# Robustness Audit: File System Edge Cases

**Audit Date:** 2026-03-08
**Auditor:** worker-1772943462017-0
**Scope:** File system operations in secure-fs.ts, state-manager.ts, event-log.ts, logger.ts

## Executive Summary

**Result: ONE MEDIUM SEVERITY ISSUE FOUND**

The codebase has good file system practices overall:
- Secure permissions (0o700 for directories, 0o600 for files)
- Atomic writes via temp file + rename pattern
- Directory creation with `recursive: true`
- ENOENT error handling in most places

**Medium severity issue:** Logger WriteStream is never closed, potentially leaking file handles.

**Low severity findings:**
- `secure-fs.ts` utilities defined but underutilized (most code uses raw fs.writeFile)
- No symlink attack protection (files could be written through symlinks)
- Disk full errors not explicitly handled (rely on generic error propagation)

## Files Audited

1. `src/utils/secure-fs.ts` - Secure file utilities (126 lines)
2. `src/core/state-manager.ts` - State persistence (612 lines)
3. `src/core/event-log.ts` - Event logging (599 lines)
4. `src/utils/logger.ts` - Console and file logging (67 lines)

## Detailed Findings

### 1. Logger WriteStream Never Closed (MEDIUM)

**Location:** src/utils/logger.ts, lines 1-67
**Severity:** MEDIUM

**Analysis:**
```typescript
export class Logger {
  private logStream: fs.WriteStream;

  constructor(logDir: string, name: string) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    this.logFilePath = path.join(logDir, `${name}.log`);
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: "a", mode: 0o600 });
  }

  private writeToFile(line: string): void {
    this.logStream.write(line + "\n");
  }
  // NO close() method!
}
```

**Issue:** The `Logger` class creates a `WriteStream` but never provides a method to close it. The Orchestrator creates a Logger and uses it throughout its lifecycle, but never closes the stream.

**Impact:**
- File descriptor leak (one per orchestrator instance)
- Potential for buffered writes to be lost on process crash
- For long-running processes, repeated Logger creation could exhaust file descriptors

**Orchestrator usage:**
```typescript
// orchestrator.ts:159
this.logger = new Logger(logsDir, "conductor");
// ... never closed
```

**Recommendation:** Add a `close()` method to Logger and call it in orchestrator shutdown:
```typescript
async close(): Promise<void> {
  return new Promise((resolve, reject) => {
    this.logStream.end(() => resolve());
    this.logStream.on('error', reject);
  });
}
```

---

### 2. Secure-FS Utilities Underutilized (LOW)

**Location:** src/utils/secure-fs.ts
**Severity:** LOW (Informational)

**Analysis:**
The `secure-fs.ts` module provides `writeFileSecure()` and `mkdirSecure()` which call `chmod()` after the operation to ensure permissions are enforced even on existing files.

**Current usage (only 3 places):**
```
src/core/planner.ts:166 - writeFileSecure(planPath, planOutput)
src/core/planner.ts:243 - writeFileSecure(planPath, planOutput)
src/core/flow-tracer.ts:70 - mkdirSecure(flowDir, { recursive: true })
```

**Not using secure-fs (direct fs.writeFile with mode):**
- `src/mcp/tools.ts` - 10+ locations
- `src/core/state-manager.ts` - 5+ locations
- `src/core/orchestrator.ts` - 7+ locations
- `src/core/event-log.ts` - 4+ locations
- `src/core/worker-manager.ts` - 6+ locations

**Impact:** On existing files, `fs.writeFile({ mode })` does NOT change permissions - the mode only applies to newly created files. If a file was previously created with different permissions (e.g., by another process or a bug), it will retain those permissions.

**Note from secure-fs.ts:**
```typescript
// IMPORTANT: Node's fs.writeFile({ mode }) only applies permissions on
// file creation. For existing files, the mode is ignored. These utilities
// call chmod() after writing to guarantee correct permissions.
```

**Recommendation:** Consider migrating sensitive file writes to use `writeFileSecure()` for defense-in-depth. However, since files are typically created with correct permissions initially, this is LOW risk.

---

### 3. No Symlink Attack Protection (LOW)

**Location:** All file write operations
**Severity:** LOW

**Analysis:**
The codebase does not check for symlinks before writing files. An attacker with write access to the `.conductor` directory could replace a file with a symlink to another location, causing the orchestrator to overwrite arbitrary files.

**Example vulnerable pattern:**
```typescript
// state-manager.ts:153
await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
await fs.rename(tmpPath, statePath);
```

If `statePath` is a symlink to `/etc/passwd`, the rename would follow the symlink and overwrite the target.

**Mitigating factors:**
1. `.conductor` directory is created with 0o700 (owner-only access)
2. Attacker would need write access to create symlinks
3. If attacker has write access to `.conductor`, they have many other attack vectors

**Recommendation:** None required. The 0o700 directory permission is sufficient protection. Adding `O_NOFOLLOW` or `lstat()` checks would add complexity without meaningful security benefit given the threat model.

---

### 4. Missing .conductor Directory Handling (LOW)

**Location:** Various files
**Severity:** LOW (Informational)

**Analysis:**
All key operations create the `.conductor` directory if missing using `recursive: true`:

```typescript
// state-manager.ts:134
await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });

// event-log.ts:161
await fs.mkdir(conductorDir, { recursive: true, mode: 0o700 });

// mcp/tools.ts:129
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
```

**Result:** CORRECT - Directory is always created before use with secure permissions.

---

### 5. Disk Full / ENOSPC Handling (LOW)

**Location:** All file write operations
**Severity:** LOW (Informational)

**Analysis:**
The codebase does not explicitly handle `ENOSPC` (disk full) errors. However, these errors propagate as exceptions and cause the operation to fail cleanly.

**Example (state-manager.ts:save):**
```typescript
try {
  await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmpPath, statePath);
} finally {
  // Clean up temp file
  try {
    await fs.unlink(tmpPath);
  } catch {
    // Temp file may not exist if rename succeeded
  }
}
```

**Behavior on disk full:**
1. `writeFile` throws ENOSPC
2. finally block attempts to clean up temp file
3. Exception propagates to caller
4. Orchestrator catches and logs error

**Result:** ACCEPTABLE - No explicit handling needed. The error propagates and is logged.

---

### 6. Permission Denied / EACCES Handling (LOW)

**Location:** All file operations
**Severity:** LOW (Informational)

**Analysis:**
Permission errors are not explicitly caught. They propagate as exceptions.

**Example in event-log.ts:rotate():**
```typescript
private async rotate(): Promise<void> {
  try {
    const content = await fs.readFile(this.logPath, "utf-8");
    // ...
    await fs.writeFile(this.logPath, newContent, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // If rotation fails, just truncate
    await fs.writeFile(this.logPath, "", { encoding: "utf-8", mode: 0o600 });
  }
}
```

**Result:** ACCEPTABLE - Graceful degradation where possible, exceptions propagate where not.

---

### 7. Concurrent File Access (LOW)

**Location:** Various files
**Severity:** LOW (Already audited in task-004)

**Analysis:**
Concurrent file access is handled via `proper-lockfile` as documented in the lock file audit. Key protections:

- `state-manager.ts:save()` - Uses lock + atomic write pattern
- `mcp/tools.ts:handleClaimTask()` - Uses lock with double-check pattern
- `mcp/tools.ts:handleCompleteTask()` - Uses lock for ownership verification

**Result:** CORRECT - See audit report `security-lock-file-race-conditions.md`.

---

### 8. File Handle Leaks - Event Log (LOW)

**Location:** src/core/event-log.ts
**Severity:** LOW (Informational)

**Analysis:**
EventLog uses `fs.appendFile()` which doesn't hold file handles open:

```typescript
await fs.appendFile(this.logPath, lines, { encoding: "utf-8", mode: 0o600 });
```

`fs.appendFile` opens the file, writes, and closes in a single atomic operation. No file handle leak risk.

**Flush interval cleanup:**
```typescript
async stop(): Promise<void> {
  if (!this.isStarted) return;
  this.isStarted = false;

  if (this.flushInterval) {
    clearInterval(this.flushInterval);  // Properly cleared
    this.flushInterval = null;
  }
  await this.flush();  // Final flush
}
```

**Result:** CORRECT - No file handle leaks. Interval properly cleaned up.

---

### 9. Very Long File Paths (LOW)

**Location:** Various files
**Severity:** LOW (Informational)

**Analysis:**
File paths are constructed using `path.join()` without length validation. On most filesystems:
- Linux: PATH_MAX = 4096 bytes
- macOS: PATH_MAX = 1024 bytes
- Windows: MAX_PATH = 260 characters (can be extended)

**Example:**
```typescript
// state-manager.ts
const taskPath = getTaskPath(this.projectDir, id);
// getTaskPath = path.join(projectDir, ORCHESTRATOR_DIR, TASKS_DIR, `${taskId}.json`)
```

**Impact:** If user provides extremely long project directory path, file operations could fail with ENAMETOOLONG.

**Mitigating factors:**
1. User controls project directory - they would notice issues
2. Task IDs are short (e.g., "task-001")
3. Errors propagate and are logged

**Recommendation:** None required. This is an extreme edge case with natural user feedback.

---

## Summary Table

| Check | Status | Severity | Notes |
|-------|--------|----------|-------|
| Missing .conductor handling | PASS | N/A | `recursive: true` always used |
| Disk full handling | PASS | LOW | Errors propagate correctly |
| Permission denied handling | PASS | LOW | Errors propagate correctly |
| Concurrent file access | PASS | N/A | Lock-based (see task-004) |
| File handle leaks (EventLog) | PASS | N/A | appendFile auto-closes |
| File handle leaks (Logger) | FAIL | MEDIUM | WriteStream never closed |
| Very long file paths | PASS | LOW | Edge case, errors propagate |
| Symlink attacks | PASS | LOW | 0o700 directory protects |
| secure-fs utilization | INFO | LOW | Underutilized but acceptable |

## Existing Protections Verified

1. **ensureDir() with recursive: true**: All directory creation uses this pattern. Confirmed in:
   - state-manager.ts:createDirectories()
   - mcp/tools.ts:ensureDir()
   - event-log.ts:writeEvents()
   - cli.ts:acquireProcessLock()

2. **0o700 directory permissions**: Verified in:
   - state-manager.ts:230 - `mode: 0o700`
   - mcp/tools.ts:129 - `mode: 0o700`
   - event-log.ts:161 - `mode: 0o700`
   - cli.ts:138 - `mode: 0o700`

3. **0o600 file permissions**: Verified in all file write locations (50+ occurrences).

4. **Atomic writes with temp files**: Verified in state-manager.ts:save():
   ```typescript
   await fs.writeFile(tmpPath, content, ...);
   await fs.rename(tmpPath, statePath);
   ```

## Recommendations

### MEDIUM Priority
1. **Add close() method to Logger**: To prevent file descriptor leak, add:
   ```typescript
   async close(): Promise<void> {
     return new Promise((resolve) => {
       this.logStream.end(() => resolve());
     });
   }
   ```
   And call from orchestrator.shutdown().

### LOW Priority (Optional)
2. **Consider migrating to secure-fs utilities**: For defense-in-depth, critical file writes could use `writeFileSecure()` instead of raw `fs.writeFile()`. This ensures permissions are enforced even on existing files.

## Conclusion

**ONE MEDIUM SEVERITY ISSUE: Logger WriteStream never closed**

The Logger class creates a WriteStream but provides no way to close it. This results in a file descriptor leak. While not critical for short-lived processes, it should be fixed for proper resource management.

All other file system operations are robust:
- Directories created with correct permissions
- Files written with correct permissions
- Atomic writes prevent partial data
- Errors propagate correctly
- Concurrent access handled via locking

The secure-fs utilities are underutilized but not a security risk since files are created with correct permissions initially.

No symlink protection is needed given the 0o700 directory permissions.

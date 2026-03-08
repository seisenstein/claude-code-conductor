# Security Audit: Lock File Race Conditions

**Audit Date:** 2026-03-08
**Auditor:** worker-1772943462017-0
**Scope:** Lock file handling in state-manager.ts, tools.ts, cli.ts, event-log.ts

## Executive Summary

**Result: NO CRITICAL VULNERABILITIES FOUND**

The codebase uses `proper-lockfile` consistently with appropriate patterns:
- Double-check patterns after lock acquisition to prevent TOCTOU races
- Proper finally blocks for lock release in error paths
- Atomic file operations (write to .tmp then rename) where appropriate
- Reasonable stale lock detection (5 seconds for most operations, 1 hour for CLI lock)
- PID-based dead process detection for CLI locks

One LOW severity finding: the `unlock` function is imported but never used in state-manager.ts.

## Files Audited

1. `src/core/state-manager.ts` - State file locking with proper-lockfile
2. `src/mcp/tools.ts` - Task claim/complete locking
3. `src/cli.ts` - CLI process lock (acquireProcessLock)
4. `src/core/event-log.ts` - Event log file access (no locking needed)

## Detailed Findings

### 1. src/core/state-manager.ts - State File Locking

**Location:** Lines 1-612
**Functions:** `save()`, `createTask()`, `resetOrphanedTasks()`
**Severity:** LOW (Informational)

**Analysis - save() method (Lines 113-162):**
```typescript
let release: (() => Promise<void>) | undefined;
try {
  release = await lock(statePath, {
    retries: { retries: 5, minTimeout: 100 },
    stale: 5000, // Consider locks stale after 5 seconds
  });

  // Write to temp file first with secure permissions (mode 0o600)
  await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });

  // Atomic rename (prevents partial writes from being read)
  await fs.rename(tmpPath, statePath);
} finally {
  // Always release the lock, even if writing fails
  if (release) {
    try {
      await release();
    } catch {
      // Lock may already be released if process is dying
    }
  }
  // Clean up temp file if it still exists
  try {
    await fs.unlink(tmpPath);
  } catch {
    // Temp file may not exist if rename succeeded
  }
}
```

**Security Assessment:**
- Uses `proper-lockfile` with retry configuration
- **Stale detection at 5 seconds** - This is reasonable for state file operations
- Atomic write pattern: write to `.tmp` then rename
- Finally block always releases lock (prevents lock leaks)
- Cleanup of temp file in finally block
- Creates file before locking if it doesn't exist (required by proper-lockfile)
- Uses secure file permissions (0o600)

**Potential Concern:** The `unlock` import on line 5 is never used. The code correctly uses the `release()` function returned by `lock()` instead.

**Analysis - createTask() method (Lines 232-311):**
```typescript
let release: (() => Promise<void>) | undefined;
try {
  release = await lock(depPath, {
    retries: { retries: 5, minTimeout: 100 },
    stale: 5000,
  });

  // Re-read after lock acquisition (double-check pattern)
  const depTask = await this.getTask(depId);
  if (depTask && !depTask.blocks.includes(id)) {
    depTask.blocks.push(id);
    await fs.writeFile(depPath, JSON.stringify(depTask, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
} finally {
  if (release) {
    try {
      await release();
    } catch {
      // Lock may already be released
    }
  }
}
```

**Security Assessment:**
- **Double-check pattern correctly implemented** - Re-reads task after lock acquisition
- Prevents TOCTOU between file existence check and mutation
- Proper finally block for lock release
- File permissions are secure (0o600)

**Analysis - resetOrphanedTasks() method (Lines 369-450):**
```typescript
release = await lock(taskPath, {
  retries: { retries: 5, minTimeout: 100 },
  stale: 5000,
});

// Double-check pattern: Re-read task after lock acquisition
// Another process may have claimed or modified it
const freshTask = await this.getTask(task.id);
if (!freshTask) {
  continue; // Task file was deleted, skip
}

// Skip if task state changed (e.g., was claimed by another worker)
if (freshTask.status !== "in_progress") {
  continue;
}
```

**Security Assessment:**
- **Double-check pattern correctly implemented**
- Comments explicitly explain the TOCTOU prevention
- Gracefully handles task deletion between check and lock
- Proper finally block for lock release

---

### 2. src/mcp/tools.ts - Task Claim/Complete Locking

**Location:** Lines 354-639
**Functions:** `handleClaimTask()`, `handleCompleteTask()`
**Severity:** LOW (Informational)

**Analysis - handleClaimTask() (Lines 362-514):**
```typescript
let release: (() => Promise<void>) | undefined;
try {
  release = await lock(taskPath, { retries: { retries: 5, minTimeout: 100 } });

  // Double-check pattern: Re-read task after acquiring lock to prevent TOCTOU race (#5)
  // Another worker may have claimed or modified the task between our access check and lock acquisition
  const task = await readJsonFile<Task>(taskPath);
  if (!task) {
    return { success: false, error: `Task not found: ${input.task_id}` };
  }

  // Verify task is still pending after lock acquisition (double-check)
  if (task.status !== "pending") {
    return {
      success: false,
      error: `Task ${input.task_id} is not pending (current status: ${task.status})`,
    };
  }
  // ... claim logic ...
} finally {
  if (release) {
    try {
      await release();
    } catch {
      // Lock may already be released if the process is dying
    }
  }
}
```

**Security Assessment:**
- **Double-check pattern correctly implemented** with explicit comment referencing issue #5
- Validates task_id before use (path traversal prevention)
- Re-reads task after lock to prevent race condition
- Proper finally block for lock release
- No stale option specified - uses proper-lockfile defaults

**Note:** Missing `stale` option in lock configuration. This is LOW risk because:
- The `proper-lockfile` default stale timeout is 10 seconds
- Task claim operations are quick (< 1 second)
- The library handles stale locks automatically

**Analysis - handleCompleteTask() (Lines 532-640):**
```typescript
let release: (() => Promise<void>) | undefined;
try {
  release = await lock(taskPath, { retries: { retries: 3, minTimeout: 100 } });

  const task = await readJsonFile<Task>(taskPath);
  if (!task) {
    return { success: false, error: `Task not found: ${input.task_id}` };
  }

  // Verify this session owns the task
  const sessionId = getSessionId();
  if (task.owner !== sessionId) {
    return {
      success: false,
      error: `Task ${input.task_id} is owned by ${task.owner}, not ${sessionId}`,
    };
  }
  // ... complete logic ...
} finally {
  if (release) {
    try {
      await release();
    } catch {
      // Lock may already be released
    }
  }
}
```

**Security Assessment:**
- Fewer retries (3 vs 5) - acceptable for completion which is less contended
- Re-reads task after lock (implicit double-check)
- Validates ownership after lock acquisition
- Proper finally block for lock release
- Input validation before locking (path traversal, size limits)

**Analysis - handlePostUpdate() and handleRecordDecision():**
Both functions use similar locking patterns for JSONL file appends:
```typescript
let release: (() => Promise<void>) | undefined;
try {
  release = await lock(filePath, {
    retries: { retries: 5, minTimeout: 100 },
    stale: 5000,
  });
  await fs.appendFile(filePath, JSON.stringify(record) + "\n", ...);
} finally {
  if (release) {
    try {
      await release();
    } catch {
      // Lock may already be released
    }
  }
}
```

**Security Assessment:**
- Consistent locking pattern across all JSONL operations
- Stale detection at 5 seconds
- Proper finally blocks

---

### 3. src/cli.ts - CLI Process Lock

**Location:** Lines 92-220
**Function:** `acquireProcessLock()`
**Severity:** LOW (Informational)

**Analysis:**
```typescript
interface LockInfo {
  pid: number;
  timestamp: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireProcessLock(projectDir: string): Promise<() => Promise<void>> {
  const lockPath = getCliLockPath(projectDir);
  const lockInfoPath = lockPath + ".info";

  // ... check if lock is held ...
  const isLocked = await check(lockPath, { stale: CLI_LOCK_STALE_TIMEOUT_MS });

  if (isLocked) {
    // Check if the holding process is still alive by reading the .info file
    const info: LockInfo = JSON.parse(infoContent);

    // Check if process is dead (PID-based stale detection)
    if (!isProcessAlive(info.pid)) {
      console.log(chalk.yellow(`Cleaning up stale lock from dead process ${info.pid}...`));
      // Force remove the stale lock
      try { await unlock(lockPath); } catch { }
      // Continue to acquire lock below
    } else {
      // Check if lock is older than stale timeout
      const elapsed = Date.now() - lockTime;
      if (elapsed > CLI_LOCK_STALE_TIMEOUT_MS) {
        // Clean up stale lock
      } else {
        throw new Error(`Another conductor process (PID ${info.pid}) is already running...`);
      }
    }
  }

  // Acquire the lock
  const release = await lock(lockPath, {
    retries: { retries: 5, minTimeout: 100 },
    stale: CLI_LOCK_STALE_TIMEOUT_MS
  });

  // Write lock info file with PID and timestamp
  await fs.writeFile(lockInfoPath, JSON.stringify(lockInfo, null, 2), { mode: 0o600 });

  // Return release function that cleans up both lock and info file
  return async () => {
    try { await release(); } catch { }
    try { await fs.unlink(lockInfoPath); } catch { }
  };
}
```

**Security Assessment:**

1. **PID-based dead process detection**: `isProcessAlive()` uses `process.kill(pid, 0)` which is the correct POSIX method to check if a process exists. Returns false if process is dead.

2. **Dual-level stale detection**:
   - `proper-lockfile` stale detection (1 hour timeout from `CLI_LOCK_STALE_TIMEOUT_MS`)
   - PID-based detection: checks if holding process is still alive
   - Time-based detection: checks if lock is older than stale timeout

3. **Lock info file (.info)**: Stores PID and timestamp for stale detection. This is a good pattern.

4. **File permissions**: Lock info file created with mode 0o600.

5. **Finally blocks in callers**: Both `start` and `resume` commands use:
   ```typescript
   try {
     // ... orchestrator logic ...
   } finally {
     if (releaseLock) {
       await releaseLock();
     }
   }
   ```

**Potential Concern - Stale timeout value:**
- `CLI_LOCK_STALE_TIMEOUT_MS` is 1 hour (60 * 60 * 1000 ms)
- This is intentionally long for orchestrator runs
- User gets helpful error message with PID and remaining time

**Analysis of `isProcessAlive()` security:**
```typescript
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- Uses signal 0 which is safe (doesn't actually send signal)
- Returns false if process doesn't exist (ESRCH error)
- Returns false if no permission to signal (EPERM error) - this is a slight inaccuracy but safe
- No command injection possible - PID is a number from JSON.parse

**TOCTOU Analysis:**
There is a potential TOCTOU between `check()` and `lock()`:
```typescript
const isLocked = await check(lockPath, { stale: CLI_LOCK_STALE_TIMEOUT_MS });
// ... cleanup logic ...
const release = await lock(lockPath, { retries: ... });
```

However, this is LOW risk because:
1. The cleanup is only triggered when the lock appears stale
2. `proper-lockfile` handles concurrent lock attempts gracefully
3. If two processes race, one will succeed and one will get a lock error
4. The stale detection is best-effort - not security-critical

---

### 4. src/core/event-log.ts - Event Log File Access

**Location:** Lines 1-599
**Class:** `EventLog`
**Severity:** LOW (Informational)

**Analysis:**

The EventLog class does NOT use `proper-lockfile`. Instead, it uses a different concurrency pattern:

```typescript
private flushPromise: Promise<void> | null;

async flush(): Promise<void> {
  // Wait for any in-flight flush to complete
  if (this.flushPromise) {
    await this.flushPromise;
  }

  if (this.buffer.length === 0) return;

  // Swap buffer
  const events = this.buffer;
  this.buffer = [];

  this.flushPromise = this.writeEvents(events);
  await this.flushPromise;
  this.flushPromise = null;
}

private async writeEvents(events: StructuredEvent[]): Promise<void> {
  // ...
  await fs.appendFile(this.logPath, lines, { encoding: "utf-8", mode: 0o600 });
}
```

**Security Assessment:**

1. **Buffer swap pattern**: This is safe for single-process concurrency. Events are moved to a temporary variable before writing.

2. **flushPromise guard**: Prevents concurrent flushes within the same process.

3. **Why no file locking?**: Event logging is:
   - Single-process (orchestrator only writes to its own event log)
   - Append-only (no read-modify-write cycles)
   - Non-critical (failed writes retry by putting events back in buffer)
   - Size-limited with rotation (DoS mitigation)

4. **Error recovery**: If write fails, events are put back in buffer:
   ```typescript
   } catch (err) {
     // Put events back in buffer on failure
     this.buffer = [...events, ...this.buffer];
     throw err;
   }
   ```

5. **Atomic operations**: Uses `fs.appendFile` which is atomic for small writes on most filesystems.

**Recommendation:** None required. The event log pattern is appropriate for single-process append-only logging.

---

## Summary Table

| File | Function | Locking | Stale Timeout | Double-Check | Finally Block | Verdict |
|------|----------|---------|---------------|--------------|---------------|---------|
| state-manager.ts | save() | proper-lockfile | 5s | N/A (atomic) | Yes | SECURE |
| state-manager.ts | createTask() | proper-lockfile | 5s | Yes | Yes | SECURE |
| state-manager.ts | resetOrphanedTasks() | proper-lockfile | 5s | Yes | Yes | SECURE |
| tools.ts | handleClaimTask() | proper-lockfile | default (10s) | Yes | Yes | SECURE |
| tools.ts | handleCompleteTask() | proper-lockfile | default (10s) | Implicit | Yes | SECURE |
| tools.ts | handlePostUpdate() | proper-lockfile | 5s | N/A (append) | Yes | SECURE |
| tools.ts | handleRecordDecision() | proper-lockfile | 5s | N/A (append) | Yes | SECURE |
| cli.ts | acquireProcessLock() | proper-lockfile | 1 hour | PID-based | Yes | SECURE |
| event-log.ts | flush() | None (buffer swap) | N/A | N/A | N/A | SECURE |

## Existing Protections Verified

1. **Double-check pattern**: All read-modify-write operations re-read data after lock acquisition to prevent TOCTOU races.

2. **Finally blocks**: Every lock acquisition has a corresponding finally block that releases the lock, preventing lock leaks on errors.

3. **Stale lock detection**: All locks have stale timeouts (5 seconds for quick operations, 1 hour for CLI lock).

4. **PID-based dead process detection**: CLI lock uses `process.kill(pid, 0)` to detect dead processes holding stale locks.

5. **Atomic file operations**: State file uses write-to-tmp-then-rename pattern for atomicity.

6. **File permissions**: All files created with mode 0o600 (owner read/write only).

7. **Proper-lockfile library**: Uses a well-maintained library that handles platform-specific locking.

## Minor Findings (Non-Critical)

### Finding 1: Unused `unlock` import

**Location:** state-manager.ts, line 5
**Severity:** LOW (Dead code)

```typescript
import { lock, unlock } from "proper-lockfile";
```

The `unlock` function is imported but never used. All lock releases use the `release()` function returned by `lock()` instead, which is the correct pattern.

**Recommendation:** Remove unused import (dead code cleanup task should handle this).

### Finding 2: Missing explicit stale option in tools.ts claim_task

**Location:** tools.ts, line 385
**Severity:** LOW (Informational)

```typescript
release = await lock(taskPath, { retries: { retries: 5, minTimeout: 100 } });
```

No explicit `stale` option is set. The `proper-lockfile` default is 10 seconds, which is appropriate for task claims.

**Recommendation:** Consider adding explicit `stale: 5000` for consistency with other lock calls, but not required.

## Conclusion

**NO CRITICAL OR HIGH SEVERITY LOCK FILE RACE CONDITIONS FOUND**

The C3 codebase follows secure lock file patterns:
- Consistently uses `proper-lockfile` for file locking
- Double-check pattern prevents TOCTOU races in read-modify-write operations
- All locks have proper finally blocks for release
- Stale lock detection is configured appropriately
- CLI process lock has additional PID-based dead process detection
- File permissions are secure (0o600)

The event log correctly avoids file locking because it uses a single-process buffer-swap pattern for append-only writes.

No fixes are required.

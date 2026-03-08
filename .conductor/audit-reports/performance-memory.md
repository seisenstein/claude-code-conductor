# Performance Audit: Memory Leaks

**Audit Date:** 2026-03-08
**Auditor:** worker-1772943462017-0
**Scope:** Resource lifecycle, timers, maps, file handles, event listeners

## Executive Summary

**Result: ONE MEDIUM SEVERITY ISSUE FOUND (previously reported in task-010)**

The codebase has good resource management practices overall:
- UsageMonitor uses adaptive setTimeout with `unref()` and proper cleanup
- EventLog uses `setInterval().unref()` and proper cleanup in `stop()`
- WorkerManager properly cleans up resilience trackers and activeWorkers map in finally blocks
- All locks use finally blocks for release
- MCP servers for workers are managed by the SDK (spawned per-query)

**Medium severity issue:** Logger WriteStream is never closed (also found in robustness audit).

**Low severity findings:**
- Signal handlers not removed on process exit (acceptable - process is exiting)
- `clearStaleFailures()` not called periodically (minimal memory impact)
- UsageMonitor creates its own Logger if none provided (potential orphan)

## Files Audited

1. `src/core/worker-manager.ts` - Worker tracking maps (698 lines)
2. `src/core/usage-monitor.ts` - Interval timers (250+ lines)
3. `src/core/event-log.ts` - Flush interval (599 lines)
4. `src/utils/logger.ts` - WriteStream (67 lines)
5. `src/core/orchestrator.ts` - MCP servers, shutdown (2500+ lines)
6. `src/core/worker-resilience.ts` - Timeout/heartbeat/retry maps (420 lines)
7. `src/cli.ts` - Signal handlers (800+ lines)

## Detailed Findings

### 1. Logger WriteStream Never Closed (MEDIUM - DUPLICATE)

**Location:** src/utils/logger.ts, lines 1-67
**Severity:** MEDIUM (Already reported in robustness-file-system.md)

**Analysis:**
```typescript
export class Logger {
  private logStream: fs.WriteStream;

  constructor(logDir: string, name: string) {
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: "a", mode: 0o600 });
  }
  // NO close() method!
}
```

**Memory Impact:**
- One file descriptor per Logger instance
- Buffered writes may be lost on crash
- Orchestrator creates one Logger at startup, never closed

**Note:** This is the same issue found in the file system robustness audit (task-010). No duplicate report needed.

---

### 2. UsageMonitor Timer Management (PASS)

**Location:** src/core/usage-monitor.ts, lines 75-124
**Severity:** N/A (No issues found)

**Analysis:**
```typescript
export class UsageMonitor {
  private timeoutHandle: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.running) return;  // Idempotent
    this.running = true;
    void this.pollAndNotify().then(() => this.scheduleNextPoll());
  }

  stop(): void {
    if (!this.running) return;  // Idempotent
    this.running = false;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;  // Check before scheduling
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);  // Clear existing before setting new
    }
    this.timeoutHandle = setTimeout(...);
    this.timeoutHandle.unref();  // Won't keep process alive
  }
}
```

**Protections Verified:**
1. **Idempotent start/stop**: Guards prevent double-start or double-stop
2. **Running flag checked**: `scheduleNextPoll()` checks `running` before scheduling
3. **Timeout cleared before set**: Prevents orphan timers
4. **`unref()` called**: Timer won't keep process alive
5. **Stop clears handle**: Proper cleanup on stop

**Orchestrator usage (line 1379):**
```typescript
finally {
  usageMonitor.stop();  // Always called via finally block
}
```

**Result:** CORRECT - No memory leaks.

---

### 3. EventLog Flush Interval (PASS)

**Location:** src/core/event-log.ts, lines 85-116
**Severity:** N/A (No issues found)

**Analysis:**
```typescript
export class EventLog {
  private flushInterval: NodeJS.Timeout | null;
  private isStarted: boolean;

  start(): void {
    if (this.isStarted) return;  // Idempotent
    this.isStarted = true;

    this.flushInterval = setInterval(() => {
      this.flush().catch(console.error);
    }, EVENT_FLUSH_INTERVAL_MS);

    this.flushInterval.unref();  // Won't keep process alive
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;  // Idempotent
    this.isStarted = false;

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();  // Final flush
  }
}
```

**Protections Verified:**
1. **Idempotent start/stop**: Guards prevent double operations
2. **`unref()` called**: Interval won't keep process alive
3. **Interval cleared and nulled**: Proper cleanup
4. **Final flush on stop**: No buffered data lost

**Orchestrator shutdown (line 1878):**
```typescript
try {
  await this.eventLog.stop();
} catch { /* Best effort */ }
```

**Result:** CORRECT - No memory leaks.

---

### 4. WorkerManager Maps and Resilience Trackers (PASS)

**Location:** src/core/worker-manager.ts, lines 460-467, 546-552
**Severity:** N/A (No issues found)

**Analysis - Worker cleanup (runWorker finally block):**
```typescript
finally {
  // V2: Clean up resilience trackers
  this.timeoutTracker.stopTracking(sessionId);
  this.heartbeatTracker.cleanup(sessionId);

  // Remove from active workers once done
  this.activeWorkers.delete(sessionId);
}
```

**Analysis - Sentinel cleanup (runSentinelWorker finally block):**
```typescript
finally {
  this.timeoutTracker.stopTracking(sessionId);
  this.heartbeatTracker.cleanup(sessionId);
  this.activeWorkers.delete(sessionId);
}
```

**Resilience tracker cleanup methods (worker-resilience.ts):**
```typescript
// WorkerTimeoutTracker
stopTracking(sessionId: string): void {
  this.startTimes.delete(sessionId);
}

// HeartbeatTracker
cleanup(sessionId: string): void {
  this.lastHeartbeat.delete(sessionId);
}
```

**Protections Verified:**
1. **Finally blocks always run**: Cleanup happens on success, error, or exception
2. **All maps cleaned**: activeWorkers, startTimes, lastHeartbeat all deleted
3. **Order is correct**: Tracker cleanup before map removal
4. **Kill also cleans up**: `killAllWorkers()` deletes from activeWorkers

**Result:** CORRECT - No memory leaks in worker lifecycle.

---

### 5. TaskRetryTracker clearStaleFailures() Not Called (LOW)

**Location:** src/core/worker-resilience.ts, lines 222-235
**Severity:** LOW (Potential memory accumulation)

**Analysis:**
```typescript
clearStaleFailures(): number {
  const now = process.hrtime.bigint();
  const ttlNs = BigInt(this.ttlMs) * 1_000_000n;
  for (const [taskId, state] of this.retryState) {
    if (now - state.lastFailureTime > ttlNs) {
      this.retryState.delete(taskId);
    }
  }
}
```

This method exists but is never called in the orchestrator execution loop.

**Memory Impact:**
- Each entry: ~100 bytes (taskId string + RetryState object)
- 100 tasks over 8 hours: ~10KB maximum
- Entries are cleared when tasks complete successfully via `clear(taskId)`

**Mitigating Factors:**
1. Retry state is cleared on successful completion
2. TTL is a safeguard for abandoned tasks
3. Memory impact is minimal

**Recommendation:** Consider calling `clearStaleFailures()` in the monitor loop, but this is LOW priority.

---

### 6. MCP Server Lifecycle (PASS)

**Location:** Various - worker-manager.ts, planner.ts, codex-reviewer.ts
**Severity:** N/A (No issues found)

**Analysis:**

MCP servers in this codebase come in two forms:

**1. External MCP Server (coordination-server.ts):**
- Spawned by SDK as child process per worker query
- SDK manages lifecycle - starts with query, stops when query completes
- No manual cleanup needed

**2. In-process MCP Server (planner.ts):**
```typescript
const plannerMcp = this.createPlannerMcpServer();
try {
  await query({ mcpServers: { planner: plannerMcp } });
} finally {
  await plannerMcp.instance.close().catch(() => {});  // Properly closed!
}
```

**Protections Verified:**
1. **Planner MCP**: Closed in finally block (lines 153, 231)
2. **Worker MCP**: Spawned per-query by SDK, managed by SDK
3. **Codex MCP**: Uses external CLI process, not in-memory server

**Result:** CORRECT - No MCP server leaks.

---

### 7. Signal Handlers Not Removed (LOW)

**Location:** src/cli.ts, lines 335-336, 678-679
**Severity:** LOW (Informational)

**Analysis:**
```typescript
const shutdown = async () => { /* ... */ process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Never removed with process.off()
```

**Impact:**
- Signal handlers accumulate if start/resume is called multiple times
- In practice, CLI commands run once then exit
- `process.exit(0)` is called in shutdown, so handlers don't matter

**Mitigating Factors:**
1. CLI is a one-shot command - never reused
2. `process.exit()` terminates everything
3. No memory leak since process exits

**Recommendation:** None required. The handlers are attached once and process exits.

---

### 8. File Handles in Error Paths (PASS)

**Location:** Various - state-manager.ts, tools.ts
**Severity:** N/A (No issues found)

**Analysis - state-manager.ts save():**
```typescript
try {
  await fs.writeFile(tmpPath, content, { mode: 0o600 });
  await fs.rename(tmpPath, statePath);
} finally {
  try {
    await fs.unlink(tmpPath);  // Clean up temp file
  } catch { /* May not exist if rename succeeded */ }
}
```

**Analysis - event-log.ts writeEvents():**
```typescript
await fs.appendFile(this.logPath, lines, { mode: 0o600 });
// appendFile opens, writes, closes - no handle leak
```

**Protections Verified:**
1. **fs.writeFile()**: Opens, writes, closes atomically
2. **fs.appendFile()**: Opens, appends, closes atomically
3. **Temp files cleaned up**: Finally blocks handle cleanup
4. **No streams held**: Only Logger holds a WriteStream (addressed separately)

**Result:** CORRECT - No file handle leaks except Logger WriteStream.

---

### 9. Event Listener Accumulation (PASS)

**Location:** Various
**Severity:** N/A (No issues found)

**Analysis:**
The codebase uses very few event listeners:

1. **CLI signal handlers**: One-time setup, process exits after
2. **Codex child process handlers**: Bound once per spawn, process exits
```typescript
child.on("error", (err) => { /* ... */ });
child.on("close", (code, signal) => { /* ... */ });
```

The child process handlers are bound once per worker spawn. When the child process exits, Node.js automatically removes the handlers.

**Result:** CORRECT - No event listener accumulation.

---

## Summary Table

| Resource | Component | Cleanup Method | Verified | Verdict |
|----------|-----------|----------------|----------|---------|
| setTimeout | UsageMonitor | clearTimeout + null | Yes | PASS |
| setInterval | EventLog | clearInterval + null + unref | Yes | PASS |
| Map (activeWorkers) | WorkerManager | delete in finally | Yes | PASS |
| Map (startTimes) | WorkerTimeoutTracker | stopTracking() | Yes | PASS |
| Map (lastHeartbeat) | HeartbeatTracker | cleanup() | Yes | PASS |
| Map (retryState) | TaskRetryTracker | clear() on success | Partial | LOW |
| WriteStream | Logger | **NONE** | No | **MEDIUM** |
| MCP Server | Planner | close() in finally | Yes | PASS |
| MCP Server (external) | WorkerManager | SDK managed | Yes | PASS |
| File handles | fs.writeFile/appendFile | Auto-closed | Yes | PASS |
| Signal handlers | CLI | Not removed | N/A | LOW |

## Existing Protections Verified

1. **unref() on all timers**: Both `UsageMonitor.timeoutHandle` and `EventLog.flushInterval` call `unref()` to prevent keeping the process alive.

2. **Idempotent start/stop**: Both UsageMonitor and EventLog have idempotency guards.

3. **Finally blocks for cleanup**: WorkerManager uses finally blocks in `runWorker()` and `runSentinelWorker()` to ensure cleanup always happens.

4. **Running flag checks**: UsageMonitor and EventLog check `running`/`isStarted` before scheduling new work.

5. **Clear before set pattern**: UsageMonitor clears existing timeout before setting new one in `scheduleNextPoll()`.

6. **MCP server close in finally**: Planner properly closes its MCP server instance in finally blocks.

## Recommendations

### MEDIUM Priority
1. **Add close() method to Logger**: (Already documented in robustness audit)
   ```typescript
   async close(): Promise<void> {
     return new Promise((resolve) => {
       this.logStream.end(() => resolve());
     });
   }
   ```
   Call from `orchestrator.shutdown()`.

### LOW Priority (Optional)
2. **Consider calling clearStaleFailures() periodically**: Could add to monitor loop, but impact is minimal.

## Conclusion

**ONE MEDIUM SEVERITY ISSUE: Logger WriteStream never closed**

This is the same issue found in the file system robustness audit (task-010). The Logger class creates a WriteStream but provides no way to close it, resulting in a file descriptor leak.

All other resource management is robust:
- Timers use `unref()` and are properly cleared
- Maps are cleaned up in finally blocks
- File handles are auto-closed by fs operations
- MCP servers are properly managed
- Event listeners don't accumulate

The codebase follows good practices for resource lifecycle management. The only fix needed is adding a close() method to Logger.

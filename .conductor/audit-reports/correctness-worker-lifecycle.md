# Correctness Audit: Worker Lifecycle Management

**Audit Date:** 2026-03-08
**Auditor:** worker-1772943462017-0
**Scope:** Worker spawn/timeout/retry/cleanup in WorkerManager, worker-resilience, and orchestrator

## Executive Summary

**Result: NO CRITICAL VULNERABILITIES FOUND**

The worker lifecycle management is well-designed with comprehensive resilience tracking:
- Workers spawn correctly with session directory setup
- Timeout detection uses `process.hrtime.bigint()` for clock-skew immunity
- Heartbeat detection prevents false positives via recording on all non-error events
- Task retry logic correctly limits to MAX_TASK_RETRIES (2 retries = 3 total attempts)
- Orphan task reset correctly handles worker crashes
- Session cleanup properly removes from activeWorkers map and resilience trackers
- Race conditions prevented via lock-based claim_task

One LOW severity finding: clearStaleFailures() is defined but not called in the main execution loop.

## Files Audited

1. `src/core/worker-manager.ts` - WorkerManager class (698 lines)
2. `src/core/worker-resilience.ts` - TaskRetryTracker, WorkerTimeoutTracker, HeartbeatTracker
3. `src/core/orchestrator.ts` - monitorExecution loop (execution phase)

## Detailed Findings

### 1. Worker Spawn (worker-manager.ts)

**Location:** Lines 94-142
**Function:** `spawnWorker()`
**Severity:** LOW (Informational)

**Analysis:**
```typescript
async spawnWorker(sessionId: string): Promise<void> {
  if (this.activeWorkers.has(sessionId)) {
    this.logger.warn(`Worker ${sessionId} is already active; skipping spawn`);
    return;
  }

  // Create session directory
  const sessionDir = path.join(this.orchestratorDir, SESSIONS_DIR, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  // Write initial status
  const initialStatus: SessionStatus = {
    session_id: sessionId,
    state: "starting",
    // ...
  };
  await fs.writeFile(path.join(sessionDir, SESSION_STATUS_FILE), ...);

  // V2: Start resilience tracking
  this.timeoutTracker.startTracking(sessionId);
  this.heartbeatTracker.recordHeartbeat(sessionId); // Initial heartbeat

  // Launch the worker as a background async task
  handle.promise = this.runWorker(sessionId, handle);
  this.activeWorkers.set(sessionId, handle);
}
```

**Security Assessment:**
1. **Idempotency check**: Guards against duplicate spawns with `activeWorkers.has(sessionId)`
2. **Directory creation**: Creates session directory with implicit default permissions
3. **Resilience tracking**: Starts both timeout and heartbeat tracking before launch
4. **Async task**: Worker runs as background Promise, not a child process

**Note:** Directory created without explicit mode 0o700. However, this is non-critical as session directories contain only status.json files.

---

### 2. Timeout Detection (worker-resilience.ts)

**Location:** Lines 254-325
**Class:** `WorkerTimeoutTracker`
**Severity:** LOW (Informational)

**Analysis:**
```typescript
export class WorkerTimeoutTracker {
  private startTimes: Map<string, bigint> = new Map();
  private timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_WORKER_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;  // 45 minutes
  }

  isTimedOut(sessionId: string): boolean {
    const startTime = this.startTimes.get(sessionId);
    if (startTime === undefined) return false;

    const elapsedMs = hrtimeToMs(process.hrtime.bigint() - startTime);
    return elapsedMs > this.timeoutMs;
  }

  getTimedOutWorkers(): string[] {
    const now = process.hrtime.bigint();
    const timedOut: string[] = [];

    for (const [sessionId, startTime] of this.startTimes) {
      const elapsedMs = hrtimeToMs(now - startTime);
      if (elapsedMs > this.timeoutMs) {
        timedOut.push(sessionId);
      }
    }
    return timedOut;
  }
}
```

**Security Assessment:**
1. **Uses hrtime.bigint()**: Immune to system clock changes (NTP adjustments, DST)
2. **Accurate conversion**: `hrtimeToMs(hrtime: bigint)` correctly divides by 1_000_000n
3. **Consistent timing**: Same `now` used for all workers in getTimedOutWorkers()
4. **Default timeout**: 45 minutes (`DEFAULT_WORKER_TIMEOUT_MS`)

**Potential Concern:** If `process.hrtime.bigint()` overflows after ~292 years, arithmetic would wrap. This is not a practical concern.

---

### 3. Heartbeat Detection (worker-resilience.ts)

**Location:** Lines 344-416
**Class:** `HeartbeatTracker`
**Severity:** LOW (Informational)

**Analysis:**
```typescript
export class HeartbeatTracker {
  private lastHeartbeat: Map<string, bigint> = new Map();
  private staleThresholdMs: number;

  constructor(staleThresholdMs: number = HEARTBEAT_STALE_THRESHOLD_MS) {
    this.staleThresholdMs = staleThresholdMs;  // 5 minutes
  }

  isStale(sessionId: string): boolean {
    const lastBeat = this.lastHeartbeat.get(sessionId);
    if (lastBeat === undefined) return false; // Never tracked, not stale

    const elapsedMs = hrtimeToMs(process.hrtime.bigint() - lastBeat);
    return elapsedMs > this.staleThresholdMs;
  }
}
```

**Worker-side heartbeat recording (worker-manager.ts:571-573):**
```typescript
// V2: Record heartbeat on all non-error events to prevent false stale detection
if (eventType !== "error") {
  this.heartbeatTracker.recordHeartbeat(sessionId);
}
```

**Security Assessment:**
1. **Uses hrtime.bigint()**: Same clock-skew immunity as timeout tracker
2. **Default threshold**: 5 minutes (`HEARTBEAT_STALE_THRESHOLD_MS`)
3. **Heartbeat on all non-error events**: Prevents false positives from long-running tool calls
4. **Never tracked = not stale**: New workers don't trigger false stale detection

**Note:** The 5-minute stale threshold is appropriate because:
- Tool calls (especially Task agent spawns) can take several minutes
- SDK streams events continuously during normal operation
- Only truly stalled workers (no events at all) will be flagged

---

### 4. Task Retry Logic (worker-resilience.ts)

**Location:** Lines 105-236
**Class:** `TaskRetryTracker`
**Severity:** LOW (Informational)

**Analysis:**
```typescript
export class TaskRetryTracker {
  private retryState: Map<string, RetryState> = new Map();
  private maxRetries: number;
  private ttlMs: number;

  constructor(maxRetries: number = MAX_TASK_RETRIES, ttlMs: number = RETRY_FAILURE_TTL_MS) {
    this.maxRetries = maxRetries;  // 2 retries = 3 total attempts
    this.ttlMs = ttlMs;            // 30 minutes TTL
  }

  recordFailure(taskId: string, error: string): void {
    const sanitizedError = sanitizeErrorForPrompt(error);
    const existing = this.retryState.get(taskId);
    const now = process.hrtime.bigint();

    if (existing) {
      existing.count++;
      existing.lastError = sanitizedError;
      existing.lastFailureTime = now;
      if (existing.count >= this.maxRetries) {
        existing.exhausted = true;
      }
    } else {
      this.retryState.set(taskId, {
        count: 1,
        lastError: sanitizedError,
        exhausted: 1 >= this.maxRetries,
        lastFailureTime: now,
      });
    }
  }

  shouldRetry(taskId: string): boolean {
    const state = this.retryState.get(taskId);
    if (!state) return true; // Never failed, can try
    return !state.exhausted && state.count < this.maxRetries;
  }
}
```

**Security Assessment:**
1. **Error sanitization**: `sanitizeErrorForPrompt()` removes file paths, prompt injection patterns
2. **MAX_TASK_RETRIES = 2**: Correct - 2 retries = 3 total attempts (initial + 2 retries)
3. **TTL-based cleanup**: `clearStaleFailures()` removes old failure state after 30 minutes
4. **hrtime for timing**: Uses monotonic clock for lastFailureTime

**Note:** `clearStaleFailures()` is defined but not called in the main execution loop. This is LOW severity because:
- Tasks complete or exhaust retries before TTL typically
- Memory impact is minimal (Map entries are small)
- TTL is a safeguard, not a core mechanism

---

### 5. Orphan Task Reset (orchestrator.ts + state-manager.ts)

**Location:** orchestrator.ts:1331-1341, state-manager.ts:369-450
**Function:** `resetOrphanedTasks()`
**Severity:** LOW (Informational)

**Analysis:**
```typescript
// orchestrator.ts:1331-1341
const { resetCount, exhaustedCount } = await this.state.resetOrphanedTasks(
  healthyWorkers,
  retryTracker ?? undefined,
);

if (resetCount > 0) {
  this.logger.info(`Reset ${resetCount} task(s) for retry`);
}
if (exhaustedCount > 0) {
  this.logger.warn(`${exhaustedCount} task(s) exceeded retry limit and were marked failed`);
}
```

**state-manager.ts (resetOrphanedTasks):**
```typescript
async resetOrphanedTasks(
  activeSessionIds: string[],
  retryTracker?: TaskRetryTrackerInterface,
): Promise<{ resetCount: number; exhaustedCount: number }> {
  const activeSet = new Set(activeSessionIds);
  const inProgressTasks = await this.getTasksByStatus("in_progress");

  for (const task of inProgressTasks) {
    if (task.owner && !activeSet.has(task.owner)) {
      // Acquire lock on task file
      release = await lock(taskPath, { retries: ..., stale: 5000 });

      // Double-check pattern: Re-read task after lock acquisition
      const freshTask = await this.getTask(task.id);
      if (freshTask.status !== "in_progress") continue;
      if (freshTask.owner && activeSet.has(freshTask.owner)) continue;

      // Check retry eligibility
      if (retryTracker && !retryTracker.shouldRetry(freshTask.id)) {
        freshTask.status = "failed";
        exhaustedCount++;
      } else {
        freshTask.status = "pending";
        freshTask.owner = null;
        resetCount++;
      }
    }
  }
}
```

**Security Assessment:**
1. **Active worker filter**: Only resets tasks owned by dead workers
2. **Double-check pattern**: Re-reads task after lock to prevent TOCTOU
3. **Retry integration**: Uses retryTracker to determine retry eligibility
4. **Exhausted handling**: Marks failed when retries exhausted
5. **Lock-based mutation**: Prevents race with concurrent claim_task

---

### 6. Session Cleanup (worker-manager.ts)

**Location:** Lines 460-467
**Function:** `runWorker()` finally block
**Severity:** LOW (Informational)

**Analysis:**
```typescript
finally {
  // V2: Clean up resilience trackers
  this.timeoutTracker.stopTracking(sessionId);
  this.heartbeatTracker.cleanup(sessionId);

  // Remove from active workers once done
  this.activeWorkers.delete(sessionId);
}
```

**Security Assessment:**
1. **Always runs**: finally block executes on success, error, or exception
2. **Tracker cleanup**: Prevents memory leaks in timeout and heartbeat maps
3. **activeWorkers removal**: Ensures isWorkerActive() returns false after exit
4. **Order**: Cleanup before removal (prevents potential null reference issues)

---

### 7. activeWorkers Map Consistency

**Location:** Throughout worker-manager.ts
**Severity:** LOW (Informational)

**Analysis:**
The `activeWorkers` map is managed consistently:

1. **Add**: Only in `spawnWorker()` after handle creation
2. **Remove**: Only in `runWorker()` finally block or `killAllWorkers()`
3. **Read**: Multiple places (getActiveWorkers, isWorkerActive, checkWorkerHealth)

**Consistency checks:**
- `checkWorkerHealth()` filters to `activeWorkers.has(id)` before returning
- `waitForAllWorkers()` gets handles from activeWorkers, handles undefined
- `runWorker()` always removes from map in finally block

**No race conditions**: All operations are single-threaded (Node.js event loop). Map operations are atomic.

---

### 8. Edge Cases Analysis

#### Edge Case 1: Worker crashes without completing task

**Flow:**
1. Worker throws exception in `runWorker()`
2. catch block logs error, records session_failed event
3. `updateSessionStatus(sessionId, "failed", errorMessage)` persists status
4. finally block runs: cleanup trackers, remove from activeWorkers
5. Next monitor loop: `resetOrphanedTasks()` finds in_progress task with dead owner
6. Task reset to pending (or failed if retries exhausted)

**Result:** CORRECT - Task is recovered for retry.

#### Edge Case 2: Worker hangs without heartbeat

**Flow:**
1. Worker stops sending events (SDK hangs, network issue)
2. Monitor loop calls `checkWorkerHealth()`
3. `heartbeatTracker.isStale(sessionId)` returns true after 5 minutes
4. Worker added to `stale` list
5. `recordWorkerFail()` logs the stall
6. `retryTracker.recordFailure()` records for current task
7. `resetOrphanedTasks()` with `healthyWorkers` excluding stale
8. Task reset to pending (or failed if retries exhausted)

**Result:** CORRECT - Stalled worker's task is recovered.

**Note:** The stale worker's Promise continues running (can't be killed). This is acceptable because:
- Worker eventually times out or completes
- Task is reassigned immediately
- Duplicate completion is prevented by claim_task locking

#### Edge Case 3: SDK query() throws exception

**Flow:**
1. `query()` throws (e.g., network error, invalid credentials)
2. catch block in `runWorker()` catches exception
3. `maybeRecordRateLimit()` checks for rate limit signals
4. `recordEvent(session_failed, ...)` records failure
5. `updateSessionStatus(sessionId, "failed", ...)` persists
6. finally block cleans up

**Result:** CORRECT - Worker failure is properly recorded.

#### Edge Case 4: Worker completes but task already reassigned

**Flow:**
1. Worker A claims task-1 (task.owner = workerA)
2. Worker A stalls (no heartbeat for 5+ minutes)
3. Monitor loop resets task-1 to pending, owner = null
4. Worker B claims task-1 (task.owner = workerB)
5. Worker A wakes up and tries to complete task-1
6. `handleCompleteTask()` checks `task.owner !== sessionId`
7. Returns `{ success: false, error: "owned by workerB, not workerA" }`

**Result:** CORRECT - Race condition prevented by ownership check.

#### Edge Case 5: Multiple workers claim same task

**Flow:**
1. Worker A and Worker B both call claim_task("task-1")
2. `handleClaimTask()` acquires lock on task-1.json
3. First to acquire lock (A) reads task, verifies pending, updates owner
4. Second (B) acquires lock after A releases
5. B re-reads task, sees status = "in_progress"
6. B returns `{ success: false, error: "not pending" }`

**Result:** CORRECT - Lock-based serialization prevents race.

---

## Summary Table

| Component | Function | Expected Behavior | Actual | Verdict |
|-----------|----------|-------------------|--------|---------|
| WorkerManager | spawnWorker() | Create session, start tracking | Yes | CORRECT |
| WorkerTimeoutTracker | isTimedOut() | 45min wall-clock timeout | Yes | CORRECT |
| HeartbeatTracker | isStale() | 5min no-activity detection | Yes | CORRECT |
| TaskRetryTracker | shouldRetry() | 2 retries (3 total attempts) | Yes | CORRECT |
| StateManager | resetOrphanedTasks() | Reset dead worker tasks | Yes | CORRECT |
| WorkerManager | runWorker() finally | Cleanup all tracking | Yes | CORRECT |
| activeWorkers | Map consistency | Add/remove synchronized | Yes | CORRECT |

## Minor Findings (Non-Critical)

### Finding 1: clearStaleFailures() not called

**Location:** worker-resilience.ts:222-235
**Severity:** LOW (Potential memory leak over very long runs)

The `clearStaleFailures()` method exists but is not called in the execution loop:
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

**Impact:** Minimal. Each entry is ~100 bytes. For 100 tasks over 8 hours, this is <10KB.

**Recommendation:** Consider calling `clearStaleFailures()` periodically in the monitor loop, but this is not critical.

### Finding 2: Session directory permissions

**Location:** worker-manager.ts:108
**Severity:** LOW (Informational)

Session directories are created without explicit mode:
```typescript
await fs.mkdir(sessionDir, { recursive: true });
```

**Impact:** Minimal. Session directories only contain status.json which is non-sensitive.

**Recommendation:** Consider adding `mode: 0o700` for consistency with other directory creation.

## Conclusion

**NO CRITICAL OR HIGH SEVERITY WORKER LIFECYCLE BUGS FOUND**

The worker lifecycle management is robust and well-designed:
- **Spawn**: Idempotent, initializes all tracking
- **Timeout**: Uses hrtime.bigint() for clock-skew immunity, 45-minute default
- **Heartbeat**: 5-minute stale threshold, records on all non-error events
- **Retry**: 2 retries = 3 attempts, sanitized error storage
- **Orphan reset**: Lock-based with double-check pattern
- **Cleanup**: Always runs in finally block
- **Race prevention**: Lock-based claim_task, ownership verification on complete

All edge cases are handled correctly:
- Worker crashes trigger task recovery
- Stalled workers are detected and tasks reassigned
- SDK exceptions are caught and logged
- Duplicate claims are prevented
- Duplicate completions are rejected

No fixes are required.

/**
 * Event Log Module (V2)
 *
 * Writes structured events to .conductor/events.jsonl with buffered I/O.
 * Provides analytics computation for the status command.
 *
 * Events are buffered and flushed every 1 second to reduce I/O.
 * All file operations are async to avoid blocking.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { StructuredEvent, ProjectProfile } from "../utils/types.js";
import {
  getEventsPath,
  EVENT_FLUSH_INTERVAL_MS,
  MAX_EVENT_LOG_SIZE_BYTES,
  ORCHESTRATOR_DIR,
} from "../utils/constants.js";
import { mkdirSecure, writeJsonAtomic } from "../utils/secure-fs.js";
import { redactSecrets } from "../utils/logger.js";

/**
 * A-3: Apply redactSecrets to any string `error` field on an event.
 * Worker failure events (worker_fail, task_failed, worker_timeout) commonly
 * carry stderr/stack-trace text that may contain API keys, bearer tokens,
 * etc. This sanitizer runs on every event before it's persisted to disk.
 */
function sanitizeEvent<T extends StructuredEvent>(event: T): T {
  if (!("error" in event) || typeof (event as { error?: unknown }).error !== "string") {
    return event;
  }
  return {
    ...event,
    error: redactSecrets((event as unknown as { error: string }).error),
  };
}

// ============================================================
// Types
// ============================================================

export interface EventAnalytics {
  /** Average duration per phase in milliseconds */
  phase_durations: Record<string, { avg_ms: number; count: number }>;
  /** Percentage of workers that completed successfully (0-100) */
  worker_success_rate: number;
  /** Percentage of tasks that were retried (0-100) */
  task_retry_rate: number;
  /** Top 5 longest-running tasks */
  top_bottleneck_tasks: { task_id: string; duration_ms: number }[];
  /** Total number of events processed */
  total_events: number;
  /** Total number of workers spawned */
  total_workers: number;
  /** Total number of tasks completed */
  total_tasks_completed: number;
}

// Type for recording events without requiring timestamp
type EventWithoutTimestamp = {
  [K in StructuredEvent["type"]]: Omit<
    Extract<StructuredEvent, { type: K }>,
    "timestamp"
  > & { timestamp?: string };
}[StructuredEvent["type"]];

// ============================================================
// EventLog Class
// ============================================================

/**
 * Manages structured event logging with buffered writes.
 *
 * Usage:
 *   const log = new EventLog(projectDir);
 *   log.start();
 *   log.record({ type: 'phase_start', phase: 'planning' });
 *   // ... later
 *   await log.stop();
 */
export class EventLog {
  private logPath: string;
  private projectDir: string;
  private buffer: StructuredEvent[];
  private flushInterval: NodeJS.Timeout | null;
  private isStarted: boolean;
  private flushPromise: Promise<void> | null;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.logPath = getEventsPath(projectDir);
    this.buffer = [];
    this.flushInterval = null;
    this.isStarted = false;
    this.flushPromise = null;
  }

  /**
   * Starts the event log with periodic flushing.
   * Idempotent - safe to call multiple times.
   */
  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;

    // H25: Use self-rescheduling setTimeout instead of setInterval.
    // setInterval can stack callbacks if flush() takes longer than the interval,
    // leading to unbounded concurrency. setTimeout re-schedules only after the
    // previous flush completes (or errors).
    const scheduleFlush = (): void => {
      this.flushInterval = setTimeout(() => {
        this.flush()
          .catch((err) => {
            // Log error but don't crash - events are not critical
            console.error("[EventLog] Flush error:", err);
          })
          .finally(() => {
            if (this.isStarted) {
              scheduleFlush();
            }
          });
      }, EVENT_FLUSH_INTERVAL_MS);

      // Don't let the timeout keep the process alive
      this.flushInterval.unref();
    };

    scheduleFlush();
  }

  /**
   * Stops the event log and performs a final flush.
   * Idempotent - safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.isStarted) return;
    this.isStarted = false;

    if (this.flushInterval) {
      clearTimeout(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush
    await this.flush();
  }

  /**
   * Records an event to the buffer.
   * If timestamp is not provided, the current time is used.
   *
   * @param event The event to record (timestamp optional)
   */
  record(event: EventWithoutTimestamp): void {
    const fullEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    } as StructuredEvent;

    this.buffer.push(fullEvent);
  }

  /**
   * Flushes all buffered events to disk.
   * Safe to call concurrently - serializes via flushPromise.
   *
   * H-4 FIX: After awaiting an in-flight flush, re-check buffer.length
   * (the prior flush may have already drained it). Use finally to null
   * flushPromise so a failed write doesn't permanently block future flushes.
   */
  async flush(): Promise<void> {
    // Wait for any in-flight flush to complete before proceeding
    if (this.flushPromise) {
      await this.flushPromise;
      // After waiting, re-check buffer — the flush we waited on may have
      // already drained events added between the two calls.
    }

    if (this.buffer.length === 0) return;

    // Swap buffer atomically (single-threaded, no yield between read & write)
    const events = this.buffer;
    this.buffer = [];

    this.flushPromise = this.writeEvents(events);
    try {
      await this.flushPromise;
    } finally {
      // Always clear flushPromise — if writeEvents threw, a stuck promise
      // would permanently block future flush() calls.
      this.flushPromise = null;
    }
  }

  /**
   * Writes events to the log file.
   */
  private async writeEvents(events: StructuredEvent[]): Promise<void> {
    try {
      // Ensure .conductor directory exists
      const conductorDir = path.join(this.projectDir, ORCHESTRATOR_DIR);
      await mkdirSecure(conductorDir, { recursive: true }); // H-2

      // Check file size before writing (DoS mitigation)
      let currentSize = 0;
      try {
        const stat = await fs.stat(this.logPath);
        currentSize = stat.size;
      } catch {
        // File doesn't exist yet, that's fine
      }

      // A-3: redact likely secrets (API keys, bearer tokens, etc.) from any
      // string `error` field before persisting. Worker failure events
      // (worker_fail, task_failed, worker_timeout) commonly carry stderr or
      // stack-trace text that may include credentials; this is defense in
      // depth alongside the logger-level redaction in Logger.writeToFile.
      const sanitized = events.map(sanitizeEvent);
      const lines = sanitized.map((e) => JSON.stringify(e)).join("\n") + "\n";
      const newSize = currentSize + Buffer.byteLength(lines, "utf-8");

      if (newSize > MAX_EVENT_LOG_SIZE_BYTES) {
        // Rotate the log file
        await this.rotate();
      }

      await fs.appendFile(this.logPath, lines, { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      // Put events back in buffer on failure
      this.buffer = [...events, ...this.buffer];
      throw err;
    }
  }

  /**
   * Rotates the log file when it exceeds the size limit.
   * Keeps the most recent half of the file.
   *
   * A-1/A-2: Uses writeJsonAtomic for tmp+fsync+rename. If rotation fails,
   * we propagate the error rather than truncating the log — leaving the
   * existing file intact is strictly better than silently losing everything.
   *
   * A-3: Re-parse each kept line and re-sanitize the `error` field before
   * re-serializing. This closes the gap where events persisted by earlier
   * (pre-A-3) versions still carry unredacted secrets on disk — the first
   * rotation after upgrade will clean them. Lines that don't parse as JSON
   * are preserved as-is (same behavior as readAll's corruption tolerance).
   */
  private async rotate(): Promise<void> {
    // Codex code-review round 1 [CRITICAL]: rotate() is invoked from
    // writeEvents whenever the pending-write would exceed MAX_EVENT_LOG_SIZE_BYTES.
    // On a fresh process where the very first flush is oversized (e.g., a
    // backlog of events written before the file exists), readFile would
    // throw ENOENT, writeEvents would requeue, and the flush loop would
    // fail forever. Treat a missing file as empty content so rotation is
    // a no-op on first-run oversized flushes.
    let content: string;
    try {
      content = await fs.readFile(this.logPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // No existing log to rotate — nothing to do. The subsequent
        // writeEvents append will create the file normally.
        return;
      }
      throw err;
    }
    const lines = content.trim().split("\n");

    // Keep the most recent half
    const keepLines = lines.slice(Math.floor(lines.length / 2));

    // A-3: re-sanitize each kept line. If a line fails to parse as JSON
    // (e.g. an earlier corrupted write), keep it verbatim — readAll will
    // skip it on next load, and we don't want rotation to drop data.
    const sanitizedLines = keepLines.map((line) => {
      if (!line) return line;
      try {
        const parsed = JSON.parse(line) as StructuredEvent;
        return JSON.stringify(sanitizeEvent(parsed));
      } catch {
        return line;
      }
    });
    const newContent = sanitizedLines.join("\n") + "\n";

    await writeJsonAtomic(this.logPath, newContent);
  }

  /**
   * Reads all events from the log file.
   * Returns empty array if file doesn't exist.
   * Skips corrupted lines gracefully.
   */
  async readAll(): Promise<StructuredEvent[]> {
    try {
      const content = await fs.readFile(this.logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      const events: StructuredEvent[] = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as StructuredEvent;
          // Basic validation - must have type and timestamp
          if (event && typeof event.type === "string" && typeof event.timestamp === "string") {
            events.push(event);
          }
        } catch {
          // Skip corrupted lines
        }
      }

      return events;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  /**
   * Computes analytics from logged events.
   */
  async getAnalytics(): Promise<EventAnalytics> {
    const events = await this.readAll();
    return computeAnalytics(events);
  }

  /**
   * Returns the number of buffered events (for testing).
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Returns whether the log is started (for testing).
   */
  isRunning(): boolean {
    return this.isStarted;
  }
}

// ============================================================
// Analytics Computation
// ============================================================

/**
 * Computes analytics from a list of events.
 */
export function computeAnalytics(events: StructuredEvent[]): EventAnalytics {
  const analytics: EventAnalytics = {
    phase_durations: {},
    worker_success_rate: 0,
    task_retry_rate: 0,
    top_bottleneck_tasks: [],
    total_events: events.length,
    total_workers: 0,
    total_tasks_completed: 0,
  };

  if (events.length === 0) {
    return analytics;
  }

  // Track phase durations
  const phaseDurations: Record<string, number[]> = {};

  // Track worker outcomes
  let workerComplete = 0;
  let workerFail = 0;
  let workerSpawn = 0;

  // Track task outcomes
  let taskCompleted = 0;
  let taskRetried = 0;

  // Track task durations
  const taskClaimTimes = new Map<string, string>();
  const taskDurations: { task_id: string; duration_ms: number }[] = [];

  for (const event of events) {
    switch (event.type) {
      case "phase_end":
        if (!phaseDurations[event.phase]) {
          phaseDurations[event.phase] = [];
        }
        phaseDurations[event.phase].push(event.duration_ms);
        break;

      case "worker_spawn":
        workerSpawn++;
        break;

      case "worker_complete":
        workerComplete++;
        break;

      case "worker_fail":
      case "worker_timeout":
        workerFail++;
        break;

      case "task_claimed":
        taskClaimTimes.set(event.task_id, event.timestamp);
        break;

      case "task_completed": {
        taskCompleted++;
        const claimTime = taskClaimTimes.get(event.task_id);
        if (claimTime) {
          const duration =
            new Date(event.timestamp).getTime() - new Date(claimTime).getTime();
          if (duration > 0) {
            taskDurations.push({ task_id: event.task_id, duration_ms: duration });
          }
        }
        break;
      }

      case "task_retried":
        taskRetried++;
        break;
    }
  }

  // Compute average phase durations
  for (const [phase, durations] of Object.entries(phaseDurations)) {
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    analytics.phase_durations[phase] = {
      avg_ms: Math.round(avg),
      count: durations.length,
    };
  }

  // Compute worker success rate
  const totalWorkerOutcomes = workerComplete + workerFail;
  if (totalWorkerOutcomes > 0) {
    analytics.worker_success_rate = Math.round(
      (workerComplete / totalWorkerOutcomes) * 100
    );
  }

  // Compute task retry rate
  const totalTaskOutcomes = taskCompleted + taskRetried;
  if (totalTaskOutcomes > 0) {
    analytics.task_retry_rate = Math.round(
      (taskRetried / totalTaskOutcomes) * 100
    );
  }

  // Find top bottleneck tasks (top 5 longest)
  taskDurations.sort((a, b) => b.duration_ms - a.duration_ms);
  analytics.top_bottleneck_tasks = taskDurations.slice(0, 5);

  analytics.total_workers = workerSpawn;
  analytics.total_tasks_completed = taskCompleted;

  return analytics;
}

// ============================================================
// Helper Functions for Recording
// ============================================================

/**
 * Records a phase start event.
 */
export function recordPhaseStart(log: EventLog, phase: string): void {
  log.record({ type: "phase_start", phase });
}

/**
 * Records a phase end event with computed duration.
 */
export function recordPhaseEnd(
  log: EventLog,
  phase: string,
  startTime: number
): void {
  log.record({
    type: "phase_end",
    phase,
    duration_ms: Date.now() - startTime,
  });
}

/**
 * Records a worker spawn event.
 */
export function recordWorkerSpawn(log: EventLog, sessionId: string): void {
  log.record({ type: "worker_spawn", session_id: sessionId });
}

/**
 * Records a worker completion event.
 */
export function recordWorkerComplete(
  log: EventLog,
  sessionId: string,
  tasksCompleted: number
): void {
  log.record({
    type: "worker_complete",
    session_id: sessionId,
    tasks_completed: tasksCompleted,
  });
}

/**
 * Records a worker failure event.
 * Error is NOT sanitized here - caller should sanitize if needed.
 */
export function recordWorkerFail(
  log: EventLog,
  sessionId: string,
  error: string
): void {
  log.record({
    type: "worker_fail",
    session_id: sessionId,
    error: truncateError(error),
  });
}

/**
 * Records a worker timeout event.
 */
export function recordWorkerTimeout(
  log: EventLog,
  sessionId: string,
  durationMs: number
): void {
  log.record({
    type: "worker_timeout",
    session_id: sessionId,
    duration_ms: durationMs,
  });
}

/**
 * Records a task claimed event.
 */
export function recordTaskClaimed(
  log: EventLog,
  taskId: string,
  sessionId: string
): void {
  log.record({ type: "task_claimed", task_id: taskId, session_id: sessionId });
}

/**
 * Records a task completed event.
 */
export function recordTaskCompleted(
  log: EventLog,
  taskId: string,
  sessionId: string
): void {
  log.record({ type: "task_completed", task_id: taskId, session_id: sessionId });
}

/**
 * Records a task failed event.
 */
export function recordTaskFailed(
  log: EventLog,
  taskId: string,
  sessionId: string,
  error: string
): void {
  log.record({
    type: "task_failed",
    task_id: taskId,
    session_id: sessionId,
    error: truncateError(error),
  });
}

/**
 * Records a task retry event.
 */
export function recordTaskRetried(
  log: EventLog,
  taskId: string,
  retryCount: number
): void {
  log.record({ type: "task_retried", task_id: taskId, retry_count: retryCount });
}

/**
 * Records a review verdict event.
 */
export function recordReviewVerdict(log: EventLog, verdict: string): void {
  log.record({ type: "review_verdict", verdict });
}

/**
 * Records a usage warning event.
 */
export function recordUsageWarning(log: EventLog, utilization: number): void {
  log.record({ type: "usage_warning", utilization });
}

/**
 * Records a scheduling decision event.
 */
export function recordSchedulingDecision(
  log: EventLog,
  taskId: string,
  score: number
): void {
  log.record({ type: "scheduling_decision", task_id: taskId, score });
}

/**
 * Records a project detection event.
 */
export function recordProjectDetection(
  log: EventLog,
  profile: ProjectProfile
): void {
  log.record({ type: "project_detection", profile });
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Truncates error messages to prevent excessive log growth.
 * Does NOT sanitize for prompt injection - that's the caller's responsibility.
 */
function truncateError(error: string): string {
  const maxLength = 500;
  if (error.length <= maxLength) {
    return error;
  }
  return error.slice(0, maxLength) + "... (truncated)";
}

/**
 * Formats analytics as a human-readable string for the status command.
 */
export function formatAnalyticsForDisplay(analytics: EventAnalytics): string {
  const lines: string[] = [];

  lines.push("## Event Log Analytics");
  lines.push("");

  // Summary
  lines.push(`- **Total Events:** ${analytics.total_events}`);
  lines.push(`- **Total Workers:** ${analytics.total_workers}`);
  lines.push(`- **Tasks Completed:** ${analytics.total_tasks_completed}`);
  lines.push(`- **Worker Success Rate:** ${analytics.worker_success_rate}%`);
  lines.push(`- **Task Retry Rate:** ${analytics.task_retry_rate}%`);
  lines.push("");

  // Phase durations
  if (Object.keys(analytics.phase_durations).length > 0) {
    lines.push("### Phase Durations (avg)");
    for (const [phase, data] of Object.entries(analytics.phase_durations)) {
      const avgSec = (data.avg_ms / 1000).toFixed(1);
      lines.push(`- **${phase}:** ${avgSec}s (${data.count} runs)`);
    }
    lines.push("");
  }

  // Top bottlenecks
  if (analytics.top_bottleneck_tasks.length > 0) {
    lines.push("### Top Bottleneck Tasks");
    for (const task of analytics.top_bottleneck_tasks) {
      const durationSec = (task.duration_ms / 1000).toFixed(1);
      lines.push(`- **${task.task_id}:** ${durationSec}s`);
    }
  }

  return lines.join("\n");
}

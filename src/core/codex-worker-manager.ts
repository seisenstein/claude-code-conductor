import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type {
  ExecutionWorkerManager,
  Message,
  ModelConfig,
  OrchestratorEvent,
  SessionStatus,
  WorkerSharedContext,
} from "../utils/types.js";
import { DEFAULT_MODEL_CONFIG } from "../utils/types.js";
import {
  MESSAGES_DIR,
  SESSIONS_DIR,
  SESSION_STATUS_FILE,
  SENTINEL_SESSION_ID,
  MAX_BUFFER_SIZE_BYTES,
  getCodexModel,
} from "../utils/constants.js";
import { getWorkerPrompt } from "../worker-prompt.js";
import { getSentinelPrompt } from "../sentinel-prompt.js";
import type { Logger } from "../utils/logger.js";
import { coerceLogText, detectProviderRateLimit } from "../utils/provider-limit.js";
import { appendJsonlLocked, writeFileSecure, mkdirSecure } from "../utils/secure-fs.js";
// H-9 FIX: Import resilience trackers for heartbeat-based stale detection
// H-10 FIX: Import TaskRetryTracker for retry tracking with session resumption
import { HeartbeatTracker, TaskRetryTracker, WorkerTimeoutTracker } from "./worker-resilience.js";

interface WorkerHandle {
  sessionId: string;
  promise: Promise<void>;
  events: OrchestratorEvent[];
  startedAt: string;
  child: ChildProcess | null;
  lastMessage: string | null;
  rateLimitReported: boolean;
  // H-9: Monotonic timestamp of last JSONL event for heartbeat tracking
  lastEventAt: bigint;
  // H-9: Thread ID from thread.started JSONL event (used for session resumption in H-10)
  threadId: string | null;
  // H-10 FIX: Task ID for retry attribution (set when worker claims a task)
  taskId: string | null;
  // Flag to prevent double-counting failures when orchestrator terminates a worker.
  // When set, the settle path should NOT record a separate failure since the
  // orchestrator already recorded one before calling terminateWorker().
  terminatedByOrchestrator: boolean;
}

type CodexSandboxMode = "workspace-write" | "read-only";

export class CodexWorkerManager implements ExecutionWorkerManager {
  private activeWorkers: Map<string, WorkerHandle> = new Map();
  private pendingEvents: OrchestratorEvent[] = [];

  private workerContext: WorkerSharedContext = {};

  // H-9 FIX: Resilience trackers for heartbeat-based stale detection and wall-clock timeout
  private heartbeatTracker: HeartbeatTracker;
  private timeoutTracker: WorkerTimeoutTracker;
  // H-10 FIX: Retry tracker for task failure tracking with session resumption
  private retryTracker: TaskRetryTracker;
  // H-10 FIX: Store thread IDs by TASK ID (not session ID) for resume support.
  // When a worker fails on a task, we preserve the thread ID so that when a new
  // worker retries that task, it can attempt to resume the Codex session.
  private taskThreadIds: Map<string, string> = new Map();
  // H-10 FIX (Task 9): Authoritative session-to-task mapping for failure attribution
  // Maps sessionId -> taskId. Updated when orchestrator notifies us of task claims.
  private sessionToTaskMap: Map<string, string> = new Map();

  // M-19: Accept ModelConfig for Codex model selection and subagent model hints
  // H-15: concurrency is used to gate `codex exec resume --last` — it can
  // only target a specific thread when we're the only worker, otherwise
  // --last may resume the wrong session.
  constructor(
    private projectDir: string,
    private orchestratorDir: string,
    private mcpServerPath: string,
    private logger: Logger,
    private modelConfig: ModelConfig = DEFAULT_MODEL_CONFIG,
    private concurrency: number = 1,
  ) {
    this.heartbeatTracker = new HeartbeatTracker();
    this.timeoutTracker = new WorkerTimeoutTracker();
    this.retryTracker = new TaskRetryTracker();
  }

  setWorkerContext(context: WorkerSharedContext): void {
    this.workerContext = context;
  }

  // taskTypeHint accepted for interface conformance with WorkerManager.
  // Codex backend currently uses a single tier across all task types — the
  // hint is recorded for future per-role Codex model selection.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async spawnWorker(sessionId: string, _taskTypeHint?: import("../utils/types.js").TaskType | null): Promise<void> {
    if (this.activeWorkers.has(sessionId)) {
      this.logger.warn(`Worker ${sessionId} is already active; skipping spawn`);
      return;
    }

    this.logger.info(`Spawning Codex worker: ${sessionId}`);
    await this.initializeSessionStatus(sessionId, "Worker session starting...");

    const handle: WorkerHandle = {
      sessionId,
      promise: Promise.resolve(),
      events: [],
      startedAt: new Date().toISOString(),
      child: null,
      lastMessage: null,
      rateLimitReported: false,
      lastEventAt: process.hrtime.bigint(),
      threadId: null,
      taskId: null, // H-10 FIX: Task ID set via registerTaskClaim()
      terminatedByOrchestrator: false,
    };

    this.activeWorkers.set(sessionId, handle);
    // H-9 FIX: Start resilience tracking for heartbeat and timeout detection
    this.timeoutTracker.startTracking(sessionId);
    this.heartbeatTracker.recordHeartbeat(sessionId); // Initial heartbeat
    handle.promise = this.runCodexSession(
      sessionId,
      handle,
      this.buildWorkerPrompt(sessionId),
      "workspace-write",
      "Codex worker running...",
    );
  }

  async spawnSentinelWorker(): Promise<void> {
    const sentinelId = SENTINEL_SESSION_ID;

    if (this.activeWorkers.has(sentinelId)) {
      this.logger.warn("Security sentinel is already running");
      return;
    }

    this.logger.info("Spawning Codex security sentinel...");
    await this.initializeSessionStatus(sentinelId, "Security sentinel starting...");

    const handle: WorkerHandle = {
      sessionId: sentinelId,
      promise: Promise.resolve(),
      events: [],
      startedAt: new Date().toISOString(),
      child: null,
      lastMessage: null,
      rateLimitReported: false,
      lastEventAt: process.hrtime.bigint(),
      threadId: null,
      taskId: null, // Sentinel doesn't work on tasks
      terminatedByOrchestrator: false,
    };

    this.activeWorkers.set(sentinelId, handle);
    // H-9 FIX: Start resilience tracking for heartbeat and timeout detection
    this.timeoutTracker.startTracking(sentinelId);
    this.heartbeatTracker.recordHeartbeat(sentinelId); // Initial heartbeat
    handle.promise = this.runCodexSession(
      sentinelId,
      handle,
      this.buildSentinelPrompt(),
      "read-only",
      "Security sentinel running...",
    );
  }

  getActiveWorkers(): string[] {
    return Array.from(this.activeWorkers.keys());
  }

  isWorkerActive(sessionId: string): boolean {
    return this.activeWorkers.has(sessionId);
  }

  async signalWindDown(reason: string, resetsAt?: string): Promise<void> {
    // H15: Validate wind_down reason against expected union type
    const VALID_REASONS = ["usage_limit", "cycle_limit", "user_requested"] as const;
    if (!VALID_REASONS.includes(reason as typeof VALID_REASONS[number])) {
      this.logger.warn(`Unknown wind_down reason: "${reason}". Using "user_requested" as default.`);
      reason = "user_requested";
    }
    this.logger.info(`Sending wind-down signal to all workers: ${reason}`);

    const messagesDir = path.join(this.orchestratorDir, MESSAGES_DIR);
    // H-9/H-10 FIX: Use mkdirSecure for secure directory permissions (mode 0o700)
    await mkdirSecure(messagesDir);

    const message: Message = {
      id: `orchestrator-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      from: "orchestrator",
      type: "wind_down",
      content: `Wind down: ${reason}. Please finish your current task, commit your work, and exit cleanly.`,
      metadata: {
        reason: reason as "usage_limit" | "cycle_limit" | "user_requested",
        ...(resetsAt ? { resets_at: resetsAt } : {}),
      },
      timestamp: new Date().toISOString(),
    };

    const messagePath = path.join(messagesDir, "orchestrator.jsonl");
    await appendJsonlLocked(messagePath, message);
  }

  async waitForAllWorkers(timeoutMs: number): Promise<void> {
    const workerIds = this.getActiveWorkers();
    if (workerIds.length === 0) {
      this.logger.info("No active workers to wait for.");
      return;
    }

    this.logger.info(
      `Waiting for ${workerIds.length} worker(s) to finish (timeout: ${Math.round(timeoutMs / 1000)}s)...`,
    );

    const promises = workerIds.map((id) => this.activeWorkers.get(id)?.promise ?? Promise.resolve());
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (timer.unref) {
        timer.unref();
      }
    });

    const result = await Promise.race([
      Promise.allSettled(promises).then(() => "done" as const),
      timeoutPromise,
    ]);

    if (result === "timeout") {
      const remaining = this.getActiveWorkers();
      this.logger.warn(
        `Timeout reached. ${remaining.length} worker(s) still active: ${remaining.join(", ")}`,
      );
    } else {
      this.logger.info("All workers have finished.");
    }
  }

  async killAllWorkers(): Promise<void> {
    const workerIds = this.getActiveWorkers();
    if (workerIds.length === 0) {
      return;
    }

    this.logger.warn(`Force-killing ${workerIds.length} worker(s): ${workerIds.join(", ")}`);
    await this.signalWindDown("user_requested");

    // H14: Send SIGTERM first, then wait up to 10s, then SIGKILL if still running
    const KILL_TIMEOUT_MS = 10_000;

    for (const sessionId of workerIds) {
      const handle = this.activeWorkers.get(sessionId);
      if (handle?.child && !handle.child.killed) {
        handle.child.kill("SIGTERM");
      }
    }

    // Wait up to KILL_TIMEOUT_MS for workers to exit
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), KILL_TIMEOUT_MS),
    );
    const promises = workerIds
      .map((id) => this.activeWorkers.get(id)?.promise)
      .filter((p): p is Promise<void> => p !== undefined);

    const result = await Promise.race([
      Promise.allSettled(promises).then(() => "done" as const),
      timeout,
    ]);

    if (result === "timeout") {
      // Escalate to SIGKILL for still-running workers
      for (const sessionId of this.getActiveWorkers()) {
        const handle = this.activeWorkers.get(sessionId);
        if (handle?.child && !handle.child.killed) {
          this.logger.warn(`Worker ${sessionId} did not exit after SIGTERM; sending SIGKILL`);
          handle.child.kill("SIGKILL");
        }
      }
    }

    // Force-remove any remaining workers from tracking
    for (const sessionId of [...this.activeWorkers.keys()]) {
      await this.updateSessionStatus(sessionId, "done", "Force killed by orchestrator");
      this.sessionToTaskMap.delete(sessionId);
      this.activeWorkers.delete(sessionId);
    }

    this.logger.info("All Codex workers have been killed and removed from tracking.");
  }

  /**
   * Terminate a specific worker by session ID.
   * Sends SIGTERM, waits up to 5s, then SIGKILL if still running.
   * Cleans up all tracking state for the worker.
   */
  async terminateWorker(sessionId: string): Promise<void> {
    const handle = this.activeWorkers.get(sessionId);
    if (!handle) {
      return;
    }

    this.logger.warn(`Terminating worker ${sessionId}`);

    // Mark as orchestrator-terminated so the settle path does not double-count
    // the failure (the orchestrator already recorded it in the retry tracker).
    handle.terminatedByOrchestrator = true;

    // Send SIGTERM
    if (handle.child && !handle.child.killed) {
      handle.child.kill("SIGTERM");
    }

    // Wait up to 5s for graceful exit
    const TERM_TIMEOUT_MS = 5_000;
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), TERM_TIMEOUT_MS),
    );

    if (handle.promise) {
      const result = await Promise.race([
        handle.promise.then(() => "done" as const).catch(() => "done" as const),
        timeout,
      ]);

      if (result === "timeout" && handle.child && !handle.child.killed) {
        this.logger.warn(`Worker ${sessionId} did not exit after SIGTERM; sending SIGKILL`);
        handle.child.kill("SIGKILL");
      }
    }

    // Clean up tracking state
    this.timeoutTracker.stopTracking(sessionId);
    this.heartbeatTracker.cleanup(sessionId);
    this.sessionToTaskMap.delete(sessionId);
    handle.child = null;
    this.activeWorkers.delete(sessionId);
    await this.updateSessionStatus(sessionId, "done", "Terminated by orchestrator (timed out/stale)");
  }

  getWorkerEvents(): OrchestratorEvent[] {
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    return events;
  }

  /**
   * Check worker health using resilience trackers.
   * H-9 FIX: Uses WorkerTimeoutTracker for wall-clock timeout and HeartbeatTracker
   * for JSONL-stream-based stale detection (replaces hardcoded 30-minute timeout).
   *
   * Performance: O(n) where n = active workers.
   */
  checkWorkerHealth(): { timedOut: string[]; stale: string[] } {
    const timedOut = this.timeoutTracker
      .getTimedOutWorkers()
      .filter((id) => this.activeWorkers.has(id));

    const stale = this.heartbeatTracker
      .getStaleWorkers()
      .filter((id) => this.activeWorkers.has(id) && !timedOut.includes(id));

    return { timedOut, stale };
  }

  /**
   * H-10 FIX: Get the retry tracker for task failure handling.
   * Returns a TaskRetryTracker instance (parity with WorkerManager).
   * The orchestrator uses this to record failures and check retry eligibility.
   */
  getRetryTracker(): TaskRetryTracker {
    return this.retryTracker;
  }

  /**
   * H-10 FIX (Task 9): Register a task claim for proper failure attribution.
   * Called by the orchestrator when it detects (via task file watching or polling)
   * that a worker has claimed a task. This maintains the authoritative
   * session-to-task mapping needed for retry attribution.
   *
   * @param sessionId - The worker session ID
   * @param taskId - The task ID that was claimed
   */
  registerTaskClaim(sessionId: string, taskId: string): void {
    this.sessionToTaskMap.set(sessionId, taskId);
    const handle = this.activeWorkers.get(sessionId);
    if (handle) {
      handle.taskId = taskId;
    }
    this.logger.debug(`Registered task claim: session ${sessionId} -> task ${taskId}`);
  }

  /**
   * H-10 FIX (Task 9): Clear task claim when a task is completed or released.
   * Called by the orchestrator when a task transitions out of in_progress.
   *
   * @param sessionId - The worker session ID
   */
  clearTaskClaim(sessionId: string): void {
    this.sessionToTaskMap.delete(sessionId);
    const handle = this.activeWorkers.get(sessionId);
    if (handle) {
      handle.taskId = null;
    }
  }

  /**
   * H-10 FIX (Task 9): Get the task ID currently claimed by a session.
   * Returns null if the session has no claimed task.
   *
   * @param sessionId - The worker session ID
   */
  getClaimedTaskId(sessionId: string): string | null {
    return this.sessionToTaskMap.get(sessionId) ?? null;
  }

  /**
   * H-10 FIX: Get a preserved thread ID for a task (used for session resumption).
   * Returns null if no thread ID is available for the task.
   *
   * @param taskId - The task ID to look up
   */
  getThreadIdForTask(taskId: string): string | null {
    return this.taskThreadIds.get(taskId) ?? null;
  }

  /**
   * H-10 FIX: Spawn a worker specifically for retrying a failed task.
   * If a thread ID was preserved from the previous failed attempt, this method
   * will use `codex exec resume --last` for session resumption, which allows
   * Codex to resume from its SQLite-persisted session state.
   *
   * This is more powerful than a fresh start because the worker can see what
   * was already attempted and continue from there.
   *
   * @param sessionId - New session ID for the retry worker
   * @param taskId - The task ID being retried
   * @param correctivePrompt - Optional corrective prompt explaining what went wrong
   * @param _taskTypeHint - H-10 parity with Claude WorkerManager. Codex
   *   infers role from the preserved thread, so this hint is ignored here;
   *   accepted for interface conformance.
   */
  async spawnWorkerForRetry(
    sessionId: string,
    taskId: string,
    correctivePrompt?: string,
    _taskTypeHint?: import("../utils/types.js").TaskType | null,
  ): Promise<void> {
    if (this.activeWorkers.has(sessionId)) {
      this.logger.warn(`Worker ${sessionId} is already active; skipping spawn`);
      return;
    }

    const preservedThreadId = this.taskThreadIds.get(taskId);
    const hasResumeCapability = preservedThreadId && preservedThreadId.length > 0;

    if (hasResumeCapability) {
      this.logger.info(`Spawning Codex worker ${sessionId} with session resumption for task ${taskId}`);
    } else {
      this.logger.info(`Spawning Codex worker ${sessionId} for retry of task ${taskId} (no resume available)`);
    }

    await this.initializeSessionStatus(sessionId, "Worker session starting (retry)...");

    const handle: WorkerHandle = {
      sessionId,
      promise: Promise.resolve(),
      events: [],
      startedAt: new Date().toISOString(),
      child: null,
      lastMessage: null,
      rateLimitReported: false,
      lastEventAt: process.hrtime.bigint(),
      threadId: null,
      taskId, // Pre-set task ID since this is a retry
      terminatedByOrchestrator: false,
    };

    // Pre-register the task claim since we know which task this worker will retry
    this.sessionToTaskMap.set(sessionId, taskId);

    this.activeWorkers.set(sessionId, handle);
    this.timeoutTracker.startTracking(sessionId);
    this.heartbeatTracker.recordHeartbeat(sessionId);

    // Use resume if we have a preserved thread ID, otherwise fresh start.
    // A default corrective prompt is used when none is provided, so resume
    // is not skipped just because the caller omitted a prompt.
    //
    // H-15: `codex exec resume --last` cannot target a specific thread.
    // When concurrency > 1, --last may resume the wrong session (whichever
    // ran most recently), silently cross-contaminating task contexts. Only
    // use resume when we're the only worker.
    const canUseResume = hasResumeCapability && this.concurrency === 1;

    if (canUseResume) {
      const resumePrompt = correctivePrompt ?? "Continue working on this task. The previous attempt did not complete successfully.";
      handle.promise = this.runCodexSessionWithResume(
        sessionId,
        handle,
        taskId,
        resumePrompt,
        "workspace-write",
        "Codex worker running (resumed session)...",
      );
    } else {
      if (hasResumeCapability && this.concurrency !== 1) {
        this.logger.warn(
          `Worker ${sessionId}: preserved thread ID available for task ${taskId} but concurrency=${this.concurrency} > 1. ` +
          `Skipping session resume to avoid cross-task contamination. Falling back to fresh worker.`,
        );
      }
      // Fall back to regular spawn - worker will claim the task via MCP
      handle.promise = this.runCodexSession(
        sessionId,
        handle,
        this.buildWorkerPrompt(sessionId),
        "workspace-write",
        "Codex worker running (retry)...",
      );
    }
  }

  private async initializeSessionStatus(sessionId: string, progress: string): Promise<void> {
    const sessionDir = path.join(this.orchestratorDir, SESSIONS_DIR, sessionId);
    await mkdirSecure(sessionDir);

    const initialStatus: SessionStatus = {
      session_id: sessionId,
      state: "starting",
      current_task: null,
      tasks_completed: [],
      progress,
      updated_at: new Date().toISOString(),
    };

    // H-7 FIX: Use writeFileSecure for proper permissions (owner rw only)
    await writeFileSecure(
      path.join(sessionDir, SESSION_STATUS_FILE),
      JSON.stringify(initialStatus, null, 2) + "\n",
    );
  }

  private async runCodexSession(
    sessionId: string,
    handle: WorkerHandle,
    prompt: string,
    sandbox: CodexSandboxMode,
    progress: string,
  ): Promise<void> {
    const outputPath = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sessionId,
      "codex-last-message.txt",
    );

    await this.updateSessionStatus(sessionId, "working", progress);

    return new Promise<void>((resolve, reject) => {
      const args = this.buildCodexExecArgs(sessionId, prompt, sandbox, outputPath);
      const child = spawn("codex", args, {
        cwd: this.projectDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      handle.child = child;

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let settled = false;

      const settle = (success: boolean, message: string): void => {
        if (settled) {
          return;
        }
        settled = true;

        void (async () => {
          if (success) {
            this.logger.info(`Codex worker ${sessionId} completed successfully.`);
            if (handle.lastMessage) {
              this.logger.debug(
                `Codex worker ${sessionId} final message: ${handle.lastMessage.substring(0, 200)}`,
              );
            }
            this.recordEvent(handle, { type: "session_done", sessionId });
            await this.updateSessionStatus(sessionId, "done", "Completed successfully");
          } else {
            this.logger.error(`Codex worker ${sessionId} failed: ${message}`);
            this.maybeRecordRateLimit(handle, sessionId, message);
            this.recordEvent(handle, { type: "session_failed", sessionId, error: message });
            await this.updateSessionStatus(sessionId, "failed", message);
            // H-10 FIX: Record failure in retry tracker using TASK ID (not session ID)
            // This is critical for retry attribution - StateManager.resetOrphanedTasks
            // checks retries by task.id, so we must record against the task ID.
            // Skip if the orchestrator already recorded this failure (terminatedByOrchestrator flag)
            // to avoid double-counting which can prematurely exhaust retries.
            const failedTaskId = handle.taskId ?? this.sessionToTaskMap.get(sessionId);
            if (failedTaskId && !handle.terminatedByOrchestrator) {
              this.retryTracker.recordFailure(failedTaskId, message);
              this.logger.debug(`Recorded failure for task ${failedTaskId} (session ${sessionId})`);

              // H-10 FIX: Preserve thread ID by TASK ID for resume support.
              // When a worker fails, we store its thread ID keyed by task ID (not session ID)
              // so that when a NEW session retries that task, it can retrieve the thread ID.
              if (handle.threadId && handle.threadId.length > 0) {
                this.taskThreadIds.set(failedTaskId, handle.threadId);
                this.logger.debug(`Preserved thread ID for task ${failedTaskId}: ${handle.threadId}`);
              }
            } else if (failedTaskId && handle.terminatedByOrchestrator) {
              this.logger.debug(
                `Skipping failure recording for task ${failedTaskId} (session ${sessionId}) - already recorded by orchestrator`,
              );
              // Still preserve thread ID for resume support even on orchestrator-terminated workers
              if (handle.threadId && handle.threadId.length > 0) {
                this.taskThreadIds.set(failedTaskId, handle.threadId);
              }
            } else {
              // Fallback: sentinel or worker that never claimed a task
              this.logger.warn(`Worker ${sessionId} failed but has no associated task ID`);
            }
          }

          // H-9 FIX: Clean up resilience trackers to prevent memory leaks
          this.timeoutTracker.stopTracking(sessionId);
          this.heartbeatTracker.cleanup(sessionId);
          this.sessionToTaskMap.delete(sessionId);

          handle.child = null;
          this.activeWorkers.delete(sessionId);
        })()
          .then(() => {
            if (success) {
              resolve();
            } else {
              reject(new Error(message));
            }
          })
          .catch(reject);
      };

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");

      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer = this.consumeLines(stdoutBuffer + chunk, (line) => {
          this.processCodexOutputLine(sessionId, handle, line);
        });
      });

      child.stderr.on("data", (chunk: string) => {
        stderrBuffer = this.consumeLines(stderrBuffer + chunk, (line) => {
          if (line.trim().length > 0) {
            this.maybeRecordRateLimit(handle, sessionId, line);
            this.logger.debug(`Codex worker ${sessionId} stderr: ${line}`);
          }
        });
      });

      child.on("error", (err) => {
        settle(false, err.message);
      });

      child.on("close", (code, signal) => {
        stdoutBuffer = this.consumeLines(stdoutBuffer, (line) => {
          this.processCodexOutputLine(sessionId, handle, line);
        }, true);
        stderrBuffer = this.consumeLines(stderrBuffer, (line) => {
          if (line.trim().length > 0) {
            this.maybeRecordRateLimit(handle, sessionId, line);
            this.logger.debug(`Codex worker ${sessionId} stderr: ${line}`);
          }
        }, true);

        if (code === 0) {
          settle(true, "Completed successfully");
          return;
        }

        const reason = signal
          ? `Codex worker terminated by signal ${signal}`
          : `Codex exited with code ${code ?? "unknown"}`;
        settle(false, reason);
      });
    });
  }

  /**
   * H-10 FIX: Run a Codex session with resume capability.
   * This method attempts to use `codex exec resume --last` when a thread ID
   * is available from a previous failed session on the same task.
   *
   * If resume args cannot be built (no preserved thread ID), falls back to
   * a fresh start with the corrective prompt.
   */
  private async runCodexSessionWithResume(
    sessionId: string,
    handle: WorkerHandle,
    taskId: string,
    correctivePrompt: string,
    sandbox: CodexSandboxMode,
    progress: string,
  ): Promise<void> {
    const outputPath = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sessionId,
      "codex-last-message.txt",
    );

    await this.updateSessionStatus(sessionId, "working", progress);

    // Try to build resume args using preserved thread ID
    const resumeArgs = this.buildResumeArgs(sessionId, taskId, correctivePrompt, sandbox, outputPath);

    if (!resumeArgs) {
      // No preserved thread ID - fall back to fresh start with corrective context
      this.logger.info(`No resume capability for task ${taskId}, using fresh start`);
      const freshPrompt = `${this.buildWorkerPrompt(sessionId)}\n\n## Retry Context\n\nThis is a retry of a previously failed task. ${correctivePrompt}`;
      return this.runCodexSession(sessionId, handle, freshPrompt, sandbox, progress);
    }

    this.logger.info(`Using session resumption for task ${taskId}`);

    return new Promise<void>((resolve, reject) => {
      const child = spawn("codex", resumeArgs, {
        cwd: this.projectDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      handle.child = child;

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let settled = false;

      const settle = (success: boolean, message: string): void => {
        if (settled) {
          return;
        }
        settled = true;

        void (async () => {
          if (success) {
            this.logger.info(`Codex worker ${sessionId} (resumed) completed successfully.`);
            if (handle.lastMessage) {
              this.logger.debug(
                `Codex worker ${sessionId} final message: ${handle.lastMessage.substring(0, 200)}`,
              );
            }
            this.recordEvent(handle, { type: "session_done", sessionId });
            await this.updateSessionStatus(sessionId, "done", "Completed successfully (resumed)");
            // Clear the preserved thread ID on success since the task is done
            this.taskThreadIds.delete(taskId);
          } else {
            this.logger.error(`Codex worker ${sessionId} (resumed) failed: ${message}`);
            this.maybeRecordRateLimit(handle, sessionId, message);
            this.recordEvent(handle, { type: "session_failed", sessionId, error: message });
            await this.updateSessionStatus(sessionId, "failed", message);
            // Skip if the orchestrator already recorded this failure (terminatedByOrchestrator flag)
            // to avoid double-counting which can prematurely exhaust retries.
            if (!handle.terminatedByOrchestrator) {
              this.retryTracker.recordFailure(taskId, message);
              this.logger.debug(`Recorded failure for task ${taskId} (session ${sessionId}, resumed)`);
            } else {
              this.logger.debug(
                `Skipping failure recording for task ${taskId} (session ${sessionId}, resumed) - already recorded by orchestrator`,
              );
            }

            // Update preserved thread ID if we got a new one
            if (handle.threadId && handle.threadId.length > 0) {
              this.taskThreadIds.set(taskId, handle.threadId);
              this.logger.debug(`Updated preserved thread ID for task ${taskId}: ${handle.threadId}`);
            }
          }

          this.timeoutTracker.stopTracking(sessionId);
          this.heartbeatTracker.cleanup(sessionId);
          this.sessionToTaskMap.delete(sessionId);

          handle.child = null;
          this.activeWorkers.delete(sessionId);
        })()
          .then(() => {
            if (success) {
              resolve();
            } else {
              reject(new Error(message));
            }
          })
          .catch(reject);
      };

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");

      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer = this.consumeLines(stdoutBuffer + chunk, (line) => {
          this.processCodexOutputLine(sessionId, handle, line);
        });
      });

      child.stderr.on("data", (chunk: string) => {
        stderrBuffer = this.consumeLines(stderrBuffer + chunk, (line) => {
          if (line.trim().length > 0) {
            this.maybeRecordRateLimit(handle, sessionId, line);
            this.logger.debug(`Codex worker ${sessionId} stderr: ${line}`);
          }
        });
      });

      child.on("error", (err) => {
        settle(false, err.message);
      });

      child.on("close", (code, signal) => {
        stdoutBuffer = this.consumeLines(stdoutBuffer, (line) => {
          this.processCodexOutputLine(sessionId, handle, line);
        }, true);
        stderrBuffer = this.consumeLines(stderrBuffer, (line) => {
          if (line.trim().length > 0) {
            this.maybeRecordRateLimit(handle, sessionId, line);
            this.logger.debug(`Codex worker ${sessionId} stderr: ${line}`);
          }
        }, true);

        if (code === 0) {
          settle(true, "Completed successfully");
          return;
        }

        const reason = signal
          ? `Codex worker terminated by signal ${signal}`
          : `Codex exited with code ${code ?? "unknown"}`;
        settle(false, reason);
      });
    });
  }

  private consumeLines(
    buffer: string,
    onLine: (line: string) => void,
    flushRemainder = false,
  ): string {
    // Buffer size check to prevent memory exhaustion from large Codex outputs
    // If buffer exceeds MAX_BUFFER_SIZE_BYTES (10MB), truncate to last half.
    // H16: Use byte-aware slicing to handle multi-byte characters correctly.
    let truncatedBuffer = buffer;
    const bufferSizeBytes = Buffer.byteLength(buffer, "utf-8");
    if (bufferSizeBytes > MAX_BUFFER_SIZE_BYTES) {
      this.logger.warn(
        `Codex output buffer exceeded ${MAX_BUFFER_SIZE_BYTES} bytes (${bufferSizeBytes} bytes). Truncating to preserve recent output.`,
      );
      // Convert to Buffer, slice by bytes (not characters), convert back
      const buf = Buffer.from(buffer, "utf-8");
      const halfBytes = Math.floor(buf.length / 2);
      truncatedBuffer = buf.subarray(halfBytes).toString("utf-8");
    }

    const normalized = truncatedBuffer.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const remainder = flushRemainder ? "" : (lines.pop() ?? "");

    for (const line of flushRemainder ? lines.filter((entry) => entry.length > 0) : lines) {
      if (line.trim().length > 0) {
        onLine(line);
      }
    }

    if (flushRemainder && remainder.trim().length > 0) {
      onLine(remainder);
    }

    return remainder;
  }

  private processCodexOutputLine(
    sessionId: string,
    handle: WorkerHandle,
    line: string,
  ): void {
    const parsed = this.tryParseJsonLine(line);
    if (!parsed) {
      this.maybeRecordRateLimit(handle, sessionId, line);
      this.logger.debug(`Codex worker ${sessionId}: ${line}`);
      return;
    }

    // H-9 FIX: Every valid JSONL line serves as a heartbeat — update monotonic timestamp
    handle.lastEventAt = process.hrtime.bigint();
    this.heartbeatTracker.recordHeartbeat(sessionId);

    const eventType = typeof parsed.type === "string" ? parsed.type : "unknown";

    // H-9: Capture thread ID from thread.started events for session resumption (H-10)
    if (eventType === "thread.started" && typeof parsed.thread_id === "string" && parsed.thread_id.length > 0) {
      handle.threadId = parsed.thread_id;
      this.logger.debug(`Codex worker ${sessionId} thread started: ${handle.threadId}`);
    }

    if (eventType === "error") {
      const message = coerceLogText(parsed.message ?? parsed);
      this.maybeRecordRateLimit(handle, sessionId, message);
      this.logger.warn(`Codex worker ${sessionId} reported: ${message}`);
      return;
    }

    if (eventType === "item.completed") {
      const item = parsed.item as Record<string, unknown> | undefined;
      const messageText = this.extractAgentMessageText(item);
      if (messageText) {
        handle.lastMessage = messageText;
        this.maybeRecordRateLimit(handle, sessionId, messageText);
        this.logger.debug(`Codex worker ${sessionId} message: ${messageText.substring(0, 200)}`);
      }
      return;
    }

    if (eventType === "turn.completed") {
      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (usage) {
        this.logger.debug(`Codex worker ${sessionId} turn completed: ${JSON.stringify(usage)}`);
      }
      return;
    }

    this.logger.debug(`Codex worker ${sessionId} event: ${line}`);
  }

  private tryParseJsonLine(line: string): Record<string, unknown> | null {
    if (!line.trim().startsWith("{")) {
      return null;
    }

    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private extractAgentMessageText(item: Record<string, unknown> | undefined): string | null {
    if (!item || item.type !== "agent_message") {
      return null;
    }

    if (typeof item.text === "string") {
      return item.text;
    }

    if (Array.isArray(item.content)) {
      const parts = item.content
        .map((entry) => {
          if (typeof entry === "string") {
            return entry;
          }
          if (entry && typeof entry === "object" && "text" in entry) {
            return coerceLogText((entry as Record<string, unknown>).text);
          }
          return "";
        })
        .filter((entry) => entry.length > 0);

      if (parts.length > 0) {
        return parts.join("\n");
      }
    }

    return null;
  }

  private buildCodexExecArgs(
    sessionId: string,
    prompt: string,
    sandbox: CodexSandboxMode,
    outputPath: string,
  ): string[] {
    // M-19: Map the configured Claude model tier to a Codex/OpenAI model name
    const codexModel = getCodexModel(this.modelConfig.worker);

    return [
      "exec",
      "--model",
      codexModel,
      "--json",
      "--full-auto",
      "--sandbox",
      sandbox,
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "-o",
      outputPath,
      "-C",
      this.projectDir,
      "-c",
      'mcp_servers.coordinator.command="node"',
      "-c",
      `mcp_servers.coordinator.args=[${JSON.stringify(this.mcpServerPath)}]`,
      "-c",
      `mcp_servers.coordinator.env.CONDUCTOR_DIR=${JSON.stringify(this.orchestratorDir)}`,
      "-c",
      `mcp_servers.coordinator.env.SESSION_ID=${JSON.stringify(sessionId)}`,
      "-c",
      "mcp_servers.coordinator.startup_timeout_sec=10",
      "-c",
      "mcp_servers.coordinator.tool_timeout_sec=30",
      "-c",
      "mcp_servers.coordinator.enabled=true",
      "-c",
      "mcp_servers.coordinator.required=false",
      prompt,
    ];
  }

  /**
   * H-10 FIX: Build resume args for retrying a failed Codex session.
   * Uses `codex exec resume --last` when a thread ID is available from the
   * previous session, which is more powerful than a fresh start because
   * Codex can resume from its SQLite-persisted session state.
   *
   * Returns null if no thread ID is available (caller should fall back to fresh start).
   *
   * @param sessionId - The new session ID for the retry worker (for MCP server config)
   * @param taskId - The task ID being retried (used to look up preserved thread ID)
   * @param correctivePrompt - Prompt explaining what to fix
   * @param sandbox - Sandbox mode for the Codex session
   * @param outputPath - Path for Codex output
   */
  private buildResumeArgs(
    sessionId: string,
    taskId: string,
    correctivePrompt: string,
    sandbox: CodexSandboxMode,
    outputPath: string,
  ): string[] | null {
    // H-10 FIX: Look up thread ID by TASK ID (not session ID)
    // The thread ID was preserved when the previous worker failed on this task
    const threadId = this.taskThreadIds.get(taskId);
    if (!threadId || threadId.length === 0) {
      return null; // No session to resume — caller falls back to fresh start
    }

    // KNOWN LIMITATION: The Codex CLI `exec resume` does not support targeting a
    // specific thread/session by ID. `--last` resumes the most recent session,
    // which may not correspond to the intended task when multiple workers run
    // concurrently. The threadId is validated for existence above to gate whether
    // resume is attempted, but the actual resume target is best-effort.
    // If the Codex CLI adds `--thread-id <id>` support in the future, use it here.

    // M-19: Map the configured Claude model tier to a Codex/OpenAI model name
    const codexModel = getCodexModel(this.modelConfig.worker);

    return [
      "exec",
      "resume",
      "--last",
      "--model",
      codexModel,
      "--json",
      "--full-auto",
      "--sandbox",
      sandbox,
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "-o",
      outputPath,
      "-C",
      this.projectDir,
      "-c",
      'mcp_servers.coordinator.command="node"',
      "-c",
      `mcp_servers.coordinator.args=[${JSON.stringify(this.mcpServerPath)}]`,
      "-c",
      `mcp_servers.coordinator.env.CONDUCTOR_DIR=${JSON.stringify(this.orchestratorDir)}`,
      "-c",
      `mcp_servers.coordinator.env.SESSION_ID=${JSON.stringify(sessionId)}`,
      "-c",
      "mcp_servers.coordinator.startup_timeout_sec=10",
      "-c",
      "mcp_servers.coordinator.tool_timeout_sec=30",
      "-c",
      "mcp_servers.coordinator.enabled=true",
      "-c",
      "mcp_servers.coordinator.required=false",
      correctivePrompt,
    ];
  }

  private async updateSessionStatus(
    sessionId: string,
    state: SessionStatus["state"],
    progress: string,
  ): Promise<void> {
    const sessionDir = path.join(this.orchestratorDir, SESSIONS_DIR, sessionId);

    try {
      await mkdirSecure(sessionDir);

      const statusPath = path.join(sessionDir, SESSION_STATUS_FILE);
      let existing: SessionStatus | null = null;

      try {
        const raw = await fs.readFile(statusPath, "utf-8");
        existing = JSON.parse(raw) as SessionStatus;
      } catch {
        // Start fresh if the status file is missing or malformed.
      }

      const status: SessionStatus = {
        session_id: sessionId,
        state,
        current_task: existing?.current_task ?? null,
        tasks_completed: existing?.tasks_completed ?? [],
        progress,
        updated_at: new Date().toISOString(),
      };

      // H-8 FIX: Use writeFileSecure for proper permissions (owner rw only)
      await writeFileSecure(statusPath, JSON.stringify(status, null, 2) + "\n");
    } catch (err) {
      this.logger.error(
        `Failed to update session status for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private buildWorkerPrompt(sessionId: string): string {
    // M-19: Pass subagentModel so the worker prompt includes a model hint for spawned subagents
    return getWorkerPrompt({
      sessionId,
      runtime: "codex",
      subagentModel: this.modelConfig.subagent,
      ...this.workerContext,
    });
  }

  private buildSentinelPrompt(): string {
    return getSentinelPrompt(this.workerContext.conventions?.security_invariants);
  }

  private recordEvent(handle: WorkerHandle, event: OrchestratorEvent): void {
    handle.events.push(event);
    this.pendingEvents.push(event);
  }

  private maybeRecordRateLimit(
    handle: WorkerHandle,
    sessionId: string,
    detail: string,
  ): void {
    if (handle.rateLimitReported) {
      return;
    }

    const signal = detectProviderRateLimit("codex", detail);
    if (!signal) {
      return;
    }

    handle.rateLimitReported = true;
    this.logger.warn(`Codex worker ${sessionId} hit a usage limit: ${signal.detail}`);
    this.recordEvent(handle, {
      type: "provider_rate_limited",
      sessionId,
      provider: signal.provider,
      detail: signal.detail,
      resets_at: signal.resetsAt,
    });
  }
}

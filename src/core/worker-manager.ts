import fs from "node:fs/promises";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  ExecutionWorkerManager,
  OrchestratorEvent,
  Message,
  SessionStatus,
  WorkerSharedContext,
  ModelConfig,
} from "../utils/types.js";
import { MODEL_TIER_TO_ID, DEFAULT_MODEL_CONFIG } from "../utils/types.js";
import {
  TaskRetryTracker,
  WorkerTimeoutTracker,
  HeartbeatTracker,
} from "./worker-resilience.js";
import {
  WORKER_ALLOWED_TOOLS,
  DEFAULT_WORKER_MAX_TURNS,
  MESSAGES_DIR,
  SESSIONS_DIR,
  SESSION_STATUS_FILE,
  SENTINEL_WORKER_MAX_TURNS,
  FLOW_TRACING_READ_ONLY_TOOLS,
} from "../utils/constants.js";
import { getWorkerPrompt } from "../worker-prompt.js";
import { getSentinelPrompt } from "../sentinel-prompt.js";
import type { Logger } from "../utils/logger.js";
import { coerceLogText, detectProviderRateLimit } from "../utils/provider-limit.js";
import { appendJsonlLocked, writeFileSecure } from "../utils/secure-fs.js";

// ============================================================
// Worker Handle
// ============================================================

interface WorkerHandle {
  sessionId: string;
  promise: Promise<void>;
  events: OrchestratorEvent[];
  startedAt: string;
  rateLimitReported: boolean;
}

// ============================================================
// Worker Manager
// ============================================================

/**
 * Manages spawning and monitoring headless Claude Code worker
 * sessions via the Agent SDK. Each worker runs as a background
 * async task that picks up tasks from the coordination server.
 */
export class WorkerManager implements ExecutionWorkerManager {
  private activeWorkers: Map<string, WorkerHandle> = new Map();
  private pendingEvents: OrchestratorEvent[] = [];

  private workerContext: WorkerSharedContext = {};

  // V2: Resilience trackers
  private timeoutTracker: WorkerTimeoutTracker;
  private heartbeatTracker: HeartbeatTracker;
  private retryTracker: TaskRetryTracker;

  constructor(
    private projectDir: string,
    private orchestratorDir: string,
    private mcpServerPath: string,
    private logger: Logger,
    private modelConfig: ModelConfig = DEFAULT_MODEL_CONFIG,
  ) {
    // Initialize resilience trackers
    this.timeoutTracker = new WorkerTimeoutTracker();
    this.heartbeatTracker = new HeartbeatTracker();
    this.retryTracker = new TaskRetryTracker();
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Set shared context that will be injected into all worker prompts.
   * Call this after planning/conventions extraction, before spawning workers.
   */
  setWorkerContext(context: WorkerSharedContext): void {
    this.workerContext = context;
  }

  /**
   * Spawn a new worker session.
   *
   * Creates the session directory, writes initial status, and launches
   * the SDK query in a background async task.
   */
  async spawnWorker(sessionId: string): Promise<void> {
    if (this.activeWorkers.has(sessionId)) {
      this.logger.warn(`Worker ${sessionId} is already active; skipping spawn`);
      return;
    }

    this.logger.info(`Spawning worker: ${sessionId}`);

    // Create session directory
    const sessionDir = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sessionId,
    );
    await fs.mkdir(sessionDir, { recursive: true });

    // Write initial status with secure permissions (H12 fix)
    const initialStatus: SessionStatus = {
      session_id: sessionId,
      state: "starting",
      current_task: null,
      tasks_completed: [],
      progress: "Worker session starting...",
      updated_at: new Date().toISOString(),
    };
    await writeFileSecure(
      path.join(sessionDir, SESSION_STATUS_FILE),
      JSON.stringify(initialStatus, null, 2) + "\n",
    );

    // Build the worker handle
    const handle: WorkerHandle = {
      sessionId,
      promise: Promise.resolve(), // will be replaced below
      events: [],
      startedAt: new Date().toISOString(),
      rateLimitReported: false,
    };

    // V2: Start resilience tracking
    this.timeoutTracker.startTracking(sessionId);
    this.heartbeatTracker.recordHeartbeat(sessionId); // Initial heartbeat

    // Launch the worker as a background async task
    handle.promise = this.runWorker(sessionId, handle);

    this.activeWorkers.set(sessionId, handle);
  }

  /**
   * Spawn a read-only security sentinel worker that monitors completed tasks
   * and scans for security issues in real-time during execution.
   */
  async spawnSentinelWorker(): Promise<void> {
    const sentinelId = "sentinel-security";

    if (this.activeWorkers.has(sentinelId)) {
      this.logger.warn("Security sentinel is already running");
      return;
    }

    this.logger.info("Spawning security sentinel worker...");

    // Create session directory
    const sessionDir = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sentinelId,
    );
    await fs.mkdir(sessionDir, { recursive: true });

    // Write initial status with secure permissions (H12 fix)
    const initialStatus: SessionStatus = {
      session_id: sentinelId,
      state: "starting",
      current_task: null,
      tasks_completed: [],
      progress: "Security sentinel starting...",
      updated_at: new Date().toISOString(),
    };
    await writeFileSecure(
      path.join(sessionDir, SESSION_STATUS_FILE),
      JSON.stringify(initialStatus, null, 2) + "\n",
    );

    const sentinelPrompt = this.buildSentinelPrompt();

    const handle: WorkerHandle = {
      sessionId: sentinelId,
      promise: Promise.resolve(),
      events: [],
      startedAt: new Date().toISOString(),
      rateLimitReported: false,
    };

    // V2: Start resilience tracking for sentinel
    this.timeoutTracker.startTracking(sentinelId);
    this.heartbeatTracker.recordHeartbeat(sentinelId);

    // Launch with read-only file tools and sentinel prompt.
    // Note: The sentinel also gets mcp__coordinator__post_update so it can
    // broadcast security findings to other workers. This is intentional —
    // the sentinel is read-only for FILES but needs write access to the
    // message bus to report security issues it discovers. (H11)
    handle.promise = this.runSentinelWorker(sentinelId, handle, sentinelPrompt);
    this.activeWorkers.set(sentinelId, handle);
  }

  /**
   * Get the list of active worker session IDs.
   */
  getActiveWorkers(): string[] {
    return Array.from(this.activeWorkers.keys());
  }

  /**
   * Check if a specific worker is still running.
   *
   * A worker is considered active if its handle is in the map.
   * Once the background task resolves (success or error), the
   * handle is removed.
   */
  isWorkerActive(sessionId: string): boolean {
    return this.activeWorkers.has(sessionId);
  }

  /**
   * Send a wind-down signal to all workers.
   *
   * Writes a wind_down message to the orchestrator's shared message
   * file so that all workers will pick it up on their next
   * `read_updates` call.
   */
  async signalWindDown(reason: string, resetsAt?: string): Promise<void> {
    // M-18 FIX: Validate reason against the allowed set before casting
    const VALID_WIND_DOWN_REASONS = new Set(["usage_limit", "cycle_limit", "user_requested"]);
    let validatedReason: "usage_limit" | "cycle_limit" | "user_requested";
    if (VALID_WIND_DOWN_REASONS.has(reason)) {
      validatedReason = reason as "usage_limit" | "cycle_limit" | "user_requested";
    } else {
      this.logger.warn(`Invalid wind-down reason '${reason}', defaulting to 'user_requested'`);
      validatedReason = "user_requested";
    }

    this.logger.info(`Sending wind-down signal to all workers: ${validatedReason}`);

    const messagesDir = path.join(this.orchestratorDir, MESSAGES_DIR);
    await fs.mkdir(messagesDir, { recursive: true });

    const message: Message = {
      id: `orchestrator-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      from: "orchestrator",
      type: "wind_down",
      content: `Wind down: ${validatedReason}. Please finish your current task, commit your work, and exit cleanly.`,
      metadata: {
        reason: validatedReason,
        ...(resetsAt ? { resets_at: resetsAt } : {}),
      },
      timestamp: new Date().toISOString(),
    };

    // Write to the orchestrator message file, which all workers will read
    const messagePath = path.join(messagesDir, "orchestrator.jsonl");
    await appendJsonlLocked(messagePath, message);

    this.logger.debug(`Wind-down message written to ${messagePath}`);
  }

  /**
   * Wait for all workers to finish, with a timeout.
   *
   * If the timeout expires before all workers complete, the remaining
   * workers are left running (use killAllWorkers to force-stop them).
   */
  async waitForAllWorkers(timeoutMs: number): Promise<void> {
    const workerIds = this.getActiveWorkers();
    if (workerIds.length === 0) {
      this.logger.info("No active workers to wait for.");
      return;
    }

    this.logger.info(
      `Waiting for ${workerIds.length} worker(s) to finish (timeout: ${Math.round(timeoutMs / 1000)}s)...`,
    );

    const promises = workerIds.map((id) => {
      const handle = this.activeWorkers.get(id);
      return handle ? handle.promise : Promise.resolve();
    });

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      // Allow the process to exit even if the timer is pending
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

  /**
   * Force kill all worker processes.
   *
   * Since workers are async tasks (not child processes), we can only
   * signal wind-down and wait for them to finish. The SDK doesn't expose
   * a direct kill mechanism, so we:
   * 1. Signal wind-down to give workers a chance for clean exit
   * 2. Wait up to KILL_TIMEOUT_MS for worker promises to settle
   * 3. Force-remove any remaining workers from tracking
   *
   * (H10 fix: Previously removed workers immediately without waiting,
   *  leaving orphaned in-flight SDK sessions.)
   */
  async killAllWorkers(): Promise<void> {
    const workerIds = this.getActiveWorkers();
    if (workerIds.length === 0) {
      return;
    }

    this.logger.warn(`Force-killing ${workerIds.length} worker(s): ${workerIds.join(", ")}`);

    // Signal wind-down first to give a chance for clean exit
    await this.signalWindDown("user_requested");

    // Wait for workers to finish (with timeout)
    const KILL_TIMEOUT_MS = 30_000;
    const promises = workerIds
      .map((id) => this.activeWorkers.get(id)?.promise)
      .filter((p): p is Promise<void> => p != null);

    if (promises.length > 0) {
      const timeout = new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), KILL_TIMEOUT_MS);
        if (timer.unref) {
          timer.unref();
        }
      });

      const result = await Promise.race([
        Promise.allSettled(promises).then(() => "done" as const),
        timeout,
      ]);

      if (result === "timeout") {
        const remaining = this.getActiveWorkers();
        this.logger.warn(
          `${remaining.length} worker(s) still active after ${KILL_TIMEOUT_MS}ms kill timeout. Force-removing.`,
        );
      }
    }

    // Force-remove any remaining workers that didn't finish in time
    for (const sessionId of this.getActiveWorkers()) {
      await this.updateSessionStatus(sessionId, "done", "Force killed by orchestrator");
      this.activeWorkers.delete(sessionId);
    }

    this.logger.info("All workers have been killed and removed from tracking.");
  }

  /**
   * Get combined events from all workers (past and present).
   */
  getWorkerEvents(): OrchestratorEvent[] {
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    return events;
  }

  /**
   * V2: Check the health of all active workers.
   *
   * Returns lists of workers that have timed out (exceeded wall-clock timeout)
   * and workers that are stale (no heartbeat activity).
   *
   * Performance: O(n) where n = active workers.
   */
  checkWorkerHealth(): {
    timedOut: string[];
    stale: string[];
  } {
    const timedOut = this.timeoutTracker
      .getTimedOutWorkers()
      .filter((id) => this.activeWorkers.has(id));

    const stale = this.heartbeatTracker
      .getStaleWorkers()
      .filter((id) => this.activeWorkers.has(id) && !timedOut.includes(id));

    return { timedOut, stale };
  }

  /**
   * V2: Get the retry tracker for task failure handling.
   *
   * The orchestrator uses this to record failures and check retry eligibility.
   */
  getRetryTracker(): TaskRetryTracker {
    return this.retryTracker;
  }

  // ----------------------------------------------------------------
  // Private: Worker execution
  // ----------------------------------------------------------------

  /**
   * Run a single worker session. This method is called as a background
   * async task and iterates over the SDK async iterable until the
   * worker exits.
   */
  private async runWorker(
    sessionId: string,
    handle: WorkerHandle,
  ): Promise<void> {
    const workerPrompt = this.buildWorkerPrompt(sessionId);

    try {
      const workerModelId = MODEL_TIER_TO_ID[this.modelConfig.worker];
      const asyncIterable = query({
        prompt: workerPrompt,
        options: {
          allowedTools: WORKER_ALLOWED_TOOLS,
          mcpServers: {
            coordinator: {
              command: "node",
              args: [this.mcpServerPath],
              env: {
                CONDUCTOR_DIR: this.orchestratorDir,
                SESSION_ID: sessionId,
              },
            },
          },
          cwd: this.projectDir,
          maxTurns: DEFAULT_WORKER_MAX_TURNS,
          model: workerModelId,
          ...(this.modelConfig.extendedContext && this.modelConfig.worker !== "haiku" ? { betas: ["context-1m-2025-08-07" as const] } : {}),
          settingSources: ["project"],
        },
      });

      for await (const event of asyncIterable) {
        try {
          this.processWorkerEvent(sessionId, handle, event);
        } catch (err) {
          // Log error and record failure event, but continue processing
          // to avoid dropping subsequent events from the SDK stream
          const errorMessage =
            err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Worker ${sessionId} event processing error: ${errorMessage}`
          );
          this.recordEvent(handle, {
            type: "session_failed",
            sessionId,
            error: `Event processing error: ${errorMessage}`,
          });
          // Continue processing other events - don't break the loop
        }
      }

      // Worker completed normally
      this.logger.info(`Worker ${sessionId} completed successfully.`);
      this.recordEvent(handle, {
        type: "session_done",
        sessionId,
      });

      await this.updateSessionStatus(sessionId, "done", "Completed successfully");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      this.logger.error(`Worker ${sessionId} failed: ${errorMessage}`);

      this.maybeRecordRateLimit(handle, sessionId, errorMessage);

      // If no explicit rate limit was detected but the error looks like an
      // unexplained SDK exit (code 1), record it as a suspicious exit.
      // The orchestrator can correlate this with usage data staleness.
      if (!handle.rateLimitReported && /exited? with code 1\b/i.test(errorMessage)) {
        this.logger.warn(
          `Worker ${sessionId} exited with code 1 (no explicit rate limit). ` +
          `Recording as suspicious exit for staleness correlation.`
        );
        this.recordEvent(handle, {
          type: "session_failed",
          sessionId,
          error: `SUSPICIOUS_EXIT: ${errorMessage}`,
        });
      } else {
        this.recordEvent(handle, {
          type: "session_failed",
          sessionId,
          error: errorMessage,
        });
      }

      await this.updateSessionStatus(sessionId, "failed", errorMessage);
    } finally {
      // V2: Clean up resilience trackers
      this.timeoutTracker.stopTracking(sessionId);
      this.heartbeatTracker.cleanup(sessionId);

      // Remove from active workers once done
      this.activeWorkers.delete(sessionId);
    }
  }

  /**
   * Run a security sentinel worker session. Uses read-only tools and
   * a dedicated sentinel prompt. Monitors for security issues in
   * completed tasks.
   */
  private async runSentinelWorker(
    sessionId: string,
    handle: WorkerHandle,
    prompt: string,
  ): Promise<void> {
    try {
      // Sentinel uses subagent model tier (read-only, lighter workload)
      const sentinelModelId = MODEL_TIER_TO_ID[this.modelConfig.subagent];
      const asyncIterable = query({
        prompt,
        options: {
          allowedTools: [
            // Read-only file tools (Read, Bash, Glob, Grep, LSP — no Task/Write/Edit)
            ...FLOW_TRACING_READ_ONLY_TOOLS,
            // MCP coordination tools:
            "mcp__coordinator__read_updates",
            // post_update is intentionally included: the sentinel needs to
            // broadcast security findings to other workers via the message bus.
            // The sentinel is read-only for FILES but writes to the message log. (H11)
            "mcp__coordinator__post_update",
            "mcp__coordinator__get_tasks",
          ],
          mcpServers: {
            coordinator: {
              command: "node",
              args: [this.mcpServerPath],
              env: {
                CONDUCTOR_DIR: this.orchestratorDir,
                SESSION_ID: sessionId,
              },
            },
          },
          cwd: this.projectDir,
          maxTurns: SENTINEL_WORKER_MAX_TURNS,
          model: sentinelModelId,
          ...(this.modelConfig.extendedContext && this.modelConfig.subagent !== "haiku" ? { betas: ["context-1m-2025-08-07" as const] } : {}),
          settingSources: ["project"],
        },
      });

      for await (const event of asyncIterable) {
        try {
          this.processWorkerEvent(sessionId, handle, event);
        } catch (err) {
          // Log error and record failure event, but continue processing
          // to avoid dropping subsequent events from the SDK stream
          const errorMessage =
            err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Sentinel ${sessionId} event processing error: ${errorMessage}`
          );
          this.recordEvent(handle, {
            type: "session_failed",
            sessionId,
            error: `Event processing error: ${errorMessage}`,
          });
          // Continue processing other events - don't break the loop
        }
      }

      // Sentinel completed normally
      this.logger.info(`Security sentinel ${sessionId} completed.`);
      this.recordEvent(handle, {
        type: "session_done",
        sessionId,
      });

      await this.updateSessionStatus(sessionId, "done", "Sentinel completed");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      this.logger.error(`Security sentinel ${sessionId} failed: ${errorMessage}`);

      this.maybeRecordRateLimit(handle, sessionId, errorMessage);
      this.recordEvent(handle, {
        type: "session_failed",
        sessionId,
        error: errorMessage,
      });

      await this.updateSessionStatus(sessionId, "failed", errorMessage);
    } finally {
      // V2: Clean up resilience trackers
      this.timeoutTracker.stopTracking(sessionId);
      this.heartbeatTracker.cleanup(sessionId);

      this.activeWorkers.delete(sessionId);
    }
  }

  /**
   * Process a single event from the worker's SDK async iterable.
   * Captures relevant events into the worker handle for the
   * orchestrator to inspect.
   */
  private processWorkerEvent(
    sessionId: string,
    handle: WorkerHandle,
    event: Record<string, unknown>,
  ): void {
    // The SDK emits events with a `type` field. We capture the ones
    // that are relevant for orchestrator monitoring.
    const eventType = event.type as string | undefined;

    // V2: Record heartbeat on all non-error events to prevent false stale detection
    // (previously only recorded on tool_use/result, causing false positives)
    if (eventType !== "error") {
      this.heartbeatTracker.recordHeartbeat(sessionId);
    }

    if (eventType === "result") {
      const resultText = coerceLogText(event.result);
      this.maybeRecordRateLimit(handle, sessionId, resultText);
      this.logger.debug(`Worker ${sessionId} result: ${resultText.substring(0, 200)}`);
    } else if (eventType === "error") {
      const errorText = coerceLogText(event.error);
      this.logger.error(`Worker ${sessionId} error event: ${errorText}`);
      this.maybeRecordRateLimit(handle, sessionId, errorText);
      this.recordEvent(handle, {
        type: "session_failed",
        sessionId,
        error: errorText,
      });
    } else if (eventType === "tool_use") {
      // Log tool usage at debug level for observability
      const toolName = event.tool_name ?? event.name ?? "unknown";
      this.logger.debug(`Worker ${sessionId} using tool: ${String(toolName)}`);
    }
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

    const signal = detectProviderRateLimit("claude", detail);
    if (!signal) {
      return;
    }

    handle.rateLimitReported = true;
    this.logger.warn(`Claude worker ${sessionId} hit a usage limit: ${signal.detail}`);
    this.recordEvent(handle, {
      type: "provider_rate_limited",
      sessionId,
      provider: signal.provider,
      detail: signal.detail,
      resets_at: signal.resetsAt,
    });
  }

  // ----------------------------------------------------------------
  // Private: Session status management
  // ----------------------------------------------------------------

  /**
   * Update the session status file on disk.
   */
  private async updateSessionStatus(
    sessionId: string,
    state: SessionStatus["state"],
    progress: string,
  ): Promise<void> {
    const sessionDir = path.join(
      this.orchestratorDir,
      SESSIONS_DIR,
      sessionId,
    );

    try {
      await fs.mkdir(sessionDir, { recursive: true });

      const statusPath = path.join(sessionDir, SESSION_STATUS_FILE);

      // Try to read existing status to preserve task history
      let existing: SessionStatus | null = null;
      try {
        const raw = await fs.readFile(statusPath, "utf-8");
        existing = JSON.parse(raw) as SessionStatus;
      } catch {
        // File doesn't exist or is invalid; start fresh
      }

      const status: SessionStatus = {
        session_id: sessionId,
        state,
        current_task: existing?.current_task ?? null,
        tasks_completed: existing?.tasks_completed ?? [],
        progress,
        updated_at: new Date().toISOString(),
      };

      // Use writeFileSecure for proper 0o600 permissions (H12 fix)
      await writeFileSecure(
        statusPath,
        JSON.stringify(status, null, 2) + "\n",
      );
    } catch (err) {
      this.logger.error(
        `Failed to update session status for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ----------------------------------------------------------------
  // Private: Prompt builders
  // ----------------------------------------------------------------

  /**
   * Build the system prompt for a worker session.
   * Delegates to the shared getWorkerPrompt function with full context.
   */
  private buildWorkerPrompt(sessionId: string): string {
    return getWorkerPrompt({
      sessionId,
      runtime: "claude",
      subagentModel: this.modelConfig.subagent,
      ...this.workerContext,
    });
  }


  private buildSentinelPrompt(): string {
    return getSentinelPrompt(this.workerContext.conventions?.security_invariants);
  }
}

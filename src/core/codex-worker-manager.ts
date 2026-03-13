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
  MAX_BUFFER_SIZE_BYTES,
  CODEX_MODEL_MAP,
  CODEX_JOB_MAX_RUNTIME_SECONDS,
} from "../utils/constants.js";
import { getWorkerPrompt } from "../worker-prompt.js";
import { getSentinelPrompt } from "../sentinel-prompt.js";
import type { Logger } from "../utils/logger.js";
import { coerceLogText, detectProviderRateLimit } from "../utils/provider-limit.js";
import { appendJsonlLocked, writeFileSecure, mkdirSecure } from "../utils/secure-fs.js";
// H-9 FIX: Import resilience trackers for heartbeat-based stale detection
import { HeartbeatTracker, WorkerTimeoutTracker } from "./worker-resilience.js";

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
}

type CodexSandboxMode = "workspace-write" | "read-only";

export class CodexWorkerManager implements ExecutionWorkerManager {
  private activeWorkers: Map<string, WorkerHandle> = new Map();
  private pendingEvents: OrchestratorEvent[] = [];

  private workerContext: WorkerSharedContext = {};

  // H-9 FIX: Resilience trackers for heartbeat-based stale detection and wall-clock timeout
  private heartbeatTracker: HeartbeatTracker;
  private timeoutTracker: WorkerTimeoutTracker;

  // M-19: Accept ModelConfig for Codex model selection and subagent model hints
  constructor(
    private projectDir: string,
    private orchestratorDir: string,
    private mcpServerPath: string,
    private logger: Logger,
    private modelConfig: ModelConfig = DEFAULT_MODEL_CONFIG,
  ) {
    this.heartbeatTracker = new HeartbeatTracker();
    this.timeoutTracker = new WorkerTimeoutTracker();
  }

  setWorkerContext(context: WorkerSharedContext): void {
    this.workerContext = context;
  }

  async spawnWorker(sessionId: string): Promise<void> {
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
    const sentinelId = "sentinel-security";

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
      this.activeWorkers.delete(sessionId);
    }

    this.logger.info("All Codex workers have been killed and removed from tracking.");
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
   * Get retry tracker. CodexWorkerManager does not currently support
   * retry tracking, so this returns null.
   */
  getRetryTracker(): null {
    // Codex workers don't support retry tracking yet
    return null;
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
          }

          // H-9 FIX: Clean up resilience trackers to prevent memory leaks
          this.timeoutTracker.stopTracking(sessionId);
          this.heartbeatTracker.cleanup(sessionId);

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
    const codexModel = CODEX_MODEL_MAP[this.modelConfig.worker];

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

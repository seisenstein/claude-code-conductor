import fs from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";

import {
  type OrchestratorState,
  type OrchestratorStatus,
  type Task,
  type TaskDefinition,
  type TaskStatus,
  type CycleRecord,
  type UsageSnapshot,
  type CodexUsageMetrics,
  type TaskRetryTrackerInterface,
  type ModelConfig,
} from "../utils/types.js";
import { validateStateJsonLenient } from "../utils/state-schema.js";
import { validateFileName } from "../utils/validation.js";

import {
  getOrchestratorDir,
  getTasksDir,
  getMessagesDir,
  getSessionsDir,
  getCodexReviewsDir,
  getFlowTracingDir,
  getLogsDir,
  getStatePath,
  getTaskPath,
} from "../utils/constants.js";
import { mkdirSecure } from "../utils/secure-fs.js";

export class StateManager {
  private projectDir: string;
  private state: OrchestratorState | null = null;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  /**
   * Initialize fresh state for a new orchestration run.
   */
  async initialize(
    feature: string,
    branch: string,
    options: {
      maxCycles: number;
      concurrency: number;
      workerRuntime: "claude" | "codex";
      modelConfig?: ModelConfig;
      baseCommitSha?: string;
      usageThreshold?: number;
    },
  ): Promise<OrchestratorState> {
    const now = new Date().toISOString();

    this.state = {
      status: "initializing",
      feature,
      project_path: this.projectDir,
      branch,
      worker_runtime: options.workerRuntime,
      model_config: options.modelConfig,
      base_commit_sha: options.baseCommitSha ?? null,
      current_cycle: 0,
      max_cycles: options.maxCycles,
      concurrency: options.concurrency,
      started_at: now,
      updated_at: now,
      paused_at: null,
      resume_after: null,
      usage: {
        five_hour: 0,
        seven_day: 0,
        five_hour_resets_at: null,
        seven_day_resets_at: null,
        last_checked: now,
      },
      claude_usage: null,
      codex_usage: null,
      codex_metrics: null,
      // H-5: completed_task_ids and failed_task_ids removed — they were dead state.
      // Task completion/failure is tracked via individual task files and cycle_history.
      active_session_ids: [],
      cycle_history: [],
      progress: "",
      usage_threshold: options.usageThreshold,
    };

    await this.save();
    return this.state;
  }

  /**
   * Load existing state from disk (for resume).
   *
   * Uses Zod schema validation (CRITICAL - state.json) to catch:
   * - Malformed JSON from partial writes
   * - Missing required fields
   * - Invalid field types
   * - Version migrations (via lenient parsing with defaults)
   *
   * @throws Error if state file cannot be read or fails validation
   */
  async load(): Promise<OrchestratorState> {
    const statePath = getStatePath(this.projectDir);
    const raw = await fs.readFile(statePath, "utf-8");

    // Validate with Zod schema (CRITICAL - state.json validation)
    const result = validateStateJsonLenient(raw);
    if (!result.valid) {
      throw new Error(
        `State file validation failed (${statePath}):\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }

    this.state = result.state as OrchestratorState;
    return this.state;
  }

  /**
   * Save current state to disk atomically (write to temp, then rename).
   * Uses proper-lockfile to prevent concurrent write corruption.
   */
  async save(): Promise<void> {
    if (!this.state) {
      throw new Error("StateManager: no state to save — call initialize() or load() first");
    }
    const statePath = getStatePath(this.projectDir);
    const tmpPath = statePath + ".tmp";
    const content = JSON.stringify(this.state, null, 2) + "\n";

    // Ensure the directory exists before writing (H-2: mkdirSecure enforces 0o700)
    await mkdirSecure(path.dirname(statePath), { recursive: true });

    // Ensure state.json exists before locking (proper-lockfile requires file to exist).
    // Use fs.open() with "a" flag for atomic create-or-noop, preventing the TOCTOU race
    // where concurrent callers both see the file as missing and one truncates the other's
    // data via writeFile. (H21 fix)
    const fh = await fs.open(statePath, "a", 0o600);
    await fh.close();

    let release: (() => Promise<void>) | undefined;
    try {
      // Acquire lock with retry configuration and stale detection
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

      // Clean up temp file if it still exists (in case rename failed)
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Temp file may not exist if rename succeeded
      }
    }
  }

  /**
   * Get current in-memory state.
   */
  get(): OrchestratorState {
    if (!this.state) {
      throw new Error("StateManager: state not loaded — call initialize() or load() first");
    }
    return this.state;
  }

  // ----------------------------------------------------------------
  // Status
  // ----------------------------------------------------------------

  /**
   * Update the orchestrator status.
   */
  async setStatus(status: OrchestratorStatus): Promise<void> {
    this.ensureState();
    this.state!.status = status;
    this.touch();
    await this.save();
  }

  /**
   * Update the progress detail string and persist.
   */
  async setProgress(detail: string): Promise<void> {
    this.ensureState();
    this.state!.progress = detail;
    this.touch();
    await this.save();
  }

  // ----------------------------------------------------------------
  // Directory setup
  // ----------------------------------------------------------------

  /**
   * Create the .conductor/ directory structure.
   * Uses mode 0o700 for owner-only access (security requirement #15).
   */
  async createDirectories(): Promise<void> {
    const dirs = [
      getOrchestratorDir(this.projectDir),
      getTasksDir(this.projectDir),
      getMessagesDir(this.projectDir),
      getSessionsDir(this.projectDir),
      getCodexReviewsDir(this.projectDir),
      getFlowTracingDir(this.projectDir),
      getLogsDir(this.projectDir),
    ];

    for (const dir of dirs) {
      await mkdirSecure(dir, { recursive: true }); // H-2
    }
  }

  // ----------------------------------------------------------------
  // Task management
  // ----------------------------------------------------------------

  /**
   * Create a task from a TaskDefinition and persist it.
   *
   * V2: Uses proper-lockfile to lock dependency files during blocks[] mutation
   * to prevent race condition with concurrent task operations (#8).
   */
  async createTask(
    definition: TaskDefinition,
    id: string,
    dependencyIds: string[],
  ): Promise<Task> {
    this.ensureState();

    // Validate task ID and dependency IDs to prevent path traversal (#30)
    const idValidation = validateFileName(id);
    if (!idValidation.valid) {
      throw new Error(`Invalid task ID "${id}": ${idValidation.reason}`);
    }
    for (const depId of dependencyIds) {
      const depValidation = validateFileName(depId);
      if (!depValidation.valid) {
        throw new Error(`Invalid dependency ID "${depId}": ${depValidation.reason}`);
      }
    }

    const now = new Date().toISOString();
    const task: Task = {
      id,
      subject: definition.subject,
      description: definition.description,
      status: "pending",
      owner: null,
      depends_on: dependencyIds,
      blocks: [],
      result_summary: null,
      files_changed: [],
      created_at: now,
      started_at: null,
      completed_at: null,
      task_type: definition.task_type,
      security_requirements: definition.security_requirements,
      performance_requirements: definition.performance_requirements,
      acceptance_criteria: definition.acceptance_criteria,
      risk_level: definition.risk_level,
    };

    // Write the task file with secure permissions (mode 0o600)
    const taskPath = getTaskPath(this.projectDir, id);
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });

    // Now compute `blocks` for all existing tasks:
    // If this new task depends on task X, then task X blocks this new task.
    // Lock each dependency file to prevent race conditions during mutation.
    for (const depId of dependencyIds) {
      const depPath = getTaskPath(this.projectDir, depId);

      // Verify file exists before trying to lock
      try {
        await fs.access(depPath);
      } catch {
        // Dependency file doesn't exist, skip
        continue;
      }

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
    }

    this.touch();
    await this.save();
    return task;
  }

  /**
   * Get a task by ID, or null if not found.
   *
   * (H20 fix) Only catches ENOENT (file not found) and returns null.
   * Other errors (permission denied, corrupt JSON, etc.) are rethrown
   * so callers know something is wrong. Also validates required fields
   * at runtime instead of unsafe cast.
   */
  async getTask(taskId: string): Promise<Task | null> {
    // M-9 FIX: Validate taskId to prevent path traversal (e.g. "../../etc/passwd")
    const idValidation = validateFileName(taskId);
    if (!idValidation.valid) {
      process.stderr.write(`[state-manager] Invalid task ID "${taskId}": ${idValidation.reason}\n`);
      return null;
    }
    const taskPath = getTaskPath(this.projectDir, taskId);
    try {
      const raw = await fs.readFile(taskPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      // Runtime validation of required fields (H20, Issue #6 hardening)
      const p = parsed as Record<string, unknown>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof p.id !== "string" ||
        typeof p.status !== "string" ||
        typeof p.subject !== "string" ||
        typeof p.description !== "string" ||
        !Array.isArray(p.depends_on) ||
        !Array.isArray(p.blocks) ||
        !Array.isArray(p.files_changed) ||
        typeof p.created_at !== "string"
      ) {
        process.stderr.write(`[state-manager] Task file ${taskId} has invalid structure — skipping\n`);
        return null;
      }

      return parsed as Task;
    } catch (err) {
      // Only return null for missing files; rethrow everything else (H20)
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Get all tasks by reading every file in the tasks directory.
   *
   * (H19 fix) Wraps each file read + parse in a try-catch so a single
   * malformed or corrupt task file does not crash the entire operation.
   * Malformed files are skipped with a warning.
   */
  async getAllTasks(): Promise<Task[]> {
    const tasksDir = getTasksDir(this.projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(tasksDir);
    } catch {
      return [];
    }

    const tasks: Task[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(tasksDir, entry), "utf-8");
        const parsed: unknown = JSON.parse(raw);

        // Runtime validation: task must have required fields that downstream
        // code accesses without null checks (H19, Issue #6 hardening).
        const p = parsed as Record<string, unknown>;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof p.id !== "string" ||
          typeof p.status !== "string" ||
          typeof p.subject !== "string" ||
          typeof p.description !== "string" ||
          !Array.isArray(p.depends_on) ||
          !Array.isArray(p.blocks) ||
          !Array.isArray(p.files_changed) ||
          typeof p.created_at !== "string"
        ) {
          process.stderr.write(`[state-manager] Skipping malformed task file: ${entry}\n`);
          continue;
        }

        tasks.push(parsed as Task);
      } catch (err) {
        // Skip malformed/unreadable files instead of crashing (H19)
        process.stderr.write(
          `[state-manager] Error reading task file ${entry}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return tasks;
  }

  /**
   * Remove all task files from the tasks directory.
   * Called before creating new tasks during replanning to prevent stale
   * task files from previous plans from appearing alongside new ones.
   *
   * Only removes .json files (task files). Other file types are left alone.
   * Errors on individual file deletions are logged but do not halt the operation.
   */
  async clearTaskFiles(): Promise<void> {
    const tasksDir = getTasksDir(this.projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(tasksDir);
    } catch {
      return; // Directory doesn't exist yet — nothing to clear
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        await fs.unlink(path.join(tasksDir, entry));
      } catch (err) {
        process.stderr.write(
          `[state-manager] Failed to remove old task file ${entry}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /**
   * Get all tasks that match a given status.
   */
  async getTasksByStatus(status: TaskStatus): Promise<Task[]> {
    const allTasks = await this.getAllTasks();
    return allTasks.filter((t) => t.status === status);
  }

  /**
   * Reset orphaned tasks: any task that is in_progress but whose owner
   * is not in the set of active worker session IDs gets reset to pending.
   *
   * V2: If a TaskRetryTracker is provided, uses it to:
   * - Check if the task should be retried
   * - Mark tasks as failed if retries are exhausted
   * - Persist retry_count and last_error to the task file
   *
   * V3: Uses proper-lockfile to prevent race condition with claim_task (#8).
   * Each task file is locked before mutation with double-check pattern.
   *
   * Returns { resetCount: number, exhaustedCount: number }
   */
  async resetOrphanedTasks(
    activeSessionIds: string[],
    retryTracker?: TaskRetryTrackerInterface,
  ): Promise<{ resetCount: number; exhaustedCount: number }> {
    const activeSet = new Set(activeSessionIds);
    const inProgressTasks = await this.getTasksByStatus("in_progress");
    let resetCount = 0;
    let exhaustedCount = 0;

    for (const task of inProgressTasks) {
      if (task.owner && !activeSet.has(task.owner)) {
        const taskPath = getTaskPath(this.projectDir, task.id);

        // Acquire lock on task file to prevent race with claim_task
        let release: (() => Promise<void>) | undefined;
        try {
          release = await lock(taskPath, {
            retries: { retries: 5, minTimeout: 100 },
            stale: 5000,
          });

          // Double-check pattern: Re-read task after lock acquisition
          // Another process may have claimed or modified it
          const freshTask = await this.getTask(task.id);
          if (!freshTask) {
            // Task file was deleted, skip
            continue;
          }

          // Skip if task state changed (e.g., was claimed by another worker)
          if (freshTask.status !== "in_progress") {
            continue;
          }

          // Skip if task is now owned by an active session
          if (freshTask.owner && activeSet.has(freshTask.owner)) {
            continue;
          }

          // Owner is no longer active — check if we should retry
          if (retryTracker && !retryTracker.shouldRetry(freshTask.id)) {
            // Exhausted retries — mark as failed
            freshTask.status = "failed";
            freshTask.completed_at = new Date().toISOString();
            freshTask.result_summary = "Exceeded maximum retry attempts";
            freshTask.retry_count = retryTracker.getRetryCount(freshTask.id);
            // Convert null to undefined for optional field
            freshTask.last_error = retryTracker.getLastError(freshTask.id) ?? undefined;
            exhaustedCount++;
          } else {
            // Reset for retry
            freshTask.status = "pending";
            freshTask.owner = null;
            freshTask.started_at = null;

            // V2: Persist retry context to task file
            if (retryTracker) {
              freshTask.retry_count = retryTracker.getRetryCount(freshTask.id);
              // Convert null to undefined for optional field
              freshTask.last_error = retryTracker.getLastError(freshTask.id) ?? undefined;
            }
            resetCount++;
          }

          await fs.writeFile(taskPath, JSON.stringify(freshTask, null, 2) + "\n", {
            encoding: "utf-8",
            mode: 0o600,
          });
        } finally {
          if (release) {
            try {
              await release();
            } catch {
              // Lock may already be released
            }
          }
        }
      }
    }

    return { resetCount, exhaustedCount };
  }

  // ----------------------------------------------------------------
  // Session tracking
  // ----------------------------------------------------------------

  /**
   * Add an active session ID.
   */
  async addActiveSession(sessionId: string): Promise<void> {
    this.ensureState();
    if (!this.state!.active_session_ids.includes(sessionId)) {
      this.state!.active_session_ids.push(sessionId);
    }
    this.touch();
    await this.save();
  }

  /**
   * Remove an active session ID.
   */
  async removeActiveSession(sessionId: string): Promise<void> {
    this.ensureState();
    this.state!.active_session_ids = this.state!.active_session_ids.filter(
      (id) => id !== sessionId,
    );
    this.touch();
    await this.save();
  }

  /**
   * Replace the active session list with the provided IDs.
   */
  async setActiveSessions(sessionIds: string[]): Promise<void> {
    this.ensureState();
    this.state!.active_session_ids = [...sessionIds];
    this.touch();
    await this.save();
  }

  // ----------------------------------------------------------------
  // Cycle tracking
  // ----------------------------------------------------------------

  /**
   * Record a completed cycle.
   * Validates CycleRecord required fields (#26g).
   */
  async recordCycle(record: CycleRecord): Promise<void> {
    this.ensureState();

    // Validate required CycleRecord fields (#26g)
    if (typeof record.cycle !== "number" || record.cycle < 1) {
      throw new Error(`Invalid CycleRecord: cycle must be a positive number, got ${record.cycle}`);
    }
    if (typeof record.plan_version !== "number" || record.plan_version < 1) {
      throw new Error(`Invalid CycleRecord: plan_version must be a positive number, got ${record.plan_version}`);
    }
    if (typeof record.duration_ms !== "number" || record.duration_ms < 0) {
      throw new Error(`Invalid CycleRecord: duration_ms must be a non-negative number, got ${record.duration_ms}`);
    }
    if (!record.started_at || !record.completed_at) {
      throw new Error(`Invalid CycleRecord: started_at and completed_at are required`);
    }

    this.state!.cycle_history.push(record);
    this.state!.current_cycle = record.cycle;
    this.touch();
    await this.save();
  }

  // ----------------------------------------------------------------
  // Usage
  // ----------------------------------------------------------------

  /**
   * Update the Claude usage snapshot.
   */
  async updateClaudeUsage(usage: UsageSnapshot): Promise<void> {
    this.ensureState();
    this.state!.claude_usage = usage;
    this.touch();
    await this.save();
  }

  /**
   * Update the Codex usage snapshot.
   */
  async updateCodexUsage(usage: UsageSnapshot): Promise<void> {
    this.ensureState();
    this.state!.codex_usage = usage;
    this.touch();
    await this.save();
  }

  /**
   * Update the Codex usage metrics.
   */
  async updateCodexMetrics(metrics: CodexUsageMetrics): Promise<void> {
    this.ensureState();
    this.state!.codex_metrics = metrics;
    this.touch();
    await this.save();
  }

  /**
   * Update the usage snapshot.
   */
  async updateUsage(usage: UsageSnapshot): Promise<void> {
    this.ensureState();
    this.state!.usage = usage;
    this.touch();
    await this.save();
  }

  // ----------------------------------------------------------------
  // Pause / Resume
  // ----------------------------------------------------------------

  /**
   * Mark the orchestrator as paused with a target resume time.
   */
  async pause(resumeAfter: string): Promise<void> {
    this.ensureState();
    this.state!.status = "paused";
    this.state!.paused_at = new Date().toISOString();
    this.state!.resume_after = resumeAfter;
    this.touch();
    await this.save();
  }

  /**
   * Resume from a paused state.
   */
  async resume(workerRuntime?: "claude" | "codex"): Promise<void> {
    this.ensureState();
    this.state!.status = "executing";
    this.state!.paused_at = null;
    this.state!.resume_after = null;
    if (workerRuntime) {
      this.state!.worker_runtime = workerRuntime;
    }
    this.touch();
    await this.save();
  }

  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------

  private ensureState(): void {
    if (!this.state) {
      throw new Error("StateManager: state not loaded — call initialize() or load() first");
    }
  }

  private touch(): void {
    if (this.state) {
      this.state.updated_at = new Date().toISOString();
    }
  }
}

import fs from "node:fs/promises";
import path from "node:path";

import {
  type OrchestratorState,
  type OrchestratorStatus,
  type Task,
  type TaskDefinition,
  type TaskStatus,
  type CycleRecord,
  type UsageSnapshot,
  type CodexUsageMetrics,
} from "../utils/types.js";

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
      baseCommitSha?: string;
    },
  ): Promise<OrchestratorState> {
    const now = new Date().toISOString();

    this.state = {
      status: "initializing",
      feature,
      project_path: this.projectDir,
      branch,
      worker_runtime: options.workerRuntime,
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
      completed_task_ids: [],
      failed_task_ids: [],
      active_session_ids: [],
      cycle_history: [],
      progress: "",
    };

    await this.save();
    return this.state;
  }

  /**
   * Load existing state from disk (for resume).
   */
  async load(): Promise<OrchestratorState> {
    const statePath = getStatePath(this.projectDir);
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OrchestratorState>;
    this.state = {
      ...parsed,
      worker_runtime: parsed.worker_runtime ?? "claude",
      claude_usage: parsed.claude_usage ?? null,
      codex_usage: parsed.codex_usage ?? null,
    } as OrchestratorState;
    return this.state;
  }

  /**
   * Save current state to disk atomically (write to temp, then rename).
   */
  async save(): Promise<void> {
    if (!this.state) {
      throw new Error("StateManager: no state to save — call initialize() or load() first");
    }
    const statePath = getStatePath(this.projectDir);
    const tmpPath = statePath + ".tmp";
    const content = JSON.stringify(this.state, null, 2) + "\n";
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, statePath);
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
      await fs.mkdir(dir, { recursive: true });
    }
  }

  // ----------------------------------------------------------------
  // Task management
  // ----------------------------------------------------------------

  /**
   * Create a task from a TaskDefinition and persist it.
   */
  async createTask(
    definition: TaskDefinition,
    id: string,
    dependencyIds: string[],
  ): Promise<Task> {
    this.ensureState();

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
    };

    // Write the task file
    const taskPath = getTaskPath(this.projectDir, id);
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2) + "\n", "utf-8");

    // Now compute `blocks` for all existing tasks:
    // If this new task depends on task X, then task X blocks this new task.
    for (const depId of dependencyIds) {
      const depTask = await this.getTask(depId);
      if (depTask && !depTask.blocks.includes(id)) {
        depTask.blocks.push(id);
        const depPath = getTaskPath(this.projectDir, depId);
        await fs.writeFile(depPath, JSON.stringify(depTask, null, 2) + "\n", "utf-8");
      }
    }

    this.touch();
    await this.save();
    return task;
  }

  /**
   * Get a task by ID, or null if not found.
   */
  async getTask(taskId: string): Promise<Task | null> {
    const taskPath = getTaskPath(this.projectDir, taskId);
    try {
      const raw = await fs.readFile(taskPath, "utf-8");
      return JSON.parse(raw) as Task;
    } catch {
      return null;
    }
  }

  /**
   * Get all tasks by reading every file in the tasks directory.
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
      const raw = await fs.readFile(path.join(tasksDir, entry), "utf-8");
      tasks.push(JSON.parse(raw) as Task);
    }
    return tasks;
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
   * Returns the number of tasks reset.
   */
  async resetOrphanedTasks(activeSessionIds: string[]): Promise<number> {
    const activeSet = new Set(activeSessionIds);
    const inProgressTasks = await this.getTasksByStatus("in_progress");
    let resetCount = 0;

    for (const task of inProgressTasks) {
      if (task.owner && !activeSet.has(task.owner)) {
        // Owner is no longer active — reset task
        task.status = "pending";
        task.owner = null;
        task.started_at = null;
        const taskPath = getTaskPath(this.projectDir, task.id);
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2) + "\n", "utf-8");
        resetCount++;
      }
    }

    return resetCount;
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
   */
  async recordCycle(record: CycleRecord): Promise<void> {
    this.ensureState();
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

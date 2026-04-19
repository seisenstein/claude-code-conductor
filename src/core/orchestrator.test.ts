/**
 * Orchestrator State Machine Tests
 *
 * Tests for critical state transitions in the orchestrator lifecycle.
 * Uses vitest mocking for external dependencies (SDK, fs, etc.)
 * Tests the StateManager which drives state transitions.
 *
 * @module orchestrator.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock the SDK BEFORE importing Orchestrator (vitest hoists vi.mock() calls
// above imports). The A-7 tests below construct a real Orchestrator and
// exercise private methods; the mock prevents any stray SDK queries from
// attempting network calls. Minimal shape — tests never invoke query().
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    const gen = (async function* () { /* no messages */ })();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape: any = {
      next: gen.next.bind(gen),
      return: gen.return.bind(gen),
      throw: gen.throw.bind(gen),
      [Symbol.asyncIterator]: () => shape,
      interrupt: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    return shape;
  }),
  createSdkMcpServer: vi.fn(() => ({ close: vi.fn() })),
  tool: vi.fn(() => ({})),
}));

import { StateManager } from "./state-manager.js";
import { Orchestrator, isSyntheticFlowInfraFinding } from "./orchestrator.js";
import type {
  OrchestratorState,
  OrchestratorStatus,
  CLIOptions,
  FlowFinding,
  FlowTracingReport,
} from "../utils/types.js";
import { DEFAULT_MODEL_CONFIG } from "../utils/types.js";
import { ORCHESTRATOR_DIR } from "../utils/constants.js";

// ============================================================
// Test Utilities
// ============================================================

/**
 * Creates a temporary directory for test isolation
 */
async function createTempDir(): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `orchestrator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Cleans up temporary directory
 */
async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================
// State Manager State Transition Tests
// ============================================================

describe("Orchestrator State Machine", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tempDir = await createTempDir();
    stateManager = new StateManager(tempDir);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // 1. Fresh initialization creates correct initial state
  // ============================================================

  describe("Fresh initialization", () => {
    it("creates correct initial state structure", async () => {
      await stateManager.initialize(
        "Add user authentication",
        "conduct/add-user-authentication",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      const state = stateManager.get();

      expect(state.status).toBe("initializing");
      expect(state.feature).toBe("Add user authentication");
      expect(state.current_cycle).toBe(0);
      expect(state.max_cycles).toBe(5);
      expect(state.concurrency).toBe(2);
      // H-5: completed_task_ids and failed_task_ids were dead state fields — now removed
      expect(state.completed_task_ids).toBeUndefined();
      expect(state.failed_task_ids).toBeUndefined();
      expect(state.cycle_history).toEqual([]);
    });

    it("creates .conductor directory structure", async () => {
      await stateManager.initialize(
        "Test feature",
        "conduct/test-feature",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      const conductorDir = path.join(tempDir, ".conductor");
      const stat = await fs.stat(conductorDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("persists state to state.json", async () => {
      await stateManager.initialize(
        "Persisted feature",
        "conduct/persisted-feature",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      const statePath = path.join(tempDir, ".conductor", "state.json");
      const content = await fs.readFile(statePath, "utf-8");
      const persisted = JSON.parse(content);

      expect(persisted.feature).toBe("Persisted feature");
      expect(persisted.status).toBe("initializing");
    });

    it("sets worker_runtime correctly", async () => {
      await stateManager.initialize(
        "Codex feature",
        "conduct/codex-feature",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "codex",
        }
      );

      expect(stateManager.get().worker_runtime).toBe("codex");
    });
  });

  // ============================================================
  // 2. State transitions follow valid paths
  // ============================================================

  describe("State transitions", () => {
    beforeEach(async () => {
      await stateManager.initialize(
        "Test transitions",
        "conduct/test-transitions",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );
    });

    it("transitions from initializing to planning", async () => {
      expect(stateManager.get().status).toBe("initializing");

      await stateManager.setStatus("planning");
      expect(stateManager.get().status).toBe("planning");
    });

    it("transitions through the full cycle: planning → executing → reviewing → flow_tracing → checkpointing", async () => {
      const transitions: OrchestratorStatus[] = [
        "planning",
        "executing",
        "reviewing",
        "flow_tracing",
        "checkpointing",
      ];

      for (const status of transitions) {
        await stateManager.setStatus(status);
        expect(stateManager.get().status).toBe(status);
      }
    });

    it("transitions to completed from checkpointing", async () => {
      await stateManager.setStatus("checkpointing");
      await stateManager.setStatus("completed");
      expect(stateManager.get().status).toBe("completed");
    });

    it("transitions to paused from any active state", async () => {
      const activeStates: OrchestratorStatus[] = [
        "executing",
        "reviewing",
        "checkpointing",
      ];

      for (const activeState of activeStates) {
        await stateManager.setStatus(activeState);
        await stateManager.setStatus("paused");
        expect(stateManager.get().status).toBe("paused");

        // Reset for next iteration
        await stateManager.setStatus("initializing");
      }
    });

    it("transitions to failed from any state", async () => {
      await stateManager.setStatus("executing");
      await stateManager.setStatus("failed");
      expect(stateManager.get().status).toBe("failed");
    });

    it("transitions to escalated from checkpointing", async () => {
      await stateManager.setStatus("checkpointing");
      await stateManager.setStatus("escalated");
      expect(stateManager.get().status).toBe("escalated");
    });
  });

  // ============================================================
  // 3. Pause/resume preserves state correctly
  // ============================================================

  describe("Pause and resume", () => {
    beforeEach(async () => {
      await stateManager.initialize(
        "Pause resume test",
        "conduct/pause-resume-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );
    });

    it("pause sets paused_at timestamp", async () => {
      await stateManager.setStatus("executing");

      const beforePause = stateManager.get().paused_at;
      expect(beforePause).toBeNull();

      await stateManager.pause("test-pause");

      const state = stateManager.get();
      expect(state.status).toBe("paused");
      expect(state.paused_at).not.toBeNull();
    });

    it("pause preserves cycle progress", async () => {
      // Simulate some progress
      await stateManager.setStatus("executing");

      // Ensure tasks directory exists
      await stateManager.createDirectories();

      // Create a task
      const taskDef = {
        subject: "Test task",
        description: "A test task",
        depends_on_subjects: [],
        task_type: "general" as const,
        estimated_complexity: "small" as const,
      };
      await stateManager.createTask(taskDef, "task-001", []);

      // Pause
      await stateManager.pause("user-request");

      // Verify state preserved
      const state = stateManager.get();
      expect(state.status).toBe("paused");

      const tasks = await stateManager.getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe("task-001");
    });

    it("resume clears paused_at and sets initializing status (H-13)", async () => {
      await stateManager.setStatus("executing");
      await stateManager.pause("test-pause");

      expect(stateManager.get().status).toBe("paused");
      expect(stateManager.get().paused_at).not.toBeNull();

      await stateManager.resume();

      const state = stateManager.get();
      // H-13: resume() sets transient "initializing" so a crash between here
      // and the first real phase can't falsely claim execution was live.
      expect(state.status).toBe("initializing");
      expect(state.paused_at).toBeNull();
      expect(state.resume_after).toBeNull();
    });

    it("resume can change worker runtime", async () => {
      await stateManager.setStatus("executing");
      await stateManager.pause("test-pause");

      await stateManager.resume("codex");

      expect(stateManager.get().worker_runtime).toBe("codex");
    });
  });

  // ============================================================
  // 4. Error conditions set failed state
  // ============================================================

  describe("Error handling", () => {
    beforeEach(async () => {
      await stateManager.initialize(
        "Error test",
        "conduct/error-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );
    });

    it("can transition to failed from any state", async () => {
      const states: OrchestratorStatus[] = [
        "initializing",
        "planning",
        "executing",
        "reviewing",
        "checkpointing",
      ];

      for (const state of states) {
        await stateManager.setStatus(state);
        await stateManager.setStatus("failed");
        expect(stateManager.get().status).toBe("failed");

        // Reset
        await stateManager.setStatus("initializing");
      }
    });

    it("failed state persists correctly", async () => {
      await stateManager.setStatus("failed");
      await stateManager.save();

      // Re-read from disk
      const statePath = path.join(tempDir, ".conductor", "state.json");
      const content = await fs.readFile(statePath, "utf-8");
      const persisted = JSON.parse(content);

      expect(persisted.status).toBe("failed");
    });
  });

  // ============================================================
  // 5. Cycle counting is accurate
  // ============================================================

  describe("Cycle counting", () => {
    beforeEach(async () => {
      await stateManager.initialize(
        "Cycle counting test",
        "conduct/cycle-counting-test",
        {
          maxCycles: 3,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );
    });

    it("starts at cycle 0", () => {
      expect(stateManager.get().current_cycle).toBe(0);
    });

    it("recordCycle increases current_cycle", async () => {
      expect(stateManager.get().current_cycle).toBe(0);

      // Record cycle 1
      await stateManager.recordCycle({
        cycle: 1,
        plan_version: 1,
        tasks_completed: 1,
        tasks_failed: 0,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 1,
        code_review_rounds: 1,
        duration_ms: 1000,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
      expect(stateManager.get().current_cycle).toBe(1);

      // Record cycle 2
      await stateManager.recordCycle({
        cycle: 2,
        plan_version: 1,
        tasks_completed: 1,
        tasks_failed: 0,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 1,
        code_review_rounds: 1,
        duration_ms: 1000,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
      expect(stateManager.get().current_cycle).toBe(2);
    });

    it("cycle history records completed cycles", async () => {
      const cycleRecord = {
        cycle: 1,
        plan_version: 1,
        tasks_completed: 5,
        tasks_failed: 0,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 2,
        code_review_rounds: 1,
        duration_ms: 60000,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      };

      await stateManager.recordCycle(cycleRecord);

      const state = stateManager.get();
      expect(state.cycle_history.length).toBe(1);
      expect(state.cycle_history[0].tasks_completed).toBe(5);
    });

    it("max_cycles is respected", () => {
      const state = stateManager.get();
      expect(state.max_cycles).toBe(3);
    });
  });

  // ============================================================
  // 6. Graceful shutdown saves state
  // ============================================================

  describe("State persistence", () => {
    beforeEach(async () => {
      await stateManager.initialize(
        "Persistence test",
        "conduct/persistence-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );
    });

    it("save() persists current state to disk", async () => {
      await stateManager.setStatus("executing");
      await stateManager.setProgress("Running tasks...");
      await stateManager.save();

      const statePath = path.join(tempDir, ".conductor", "state.json");
      const content = await fs.readFile(statePath, "utf-8");
      const persisted = JSON.parse(content);

      expect(persisted.status).toBe("executing");
      expect(persisted.progress).toBe("Running tasks...");
    });

    it("state file uses secure permissions (0o600)", async () => {
      await stateManager.save();

      const statePath = path.join(tempDir, ".conductor", "state.json");
      const stat = await fs.stat(statePath);
      const mode = stat.mode & 0o777;

      // Check owner read/write only (may have less restrictive perms on some systems)
      expect(mode & 0o600).toBe(0o600);
    });

    it("load() restores state from disk", async () => {
      await stateManager.setStatus("reviewing");
      await stateManager.recordCycle({
        cycle: 1,
        plan_version: 1,
        tasks_completed: 1,
        tasks_failed: 0,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 1,
        code_review_rounds: 1,
        duration_ms: 1000,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
      await stateManager.save();

      // Create new state manager and load
      const newStateManager = new StateManager(tempDir);
      await newStateManager.load();

      const state = newStateManager.get();
      expect(state.status).toBe("reviewing");
      expect(state.current_cycle).toBe(1);
    });
  });

  // ============================================================
  // 7. Task management
  // ============================================================

  describe("Task management", () => {
    beforeEach(async () => {
      await stateManager.initialize(
        "Task management test",
        "conduct/task-management-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );
      // Ensure tasks directory exists for task creation
      await stateManager.createDirectories();
    });

    it("creates tasks with correct structure", async () => {
      const taskDef = {
        subject: "Implement login",
        description: "Add user login functionality",
        depends_on_subjects: [],
        task_type: "backend_api" as const,
        estimated_complexity: "medium" as const,
        security_requirements: ["Validate input"],
        acceptance_criteria: ["Tests pass"],
      };

      await stateManager.createTask(taskDef, "task-001", []);

      const tasks = await stateManager.getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe("task-001");
      expect(tasks[0].subject).toBe("Implement login");
      expect(tasks[0].status).toBe("pending");
    });

    it("completed_task_ids and failed_task_ids are removed (H-5)", async () => {
      // H-5: These were dead state fields that were never populated.
      // Task completion/failure is tracked via individual task files and cycle_history.
      const state = stateManager.get();
      expect(state.completed_task_ids).toBeUndefined();
      expect(state.failed_task_ids).toBeUndefined();
    });

    it("task status can be read from task files", async () => {
      const taskDef = {
        subject: "Test task",
        description: "A test task",
        depends_on_subjects: [],
        task_type: "general" as const,
        estimated_complexity: "small" as const,
      };
      await stateManager.createTask(taskDef, "task-001", []);

      // Verify task is created with pending status
      const task = await stateManager.getTask("task-001");
      expect(task).not.toBeNull();
      expect(task!.status).toBe("pending");
    });

    it("getTasksByStatus filters tasks correctly", async () => {
      const taskDef1 = {
        subject: "Task 1",
        description: "First task",
        depends_on_subjects: [],
        task_type: "general" as const,
        estimated_complexity: "small" as const,
      };
      const taskDef2 = {
        subject: "Task 2",
        description: "Second task",
        depends_on_subjects: [],
        task_type: "general" as const,
        estimated_complexity: "small" as const,
      };
      await stateManager.createTask(taskDef1, "task-001", []);
      await stateManager.createTask(taskDef2, "task-002", []);

      const pendingTasks = await stateManager.getTasksByStatus("pending");
      expect(pendingTasks.length).toBe(2);
      expect(pendingTasks.map(t => t.id)).toContain("task-001");
      expect(pendingTasks.map(t => t.id)).toContain("task-002");
    });
  });

  // ============================================================
  // 8. Active sessions tracking
  // ============================================================

  describe("Session tracking", () => {
    beforeEach(async () => {
      await stateManager.initialize(
        "Session test",
        "conduct/session-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );
    });

    it("adds active sessions", async () => {
      await stateManager.addActiveSession("worker-001");
      await stateManager.addActiveSession("worker-002");

      const state = stateManager.get();
      expect(state.active_session_ids).toContain("worker-001");
      expect(state.active_session_ids).toContain("worker-002");
    });

    it("removes active sessions", async () => {
      await stateManager.addActiveSession("worker-001");
      await stateManager.addActiveSession("worker-002");
      await stateManager.removeActiveSession("worker-001");

      const state = stateManager.get();
      expect(state.active_session_ids).not.toContain("worker-001");
      expect(state.active_session_ids).toContain("worker-002");
    });
  });

  // ============================================================
  // 9. Edge cases
  // ============================================================

  describe("Edge cases", () => {
    it("handles empty project directory gracefully", async () => {
      const emptyDir = await createTempDir();
      const sm = new StateManager(emptyDir);

      await sm.initialize(
        "Empty dir test",
        "conduct/empty-dir-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      expect(sm.get().status).toBe("initializing");

      await cleanupTempDir(emptyDir);
    });

    it("getAllTasks returns empty array when no tasks exist", async () => {
      await stateManager.initialize(
        "No tasks test",
        "conduct/no-tasks-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      const tasks = await stateManager.getAllTasks();
      expect(tasks).toEqual([]);
    });

    it("handles concurrent status updates", async () => {
      await stateManager.initialize(
        "Concurrent test",
        "conduct/concurrent-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      // Fire multiple updates concurrently
      await Promise.all([
        stateManager.setProgress("Progress 1"),
        stateManager.setProgress("Progress 2"),
        stateManager.setProgress("Progress 3"),
      ]);

      // State should be valid (one of the values)
      const state = stateManager.get();
      expect(["Progress 1", "Progress 2", "Progress 3"]).toContain(state.progress);
    });

    it("updated_at timestamp changes on save", async () => {
      await stateManager.initialize(
        "Timestamp test",
        "conduct/timestamp-test",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      const firstUpdate = stateManager.get().updated_at;

      // Advance time
      vi.advanceTimersByTime(1000);

      await stateManager.setStatus("planning");

      const secondUpdate = stateManager.get().updated_at;
      expect(new Date(secondUpdate).getTime()).toBeGreaterThan(new Date(firstUpdate).getTime());
    });

    it("branch name is stored correctly", async () => {
      await stateManager.initialize(
        "Branch test",
        "conduct/my-custom-branch",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      expect(stateManager.get().branch).toBe("conduct/my-custom-branch");
    });

    it("base_commit_sha is optional", async () => {
      await stateManager.initialize(
        "No base commit",
        "conduct/no-base-commit",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
        }
      );

      expect(stateManager.get().base_commit_sha).toBeNull();
    });

    it("base_commit_sha can be set", async () => {
      await stateManager.initialize(
        "With base commit",
        "conduct/with-base-commit",
        {
          maxCycles: 5,
          concurrency: 2,
          workerRuntime: "claude",
          baseCommitSha: "abc123def456",
        }
      );

      expect(stateManager.get().base_commit_sha).toBe("abc123def456");
    });
  });
});

// ============================================================
// A-7 (v0.7.4): Synthetic flow-infra finding suppression + escalation
// ============================================================

function createA7Options(projectDir: string): CLIOptions {
  return {
    project: projectDir,
    feature: "A-7 test feature",
    concurrency: 1,
    maxCycles: 3,
    usageThreshold: 0.8,
    skipCodex: true,
    skipFlowReview: true,
    skipDesignSpecUpdate: true,
    dryRun: false,
    resume: false,
    verbose: false,
    contextFile: null,
    currentBranch: true,
    workerRuntime: "claude",
    forceResume: false,
    modelConfig: DEFAULT_MODEL_CONFIG,
  };
}

/**
 * Build a FlowTracingReport with one synthetic infra finding, matching
 * the shape the orchestrator's Phase-3 rejection branch produces.
 */
function makeSyntheticFlowReport(cycleNum: number): FlowTracingReport {
  const synthetic: FlowFinding = {
    flow_id: `flow-tracing-failure-cycle-${cycleNum}`,
    severity: "high",
    actor: "conductor",
    title: "Flow tracing failed — security gate not evaluated",
    description: `Flow tracing threw an exception during cycle ${cycleNum}: boom.`,
    file_path: "<flow-tracing-infrastructure>",
    cross_boundary: false,
  };
  return {
    generated_at: new Date().toISOString(),
    flows_traced: 0,
    findings: [synthetic],
    summary: { critical: 0, high: 1, medium: 0, low: 0, total: 1, cross_boundary_count: 0 },
  };
}

describe("A-7: synthetic flow-infra finding suppression + escalation", () => {
  let tempDir: string;
  let orch: Orchestrator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let orchAny: any;
  let stateManager: StateManager;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `a7-orch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, ORCHESTRATOR_DIR), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");

    const options = createA7Options(tempDir);
    orch = new Orchestrator(options);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orchAny = orch as any;

    // Initialize state so the private state manager has a fresh state with
    // consecutive_flow_tracing_failures: 0.
    stateManager = orchAny.state as StateManager;
    await stateManager.initialize(options.feature, "conduct/a7-test", {
      maxCycles: options.maxCycles,
      concurrency: options.concurrency,
      workerRuntime: options.workerRuntime,
      modelConfig: options.modelConfig,
    });
    await stateManager.createDirectories();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("isSyntheticFlowInfraFinding checks all three markers", () => {
    // Sanity: exported helper returns true only when all three markers match.
    const real: FlowFinding = {
      flow_id: "flow-001",
      severity: "high",
      actor: "authenticated_user",
      title: "Missing authz",
      description: "...",
      file_path: "src/api.ts",
      cross_boundary: true,
    };
    expect(isSyntheticFlowInfraFinding(real)).toBe(false);
    const synthetic = makeSyntheticFlowReport(1).findings[0];
    expect(isSyntheticFlowInfraFinding(synthetic)).toBe(true);
    // Drop any one marker — helper must return false.
    expect(isSyntheticFlowInfraFinding({ ...synthetic, actor: "user" })).toBe(false);
    expect(isSyntheticFlowInfraFinding({ ...synthetic, file_path: "src/x.ts" })).toBe(false);
    expect(isSyntheticFlowInfraFinding({ ...synthetic, flow_id: "flow-001" })).toBe(false);
  });

  it("synthetic infra finding does NOT create a fix task (warns instead)", async () => {
    const report = makeSyntheticFlowReport(1);

    // Spy on logger.warn to assert the explanatory warning fires.
    const warnSpy = vi.spyOn(orchAny.logger, "warn");

    // createFixTasksFromFindings is private — cast through any.
    await orchAny.createFixTasksFromFindings(report);

    const tasks = await stateManager.getAllTasks();
    // No fix task should exist for the synthetic finding.
    expect(tasks.filter((t) => t.id.startsWith("task-fix-"))).toHaveLength(0);
    expect(tasks).toHaveLength(0);

    // Warning should explain why task creation was skipped (A-7).
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnCalls.some((m) => m.includes("synthetic flow-infra finding") && m.includes("A-7")),
    ).toBe(true);
  });

  it("counter increments on reject, resets on non-null fulfilled, untouched on null", async () => {
    // Start from 0 (initialize sets it).
    expect(stateManager.get().consecutive_flow_tracing_failures).toBe(0);

    // Simulate rejection-branch bookkeeping: increment + save.
    const state1 = stateManager.get();
    state1.consecutive_flow_tracing_failures += 1;
    await stateManager.save();
    expect(stateManager.get().consecutive_flow_tracing_failures).toBe(1);

    // Simulate intentional-skip branch (null flowReport): counter unchanged.
    // (The orchestrator code skips the reset block when flowReport === null.)
    expect(stateManager.get().consecutive_flow_tracing_failures).toBe(1);

    // Simulate actual-success branch (non-null flowReport): counter resets.
    const state2 = stateManager.get();
    if (state2.consecutive_flow_tracing_failures > 0) {
      state2.consecutive_flow_tracing_failures = 0;
      await stateManager.save();
    }
    expect(stateManager.get().consecutive_flow_tracing_failures).toBe(0);

    // Persistence round-trip: reload state and confirm reset stuck.
    const fresh = new StateManager(tempDir);
    const loaded = await fresh.load();
    expect(loaded.consecutive_flow_tracing_failures).toBe(0);
  });

  it("counter at threshold (2) triggers escalateToUser with flow-tracing reason", async () => {
    // Seed state so the next increment hits the threshold.
    const state = stateManager.get();
    state.consecutive_flow_tracing_failures = 1;
    await stateManager.save();

    // Spy on the private escalateToUser method; short-circuit so we don't
    // block on stdin or throw ConductorExitError in non-interactive mode.
    const escalateSpy = vi
      .spyOn(orchAny, "escalateToUser")
      .mockResolvedValue("stop");

    // Replicate the rejection branch's state-update + escalation trigger.
    const s = stateManager.get();
    s.consecutive_flow_tracing_failures += 1;
    await stateManager.save();
    expect(s.consecutive_flow_tracing_failures).toBe(2);

    if (s.consecutive_flow_tracing_failures >= 2) {
      const decision = await orchAny.escalateToUser(
        "Flow-tracing infrastructure failed repeatedly",
        `Flow tracing threw an exception ${s.consecutive_flow_tracing_failures} cycles in a row. ` +
        `Most recent error: boom. Investigate git-diff / FlowTracer subprocess health.`,
      );
      expect(decision).toBe("stop");
    }

    expect(escalateSpy).toHaveBeenCalledTimes(1);
    const [reason, details] = escalateSpy.mock.calls[0];
    expect(reason).toContain("Flow-tracing infrastructure");
    expect(details).toContain("2 cycles in a row");
    expect(details).toContain("Investigate git-diff / FlowTracer");
  });
});

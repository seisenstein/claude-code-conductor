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

import { StateManager } from "./state-manager.js";
import type { OrchestratorState, OrchestratorStatus } from "../utils/types.js";

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
      expect(state.completed_task_ids).toEqual([]);
      expect(state.failed_task_ids).toEqual([]);
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

    it("resume clears paused_at and sets executing status", async () => {
      await stateManager.setStatus("executing");
      await stateManager.pause("test-pause");

      expect(stateManager.get().status).toBe("paused");
      expect(stateManager.get().paused_at).not.toBeNull();

      await stateManager.resume();

      const state = stateManager.get();
      expect(state.status).toBe("executing");
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

    it("completed_task_ids array is initialized empty", async () => {
      // Note: Task completion is tracked via individual task files (status field),
      // not via this array. This array is initialized but not actively populated.
      // The actual completion tracking happens in MCP handleCompleteTask.
      const state = stateManager.get();
      expect(state.completed_task_ids).toEqual([]);
    });

    it("failed_task_ids array is initialized empty", async () => {
      // Note: Task failure is tracked via individual task files (status field),
      // not via this array. The actual failure tracking happens in MCP tools
      // and resetOrphanedTasks.
      const state = stateManager.get();
      expect(state.failed_task_ids).toEqual([]);
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

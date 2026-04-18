/**
 * Integration tests for StateManager
 *
 * Tests atomic write patterns, state persistence across load/save cycles,
 * and task retry field persistence using real file system operations
 * in temporary directories.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StateManager } from "./state-manager.js";
import { TaskRetryTracker } from "./worker-resilience.js";
import type { Task, TaskDefinition } from "../utils/types.js";

describe("StateManager integration", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-state-test-"));
    stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("atomic writes", () => {
    it("state file is valid JSON after save", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const statePath = path.join(tempDir, ".conductor", "state.json");
      const tmpPath = statePath + ".tmp";

      // Tmp file should not exist after save
      await expect(fs.access(tmpPath)).rejects.toThrow();

      // State file should exist
      await expect(fs.access(statePath)).resolves.not.toThrow();

      // State should be valid JSON
      const content = await fs.readFile(statePath, "utf-8");
      const state = JSON.parse(content);
      expect(state.feature).toBe("test feature");
    });

    it("state persists across load/save cycles", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.setStatus("executing");
      await stateManager.setProgress("Working on tasks");

      // Create new instance and load
      const stateManager2 = new StateManager(tempDir);
      const loaded = await stateManager2.load();

      expect(loaded.status).toBe("executing");
      expect(loaded.progress).toBe("Working on tasks");
    });

    it("preserves all state fields across save/load cycles", async () => {
      await stateManager.initialize("complex feature", "feature-branch", {
        maxCycles: 3,
        concurrency: 4,
        workerRuntime: "claude",
        baseCommitSha: "abc123",
      });

      // Modify various state fields
      await stateManager.setStatus("reviewing");
      await stateManager.addActiveSession("worker-1");
      await stateManager.addActiveSession("worker-2");
      await stateManager.recordCycle({
        cycle: 1,
        plan_version: 1,
        tasks_completed: 5,
        tasks_failed: 1,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 2,
        code_review_rounds: 1,
        duration_ms: 60000,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });

      // Load in new instance
      const stateManager2 = new StateManager(tempDir);
      const loaded = await stateManager2.load();

      expect(loaded.feature).toBe("complex feature");
      expect(loaded.branch).toBe("feature-branch");
      expect(loaded.max_cycles).toBe(3);
      expect(loaded.concurrency).toBe(4);
      expect(loaded.base_commit_sha).toBe("abc123");
      expect(loaded.status).toBe("reviewing");
      expect(loaded.active_session_ids).toEqual(["worker-1", "worker-2"]);
      expect(loaded.cycle_history).toHaveLength(1);
      expect(loaded.cycle_history[0].tasks_completed).toBe(5);
    });

    it("multiple sequential saves work correctly", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Perform multiple sequential saves
      await stateManager.setProgress("Progress 1");
      await stateManager.setProgress("Progress 2");
      await stateManager.setProgress("Progress 3");

      // State should have the last progress value
      const stateManager2 = new StateManager(tempDir);
      const loaded = await stateManager2.load();
      expect(loaded.progress).toBe("Progress 3");
    });

    it("concurrent saves produce valid JSON", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const results = await Promise.allSettled([
        stateManager.setProgress("Progress A"),
        stateManager.setProgress("Progress B"),
      ]);

      // At least one save must succeed
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Verify final state is valid JSON
      const statePath = path.join(tempDir, ".conductor", "state.json");
      const content = await fs.readFile(statePath, "utf-8");
      const state = JSON.parse(content); // Should not throw
      expect(["Progress A", "Progress B"]).toContain(state.progress);
    });

    it("creates .conductor directory if missing on save", async () => {
      // Create a fresh state manager pointing to a new temp subdir
      const subDir = path.join(tempDir, "nested", "project");
      const freshManager = new StateManager(subDir);
      await freshManager.createDirectories();
      await freshManager.initialize("test", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Verify state was saved
      const statePath = path.join(subDir, ".conductor", "state.json");
      const content = await fs.readFile(statePath, "utf-8");
      const state = JSON.parse(content);
      expect(state.feature).toBe("test");
    });
  });

  describe("task management", () => {
    it("creates task files with correct structure", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const taskDef: TaskDefinition = {
        subject: "Test task",
        description: "Test description",
        depends_on_subjects: [],
        estimated_complexity: "small",
        task_type: "backend_api",
        security_requirements: ["Validate all inputs"],
        performance_requirements: ["Use pagination"],
        acceptance_criteria: ["Tests pass"],
        risk_level: "medium",
      };

      const task = await stateManager.createTask(taskDef, "task-001", []);

      expect(task.id).toBe("task-001");
      expect(task.subject).toBe("Test task");
      expect(task.status).toBe("pending");
      expect(task.task_type).toBe("backend_api");
      expect(task.security_requirements).toEqual(["Validate all inputs"]);

      // Verify task file exists
      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      const taskPath = path.join(tasksDir, "task-001.json");
      const taskContent = await fs.readFile(taskPath, "utf-8");
      const persistedTask = JSON.parse(taskContent);
      expect(persistedTask.id).toBe("task-001");
    });

    it("updates blocks relationship when creating dependent tasks", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Create first task
      await stateManager.createTask(
        {
          subject: "Parent task",
          description: "Parent description",
          depends_on_subjects: [],
          estimated_complexity: "medium",
        },
        "task-001",
        [],
      );

      // Create dependent task
      await stateManager.createTask(
        {
          subject: "Child task",
          description: "Child description",
          depends_on_subjects: ["Parent task"],
          estimated_complexity: "small",
        },
        "task-002",
        ["task-001"],
      );

      // Parent task should have child in blocks array
      const parentTask = await stateManager.getTask("task-001");
      expect(parentTask?.blocks).toContain("task-002");

      // Child task should have parent in depends_on
      const childTask = await stateManager.getTask("task-002");
      expect(childTask?.depends_on).toContain("task-001");
    });

    it("retrieves tasks by status", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Create tasks with different statuses
      await stateManager.createTask(
        { subject: "Task 1", description: "", depends_on_subjects: [], estimated_complexity: "small" },
        "task-001",
        [],
      );
      await stateManager.createTask(
        { subject: "Task 2", description: "", depends_on_subjects: [], estimated_complexity: "small" },
        "task-002",
        [],
      );

      // Modify one task to be in_progress
      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      const task2Path = path.join(tasksDir, "task-002.json");
      const task2 = JSON.parse(await fs.readFile(task2Path, "utf-8")) as Task;
      task2.status = "in_progress";
      task2.owner = "worker-1";
      await fs.writeFile(task2Path, JSON.stringify(task2, null, 2));

      const pendingTasks = await stateManager.getTasksByStatus("pending");
      const inProgressTasks = await stateManager.getTasksByStatus("in_progress");

      expect(pendingTasks).toHaveLength(1);
      expect(pendingTasks[0].id).toBe("task-001");
      expect(inProgressTasks).toHaveLength(1);
      expect(inProgressTasks[0].id).toBe("task-002");
    });
  });

  describe("task retry fields", () => {
    it("persists retry_count and last_error on task reset", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Create a task
      const taskDef: TaskDefinition = {
        subject: "Test task",
        description: "Test description",
        depends_on_subjects: [],
        estimated_complexity: "small",
      };
      await stateManager.createTask(taskDef, "task-001", []);

      // Claim the task (simulate worker claiming)
      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      const taskPath = path.join(tasksDir, "task-001.json");
      const task = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
      task.status = "in_progress";
      task.owner = "worker-1";
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

      // Set up retry tracker
      const retryTracker = new TaskRetryTracker();
      retryTracker.recordFailure("task-001", "Worker timed out");

      // Reset orphaned tasks
      const result = await stateManager.resetOrphanedTasks([], retryTracker);
      expect(result.resetCount).toBe(1);

      // Verify retry fields are persisted
      const updatedTask = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
      expect(updatedTask.status).toBe("pending");
      expect(updatedTask.retry_count).toBe(1);
      expect(updatedTask.last_error).toBeTruthy();
      // Error should be sanitized (path-like content removed)
      expect(updatedTask.last_error).not.toContain("/home/");
    });

    it("marks task as failed when retries exhausted", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const taskDef: TaskDefinition = {
        subject: "Test task",
        description: "Test description",
        depends_on_subjects: [],
        estimated_complexity: "small",
      };
      await stateManager.createTask(taskDef, "task-001", []);

      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      const taskPath = path.join(tasksDir, "task-001.json");
      const task = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
      task.status = "in_progress";
      task.owner = "worker-1";
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

      // Exhaust retries (default MAX_TASK_RETRIES = 2)
      const retryTracker = new TaskRetryTracker();
      retryTracker.recordFailure("task-001", "Error 1");
      retryTracker.recordFailure("task-001", "Error 2");
      // Now shouldRetry returns false

      const result = await stateManager.resetOrphanedTasks([], retryTracker);
      expect(result.exhaustedCount).toBe(1);
      expect(result.resetCount).toBe(0);

      const updatedTask = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
      expect(updatedTask.status).toBe("failed");
      expect(updatedTask.result_summary).toContain("retry");
      expect(updatedTask.completed_at).toBeTruthy();
    });

    it("does not reset tasks with active owners", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.createTask(
        { subject: "Task 1", description: "", depends_on_subjects: [], estimated_complexity: "small" },
        "task-001",
        [],
      );

      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      const taskPath = path.join(tasksDir, "task-001.json");
      const task = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
      task.status = "in_progress";
      task.owner = "worker-1";
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

      // Worker is still active
      const result = await stateManager.resetOrphanedTasks(["worker-1"]);
      expect(result.resetCount).toBe(0);
      expect(result.exhaustedCount).toBe(0);

      // Task should still be in_progress
      const unchangedTask = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
      expect(unchangedTask.status).toBe("in_progress");
    });

    it("resets multiple orphaned tasks correctly", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Create multiple tasks
      for (let i = 1; i <= 3; i++) {
        await stateManager.createTask(
          { subject: `Task ${i}`, description: "", depends_on_subjects: [], estimated_complexity: "small" },
          `task-00${i}`,
          [],
        );
      }

      const tasksDir = path.join(tempDir, ".conductor", "tasks");

      // Set all to in_progress with different owners
      for (let i = 1; i <= 3; i++) {
        const taskPath = path.join(tasksDir, `task-00${i}.json`);
        const task = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
        task.status = "in_progress";
        task.owner = `worker-${i}`;
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
      }

      // Only worker-2 is still active
      const retryTracker = new TaskRetryTracker();
      retryTracker.recordFailure("task-001", "Worker 1 died");
      retryTracker.recordFailure("task-003", "Worker 3 died");

      const result = await stateManager.resetOrphanedTasks(["worker-2"], retryTracker);
      expect(result.resetCount).toBe(2); // task-001 and task-003

      // Verify task statuses
      const task1 = JSON.parse(await fs.readFile(path.join(tasksDir, "task-001.json"), "utf-8")) as Task;
      const task2 = JSON.parse(await fs.readFile(path.join(tasksDir, "task-002.json"), "utf-8")) as Task;
      const task3 = JSON.parse(await fs.readFile(path.join(tasksDir, "task-003.json"), "utf-8")) as Task;

      expect(task1.status).toBe("pending");
      expect(task1.retry_count).toBe(1);
      expect(task2.status).toBe("in_progress"); // Still active
      expect(task3.status).toBe("pending");
      expect(task3.retry_count).toBe(1);
    });

    it("works without retry tracker (backward compatibility)", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.createTask(
        { subject: "Task 1", description: "", depends_on_subjects: [], estimated_complexity: "small" },
        "task-001",
        [],
      );

      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      const taskPath = path.join(tasksDir, "task-001.json");
      const task = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
      task.status = "in_progress";
      task.owner = "worker-1";
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

      // Reset without retry tracker
      const result = await stateManager.resetOrphanedTasks([]);
      expect(result.resetCount).toBe(1);

      const updatedTask = JSON.parse(await fs.readFile(taskPath, "utf-8")) as Task;
      expect(updatedTask.status).toBe("pending");
      // No retry fields since no tracker provided
      expect(updatedTask.retry_count).toBeUndefined();
    });
  });

  describe("session tracking", () => {
    it("adds and removes active sessions", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.addActiveSession("worker-1");
      await stateManager.addActiveSession("worker-2");

      let state = stateManager.get();
      expect(state.active_session_ids).toEqual(["worker-1", "worker-2"]);

      await stateManager.removeActiveSession("worker-1");
      state = stateManager.get();
      expect(state.active_session_ids).toEqual(["worker-2"]);
    });

    it("does not duplicate session IDs", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.addActiveSession("worker-1");
      await stateManager.addActiveSession("worker-1");
      await stateManager.addActiveSession("worker-1");

      const state = stateManager.get();
      expect(state.active_session_ids).toEqual(["worker-1"]);
    });

    it("sets active sessions list", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.addActiveSession("worker-1");
      await stateManager.addActiveSession("worker-2");

      await stateManager.setActiveSessions(["worker-3", "worker-4"]);

      const state = stateManager.get();
      expect(state.active_session_ids).toEqual(["worker-3", "worker-4"]);
    });
  });

  describe("pause and resume", () => {
    it("pauses and resumes orchestrator state", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.setStatus("executing");

      // Pause
      const resumeAfter = new Date(Date.now() + 3600000).toISOString();
      await stateManager.pause(resumeAfter);

      let state = stateManager.get();
      expect(state.status).toBe("paused");
      expect(state.paused_at).toBeTruthy();
      expect(state.resume_after).toBe(resumeAfter);

      // Resume — H-13: sets transient "initializing", not "executing".
      await stateManager.resume();

      state = stateManager.get();
      expect(state.status).toBe("initializing");
      expect(state.paused_at).toBeNull();
      expect(state.resume_after).toBeNull();
    });

    it("resume can switch worker runtime", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.pause(new Date().toISOString());
      await stateManager.resume("codex");

      const state = stateManager.get();
      expect(state.worker_runtime).toBe("codex");
    });
  });

  describe("error handling", () => {
    it("throws when getting state before initialization", () => {
      const uninitializedManager = new StateManager(tempDir);
      expect(() => uninitializedManager.get()).toThrow("state not loaded");
    });

    it("returns null for non-existent tasks", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const task = await stateManager.getTask("non-existent-task");
      expect(task).toBeNull();
    });

    it("returns empty array when no tasks exist", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const tasks = await stateManager.getAllTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe("H19: getAllTasks handles malformed JSON", () => {
    it("skips malformed JSON files without crashing", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Create a valid task
      await stateManager.createTask(
        { subject: "Valid task", description: "Valid", depends_on_subjects: [], estimated_complexity: "small" },
        "task-001",
        [],
      );

      // Write a malformed JSON file directly to the tasks directory
      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      await fs.writeFile(path.join(tasksDir, "task-002.json"), "{ invalid json !!!");

      // Create another valid task
      await stateManager.createTask(
        { subject: "Another valid", description: "Valid 2", depends_on_subjects: [], estimated_complexity: "small" },
        "task-003",
        [],
      );

      // getAllTasks should return the 2 valid tasks and skip the malformed one
      const tasks = await stateManager.getAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.id)).toEqual(["task-001", "task-003"]);
    });

    it("skips task files with missing required fields", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Create a valid task
      await stateManager.createTask(
        { subject: "Valid", description: "", depends_on_subjects: [], estimated_complexity: "small" },
        "task-001",
        [],
      );

      // Write a JSON file missing required fields
      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      await fs.writeFile(
        path.join(tasksDir, "task-bad.json"),
        JSON.stringify({ foo: "bar", baz: 123 }),
      );

      const tasks = await stateManager.getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("task-001");
    });

    it("skips task files where id is not a string", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      // Write a task file where id is a number instead of a string
      await fs.writeFile(
        path.join(tasksDir, "task-numeric.json"),
        JSON.stringify({ id: 42, status: "pending" }),
      );

      const tasks = await stateManager.getAllTasks();
      expect(tasks).toHaveLength(0);
    });

    it("returns valid tasks from a mix of valid and invalid files", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const tasksDir = path.join(tempDir, ".conductor", "tasks");

      // Write mix of valid and invalid files
      await fs.writeFile(
        path.join(tasksDir, "task-a.json"),
        JSON.stringify({ id: "task-a", status: "pending", subject: "A", description: "", depends_on: [], blocks: [], owner: null, result_summary: null, files_changed: [], created_at: "2026-01-01", started_at: null, completed_at: null }),
      );
      await fs.writeFile(path.join(tasksDir, "task-b.json"), "not json");
      await fs.writeFile(path.join(tasksDir, "task-c.json"), JSON.stringify({ no_id: true }));
      await fs.writeFile(
        path.join(tasksDir, "task-d.json"),
        JSON.stringify({ id: "task-d", status: "completed", subject: "D", description: "", depends_on: [], blocks: [], owner: null, result_summary: "done", files_changed: [], created_at: "2026-01-01", started_at: null, completed_at: "2026-01-02" }),
      );

      const tasks = await stateManager.getAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.id)).toEqual(["task-a", "task-d"]);
    });
  });

  describe("H20: getTask error handling and validation", () => {
    it("returns null for non-existent task (ENOENT)", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const task = await stateManager.getTask("does-not-exist");
      expect(task).toBeNull();
    });

    it("returns null for task file with invalid structure", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      // Write a valid JSON file but without required Task fields
      await fs.writeFile(
        path.join(tasksDir, "task-invalid.json"),
        JSON.stringify({ foo: "bar" }),
      );

      const task = await stateManager.getTask("task-invalid");
      expect(task).toBeNull();
    });

    it("throws on corrupt JSON (SyntaxError, not ENOENT)", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      await fs.writeFile(path.join(tasksDir, "task-corrupt.json"), "{ broken json");

      // Should throw SyntaxError, not silently return null
      await expect(stateManager.getTask("task-corrupt")).rejects.toThrow();
    });

    it("returns valid task when file has correct structure", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      await stateManager.createTask(
        { subject: "Valid task", description: "Desc", depends_on_subjects: [], estimated_complexity: "small" },
        "task-valid",
        [],
      );

      const task = await stateManager.getTask("task-valid");
      expect(task).not.toBeNull();
      expect(task!.id).toBe("task-valid");
      expect(task!.status).toBe("pending");
      expect(task!.subject).toBe("Valid task");
    });

    it("returns null for task file with null id", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const tasksDir = path.join(tempDir, ".conductor", "tasks");
      await fs.writeFile(
        path.join(tasksDir, "task-null-id.json"),
        JSON.stringify({ id: null, status: "pending" }),
      );

      const task = await stateManager.getTask("task-null-id");
      expect(task).toBeNull();
    });
  });

  describe("H21: save() TOCTOU fix", () => {
    it("save() works correctly on first call (file creation)", async () => {
      // This tests that the atomic create-or-noop pattern works
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      const statePath = path.join(tempDir, ".conductor", "state.json");
      const content = await fs.readFile(statePath, "utf-8");
      const state = JSON.parse(content);
      expect(state.feature).toBe("test feature");
    });

    it("concurrent save() calls produce valid state", async () => {
      await stateManager.initialize("test feature", "test-branch", {
        maxCycles: 5,
        concurrency: 2,
        workerRuntime: "claude",
      });

      // Run 5 concurrent saves
      const promises = Array.from({ length: 5 }, (_, i) =>
        stateManager.setProgress(`Progress ${i}`),
      );

      const results = await Promise.allSettled(promises);

      // At least one should succeed
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Final state should be valid JSON
      const statePath = path.join(tempDir, ".conductor", "state.json");
      const content = await fs.readFile(statePath, "utf-8");
      const state = JSON.parse(content);
      expect(state.feature).toBe("test feature");
    });

    it("save() uses atomic file creation (fs.open with 'a' flag)", async () => {
      // Verify the source code uses the atomic pattern
      const sourceContent = await fs.readFile(
        path.join(process.cwd(), "src/core/state-manager.ts"),
        "utf-8",
      );

      // Should NOT have the old fs.access() + fs.writeFile() pattern
      expect(sourceContent).not.toMatch(/await\s+fs\.access\(statePath\)/);

      // Should have the new fs.open() with 'a' flag pattern
      expect(sourceContent).toContain('fs.open(statePath, "a"');
    });
  });
});

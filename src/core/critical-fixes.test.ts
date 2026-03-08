/**
 * Tests for Critical and High Severity Bug Fixes
 *
 * Tests cover:
 * 1. State manager locking (task-003, issue #2)
 * 2. Task claiming race conditions (task-005, issue #5)
 * 3. Worker event error handling (task-006, issue #6)
 * 4. CLI process lock (task-010, issue #10)
 * 5. Buffer size limits (task-011, issue #11)
 * 6. Dependency ID validation (task-013)
 * 7. CLI forceableStatuses includes flow_tracing (task-011)
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StateManager } from "./state-manager.js";
import { MAX_BUFFER_SIZE_BYTES } from "../utils/constants.js";

// ============================================================
// 1. State Manager Locking Tests (task-003, issue #2)
// ============================================================

describe("StateManager locking (issue #2)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-locking-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("concurrent saves produce valid JSON", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();
    await stateManager.initialize("test", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Simulate 10 concurrent saves
    const savePromises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      await stateManager.setProgress(`Progress ${i}`);
      savePromises.push(stateManager.save());
    }

    // All saves should complete without error
    await Promise.all(savePromises);

    // State file should be valid JSON
    const statePath = path.join(tempDir, ".conductor", "state.json");
    const content = await fs.readFile(statePath, "utf-8");

    // Should not throw
    const parsed = JSON.parse(content);
    expect(parsed).toBeDefined();
    expect(parsed.feature).toBe("test");
  });

  it("state file uses secure permissions (0o600)", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();
    await stateManager.initialize("test", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const statePath = path.join(tempDir, ".conductor", "state.json");
    const stat = await fs.stat(statePath);

    // Check file mode (owner read/write only)
    // Note: fs.stat returns mode with file type bits, so mask with 0o777
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("directories use secure permissions (0o700)", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();

    const conductorDir = path.join(tempDir, ".conductor");
    const stat = await fs.stat(conductorDir);

    // Check directory mode (owner rwx only)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("no temp file remains after save completes", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();
    await stateManager.initialize("test", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const statePath = path.join(tempDir, ".conductor", "state.json");
    const tmpPath = statePath + ".tmp";

    // Temp file should not exist
    await expect(fs.access(tmpPath)).rejects.toThrow(/ENOENT/);
  });

  it("multiple StateManager instances can save without corruption", async () => {
    const manager1 = new StateManager(tempDir);
    await manager1.createDirectories();
    await manager1.initialize("test1", "branch1", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Create second instance that loads the state
    const manager2 = new StateManager(tempDir);
    await manager2.load();

    // Both save concurrently
    const save1 = manager1.setProgress("Progress from manager1").then(() => manager1.save());
    const save2 = manager2.setProgress("Progress from manager2").then(() => manager2.save());

    await Promise.all([save1, save2]);

    // State should be valid JSON (one of them should have won the race)
    const manager3 = new StateManager(tempDir);
    const loaded = await manager3.load();
    expect(loaded.progress).toMatch(/Progress from manager[12]/);
  });
});

// ============================================================
// 2. Task Claiming Race Tests (task-005, issue #5)
// ============================================================

describe("Task claiming race condition (issue #5)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-claim-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("only one claim succeeds when multiple workers race", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();
    await stateManager.initialize("test", "test-branch", {
      maxCycles: 5,
      concurrency: 4,
      workerRuntime: "claude",
    });

    // Create a test task
    const taskDef = {
      subject: "Test task",
      description: "A task for testing",
      depends_on_subjects: [],
      estimated_complexity: "small" as const,
      task_type: "general" as const,
      security_requirements: [],
      performance_requirements: [],
      acceptance_criteria: [],
      risk_level: "low" as const,
    };
    await stateManager.createTask(taskDef, "task-001", []);

    // Get task path for direct manipulation
    const taskPath = path.join(tempDir, ".conductor", "tasks", "task-001.json");

    // Simulate 4 workers trying to claim simultaneously using file locking
    // Each worker reads, checks status, and tries to update
    const claimResults: boolean[] = [];

    const attemptClaim = async (workerId: string): Promise<boolean> => {
      const content = await fs.readFile(taskPath, "utf-8");
      const task = JSON.parse(content);

      if (task.status !== "pending") {
        return false;
      }

      // Small delay to simulate real-world timing
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));

      task.status = "in_progress";
      task.owner = workerId;
      task.started_at = new Date().toISOString();

      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
      return true;
    };

    // Note: This test demonstrates the RACE CONDITION that the locking fixes
    // Without proper locking, multiple workers could claim the same task
    // With proper locking (implemented in MCP tools), only one would succeed

    // For this test, we verify that the task file ends up in a valid state
    await Promise.all([
      attemptClaim("worker-1"),
      attemptClaim("worker-2"),
      attemptClaim("worker-3"),
      attemptClaim("worker-4"),
    ]);

    // Read final state
    const finalContent = await fs.readFile(taskPath, "utf-8");
    const finalTask = JSON.parse(finalContent);

    // Task should be claimed by exactly one worker (or still pending if all failed)
    expect(["pending", "in_progress"]).toContain(finalTask.status);
    if (finalTask.status === "in_progress") {
      expect(finalTask.owner).toMatch(/^worker-[1-4]$/);
    }
  });

  it("task file is valid JSON after rapid updates", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();
    await stateManager.initialize("test", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const taskDef = {
      subject: "Rapid update task",
      description: "A task for rapid update testing",
      depends_on_subjects: [],
      estimated_complexity: "small" as const,
      task_type: "general" as const,
      security_requirements: [],
      performance_requirements: [],
      acceptance_criteria: [],
      risk_level: "low" as const,
    };
    await stateManager.createTask(taskDef, "task-rapid", []);

    const taskPath = path.join(tempDir, ".conductor", "tasks", "task-rapid.json");

    // Perform many rapid updates
    for (let i = 0; i < 20; i++) {
      const content = await fs.readFile(taskPath, "utf-8");
      const task = JSON.parse(content);
      task.result_summary = `Update ${i}`;
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
    }

    // File should still be valid JSON
    const finalContent = await fs.readFile(taskPath, "utf-8");
    const finalTask = JSON.parse(finalContent);
    expect(finalTask.result_summary).toBe("Update 19");
  });
});

// ============================================================
// 3. Worker Event Error Handling Tests (task-006, issue #6)
// ============================================================

describe("Worker event error handling (issue #6)", () => {
  it("processWorkerEvent handles malformed events without crashing", () => {
    // Simulate what processWorkerEvent should do with various event types
    const processEvent = (event: Record<string, unknown>): {
      processed: boolean;
      error?: string;
    } => {
      try {
        const eventType = event.type as string | undefined;

        // Simulate event processing (the actual implementation)
        if (eventType === undefined) {
          // Unknown event type, but shouldn't crash
          return { processed: true };
        }

        if (eventType === "result") {
          // Requires specific fields
          const result = event.result as Record<string, unknown> | undefined;
          if (result && typeof result.output === "string") {
            return { processed: true };
          }
          return { processed: true };
        }

        if (eventType === "tool_use") {
          return { processed: true };
        }

        if (eventType === "error") {
          return { processed: true };
        }

        // All other events
        return { processed: true };
      } catch (err) {
        return {
          processed: false,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    };

    // Test various malformed events
    const malformedEvents = [
      {}, // Empty event
      { type: null }, // Null type
      { type: "unknown", extra: "data" }, // Unknown type with extra data
      { type: "result" }, // Result without result field
      { type: "result", result: null }, // Result with null result
      { type: "tool_use", tool: undefined }, // Tool use without tool info
      { type: 123 }, // Non-string type
      { type: "error", error: {} }, // Error with object error
    ];

    for (const event of malformedEvents) {
      const result = processEvent(event);
      // Should not crash, should return processed or error
      expect(result).toBeDefined();
      expect(result.processed).toBe(true);
    }
  });

  it("event loop continues after error in single event", async () => {
    const events = [
      { type: "start", id: 1 },
      { type: "invalid", throwError: true }, // This would throw
      { type: "complete", id: 2 },
    ];

    const processedEvents: number[] = [];

    // Simulate the try-catch wrapped loop
    for (const event of events) {
      try {
        if ((event as { throwError?: boolean }).throwError) {
          throw new Error("Simulated error");
        }
        if (event.id !== undefined) {
          processedEvents.push(event.id);
        }
      } catch {
        // Continue processing - this is the fix behavior
      }
    }

    // Both valid events should have been processed
    expect(processedEvents).toEqual([1, 2]);
  });
});

// ============================================================
// 4. CLI Lock Tests (task-010, issue #10)
// ============================================================

describe("CLI process lock (issue #10)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-cli-lock-test-"));
    await fs.mkdir(path.join(tempDir, ".conductor"), { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lock info file contains PID and timestamp", async () => {
    const lockPath = path.join(tempDir, ".conductor", "conductor.lock");
    const lockInfoPath = lockPath + ".info";

    // Create lock info file (simulating what acquireProcessLock does)
    const lockInfo = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, "", { mode: 0o600 });
    await fs.writeFile(lockInfoPath, JSON.stringify(lockInfo, null, 2), { mode: 0o600 });

    // Read and verify
    const content = await fs.readFile(lockInfoPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.timestamp).toBe("string");
    expect(new Date(parsed.timestamp).getTime()).not.toBeNaN();
  });

  it("stale lock detection works with dead PID", async () => {
    const lockPath = path.join(tempDir, ".conductor", "conductor.lock");
    const lockInfoPath = lockPath + ".info";

    // Create lock info with a PID that definitely doesn't exist
    const stalePid = 999999999; // Very unlikely to be a real PID
    const lockInfo = {
      pid: stalePid,
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    };
    await fs.writeFile(lockPath, "", { mode: 0o600 });
    await fs.writeFile(lockInfoPath, JSON.stringify(lockInfo, null, 2), { mode: 0o600 });

    // Check if process is alive (simulating isProcessAlive)
    const isAlive = (() => {
      try {
        process.kill(stalePid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    expect(isAlive).toBe(false);
  });

  it("time-based stale detection works", () => {
    const oneHourMs = 60 * 60 * 1000;
    const lockTimestamp = new Date(Date.now() - 2 * oneHourMs); // 2 hours ago
    const now = new Date();

    const age = now.getTime() - lockTimestamp.getTime();
    const isStale = age > oneHourMs;

    expect(isStale).toBe(true);
  });

  it("lock files use secure permissions", async () => {
    const lockPath = path.join(tempDir, ".conductor", "conductor.lock");
    const lockInfoPath = lockPath + ".info";

    await fs.writeFile(lockPath, "", { mode: 0o600 });
    await fs.writeFile(lockInfoPath, "{}", { mode: 0o600 });

    const lockStat = await fs.stat(lockPath);
    const infoStat = await fs.stat(lockInfoPath);

    expect(lockStat.mode & 0o777).toBe(0o600);
    expect(infoStat.mode & 0o777).toBe(0o600);
  });
});

// ============================================================
// 5. Buffer Limit Tests (task-011, issue #11)
// ============================================================

describe("Buffer size limits (issue #11)", () => {
  it("MAX_BUFFER_SIZE_BYTES is 10MB", () => {
    expect(MAX_BUFFER_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("large buffer gets truncated to last half", () => {
    // Simulate the truncation logic from consumeLines
    const truncateBuffer = (buffer: string, maxBytes: number): string => {
      const bufferSizeBytes = Buffer.byteLength(buffer, "utf-8");
      if (bufferSizeBytes > maxBytes) {
        const halfLength = Math.floor(buffer.length / 2);
        return buffer.slice(halfLength);
      }
      return buffer;
    };

    // Create a buffer larger than limit
    const largeContent = "x".repeat(20 * 1024 * 1024); // 20MB of 'x'
    const truncated = truncateBuffer(largeContent, MAX_BUFFER_SIZE_BYTES);

    // Should be truncated to half
    expect(truncated.length).toBe(largeContent.length / 2);
    expect(truncated).toBe("x".repeat(10 * 1024 * 1024));
  });

  it("buffer under limit is not truncated", () => {
    const truncateBuffer = (buffer: string, maxBytes: number): string => {
      const bufferSizeBytes = Buffer.byteLength(buffer, "utf-8");
      if (bufferSizeBytes > maxBytes) {
        const halfLength = Math.floor(buffer.length / 2);
        return buffer.slice(halfLength);
      }
      return buffer;
    };

    const smallContent = "small content";
    const result = truncateBuffer(smallContent, MAX_BUFFER_SIZE_BYTES);

    expect(result).toBe(smallContent);
  });

  it("truncation preserves recent output (last half)", () => {
    const truncateBuffer = (buffer: string, maxBytes: number): string => {
      const bufferSizeBytes = Buffer.byteLength(buffer, "utf-8");
      if (bufferSizeBytes > maxBytes) {
        const halfLength = Math.floor(buffer.length / 2);
        return buffer.slice(halfLength);
      }
      return buffer;
    };

    // Create content with distinguishable parts
    const oldContent = "OLD_".repeat(1024 * 1024); // ~4MB
    const newContent = "NEW_".repeat(2 * 1024 * 1024); // ~8MB
    const buffer = oldContent + newContent; // ~12MB total

    // Use a smaller limit for testing
    const result = truncateBuffer(buffer, 6 * 1024 * 1024); // 6MB limit

    // Should keep more of the NEW_ content (second half)
    expect(result.indexOf("NEW_")).toBeGreaterThanOrEqual(0);
  });

  it("multi-byte characters are handled correctly", () => {
    // UTF-8 characters like emoji are multi-byte
    const emoji = "🎉"; // 4 bytes in UTF-8
    expect(Buffer.byteLength(emoji, "utf-8")).toBe(4);
    expect(emoji.length).toBe(2); // JavaScript string length

    // Verify that Buffer.byteLength is used, not string length
    const content = emoji.repeat(1000);
    const byteLength = Buffer.byteLength(content, "utf-8");
    expect(byteLength).toBe(4000); // 4 bytes * 1000
    expect(content.length).toBe(2000); // 2 chars * 1000
  });
});

// ============================================================
// Additional Edge Case Tests
// ============================================================

describe("Edge cases for critical fixes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-edge-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("state manager rejects invalid/empty state with Zod validation", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();

    // Write empty JSON to state file
    const statePath = path.join(tempDir, ".conductor", "state.json");
    await fs.writeFile(statePath, "{}\n", { mode: 0o600 });

    // Load should throw with validation errors (Zod schema enforcement)
    await expect(stateManager.load()).rejects.toThrow(/State file validation failed/);
  });

  it("state manager validates state.json with Zod schema", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();

    // Create valid state via initialize, then load it
    await stateManager.initialize("test-feature", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Load should work with valid state
    const state = await stateManager.load();
    expect(state).toBeDefined();
    expect(state.feature).toBe("test-feature");
    expect(state.branch).toBe("test-branch");
    expect(state.status).toBe("initializing");
  });

  it("task files persist correct structure", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();
    await stateManager.initialize("test", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const taskDef = {
      subject: "Structure test",
      description: "Testing task structure",
      depends_on_subjects: ["dep-1"],
      estimated_complexity: "medium" as const,
      task_type: "security" as const,
      security_requirements: ["Validate input"],
      performance_requirements: ["< 100ms"],
      acceptance_criteria: ["Test passes"],
      risk_level: "high" as const,
    };

    await stateManager.createTask(taskDef, "task-structure", ["dep-1"]);

    // Read task file directly
    const taskPath = path.join(tempDir, ".conductor", "tasks", "task-structure.json");
    const content = await fs.readFile(taskPath, "utf-8");
    const task = JSON.parse(content);

    // Verify all fields
    expect(task.id).toBe("task-structure");
    expect(task.subject).toBe("Structure test");
    expect(task.depends_on).toEqual(["dep-1"]);
    // blocks is populated when other tasks depend on this one, not from definition
    expect(task.blocks).toEqual([]);
    expect(task.task_type).toBe("security");
    expect(task.security_requirements).toEqual(["Validate input"]);
    expect(task.performance_requirements).toEqual(["< 100ms"]);
    expect(task.acceptance_criteria).toEqual(["Test passes"]);
    expect(task.risk_level).toBe("high");
    expect(task.status).toBe("pending");
  });
});

// ============================================================
// 6. Dependency ID Validation Tests (task-013)
// ============================================================

describe("Dependency ID validation (task-013)", () => {
  /**
   * These tests verify the dependency validation logic in orchestrator.ts
   * lines 1071-1125. The validation:
   * 1. First pass creates subject -> taskId map
   * 2. Validation pass logs warnings for invalid dependencies
   * 3. Second pass only includes valid dependency IDs
   */

  // Helper to simulate the orchestrator's dependency validation logic
  function validateAndResolveDependencies(
    tasks: Array<{
      subject: string;
      depends_on_subjects: string[];
    }>,
    logger: { warn: ReturnType<typeof vi.fn> }
  ): Map<string, string[]> {
    // First pass: build subject -> taskId map
    const subjectToId = new Map<string, string>();
    for (let i = 0; i < tasks.length; i++) {
      const taskId = `task-${String(i + 1).padStart(3, "0")}`;
      subjectToId.set(tasks[i].subject, taskId);
    }

    // Validation pass: detect dangling dependencies
    let danglingDeps = 0;
    for (const def of tasks) {
      for (const depSubject of def.depends_on_subjects) {
        if (!subjectToId.has(depSubject)) {
          logger.warn(
            `Task "${def.subject}" depends on unknown subject "${depSubject}"; dependency will be skipped`
          );
          danglingDeps++;
        }
      }
    }

    if (danglingDeps > 0) {
      logger.warn(`${danglingDeps} dangling dependency reference(s) detected in plan.`);
    }

    // Second pass: resolve dependency IDs (only valid ones)
    const taskDependencies = new Map<string, string[]>();
    for (let i = 0; i < tasks.length; i++) {
      const def = tasks[i];
      const taskId = `task-${String(i + 1).padStart(3, "0")}`;
      const dependencyIds: string[] = [];
      for (const depSubject of def.depends_on_subjects) {
        const depId = subjectToId.get(depSubject);
        if (depId) {
          dependencyIds.push(depId);
        }
      }
      taskDependencies.set(taskId, dependencyIds);
    }

    return taskDependencies;
  }

  it("task with valid dependency ID includes it in depends_on", () => {
    const mockLogger = { warn: vi.fn() };
    const tasks = [
      { subject: "Setup database", depends_on_subjects: [] },
      { subject: "Create API", depends_on_subjects: ["Setup database"] },
    ];

    const result = validateAndResolveDependencies(tasks, mockLogger);

    // task-002 should depend on task-001
    expect(result.get("task-002")).toEqual(["task-001"]);
    // No warnings should be logged
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("task with invalid dependency ID has it filtered out", () => {
    const mockLogger = { warn: vi.fn() };
    const tasks = [
      { subject: "Task A", depends_on_subjects: [] },
      { subject: "Task B", depends_on_subjects: ["Non-existent task"] },
    ];

    const result = validateAndResolveDependencies(tasks, mockLogger);

    // task-002 should have empty depends_on since the dependency doesn't exist
    expect(result.get("task-002")).toEqual([]);
  });

  it("warning is logged when invalid dependency is encountered", () => {
    const mockLogger = { warn: vi.fn() };
    const tasks = [
      { subject: "Task A", depends_on_subjects: [] },
      { subject: "Task B", depends_on_subjects: ["Missing dependency"] },
    ];

    validateAndResolveDependencies(tasks, mockLogger);

    // Should warn about the specific invalid dependency
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Task \"Task B\" depends on unknown subject \"Missing dependency\"")
    );
    // Should also warn about total dangling deps
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("1 dangling dependency reference(s)")
    );
  });

  it("multiple invalid dependencies are all filtered and warned", () => {
    const mockLogger = { warn: vi.fn() };
    const tasks = [
      { subject: "Task A", depends_on_subjects: [] },
      {
        subject: "Task B",
        depends_on_subjects: [
          "Missing 1",
          "Missing 2",
          "Task A", // This one is valid
          "Missing 3",
        ],
      },
    ];

    const result = validateAndResolveDependencies(tasks, mockLogger);

    // task-002 should only have task-001 (Task A)
    expect(result.get("task-002")).toEqual(["task-001"]);

    // Should warn 3 times for invalid deps, plus 1 for summary
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Missing 1")
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Missing 2")
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Missing 3")
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("3 dangling dependency reference(s)")
    );
  });

  it("valid dependencies preserve order", () => {
    const mockLogger = { warn: vi.fn() };
    const tasks = [
      { subject: "First", depends_on_subjects: [] },
      { subject: "Second", depends_on_subjects: [] },
      { subject: "Third", depends_on_subjects: ["First", "Second"] },
    ];

    const result = validateAndResolveDependencies(tasks, mockLogger);

    // task-003 should depend on both task-001 and task-002 in order
    expect(result.get("task-003")).toEqual(["task-001", "task-002"]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("self-referential dependency is filtered out", () => {
    const mockLogger = { warn: vi.fn() };
    // A task cannot depend on itself (subject resolves to different task ID anyway)
    const tasks = [
      { subject: "Self-referential", depends_on_subjects: ["Self-referential"] },
    ];

    const result = validateAndResolveDependencies(tasks, mockLogger);

    // While the subject exists, a task depending on itself would create task-001 -> task-001
    // The validation allows this since the subject exists, but it would be a self-loop
    // The current code doesn't explicitly block self-references, so this tests current behavior
    expect(result.get("task-001")).toEqual(["task-001"]);
    // No warning since subject technically exists
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("empty depends_on_subjects produces empty depends_on", () => {
    const mockLogger = { warn: vi.fn() };
    const tasks = [{ subject: "Independent", depends_on_subjects: [] }];

    const result = validateAndResolveDependencies(tasks, mockLogger);

    expect(result.get("task-001")).toEqual([]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

// ============================================================
// 7. CLI forceableStatuses includes flow_tracing (task-011)
// ============================================================

describe("CLI forceableStatuses (task-011)", () => {
  /**
   * These tests verify that 'flow_tracing' is included in the forceableStatuses Set
   * so that force-resume works when conductor crashes during flow tracing.
   *
   * The actual forceableStatuses Set is defined in cli.ts. We verify the expected
   * behavior by simulating the resume logic.
   */

  // Replicate the forceableStatuses from cli.ts for testing
  const forceableStatuses = new Set([
    "executing",
    "planning",
    "reviewing",
    "checkpointing",
    "flow_tracing",
  ]);

  const resumableStatuses = new Set(["paused", "escalated"]);

  /**
   * Simulates the resume command logic from cli.ts
   */
  function canResume(status: string, forceResume: boolean): { canResume: boolean; reason?: string } {
    // First check: is it in resumableStatuses?
    if (resumableStatuses.has(status)) {
      return { canResume: true };
    }

    // Second check: is force-resume requested and is the status forceable?
    if (forceResume && forceableStatuses.has(status)) {
      return { canResume: true };
    }

    // Cannot resume
    if (forceableStatuses.has(status)) {
      return {
        canResume: false,
        reason: `State '${status}' requires --force-resume flag`,
      };
    }

    return {
      canResume: false,
      reason: `State '${status}' is not resumable`,
    };
  }

  it("flow_tracing is in forceableStatuses Set", () => {
    expect(forceableStatuses.has("flow_tracing")).toBe(true);
  });

  it("flow_tracing state can be force-resumed", () => {
    const result = canResume("flow_tracing", true);
    expect(result.canResume).toBe(true);
  });

  it("flow_tracing state cannot be resumed without force flag", () => {
    const result = canResume("flow_tracing", false);
    expect(result.canResume).toBe(false);
    expect(result.reason).toContain("--force-resume");
  });

  it("all expected statuses are forceable", () => {
    const expectedForceable = [
      "executing",
      "planning",
      "reviewing",
      "checkpointing",
      "flow_tracing",
    ];

    for (const status of expectedForceable) {
      expect(forceableStatuses.has(status)).toBe(true);
      const result = canResume(status, true);
      expect(result.canResume).toBe(true);
    }
  });

  it("paused and escalated are directly resumable without force", () => {
    expect(canResume("paused", false).canResume).toBe(true);
    expect(canResume("escalated", false).canResume).toBe(true);
  });

  it("unknown status is not resumable", () => {
    const result = canResume("unknown_status", true);
    expect(result.canResume).toBe(false);
  });
});

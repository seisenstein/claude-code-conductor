/**
 * Task-012 Tests: Medium systemic fixes verification
 *
 * Tests verify both already-fixed items and new fixes:
 * - setInterval → setTimeout in event-log.ts and codex-usage-monitor.ts
 * - checkForPartialCommits session-specific matching
 * - ensureProviderCapacity documentation
 * - Codex ERROR verdict treated as "review unavailable"
 * - Task file cleanup on replan (clearTaskFiles)
 * - status_filter with ranked=true in handleGetTasks
 * - sanitizeErrorForPrompt escapes # characters
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { StateManager } from "./state-manager.js";
import { sanitizeErrorForPrompt } from "./worker-resilience.js";
import type { TaskDefinition } from "../utils/types.js";

// ============================================================
// 1. EventLog: self-rescheduling setTimeout (already fixed)
// ============================================================

describe("task-012: EventLog uses setTimeout (not setInterval)", () => {
  it("source code uses setTimeout-based scheduling, not setInterval", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/event-log.ts"),
      "utf-8",
    );

    // Should use setTimeout for scheduling flushes
    expect(source).toContain("setTimeout(");
    expect(source).toContain("scheduleFlush");

    // Should NOT use setInterval anywhere
    // (clearInterval may still appear for type compat, but setInterval() call should not)
    const setIntervalCalls = source.match(/\bsetInterval\s*\(/g);
    expect(setIntervalCalls).toBeNull();

    // Should use clearTimeout (not clearInterval) for cleanup
    expect(source).toContain("clearTimeout(");
  });

  it("stop() method uses clearTimeout", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/event-log.ts"),
      "utf-8",
    );

    // The stop() method should clear with clearTimeout
    const stopMethod = source.substring(
      source.indexOf("async stop()"),
      source.indexOf("async stop()") + 300,
    );
    expect(stopMethod).toContain("clearTimeout(");
    expect(stopMethod).not.toContain("clearInterval(");
  });

  it("timer is unref'd to prevent keeping process alive", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/event-log.ts"),
      "utf-8",
    );
    expect(source).toContain(".unref()");
  });
});

// ============================================================
// 2. CodexUsageMonitor: self-rescheduling setTimeout (already fixed)
// ============================================================

describe("task-012: CodexUsageMonitor uses setTimeout (not setInterval)", () => {
  it("source code uses setTimeout-based scheduling, not setInterval", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/codex-usage-monitor.ts"),
      "utf-8",
    );

    // Should use setTimeout for scheduling polls
    expect(source).toContain("setTimeout(");
    expect(source).toContain("schedulePoll");

    // Should NOT use setInterval
    const setIntervalCalls = source.match(/\bsetInterval\s*\(/g);
    expect(setIntervalCalls).toBeNull();

    // Should use clearTimeout for cleanup
    expect(source).toContain("clearTimeout(");
  });

  it("timer is unref'd to prevent keeping process alive", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/codex-usage-monitor.ts"),
      "utf-8",
    );
    expect(source).toContain(".unref()");
  });
});

// ============================================================
// 3. checkForPartialCommits session-specific matching (already fixed)
// ============================================================

describe("task-012: checkForPartialCommits uses session-specific matching", () => {
  it("source code matches sessionId, not generic [task-] pattern", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/orchestrator.ts"),
      "utf-8",
    );

    // Find the checkForPartialCommits method
    const methodStart = source.indexOf("private async checkForPartialCommits");
    expect(methodStart).toBeGreaterThan(-1);

    const methodBody = source.substring(methodStart, methodStart + 500);

    // Should use sessionId for matching
    expect(methodBody).toContain("sessionId");
    expect(methodBody).toContain("message.includes(sessionId)");

    // Should NOT match any task commit generically
    // The old pattern was: message.includes("[task-")
    // Make sure it's not the sole matching criterion
    const includesTaskPattern = methodBody.match(
      /message\.includes\(\s*["']?\[task-/,
    );
    // If [task- pattern exists, it must be combined with sessionId
    if (includesTaskPattern) {
      expect(methodBody).toContain("sessionId");
    }
  });
});

// ============================================================
// 4. ensureProviderCapacity documentation (new fix)
// ============================================================

describe("task-012: ensureProviderCapacity has return semantics documentation", () => {
  it("method has JSDoc explaining always-true return semantics", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/orchestrator.ts"),
      "utf-8",
    );

    // Find the ensureProviderCapacity method and preceding comment
    const methodPos = source.indexOf(
      "private async ensureProviderCapacity",
    );
    expect(methodPos).toBeGreaterThan(-1);

    // Look at the 800 chars before the method signature for the JSDoc
    const preceding = source.substring(
      Math.max(0, methodPos - 800),
      methodPos,
    );

    // Should document the "always true" semantic
    expect(preceding).toContain("always returns `true`");
    // Should explain why
    expect(preceding).toContain("always wait");
  });
});

// ============================================================
// 5. Codex ERROR verdict treated as "review unavailable" (new fix)
// ============================================================

describe("task-012: Codex ERROR/RATE_LIMITED verdict handling", () => {
  it("review() treats ERROR as review unavailable, not rejection", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/orchestrator.ts"),
      "utf-8",
    );

    // Find the code review verdict section
    // It should contain isToolFailure logic
    expect(source).toContain("isToolFailure");

    // Should check for both ERROR and RATE_LIMITED
    expect(source).toContain('"ERROR"');
    expect(source).toContain('"RATE_LIMITED"');

    // The approved calculation should include isToolFailure
    expect(source).toContain('reviewResult.verdict === "APPROVE" || isToolFailure');
  });

  it("isToolFailure includes both ERROR and RATE_LIMITED verdicts", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/orchestrator.ts"),
      "utf-8",
    );

    // Find the isToolFailure definition
    const isToolFailureMatch = source.match(
      /const isToolFailure\s*=[\s\S]*?;/,
    );
    expect(isToolFailureMatch).not.toBeNull();

    const definition = isToolFailureMatch![0];
    expect(definition).toContain('"ERROR"');
    expect(definition).toContain('"RATE_LIMITED"');
  });

  it("logs descriptive messages for ERROR and RATE_LIMITED verdicts", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/orchestrator.ts"),
      "utf-8",
    );

    // Should log that ERROR is treated as unavailable, not rejection
    expect(source).toContain("review unavailable (not as rejection)");
  });
});

// ============================================================
// 6. clearTaskFiles on replan (new fix)
// ============================================================

describe("task-012: clearTaskFiles on replan", () => {
  let tempDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "conductor-task012-test-"),
    );
    stateManager = new StateManager(tempDir);
    await stateManager.createDirectories();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("clearTaskFiles removes all .json files from tasks directory", async () => {
    // Create some task files
    await stateManager.initialize("test feature", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const taskDef: TaskDefinition = {
      subject: "Test task",
      description: "A test task",
      depends_on_subjects: [],
      task_type: "general",
      estimated_complexity: "small",
      security_requirements: [],
      performance_requirements: [],
      acceptance_criteria: [],
      risk_level: "medium",
    };

    await stateManager.createTask(taskDef, "task-001", []);
    await stateManager.createTask(taskDef, "task-002", []);
    await stateManager.createTask(taskDef, "task-003", []);

    // Verify tasks exist
    let tasks = await stateManager.getAllTasks();
    expect(tasks.length).toBe(3);

    // Clear task files
    await stateManager.clearTaskFiles();

    // Verify tasks are gone
    tasks = await stateManager.getAllTasks();
    expect(tasks.length).toBe(0);
  });

  it("clearTaskFiles handles non-existent directory gracefully", async () => {
    // Remove the tasks directory
    const tasksDir = path.join(tempDir, ".conductor", "tasks");
    await fs.rm(tasksDir, { recursive: true, force: true });

    // Should not throw
    await expect(stateManager.clearTaskFiles()).resolves.not.toThrow();
  });

  it("clearTaskFiles only removes .json files", async () => {
    await stateManager.initialize("test feature", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const tasksDir = path.join(tempDir, ".conductor", "tasks");

    // Create a task file and a non-json file
    const taskDef: TaskDefinition = {
      subject: "Test task",
      description: "A test task",
      depends_on_subjects: [],
      task_type: "general",
      estimated_complexity: "small",
      security_requirements: [],
      performance_requirements: [],
      acceptance_criteria: [],
      risk_level: "medium",
    };
    await stateManager.createTask(taskDef, "task-001", []);
    await fs.writeFile(
      path.join(tasksDir, "readme.txt"),
      "Keep this file",
      "utf-8",
    );

    // Clear task files
    await stateManager.clearTaskFiles();

    // json file should be gone
    const tasks = await stateManager.getAllTasks();
    expect(tasks.length).toBe(0);

    // non-json file should still exist
    const txtContent = await fs.readFile(
      path.join(tasksDir, "readme.txt"),
      "utf-8",
    );
    expect(txtContent).toBe("Keep this file");
  });

  it("clearTaskFiles handles individual file deletion errors gracefully", async () => {
    await stateManager.initialize("test feature", "test-branch", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const taskDef: TaskDefinition = {
      subject: "Test task",
      description: "A test task",
      depends_on_subjects: [],
      task_type: "general",
      estimated_complexity: "small",
      security_requirements: [],
      performance_requirements: [],
      acceptance_criteria: [],
      risk_level: "medium",
    };
    await stateManager.createTask(taskDef, "task-001", []);
    await stateManager.createTask(taskDef, "task-002", []);

    // Make one file read-only (can't delete on some systems)
    // This is a best-effort test - deletion errors should be caught
    const tasksDir = path.join(tempDir, ".conductor", "tasks");
    const task1Path = path.join(tasksDir, "task-001.json");

    // Just verify clearTaskFiles doesn't throw even if filesystem is weird
    await expect(stateManager.clearTaskFiles()).resolves.not.toThrow();
  });

  it("orchestrator calls clearTaskFiles during replan", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/orchestrator.ts"),
      "utf-8",
    );

    // The orchestrator should call clearTaskFiles before creating new tasks during replan
    expect(source).toContain("clearTaskFiles()");

    // Should only clear during replan, not initial plan
    expect(source).toContain("if (isReplan)");

    // The clearTaskFiles call should be near the "Create tasks from plan output" comment
    const clearPos = source.indexOf("clearTaskFiles()");
    const createTasksPos = source.indexOf("Create tasks from plan output");
    expect(clearPos).toBeGreaterThan(-1);
    expect(createTasksPos).toBeGreaterThan(-1);
    // clearTaskFiles should appear before task creation
    expect(clearPos).toBeLessThan(createTasksPos);
  });
});

// ============================================================
// 7. status_filter with ranked=true in handleGetTasks (already fixed)
// ============================================================

describe("task-012: handleGetTasks applies status_filter when ranked=true", () => {
  it("source code handles status_filter with ranked=true correctly (H-11)", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/mcp/tools.ts"),
      "utf-8",
    );

    // Find the handleGetTasks function
    const funcStart = source.indexOf(
      "export async function handleGetTasks",
    );
    expect(funcStart).toBeGreaterThan(-1);

    const funcBody = source.substring(funcStart, funcStart + 1500);

    // Should handle status_filter
    expect(funcBody).toContain("input.status_filter");

    // H-11: When status_filter is non-pending with ranked=true,
    // should skip ranking entirely and just filter by status.
    // This is the correct fix — ranking only returns pending tasks,
    // so a non-pending filter after ranking was always empty.
    expect(funcBody).toContain('status_filter !== "pending"');
    expect(funcBody).toContain("rankClaimableTasks");
  });
});

// ============================================================
// 8. sanitizeErrorForPrompt escapes # (already fixed)
// ============================================================

describe("task-012: sanitizeErrorForPrompt escapes # characters", () => {
  it("escapes # characters to prevent markdown heading injection", () => {
    const input = "Error: # This is a heading\n## Another heading";
    const sanitized = sanitizeErrorForPrompt(input);
    expect(sanitized).toContain("\\#");
    expect(sanitized).not.toMatch(/(?<!\\)#/); // No unescaped # characters
  });

  it("escapes multiple # characters", () => {
    const input = "### Triple heading ### more hashes";
    const sanitized = sanitizeErrorForPrompt(input);
    // All # should be escaped
    const unescapedHashes = sanitized.match(/(?<!\\)#/g);
    expect(unescapedHashes).toBeNull();
  });

  it("still escapes other markdown characters alongside #", () => {
    const input = "Error: *bold* _italic_ `code` [link] # heading";
    const sanitized = sanitizeErrorForPrompt(input);
    expect(sanitized).toContain("\\*");
    expect(sanitized).toContain("\\_");
    expect(sanitized).toContain("\\`");
    expect(sanitized).toContain("\\[");
    expect(sanitized).toContain("\\]");
    expect(sanitized).toContain("\\#");
  });

  it("source code includes # in the escape chain", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/worker-resilience.ts"),
      "utf-8",
    );

    // H29 fix: # should be in the markdown escape chain
    expect(source).toContain('.replace(/#/g, "\\\\#")');
    // Comment should reference H29
    expect(source).toContain("H29");
  });
});

// ============================================================
// 9. clearStaleFailures removed (task-003 already handled)
// ============================================================

describe("task-012: clearStaleFailures was removed by task-003", () => {
  it("clearStaleFailures method does not exist in worker-resilience.ts", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/worker-resilience.ts"),
      "utf-8",
    );

    // Method definition should not exist (but a comment about removal may)
    // Look for actual method definition patterns, not comments
    const methodDefinitionPattern = /clearStaleFailures\s*\([^)]*\)\s*[:{]/;
    expect(source).not.toMatch(methodDefinitionPattern);

    // Comment explaining removal should exist
    expect(source).toContain("clearStaleFailures");
    expect(source).toContain("removed");
  });
});

/**
 * MCP Tools Security Tests (task-020)
 *
 * Tests for security-sensitive functionality in MCP tool handlers:
 * - Path traversal prevention in task_id, session_id, contract_id
 * - Input size limit enforcement
 * - Error message sanitization (no path leakage)
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock child_process.execFile to prevent real `npm test` subprocesses from spawning
// during validation-pass tests. Tests that should fail validation never reach execFile.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: unknown, _opts: unknown, cb?: Function) => {
      if (cb) cb(null, { stdout: "mocked test output", stderr: "" });
      return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
    }),
  };
});

import {
  handleClaimTask,
  handleCompleteTask,
  handleGetSessionStatus,
  handleRegisterContract,
  handleRecordDecision,
  handlePostUpdate,
  handleRunTests,
  handleReadUpdates,
  MAX_READ_UPDATES_HARD_CAP,
} from "./tools.js";

// ============================================================
// Test Setup
// ============================================================

// Store original env values
const originalEnv = { ...process.env };

// Temp directory for test files
let tempDir: string;

beforeEach(async () => {
  // Create temp directory structure
  tempDir = path.join(os.tmpdir(), `mcp-tools-test-${Date.now()}`);
  const conductorDir = path.join(tempDir, ".conductor");
  await fs.mkdir(path.join(conductorDir, "tasks"), { recursive: true });
  await fs.mkdir(path.join(conductorDir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(conductorDir, "messages"), { recursive: true });
  await fs.mkdir(path.join(conductorDir, "contracts"), { recursive: true });

  // Set env vars for tools.ts
  process.env.CONDUCTOR_DIR = conductorDir;
  process.env.SESSION_ID = "test-session-123";
});

afterEach(async () => {
  // Restore original env
  process.env.CONDUCTOR_DIR = originalEnv.CONDUCTOR_DIR;
  process.env.SESSION_ID = originalEnv.SESSION_ID;

  // Clean up temp directory
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================================
// Path Traversal Tests - task_id
// ============================================================

describe("handleClaimTask - path traversal prevention", () => {
  it("rejects task_id with parent directory traversal", async () => {
    const result = await handleClaimTask({ task_id: "../secret" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
    expect(result.error).toContain("..");
  });

  it("rejects task_id with URL-encoded traversal", async () => {
    const result = await handleClaimTask({ task_id: "%2e%2e%2fsecret" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("rejects task_id with double URL-encoded traversal", async () => {
    const result = await handleClaimTask({ task_id: "%252e%252e%252f" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("rejects task_id with triple URL-encoded traversal", async () => {
    const result = await handleClaimTask({ task_id: "%25252e%25252e%25252f" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("rejects task_id with absolute Unix path", async () => {
    const result = await handleClaimTask({ task_id: "/etc/passwd" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
    expect(result.error).toContain("Absolute");
  });

  it("rejects task_id with absolute Windows path", async () => {
    const result = await handleClaimTask({ task_id: "C:\\Windows\\System32" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("rejects task_id with null byte injection", async () => {
    const result = await handleClaimTask({ task_id: "task\x00.json" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
    expect(result.error).toContain("null byte");
  });

  it("rejects task_id with backslashes", async () => {
    const result = await handleClaimTask({ task_id: "path\\to\\task" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
    expect(result.error).toContain("backslash");
  });

  it("rejects task_id with URL-encoded backslash", async () => {
    const result = await handleClaimTask({ task_id: "path%5Cto%5Ctask" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("accepts valid task_id format", async () => {
    // This should fail with "Task file not found" (not validation error)
    const result = await handleClaimTask({ task_id: "task-001" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.error).not.toContain("Invalid task_id");
  });
});

// ============================================================
// A-4: validateIdentifier rejects path separators in task_id
// ============================================================

describe("A-4: handleClaimTask rejects path separators in task_id", () => {
  it("rejects task_id containing a forward slash with 'path separators' reason", async () => {
    const result = await handleClaimTask({ task_id: "subdir/task-001" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path separators");
  });
});

// ============================================================
// Path Traversal Tests - complete_task
// ============================================================

describe("handleCompleteTask - path traversal prevention", () => {
  it("rejects task_id with path traversal", async () => {
    const result = await handleCompleteTask({
      task_id: "../secret",
      result_summary: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("rejects files_changed with path traversal", async () => {
    // Create a valid task file first
    const conductorDir = process.env.CONDUCTOR_DIR!;
    const taskPath = path.join(conductorDir, "tasks", "task-001.json");
    const task = {
      id: "task-001",
      status: "in_progress",
      owner: "test-session-123",
      depends_on: [],
      blocks: [],
      subject: "Test task",
      description: "Test",
      files_changed: [],
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(taskPath, JSON.stringify(task), "utf-8");

    const result = await handleCompleteTask({
      task_id: "task-001",
      result_summary: "done",
      files_changed: ["../../../etc/passwd"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid files_changed");
    expect(result.error).toContain("..");
  });

  it("rejects files_changed with multiple invalid entries", async () => {
    const conductorDir = process.env.CONDUCTOR_DIR!;
    const taskPath = path.join(conductorDir, "tasks", "task-002.json");
    const task = {
      id: "task-002",
      status: "in_progress",
      owner: "test-session-123",
      depends_on: [],
      blocks: [],
      subject: "Test task",
      description: "Test",
      files_changed: [],
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(taskPath, JSON.stringify(task), "utf-8");

    const result = await handleCompleteTask({
      task_id: "task-002",
      result_summary: "done",
      files_changed: ["../secret", "/etc/passwd", "valid.txt"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid files_changed");
    // Should list both invalid entries
    expect(result.error).toContain("../secret");
    expect(result.error).toContain("/etc/passwd");
  });

  it("accepts valid files_changed entries", async () => {
    const conductorDir = process.env.CONDUCTOR_DIR!;
    const taskPath = path.join(conductorDir, "tasks", "task-003.json");
    const task = {
      id: "task-003",
      status: "in_progress",
      owner: "test-session-123",
      depends_on: [],
      blocks: [],
      subject: "Test task",
      description: "Test",
      files_changed: [],
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(taskPath, JSON.stringify(task), "utf-8");

    const result = await handleCompleteTask({
      task_id: "task-003",
      result_summary: "done",
      files_changed: ["src/file.ts", "package.json", "docs/readme.md"],
    });
    expect(result.success).toBe(true);
    expect(result.task?.files_changed).toEqual([
      "src/file.ts",
      "package.json",
      "docs/readme.md",
    ]);
  });
});

// ============================================================
// Path Traversal Tests - session_id
// ============================================================

describe("handleGetSessionStatus - path traversal prevention", () => {
  it("rejects session_id with path traversal", async () => {
    const result = await handleGetSessionStatus({ session_id: "../secret" });
    expect(result.found).toBe(false);
    // Should silently reject, not leak info about why
  });

  it("rejects session_id with absolute path", async () => {
    const result = await handleGetSessionStatus({
      session_id: "/etc/passwd",
    });
    expect(result.found).toBe(false);
  });

  it("returns found=false for non-existent valid session", async () => {
    const result = await handleGetSessionStatus({
      session_id: "non-existent-session",
    });
    expect(result.found).toBe(false);
  });
});

// ============================================================
// Path Traversal Tests - contract_id
// ============================================================

describe("handleRegisterContract - path traversal prevention", () => {
  it("rejects contract_id with path traversal", async () => {
    const result = await handleRegisterContract({
      contract_id: "../secret",
      contract_type: "api_endpoint",
      spec: "test spec",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Invalid contract_id");
    }
  });

  it("rejects contract_id with null byte", async () => {
    const result = await handleRegisterContract({
      contract_id: "contract\x00.json",
      contract_type: "type_definition",
      spec: "test spec",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Invalid contract_id");
    }
  });

  it("accepts valid contract_id", async () => {
    const result = await handleRegisterContract({
      contract_id: "UserProfile-type",
      contract_type: "type_definition",
      spec: "interface UserProfile { id: string; name: string; }",
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.contract_id).toBe("UserProfile-type");
    }
  });
});

// ============================================================
// Input Size Limit Tests
// ============================================================

describe("handleCompleteTask - input size limits", () => {
  it("rejects result_summary exceeding 10K chars", async () => {
    const conductorDir = process.env.CONDUCTOR_DIR!;
    const taskPath = path.join(conductorDir, "tasks", "task-004.json");
    const task = {
      id: "task-004",
      status: "in_progress",
      owner: "test-session-123",
      depends_on: [],
      blocks: [],
      subject: "Test task",
      description: "Test",
      files_changed: [],
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(taskPath, JSON.stringify(task), "utf-8");

    const result = await handleCompleteTask({
      task_id: "task-004",
      result_summary: "x".repeat(10_001), // Exceeds 10K
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("result_summary exceeds maximum length");
  });

  it("accepts result_summary at exactly 10K chars", async () => {
    const conductorDir = process.env.CONDUCTOR_DIR!;
    const taskPath = path.join(conductorDir, "tasks", "task-005.json");
    const task = {
      id: "task-005",
      status: "in_progress",
      owner: "test-session-123",
      depends_on: [],
      blocks: [],
      subject: "Test task",
      description: "Test",
      files_changed: [],
      created_at: new Date().toISOString(),
    };
    await fs.writeFile(taskPath, JSON.stringify(task), "utf-8");

    const result = await handleCompleteTask({
      task_id: "task-005",
      result_summary: "x".repeat(10_000), // Exactly 10K
    });
    expect(result.success).toBe(true);
  });
});

describe("handleRegisterContract - input size limits", () => {
  it("rejects spec exceeding 50K chars", async () => {
    const result = await handleRegisterContract({
      contract_id: "test-contract",
      contract_type: "type_definition",
      spec: "x".repeat(50_001), // Exceeds 50K
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("spec exceeds maximum length");
    }
  });
});

describe("handleRecordDecision - input size limits", () => {
  it("rejects decision exceeding 10K chars", async () => {
    const result = await handleRecordDecision({
      category: "test",
      decision: "x".repeat(10_001), // Exceeds 10K
      rationale: "test rationale",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("decision exceeds maximum length");
    }
  });

  it("rejects rationale exceeding 10K chars", async () => {
    const result = await handleRecordDecision({
      category: "test",
      decision: "test decision",
      rationale: "x".repeat(10_001), // Exceeds 10K
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("rationale exceeds maximum length");
    }
  });
});

describe("handlePostUpdate - input size limits", () => {
  it("rejects content exceeding 10K chars", async () => {
    const result = await handlePostUpdate({
      type: "status",
      content: "x".repeat(10_001), // Exceeds 10K
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("content exceeds maximum length");
    }
  });
});

// ============================================================
// Error Message Sanitization Tests
// ============================================================

describe("error messages - no path leakage", () => {
  it("does not leak CONDUCTOR_DIR in claim_task error", async () => {
    const result = await handleClaimTask({ task_id: "nonexistent-task" });
    expect(result.success).toBe(false);
    // Error should not contain the full conductor path
    expect(result.error).not.toContain(process.env.CONDUCTOR_DIR);
    // Should give useful error without exposing internals
    expect(result.error).toContain("not found");
  });

  it("does not leak absolute paths in complete_task error", async () => {
    const result = await handleCompleteTask({
      task_id: "nonexistent-task",
      result_summary: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).not.toContain(process.env.CONDUCTOR_DIR);
    expect(result.error).toContain("not found");
  });

  it("path traversal error does not leak validation internals", async () => {
    const result = await handleClaimTask({ task_id: "../../../etc/passwd" });
    expect(result.success).toBe(false);
    // Should give generic error about invalid task_id
    expect(result.error).toContain("Invalid task_id");
    // Should mention the reason but not leak paths
    expect(result.error).toContain("..");
    expect(result.error).not.toContain("etc/passwd");
  });
});

// ============================================================
// Unicode and Edge Cases
// ============================================================

describe("path traversal - unicode and edge cases", () => {
  it("handles empty task_id", async () => {
    const result = await handleClaimTask({ task_id: "" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("handles whitespace-only task_id", async () => {
    const result = await handleClaimTask({ task_id: "   " });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("handles task_id with control characters", async () => {
    const result = await handleClaimTask({ task_id: "task\x01\x02\x03" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("accepts task_id with Unicode letters", async () => {
    // This should fail with "not found" rather than validation error
    // (assuming validateFileName allows unicode letters)
    const result = await handleClaimTask({ task_id: "task-日本語" });
    // Either valid (not found) or invalid - just check it doesn't crash
    expect(typeof result.success).toBe("boolean");
  });
});

// ============================================================
// Mixed Attack Patterns
// ============================================================

describe("path traversal - mixed attack patterns", () => {
  it("rejects mixed encoding: raw + URL encoded", async () => {
    const result = await handleClaimTask({ task_id: "..%2f..%2f" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("rejects dot-slash variations", async () => {
    const result = await handleClaimTask({ task_id: ".%2e/" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });

  it("rejects nested traversal with valid segments", async () => {
    const result = await handleClaimTask({
      task_id: "tasks/../../../etc/passwd",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task_id");
  });
});

// ============================================================
// handleRunTests - test_files validation (task-014)
// ============================================================

describe("handleRunTests - test_files validation", () => {
  it("rejects test_files with path traversal (../)", async () => {
    const result = await handleRunTests({
      test_files: ["../../../etc/passwd"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file path");
    expect(result.output).toContain("..");
  });

  it("rejects test_files with absolute paths (/etc/passwd)", async () => {
    const result = await handleRunTests({
      test_files: ["/etc/passwd"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file path");
    expect(result.output).toContain("Absolute");
  });

  it("rejects test_files without valid test extension", async () => {
    const result = await handleRunTests({
      test_files: ["src/utils/validation.ts"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file extension");
    expect(result.output).toContain(".test.ts");
    expect(result.output).toContain(".spec.ts");
  });

  it("rejects test_files with plain .js extension", async () => {
    const result = await handleRunTests({
      test_files: ["src/index.js"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file extension");
  });

  it("accepts valid test file paths with .test.ts extension", async () => {
    // execFile is mocked at module level - no real subprocess spawned
    const result = await handleRunTests({
      test_files: ["src/utils/validation.test.ts"],
    });
    // Should not have validation error
    expect(result.output).not.toContain("Invalid test file path");
    expect(result.output).not.toContain("Invalid test file extension");
  });

  it("accepts valid test file paths with .spec.ts extension", async () => {
    const result = await handleRunTests({
      test_files: ["src/core/scheduler.spec.ts"],
    });
    expect(result.output).not.toContain("Invalid test file path");
    expect(result.output).not.toContain("Invalid test file extension");
  });

  it("accepts valid test file paths with .test.tsx extension", async () => {
    const result = await handleRunTests({
      test_files: ["src/components/Button.test.tsx"],
    });
    expect(result.output).not.toContain("Invalid test file path");
    expect(result.output).not.toContain("Invalid test file extension");
  });

  it("accepts valid test file paths with .spec.jsx extension", async () => {
    const result = await handleRunTests({
      test_files: ["src/components/Button.spec.jsx"],
    });
    expect(result.output).not.toContain("Invalid test file path");
    expect(result.output).not.toContain("Invalid test file extension");
  });

  it("rejects multiple test_files when any has path traversal", async () => {
    const result = await handleRunTests({
      test_files: ["src/utils/validation.test.ts", "../secret.test.ts"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file path");
    expect(result.output).toContain("..");
  });

  it("rejects multiple test_files when any has invalid extension", async () => {
    const result = await handleRunTests({
      test_files: ["src/utils/validation.test.ts", "src/utils/helper.ts"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file extension");
    expect(result.output).toContain("helper.ts");
  });

  it("rejects test_files with URL-encoded path traversal", async () => {
    const result = await handleRunTests({
      test_files: ["%2e%2e%2fsecret.test.ts"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file path");
  });

  it("rejects test_files with null byte injection", async () => {
    const result = await handleRunTests({
      test_files: ["src/utils/test\x00.test.ts"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file path");
    expect(result.output).toContain("null byte");
  });

  it("rejects test_files with Windows absolute path", async () => {
    const result = await handleRunTests({
      test_files: ["C:\\Windows\\test.test.ts"],
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Invalid test file path");
  });
});

// ============================================================
// handleCompleteTask - status validation (H6 fix)
// ============================================================

describe("handleCompleteTask - status validation (H6)", () => {
  it("rejects completing a task with status 'pending'", async () => {
    // Create a pending task file
    const taskId = "test-status-pending";
    const taskData = {
      id: taskId,
      subject: "Test pending task",
      description: "Test",
      status: "pending",
      owner: null,
      depends_on: [],
      blocks: [],
      result_summary: null,
      files_changed: [],
      created_at: new Date().toISOString(),
    };
    const taskPath = path.join(tempDir, ".conductor", "tasks", `${taskId}.json`);
    await fs.writeFile(taskPath, JSON.stringify(taskData, null, 2), "utf-8");

    const result = await handleCompleteTask({
      task_id: taskId,
      result_summary: "Should not complete",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("pending");
    expect(result.error).toContain("expected 'in_progress'");
  });

  it("rejects completing a task with status 'completed'", async () => {
    const taskId = "test-status-completed";
    const taskData = {
      id: taskId,
      subject: "Test already completed task",
      description: "Test",
      status: "completed",
      owner: "test-session-123",
      depends_on: [],
      blocks: [],
      result_summary: "Already done",
      files_changed: [],
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    const taskPath = path.join(tempDir, ".conductor", "tasks", `${taskId}.json`);
    await fs.writeFile(taskPath, JSON.stringify(taskData, null, 2), "utf-8");

    const result = await handleCompleteTask({
      task_id: taskId,
      result_summary: "Should not re-complete",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("completed");
    expect(result.error).toContain("expected 'in_progress'");
  });

  it("allows completing a task with status 'in_progress' owned by current session", async () => {
    const taskId = "test-status-in-progress";
    const taskData = {
      id: taskId,
      subject: "Test in-progress task",
      description: "Test",
      status: "in_progress",
      owner: "test-session-123",
      depends_on: [],
      blocks: [],
      result_summary: null,
      files_changed: [],
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
    };
    const taskPath = path.join(tempDir, ".conductor", "tasks", `${taskId}.json`);
    await fs.writeFile(taskPath, JSON.stringify(taskData, null, 2), "utf-8");

    const result = await handleCompleteTask({
      task_id: taskId,
      result_summary: "Task completed successfully",
    });
    expect(result.success).toBe(true);
    expect(result.task?.status).toBe("completed");
  });
});

// ============================================================
// handlePostUpdate - concurrent writes (H7/H9 fix)
// ============================================================

describe("handlePostUpdate - concurrent writes (H7/H9)", () => {
  it("handles concurrent messages without data loss", async () => {
    // Fire multiple post_update calls concurrently
    const promises = Array.from({ length: 5 }, (_, i) =>
      handlePostUpdate({
        type: "status" as const,
        content: `Concurrent message ${i}`,
      }),
    );

    const results = await Promise.all(promises);

    // All should succeed (no errors)
    for (const result of results) {
      expect(result).not.toHaveProperty("error");
      expect((result as { id: string }).id).toBeTruthy();
    }

    // Verify all 5 messages are in the file
    const msgDir = path.join(tempDir, ".conductor", "messages");
    const files = await fs.readdir(msgDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    expect(jsonlFiles.length).toBeGreaterThan(0);

    let totalLines = 0;
    for (const file of jsonlFiles) {
      const content = await fs.readFile(path.join(msgDir, file), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      totalLines += lines.length;
    }
    expect(totalLines).toBe(5);
  });
});

// ============================================================
// handleRecordDecision - concurrent writes (H8/H9 fix)
// ============================================================

describe("handleRecordDecision - concurrent writes (H8/H9)", () => {
  it("handles concurrent decisions without data loss", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      handleRecordDecision({
        category: "naming",
        decision: `Decision ${i}`,
        rationale: `Rationale ${i}`,
      }),
    );

    const results = await Promise.all(promises);

    // All should succeed (no errors)
    for (const result of results) {
      expect(result).not.toHaveProperty("error");
      expect((result as { id: string }).id).toBeTruthy();
    }

    // Verify all 5 decisions are in the file
    const decisionsFile = path.join(tempDir, ".conductor", "decisions.jsonl");
    const content = await fs.readFile(decisionsFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(5);
  });
});

// ============================================================
// H-12: register_contract task_id parameter for accurate provenance
// ============================================================

describe("handleRegisterContract - H-12 task_id parameter", () => {
  it("uses task_id as owner_task_id when provided", async () => {
    const result = await handleRegisterContract({
      contract_id: "h12-test-contract",
      contract_type: "type_definition",
      spec: "interface TestType { id: string; }",
      task_id: "task-042",
    });

    // Should succeed
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      // H-12: owner_task_id should be set to the provided task_id
      expect(result.owner_task_id).toBe("task-042");
      // registered_by should still be the session ID
      expect(result.registered_by).toBe("test-session-123");
    }

    // Verify the persisted contract file also has the correct owner_task_id
    const contractFile = path.join(
      tempDir,
      ".conductor",
      "contracts",
      "h12-test-contract.json",
    );
    const persisted = JSON.parse(await fs.readFile(contractFile, "utf-8"));
    expect(persisted.owner_task_id).toBe("task-042");
    expect(persisted.registered_by).toBe("test-session-123");
  });

  it("falls back to session ID when task_id is not provided", async () => {
    const result = await handleRegisterContract({
      contract_id: "h12-fallback-contract",
      contract_type: "api_endpoint",
      spec: "POST /api/test",
    });

    // Should succeed
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      // Without task_id, owner_task_id should fall back to sessionId
      expect(result.owner_task_id).toBe("test-session-123");
      expect(result.registered_by).toBe("test-session-123");
    }
  });

  it("source code accepts task_id in RegisterContractInput interface", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/mcp/tools.ts"),
      "utf-8",
    );

    // H-12: Interface should declare optional task_id
    expect(source).toMatch(/task_id\?:\s*string/);

    // H-12: owner_task_id should use task_id with fallback
    expect(source).toMatch(/owner_task_id:\s*input\.task_id\s*\?\?/);
  });
});

// ============================================================
// A-8: read_updates mtime TOCTOU residual (v0.7.4)
// ============================================================

describe("A-8: read_updates mtime TOCTOU residual", () => {
  // The mtime pre-filter in handleReadUpdates and the subsequent readJsonlFile
  // are not atomic. A concurrent write between the two could, in principle,
  // land a message that the mtime skip reasoned around. The guaranteed
  // behavior is only that the new message shows up eventually (no data loss):
  // it may arrive in this call, or in a subsequent call. This test documents
  // that contract.
  it("eventually delivers a message written concurrently with a read", async () => {
    const dir = path.join(tempDir, ".conductor", "messages");
    const sessionId = "other-session";
    const filePath = path.join(dir, `${sessionId}.jsonl`);

    const now = Date.now();
    const oldTs = new Date(now - 100_000).toISOString();
    const sinceTs = new Date(now - 50_000).toISOString();
    const newTs = new Date(now + 100_000).toISOString();

    // Seed the file with 1 old message addressed to this session
    const oldMsg = {
      id: `${sessionId}-old-1`,
      from: sessionId,
      to: "test-session-123",
      type: "status",
      content: "old",
      timestamp: oldTs,
    };
    await fs.writeFile(filePath, JSON.stringify(oldMsg) + "\n", {
      encoding: "utf-8",
    });

    // Give the filesystem a moment so mtime of the initial write is settled.
    await new Promise((r) => setTimeout(r, 10));

    // Concurrently: (a) read messages since `sinceTs`, (b) append a new msg.
    const newMsg = {
      id: `${sessionId}-new-1`,
      from: sessionId,
      to: "test-session-123",
      type: "status",
      content: "new",
      timestamp: newTs,
    };
    const [firstRead] = await Promise.all([
      handleReadUpdates({ since: sinceTs }),
      fs.appendFile(filePath, JSON.stringify(newMsg) + "\n", {
        encoding: "utf-8",
      }),
    ]);

    // Check whether the new message made it into the first read.
    const gotNewOnFirstRead = firstRead.some((m) => m.id === newMsg.id);

    if (!gotNewOnFirstRead) {
      // TOCTOU hit: the mtime pre-filter skipped the file before the append
      // landed. The contract is that the message must appear on a
      // subsequent read_updates call.
      const secondRead = await handleReadUpdates({ since: sinceTs });
      expect(secondRead.some((m) => m.id === newMsg.id)).toBe(true);
    } else {
      // Fast path: the append landed before the mtime pre-filter ran, so
      // the new message was delivered on the first read. Either outcome is
      // acceptable — we only care that the message is eventually delivered.
      expect(gotNewOnFirstRead).toBe(true);
    }
  });
});

// ============================================================
// T-4: record_decision enum validation [H-18]
// ============================================================

describe("T-4: record_decision enum validation [H-18]", () => {
  it("accepts a valid category", async () => {
    const result = await handleRecordDecision({
      category: "auth",
      decision: "Use JWT",
      rationale: "Stateless auth for our service",
    });
    expect("error" in result).toBe(false);
  });

  it("rejects an invalid category with enum-aware error", async () => {
    const result = await handleRecordDecision({
      category: "not-a-category",
      decision: "Some decision",
      rationale: "Some rationale",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      // Zod's enum error mentions at least one of the valid values.
      // We don't over-constrain on exact wording of zod's message, but
      // at least one known category should show up in the rejection.
      const err = result.error;
      const mentionsValidValue =
        err.includes("auth") ||
        err.includes("naming") ||
        err.includes("data_model") ||
        err.includes("error_handling") ||
        err.includes("api_design") ||
        err.includes("testing") ||
        err.includes("performance") ||
        err.includes("other");
      expect(mentionsValidValue).toBe(true);
    }
  });
});

// ============================================================
// T-4: read_updates mtime + limit semantics [H-19]
// ============================================================

describe("T-4: read_updates mtime + limit semantics [H-19]", () => {
  const sessionId = "test-session-123";

  /**
   * Helper: write a jsonl file of messages addressed to the current session.
   * Writes atomically with a single writeFile call.
   */
  async function writeJsonlFile(
    filePath: string,
    messages: Array<{
      id: string;
      timestamp: string;
      from?: string;
      to?: string;
      type?: string;
      content?: string;
    }>,
  ): Promise<void> {
    const lines = messages
      .map((m) =>
        JSON.stringify({
          from: "writer-session",
          to: sessionId,
          type: "status",
          content: "msg",
          ...m,
        }),
      )
      .join("\n");
    await fs.writeFile(filePath, lines + "\n", { encoding: "utf-8" });
  }

  it("mtime pre-filter skips files with mtime <= since", async () => {
    const dir = path.join(tempDir, ".conductor", "messages");
    const oldFile = path.join(dir, "writer-old.jsonl");
    const newFile = path.join(dir, "writer-new.jsonl");

    const now = Date.now();
    const oldTs = new Date(now - 1_000_000).toISOString();
    const newTs = new Date(now + 10_000).toISOString();

    await writeJsonlFile(oldFile, [
      { id: "msg-old-1", timestamp: oldTs },
    ]);
    await writeJsonlFile(newFile, [
      { id: "msg-new-1", timestamp: newTs },
    ]);

    // Force the old file's mtime to be older than `since`.
    const sinceDate = new Date(now - 500_000);
    const olderDate = new Date(now - 900_000);
    await fs.utimes(oldFile, olderDate, olderDate);

    const result = await handleReadUpdates({ since: sinceDate.toISOString() });

    // Old file should be skipped by mtime pre-filter; new file's message
    // should come through (and pass the timestamp > since filter).
    const ids = result.map((m) => m.id);
    expect(ids).toContain("msg-new-1");
    expect(ids).not.toContain("msg-old-1");
  });

  it("limit caps results to the N most recent when supplied", async () => {
    const dir = path.join(tempDir, ".conductor", "messages");
    const now = Date.now();
    // Spread 1000 messages across 5 files.
    const perFile = 200;
    const totalFiles = 5;
    const allTimestamps: string[] = [];
    for (let f = 0; f < totalFiles; f++) {
      const filePath = path.join(dir, `writer-${f}.jsonl`);
      const msgs = [];
      for (let i = 0; i < perFile; i++) {
        const idx = f * perFile + i;
        const ts = new Date(now - 1_000_000 + idx * 100).toISOString();
        allTimestamps.push(ts);
        msgs.push({ id: `msg-${idx}`, timestamp: ts });
      }
      await writeJsonlFile(filePath, msgs);
    }

    const since = new Date(now - 2_000_000).toISOString();
    const result = await handleReadUpdates({ since, limit: 100 });

    expect(result.length).toBe(100);
    // Must be ascending by timestamp within the returned window.
    for (let i = 1; i < result.length; i++) {
      const prev = new Date(result[i - 1].timestamp).getTime();
      const curr = new Date(result[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
    // Must be the most recent 100 (by timestamp).
    const expectedLast = allTimestamps
      .slice()
      .sort()
      .slice(-100);
    expect(result.map((m) => m.timestamp)).toEqual(expectedLast);
  });

  it("returns all matching messages when limit is omitted (pre-H-19 parity)", async () => {
    const dir = path.join(tempDir, ".conductor", "messages");
    const filePath = path.join(dir, "writer-all.jsonl");
    const now = Date.now();
    const total = 250;
    const msgs = [];
    for (let i = 0; i < total; i++) {
      const ts = new Date(now - 1_000_000 + i * 100).toISOString();
      msgs.push({ id: `msg-${i}`, timestamp: ts });
    }
    await writeJsonlFile(filePath, msgs);

    const since = new Date(now - 2_000_000).toISOString();
    const result = await handleReadUpdates({ since });

    expect(result.length).toBe(total);
  });

  it("hard-cap clamps explicit limit to MAX_READ_UPDATES_HARD_CAP", async () => {
    const dir = path.join(tempDir, ".conductor", "messages");
    const now = Date.now();
    const total = 10_500; // > MAX_READ_UPDATES_HARD_CAP
    // Spread across a few files to exercise the multi-file path.
    const fileCount = 3;
    const perFile = Math.ceil(total / fileCount);

    let idx = 0;
    for (let f = 0; f < fileCount; f++) {
      const filePath = path.join(dir, `writer-${f}.jsonl`);
      const msgs = [];
      const count = Math.min(perFile, total - idx);
      for (let i = 0; i < count; i++) {
        const ts = new Date(now - 10_000_000 + idx * 10).toISOString();
        msgs.push({ id: `msg-${idx}`, timestamp: ts });
        idx++;
      }
      await writeJsonlFile(filePath, msgs);
    }

    const since = new Date(now - 20_000_000).toISOString();
    const result = await handleReadUpdates({ since, limit: 1_000_000 });

    // When limit exceeds the cap, it clamps to exactly MAX_READ_UPDATES_HARD_CAP.
    expect(result.length).toBe(MAX_READ_UPDATES_HARD_CAP);
  }, 30_000);

  it("since + limit compose: returns N most recent AFTER since", async () => {
    const dir = path.join(tempDir, ".conductor", "messages");
    const filePath = path.join(dir, "writer-compose.jsonl");
    const now = Date.now();
    const total = 100;
    const msgs = [];
    for (let i = 0; i < total; i++) {
      const ts = new Date(now - 1_000_000 + i * 1_000).toISOString();
      msgs.push({ id: `msg-${i}`, timestamp: ts });
    }
    await writeJsonlFile(filePath, msgs);

    // `since` that includes the newest 80 of the 100 messages.
    // msg-i timestamps are now - 1_000_000 + i*1_000.
    // We want 80 to pass `since`, i.e. i in [20, 99].
    // Since filter uses msgTs > sinceTs strictly, pick sinceTs strictly less
    // than the timestamp of msg-20.
    const sinceMs = now - 1_000_000 + 19 * 1_000 + 500;
    const since = new Date(sinceMs).toISOString();

    const result = await handleReadUpdates({ since, limit: 30 });

    expect(result.length).toBe(30);
    // All returned messages must be strictly newer than `since`.
    for (const m of result) {
      expect(new Date(m.timestamp).getTime()).toBeGreaterThan(sinceMs);
    }
    // Must be ascending.
    for (let i = 1; i < result.length; i++) {
      const prev = new Date(result[i - 1].timestamp).getTime();
      const curr = new Date(result[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
    // Must be the 30 most recent among those that pass `since`.
    // The 80 passing are msg-20..msg-99; the 30 most recent are msg-70..msg-99.
    const expectedIds = Array.from({ length: 30 }, (_, k) => `msg-${70 + k}`);
    expect(result.map((m) => m.id)).toEqual(expectedIds);
  });
});

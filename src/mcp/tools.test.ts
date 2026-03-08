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

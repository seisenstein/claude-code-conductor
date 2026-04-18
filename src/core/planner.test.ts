import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Planner } from "./planner.js";

// Mock SDK dependencies for integration tests
const mockClose = vi.fn().mockResolvedValue(undefined);
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn(() => ({ instance: { close: mockClose } })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ handler })),
}));

const mockQueryWithTimeout = vi.fn();
vi.mock("../utils/sdk-timeout.js", () => ({
  queryWithTimeout: (...args: unknown[]) => mockQueryWithTimeout(...args),
}));

// Access private methods for testing via type cast
type PlannerPrivate = {
  readAndValidateTasksDraft(): Promise<unknown[]>;
};

function createPlanner(projectDir = "/tmp/test"): PlannerPrivate {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return new Planner(projectDir, logger as never) as unknown as PlannerPrivate;
}

// ============================================================
// readAndValidateTasksDraft tests (new file-based approach)
// ============================================================

describe("Planner.readAndValidateTasksDraft", () => {
  let tmpDir: string;

  async function setup() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "planner-test-"));
    await fs.mkdir(path.join(tmpDir, ".conductor"), { recursive: true });
  }

  async function cleanup() {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  it("reads and validates a valid tasks-draft.json", async () => {
    await setup();
    try {
      const tasks = [
        { subject: "A", description: "First", depends_on_subjects: [] },
        { subject: "B", description: "Second", depends_on_subjects: ["A"] },
      ];
      await fs.writeFile(
        path.join(tmpDir, ".conductor", "tasks-draft.json"),
        JSON.stringify(tasks),
      );
      const planner = createPlanner(tmpDir);
      const result = await planner.readAndValidateTasksDraft();
      expect(result).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("throws when tasks-draft.json is missing", async () => {
    await setup();
    try {
      const planner = createPlanner(tmpDir);
      await expect(planner.readAndValidateTasksDraft()).rejects.toThrow(
        /Planner did not write tasks-draft\.json/,
      );
    } finally {
      await cleanup();
    }
  });

  it("throws when tasks-draft.json contains invalid JSON", async () => {
    await setup();
    try {
      await fs.writeFile(
        path.join(tmpDir, ".conductor", "tasks-draft.json"),
        "not json {[",
      );
      const planner = createPlanner(tmpDir);
      await expect(planner.readAndValidateTasksDraft()).rejects.toThrow(
        /failed validation/,
      );
    } finally {
      await cleanup();
    }
  });

  it("throws when tasks-draft.json contains empty array", async () => {
    await setup();
    try {
      await fs.writeFile(
        path.join(tmpDir, ".conductor", "tasks-draft.json"),
        "[]",
      );
      const planner = createPlanner(tmpDir);
      await expect(planner.readAndValidateTasksDraft()).rejects.toThrow(
        /empty/,
      );
    } finally {
      await cleanup();
    }
  });

  it("throws when tasks have validation errors", async () => {
    await setup();
    try {
      const tasks = [
        { description: "Missing subject" },
      ];
      await fs.writeFile(
        path.join(tmpDir, ".conductor", "tasks-draft.json"),
        JSON.stringify(tasks),
      );
      const planner = createPlanner(tmpDir);
      await expect(planner.readAndValidateTasksDraft()).rejects.toThrow(
        /failed validation/,
      );
    } finally {
      await cleanup();
    }
  });
});

// ============================================================
// Integration tests: createPlan reads from tasks-draft.json,
// MCP server is always closed
// ============================================================

describe("Planner.createPlan integration", () => {
  let tmpDir: string;

  async function setup() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "planner-int-"));
    await fs.mkdir(path.join(tmpDir, ".conductor"), { recursive: true });
    mockClose.mockClear();
    mockQueryWithTimeout.mockReset();
  }

  async function cleanup() {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  it("succeeds when tasks-draft.json is written during session", async () => {
    await setup();
    try {
      const validTasks = [
        { subject: "A", description: "First", depends_on_subjects: [] },
      ];
      // Simulate the SDK session writing tasks-draft.json
      mockQueryWithTimeout.mockImplementation(async () => {
        await fs.writeFile(
          path.join(tmpDir, ".conductor", "tasks-draft.json"),
          JSON.stringify(validTasks),
        );
        return "# Plan\n\nSome plan markdown";
      });

      const planner = new Planner(tmpDir, {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      } as never);
      const result = await planner.createPlan("test feature", "Q&A context", 1);

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].subject).toBe("A");
      expect(result.plan_markdown).toContain("# Plan");
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("throws when tasks-draft.json is not written and still closes MCP", async () => {
    await setup();
    try {
      mockQueryWithTimeout.mockResolvedValue("# Plan without tasks file");

      const planner = new Planner(tmpDir, {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      } as never);

      await expect(planner.createPlan("test", "qa", 1)).rejects.toThrow(
        /Planner did not write tasks-draft\.json/,
      );
      // MCP server must still be closed even on failure
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("closes MCP server even when queryWithTimeout throws", async () => {
    await setup();
    try {
      mockQueryWithTimeout.mockRejectedValue(new Error("SDK timeout"));

      const planner = new Planner(tmpDir, {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      } as never);

      await expect(planner.createPlan("test", "qa", 1)).rejects.toThrow("SDK timeout");
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });
});

// ============================================================
// Integration tests: replan reads from tasks-draft.json,
// MCP server is always closed
// ============================================================

describe("Planner.replan integration", () => {
  let tmpDir: string;

  async function setup() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "planner-replan-"));
    await fs.mkdir(path.join(tmpDir, ".conductor"), { recursive: true });
    // Write a previous plan file that replan reads
    await fs.writeFile(path.join(tmpDir, ".conductor", "plan-v1.md"), "# Previous Plan\n");
    mockClose.mockClear();
    mockQueryWithTimeout.mockReset();
  }

  async function cleanup() {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  function makePlanner() {
    return new Planner(tmpDir, {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    } as never);
  }

  it("succeeds when tasks-draft.json is written during replan session", async () => {
    await setup();
    try {
      const validTasks = [
        { subject: "Fix-A", description: "Fix first issue", depends_on_subjects: [] },
      ];
      mockQueryWithTimeout.mockImplementation(async () => {
        await fs.writeFile(
          path.join(tmpDir, ".conductor", "tasks-draft.json"),
          JSON.stringify(validTasks),
        );
        return "# Replan\n\nUpdated plan";
      });

      const result = await makePlanner().replan(
        "test feature",
        path.join(tmpDir, ".conductor", "plan-v1.md"),
        [], // completedTasks
        [], // failedTasks
        null, // codexFeedback
        2,
      );

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].subject).toBe("Fix-A");
      expect(result.plan_markdown).toContain("# Replan");
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("throws when tasks-draft.json is missing after replan and still closes MCP", async () => {
    await setup();
    try {
      mockQueryWithTimeout.mockResolvedValue("# Replan without tasks");

      await expect(
        makePlanner().replan("test", path.join(tmpDir, ".conductor", "plan-v1.md"), [], [], null, 2),
      ).rejects.toThrow(/Planner did not write tasks-draft\.json/);
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("closes MCP server even when replan queryWithTimeout throws", async () => {
    await setup();
    try {
      mockQueryWithTimeout.mockRejectedValue(new Error("replan timeout"));

      await expect(
        makePlanner().replan("test", path.join(tmpDir, ".conductor", "plan-v1.md"), [], [], null, 2),
      ).rejects.toThrow("replan timeout");
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });
});

// ============================================================
// H-6 fix: Planner replan uses modelConfig instead of hardcoded model
// ============================================================

describe("Planner H-6 fix: replan model config", () => {
  it("source code does NOT hardcode claude-sonnet-4-6 in replan", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/planner.ts"),
      "utf-8",
    );

    // Find the replan method
    const replanStart = source.indexOf("async replan(");
    expect(replanStart).toBeGreaterThan(-1);

    const replanBody = source.substring(replanStart, replanStart + 2000);

    // H-6 FIX: Should NOT have hardcoded 'claude-sonnet-4-6' in the replan method
    expect(replanBody).not.toContain('"claude-sonnet-4-6"');
    expect(replanBody).not.toContain("'claude-sonnet-4-6'");
  });

  it("source code uses DEFAULT_ROLE_CONFIG (per-role) for fallback (v0.7.0)", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/planner.ts"),
      "utf-8",
    );

    // Per-role defaults replaced the legacy MODEL_TIER_TO_ID[DEFAULT_MODEL_CONFIG]
    // fallback. The constructor now resolves to DEFAULT_ROLE_CONFIG.planner when
    // no spec is supplied, so DEFAULT_ROLE_CONFIG must be imported and referenced.
    expect(source).toContain("DEFAULT_ROLE_CONFIG");
    expect(source).toContain("DEFAULT_ROLE_CONFIG.planner");
  });
});

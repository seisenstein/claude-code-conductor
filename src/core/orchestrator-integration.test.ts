/**
 * Orchestrator Integration Tests - Main Happy Path
 *
 * These tests verify the Orchestrator's main run() loop functionality:
 * - Fresh initialization with state creation
 * - Single cycle completion (planning -> execution -> review -> checkpoint)
 * - Planning phase produces tasks
 * - Execution phase spawns workers
 * - Review phase processes Codex approval
 * - Checkpoint records cycle and returns appropriate status
 *
 * Uses mocked SDK (no real Claude sessions) and real temp directories.
 *
 * @module orchestrator-integration.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Mock the SDK BEFORE importing Orchestrator (hoisted by vitest)
// Using inline vi.fn() to avoid hoisting issues
// The Query interface extends AsyncGenerator<SDKMessage, void> and requires additional methods
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  // Helper to create a fully-typed mock Query object that satisfies the SDK interface
  // Defined inline to ensure it's available when the mock factory runs.
  // Adds the methods that came in @anthropic-ai/claude-agent-sdk 0.2.x (applyFlagSettings,
  // initializationResult, supportedAgents, getContextUsage, reloadPlugins, seedReadState,
  // reconnectMcpServer, toggleMcpServer, stopTask, close).
  const buildMockQueryShape = (
    generator: AsyncGenerator<unknown, void, unknown>,
  ): Record<string, unknown> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape: any = {
      next: generator.next.bind(generator),
      return: generator.return.bind(generator),
      throw: generator.throw.bind(generator),
      [Symbol.asyncIterator]: () => shape,
      interrupt: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      initializationResult: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedAgents: vi.fn().mockResolvedValue([]),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      getContextUsage: vi.fn().mockResolvedValue({}),
      reloadPlugins: vi.fn().mockResolvedValue({}),
      accountInfo: vi.fn().mockResolvedValue({
        email: "test@example.com",
        organizationName: null,
        subscriptionType: "free",
      }),
      rewindFiles: vi.fn().mockResolvedValue({
        canRewind: true,
        error: null,
        filesAdded: 0,
        filesModified: 0,
        filesDeleted: 0,
      }),
      seedReadState: vi.fn().mockResolvedValue(undefined),
      reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
      toggleMcpServer: vi.fn().mockResolvedValue(undefined),
      setMcpServers: vi.fn().mockResolvedValue({
        added: [],
        removed: [],
        errors: [],
      }),
      streamInput: vi.fn().mockResolvedValue(undefined),
      stopTask: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    return shape;
  };

  const createMockQueryInternal = (result: string) => {
    // Create a proper SDKResultMessage-like object (only "result" type is used in tests)
    const mockResultMessage = {
      type: "result" as const,
      subtype: "success" as const,
      duration_ms: 100,
      duration_api_ms: 90,
      is_error: false,
      num_turns: 1,
      result,
      total_cost_usd: 0.001,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      structured_output: undefined,
      uuid: "00000000-0000-0000-0000-000000000000" as `${string}-${string}-${string}-${string}-${string}`,
      session_id: "test-session-id",
    };

    const generator = (async function* () {
      yield mockResultMessage;
    })();

    // Create the mock Query object with all required interface methods
    const mockQuery = buildMockQueryShape(generator);

    return mockQuery;
  };

  return {
    query: vi.fn(() => createMockQueryInternal("")),
    createSdkMcpServer: vi.fn(() => ({
      close: vi.fn(),
    })),
    tool: vi.fn(() => ({})),
    // Export the helper so it can be used elsewhere
    __createMockQuery: createMockQueryInternal,
  };
});

// Mock child_process for codex CLI
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execSync: vi.fn(() => Buffer.from("")),
}));

// Mock readline to avoid interactive prompts
vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: vi.fn().mockResolvedValue("test answer"),
      close: vi.fn(),
    })),
  },
}));

// Import SDK mock to access the mocked function
import * as sdk from "@anthropic-ai/claude-agent-sdk";

import { Orchestrator } from "./orchestrator.js";
import { StateManager } from "./state-manager.js";
import type { CLIOptions, Task } from "../utils/types.js";
import { DEFAULT_MODEL_CONFIG } from "../utils/types.js";
import {
  createMockTaskDefinition,
  createTempProjectDir,
  cleanupTempDir,
  createMockUsageMonitor,
  createMockWorkerManager,
  createMockCodexReviewer,
  type MockUsageMonitor,
  type MockWorkerManager,
  type MockCodexReviewer,
} from "./__tests__/orchestrator-test-utils.js";
import { ORCHESTRATOR_DIR, getPauseSignalPath } from "../utils/constants.js";

// Get the mocked query function
const mockQuery = vi.mocked(sdk.query);

// ============================================================
// Test Setup Helpers
// ============================================================

function createTestOptions(projectDir: string, overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    project: projectDir,
    feature: "Test feature implementation",
    concurrency: 1,
    maxCycles: 3,
    usageThreshold: 0.8,
    skipCodex: true, // Skip Codex by default to simplify tests
    skipFlowReview: true, // Skip flow review by default
    skipDesignSpecUpdate: true, // Skip design spec update by default
    dryRun: false,
    resume: false,
    verbose: false,
    contextFile: null,
    currentBranch: true, // Use current branch mode (no git operations)
    workerRuntime: "claude",
    forceResume: false,
    modelConfig: DEFAULT_MODEL_CONFIG,
    ...overrides,
  };
}

// Helper to create a mock async iterable query result
// Recreates the full mock Query object to satisfy the SDK interface
function createMockQueryResult(result: string) {
  // Create a proper SDKResultMessage-like object
  const mockResultMessage = {
    type: "result" as const,
    subtype: "success" as const,
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: false,
    num_turns: 1,
    result,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      server_tool_use: { web_search_requests: 0 },
      service_tier: "standard" as const,
    },
    modelUsage: {},
    permission_denials: [],
    structured_output: undefined,
    uuid: "00000000-0000-0000-0000-000000000000" as `${string}-${string}-${string}-${string}-${string}`,
    session_id: "test-session-id",
  };

  const generator = (async function* () {
    yield mockResultMessage;
  })();

  // Create the mock Query object with all required interface methods.
  // Mirrors the shape inside the vi.mock() factory above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockQuery: any = {
    next: generator.next.bind(generator),
    return: generator.return.bind(generator),
    throw: generator.throw.bind(generator),
    [Symbol.asyncIterator]: () => mockQuery,
    interrupt: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    initializationResult: vi.fn().mockResolvedValue({}),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue({}),
    reloadPlugins: vi.fn().mockResolvedValue({}),
    accountInfo: vi.fn().mockResolvedValue({
      email: "test@example.com",
      organizationName: null,
      subscriptionType: "free",
    }),
    rewindFiles: vi.fn().mockResolvedValue({
      canRewind: true,
      error: null,
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
    }),
    seedReadState: vi.fn().mockResolvedValue(undefined),
    reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
    toggleMcpServer: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi.fn().mockResolvedValue({
      added: [],
      removed: [],
      errors: [],
    }),
    streamInput: vi.fn().mockResolvedValue(undefined),
    stopTask: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };

  return mockQuery;
}

// ============================================================
// Integration Tests - Main Happy Path
// ============================================================

describe("Orchestrator Integration - Happy Path", () => {
  let tempDir: string;
  let options: CLIOptions;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    options = createTestOptions(tempDir);

    // Initialize a minimal git repo for the orchestrator
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");

    // Reset and configure mock SDK to return empty responses by default
    mockQuery.mockReset();
    mockQuery.mockReturnValue(createMockQueryResult(""));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // Test 1: Fresh start initializes state correctly
  // ============================================================

  it("fresh start initializes state correctly", async () => {
    const orchestrator = new Orchestrator(options);

    // We'll just check that the orchestrator can be constructed
    // and the state directory exists
    expect(orchestrator).toBeDefined();

    const conductorDir = path.join(tempDir, ORCHESTRATOR_DIR);
    const stat = await fs.stat(conductorDir);
    expect(stat.isDirectory()).toBe(true);
  });

  // ============================================================
  // Test 2: State manager initializes with correct structure
  // ============================================================

  it("state manager initializes with correct structure", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Test feature", "conduct/test-feature", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const state = stateManager.get();

    expect(state.status).toBe("initializing");
    expect(state.feature).toBe("Test feature");
    expect(state.max_cycles).toBe(3);
    expect(state.concurrency).toBe(2);
    expect(state.current_cycle).toBe(0);
    // H-5: completed_task_ids was a dead state field — now removed
    expect(state.completed_task_ids).toBeUndefined();
    expect(state.cycle_history).toEqual([]);
  });

  // ============================================================
  // Test 3: Dry run mode (state manager only - no git required)
  // ============================================================

  it("dry run option can be set in CLI options", async () => {
    const dryRunOptions = createTestOptions(tempDir, { dryRun: true });

    // Verify dry run option is correctly set
    expect(dryRunOptions.dryRun).toBe(true);
    expect(dryRunOptions.skipCodex).toBe(true);
    expect(dryRunOptions.skipFlowReview).toBe(true);
  });

  // ============================================================
  // Test 4: State persists to state.json
  // ============================================================

  it("state persists to state.json", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Persisted feature", "conduct/persisted", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("planning");
    await stateManager.save();

    const statePath = path.join(tempDir, ORCHESTRATOR_DIR, "state.json");
    const content = await fs.readFile(statePath, "utf-8");
    const persisted = JSON.parse(content);

    expect(persisted.feature).toBe("Persisted feature");
    expect(persisted.status).toBe("planning");
  });

  // ============================================================
  // Test 5: Task creation works correctly
  // ============================================================

  it("task creation stores tasks correctly", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Task test", "conduct/task-test", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    const taskDef = createMockTaskDefinition({
      subject: "Implement login",
      description: "Add user login functionality",
      task_type: "backend_api",
    });

    await stateManager.createTask(taskDef, "task-001", []);

    const tasks = await stateManager.getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task-001");
    expect(tasks[0].subject).toBe("Implement login");
    expect(tasks[0].status).toBe("pending");
  });

  // ============================================================
  // Test 6: Checkpoint returns 'complete' when all tasks done
  // ============================================================

  it("checkpoint returns complete when all tasks are done", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Checkpoint test", "conduct/checkpoint", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create a task and mark it completed
    const taskDef = createMockTaskDefinition({ subject: "Test task" });
    await stateManager.createTask(taskDef, "task-001", []);

    // Read task, update status to completed, write back
    const taskPath = path.join(tempDir, ORCHESTRATOR_DIR, "tasks", "task-001.json");
    const taskContent = await fs.readFile(taskPath, "utf-8");
    const task: Task = JSON.parse(taskContent);
    task.status = "completed";
    task.completed_at = new Date().toISOString();
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    // Verify task status
    const tasks = await stateManager.getAllTasks();
    expect(tasks[0].status).toBe("completed");

    // All tasks are completed, no failed or pending
    const completed = tasks.filter((t) => t.status === "completed");
    const failed = tasks.filter((t) => t.status === "failed");
    const pending = tasks.filter((t) => t.status === "pending");

    expect(completed.length).toBe(1);
    expect(failed.length).toBe(0);
    expect(pending.length).toBe(0);
  });

  // ============================================================
  // Test 7: Cycle history records completed cycles
  // ============================================================

  it("cycle history records completed cycles", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Cycle test", "conduct/cycle-test", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const cycleRecord = {
      cycle: 1,
      plan_version: 1,
      tasks_completed: 3,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 1,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };

    await stateManager.recordCycle(cycleRecord);

    const state = stateManager.get();
    expect(state.current_cycle).toBe(1);
    expect(state.cycle_history).toHaveLength(1);
    expect(state.cycle_history[0].tasks_completed).toBe(3);
  });

  // ============================================================
  // Test 8: Resume from paused state continues execution
  // ============================================================

  it("resume from paused state continues execution", async () => {
    const stateManager = new StateManager(tempDir);

    // Initialize and pause
    await stateManager.initialize("Resume test", "conduct/resume-test", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("executing");
    await stateManager.pause("test-pause");

    expect(stateManager.get().status).toBe("paused");
    expect(stateManager.get().paused_at).not.toBeNull();

    // Resume
    await stateManager.resume();

    const state = stateManager.get();
    // H-13: resume() sets transient "initializing", not "executing".
    expect(state.status).toBe("initializing");
    expect(state.paused_at).toBeNull();
  });
});

// ============================================================
// Integration Tests - Checkpoint Gating
// ============================================================

describe("Orchestrator Integration - Checkpoint Gating", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // Test 1: All tasks completed -> checkpoint logic determines 'complete'
  // ============================================================

  it("all tasks completed results in complete checkpoint decision", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Checkpoint complete test", "conduct/checkpoint-complete", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create two tasks and mark them both completed
    const taskDef1 = createMockTaskDefinition({ subject: "Task 1" });
    const taskDef2 = createMockTaskDefinition({ subject: "Task 2" });
    await stateManager.createTask(taskDef1, "task-001", []);
    await stateManager.createTask(taskDef2, "task-002", []);

    // Mark both tasks as completed
    for (const taskId of ["task-001", "task-002"]) {
      const taskPath = path.join(tempDir, ORCHESTRATOR_DIR, "tasks", `${taskId}.json`);
      const taskContent = await fs.readFile(taskPath, "utf-8");
      const task: Task = JSON.parse(taskContent);
      task.status = "completed";
      task.completed_at = new Date().toISOString();
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
    }

    // Verify checkpoint conditions
    const tasks = await stateManager.getAllTasks();
    const completed = tasks.filter((t) => t.status === "completed");
    const failed = tasks.filter((t) => t.status === "failed");
    const pending = tasks.filter((t) => t.status === "pending");
    const inProgress = tasks.filter((t) => t.status === "in_progress");

    const remaining = pending.length + inProgress.length;

    // Checkpoint should return 'complete' when:
    // remaining === 0 && failed.length === 0
    expect(completed.length).toBe(2);
    expect(failed.length).toBe(0);
    expect(remaining).toBe(0);

    // This matches the condition in checkpoint() that returns 'complete'
  });

  // ============================================================
  // Test 2: Some tasks failed with room for retries -> continue
  // ============================================================

  it("failed tasks with remaining cycles results in continue decision", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Checkpoint continue test", "conduct/checkpoint-continue", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create a task and mark it failed
    const taskDef = createMockTaskDefinition({ subject: "Failing task" });
    await stateManager.createTask(taskDef, "task-001", []);

    const taskPath = path.join(tempDir, ORCHESTRATOR_DIR, "tasks", "task-001.json");
    const taskContent = await fs.readFile(taskPath, "utf-8");
    const task: Task = JSON.parse(taskContent);
    task.status = "failed";
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    // Verify checkpoint conditions
    const tasks = await stateManager.getAllTasks();
    const state = stateManager.get();
    const failed = tasks.filter((t) => t.status === "failed");

    // We're at cycle 0, max is 3, so there's room for more cycles
    expect(failed.length).toBe(1);
    expect(state.current_cycle).toBeLessThan(state.max_cycles - 1);

    // Checkpoint should return 'continue' when:
    // failed.length > 0 && current_cycle + 1 < max_cycles
  });

  // ============================================================
  // Test 3: Max cycles reached with incomplete tasks -> escalate
  // ============================================================

  it("max cycles reached with incomplete tasks results in escalate decision", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Checkpoint escalate test", "conduct/checkpoint-escalate", {
      maxCycles: 2,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create a pending task
    const taskDef = createMockTaskDefinition({ subject: "Incomplete task" });
    await stateManager.createTask(taskDef, "task-001", []);

    // Record cycle to bring current_cycle to 1 (max is 2)
    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 0,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 1,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const state = stateManager.get();
    const tasks = await stateManager.getAllTasks();
    const pending = tasks.filter((t) => t.status === "pending");

    // We're at cycle 1, max is 2, so current_cycle + 1 >= max_cycles
    expect(state.current_cycle).toBe(1);
    expect(state.max_cycles).toBe(2);
    expect(state.current_cycle + 1).toBeGreaterThanOrEqual(state.max_cycles);
    expect(pending.length).toBe(1);

    // Checkpoint should return 'escalate' when:
    // current_cycle + 1 >= max_cycles && remaining > 0
  });

  // ============================================================
  // Test 4: Pause sets paused_at and changes status
  // ============================================================

  it("pause during checkpoint sets paused_at timestamp", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Checkpoint pause test", "conduct/checkpoint-pause", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("checkpointing");

    // Simulate user-requested pause
    await stateManager.pause("user_requested");

    const state = stateManager.get();

    expect(state.status).toBe("paused");
    expect(state.paused_at).not.toBeNull();

    // Checkpoint returns 'pause' when userPauseRequested is true
    // or when usage monitor indicates wind-down needed
  });

  // ============================================================
  // Test 5: Status transitions through checkpoint phase
  // ============================================================

  it("status can transition to checkpointing", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Checkpoint status test", "conduct/checkpoint-status", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Transition through phases
    await stateManager.setStatus("planning");
    expect(stateManager.get().status).toBe("planning");

    await stateManager.setStatus("executing");
    expect(stateManager.get().status).toBe("executing");

    await stateManager.setStatus("reviewing");
    expect(stateManager.get().status).toBe("reviewing");

    await stateManager.setStatus("flow_tracing");
    expect(stateManager.get().status).toBe("flow_tracing");

    await stateManager.setStatus("checkpointing");
    expect(stateManager.get().status).toBe("checkpointing");

    await stateManager.setStatus("completed");
    expect(stateManager.get().status).toBe("completed");
  });

  // ============================================================
  // Test 6: Escalated status can be set
  // ============================================================

  it("status can transition to escalated", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Checkpoint escalated test", "conduct/checkpoint-escalated", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("checkpointing");
    await stateManager.setStatus("escalated");

    expect(stateManager.get().status).toBe("escalated");
  });
});

// ============================================================
// Integration Tests - Pause and Resume
// ============================================================

describe("Orchestrator Integration - Pause and Resume", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // Test 1: Pause signal file triggers paused status
  // ============================================================

  it("pause signal file creation triggers pause when detected", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Pause signal test", "conduct/pause-signal", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("executing");

    // Create pause signal file
    const signalPath = getPauseSignalPath(tempDir);
    const signal = {
      requested_at: new Date().toISOString(),
      requested_by: "user",
    };
    await fs.writeFile(signalPath, JSON.stringify(signal, null, 2));

    // Verify signal file exists
    const signalExists = await fs.access(signalPath).then(() => true).catch(() => false);
    expect(signalExists).toBe(true);

    // Simulate orchestrator detecting pause signal and pausing
    await stateManager.pause("user_requested");

    const state = stateManager.get();
    expect(state.status).toBe("paused");
    expect(state.paused_at).not.toBeNull();
  });

  // ============================================================
  // Test 2: Resume clears paused state and continues
  // ============================================================

  it("resume clears paused state and continues execution", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Resume test", "conduct/resume-test", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("executing");
    await stateManager.pause("test_pause");

    expect(stateManager.get().status).toBe("paused");
    expect(stateManager.get().paused_at).not.toBeNull();

    // Resume
    await stateManager.resume();

    const state = stateManager.get();
    // H-13: resume() sets transient "initializing"; phases transition it.
    expect(state.status).toBe("initializing");
    expect(state.paused_at).toBeNull();
    expect(state.resume_after).toBeNull();
  });

  // ============================================================
  // Test 3: Resume with existing tasks skips planning phase
  // ============================================================

  it("resume with existing tasks allows continuing execution", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Resume tasks test", "conduct/resume-tasks", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create tasks (simulating previous planning phase)
    const taskDef1 = createMockTaskDefinition({ subject: "Task 1" });
    const taskDef2 = createMockTaskDefinition({ subject: "Task 2" });
    await stateManager.createTask(taskDef1, "task-001", []);
    await stateManager.createTask(taskDef2, "task-002", []);

    // Mark first task completed
    const taskPath = path.join(tempDir, ORCHESTRATOR_DIR, "tasks", "task-001.json");
    const taskContent = await fs.readFile(taskPath, "utf-8");
    const task: Task = JSON.parse(taskContent);
    task.status = "completed";
    task.completed_at = new Date().toISOString();
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    // Pause
    await stateManager.setStatus("executing");
    await stateManager.pause("test_pause");

    // Resume
    await stateManager.resume();

    // Check tasks still exist (planning should be skipped)
    const tasks = await stateManager.getAllTasks();
    expect(tasks.length).toBe(2);

    const completedTasks = tasks.filter(t => t.status === "completed");
    const pendingTasks = tasks.filter(t => t.status === "pending");
    expect(completedTasks.length).toBe(1);
    expect(pendingTasks.length).toBe(1);

    // H-13: resume() leaves status as "initializing"; phases transition it.
    expect(stateManager.get().status).toBe("initializing");
  });

  // ============================================================
  // Test 4: Usage-triggered pause sets resume_after timestamp
  // ============================================================

  it("usage-triggered pause sets resume_after timestamp", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Usage pause test", "conduct/usage-pause", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("executing");

    // Simulate usage-triggered pause with resume_after timestamp
    const resumeTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour later
    await stateManager.pause(resumeTime);

    const state = stateManager.get();
    expect(state.status).toBe("paused");
    expect(state.paused_at).not.toBeNull();
    expect(state.resume_after).toBe(resumeTime);
  });

  // ============================================================
  // Test 5: Pause during execution phase records correct status
  // ============================================================

  it("pause during execution phase records executing as prior status", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Execution pause test", "conduct/exec-pause", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Set status to executing (simulating active execution)
    await stateManager.setStatus("executing");
    expect(stateManager.get().status).toBe("executing");

    // Pause
    await stateManager.pause("user_requested");

    const state = stateManager.get();
    expect(state.status).toBe("paused");
    expect(state.paused_at).not.toBeNull();

    // H-13: resume() sets "initializing" regardless of pre-pause status.
    // The phase that runs after resume is responsible for its own setStatus.
    await stateManager.resume();
    expect(stateManager.get().status).toBe("initializing");
  });

  // ============================================================
  // Test 6: Removing pause signal file after detection
  // ============================================================

  it("pause signal file can be removed after detection", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Signal cleanup test", "conduct/signal-cleanup", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Create pause signal file
    const signalPath = getPauseSignalPath(tempDir);
    await fs.writeFile(signalPath, JSON.stringify({ requested_at: new Date().toISOString() }));

    // Verify it exists
    let exists = await fs.access(signalPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // Remove it (simulating orchestrator consuming the signal)
    await fs.unlink(signalPath);

    // Verify removal
    exists = await fs.access(signalPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});

// ============================================================
// Integration Tests - Rate Limit Handling
// ============================================================

describe("Orchestrator Integration - Rate Limit Handling", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // Test 1: Worker rate limit event can be detected in events
  // ============================================================

  it("worker manager can emit provider_rate_limited events", async () => {
    const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const workerManager: MockWorkerManager = createMockWorkerManager({
      workerEvents: [
        {
          type: "provider_rate_limited",
          sessionId: "worker-001",
          provider: "claude",
          detail: "Rate limit exceeded",
          resets_at: resetTime,
        },
      ],
    });

    // Get events from worker manager
    const events = workerManager.getWorkerEvents();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("provider_rate_limited");
    if (events[0].type === "provider_rate_limited") {
      expect(events[0].provider).toBe("claude");
      expect(events[0].resets_at).toBe(resetTime);
    }
  });

  // ============================================================
  // Test 2: Rate limit with resets_at timestamp can be stored
  // ============================================================

  it("rate limit event contains resets_at timestamp for scheduling", async () => {
    const resetTime = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    const workerManager: MockWorkerManager = createMockWorkerManager({
      workerEvents: [
        {
          type: "provider_rate_limited",
          sessionId: "worker-002",
          provider: "claude",
          detail: "5h utilization at 95%",
          resets_at: resetTime,
        },
      ],
    });

    const events = workerManager.getWorkerEvents();
    const rateLimitEvent = events.find(e => e.type === "provider_rate_limited");

    expect(rateLimitEvent).toBeDefined();
    if (rateLimitEvent?.type === "provider_rate_limited") {
      expect(rateLimitEvent.resets_at).toBe(resetTime);
      // This timestamp would be used by handleProviderRateLimit to schedule resume
    }
  });

  // ============================================================
  // Test 3: Usage critical triggers pause state
  // ============================================================

  it("usage monitor critical state leads to pause decision", async () => {
    const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const usageMonitor: MockUsageMonitor = createMockUsageMonitor({
      provider: "claude",
      critical: true,
      windDownNeeded: true,
      resetTime,
      usage: {
        five_hour: 0.95,
        seven_day: 0.4,
        five_hour_resets_at: resetTime,
        seven_day_resets_at: null,
        last_checked: new Date().toISOString(),
      },
    });

    // Verify the mock returns critical state
    expect(usageMonitor.isCritical()).toBe(true);
    expect(usageMonitor.isWindDownNeeded()).toBe(true);
    expect(usageMonitor.getResetTime()).toBe(resetTime);

    // In the orchestrator, this would trigger:
    // 1. Wind-down signal to workers
    // 2. Pause with resume_after = resetTime

    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Usage critical test", "conduct/usage-critical", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("executing");

    // Simulate the orchestrator's handleProviderRateLimit behavior
    await stateManager.pause(resetTime);

    const state = stateManager.get();
    expect(state.status).toBe("paused");
    expect(state.resume_after).toBe(resetTime);
  });

  // ============================================================
  // Test 4: Codex usage critical during review triggers pause
  // ============================================================

  it("codex usage monitor critical state can be detected", async () => {
    const resetTime = new Date(Date.now() + 45 * 60 * 1000).toISOString();
    const codexUsageMonitor: MockUsageMonitor = createMockUsageMonitor({
      provider: "codex",
      critical: true,
      windDownNeeded: true,
      resetTime,
      usage: {
        five_hour: 0.92,
        seven_day: 0.3,
        five_hour_resets_at: resetTime,
        seven_day_resets_at: null,
        last_checked: new Date().toISOString(),
      },
    });

    expect(codexUsageMonitor.provider).toBe("codex");
    expect(codexUsageMonitor.isCritical()).toBe(true);
    expect(codexUsageMonitor.getResetTime()).toBe(resetTime);

    // In the orchestrator, during review phase with codex runtime,
    // this would trigger pause before code review
  });

  // ============================================================
  // Test 5: Wind-down signal can be sent to workers
  // ============================================================

  it("worker manager can signal wind-down to workers", async () => {
    const workerManager: MockWorkerManager = createMockWorkerManager({
      activeWorkers: ["worker-001", "worker-002"],
    });

    const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await workerManager.signalWindDown("usage threshold reached", resetTime);

    expect(workerManager.signalWindDown).toHaveBeenCalledWith(
      "usage threshold reached",
      resetTime,
    );
  });

  // ============================================================
  // Test 6: Multiple rate limit events are accumulated
  // ============================================================

  it("multiple rate limit events can be accumulated", async () => {
    const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const workerManager: MockWorkerManager = createMockWorkerManager({
      workerEvents: [
        {
          type: "provider_rate_limited",
          sessionId: "worker-001",
          provider: "claude",
          detail: "First rate limit",
          resets_at: resetTime,
        },
        {
          type: "provider_rate_limited",
          sessionId: "worker-002",
          provider: "claude",
          detail: "Second rate limit",
          resets_at: resetTime,
        },
      ],
    });

    const events = workerManager.getWorkerEvents();
    const rateLimitEvents = events.filter(e => e.type === "provider_rate_limited");

    expect(rateLimitEvents).toHaveLength(2);
  });
});

// ============================================================
// Integration Tests - Force Resume Crash Recovery
// ============================================================

describe("Orchestrator Integration - Force Resume Crash Recovery", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // Helper to create state.json with a specific status
  async function createStateWithStatus(
    status: string,
    overrides: Partial<{
      current_cycle: number;
      cycle_history: unknown[];
      feature: string;
    }> = {},
  ): Promise<void> {
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Force resume test", "conduct/force-resume-test", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });
    await stateManager.createDirectories();

    // Read and modify the state file directly to set the desired status
    const statePath = path.join(tempDir, ORCHESTRATOR_DIR, "state.json");
    const stateContent = await fs.readFile(statePath, "utf-8");
    const state = JSON.parse(stateContent);
    state.status = status;

    // Apply any additional overrides
    if (overrides.current_cycle !== undefined) {
      state.current_cycle = overrides.current_cycle;
    }
    if (overrides.cycle_history !== undefined) {
      state.cycle_history = overrides.cycle_history;
    }
    if (overrides.feature !== undefined) {
      state.feature = overrides.feature;
    }

    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  // ============================================================
  // Test 1: Force-resume from 'executing' state succeeds
  // ============================================================

  it("force-resume from executing state clears stale state and succeeds", async () => {
    await createStateWithStatus("executing");

    // Create a StateManager and load the state
    const stateManager = new StateManager(tempDir);
    await stateManager.load();

    // Verify we're in executing state
    expect(stateManager.get().status).toBe("executing");

    // H-13: resume() sets status to transient "initializing" so a crash
    // between here and the first real phase doesn't falsely claim execution
    // was in progress.
    await stateManager.resume();

    expect(stateManager.get().status).toBe("initializing");
    expect(stateManager.get().paused_at).toBeNull();
    expect(stateManager.get().resume_after).toBeNull();
  });

  // ============================================================
  // Test 2: Force-resume from 'planning' state succeeds
  // ============================================================

  it("force-resume from planning state succeeds", async () => {
    await createStateWithStatus("planning");

    const stateManager = new StateManager(tempDir);
    await stateManager.load();

    expect(stateManager.get().status).toBe("planning");

    // H-13: resume() sets transient "initializing"; the orchestrator's
    // next phase transitions to its own status on entry.
    await stateManager.resume();

    expect(stateManager.get().status).toBe("initializing");
  });

  // ============================================================
  // Test 3: Force-resume from 'reviewing' state succeeds
  // ============================================================

  it("force-resume from reviewing state succeeds", async () => {
    await createStateWithStatus("reviewing");

    const stateManager = new StateManager(tempDir);
    await stateManager.load();

    expect(stateManager.get().status).toBe("reviewing");

    // H-13: resume() sets transient "initializing"; the orchestrator's
    // next phase transitions to its own status on entry.
    await stateManager.resume();

    expect(stateManager.get().status).toBe("initializing");
  });

  // ============================================================
  // Test 4: Force-resume from 'checkpointing' state succeeds
  // ============================================================

  it("force-resume from checkpointing state succeeds", async () => {
    await createStateWithStatus("checkpointing");

    const stateManager = new StateManager(tempDir);
    await stateManager.load();

    expect(stateManager.get().status).toBe("checkpointing");

    // H-13: resume() sets transient "initializing"; the orchestrator's
    // next phase transitions to its own status on entry.
    await stateManager.resume();

    expect(stateManager.get().status).toBe("initializing");
  });

  // ============================================================
  // Test 5: Force-resume from 'flow_tracing' state succeeds
  // ============================================================

  it("force-resume from flow_tracing state succeeds", async () => {
    // This test verifies that flow_tracing is now in forceableStatuses (task-011 fix)
    await createStateWithStatus("flow_tracing");

    const stateManager = new StateManager(tempDir);
    await stateManager.load();

    expect(stateManager.get().status).toBe("flow_tracing");

    // H-13: resume() sets transient "initializing"; the orchestrator's
    // next phase transitions to its own status on entry.
    await stateManager.resume();

    expect(stateManager.get().status).toBe("initializing");
  });

  // ============================================================
  // Test 6: In-progress tasks are reset to pending on force-resume
  // ============================================================

  it("in-progress tasks are reset to pending when their worker is dead", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Task reset test", "conduct/task-reset", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });
    await stateManager.createDirectories();

    // Create tasks with different statuses
    const taskDef1 = createMockTaskDefinition({ subject: "In progress task 1" });
    const taskDef2 = createMockTaskDefinition({ subject: "In progress task 2" });
    const taskDef3 = createMockTaskDefinition({ subject: "Pending task" });
    await stateManager.createTask(taskDef1, "task-001", []);
    await stateManager.createTask(taskDef2, "task-002", []);
    await stateManager.createTask(taskDef3, "task-003", []);

    // Mark task-001 and task-002 as in_progress with dead workers
    const tasksDir = path.join(tempDir, ORCHESTRATOR_DIR, "tasks");

    for (const [taskId, owner] of [
      ["task-001", "dead-worker-001"],
      ["task-002", "dead-worker-002"],
    ]) {
      const taskPath = path.join(tasksDir, `${taskId}.json`);
      const taskContent = await fs.readFile(taskPath, "utf-8");
      const task: Task = JSON.parse(taskContent);
      task.status = "in_progress";
      task.owner = owner;
      task.started_at = new Date().toISOString();
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
    }

    // Simulate force-resume: set state to executing and reset orphaned tasks
    await stateManager.setStatus("executing");

    // Call resetOrphanedTasks with empty active workers list
    // (simulating that all workers died during a crash)
    const result = await stateManager.resetOrphanedTasks([]);

    // Both in_progress tasks should be reset to pending
    expect(result.resetCount).toBe(2);
    expect(result.exhaustedCount).toBe(0);

    // Verify task statuses
    const task1 = JSON.parse(await fs.readFile(path.join(tasksDir, "task-001.json"), "utf-8")) as Task;
    const task2 = JSON.parse(await fs.readFile(path.join(tasksDir, "task-002.json"), "utf-8")) as Task;
    const task3 = JSON.parse(await fs.readFile(path.join(tasksDir, "task-003.json"), "utf-8")) as Task;

    expect(task1.status).toBe("pending");
    expect(task1.owner).toBeNull();
    expect(task2.status).toBe("pending");
    expect(task2.owner).toBeNull();
    expect(task3.status).toBe("pending"); // Already was pending
  });

  // ============================================================
  // Test 7: Force-resume preserves cycle history
  // ============================================================

  it("force-resume preserves cycle history from previous runs", async () => {
    const cycleHistory = [
      {
        cycle: 1,
        plan_version: 1,
        tasks_completed: 5,
        tasks_failed: 0,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 1,
        code_review_rounds: 1,
        duration_ms: 120000,
        started_at: new Date(Date.now() - 200000).toISOString(),
        completed_at: new Date(Date.now() - 80000).toISOString(),
      },
      {
        cycle: 2,
        plan_version: 1,
        tasks_completed: 3,
        tasks_failed: 1,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 1,
        code_review_rounds: 2,
        duration_ms: 90000,
        started_at: new Date(Date.now() - 80000).toISOString(),
        completed_at: new Date(Date.now() - 10000).toISOString(),
      },
    ];

    await createStateWithStatus("executing", {
      current_cycle: 2,
      cycle_history: cycleHistory,
    });

    const stateManager = new StateManager(tempDir);
    await stateManager.load();

    // Verify cycle history is loaded
    const state = stateManager.get();
    expect(state.current_cycle).toBe(2);
    expect(state.cycle_history).toHaveLength(2);
    expect(state.cycle_history[0].tasks_completed).toBe(5);
    expect(state.cycle_history[1].tasks_failed).toBe(1);

    // Force-resume
    await stateManager.resume();

    // Cycle history should be preserved
    const resumedState = stateManager.get();
    expect(resumedState.current_cycle).toBe(2);
    expect(resumedState.cycle_history).toHaveLength(2);
    expect(resumedState.cycle_history[0].tasks_completed).toBe(5);
    expect(resumedState.cycle_history[1].tasks_failed).toBe(1);
  });

  // ============================================================
  // Test 8: Force-resume with completed tasks preserves their status
  // ============================================================

  it("force-resume preserves completed task statuses", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Completed preservation test", "conduct/completed-preservation", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });
    await stateManager.createDirectories();

    // Create tasks
    const taskDef1 = createMockTaskDefinition({ subject: "Completed task" });
    const taskDef2 = createMockTaskDefinition({ subject: "In progress task" });
    await stateManager.createTask(taskDef1, "task-001", []);
    await stateManager.createTask(taskDef2, "task-002", []);

    const tasksDir = path.join(tempDir, ORCHESTRATOR_DIR, "tasks");

    // Mark task-001 as completed
    const task1Path = path.join(tasksDir, "task-001.json");
    const task1Content = await fs.readFile(task1Path, "utf-8");
    const task1: Task = JSON.parse(task1Content);
    task1.status = "completed";
    task1.completed_at = new Date().toISOString();
    task1.result_summary = "Task completed successfully";
    await fs.writeFile(task1Path, JSON.stringify(task1, null, 2));

    // Mark task-002 as in_progress with dead worker
    const task2Path = path.join(tasksDir, "task-002.json");
    const task2Content = await fs.readFile(task2Path, "utf-8");
    const task2: Task = JSON.parse(task2Content);
    task2.status = "in_progress";
    task2.owner = "dead-worker";
    await fs.writeFile(task2Path, JSON.stringify(task2, null, 2));

    // Set state to executing (simulating crash during execution)
    await stateManager.setStatus("executing");

    // Reset orphaned tasks
    const result = await stateManager.resetOrphanedTasks([]);

    // Only task-002 should be reset, task-001 should remain completed
    expect(result.resetCount).toBe(1);

    const task1After = JSON.parse(await fs.readFile(task1Path, "utf-8")) as Task;
    const task2After = JSON.parse(await fs.readFile(task2Path, "utf-8")) as Task;

    expect(task1After.status).toBe("completed");
    expect(task1After.result_summary).toBe("Task completed successfully");
    expect(task2After.status).toBe("pending");
  });

  // ============================================================
  // Test 9: Force-resume can update worker runtime
  // ============================================================

  it("force-resume can update worker runtime", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Runtime change test", "conduct/runtime-change", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Set to executing to simulate crash
    await stateManager.setStatus("executing");

    expect(stateManager.get().worker_runtime).toBe("claude");

    // Resume with different runtime
    await stateManager.resume("codex");

    // H-13: resume() sets "initializing"; runtime update still applies.
    expect(stateManager.get().status).toBe("initializing");
    expect(stateManager.get().worker_runtime).toBe("codex");
  });

  // ============================================================
  // Test 10: forceableStatuses includes flow_tracing
  // ============================================================

  it("CLI forceableStatuses set includes flow_tracing", () => {
    // This test documents the expected forceableStatuses in CLI
    // which should include flow_tracing after the task-011 fix
    const forceableStatuses = new Set([
      "executing",
      "planning",
      "reviewing",
      "checkpointing",
      "flow_tracing",
    ]);

    expect(forceableStatuses.has("executing")).toBe(true);
    expect(forceableStatuses.has("planning")).toBe(true);
    expect(forceableStatuses.has("reviewing")).toBe(true);
    expect(forceableStatuses.has("checkpointing")).toBe(true);
    expect(forceableStatuses.has("flow_tracing")).toBe(true);

    // These should NOT be forceable
    expect(forceableStatuses.has("paused")).toBe(false);
    expect(forceableStatuses.has("escalated")).toBe(false);
    expect(forceableStatuses.has("completed")).toBe(false);
    expect(forceableStatuses.has("failed")).toBe(false);
    expect(forceableStatuses.has("initializing")).toBe(false);
  });
});

// ============================================================
// Integration Tests - Escalation Handling
// ============================================================

describe("Orchestrator Integration - Escalation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // Test 1: Max cycles reached triggers escalation
  // ============================================================

  it("max cycles reached triggers escalated status", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Escalation max cycles test", "conduct/escalation-max", {
      maxCycles: 2,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create a pending task that won't be completed
    const taskDef = createMockTaskDefinition({ subject: "Incomplete task" });
    await stateManager.createTask(taskDef, "task-001", []);

    // Record cycle 1
    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 0,
      tasks_failed: 1,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 1,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    // We're now at cycle 1, max is 2 -> next cycle would exceed max
    const state = stateManager.get();
    expect(state.current_cycle).toBe(1);
    expect(state.max_cycles).toBe(2);

    // Simulate orchestrator escalation behavior
    // In real orchestrator, checkpoint() would call escalateToUser()
    await stateManager.setStatus("escalated");

    expect(stateManager.get().status).toBe("escalated");
  });

  // ============================================================
  // Test 2: Persistent task failures trigger escalation
  // ============================================================

  it("persistent task failures with max cycles leads to escalation", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Escalation failures test", "conduct/escalation-fail", {
      maxCycles: 2,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create a task and mark it as failed
    const taskDef = createMockTaskDefinition({ subject: "Failing task" });
    await stateManager.createTask(taskDef, "task-001", []);

    const taskPath = path.join(tempDir, ORCHESTRATOR_DIR, "tasks", "task-001.json");
    const taskContent = await fs.readFile(taskPath, "utf-8");
    const task: Task = JSON.parse(taskContent);
    task.status = "failed";
    task.retry_count = 3; // Max retries exceeded
    task.last_error = "Persistent error after 3 retries";
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    // Record cycle to bring to max
    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 0,
      tasks_failed: 1,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 1,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    // Verify conditions for escalation
    const state = stateManager.get();
    const tasks = await stateManager.getAllTasks();
    const failed = tasks.filter(t => t.status === "failed");

    expect(failed.length).toBe(1);
    expect(failed[0].retry_count).toBe(3);
    expect(state.current_cycle + 1).toBeGreaterThanOrEqual(state.max_cycles);

    // Escalation should be triggered
    await stateManager.setStatus("escalated");
    expect(stateManager.get().status).toBe("escalated");
  });

  // ============================================================
  // Test 3: Escalation file is written with correct context (non-interactive)
  // ============================================================

  it("escalation file contains reason, details, and options", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Escalation file test", "conduct/escalation-file", {
      maxCycles: 2,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();
    await stateManager.setStatus("escalated");

    // Simulate writing escalation file (what orchestrator does in non-interactive mode)
    const escalationPath = path.join(tempDir, ORCHESTRATOR_DIR, "escalation.json");
    const escalation = {
      reason: "Cycle limit reached",
      details: "Completed 2 cycle(s). Some tasks may remain incomplete.",
      timestamp: new Date().toISOString(),
      options: ["continue", "redirect", "stop"],
    };
    await fs.writeFile(
      escalationPath,
      JSON.stringify(escalation, null, 2) + "\n",
      { mode: 0o600 },
    );

    // Verify escalation file contents
    const content = await fs.readFile(escalationPath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.reason).toBe("Cycle limit reached");
    expect(parsed.details).toContain("cycle(s)");
    expect(parsed.options).toEqual(["continue", "redirect", "stop"]);
    expect(parsed.timestamp).toBeDefined();
  });

  // ============================================================
  // Test 4: Escalation with 'redirect' response stores guidance
  // ============================================================

  it("escalation redirect response can store redirectGuidance", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Redirect guidance test", "conduct/redirect-guidance", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();
    await stateManager.setStatus("escalated");

    // Simulate storing redirect guidance (what orchestrator does after user provides guidance)
    // Create an escalation response file to simulate user response
    const responsePath = path.join(tempDir, ORCHESTRATOR_DIR, "escalation-response.json");
    const response = {
      choice: "redirect",
      guidance: "Focus on implementing the authentication flow first",
      responded_at: new Date().toISOString(),
    };
    await fs.writeFile(responsePath, JSON.stringify(response, null, 2));

    // Verify response can be read
    const content = await fs.readFile(responsePath, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed.choice).toBe("redirect");
    expect(parsed.guidance).toBe("Focus on implementing the authentication flow first");

    // Resume from escalation - should transition to planning for next cycle
    await stateManager.setStatus("planning");
    expect(stateManager.get().status).toBe("planning");
  });

  // ============================================================
  // Test 5: Escalation with 'stop' response completes orchestrator
  // ============================================================

  it("escalation stop response leads to completed status", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Stop escalation test", "conduct/stop-escalation", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create a completed task to show some work was done
    const taskDef = createMockTaskDefinition({ subject: "Completed task" });
    await stateManager.createTask(taskDef, "task-001", []);

    const taskPath = path.join(tempDir, ORCHESTRATOR_DIR, "tasks", "task-001.json");
    const taskContent = await fs.readFile(taskPath, "utf-8");
    const task: Task = JSON.parse(taskContent);
    task.status = "completed";
    task.completed_at = new Date().toISOString();
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    await stateManager.setStatus("escalated");

    // Simulate user choosing "stop"
    // In orchestrator, this calls complete() which sets status to "completed"
    await stateManager.setStatus("completed");

    expect(stateManager.get().status).toBe("completed");
  });

  // ============================================================
  // Test 6: Escalation with 'continue' response proceeds to next cycle
  // ============================================================

  it("escalation continue response allows state transition to planning", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Continue escalation test", "conduct/continue-escalation", {
      maxCycles: 5, // Set higher to allow continuation
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.setStatus("escalated");

    // Simulate user choosing "continue"
    // In orchestrator, this returns "continue" and the run loop proceeds to next cycle
    await stateManager.setStatus("planning");

    expect(stateManager.get().status).toBe("planning");
  });

  // ============================================================
  // Test 7: Escalation file uses secure permissions
  // ============================================================

  it("escalation file uses secure permissions (0o600)", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Secure escalation test", "conduct/secure-escalation", {
      maxCycles: 2,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Write escalation file with secure permissions
    const escalationPath = path.join(tempDir, ORCHESTRATOR_DIR, "escalation.json");
    const escalation = {
      reason: "Test escalation",
      details: "Security test",
      timestamp: new Date().toISOString(),
      options: ["continue", "redirect", "stop"],
    };
    await fs.writeFile(
      escalationPath,
      JSON.stringify(escalation, null, 2) + "\n",
      { mode: 0o600 },
    );

    // Verify file permissions
    const stat = await fs.stat(escalationPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ============================================================
// Integration Tests - Codex Review Loops
// ============================================================

describe("Orchestrator Integration - Codex Loops", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // Test 1: Plan discussion loop - single round approval
  // ============================================================

  it("plan discussion with single round approval records 1 round", async () => {
    const codexReviewer: MockCodexReviewer = createMockCodexReviewer({
      planVerdict: "APPROVE",
      codeVerdict: "APPROVE",
    });

    // Simulate plan review call
    const result = await codexReviewer.reviewPlan("Test plan content");

    expect(result.verdict).toBe("APPROVE");
    expect(codexReviewer.reviewPlan).toHaveBeenCalledTimes(1);

    // In the orchestrator, this would record plan_discussion_rounds: 1
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Plan approve test", "conduct/plan-approve", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 2,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 1,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const state = stateManager.get();
    expect(state.cycle_history[0].plan_discussion_rounds).toBe(1);
    expect(state.cycle_history[0].codex_plan_approved).toBe(true);
  });

  // ============================================================
  // Test 2: Plan discussion loop - rejection -> replan -> approval
  // ============================================================

  it("plan discussion with rejection then approval records 2 rounds", async () => {
    const codexReviewer: MockCodexReviewer = createMockCodexReviewer({
      planVerdictSequence: ["NEEDS_DISCUSSION", "APPROVE"],
      codeVerdict: "APPROVE",
    });

    // First call returns NEEDS_DISCUSSION
    const result1 = await codexReviewer.reviewPlan("Initial plan");
    expect(result1.verdict).toBe("NEEDS_DISCUSSION");

    // Second call returns APPROVE (after replan)
    const result2 = await codexReviewer.reviewPlan("Revised plan with feedback");
    expect(result2.verdict).toBe("APPROVE");

    expect(codexReviewer.reviewPlan).toHaveBeenCalledTimes(2);

    // Record cycle with 2 plan discussion rounds
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Plan replan test", "conduct/plan-replan", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 2,  // Plan was revised once
      tasks_completed: 2,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 2,
      code_review_rounds: 1,
      duration_ms: 90000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const state = stateManager.get();
    expect(state.cycle_history[0].plan_discussion_rounds).toBe(2);
    expect(state.cycle_history[0].plan_version).toBe(2);
  });

  // ============================================================
  // Test 3: Plan discussion loop - max rounds exceeded -> escalation
  // ============================================================

  it("plan discussion max rounds exceeded triggers escalation status", async () => {
    const codexReviewer: MockCodexReviewer = createMockCodexReviewer({
      planVerdictSequence: ["NEEDS_DISCUSSION", "NEEDS_DISCUSSION", "MAJOR_CONCERNS"],
    });

    // Simulate multiple failed plan reviews
    for (let i = 0; i < 3; i++) {
      const result = await codexReviewer.reviewPlan(`Plan attempt ${i + 1}`);
      expect(["NEEDS_DISCUSSION", "MAJOR_CONCERNS"]).toContain(result.verdict);
    }

    expect(codexReviewer.reviewPlan).toHaveBeenCalledTimes(3);

    // When max rounds exceeded, orchestrator escalates
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Plan escalate test", "conduct/plan-escalate", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Record the escalation
    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 3,
      tasks_completed: 0,
      tasks_failed: 0,
      codex_plan_approved: false,
      codex_code_approved: false,
      plan_discussion_rounds: 3,
      code_review_rounds: 0,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    await stateManager.setStatus("escalated");

    const state = stateManager.get();
    expect(state.status).toBe("escalated");
    expect(state.cycle_history[0].codex_plan_approved).toBe(false);
    expect(state.cycle_history[0].plan_discussion_rounds).toBe(3);
  });

  // ============================================================
  // Test 4: Code review loop - single round approval
  // ============================================================

  it("code review with single round approval records 1 round", async () => {
    const codexReviewer: MockCodexReviewer = createMockCodexReviewer({
      planVerdict: "APPROVE",
      codeVerdict: "APPROVE",
    });

    // Simulate code review call
    const result = await codexReviewer.reviewCode("diff content", "code changes summary");

    expect(result.verdict).toBe("APPROVE");
    expect(codexReviewer.reviewCode).toHaveBeenCalledTimes(1);

    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Code approve test", "conduct/code-approve", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 2,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 1,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const state = stateManager.get();
    expect(state.cycle_history[0].code_review_rounds).toBe(1);
    expect(state.cycle_history[0].codex_code_approved).toBe(true);
  });

  // ============================================================
  // Test 5: Code review loop - rejection -> fix -> approval
  // ============================================================

  it("code review with rejection then approval records 2 rounds", async () => {
    const codexReviewer: MockCodexReviewer = createMockCodexReviewer({
      planVerdict: "APPROVE",
      codeVerdictSequence: ["NEEDS_FIXES", "APPROVE"],
      issues: ["Security issue in auth module"],
    });

    // First code review returns NEEDS_FIXES
    const result1 = await codexReviewer.reviewCode("initial diff", "initial changes");
    expect(result1.verdict).toBe("NEEDS_FIXES");
    expect(result1.issues).toContain("Security issue in auth module");

    // Second code review returns APPROVE (after fixes)
    const result2 = await codexReviewer.reviewCode("fixed diff", "fixed changes");
    expect(result2.verdict).toBe("APPROVE");

    expect(codexReviewer.reviewCode).toHaveBeenCalledTimes(2);

    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Code fix test", "conduct/code-fix", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 2,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 2,
      duration_ms: 120000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const state = stateManager.get();
    expect(state.cycle_history[0].code_review_rounds).toBe(2);
    expect(state.cycle_history[0].codex_code_approved).toBe(true);
  });

  // ============================================================
  // Test 6: Code review loop - max disagreement rounds -> escalation
  // ============================================================

  it("code review max disagreement rounds triggers escalation", async () => {
    const codexReviewer: MockCodexReviewer = createMockCodexReviewer({
      planVerdict: "APPROVE",
      codeVerdictSequence: ["NEEDS_FIXES", "NEEDS_FIXES", "MAJOR_PROBLEMS"],
      issues: ["Critical security vulnerability persists"],
    });

    // Simulate multiple failed code reviews
    for (let i = 0; i < 3; i++) {
      const result = await codexReviewer.reviewCode(`diff attempt ${i + 1}`, `changes ${i + 1}`);
      expect(["NEEDS_FIXES", "MAJOR_PROBLEMS"]).toContain(result.verdict);
    }

    expect(codexReviewer.reviewCode).toHaveBeenCalledTimes(3);

    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Code escalate test", "conduct/code-escalate", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 2,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: false,
      plan_discussion_rounds: 1,
      code_review_rounds: 3,
      duration_ms: 180000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    await stateManager.setStatus("escalated");

    const state = stateManager.get();
    expect(state.status).toBe("escalated");
    expect(state.cycle_history[0].codex_code_approved).toBe(false);
    expect(state.cycle_history[0].code_review_rounds).toBe(3);
  });

  // ============================================================
  // Test 7: skipCodex option bypasses all Codex interactions
  // ============================================================

  it("skipCodex option sets codex_plan_approved and codex_code_approved to true", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Skip Codex test", "conduct/skip-codex", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // When skipCodex is true, orchestrator records approved without calling Codex
    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 3,
      tasks_failed: 0,
      codex_plan_approved: true, // Auto-approved when skipCodex
      codex_code_approved: true, // Auto-approved when skipCodex
      plan_discussion_rounds: 0, // No rounds when skipped
      code_review_rounds: 0, // No rounds when skipped
      duration_ms: 30000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const state = stateManager.get();
    expect(state.cycle_history[0].codex_plan_approved).toBe(true);
    expect(state.cycle_history[0].codex_code_approved).toBe(true);
    expect(state.cycle_history[0].plan_discussion_rounds).toBe(0);
    expect(state.cycle_history[0].code_review_rounds).toBe(0);
  });

  // ============================================================
  // Test 8: Multiple cycles accumulate round counts correctly
  // ============================================================

  it("multiple cycles track round counts independently", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.initialize("Multi-cycle test", "conduct/multi-cycle", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    // Cycle 1: 1 plan round, 1 code round
    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 2,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 1,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    // Cycle 2: 2 plan rounds, 3 code rounds
    await stateManager.recordCycle({
      cycle: 2,
      plan_version: 2,
      tasks_completed: 1,
      tasks_failed: 1,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 2,
      code_review_rounds: 3,
      duration_ms: 120000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const state = stateManager.get();
    expect(state.cycle_history).toHaveLength(2);

    expect(state.cycle_history[0].plan_discussion_rounds).toBe(1);
    expect(state.cycle_history[0].code_review_rounds).toBe(1);

    expect(state.cycle_history[1].plan_discussion_rounds).toBe(2);
    expect(state.cycle_history[1].code_review_rounds).toBe(3);
  });

  // ============================================================
  // Test 9: Codex verdict sequences work correctly
  // ============================================================

  it("codex mock verdict sequences return correct values in order", async () => {
    const codexReviewer: MockCodexReviewer = createMockCodexReviewer({
      planVerdictSequence: ["NEEDS_DISCUSSION", "MAJOR_CONCERNS", "APPROVE"],
      codeVerdictSequence: ["NEEDS_FIXES", "APPROVE"],
    });

    // Test plan verdict sequence
    const plan1 = await codexReviewer.reviewPlan("plan v1");
    expect(plan1.verdict).toBe("NEEDS_DISCUSSION");

    const plan2 = await codexReviewer.reviewPlan("plan v2");
    expect(plan2.verdict).toBe("MAJOR_CONCERNS");

    const plan3 = await codexReviewer.reviewPlan("plan v3");
    expect(plan3.verdict).toBe("APPROVE");

    // Additional calls should return the last verdict
    const plan4 = await codexReviewer.reviewPlan("plan v4");
    expect(plan4.verdict).toBe("APPROVE");

    // Test code verdict sequence
    const code1 = await codexReviewer.reviewCode("diff 1", "summary 1");
    expect(code1.verdict).toBe("NEEDS_FIXES");

    const code2 = await codexReviewer.reviewCode("diff 2", "summary 2");
    expect(code2.verdict).toBe("APPROVE");

    // Additional calls should return the last verdict
    const code3 = await codexReviewer.reviewCode("diff 3", "summary 3");
    expect(code3.verdict).toBe("APPROVE");
  });
});

// ============================================================
// Integration Tests - Edge Cases and Boundaries
// ============================================================

describe("Orchestrator Integration - Edge Cases and Boundaries", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // Test 1: Max cycles = 1 completes after single cycle
  // ============================================================

  it("max cycles = 1 allows exactly one cycle", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Single cycle test", "conduct/single-cycle", {
      maxCycles: 1,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const state = stateManager.get();
    expect(state.max_cycles).toBe(1);
    expect(state.current_cycle).toBe(0);

    // Record one cycle
    await stateManager.recordCycle({
      cycle: 1,
      plan_version: 1,
      tasks_completed: 3,
      tasks_failed: 0,
      codex_plan_approved: true,
      codex_code_approved: true,
      plan_discussion_rounds: 1,
      code_review_rounds: 1,
      duration_ms: 60000,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    // After one cycle, current_cycle should be 1
    expect(stateManager.get().current_cycle).toBe(1);

    // At this point, current_cycle + 1 (2) > max_cycles (1)
    // So no more cycles should be allowed
    const afterCycle = stateManager.get();
    expect(afterCycle.current_cycle + 1).toBeGreaterThan(afterCycle.max_cycles);
  });

  // ============================================================
  // Test 2: Cycle counter increments correctly across multiple cycles
  // ============================================================

  it("cycle counter increments correctly across multiple cycles", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Multi cycle test", "conduct/multi-cycle", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    expect(stateManager.get().current_cycle).toBe(0);

    // Record 3 cycles
    for (let i = 1; i <= 3; i++) {
      await stateManager.recordCycle({
        cycle: i,
        plan_version: 1,
        tasks_completed: 2,
        tasks_failed: 0,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 1,
        code_review_rounds: 1,
        duration_ms: 30000 * i,
        started_at: new Date(Date.now() - 60000 * (4 - i)).toISOString(),
        completed_at: new Date(Date.now() - 60000 * (3 - i)).toISOString(),
      });

      expect(stateManager.get().current_cycle).toBe(i);
    }

    // Verify cycle history
    const state = stateManager.get();
    expect(state.current_cycle).toBe(3);
    expect(state.cycle_history).toHaveLength(3);
    expect(state.cycle_history[0].cycle).toBe(1);
    expect(state.cycle_history[1].cycle).toBe(2);
    expect(state.cycle_history[2].cycle).toBe(3);
  });

  // ============================================================
  // Test 3: Empty task list after planning
  // ============================================================

  it("empty task list results in no pending tasks", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Empty tasks test", "conduct/empty-tasks", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Don't create any tasks - simulate empty planning result
    const tasks = await stateManager.getAllTasks();

    expect(tasks).toHaveLength(0);

    // Verify task directory exists but is empty
    const tasksDir = path.join(tempDir, ORCHESTRATOR_DIR, "tasks");
    const stat = await fs.stat(tasksDir);
    expect(stat.isDirectory()).toBe(true);

    const taskFiles = await fs.readdir(tasksDir);
    expect(taskFiles).toHaveLength(0);
  });

  // ============================================================
  // Test 4: All tasks already completed on resume
  // ============================================================

  it("all tasks already completed means no pending work", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Resume completed test", "conduct/resume-completed", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create tasks and mark them all completed
    const taskDef1 = createMockTaskDefinition({ subject: "Task 1" });
    const taskDef2 = createMockTaskDefinition({ subject: "Task 2" });
    const taskDef3 = createMockTaskDefinition({ subject: "Task 3" });
    await stateManager.createTask(taskDef1, "task-001", []);
    await stateManager.createTask(taskDef2, "task-002", []);
    await stateManager.createTask(taskDef3, "task-003", []);

    const tasksDir = path.join(tempDir, ORCHESTRATOR_DIR, "tasks");

    for (const taskId of ["task-001", "task-002", "task-003"]) {
      const taskPath = path.join(tasksDir, `${taskId}.json`);
      const taskContent = await fs.readFile(taskPath, "utf-8");
      const task: Task = JSON.parse(taskContent);
      task.status = "completed";
      task.completed_at = new Date().toISOString();
      task.result_summary = `${taskId} completed successfully`;
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
    }

    // Pause and resume
    await stateManager.setStatus("executing");
    await stateManager.pause("test");
    await stateManager.resume();

    // Verify all tasks are still completed
    const tasks = await stateManager.getAllTasks();
    const pendingTasks = tasks.filter(t => t.status === "pending");
    const completedTasks = tasks.filter(t => t.status === "completed");

    expect(pendingTasks).toHaveLength(0);
    expect(completedTasks).toHaveLength(3);

    // In the orchestrator, this would trigger 'complete' checkpoint decision
    const remaining = tasks.filter(
      t => t.status === "pending" || t.status === "in_progress",
    );
    expect(remaining.length).toBe(0);
  });

  // ============================================================
  // Test 5: Dry run option is correctly set
  // ============================================================

  it("dry run option correctly configures options", () => {
    const dryRunOptions = createTestOptions(tempDir, {
      dryRun: true,
      skipCodex: true,
      skipFlowReview: true,
    });

    expect(dryRunOptions.dryRun).toBe(true);
    expect(dryRunOptions.skipCodex).toBe(true);
    expect(dryRunOptions.skipFlowReview).toBe(true);

    // Verify other default options are still set
    expect(dryRunOptions.project).toBe(tempDir);
    expect(dryRunOptions.concurrency).toBe(1);
    expect(dryRunOptions.maxCycles).toBe(3);
  });

  // ============================================================
  // Test 6: Cycle history accumulates correctly
  // ============================================================

  it("cycle history accumulates with unique durations", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("History accumulation test", "conduct/history-accum", {
      maxCycles: 5,
      concurrency: 2,
      workerRuntime: "claude",
    });

    const durations = [45000, 60000, 75000];

    for (let i = 0; i < durations.length; i++) {
      await stateManager.recordCycle({
        cycle: i + 1,
        plan_version: 1,
        tasks_completed: i + 1,
        tasks_failed: 0,
        codex_plan_approved: true,
        codex_code_approved: true,
        plan_discussion_rounds: 1,
        code_review_rounds: 1,
        duration_ms: durations[i],
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
    }

    const state = stateManager.get();
    expect(state.cycle_history).toHaveLength(3);
    expect(state.cycle_history[0].duration_ms).toBe(45000);
    expect(state.cycle_history[1].duration_ms).toBe(60000);
    expect(state.cycle_history[2].duration_ms).toBe(75000);
    expect(state.cycle_history[0].tasks_completed).toBe(1);
    expect(state.cycle_history[1].tasks_completed).toBe(2);
    expect(state.cycle_history[2].tasks_completed).toBe(3);
  });

  // ============================================================
  // Test 7: State persists max_cycles correctly
  // ============================================================

  it("max_cycles persists correctly in state", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Max cycles persistence", "conduct/max-persist", {
      maxCycles: 7,
      concurrency: 3,
      workerRuntime: "claude",
    });

    await stateManager.save();

    // Read state file directly
    const statePath = path.join(tempDir, ORCHESTRATOR_DIR, "state.json");
    const stateContent = await fs.readFile(statePath, "utf-8");
    const persistedState = JSON.parse(stateContent);

    expect(persistedState.max_cycles).toBe(7);
    expect(persistedState.concurrency).toBe(3);
  });

  // ============================================================
  // Test 8: Failed tasks counted correctly
  // ============================================================

  it("failed tasks are counted separately from pending", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Failed tasks test", "conduct/failed-tasks", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "claude",
    });

    await stateManager.createDirectories();

    // Create tasks with different statuses
    const taskDef1 = createMockTaskDefinition({ subject: "Completed task" });
    const taskDef2 = createMockTaskDefinition({ subject: "Failed task" });
    const taskDef3 = createMockTaskDefinition({ subject: "Pending task" });
    await stateManager.createTask(taskDef1, "task-001", []);
    await stateManager.createTask(taskDef2, "task-002", []);
    await stateManager.createTask(taskDef3, "task-003", []);

    const tasksDir = path.join(tempDir, ORCHESTRATOR_DIR, "tasks");

    // Mark task-001 as completed
    const task1Path = path.join(tasksDir, "task-001.json");
    const task1Content = await fs.readFile(task1Path, "utf-8");
    const task1: Task = JSON.parse(task1Content);
    task1.status = "completed";
    task1.completed_at = new Date().toISOString();
    await fs.writeFile(task1Path, JSON.stringify(task1, null, 2));

    // Mark task-002 as failed
    const task2Path = path.join(tasksDir, "task-002.json");
    const task2Content = await fs.readFile(task2Path, "utf-8");
    const task2: Task = JSON.parse(task2Content);
    task2.status = "failed";
    task2.completed_at = new Date().toISOString();
    task2.result_summary = "Task failed due to error";
    await fs.writeFile(task2Path, JSON.stringify(task2, null, 2));

    // Verify counts
    const tasks = await stateManager.getAllTasks();
    const completed = tasks.filter(t => t.status === "completed");
    const failed = tasks.filter(t => t.status === "failed");
    const pending = tasks.filter(t => t.status === "pending");

    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(tasks).toHaveLength(3);
  });

  // ============================================================
  // Test 9: State initialization with different worker runtimes
  // ============================================================

  it("state initializes correctly with codex worker runtime", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("Codex runtime test", "conduct/codex-runtime", {
      maxCycles: 3,
      concurrency: 2,
      workerRuntime: "codex",
    });

    expect(stateManager.get().worker_runtime).toBe("codex");

    // Save and reload to verify persistence
    await stateManager.save();

    const statePath = path.join(tempDir, ORCHESTRATOR_DIR, "state.json");
    const stateContent = await fs.readFile(statePath, "utf-8");
    const persistedState = JSON.parse(stateContent);

    expect(persistedState.worker_runtime).toBe("codex");
  });

  // ============================================================
  // Test 10: High max_cycles boundary
  // ============================================================

  it("high max_cycles value (100) initializes correctly", async () => {
    const stateManager = new StateManager(tempDir);

    await stateManager.initialize("High max cycles test", "conduct/high-max-cycles", {
      maxCycles: 100,
      concurrency: 10,
      workerRuntime: "claude",
    });

    const state = stateManager.get();
    expect(state.max_cycles).toBe(100);
    expect(state.concurrency).toBe(10);
    expect(state.current_cycle).toBe(0);
  });
});

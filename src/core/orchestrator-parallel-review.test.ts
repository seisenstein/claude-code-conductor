/**
 * Orchestrator H-4 Promise.allSettled parallel review legs [T-1]
 *
 * Verifies the Phase-3 `Promise.allSettled` behavior at
 * `src/core/orchestrator.ts:456-550`:
 *   - All three legs (code review, flow tracing, design-spec update) run
 *     independently; a failure in any one does not silently drop sibling
 *     results.
 *   - Per-leg timing (code_review_ms, flow_tracing_ms) is recorded via
 *     chained then() handlers BEFORE `Promise.allSettled` aggregation,
 *     so rejected legs still produce a finite, non-negative duration.
 *   - A rejected flow-tracing leg synthesizes a high-severity
 *     `FlowTracingReport` with the documented shape.
 *   - A rejected code-review leg forces `approved === false` and the
 *     cycle to repeat.
 *   - A rejected design-spec leg logs a warning but is non-fatal.
 *
 * Harness approach (per Codex plan-review round 2): construct a real
 * `Orchestrator`, then reassign internal collaborators via `as any`
 * cast and spy private Phase-3 methods for deterministic control.
 * Unrelated gates (pre-Phase-3 setup, checkpoint, fix-task creation)
 * are stubbed so each test focuses on the allSettled branch behavior.
 *
 * @module orchestrator-parallel-review.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Mock the SDK BEFORE importing Orchestrator (vitest hoists vi.mock()).
// These tests never reach the SDK (all Phase-3 methods are spied), but
// constructing a real Orchestrator touches modules that import the SDK.
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

// Mock child_process for codex CLI
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execSync: vi.fn(() => Buffer.from("")),
}));

// Mock readline to avoid interactive prompts during checkInitStatus
vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: vi.fn().mockResolvedValue("y"),
      close: vi.fn(),
    })),
  },
}));

import { Orchestrator } from "./orchestrator.js";
import { StateManager } from "./state-manager.js";
import type { CLIOptions, FlowTracingReport } from "../utils/types.js";
import { DEFAULT_MODEL_CONFIG } from "../utils/types.js";
import {
  createMockWorkerManager,
  createMockPlanner,
  createMockCodexReviewer,
  createMockFlowTracer,
  createTempProjectDir,
  cleanupTempDir,
} from "./__tests__/orchestrator-test-utils.js";

// ============================================================
// Test Setup Helpers
// ============================================================

function createTestOptions(projectDir: string, overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    project: projectDir,
    feature: "T-1 parallel review test",
    concurrency: 1,
    // maxCycles: 1 so the run() loop executes exactly one cycle, then exits.
    maxCycles: 1,
    usageThreshold: 0.8,
    skipCodex: true,
    skipFlowReview: false, // we need Phase 3 to run
    skipDesignSpecUpdate: false,
    dryRun: false,
    resume: false,
    verbose: false,
    contextFile: null,
    currentBranch: true,
    workerRuntime: "claude",
    forceResume: false,
    modelConfig: DEFAULT_MODEL_CONFIG,
    ...overrides,
  };
}

/**
 * Install the private-field-reassignment + spy harness onto an Orchestrator.
 *
 * Reassigns `workers`, `planner`, `codex`, `flowTracer` with factory mocks.
 * Spies on the Phase-3 methods per the T-1 spec. Also stubs pre-Phase-3
 * methods (`initialize`, `checkInitStatus`, `plan`, `execute`, `complete`)
 * and helpers that block without network/git access. `initialize` is
 * replaced with a minimal stub that initializes the StateManager so the
 * cycle loop has a valid state shape.
 */
async function installHarness(
  orch: Orchestrator,
  projectDir: string,
  reviewOutcome: "resolve" | "reject",
  flowOutcome: "resolve" | "reject" | "null",
  designOutcome: "resolve" | "reject",
): Promise<{
  stateManager: StateManager;
  createFixSpy: ReturnType<typeof vi.spyOn>;
  warnSpy: ReturnType<typeof vi.spyOn>;
  errorSpy: ReturnType<typeof vi.spyOn>;
  reviewSpy: ReturnType<typeof vi.spyOn>;
  flowSpy: ReturnType<typeof vi.spyOn>;
  designSpy: ReturnType<typeof vi.spyOn>;
  checkpointSpy: ReturnType<typeof vi.spyOn>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orchAny = orch as any;

  // Step 2 (spec): reassign internal collaborators via cast.
  orchAny.workers = createMockWorkerManager();
  orchAny.planner = createMockPlanner();
  orchAny.codex = createMockCodexReviewer({ available: false });
  orchAny.flowTracer = createMockFlowTracer();

  // Initialize state manager with a fresh state (bypasses the real
  // initialize() method which needs git + directory setup).
  const stateManager = orchAny.state as StateManager;
  await stateManager.initialize("T-1 parallel review test", "conduct/t1-test", {
    maxCycles: 1,
    concurrency: 1,
    workerRuntime: "claude",
  });
  await stateManager.createDirectories();

  // Step 4 (spec): stub unrelated gates.
  // Replace `initialize` with a no-op since we already set up state.
  vi.spyOn(orchAny, "initialize").mockResolvedValue(undefined);
  vi.spyOn(orchAny, "checkInitStatus").mockResolvedValue(undefined);
  vi.spyOn(orchAny, "clearStaleOrchestratorMessages").mockResolvedValue(undefined);
  vi.spyOn(orchAny, "plan").mockResolvedValue(1);
  vi.spyOn(orchAny, "execute").mockResolvedValue(undefined);
  vi.spyOn(orchAny, "ensureProviderCapacity").mockResolvedValue(true);
  vi.spyOn(orchAny, "computeBlastRadius").mockResolvedValue({
    files_touched: [],
    max_risk_level: "low",
    directory_fan_out: 0,
  });
  vi.spyOn(orchAny, "complete").mockResolvedValue(undefined);
  // Stub the conventions/design-spec utility method (not a module fn here —
  // the orchestrator reads `this.conventions`/`this.designSpec` after
  // extractConventions/loadDesignSpec returns; we bypass both by patching
  // the modules below via direct function replacement on the instance).
  // Since extractConventions is a module-level import, stub it by setting
  // `this.conventions` on orch and short-circuiting via run-order spies.
  // The pre-Phase-3 work happens between `execute()` and the Phase-3 block;
  // we spy on the pieces that block.
  const checkpointSpy = vi.spyOn(orchAny, "checkpoint").mockResolvedValue("complete");
  const createFixSpy = vi.spyOn(orchAny, "createFixTasksFromFindings").mockResolvedValue(undefined);

  // Step 3 (spec): spy Phase-3 methods.
  const reviewSpy =
    reviewOutcome === "resolve"
      ? vi.spyOn(orchAny, "review").mockResolvedValue(true)
      : vi.spyOn(orchAny, "review").mockRejectedValue(new Error("review crashed"));
  const flowSpy =
    flowOutcome === "resolve"
      ? vi.spyOn(orchAny, "flowReview").mockResolvedValue({
          generated_at: new Date().toISOString(),
          flows_traced: 1,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0, cross_boundary_count: 0 },
        } as FlowTracingReport)
      : flowOutcome === "null"
        ? vi.spyOn(orchAny, "flowReview").mockResolvedValue(null)
        : vi.spyOn(orchAny, "flowReview").mockRejectedValue(new Error("tracer crashed"));
  const designSpy =
    designOutcome === "resolve"
      ? vi.spyOn(orchAny, "updateDesignSpecIfNeeded").mockResolvedValue(null)
      : vi.spyOn(orchAny, "updateDesignSpecIfNeeded").mockRejectedValue(new Error("design spec crashed"));

  // escalateToUser would prompt stdin. Stub to return "continue" so A-7 path
  // (counter >= 2) doesn't block the run. Only reachable if the same Orchestrator
  // is reused across multiple cycles — not in these single-cycle tests, but
  // defensive.
  vi.spyOn(orchAny, "escalateToUser").mockResolvedValue("continue");

  // Avoid extractConventions / loadWorkerRules / loadDesignSpec calls reaching
  // the network: the run() code path calls them between `execute()` and
  // Phase 3. Since those are module-level imports, we can't spy on them via
  // the instance. Instead, set the state ahead so the orchestrator has
  // pre-populated values and the module calls return the cached/default
  // results for an empty project dir (all three tolerate missing files).
  // extractConventions hits the SDK via a spawned agent — which the SDK
  // mock above intercepts to yield no messages and return a default result.
  // That still takes some time, so we intercept the module function by
  // spying on it at the instance level: patch `this.conventions` etc.
  // Simpler: spy on the orchestrator's `setWorkerContext` usage by stubbing
  // the whole between-execute-and-phase3 block. We already spy on `execute`,
  // so after execute returns, the orchestrator runs conventions extraction.
  // To skip that, also spy on the extractConventions import via a module
  // mock. Done in vi.mock block at the top would be cleanest; do it here
  // with a direct property assignment on the module namespace.

  // Capture logger output (the test logger lives inside the Orchestrator).
  const warnSpy = vi.spyOn(orchAny.logger, "warn");
  const errorSpy = vi.spyOn(orchAny.logger, "error");

  return {
    stateManager,
    createFixSpy,
    warnSpy,
    errorSpy,
    reviewSpy,
    flowSpy,
    designSpy,
    checkpointSpy,
  };
}

// Mock the module-level utility imports used between execute() and Phase 3,
// so we don't need to spawn real SDK sessions for conventions extraction.
vi.mock("../utils/conventions-extractor.js", () => ({
  extractConventions: vi.fn().mockResolvedValue({
    auth_patterns: [],
    validation_patterns: [],
    error_handling_patterns: [],
    test_patterns: [],
    directory_structure: "",
    naming_conventions: [],
    libraries: [],
    security_invariants: [],
  }),
}));

vi.mock("../utils/rules-loader.js", () => ({
  loadWorkerRules: vi.fn().mockResolvedValue(""),
}));

vi.mock("../utils/design-spec-analyzer.js", () => ({
  loadDesignSpec: vi.fn().mockResolvedValue(undefined),
}));

// known-issues writes to disk — passthrough is fine with a temp dir, but
// stub out to avoid any filesystem race with the atomic writer in tests.
vi.mock("../utils/known-issues.js", () => ({
  addKnownIssues: vi.fn().mockResolvedValue(undefined),
  getUnresolvedIssues: vi.fn().mockResolvedValue([]),
}));

// ============================================================
// T-1 Tests — Phase-3 Promise.allSettled behavior
// ============================================================

describe("Orchestrator H-4 Promise.allSettled parallel review legs [T-1]", () => {
  let tempDir: string;
  let orch: Orchestrator;

  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".conductor/\n");
    orch = new Orchestrator(createTestOptions(tempDir));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it("all three legs succeed — approved, flow report present, no synthetic finding", async () => {
    const { stateManager, createFixSpy, checkpointSpy } = await installHarness(
      orch,
      tempDir,
      "resolve",
      "resolve",
      "resolve",
    );

    await orch.run();

    // Checkpoint ran (cycle reached Phase 4).
    expect(checkpointSpy).toHaveBeenCalled();

    // Observable: the flowReport passed to createFixTasksFromFindings
    // should NOT contain a synthetic finding (all legs succeeded, the
    // mock FlowTracer returns an empty-findings report). Since summary
    // has no critical/high, createFixTasksFromFindings is only called if
    // the branch at orchestrator.ts:571 triggers — which it won't here.
    // So expect zero calls.
    expect(createFixSpy).not.toHaveBeenCalled();

    // Phase-3 durations: both must be finite + non-negative.
    const finalState = stateManager.get();
    expect(finalState.cycle_history).toHaveLength(1);
    const durations = finalState.cycle_history[0].phase_durations;
    const codeReviewMs = durations?.code_review_ms;
    const flowTracingMs = durations?.flow_tracing_ms;
    expect(Number.isFinite(codeReviewMs) && (codeReviewMs as number) >= 0).toBe(true);
    expect(Number.isFinite(flowTracingMs) && (flowTracingMs as number) >= 0).toBe(true);
  });

  it("code-review leg rejects — approved=false, error logged, cycle forced to repeat", async () => {
    const { stateManager, errorSpy, warnSpy, createFixSpy } = await installHarness(
      orch,
      tempDir,
      "reject",
      "resolve",
      "resolve",
    );

    await orch.run();

    // Error should be logged from the rejection handler at orchestrator.ts:473.
    const errorCalls = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((m) => m.includes("Code review rejected"))).toBe(true);

    // Warn should fire from the "Code review not approved" branch (line 582),
    // which runs when approved=false AND result==="complete" from checkpoint.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("Code review not approved"))).toBe(true);

    // The cycle record should reflect non-approval.
    const finalState = stateManager.get();
    expect(finalState.cycle_history).toHaveLength(1);
    expect(finalState.cycle_history[0].codex_code_approved).toBe(false);

    // Sibling (flow) leg still produced a result: since flow returned a
    // report with 0 findings, createFixTasksFromFindings should not have been
    // called (branch at 571 requires critical/high > 0).
    expect(createFixSpy).not.toHaveBeenCalled();

    // Durations still finite.
    const durations = finalState.cycle_history[0].phase_durations;
    expect(Number.isFinite(durations?.code_review_ms) && (durations!.code_review_ms as number) >= 0).toBe(true);
    expect(Number.isFinite(durations?.flow_tracing_ms) && (durations!.flow_tracing_ms as number) >= 0).toBe(true);
  });

  it("flow-tracing leg rejects — synthetic FlowTracingReport shape is valid", async () => {
    const { stateManager, errorSpy, createFixSpy } = await installHarness(
      orch,
      tempDir,
      "resolve",
      "reject",
      "resolve",
    );

    await orch.run();

    // Error logged from rejection handler at orchestrator.ts:504.
    const errorCalls = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((m) => m.includes("Flow tracing rejected"))).toBe(true);

    // The synthetic FlowTracingReport has high-severity=1, which triggers the
    // branch at orchestrator.ts:571 and calls createFixTasksFromFindings with
    // the synthetic report. Assert shape via captured argument.
    expect(createFixSpy).toHaveBeenCalled();
    const flowReportArg = createFixSpy.mock.calls[0][0] as FlowTracingReport;

    expect(flowReportArg).toMatchObject({
      generated_at: expect.any(String),
      flows_traced: 0,
      summary: { critical: 0, high: 1, medium: 0, low: 0, total: 1, cross_boundary_count: 0 },
    });
    expect(flowReportArg.findings).toHaveLength(1);
    expect(flowReportArg.findings[0]).toMatchObject({
      flow_id: expect.stringMatching(/^flow-tracing-failure-cycle-\d+$/),
      severity: "high",
      actor: "conductor",
      file_path: "<flow-tracing-infrastructure>",
      cross_boundary: false,
    });

    // A-7 suppression (separately tested) means createFixTasksFromFindings
    // would internally skip this finding — here we only assert the synthetic
    // report is what was passed in. No other findings should be present.

    // The counter should have incremented to 1 (single rejection).
    const finalState = stateManager.get();
    expect(finalState.consecutive_flow_tracing_failures).toBe(1);

    // Durations still finite + non-negative even on rejection.
    const durations = finalState.cycle_history[0].phase_durations;
    expect(Number.isFinite(durations?.code_review_ms) && (durations!.code_review_ms as number) >= 0).toBe(true);
    expect(Number.isFinite(durations?.flow_tracing_ms) && (durations!.flow_tracing_ms as number) >= 0).toBe(true);
  });

  it("design-spec leg rejects — warning logged, approved and flowReport unaffected", async () => {
    const { stateManager, warnSpy, createFixSpy } = await installHarness(
      orch,
      tempDir,
      "resolve",
      "resolve",
      "reject",
    );

    await orch.run();

    // Warning from orchestrator.ts:549.
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("Design spec update failed") && m.includes("non-fatal"))).toBe(true);

    // Approved should still be true (code review succeeded).
    const finalState = stateManager.get();
    expect(finalState.cycle_history[0].codex_code_approved).toBe(true);

    // Flow report had no findings → no fix tasks.
    expect(createFixSpy).not.toHaveBeenCalled();

    // Cycle proceeds (completes normally).
    expect(finalState.cycle_history).toHaveLength(1);

    // Durations still finite.
    const durations = finalState.cycle_history[0].phase_durations;
    expect(Number.isFinite(durations?.code_review_ms) && (durations!.code_review_ms as number) >= 0).toBe(true);
    expect(Number.isFinite(durations?.flow_tracing_ms) && (durations!.flow_tracing_ms as number) >= 0).toBe(true);
  });

  it("review AND flowReview reject simultaneously — both handlers run, no sibling loss", async () => {
    const { stateManager, errorSpy, createFixSpy } = await installHarness(
      orch,
      tempDir,
      "reject",
      "reject",
      "resolve",
    );

    await orch.run();

    // BOTH rejection-branch error logs should fire — this is the "no sibling
    // loss" invariant for H-4.
    const errorCalls = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((m) => m.includes("Code review rejected"))).toBe(true);
    expect(errorCalls.some((m) => m.includes("Flow tracing rejected"))).toBe(true);

    // approved=false recorded.
    const finalState = stateManager.get();
    expect(finalState.cycle_history[0].codex_code_approved).toBe(false);

    // Synthetic flowReport is present and reaches createFixTasksFromFindings.
    expect(createFixSpy).toHaveBeenCalled();
    const flowReportArg = createFixSpy.mock.calls[0][0] as FlowTracingReport;
    expect(flowReportArg.summary.high).toBe(1);
    expect(flowReportArg.findings[0].file_path).toBe("<flow-tracing-infrastructure>");

    // Durations still finite + non-negative on double-reject.
    const durations = finalState.cycle_history[0].phase_durations;
    expect(Number.isFinite(durations?.code_review_ms) && (durations!.code_review_ms as number) >= 0).toBe(true);
    expect(Number.isFinite(durations?.flow_tracing_ms) && (durations!.flow_tracing_ms as number) >= 0).toBe(true);
  });
});

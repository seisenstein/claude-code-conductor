/**
 * Shared Test Utilities for Orchestrator Integration Tests
 *
 * This file provides reusable mock factories for testing the orchestrator's
 * integration with its dependencies (Planner, WorkerManager, CodexReviewer,
 * FlowTracer, UsageMonitor, Logger).
 *
 * Usage:
 *   import {
 *     createMockPlanner,
 *     createMockWorkerManager,
 *     createMockCodexReviewer,
 *     createMockFlowTracer,
 *     createMockUsageMonitor,
 *     createMockLogger,
 *     createTempProjectDir,
 *     cleanupTempDir,
 *   } from "./orchestrator-test-utils.js";
 *
 * @module orchestrator-test-utils
 */

import { vi } from "vitest";
import type { Mock } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type {
  TaskDefinition,
  PlannerOutput,
  ThreatModel,
  ExecutionWorkerManager,
  OrchestratorEvent,
  WorkerSharedContext,
  WorkerHealthStatus,
  TaskRetryTrackerInterface,
  FlowTracingReport,
  FlowFinding,
  UsageSnapshot,
  ProviderUsageMonitor,
  CodexReviewResult,
  CodexVerdict,
  CodexUsageMetrics,
} from "../../utils/types.js";

import {
  TASKS_DIR,
  SESSIONS_DIR,
  MESSAGES_DIR,
  LOGS_DIR,
  ORCHESTRATOR_DIR,
} from "../../utils/constants.js";

// ============================================================
// Mock Planner Factory
// ============================================================

export interface MockPlanner {
  plan: Mock<(feature: string, redirectGuidance?: string, knownIssuesSummary?: string) => Promise<PlannerOutput>>;
  askQuestions: Mock<(feature: string) => Promise<string>>;
  setQaContext: Mock<(context: string) => void>;
  setConventions: Mock<(conventions: unknown) => void>;
}

export interface CreateMockPlannerOptions {
  /** Tasks to return from plan() */
  tasks?: TaskDefinition[];
  /** Threat model to return from plan() */
  threatModel?: ThreatModel;
  /** Plan markdown to return from plan() */
  planMarkdown?: string;
  /** Q&A context to return from askQuestions() */
  qaContext?: string;
  /** Error to throw from plan() */
  planError?: Error;
  /** Anchor task subjects */
  anchorTaskSubjects?: string[];
}

/**
 * Creates a mock Planner with vi.fn() methods.
 * Configure return values via options.
 */
export function createMockPlanner(options: CreateMockPlannerOptions = {}): MockPlanner {
  const {
    tasks = [],
    threatModel,
    planMarkdown = "# Test Plan\n\nThis is a test plan.",
    qaContext = "Q: Test question?\nA: Test answer.",
    planError,
    anchorTaskSubjects = [],
  } = options;

  const planOutput: PlannerOutput = {
    plan_markdown: planMarkdown,
    tasks,
    threat_model: threatModel,
    anchor_task_subjects: anchorTaskSubjects,
  };

  return {
    plan: vi.fn().mockImplementation(async () => {
      if (planError) throw planError;
      return planOutput;
    }),
    askQuestions: vi.fn().mockResolvedValue(qaContext),
    setQaContext: vi.fn(),
    setConventions: vi.fn(),
  };
}

// ============================================================
// Mock WorkerManager Factory
// ============================================================

export interface MockWorkerManager extends ExecutionWorkerManager {
  spawnWorker: Mock<(sessionId: string) => Promise<void>>;
  spawnSentinelWorker: Mock<() => Promise<void>>;
  getActiveWorkers: Mock<() => string[]>;
  isWorkerActive: Mock<(sessionId: string) => boolean>;
  signalWindDown: Mock<(reason: string, resetsAt?: string) => Promise<void>>;
  waitForAllWorkers: Mock<(timeoutMs: number) => Promise<void>>;
  killAllWorkers: Mock<() => Promise<void>>;
  getWorkerEvents: Mock<() => OrchestratorEvent[]>;
  setWorkerContext: Mock<(context: WorkerSharedContext) => void>;
  checkWorkerHealth: Mock<() => WorkerHealthStatus>;
  getRetryTracker: Mock<() => TaskRetryTrackerInterface | null>;
}

export interface CreateMockWorkerManagerOptions {
  /** List of active worker session IDs */
  activeWorkers?: string[];
  /** Events to return from getWorkerEvents() (consumed on each call) */
  workerEvents?: OrchestratorEvent[];
  /** Worker health status */
  healthStatus?: WorkerHealthStatus;
  /** Whether to return a retry tracker */
  includeRetryTracker?: boolean;
  /** Callback when spawnWorker is called (for side effects) */
  onSpawnWorker?: (sessionId: string) => void;
  /** Delay before workers "complete" (simulates async work) */
  spawnDelayMs?: number;
}

/**
 * Creates a mock WorkerManager implementing ExecutionWorkerManager interface.
 * Configure active workers, events, and health status via options.
 */
export function createMockWorkerManager(
  options: CreateMockWorkerManagerOptions = {},
): MockWorkerManager {
  const {
    activeWorkers = [],
    workerEvents = [],
    healthStatus = { timedOut: [], stale: [] },
    includeRetryTracker = true,
    onSpawnWorker,
    spawnDelayMs = 0,
  } = options;

  // Event queue - events are consumed when getWorkerEvents() is called
  const eventQueue: OrchestratorEvent[] = [...workerEvents];

  // Mock retry tracker
  const retryTracker: TaskRetryTrackerInterface = {
    recordFailure: vi.fn(),
    shouldRetry: vi.fn().mockReturnValue(true),
    getRetryContext: vi.fn().mockReturnValue(null),
    getRetryCount: vi.fn().mockReturnValue(0),
    getLastError: vi.fn().mockReturnValue(null),
  };

  return {
    spawnWorker: vi.fn().mockImplementation(async (sessionId: string) => {
      if (spawnDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
      }
      onSpawnWorker?.(sessionId);
    }),
    spawnSentinelWorker: vi.fn().mockResolvedValue(undefined),
    getActiveWorkers: vi.fn().mockReturnValue(activeWorkers),
    isWorkerActive: vi.fn().mockImplementation((sessionId: string) =>
      activeWorkers.includes(sessionId),
    ),
    signalWindDown: vi.fn().mockResolvedValue(undefined),
    waitForAllWorkers: vi.fn().mockResolvedValue(undefined),
    killAllWorkers: vi.fn().mockResolvedValue(undefined),
    getWorkerEvents: vi.fn().mockImplementation(() => {
      const events = [...eventQueue];
      eventQueue.length = 0;
      return events;
    }),
    setWorkerContext: vi.fn(),
    checkWorkerHealth: vi.fn().mockReturnValue(healthStatus),
    getRetryTracker: vi.fn().mockReturnValue(includeRetryTracker ? retryTracker : null),
  };
}

/**
 * Helper to push events to a mock worker manager's event queue.
 * Must access the internal queue through the mock implementation.
 */
export function pushWorkerEvents(
  manager: MockWorkerManager,
  events: OrchestratorEvent[],
): void {
  // Create new implementation that includes the new events
  const existingImpl = manager.getWorkerEvents.getMockImplementation();
  const currentEvents: OrchestratorEvent[] = [];

  // Preserve any events that were added before
  if (existingImpl) {
    currentEvents.push(...(existingImpl() as OrchestratorEvent[]));
  }
  currentEvents.push(...events);

  manager.getWorkerEvents.mockImplementation(() => {
    const result = [...currentEvents];
    currentEvents.length = 0;
    return result;
  });
}

// ============================================================
// Mock CodexReviewer Factory
// ============================================================

export interface MockCodexReviewer {
  isAvailable: Mock<() => Promise<boolean>>;
  reviewPlan: Mock<(plan: string, feedback?: string, knownIssues?: string) => Promise<CodexReviewResult>>;
  reviewCode: Mock<(diff: string, summary: string) => Promise<CodexReviewResult>>;
  getMetrics: Mock<() => CodexUsageMetrics>;
}

export interface CreateMockCodexReviewerOptions {
  /** Whether Codex is available */
  available?: boolean;
  /** Default verdict for plan review */
  planVerdict?: CodexVerdict;
  /** Default verdict for code review */
  codeVerdict?: CodexVerdict;
  /** Issues to return */
  issues?: string[];
  /** Sequence of verdicts for plan review (overrides planVerdict) */
  planVerdictSequence?: CodexVerdict[];
  /** Sequence of verdicts for code review (overrides codeVerdict) */
  codeVerdictSequence?: CodexVerdict[];
  /** Metrics to return */
  metrics?: CodexUsageMetrics;
}

/**
 * Creates a mock CodexReviewer with configurable review behavior.
 * Use verdict sequences to test multi-round review loops.
 */
export function createMockCodexReviewer(
  options: CreateMockCodexReviewerOptions = {},
): MockCodexReviewer {
  const {
    available = true,
    planVerdict = "APPROVE",
    codeVerdict = "APPROVE",
    issues = [],
    planVerdictSequence,
    codeVerdictSequence,
    metrics = {
      invocations: 0,
      successes: 0,
      invalid_responses: 0,
      presumed_rate_limits: 0,
      last_presumed_rate_limit_at: null,
      output_too_large_failures: 0, // CR-2
      execution_errors: 0, // H-16
    },
  } = options;

  let planCallCount = 0;
  let codeCallCount = 0;

  return {
    isAvailable: vi.fn().mockResolvedValue(available),
    reviewPlan: vi.fn().mockImplementation(async (): Promise<CodexReviewResult> => {
      const verdict = planVerdictSequence
        ? planVerdictSequence[Math.min(planCallCount++, planVerdictSequence.length - 1)]
        : planVerdict;
      return {
        verdict,
        raw_output: `Plan review verdict: ${verdict}`,
        issues,
        file_path: "plan.md",
      };
    }),
    reviewCode: vi.fn().mockImplementation(async (): Promise<CodexReviewResult> => {
      const verdict = codeVerdictSequence
        ? codeVerdictSequence[Math.min(codeCallCount++, codeVerdictSequence.length - 1)]
        : codeVerdict;
      return {
        verdict,
        raw_output: `Code review verdict: ${verdict}`,
        issues,
        file_path: "code-review.md",
      };
    }),
    getMetrics: vi.fn().mockReturnValue(metrics),
  };
}

// ============================================================
// Mock FlowTracer Factory
// ============================================================

export interface MockFlowTracer {
  trace: Mock<(changedFiles: string[], diff: string, cycle: number) => Promise<FlowTracingReport>>;
}

export interface CreateMockFlowTracerOptions {
  /** Findings to include in the report */
  findings?: FlowFinding[];
  /** Number of flows traced */
  flowsTraced?: number;
  /** Error to throw from trace() */
  traceError?: Error;
}

/**
 * Creates a mock FlowTracer with configurable trace results.
 */
export function createMockFlowTracer(
  options: CreateMockFlowTracerOptions = {},
): MockFlowTracer {
  const { findings = [], flowsTraced = 1, traceError } = options;

  const summary = {
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    total: findings.length,
    cross_boundary_count: findings.filter((f) => f.cross_boundary).length,
  };

  const report: FlowTracingReport = {
    generated_at: new Date().toISOString(),
    flows_traced: flowsTraced,
    findings,
    summary,
  };

  return {
    trace: vi.fn().mockImplementation(async () => {
      if (traceError) throw traceError;
      return report;
    }),
  };
}

/**
 * Creates a sample FlowFinding for testing.
 */
export function createMockFlowFinding(
  overrides: Partial<FlowFinding> = {},
): FlowFinding {
  return {
    flow_id: "flow-001",
    severity: "medium",
    actor: "authenticated_user",
    title: "Test finding",
    description: "This is a test finding",
    file_path: "src/test.ts",
    line_number: 42,
    cross_boundary: false,
    ...overrides,
  };
}

// ============================================================
// Mock UsageMonitor Factory
// ============================================================

export interface MockUsageMonitor extends ProviderUsageMonitor {
  start: Mock<() => void>;
  stop: Mock<() => void>;
  getUsage: Mock<() => UsageSnapshot>;
  poll: Mock<() => Promise<UsageSnapshot>>;
  isWindDownNeeded: Mock<() => boolean>;
  isCritical: Mock<() => boolean>;
  getResetTime: Mock<() => string | null>;
  waitForReset: Mock<() => Promise<void>>;
  isDataStale: Mock<() => boolean>;
  getConsecutiveFailures: Mock<() => number>;
  getStaleDurationMs: Mock<() => number>;
}

export interface CreateMockUsageMonitorOptions {
  /** Provider type */
  provider?: "claude" | "codex";
  /** Current usage snapshot */
  usage?: UsageSnapshot;
  /** Whether wind-down is needed */
  windDownNeeded?: boolean;
  /** Whether usage is critical */
  critical?: boolean;
  /** Reset time for critical usage */
  resetTime?: string | null;
  /** Whether data is stale */
  stale?: boolean;
  /** Number of consecutive failures */
  consecutiveFailures?: number;
}

/**
 * Creates a mock UsageMonitor implementing ProviderUsageMonitor interface.
 */
export function createMockUsageMonitor(
  options: CreateMockUsageMonitorOptions = {},
): MockUsageMonitor {
  const {
    provider = "claude",
    usage = {
      five_hour: 0.2,
      seven_day: 0.1,
      five_hour_resets_at: null,
      seven_day_resets_at: null,
      last_checked: new Date().toISOString(),
    },
    windDownNeeded = false,
    critical = false,
    resetTime = null,
    stale = false,
    consecutiveFailures = 0,
  } = options;

  return {
    provider,
    start: vi.fn(),
    stop: vi.fn(),
    getUsage: vi.fn().mockReturnValue(usage),
    poll: vi.fn().mockResolvedValue(usage),
    isWindDownNeeded: vi.fn().mockReturnValue(windDownNeeded),
    isCritical: vi.fn().mockReturnValue(critical),
    getResetTime: vi.fn().mockReturnValue(resetTime),
    waitForReset: vi.fn().mockResolvedValue(undefined),
    isDataStale: vi.fn().mockReturnValue(stale),
    getConsecutiveFailures: vi.fn().mockReturnValue(consecutiveFailures),
    getStaleDurationMs: vi.fn().mockReturnValue(0),
    getUsageRatePerMinute: vi.fn().mockReturnValue(null),
    estimateMinutesUntilThreshold: vi.fn().mockReturnValue(null),
    isThresholdPredicted: vi.fn().mockReturnValue(false),
    getRateSummary: vi.fn().mockReturnValue("rate: insufficient data"),
  };
}

// ============================================================
// Mock Logger Factory
// ============================================================

export interface MockLogger {
  info: Mock<(message: string) => void>;
  warn: Mock<(message: string) => void>;
  error: Mock<(message: string) => void>;
  debug: Mock<(message: string) => void>;
  close: Mock<() => void>;
}

/**
 * Creates a mock Logger with vi.fn() methods for all log levels.
 */
export function createMockLogger(): MockLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    close: vi.fn(),
  };
}

// ============================================================
// Temp Directory Utilities
// ============================================================

/**
 * Creates a temporary project directory with the .conductor structure.
 * Subdirectories created: tasks/, sessions/, messages/, logs/
 *
 * @returns Path to the temporary project directory
 */
export async function createTempProjectDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "conductor-integration-test-"),
  );

  const conductorDir = path.join(tempDir, ORCHESTRATOR_DIR);
  await fs.mkdir(conductorDir, { recursive: true, mode: 0o700 });

  // Create subdirectories
  await Promise.all([
    fs.mkdir(path.join(conductorDir, TASKS_DIR), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(conductorDir, SESSIONS_DIR), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(conductorDir, MESSAGES_DIR), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(conductorDir, LOGS_DIR), { recursive: true, mode: 0o700 }),
  ]);

  return tempDir;
}

/**
 * Safely cleans up a temporary directory.
 * Silently ignores errors (e.g., if already deleted).
 *
 * @param tempDir Path to the temporary directory to clean up
 */
export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================
// Task Definition Helpers
// ============================================================

/**
 * Creates a sample TaskDefinition for testing.
 */
export function createMockTaskDefinition(
  overrides: Partial<TaskDefinition> = {},
): TaskDefinition {
  return {
    subject: "Test task",
    description: "This is a test task",
    depends_on_subjects: [],
    estimated_complexity: "small",
    task_type: "general",
    security_requirements: [],
    performance_requirements: [],
    acceptance_criteria: ["Task completes successfully"],
    risk_level: "low",
    ...overrides,
  };
}

/**
 * Creates multiple TaskDefinitions with sequential numbering.
 */
export function createMockTaskDefinitions(
  count: number,
  baseOverrides: Partial<TaskDefinition> = {},
): TaskDefinition[] {
  return Array.from({ length: count }, (_, i) =>
    createMockTaskDefinition({
      subject: `Task ${i + 1}`,
      description: `Description for task ${i + 1}`,
      ...baseOverrides,
    }),
  );
}

// ============================================================
// Threat Model Helper
// ============================================================

/**
 * Creates a sample ThreatModel for testing.
 */
export function createMockThreatModel(
  overrides: Partial<ThreatModel> = {},
): ThreatModel {
  return {
    feature_summary: "Test feature",
    data_flows: ["User -> API -> Database"],
    trust_boundaries: ["Client/Server boundary"],
    attack_surfaces: [
      {
        surface: "API endpoint",
        threat_category: "Spoofing",
        mitigation: "Authentication required",
      },
    ],
    unmapped_mitigations: [],
    ...overrides,
  };
}

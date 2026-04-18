// ============================================================
// Error Types
// ============================================================

/**
 * Typed error thrown instead of process.exit() in the orchestrator.
 * Allows finally blocks to run cleanup (event log flush, state save,
 * orphaned worker termination) before the CLI layer translates the
 * error into the appropriate process.exit() call.
 */
export class ConductorExitError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly reason: string,
  ) {
    super(`Conductor exit (code ${exitCode}): ${reason}`);
    this.name = "ConductorExitError";
  }
}

// ============================================================
// Orchestrator State Types
// ============================================================

export interface OrchestratorState {
  status: OrchestratorStatus;
  feature: string;
  project_path: string;
  branch: string;
  worker_runtime: WorkerRuntime;
  model_config?: ModelConfig;
  base_commit_sha: string | null;
  current_cycle: number;
  max_cycles: number;
  concurrency: number;
  started_at: string;
  updated_at: string;
  paused_at: string | null;
  resume_after: string | null;
  usage: UsageSnapshot;
  claude_usage: UsageSnapshot | null;
  codex_usage: UsageSnapshot | null;
  codex_metrics: CodexUsageMetrics | null;
  /** @deprecated Dead state fields — task completion/failure is tracked via individual task files and cycle_history. Kept optional for backward compatibility with existing state.json files. */
  completed_task_ids?: string[];
  /** @deprecated Dead state fields — task completion/failure is tracked via individual task files and cycle_history. Kept optional for backward compatibility with existing state.json files. */
  failed_task_ids?: string[];
  active_session_ids: string[];
  cycle_history: CycleRecord[];
  progress: string;
  usage_threshold?: number; // Wind-down usage threshold (0-1), preserved across resume
}

export type OrchestratorStatus =
  | "initializing"
  | "questioning"
  | "planning"
  | "executing"
  | "reviewing"
  | "flow_tracing"
  | "checkpointing"
  | "paused"
  | "completed"
  | "failed"
  | "escalated";

export interface PhaseDurations {
  planning_ms?: number;
  conventions_ms?: number;
  codex_plan_review_ms?: number;
  execution_ms?: number;
  code_review_ms?: number;
  flow_tracing_ms?: number;
  checkpoint_ms?: number;
}

export interface CycleRecord {
  cycle: number;
  plan_version: number;
  tasks_completed: number;
  tasks_failed: number;
  codex_plan_approved: boolean;
  codex_code_approved: boolean;
  plan_discussion_rounds: number;
  code_review_rounds: number;
  duration_ms: number;
  started_at: string;
  completed_at: string;
  flow_tracing?: FlowTracingSummary;
  phase_durations?: PhaseDurations;
  blast_radius?: BlastRadius;
}

export interface BlastRadius {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  critical_files_touched: string[];
  warnings: string[];
}

export interface FlowTracingSummary {
  flows_traced: number;
  total_findings: number;
  critical_findings: number;
  high_findings: number;
  duration_ms: number;
}

// ============================================================
// Task Types
// ============================================================

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  depends_on: string[];
  blocks: string[];
  result_summary: string | null;
  files_changed: string[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  task_type?: TaskType;
  security_requirements?: string[];
  performance_requirements?: string[];
  acceptance_criteria?: string[];
  risk_level?: "low" | "medium" | "high";
  // V2: Worker resilience fields
  retry_count?: number; // Number of retry attempts (0 = first attempt)
  last_error?: string; // Error message from previous attempt (sanitized)
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

// ============================================================
// Session Types
// ============================================================

export interface SessionStatus {
  session_id: string;
  state: SessionState;
  current_task: string | null;
  tasks_completed: string[];
  progress: string;
  updated_at: string;
}

export type SessionState = "starting" | "working" | "idle" | "pausing" | "paused" | "done" | "failed";

// ============================================================
// Message Types
// ============================================================

export interface Message {
  id: string;
  from: string;
  type: MessageType;
  to?: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export type MessageType =
  | "status"
  | "question"
  | "answer"
  | "broadcast"
  | "wind_down"
  | "task_completed"
  | "error"
  | "escalation";

// ============================================================
// Usage Types
// ============================================================

export interface UsageSnapshot {
  five_hour: number; // 0.0 - 1.0
  seven_day: number; // 0.0 - 1.0
  five_hour_resets_at: string | null;
  seven_day_resets_at: string | null;
  last_checked: string;
}

export interface UsageApiResponse {
  five_hour: {
    utilization: number;
    resets_at: string;
  };
  seven_day: {
    utilization: number;
    resets_at: string;
  };
}

export interface OAuthCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

// ============================================================
// Codex Types
// ============================================================

export type CodexVerdict = "APPROVE" | "NEEDS_DISCUSSION" | "MAJOR_CONCERNS" | "NEEDS_FIXES" | "MAJOR_PROBLEMS" | "NO_VERDICT" | "ERROR" | "RATE_LIMITED";

export interface CodexJsonResponse {
  review_performed: true;
  verdict: "APPROVE" | "NEEDS_DISCUSSION" | "MAJOR_CONCERNS" | "NEEDS_FIXES" | "MAJOR_PROBLEMS";
  issues: { description: string; severity: "minor" | "major" | "critical" }[];
  summary: string;
}

export interface CodexUsageMetrics {
  invocations: number;
  successes: number;
  invalid_responses: number;
  presumed_rate_limits: number;
  last_presumed_rate_limit_at: string | null;
  /**
   * CR-2: terminal failures from spawned codex exec where stdout exceeded
   * MAX_CODEX_STDOUT_BYTES. Tracked separately from presumed_rate_limits
   * because retry is pointless for overflow and the orchestrator should
   * see it distinctly in ops dashboards.
   */
  output_too_large_failures: number;
}

export interface CodexReviewResult {
  verdict: CodexVerdict;
  raw_output: string;
  issues: string[];
  file_path: string;
}

// ============================================================
// Planner Types
// ============================================================

export interface TaskDefinition {
  subject: string;
  description: string;
  depends_on_subjects: string[];
  estimated_complexity: "small" | "medium" | "large";
  task_type?: TaskType;
  security_requirements?: string[];
  performance_requirements?: string[];
  acceptance_criteria?: string[];
  risk_level?: "low" | "medium" | "high";
}

export type TaskType =
  | "backend_api"
  | "frontend_ui"
  | "database"
  | "security"
  | "testing"
  | "infrastructure"
  | "reverse_engineering"
  | "integration"
  | "general";

export interface PlannerOutput {
  plan_markdown: string;
  tasks: TaskDefinition[];
  threat_model?: ThreatModel;
  anchor_task_subjects?: string[];
}

export interface ThreatModel {
  feature_summary: string;
  data_flows: string[];
  trust_boundaries: string[];
  attack_surfaces: {
    surface: string;
    threat_category: string; // STRIDE: Spoofing, Tampering, Repudiation, Info Disclosure, DoS, Elevation
    mitigation: string;
    mapped_to_task?: string;
  }[];
  unmapped_mitigations: string[];
}

// ============================================================
// Model Configuration Types
// ============================================================

/**
 * Supported Claude model tiers.
 *
 * Explicit tiers (preferred) and legacy aliases (kept for backwards compat
 * with the pre-0.7.0 `--worker-model opus|sonnet|haiku` flags and existing
 * state.json / models.json files).
 *
 *   - opus-4-7:   claude-opus-4-7              (Jan 2026, adaptive thinking only)
 *   - opus-4-6:   claude-opus-4-6              (still supports /fast)
 *   - sonnet-4-6: claude-sonnet-4-6
 *   - haiku-4-5:  claude-haiku-4-5-20251001
 *   - opus  -> opus-4-6   (legacy alias; safe default for existing users)
 *   - sonnet-> sonnet-4-6 (legacy alias)
 *   - haiku -> haiku-4-5  (legacy alias)
 */
export type ClaudeModelTier =
  | "opus-4-7"
  | "opus-4-6"
  | "sonnet-4-6"
  | "haiku-4-5"
  | "opus"
  | "sonnet"
  | "haiku";

/**
 * Reasoning-effort levels that the Claude Agent SDK accepts on its `effort`
 * option (adaptive thinking guidance). `xhigh` is Opus 4.7 only; `max` is
 * Opus 4.6, Opus 4.7, and Sonnet 4.6.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Distinct agent spawn points in the conductor. Used to look up a per-role
 * model + effort spec from `ModelConfig.roles` and `DEFAULT_ROLE_CONFIG`.
 *
 * Worker roles are keyed off `Task.task_type` (the persona system) so the
 * orchestrator can pick a different model for, e.g., frontend vs. backend
 * work in the same run.
 */
export type AgentRole =
  | "planner"
  | "worker_backend_api"
  | "worker_frontend_ui"
  | "worker_database"
  | "worker_security"
  | "worker_testing"
  | "worker_infrastructure"
  | "worker_reverse_engineering"
  | "worker_integration"
  | "worker_general"
  | "sentinel"
  | "flow_tracer"
  | "flow_config_analyzer"
  | "conventions_extractor"
  | "rules_extractor"
  | "design_spec_analyzer"
  | "design_spec_updater";

/** A model + effort selection for a single agent role. */
export interface RoleModelSpec {
  tier: ClaudeModelTier;
  effort?: EffortLevel;
}

/**
 * Model configuration for the conductor.
 *
 * The legacy two-tier shape (`worker` + `subagent`) is preserved so existing
 * CLI flags and state.json files keep working. Per-role overrides go in
 * `roles`; resolution precedence (highest to lowest):
 *
 *   1. `ModelConfig.roles[role]`
 *   2. Legacy `worker` (for execution-worker roles) or `subagent` (for
 *      sentinel + read-only analyzers) — applied only if the user supplied
 *      these via legacy flags
 *   3. `DEFAULT_ROLE_CONFIG[role]` from constants.ts
 */
export interface ModelConfig {
  /** Legacy: model used for execution workers when no per-role override applies. */
  worker: ClaudeModelTier;
  /** Legacy: model used for sentinel + read-only analyzers when no per-role override applies. */
  subagent: ClaudeModelTier;
  /**
   * Whether to use the extended 1M token context window.
   * - Opus 4.6 / 4.7: 1M is included at no extra cost (this flag is ignored; always enabled).
   * - Sonnet 4.6: 1M is billed as extra usage (opt-in).
   * - Haiku: not supported.
   */
  extendedContext: boolean;
  /** Per-role model + effort overrides. Loaded from `.conductor/models.json` or CLI flags. */
  roles?: Partial<Record<AgentRole, RoleModelSpec>>;
}

/**
 * Map from model tier to full Claude API model ID.
 *
 * Legacy aliases (`opus` / `sonnet` / `haiku`) intentionally resolve to the
 * SAME model IDs they did in 0.6.x — that is, `opus -> claude-opus-4-6`, NOT
 * `claude-opus-4-7`. Users who want 4.7 must opt in explicitly via the new
 * `opus-4-7` tier or the per-role config.
 */
export const MODEL_TIER_TO_ID: Record<ClaudeModelTier, string> = {
  "opus-4-7": "claude-opus-4-7",
  "opus-4-6": "claude-opus-4-6",
  "sonnet-4-6": "claude-sonnet-4-6",
  "haiku-4-5": "claude-haiku-4-5-20251001",
  // Legacy aliases — preserve pre-0.7.0 behavior
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/** Default model config: legacy two-tier defaults remain the same. Per-role
 *  defaults live in `DEFAULT_ROLE_CONFIG` (constants.ts). */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  worker: "opus",
  subagent: "sonnet",
  extendedContext: false,
};

// ============================================================
// CLI Types
// ============================================================

export interface CLIOptions {
  project: string;
  feature: string;
  concurrency: number;
  maxCycles: number;
  usageThreshold: number;
  skipCodex: boolean;
  skipFlowReview: boolean;
  skipDesignSpecUpdate: boolean;
  dryRun: boolean;
  resume: boolean;
  verbose: boolean;
  contextFile: string | null;
  currentBranch: boolean;
  workerRuntime: WorkerRuntime;
  forceResume: boolean;
  modelConfig: ModelConfig;
}

// ============================================================
// Worker Spawn Types
// ============================================================

export type WorkerRuntime = "claude" | "codex";

export interface ProviderUsageMonitor {
  readonly provider: WorkerRuntime;
  start(): void;
  stop(): void;
  getUsage(): UsageSnapshot;
  poll(): Promise<UsageSnapshot>;
  isWindDownNeeded(): boolean;
  isCritical(): boolean;
  getResetTime(): string | null;
  waitForReset(): Promise<void>;
  /** Returns true if usage data is older than USAGE_STALE_THRESHOLD_MS. */
  isDataStale(): boolean;
  /** Number of consecutive poll failures (resets on success). */
  getConsecutiveFailures(): number;
  /** Milliseconds since the last successful poll, or 0 if never polled. */
  getStaleDurationMs(): number;
  /** Usage rate as fraction per minute (e.g. 0.006 = 0.6%/min). Null if insufficient data. */
  getUsageRatePerMinute(): number | null;
  /** Estimated minutes until the threshold is reached. Null if rate is unavailable or non-positive. */
  estimateMinutesUntilThreshold(threshold?: number): number | null;
  /** True if rate tracking predicts the threshold will be hit before the next poll. */
  isThresholdPredicted(): boolean;
  /** Human-readable rate summary for logging. */
  getRateSummary(): string;
}

export interface WorkerSharedContext {
  qaContext?: string;
  conventions?: ProjectConventions;
  projectRules?: string;
  featureDescription?: string;
  threatModelSummary?: string;
  projectGuidance?: string; // V2: Auto-detected project guidance
  designSpec?: DesignSpec; // V2: Frontend design system spec from `conduct init`
}

/**
 * Worker health check result.
 * Used by orchestrator to detect unhealthy workers.
 * Note: Implementations duplicate this type inline; consider importing for consistency.
 */
export interface WorkerHealthStatus {
  timedOut: string[]; // Session IDs that exceeded wall-clock timeout
  stale: string[]; // Session IDs with no heartbeat (excludes timedOut)
}

/**
 * Retry tracker interface for task failure tracking.
 * Defined here as a minimal interface to avoid circular imports.
 */
export interface TaskRetryTrackerInterface {
  recordFailure(taskId: string, error: string): void;
  shouldRetry(taskId: string): boolean;
  getRetryContext(taskId: string): string | null;
  getRetryCount(taskId: string): number;
  getLastError(taskId: string): string | null;
}

export interface ExecutionWorkerManager {
  setWorkerContext(context: WorkerSharedContext): void;
  /**
   * Spawn a new worker session.
   * `taskTypeHint` (optional) is the most likely task type the worker will
   * claim — used to pick a per-role model + effort. Workers may still claim
   * a different task via MCP; the hint just guides initial model selection.
   */
  spawnWorker(sessionId: string, taskTypeHint?: TaskType | null): Promise<void>;
  spawnSentinelWorker(): Promise<void>;
  getActiveWorkers(): string[];
  isWorkerActive(sessionId: string): boolean;
  signalWindDown(reason: string, resetsAt?: string): Promise<void>;
  waitForAllWorkers(timeoutMs: number): Promise<void>;
  killAllWorkers(): Promise<void>;
  getWorkerEvents(): OrchestratorEvent[];

  // V2: Worker resilience methods
  /**
   * Check health of all active workers.
   * Returns lists of timed-out and stale workers.
   */
  checkWorkerHealth(): WorkerHealthStatus;

  /**
   * Get the task retry tracker for recording failures.
   * Returns null if retry tracking is not supported.
   */
  getRetryTracker(): TaskRetryTrackerInterface | null;

  // H-10 FIX (Task 9): Task claim tracking for proper failure attribution
  /**
   * Register a task claim for failure attribution.
   * Called when a worker claims a task.
   */
  registerTaskClaim?(sessionId: string, taskId: string): void;

  /**
   * Clear a task claim when a task is completed or released.
   */
  clearTaskClaim?(sessionId: string): void;

  /**
   * Get the task ID currently claimed by a session.
   * Returns null if no task is claimed.
   */
  getClaimedTaskId?(sessionId: string): string | null;

  // H-10 FIX: Session resumption support for retries
  /**
   * Spawn a worker specifically for retrying a failed task.
   * If a thread ID was preserved from the previous failed attempt, the worker
   * may use session resumption for better context continuity.
   *
   * @param sessionId - New session ID for the retry worker
   * @param taskId - The task ID being retried
   * @param correctivePrompt - Optional prompt explaining what went wrong
   * @param taskTypeHint - Optional task type for role-based model selection
   *                      on the retry worker (H-10).
   */
  spawnWorkerForRetry?(
    sessionId: string,
    taskId: string,
    correctivePrompt?: string,
    taskTypeHint?: TaskType | null,
  ): Promise<void>;

  /**
   * Get a preserved thread ID for a task (for session resumption).
   * Returns null if no thread ID is available for the task.
   */
  getThreadIdForTask?(taskId: string): string | null;

  /**
   * Terminate a specific worker by session ID.
   * Sends SIGTERM, waits briefly, then SIGKILL if needed.
   * Used to kill timed-out or stale workers before resetting their tasks.
   */
  terminateWorker?(sessionId: string): Promise<void>;
}

// ============================================================
// Event Types (for orchestrator event loop)
// ============================================================

export type OrchestratorEvent =
  | { type: "task_completed"; taskId: string; sessionId: string; summary: string }
  | { type: "task_failed"; taskId: string; sessionId: string; error: string }
  | { type: "session_idle"; sessionId: string }
  | { type: "session_done"; sessionId: string }
  | { type: "session_failed"; sessionId: string; error: string }
  | {
      type: "provider_rate_limited";
      sessionId: string;
      provider: WorkerRuntime;
      detail: string;
      resets_at: string | null;
    }
  | { type: "usage_warning"; utilization: number }
  | { type: "usage_critical"; utilization: number; resets_at: string }
  | { type: "all_tasks_complete" }
  | { type: "escalation_needed"; reason: string; details: string };

// ============================================================
// Flow-Tracing Review Types
// ============================================================

export type FlowFindingSeverity = "critical" | "high" | "medium" | "low";

export interface FlowSpec {
  id: string;
  name: string;
  description: string;
  entry_points: string[];
  actors: ActorType[];
  edge_cases: string[];
}

/** Actor type for flow tracing (e.g., "authenticated_user", "admin"). Exported for semantic clarity. */
export type ActorType = string;

export interface FlowFinding {
  flow_id: string;
  severity: FlowFindingSeverity;
  actor: ActorType;
  title: string;
  description: string;
  file_path: string;
  line_number?: number;
  cross_boundary: boolean;
  edge_case?: string;
}

export interface FlowConfig {
  /** Layer definitions for the tracing methodology (what to check at each layer) */
  layers: {
    name: string;
    checks: string[];
  }[];

  /** Actor types relevant to this project */
  actor_types: string[];

  /** Edge cases to always check */
  edge_cases: string[];

  /** Example flows to guide the extraction prompt */
  example_flows: {
    id: string;
    name: string;
    description: string;
    entry_points: string[];
    actors: string[];
    edge_cases: string[];
  }[];
}

export interface FlowTracingReport {
  generated_at: string;
  flows_traced: number;
  findings: FlowFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
    cross_boundary_count: number;
  };
}

// ============================================================
// Contract & Decision Types (cross-worker coordination)
// ============================================================

export interface ContractSpec {
  contract_id: string;
  contract_type: "api_endpoint" | "type_definition" | "event_schema" | "database_schema";
  spec: string;
  owner_task_id: string;
  registered_by: string;
  registered_at: string;
}

export interface ArchitecturalDecision {
  id: string;
  task_id: string;
  session_id: string;
  category: "naming" | "auth" | "data_model" | "error_handling" | "api_design" | "testing" | "performance" | "other";
  decision: string;
  rationale: string;
  timestamp: string;
}

export interface SemgrepFinding {
  rule_id: string;
  severity: "ERROR" | "WARNING" | "INFO";
  message: string;
  file_path: string;
  line_start: number;
  line_end: number;
}

export interface ClaimTaskResult {
  success: boolean;
  task?: Task;
  dependency_context?: {
    task_id: string;
    result_summary: string | null;
    files_changed: string[];
  }[];
  in_progress_siblings?: { task_id: string; subject: string }[];
  contracts?: ContractSpec[];
  decisions?: ArchitecturalDecision[];
  warnings?: string[];
  error?: string;
}

// ============================================================
// Project Conventions (extracted pre-execution)
// ============================================================

export interface ProjectConventions {
  auth_patterns: string[];
  validation_patterns: string[];
  error_handling_patterns: string[];
  test_patterns: string[];
  directory_structure: string[];
  naming_conventions: string[];
  key_libraries: { name: string; purpose: string }[];
  security_invariants: string[];
}

// ============================================================
// Design System Spec (generated by `conduct init`)
// ============================================================

export interface DesignSpec {
  generated_at: string;
  framework: string; // "react" | "vue" | "svelte" | "angular"
  component_hierarchy: {
    primitives: ComponentInfo[];
    composed: ComponentInfo[];
    page_level: ComponentInfo[];
  };
  variant_system: {
    approach: string; // "cva" | "prop-based" | "styled-components" | "css-modules" | "tailwind-variants"
    libraries: string[];
    examples: VariantExample[];
  };
  theming: {
    approach: string; // "css-variables" | "tailwind" | "design-tokens" | "styled-theme" | "none"
    token_file?: string;
    color_system?: string;
  };
  naming_conventions: {
    files: string;
    components: string;
    props: string;
    css_classes: string;
  };
  shared_primitives: SharedPrimitive[];
}

export interface ComponentInfo {
  name: string;
  file_path: string;
  variant_count?: number;
  description?: string;
}

export interface VariantExample {
  component: string;
  file_path: string;
  pattern: string;
  variants: string[];
}

export interface SharedPrimitive {
  name: string;
  file_path: string;
  variant_count: number;
  size_count?: number;
  consumers: number;
  variant_approach: string;
  description: string;
}

export interface DesignSpecUpdateResult {
  updated: boolean;
  warnings: string[];
}

export interface InitResult {
  projectProfile: ProjectProfile;
  hasFrontend: boolean;
  files: {
    created: string[];
    recommended: string[];
    skipped: string[];
  };
  designSpec: DesignSpec | null;
}

// ============================================================
// Known Issues Registry (persists across cycles)
// ============================================================

export interface KnownIssue {
  id: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  source: "codex_review" | "flow_tracing" | "semgrep" | "incremental_review" | "sentinel";
  file_path?: string;
  found_in_cycle: number;
  addressed_in_cycle?: number;
  addressed: boolean;
  assigned_to_task?: string;
}

// ============================================================
// Project Auto-Detection Types (V2)
// ============================================================

/**
 * High-level project archetype, used to pick flow-config seed templates
 * and to adapt downstream prompts (worker, threat model, etc.) to the
 * actual shape of the project rather than assuming a web app.
 *
 *   - cli:     A command-line tool or developer tool (has `bin` in package.json,
 *              `src/cli*` entry, argparse/commander/click deps, etc.)
 *   - web:     A web application (frontend framework detected, or API-only
 *              backend paired with a browser client)
 *   - library: A reusable package that exports modules/APIs for other code
 *              (has `main`/`module`/`exports` / `types`, no bin, no server)
 *   - service: A long-running backend service without a web frontend
 *              (express/fastify/hono/nestjs/fastapi/django/flask detected)
 *   - other:   Anything that doesn't fit the archetypes above
 */
export type ProjectArchetype = "cli" | "web" | "library" | "service" | "other";

export interface ProjectProfile {
  detected_at: string;
  languages: ("typescript" | "javascript" | "python")[];
  frameworks: string[]; // e.g., 'nextjs', 'express', 'fastapi'
  test_runners: string[]; // e.g., 'vitest', 'jest', 'pytest'
  linters: string[]; // e.g., 'eslint', 'prettier', 'ruff'
  ci_systems: string[]; // e.g., 'github-actions', 'gitlab-ci'
  package_managers: string[]; // e.g., 'npm', 'yarn', 'pip'
  /** v0.7.1: high-level shape of the project (CLI / web app / library / service). */
  archetype?: ProjectArchetype;
}

// ============================================================
// Structured Event Log Types (V2)
// ============================================================

export type StructuredEvent =
  | { type: "phase_start"; phase: string; timestamp: string }
  | { type: "phase_end"; phase: string; timestamp: string; duration_ms: number }
  | { type: "worker_spawn"; session_id: string; timestamp: string }
  | { type: "worker_complete"; session_id: string; timestamp: string; tasks_completed: number }
  | { type: "worker_fail"; session_id: string; timestamp: string; error: string }
  | { type: "worker_timeout"; session_id: string; timestamp: string; duration_ms: number }
  | { type: "task_claimed"; task_id: string; session_id: string; timestamp: string }
  | { type: "task_completed"; task_id: string; session_id: string; timestamp: string }
  | { type: "task_failed"; task_id: string; session_id: string; timestamp: string; error: string }
  | { type: "task_retried"; task_id: string; retry_count: number; timestamp: string }
  | { type: "review_verdict"; verdict: string; timestamp: string }
  | { type: "usage_warning"; utilization: number; timestamp: string }
  | { type: "scheduling_decision"; task_id: string; score: number; timestamp: string }
  | { type: "project_detection"; profile: ProjectProfile; timestamp: string };

// ============================================================
// Orchestrator State Types
// ============================================================

export interface OrchestratorState {
  status: OrchestratorStatus;
  feature: string;
  project_path: string;
  branch: string;
  worker_runtime: WorkerRuntime;
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
  completed_task_ids: string[];
  failed_task_ids: string[];
  active_session_ids: string[];
  cycle_history: CycleRecord[];
  progress: string;
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
  review_feedback?: string[];
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

export interface ResumeInfo {
  session_id: string;
  current_task_id: string | null;
  task_progress: string;
  files_modified: string[];
  last_commit: string | null;
  context_notes: string;
  created_at: string;
}

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

export interface WindDownMessage extends Message {
  type: "wind_down";
  metadata: {
    reason: "usage_limit" | "cycle_limit" | "user_requested";
    resets_at?: string;
  };
}

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
  dryRun: boolean;
  resume: boolean;
  verbose: boolean;
  contextFile: string | null;
  currentBranch: boolean;
  workerRuntime: WorkerRuntime;
  forceResume: boolean;
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
}

export interface WorkerSharedContext {
  qaContext?: string;
  conventions?: ProjectConventions;
  projectRules?: string;
  featureDescription?: string;
  threatModelSummary?: string;
}

export interface ExecutionWorkerManager {
  setWorkerContext(context: WorkerSharedContext): void;
  spawnWorker(sessionId: string): Promise<void>;
  spawnSentinelWorker(): Promise<void>;
  getActiveWorkers(): string[];
  isWorkerActive(sessionId: string): boolean;
  signalWindDown(reason: string, resetsAt?: string): Promise<void>;
  waitForAllWorkers(timeoutMs: number): Promise<void>;
  killAllWorkers(): Promise<void>;
  getWorkerEvents(): OrchestratorEvent[];
}

export interface WorkerConfig {
  sessionId: string;
  projectDir: string;
  orchestratorDir: string;
  mcpServerPath: string;
  systemPromptAddendum: string;
  allowedTools: string[];
  maxTurns: number;
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

export interface CompletionVerification {
  type_check_passed: boolean;
  tests_passed: boolean;
  tests_added: number;
  auth_verified: boolean;
  input_validation_verified: boolean;
  no_hardcoded_secrets: boolean;
  semgrep_passed?: boolean;
  semgrep_findings?: SemgrepFinding[];
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

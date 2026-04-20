import fs from "node:fs";
import os from "node:os";
import path from "path";
import type { AgentRole, ClaudeModelTier, RoleModelSpec, TaskType } from "./types.js";

// ============================================================
// Directory & File Names
// ============================================================

export const ORCHESTRATOR_DIR = ".conductor";
export const TASKS_DIR = "tasks";
export const MESSAGES_DIR = "messages";
export const SESSIONS_DIR = "sessions";
export const CODEX_REVIEWS_DIR = "codex-reviews";
export const FLOW_TRACING_DIR = "flow-tracing";
export const CONTRACTS_DIR = "contracts";
export const DECISIONS_FILE = "decisions.jsonl";
export const CONVENTIONS_FILE = "conventions.json";
export const DESIGN_SPEC_FILE = "design-spec.json";
export const RECOMMENDED_CONFIGS_DIR = "recommended-configs";
export const KNOWN_ISSUES_FILE = "known-issues.json";
export const RULES_FILE = "rules.md";
export const WORKER_RULES_FILE = "worker-rules.md";
export const LOGS_DIR = "logs";
export const PROGRESS_LOG_FILE = "progress.jsonl";

export const STATE_FILE = "state.json";
export const SESSION_STATUS_FILE = "status.json";
export const RESUME_INFO_FILE = "resume-info.json";
export const RESULT_FILE = "result.json";
export const ESCALATION_FILE = "escalation.json";
export const PAUSE_SIGNAL_FILE = "pause.signal";
export const CLI_LOCK_FILE = "conductor.lock"; // Process lock file (#10)
export const TASKS_DRAFT_FILE = "tasks-draft.json"; // Planner writes task definitions here (#4)
export const MODELS_CONFIG_FILE = "models.json"; // Per-role model + effort overrides (v0.7.0)
export const FLOW_CONFIG_FILE = "flow-config.json";

// ============================================================
// Archive (v0.7.6)
// ============================================================

export const ARCHIVE_DIR = "archive";
export const ARCHIVE_META_FILE = "_archive-meta.json";
export const ARCHIVE_IN_PROGRESS_MARKER = ".archive-in-progress";
export const ARCHIVE_PARTIAL_SUFFIX = "-PARTIAL";
/** Matches quarantine dir names: `<slug>-PARTIAL`, `<slug>-PARTIAL-2`, etc.
 *  Used by finalizePartialArchive to skip entries that are already quarantined. */
export const ARCHIVE_PARTIAL_REGEX = /-PARTIAL(?:-\d+)?$/;
export const ARCHIVE_VERSION = 1;
/** Glob-like special: any file matching /^plan-v\d+\.md$/ at `.conductor/`
 *  root is archived. Captures plan-v1.md, plan-v10.md, etc., including gaps. */
export const ARCHIVE_PLAN_GLOB = /^plan-v\d+\.md$/;
/** Max total length of an archive slug (filesystem-safe across FAT/APFS/ext4). */
export const MAX_ARCHIVE_SLUG_LENGTH = 80;
/** Max length of the slug-core (branch-slug or feature-slug) before suffixes. */
export const MAX_ARCHIVE_SLUG_CORE_LENGTH = 40;
/** Upper bound on collision suffixes (<slug>-2, -3, ..., -99). */
export const ARCHIVE_COLLISION_LIMIT = 99;

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_MAX_CYCLES = 5;
export const DEFAULT_USAGE_THRESHOLD = 0.80;
export const DEFAULT_CRITICAL_THRESHOLD = 0.90;
export const DEFAULT_USAGE_POLL_INTERVAL_MS = 600_000; // 10 minutes — usage API has ~5 req/token limit (GH #30930)
export const DEFAULT_WORKER_MAX_TURNS = 100;
export const DEFAULT_WORKER_POLL_INTERVAL_MS = 5_000; // 5 seconds (orchestrator checks workers)
export const FLOW_TRACING_WORKER_MAX_TURNS = 50;
export const MAX_FLOW_TRACING_WORKERS = 3;
export const FLOW_TRACING_OVERALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes overall deadline (#12)
export const SENTINEL_POLL_INTERVAL_MS = 15_000; // 15 seconds
export const SENTINEL_WORKER_MAX_TURNS = 200;
export const SENTINEL_SESSION_ID = "sentinel-security";
export const CONVENTIONS_EXTRACTION_MAX_TURNS = 20;
export const RULES_EXTRACTOR_MAX_TURNS = 25;
export const RULES_EXTRACTOR_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
export const DESIGN_SPEC_ANALYZER_MAX_TURNS = 30;
export const DESIGN_SPEC_ANALYZER_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
export const DESIGN_SPEC_UPDATER_MAX_TURNS = 15;
export const DESIGN_SPEC_UPDATER_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
export const FLOW_CONFIG_ANALYZER_MAX_TURNS = 25;
export const FLOW_CONFIG_ANALYZER_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
export const INCREMENTAL_REVIEW_MAX_TURNS = 15;
export const MAX_SEMGREP_RETRIES = 2;

// ============================================================
// Worker Resilience Configuration (V2)
// ============================================================

export const DEFAULT_WORKER_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes
export const MAX_TASK_RETRIES = 2; // 2 retries = 3 total attempts
export const RETRY_FAILURE_TTL_MS = 30 * 60 * 1000; // 30 minutes - clear old failures after this (#26c)
export const HEARTBEAT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
export const USAGE_MONITOR_MAX_RETRIES = 3; // Retries on 429 with exponential backoff (#7)
export const USAGE_POLL_MAX_INTERVAL_MS = 10 * 60 * 1000; // 10 min cap for adaptive backoff
export const USAGE_POLL_BACKOFF_MULTIPLIER = 2; // Double poll interval on failure
export const USAGE_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — warn about stale data
export const USAGE_STALE_CRITICAL_MS = 60 * 60 * 1000; // 60 min — safety-pause, data too old
export const USAGE_RATE_WINDOW_SIZE = 6; // Number of samples for running average rate calculation
export const USAGE_RATE_ESTABLISHED_POLL_MS = 30 * 60 * 1000; // 30 min — once rate is established, poll less
export const USAGE_API_429_BACKOFF_MS = 60 * 60 * 1000; // 60 min — on 429, back off aggressively (token limit)

// ============================================================
// Codex Worker Parity Configuration
// ============================================================

/** Model maps for API accounts (tiered) vs ChatGPT accounts (limited selection).
 *  Both legacy aliases (opus/sonnet/haiku) and explicit tiers (opus-4-7, etc.)
 *  must map to a Codex model since either can show up in `ModelConfig`. */
const CODEX_MODEL_MAP_API: Record<ClaudeModelTier, string> = {
  "opus-4-7": "gpt-5.3-codex-high",
  "opus-4-6": "gpt-5.3-codex-high",
  "sonnet-4-6": "gpt-5.3-codex-medium",
  "haiku-4-5": "gpt-5.3-codex-low",
  opus: "gpt-5.3-codex-high",
  sonnet: "gpt-5.3-codex-medium",
  haiku: "gpt-5.3-codex-low",
};

const CODEX_MODEL_MAP_CHATGPT: Record<ClaudeModelTier, string> = {
  "opus-4-7": "gpt-5.3-codex",
  "opus-4-6": "gpt-5.3-codex",
  "sonnet-4-6": "gpt-5.3-codex",
  "haiku-4-5": "codex-mini-latest",
  opus: "gpt-5.3-codex",
  sonnet: "gpt-5.3-codex",
  haiku: "codex-mini-latest",
};

/**
 * Detect whether Codex CLI is authenticated with an API key or a ChatGPT account.
 * API accounts have OPENAI_API_KEY set (env var or in auth.json).
 * ChatGPT accounts use OAuth tokens with no API key.
 */
let _codexAccountType: "api" | "chatgpt" | undefined;
function detectCodexAccountType(): "api" | "chatgpt" {
  if (_codexAccountType) return _codexAccountType;

  // Check env var first
  if (process.env.OPENAI_API_KEY) {
    _codexAccountType = "api";
    return _codexAccountType;
  }

  // Check ~/.codex/auth.json
  try {
    const authPath = path.join(os.homedir(), ".codex", "auth.json");
    const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    if (authData.OPENAI_API_KEY) {
      _codexAccountType = "api";
    } else {
      _codexAccountType = "chatgpt";
    }
  } catch {
    // If we can't read auth.json, assume ChatGPT (safer default — won't
    // request tiered models that require API billing)
    _codexAccountType = "chatgpt";
  }

  return _codexAccountType;
}

/** Maps Claude model tiers to Codex/OpenAI model names for --model flag.
 *  Selects tiered models (high/medium/low) for API accounts,
 *  or generic models for ChatGPT accounts. */
export function getCodexModel(tier: ClaudeModelTier): string {
  const accountType = detectCodexAccountType();
  return accountType === "api"
    ? CODEX_MODEL_MAP_API[tier]
    : CODEX_MODEL_MAP_CHATGPT[tier];
}

/** @deprecated Use getCodexModel() instead. Kept for test compatibility. */
export const CODEX_MODEL_MAP: Record<ClaudeModelTier, string> = CODEX_MODEL_MAP_API;

/** Job timeout for Codex workers in seconds, derived from DEFAULT_WORKER_TIMEOUT_MS. */
export const CODEX_JOB_MAX_RUNTIME_SECONDS = Math.floor(DEFAULT_WORKER_TIMEOUT_MS / 1000);

// ============================================================
// Event Log Configuration (V2)
// ============================================================

export const EVENTS_FILE = "events.jsonl";
export const EVENT_FLUSH_INTERVAL_MS = 1000; // 1 second
export const MAX_EVENT_LOG_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB limit (DoS mitigation)
export const MAX_BUFFER_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB buffer limit for Codex output (#11)

// ============================================================
// Project Detection Configuration (V2)
// ============================================================

export const PROJECT_PROFILE_FILE = "project-profile.json";

// ============================================================
// Task Scheduling Priority Configuration (V2)
// ============================================================

export const TASK_TYPE_PRIORITY: Record<TaskType, number> = {
  security: 60,
  reverse_engineering: 55,
  database: 50,
  backend_api: 40,
  infrastructure: 30,
  frontend_ui: 20,
  integration: 15,
  testing: 10,
  general: 0,
};

export const RISK_LEVEL_SCORE: Record<string, number> = {
  high: 30,
  medium: 15,
  low: 0,
};

// Critical path depth multiplier for scheduling score
export const CRITICAL_PATH_DEPTH_MULTIPLIER = 10;

// ============================================================
// Replan Prompt Compaction
// ============================================================

export const REPLAN_TOKEN_THRESHOLD = 40_000;
export const COMPACTION_AGENT_MAX_TURNS = 10;
export const COMPACTION_AGENT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
export const CHARS_PER_TOKEN_ESTIMATE = 4;

// ============================================================
// Semgrep Configuration
// ============================================================

export const SEMGREP_DEFAULT_CONFIGS = [
  "p/typescript",
  "p/owasp-top-ten",
  "p/cwe-top-25",
];

export const SEMGREP_SEVERITY_BLOCK_THRESHOLD = "ERROR"; // block task completion on ERROR findings

// ============================================================
// Limits
// ============================================================

export const MAX_PLAN_DISCUSSION_ROUNDS = 5;
export const MAX_CODE_REVIEW_ROUNDS = 5;
export const FLOW_TASK_PREFIX = "flow-";
export const MAX_DISAGREEMENT_ROUNDS = 2; // escalate to user after this
/** Progressive backoff schedule (in ms) for Codex rate limits: 1min, 5min, 10min, then give up. */
export const CODEX_RATE_LIMIT_BACKOFF_MS = [1 * 60_000, 5 * 60_000, 10 * 60_000] as const;
export const WIND_DOWN_GRACE_PERIOD_MS = 120_000; // 2 minutes for clean exit
export const RESUME_UTILIZATION_THRESHOLD = 0.50; // resume when usage drops below this
export const CLI_LOCK_STALE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour stale lock timeout (#10)
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000; // 10 seconds grace period for shutdown (#19)

// ============================================================
// Usage API
// ============================================================

export const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_API_BETA_HEADER = "oauth-2025-04-20";
export const CREDENTIALS_PATH_LINUX = "~/.claude/.credentials.json";
export const CREDENTIALS_PATH_MACOS = "~/.claude/.credentials.json";

// ============================================================
// Worker Configuration
// ============================================================

export const WORKER_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "LSP", // Language Server Protocol for code intelligence (go-to-definition, references, hover, etc.)
  "Task", // so workers can use subagents
  "mcp__coordinator__read_updates",
  "mcp__coordinator__post_update",
  "mcp__coordinator__get_tasks",
  "mcp__coordinator__claim_task",
  "mcp__coordinator__complete_task",
  "mcp__coordinator__get_session_status",
  "mcp__coordinator__register_contract",
  "mcp__coordinator__get_contracts",
  "mcp__coordinator__record_decision",
  "mcp__coordinator__get_decisions",
  "mcp__coordinator__run_tests",
  "mcp__codex__*", // optional Codex MCP for real-time consultation
];

// ============================================================
// Flow-Tracing Worker Configuration (read-only)
// ============================================================

// ============================================================
// Planner Configuration
// ============================================================

export const PLANNER_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "LSP", // Language Server Protocol for code intelligence
  "Write", // for writing tasks-draft.json
  "mcp__planner__validate_task_definitions",
];

// ============================================================
// Flow-Tracing Worker Configuration (read-only)
// ============================================================

// Note: Task tool is intentionally EXCLUDED — it allows spawning subagents with
// write access, which would defeat the purpose of read-only flow-tracing workers.
export const FLOW_TRACING_READ_ONLY_TOOLS = [
  "Read",
  "Bash",
  "Glob",
  "Grep",
  "LSP", // Language Server Protocol for code intelligence (read-only)
];

// ============================================================
// Read-only worker enforcement (CR-1)
// ============================================================

/**
 * Tools that MUST NOT be available to read-only workers (sentinel, flow-tracer,
 * planner question-gen, prompt-compactor, rules-extractor, design-spec
 * analyzer/updater, conventions-extractor, flow-config-analyzer). Passed to the
 * SDK via `disallowedTools` to remove these tools from the model's context
 * entirely — unlike `allowedTools`, which only controls permission-prompt
 * auto-approval and is ineffective under `permissionMode: "bypassPermissions"`.
 *
 * NotebookEdit is the .ipynb write tool. Task spawns subagents which can
 * themselves have write tools, so it is also excluded.
 *
 * Note: `Bash` is NOT in this list — read-only workers need Bash for `git diff`,
 * `rg`, `find`, etc. A residual write-via-shell risk remains at 7 Bash-present
 * callsites; see .claude/specs/v0.7.2-critical-fixes.md for the enumeration.
 */
export const READ_ONLY_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Task",
];

// ============================================================
// CodexReviewer prompt size guards (CR-2)
// ============================================================

/** Per-file cap: 100K UTF-16 code units. Large enough for most files but
 *  prevents one giant file from dominating the prompt. */
export const MAX_CODEX_PROMPT_FILE_CHARS = 100_000;

/** Aggregate file-content cap: 2 million UTF-16 code units (~2-4MB).
 *  Applies only to the concatenated file chunks appended to the prompt —
 *  NOT the base prompt prefix or summary marker (typical overhead <5KB).
 *  Bounds Node heap pressure and Codex token cost. Prompt is delivered via
 *  stdin (not argv), so OS ARG_MAX is not a factor. */
export const MAX_CODEX_PROMPT_AGGREGATE_CHARS = 2_000_000;

/** spawn stdout byte cap — parity with the 10MB execFile maxBuffer the
 *  previous implementation used. On overflow, child is killed and
 *  CodexExecutionError("output_too_large") is thrown. */
export const MAX_CODEX_STDOUT_BYTES = 10 * 1024 * 1024;

// ============================================================
// Git
// ============================================================

export const BRANCH_PREFIX = "conduct/";
export const COMMIT_PREFIX_TASK = "[task-";
export const GIT_CHECKPOINT_PREFIX = "checkpoint-";

// ============================================================
// Helpers
// ============================================================

export function getOrchestratorDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR);
}

export function getTasksDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, TASKS_DIR);
}

export function getMessagesDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, MESSAGES_DIR);
}

export function getSessionsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, SESSIONS_DIR);
}

export function getSessionDir(projectDir: string, sessionId: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, SESSIONS_DIR, sessionId);
}

export function getCodexReviewsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, CODEX_REVIEWS_DIR);
}

export function getLogsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, LOGS_DIR);
}

export function getStatePath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, STATE_FILE);
}

export function getTaskPath(projectDir: string, taskId: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, TASKS_DIR, `${taskId}.json`);
}

export function getMessagePath(projectDir: string, sessionId: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, MESSAGES_DIR, `${sessionId}.jsonl`);
}

export function getPlanPath(projectDir: string, version: number): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, `plan-v${version}.md`);
}

export function getEscalationPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, ESCALATION_FILE);
}

export function getPauseSignalPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, PAUSE_SIGNAL_FILE);
}

export function getFlowTracingDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, FLOW_TRACING_DIR);
}

export function getFlowTracingReportPath(projectDir: string, cycle: number): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, FLOW_TRACING_DIR, `report-cycle-${cycle}.json`);
}

export function getFlowTracingSummaryPath(projectDir: string, cycle: number): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, FLOW_TRACING_DIR, `summary-cycle-${cycle}.md`);
}

export function getContractsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, CONTRACTS_DIR);
}

export function getDecisionsPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, DECISIONS_FILE);
}

export function getConventionsPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, CONVENTIONS_FILE);
}

export function getDesignSpecPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, DESIGN_SPEC_FILE);
}

export function getRecommendedConfigsDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, RECOMMENDED_CONFIGS_DIR);
}

export function getFlowConfigPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, "flow-config.json");
}

export function getKnownIssuesPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, KNOWN_ISSUES_FILE);
}

export function getRulesPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, RULES_FILE);
}

export function getWorkerRulesPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, WORKER_RULES_FILE);
}

export function getProgressLogPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, PROGRESS_LOG_FILE);
}

export function getCliLockPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, CLI_LOCK_FILE);
}

export function getTasksDraftPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, TASKS_DRAFT_FILE);
}

export function getModelsConfigPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, MODELS_CONFIG_FILE);
}

// ============================================================
// Per-Role Model + Effort Defaults (v0.7.0)
// ============================================================

/**
 * Default model + effort per agent role.
 *
 * Rationale:
 *   - planner / sentinel / worker_security on Opus 4.7 xhigh
 *     (4.7's reasoning step-change matters most for planning + cyber-sec review).
 *   - frontend_ui on Opus 4.7 high (4.7 is materially better at frontend work).
 *   - All other workers on Opus 4.6 high — 4.7 has shown a tendency to leave
 *     stub code with TODO comments on backend/infra work, which is unacceptable.
 *   - Read-only analyzers on Sonnet 4.6 medium — preserves prior behavior
 *     (these were `subagent` tier = sonnet pre-0.7.0). Medium effort because
 *     the work is mechanical extraction, not reasoning-heavy.
 *
 * Users override via .conductor/models.json or per-role CLI flags.
 */
export const DEFAULT_ROLE_CONFIG: Record<AgentRole, RoleModelSpec> = {
  planner: { tier: "opus-4-7", effort: "xhigh" },
  worker_security: { tier: "opus-4-7", effort: "xhigh" },
  sentinel: { tier: "opus-4-7", effort: "xhigh" },
  worker_frontend_ui: { tier: "opus-4-7", effort: "high" },
  worker_backend_api: { tier: "opus-4-6", effort: "high" },
  worker_database: { tier: "opus-4-6", effort: "high" },
  worker_infrastructure: { tier: "opus-4-6", effort: "high" },
  worker_integration: { tier: "opus-4-6", effort: "high" },
  worker_testing: { tier: "opus-4-6", effort: "high" },
  worker_reverse_engineering: { tier: "opus-4-6", effort: "high" },
  worker_general: { tier: "opus-4-6", effort: "high" },
  flow_tracer: { tier: "sonnet-4-6", effort: "medium" },
  flow_config_analyzer: { tier: "sonnet-4-6", effort: "medium" },
  conventions_extractor: { tier: "sonnet-4-6", effort: "medium" },
  rules_extractor: { tier: "sonnet-4-6", effort: "medium" },
  design_spec_analyzer: { tier: "sonnet-4-6", effort: "medium" },
  design_spec_updater: { tier: "sonnet-4-6", effort: "medium" },
};

/** All AgentRole values (handy for iteration). Kept in sync with DEFAULT_ROLE_CONFIG. */
export const ALL_AGENT_ROLES: AgentRole[] = Object.keys(DEFAULT_ROLE_CONFIG) as AgentRole[];

// ============================================================
// V2 Path Helpers
// ============================================================

export function getEventsPath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, EVENTS_FILE);
}

export function getProjectProfilePath(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, PROJECT_PROFILE_FILE);
}

// ============================================================
// Archive Helpers (v0.7.6)
// ============================================================

/**
 * Exhaustive list of run artifacts moved into an archive. Paths are
 * relative to `.conductor/`. Missing entries are silently skipped.
 *
 * The archive algorithm ALSO scans `.conductor/` root for files matching
 * `ARCHIVE_PLAN_GLOB` (plan-v*.md) and adds them to the work-list, so they
 * do not need to be enumerated here.
 */
export const FILES_TO_ARCHIVE: readonly string[] = [
  STATE_FILE,
  STATE_FILE + ".bak",
  "context.md",
  TASKS_DIR,
  MESSAGES_DIR,
  SESSIONS_DIR,
  CONTRACTS_DIR,
  CODEX_REVIEWS_DIR,
  FLOW_TRACING_DIR,
  LOGS_DIR,
  DECISIONS_FILE,
  EVENTS_FILE,
  PROGRESS_LOG_FILE,
  KNOWN_ISSUES_FILE,
  TASKS_DRAFT_FILE,
  ESCALATION_FILE,
  RESUME_INFO_FILE,
  RESULT_FILE,
  SESSION_STATUS_FILE, // legacy root location; per-session status.json under sessions/<id>/ is carried with sessions/
] as const;

/**
 * Files/dirs that stay at `.conductor/` root after archival. Documentation
 * only — the archiver does NOT iterate this list; it only moves entries in
 * FILES_TO_ARCHIVE (+ ARCHIVE_PLAN_GLOB matches) and everything else stays.
 */
export const FILES_TO_KEEP_AT_ROOT: readonly string[] = [
  FLOW_CONFIG_FILE,
  RULES_FILE,
  WORKER_RULES_FILE,
  MODELS_CONFIG_FILE,
  DESIGN_SPEC_FILE,
  PROJECT_PROFILE_FILE,
  CONVENTIONS_FILE,
  RECOMMENDED_CONFIGS_DIR,
  ARCHIVE_DIR,
] as const;

/**
 * Transient files deleted (not archived) on archival. Lock files are
 * intentionally NOT here — they may still be held by the CLI process
 * running the archival; releaseLock() handles them.
 */
export const FILES_TO_DELETE_ON_ARCHIVE: readonly string[] = [
  PAUSE_SIGNAL_FILE,
] as const;

export function getArchiveDir(projectDir: string): string {
  return path.join(projectDir, ORCHESTRATOR_DIR, ARCHIVE_DIR);
}

export function getArchivePath(projectDir: string, slug: string): string {
  return path.join(getArchiveDir(projectDir), slug);
}

export function getArchiveMetaPath(projectDir: string, slug: string): string {
  return path.join(getArchivePath(projectDir, slug), ARCHIVE_META_FILE);
}

export function getArchiveInProgressMarkerPath(projectDir: string, slug: string): string {
  return path.join(getArchivePath(projectDir, slug), ARCHIVE_IN_PROGRESS_MARKER);
}

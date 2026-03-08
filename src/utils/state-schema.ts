/**
 * Zod Schema for OrchestratorState (CRITICAL - state.json validation)
 *
 * This schema provides runtime validation for state.json to catch:
 * - Malformed JSON from partial writes
 * - Missing required fields
 * - Invalid field types
 * - Version migrations
 *
 * Per audit requirements, state.json gets Zod validation while other
 * JSON files use try/catch recovery.
 */

import { z } from "zod";

// ============================================================
// Usage Snapshot Schema
// ============================================================

export const UsageSnapshotSchema = z.object({
  five_hour: z.number().min(0).max(1),
  seven_day: z.number().min(0).max(1),
  five_hour_resets_at: z.string().nullable(),
  seven_day_resets_at: z.string().nullable(),
  last_checked: z.string(),
});

// ============================================================
// Codex Usage Metrics Schema
// ============================================================

export const CodexUsageMetricsSchema = z.object({
  invocations: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  invalid_responses: z.number().int().nonnegative(),
  presumed_rate_limits: z.number().int().nonnegative(),
  last_presumed_rate_limit_at: z.string().nullable(),
});

// ============================================================
// Flow Tracing Summary Schema
// ============================================================

export const FlowTracingSummarySchema = z.object({
  flows_traced: z.number().int().nonnegative(),
  total_findings: z.number().int().nonnegative(),
  critical_findings: z.number().int().nonnegative(),
  high_findings: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative(),
});

// ============================================================
// Blast Radius Schema
// ============================================================

export const BlastRadiusSchema = z.object({
  files_changed: z.number().int().nonnegative(),
  lines_added: z.number().int().nonnegative(),
  lines_removed: z.number().int().nonnegative(),
  critical_files_touched: z.array(z.string()),
  warnings: z.array(z.string()),
});

// ============================================================
// Phase Durations Schema
// ============================================================

export const PhaseDurationsSchema = z.object({
  planning_ms: z.number().nonnegative().optional(),
  conventions_ms: z.number().nonnegative().optional(),
  codex_plan_review_ms: z.number().nonnegative().optional(),
  execution_ms: z.number().nonnegative().optional(),
  code_review_ms: z.number().nonnegative().optional(),
  flow_tracing_ms: z.number().nonnegative().optional(),
  checkpoint_ms: z.number().nonnegative().optional(),
});

// ============================================================
// Cycle Record Schema
// ============================================================

export const CycleRecordSchema = z.object({
  cycle: z.number().int().positive(),
  plan_version: z.number().int().positive(),
  tasks_completed: z.number().int().nonnegative(),
  tasks_failed: z.number().int().nonnegative(),
  codex_plan_approved: z.boolean(),
  codex_code_approved: z.boolean(),
  plan_discussion_rounds: z.number().int().nonnegative(),
  code_review_rounds: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative(),
  started_at: z.string(),
  completed_at: z.string(),
  flow_tracing: FlowTracingSummarySchema.optional(),
  phase_durations: PhaseDurationsSchema.optional(),
  blast_radius: BlastRadiusSchema.optional(),
});

// ============================================================
// Orchestrator Status Schema
// ============================================================

export const OrchestratorStatusSchema = z.enum([
  "initializing",
  "questioning",
  "planning",
  "executing",
  "reviewing",
  "flow_tracing",
  "checkpointing",
  "paused",
  "completed",
  "failed",
  "escalated",
]);

// ============================================================
// Worker Runtime Schema
// ============================================================

export const WorkerRuntimeSchema = z.enum(["claude", "codex"]);

// ============================================================
// Orchestrator State Schema (MAIN SCHEMA)
// ============================================================

export const OrchestratorStateSchema = z.object({
  status: OrchestratorStatusSchema,
  feature: z.string().min(1),
  project_path: z.string().min(1),
  branch: z.string().min(1),
  worker_runtime: WorkerRuntimeSchema,
  base_commit_sha: z.string().nullable(),
  current_cycle: z.number().int().nonnegative(),
  max_cycles: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  started_at: z.string(),
  updated_at: z.string(),
  paused_at: z.string().nullable(),
  resume_after: z.string().nullable(),
  usage: UsageSnapshotSchema,
  claude_usage: UsageSnapshotSchema.nullable(),
  codex_usage: UsageSnapshotSchema.nullable(),
  codex_metrics: CodexUsageMetricsSchema.nullable(),
  completed_task_ids: z.array(z.string()),
  failed_task_ids: z.array(z.string()),
  active_session_ids: z.array(z.string()),
  cycle_history: z.array(CycleRecordSchema),
  progress: z.string(),
});

// ============================================================
// Type Exports
// ============================================================

export type OrchestratorStateFromSchema = z.infer<typeof OrchestratorStateSchema>;

// ============================================================
// Validation Functions
// ============================================================

export interface StateValidationSuccess {
  valid: true;
  state: OrchestratorStateFromSchema;
}

export interface StateValidationFailure {
  valid: false;
  errors: string[];
}

export type StateValidationResult = StateValidationSuccess | StateValidationFailure;

/**
 * Validate and parse state.json content using Zod schema.
 *
 * Returns a validation result with either the parsed state or error messages.
 * This is the primary validation function for state.json.
 *
 * @param json - Raw JSON string from state.json
 * @returns Validation result with parsed state or errors
 */
export function validateStateJson(json: string): StateValidationResult {
  // Step 1: Try to parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      valid: false,
      errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Step 2: Validate with Zod schema
  const result = OrchestratorStateSchema.safeParse(parsed);
  if (result.success) {
    return { valid: true, state: result.data };
  }

  // Format Zod errors into readable messages
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });

  return { valid: false, errors };
}

/**
 * Validate and parse state.json content, with lenient handling for
 * optional fields that may be missing in older state files.
 *
 * This version applies defaults for fields that were added in later versions,
 * enabling backward compatibility with state files from previous versions.
 *
 * @param json - Raw JSON string from state.json
 * @returns Validation result with parsed state or errors
 */
export function validateStateJsonLenient(json: string): StateValidationResult {
  // Step 1: Try to parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      valid: false,
      errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Step 2: Apply defaults for potentially missing fields (version migration)
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    // Fields added in later versions with their defaults
    obj.worker_runtime = obj.worker_runtime ?? "claude";
    obj.claude_usage = obj.claude_usage ?? null;
    obj.codex_usage = obj.codex_usage ?? null;
    obj.codex_metrics = obj.codex_metrics ?? null;
  }

  // Step 3: Validate with Zod schema
  const result = OrchestratorStateSchema.safeParse(parsed);
  if (result.success) {
    return { valid: true, state: result.data };
  }

  // Format Zod errors into readable messages
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });

  return { valid: false, errors };
}

/**
 * Per-Role Model + Effort Configuration (v0.7.0)
 *
 * Loads `.conductor/models.json` overrides, resolves the effective
 * `RoleModelSpec` for any agent role using a deterministic precedence chain,
 * and converts a spec into the SDK `query()` arguments.
 *
 * Precedence (highest → lowest):
 *   1. `ModelConfig.roles[role]` (CLI role flags or models.json file)
 *   2. Legacy `ModelConfig.worker` / `subagent` tier — applied only to roles
 *      that fall into the legacy bucket. Lets the pre-0.7.0 `--worker-model`
 *      / `--subagent-model` flags keep working.
 *   3. `DEFAULT_ROLE_CONFIG[role]` from constants.ts.
 */

import fs from "node:fs/promises";
import { z } from "zod";
import {
  ALL_AGENT_ROLES,
  DEFAULT_ROLE_CONFIG,
  getModelsConfigPath,
} from "./constants.js";
import type {
  AgentRole,
  ClaudeModelTier,
  EffortLevel,
  ModelConfig,
  RoleModelSpec,
} from "./types.js";
import { MODEL_TIER_TO_ID } from "./types.js";

// ============================================================
// Role bucketing for legacy two-tier flag fallback
// ============================================================

/** Roles that historically used the `worker` (= execution) model tier. */
export const LEGACY_WORKER_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  "planner",
  "worker_backend_api",
  "worker_frontend_ui",
  "worker_database",
  "worker_security",
  "worker_testing",
  "worker_infrastructure",
  "worker_integration",
  "worker_reverse_engineering",
  "worker_general",
]);

/** Roles that historically used the `subagent` (= sonnet) model tier. */
export const LEGACY_SUBAGENT_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  "sentinel",
  "flow_tracer",
  "flow_config_analyzer",
  "conventions_extractor",
  "rules_extractor",
  "design_spec_analyzer",
  "design_spec_updater",
]);

/**
 * Expand a legacy two-tier choice (`--worker-model X` / `--subagent-model Y`)
 * into per-role overrides.
 *
 * The CLI calls this when the user passes a legacy flag — the result is
 * merged into `ModelConfig.roles` so `resolveRoleSpec` sees a uniform
 * per-role override map and never has to consult the deprecated `worker`
 * / `subagent` fields directly.
 */
export function expandLegacyTiers(
  workerTier: ClaudeModelTier | undefined,
  subagentTier: ClaudeModelTier | undefined,
): Partial<Record<AgentRole, RoleModelSpec>> {
  const out: Partial<Record<AgentRole, RoleModelSpec>> = {};
  if (workerTier !== undefined) {
    for (const role of LEGACY_WORKER_ROLES) {
      out[role] = { tier: workerTier, effort: DEFAULT_ROLE_CONFIG[role].effort };
    }
  }
  if (subagentTier !== undefined) {
    for (const role of LEGACY_SUBAGENT_ROLES) {
      out[role] = { tier: subagentTier, effort: DEFAULT_ROLE_CONFIG[role].effort };
    }
  }
  return out;
}

// ============================================================
// Schema for .conductor/models.json
// ============================================================

const TIER_VALUES = [
  "opus-4-7",
  "opus-4-6",
  "sonnet-4-6",
  "haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
] as const satisfies readonly ClaudeModelTier[];

const EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

const RoleModelSpecSchema = z.object({
  tier: z.enum(TIER_VALUES),
  effort: z.enum(EFFORT_VALUES).optional(),
});

// All AgentRole keys as optional fields (zod 4: z.record with an enum key
// expects every variant to be present, which we don't want — partial roles
// is the whole point of this file).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RolesShape: Record<string, any> = Object.fromEntries(
  ALL_AGENT_ROLES.map((role) => [role, RoleModelSpecSchema.optional()]),
);

const ModelsFileSchema = z.object({
  roles: z.object(RolesShape).strict().optional(),
  // Top-level legacy keys are intentionally accepted but ignored — the
  // CLI/state.json is the source of truth for those.
  worker: z.enum(TIER_VALUES).optional(),
  subagent: z.enum(TIER_VALUES).optional(),
  extendedContext: z.boolean().optional(),
});

export type ModelsFile = z.infer<typeof ModelsFileSchema>;

// ============================================================
// Loader
// ============================================================

export interface LoadModelsConfigResult {
  /** Per-role overrides parsed from .conductor/models.json. Undefined if file missing or unreadable. */
  roles?: Partial<Record<AgentRole, RoleModelSpec>>;
  /** Warnings to surface (e.g. malformed file). Non-fatal. */
  warnings: string[];
}

/**
 * Load and validate `.conductor/models.json`. Always non-fatal —
 * malformed/missing files return `{ roles: undefined, warnings: [...] }` so
 * the orchestrator can fall back to legacy + defaults.
 */
export async function loadModelsConfig(projectDir: string): Promise<LoadModelsConfigResult> {
  const path = getModelsConfigPath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { warnings: [] };
    }
    return { warnings: [`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { warnings: [`Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const result = ModelsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { warnings: [`Invalid schema in ${path}: ${issues.join("; ")}`] };
  }

  return {
    roles: result.data.roles as Partial<Record<AgentRole, RoleModelSpec>> | undefined,
    warnings: [],
  };
}

// ============================================================
// Resolution
// ============================================================

/**
 * Resolve the effective `RoleModelSpec` for a given agent role.
 *
 * Precedence (highest → lowest):
 *   1. `config.roles[role]` — per-role override (CLI flags + .conductor/models.json
 *      + CLI-expanded legacy `--worker-model` / `--subagent-model` flags).
 *   2. `DEFAULT_ROLE_CONFIG[role]` — built-in per-role default.
 *
 * The legacy `config.worker` / `config.subagent` fields are NOT consulted
 * directly — the CLI expands them into `roles` via `expandLegacyTiers` so
 * the resolution model has a single uniform shape.
 */
export function resolveRoleSpec(config: ModelConfig | undefined, role: AgentRole): RoleModelSpec {
  const override = config?.roles?.[role];
  if (override) {
    // H-7: inherit default effort when override is tier-only. Previously the
    // return was `{ tier: override.tier, effort: override.effort }` which
    // silently dropped the role's default effort for a partial override
    // like `{ "planner": { "tier": "sonnet-4-6" } }`.
    return {
      tier: override.tier,
      effort: override.effort ?? DEFAULT_ROLE_CONFIG[role].effort,
    };
  }
  return { ...DEFAULT_ROLE_CONFIG[role] };
}

// ============================================================
// SDK conversion
// ============================================================

export interface ResolvedSdkArgs {
  /** Concrete Claude API model ID (e.g. "claude-opus-4-7"). */
  model: string;
  /** Effort level to pass to the SDK's `effort` option. Undefined = SDK default. */
  effort?: EffortLevel;
}

/**
 * Convert a `RoleModelSpec` into the arguments the Agent SDK `query()` call
 * expects. The SDK's `Options.effort` natively accepts all five effort
 * levels (`low`/`medium`/`high`/`xhigh`/`max`) starting in 0.2.x, so we pass
 * it straight through.
 */
export function specToSdkArgs(spec: RoleModelSpec): ResolvedSdkArgs {
  return {
    model: MODEL_TIER_TO_ID[spec.tier],
    effort: spec.effort,
  };
}

/** Convenience: resolve + convert in one call. */
export function resolveSdkArgs(config: ModelConfig | undefined, role: AgentRole): ResolvedSdkArgs {
  return specToSdkArgs(resolveRoleSpec(config, role));
}

// ============================================================
// Display helpers
// ============================================================

/** Human-readable line for logging the resolved spec for a role. */
export function describeRoleSpec(role: AgentRole, spec: RoleModelSpec): string {
  const effort = spec.effort ?? "(sdk default)";
  return `  ${role.padEnd(28)} → ${spec.tier.padEnd(11)} effort=${effort}`;
}

/** Build a sorted, multi-line table of all resolved role specs. */
export function describeResolvedRoles(config: ModelConfig | undefined): string {
  return ALL_AGENT_ROLES.map((role) => describeRoleSpec(role, resolveRoleSpec(config, role))).join("\n");
}

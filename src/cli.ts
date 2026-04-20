#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { lock, unlock, check } from "proper-lockfile";

import { Orchestrator } from "./core/orchestrator.js";
import { EventLog } from "./core/event-log.js";
import {
  archiveCurrentRun,
  detectStaleTerminalState,
  finalizePartialArchive,
  listArchives,
  pruneArchives,
  readArchive,
  ArchiveNotFoundError,
  ArchiveRefusedError,
} from "./core/archiver.js";
import type { CLIOptions, OrchestratorState, Task, UsageSnapshot, WorkerRuntime, ClaudeModelTier, ModelConfig, EffortLevel, AgentRole, RoleModelSpec, OrchestratorStatus } from "./utils/types.js";
import { DEFAULT_MODEL_CONFIG, ConductorExitError } from "./utils/types.js";
import { loadModelsConfig, expandLegacyTiers, mergeRoleMaps } from "./utils/models-config.js";
import { ALL_AGENT_ROLES, DEFAULT_ROLE_CONFIG } from "./utils/constants.js";
import {
  getStatePath,
  getLogsDir,
  getOrchestratorDir,
  getTasksDir,
  getPauseSignalPath,
  getCliLockPath,
  CLI_LOCK_STALE_TIMEOUT_MS,
  DEFAULT_USAGE_THRESHOLD,
} from "./utils/constants.js";
import { validateBounds } from "./utils/validation.js";
import { validateStateJsonLenient } from "./utils/state-schema.js";
import { mkdirSecure } from "./utils/secure-fs.js";

// ============================================================
// Module-level state
// ============================================================

/**
 * Flag to prevent re-entrancy during shutdown.
 * First SIGINT/SIGTERM triggers graceful shutdown.
 * Second signal forces immediate exit (standard Unix pattern).
 */
let shutdownInProgress = false;

// ============================================================
// Helpers
// ============================================================

/**
 * Result of reading state.json.
 *
 * - `ok`: state file exists and passes Zod validation.
 * - `missing`: state file does not exist (ENOENT). Only ENOENT counts —
 *   other filesystem errors are `unreadable` so safety-critical guards
 *   don't mistake a permission error for "no state" (v0.7.6 Codex round 5).
 * - `invalid`: state file exists but fails Zod validation (partial write,
 *   schema drift, etc.).
 * - `unreadable`: state file exists but `fs.readFile` failed with a non-
 *   ENOENT error (EACCES, EIO, EBUSY, etc.). Hard-fail at call sites.
 */
type ReadStateResult =
  | { status: "ok"; state: OrchestratorState }
  | { status: "missing" }
  | { status: "invalid"; errors: string[] }
  | { status: "unreadable"; error: string };

/**
 * Read and validate state.json using Zod schema.
 *
 * Uses lenient validation to handle backward compatibility with older state files.
 * Returns a typed result distinguishing between missing file, invalid schema,
 * unreadable file (non-ENOENT fs error), and success.
 *
 * @param projectDir - Project directory path
 * @returns Typed result with state or error information
 */
async function readState(projectDir: string): Promise<ReadStateResult> {
  const statePath = getStatePath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", error: `${code ?? "?"}: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Validate with Zod schema (CRITICAL - state.json validation)
  const result = validateStateJsonLenient(raw);
  if (!result.valid) {
    return { status: "invalid", errors: result.errors };
  }

  return { status: "ok", state: result.state as OrchestratorState };
}

async function readAllTasks(projectDir: string): Promise<Task[]> {
  const tasksDir = getTasksDir(projectDir);
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(tasksDir, entry), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      // M-7: Validate required Task fields before pushing
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "id" in parsed &&
        typeof (parsed as Record<string, unknown>).id === "string" &&
        "subject" in parsed &&
        typeof (parsed as Record<string, unknown>).subject === "string" &&
        "status" in parsed &&
        typeof (parsed as Record<string, unknown>).status === "string"
      ) {
        tasks.push(parsed as Task);
      }
    } catch {
      // skip invalid files
    }
  }
  return tasks;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function parseWorkerRuntime(value: string): WorkerRuntime {
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw new InvalidArgumentError(
    `Invalid worker runtime "${value}". Expected "claude" or "codex".`,
  );
}

const VALID_MODEL_TIERS: ClaudeModelTier[] = [
  "opus-4-7",
  "opus-4-6",
  "sonnet-4-6",
  "haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
];

function parseModelTier(value: string): ClaudeModelTier {
  const v = value.trim().toLowerCase();
  if ((VALID_MODEL_TIERS as string[]).includes(v)) {
    return v as ClaudeModelTier;
  }
  throw new InvalidArgumentError(
    `Invalid model tier "${value}". Expected one of: ${VALID_MODEL_TIERS.join(", ")}.`,
  );
}

const VALID_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function parseEffortLevel(value: string): EffortLevel {
  const v = value.trim().toLowerCase();
  if ((VALID_EFFORT_LEVELS as string[]).includes(v)) {
    return v as EffortLevel;
  }
  throw new InvalidArgumentError(
    `Invalid effort level "${value}". Expected one of: ${VALID_EFFORT_LEVELS.join(", ")}.`,
  );
}

// ============================================================
// Per-role CLI flag resolution
// ============================================================

/** Role groups that a single --<group>-model flag expands into. */
const ROLE_GROUPS: Record<string, AgentRole[]> = {
  planner: ["planner"],
  security: ["worker_security", "sentinel"],
  frontend: ["worker_frontend_ui"],
  backend: ["worker_backend_api", "worker_database", "worker_infrastructure", "worker_integration"],
  analyzer: ["flow_tracer", "conventions_extractor", "rules_extractor", "design_spec_analyzer", "design_spec_updater"],
};

/**
 * A partial role override emitted by CLI flags. Either field may be absent —
 * unspecified fields are preserved from the underlying base (file config,
 * legacy expansion, or DEFAULT_ROLE_CONFIG) when the patch is applied.
 */
type RoleOverridePatch = { tier?: ClaudeModelTier; effort?: EffortLevel };

/**
 * Build per-role override patches from CLI flags.
 *
 * `--<group>-model X` and `--<group>-effort Y` each emit a patch with only
 * the field they set — never a full RoleModelSpec — so that effort-only
 * flags don't accidentally clobber the tier from a lower-precedence layer
 * (regression Codex caught in the first review).
 *
 * `--default-effort` applies to every role whose per-group effort flag is
 * absent.
 */
function collectRoleOverridesFromFlags(
  opts: Record<string, string | boolean | undefined>,
): Partial<Record<AgentRole, RoleOverridePatch>> {
  const patches: Partial<Record<AgentRole, RoleOverridePatch>> = {};
  const defaultEffort = opts.defaultEffort as EffortLevel | undefined;

  // Track which roles got an explicit per-group effort (so --default-effort
  // doesn't overwrite per-group choices).
  const hasExplicitEffort = new Set<AgentRole>();

  for (const [groupKey, roles] of Object.entries(ROLE_GROUPS)) {
    const tier = opts[`${groupKey}Model`] as ClaudeModelTier | undefined;
    const effort = opts[`${groupKey}Effort`] as EffortLevel | undefined;
    if (!tier && !effort) continue;
    for (const role of roles) {
      const prev = patches[role] ?? {};
      patches[role] = {
        ...prev,
        ...(tier !== undefined ? { tier } : {}),
        ...(effort !== undefined ? { effort } : {}),
      };
      if (effort !== undefined) hasExplicitEffort.add(role);
    }
  }

  // --default-effort: apply to every role lacking an explicit per-group effort.
  if (defaultEffort !== undefined) {
    for (const role of ALL_AGENT_ROLES as AgentRole[]) {
      if (hasExplicitEffort.has(role)) continue;
      patches[role] = { ...(patches[role] ?? {}), effort: defaultEffort };
    }
  }

  return patches;
}

/**
 * Apply patches on top of a base role map. Unspecified patch fields fall
 * through to the base (or to DEFAULT_ROLE_CONFIG when the role isn't in base).
 */
function applyRolePatches(
  base: Partial<Record<AgentRole, RoleModelSpec>>,
  patches: Partial<Record<AgentRole, RoleOverridePatch>>,
): Partial<Record<AgentRole, RoleModelSpec>> {
  const out: Partial<Record<AgentRole, RoleModelSpec>> = { ...base };
  for (const [role, patch] of Object.entries(patches) as [AgentRole, RoleOverridePatch][]) {
    const existing = out[role] ?? DEFAULT_ROLE_CONFIG[role];
    out[role] = {
      tier: patch.tier ?? existing.tier,
      effort: patch.effort ?? existing.effort,
    };
  }
  return out;
}

/**
 * Compose the final per-role override map for a run. Order (later wins):
 *   1. saved state roles (resume only — caller passes them in `seedRoles`)
 *   2. .conductor/models.json file roles
 *   3. legacy --worker-model / --subagent-model expansions (only when
 *      `legacyExplicit` is true so we don't auto-expand inherited defaults
 *      from the interactive prompt)
 *   4. per-group CLI flag patches (handled as patches so effort-only flags
 *      preserve the underlying tier)
 */
async function composeRoleConfig(
  projectDir: string,
  opts: Record<string, string | boolean | undefined>,
  legacy: { workerTier?: ClaudeModelTier; subagentTier?: ClaudeModelTier; explicit: boolean },
  seedRoles?: Partial<Record<AgentRole, RoleModelSpec>>,
): Promise<{ roles?: Partial<Record<AgentRole, RoleModelSpec>>; warnings: string[] }> {
  const fileResult = await loadModelsConfig(projectDir);
  // H-8: field-level merge at every composition layer. Shallow spreads
  // dropped effort when a later layer supplied a tier-only partial.
  let merged: Partial<Record<AgentRole, RoleModelSpec>> = { ...(seedRoles ?? {}) };
  if (fileResult.roles) {
    merged = mergeRoleMaps(merged, fileResult.roles);
  }
  if (legacy.explicit) {
    const legacyExpanded = expandLegacyTiers(legacy.workerTier, legacy.subagentTier);
    merged = mergeRoleMaps(merged, legacyExpanded);
  }
  const patches = collectRoleOverridesFromFlags(opts);
  merged = applyRolePatches(merged, patches);
  return {
    roles: Object.keys(merged).length > 0 ? merged : undefined,
    warnings: fileResult.warnings,
  };
}

/**
 * Interactive model selection prompt.
 *
 * Default flow (just press enter): use the per-role defaults from
 * `DEFAULT_ROLE_CONFIG` — Opus 4.7 xhigh for planner/security, Opus 4.7 high
 * for frontend, Opus 4.6 high for other workers, Sonnet 4.6 medium for
 * read-only analyzers. The returned `legacyExplicit` flag is `false`, which
 * tells the caller NOT to expand `worker`/`subagent` into per-role overrides.
 *
 * Legacy two-tier mode is opt-in: if the user answers "y" to the legacy
 * question, we ask for `worker`/`subagent` tiers and the returned
 * `legacyExplicit` is `true`, which tells the caller to expand them.
 */
async function promptModelSelection(): Promise<{ config: ModelConfig; legacyExplicit: boolean }> {
  const readline = await import("node:readline/promises");
  const { stdin: input, stdout: output } = await import("node:process");
  const rl = readline.createInterface({ input, output });

  try {
    console.log("");
    console.log(chalk.bold.cyan("  MODEL CONFIGURATION"));
    console.log(chalk.bold.cyan("  " + "-".repeat(40)));
    console.log("");
    console.log(chalk.white("  Per-role defaults will be used (recommended):"));
    console.log(chalk.gray("    planner / security / sentinel    → opus-4-7 xhigh"));
    console.log(chalk.gray("    frontend_ui                       → opus-4-7 high"));
    console.log(chalk.gray("    backend / database / infra / etc. → opus-4-6 high"));
    console.log(chalk.gray("    read-only analyzers               → sonnet-4-6 medium"));
    console.log(chalk.gray("    (edit .conductor/models.json or pass --<group>-model flags to override)"));
    console.log("");

    const legacyAnswer = await rl.question(
      chalk.yellow("  Use legacy two-tier mode (single tier for all workers)? [y/N]: "),
    );
    const wantsLegacy = ["y", "yes"].includes(legacyAnswer.trim().toLowerCase());

    if (!wantsLegacy) {
      // Per-role default path: return DEFAULT_MODEL_CONFIG with legacyExplicit=false.
      // The caller will NOT expand worker/subagent into roles, so per-role defaults win.
      console.log("");
      console.log(chalk.green("  Using per-role defaults."));
      console.log("");
      return { config: { ...DEFAULT_MODEL_CONFIG }, legacyExplicit: false };
    }

    console.log("");
    console.log(chalk.white("  Available tiers: opus-4-7 / opus-4-6 / sonnet-4-6 / haiku-4-5"));
    console.log(chalk.white("  Aliases: opus → opus-4-6, sonnet → sonnet-4-6, haiku → haiku-4-5"));
    console.log("");

    const workerAnswer = await rl.question(
      chalk.yellow("  Worker tier (default: opus-4-6): "),
    );
    const workerInput = workerAnswer.trim().toLowerCase();
    const workerModel: ClaudeModelTier = (VALID_MODEL_TIERS as string[]).includes(workerInput)
      ? (workerInput as ClaudeModelTier)
      : "opus";

    const subagentDefault: ClaudeModelTier =
      workerModel === "opus" || workerModel === "opus-4-6" || workerModel === "opus-4-7"
        ? "sonnet"
        : workerModel;
    const subagentAnswer = await rl.question(
      chalk.yellow(`  Subagent tier (default: ${subagentDefault}): `),
    );
    const subagentInput = subagentAnswer.trim().toLowerCase();
    const subagentModel: ClaudeModelTier = (VALID_MODEL_TIERS as string[]).includes(subagentInput)
      ? (subagentInput as ClaudeModelTier)
      : subagentDefault;

    // Extended context: Opus (4.6 / 4.7) always gets 1M at no extra cost.
    // Only ask for Sonnet workers since 1M is billed as extra usage.
    // Match both the legacy alias `sonnet` and the explicit tier `sonnet-4-6`.
    let extendedContext = false;
    if (workerModel === "sonnet" || workerModel === "sonnet-4-6") {
      const extAnswer = await rl.question(
        chalk.yellow("  Use extended 1M token context window? (billed as extra usage) [y/N]: "),
      );
      extendedContext = extAnswer.trim().toLowerCase() === "y" || extAnswer.trim().toLowerCase() === "yes";
    }

    const config: ModelConfig = { worker: workerModel, subagent: subagentModel, extendedContext };
    const { MODEL_TIER_TO_ID } = await import("./utils/types.js");

    console.log("");
    console.log(chalk.green(`  Workers:   ${config.worker} (${MODEL_TIER_TO_ID[config.worker]})`));
    console.log(chalk.green(`  Subagents: ${config.subagent} (${MODEL_TIER_TO_ID[config.subagent]})`));
    if (config.worker === "opus" || config.worker === "opus-4-6" || config.worker === "opus-4-7") {
      console.log(chalk.green("  Context:   1M tokens (included)"));
    } else if (config.extendedContext) {
      console.log(chalk.green("  Context:   1M tokens (extra usage)"));
    }
    console.log("");

    return { config, legacyExplicit: true };
  } finally {
    rl.close();
  }
}

// ============================================================
// Process Lock Helpers (#10)
// ============================================================

interface LockInfo {
  pid: number;
  timestamp: string;
}

/**
 * Check if a process with the given PID is still running.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a process-level lock to prevent concurrent CLI invocations.
 * Returns a release function that must be called in a finally block.
 *
 * @throws Error if lock is already held by another active process
 */
async function acquireProcessLock(projectDir: string): Promise<() => Promise<void>> {
  const lockPath = getCliLockPath(projectDir);
  const lockInfoPath = lockPath + ".info";
  const orchestratorDir = getOrchestratorDir(projectDir);

  // Ensure .conductor directory exists
  await mkdirSecure(orchestratorDir, { recursive: true }); // H-2

  // Create lock file if it doesn't exist (required by proper-lockfile)
  try {
    await fs.access(lockPath);
  } catch {
    await fs.writeFile(lockPath, "", { mode: 0o600 });
  }

  // Check if lock is already held
  const isLocked = await check(lockPath, { stale: CLI_LOCK_STALE_TIMEOUT_MS });

  if (isLocked) {
    // Check if the holding process is still alive by reading the .info file
    try {
      const infoContent = await fs.readFile(lockInfoPath, "utf-8");
      const info: LockInfo = JSON.parse(infoContent);

      // Check if process is dead (PID-based stale detection)
      if (!isProcessAlive(info.pid)) {
        console.log(chalk.yellow(`Cleaning up stale lock from dead process ${info.pid}...`));
        // Force remove the stale lock
        try {
          await unlock(lockPath);
        } catch {
          // Lock may not be held properly, just continue
        }
        try {
          await fs.unlink(lockInfoPath);
        } catch {
          // Info file may not exist
        }
        // Continue to acquire lock below
      } else {
        // Check if lock is older than stale timeout
        const lockTime = new Date(info.timestamp).getTime();
        const elapsed = Date.now() - lockTime;

        if (elapsed > CLI_LOCK_STALE_TIMEOUT_MS) {
          console.log(chalk.yellow(`Cleaning up stale lock (${Math.round(elapsed / 60000)} minutes old)...`));
          try {
            await unlock(lockPath);
          } catch {
            // Lock may not be held properly
          }
          try {
            await fs.unlink(lockInfoPath);
          } catch {
            // Info file may not exist
          }
          // Continue to acquire lock below
        } else {
          // Lock is held by an active process
          throw new Error(
            `Another conductor process (PID ${info.pid}) is already running.\n` +
            `Started at: ${info.timestamp}\n` +
            `If this is stale, wait ${Math.round((CLI_LOCK_STALE_TIMEOUT_MS - elapsed) / 60000)} minutes or kill PID ${info.pid}.`
          );
        }
      }
    } catch (err) {
      // If we can't read the info file but lock is held, throw generic error
      if (err instanceof Error && err.message.includes("Another conductor")) {
        throw err;
      }
      throw new Error(
        "Another conductor process appears to be running.\n" +
        "If this is stale, wait up to 1 hour or manually remove .conductor/conductor.lock"
      );
    }
  }

  // Acquire the lock
  const release = await lock(lockPath, {
    retries: { retries: 5, minTimeout: 100 },
    stale: CLI_LOCK_STALE_TIMEOUT_MS
  });

  // Write lock info file with PID and timestamp
  const lockInfo: LockInfo = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  await fs.writeFile(lockInfoPath, JSON.stringify(lockInfo, null, 2), { mode: 0o600 });

  // Return release function that cleans up both lock and info file
  return async () => {
    try {
      await release();
    } catch {
      // Lock may already be released
    }
    try {
      await fs.unlink(lockInfoPath);
    } catch {
      // Info file may already be removed
    }
  };
}

function printUsageSnapshot(label: string, usage: UsageSnapshot): void {
  console.log(chalk.white(`${label}:`));
  console.log(chalk.white(`      5-hour:       ${(usage.five_hour * 100).toFixed(1)}%`));
  console.log(chalk.white(`      7-day:        ${(usage.seven_day * 100).toFixed(1)}%`));
  if (usage.five_hour_resets_at) {
    console.log(chalk.gray(`      5h resets at:  ${usage.five_hour_resets_at}`));
  }
  console.log(chalk.gray(`      Last checked:  ${usage.last_checked}`));
}

// ============================================================
// CLI Program
// ============================================================

const program = new Command();

program
  .name("conduct")
  .description("Claude Code Conductor -- hierarchical multi-agent orchestration for large features")
  .version("0.7.6");

// ============================================================
// init command
// ============================================================

program
  .command("init")
  .description("Initialize conductor configuration for this project")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("--force", "Overwrite existing config files instead of writing to recommended-configs/", false)
  .option("--worker-model <tier>", "Claude model for analysis agents: opus, sonnet, or haiku", parseModelTier)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const projectDir = path.resolve(opts.project as string);

    console.log(chalk.bold.cyan("\n  Conductor Init\n"));

    try {
      // Dynamic import to avoid loading init module on every CLI invocation
      const { runInit } = await import("./core/init.js");

      // H-11: pass the tier shorthand (e.g. "opus-4-7") directly. Analyzers
      // route it through resolveLooseModelArg which expects a tier key, not
      // a fully-resolved SDK model ID. Converting to full ID here would be
      // treated as "unknown tier" downstream and fall back to defaults.
      const modelTier = opts.workerModel as string | undefined;

      await runInit(projectDir, {
        force: Boolean(opts.force),
        model: modelTier,
        verbose: Boolean(opts.verbose),
      });
    } catch (err) {
      console.error(chalk.red(`\nInit failed: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

// ============================================================
// start command
// ============================================================

program
  .command("start")
  .description("Start a new conductor run")
  .argument("<feature>", "Feature description")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("-c, --concurrency <n>", "Number of parallel workers", "2")
  .option("--max-cycles <n>", "Maximum plan-execute-review cycles", "5")
  .option("--usage-threshold <n>", "Wind-down usage threshold (0-1)", "0.80")
  .option("--skip-codex", "Skip Codex reviews", false)
  .option("--skip-flow-review", "Skip flow-tracing review phase", false)
  .option("--skip-design-spec-update", "Skip post-cycle design spec update", false)
  .option("--dry-run", "Plan only, don't execute", false)
  .option("--current-branch", "Work on the current branch instead of creating conduct/<slug>", false)
  .option("--context-file <path>", "Path to pre-gathered context file (skips interactive Q&A)")
  .option("--worker-runtime <runtime>", "Worker execution backend: claude or codex", parseWorkerRuntime, "claude")
  .option("--worker-model <tier>", "Legacy: model tier for execution workers (opus/sonnet/haiku/opus-4-7/opus-4-6/sonnet-4-6/haiku-4-5). Prefer per-role flags below.", parseModelTier)
  .option("--subagent-model <tier>", "Legacy: model tier for sentinel + read-only analyzers.", parseModelTier)
  .option("--extended-context", "Use 1M token context for sonnet workers (billed as extra usage; opus always has 1M included)", false)
  .option("--planner-model <tier>", "Model for the planner role.", parseModelTier)
  .option("--planner-effort <level>", "Effort level for the planner.", parseEffortLevel)
  .option("--security-model <tier>", "Model for security worker + sentinel.", parseModelTier)
  .option("--security-effort <level>", "Effort level for security + sentinel.", parseEffortLevel)
  .option("--frontend-model <tier>", "Model for frontend_ui workers.", parseModelTier)
  .option("--frontend-effort <level>", "Effort level for frontend workers.", parseEffortLevel)
  .option("--backend-model <tier>", "Model for backend-class workers (backend_api, database, infrastructure, integration).", parseModelTier)
  .option("--backend-effort <level>", "Effort level for backend workers.", parseEffortLevel)
  .option("--analyzer-model <tier>", "Model for read-only analyzer agents (flow tracer, conventions, rules, design-spec).", parseModelTier)
  .option("--analyzer-effort <level>", "Effort level for analyzer agents.", parseEffortLevel)
  .option("--default-effort <level>", "Effort level applied to roles without a group flag.", parseEffortLevel)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (feature: string, opts: Record<string, string | boolean | undefined>) => {
    const projectDir = path.resolve(opts.project as string);

    // Parse numeric options
    const concurrency = parseInt(opts.concurrency as string, 10) || 2;
    const maxCycles = parseInt(opts.maxCycles as string, 10) || 5;
    const usageThreshold = parseFloat(opts.usageThreshold as string) || 0.8;

    // Validate bounds for CLI parameters (#20 - security: reject extreme values)
    try {
      validateBounds("concurrency", concurrency, 1, 10);
      validateBounds("maxCycles", maxCycles, 1, 20);
      validateBounds("usageThreshold", usageThreshold, 0.1, 1.0);
    } catch (err) {
      throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
    }

    // Resolve legacy two-tier configuration: CLI flags > interactive prompt > defaults.
    // `legacyExplicit` is the source-of-truth for "should we expand worker/subagent
    // into per-role overrides?". CLI flags always count as explicit; the interactive
    // prompt sets it true only when the user opts into legacy two-tier mode; pure
    // defaults stay legacyExplicit=false so per-role defaults win.
    let modelConfig: ModelConfig;
    let legacyExplicit = false;
    const hasLegacyFlags = Boolean(opts.workerModel || opts.subagentModel || opts.extendedContext);

    if (hasLegacyFlags) {
      modelConfig = {
        worker: (opts.workerModel as ClaudeModelTier) ?? DEFAULT_MODEL_CONFIG.worker,
        subagent: (opts.subagentModel as ClaudeModelTier) ?? DEFAULT_MODEL_CONFIG.subagent,
        extendedContext: Boolean(opts.extendedContext),
      };
      legacyExplicit = Boolean(opts.workerModel || opts.subagentModel);
    } else if (!opts.contextFile) {
      const prompted = await promptModelSelection();
      modelConfig = prompted.config;
      legacyExplicit = prompted.legacyExplicit;
    } else {
      modelConfig = { ...DEFAULT_MODEL_CONFIG };
    }

    // Compose final per-role overrides: file → legacy expansion (only when
    // explicit) → per-group flag patches (effort-only flags preserve underlying tier).
    // Legacy tiers come from the resolved `modelConfig` (which carries the
    // prompt's interactive answers OR the CLI flag values), not from `opts`
    // directly — otherwise the interactive legacy path silently contributes
    // nothing because opts.workerModel is undefined in that flow.
    const composed = await composeRoleConfig(
      projectDir,
      opts,
      {
        workerTier: legacyExplicit ? modelConfig.worker : undefined,
        subagentTier: legacyExplicit ? modelConfig.subagent : undefined,
        explicit: legacyExplicit,
      },
    );
    if (composed.roles) modelConfig.roles = composed.roles;
    for (const w of composed.warnings) console.warn(chalk.yellow(`  [models.json] ${w}`));

    // Validate: extended context only works with sonnet (opus always has 1M, haiku doesn't support it)
    const workerIsSonnet = modelConfig.worker === "sonnet" || modelConfig.worker === "sonnet-4-6";
    const workerIsHaiku = modelConfig.worker === "haiku" || modelConfig.worker === "haiku-4-5";
    if (modelConfig.extendedContext && !workerIsSonnet) {
      if (workerIsHaiku) {
        throw new InvalidArgumentError(
          "Extended context (1M tokens) is not supported with haiku. Use opus or sonnet for the worker model.",
        );
      }
      // For opus variants, silently ignore --extended-context since 1M is already included
      modelConfig.extendedContext = false;
    }

    const options: CLIOptions = {
      project: projectDir,
      feature,
      concurrency,
      maxCycles,
      usageThreshold,
      skipCodex: Boolean(opts.skipCodex),
      skipFlowReview: Boolean(opts.skipFlowReview),
      skipDesignSpecUpdate: Boolean(opts.skipDesignSpecUpdate),
      dryRun: Boolean(opts.dryRun),
      resume: false,
      verbose: Boolean(opts.verbose),
      contextFile: opts.contextFile ? path.resolve(opts.contextFile as string) : null,
      currentBranch: Boolean(opts.currentBranch),
      workerRuntime: opts.workerRuntime as WorkerRuntime,
      forceResume: false,
      modelConfig,
    };

    // Acquire process lock to prevent concurrent invocations (#10)
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await acquireProcessLock(projectDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nCannot start conductor: ${message}\n`));
      process.exit(1);
    }

    // v0.7.6 Hook 1: post-lock state classification. Only missing /
    // completed / failed may proceed into StateManager.initialize(). Every
    // other read-state result aborts with clear recovery guidance.
    const preStartState = await readState(projectDir);
    const exitReleasingLock = async (code: number): Promise<never> => {
      if (releaseLock) { try { await releaseLock(); } catch { /* best effort */ } releaseLock = undefined; }
      process.exit(code);
    };

    if (preStartState.status === "unreadable") {
      console.error(chalk.red(
        `\nCannot read .conductor/state.json: ${preStartState.error}\n\n` +
        `This is not a missing-file case — check filesystem permissions,\n` +
        `disk health, or whether another process has the file open.\n`
      ));
      await exitReleasingLock(1);
    }

    if (preStartState.status === "invalid") {
      console.error(chalk.red(
        `\nExisting .conductor/state.json is invalid and cannot be classified:\n` +
        preStartState.errors.map((e) => `  - ${e}`).join("\n") + "\n\n" +
        `Options:\n` +
        `  - Inspect manually: ls .conductor/ && cat .conductor/state.json\n` +
        `  - Quarantine:       mv .conductor .conductor-corrupt-$(date +%s)\n` +
        `  - Start fresh (destructive): rm -rf .conductor/ (loses prior run)\n` +
        `Note: \`conduct archive --force\` does NOT recover invalid state — the archiver re-reads via the same validator.\n`
      ));
      await exitReleasingLock(1);
    }

    if (preStartState.status === "ok") {
      const s = preStartState.state.status;
      if (s === "paused" || s === "escalated") {
        console.error(chalk.red(
          `\nA prior '${s}' conductor run is present in this project.\n` +
          `  Feature: ${preStartState.state.feature}\n\n` +
          `Options:\n` +
          `  - Resume it:        conduct resume --project "${projectDir}"\n` +
          `  - Archive + start:  conduct archive --force --yes --project "${projectDir}" && conduct start ...\n`
        ));
        await exitReleasingLock(2);
      }
      const NON_TERMINAL_STUCK: OrchestratorStatus[] = [
        "initializing", "questioning", "planning", "executing",
        "reviewing", "flow_tracing", "checkpointing",
      ];
      if (NON_TERMINAL_STUCK.includes(s)) {
        console.error(chalk.red(
          `\nA prior conductor run is in '${s}' state but no process is active.\n` +
          `This usually means a previous run crashed mid-${s}.\n` +
          `  Feature: ${preStartState.state.feature}\n\n` +
          `Options:\n` +
          `  - Force-resume:     conduct resume --force-resume --project "${projectDir}"\n` +
          `  - Archive + start:  conduct archive --force --yes --project "${projectDir}" && conduct start ...\n`
        ));
        await exitReleasingLock(2);
      }
      // Only `completed` and `failed` reach here — Hook 2 will auto-archive.
    }
    // status === "missing" falls through: nothing to guard.

    // v0.7.6 Hook 2: recover partial archives, then auto-archive stale
    // terminal (completed/failed) state so the new run starts clean.
    // Fail-closed — archival failure refuses the start (don't clobber).
    try {
      await finalizePartialArchive(projectDir);
      const detection = await detectStaleTerminalState(projectDir);
      if (detection.stale && detection.slug) {
        console.log(chalk.gray(
          `[conduct] Detected prior ${detection.status} run — archiving to .conductor/archive/${detection.slug}/...`
        ));
        const result = await archiveCurrentRun(projectDir, {
          archivedBy: "auto-stale-on-start",
        });
        console.log(chalk.gray(`[conduct] Archived to ${result.archivePath}`));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(
        `\nStale-state archival failed: ${message}\n\n` +
        `Refusing to start — proceeding would overwrite the prior run's artifacts.\n\n` +
        `Options:\n` +
        `  - Inspect:    ls .conductor/\n` +
        `  - Retry manually: conduct archive --yes --project "${projectDir}" && conduct start ...\n` +
        `  - Quarantine: mv .conductor .conductor-archive-failed-$(date +%s)\n`
      ));
      await exitReleasingLock(1);
    }

    try {
      const orchestrator = new Orchestrator(options);

      // Graceful shutdown on SIGINT/SIGTERM (#19)
      // Double-SIGINT protection: second signal forces immediate exit
      const shutdown = async () => {
        if (shutdownInProgress) {
          console.log('\nForce exit (second signal)');
          process.exit(1);
        }
        shutdownInProgress = true;
        console.log('\nGraceful shutdown initiated...');
        try {
          await orchestrator.shutdown();
        } catch {
          // Best effort
        }
        // Release lock BEFORE exiting to prevent stale locks (H31 fix)
        if (releaseLock) {
          try { await releaseLock(); } catch { /* best effort */ }
          releaseLock = undefined;
        }
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await orchestrator.run();
    } catch (err) {
      // ConductorExitError: orchestrator requested clean exit (e.g. escalation).
      // H-2 FIX: Release lock before process.exit() to prevent stale locks
      if (err instanceof ConductorExitError) {
        if (releaseLock) {
          try { await releaseLock(); } catch { /* best effort */ }
          releaseLock = undefined;
        }
        process.exit(err.exitCode);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nConductor failed: ${message}\n`));
      process.exit(1);
    } finally {
      if (releaseLock) {
        await releaseLock();
      }
    }
  });

// ============================================================
// status command
// ============================================================

program
  .command("status")
  .description("Show current conductor status")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .action(async (opts: Record<string, string>) => {
    const projectDir = path.resolve(opts.project);

    const stateResult = await readState(projectDir);
    if (stateResult.status === "missing") {
      console.log(chalk.yellow("\nNo conductor state found in this project."));
      console.log(chalk.gray(`Looked in: ${getStatePath(projectDir)}\n`));
      return;
    }
    if (stateResult.status === "unreadable") {
      console.error(chalk.red(`\nCannot read conductor state file: ${stateResult.error}`));
      console.error(chalk.gray(`File: ${getStatePath(projectDir)}\n`));
      return;
    }
    if (stateResult.status === "invalid") {
      console.error(chalk.red("\nConductor state file exists but is invalid:"));
      for (const error of stateResult.errors) {
        console.error(chalk.yellow(`  - ${error}`));
      }
      console.error(chalk.gray(`File: ${getStatePath(projectDir)}\n`));
      return;
    }
    const state = stateResult.state;

    const tasks = await readAllTasks(projectDir);
    const completed = tasks.filter((t) => t.status === "completed");
    const failed = tasks.filter((t) => t.status === "failed");
    const pending = tasks.filter((t) => t.status === "pending");
    const inProgress = tasks.filter((t) => t.status === "in_progress");

    // Status color
    const statusColors: Record<string, (s: string) => string> = {
      initializing: chalk.blue,
      questioning: chalk.blue,
      planning: chalk.cyan,
      executing: chalk.green,
      reviewing: chalk.magenta,
      flow_tracing: chalk.magenta,
      checkpointing: chalk.cyan,
      paused: chalk.yellow,
      completed: chalk.green,
      failed: chalk.red,
      escalated: chalk.red,
    };

    const colorFn = statusColors[state.status] ?? chalk.white;

    console.log("");
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log(chalk.bold.cyan("  C3 CONDUCTOR STATUS"));
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log("");
    console.log(chalk.white(`  Status:       `) + colorFn(state.status.toUpperCase()));
    if (state.progress) {
      console.log(chalk.white(`  Progress:     `) + chalk.yellow(state.progress));
    }
    console.log(chalk.white(`  Feature:      ${state.feature}`));
    console.log(chalk.white(`  Branch:       ${state.branch}`));
    console.log(chalk.white(`  Runtime:      ${state.worker_runtime}`));
    if (state.model_config) {
      console.log(chalk.white(`  Worker Model: ${state.model_config.worker}`));
      console.log(chalk.white(`  Agent Model:  ${state.model_config.subagent}`));
      const w = state.model_config.worker;
      if (w === "opus" || w === "opus-4-6" || w === "opus-4-7") {
        console.log(chalk.white(`  Context:      1M tokens (included)`));
      } else if (state.model_config.extendedContext && (w === "sonnet" || w === "sonnet-4-6")) {
        console.log(chalk.white(`  Context:      1M tokens (extra usage)`));
      }
    }
    console.log(chalk.white(`  Cycle:        ${state.current_cycle} / ${state.max_cycles}`));
    console.log(chalk.white(`  Concurrency:  ${state.concurrency}`));
    console.log(chalk.white(`  Started:      ${state.started_at}`));
    console.log(chalk.white(`  Updated:      ${state.updated_at}`));
    console.log("");

    // Task summary
    console.log(chalk.bold("  Tasks:"));
    console.log(chalk.green(`    Completed:    ${completed.length}`));
    console.log(chalk.red(`    Failed:       ${failed.length}`));
    console.log(chalk.yellow(`    Pending:      ${pending.length}`));
    console.log(chalk.cyan(`    In Progress:  ${inProgress.length}`));
    console.log(chalk.white(`    Total:        ${tasks.length}`));
    console.log("");

    // Usage
    console.log(chalk.bold("  Usage:"));
    printUsageSnapshot(`    Active (${state.worker_runtime})`, state.usage);
    if (state.claude_usage && state.worker_runtime !== "claude") {
      printUsageSnapshot("    Claude SDK", state.claude_usage);
    }
    if (state.codex_usage && state.worker_runtime !== "codex") {
      printUsageSnapshot("    Codex CLI", state.codex_usage);
    }
    console.log("");

    // Pause info
    if (state.status === "paused" && state.paused_at) {
      console.log(chalk.yellow.bold("  Paused:"));
      console.log(chalk.yellow(`    Paused at:    ${state.paused_at}`));
      if (state.resume_after) {
        console.log(chalk.yellow(`    Resume after: ${state.resume_after}`));
      }
      console.log("");
    }

    // Active sessions
    if (state.active_session_ids.length > 0) {
      console.log(chalk.bold("  Active Sessions:"));
      for (const sid of state.active_session_ids) {
        console.log(chalk.cyan(`    - ${sid}`));
      }
      console.log("");
    }

    // Cycle history
    if (state.cycle_history.length > 0) {
      console.log(chalk.bold("  Cycle History:"));
      for (const cycle of state.cycle_history) {
        const duration = formatDuration(cycle.duration_ms);
        const planApproved = cycle.codex_plan_approved
          ? chalk.green("approved")
          : chalk.red("not approved");
        const codeApproved = cycle.codex_code_approved
          ? chalk.green("approved")
          : chalk.red("not approved");
        const flowInfo = cycle.flow_tracing
          ? `, flow: ${cycle.flow_tracing.total_findings} finding(s)`
          : "";
        console.log(
          chalk.white(
            `    Cycle ${cycle.cycle}: ${cycle.tasks_completed} completed, ` +
            `${cycle.tasks_failed} failed, plan ${planApproved}, ` +
            `code ${codeApproved}${flowInfo}, ${duration}`,
          ),
        );
        // Phase durations breakdown
        if (cycle.phase_durations) {
          const pd = cycle.phase_durations;
          const parts: string[] = [];
          if (pd.planning_ms) parts.push(`plan: ${formatDuration(pd.planning_ms)}`);
          if (pd.conventions_ms) parts.push(`conventions: ${formatDuration(pd.conventions_ms)}`);
          if (pd.execution_ms) parts.push(`exec: ${formatDuration(pd.execution_ms)}`);
          if (pd.code_review_ms) parts.push(`review: ${formatDuration(pd.code_review_ms)}`);
          if (pd.flow_tracing_ms) parts.push(`flow: ${formatDuration(pd.flow_tracing_ms)}`);
          if (parts.length > 0) {
            console.log(chalk.gray(`             Phases: ${parts.join(", ")}`));
          }
        }
        // Blast radius summary
        if (cycle.blast_radius) {
          const br = cycle.blast_radius;
          const brInfo = `${br.files_changed} files, +${br.lines_added}/-${br.lines_removed} lines`;
          const warningCount = br.warnings.length > 0 ? chalk.yellow(` (${br.warnings.length} warning(s))`) : "";
          console.log(chalk.gray(`             Blast radius: ${brInfo}${warningCount}`));
        }
      }
      console.log("");
    }

    // Event analytics
    try {
      const eventLog = new EventLog(projectDir);
      const analytics = await eventLog.getAnalytics();

      // Only show if there are events
      if (analytics.total_events > 0) {
        console.log(chalk.bold("  Event Analytics:"));

        // Phase durations
        if (Object.keys(analytics.phase_durations).length > 0) {
          console.log(chalk.white("    Average Phase Durations:"));
          for (const [phase, stats] of Object.entries(analytics.phase_durations)) {
            const avgSec = Math.round(stats.avg_ms / 1000);
            console.log(chalk.gray(`      ${phase}: ${avgSec}s avg (${stats.count} runs)`));
          }
        }

        // Worker success rate
        if (analytics.total_workers > 0) {
          const successColor = analytics.worker_success_rate >= 80 ? chalk.green : chalk.yellow;
          console.log(
            chalk.white("    Worker Success Rate: ") +
            successColor(`${analytics.worker_success_rate}%`)
          );
        }

        // Task retry rate - only show if > 0
        if (analytics.task_retry_rate > 0) {
          console.log(
            chalk.white("    Task Retry Rate: ") +
            chalk.yellow(`${analytics.task_retry_rate}%`)
          );
        }

        // Top bottleneck tasks (top 3)
        if (analytics.top_bottleneck_tasks.length > 0) {
          console.log(chalk.white("    Top Bottleneck Tasks:"));
          for (const task of analytics.top_bottleneck_tasks.slice(0, 3)) {
            const durationMin = Math.round(task.duration_ms / 60000);
            console.log(chalk.gray(`      ${task.task_id}: ${durationMin}m`));
          }
        }

        console.log("");
      }
    } catch {
      // Event log may not exist yet - that's fine
    }

    // Task details
    if (tasks.length > 0) {
      console.log(chalk.bold("  Task Details:"));
      for (const task of tasks) {
        const statusIcon =
          task.status === "completed"
            ? chalk.green("[DONE]")
            : task.status === "failed"
              ? chalk.red("[FAIL]")
              : task.status === "in_progress"
                ? chalk.cyan("[WORK]")
                : chalk.gray("[PEND]");

        console.log(`    ${statusIcon} ${chalk.white(task.id)}: ${task.subject}`);
        if (task.owner) {
          console.log(chalk.gray(`           Owner: ${task.owner}`));
        }
        if (task.result_summary) {
          console.log(
            chalk.gray(`           Result: ${task.result_summary.substring(0, 80)}`),
          );
        }
      }
      console.log("");
    }

    console.log(chalk.bold.cyan("=".repeat(60)) + "\n");
  });

// ============================================================
// resume command
// ============================================================

program
  .command("resume")
  .description("Resume a paused conductor run")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("-c, --concurrency <n>", "Number of parallel workers")
  .option("--usage-threshold <n>", "Wind-down usage threshold (0-1)")
  .option("--skip-codex", "Skip Codex reviews", false)
  .option("--skip-flow-review", "Skip flow-tracing review phase", false)
  .option("--skip-design-spec-update", "Skip post-cycle design spec update", false)
  .option("--worker-runtime <runtime>", "Worker execution backend: claude or codex", parseWorkerRuntime)
  .option("--worker-model <tier>", "Legacy: model tier for execution workers.", parseModelTier)
  .option("--subagent-model <tier>", "Legacy: model tier for sentinel + analyzers.", parseModelTier)
  .option("--extended-context", "Use 1M token context for sonnet workers (billed as extra usage; opus always has 1M included)", false)
  .option("--planner-model <tier>", "Model for the planner role.", parseModelTier)
  .option("--planner-effort <level>", "Effort level for the planner.", parseEffortLevel)
  .option("--security-model <tier>", "Model for security worker + sentinel.", parseModelTier)
  .option("--security-effort <level>", "Effort level for security + sentinel.", parseEffortLevel)
  .option("--frontend-model <tier>", "Model for frontend_ui workers.", parseModelTier)
  .option("--frontend-effort <level>", "Effort level for frontend workers.", parseEffortLevel)
  .option("--backend-model <tier>", "Model for backend-class workers.", parseModelTier)
  .option("--backend-effort <level>", "Effort level for backend workers.", parseEffortLevel)
  .option("--analyzer-model <tier>", "Model for read-only analyzer agents.", parseModelTier)
  .option("--analyzer-effort <level>", "Effort level for analyzer agents.", parseEffortLevel)
  .option("--default-effort <level>", "Effort level applied to roles without a group flag.", parseEffortLevel)
  .option("--force-resume", "Force resume even if state is stale (for example stuck in executing)", false)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const projectDir = path.resolve(opts.project as string);

    const stateResult = await readState(projectDir);
    if (stateResult.status === "missing") {
      console.error(chalk.red("\nNo conductor state found. Nothing to resume.\n"));
      process.exit(1);
    }
    if (stateResult.status === "unreadable") {
      console.error(chalk.red(`\nCannot read conductor state file: ${stateResult.error}`));
      console.error(chalk.gray(`File: ${getStatePath(projectDir)}\n`));
      process.exit(1);
    }
    if (stateResult.status === "invalid") {
      console.error(chalk.red("\nConductor state file exists but is invalid:"));
      for (const error of stateResult.errors) {
        console.error(chalk.yellow(`  - ${error}`));
      }
      console.error(chalk.gray(`File: ${getStatePath(projectDir)}\n`));
      process.exit(1);
    }
    const state = stateResult.state;

    if (state.status === "completed" || state.status === "failed") {
      console.error(
        chalk.red(
          `\nConductor is in '${state.status}' state. ` +
          `Start a new run instead of resuming.\n`,
        ),
      );
      process.exit(1);
    }

    const forceResume = Boolean(opts.forceResume);
    const resumableStatuses = new Set(["paused", "escalated"]);
    const forceableStatuses = new Set(["executing", "planning", "reviewing", "checkpointing", "flow_tracing"]);

    if (!resumableStatuses.has(state.status)) {
      if (!forceResume || !forceableStatuses.has(state.status)) {
        console.error(
          chalk.red(
            `\nConductor is in '${state.status}' state, not 'paused' or 'escalated'. ` +
            `Cannot resume.\n`,
          ),
        );
        if (forceableStatuses.has(state.status)) {
          console.error(
            chalk.yellow("If this state is stale, retry with: conduct resume --force-resume ...\n"),
          );
        }
        process.exit(1);
      }

      console.log(
        chalk.yellow(
          `\nForce-resuming conductor from stale '${state.status}' state for: ${state.feature}\n`,
        ),
      );
    } else {
      console.log(chalk.cyan(`\nResuming conductor for: ${state.feature}\n`));
    }

    // Resolve model config: CLI flags override > saved state > defaults
    const hasModelFlags = Boolean(opts.workerModel || opts.subagentModel || opts.extendedContext);
    const savedModelConfig = state.model_config ?? DEFAULT_MODEL_CONFIG;
    const resumeModelConfig: ModelConfig = hasModelFlags
      ? {
          worker: (opts.workerModel as ClaudeModelTier) ?? savedModelConfig.worker,
          subagent: (opts.subagentModel as ClaudeModelTier) ?? savedModelConfig.subagent,
          extendedContext: opts.extendedContext ? Boolean(opts.extendedContext) : savedModelConfig.extendedContext,
          roles: savedModelConfig.roles,
        }
      : { ...savedModelConfig };

    // Re-merge per-role overrides via composeRoleConfig with the saved
    // state's roles as the seed. Resume only expands legacy tiers from
    // CLI flags — saved state's worker/subagent are intentionally not
    // re-expanded (they were either already expanded into roles at start
    // time or the user originally chose per-role defaults). When the user
    // passes legacy flags now, we read the resolved tiers from
    // `resumeModelConfig` (which already fused CLI flags over saved state
    // on lines 1088-1096 above).
    const resumeLegacyExplicit = Boolean(opts.workerModel || opts.subagentModel);
    const resumeComposed = await composeRoleConfig(
      projectDir,
      opts,
      {
        workerTier: resumeLegacyExplicit ? resumeModelConfig.worker : undefined,
        subagentTier: resumeLegacyExplicit ? resumeModelConfig.subagent : undefined,
        explicit: resumeLegacyExplicit,
      },
      resumeModelConfig.roles,
    );
    if (resumeComposed.roles) {
      resumeModelConfig.roles = resumeComposed.roles;
    } else {
      delete resumeModelConfig.roles;
    }
    for (const w of resumeComposed.warnings) console.warn(chalk.yellow(`  [models.json] ${w}`));

    // Validate bounds for CLI overrides on resume (#20 - security: reject extreme values)
    // H-3 FIX: Validate concurrency when overridden (matches start command validation)
    if (opts.concurrency) {
      const c = parseInt(opts.concurrency as string, 10);
      validateBounds("concurrency", c, 1, 10);
    }
    if (opts.usageThreshold) {
      const threshold = parseFloat(opts.usageThreshold as string);
      validateBounds("usageThreshold", threshold, 0.1, 1.0);
    }

    const options: CLIOptions = {
      project: projectDir,
      feature: state.feature,
      concurrency: opts.concurrency
        ? parseInt(opts.concurrency as string, 10)
        : state.concurrency,
      maxCycles: state.max_cycles,
      usageThreshold: opts.usageThreshold
        ? parseFloat(opts.usageThreshold as string)
        : state.usage_threshold ?? DEFAULT_USAGE_THRESHOLD,
      skipCodex: Boolean(opts.skipCodex),
      skipFlowReview: Boolean(opts.skipFlowReview),
      skipDesignSpecUpdate: Boolean(opts.skipDesignSpecUpdate),
      dryRun: false,
      resume: true,
      verbose: Boolean(opts.verbose),
      contextFile: null,
      currentBranch: false,
      workerRuntime: opts.workerRuntime
        ? opts.workerRuntime as WorkerRuntime
        : state.worker_runtime,
      forceResume,
      modelConfig: resumeModelConfig,
    };

    // Acquire process lock to prevent concurrent invocations (#10)
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await acquireProcessLock(projectDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nCannot resume conductor: ${message}\n`));
      process.exit(1);
    }

    // v0.7.6: clean up any leftover partial-archive marker before resuming.
    // Resume never auto-archives — the run being resumed is by definition
    // non-terminal.
    try {
      await finalizePartialArchive(projectDir);
    } catch (err) {
      console.warn(chalk.yellow(
        `[conduct] finalizePartialArchive failed during resume (continuing): ${err instanceof Error ? err.message : String(err)}`
      ));
    }

    try {
      const orchestrator = new Orchestrator(options);

      // Graceful shutdown on SIGINT/SIGTERM (#19)
      // Double-SIGINT protection: second signal forces immediate exit
      const shutdown = async () => {
        if (shutdownInProgress) {
          console.log('\nForce exit (second signal)');
          process.exit(1);
        }
        shutdownInProgress = true;
        console.log('\nGraceful shutdown initiated...');
        try {
          await orchestrator.shutdown();
        } catch {
          // Best effort
        }
        // Release lock BEFORE exiting to prevent stale locks (H31 fix)
        if (releaseLock) {
          try { await releaseLock(); } catch { /* best effort */ }
          releaseLock = undefined;
        }
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await orchestrator.run();
    } catch (err) {
      // H-2 FIX: Release lock before process.exit() to prevent stale locks
      if (err instanceof ConductorExitError) {
        if (releaseLock) {
          try { await releaseLock(); } catch { /* best effort */ }
          releaseLock = undefined;
        }
        process.exit(err.exitCode);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nResume failed: ${message}\n`));
      process.exit(1);
    } finally {
      if (releaseLock) {
        await releaseLock();
      }
    }
  });

// ============================================================
// pause command
// ============================================================

program
  .command("pause")
  .description("Signal a running conductor to pause gracefully")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .action(async (opts: Record<string, string>) => {
    const projectDir = path.resolve(opts.project);

    const stateResult = await readState(projectDir);
    if (stateResult.status === "missing") {
      console.error(chalk.red("\nNo conductor state found. Nothing to pause.\n"));
      process.exit(1);
    }
    if (stateResult.status === "unreadable") {
      console.error(chalk.red(`\nCannot read conductor state file: ${stateResult.error}`));
      console.error(chalk.gray(`File: ${getStatePath(projectDir)}\n`));
      process.exit(1);
    }
    if (stateResult.status === "invalid") {
      console.error(chalk.red("\nConductor state file exists but is invalid:"));
      for (const error of stateResult.errors) {
        console.error(chalk.yellow(`  - ${error}`));
      }
      console.error(chalk.gray(`File: ${getStatePath(projectDir)}\n`));
      process.exit(1);
    }
    const state = stateResult.state;

    if (state.status !== "executing" && state.status !== "planning" && state.status !== "reviewing") {
      console.error(
        chalk.red(
          `\nConductor is in '${state.status}' state. ` +
          `Can only pause when executing, planning, or reviewing.\n`,
        ),
      );
      process.exit(1);
    }

    // Write the pause signal file
    const signalPath = getPauseSignalPath(projectDir);
    const signal = {
      requested_at: new Date().toISOString(),
      requested_by: "user",
    };
    await fs.writeFile(signalPath, JSON.stringify(signal, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });

    console.log(chalk.yellow("\n  Pause signal sent."));
    console.log(chalk.yellow("  The conductor will pause after current workers finish their tasks."));
    console.log(chalk.yellow(`  Resume later with: conduct resume --project "${projectDir}"\n`));
  });

// ============================================================
// log command
// ============================================================

program
  .command("log")
  .description("Tail the conductor log")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("-n, --lines <n>", "Number of lines to show", "50")
  .action(async (opts: Record<string, string>) => {
    const projectDir = path.resolve(opts.project);
    const logPath = path.join(getLogsDir(projectDir), "conductor.log");
    const numLines = parseInt(opts.lines, 10) || 50;

    try {
      const content = await fs.readFile(logPath, "utf-8");
      const lines = content.split("\n");
      const tail = lines.slice(-numLines);

      console.log(chalk.bold.cyan(`\n--- ${logPath} (last ${numLines} lines) ---\n`));

      for (const line of tail) {
        if (line.includes("[ERROR]")) {
          console.log(chalk.red(line));
        } else if (line.includes("[WARN]")) {
          console.log(chalk.yellow(line));
        } else if (line.includes("[DEBUG]")) {
          console.log(chalk.gray(line));
        } else {
          console.log(line);
        }
      }

      console.log(chalk.bold.cyan("\n--- end of log ---\n"));
    } catch {
      console.error(chalk.red(`\nLog file not found: ${logPath}\n`));
      console.error(
        chalk.gray("Make sure a conductor run has been started in this project."),
      );
      process.exit(1);
    }
  });

// ============================================================
// archive command group (v0.7.6)
// ============================================================

/** Parse ISO date or a relative like "7d", "24h", "30m". Returns a Date. */
function parseDateArg(name: string, v: string): Date {
  const rel = /^(\d+)([dhm])$/i.exec(v);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const multiplier = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    return new Date(Date.now() - n * multiplier);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new InvalidArgumentError(`--${name} must be ISO date or relative (e.g. 7d/24h/30m), got: ${v}`);
  }
  return d;
}

function parseArchiveStatusArg(v: string): "completed" | "failed" {
  const t = v.trim().toLowerCase();
  if (t === "completed" || t === "failed") return t;
  throw new InvalidArgumentError(`--status must be completed or failed, got: ${v}`);
}

async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const { stdin: input, stdout: output } = await import("node:process");
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    const t = answer.trim().toLowerCase();
    return t === "y" || t === "yes";
  } finally {
    rl.close();
  }
}

const archiveCmd = program
  .command("archive")
  .description("Archive the current terminal run (also: list / inspect / prune subcommands)")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("--slug <name>", "Override auto-derived slug (timestamp is still appended)")
  .option("--force", "Archive even if run is paused/escalated (destructive)", false)
  .option("--yes", "Skip confirmation prompts", false)
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const projectDir = path.resolve(opts.project as string);

    // Status-first classification to produce spec-accurate exit codes.
    const prelim = await readState(projectDir);
    if (prelim.status === "missing") {
      console.error(chalk.red("\nNo conductor run found in this project. Nothing to archive.\n"));
      process.exit(1);
    }
    if (prelim.status === "unreadable") {
      console.error(chalk.red(`\nCannot read conductor state: ${prelim.error}\n`));
      process.exit(1);
    }
    if (prelim.status === "invalid") {
      console.error(chalk.red("\nConductor state file exists but is invalid:"));
      for (const e of prelim.errors) console.error(chalk.yellow(`  - ${e}`));
      console.error(chalk.gray(
        `\nArchival requires a valid state.json. Inspect or quarantine manually:\n` +
        `  - mv .conductor .conductor-corrupt-$(date +%s)\n`
      ));
      process.exit(1);
    }

    const classifyActionable = (s: OrchestratorStatus): "terminal" | "resumable" | "active" => {
      if (s === "completed" || s === "failed") return "terminal";
      if (s === "paused" || s === "escalated") return "resumable";
      return "active";
    };

    let actionable = classifyActionable(prelim.state.status);
    const force = Boolean(opts.force);

    if (actionable === "active") {
      console.error(chalk.red(
        `\nRun is active ('${prelim.state.status}'). Wait for it to finish, or run \`conduct pause\` first.\n`
      ));
      process.exit(1);
    }
    if (actionable === "resumable" && !force) {
      console.error(chalk.red(
        `\nRun is '${prelim.state.status}'. Use \`conduct resume\` to continue, or pass --force --yes to archive anyway.\n`
      ));
      process.exit(2);
    }
    if (actionable === "resumable" && force && !opts.yes) {
      const ok = await promptYesNo(
        chalk.yellow(`Run is '${prelim.state.status}'. Archive it anyway (destructive)? [y/N]: `)
      );
      if (!ok) {
        console.log("Cancelled.");
        process.exit(0);
      }
    }

    // Acquire lock to prevent concurrent mutation during archival.
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await acquireProcessLock(projectDir);
    } catch (err) {
      console.error(chalk.red(`\nCannot archive: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }

    try {
      // Re-read state AFTER lock to close precheck→lock race window.
      const postLock = await readState(projectDir);
      if (postLock.status !== "ok") {
        console.error(chalk.red(
          `\nState changed between precheck and lock acquisition (now '${postLock.status}'). Please re-run.\n`
        ));
        process.exit(1);
      }
      actionable = classifyActionable(postLock.state.status);
      if (actionable === "active") {
        console.error(chalk.red(
          `\nRun transitioned to active ('${postLock.state.status}') after lock. Refuse to archive.\n`
        ));
        process.exit(1);
      }
      if (actionable === "resumable" && !force) {
        console.error(chalk.red(
          `\nRun transitioned to '${postLock.state.status}' after lock. Pass --force --yes to archive.\n`
        ));
        process.exit(2);
      }

      // Recover any prior partial archive first.
      try {
        await finalizePartialArchive(projectDir);
      } catch (err) {
        console.warn(chalk.yellow(
          `[conduct] finalizePartialArchive failed (continuing): ${err instanceof Error ? err.message : String(err)}`
        ));
      }

      const result = await archiveCurrentRun(projectDir, {
        archivedBy: "manual",
        force,
        slug: (opts.slug as string | undefined) ?? undefined,
      });
      console.log(chalk.green(`\nArchived to .conductor/archive/${result.slug}/\n`));
    } catch (err) {
      if (err instanceof ArchiveRefusedError) {
        console.error(chalk.red(`\n${err.message}\n`));
        process.exit(2);
      }
      console.error(chalk.red(`\nArchive failed: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    } finally {
      if (releaseLock) { try { await releaseLock(); } catch { /* best effort */ } }
    }
  });

archiveCmd
  .command("list")
  .description("List archived runs, sorted by date descending")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("--json", "Machine-readable output", false)
  .option("--status <status>", "Filter to completed|failed", parseArchiveStatusArg)
  .option("--since <date>", "Show archives since ISO date or relative (e.g. 7d)",
    (v: string) => parseDateArg("since", v))
  .action(async (opts: Record<string, string | boolean | Date | undefined>) => {
    const projectDir = path.resolve(opts.project as string);
    const all = await listArchives(projectDir);
    const statusFilter = opts.status as ("completed" | "failed" | undefined);
    const since = opts.since as (Date | undefined);
    const filtered = all.filter((e) => {
      if (statusFilter && e.meta.final_status !== statusFilter) return false;
      if (since && new Date(e.meta.archived_at) < since) return false;
      return true;
    });

    if (opts.json) {
      // Emit dirSlug alongside the meta so JSON consumers can pass the
      // unambiguous slug to `archive inspect` / `archive prune`.
      console.log(JSON.stringify(
        filtered.map((e) => ({ dir_slug: e.dirSlug, ...e.meta })),
        null,
        2,
      ));
      return;
    }

    if (filtered.length === 0) {
      console.log(chalk.gray("\nNo archived runs found.\n"));
      return;
    }

    // Print a simple fixed-column table. SLUG is the actual directory name
    // (dirSlug), which is what users pass to `inspect` / `prune`.
    const rows: string[][] = [["SLUG", "DATE", "STATUS", "CYCLES", "TASKS"]];
    for (const e of filtered) {
      const m = e.meta;
      const date = m.archived_at.slice(0, 16).replace("T", " ");
      const cycles = m.summary ? `${m.summary.cycles_run}/${m.summary.max_cycles}` : "-";
      const tasks = m.summary
        ? `${m.summary.tasks_completed} done${m.summary.tasks_failed ? ", " + m.summary.tasks_failed + " failed" : ""}`
        : "-";
      rows.push([e.dirSlug, date, m.final_status, cycles, tasks]);
    }
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    for (const row of rows) {
      console.log(row.map((c, i) => c.padEnd(widths[i])).join("  "));
    }
    console.log("");
  });

archiveCmd
  .command("inspect <slug>")
  .description("Show details of an archived run (read-only)")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("--json", "Machine-readable output", false)
  .action(async (slug: string, opts: Record<string, string | boolean | undefined>) => {
    const projectDir = path.resolve(opts.project as string);
    try {
      const entry = await readArchive(projectDir, slug);
      const meta = entry.meta;
      if (opts.json) {
        console.log(JSON.stringify({ dir_slug: entry.dirSlug, ...meta }, null, 2));
        return;
      }
      console.log("");
      console.log(chalk.bold.cyan("=".repeat(60)));
      console.log(chalk.bold.cyan(`  ARCHIVED RUN: ${entry.dirSlug}`));
      console.log(chalk.bold.cyan("  (read-only view)"));
      console.log(chalk.bold.cyan("=".repeat(60)));
      console.log("");
      console.log(chalk.white(`  Status:       ${meta.final_status.toUpperCase()}`));
      console.log(chalk.white(`  Archived:     ${meta.archived_at}`));
      console.log(chalk.white(`  Archived By:  ${meta.archived_by}`));
      console.log(chalk.white(`  Version:      archive_version=${meta.archive_version}, conductor_version=${meta.conductor_version}`));
      if (meta.summary) {
        console.log(chalk.white(`  Feature:      ${meta.summary.feature}`));
        console.log(chalk.white(`  Branch:       ${meta.summary.branch}`));
        console.log(chalk.white(`  Cycles:       ${meta.summary.cycles_run}/${meta.summary.max_cycles}`));
        console.log(chalk.white(`  Tasks:        ${meta.summary.tasks_completed} completed, ${meta.summary.tasks_failed} failed`));
        console.log(chalk.white(`  Started:      ${meta.summary.started_at}`));
        console.log(chalk.white(`  Completed:    ${meta.summary.completed_at}`));
      } else {
        console.log(chalk.gray(`  (No summary available — legacy archive or missing metadata.)`));
      }
      console.log("");
    } catch (err) {
      if (err instanceof ArchiveNotFoundError) {
        console.error(chalk.red(`\nArchive not found: ${slug}\n`));
        process.exit(1);
      }
      console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  });

archiveCmd
  .command("prune")
  .description("Delete archived runs matching filters")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("--before <date>", "Delete archives older than this date (ISO or relative)",
    (v: string) => parseDateArg("before", v))
  .option("--keep-last <n>", "Keep the N most recent, delete the rest", (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new InvalidArgumentError(`--keep-last must be a non-negative integer, got: ${v}`);
    }
    return n;
  })
  .option("--status <status>", "Only consider archives with this status", parseArchiveStatusArg)
  .option("--dry-run", "Preview without deleting", false)
  .option("--yes", "Skip confirmation prompt", false)
  .action(async (opts: Record<string, string | boolean | number | Date | undefined>) => {
    const projectDir = path.resolve(opts.project as string);

    const before = opts.before as (Date | undefined);
    const keepLast = opts.keepLast as (number | undefined);
    const status = opts.status as ("completed" | "failed" | undefined);

    if (before === undefined && keepLast === undefined) {
      console.error(chalk.red(
        "\nprune requires at least one of --before or --keep-last (optionally narrowed by --status).\n"
      ));
      process.exit(1);
    }

    const dryRun = Boolean(opts.dryRun);
    const filter = { beforeDate: before, keepLast, status };

    // First pass: always collect candidates via a dry-run so we can preview.
    const preview = await pruneArchives(projectDir, filter, { dryRun: true });
    if (preview.candidates.length === 0) {
      console.log(chalk.gray("\nNo archives match the filter.\n"));
      return;
    }

    console.log(chalk.white(`\n${dryRun ? "Would delete" : "Will delete"} ${preview.candidates.length} archive(s):`));
    for (const c of preview.candidates) {
      console.log(chalk.gray(`  - ${c.slug} (${c.archivedAt.toISOString().slice(0, 16).replace("T", " ")}) — ${c.reason}`));
    }

    if (dryRun) {
      console.log(chalk.gray(`\nRe-run without --dry-run to delete.\n`));
      return;
    }

    if (!opts.yes) {
      const ok = await promptYesNo(chalk.yellow("\nProceed with deletion? [y/N]: "));
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
    }

    const result = await pruneArchives(projectDir, filter, { dryRun: false });
    console.log(chalk.green(`\nDeleted ${result.deleted.length} archive(s).\n`));
  });

// ============================================================
// Parse
// ============================================================

program.parse();

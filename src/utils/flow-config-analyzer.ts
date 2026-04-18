/**
 * Flow Config Analyzer (v0.7.1)
 *
 * Spawns a read-only agent that inspects the actual codebase and produces
 * a tailored `FlowConfig` matching the project's architecture, rather than
 * relying on a static template alone. The seed template (from
 * `flow-config-generator.ts`) is passed in as a reference structure that
 * the agent can adapt, replace, or extend.
 *
 * Caches the result to `.conductor/flow-config.json` with a 1-hour TTL,
 * matching the pattern used by `conventions-extractor` and
 * `design-spec-analyzer`. If the agent fails or returns malformed output,
 * the function returns the seed template unchanged so init is never blocked.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  FLOW_CONFIG_ANALYZER_MAX_TURNS,
  FLOW_CONFIG_ANALYZER_TIMEOUT_MS,
  DEFAULT_ROLE_CONFIG,
  READ_ONLY_DISALLOWED_TOOLS,
  getFlowConfigPath,
} from "./constants.js";
import { specToSdkArgs } from "./models-config.js";
import { queryWithTimeout } from "./sdk-timeout.js";
import { mkdirSecure } from "./secure-fs.js";
import type { Logger } from "./logger.js";
import type {
  FlowConfig,
  ProjectArchetype,
  ProjectProfile,
  RoleModelSpec,
} from "./types.js";

/** Cache TTL for the analyzed flow-config — matches conventions/design-spec. */
const FLOW_CONFIG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Combined output of the analyzer: tailored flow config + (optionally) a
 * refined archetype if the LLM disagreed with the heuristic detection.
 */
export interface FlowConfigAnalysisResult {
  flowConfig: FlowConfig;
  /** Refined archetype suggested by the LLM, if it differs from `profile.archetype`. */
  refinedArchetype?: ProjectArchetype;
  /** True when the analyzer succeeded; false when we fell back to the seed. */
  analyzed: boolean;
  /** Non-fatal warnings to surface to the caller (e.g. malformed output). */
  warnings: string[];
}

function buildAnalysisPrompt(seed: FlowConfig, profile: ProjectProfile): string {
  const seedJson = JSON.stringify(seed, null, 2);
  const profileSummary = [
    `Languages: ${profile.languages.join(", ") || "(none detected)"}`,
    `Frameworks: ${profile.frameworks.join(", ") || "(none detected)"}`,
    `Test Runners: ${profile.test_runners.join(", ") || "(none)"}`,
    `Linters: ${profile.linters.join(", ") || "(none)"}`,
    `Package Managers: ${profile.package_managers.join(", ") || "(none)"}`,
    `Heuristic Archetype: ${profile.archetype ?? "unknown"}`,
  ].join("\n");

  return [
    "You are a flow-tracing analyst. Your job is to produce a `FlowConfig` JSON",
    "that accurately reflects THIS project's architecture, so that downstream",
    "flow-tracing review workers know which layers, actor types, and edge cases",
    "to look for in this codebase.",
    "",
    "## Detected Project Profile",
    "",
    profileSummary,
    "",
    "## Seed Template (a generic starting point)",
    "",
    "Below is a seed template the system picked based on heuristics. It may be",
    "well-suited to this project, partially relevant, or entirely wrong. Your",
    "job is to inspect the actual codebase and produce a FINAL FlowConfig that",
    "fits the real architecture. Adapt, replace, or extend the seed freely.",
    "",
    "```json",
    seedJson,
    "```",
    "",
    "## What to Investigate",
    "",
    "Use Read, Glob, Grep, Bash, and LSP to understand the project's actual",
    "architecture. Spend most effort here — do NOT just rephrase the seed.",
    "",
    "1. **Layers** — What are the architectural boundaries? Examples:",
    "   - For a web app: pages → API → services → DB",
    "   - For a CLI tool: arg parsing → config loading → core logic → I/O → state → output",
    "   - For an orchestration engine: CLI → orchestrator core → worker pool → IPC/MCP → state → external integrations",
    "   - For a library: public API → input validation → internal logic → side-effect boundary → packaging",
    "   For each layer, list 3-6 concrete checks the flow tracer should perform.",
    "",
    "2. **Actor Types** — Who or what initiates flows? Examples:",
    "   - Web app: owner, admin, member, viewer, anonymous",
    "   - CLI tool: interactive_user, ci_runner, scripted_invocation",
    "   - Library: library_consumer, type_consumer, transitive_dependency_user",
    "   - Orchestration: planner, execution_worker, sentinel, codex_reviewer, orchestrator_loop",
    "",
    "3. **Edge Cases** — What kinds of failures or surprises are worth flagging?",
    "   These should be PROJECT-SPECIFIC, not generic. Look for:",
    "   - Concurrency primitives (lock files, async coordination)",
    "   - State persistence failure modes",
    "   - External-process or external-service boundaries",
    "   - Resource cleanup (signals, timeouts, file handles)",
    "   - Schema migration / version drift",
    "",
    "4. **Example Flows** — 2-5 real user-visible flows in this codebase, each with:",
    "   - id (kebab-case)",
    "   - name (short title)",
    "   - description (1 sentence)",
    "   - entry_points (real file paths from THIS codebase, not made up)",
    "   - actors (subset of actor_types above)",
    "   - edge_cases (project-specific, NOT generic)",
    "",
    "5. **Archetype Refinement** — The heuristic guessed `" + (profile.archetype ?? "unknown") + "`.",
    "   If after inspecting the codebase you disagree, suggest a better one. Valid:",
    "   `cli` | `web` | `library` | `service` | `other`.",
    "",
    "## Output Format",
    "",
    "Output EXACTLY one JSON code block fenced with ```json. The JSON must have",
    "this shape (matches the FlowConfig type plus an optional archetype):",
    "",
    "```json",
    "{",
    '  "archetype": "cli|web|library|service|other",',
    '  "layers": [{ "name": "...", "checks": ["...", "..."] }],',
    '  "actor_types": ["..."],',
    '  "edge_cases": ["..."],',
    '  "example_flows": [',
    '    {',
    '      "id": "kebab-case-id",',
    '      "name": "Short Name",',
    '      "description": "What this flow does in one sentence.",',
    '      "entry_points": ["src/cli.ts", "src/core/something.ts"],',
    '      "actors": ["..."],',
    '      "edge_cases": ["..."]',
    '    }',
    '  ]',
    "}",
    "```",
    "",
    "Be PROJECT-SPECIFIC. Generic web-app boilerplate (owner/admin/member/viewer,",
    "auth/RBAC, pagination) does NOT belong in a CLI tool's flow config. Real",
    "file paths from THIS codebase, real failure modes for THIS architecture.",
  ].join("\n");
}

function tryParseJson(text: string, warn: (msg: string) => void): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    warn(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Best-effort JSON repair (strip // comments, trailing commas, surrounding text). */
function tryFixJson(text: string): string {
  let fixed = text;
  fixed = fixed.replace(/\/\/[^\n]*/g, "");
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");
  const braceStart = fixed.indexOf("{");
  const braceEnd = fixed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    fixed = fixed.substring(braceStart, braceEnd + 1);
  }
  return fixed;
}

const VALID_ARCHETYPES: readonly ProjectArchetype[] = ["cli", "web", "library", "service", "other"];

/**
 * Validate and coerce a parsed JSON object into a FlowConfig. Bad fields fall
 * back to the seed values rather than dropping the whole result, so partial
 * agent output still produces something usable.
 */
function coerceFlowConfig(
  raw: unknown,
  seed: FlowConfig,
  warn: (msg: string) => void,
): { config: FlowConfig; archetype?: ProjectArchetype; usedSeed: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn("Analyzer output was not a JSON object; falling back to seed.");
    return { config: { ...seed }, usedSeed: true };
  }
  const obj = raw as Record<string, unknown>;

  const layers = Array.isArray(obj.layers)
    ? obj.layers
        .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
        .map((l) => ({
          name: typeof l.name === "string" ? l.name : "",
          checks: Array.isArray(l.checks) ? l.checks.filter((c): c is string => typeof c === "string") : [],
        }))
        .filter((l) => l.name.length > 0)
    : seed.layers;

  const actorTypes = Array.isArray(obj.actor_types)
    ? obj.actor_types.filter((a): a is string => typeof a === "string")
    : seed.actor_types;

  const edgeCases = Array.isArray(obj.edge_cases)
    ? obj.edge_cases.filter((e): e is string => typeof e === "string")
    : seed.edge_cases;

  const exampleFlows = Array.isArray(obj.example_flows)
    ? obj.example_flows
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .map((f) => ({
          id: typeof f.id === "string" ? f.id : "",
          name: typeof f.name === "string" ? f.name : "",
          description: typeof f.description === "string" ? f.description : "",
          entry_points: Array.isArray(f.entry_points)
            ? f.entry_points.filter((p): p is string => typeof p === "string")
            : [],
          actors: Array.isArray(f.actors) ? f.actors.filter((a): a is string => typeof a === "string") : [],
          edge_cases: Array.isArray(f.edge_cases) ? f.edge_cases.filter((e): e is string => typeof e === "string") : [],
        }))
        .filter((f) => f.id.length > 0 && f.name.length > 0)
    : seed.example_flows;

  // Empty layers / actors are a strong signal the agent didn't actually analyze
  // anything. Treat that as a failure and fall back to the seed.
  if (layers.length === 0) {
    warn("Analyzer returned zero layers; falling back to seed.");
    return { config: { ...seed }, usedSeed: true };
  }

  const archetype = typeof obj.archetype === "string" && (VALID_ARCHETYPES as readonly string[]).includes(obj.archetype)
    ? (obj.archetype as ProjectArchetype)
    : undefined;

  return {
    config: {
      layers,
      actor_types: actorTypes,
      edge_cases: edgeCases,
      example_flows: exampleFlows,
    },
    archetype,
    usedSeed: false,
  };
}

export interface AnalyzeFlowConfigOptions {
  /**
   * When true, the analyzer does NOT write its result to
   * `.conductor/flow-config.json` and does NOT consult the on-disk cache.
   * Callers (e.g. `conduct init` when a pre-existing config must be
   * preserved) handle persistence themselves. Defaults to false.
   */
  skipCache?: boolean;
}

/**
 * Analyze the project and produce a tailored FlowConfig. Caches the result
 * to `.conductor/flow-config.json` with a 1-hour TTL unless `skipCache`
 * is set.
 *
 * Always non-fatal: on agent error / timeout / malformed output, returns the
 * seed unchanged with a warning.
 */
export async function analyzeFlowConfig(
  projectDir: string,
  seed: FlowConfig,
  profile: ProjectProfile,
  modelSpec?: RoleModelSpec | string,
  logger?: Logger,
  opts: AnalyzeFlowConfigOptions = {},
): Promise<FlowConfigAnalysisResult> {
  const warn = (msg: string) => (logger ? logger.warn(msg) : process.stderr.write(msg + "\n"));
  const warnings: string[] = [];

  const sdkArgs = typeof modelSpec === "string"
    ? { model: modelSpec, effort: DEFAULT_ROLE_CONFIG.flow_config_analyzer.effort }
    : specToSdkArgs(modelSpec ?? DEFAULT_ROLE_CONFIG.flow_config_analyzer);

  // Cache check (skipped when caller manages persistence themselves)
  const cachePath = getFlowConfigPath(projectDir);
  if (!opts.skipCache) {
    try {
      const stat = await fs.stat(cachePath);
      const age = Date.now() - stat.mtimeMs;
      if (age < FLOW_CONFIG_CACHE_TTL_MS) {
        const cachedRaw = await fs.readFile(cachePath, "utf-8");
        const cached = JSON.parse(cachedRaw) as FlowConfig;
        // Trust the cache shape — it was written by us. If it's missing layers,
        // treat as stale and re-analyze.
        if (Array.isArray(cached.layers) && cached.layers.length > 0) {
          return { flowConfig: cached, analyzed: true, warnings: [] };
        }
      }
    } catch {
      // No cache or unreadable — proceed with analysis.
    }
  }

  const prompt = buildAnalysisPrompt(seed, profile);

  let resultText = "";
  try {
    resultText = await queryWithTimeout(
      prompt,
      {
        allowedTools: ["Read", "Glob", "Grep", "Bash", "LSP"],
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // CR-1
        cwd: projectDir,
        maxTurns: FLOW_CONFIG_ANALYZER_MAX_TURNS,
        model: sdkArgs.model,
        effort: sdkArgs.effort,
        settingSources: ["project"],
      },
      FLOW_CONFIG_ANALYZER_TIMEOUT_MS,
      "flow-config-analysis",
      logger,
    );
  } catch (error) {
    const msg = `Flow-config analyzer failed: ${error instanceof Error ? error.message : String(error)}`;
    warn(msg);
    warnings.push(msg);
    return { flowConfig: { ...seed }, analyzed: false, warnings };
  }

  if (!resultText || resultText.trim().length === 0) {
    warn("Flow-config analyzer returned empty output; falling back to seed.");
    return { flowConfig: { ...seed }, analyzed: false, warnings: ["Empty analyzer output"] };
  }

  // Extract JSON from the response (prefer fenced ```json block).
  const fenced = resultText.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  const jsonText = fenced ? fenced[1] : resultText;

  const parsed =
    tryParseJson(jsonText.trim(), warn) ?? tryParseJson(tryFixJson(jsonText.trim()), warn);

  if (parsed === null) {
    const preview = resultText.substring(0, 300);
    warn(`Flow-config analyzer output unparseable. Preview: ${preview}`);
    return { flowConfig: { ...seed }, analyzed: false, warnings: ["Unparseable JSON"] };
  }

  const { config, archetype, usedSeed } = coerceFlowConfig(parsed, seed, (m) => {
    warn(m);
    warnings.push(m);
  });

  // When coerce had to fall back to the seed (malformed agent output), do
  // NOT cache the seed as if it were analyzed output — that would suppress
  // re-analysis for the next hour. Only persist genuine tailored output.
  if (!usedSeed && !opts.skipCache) {
    try {
      await mkdirSecure(path.dirname(cachePath), { recursive: true }); // H-2
      await fs.writeFile(cachePath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch (error) {
      warn(`Failed to cache flow-config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    flowConfig: config,
    refinedArchetype: archetype && archetype !== profile.archetype ? archetype : undefined,
    // analyzed=true means "we got real tailored output from the LLM". A
    // seed-fallback path explicitly returns false so callers (init, status)
    // surface "analyzer fell back" instead of "tailored".
    analyzed: !usedSeed,
    warnings,
  };
}

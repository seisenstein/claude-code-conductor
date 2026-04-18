import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";

import type { InitResult, ProjectProfile } from "../utils/types.js";
import {
  getOrchestratorDir,
  getDesignSpecPath,
  getFlowConfigPath,
  getRulesPath,
  getRecommendedConfigsDir,
  getLogsDir,
  getModelsConfigPath,
  DEFAULT_ROLE_CONFIG,
} from "../utils/constants.js";
import { detectProjectWithCache, cacheProfile } from "./project-detector.js";
import { analyzeDesignSystem } from "../utils/design-spec-analyzer.js";
import { generateFlowConfig } from "../utils/flow-config-generator.js";
import { analyzeFlowConfig } from "../utils/flow-config-analyzer.js";
import { extractProjectRules } from "../utils/rules-extractor.js";
import { ensureGitignore } from "../utils/gitignore.js";
import { Logger } from "../utils/logger.js";
import { mkdirSecure } from "../utils/secure-fs.js";

export interface InitOptions {
  force?: boolean;
  model?: string;
  verbose?: boolean;
}

/** Frameworks that indicate a frontend is present. */
const FRONTEND_FRAMEWORKS = new Set([
  "react",
  "nextjs",
  "vue",
  "angular",
  "svelte",
]);

/**
 * Run project initialization: detect stack, analyze design system,
 * generate flow config, scaffold rules.
 */
export async function runInit(
  projectDir: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const orchestratorDir = getOrchestratorDir(projectDir);
  const logsDir = getLogsDir(projectDir);
  const logger = options.verbose ? new Logger(logsDir, "init") : undefined;

  const result: InitResult = {
    projectProfile: {} as ProjectProfile,
    hasFrontend: false,
    files: { created: [], recommended: [], skipped: [] },
    designSpec: null,
  };

  // 1. Ensure .conductor/ exists and is gitignored
  await mkdirSecure(orchestratorDir, { recursive: true }); // H-2
  await ensureGitignore(projectDir);

  // 2. Detect project
  console.log(chalk.cyan("  Detecting project stack..."));
  const profile = await detectProjectWithCache(projectDir, options.force);
  result.projectProfile = profile;
  console.log(
    chalk.green(`  Detected: `) +
      `${profile.languages.join(", ")} | ` +
      `Frameworks: ${profile.frameworks.length > 0 ? profile.frameworks.join(", ") : "none"} | ` +
      `Tests: ${profile.test_runners.length > 0 ? profile.test_runners.join(", ") : "none"} | ` +
      `Archetype: ${profile.archetype ?? "unknown"}`,
  );

  // 3. Check for frontend
  const hasFrontend = profile.frameworks.some((f) => FRONTEND_FRAMEWORKS.has(f));
  result.hasFrontend = hasFrontend;

  // 4. Generate seed flow config (template based on archetype + framework),
  //    then refine it with the LLM-based flow-config-analyzer that inspects
  //    the actual codebase. The analyzer is non-fatal — if it fails or times
  //    out, we ship the seed and warn.
  //
  //    Important: the analyzer caches its output to .conductor/flow-config.json
  //    as a side-effect, so we must capture pre-existence BEFORE invoking it
  //    (mirrors the design-spec-analyzer pattern at line ~108) to decide
  //    whether the user already had a hand-edited flow-config we should
  //    route to recommended-configs/ instead of overwriting.
  console.log(chalk.cyan("  Generating flow configuration..."));
  const seedFlowConfig = generateFlowConfig(profile);
  const flowConfigPath = getFlowConfigPath(projectDir);
  const flowConfigExistedBeforeAnalysis = await fileExists(flowConfigPath);

  console.log(chalk.cyan("  Refining flow configuration with codebase analysis..."));
  // skipCache: true means the analyzer doesn't touch flow-config.json on
  // disk. We handle the existing-file-safe write below, so a user's
  // hand-edited config never gets clobbered.
  const flowAnalysis = await analyzeFlowConfig(
    projectDir,
    seedFlowConfig,
    profile,
    options.model,
    logger,
    { skipCache: true },
  );
  const flowConfig = flowAnalysis.flowConfig;
  if (flowAnalysis.analyzed) {
    console.log(
      chalk.green(
        `  Flow config tailored: ${flowConfig.layers.length} layers, ` +
          `${flowConfig.actor_types.length} actor type(s), ` +
          `${flowConfig.example_flows.length} example flow(s)`,
      ),
    );
  } else {
    console.log(chalk.yellow("  Flow analyzer fell back to seed template — see warnings above."));
  }
  // If the analyzer suggested a different archetype than the heuristic, persist it.
  if (flowAnalysis.refinedArchetype && flowAnalysis.refinedArchetype !== profile.archetype) {
    console.log(
      chalk.cyan(
        `  Archetype refined: ${profile.archetype ?? "unknown"} → ${flowAnalysis.refinedArchetype}`,
      ),
    );
    profile.archetype = flowAnalysis.refinedArchetype;
    result.projectProfile = profile;
    await cacheProfile(projectDir, profile);
  }

  // Persist via the existing-file-safe writer. Analyzer ran with skipCache,
  // so the on-disk file is untouched at this point — writeConfigFile sees
  // the true pre-state and routes correctly.
  void flowConfigExistedBeforeAnalysis; // (kept for explicit log clarity)
  await writeConfigFile(
    flowConfigPath,
    JSON.stringify(flowConfig, null, 2),
    options.force,
    result,
    projectDir,
  );

  // 4b. Write per-role model + effort defaults (.conductor/models.json).
  //     Materializes DEFAULT_ROLE_CONFIG so users have a starting point they
  //     can edit to tune cost/latency/quality per role.
  const modelsConfigPath = getModelsConfigPath(projectDir);
  const modelsConfigContent = JSON.stringify(
    {
      $schema: "https://raw.githubusercontent.com/anthropics/claude-code-conductor/main/schemas/models-config.schema.json",
      $comment: "Per-role model + effort overrides. Tiers: opus-4-7 | opus-4-6 | sonnet-4-6 | haiku-4-5 (legacy: opus/sonnet/haiku). Efforts: low | medium | high | xhigh | max.",
      roles: DEFAULT_ROLE_CONFIG,
    },
    null,
    2,
  );
  await writeConfigFile(modelsConfigPath, modelsConfigContent, options.force, result, projectDir);

  // 5. Extract rules from project guidance files (CLAUDE.md, .claude/rules/, etc.)
  console.log(chalk.cyan("  Extracting worker rules from project guidance..."));
  const rulesContent = await extractProjectRules(projectDir, options.model, logger);
  const rulesPath = getRulesPath(projectDir);
  await writeConfigFile(rulesPath, rulesContent, options.force, result, projectDir);

  // 6. Analyze design system (only if frontend detected)
  if (hasFrontend) {
    console.log(chalk.cyan("  Analyzing frontend design system..."));
    // Check for existing spec BEFORE calling analyzer (which writes to specPath as cache)
    const specPath = getDesignSpecPath(projectDir);
    const specExistedBeforeAnalysis = await fileExists(specPath);
    const spec = await analyzeDesignSystem(projectDir, options.model, logger);
    if (spec) {
      result.designSpec = spec;
      if (specExistedBeforeAnalysis && !options.force) {
        // Analyzer wrote to specPath (cache), but user had a pre-existing one.
        // Move the analyzer output to recommended-configs.
        const recDir = getRecommendedConfigsDir(projectDir);
        await mkdirSecure(recDir, { recursive: true }); // H-2
        const recPath = path.join(recDir, "design-spec.json");
        // Re-write to recommended path
        await fs.writeFile(recPath, JSON.stringify(spec, null, 2), { encoding: "utf-8", mode: 0o600 });
        result.files.recommended.push(relPath(recPath, projectDir));
      } else {
        result.files.created.push(relPath(specPath, projectDir));
      }
      console.log(
        chalk.green(`  Found ${spec.shared_primitives.length} shared primitives, `) +
          `variant system: ${spec.variant_system.approach}`,
      );
    } else {
      console.log(chalk.yellow("  No frontend components found; skipping design spec."));
    }
  } else {
    console.log(chalk.dim("  No frontend framework detected; skipping design system analysis."));
  }

  // 7. Print summary
  printSummary(result, projectDir);

  return result;
}

/**
 * Write a config file, respecting the existing-file / recommended-configs pattern.
 */
async function writeConfigFile(
  targetPath: string,
  content: string,
  force: boolean | undefined,
  result: InitResult,
  projectDir: string,
): Promise<void> {
  const exists = await fileExists(targetPath);

  if (exists && !force) {
    // Write to recommended-configs/ instead
    const recDir = getRecommendedConfigsDir(projectDir);
    await mkdirSecure(recDir, { recursive: true }); // H-2
    const fileName = path.basename(targetPath);
    const recPath = path.join(recDir, fileName);
    await fs.writeFile(recPath, content, { encoding: "utf-8", mode: 0o600 });
    result.files.recommended.push(relPath(recPath, projectDir));
  } else {
    await mkdirSecure(path.dirname(targetPath), { recursive: true }); // H-2
    await fs.writeFile(targetPath, content, { encoding: "utf-8", mode: 0o600 });
    result.files.created.push(relPath(targetPath, projectDir));
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relPath(absPath: string, projectDir: string): string {
  return path.relative(projectDir, absPath);
}

function printSummary(result: InitResult, projectDir: string): void {
  console.log("");
  console.log(chalk.bold("Init complete."));

  if (result.files.created.length > 0) {
    console.log(chalk.green("  Created:"));
    for (const f of result.files.created) {
      console.log(chalk.green(`    ${f}`));
    }
  }

  if (result.files.recommended.length > 0) {
    console.log("");
    console.log(
      chalk.yellow("  Existing configs detected. Recommended alternatives written to:"),
    );
    for (const f of result.files.recommended) {
      console.log(chalk.yellow(`    ${f}`));
    }
    console.log("");
    console.log(
      chalk.yellow(
        "  Compare these against your current configs and replace them if you prefer\n" +
          "  the new versions. You can find them in:\n" +
          `    ${path.relative(projectDir, getRecommendedConfigsDir(projectDir))}/`,
      ),
    );
  }

  if (result.files.created.length === 0 && result.files.recommended.length === 0) {
    console.log(chalk.dim("  No new files written (all configs already exist)."));
  }

  console.log("");
  console.log(chalk.cyan("  Next: run 'conduct start \"<feature description>\"' to begin."));
}

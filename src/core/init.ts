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
} from "../utils/constants.js";
import { detectProjectWithCache } from "./project-detector.js";
import { analyzeDesignSystem } from "../utils/design-spec-analyzer.js";
import { generateFlowConfig } from "../utils/flow-config-generator.js";
import { extractProjectRules } from "../utils/rules-extractor.js";
import { ensureGitignore } from "../utils/gitignore.js";
import { Logger } from "../utils/logger.js";

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
  await fs.mkdir(orchestratorDir, { recursive: true, mode: 0o700 });
  await ensureGitignore(projectDir);

  // 2. Detect project
  console.log(chalk.cyan("  Detecting project stack..."));
  const profile = await detectProjectWithCache(projectDir, options.force);
  result.projectProfile = profile;
  console.log(
    chalk.green(`  Detected: `) +
      `${profile.languages.join(", ")} | ` +
      `Frameworks: ${profile.frameworks.length > 0 ? profile.frameworks.join(", ") : "none"} | ` +
      `Tests: ${profile.test_runners.length > 0 ? profile.test_runners.join(", ") : "none"}`,
  );

  // 3. Check for frontend
  const hasFrontend = profile.frameworks.some((f) => FRONTEND_FRAMEWORKS.has(f));
  result.hasFrontend = hasFrontend;

  // 4. Generate flow config
  console.log(chalk.cyan("  Generating flow configuration..."));
  const flowConfig = generateFlowConfig(profile);
  const flowConfigPath = getFlowConfigPath(projectDir);
  await writeConfigFile(flowConfigPath, JSON.stringify(flowConfig, null, 2), options.force, result, projectDir);

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
        await fs.mkdir(recDir, { recursive: true, mode: 0o700 });
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
    await fs.mkdir(recDir, { recursive: true, mode: 0o700 });
    const fileName = path.basename(targetPath);
    const recPath = path.join(recDir, fileName);
    await fs.writeFile(recPath, content, { encoding: "utf-8", mode: 0o600 });
    result.files.recommended.push(relPath(recPath, projectDir));
  } else {
    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
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

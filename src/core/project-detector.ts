/**
 * Project Detector Module (V2)
 *
 * Auto-detects project characteristics during orchestrator initialization:
 * - Languages: Node.js/TypeScript, Python
 * - Frameworks: Next.js, Express, NestJS, React, Vue, FastAPI, Django, Flask
 * - Test runners: vitest, jest, mocha, pytest
 * - Linters: ESLint, Prettier, Biome, Ruff, Black, mypy
 * - CI systems: GitHub Actions, GitLab CI, CircleCI
 * - Package managers: npm, yarn, pnpm, bun, pip, poetry
 *
 * Results are cached to .conductor/project-profile.json for reuse on resume.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { ProjectProfile, ProjectArchetype } from "../utils/types.js";
import { getProjectProfilePath } from "../utils/constants.js";

// ============================================================
// Main Detection Function
// ============================================================

/**
 * Detects project characteristics from the project directory.
 * Only reads known config files - does not execute any scripts.
 *
 * @param projectDir The root directory of the project
 * @returns ProjectProfile with detected characteristics
 */
export async function detectProject(projectDir: string): Promise<ProjectProfile> {
  const profile: ProjectProfile = {
    detected_at: new Date().toISOString(),
    languages: [],
    frameworks: [],
    test_runners: [],
    linters: [],
    ci_systems: [],
    package_managers: [],
  };

  // Detect languages first (needed for framework detection)
  profile.languages = await detectLanguages(projectDir);

  // Detect frameworks based on languages
  profile.frameworks = await detectFrameworks(projectDir, profile.languages);

  // Detect test runners
  profile.test_runners = await detectTestRunners(projectDir);

  // Detect linters
  profile.linters = await detectLinters(projectDir);

  // Detect CI systems
  profile.ci_systems = await detectCISystems(projectDir);

  // Detect package managers
  profile.package_managers = await detectPackageManagers(projectDir);

  // v0.7.1: high-level archetype (cli / web / library / service / other).
  // Refined later by the LLM-based flow-config-analyzer — this is a seed.
  profile.archetype = await detectArchetype(projectDir, profile);

  return profile;
}

// ============================================================
// Archetype Detection (v0.7.1)
// ============================================================

/**
 * Classify the project into a high-level archetype for flow-config seeding
 * and downstream prompt tailoring. The rules are heuristic and intentionally
 * conservative — anything ambiguous falls through to "other" and the
 * flow-config-analyzer LLM pass gets the final call.
 *
 * Priority order (first match wins):
 *   1. Frontend framework → "web"
 *   2. `bin` in package.json OR CLI-style dep (commander/yargs/oclif/click/argparse) OR src/cli* → "cli"
 *   3. Backend/API framework → "service"
 *   4. package.json `main`/`module`/`exports` with no bin/server → "library"
 *   5. Python pyproject with no framework → "library"
 *   6. Otherwise → "other"
 */
async function detectArchetype(
  projectDir: string,
  profile: ProjectProfile,
): Promise<ProjectArchetype> {
  const FRONTEND_FRAMEWORKS = new Set([
    "nextjs", "react", "vue", "svelte", "angular",
  ]);
  const SERVICE_FRAMEWORKS = new Set([
    "express", "fastify", "hono", "koa", "nestjs",
    "fastapi", "django", "flask", "starlette", "aiohttp",
  ]);

  // 1. Web app — any frontend framework wins
  if (profile.frameworks.some((f) => FRONTEND_FRAMEWORKS.has(f))) {
    return "web";
  }

  const pkg = await readJsonSafe<PackageJsonWithBin>(
    path.join(projectDir, "package.json"),
  );

  // 2. CLI detection
  if (pkg) {
    if (pkg.bin !== undefined) {
      const hasBinEntry =
        typeof pkg.bin === "string" ||
        (typeof pkg.bin === "object" && Object.keys(pkg.bin).length > 0);
      if (hasBinEntry) return "cli";
    }

    // Only consider runtime dependencies. devDependencies often contain CLI
    // libraries used by build scripts (commander/yargs in tooling, etc.) that
    // don't make the project itself a CLI. A monorepo root with a React app
    // shouldn't be tagged "cli" just because a build tool ships commander.
    const runtimeDeps = pkg.dependencies ?? {};
    const CLI_DEPS = [
      "commander", "yargs", "meow", "oclif", "@oclif/core",
      "cac", "sade", "minimist", "arg",
    ];
    if (CLI_DEPS.some((d) => runtimeDeps[d])) return "cli";
  }

  // src/cli{.ts,.js,.mjs} entry point (case-insensitive)
  const cliEntryCandidates = [
    "cli.ts", "cli.js", "cli.mjs", "cli.cts",
    "src/cli.ts", "src/cli.js", "src/cli.mjs", "src/cli.cts",
  ];
  for (const candidate of cliEntryCandidates) {
    if (await fileExists(path.join(projectDir, candidate))) return "cli";
  }

  // Python CLI heuristics
  if (profile.languages.includes("python")) {
    const pyprojectPath = path.join(projectDir, "pyproject.toml");
    if (await fileExists(pyprojectPath)) {
      const content = await readFileSafe(pyprojectPath);
      if (content) {
        // [project.scripts] or [tool.poetry.scripts] → CLI entrypoint
        if (/\[project\.scripts\]|\[tool\.poetry\.scripts\]/.test(content)) {
          return "cli";
        }
        // click/typer/argparse as direct deps strongly suggests CLI
        if (/(?:^|\n)\s*(?:click|typer|rich-click)\s*[=<>~]/.test(content)) {
          return "cli";
        }
      }
    }
  }

  // 3. Service (API/backend) — framework detection
  if (profile.frameworks.some((f) => SERVICE_FRAMEWORKS.has(f))) {
    return "service";
  }

  // 4. Library heuristic: package.json has entrypoints but no bin/server
  if (pkg) {
    const hasEntryPoints = Boolean(
      pkg.main || pkg.module || pkg.exports || pkg.types,
    );
    if (hasEntryPoints) return "library";
  }

  // 5. Python library: pyproject.toml with no CLI/service signals (already checked above)
  if (profile.languages.includes("python")) {
    if (await fileExists(path.join(projectDir, "pyproject.toml"))) {
      return "library";
    }
  }

  return "other";
}

// ============================================================
// Language Detection
// ============================================================

/**
 * Detects programming languages used in the project.
 */
async function detectLanguages(
  projectDir: string
): Promise<("typescript" | "javascript" | "python")[]> {
  const languages: ("typescript" | "javascript" | "python")[] = [];

  // Check for TypeScript
  if (await fileExists(path.join(projectDir, "tsconfig.json"))) {
    languages.push("typescript");
  } else if (await fileExists(path.join(projectDir, "package.json"))) {
    // Check package.json for typescript dependency
    const pkg = await readJsonSafe<PackageJson>(path.join(projectDir, "package.json"));
    if (pkg) {
      const deps: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (deps.typescript) {
        languages.push("typescript");
      } else {
        languages.push("javascript");
      }
    }
  }

  // Check for Python
  if (
    (await fileExists(path.join(projectDir, "pyproject.toml"))) ||
    (await fileExists(path.join(projectDir, "requirements.txt"))) ||
    (await fileExists(path.join(projectDir, "setup.py"))) ||
    (await fileExists(path.join(projectDir, "Pipfile")))
  ) {
    languages.push("python");
  }

  return languages;
}

// ============================================================
// Framework Detection
// ============================================================

/**
 * Detects frameworks based on project dependencies.
 */
async function detectFrameworks(
  projectDir: string,
  languages: string[]
): Promise<string[]> {
  const frameworks: string[] = [];

  // Node.js/TypeScript frameworks
  if (languages.includes("typescript") || languages.includes("javascript")) {
    const nodeFrameworks = await detectNodeFrameworks(projectDir);
    frameworks.push(...nodeFrameworks);
  }

  // Python frameworks
  if (languages.includes("python")) {
    const pythonFrameworks = await detectPythonFrameworks(projectDir);
    frameworks.push(...pythonFrameworks);
  }

  return frameworks;
}

/**
 * Detects Node.js/TypeScript frameworks from package.json.
 */
async function detectNodeFrameworks(projectDir: string): Promise<string[]> {
  const frameworks: string[] = [];
  const pkg = await readJsonSafe<PackageJson>(path.join(projectDir, "package.json"));

  if (!pkg) return frameworks;

  const deps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  // Framework detection mapping
  const frameworkMappings: [string, string][] = [
    ["next", "nextjs"],
    ["express", "express"],
    ["@nestjs/core", "nestjs"],
    ["react", "react"],
    ["vue", "vue"],
    ["@angular/core", "angular"],
    ["svelte", "svelte"],
    ["fastify", "fastify"],
    ["koa", "koa"],
    ["hono", "hono"],
  ];

  for (const [depName, frameworkName] of frameworkMappings) {
    if (deps[depName]) {
      frameworks.push(frameworkName);
    }
  }

  return frameworks;
}

/**
 * Detects Python frameworks from pyproject.toml or requirements.txt.
 */
async function detectPythonFrameworks(projectDir: string): Promise<string[]> {
  const frameworks: string[] = [];

  // Try pyproject.toml first
  const pyprojectPath = path.join(projectDir, "pyproject.toml");
  if (await fileExists(pyprojectPath)) {
    const content = await readFileSafe(pyprojectPath);
    if (content) {
      if (content.includes("fastapi")) frameworks.push("fastapi");
      if (content.includes("django")) frameworks.push("django");
      if (content.includes("flask")) frameworks.push("flask");
      if (content.includes("starlette")) frameworks.push("starlette");
      if (content.includes("aiohttp")) frameworks.push("aiohttp");
    }
  }

  // Try requirements.txt
  const requirementsPath = path.join(projectDir, "requirements.txt");
  if (await fileExists(requirementsPath)) {
    const content = await readFileSafe(requirementsPath);
    if (content) {
      const lines = content.toLowerCase().split("\n");
      for (const line of lines) {
        const pkg = line.split(/[=<>!~\[]/, 1)[0].trim();
        if (pkg === "fastapi") frameworks.push("fastapi");
        if (pkg === "django") frameworks.push("django");
        if (pkg === "flask") frameworks.push("flask");
        if (pkg === "starlette") frameworks.push("starlette");
        if (pkg === "aiohttp") frameworks.push("aiohttp");
      }
    }
  }

  // Dedupe
  return [...new Set(frameworks)];
}

// ============================================================
// Test Runner Detection
// ============================================================

/**
 * Detects test runners used in the project.
 */
async function detectTestRunners(projectDir: string): Promise<string[]> {
  const runners: string[] = [];

  // Node.js test runners
  const pkg = await readJsonSafe<PackageJson>(path.join(projectDir, "package.json"));
  if (pkg) {
    const deps: Record<string, string> = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    if (deps.vitest) runners.push("vitest");
    if (deps.jest) runners.push("jest");
    if (deps.mocha) runners.push("mocha");
    if (deps.ava) runners.push("ava");
    if (deps.tap) runners.push("tap");
  }

  // Python test runners
  const pyprojectPath = path.join(projectDir, "pyproject.toml");
  if (await fileExists(pyprojectPath)) {
    const content = await readFileSafe(pyprojectPath);
    if (content && content.includes("pytest")) {
      runners.push("pytest");
    }
  }

  // Check for pytest.ini
  if (await fileExists(path.join(projectDir, "pytest.ini"))) {
    if (!runners.includes("pytest")) {
      runners.push("pytest");
    }
  }

  // Check requirements.txt for pytest
  const requirementsPath = path.join(projectDir, "requirements.txt");
  if (await fileExists(requirementsPath)) {
    const content = await readFileSafe(requirementsPath);
    if (content && content.toLowerCase().includes("pytest")) {
      if (!runners.includes("pytest")) {
        runners.push("pytest");
      }
    }
  }

  return runners;
}

// ============================================================
// Linter Detection
// ============================================================

/**
 * Detects linters configured in the project.
 */
async function detectLinters(projectDir: string): Promise<string[]> {
  const linters: string[] = [];

  // Node.js linters from package.json
  const pkg = await readJsonSafe<PackageJson>(path.join(projectDir, "package.json"));
  if (pkg) {
    const deps: Record<string, string> = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    if (deps.eslint) linters.push("eslint");
    if (deps.prettier) linters.push("prettier");
    if (deps["@biomejs/biome"] || deps.biome) linters.push("biome");
  }

  // ESLint config files
  const eslintConfigs = [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
  ];
  for (const config of eslintConfigs) {
    if (await fileExists(path.join(projectDir, config))) {
      if (!linters.includes("eslint")) linters.push("eslint");
      break;
    }
  }

  // Prettier config files
  const prettierConfigs = [
    ".prettierrc",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.json",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    "prettier.config.js",
    "prettier.config.cjs",
  ];
  for (const config of prettierConfigs) {
    if (await fileExists(path.join(projectDir, config))) {
      if (!linters.includes("prettier")) linters.push("prettier");
      break;
    }
  }

  // Biome config
  if (await fileExists(path.join(projectDir, "biome.json"))) {
    if (!linters.includes("biome")) linters.push("biome");
  }

  // Python linters
  // Ruff
  if (
    (await fileExists(path.join(projectDir, "ruff.toml"))) ||
    (await fileExists(path.join(projectDir, ".ruff.toml")))
  ) {
    linters.push("ruff");
  }

  // Check pyproject.toml for tool configs
  const pyprojectPath = path.join(projectDir, "pyproject.toml");
  if (await fileExists(pyprojectPath)) {
    const content = await readFileSafe(pyprojectPath);
    if (content) {
      if (content.includes("[tool.ruff]") && !linters.includes("ruff")) {
        linters.push("ruff");
      }
      if (content.includes("[tool.black]")) {
        linters.push("black");
      }
      if (content.includes("[tool.mypy]")) {
        linters.push("mypy");
      }
      if (content.includes("[tool.isort]")) {
        linters.push("isort");
      }
    }
  }

  // mypy.ini
  if (await fileExists(path.join(projectDir, "mypy.ini"))) {
    if (!linters.includes("mypy")) linters.push("mypy");
  }

  return linters;
}

// ============================================================
// CI System Detection
// ============================================================

/**
 * Detects CI systems configured in the project.
 */
async function detectCISystems(projectDir: string): Promise<string[]> {
  const ciSystems: string[] = [];

  // GitHub Actions
  const githubWorkflowsDir = path.join(projectDir, ".github", "workflows");
  if (await directoryExists(githubWorkflowsDir)) {
    try {
      const files = await fs.readdir(githubWorkflowsDir);
      if (files.some((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
        ciSystems.push("github-actions");
      }
    } catch {
      // Directory might not be readable
    }
  }

  // GitLab CI
  if (await fileExists(path.join(projectDir, ".gitlab-ci.yml"))) {
    ciSystems.push("gitlab-ci");
  }

  // CircleCI
  if (await fileExists(path.join(projectDir, ".circleci", "config.yml"))) {
    ciSystems.push("circleci");
  }

  // Travis CI
  if (await fileExists(path.join(projectDir, ".travis.yml"))) {
    ciSystems.push("travis-ci");
  }

  // Jenkins
  if (await fileExists(path.join(projectDir, "Jenkinsfile"))) {
    ciSystems.push("jenkins");
  }

  // Azure Pipelines
  if (await fileExists(path.join(projectDir, "azure-pipelines.yml"))) {
    ciSystems.push("azure-pipelines");
  }

  return ciSystems;
}

// ============================================================
// Package Manager Detection
// ============================================================

/**
 * Detects package managers used in the project.
 */
async function detectPackageManagers(projectDir: string): Promise<string[]> {
  const managers: string[] = [];

  // Node.js package managers (check lock files)
  if (await fileExists(path.join(projectDir, "package-lock.json"))) {
    managers.push("npm");
  }
  if (await fileExists(path.join(projectDir, "yarn.lock"))) {
    managers.push("yarn");
  }
  if (await fileExists(path.join(projectDir, "pnpm-lock.yaml"))) {
    managers.push("pnpm");
  }
  if (await fileExists(path.join(projectDir, "bun.lockb"))) {
    managers.push("bun");
  }

  // Python package managers
  if (await fileExists(path.join(projectDir, "requirements.txt"))) {
    managers.push("pip");
  }
  if (await fileExists(path.join(projectDir, "Pipfile"))) {
    managers.push("pipenv");
  }
  if (await fileExists(path.join(projectDir, "poetry.lock"))) {
    managers.push("poetry");
  }
  if (await fileExists(path.join(projectDir, "pdm.lock"))) {
    managers.push("pdm");
  }
  if (await fileExists(path.join(projectDir, "uv.lock"))) {
    managers.push("uv");
  }

  return managers;
}

// ============================================================
// Caching
// ============================================================

/**
 * Loads a cached project profile if it exists.
 *
 * @param projectDir The project directory
 * @returns The cached profile or null if not found
 */
export async function loadCachedProfile(
  projectDir: string
): Promise<ProjectProfile | null> {
  const profilePath = getProjectProfilePath(projectDir);
  return await readJsonSafe<ProjectProfile>(profilePath);
}

/**
 * Caches the project profile to disk.
 *
 * @param projectDir The project directory
 * @param profile The profile to cache
 */
export async function cacheProfile(
  projectDir: string,
  profile: ProjectProfile
): Promise<void> {
  const profilePath = getProjectProfilePath(projectDir);

  // Ensure .conductor directory exists with secure permissions
  const conductorDir = path.dirname(profilePath);
  await fs.mkdir(conductorDir, { recursive: true, mode: 0o700 });

  // Use secure permissions: mode 0o600 for file (owner rw only)
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/**
 * Detects project and caches the result. Uses cache if available.
 *
 * @param projectDir The project directory
 * @param forceRefresh Force a fresh detection even if cache exists
 * @returns The project profile
 */
export async function detectProjectWithCache(
  projectDir: string,
  forceRefresh = false
): Promise<ProjectProfile> {
  if (!forceRefresh) {
    const cached = await loadCachedProfile(projectDir);
    if (cached) {
      return cached;
    }
  }

  const profile = await detectProject(projectDir);
  await cacheProfile(projectDir, profile);
  return profile;
}

// ============================================================
// Guidance Generation
// ============================================================

/**
 * Formats the project profile as markdown guidance for worker prompts.
 *
 * @param profile The project profile
 * @returns Markdown string with project guidance
 */
export function formatProjectGuidance(profile: ProjectProfile): string {
  const lines: string[] = [];

  lines.push("## Project Profile");
  lines.push("");

  // Languages
  if (profile.languages.length > 0) {
    lines.push(`- **Languages:** ${profile.languages.join(", ")}`);
  }

  // Frameworks
  if (profile.frameworks.length > 0) {
    lines.push(`- **Frameworks:** ${profile.frameworks.join(", ")}`);
  }

  // Test runners with commands
  if (profile.test_runners.length > 0) {
    const runnerInfo = profile.test_runners.map((r) => {
      const cmd = getTestCommand(r, profile.package_managers);
      return cmd ? `${r} (\`${cmd}\`)` : r;
    });
    lines.push(`- **Test Runners:** ${runnerInfo.join(", ")}`);
  }

  // Linters
  if (profile.linters.length > 0) {
    lines.push(`- **Linters:** ${profile.linters.join(", ")}`);
  }

  // CI systems
  if (profile.ci_systems.length > 0) {
    lines.push(`- **CI Systems:** ${profile.ci_systems.join(", ")}`);
  }

  // Package managers
  if (profile.package_managers.length > 0) {
    lines.push(`- **Package Managers:** ${profile.package_managers.join(", ")}`);
  }

  // Add helpful commands section if we have enough info
  lines.push("");
  lines.push("### Useful Commands");

  // Add package manager commands
  const primaryPM = getPrimaryPackageManager(profile.package_managers);
  if (primaryPM) {
    lines.push(`- **Install dependencies:** \`${getInstallCommand(primaryPM)}\``);
  }

  // Add test command
  if (profile.test_runners.length > 0) {
    const testCmd = getTestCommand(profile.test_runners[0], profile.package_managers);
    if (testCmd) {
      lines.push(`- **Run tests:** \`${testCmd}\``);
    }
  }

  // Add lint command
  if (profile.linters.length > 0) {
    const lintCmd = getLintCommand(profile.linters, profile.package_managers);
    if (lintCmd) {
      lines.push(`- **Run linter:** \`${lintCmd}\``);
    }
  }

  // Add type check command for TypeScript
  if (profile.languages.includes("typescript")) {
    lines.push("- **Type check:** `npx tsc --noEmit`");
  }

  return lines.join("\n");
}

/**
 * Gets the test command for a given test runner.
 */
function getTestCommand(
  runner: string,
  packageManagers: string[]
): string | null {
  const isNode = packageManagers.some((pm) =>
    ["npm", "yarn", "pnpm", "bun"].includes(pm)
  );

  switch (runner) {
    case "vitest":
      return isNode ? "npx vitest run" : null;
    case "jest":
      return isNode ? "npx jest" : null;
    case "mocha":
      return isNode ? "npx mocha" : null;
    case "ava":
      return isNode ? "npx ava" : null;
    case "pytest":
      return "pytest";
    default:
      return null;
  }
}

/**
 * Gets the primary package manager (prefer the most specific lock file).
 */
function getPrimaryPackageManager(managers: string[]): string | null {
  // Prefer in order: pnpm > yarn > bun > npm for Node
  // poetry > pipenv > pip for Python
  const preference = [
    "pnpm",
    "yarn",
    "bun",
    "npm",
    "poetry",
    "pipenv",
    "pdm",
    "uv",
    "pip",
  ];
  for (const pm of preference) {
    if (managers.includes(pm)) {
      return pm;
    }
  }
  return managers[0] ?? null;
}

/**
 * Gets the install command for a package manager.
 */
function getInstallCommand(pm: string): string {
  switch (pm) {
    case "npm":
      return "npm install";
    case "yarn":
      return "yarn install";
    case "pnpm":
      return "pnpm install";
    case "bun":
      return "bun install";
    case "pip":
      return "pip install -r requirements.txt";
    case "pipenv":
      return "pipenv install";
    case "poetry":
      return "poetry install";
    case "pdm":
      return "pdm install";
    case "uv":
      return "uv sync";
    default:
      return `${pm} install`;
  }
}

/**
 * Gets the lint command based on detected linters.
 */
function getLintCommand(
  linters: string[],
  packageManagers: string[]
): string | null {
  const isNode = packageManagers.some((pm) =>
    ["npm", "yarn", "pnpm", "bun"].includes(pm)
  );

  // Prefer biome > eslint for Node
  if (linters.includes("biome") && isNode) {
    return "npx biome check .";
  }
  if (linters.includes("eslint") && isNode) {
    return "npx eslint .";
  }
  if (linters.includes("ruff")) {
    return "ruff check .";
  }
  if (linters.includes("black")) {
    return "black --check .";
  }
  if (linters.includes("mypy")) {
    return "mypy .";
  }

  return null;
}

// ============================================================
// Types
// ============================================================

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Extended package.json shape used by archetype detection. */
interface PackageJsonWithBin extends PackageJson {
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  exports?: unknown;
  types?: string;
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Checks if a file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Checks if a directory exists.
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Safely reads and parses a JSON file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Safely reads a file as text.
 * Returns null if the file doesn't exist or can't be read.
 */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

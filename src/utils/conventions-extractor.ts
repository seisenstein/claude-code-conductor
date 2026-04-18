import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectConventions, RoleModelSpec } from "./types.js";
import { getConventionsPath, CONVENTIONS_EXTRACTION_MAX_TURNS, DEFAULT_ROLE_CONFIG } from "./constants.js";
import { specToSdkArgs } from "./models-config.js";
import { queryWithTimeout } from "./sdk-timeout.js";
import type { Logger } from "./logger.js";

const DEFAULT_CONVENTIONS: ProjectConventions = {
  auth_patterns: [],
  validation_patterns: [],
  error_handling_patterns: [],
  test_patterns: [],
  directory_structure: [],
  naming_conventions: [],
  key_libraries: [],
  security_invariants: [],
};

const EXTRACTION_PROMPT = `You are a codebase conventions extractor. Your job is to analyze this project and extract its conventions into a structured JSON object.

Follow these steps carefully:

1. **Read project config files**: Read CLAUDE.md, README.md, package.json, and tsconfig.json if they exist in the current directory.

2. **Search for auth patterns**: Use Grep to search for patterns like "auth", "middleware", "session", "jwt", "token", "passport", "guard". Note what auth frameworks/patterns are used and how they are applied.

3. **Search for validation patterns**: Use Grep to search for "zod", "joi", "validate", "schema", "yup", "class-validator", "ajv". Note validation libraries and how input validation is structured.

4. **Search for error handling patterns**: Use Grep to search for "catch", "Error", "error.handler", "ErrorBoundary", "try {", "throw new". Note how errors are structured, logged, and propagated.

5. **Search for test patterns**: Use Glob to find test files (e.g., **/*.test.ts, **/*.spec.ts, **/__tests__/**). Use Grep to check for test framework imports ("vitest", "jest", "mocha", "chai"). Note test file naming conventions and frameworks.

6. **Check directory structure**: Use Bash with "ls -la" at the project root, and "ls" on src/ or similar top-level directories. Note the directory organization pattern (e.g., feature-based, layer-based).

7. **Check naming conventions**: Look at a few source files to determine naming patterns for files (kebab-case, camelCase, PascalCase), exports, types, and interfaces.

8. **Identify key libraries**: Read package.json dependencies to identify important libraries and their purposes.

9. **Identify security invariants**: Based on what you find, note any security patterns that must be maintained (e.g., "all API routes require auth middleware", "all user input is validated with zod").

After completing your analysis, output EXACTLY one JSON block in this format:

\`\`\`json
{
  "auth_patterns": ["description of each auth pattern found"],
  "validation_patterns": ["description of each validation pattern found"],
  "error_handling_patterns": ["description of each error handling pattern found"],
  "test_patterns": ["description of each test pattern found"],
  "directory_structure": ["description of directory organization"],
  "naming_conventions": ["description of naming conventions"],
  "key_libraries": [{"name": "library-name", "purpose": "what it's used for"}],
  "security_invariants": ["security rule that must be maintained"]
}
\`\`\`

If you find no examples for a category, use an empty array. Be specific and cite actual file paths or patterns you found. Do NOT guess -- only report what you actually find in the codebase.`;

/**
 * M-35: Attempt to parse JSON, returning null on failure instead of throwing.
 */
function tryParseJson(text: string, warn: (msg: string) => void): Record<string, unknown> | null {
  try {
    const result: unknown = JSON.parse(text);
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch (error) {
    warn(
      `JSON parse attempt failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * M-35: Attempt to fix common JSON issues from LLM output:
 * - Trailing commas before ] or }
 * - Comments (// style)
 * - Leading/trailing non-JSON content
 */
function tryFixJson(text: string): string {
  let fixed = text;
  // Strip single-line comments (// ...)
  fixed = fixed.replace(/\/\/[^\n]*/g, "");
  // Remove trailing commas before ] or }
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");
  // Try to extract just the outermost {} block if there's surrounding text
  const braceStart = fixed.indexOf("{");
  const braceEnd = fixed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    fixed = fixed.substring(braceStart, braceEnd + 1);
  }
  return fixed;
}

/**
 * Extract project conventions by spawning a read-only SDK agent.
 * Results are cached to .conductor/conventions.json.
 * If cached and less than 1 hour old, returns cached version.
 */
export async function extractConventions(
  projectDir: string,
  spec?: RoleModelSpec | string,
  logger?: Logger,
): Promise<ProjectConventions> {
  const conventionsPath = getConventionsPath(projectDir);
  const warn = (msg: string) => logger ? logger.warn(msg) : process.stderr.write(msg + "\n");

  // Resolve model + effort from spec (RoleModelSpec preferred, bare string for legacy callers)
  const sdkArgs = typeof spec === "string"
    ? { model: spec, effort: DEFAULT_ROLE_CONFIG.conventions_extractor.effort }
    : specToSdkArgs(spec ?? DEFAULT_ROLE_CONFIG.conventions_extractor);

  // Check cache (< 1 hour old)
  try {
    const stat = await fs.stat(conventionsPath);
    const age = Date.now() - stat.mtimeMs;
    if (age < 3_600_000) {
      const cached = JSON.parse(await fs.readFile(conventionsPath, "utf-8"));
      return cached as ProjectConventions;
    }
  } catch {
    // No cache or unreadable -- proceed with extraction
  }

  // Spawn read-only agent to extract conventions
  let resultText = "";

  try {
    resultText = await queryWithTimeout(
      EXTRACTION_PROMPT,
      {
        allowedTools: ["Read", "Glob", "Grep", "Bash", "LSP"],
        cwd: projectDir,
        maxTurns: CONVENTIONS_EXTRACTION_MAX_TURNS,
        model: sdkArgs.model,
        effort: sdkArgs.effort,
        settingSources: ["project"],
      },
      5 * 60 * 1000, // 5 min
      "conventions-extraction",
      logger,
    );
  } catch (error) {
    warn(`Conventions extraction agent failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ...DEFAULT_CONVENTIONS };
  }

  // Parse the JSON output from the agent's response
  const conventions = parseConventionsOutput(resultText, logger);

  // Ensure the directory exists and save cache with secure permissions
  try {
    // Use mode 0o700 for directory (owner rwx only)
    await fs.mkdir(path.dirname(conventionsPath), { recursive: true, mode: 0o700 });
    // Use mode 0o600 for file (owner rw only)
    await fs.writeFile(conventionsPath, JSON.stringify(conventions, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (error) {
    warn(`Failed to cache conventions: ${error instanceof Error ? error.message : String(error)}`);
  }

  return conventions;
}

/**
 * Parse the agent's output to extract the ProjectConventions JSON block.
 */
function parseConventionsOutput(text: string, logger?: Logger): ProjectConventions {
  const warn = (msg: string) => logger ? logger.warn(msg) : process.stderr.write(msg + "\n");

  if (!text || text.trim() === "") {
    warn("Conventions extraction returned empty response; using defaults.");
    return { ...DEFAULT_CONVENTIONS };
  }

  // Try to find a JSON code block
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  const jsonText = jsonBlockMatch ? jsonBlockMatch[1] : text;

  // M-35: Try multiple parsing strategies instead of all-or-nothing
  const parsed = tryParseJson(jsonText.trim(), warn) ?? tryParseJson(tryFixJson(jsonText.trim()), warn);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Log first 500 chars of raw output to help debug parse failures
    const preview = text.substring(0, 500);
    warn(
      `Failed to parse conventions JSON from agent output; using defaults.\n` +
      `Raw output preview (first 500 chars):\n${preview}`
    );
    return { ...DEFAULT_CONVENTIONS };
  }

  // Validate the structure and fill in missing fields
  const conventions: ProjectConventions = {
    auth_patterns: Array.isArray(parsed.auth_patterns) ? parsed.auth_patterns : [],
    validation_patterns: Array.isArray(parsed.validation_patterns) ? parsed.validation_patterns : [],
    error_handling_patterns: Array.isArray(parsed.error_handling_patterns) ? parsed.error_handling_patterns : [],
    test_patterns: Array.isArray(parsed.test_patterns) ? parsed.test_patterns : [],
    directory_structure: Array.isArray(parsed.directory_structure) ? parsed.directory_structure : [],
    naming_conventions: Array.isArray(parsed.naming_conventions) ? parsed.naming_conventions : [],
    key_libraries: Array.isArray(parsed.key_libraries) ? parsed.key_libraries : [],
    security_invariants: Array.isArray(parsed.security_invariants) ? parsed.security_invariants : [],
  };

  // Warn if critical security_invariants field is empty
  if (conventions.security_invariants.length === 0) {
    warn(
      "Conventions extraction found no security_invariants. " +
      "Consider reviewing the codebase manually for security patterns."
    );
  }

  return conventions;
}

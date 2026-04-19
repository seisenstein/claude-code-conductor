/**
 * Extracts project-specific rules from existing guidance files (CLAUDE.md,
 * .claude/rules/*, .cursorrules, etc.) and synthesizes them into a
 * conductor-compatible rules.md.
 *
 * This runs during `conduct init` to populate rules.md with actual project
 * rules rather than a generic template. Workers receive these rules in every
 * prompt, so they follow the same standards as the main Claude session.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  RULES_EXTRACTOR_MAX_TURNS,
  RULES_EXTRACTOR_TIMEOUT_MS,
  READ_ONLY_DISALLOWED_TOOLS,
  WORKER_ALLOWED_TOOLS,
} from "./constants.js";
import { resolveLooseModelArg } from "./models-config.js";
import { queryWithTimeout } from "./sdk-timeout.js";
import type { Logger } from "./logger.js";
import { TASK_TYPE_LITERALS, type RoleModelSpec } from "./types.js";

/** Well-known guidance file locations to search for. */
const GUIDANCE_FILE_PATTERNS = [
  "CLAUDE.md",
  ".claude/rules",         // directory of rule files
  ".cursorrules",
  ".cursorules",
  "AGENTS.md",
  "COPILOT.md",
  ".github/copilot-instructions.md",
];

const EXTRACTION_PROMPT = `You are a project rules extractor for a multi-agent code orchestration system called "Conductor". Your job is to read this project's existing guidance files AND verify against the actual source code, then synthesize the result into a single, actionable rules document that will be injected into every worker agent's prompt.

## Step 1: Find guidance files

Search for these files in the project root:
- \`CLAUDE.md\` — Primary Claude Code instructions
- \`.claude/rules/\` — Directory of rule files (read ALL files in this directory)
- \`.cursorrules\` or \`.cursorules\` — Cursor AI rules
- \`AGENTS.md\`, \`COPILOT.md\`, \`.github/copilot-instructions.md\` — Other AI guidance

Use Glob and Read to find and read all of them. Some may not exist — that's fine, skip them.

## Step 2: Extract actionable rules

From all guidance files you find, extract rules that would be relevant to a code-writing agent. Focus on:

1. **Architecture rules** — Required patterns, middleware, auth approaches, routing conventions
2. **Coding standards** — Required libraries (e.g., "use zod for validation"), naming conventions, type patterns
3. **Security rules** — Auth patterns, RLS policies, CSRF, input validation requirements
4. **Database rules** — Migration patterns, FK conventions, query patterns
5. **Styling/UI rules** — CSS methodology, color systems, component patterns
6. **Testing rules** — Test runner, test patterns, what to test
7. **Off-limits** — Things that must NOT be done (e.g., "never use any type", "do not modify shared components")
8. **Build/deploy rules** — Build commands, CI requirements, deployment constraints

## Step 3: VERIFY against the source — the rules MUST match the code

Guidance files drift. Code is ground truth. For every rule that references a
specific value, list, or constant, you MUST verify it against the actual
source before writing it down. **Where guidance and code disagree, the code wins.**

### 3a. Autonomous verification

As you extract rules, identify any concrete reference and verify it against
the source. Examples of references to verify:
- "Valid X are: A, B, C" (is the union/enum literal really {A, B, C}?)
- "Workers can use tools T1, T2" (is the allowlist exactly that?)
- "Default value is N" (is the constant really N?)
- "Maximum is M" (is the limit really M?)
- "We use library L" (is L actually in package.json dependencies?)

Use Read, Grep, and LSP to find the authoritative definition. Prefer LSP
goToDefinition when a symbol is named.

### 3b. Mandatory verification list (always check these)

Even if guidance doesn't mention them, ALWAYS verify these specific items
when present in this codebase, because they are foundational to worker
behavior and easy to drift on:

- **TaskType union** — open \`src/utils/types.ts\` and find \`export type TaskType\`. List EVERY member literally (no abbreviation). If any task type is not in your output, fix it.
- **Worker tool allowlists** — open \`src/utils/constants.ts\` and find \`WORKER_ALLOWED_TOOLS\`, \`PLANNER_ALLOWED_TOOLS\`, \`FLOW_TRACING_READ_ONLY_TOOLS\`. Reflect them accurately.
- **AgentRole union** (if present) — same treatment as TaskType.
- **Numeric thresholds** — \`DEFAULT_CONCURRENCY\`, \`DEFAULT_MAX_CYCLES\`, \`MAX_DISAGREEMENT_ROUNDS\`, \`DEFAULT_WORKER_TIMEOUT_MS\`. Cite exact values.
- **Effort levels** (if present) — \`type EffortLevel\` should list every level.
- **Branch / commit conventions** — \`BRANCH_PREFIX\`, \`COMMIT_PREFIX_TASK\`, etc.

If the codebase doesn't have these constants, skip them — don't fabricate.

### 3c. Drift reporting

If you find ANY discrepancy between guidance and code, surface it as an
inline annotation in the corresponding rule, e.g.:

\`- Valid task types: backend_api, frontend_ui, database, security, testing, infrastructure, reverse_engineering, integration, general (CLAUDE.md was missing reverse_engineering and integration — code is authoritative)\`

This makes drift visible to humans reading the rules later.

## Step 4: Output

Output a markdown document with clear, imperative rules organized by category. Each rule should be a single line starting with a dash. Rules must be specific and actionable — not vague guidance like "write clean code".

**Do NOT include:**
- Build commands (those are in project-profile, not rules)
- File paths to documentation (workers can't read them)
- References to "CLAUDE.md says..." — just state the rule directly
- Generic advice that applies to all projects

**DO include:**
- Project-specific patterns (e.g., "use secureHandler() for all API routes")
- Required libraries and how to use them (e.g., "validate all inputs with zod schemas")
- Naming conventions specific to this project
- Security invariants (e.g., "all RLS policies must use (select auth.uid())")
- Styling rules (e.g., "use OKLCH colors: bg-primary-10 not bg-primary/10")
- Verified concrete values (the actual TaskType members, the actual numeric thresholds)
- Inline drift annotations where guidance and code disagreed (so future maintainers know)

Output the rules document between these markers:

\`\`\`rules
# Conductor Worker Rules
# Extracted from project guidance files by conduct init.
# Cross-referenced against source code — code-derived values are authoritative.
# These rules are injected into every worker prompt.

## Architecture Rules
- ...

## Coding Standards
- ...

(etc.)
\`\`\`

If no guidance files exist, output an empty template with section headers only.`;

/**
 * Extract project-specific rules from existing guidance files.
 * Returns the rules markdown content, or a fallback template if extraction fails.
 */
export async function extractProjectRules(
  projectDir: string,
  spec?: RoleModelSpec | string,
  logger?: Logger,
): Promise<string> {
  const warn = (msg: string) => (logger ? logger.warn(msg) : process.stderr.write(msg + "\n"));

  // H-11: route tier shorthands through MODEL_TIER_TO_ID.
  const sdkArgs = resolveLooseModelArg(spec, "rules_extractor", warn);

  // Quick check: are there any guidance files to read?
  const hasGuidance = await hasGuidanceFiles(projectDir);
  if (!hasGuidance) {
    warn("No project guidance files found (CLAUDE.md, .claude/rules/, etc.); using template.");
    return FALLBACK_TEMPLATE;
  }

  let resultText = "";
  try {
    resultText = await queryWithTimeout(
      EXTRACTION_PROMPT,
      {
        allowedTools: ["Read", "Glob", "Grep", "Bash", "LSP"],
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // CR-1
        cwd: projectDir,
        maxTurns: RULES_EXTRACTOR_MAX_TURNS,
        model: sdkArgs.model,
        effort: sdkArgs.effort,
        settingSources: ["project"],
      },
      RULES_EXTRACTOR_TIMEOUT_MS,
      "rules-extraction",
      logger,
    );
  } catch (error) {
    warn(`Rules extraction agent failed: ${error instanceof Error ? error.message : String(error)}`);
    return FALLBACK_TEMPLATE;
  }

  const rules = parseRulesOutput(resultText, logger);
  if (rules === FALLBACK_TEMPLATE) return rules;
  // H-12: host-side verification of LLM-produced rules. If the document
  // mentions task types or allowed-tools but drifts from reality, discard
  // and fall back to template rather than injecting wrong facts into every
  // worker prompt.
  if (!verifyExtractedRules(rules, warn)) return FALLBACK_TEMPLATE;
  return rules;
}

/**
 * H-12: Host-side verification of LLM-extracted rules.
 *
 * Strict-when-triggered policy: if the document mentions the concept, every
 * concrete value must appear. Silent omission → discard. Tolerating some
 * missing literals defeats the whole point of host-side verification.
 *
 * Returns true if the rules document passes sanity checks, false if drift
 * was detected. Caller falls back to FALLBACK_TEMPLATE on false.
 */
export function verifyExtractedRules(rules: string, warn: (msg: string) => void): boolean {
  const mentionsTaskTypes = /task[_\s-]?type/i.test(rules);
  if (mentionsTaskTypes) {
    const missing = TASK_TYPE_LITERALS.filter((t) => !rules.includes(t));
    if (missing.length > 0) {
      warn(
        `Rules document mentions task types but omits: ${missing.join(", ")}. ` +
        `Discarding extracted rules and falling back to template.`,
      );
      return false;
    }
  }

  // Negative lookbehind for "dis" to avoid false-triggering on "disallowed
  // tools" (which is a legitimate concept the document may discuss without
  // needing to enumerate every WORKER_ALLOWED_TOOLS member).
  const mentionsAllowedTools = /(?<!dis)allowed[_\s-]?tools?|WORKER_ALLOWED_TOOLS/i.test(rules);
  if (mentionsAllowedTools) {
    // Exclude MCP tools — they're often referenced by purpose not name.
    const expected = WORKER_ALLOWED_TOOLS.filter((t) => !t.startsWith("mcp__"));
    const missing = expected.filter((t) => !rules.includes(t));
    if (missing.length > 0) {
      warn(
        `Rules document mentions allowed-tools but omits: ${missing.join(", ")}. ` +
        `Discarding extracted rules and falling back to template.`,
      );
      return false;
    }
  }

  return true;
}

/**
 * Check if any known guidance files exist in the project.
 */
async function hasGuidanceFiles(projectDir: string): Promise<boolean> {
  for (const pattern of GUIDANCE_FILE_PATTERNS) {
    try {
      const fullPath = path.join(projectDir, pattern);
      const stat = await fs.stat(fullPath);
      if (stat.isFile() || stat.isDirectory()) {
        return true;
      }
    } catch {
      // Not found, continue
    }
  }
  return false;
}

/**
 * Parse the agent's output to extract the rules markdown.
 */
function parseRulesOutput(text: string, logger?: Logger): string {
  const warn = (msg: string) => (logger ? logger.warn(msg) : process.stderr.write(msg + "\n"));

  if (!text || text.trim() === "") {
    warn("Rules extraction returned empty response; using template.");
    return FALLBACK_TEMPLATE;
  }

  // Try to find the ```rules block
  const rulesBlockMatch = text.match(/```rules\s*\n([\s\S]*?)\n\s*```/);
  if (rulesBlockMatch) {
    const rules = rulesBlockMatch[1].trim();
    if (rules.length > 50) {
      return rules + "\n";
    }
  }

  // Try ```markdown block
  const mdBlockMatch = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n\s*```/);
  if (mdBlockMatch) {
    const content = mdBlockMatch[1].trim();
    if (content.startsWith("#") && content.length > 50) {
      return content + "\n";
    }
  }

  // Last resort: if the output starts with # and looks like markdown rules, use it directly
  const trimmed = text.trim();
  if (trimmed.startsWith("# ") && trimmed.includes("\n- ") && trimmed.length > 100) {
    return trimmed + "\n";
  }

  warn("Could not parse rules from agent output; using template.");
  return FALLBACK_TEMPLATE;
}

const FALLBACK_TEMPLATE = `# Conductor Worker Rules
# These rules are injected into every worker prompt.
# Add project-specific guidance below.

## Architecture Rules
# e.g., "All API routes must go through the auth middleware"
# e.g., "Use server actions for mutations, not API routes"

## Coding Standards
# e.g., "Use zod for all input validation"
# e.g., "Use the cn() utility for conditional classNames"

## Off-Limits
# e.g., "Do not modify shared component base styles — add variants instead"
# e.g., "Do not add new dependencies without approval"

## Component Guidelines
# e.g., "All new UI components must support the project's variant system"
# e.g., "Shared primitives live in components/ui/ — do not create duplicates"
`;

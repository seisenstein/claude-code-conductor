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
} from "./constants.js";
import { queryWithTimeout } from "./sdk-timeout.js";
import type { Logger } from "./logger.js";

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

const EXTRACTION_PROMPT = `You are a project rules extractor for a multi-agent code orchestration system called "Conductor". Your job is to read this project's existing guidance files and synthesize them into a single, actionable rules document that will be injected into every worker agent's prompt.

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

## Step 3: Output

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

Output the rules document between these markers:

\`\`\`rules
# Conductor Worker Rules
# Extracted from project guidance files by conduct init.
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
  model?: string,
  logger?: Logger,
): Promise<string> {
  const warn = (msg: string) => (logger ? logger.warn(msg) : process.stderr.write(msg + "\n"));

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
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        cwd: projectDir,
        maxTurns: RULES_EXTRACTOR_MAX_TURNS,
        model,
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
  return rules;
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

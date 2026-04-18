import { countPromptTokens } from "./token-counter.js";
import {
  REPLAN_TOKEN_THRESHOLD,
  COMPACTION_AGENT_MAX_TURNS,
  COMPACTION_AGENT_TIMEOUT_MS,
  CHARS_PER_TOKEN_ESTIMATE,
  READ_ONLY_DISALLOWED_TOOLS,
  getTasksDir,
  getKnownIssuesPath,
} from "./constants.js";
import { queryWithTimeout } from "./sdk-timeout.js";
import type { Logger } from "./logger.js";

/**
 * Progressively compact a replan prompt if it exceeds the token threshold.
 *
 * Applies tiers of compaction sequentially, re-checking token count after each:
 *   Tier 1: Truncate flow findings and known issues to severity counts + file pointer
 *   Tier 2: Drop completed task subjects
 *   Tier 3: Drop unresolved known issues entirely
 *   Tier 4: Spawn a compaction agent to intelligently compress the prompt
 *
 * Returns the prompt unchanged if it's within the threshold.
 */
export async function compactReplanPrompt(
  prompt: string,
  projectDir: string,
  model: string,
  logger: Logger,
): Promise<string> {
  const tokens = await countPromptTokens(prompt, model);

  if (tokens <= REPLAN_TOKEN_THRESHOLD) {
    return prompt;
  }

  logger.info(
    `Replan prompt is ${tokens} tokens (threshold: ${REPLAN_TOKEN_THRESHOLD}). Starting progressive compaction...`,
  );

  let compacted = prompt;

  // Tier 1: Truncate findings sections to counts + file pointer
  compacted = applyTier1(compacted, projectDir);
  const tier1Tokens = await countPromptTokens(compacted, model);
  logger.info(`Tier 1 (truncate findings): ${tier1Tokens} tokens`);
  if (tier1Tokens <= REPLAN_TOKEN_THRESHOLD) return compacted;

  // Tier 2: Drop completed task subjects
  compacted = applyTier2(compacted, projectDir);
  const tier2Tokens = await countPromptTokens(compacted, model);
  logger.info(`Tier 2 (drop completed subjects): ${tier2Tokens} tokens`);
  if (tier2Tokens <= REPLAN_TOKEN_THRESHOLD) return compacted;

  // Tier 3: Drop unresolved known issues entirely
  compacted = applyTier3(compacted, projectDir);
  const tier3Tokens = await countPromptTokens(compacted, model);
  logger.info(`Tier 3 (drop known issues): ${tier3Tokens} tokens`);
  if (tier3Tokens <= REPLAN_TOKEN_THRESHOLD) return compacted;

  // Tier 4: Spawn a compaction agent
  logger.info(`Tier 4: spawning compaction agent...`);
  const tier4Result = await applyTier4(compacted, projectDir, model, logger);
  if (tier4Result) {
    const tier4Tokens = await countPromptTokens(tier4Result, model);
    logger.info(`Tier 4 (compaction agent): ${tier4Tokens} tokens`);
    if (tier4Tokens <= REPLAN_TOKEN_THRESHOLD) {
      return tier4Result;
    }
    // Tier 4 result still too large — fall through to hard truncation
    compacted = tier4Result;
  }

  // Tier 5: Deterministic hard truncation as a guaranteed last resort.
  // Estimate the max character length from the token threshold and truncate.
  // Reserve space for the suffix so the total stays within the budget.
  const truncationSuffix = "\n\n[TRUNCATED — prompt exceeded token limit. See .conductor/ for full context.]\n";
  const maxChars = REPLAN_TOKEN_THRESHOLD * CHARS_PER_TOKEN_ESTIMATE - truncationSuffix.length;
  if (compacted.length > maxChars) {
    logger.warn(
      `Prompt still over threshold after all tiers. Hard-truncating from ${compacted.length} to ~${maxChars} chars.`,
    );
    compacted = compacted.substring(0, maxChars) + truncationSuffix;
  }

  return compacted;
}

// ============================================================
// Section replacement helpers
// ============================================================

/**
 * Escape special regex characters in a string for use in a RegExp.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find a ## section in the prompt and replace its content.
 * Uses line-anchored matching to avoid false partial-string matches (H27 fix).
 * Returns the original prompt if the section isn't found.
 */
function replaceSection(prompt: string, sectionHeader: string, replacement: string): string {
  // Match header at the start of a line to avoid false matches
  const headerPattern = new RegExp(`^${escapeRegex(sectionHeader)}`, "m");
  const match = headerPattern.exec(prompt);
  if (!match) return prompt;
  const headerIndex = match.index;

  // Find where this section ends (next ## header or end of string)
  const afterHeader = headerIndex + sectionHeader.length;
  const nextSectionMatch = prompt.substring(afterHeader).search(/\n## /);
  const sectionEnd = nextSectionMatch === -1
    ? prompt.length
    : afterHeader + nextSectionMatch;

  return prompt.substring(0, headerIndex) + replacement + prompt.substring(sectionEnd);
}

/**
 * Count lines that start with "- [" in a section (finding/issue lines).
 * M-30: Uses line-anchored regex instead of indexOf to avoid false partial-string matches.
 */
function countFindingLines(prompt: string, sectionHeader: string): number {
  // Use line-anchored regex (same pattern as replaceSection) to find the section header
  const headerPattern = new RegExp(`^${escapeRegex(sectionHeader)}`, "m");
  const match = headerPattern.exec(prompt);
  if (!match) return 0;
  const headerIndex = match.index;

  const afterHeader = headerIndex + sectionHeader.length;
  const nextSectionMatch = prompt.substring(afterHeader).search(/\n## /);
  const sectionContent = nextSectionMatch === -1
    ? prompt.substring(afterHeader)
    : prompt.substring(afterHeader, afterHeader + nextSectionMatch);

  return sectionContent.split("\n").filter((l) => l.trimStart().startsWith("- [")).length;
}

// ============================================================
// Tier implementations
// ============================================================

/**
 * Tier 1: Replace flow findings and known issues with severity counts + file pointer.
 */
function applyTier1(prompt: string, projectDir: string): string {
  let result = prompt;

  // Compact flow-tracing findings
  const flowHeader = "## Flow-Tracing Findings";
  const flowCount = countFindingLines(result, flowHeader);
  if (flowCount > 0) {
    result = replaceSection(
      result,
      flowHeader,
      `${flowHeader}\n\n${flowCount} findings from flow tracing. Details available in the flow-tracing summary files under .conductor/flow-tracing/.\n`,
    );
  }

  // Compact known issues
  const issuesHeader = "## Unresolved Known Issues";
  const issueCount = countFindingLines(result, issuesHeader);
  if (issueCount > 0) {
    const knownIssuesPath = getKnownIssuesPath(projectDir);
    result = replaceSection(
      result,
      issuesHeader,
      `${issuesHeader}\n\n${issueCount} unresolved issues from previous cycles. See: ${knownIssuesPath}\n`,
    );
  }

  return result;
}

/**
 * Tier 2: Replace completed task subjects with a count + pointer.
 */
function applyTier2(prompt: string, projectDir: string): string {
  const completedHeader = "## Completed Tasks";
  const completedCount = countFindingLines(prompt, completedHeader);
  const tasksDir = getTasksDir(projectDir);

  if (completedCount > 0) {
    return replaceSection(
      prompt,
      completedHeader,
      `${completedHeader}\n\n${completedCount} tasks completed in previous cycles. See ${tasksDir}/ for details.\n`,
    );
  }

  return prompt;
}

/**
 * Tier 3: Drop unresolved known issues section entirely.
 */
function applyTier3(prompt: string, projectDir: string): string {
  const issuesHeader = "## Unresolved Known Issues";
  const knownIssuesPath = getKnownIssuesPath(projectDir);

  return replaceSection(
    prompt,
    issuesHeader,
    `${issuesHeader}\n\nSee: ${knownIssuesPath} for all unresolved issues.\n`,
  );
}

/**
 * Tier 4: Spawn a compaction agent to intelligently compress the prompt.
 */
async function applyTier4(prompt: string, projectDir: string, model: string, logger: Logger): Promise<string | null> {
  // H28: Truncate prompt to a reasonable size limit before sending to
  // the compaction agent to prevent excessive token usage / injection.
  const MAX_COMPACTION_INPUT_CHARS = 100_000;
  let sanitizedPrompt = prompt;
  if (sanitizedPrompt.length > MAX_COMPACTION_INPUT_CHARS) {
    logger.warn(
      `Truncating compaction agent input from ${sanitizedPrompt.length} to ${MAX_COMPACTION_INPUT_CHARS} chars`,
    );
    sanitizedPrompt = sanitizedPrompt.substring(0, MAX_COMPACTION_INPUT_CHARS) + "\n[truncated]";
  }
  // Strip potential role markers that could confuse the model
  sanitizedPrompt = sanitizedPrompt.replace(/\b(Human|Assistant|System):/gi, "[role-marker]:");

  const systemPrompt = [
    "You are a prompt compaction agent. Your job is to compress the following replan prompt",
    "to be significantly shorter while preserving all critical information.",
    "",
    "PRESERVE VERBATIM:",
    "- The Feature Description section",
    "- The Instructions section",
    "- Failed task details (these are critical for replanning)",
    "- Critical and high severity findings",
    "",
    "AGGRESSIVELY SUMMARIZE:",
    "- Completed work (just note what was done, not details)",
    "- Medium and low severity findings (counts only)",
    "- Verbose plan context",
    "",
    "REMOVE:",
    "- Redundancy and repetition",
    "- Verbose descriptions of completed work",
    "- Duplicated context that appears in multiple sections",
    "",
    "Output ONLY the compacted prompt text. Do not add any commentary or meta-text.",
    "",
    "Here is the prompt to compact:",
    "",
    sanitizedPrompt,
  ].join("\n");

  try {
    const result = await queryWithTimeout(
      systemPrompt,
      {
        allowedTools: ["Read", "Glob", "Grep"],
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // CR-1
        cwd: projectDir,
        maxTurns: COMPACTION_AGENT_MAX_TURNS,
        model,
        settingSources: ["project"],
      },
      COMPACTION_AGENT_TIMEOUT_MS,
      "prompt-compaction",
      logger,
    );

    if (result && result.length > 100) {
      return result;
    }

    logger.warn("Compaction agent returned insufficient output");
    return null;
  } catch (err) {
    logger.warn(
      `Compaction agent failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

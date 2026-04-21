/**
 * Shared prompt components for Codex plan + code reviews.
 *
 * Ported from `/Users/cameron/Documents/ClaudeCodexDiscussion` — a
 * stand-alone MCP-based codex-review skill whose slash commands
 * (`/codex-review-plan`, `/codex-review-code`) consistently converge by
 * pushing Codex toward:
 *   - adversarial stance (find what's wrong, not confirm correctness)
 *   - collaborative feedback framing (better discussion quality)
 *   - complete findings per round (anti-drip-feed)
 *   - rich severity taxonomy that downstream gating can trust
 *
 * The conductor's reviewer uses non-interactive `codex exec` one-shots
 * (not an MCP dialog), so these pure-function builders are composed into
 * each prompt in `codex-reviewer.ts`. Round-budget awareness gives Codex
 * a sense of where it stands in the discussion so it stops drip-feeding
 * findings across rounds.
 *
 * See `.claude/specs/v0.7.7-codex-review-convergence.md` for the full
 * design and Codex-plan-review round-by-round decisions.
 */

import { CATEGORY_TO_SEVERITY } from "./codex-review-gating.js";

export interface RoundBudget {
  /** 1-indexed discussion-round number. Initial review is round 1. */
  current: number;
  /** Preferred max discussion rounds. `FINAL PLANNED ROUND` banner fires at this value. */
  softCap: number;
  /** Absolute upper bound. May equal softCap (conductor enforces it in the while-loop). */
  hardCap: number;
}

/** Shared adversarial review stance preamble. */
export function buildAdversarialStance(target: "plan" | "code"): string {
  const what = target === "plan" ? "plan" : "code";
  const claim = target === "plan"
    ? "has gaps, incorrect assumptions, or will fail in ways the author hasn't anticipated"
    : "has something wrong, missing, or subtly broken";
  return [
    "## Your Review Stance",
    "",
    `ADVERSARIAL REVIEW MODE: Your default assumption is that this ${what} ${claim}. You are not here to confirm ${what} is good — you are here to find what's wrong with it. Only accept a part of the ${what} as sound once you have actively tried to poke holes in it and failed.`,
    "",
    `For every piece of the ${what}, ask:`,
    `- "What happens if this assumption is wrong?"`,
    `- "What dependency is being taken for granted?"`,
    `- "What's the failure mode the author probably hasn't considered?"`,
    `- "What input or state would make this fail?"`,
    `- "Is there a simpler way that was overlooked?"`,
    "",
    `Read the actual codebase to verify claims. Do not take the ${what} at face value — check it.`,
  ].join("\n");
}

/**
 * Feedback-framing preamble. Improves discussion quality by encouraging
 * findings to land as collaborative observations rather than urgent
 * demands.
 */
export function buildFeedbackFraming(): string {
  return [
    "## How to Frame Your Feedback",
    "",
    "Present findings as interesting observations and open questions, not urgent demands. Use language like \"I noticed...\", \"Worth investigating whether...\", \"This is an interesting case — what happens when...\". Frame each finding as a collaborative puzzle, not a failure on the author's part. Be direct and specific about what you found, but avoid language that implies urgency, disappointment, or that the author should have caught this. The goal is the most thorough and accurate review possible, which works best when the discussion feels like two engineers working through a problem together.",
    "",
    "If you genuinely find nothing wrong after thorough investigation, say so clearly and explain what you checked — forced criticism is worse than honest approval.",
  ].join("\n");
}

/**
 * Round-budget block. Injected into every prompt so Codex knows the
 * current round, doesn't drip-feed findings, and knows when to converge.
 *
 * Three modes:
 *   current < softCap   → normal budget block
 *   current === softCap → FINAL PLANNED ROUND banner
 *   current > softCap   → OVERTIME banner (defensive; orchestrator
 *                         stops invoking Codex once the while-loop
 *                         bound is hit, but this path is retained for
 *                         safety)
 */
export function buildRoundBudget(budget: RoundBudget): string {
  const { current, softCap, hardCap } = budget;
  const remainingAfterThis = Math.max(0, softCap - current);
  const lines: string[] = [
    "## Round Budget",
    "",
    `This review has a soft budget of ${softCap} rounds. You are writing round ${current} of ${softCap}. Rounds remaining after this one: ${remainingAfterThis}.`,
  ];

  if (current > softCap) {
    lines.push(
      "",
      `**OVERTIME:** You are past the soft budget (round ${current}, soft cap ${softCap}, hard cap ${hardCap}). Continue only if the remaining issues genuinely require more back-and-forth. Otherwise wrap up with a final summary this round and approve if appropriate.`,
    );
  } else if (current === softCap) {
    lines.push(
      "",
      `**FINAL PLANNED ROUND:** This is round ${current} of ${softCap}. There will be no more Codex rounds after this one. Deliver every remaining finding and your final verdict in this message.`,
    );
  }

  lines.push(
    "",
    "How to use the budget well:",
    "",
    '1. **Dump every finding in this message.** Do not hold findings back for "next round." If your investigation surfaced ten issues, include all ten here. Future rounds are for verifying fixes and genuine follow-ups — not for releasing material you already had. Drip-feeding burns rounds and risks the review ending before you raise important findings.',
    "",
    '2. **Consolidate and order by severity.** Lead with CRITICAL, then the major-class labels (CORRECTNESS / ARCHITECTURE / SECURITY / ROBUSTNESS / COMPLETENESS / ORDERING / RISK), then SUGGESTION, then a single short "Nits" section at the end — or omit nits entirely.',
    "",
    "3. **Signal over noise.** A finding earns a slot only if a reasonable senior engineer would change a decision based on it. Skip style, naming, and cosmetic preferences unless they impact correctness or understanding. If nothing serious survives investigation after you've genuinely looked, say so plainly — a short honest review is better than padding the list with manufactured concerns.",
    "",
    "4. **Thoroughness, not speed.** The budget is not a countdown clock. Investigate each finding properly before you write. The goal is that when you DO write, your message is COMPLETE.",
  );
  return lines.join("\n");
}

/**
 * Severity taxonomy. Tells Codex which category labels to use in each
 * issue's `description` prefix AND which `severity` bucket to write
 * into the JSON. The mapping table is driven by `CATEGORY_TO_SEVERITY`
 * from `codex-review-gating.ts` — the single source of truth shared
 * with the parser fallback and the gating predicates.
 */
export function buildSeverityTaxonomy(target: "plan" | "code"): string {
  const codeLabels = ["CRITICAL", "CORRECTNESS", "ARCHITECTURE", "SECURITY", "ROBUSTNESS", "SUGGESTION", "QUESTION", "PRAISE", "NIT"];
  const planLabels = ["CRITICAL", "CORRECTNESS", "COMPLETENESS", "ORDERING", "RISK", "ALTERNATIVE", "SUGGESTION", "QUESTION", "NIT"];
  const labels = target === "code" ? codeLabels : planLabels;

  const definitions: Record<string, string> = {
    CRITICAL: target === "code"
      ? "bugs, security issues, data loss risk, correctness failures. Must address."
      : "the plan is flawed or will fail as stated. Must address.",
    CORRECTNESS: target === "code"
      ? "logic errors, edge cases, race conditions, incorrect error handling."
      : "the plan's technical claims don't hold up against the actual codebase.",
    ARCHITECTURE: "design problems, coupling issues, broken abstractions.",
    SECURITY: "input validation, auth, secrets, unsafe patterns.",
    ROBUSTNESS: "error paths, resource cleanup, partial-failure handling.",
    COMPLETENESS: "missing steps, edge cases, or dependencies.",
    ORDERING: "steps in the wrong order or hidden inter-step dependencies.",
    RISK: "an underestimated failure mode or untested assumption.",
    ALTERNATIVE: "a simpler or better approach was overlooked.",
    SUGGESTION: "a concrete improvement with demonstrable benefit. Not a stylistic preference.",
    QUESTION: "genuinely needs clarification before you can conclude. Used sparingly.",
    PRAISE: "optional — a pattern genuinely worth keeping. **Put praise in `summary`, NEVER in the `issues` array.**",
    NIT: "cosmetic/stylistic. Group into one short trailing section or omit.",
  };

  const lines: string[] = [
    "## Categorize Each Finding",
    "",
    "In each `issues[].description` string, lead with ONE category tag from the list below (definitions matter — do not inflate):",
    "",
  ];
  for (const label of labels) {
    const sev = CATEGORY_TO_SEVERITY[label];
    lines.push(`- **[${label}]** — ${definitions[label]} (severity: ${sev ?? "n/a"})`);
  }
  lines.push(
    "",
    "And set the `severity` field on each issue to match the mapping above: `critical` | `major` | `minor`.",
    "",
    "**If every finding is `minor`, your verdict MUST be `APPROVE`.** Do not use `NEEDS_DISCUSSION` / `NEEDS_FIXES` / `MAJOR_CONCERNS` / `MAJOR_PROBLEMS` for a minor-only outcome — list the minors in `summary` (or a trailing section) and approve. The conductor treats a minor-only outcome as approved-with-minors either way, so a non-APPROVE verdict just burns rounds.",
    "",
    "**Never place `[PRAISE]` items inside the `issues` array.** Praise belongs in `summary`. Praise inside `issues` risks being counted toward escalation tracking even though the gating layer maps it to `minor`.",
    "",
    "If you've investigated and there's genuinely nothing to flag, set `verdict: \"APPROVE\"` with an empty `issues` array and a short `summary`.",
  );
  return lines.join("\n");
}

/** Full coordinator MCP paragraph — used by code reviews. */
export function buildCoordinatorMcpParagraph(): string {
  return [
    "You have access to the `coordinator` MCP server with tools: `get_tasks`, `get_contracts`, `get_decisions`, `read_updates`. Use these to see task statuses, contracts registered between workers, architectural decisions recorded during execution, and broadcast messages. This is how you understand the full coordination state around the changes under review.",
  ].join("\n");
}

/**
 * Trimmed coordinator MCP paragraph — used by replan plan reviews.
 * Advertises only contracts and decisions (tasks are mid-cycle stale).
 */
export function buildCoordinatorMcpParagraphReplan(): string {
  return [
    "This is a replan (cycle 2+). Prior cycles have written coordination state. You have access to the `coordinator` MCP server with tools: `get_contracts` (API schemas / type defs registered by earlier workers) and `get_decisions` (architectural decisions recorded across cycles). Use these to understand what was already committed to. Do NOT rely on `get_tasks` — the task list is mid-cycle stale during plan review.",
  ].join("\n");
}

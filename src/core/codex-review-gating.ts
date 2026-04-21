/**
 * Shared gating logic for Codex plan + code reviews.
 *
 * Single source of truth for:
 *   - CATEGORY_TO_SEVERITY: the mapping from free-text taxonomy labels
 *     (CRITICAL / CORRECTNESS / ARCHITECTURE / ...) to the JSON schema's
 *     coarse severity field (critical / major / minor).
 *   - inferSeverityFromCategory: parser fallback for a malformed
 *     `severity` field when the description carries a [CATEGORY] tag.
 *   - hasBlockingIssues / hasOnlyMinorIssues: predicates used by the
 *     discussion loops, escalation counting, and approval-state
 *     computation so all three layers share ONE definition of "blocking".
 *   - normalizeIssueKey: canonical form used for recurrence tracking
 *     across rounds.
 *
 * Imported by `codex-review-prompts.ts` (prompt taxonomy table),
 * `codex-reviewer.ts` (parser fallback + consistency guards), and
 * `orchestrator.ts` (loop gating + escalation + approval state).
 *
 * See `.claude/specs/v0.7.7-codex-review-convergence.md` for the full
 * rationale and Codex-plan-review round-by-round decisions.
 */

/**
 * Coarse severity bucket carried on each parsed issue. Must match the
 * `validSeverities` set used by `parseStructuredResponse` in
 * `codex-reviewer.ts`. `"unknown"` is surfaced when Codex emits a
 * malformed `severity` field AND the description has no recognizable
 * `[CATEGORY]` prefix we can infer from.
 */
export type IssueSeverity = "minor" | "major" | "critical" | "unknown";

/**
 * Category taxonomy → severity bucket.
 *
 * Prompt and parser both key off this single map. Add a category here,
 * then update `buildSeverityTaxonomy` copy in `codex-review-prompts.ts`.
 *
 * PRAISE is mapped defensively — the prompt instructs Codex to put
 * praise in `summary`, never `issues`. If Codex non-complies and emits
 * `[PRAISE]` with a malformed severity, the fallback maps to `minor`
 * (non-blocking) rather than `unknown` (blocking), keeping the gating
 * predicates sound.
 */
export const CATEGORY_TO_SEVERITY: Record<string, IssueSeverity> = {
  // Shared
  CRITICAL: "critical",
  CORRECTNESS: "major",
  SUGGESTION: "minor",
  QUESTION: "minor",
  NIT: "minor",
  PRAISE: "minor",
  // Code-specific
  ARCHITECTURE: "major",
  SECURITY: "major",
  ROBUSTNESS: "major",
  // Plan-specific
  COMPLETENESS: "major",
  ORDERING: "major",
  RISK: "major",
  ALTERNATIVE: "minor",
};

/**
 * Case-insensitive capture of a leading `[CATEGORY]` tag. Codex
 * sometimes uses lowercase or mixed-case tags (`[suggestion]`,
 * `[Correctness]`) despite the prompt convention of all-caps; the
 * gating must not fall apart on that minor prompt-non-compliance,
 * otherwise `[suggestion]` → `null` inference → `[unknown]` severity
 * → escalation tripped on what should be a minor finding.
 */
const CATEGORY_PREFIX_RE = /^\s*\[([A-Za-z]+)\]/;

/**
 * Scan an issue description for a leading `[CATEGORY]` tag and return
 * the mapped severity. Case-insensitive. Returns `null` if there is no
 * recognizable tag, in which case the caller should fall back to
 * `"unknown"`.
 */
export function inferSeverityFromCategory(description: string): IssueSeverity | null {
  const match = CATEGORY_PREFIX_RE.exec(description);
  if (!match) return null;
  const sev = CATEGORY_TO_SEVERITY[match[1].toUpperCase()];
  return sev ?? null;
}

const SEVERITY_PREFIX_RE = /^\s*\[(minor|major|critical|unknown)\]\s*/;

/**
 * `true` if ANY issue is `[critical]`, `[major]`, or `[unknown]`.
 *
 * `[unknown]` is treated as blocking on purpose — a malformed severity
 * could be hiding a real critical/major issue. Better to keep the loop
 * going than to false-approve.
 */
export function hasBlockingIssues(issues: readonly string[]): boolean {
  for (const issue of issues) {
    const m = SEVERITY_PREFIX_RE.exec(issue);
    if (!m) continue;
    const sev = m[1];
    if (sev === "critical" || sev === "major" || sev === "unknown") {
      return true;
    }
  }
  return false;
}

/**
 * `true` iff there is at least one issue AND every issue is `[minor]`.
 *
 * Empty `issues` returns `false` — a non-APPROVE verdict with zero
 * parsed issues is ambiguous (could be a model hiccup) and must not
 * short-circuit into approval.
 */
export function hasOnlyMinorIssues(issues: readonly string[]): boolean {
  if (issues.length === 0) return false;
  for (const issue of issues) {
    const m = SEVERITY_PREFIX_RE.exec(issue);
    if (!m) return false;
    if (m[1] !== "minor") return false;
  }
  return true;
}

/**
 * Canonical form of an issue string used as a recurrence-tracking key.
 *
 * Strips:
 *   1. Leading severity prefix (`[minor|major|critical|unknown] `)
 *   2. Leading category prefix (`[CRITICAL|NIT|...] `) — handles Codex
 *      re-wording the category between rounds while the finding is
 *      unchanged
 * Then collapses internal whitespace and truncates to 80 chars.
 */
export function normalizeIssueKey(issue: string): string {
  let s = issue.replace(SEVERITY_PREFIX_RE, "");
  s = s.replace(CATEGORY_PREFIX_RE, "");
  s = s.trim().replace(/\s+/g, " ");
  return s.slice(0, 80);
}

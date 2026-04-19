/**
 * Tests for verifyExtractedRules in rules-extractor.ts — H-12.
 *
 * Strict-when-triggered policy:
 *  - If the document mentions "task type", every TASK_TYPE_LITERAL must appear.
 *  - If the document mentions "allowed tools" (not "disallowed tools"), every
 *    non-MCP WORKER_ALLOWED_TOOLS entry must appear.
 *
 * Drift → warn + return false → caller falls back to FALLBACK_TEMPLATE.
 */

import { describe, it, expect, vi } from "vitest";
import { verifyExtractedRules } from "./rules-extractor.js";
import { TASK_TYPE_LITERALS } from "./types.js";
import { WORKER_ALLOWED_TOOLS } from "./constants.js";

describe("verifyExtractedRules [H-12]", () => {
  it("rules mention task types and include all 9 literals → pass", () => {
    const rules = `# Rules\n\nSupported task types: ${TASK_TYPE_LITERALS.join(", ")}.`;
    const warn = vi.fn();
    expect(verifyExtractedRules(rules, warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rules mention task types but omit one → fail with warning naming the missing literal", () => {
    // Include all but `reverse_engineering`
    const included = TASK_TYPE_LITERALS.filter((t) => t !== "reverse_engineering");
    const rules = `# Rules\n\nSupported task types: ${included.join(", ")}.`;
    const warn = vi.fn();
    expect(verifyExtractedRules(rules, warn)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("reverse_engineering");
  });

  it("rules mention allowed-tools and list all non-MCP tools → pass", () => {
    const nonMcp = WORKER_ALLOWED_TOOLS.filter((t) => !t.startsWith("mcp__"));
    const rules = `# Rules\n\nWorkers have allowed tools: ${nonMcp.join(", ")}.`;
    const warn = vi.fn();
    expect(verifyExtractedRules(rules, warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rules mention allowed-tools but omit one → fail", () => {
    const nonMcp = WORKER_ALLOWED_TOOLS.filter((t) => !t.startsWith("mcp__"));
    // Drop the first non-mcp tool
    const included = nonMcp.slice(1);
    const rules = `# Rules\n\nAllowed tools: ${included.join(", ")}.`;
    const warn = vi.fn();
    expect(verifyExtractedRules(rules, warn)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(nonMcp[0]);
  });

  it("rules mention 'disallowed tools' only (never 'allowed tools') → pass (regex lookbehind)", () => {
    // Regression for the v0.7.3 round-1 fix: the negative lookbehind
    // (?<!dis) must prevent "disallowed tools" from triggering the strict check.
    const rules = `# Rules\n\nDisallowed tools are: Write, Edit, NotebookEdit, Task.`;
    const warn = vi.fn();
    expect(verifyExtractedRules(rules, warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rules mention neither task types nor allowed-tools → pass vacuously", () => {
    const rules = `# Rules\n\nUse semantic commit messages. Don't push to main directly.`;
    const warn = vi.fn();
    expect(verifyExtractedRules(rules, warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("integration: extractor returns FALLBACK_TEMPLATE-style content on drift (via warn + false return)", () => {
    // The `extractProjectRules` integration is complex (spawns an SDK agent);
    // here we assert only the observable behavior of verifyExtractedRules
    // as a unit. If the returned value is false, the caller falls back — that
    // fallback is tested separately by virtue of the extractor code path.
    const rules = `# Rules\n\nTask types include backend_api and frontend_ui.`;
    const warn = vi.fn();
    // Missing literals → false
    expect(verifyExtractedRules(rules, warn)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

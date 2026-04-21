import { describe, it, expect } from "vitest";

import {
  buildAdversarialStance,
  buildFeedbackFraming,
  buildRoundBudget,
  buildSeverityTaxonomy,
  buildCoordinatorMcpParagraph,
  buildCoordinatorMcpParagraphReplan,
} from "./codex-review-prompts.js";

describe("buildAdversarialStance", () => {
  it("includes ADVERSARIAL REVIEW MODE for plan target", () => {
    const out = buildAdversarialStance("plan");
    expect(out).toContain("ADVERSARIAL REVIEW MODE");
    expect(out).toContain("plan");
  });

  it("includes ADVERSARIAL REVIEW MODE for code target", () => {
    const out = buildAdversarialStance("code");
    expect(out).toContain("ADVERSARIAL REVIEW MODE");
    expect(out).toContain("code");
  });

  it("tells Codex to read the codebase, not just take claims at face value", () => {
    expect(buildAdversarialStance("plan")).toContain("Read the actual codebase");
  });
});

describe("buildFeedbackFraming", () => {
  it("contains the canonical collaborative-puzzle marker", () => {
    expect(buildFeedbackFraming()).toContain("collaborative puzzle");
  });

  it("allows honest approval over forced criticism", () => {
    expect(buildFeedbackFraming()).toContain("forced criticism is worse than honest approval");
  });
});

describe("buildRoundBudget", () => {
  it("renders round X of Y in the normal (pre-softCap) mode", () => {
    const out = buildRoundBudget({ current: 1, softCap: 6, hardCap: 6 });
    expect(out).toContain("round 1 of 6");
    expect(out).not.toContain("FINAL PLANNED ROUND");
    expect(out).not.toContain("OVERTIME");
  });

  it("renders FINAL PLANNED ROUND when current === softCap", () => {
    const out = buildRoundBudget({ current: 6, softCap: 6, hardCap: 6 });
    expect(out).toContain("FINAL PLANNED ROUND");
    expect(out).not.toContain("OVERTIME");
  });

  it("renders OVERTIME when past the softCap", () => {
    const out = buildRoundBudget({ current: 7, softCap: 6, hardCap: 11 });
    expect(out).toContain("OVERTIME");
  });

  it("anti-drip-feed block is always present", () => {
    const out = buildRoundBudget({ current: 2, softCap: 6, hardCap: 6 });
    expect(out).toContain("Dump every finding in this message");
    expect(out).toContain("Drip-feeding burns rounds");
  });
});

describe("buildSeverityTaxonomy", () => {
  it("includes all nine code-side labels", () => {
    const out = buildSeverityTaxonomy("code");
    for (const label of ["CRITICAL", "CORRECTNESS", "ARCHITECTURE", "SECURITY", "ROBUSTNESS", "SUGGESTION", "QUESTION", "PRAISE", "NIT"]) {
      expect(out).toContain(`[${label}]`);
    }
  });

  it("includes all nine plan-side labels", () => {
    const out = buildSeverityTaxonomy("plan");
    for (const label of ["CRITICAL", "CORRECTNESS", "COMPLETENESS", "ORDERING", "RISK", "ALTERNATIVE", "SUGGESTION", "QUESTION", "NIT"]) {
      expect(out).toContain(`[${label}]`);
    }
  });

  it("states the minor-only → APPROVE rule", () => {
    const out = buildSeverityTaxonomy("code");
    expect(out).toContain("every finding is `minor`");
    expect(out).toContain("MUST be `APPROVE`");
  });

  it("states that PRAISE goes in summary, not issues", () => {
    const out = buildSeverityTaxonomy("code");
    expect(out).toContain("Praise belongs in `summary`");
  });

  it("plan taxonomy does NOT include code-only labels ARCHITECTURE / SECURITY / ROBUSTNESS", () => {
    const out = buildSeverityTaxonomy("plan");
    expect(out).not.toContain("[ARCHITECTURE]");
    expect(out).not.toContain("[SECURITY]");
    expect(out).not.toContain("[ROBUSTNESS]");
  });

  it("code taxonomy does NOT include plan-only labels COMPLETENESS / ORDERING / RISK / ALTERNATIVE", () => {
    const out = buildSeverityTaxonomy("code");
    expect(out).not.toContain("[COMPLETENESS]");
    expect(out).not.toContain("[ORDERING]");
    expect(out).not.toContain("[RISK]");
    expect(out).not.toContain("[ALTERNATIVE]");
  });
});

describe("buildCoordinatorMcpParagraph", () => {
  it("advertises all four coordinator tools for code reviews", () => {
    const out = buildCoordinatorMcpParagraph();
    expect(out).toContain("get_tasks");
    expect(out).toContain("get_contracts");
    expect(out).toContain("get_decisions");
    expect(out).toContain("read_updates");
  });
});

describe("buildCoordinatorMcpParagraphReplan", () => {
  it("advertises only contracts + decisions for replan plan reviews", () => {
    const out = buildCoordinatorMcpParagraphReplan();
    expect(out).toContain("get_contracts");
    expect(out).toContain("get_decisions");
    expect(out).toContain("Do NOT rely on `get_tasks`");
  });
});

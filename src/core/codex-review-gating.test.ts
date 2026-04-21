import { describe, it, expect } from "vitest";

import {
  CATEGORY_TO_SEVERITY,
  hasBlockingIssues,
  hasOnlyMinorIssues,
  inferSeverityFromCategory,
  normalizeIssueKey,
} from "./codex-review-gating.js";

describe("CATEGORY_TO_SEVERITY", () => {
  it("maps CRITICAL to critical", () => {
    expect(CATEGORY_TO_SEVERITY.CRITICAL).toBe("critical");
  });

  it("maps major-class labels to major", () => {
    for (const label of ["CORRECTNESS", "ARCHITECTURE", "SECURITY", "ROBUSTNESS", "COMPLETENESS", "ORDERING", "RISK"]) {
      expect(CATEGORY_TO_SEVERITY[label]).toBe("major");
    }
  });

  it("maps minor-class labels to minor", () => {
    for (const label of ["SUGGESTION", "QUESTION", "NIT", "ALTERNATIVE"]) {
      expect(CATEGORY_TO_SEVERITY[label]).toBe("minor");
    }
  });

  it("maps PRAISE to minor defensively so it's never blocking", () => {
    expect(CATEGORY_TO_SEVERITY.PRAISE).toBe("minor");
  });
});

describe("inferSeverityFromCategory", () => {
  it("infers critical from [CRITICAL] prefix", () => {
    expect(inferSeverityFromCategory("[CRITICAL] Missing auth check")).toBe("critical");
  });

  it("infers major from [CORRECTNESS] prefix", () => {
    expect(inferSeverityFromCategory("[CORRECTNESS] Off-by-one in loop")).toBe("major");
  });

  it("infers minor from [NIT] prefix", () => {
    expect(inferSeverityFromCategory("[NIT] Inconsistent spacing")).toBe("minor");
  });

  it("returns null when there is no category tag", () => {
    expect(inferSeverityFromCategory("No tag here")).toBeNull();
  });

  it("returns null for an unknown category", () => {
    expect(inferSeverityFromCategory("[MYSTERYBUG] Whatever")).toBeNull();
  });

  it("returns minor for [PRAISE] (defensive)", () => {
    expect(inferSeverityFromCategory("[PRAISE] Good job")).toBe("minor");
  });

  it("is case-insensitive for the category label", () => {
    expect(inferSeverityFromCategory("[suggestion] ...")).toBe("minor");
    expect(inferSeverityFromCategory("[Correctness] ...")).toBe("major");
    expect(inferSeverityFromCategory("[critical] ...")).toBe("critical");
  });
});

describe("hasBlockingIssues", () => {
  it("returns false for empty array", () => {
    expect(hasBlockingIssues([])).toBe(false);
  });

  it("returns false for minor-only issues", () => {
    expect(hasBlockingIssues(["[minor] X", "[minor] Y"])).toBe(false);
  });

  it("returns true for a critical issue", () => {
    expect(hasBlockingIssues(["[minor] X", "[critical] Y"])).toBe(true);
  });

  it("returns true for a major issue", () => {
    expect(hasBlockingIssues(["[major] X"])).toBe(true);
  });

  it("treats [unknown] as blocking (could hide a real critical)", () => {
    expect(hasBlockingIssues(["[unknown] Parsed without severity"])).toBe(true);
  });

  it("ignores strings with no severity prefix", () => {
    expect(hasBlockingIssues(["no prefix at all"])).toBe(false);
  });
});

describe("hasOnlyMinorIssues", () => {
  it("returns false for empty array — empty is not approval", () => {
    expect(hasOnlyMinorIssues([])).toBe(false);
  });

  it("returns true when all issues are minor", () => {
    expect(hasOnlyMinorIssues(["[minor] X", "[minor] Y"])).toBe(true);
  });

  it("returns false when any issue is major", () => {
    expect(hasOnlyMinorIssues(["[minor] X", "[major] Y"])).toBe(false);
  });

  it("returns false when any issue is critical", () => {
    expect(hasOnlyMinorIssues(["[critical] X"])).toBe(false);
  });

  it("returns false when any issue is unknown (conservative)", () => {
    expect(hasOnlyMinorIssues(["[minor] X", "[unknown] Y"])).toBe(false);
  });

  it("returns false for an issue without a severity prefix", () => {
    expect(hasOnlyMinorIssues(["[minor] X", "no prefix"])).toBe(false);
  });
});

describe("normalizeIssueKey", () => {
  it("strips the severity prefix", () => {
    expect(normalizeIssueKey("[critical] Missing auth")).toBe("Missing auth");
  });

  it("strips both severity and category prefixes", () => {
    expect(normalizeIssueKey("[critical] [CORRECTNESS] Missing auth at handlers/posts.ts")).toBe(
      "Missing auth at handlers/posts.ts",
    );
  });

  it("collapses internal whitespace", () => {
    expect(normalizeIssueKey("[minor]  multiple   spaces   here")).toBe("multiple spaces here");
  });

  it("truncates to 80 chars", () => {
    const long = "[major] " + "x".repeat(200);
    expect(normalizeIssueKey(long).length).toBe(80);
  });

  it("produces the same key when only the category label changes", () => {
    const a = normalizeIssueKey("[critical] [CORRECTNESS] handlers/posts.ts:42 missing auth check");
    const b = normalizeIssueKey("[critical] [ROBUSTNESS] handlers/posts.ts:42 missing auth check");
    expect(a).toBe(b);
  });

  it("produces the same key when only the severity prefix changes", () => {
    const a = normalizeIssueKey("[unknown] handlers/posts.ts:42 auth bug");
    const b = normalizeIssueKey("[major] handlers/posts.ts:42 auth bug");
    expect(a).toBe(b);
  });

  it("strips category tag regardless of case (case-insensitive)", () => {
    const upper = normalizeIssueKey("[critical] [CORRECTNESS] handlers/posts.ts:42 auth bug");
    const lower = normalizeIssueKey("[critical] [correctness] handlers/posts.ts:42 auth bug");
    const mixed = normalizeIssueKey("[critical] [Correctness] handlers/posts.ts:42 auth bug");
    expect(upper).toBe(lower);
    expect(upper).toBe(mixed);
  });

  it("handles missing prefix gracefully", () => {
    expect(normalizeIssueKey("plain description")).toBe("plain description");
  });
});

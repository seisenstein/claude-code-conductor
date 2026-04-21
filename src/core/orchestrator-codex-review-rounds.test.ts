import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Round-wiring + gating-integration tests for v0.7.7.
 *
 * The full orchestrator exercises Codex, a live MCP server, and a real
 * filesystem, so these tests are source-level: we assert the orchestrator
 * passes the right RoundBudget / context shape at each call site and that
 * the gating helpers are wired into the escalation loop + approval state.
 * Paired with the behavioral tests in codex-review-gating.test.ts and
 * codex-reviewer.test.ts, they cover the full surface.
 */

async function readOrchestrator(): Promise<string> {
  return fs.readFile(path.join(__dirname, "orchestrator.ts"), "utf-8");
}

describe("orchestrator v0.7.7 - plan review round wiring", () => {
  it("imports the gating helpers", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("hasBlockingIssues");
    expect(source).toContain("hasOnlyMinorIssues");
    expect(source).toContain("normalizeIssueKey");
    expect(source).toContain('from "./codex-review-gating.js"');
  });

  it("initial reviewPlan is called with current=1 and isReplan context", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("this.codex.reviewPlan(");
    expect(source).toContain("current: 1, softCap: planSoftCap, hardCap: planSoftCap");
    expect(source).toContain("hasPriorContext: isReplan");
  });

  it("plan softCap is MAX_PLAN_DISCUSSION_ROUNDS + 1 (initial + re-reviews)", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("MAX_PLAN_DISCUSSION_ROUNDS + 1");
    expect(source).toContain("const planSoftCap =");
  });

  it("reReviewPlan passes current = discussionRound + 1", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("this.codex.reReviewPlan(");
    expect(source).toContain("current: discussionRound + 1, softCap: planSoftCap");
  });
});

describe("orchestrator v0.7.7 - code review round wiring", () => {
  it("initial reviewCode is called with current=1", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("this.codex.reviewCode(");
    expect(source).toContain("current: 1, softCap: codeSoftCap, hardCap: codeSoftCap");
  });

  it("code softCap is MAX_CODE_REVIEW_ROUNDS + 1", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("MAX_CODE_REVIEW_ROUNDS + 1");
    expect(source).toContain("const codeSoftCap =");
  });

  it("reReviewCode passes current = reviewRound + 1", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("this.codex.reReviewCode(");
    expect(source).toContain("current: reviewRound + 1, softCap: codeSoftCap");
  });
});

describe("orchestrator v0.7.7 - discussion loop gating", () => {
  it("plan while-loop continuation checks hasBlockingIssues", async () => {
    const source = await readOrchestrator();
    // The block of interest is the plan discussion loop condition.
    expect(source).toMatch(/reviewResult\.verdict !== "APPROVE"[\s\S]{0,400}hasBlockingIssues\(reviewResult\.issues\)[\s\S]{0,200}MAX_PLAN_DISCUSSION_ROUNDS/);
  });

  it("code while-loop continuation checks hasBlockingIssues", async () => {
    const source = await readOrchestrator();
    expect(source).toMatch(/reviewResult\.verdict !== "APPROVE"[\s\S]{0,400}hasBlockingIssues\(reviewResult\.issues\)[\s\S]{0,200}MAX_CODE_REVIEW_ROUNDS/);
  });
});

describe("orchestrator v0.7.7 - escalation filter + key normalization", () => {
  it("plan escalation counter uses normalizeIssueKey, not substring(0, 80)", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("normalizeIssueKey(issue)");
    // The raw substring approach must be gone.
    expect(source).not.toMatch(/const issueKey = issue\.substring\(0, 80\)/);
  });

  it("plan escalation counter skips non-blocking issues", async () => {
    const source = await readOrchestrator();
    // The new filter appears as a guard inside the for-loop.
    expect(source).toContain("if (!hasBlockingIssues([issue])) continue");
  });
});

describe("orchestrator v0.7.7 - approval state propagation for minor-only outcomes", () => {
  it("lastPlanApproved includes hasOnlyMinorIssues short-circuit", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("const planMinorOnly");
    expect(source).toContain("hasOnlyMinorIssues(reviewResult.issues)");
    expect(source).toContain('this.lastPlanApproved = reviewResult.verdict === "APPROVE" || planMinorOnly');
  });

  it("code-review approved includes hasOnlyMinorIssues short-circuit", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("const codeMinorOnly");
    expect(source).toContain("const approved = reviewResult.verdict === \"APPROVE\" || isToolFailure || codeMinorOnly");
  });

  it("log line distinguishes minor-only outcomes from true APPROVE verdicts", async () => {
    const source = await readOrchestrator();
    expect(source).toContain("treating as approved-with-minors");
  });
});

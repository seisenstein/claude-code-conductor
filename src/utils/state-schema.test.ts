/**
 * Tests for state-schema.ts — Zod validation that gates state.json integrity.
 *
 * CR-4 continuation (v0.7.3): validateStateJson and validateStateJsonLenient
 * are security/reliability critical (malformed state crashes resume;
 * schema evolution is handled here). Tests cover:
 *
 *  - happy path
 *  - missing required fields
 *  - invalid field types
 *  - malformed JSON
 *  - lenient backfill for output_too_large_failures (v0.7.2)
 *  - lenient backfill for execution_errors (v0.7.3, H-16)
 *  - strict rejects what lenient accepts
 */

import { describe, it, expect } from "vitest";
import { validateStateJson, validateStateJsonLenient } from "./state-schema.js";

function minimalValidState(): Record<string, unknown> {
  return {
    status: "initializing",
    feature: "test feature",
    project_path: "/tmp/proj",
    branch: "conduct/test",
    worker_runtime: "claude",
    base_commit_sha: null,
    current_cycle: 0,
    max_cycles: 5,
    concurrency: 2,
    started_at: "2026-04-18T00:00:00.000Z",
    updated_at: "2026-04-18T00:00:00.000Z",
    paused_at: null,
    resume_after: null,
    usage: {
      five_hour: 0,
      seven_day: 0,
      five_hour_resets_at: null,
      seven_day_resets_at: null,
      last_checked: "2026-04-18T00:00:00.000Z",
    },
    claude_usage: null,
    codex_usage: null,
    codex_metrics: null,
    active_session_ids: [],
    cycle_history: [],
    progress: "",
  };
}

describe("validateStateJson (strict)", () => {
  it("accepts a minimal valid state", () => {
    const result = validateStateJson(JSON.stringify(minimalValidState()));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.state.feature).toBe("test feature");
      expect(result.state.worker_runtime).toBe("claude");
    }
  });

  it("rejects missing required fields", () => {
    const state = minimalValidState();
    delete state.status;
    const result = validateStateJson(JSON.stringify(state));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("status"))).toBe(true);
    }
  });

  it("rejects wrong field type", () => {
    const state = minimalValidState();
    state.concurrency = "two" as unknown as number;
    const result = validateStateJson(JSON.stringify(state));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("concurrency"))).toBe(true);
    }
  });

  it("rejects malformed JSON", () => {
    const result = validateStateJson("{ not json");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /invalid json/i.test(e))).toBe(true);
    }
  });

  it("rejects invalid status enum value", () => {
    const state = minimalValidState();
    state.status = "not-a-real-status";
    const result = validateStateJson(JSON.stringify(state));
    expect(result.valid).toBe(false);
  });

  it("accepts the full set of legitimate OrchestratorStatus values", () => {
    const values = [
      "initializing",
      "questioning",
      "planning",
      "executing",
      "reviewing",
      "flow_tracing",
      "checkpointing",
      "paused",
      "completed",
      "failed",
      "escalated",
    ];
    for (const v of values) {
      const state = minimalValidState();
      state.status = v;
      const result = validateStateJson(JSON.stringify(state));
      expect(result.valid, `status=${v}`).toBe(true);
    }
  });
});

describe("validateStateJsonLenient (backfill)", () => {
  it("backfills worker_runtime when missing", () => {
    const state = minimalValidState();
    delete state.worker_runtime;
    const result = validateStateJsonLenient(JSON.stringify(state));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.state.worker_runtime).toBe("claude");
    }
  });

  it("backfills output_too_large_failures to 0 (CR-2, v0.7.2)", () => {
    const state = minimalValidState();
    state.codex_metrics = {
      invocations: 1,
      successes: 0,
      invalid_responses: 1,
      presumed_rate_limits: 0,
      last_presumed_rate_limit_at: null,
      // output_too_large_failures intentionally missing — simulates pre-v0.7.2 state.json
    };
    const result = validateStateJsonLenient(JSON.stringify(state));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.state.codex_metrics?.output_too_large_failures).toBe(0);
    }
  });

  it("backfills execution_errors to 0 (H-16, v0.7.3)", () => {
    const state = minimalValidState();
    state.codex_metrics = {
      invocations: 1,
      successes: 0,
      invalid_responses: 1,
      presumed_rate_limits: 0,
      last_presumed_rate_limit_at: null,
      output_too_large_failures: 0,
      // execution_errors intentionally missing — simulates pre-v0.7.3 state.json
    };
    const result = validateStateJsonLenient(JSON.stringify(state));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.state.codex_metrics?.execution_errors).toBe(0);
    }
  });

  it("backfills both v0.7.2 and v0.7.3 metrics additions together", () => {
    // Pre-v0.7.2 state.json — only the fields v0.7.0/v0.7.1 shipped with.
    const state = minimalValidState();
    state.codex_metrics = {
      invocations: 5,
      successes: 2,
      invalid_responses: 1,
      presumed_rate_limits: 2,
      last_presumed_rate_limit_at: "2026-04-18T00:00:00.000Z",
    };
    const result = validateStateJsonLenient(JSON.stringify(state));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.state.codex_metrics?.invocations).toBe(5);
      expect(result.state.codex_metrics?.presumed_rate_limits).toBe(2);
      expect(result.state.codex_metrics?.output_too_large_failures).toBe(0);
      expect(result.state.codex_metrics?.execution_errors).toBe(0);
    }
  });

  it("also rejects malformed JSON in lenient mode", () => {
    const result = validateStateJsonLenient("not json at all");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => /invalid json/i.test(e))).toBe(true);
    }
  });

  it("still rejects a state with invalid field types (lenient is backfill, not permissive)", () => {
    const state = minimalValidState();
    state.current_cycle = -1;
    const result = validateStateJsonLenient(JSON.stringify(state));
    expect(result.valid).toBe(false);
  });
});

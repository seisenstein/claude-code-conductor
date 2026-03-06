import { describe, expect, it } from "vitest";

import { coerceLogText, detectProviderRateLimit } from "./provider-limit.js";

describe("coerceLogText", () => {
  it("returns an empty string for undefined values", () => {
    expect(coerceLogText(undefined)).toBe("");
  });

  it("serializes objects for logging", () => {
    expect(coerceLogText({ ok: true })).toBe('{"ok":true}');
  });
});

describe("detectProviderRateLimit", () => {
  it("detects common limit messages", () => {
    expect(
      detectProviderRateLimit("claude", "You've hit your limit · resets 7am (America/Vancouver)"),
    ).toMatchObject({
      provider: "claude",
    });
  });

  it("captures ISO reset hints when present", () => {
    expect(
      detectProviderRateLimit("codex", "rate limit exceeded until 2026-03-06T15:00:00.000Z"),
    ).toMatchObject({
      provider: "codex",
      resetsAt: "2026-03-06T15:00:00.000Z",
    });
  });

  it("detects 'rate limited' with a space separator", () => {
    expect(
      detectProviderRateLimit("claude", "Your account is rate limited, please wait"),
    ).toMatchObject({
      provider: "claude",
    });
  });

  it("ignores ordinary errors", () => {
    expect(detectProviderRateLimit("codex", "command failed with exit code 1")).toBeNull();
  });
});

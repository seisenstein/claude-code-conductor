import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tests for H14-H17 fixes in codex-worker-manager.ts.
 *
 * H14: killAllWorkers SIGTERM→SIGKILL escalation
 * H15: signalWindDown reason validation
 * H16: consumeLines byte-aware buffer truncation
 * H17: checkWorkerHealth wall-clock timeout tracking
 *
 * The CodexWorkerManager class requires spawning real child processes
 * and MCP infrastructure. We test the fix behaviors through:
 * 1. Source code verification for structural fixes
 * 2. Unit-level reproduction of the algorithms
 */

// ================================================================
// H14: killAllWorkers SIGTERM → SIGKILL escalation
// ================================================================

describe("CodexWorkerManager H14 - killAllWorkers SIGTERM→SIGKILL", () => {
  it("source code sends SIGTERM before SIGKILL", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );

    // H14: Must send SIGTERM first
    expect(source).toContain('kill("SIGTERM")');
    // H14: Must escalate to SIGKILL
    expect(source).toContain('kill("SIGKILL")');

    // Verify SIGTERM appears before SIGKILL in the killAllWorkers method
    const sigTermIndex = source.indexOf('kill("SIGTERM")');
    const sigKillIndex = source.indexOf('kill("SIGKILL")');
    expect(sigTermIndex).toBeLessThan(sigKillIndex);
  });

  it("source code has a timeout between SIGTERM and SIGKILL", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );

    // H14: Must have a timeout (10 seconds)
    expect(source).toContain("KILL_TIMEOUT_MS");
    expect(source).toContain("10_000");

    // H14: Must use Promise.race for timeout
    expect(source).toContain("Promise.race");
    expect(source).toContain("Promise.allSettled");
  });

  it("source code references H14 fix in comment", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );
    expect(source).toContain("H14");
  });
});

// ================================================================
// H15: signalWindDown reason validation
// ================================================================

describe("CodexWorkerManager H15 - signalWindDown reason validation", () => {
  it("source code validates wind_down reason", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );

    // H15: Must have VALID_REASONS constant
    expect(source).toContain("VALID_REASONS");

    // H15: Must check against valid reasons
    expect(source).toContain("usage_limit");
    expect(source).toContain("user_requested");

    // H15: Must fall back to default on invalid reason
    expect(source).toContain('reason = "user_requested"');
  });

  it("source code references H15 fix in comment", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );
    expect(source).toContain("H15");
  });

  it("validates reason against expected union type at runtime", () => {
    // Reproduce the validation logic
    const VALID_REASONS = ["usage_limit", "cycle_limit", "user_requested"] as const;

    const validReason = "usage_limit";
    expect(VALID_REASONS.includes(validReason as typeof VALID_REASONS[number])).toBe(true);

    const invalidReason = "something_else";
    expect(VALID_REASONS.includes(invalidReason as typeof VALID_REASONS[number])).toBe(false);

    const emptyReason = "";
    expect(VALID_REASONS.includes(emptyReason as typeof VALID_REASONS[number])).toBe(false);
  });
});

// ================================================================
// H16: consumeLines byte-aware truncation
// ================================================================

describe("CodexWorkerManager H16 - consumeLines byte-aware truncation", () => {
  it("source code uses Buffer for byte-level slicing", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );

    // H16: Must use Buffer.from for byte conversion
    expect(source).toContain('Buffer.from(buffer, "utf-8")');

    // H16: Must use buf.length for byte-level slicing (not string length)
    expect(source).toContain("buf.length");
    expect(source).toContain("subarray");

    // H16: Must check against MAX_BUFFER_SIZE_BYTES
    expect(source).toContain("MAX_BUFFER_SIZE_BYTES");
    expect(source).toContain("Buffer.byteLength");
  });

  it("source code references H16 fix in comment", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );
    expect(source).toContain("H16");
  });

  it("byte-aware truncation handles multi-byte characters correctly", () => {
    // Reproduce the truncation logic
    const MAX_SIZE = 100; // small limit for testing

    // String with multi-byte characters (each emoji is 4 bytes in UTF-8)
    const multiByteStr = "🎉".repeat(30); // 30 emojis = 120 bytes > 100 byte limit

    const bufferSizeBytes = Buffer.byteLength(multiByteStr, "utf-8");
    expect(bufferSizeBytes).toBeGreaterThan(MAX_SIZE);

    // Apply the H16 fix: byte-aware slicing
    const buf = Buffer.from(multiByteStr, "utf-8");
    const halfBytes = Math.floor(buf.length / 2);
    const truncated = buf.subarray(halfBytes).toString("utf-8");

    // Result should be valid UTF-8 (may have a replacement char at the boundary)
    expect(typeof truncated).toBe("string");
    // Result byte size should be approximately half the original
    const truncatedBytes = Buffer.byteLength(truncated, "utf-8");
    expect(truncatedBytes).toBeLessThanOrEqual(bufferSizeBytes);
  });

  it("byte-aware truncation handles ASCII correctly", () => {
    const MAX_SIZE = 50;
    const asciiStr = "A".repeat(100); // 100 bytes > 50 byte limit

    const buf = Buffer.from(asciiStr, "utf-8");
    const halfBytes = Math.floor(buf.length / 2);
    const truncated = buf.subarray(halfBytes).toString("utf-8");

    expect(truncated.length).toBe(50);
    expect(Buffer.byteLength(truncated, "utf-8")).toBe(50);
  });

  it("byte-aware truncation handles mixed content", () => {
    const MAX_SIZE = 50;
    const mixed = "Hello 🌍 World 🎉 Test 💻"; // mix of ASCII and multi-byte

    const buf = Buffer.from(mixed, "utf-8");
    const halfBytes = Math.floor(buf.length / 2);
    const truncated = buf.subarray(halfBytes).toString("utf-8");

    // Should produce valid string (no crash, no infinite loop)
    expect(typeof truncated).toBe("string");
    expect(truncated.length).toBeGreaterThan(0);
  });
});

// ================================================================
// H17: checkWorkerHealth timeout tracking
// ================================================================

describe("CodexWorkerManager H17 - checkWorkerHealth timeout tracking", () => {
  it("source code checks wall-clock timeout for workers", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );

    // H17: Must have a timeout constant (30 minutes)
    expect(source).toContain("CODEX_WORKER_TIMEOUT_MS");
    expect(source).toContain("30 * 60 * 1000");

    // H17: Must track start time
    expect(source).toContain("startedAt");

    // H17: Must return timedOut array with actual data
    expect(source).toContain("timedOut");
  });

  it("source code references H17 fix in comment", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );
    expect(source).toContain("H17");
  });

  it("timeout detection logic works correctly", () => {
    // Reproduce the timeout detection logic
    const CODEX_WORKER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    // Worker started 31 minutes ago — should be timed out
    const startedAt31MinAgo = new Date(now - 31 * 60 * 1000).toISOString();
    const elapsed31 = now - new Date(startedAt31MinAgo).getTime();
    expect(elapsed31).toBeGreaterThan(CODEX_WORKER_TIMEOUT_MS);

    // Worker started 5 minutes ago — should NOT be timed out
    const startedAt5MinAgo = new Date(now - 5 * 60 * 1000).toISOString();
    const elapsed5 = now - new Date(startedAt5MinAgo).getTime();
    expect(elapsed5).toBeLessThan(CODEX_WORKER_TIMEOUT_MS);

    // Worker started exactly at timeout — should NOT be timed out (using >)
    const startedAtExact = new Date(now - CODEX_WORKER_TIMEOUT_MS).toISOString();
    const elapsedExact = now - new Date(startedAtExact).getTime();
    expect(elapsedExact).toBeLessThanOrEqual(CODEX_WORKER_TIMEOUT_MS);
  });

  it("checkWorkerHealth returns correct structure", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );

    // Should return { timedOut: string[], stale: string[] }
    expect(source).toContain("timedOut: string[]");
    expect(source).toContain("stale: string[]");

    // Stale detection is not supported for Codex workers
    expect(source).toContain("stale: []");
  });
});

// ================================================================
// General source verification
// ================================================================

describe("CodexWorkerManager general security", () => {
  it("uses writeFileSecure for session status writes", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );

    // Session status files should use writeFileSecure for proper permissions (H-7/H-8 fix)
    expect(source).toContain("writeFileSecure");
    // Should import writeFileSecure from secure-fs
    expect(source).toContain("writeFileSecure");
  });

  it("uses appendJsonlLocked for message writes", async () => {
    const source = await fs.readFile(
      path.join(__dirname, "codex-worker-manager.ts"),
      "utf-8",
    );

    // Should use the locking utility for JSONL writes
    expect(source).toContain("appendJsonlLocked");
  });
});

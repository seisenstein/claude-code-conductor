/**
 * Tests for readJsonlFile — Critical C3 fix.
 *
 * Verifies that readJsonlFile handles malformed JSON lines gracefully
 * instead of crashing the entire MCP server.
 */

import { describe, expect, it, afterEach, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readJsonlFile } from "./tools.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `readJsonlFile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("readJsonlFile", () => {
  it("returns parsed objects for a valid JSONL file", async () => {
    const filePath = path.join(tempDir, "valid.jsonl");
    await fs.writeFile(
      filePath,
      '{"id":1,"name":"alice"}\n{"id":2,"name":"bob"}\n{"id":3,"name":"charlie"}\n',
    );
    const result = await readJsonlFile<{ id: number; name: string }>(filePath);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 1, name: "alice" });
    expect(result[1]).toEqual({ id: 2, name: "bob" });
    expect(result[2]).toEqual({ id: 3, name: "charlie" });
  });

  it("skips malformed JSON lines and returns valid ones (C3 fix)", async () => {
    const filePath = path.join(tempDir, "mixed.jsonl");
    await fs.writeFile(
      filePath,
      '{"id":1,"name":"alice"}\nNOT_VALID_JSON\n{"id":2,"name":"bob"}\n{broken\n{"id":3,"name":"charlie"}\n',
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await readJsonlFile<{ id: number; name: string }>(filePath);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 1, name: "alice" });
    expect(result[1]).toEqual({ id: 2, name: "bob" });
    expect(result[2]).toEqual({ id: 3, name: "charlie" });

    // Should have warned about the 2 malformed lines via process.stderr.write
    const stderrCalls = stderrSpy.mock.calls.filter(c => String(c[0]).includes("[readJsonlFile]"));
    expect(stderrCalls).toHaveLength(2);
    expect(String(stderrCalls[0]![0])).toContain("Skipping malformed JSON line");
    expect(String(stderrCalls[0]![0])).toContain("NOT_VALID_JSON");
    expect(String(stderrCalls[1]![0])).toContain("{broken");
    stderrSpy.mockRestore();
  });

  it("returns empty array for entirely malformed file", async () => {
    const filePath = path.join(tempDir, "allbad.jsonl");
    await fs.writeFile(filePath, "garbage\nmore garbage\nnope\n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await readJsonlFile<unknown>(filePath);
    expect(result).toEqual([]);
    const stderrCalls = stderrSpy.mock.calls.filter(c => String(c[0]).includes("[readJsonlFile]"));
    expect(stderrCalls).toHaveLength(3);
    stderrSpy.mockRestore();
  });

  it("returns empty array for non-existent file", async () => {
    const filePath = path.join(tempDir, "nonexistent.jsonl");
    const result = await readJsonlFile<unknown>(filePath);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty file", async () => {
    const filePath = path.join(tempDir, "empty.jsonl");
    await fs.writeFile(filePath, "");
    const result = await readJsonlFile<unknown>(filePath);
    expect(result).toEqual([]);
  });

  it("returns empty array for file with only whitespace/newlines", async () => {
    const filePath = path.join(tempDir, "whitespace.jsonl");
    await fs.writeFile(filePath, "\n\n\n  \n");
    const result = await readJsonlFile<unknown>(filePath);
    expect(result).toEqual([]);
  });

  it("handles single valid line without trailing newline", async () => {
    const filePath = path.join(tempDir, "single.jsonl");
    await fs.writeFile(filePath, '{"key":"value"}');
    const result = await readJsonlFile<{ key: string }>(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "value" });
  });

  it("truncates long malformed lines in warning message", async () => {
    const filePath = path.join(tempDir, "long-bad.jsonl");
    const longLine = "x".repeat(200);
    await fs.writeFile(filePath, longLine + "\n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await readJsonlFile<unknown>(filePath);
    // The warning should truncate at 100 chars
    const stderrCalls = stderrSpy.mock.calls.filter(c => String(c[0]).includes("[readJsonlFile]"));
    expect(stderrCalls).toHaveLength(1);
    const warnMsg = String(stderrCalls[0]![0]);
    expect(warnMsg).toContain("x".repeat(100));
    expect(warnMsg).not.toContain("x".repeat(200));
    stderrSpy.mockRestore();
  });

  it("re-throws non-ENOENT read errors (M-28)", async () => {
    // M-28: Non-ENOENT errors (like EISDIR, EACCES) should be re-thrown
    // instead of silently returning an empty array
    const filePath = path.join(tempDir, "isdir.jsonl");
    await fs.mkdir(filePath, { recursive: true });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(readJsonlFile<unknown>(filePath)).rejects.toThrow("EISDIR");
    // Should still log the error before re-throwing
    const stderrCalls = stderrSpy.mock.calls.filter(c => String(c[0]).includes("[readJsonlFile]"));
    expect(stderrCalls).toHaveLength(1);
    expect(String(stderrCalls[0]![0])).toContain("Error reading");
    stderrSpy.mockRestore();
  });
});

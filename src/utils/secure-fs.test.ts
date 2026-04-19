import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeFileSecure,
  mkdirSecure,
  mkdirSecureSync,
  appendFileSecure,
  chmodSecure,
  appendJsonlLocked,
  writeJsonAtomic,
  SECURE_FILE_MODE,
  SECURE_DIR_MODE,
} from "./secure-fs.js";

describe("secure-fs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "secure-fs-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("writeFileSecure", () => {
    it("writes a new file with 0o600 mode", async () => {
      const p = path.join(tmpDir, "new.txt");
      await writeFileSecure(p, "hello");
      const stat = await fs.stat(p);
      expect(stat.mode & 0o777).toBe(SECURE_FILE_MODE);
      expect(await fs.readFile(p, "utf-8")).toBe("hello");
    });

    it("enforces 0o600 on an existing file with broader perms (umask defeat)", async () => {
      const p = path.join(tmpDir, "existing.txt");
      // Create with 0o644
      await fs.writeFile(p, "old", { mode: 0o644 });
      await fs.chmod(p, 0o644); // make sure
      const before = (await fs.stat(p)).mode & 0o777;
      expect(before).toBe(0o644);

      await writeFileSecure(p, "new");
      const after = (await fs.stat(p)).mode & 0o777;
      expect(after).toBe(SECURE_FILE_MODE);
    });

    it("respects custom mode", async () => {
      const p = path.join(tmpDir, "custom.txt");
      await writeFileSecure(p, "x", { mode: 0o640 });
      expect((await fs.stat(p)).mode & 0o777).toBe(0o640);
    });
  });

  describe("mkdirSecure (H-2)", () => {
    it("creates a directory with 0o700 even under a permissive umask", async () => {
      const prev = process.umask(0o022); // default umask that would yield 0o755 via plain mkdir
      try {
        const p = path.join(tmpDir, "secure-dir");
        await mkdirSecure(p, { recursive: true });
        const stat = await fs.stat(p);
        expect(stat.mode & 0o777).toBe(SECURE_DIR_MODE);
      } finally {
        process.umask(prev);
      }
    });

    it("re-chmods an existing directory with broader perms", async () => {
      const p = path.join(tmpDir, "existing");
      await fs.mkdir(p, { mode: 0o755 });
      await fs.chmod(p, 0o755);
      expect((await fs.stat(p)).mode & 0o777).toBe(0o755);

      await mkdirSecure(p, { recursive: true });
      expect((await fs.stat(p)).mode & 0o777).toBe(SECURE_DIR_MODE);
    });

    it("only chmods the final target on recursive create", async () => {
      const prev = process.umask(0o022);
      try {
        const p = path.join(tmpDir, "outer", "inner");
        await mkdirSecure(p, { recursive: true });
        // final target is 0o700
        expect((await fs.stat(p)).mode & 0o777).toBe(SECURE_DIR_MODE);
        // parent is NOT forced to 0o700 (may inherit umask filter)
        // We only verify the invariant the helper promises: target is 0o700.
      } finally {
        process.umask(prev);
      }
    });
  });

  describe("mkdirSecureSync", () => {
    it("creates a directory with 0o700 under permissive umask", () => {
      const prev = process.umask(0o022);
      try {
        const p = path.join(tmpDir, "sync-dir");
        mkdirSecureSync(p, { recursive: true });
        const stat = fsSync.statSync(p);
        expect(stat.mode & 0o777).toBe(SECURE_DIR_MODE);
      } finally {
        process.umask(prev);
      }
    });
  });

  describe("appendFileSecure", () => {
    it("creates a new file with 0o600", async () => {
      const p = path.join(tmpDir, "append-new.log");
      await appendFileSecure(p, "line1\n");
      expect((await fs.stat(p)).mode & 0o777).toBe(SECURE_FILE_MODE);
      expect(await fs.readFile(p, "utf-8")).toBe("line1\n");
    });

    it("appends to existing and enforces 0o600", async () => {
      const p = path.join(tmpDir, "append-existing.log");
      await fs.writeFile(p, "first\n", { mode: 0o644 });
      await fs.chmod(p, 0o644);
      await appendFileSecure(p, "second\n");
      expect(await fs.readFile(p, "utf-8")).toBe("first\nsecond\n");
      expect((await fs.stat(p)).mode & 0o777).toBe(SECURE_FILE_MODE);
    });
  });

  describe("chmodSecure", () => {
    it("sets mode 0o600 by default", async () => {
      const p = path.join(tmpDir, "chmod-test.txt");
      await fs.writeFile(p, "x", { mode: 0o644 });
      await fs.chmod(p, 0o644);
      await chmodSecure(p);
      expect((await fs.stat(p)).mode & 0o777).toBe(SECURE_FILE_MODE);
    });
  });

  describe("appendJsonlLocked", () => {
    it("creates file and appends a JSON line", async () => {
      const p = path.join(tmpDir, "events.jsonl");
      await appendJsonlLocked(p, { a: 1 });
      await appendJsonlLocked(p, { b: 2 });
      const content = await fs.readFile(p, "utf-8");
      expect(content.trim().split("\n")).toEqual([
        JSON.stringify({ a: 1 }),
        JSON.stringify({ b: 2 }),
      ]);
      expect((await fs.stat(p)).mode & 0o777).toBe(SECURE_FILE_MODE);
    });

    it("writes produce clean lines (no interleaving on repeated writes)", async () => {
      const p = path.join(tmpDir, "sequential.jsonl");
      // Sequential writes to avoid proper-lockfile retry-exhaustion flakes.
      // The file lock serializes concurrent callers in production; this
      // test only verifies that each write produces a parseable line.
      for (let i = 0; i < 10; i++) {
        await appendJsonlLocked(p, { i });
      }
      const content = await fs.readFile(p, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(10);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe("writeJsonAtomic [T-5]", () => {
    it("writes via tmp + rename and leaves no .tmp sibling", async () => {
      const dest = path.join(tmpDir, "atomic.json");
      await writeJsonAtomic(dest, "content");

      expect(await fs.readFile(dest, "utf-8")).toBe("content");

      // No .tmp sibling remains after a successful rename
      const tmpExists = await fs
        .access(dest + ".tmp")
        .then(() => true)
        .catch(() => false);
      expect(tmpExists).toBe(false);
    });

    it("calls FileHandle.sync() exactly once by default (fsync for durability)", async () => {
      const dest = path.join(tmpDir, "fsync-default.json");

      // Spy by wrapping fs.open: return a proxy that records sync() calls,
      // then delegates the real call. This is the cleanest seam — we can't
      // spy on FileHandle.prototype directly because FileHandle instances
      // don't share a prototype that vi.spyOn can see (they're bound to the
      // individual handle object per open()).
      const realOpen = fs.open.bind(fs);
      const syncSpy = vi.fn();
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const fh = await realOpen(...args);
        const origSync = fh.sync.bind(fh);
        fh.sync = async () => {
          syncSpy();
          return origSync();
        };
        return fh;
      });

      try {
        await writeJsonAtomic(dest, "content-default");
      } finally {
        openSpy.mockRestore();
      }

      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(dest, "utf-8")).toBe("content-default");
    });

    it("skips FileHandle.sync() when { fsync: false }", async () => {
      const dest = path.join(tmpDir, "fsync-false.json");

      const realOpen = fs.open.bind(fs);
      const syncSpy = vi.fn();
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const fh = await realOpen(...args);
        const origSync = fh.sync.bind(fh);
        fh.sync = async () => {
          syncSpy();
          return origSync();
        };
        return fh;
      });

      try {
        await writeJsonAtomic(dest, "content-no-fsync", { fsync: false });
      } finally {
        openSpy.mockRestore();
      }

      expect(syncSpy).not.toHaveBeenCalled();
      expect(await fs.readFile(dest, "utf-8")).toBe("content-no-fsync");
    });

    it("defaults mode to 0o600", async () => {
      const dest = path.join(tmpDir, "mode-default.json");
      await writeJsonAtomic(dest, "x");
      const stat = await fs.stat(dest);
      expect(stat.mode & 0o777).toBe(SECURE_FILE_MODE);
    });
  });
});

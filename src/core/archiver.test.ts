/**
 * Unit tests for src/core/archiver.ts (v0.7.6).
 *
 * Uses os.tmpdir() sandboxes so no real conductor state is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  archiveCurrentRun,
  deriveSlug,
  detectStaleTerminalState,
  finalizePartialArchive,
  listArchives,
  pruneArchives,
  readArchive,
  ArchiveNotFoundError,
  ArchiveRefusedError,
} from "./archiver.js";
import {
  ARCHIVE_DIR,
  ARCHIVE_IN_PROGRESS_MARKER,
  ARCHIVE_META_FILE,
  ORCHESTRATOR_DIR,
  getArchiveDir,
  getArchivePath,
  getStatePath,
} from "../utils/constants.js";
import type { OrchestratorState, OrchestratorStatus } from "../utils/types.js";

// ============================================================
// Fixtures
// ============================================================

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    status: "completed" as OrchestratorStatus,
    feature: "demo feature",
    project_path: "/tmp/demo",
    branch: "conduct/demo-feature",
    worker_runtime: "claude",
    model_config: { worker: "opus", subagent: "sonnet", extendedContext: false },
    base_commit_sha: null,
    current_cycle: 1,
    max_cycles: 5,
    concurrency: 2,
    consecutive_flow_tracing_failures: 0,
    started_at: "2026-04-18T05:15:00.000Z",
    updated_at: "2026-04-18T05:18:00.000Z",
    paused_at: null,
    resume_after: null,
    usage: {
      five_hour: 0,
      seven_day: 0,
      five_hour_resets_at: null,
      seven_day_resets_at: null,
      last_checked: "2026-04-18T05:18:00.000Z",
    },
    claude_usage: null,
    codex_usage: null,
    codex_metrics: null,
    active_session_ids: [],
    cycle_history: [],
    progress: "",
    ...overrides,
  };
}

async function seedConductorDir(
  projectDir: string,
  state: OrchestratorState | null,
  extras: { files?: Record<string, string>; dirs?: string[] } = {},
): Promise<void> {
  const dir = path.join(projectDir, ORCHESTRATOR_DIR);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (state) {
    await fs.writeFile(getStatePath(projectDir), JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  for (const [rel, content] of Object.entries(extras.files ?? {})) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, { mode: 0o600 });
  }
  for (const rel of extras.dirs ?? []) {
    await fs.mkdir(path.join(dir, rel), { recursive: true, mode: 0o700 });
  }
}

// ============================================================
// Tests
// ============================================================

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archiver-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("deriveSlug", () => {
  const fixedNow = () => new Date("2026-04-18T05:18:00.000Z");

  it("strips conduct/ prefix when branch present", () => {
    const s = deriveSlug({ branch: "conduct/my-feature", feature: "", status: "completed" }, undefined, fixedNow);
    expect(s).toBe("my-feature-20260418-051800");
  });

  it("falls back to feature slug when branch missing", () => {
    const s = deriveSlug({ branch: "", feature: "Fix Lock Race", status: "completed" }, undefined, fixedNow);
    expect(s).toBe("fix-lock-race-20260418-051800");
  });

  it("falls back to feature slug when branch is 'main'", () => {
    const s = deriveSlug({ branch: "main", feature: "Hello", status: "completed" }, undefined, fixedNow);
    expect(s).toBe("hello-20260418-051800");
  });

  it("falls back to 'run' when both branch and feature are empty", () => {
    const s = deriveSlug({ branch: "", feature: "", status: "completed" }, undefined, fixedNow);
    expect(s).toBe("run-20260418-051800");
  });

  it("appends -FAILED when status is failed", () => {
    const s = deriveSlug({ branch: "conduct/fail", feature: "", status: "failed" }, undefined, fixedNow);
    expect(s).toBe("fail-FAILED-20260418-051800");
  });

  it("truncates long feature strings", () => {
    const longFeature = "a".repeat(200);
    const s = deriveSlug({ branch: "", feature: longFeature, status: "completed" }, undefined, fixedNow);
    expect(s.length).toBeLessThanOrEqual(80);
  });

  it("respects override slug", () => {
    const s = deriveSlug({ branch: "conduct/ignored", feature: "", status: "completed" }, "custom-name", fixedNow);
    expect(s).toBe("custom-name-20260418-051800");
  });

  it("slugifies punctuation and collapses dashes", () => {
    const s = deriveSlug({ branch: "conduct/My Feature!!!--name", feature: "", status: "completed" }, undefined, fixedNow);
    expect(s).toBe("my-feature-name-20260418-051800");
  });
});

describe("detectStaleTerminalState", () => {
  it("returns stale=false when state.json is missing", async () => {
    const r = await detectStaleTerminalState(tmpDir);
    expect(r.stale).toBe(false);
  });

  it("returns stale=true for completed status", async () => {
    await seedConductorDir(tmpDir, makeState({ status: "completed" }));
    const r = await detectStaleTerminalState(tmpDir);
    expect(r.stale).toBe(true);
    if (r.stale) {
      expect(r.status).toBe("completed");
      expect(r.slug).toMatch(/^demo-feature-\d{8}-\d{6}$/);
    }
  });

  it("returns stale=true for failed status with -FAILED in slug", async () => {
    await seedConductorDir(tmpDir, makeState({ status: "failed" }));
    const r = await detectStaleTerminalState(tmpDir);
    expect(r.stale).toBe(true);
    if (r.stale) {
      expect(r.status).toBe("failed");
      expect(r.slug).toContain("-FAILED-");
    }
  });

  it("returns stale=false for paused status", async () => {
    await seedConductorDir(tmpDir, makeState({ status: "paused" }));
    const r = await detectStaleTerminalState(tmpDir);
    expect(r.stale).toBe(false);
  });

  it("returns stale=false for executing status", async () => {
    await seedConductorDir(tmpDir, makeState({ status: "executing" }));
    const r = await detectStaleTerminalState(tmpDir);
    expect(r.stale).toBe(false);
  });

  it("returns stale=false (does not throw) for corrupt JSON", async () => {
    await fs.mkdir(path.join(tmpDir, ORCHESTRATOR_DIR), { recursive: true });
    await fs.writeFile(getStatePath(tmpDir), "{ not valid json");
    const r = await detectStaleTerminalState(tmpDir);
    expect(r.stale).toBe(false);
  });
});

describe("archiveCurrentRun — happy path", () => {
  it("moves listed files + dirs into a fresh archive with valid meta", async () => {
    await seedConductorDir(tmpDir, makeState({ status: "completed" }), {
      files: {
        "context.md": "# Context",
        "decisions.jsonl": '{"id":"d1"}\n',
        "events.jsonl": '{"type":"phase_start"}\n',
        "progress.jsonl": "",
        "known-issues.json": "[]",
        "tasks-draft.json": "[]",
        "plan-v1.md": "# Plan v1",
        "plan-v3.md": "# Plan v3", // gap (no v2) — both should archive
        "tasks/task-001.json": '{"id":"task-001"}',
        "messages/session-01.jsonl": "",
        "sessions/session-01/output.log": "hi",
        "contracts/c1.json": "{}",
        "codex-reviews/r1.md": "# review",
        "flow-tracing/report.json": "{}",
        "logs/conductor.log": "log entry",
      },
    });

    const res = await archiveCurrentRun(tmpDir, { archivedBy: "manual" });
    expect(res.slug).toMatch(/^demo-feature-\d{8}-\d{6}$/);
    expect(res.meta.final_status).toBe("completed");
    expect(res.meta.archive_version).toBeGreaterThan(0);
    expect(res.meta.archived_by).toBe("manual");

    // Root cleanup: state.json, context.md, plan-v1.md, plan-v3.md should be gone.
    await expect(fs.access(getStatePath(tmpDir))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, ORCHESTRATOR_DIR, "context.md"))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, ORCHESTRATOR_DIR, "plan-v1.md"))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, ORCHESTRATOR_DIR, "plan-v3.md"))).rejects.toThrow();

    // Archive contents
    const archivePath = res.archivePath;
    await fs.access(path.join(archivePath, "state.json"));
    await fs.access(path.join(archivePath, "plan-v1.md"));
    await fs.access(path.join(archivePath, "plan-v3.md"));
    await fs.access(path.join(archivePath, "tasks", "task-001.json"));
    await fs.access(path.join(archivePath, ARCHIVE_META_FILE));
    await expect(fs.access(path.join(archivePath, ARCHIVE_IN_PROGRESS_MARKER))).rejects.toThrow();
  });

  it("throws ArchiveRefusedError on paused without force", async () => {
    await seedConductorDir(tmpDir, makeState({ status: "paused" }));
    await expect(archiveCurrentRun(tmpDir, { archivedBy: "manual" })).rejects.toBeInstanceOf(ArchiveRefusedError);
  });

  it("archives paused state when force=true", async () => {
    await seedConductorDir(tmpDir, makeState({ status: "paused" }));
    const res = await archiveCurrentRun(tmpDir, { archivedBy: "manual", force: true });
    expect(res.meta.final_status).toBe("unknown");
  });

  it("throws when state.json is missing", async () => {
    await fs.mkdir(path.join(tmpDir, ORCHESTRATOR_DIR), { recursive: true });
    await expect(archiveCurrentRun(tmpDir, { archivedBy: "manual" })).rejects.toThrow(/missing or invalid/);
  });

  it("resolves slug collisions with -2, -3, ...", async () => {
    const state = makeState({ status: "completed" });
    const slug1 = deriveSlug(state, undefined, () => new Date("2026-04-18T05:18:00.000Z"));
    // Pre-create a dir matching the slug to force a collision.
    await fs.mkdir(path.join(tmpDir, ORCHESTRATOR_DIR, ARCHIVE_DIR, slug1), { recursive: true });
    await seedConductorDir(tmpDir, state);

    const res = await archiveCurrentRun(tmpDir, {
      archivedBy: "manual",
      now: () => new Date("2026-04-18T05:18:00.000Z"),
    });
    expect(res.slug).toBe(`${slug1}-2`);
  });

  it("preserves 0o600 on files and 0o700 on dirs inside the archive", async () => {
    await seedConductorDir(tmpDir, makeState(), {
      files: { "context.md": "x", "tasks/t1.json": "{}" },
      dirs: ["messages"],
    });
    const res = await archiveCurrentRun(tmpDir, { archivedBy: "manual" });

    const fileStat = fsSync.statSync(path.join(res.archivePath, "context.md"));
    expect(fileStat.mode & 0o777).toBe(0o600);

    const dirStat = fsSync.statSync(path.join(res.archivePath, "tasks"));
    expect(dirStat.mode & 0o777 & 0o700).toBe(0o700);
  });
});

describe("finalizePartialArchive", () => {
  it("is a no-op when archive dir doesn't exist", async () => {
    await finalizePartialArchive(tmpDir);
    // No throw = pass.
  });

  it("removes marker when both marker + meta exist", async () => {
    const slug = "some-run-20260418-051800";
    const archivePath = getArchivePath(tmpDir, slug);
    await fs.mkdir(archivePath, { recursive: true });
    await fs.writeFile(path.join(archivePath, ARCHIVE_IN_PROGRESS_MARKER), "");
    await fs.writeFile(path.join(archivePath, ARCHIVE_META_FILE), "{}");

    await finalizePartialArchive(tmpDir);

    await fs.access(archivePath); // still there
    await expect(fs.access(path.join(archivePath, ARCHIVE_IN_PROGRESS_MARKER))).rejects.toThrow();
    await fs.access(path.join(archivePath, ARCHIVE_META_FILE));
  });

  it("quarantines to -PARTIAL when marker exists but meta missing", async () => {
    const slug = "crashed-20260418-051800";
    const archivePath = getArchivePath(tmpDir, slug);
    await fs.mkdir(archivePath, { recursive: true });
    await fs.writeFile(path.join(archivePath, ARCHIVE_IN_PROGRESS_MARKER), "");

    await finalizePartialArchive(tmpDir);

    await expect(fs.access(archivePath)).rejects.toThrow();
    const quarantined = archivePath + "-PARTIAL";
    await fs.access(quarantined);
    // marker deleted after rename
    await expect(fs.access(path.join(quarantined, ARCHIVE_IN_PROGRESS_MARKER))).rejects.toThrow();
  });

  it("leaves legacy archives (no marker) untouched", async () => {
    const legacy = getArchivePath(tmpDir, "legacy-run");
    await fs.mkdir(legacy, { recursive: true });

    await finalizePartialArchive(tmpDir);

    await fs.access(legacy);
  });

  it("skips entries already ending with -PARTIAL or -PARTIAL-N", async () => {
    const p1 = getArchivePath(tmpDir, "foo-PARTIAL");
    const p2 = getArchivePath(tmpDir, "foo-PARTIAL-2");
    await fs.mkdir(p1, { recursive: true });
    await fs.mkdir(p2, { recursive: true });
    await fs.writeFile(path.join(p1, ARCHIVE_IN_PROGRESS_MARKER), ""); // stuck marker
    await fs.writeFile(path.join(p2, ARCHIVE_IN_PROGRESS_MARKER), ""); // stuck marker

    await finalizePartialArchive(tmpDir);

    // Both should still exist with suffix NOT doubled.
    await fs.access(p1);
    await fs.access(p2);
    await expect(fs.access(p1 + "-PARTIAL")).rejects.toThrow();
    await expect(fs.access(p2 + "-PARTIAL")).rejects.toThrow();
  });

  it("uses -PARTIAL-2 when -PARTIAL already exists", async () => {
    const slug = "dup-20260418-051800";
    const orig = getArchivePath(tmpDir, slug);
    const partial1 = orig + "-PARTIAL";
    await fs.mkdir(orig, { recursive: true });
    await fs.writeFile(path.join(orig, ARCHIVE_IN_PROGRESS_MARKER), "");
    await fs.mkdir(partial1, { recursive: true }); // collision

    await finalizePartialArchive(tmpDir);

    await expect(fs.access(orig)).rejects.toThrow();
    await fs.access(partial1); // pre-existing untouched
    await fs.access(orig + "-PARTIAL-2"); // new quarantine
  });
});

describe("listArchives", () => {
  it("returns [] when archive dir is missing", async () => {
    expect(await listArchives(tmpDir)).toEqual([]);
  });

  it("returns [] when archive dir exists but is empty", async () => {
    await fs.mkdir(getArchiveDir(tmpDir), { recursive: true });
    expect(await listArchives(tmpDir)).toEqual([]);
  });

  it("returns valid + legacy entries, skips partials, sorts desc", async () => {
    const archiveRoot = getArchiveDir(tmpDir);
    await fs.mkdir(archiveRoot, { recursive: true });

    // Valid archive
    const valid = path.join(archiveRoot, "valid-20260418-051800");
    await fs.mkdir(valid, { recursive: true });
    await fs.writeFile(
      path.join(valid, ARCHIVE_META_FILE),
      JSON.stringify({
        archive_version: 1,
        archived_at: "2026-04-18T05:18:00.000Z",
        archived_by: "manual",
        original_slug: "valid",
        final_status: "completed",
        summary: null,
        conductor_version: "0.7.6",
      }),
    );

    // Legacy archive (no meta) — force an old mtime so sort puts it after "valid"
    const legacy = path.join(archiveRoot, "legacy-20260101-120000");
    await fs.mkdir(legacy, { recursive: true });
    const legacyMtime = new Date("2026-01-01T12:00:00.000Z");
    await fs.utimes(legacy, legacyMtime, legacyMtime);

    // Partial (has marker) — should be skipped
    const partial = path.join(archiveRoot, "partial-20260418-060000");
    await fs.mkdir(partial, { recursive: true });
    await fs.writeFile(path.join(partial, ARCHIVE_IN_PROGRESS_MARKER), "");

    // -PARTIAL-quarantined — should be skipped
    const quarantined = path.join(archiveRoot, "q-PARTIAL");
    await fs.mkdir(quarantined, { recursive: true });

    const list = await listArchives(tmpDir);
    expect(list.length).toBe(2);
    expect(list[0].dirSlug).toBe("valid-20260418-051800");
    expect(list[0].meta.original_slug).toBe("valid");
    expect(list[1].dirSlug).toBe("legacy-20260101-120000");
    expect(list[1].meta.final_status).toBe("unknown");
    expect(list[1].meta.archive_version).toBe(0);
  });
});

describe("readArchive", () => {
  it("returns parsed meta for valid archive", async () => {
    const archiveRoot = getArchiveDir(tmpDir);
    const p = path.join(archiveRoot, "valid-20260418-051800");
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(
      path.join(p, ARCHIVE_META_FILE),
      JSON.stringify({
        archive_version: 1,
        archived_at: "2026-04-18T05:18:00.000Z",
        archived_by: "auto-on-completion",
        original_slug: "valid",
        final_status: "completed",
        summary: null,
        conductor_version: "0.7.6",
      }),
    );
    const entry = await readArchive(tmpDir, "valid-20260418-051800");
    expect(entry.dirSlug).toBe("valid-20260418-051800");
    expect(entry.meta.archived_by).toBe("auto-on-completion");
  });

  it("returns legacy stub when meta is missing", async () => {
    const p = getArchivePath(tmpDir, "legacy-run");
    await fs.mkdir(p, { recursive: true });
    const entry = await readArchive(tmpDir, "legacy-run");
    expect(entry.dirSlug).toBe("legacy-run");
    expect(entry.meta.final_status).toBe("unknown");
    expect(entry.meta.archive_version).toBe(0);
  });

  it("throws ArchiveNotFoundError when slug does not exist", async () => {
    await expect(readArchive(tmpDir, "nonexistent")).rejects.toBeInstanceOf(ArchiveNotFoundError);
  });

  it("rejects slugs with path-traversal segments", async () => {
    await expect(readArchive(tmpDir, "../etc")).rejects.toThrow(/Invalid archive slug/);
    await expect(readArchive(tmpDir, "has/slash")).rejects.toThrow(/Invalid archive slug/);
  });
});

describe("pruneArchives", () => {
  async function seedArchive(slug: string, archivedAt: string, finalStatus: "completed" | "failed" | "unknown" = "completed"): Promise<void> {
    const p = getArchivePath(tmpDir, slug);
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(
      path.join(p, ARCHIVE_META_FILE),
      JSON.stringify({
        archive_version: 1,
        archived_at: archivedAt,
        archived_by: "manual",
        original_slug: slug,
        final_status: finalStatus,
        summary: null,
        conductor_version: "0.7.6",
      }),
    );
  }

  it("errors when no filter is provided", async () => {
    await expect(pruneArchives(tmpDir, {}, { dryRun: true })).rejects.toThrow(/specify at least one of/);
  });

  it("--keep-last 0 --dry-run lists all, deletes none", async () => {
    await seedArchive("a-20260418-100000", "2026-04-18T10:00:00.000Z");
    await seedArchive("b-20260417-100000", "2026-04-17T10:00:00.000Z");
    await seedArchive("c-20260416-100000", "2026-04-16T10:00:00.000Z");
    const r = await pruneArchives(tmpDir, { keepLast: 0 }, { dryRun: true });
    expect(r.candidates.length).toBe(3);
    expect(r.deleted.length).toBe(0);
  });

  it("--keep-last 2 deletes the oldest of three", async () => {
    await seedArchive("a-20260418-100000", "2026-04-18T10:00:00.000Z");
    await seedArchive("b-20260417-100000", "2026-04-17T10:00:00.000Z");
    await seedArchive("c-20260416-100000", "2026-04-16T10:00:00.000Z");
    const r = await pruneArchives(tmpDir, { keepLast: 2 }, { dryRun: false });
    expect(r.candidates.length).toBe(1);
    expect(r.deleted.length).toBe(1);
    await expect(fs.access(getArchivePath(tmpDir, "c-20260416-100000"))).rejects.toThrow();
    await fs.access(getArchivePath(tmpDir, "a-20260418-100000"));
    await fs.access(getArchivePath(tmpDir, "b-20260417-100000"));
  });

  it("--before date includes only archives older than date", async () => {
    await seedArchive("new-1", "2026-04-18T10:00:00.000Z");
    await seedArchive("old-1", "2026-01-01T00:00:00.000Z");
    const r = await pruneArchives(
      tmpDir,
      { beforeDate: new Date("2026-02-01T00:00:00.000Z") },
      { dryRun: true },
    );
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].slug).toBe("old-1");
  });

  it("--status narrows — does NOT match legacy 'unknown' archives", async () => {
    // Legacy archive (meta says unknown)
    const p = getArchivePath(tmpDir, "legacy");
    await fs.mkdir(p, { recursive: true });
    await seedArchive("completed-one", "2026-04-18T10:00:00.000Z", "completed");

    const r = await pruneArchives(tmpDir, { keepLast: 0, status: "failed" }, { dryRun: true });
    // 'completed-one' is completed, not failed → excluded.
    // 'legacy' has no meta → listed as unknown → excluded.
    expect(r.candidates.length).toBe(0);
  });

  it("dry-run never mutates the filesystem", async () => {
    await seedArchive("a", "2026-04-18T10:00:00.000Z");
    await pruneArchives(tmpDir, { keepLast: 0 }, { dryRun: true });
    await fs.access(getArchivePath(tmpDir, "a"));
  });

  it("--keep-last + --status narrows scope FIRST (status-scoped keep-last, Codex round-1 code-review)", async () => {
    // Seed 2 failed + 2 completed. --keep-last 1 --status failed should
    // keep the newest FAILED and delete the older FAILED only. The two
    // completed archives must be untouched.
    await seedArchive("fail-new-20260418-100000", "2026-04-18T10:00:00.000Z", "failed");
    await seedArchive("fail-old-20260417-100000", "2026-04-17T10:00:00.000Z", "failed");
    await seedArchive("ok-new-20260416-100000", "2026-04-16T10:00:00.000Z", "completed");
    await seedArchive("ok-old-20260415-100000", "2026-04-15T10:00:00.000Z", "completed");

    const r = await pruneArchives(tmpDir, { keepLast: 1, status: "failed" }, { dryRun: false });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].slug).toBe("fail-old-20260417-100000");
    expect(r.deleted).toEqual(["fail-old-20260417-100000"]);

    await fs.access(getArchivePath(tmpDir, "fail-new-20260418-100000"));
    await expect(fs.access(getArchivePath(tmpDir, "fail-old-20260417-100000"))).rejects.toThrow();
    // Completed archives untouched
    await fs.access(getArchivePath(tmpDir, "ok-new-20260416-100000"));
    await fs.access(getArchivePath(tmpDir, "ok-old-20260415-100000"));
  });

  it("prune emits the actual directory slug so same-timestamp archives are distinct (Codex round-1 code-review)", async () => {
    // Two archives with identical archived_at but different dirSlug +
    // final_status. --status failed must only mark the FAILED one; the
    // completed one must not be deleted by mistake.
    const sameTs = "2026-04-18T10:00:00.000Z";
    await seedArchive("race-failed", sameTs, "failed");
    await seedArchive("race-completed", sameTs, "completed");

    const r = await pruneArchives(tmpDir, { keepLast: 0, status: "failed" }, { dryRun: false });
    expect(r.deleted).toEqual(["race-failed"]);
    await expect(fs.access(getArchivePath(tmpDir, "race-failed"))).rejects.toThrow();
    await fs.access(getArchivePath(tmpDir, "race-completed"));
  });
});

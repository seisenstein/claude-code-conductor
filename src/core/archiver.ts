/**
 * Archiver (v0.7.6)
 *
 * Moves conductor run artifacts under `.conductor/archive/<slug>-<ts>/` on
 * terminal status or explicit user command. See `.claude/specs/v0.7.6-auto-archival.md`
 * for the spec and `.claude/specs/v0.7.6-implementation-plan.md` for the
 * Codex-reviewed design.
 *
 * Safety invariants:
 *   - Archival is the last mutation on `.conductor/` in a run. In the
 *     orchestrator's `run().finally`, event-log + logger are flushed/closed
 *     BEFORE we move files.
 *   - `fs.rename` is atomic on a single filesystem; we fall back to
 *     `fs.cp` + `fs.rm` on EXDEV and re-normalize permissions.
 *   - An `.archive-in-progress` marker is written before moves begin and
 *     deleted only after `_archive-meta.json` is durable. Any crash
 *     between leaves a partial archive which `finalizePartialArchive`
 *     quarantines on next start.
 *   - We never touch lock files; the CLI layer holds them and
 *     `releaseLock()` handles cleanup.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  ArchiveMeta,
  ArchivedBy,
  ArchiveSummary,
  OrchestratorState,
} from "../utils/types.js";
import { validateStateJsonLenient } from "../utils/state-schema.js";
import { validateIdentifier } from "../utils/validation.js";
import { mkdirSecure, writeJsonAtomic, SECURE_FILE_MODE, SECURE_DIR_MODE } from "../utils/secure-fs.js";
import {
  ARCHIVE_COLLISION_LIMIT,
  ARCHIVE_IN_PROGRESS_MARKER,
  ARCHIVE_META_FILE,
  ARCHIVE_PARTIAL_REGEX,
  ARCHIVE_PARTIAL_SUFFIX,
  ARCHIVE_PLAN_GLOB,
  ARCHIVE_VERSION,
  BRANCH_PREFIX,
  FILES_TO_ARCHIVE,
  FILES_TO_DELETE_ON_ARCHIVE,
  MAX_ARCHIVE_SLUG_CORE_LENGTH,
  MAX_ARCHIVE_SLUG_LENGTH,
  ORCHESTRATOR_DIR,
  getArchiveDir,
  getArchivePath,
  getArchiveMetaPath,
  getArchiveInProgressMarkerPath,
  getStatePath,
} from "../utils/constants.js";

// ============================================================
// Package version — hoisted so archive-meta records match the running CLI.
// ============================================================

// Keep in sync with package.json + src/cli.ts .version()
const CONDUCTOR_VERSION = "0.7.6";

// ============================================================
// Error types
// ============================================================

export class ArchiveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveRefusedError";
  }
}

export class ArchiveNotFoundError extends Error {
  constructor(slug: string) {
    super(`Archive not found: ${slug}`);
    this.name = "ArchiveNotFoundError";
  }
}

// ============================================================
// Public types
// ============================================================

export interface ArchiveResult {
  archivePath: string;
  slug: string;
  meta: ArchiveMeta;
}

/**
 * An archive entry as returned by listArchives / readArchive. Wraps the
 * on-disk `ArchiveMeta` with the actual directory slug (which includes the
 * timestamp + any collision suffix). The directory slug is what users pass
 * to `conduct archive inspect <slug>` and what pruneArchives uses for
 * deletion — `meta.original_slug` intentionally strips the timestamp
 * (following the spec) and is not a unique identifier.
 */
export interface ArchiveEntry {
  dirSlug: string;     // actual directory name under .conductor/archive/
  archivePath: string; // absolute path
  meta: ArchiveMeta;
}

export interface ArchiveOptions {
  archivedBy: ArchivedBy;
  force?: boolean; // allow archiving paused/escalated
  slug?: string;   // override auto-derived slug (timestamp still appended)
  now?: () => Date;
}

export interface PruneFilter {
  beforeDate?: Date;
  keepLast?: number;
  status?: "completed" | "failed";
}

export interface PruneCandidate {
  slug: string;        // directory slug (unambiguous — matches the on-disk dir name)
  archivedAt: Date;
  meta: ArchiveMeta | null;
  reason: string;
}

export interface PruneResult {
  candidates: PruneCandidate[];
  deleted: string[];
}

export type StaleDetection =
  | { stale: false }
  | {
      stale: true;
      status: "completed" | "failed";
      slug: string;
      state: OrchestratorState;
    };

// ============================================================
// Internal helpers
// ============================================================

function slugify(raw: string, maxLen: number): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, ""); // trim trailing dash that a slice may have created
}

function formatTimestampUtc(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "-" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readLstat(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/** Walks the tree rooted at `root`; does NOT follow symlinks. For each
 *  regular file chmods to 0o600, for each regular dir chmods to 0o700.
 *  Symlinks are skipped (chmod follows symlinks and would mutate targets). */
async function normalizePermissionsRecursive(root: string): Promise<void> {
  const rootStat = await readLstat(root);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink()) return;

  if (rootStat.isDirectory()) {
    try {
      await fs.chmod(root, SECURE_DIR_MODE);
    } catch {
      // Non-fatal
    }
    let entries: string[] = [];
    try {
      entries = await fs.readdir(root);
    } catch {
      return;
    }
    for (const e of entries) {
      await normalizePermissionsRecursive(path.join(root, e));
    }
  } else if (rootStat.isFile()) {
    try {
      await fs.chmod(root, SECURE_FILE_MODE);
    } catch {
      // Non-fatal
    }
  }
  // Other types (sockets, fifos, block/char devices) — leave alone.
}

async function moveWithExdevFallback(src: string, dst: string): Promise<void> {
  await mkdirSecure(path.dirname(dst), { recursive: true });
  try {
    await fs.rename(src, dst);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EXDEV") {
      throw err;
    }
  }
  // Cross-filesystem fallback. Copy then remove source. Do NOT set
  // preserveTimestamps — some FUSE/container mounts reject utimes and we
  // don't need timestamp fidelity for AC #9 (which only requires permissions).
  await fs.cp(src, dst, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  await normalizePermissionsRecursive(dst);
  await fs.rm(src, { recursive: true, force: true });
}

function resolveFailedSuffix(status: string): string {
  return status === "failed" ? "-FAILED" : "";
}

/**
 * Clamp the full slug to MAX_ARCHIVE_SLUG_LENGTH by truncating the core
 * (the first segment, before -FAILED/-ts).
 */
function clampSlugToMax(core: string, failedSuffix: string, timestampSuffix: string): string {
  const overheadLen = failedSuffix.length + timestampSuffix.length;
  const roomForCore = MAX_ARCHIVE_SLUG_LENGTH - overheadLen;
  const effectiveMaxCore = Math.max(1, Math.min(MAX_ARCHIVE_SLUG_CORE_LENGTH, roomForCore));
  let trimmed = core.slice(0, effectiveMaxCore).replace(/-+$/g, "");
  if (trimmed.length === 0) trimmed = "run";
  return trimmed + failedSuffix + timestampSuffix;
}

/**
 * Derive an archive slug from orchestrator state.
 *
 * Algorithm (§2.1 of the plan):
 *   1. base = override || strip BRANCH_PREFIX from state.branch.
 *      If branch is empty/"main", fallback to slugify(feature, 40).
 *      If feature is also empty, fallback to "run".
 *   2. Append -FAILED when status === "failed".
 *   3. Append -YYYYMMDD-HHMMSS (UTC).
 *   4. Total length clamped to MAX_ARCHIVE_SLUG_LENGTH.
 *
 * Collision suffix resolution (<slug>-2/-3/...) happens in archiveCurrentRun.
 */
export function deriveSlug(
  state: Pick<OrchestratorState, "branch" | "feature" | "status">,
  override?: string,
  now: () => Date = () => new Date(),
): string {
  const failedSuffix = resolveFailedSuffix(state.status);
  const ts = "-" + formatTimestampUtc(now());

  let core: string;
  if (override !== undefined && override.trim().length > 0) {
    core = slugify(override, MAX_ARCHIVE_SLUG_CORE_LENGTH);
    if (core.length === 0) core = "run";
  } else {
    const branch = (state.branch ?? "").trim();
    const stripped = branch.startsWith(BRANCH_PREFIX)
      ? branch.slice(BRANCH_PREFIX.length)
      : branch;
    if (stripped.length > 0 && stripped !== "main") {
      core = slugify(stripped, MAX_ARCHIVE_SLUG_CORE_LENGTH);
    } else {
      const feat = (state.feature ?? "").trim();
      core = feat ? slugify(feat, MAX_ARCHIVE_SLUG_CORE_LENGTH) : "run";
    }
    if (core.length === 0) core = "run";
  }

  return clampSlugToMax(core, failedSuffix, ts);
}

/**
 * Read state.json, lenient. Returns null on any error (missing, invalid,
 * unreadable). Callers decide how to classify. For start-command Hook 1 the
 * CLI's own `readState()` distinguishes error kinds; this function is used
 * only in archival paths where we already expect state to be present.
 */
async function readStateLenient(projectDir: string): Promise<OrchestratorState | null> {
  const statePath = getStatePath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf-8");
  } catch {
    return null;
  }
  const r = validateStateJsonLenient(raw);
  if (!r.valid) return null;
  return r.state as OrchestratorState;
}

/** Make sure the archive root is a real directory, not a symlink. */
async function ensureArchiveRootIsRealDir(projectDir: string): Promise<void> {
  const archiveDir = getArchiveDir(projectDir);
  const st = await readLstat(archiveDir);
  if (!st) {
    await mkdirSecure(archiveDir, { recursive: true });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(
      `archive root is not a regular directory: ${archiveDir} — refuse to write`,
    );
  }
}

// ============================================================
// detectStaleTerminalState
// ============================================================

export async function detectStaleTerminalState(projectDir: string): Promise<StaleDetection> {
  const statePath = getStatePath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      process.stderr.write(`[archiver] state.json read failed in detectStaleTerminalState: ${String(err)}\n`);
    }
    return { stale: false };
  }
  const r = validateStateJsonLenient(raw);
  if (!r.valid) {
    process.stderr.write(`[archiver] state.json invalid in detectStaleTerminalState; skipping stale-detection\n`);
    return { stale: false };
  }
  const state = r.state as OrchestratorState;
  if (state.status === "completed" || state.status === "failed") {
    return {
      stale: true,
      status: state.status,
      slug: deriveSlug(state),
      state,
    };
  }
  return { stale: false };
}

// ============================================================
// finalizePartialArchive
// ============================================================

export async function finalizePartialArchive(projectDir: string): Promise<void> {
  const archiveDir = getArchiveDir(projectDir);
  const st = await readLstat(archiveDir);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    process.stderr.write(
      `[archiver] archive root is not a regular directory: ${archiveDir} — skipping partial-archive finalization\n`,
    );
    return;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(archiveDir);
  } catch (err) {
    process.stderr.write(`[archiver] cannot list ${archiveDir}: ${String(err)}\n`);
    return;
  }

  for (const entry of entries) {
    if (ARCHIVE_PARTIAL_REGEX.test(entry)) continue; // already quarantined
    const entryPath = path.join(archiveDir, entry);
    const entryStat = await readLstat(entryPath);
    if (!entryStat || !entryStat.isDirectory()) continue;

    const markerPath = path.join(entryPath, ARCHIVE_IN_PROGRESS_MARKER);
    const metaPath = path.join(entryPath, ARCHIVE_META_FILE);
    const hasMarker = await pathExists(markerPath);
    if (!hasMarker) continue;

    const hasMeta = await pathExists(metaPath);
    if (hasMeta) {
      // Archive was 99% done — just finalize by removing the marker.
      try {
        await fs.rm(markerPath, { force: true });
        process.stderr.write(`[archiver] recovered partial archive: ${entry} (marker cleared)\n`);
      } catch (err) {
        process.stderr.write(`[archiver] failed to clear marker in ${entry}: ${String(err)}\n`);
      }
      continue;
    }

    // Quarantine to <slug>-PARTIAL (with bounded collision suffix).
    let quarantinePath = entryPath + ARCHIVE_PARTIAL_SUFFIX;
    let renamed = false;
    for (let i = 0; i <= ARCHIVE_COLLISION_LIMIT; i++) {
      const candidate = i === 0
        ? entryPath + ARCHIVE_PARTIAL_SUFFIX
        : entryPath + ARCHIVE_PARTIAL_SUFFIX + "-" + (i + 1);
      if (!(await pathExists(candidate))) {
        try {
          await fs.rename(entryPath, candidate);
          quarantinePath = candidate;
          renamed = true;
          break;
        } catch (err) {
          process.stderr.write(
            `[archiver] failed to quarantine ${entry} to ${path.basename(candidate)}: ${String(err)}\n`,
          );
          // Try next suffix
        }
      }
    }
    if (!renamed) {
      process.stderr.write(
        `[archiver] could not quarantine ${entry}; all -PARTIAL-* suffixes up to ${ARCHIVE_COLLISION_LIMIT + 1} exist or failed. Leaving in place.\n`,
      );
      continue;
    }

    // Delete the marker after rename — the -PARTIAL suffix is the
    // quarantine signal now.
    try {
      await fs.rm(path.join(quarantinePath, ARCHIVE_IN_PROGRESS_MARKER), { force: true });
    } catch {
      // Non-fatal; quarantine is the primary signal.
    }
    process.stderr.write(`[archiver] quarantined partial archive as ${path.basename(quarantinePath)}\n`);
  }
}

// ============================================================
// archiveCurrentRun
// ============================================================

export async function archiveCurrentRun(
  projectDir: string,
  opts: ArchiveOptions,
): Promise<ArchiveResult> {
  // 1. Read state.
  const state = await readStateLenient(projectDir);
  if (!state) {
    throw new Error(
      `archiveCurrentRun: ${getStatePath(projectDir)} is missing or invalid. ` +
      `Inspect .conductor/ manually, then re-run, or quarantine the directory.`,
    );
  }

  // 2. Refuse paused/escalated without --force.
  if (!opts.force && (state.status === "paused" || state.status === "escalated")) {
    throw new ArchiveRefusedError(
      `Run is ${state.status}; refusing to archive without force. ` +
      `Use \`conduct resume\` to continue, or pass --force --yes to archive anyway.`,
    );
  }

  // 3. Ensure archive root is sane.
  await ensureArchiveRootIsRealDir(projectDir);

  // 4. Derive slug (+ collision resolution).
  const now = opts.now ?? (() => new Date());
  const baseSlug = deriveSlug(state, opts.slug, now);
  let finalSlug = baseSlug;
  let archivePath = getArchivePath(projectDir, finalSlug);
  for (let i = 0; await pathExists(archivePath); i++) {
    if (i >= ARCHIVE_COLLISION_LIMIT) {
      throw new Error(
        `archiveCurrentRun: exhausted ${ARCHIVE_COLLISION_LIMIT + 1} collision suffixes for slug '${baseSlug}'`,
      );
    }
    finalSlug = `${baseSlug}-${i + 2}`;
    archivePath = getArchivePath(projectDir, finalSlug);
  }

  // 5. Create archive dir + marker (atomic marker write).
  await mkdirSecure(archivePath, { recursive: true });
  const markerPath = getArchiveInProgressMarkerPath(projectDir, finalSlug);
  await writeJsonAtomic(markerPath, "", { fsync: false });

  // 6. Build the work-list: FILES_TO_ARCHIVE + ARCHIVE_PLAN_GLOB matches.
  const conductorDir = path.join(projectDir, ORCHESTRATOR_DIR);
  const workList = new Set<string>(FILES_TO_ARCHIVE);
  try {
    const rootEntries = await fs.readdir(conductorDir);
    for (const e of rootEntries) {
      if (ARCHIVE_PLAN_GLOB.test(e)) workList.add(e);
    }
  } catch {
    // If we can't read the conductor dir, nothing to archive from root.
  }

  // 7. Move each work-list entry.
  for (const rel of workList) {
    const src = path.join(conductorDir, rel);
    const srcStat = await readLstat(src);
    if (!srcStat) continue; // missing — skip silently
    const dst = path.join(archivePath, rel);
    await moveWithExdevFallback(src, dst);
  }

  // 8. Delete transient files.
  for (const rel of FILES_TO_DELETE_ON_ARCHIVE) {
    try {
      await fs.rm(path.join(conductorDir, rel), { force: true, recursive: false });
    } catch {
      // Non-fatal; file may not exist.
    }
  }

  // 9. Write _archive-meta.json atomically.
  const meta: ArchiveMeta = buildArchiveMeta(state, finalSlug, opts.archivedBy, now());
  const metaPath = getArchiveMetaPath(projectDir, finalSlug);
  await writeJsonAtomic(metaPath, JSON.stringify(meta, null, 2) + "\n");

  // 10. Remove in-progress marker — archive is now durable + discoverable.
  await fs.rm(markerPath, { force: true });

  return { archivePath, slug: finalSlug, meta };
}

function buildArchiveMeta(
  state: OrchestratorState,
  finalSlug: string,
  archivedBy: ArchivedBy,
  nowDate: Date,
): ArchiveMeta {
  const finalStatus: "completed" | "failed" | "unknown" =
    state.status === "completed" ? "completed"
    : state.status === "failed" ? "failed"
    : "unknown";

  // Derive original slug (pre-timestamp/pre-collision). Reuse deriveSlug's
  // core logic by stripping the ts suffix from finalSlug.
  const originalSlug = finalSlug.replace(/-\d{8}-\d{6}(?:-\d+)?$/, "");

  const cycleHistory = state.cycle_history ?? [];
  const tasksCompleted = cycleHistory.reduce((s, c) => s + (c.tasks_completed ?? 0), 0);
  const tasksFailed = cycleHistory.reduce((s, c) => s + (c.tasks_failed ?? 0), 0);

  const summary: ArchiveSummary | null = state.feature
    ? {
        cycles_run: cycleHistory.length,
        max_cycles: state.max_cycles ?? 0,
        tasks_completed: tasksCompleted,
        tasks_failed: tasksFailed,
        feature: state.feature ?? "",
        branch: state.branch ?? "",
        started_at: state.started_at ?? "",
        completed_at: state.updated_at ?? nowDate.toISOString(),
      }
    : null;

  return {
    archive_version: ARCHIVE_VERSION,
    archived_at: nowDate.toISOString(),
    archived_by: archivedBy,
    original_slug: originalSlug,
    final_status: finalStatus,
    summary,
    conductor_version: CONDUCTOR_VERSION,
  };
}

// ============================================================
// listArchives / readArchive
// ============================================================

function synthesizeLegacyMeta(slug: string, mtime: Date): ArchiveMeta {
  return {
    archive_version: 0,
    archived_at: mtime.toISOString(),
    archived_by: "unknown",
    original_slug: slug,
    final_status: "unknown",
    summary: null,
    conductor_version: "legacy",
  };
}

async function readMetaTolerant(projectDir: string, slug: string): Promise<ArchiveMeta | null> {
  const metaPath = getArchiveMetaPath(projectDir, slug);
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ArchiveMeta>;
    // Defensive defaults — if any required field is missing, fall back to
    // synthesized stub-style values rather than throwing.
    return {
      archive_version: typeof parsed.archive_version === "number" ? parsed.archive_version : 0,
      archived_at: typeof parsed.archived_at === "string" ? parsed.archived_at : new Date(0).toISOString(),
      archived_by: parsed.archived_by ?? "unknown",
      original_slug: typeof parsed.original_slug === "string" ? parsed.original_slug : slug,
      final_status: (parsed.final_status === "completed" || parsed.final_status === "failed")
        ? parsed.final_status
        : "unknown",
      summary: parsed.summary ?? null,
      conductor_version: typeof parsed.conductor_version === "string" ? parsed.conductor_version : "unknown",
    };
  } catch {
    return null;
  }
}

export async function listArchives(projectDir: string): Promise<ArchiveEntry[]> {
  const archiveDir = getArchiveDir(projectDir);
  const st = await readLstat(archiveDir);
  if (!st) return [];
  if (st.isSymbolicLink() || !st.isDirectory()) {
    process.stderr.write(`[archiver] archive root is not a regular directory; listArchives returning []\n`);
    return [];
  }

  let entries: string[];
  try {
    entries = await fs.readdir(archiveDir);
  } catch {
    return [];
  }

  const out: ArchiveEntry[] = [];
  for (const entry of entries) {
    const entryPath = path.join(archiveDir, entry);
    const entryStat = await readLstat(entryPath);
    if (!entryStat || !entryStat.isDirectory()) continue;

    const markerPath = path.join(entryPath, ARCHIVE_IN_PROGRESS_MARKER);
    if (await pathExists(markerPath)) continue; // partial — skip
    if (ARCHIVE_PARTIAL_REGEX.test(entry)) continue; // quarantined — skip

    const meta = (await readMetaTolerant(projectDir, entry)) ?? synthesizeLegacyMeta(entry, entryStat.mtime);
    out.push({ dirSlug: entry, archivePath: entryPath, meta });
  }

  out.sort((a, b) => {
    if (a.meta.archived_at < b.meta.archived_at) return 1;
    if (a.meta.archived_at > b.meta.archived_at) return -1;
    // Stable secondary sort on dirSlug so same-timestamp archives have a
    // deterministic order (matters for keep-last correctness).
    if (a.dirSlug < b.dirSlug) return 1;
    if (a.dirSlug > b.dirSlug) return -1;
    return 0;
  });
  return out;
}

export async function readArchive(projectDir: string, slug: string): Promise<ArchiveEntry> {
  const v = validateIdentifier(slug);
  if (!v.valid) {
    throw new Error(`Invalid archive slug: ${v.reason}`);
  }
  const archivePath = getArchivePath(projectDir, slug);
  const st = await readLstat(archivePath);
  if (!st) throw new ArchiveNotFoundError(slug);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Archive entry is not a regular directory: ${slug}`);
  }
  const meta = (await readMetaTolerant(projectDir, slug)) ?? synthesizeLegacyMeta(slug, st.mtime);
  return { dirSlug: slug, archivePath, meta };
}

// ============================================================
// pruneArchives
// ============================================================

export async function pruneArchives(
  projectDir: string,
  filter: PruneFilter,
  opts: { dryRun: boolean },
): Promise<PruneResult> {
  if (filter.beforeDate === undefined && filter.keepLast === undefined) {
    throw new Error("pruneArchives: specify at least one of --before or --keep-last");
  }

  const all = await listArchives(projectDir); // ArchiveEntry[], sorted desc by timestamp

  // Codex round-1 (code-review): `--status` narrows the considered set FIRST,
  // so `--keep-last N --status failed` means "keep the N newest FAILED runs".
  // That matches the CLI copy "Only consider archives with this status".
  // Legacy archives with final_status "unknown" never match a specific
  // --status filter (safer default).
  const considered = filter.status
    ? all.filter((e) => e.meta.final_status === filter.status)
    : all;

  const candidates: PruneCandidate[] = [];
  for (let i = 0; i < considered.length; i++) {
    const entry = considered[i];
    const archivedAt = new Date(entry.meta.archived_at);
    let reason: string | null = null;

    if (filter.keepLast !== undefined && i >= filter.keepLast) {
      reason = filter.status
        ? `beyond keep-last ${filter.keepLast} (within ${filter.status})`
        : `beyond keep-last ${filter.keepLast}`;
    }
    if (filter.beforeDate && archivedAt.getTime() < filter.beforeDate.getTime()) {
      reason = reason
        ? `${reason}; older than ${filter.beforeDate.toISOString()}`
        : `older than ${filter.beforeDate.toISOString()}`;
    }

    if (reason) {
      // Use dirSlug — the actual filesystem directory name — so deletion is
      // unambiguous even when two archives share `archived_at`.
      candidates.push({ slug: entry.dirSlug, archivedAt, meta: entry.meta, reason });
    }
  }

  if (opts.dryRun) {
    return { candidates, deleted: [] };
  }

  const deleted: string[] = [];
  for (const cand of candidates) {
    const dirPath = getArchivePath(projectDir, cand.slug);
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      deleted.push(cand.slug);
    } catch (err) {
      process.stderr.write(`[archiver] failed to prune ${cand.slug}: ${String(err)}\n`);
    }
  }

  return { candidates, deleted };
}

# Spec: Auto-Archival of Conductor Run Artifacts

**Target version:** v0.8.0
**Status:** Ready for implementation
**Motivation:** Today's session hit a real friction point — stale `state.json` and task files from a completed v0.5.0 run polluted the `.conductor/` directory, forcing manual cleanup before a new audit run could start. Historical run artifacts are also valuable (past plans, decisions, audit reports) and shouldn't be silently overwritten.

---

## User Experience

### The common case (auto-archive, zero friction)

```
$ conduct start "add user auth" --project .
[conduct] Detected prior run 'audit-v0-7-1' (completed). Archiving to .conductor/archive/audit-v0-7-1-20260418-051800/...
[conduct] Starting fresh run 'add-user-auth'...
```

### Inspecting history

```
$ conduct archive list
SLUG                                  DATE               STATUS     CYCLES  TASKS
audit-v0-7-1-20260418-051800          2026-04-18 05:18   completed  1/1     22 done
fix-lock-race-20260412-143022         2026-04-12 14:30   completed  2/5     8 done
failed-deploy-FAILED-20260410-091500  2026-04-10 09:15   failed     3/5     5 done, 1 failed

$ conduct archive inspect audit-v0-7-1-20260418-051800
============================================================
  ARCHIVED RUN: audit-v0-7-1-20260418-051800
  (read-only view)
============================================================
  Status:       COMPLETED
  Feature:      Read-only audit of Conductor v0.7.1...
  Cycles:       1/1
  [... same fields as `conduct status` ...]
```

### Cleanup

```
$ conduct archive prune --keep-last 10 --dry-run
Would delete 3 archives (keeping 10 most recent):
  - old-feature-20260101-120000 (118 days ago)
  - experiment-20260115-080000 (104 days ago)
  - test-run-20260120-153000 (99 days ago)
Re-run without --dry-run to delete.
```

---

## Data Model

### Directory layout after archival

```
.conductor/
├── flow-config.json              # stays (persistent config)
├── rules.md                      # stays
├── models.json                   # stays
├── design-spec.json              # stays (if exists)
├── project-profile.json          # stays
├── recommended-configs/          # stays
│
├── archive/                      # NEW
│   ├── audit-v0-7-1-20260418-051800/
│   │   ├── state.json
│   │   ├── context.md
│   │   ├── tasks/
│   │   ├── messages/
│   │   ├── sessions/
│   │   ├── contracts/
│   │   ├── codex-reviews/
│   │   ├── flow-tracing/
│   │   ├── logs/
│   │   ├── decisions.jsonl
│   │   ├── events.jsonl
│   │   ├── progress.jsonl
│   │   ├── known-issues.json
│   │   ├── tasks-draft.json
│   │   ├── plan-v1.md
│   │   ├── escalation.json       # if present
│   │   └── _archive-meta.json    # NEW — see below
│   └── fix-lock-race-FAILED-20260418-093000/
│       └── ...
│
└── # (empty after archival — ready for fresh run)
```

### Files that MOVE to archive

```
state.json
context.md
tasks/           (directory)
messages/        (directory)
sessions/        (directory)
contracts/       (directory)
codex-reviews/   (directory)
flow-tracing/    (directory)
logs/            (directory)
decisions.jsonl
events.jsonl
progress.jsonl
known-issues.json
tasks-draft.json
plan-v*.md       (all versions)
escalation.json  (if present)
status.json      (if present at root — legacy SESSION_STATUS_FILE path; the per-session status.json under sessions/<id>/ goes with sessions/)
resume-info.json (if present)
result.json      (if present)
```

### Files that STAY at `.conductor/` root

```
flow-config.json
rules.md
worker-rules.md         (legacy, if present)
models.json
design-spec.json
project-profile.json
conventions.json
recommended-configs/    (directory)
```

### Files that are DELETED (not archived)

```
conductor.lock
conductor.lock.info
pause.signal            (if present — transient)
```

### `_archive-meta.json` (new file, written at archive time)

```json
{
  "archive_version": 1,
  "archived_at": "2026-04-18T05:18:00.000Z",
  "archived_by": "auto-on-completion" | "auto-on-failure" | "auto-stale-on-start" | "manual",
  "original_slug": "audit-v0-7-1",
  "final_status": "completed" | "failed",
  "summary": {
    "cycles_run": 1,
    "max_cycles": 1,
    "tasks_completed": 22,
    "tasks_failed": 0,
    "feature": "Read-only audit of Conductor v0.7.1...",
    "branch": "conduct/audit-v0-7-1",
    "started_at": "2026-04-18T05:15:00.000Z",
    "completed_at": "2026-04-18T05:18:00.000Z"
  },
  "conductor_version": "0.8.0"
}
```

Rationale: `conduct archive list` reads this file per-archive to render the table without re-parsing `state.json`. Also serves as a drift guard — if `_archive-meta.json` is missing, the directory may be a partial archive (from a crash mid-move) and should be treated cautiously.

---

## Trigger Matrix

| Condition | Behavior | Archive slug pattern |
|---|---|---|
| Run completes normally (status → `completed`) | Auto-archive after final state write. Log the path. | `<branch-slug>-<YYYYMMDD-HHMMSS>` |
| Run fails (status → `failed`) | Auto-archive with `-FAILED` marker. User locates via `conduct archive list`. | `<branch-slug>-FAILED-<YYYYMMDD-HHMMSS>` |
| Run is paused (status → `paused`) | **NEVER archive.** Resumable. | — |
| Run is escalated (status → `escalated`) | **NEVER archive.** Resumable. | — |
| `conduct start` detects stale `completed` / `failed` state | Auto-archive old run, then start fresh. Print one-line notice. | `<old-branch-slug>-<YYYYMMDD-HHMMSS>` (plus `-FAILED` if applicable) |
| `conduct start` detects stale `paused` / `escalated` state | Refuse to start — tell user to `conduct resume` or `conduct archive --force`. | — |
| `conduct archive` (no args), run in terminal state | Archive manually. Useful for failed runs the user wants to archive after inspection. | `<branch-slug>[-FAILED]-<YYYYMMDD-HHMMSS>` |
| `conduct archive` (no args), run active/paused/escalated | Error: "Run is active. Use `conduct stop` first." | — |
| Crash mid-archive | `.in-progress` marker in archive dir. Next `conduct start` detects + finishes the move. | — |

### Slug derivation algorithm

```
1. Start with state.json `branch` field (e.g. "conduct/audit-v0-7-1")
2. Strip "conduct/" prefix → "audit-v0-7-1"
3. If branch missing or equals "main", fallback: slugify(state.json `feature` field, max 40 chars)
4. If feature also missing, fallback: "run"
5. Append "-FAILED" if state.status === "failed"
6. Append "-YYYYMMDD-HHMMSS" (UTC) based on archival time
7. If (somehow) the resulting path exists, append "-2", "-3", ... until free
```

Max total slug length: 80 chars (filesystem-safe across FAT/exFAT/APFS/ext4).

---

## CLI Surface

### `conduct archive` (new subcommand group)

#### `conduct archive` / `conduct archive now` (no args)
Manually archive the current terminal run. Refuses if run is active or resumable.

**Flags:**
- `--force` — archive even if state is `paused`/`escalated`. Destructive; warns and requires `--yes`.
- `--yes` — skip confirmation (for scripts).
- `--slug <name>` — override auto-derived slug. Still gets the timestamp suffix.

**Exit codes:**
- 0 on success
- 1 if run is active (workers running)
- 2 if run is resumable and `--force` not set

#### `conduct archive list`
Table view. Columns: SLUG, DATE, STATUS, CYCLES, TASKS, FEATURE (truncated).

**Flags:**
- `--json` — machine-readable output (reads `_archive-meta.json` from each archive)
- `--status <completed|failed>` — filter
- `--since <date>` — ISO date or relative (e.g. `7d`)

#### `conduct archive inspect <slug>`
Read-only equivalent of `conduct status`, pointed at an archived run.

**Flags:**
- `--tasks` — include per-task detail
- `--json` — machine-readable

#### `conduct archive prune`
Delete archives matching filters.

**Flags (at least one required):**
- `--before <date>` — delete archives older than this
- `--keep-last <N>` — keep the N most recent, delete rest
- `--status <failed>` — narrow to a specific status
- `--dry-run` — preview only, no deletion
- `--yes` — skip confirmation prompt

Defaults: neither flag set → error with usage hint. Interactive confirmation always shown unless `--yes` or `--dry-run`.

---

## Implementation Plan

### New files

- `src/core/archiver.ts` — core archival logic. Exports:
  - `archiveCurrentRun(projectDir, opts): Promise<ArchiveResult>` — the main entry
  - `listArchives(projectDir): Promise<ArchiveMeta[]>`
  - `readArchive(projectDir, slug): Promise<ArchiveMeta>`
  - `pruneArchives(projectDir, filter): Promise<PruneResult>`
  - `detectStaleTerminalState(projectDir): Promise<{stale: boolean, status, slug?}>`
  - `finalizePartialArchive(projectDir): Promise<void>` — recover from mid-archive crash
- `src/core/archiver.test.ts` — unit tests (see Testing section)
- `src/utils/types.ts` additions:
  - `ArchiveMeta` interface (mirrors `_archive-meta.json`)
  - `ArchivedBy = "auto-on-completion" | "auto-on-failure" | "auto-stale-on-start" | "manual"`

### Modified files

- `src/cli.ts`:
  - New `archive` subcommand group via Commander's `.command("archive")` with `.command("list")`, `.command("inspect <slug>")`, `.command("prune")`, and a default action for `conduct archive`
  - `start` command: call `detectStaleTerminalState` → `archiveCurrentRun` before `acquireProcessLock`
- `src/core/orchestrator.ts`:
  - On terminal status write (`completed` or `failed`), call `archiveCurrentRun` as the last step before returning from `run()`. Wrap in try/catch — archival failure must not propagate as run failure.
- `src/utils/constants.ts`:
  - `ARCHIVE_DIR = "archive"`
  - `ARCHIVE_META_FILE = "_archive-meta.json"`
  - `ARCHIVE_IN_PROGRESS_MARKER = ".archive-in-progress"`
  - `getArchiveDir(projectDir)`, `getArchivePath(projectDir, slug)`, `getArchiveMetaPath(projectDir, slug)` helpers
  - `FILES_TO_ARCHIVE: string[]` — exhaustive list per this spec
  - `FILES_TO_KEEP_AT_ROOT: string[]` — stays-in-place list
  - `FILES_TO_DELETE_ON_ARCHIVE: string[]` — locks, pause signals

### Algorithm details

#### `archiveCurrentRun`

```ts
async function archiveCurrentRun(projectDir, opts): Promise<ArchiveResult> {
  const conductorDir = getOrchestratorDir(projectDir);

  // 1. Read state.json to get branch + status + summary (for meta)
  const state = await readStateOrThrow(conductorDir);

  // 2. Verify run is in an archivable state
  if (!opts.force && (state.status === "paused" || state.status === "escalated")) {
    throw new Error(`Run is ${state.status} — use conduct resume, or --force to archive anyway`);
  }

  // 3. Derive slug (see algorithm above)
  const slug = deriveSlug(state, opts.slug);
  const archivePath = path.join(conductorDir, ARCHIVE_DIR, slug);

  // 4. Create archive dir + write in-progress marker
  await fs.mkdir(archivePath, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(archivePath, ARCHIVE_IN_PROGRESS_MARKER), "");

  // 5. Move each FILES_TO_ARCHIVE entry (skip if missing)
  for (const relPath of FILES_TO_ARCHIVE) {
    const src = path.join(conductorDir, relPath);
    const dst = path.join(archivePath, relPath);
    if (await exists(src)) {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst); // atomic same-fs; cross-fs fallback handled below
    }
  }

  // 6. Delete FILES_TO_DELETE_ON_ARCHIVE (locks etc.)
  for (const relPath of FILES_TO_DELETE_ON_ARCHIVE) {
    await fs.rm(path.join(conductorDir, relPath), { force: true });
  }

  // 7. Write _archive-meta.json
  const meta: ArchiveMeta = { ... };
  await writeFileSecure(getArchiveMetaPath(projectDir, slug), JSON.stringify(meta, null, 2));

  // 8. Remove in-progress marker — archive is now durable
  await fs.unlink(path.join(archivePath, ARCHIVE_IN_PROGRESS_MARKER));

  return { archivePath, slug, meta };
}
```

Cross-filesystem fallback: if `fs.rename` throws EXDEV, fall back to `fs.cp(..., {recursive: true})` + `fs.rm(src, {recursive: true, force: true})`. Acceptable because `.conductor/` is almost always on the same filesystem as the project.

#### `detectStaleTerminalState`

Called at `conduct start` after `acquireProcessLock`:

```ts
async function detectStaleTerminalState(projectDir) {
  const statePath = getStatePath(projectDir);
  if (!await exists(statePath)) return { stale: false };

  const state = await readStateOrNull(statePath);
  if (!state) return { stale: false };

  if (state.status === "completed" || state.status === "failed") {
    return { stale: true, status: state.status, slug: deriveSlug(state) };
  }

  return { stale: false };
}
```

#### `finalizePartialArchive`

Called at `conduct start` before `detectStaleTerminalState`:

```ts
async function finalizePartialArchive(projectDir) {
  const archiveDir = getArchiveDir(projectDir);
  if (!await exists(archiveDir)) return;

  const entries = await fs.readdir(archiveDir);
  for (const entry of entries) {
    const entryPath = path.join(archiveDir, entry);
    const markerPath = path.join(entryPath, ARCHIVE_IN_PROGRESS_MARKER);
    if (await exists(markerPath)) {
      logger.warn(`Recovering partial archive: ${entry}`);
      // If meta exists, archive was mostly done — just remove marker
      // If meta missing, treat as corrupt: rename to `<slug>-PARTIAL` and continue
      const metaPath = path.join(entryPath, ARCHIVE_META_FILE);
      if (await exists(metaPath)) {
        await fs.unlink(markerPath);
      } else {
        await fs.rename(entryPath, entryPath + "-PARTIAL");
      }
    }
  }
}
```

---

## Edge Cases

| Case | Handling |
|---|---|
| `.conductor/archive/` doesn't exist | Created with `mode: 0o700` on first archive |
| Slug collision (same branch archived twice in the same second) | Append `-2`, `-3` to slug; timestamp granularity is seconds so collisions are rare but possible |
| `state.json` missing but other run files present | Fall back: use feature from `context.md` if available, else slug = `orphan-run-<ts>`, status = "unknown" |
| Disk full mid-archive | `.archive-in-progress` marker remains; next start detects and routes to `finalizePartialArchive`. User sees a warning; archive is moved to `<slug>-PARTIAL` for manual inspection. |
| User has edited an archive manually | Treated as read-only; `inspect` tolerates missing fields with sensible defaults |
| Symlinks inside `.conductor/` | Archiver follows symlinks using `fs.cp` fallback, never moves the target (only the link itself). Rare but possible with external log aggregators. |
| Archive dir name matches an existing CLI reserved name | Archive dir is always inside `.conductor/archive/` — no conflict possible with root CLI subcommands |
| Concurrent `conduct start` races | Process lock (existing CLI_LOCK_FILE) prevents two starts. Lock is acquired BEFORE stale-state detection, so only one archival runs at a time. |
| User passes `--current-branch` to `conduct start` | Branch slug falls back to `feature` slugified since no `conduct/*` branch exists |
| Very long feature descriptions | Slug truncated to 40 chars during slugify step before the timestamp is appended |

---

## Acceptance Criteria

1. After a `conduct start` run completes normally, `.conductor/` contains only persistent config files; `.conductor/archive/<slug>-<ts>/` contains a valid run archive with `_archive-meta.json`.
2. After a `conduct start` run fails, `.conductor/archive/<slug>-FAILED-<ts>/` exists with `_archive-meta.json.final_status === "failed"`; `.conductor/` root is cleaned.
3. `conduct start` invoked against a `.conductor/` with a prior `completed` or `failed` state auto-archives the prior run and proceeds to plan phase. The stale state must not influence the new run's planning.
4. `conduct start` invoked against a `paused` / `escalated` state errors out with a clear message; nothing is archived.
5. `conduct archive list` prints a table sorted by date-descending. JSON output (`--json`) returns an array of `ArchiveMeta`.
6. `conduct archive inspect <slug>` prints a status-style summary from `_archive-meta.json` without reading any files in the archive directory (for performance — list shouldn't need directory traversal).
7. `conduct archive prune --keep-last 0 --dry-run` lists all archives without deleting any. `--keep-last 0 --yes` deletes all.
8. A crash mid-archive (simulated by killing the process after the in-progress marker is written but before `_archive-meta.json`) is recovered on next `conduct start`: the partial archive is renamed to `<slug>-PARTIAL` and a warning is logged; the new run starts cleanly.
9. All archived files have the same permissions (`0o600` for files, `0o700` for directories) as their source — archival preserves the security posture.
10. `conduct resume` never triggers archival (run is still in progress from its perspective).

---

## Testing Strategy

### Unit tests (`src/core/archiver.test.ts`)

- `deriveSlug`: branch present / missing / "main" / malformed / very long feature; status `failed` adds `-FAILED`; collision suffix increments correctly.
- `archiveCurrentRun`: happy path (all directories + files present) leaves `.conductor/` in expected state. Asserts every entry in `FILES_TO_ARCHIVE` that exists is moved; every entry in `FILES_TO_KEEP_AT_ROOT` is untouched; every entry in `FILES_TO_DELETE_ON_ARCHIVE` is gone.
- `archiveCurrentRun` with missing state.json throws.
- `archiveCurrentRun` with `status: paused` throws unless `--force`.
- `detectStaleTerminalState`: returns correct status for each terminal + non-terminal state; returns `{stale: false}` when state.json is missing.
- `finalizePartialArchive`: in-progress marker + meta = unlink marker; in-progress marker + no meta = rename to `-PARTIAL`.
- Cross-fs fallback path (mock `fs.rename` to throw EXDEV, assert `fs.cp` is called).
- Permissions preserved on archived files (use `fs.stat` to assert mode bits).
- `pruneArchives`: `--keep-last N` sorts by date and keeps correct set; `--before <date>` filters correctly; `--status failed` narrows correctly; dry-run returns list without deleting.

### Integration tests (`src/cli.test.ts` additions)

- `conduct archive` with no args on an active run exits with code 1.
- `conduct archive list --json` on empty archive returns `[]`.
- `conduct archive inspect nonexistent-slug` exits with a "not found" error.
- `conduct start` after a simulated completed run auto-archives then proceeds.

### Manual smoke

1. Run a dry-run feature (`conduct start "smoke" --dry-run`), let it complete.
2. Verify `.conductor/archive/smoke-<ts>/_archive-meta.json` exists and is well-formed.
3. Run `conduct start "smoke2" --dry-run` — verify it auto-archives smoke AND proceeds.
4. Run `conduct archive list` — should show both.
5. Run `conduct archive prune --keep-last 1 --yes` — verify only most recent remains.

---

## Handoff Notes

### Implementation order

1. **Types + constants** (`types.ts`, `constants.ts`) — no runtime behavior changes yet, just shared definitions. Build passes.
2. **Core archiver** (`src/core/archiver.ts`) + unit tests. All tests green before wiring into CLI.
3. **CLI subcommand** (`src/cli.ts` — the `archive` group). Start with `list` and `inspect` (read-only — safest), then `archive` and `prune`.
4. **Stale-state auto-archival** in `conduct start` (highest-risk change — touches the lock-acquisition path).
5. **Orchestrator post-run archival** in `orchestrator.ts` (wrapped in try/catch — must never fail the actual run).
6. **Integration tests** against the new behavior end-to-end.
7. **Version bump** `0.7.1 → 0.8.0` (this is a user-visible feature adding a new subcommand group).
8. **Slash command update** (`commands/conduct.md`) — mention that stale runs auto-archive, mention `conduct archive list` for history.
9. **CHANGELOG** / commit message explaining the migration path for existing users (their next `conduct start` will auto-archive whatever's sitting in `.conductor/`).

### Parallelizable for C3

- Type + constants changes + archiver core + archiver unit tests → single `general` task
- CLI `archive list` + `inspect` subcommands → single `backend_api` task (independent read path)
- CLI `archive` (manual archive) + `archive prune` subcommands → single `backend_api` task (depends on archiver core)
- `conduct start` auto-archival wiring → single `backend_api` task (depends on archiver core)
- Orchestrator post-run archival → single `backend_api` task (depends on archiver core)
- Integration tests → single `testing` task (depends on all above)

Good C3 candidate — 5-6 discrete tasks with clear dependency graph (archiver core is the one anchor task).

### Out of scope for v0.8.0

- **Compression (tar.gz)**: Not needed. Individual archives are typically < 10 MB. Add later if disk becomes a concern.
- **Remote archive (S3/bucket upload)**: Too much scope. v0.8.0 is local-only.
- **Archive encryption**: Archives inherit `.conductor/` permissions (0o700 dir, 0o600 files) which is secure enough for local use.
- **Archive diff tool** (`conduct archive diff <slug-a> <slug-b>`): Nice idea, defer.
- **Automatic retention policy config** in `models.json` or similar: keep manual for now. If users ask for it, add `.conductor/config.json` with an `archive.retention` section.
- **Replaying an archive** (restoring a completed run into active state): unclear use case, defer.

---

## Summary of decisions baked in

| Decision | Choice |
|---|---|
| Failed runs | Auto-archive with `-FAILED` marker suffix |
| Stale terminal state on `conduct start` | Auto-archive + start fresh |
| Slug format | `<branch-slug>[-FAILED]-<YYYYMMDD-HHMMSS>` (always timestamped) |
| v1 CLI | `archive`, `archive list`, `archive inspect <slug>`, `archive prune` |
| Retention | Keep forever; manual prune only |
| Paused/escalated | Never archived |
| Partial archive recovery | In-progress marker + auto-recover on next start |
| Compression | None (defer) |

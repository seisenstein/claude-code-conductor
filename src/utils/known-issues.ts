import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lock } from "proper-lockfile";
import { getKnownIssuesPath } from "./constants.js";
import { mkdirSecure, writeJsonAtomic, SECURE_FILE_MODE } from "./secure-fs.js";
import type { KnownIssue } from "./types.js";
import type { Logger } from "./logger.js";

/** Lock configuration — matches appendJsonlLocked in secure-fs.ts */
const LOCK_CONFIG = {
  retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
  stale: 5000,
} as const;

/**
 * Load known issues from .conductor/known-issues.json.
 * Returns empty array if file doesn't exist or contains corrupt JSON.
 */
export async function loadKnownIssues(projectDir: string, logger?: Logger): Promise<KnownIssue[]> {
  const issuesPath = getKnownIssuesPath(projectDir);
  const warn = (msg: string) => logger ? logger.warn(msg) : process.stderr.write(msg + "\n");
  try {
    const contents = await fs.readFile(issuesPath, "utf-8");
    const parsed = JSON.parse(contents);
    if (!Array.isArray(parsed)) {
      warn(`[known-issues] Expected array in ${issuesPath}, got ${typeof parsed}`);
      return [];
    }
    return parsed as KnownIssue[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    // Log SyntaxError and other errors but don't crash
    warn(
      `[known-issues] Error loading ${issuesPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Save known issues to .conductor/known-issues.json with secure permissions.
 */
export async function saveKnownIssues(projectDir: string, issues: KnownIssue[]): Promise<void> {
  const issuesPath = getKnownIssuesPath(projectDir);
  await mkdirSecure(path.dirname(issuesPath), { recursive: true }); // H-2
  // A-1: writeJsonAtomic provides tmp+fsync+rename + chmod 0o600.
  await writeJsonAtomic(issuesPath, JSON.stringify(issues, null, 2) + "\n");
}

/**
 * Ensure the known-issues file exists for locking.
 * Uses open() with "a" flag: creates if missing, never truncates if present.
 * This avoids a TOCTOU race where concurrent callers both see the file as
 * missing and one truncates the other's data.
 */
async function ensureFileForLock(filePath: string): Promise<void> {
  await mkdirSecure(path.dirname(filePath), { recursive: true }); // H-2
  const fh = await fs.open(filePath, "a", SECURE_FILE_MODE);
  await fh.close();
}

/**
 * Add findings to the known issues registry. Deduplicates by file_path + description prefix.
 * Uses file locking to prevent data loss from concurrent writes (H34 fix).
 * Returns the updated list.
 */
export async function addKnownIssues(
  projectDir: string,
  newIssues: Omit<KnownIssue, "id" | "addressed" | "addressed_in_cycle">[],
  logger?: Logger,
): Promise<KnownIssue[]> {
  const issuesPath = getKnownIssuesPath(projectDir);

  // Ensure file exists before locking (proper-lockfile requires it)
  await ensureFileForLock(issuesPath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(issuesPath, LOCK_CONFIG);

    // Read under lock to avoid TOCTOU
    const existing = await loadKnownIssues(projectDir, logger);

    // Build a set of dedup keys from existing issues
    const dedupKeys = new Set(
      existing.map((issue) => buildDedupKey(issue.file_path, issue.description)),
    );

    const toAdd: KnownIssue[] = [];
    for (const newIssue of newIssues) {
      const key = buildDedupKey(newIssue.file_path, newIssue.description);
      if (!dedupKeys.has(key)) {
        dedupKeys.add(key);
        toAdd.push({
          ...newIssue,
          id: randomUUID(),
          addressed: false,
          addressed_in_cycle: undefined,
        });
      }
    }

    const updated = [...existing, ...toAdd];
    await saveKnownIssues(projectDir, updated);
    return updated;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock may already be released
      }
    }
  }
}

/**
 * Mark issues as addressed in a given cycle.
 * Uses file locking to prevent data loss from concurrent writes (H34 fix).
 */
export async function markIssuesAddressed(
  projectDir: string,
  issueIds: string[],
  cycle: number,
  logger?: Logger,
): Promise<void> {
  const issuesPath = getKnownIssuesPath(projectDir);

  // Ensure file exists before locking (proper-lockfile requires it)
  await ensureFileForLock(issuesPath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(issuesPath, LOCK_CONFIG);

    // Read under lock to avoid TOCTOU
    const issues = await loadKnownIssues(projectDir, logger);
    const idSet = new Set(issueIds);

    for (const issue of issues) {
      if (idSet.has(issue.id)) {
        issue.addressed = true;
        issue.addressed_in_cycle = cycle;
      }
    }

    await saveKnownIssues(projectDir, issues);
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock may already be released
      }
    }
  }
}

/**
 * Get only unresolved issues.
 */
export async function getUnresolvedIssues(projectDir: string, logger?: Logger): Promise<KnownIssue[]> {
  const issues = await loadKnownIssues(projectDir, logger);
  return issues.filter((issue) => !issue.addressed);
}

/**
 * Build a deduplication key from file_path and the first 80 characters of the description.
 */
function buildDedupKey(filePath: string | undefined, description: string): string {
  const prefix = description.slice(0, 80).toLowerCase().trim();
  return `${filePath ?? ""}::${prefix}`;
}

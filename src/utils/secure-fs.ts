/**
 * Secure file system utilities.
 *
 * These helpers ensure that sensitive files written by the conductor
 * have owner-only permissions (0o600 for files, 0o700 for directories),
 * even when overwriting existing files with different permissions.
 *
 * IMPORTANT: Node's fs.writeFile({ mode }) only applies permissions on
 * file creation. For existing files, the mode is ignored. These utilities
 * call chmod() after writing to guarantee correct permissions.
 *
 * @see https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options
 * "The mode option only affects the newly created file."
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import { lock } from "proper-lockfile";

/**
 * Default secure file mode: owner read/write only (0o600).
 */
export const SECURE_FILE_MODE = 0o600;

/**
 * Default secure directory mode: owner read/write/execute only (0o700).
 */
export const SECURE_DIR_MODE = 0o700;

/**
 * Write a file with secure permissions (0o600).
 *
 * Unlike fs.writeFile with { mode }, this function guarantees the file
 * has the specified permissions even if it already exists with different
 * permissions.
 *
 * @param filePath - Absolute path to the file
 * @param data - Content to write (string or Buffer)
 * @param options - Optional encoding (defaults to utf-8) and mode (defaults to 0o600)
 */
export async function writeFileSecure(
  filePath: string,
  data: string | Buffer,
  options?: { encoding?: BufferEncoding; mode?: number },
): Promise<void> {
  const encoding = options?.encoding ?? "utf-8";
  const mode = options?.mode ?? SECURE_FILE_MODE;

  // Write the file (mode here only affects new files, not existing ones)
  await fs.writeFile(filePath, data, { encoding, mode });

  // Explicitly chmod to enforce permissions on existing files too
  await fs.chmod(filePath, mode);
}

/**
 * Create a directory with secure permissions (0o700).
 *
 * Unlike fs.mkdir with { mode }, this function guarantees the directory
 * has the specified permissions even if it already exists with different
 * permissions. For recursive creation, chmods only the final target directory.
 *
 * @param dirPath - Absolute path to the directory
 * @param options - Optional recursive flag and mode
 */
export async function mkdirSecure(
  dirPath: string,
  options?: { recursive?: boolean; mode?: number },
): Promise<void> {
  const recursive = options?.recursive ?? false;
  const mode = options?.mode ?? SECURE_DIR_MODE;

  // Create the directory (mode may not apply to existing directories,
  // and is filtered by umask even for new ones — defeated by the chmod below)
  await fs.mkdir(dirPath, { recursive, mode });

  // Explicitly chmod the target directory to enforce permissions
  // For recursive creates, we only chmod the final target - parent dirs
  // may have broader permissions intentionally
  try {
    await fs.chmod(dirPath, mode);
  } catch {
    // If chmod fails (e.g., we don't own the directory), ignore
    // This can happen with system directories in the path
  }
}

/**
 * Synchronous variant of mkdirSecure for init paths that cannot await
 * (currently: Logger constructor, setup.ts).
 *
 * Same semantics: fs.mkdir with mode is filtered by umask, so chmodSync
 * after creation guarantees the final directory has the requested mode.
 */
export function mkdirSecureSync(
  dirPath: string,
  options?: { recursive?: boolean; mode?: number },
): void {
  const recursive = options?.recursive ?? false;
  const mode = options?.mode ?? SECURE_DIR_MODE;
  fsSync.mkdirSync(dirPath, { recursive, mode });
  try {
    fsSync.chmodSync(dirPath, mode);
  } catch {
    // ignore — may not own dir
  }
}

/**
 * Append to a file with secure permissions.
 *
 * Creates the file with secure permissions if it doesn't exist,
 * or appends to existing file and ensures permissions are correct.
 *
 * @param filePath - Absolute path to the file
 * @param data - Content to append
 * @param options - Optional encoding and mode
 */
export async function appendFileSecure(
  filePath: string,
  data: string | Buffer,
  options?: { encoding?: BufferEncoding; mode?: number },
): Promise<void> {
  const encoding = options?.encoding ?? "utf-8";
  const mode = options?.mode ?? SECURE_FILE_MODE;

  // Append to the file (mode only affects if file is created)
  await fs.appendFile(filePath, data, { encoding, mode });

  // Explicitly chmod to enforce permissions on existing files
  await fs.chmod(filePath, mode);
}

/**
 * Ensure permissions are correct on an existing file.
 *
 * Call this after any fs.writeFile with mode to fix permissions
 * on files that already existed.
 *
 * @param filePath - Absolute path to the file
 * @param mode - Permission mode (defaults to 0o600)
 */
export async function chmodSecure(
  filePath: string,
  mode: number = SECURE_FILE_MODE,
): Promise<void> {
  await fs.chmod(filePath, mode);
}

/**
 * Append a JSON line to a JSONL file with file locking.
 *
 * Uses proper-lockfile to serialize concurrent appends from multiple
 * workers, preventing interleaved/corrupted writes (#17).
 *
 * Creates the file with secure permissions if it doesn't exist.
 *
 * @param filePath - Absolute path to the JSONL file
 * @param data - Object to serialize as a single JSON line
 */
export async function appendJsonlLocked(filePath: string, data: unknown): Promise<void> {
  // Ensure file exists before locking (proper-lockfile requires it).
  // Use open() with "a" flag: creates if missing, never truncates if present.
  // This avoids a race where concurrent callers both see the file as missing
  // and one truncates the other's data via writeFile("").
  const fh = await fs.open(filePath, "a", SECURE_FILE_MODE);
  await fh.close();

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(filePath, {
      retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
      stale: 5000,
    });
    await fs.appendFile(filePath, JSON.stringify(data) + "\n", { encoding: "utf-8", mode: SECURE_FILE_MODE });
    // Enforce secure permissions on existing files (appendFile mode only
    // applies at creation time, not on pre-existing files).
    await fs.chmod(filePath, SECURE_FILE_MODE);
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
 * H-14: Atomically write content to `destPath` via tmp + fsync + rename.
 *
 * Writes to `destPath + ".tmp"`, fsyncs the file, then renames. Rename is
 * atomic on POSIX within a filesystem. On power-loss, either the old file
 * is intact or the new file is intact — never a torn write.
 *
 * `options.fsync: false` skips the durability flush. Rarely correct; allowed
 * for non-critical files where the perf win matters and durability doesn't.
 */
export async function writeJsonAtomic(
  destPath: string,
  content: string,
  options?: { mode?: number; fsync?: boolean },
): Promise<void> {
  const mode = options?.mode ?? SECURE_FILE_MODE;
  const wantFsync = options?.fsync !== false;
  const tmpPath = destPath + ".tmp";
  let renamed = false;
  try {
    const fh = await fs.open(tmpPath, "w", mode);
    try {
      await fh.writeFile(content, { encoding: "utf-8" });
      if (wantFsync) await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmpPath, destPath);
    renamed = true;
    // Enforce secure permissions if the destination already existed with looser
    // perms (fs.open's mode only applies on creation).
    try {
      await fs.chmod(destPath, mode);
    } catch {
      // Non-fatal — rename succeeded, file exists at destPath; chmod failure
      // is typically a permissions issue not worth failing the write over.
    }
  } finally {
    // A-R2-prereq (v0.7.5): clean up the tmp file if we never successfully
    // renamed it. A successful rename consumes tmp (POSIX atomic rename), so
    // skip in that case. On failure the tmp might exist (write/sync/close
    // succeeded but rename failed) or not (fs.open itself failed); either way,
    // swallow the unlink error — there's nothing useful to do with it and the
    // caller's original error is more informative.
    if (!renamed) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // tmp might not exist; ignore
      }
    }
  }
}

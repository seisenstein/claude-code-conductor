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
import path from "node:path";

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

  // Create the directory (mode may not apply to existing directories)
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

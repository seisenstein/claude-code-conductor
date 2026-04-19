/**
 * Validation utilities for input sanitization and bounds checking.
 *
 * These functions are designed to prevent path traversal attacks and
 * validate user input before processing.
 */

/**
 * Result of a filename validation check.
 */
export interface FileNameValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a filename or relative path to prevent path traversal attacks.
 *
 * Despite its name, this function validates both single filenames and relative
 * paths containing forward slashes (e.g., "src/utils/file.ts"). Forward slashes
 * are intentionally allowed because this function is used to validate:
 * - `files_changed` entries (relative paths from project root)
 * - Other user-provided path references
 *
 * For task_id validation specifically, the calling code in tools.ts additionally
 * rejects forward slashes to ensure task IDs are simple identifiers, not paths.
 *
 * Rejects:
 * - Path traversal sequences: "..", "./"
 * - Absolute paths (starting with "/" or Windows drive letters)
 * - Backslashes (Windows path separators)
 * - URL-encoded variants of the above
 * - Null bytes and other control characters
 *
 * @param filename - The filename or relative path to validate
 * @returns Validation result with reason if invalid
 */
export function validateFileName(filename: string): FileNameValidationResult {
  // Empty filenames are invalid
  if (!filename || filename.trim().length === 0) {
    return { valid: false, reason: "Filename cannot be empty" };
  }

  // Check for null bytes (could bypass security checks)
  if (filename.includes("\0")) {
    return { valid: false, reason: "Filename contains null byte" };
  }

  // Check for control characters (ASCII 0-31 except for common whitespace)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(filename)) {
    return { valid: false, reason: "Filename contains control characters" };
  }

  // Decode URL-encoded characters for detection
  let decoded = filename;
  try {
    // Decode multiple times to catch double/triple encoding
    for (let i = 0; i < 3; i++) {
      const newDecoded = decodeURIComponent(decoded);
      if (newDecoded === decoded) break;
      decoded = newDecoded;
    }
  } catch {
    // If decoding fails, continue with original
    decoded = filename;
  }

  // Check both raw and decoded versions
  const toCheck = [filename, decoded];

  for (const str of toCheck) {
    // Path traversal: parent directory reference
    if (str.includes("..")) {
      return { valid: false, reason: "Path traversal detected: contains '..'" };
    }

    // Backslash (Windows path separator)
    if (str.includes("\\")) {
      return { valid: false, reason: "Invalid path: contains backslash" };
    }

    // Absolute Unix path
    if (str.startsWith("/")) {
      return { valid: false, reason: "Absolute paths not allowed: starts with '/'" };
    }

    // Windows absolute path (C:, D:, etc.)
    if (/^[a-zA-Z]:/.test(str)) {
      return { valid: false, reason: "Absolute paths not allowed: Windows drive letter" };
    }

    // UNC paths (\\server\share)
    if (str.startsWith("\\\\") || str.startsWith("//")) {
      return { valid: false, reason: "UNC paths not allowed" };
    }
  }

  return { valid: true };
}

/**
 * Validates that a value is within the specified bounds (inclusive).
 *
 * @param name - Human-readable name of the parameter (for error messages)
 * @param value - The value to validate
 * @param min - Minimum allowed value (inclusive)
 * @param max - Maximum allowed value (inclusive)
 * @throws Error with descriptive message if value is out of bounds
 */
export function validateBounds(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (typeof value !== "number" || isNaN(value)) {
    throw new Error(`${name} must be a number, got: ${typeof value}`);
  }

  if (!isFinite(value)) {
    throw new Error(`${name} must be a finite number, got: ${value}`);
  }

  if (value < min) {
    throw new Error(
      `${name} must be at least ${min}, got: ${value}`,
    );
  }

  if (value > max) {
    throw new Error(
      `${name} must be at most ${max}, got: ${value}`,
    );
  }
}

/**
 * Convenience function that throws if filename validation fails.
 *
 * @param filename - The filename to validate
 * @throws Error with descriptive message if validation fails
 */
export function assertValidFileName(filename: string): void {
  const result = validateFileName(filename);
  if (!result.valid) {
    throw new Error(`Invalid filename: ${result.reason}`);
  }
}

/**
 * Validates an identifier that becomes part of a filesystem path (task_id,
 * session_id, contract_id, dependency task_id). Stricter than validateFileName:
 * rejects all path separators to ensure the resulting path does not traverse.
 *
 * NOT for: files_changed (intentional relative paths); any free-form
 * content field.
 */
export function validateIdentifier(id: string): FileNameValidationResult {
  const base = validateFileName(id);
  if (!base.valid) return base;
  // Codex code-review round 1 [SUGGESTION]: also check URL-decoded form so
  // that %2F / %5C / %3A don't bypass the separator check. validateFileName
  // decodes for its own traversal check but permits slashes at the string
  // level; we must explicitly decode-then-check for identifiers.
  let decoded = id;
  try {
    // Decode up to 3 times to catch double/triple encoding, matching the
    // pattern used in validateFileName for its traversal checks.
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    // Malformed URL encoding — validateFileName would have caught this,
    // but fall through defensively.
  }
  if (
    id.includes("/") || id.includes("\\") || id.includes(":") ||
    decoded.includes("/") || decoded.includes("\\") || decoded.includes(":")
  ) {
    return {
      valid: false,
      reason: "Identifier cannot contain path separators (/, \\, :), including URL-encoded forms",
    };
  }
  return { valid: true };
}

/**
 * Validates multiple filenames and returns all validation failures.
 *
 * @param filenames - Array of filenames to validate
 * @returns Array of validation results with the filename and failure reason
 */
export function validateFileNames(
  filenames: string[],
): Array<{ filename: string; reason: string }> {
  const failures: Array<{ filename: string; reason: string }> = [];

  for (const filename of filenames) {
    const result = validateFileName(filename);
    if (!result.valid && result.reason) {
      failures.push({ filename, reason: result.reason });
    }
  }

  return failures;
}

/**
 * Semgrep Runner Module
 *
 * Provides types and helpers for semgrep integration.
 * The `runSemgrep()` function was removed as dead code (never imported
 * by any production or test module).
 */

import type { SemgrepFinding } from "./types.js";

export interface SemgrepJsonOutput {
  results: SemgrepResult[];
  errors: unknown[];
}

export interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    severity: string;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Map semgrep severity strings to our SemgrepFinding severity enum.
 */
export function mapSeverity(severity: string): SemgrepFinding["severity"] {
  const upper = severity.toUpperCase();
  if (upper === "ERROR") return "ERROR";
  if (upper === "WARNING") return "WARNING";
  return "INFO";
}

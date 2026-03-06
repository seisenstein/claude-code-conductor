import type { WorkerRuntime } from "./types.js";

export interface ProviderRateLimitSignal {
  provider: WorkerRuntime;
  detail: string;
  resetsAt: string | null;
}

const RATE_LIMIT_PATTERNS = [
  /you['‘’]ve hit your limit/i,
  /rate limit exceeded/i,
  /rate[ _-]?limited/i,
  /\b429\b/,
  /too many requests/i,
  /quota exceeded/i,
  /usage limit reached/i,
  /usage limit exceeded/i,
  /credits? exhausted/i,
];

export function coerceLogText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function detectProviderRateLimit(
  provider: WorkerRuntime,
  detail: string,
): ProviderRateLimitSignal | null {
  if (!detail) {
    return null;
  }

  if (!RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(detail))) {
    return null;
  }

  return {
    provider,
    detail,
    resetsAt: extractResetHint(detail),
  };
}

function extractResetHint(detail: string): string | null {
  const isoMatch = detail.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/);
  if (isoMatch) {
    return isoMatch[0];
  }

  return null;
}

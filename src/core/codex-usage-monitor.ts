import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_USAGE_THRESHOLD,
  DEFAULT_CRITICAL_THRESHOLD,
  DEFAULT_USAGE_POLL_INTERVAL_MS,
  RESUME_UTILIZATION_THRESHOLD,
} from "../utils/constants.js";
import type { ProviderUsageMonitor, UsageSnapshot, WorkerRuntime } from "../utils/types.js";
import { parseCodexUsageJsonl, pickPreferredCodexUsage, type CodexUsageReading } from "../utils/codex-usage.js";
import { Logger } from "../utils/logger.js";

const DEFAULT_SNAPSHOT: UsageSnapshot = {
  five_hour: 0,
  seven_day: 0,
  five_hour_resets_at: null,
  seven_day_resets_at: null,
  last_checked: new Date().toISOString(),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CodexUsageMonitor implements ProviderUsageMonitor {
  readonly provider: WorkerRuntime = "codex";

  private threshold: number;
  private criticalThreshold: number;
  private pollIntervalMs: number;
  private intervalHandle: NodeJS.Timeout | null = null;
  private currentUsage: UsageSnapshot;
  private onWarning: (utilization: number) => void;
  private onCritical: (utilization: number, resetsAt: string) => void;
  private logger: Logger;
  private sessionsDir: string;

  constructor(options: {
    threshold?: number;
    criticalThreshold?: number;
    pollIntervalMs?: number;
    onWarning: (utilization: number) => void;
    onCritical: (utilization: number, resetsAt: string) => void;
    logger?: Logger;
    sessionsDir?: string;
  }) {
    this.threshold = options.threshold ?? DEFAULT_USAGE_THRESHOLD;
    this.criticalThreshold = options.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_USAGE_POLL_INTERVAL_MS;
    this.onWarning = options.onWarning;
    this.onCritical = options.onCritical;
    this.currentUsage = { ...DEFAULT_SNAPSHOT };
    this.logger = options.logger ?? new Logger(path.join(os.tmpdir(), "conductor-logs"), "codex-usage-monitor");
    this.sessionsDir = options.sessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
  }

  start(): void {
    if (this.intervalHandle) {
      this.logger.warn("CodexUsageMonitor is already running");
      return;
    }

    // Log configuration at debug level to reduce verbose output (#26e)
    this.logger.debug(
      `Starting Codex usage monitor (poll every ${this.pollIntervalMs / 1000}s, ` +
      `warn at ${(this.threshold * 100).toFixed(0)}%, critical at ${(this.criticalThreshold * 100).toFixed(0)}%)`,
    );

    void this.pollAndNotify();

    // H25: Use self-rescheduling setTimeout instead of setInterval.
    // setInterval can stack callbacks if pollAndNotify() takes longer than the
    // interval, leading to unbounded concurrency. setTimeout re-schedules only
    // after the previous poll completes.
    const schedulePoll = (): void => {
      this.intervalHandle = setTimeout(() => {
        this.pollAndNotify()
          .finally(() => {
            if (this.intervalHandle !== null) {
              schedulePoll();
            }
          });
      }, this.pollIntervalMs);

      this.intervalHandle.unref();
    };

    schedulePoll();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearTimeout(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Codex usage monitor stopped");
    }
  }

  getUsage(): UsageSnapshot {
    return { ...this.currentUsage };
  }

  isWindDownNeeded(): boolean {
    return this.currentUsage.five_hour >= this.threshold;
  }

  isCritical(): boolean {
    return this.currentUsage.five_hour >= this.criticalThreshold;
  }

  getResetTime(): string | null {
    return this.currentUsage.five_hour_resets_at;
  }

  // Codex usage monitor reads local files, not a remote API.
  // It is never "stale" in the way the Usage API monitor can be.
  isDataStale(): boolean {
    return false;
  }

  getConsecutiveFailures(): number {
    return 0;
  }

  getStaleDurationMs(): number {
    return 0;
  }

  // Codex reads local files — rate tracking is not meaningful
  getUsageRatePerMinute(): number | null {
    return null;
  }

  estimateMinutesUntilThreshold(_threshold?: number): number | null {
    return null;
  }

  isThresholdPredicted(): boolean {
    return false;
  }

  getRateSummary(): string {
    return "rate: N/A (codex)";
  }

  async waitForReset(): Promise<void> {
    const resetsAt = this.currentUsage.five_hour_resets_at;

    if (!resetsAt) {
      this.logger.warn("No Codex reset time available; polling once and returning");
      await this.poll();
      return;
    }

    const resetTime = new Date(resetsAt).getTime();
    const now = Date.now();

    if (resetTime > now) {
      const waitMs = resetTime - now;
      const waitMin = Math.ceil(waitMs / 60_000);
      this.logger.info(`Waiting ${waitMin} minute(s) for Codex window to reset at ${resetsAt}`);
      await sleep(waitMs);
    }

    this.logger.info("Codex reset time reached, verifying utilization...");
    let snapshot = await this.poll();

    // Keep waiting in 60s increments if still above the resume threshold.
    // Bounded to MAX_WAIT_ITERATIONS to prevent infinite loops (C-1 fix, ported from UsageMonitor H23).
    const MAX_WAIT_ITERATIONS = 60; // 60 * 60s = 1 hour max wait
    let iterations = 0;
    while (snapshot.five_hour >= RESUME_UTILIZATION_THRESHOLD) {
      if (iterations >= MAX_WAIT_ITERATIONS) {
        this.logger.error(
          `waitForReset exceeded max iterations (${MAX_WAIT_ITERATIONS}). ` +
          `Utilization still at ${(snapshot.five_hour * 100).toFixed(1)}%. Returning to avoid infinite wait.`
        );
        break;
      }
      iterations++;
      this.logger.warn(
        `Codex utilization still at ${(snapshot.five_hour * 100).toFixed(1)}% ` +
        `(need < ${(RESUME_UTILIZATION_THRESHOLD * 100).toFixed(0)}%). Waiting 60s... (attempt ${iterations}/${MAX_WAIT_ITERATIONS})`,
      );
      await sleep(60_000);
      snapshot = await this.poll();
    }

    this.logger.info(
      `Codex utilization dropped to ${(snapshot.five_hour * 100).toFixed(1)}%. Ready to resume.`,
    );
  }

  async poll(): Promise<UsageSnapshot> {
    try {
      const sessionFiles = await findNewestSessionFiles(this.sessionsDir, 40);
      const readings: CodexUsageReading[] = [];

      for (const sessionFile of sessionFiles) {
        const contents = await fs.readFile(sessionFile, "utf-8");
        const reading = parseCodexUsageJsonl(contents);
        if (!reading) {
          continue;
        }
        readings.push(reading);
      }

      const selected = pickPreferredCodexUsage(readings);
      if (selected) {
        this.currentUsage = selected.snapshot;
        this.logger.debug(
          `Codex usage snapshot selected: ` +
          `5h=${(this.currentUsage.five_hour * 100).toFixed(1)}% ` +
          `7d=${(this.currentUsage.seven_day * 100).toFixed(1)}%`,
        );
        return this.getUsage();
      }

      this.logger.warn("No Codex rate-limit snapshot found in session logs; returning last known usage");
      return this.getUsage();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to poll Codex usage: ${message}`);
      return this.getUsage();
    }
  }

  private async pollAndNotify(): Promise<void> {
    await this.poll();

    if (this.isCritical()) {
      const resetsAt = this.currentUsage.five_hour_resets_at ?? "unknown";
      this.logger.warn(
        `CRITICAL: Codex 5h utilization at ${(this.currentUsage.five_hour * 100).toFixed(1)}% ` +
        `(resets at ${resetsAt})`,
      );
      this.onCritical(this.currentUsage.five_hour, resetsAt);
    } else if (this.isWindDownNeeded()) {
      this.logger.warn(
        `WARNING: Codex 5h utilization at ${(this.currentUsage.five_hour * 100).toFixed(1)}% — approaching limit`,
      );
      this.onWarning(this.currentUsage.five_hour);
    }
  }
}

async function findNewestSessionFiles(rootDir: string, maxFiles: number): Promise<string[]> {
  let years: Dirent[];
  try {
    years = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const year of sortDesc(years)) {
    if (!year.isDirectory()) continue;
    const yearDir = path.join(rootDir, year.name);

    let months: Dirent[];
    try {
      months = await fs.readdir(yearDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const month of sortDesc(months)) {
      if (!month.isDirectory()) continue;
      const monthDir = path.join(yearDir, month.name);

      let days: Dirent[];
      try {
        days = await fs.readdir(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const day of sortDesc(days)) {
        if (!day.isDirectory()) continue;
        const dayDir = path.join(monthDir, day.name);

        let entries: Dirent[];
        try {
          entries = await fs.readdir(dayDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of sortDesc(entries)) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
            continue;
          }

          files.push(path.join(dayDir, entry.name));
          if (files.length >= maxFiles) {
            return files;
          }
        }
      }
    }
  }

  return files;
}

function sortDesc(entries: Dirent[]): Dirent[] {
  return [...entries].sort((a, b) => b.name.localeCompare(a.name));
}

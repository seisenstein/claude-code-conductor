import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  DEFAULT_USAGE_THRESHOLD,
  DEFAULT_CRITICAL_THRESHOLD,
  DEFAULT_USAGE_POLL_INTERVAL_MS,
  USAGE_API_URL,
  USAGE_API_BETA_HEADER,
  RESUME_UTILIZATION_THRESHOLD,
  USAGE_MONITOR_MAX_RETRIES,
  USAGE_POLL_MAX_INTERVAL_MS,
  USAGE_POLL_BACKOFF_MULTIPLIER,
  USAGE_STALE_THRESHOLD_MS,
  USAGE_RATE_WINDOW_SIZE,
  USAGE_RATE_ESTABLISHED_POLL_MS,
  USAGE_API_429_BACKOFF_MS,
} from "../utils/constants.js";
import type {
  ProviderUsageMonitor,
  UsageSnapshot,
  UsageApiResponse,
  OAuthCredentials,
} from "../utils/types.js";
import { Logger } from "../utils/logger.js";

// NOTE: Connection pooling / Keep-Alive (#26d)
// Node.js 20+ native fetch uses undici internally, which has Keep-Alive enabled
// by default with connection pooling. No additional configuration is needed.
// See: https://nodejs.org/docs/latest-v20.x/api/globals.html#fetch

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

/** A timestamped usage sample for rate calculation. */
interface UsageSample {
  timestamp: number; // epoch ms
  fiveHour: number; // 0.0 - 1.0
}

export class UsageMonitor implements ProviderUsageMonitor {
  readonly provider = "claude" as const;
  private threshold: number;
  private criticalThreshold: number;
  private basePollIntervalMs: number;
  private currentPollIntervalMs: number;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private currentUsage: UsageSnapshot;
  private onWarning: (utilization: number) => void;
  private onCritical: (utilization: number, resetsAt: string) => void;
  private logger: Logger;
  private consecutiveFailures = 0;
  private lastSuccessfulPollTime = 0; // epoch ms, 0 = never polled successfully
  private running = false;

  // Rate tracking: sliding window of recent usage samples
  private usageSamples: UsageSample[] = [];
  private rateWindowSize: number;

  constructor(options: {
    threshold?: number;
    criticalThreshold?: number;
    pollIntervalMs?: number;
    onWarning: (utilization: number) => void;
    onCritical: (utilization: number, resetsAt: string) => void;
    logger?: Logger;
  }) {
    this.threshold = options.threshold ?? DEFAULT_USAGE_THRESHOLD;
    this.criticalThreshold = options.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;
    this.basePollIntervalMs = options.pollIntervalMs ?? DEFAULT_USAGE_POLL_INTERVAL_MS;
    this.currentPollIntervalMs = this.basePollIntervalMs;
    this.onWarning = options.onWarning;
    this.onCritical = options.onCritical;
    this.currentUsage = { ...DEFAULT_SNAPSHOT };
    this.logger = options.logger ?? new Logger(path.join(os.tmpdir(), "conductor-logs"), "usage-monitor");
    this.rateWindowSize = USAGE_RATE_WINDOW_SIZE;
  }

  /**
   * Start polling the usage endpoint with adaptive intervals.
   * Uses self-rescheduling setTimeout instead of fixed setInterval.
   * On poll failure: doubles the interval (up to USAGE_POLL_MAX_INTERVAL_MS).
   * On poll success: resets the interval to the base value.
   */
  start(): void {
    if (this.running) {
      this.logger.warn("UsageMonitor is already running");
      return;
    }

    this.running = true;
    this.logger.debug(
      `Starting usage monitor (base poll every ${this.basePollIntervalMs / 1000}s, ` +
      `warn at ${(this.threshold * 100).toFixed(0)}%, critical at ${(this.criticalThreshold * 100).toFixed(0)}%)`
    );

    // Do an immediate poll, then schedule the next one adaptively
    void this.pollAndNotify().then(() => this.scheduleNextPoll());
  }

  /**
   * Stop polling. Guarantees no further poll callbacks will fire.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.logger.info("Usage monitor stopped");
  }

  /**
   * Schedule the next poll using the current (possibly backed-off) interval.
   * Checks `running` flag to prevent re-arming after stop().
   */
  private scheduleNextPoll(): void {
    if (!this.running) return;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }
    this.timeoutHandle = setTimeout(() => {
      if (!this.running) return;
      void this.pollAndNotify().then(() => this.scheduleNextPoll());
    }, this.currentPollIntervalMs);
    this.timeoutHandle.unref();
  }

  /**
   * Get the current usage snapshot (cached from the last poll).
   */
  getUsage(): UsageSnapshot {
    return { ...this.currentUsage };
  }

  /**
   * Check if the wind-down threshold has been reached on the 5-hour window.
   */
  isWindDownNeeded(): boolean {
    return this.currentUsage.five_hour >= this.threshold;
  }

  /**
   * Check if the critical threshold has been exceeded on the 5-hour window.
   */
  isCritical(): boolean {
    return this.currentUsage.five_hour >= this.criticalThreshold;
  }

  /**
   * Get the reset time for the 5-hour window, if known.
   */
  getResetTime(): string | null {
    return this.currentUsage.five_hour_resets_at;
  }

  /**
   * Wait for the usage window to reset. Sleeps until `resets_at`,
   * then polls to verify utilization dropped below the resume threshold.
   * Will keep sleeping in 60-second intervals if still above threshold.
   */
  async waitForReset(): Promise<void> {
    const resetsAt = this.currentUsage.five_hour_resets_at;

    if (!resetsAt) {
      this.logger.warn("No reset time available; polling once and returning");
      await this.poll();
      return;
    }

    const resetTime = new Date(resetsAt).getTime();
    const now = Date.now();

    if (resetTime > now) {
      const waitMs = resetTime - now;
      const waitMin = Math.ceil(waitMs / 60_000);
      this.logger.info(`Waiting ${waitMin} minute(s) for usage window to reset at ${resetsAt}`);
      await sleep(waitMs);
    }

    // Poll to verify utilization has dropped
    this.logger.info("Reset time reached, verifying utilization...");
    let snapshot = await this.poll();

    // Keep waiting in 60s increments if still above the resume threshold
    while (snapshot.five_hour >= RESUME_UTILIZATION_THRESHOLD) {
      this.logger.warn(
        `Utilization still at ${(snapshot.five_hour * 100).toFixed(1)}% ` +
        `(need < ${(RESUME_UTILIZATION_THRESHOLD * 100).toFixed(0)}%). Waiting 60s...`
      );
      await sleep(60_000);
      snapshot = await this.poll();
    }

    this.logger.info(
      `Utilization dropped to ${(snapshot.five_hour * 100).toFixed(1)}%. Ready to resume.`
    );
  }

  /**
   * Force a poll right now. Useful before making decisions.
   * Returns the fresh UsageSnapshot.
   *
   * On 429 or network errors, retries with exponential backoff (1s/2s/4s).
   * Returns cached usage if all retries are exhausted.
   * Tracks consecutive failures and adjusts the adaptive poll interval.
   */
  async poll(): Promise<UsageSnapshot> {
    const token = this.readOAuthToken();
    if (!token) {
      this.logger.warn("No OAuth token found; returning last known usage");
      this.recordPollFailure();
      return this.getUsage();
    }

    let lastError: string | null = null;

    for (let attempt = 0; attempt < USAGE_MONITOR_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(USAGE_API_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": USAGE_API_BETA_HEADER,
          },
        });

        // On 429, don't retry — the usage API has a ~5 request/token limit (GH #30930).
        // Retrying just wastes the remaining budget. Back off aggressively and rely on
        // cached data + rate prediction.
        if (response.status === 429) {
          this.logger.warn(
            `Usage API returned 429 — per-token rate limit likely reached (GH #30930). ` +
            `Backing off to ${USAGE_API_429_BACKOFF_MS / 60_000}min. ` +
            `Using cached data + rate prediction.`
          );
          this.recordPollFailure429();
          return this.getUsage();
        }

        if (!response.ok) {
          this.logger.warn(
            `Usage API returned ${response.status} ${response.statusText}; returning last known usage`
          );
          this.recordPollFailure();
          return this.getUsage();
        }

        const data = (await response.json()) as UsageApiResponse;

        // API returns utilization as percentage (e.g. 5.0 = 5%).
        // Internally we use 0-1 range (0.05 = 5%) so thresholds like 0.80 work correctly.
        this.currentUsage = {
          five_hour: data.five_hour.utilization / 100,
          seven_day: data.seven_day.utilization / 100,
          five_hour_resets_at: data.five_hour.resets_at,
          seven_day_resets_at: data.seven_day.resets_at,
          last_checked: new Date().toISOString(),
        };

        this.recordPollSuccess();
        this.recordUsageSample(this.currentUsage.five_hour);

        this.logger.debug(
          `Usage: 5h=${(this.currentUsage.five_hour * 100).toFixed(1)}% ` +
          `7d=${(this.currentUsage.seven_day * 100).toFixed(1)}% (${this.getRateSummary()})`
        );

        return this.getUsage();
      } catch (err) {
        // Network error - retry with backoff
        lastError = err instanceof Error ? err.message : String(err);
        const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s

        if (attempt < USAGE_MONITOR_MAX_RETRIES - 1) {
          this.logger.warn(
            `Failed to poll usage API (attempt ${attempt + 1}/${USAGE_MONITOR_MAX_RETRIES}): ${lastError}, ` +
            `retrying in ${backoffMs / 1000}s...`
          );
          await sleep(backoffMs);
        }
      }
    }

    // All retries exhausted
    this.recordPollFailure();
    this.logger.warn(
      `Usage API poll failed after ${USAGE_MONITOR_MAX_RETRIES} attempts` +
      (lastError ? `: ${lastError}` : "") +
      `; returning last known usage (stale for ${Math.round(this.getStaleDurationMs() / 1000)}s, ` +
      `${this.consecutiveFailures} consecutive failures, next poll in ${Math.round(this.currentPollIntervalMs / 1000)}s)`
    );
    return this.getUsage();
  }

  // ----------------------------------------------------------------
  // Staleness tracking
  // ----------------------------------------------------------------

  isDataStale(): boolean {
    if (this.lastSuccessfulPollTime === 0) return false; // never polled yet
    return this.getStaleDurationMs() >= USAGE_STALE_THRESHOLD_MS;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getStaleDurationMs(): number {
    if (this.lastSuccessfulPollTime === 0) return 0;
    return Date.now() - this.lastSuccessfulPollTime;
  }

  // ----------------------------------------------------------------
  // Usage rate tracking
  // ----------------------------------------------------------------

  /**
   * Record a usage sample for rate calculation.
   * Maintains a sliding window of the last N samples.
   */
  private recordUsageSample(fiveHour: number): void {
    const now = Date.now();

    // If the usage dropped (window reset), clear the history since rate is meaningless across resets
    const lastSample = this.usageSamples[this.usageSamples.length - 1];
    if (lastSample && fiveHour < lastSample.fiveHour - 0.01) {
      this.logger.debug(
        `Usage dropped from ${(lastSample.fiveHour * 100).toFixed(1)}% to ${(fiveHour * 100).toFixed(1)}% — window reset detected, clearing rate history`
      );
      this.usageSamples = [];
    }

    this.usageSamples.push({ timestamp: now, fiveHour });

    // Keep only the last N samples
    if (this.usageSamples.length > this.rateWindowSize) {
      this.usageSamples = this.usageSamples.slice(-this.rateWindowSize);
    }
  }

  /**
   * Get the current usage rate as percentage points per minute.
   * Uses a running average across the sample window.
   * Returns null if not enough data (need at least 2 samples).
   */
  getUsageRatePerMinute(): number | null {
    if (this.usageSamples.length < 2) return null;

    const first = this.usageSamples[0];
    const last = this.usageSamples[this.usageSamples.length - 1];
    const elapsedMs = last.timestamp - first.timestamp;

    if (elapsedMs <= 0) return null;

    const usageDelta = last.fiveHour - first.fiveHour;
    const elapsedMin = elapsedMs / 60_000;

    return usageDelta / elapsedMin;
  }

  /**
   * Estimate minutes until the given threshold is reached, based on the current usage rate.
   * Returns null if rate data is unavailable or rate is zero/negative (usage isn't growing).
   */
  estimateMinutesUntilThreshold(threshold?: number): number | null {
    const target = threshold ?? this.threshold;
    const rate = this.getUsageRatePerMinute();
    if (rate === null || rate <= 0) return null;

    const currentUsage = this.currentUsage.five_hour;
    const remaining = target - currentUsage;

    if (remaining <= 0) return 0; // Already at or past threshold

    return remaining / rate;
  }

  /**
   * Check if the predicted usage will exceed the threshold before the next poll.
   * This allows pre-emptive wind-down instead of discovering we're over the limit.
   */
  isThresholdPredicted(): boolean {
    const minutesUntil = this.estimateMinutesUntilThreshold();
    if (minutesUntil === null) return false;

    // If we predict hitting the threshold within the next poll interval, flag it
    const nextPollMinutes = this.currentPollIntervalMs / 60_000;
    return minutesUntil <= nextPollMinutes;
  }

  /**
   * Get a human-readable rate summary for logging.
   */
  getRateSummary(): string {
    const rate = this.getUsageRatePerMinute();
    if (rate === null) return "rate: insufficient data";

    const ratePerMin = (rate * 100).toFixed(2);
    const etaMin = this.estimateMinutesUntilThreshold();
    const etaStr = etaMin !== null ? `${Math.round(etaMin)}min` : "N/A";

    return `rate: ${ratePerMin}%/min, ETA to ${(this.threshold * 100).toFixed(0)}%: ${etaStr}`;
  }

  private recordPollSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.logger.info(
        `Usage API recovered after ${this.consecutiveFailures} consecutive failure(s). ` +
        `Resetting poll interval to ${this.basePollIntervalMs / 1000}s.`
      );
    }
    this.consecutiveFailures = 0;
    this.lastSuccessfulPollTime = Date.now();

    // Once we have a rate established (2+ samples), extend the poll interval
    // to conserve the ~5 request/token budget (GH #30930).
    if (this.usageSamples.length >= 2) {
      this.currentPollIntervalMs = USAGE_RATE_ESTABLISHED_POLL_MS;
      this.logger.debug(
        `Rate established (${this.usageSamples.length} samples). ` +
        `Extended poll interval to ${USAGE_RATE_ESTABLISHED_POLL_MS / 60_000}min to conserve API budget.`
      );
    } else {
      this.currentPollIntervalMs = this.basePollIntervalMs;
    }
  }

  private recordPollFailure(): void {
    this.consecutiveFailures++;
    // Adaptive backoff: double interval on each failure, cap at max
    const newInterval = Math.min(
      this.currentPollIntervalMs * USAGE_POLL_BACKOFF_MULTIPLIER,
      USAGE_POLL_MAX_INTERVAL_MS,
    );
    if (newInterval !== this.currentPollIntervalMs) {
      this.currentPollIntervalMs = newInterval;
      this.logger.warn(
        `Usage API poll failed (${this.consecutiveFailures} consecutive). ` +
        `Backing off to ${Math.round(this.currentPollIntervalMs / 1000)}s poll interval.`
      );
    }
  }

  /**
   * Handle 429 specifically: the usage API has ~5 requests per OAuth token (GH #30930).
   * Back off aggressively since retrying won't help — the limit is per-token, not time-based.
   */
  private recordPollFailure429(): void {
    this.consecutiveFailures++;
    this.currentPollIntervalMs = USAGE_API_429_BACKOFF_MS;
  }

  /**
   * Internal: poll and fire callbacks if thresholds are exceeded.
   */
  private async pollAndNotify(): Promise<void> {
    await this.poll();

    if (this.isCritical()) {
      const resetsAt = this.currentUsage.five_hour_resets_at ?? "unknown";
      this.logger.warn(
        `CRITICAL: 5h utilization at ${(this.currentUsage.five_hour * 100).toFixed(1)}% (resets at ${resetsAt})`
      );
      this.onCritical(this.currentUsage.five_hour, resetsAt);
    } else if (this.isWindDownNeeded()) {
      this.logger.warn(
        `WARNING: 5h utilization at ${(this.currentUsage.five_hour * 100).toFixed(1)}% — approaching limit`
      );
      this.onWarning(this.currentUsage.five_hour);
    } else if (this.isThresholdPredicted()) {
      const etaMin = this.estimateMinutesUntilThreshold();
      this.logger.warn(
        `PREDICTED: 5h utilization at ${(this.currentUsage.five_hour * 100).toFixed(1)}% — ` +
        `predicted to hit ${(this.threshold * 100).toFixed(0)}% in ~${Math.round(etaMin ?? 0)}min (${this.getRateSummary()})`
      );
      this.onWarning(this.currentUsage.five_hour);
    }
  }

  /**
   * Read the OAuth access token. Tries multiple sources in order:
   * 1. CLAUDE_CODE_OAUTH_TOKEN env var (explicit override / CI)
   * 2. ~/.claude/.credentials.json file (Linux)
   * 3. macOS Keychain (macOS)
   *
   * Returns null if no token can be found.
   */
  private readOAuthToken(): string | null {
    // 1. Environment variable (works everywhere)
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (envToken) {
      this.logger.debug("Using OAuth token from CLAUDE_CODE_OAUTH_TOKEN env var");
      return envToken;
    }

    // 2. Credentials file (Linux, or macOS if file exists)
    try {
      const credPath = path.join(os.homedir(), ".claude", ".credentials.json");

      if (fs.existsSync(credPath)) {
        const raw = fs.readFileSync(credPath, "utf-8");
        const creds = JSON.parse(raw) as OAuthCredentials;

        if (creds.claudeAiOauth?.accessToken) {
          // Check if the token has expired
          if (creds.claudeAiOauth.expiresAt && Date.now() > creds.claudeAiOauth.expiresAt) {
            this.logger.debug("Token from credentials file has expired, trying other sources");
          } else {
            this.logger.debug("Using OAuth token from credentials file");
            return creds.claudeAiOauth.accessToken;
          }
        }
      }
    } catch {
      // File doesn't exist or can't be parsed — continue to next source
    }

    // 3. macOS Keychain
    if (process.platform === "darwin") {
      try {
        const keychainResult = execSync(
          'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
          { encoding: "utf-8", timeout: 5000 },
        ).trim();

        if (keychainResult) {
          // The keychain entry stores JSON with the same structure as the file
          const creds = JSON.parse(keychainResult) as OAuthCredentials;
          if (creds.claudeAiOauth?.accessToken) {
            if (creds.claudeAiOauth.expiresAt && Date.now() > creds.claudeAiOauth.expiresAt) {
              this.logger.warn("OAuth token from Keychain has expired");
              return null;
            }
            this.logger.debug("Using OAuth token from macOS Keychain");
            return creds.claudeAiOauth.accessToken;
          }
        }
      } catch {
        this.logger.debug("Could not read OAuth token from macOS Keychain");
      }
    }

    this.logger.warn("No OAuth token found from any source (env, file, or Keychain)");
    return null;
  }
}

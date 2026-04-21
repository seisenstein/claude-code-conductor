import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

import type { CodexReviewResult, CodexVerdict, CodexUsageMetrics, ModelConfig } from "../utils/types.js";
import {
  getCodexReviewsDir,
  getCodexModel,
  MAX_CODEX_PROMPT_FILE_CHARS,
  MAX_CODEX_PROMPT_AGGREGATE_CHARS,
  MAX_CODEX_STDOUT_BYTES,
} from "../utils/constants.js";
import type { Logger } from "../utils/logger.js";
import { mkdirSecure, writeJsonAtomic } from "../utils/secure-fs.js";
import { coerceLogText, detectProviderRateLimit } from "../utils/provider-limit.js";
import {
  hasBlockingIssues,
  inferSeverityFromCategory,
} from "./codex-review-gating.js";
import {
  buildAdversarialStance,
  buildFeedbackFraming,
  buildRoundBudget,
  buildSeverityTaxonomy,
  buildCoordinatorMcpParagraph,
  buildCoordinatorMcpParagraphReplan,
  type RoundBudget,
} from "./codex-review-prompts.js";

export type { RoundBudget };

/** Timeout for each codex review invocation: 5 minutes. */
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum length for user-provided content injected into review prompts (H18). */
const MAX_PROMPT_CONTENT_LENGTH = 5000;

/**
 * Sanitize user-provided content before injecting into review prompts.
 * Prevents prompt injection by stripping role markers and truncating (H18).
 */
function sanitizePromptContent(content: string, maxLength: number = MAX_PROMPT_CONTENT_LENGTH): string {
  if (!content) return "";
  let sanitized = content;
  // Strip role markers that could confuse the model
  sanitized = sanitized.replace(/Human:|Assistant:|User:|System:/gi, "[removed]");
  // Strip instruction markers (use [\s\S]*? for multiline matching)
  sanitized = sanitized.replace(/\[INST\][\s\S]*?\[\/INST\]/gi, "[removed]");
  sanitized = sanitized.replace(/<<SYS>>[\s\S]*?<<\/SYS>>/gi, "[removed]");
  // Truncate to max length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "\n[truncated]";
  }
  return sanitized;
}

/** Valid verdict strings for the structured JSON response. */
const VALID_VERDICTS = new Set<string>([
  "APPROVE",
  "NEEDS_DISCUSSION",
  "MAJOR_CONCERNS",
  "NEEDS_FIXES",
  "MAJOR_PROBLEMS",
]);

/** JSON format instructions appended to every Codex prompt. */
const JSON_FORMAT_INSTRUCTIONS = `

IMPORTANT: You MUST respond with a JSON code block containing your review. Use exactly this format:

\`\`\`json
{
  "review_performed": true,
  "verdict": "APPROVE" | "NEEDS_DISCUSSION" | "MAJOR_CONCERNS" | "NEEDS_FIXES" | "MAJOR_PROBLEMS",
  "issues": [
    { "description": "Description of the issue", "severity": "minor" | "major" | "critical" }
  ],
  "summary": "Brief overall assessment"
}
\`\`\`

Rules:
- "review_performed" must be exactly true
- "verdict" must be one of the exact strings listed above
- "issues" must be an array (empty array if no issues)
- Each issue must have "description" (string) and "severity" ("minor", "major", or "critical")
- "summary" must be a brief string
- Do NOT include any text outside the JSON code block`;

/**
 * Custom error class for Codex CLI failures.
 * Thrown instead of returning error strings so callers can distinguish
 * real review output from execution failures.
 */
export class CodexExecutionError extends Error {
  constructor(
    message: string,
    public readonly reason: "not_found" | "timeout" | "crash" | "output_too_large",
    public readonly partialOutput?: string,
  ) {
    super(message);
    this.name = "CodexExecutionError";
  }
}

/**
 * Read at most `maxChars` UTF-16 code units from a file without allocating
 * the whole file in memory. Uses fs.open + bounded read. Returns:
 *   { content, fullByteLength, wasTruncated }
 * where wasTruncated is authoritatively true iff the file exceeded the cap
 * AND the returned content was sliced. Callers should not infer truncation
 * from byte/char mismatches — unreliable for multi-byte content (CR-2).
 */
async function readFilePrefix(
  p: string,
  maxChars: number,
): Promise<{ content: string; fullByteLength: number; wasTruncated: boolean }> {
  const stat = await fs.stat(p);
  const fullByteLength = stat.size;
  const readBytes = Math.min(fullByteLength, maxChars * 4);
  const fh = await fs.open(p, "r");
  try {
    const buf = Buffer.alloc(readBytes);
    const { bytesRead } = await fh.read(buf, 0, readBytes, 0);
    const decoded = buf.subarray(0, bytesRead).toString("utf-8");
    const wasTruncated = bytesRead < fullByteLength || decoded.length > maxChars;
    const content = wasTruncated ? decoded.slice(0, maxChars) : decoded;
    return { content, fullByteLength, wasTruncated };
  } finally {
    await fh.close();
  }
}

interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  logger: Logger;
}

/**
 * Spawn a process, pipe `stdinPayload` to its stdin, collect stdout/stderr
 * with a byte-count maxBuffer guard, and map failure modes to
 * CodexExecutionError. Parity contract with the previous execFileAsync
 * wrapper, plus explicit output_too_large handling (CR-2).
 */
async function spawnCodexWithStdin(
  command: string,
  args: string[],
  stdinPayload: string,
  opts: SpawnOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, { cwd: opts.cwd });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        opts.logger.error("Codex CLI not found — is it installed and on PATH?");
        reject(
          new CodexExecutionError(
            "Codex CLI not found. Please install codex.",
            "not_found",
          ),
        );
        return;
      }
      reject(
        new CodexExecutionError(`Codex spawn failed: ${String(err)}`, "crash"),
      );
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let overflowed = false;
    let timedOut = false;
    let settled = false;
    let exited = false; // child actually emitted 'close' — distinct from proc.killed
                        // (proc.killed flips true the moment we CALL kill(), not when the OS reaps)

    proc.on("close", () => {
      exited = true;
    });

    const killChild = () => {
      if (exited) return;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore — process may already be gone
      }
      // Unconditional SIGKILL fallback after 2s. `proc.killed` is already true
      // post-SIGTERM even if the child is still alive, so we gate on `exited`
      // (set by the 'close' listener) instead.
      setTimeout(() => {
        if (exited) return;
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000).unref();
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > opts.maxStdoutBytes) {
        overflowed = true;
        killChild();
        return;
      }
      stdoutChunks.push(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > opts.maxStdoutBytes) {
        overflowed = true;
        killChild();
        return;
      }
      stderrChunks.push(chunk);
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        opts.logger.error("Codex CLI not found — is it installed and on PATH?");
        settle(() =>
          reject(
            new CodexExecutionError(
              "Codex CLI not found. Please install codex.",
              "not_found",
            ),
          ),
        );
        return;
      }
      settle(() =>
        reject(
          new CodexExecutionError(`Codex spawn error: ${err.message}`, "crash"),
        ),
      );
    });

    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (overflowed) {
        opts.logger.error(
          `Codex stdout exceeded ${opts.maxStdoutBytes} bytes — killed.`,
        );
        settle(() =>
          reject(
            new CodexExecutionError(
              `Codex stdout exceeded ${opts.maxStdoutBytes} bytes.`,
              "output_too_large",
              stdout,
            ),
          ),
        );
        return;
      }

      if (timedOut) {
        opts.logger.error("Codex review timed out");
        settle(() =>
          reject(
            new CodexExecutionError(
              "Codex review timed out.",
              "timeout",
              stdout,
            ),
          ),
        );
        return;
      }

      if (stderr) {
        opts.logger.debug(`codex stderr: ${stderr.trim()}`);
      }

      if (code === 0) {
        settle(() => resolve(stdout));
        return;
      }

      // Non-zero exit but stdout present → return stdout (behavioral parity).
      if (stdout.trim().length > 0) {
        opts.logger.warn(
          `Codex exited with code ${code} but produced output (${stdout.length} chars). stderr: ${stderr.trim()}`,
        );
        settle(() => resolve(stdout));
        return;
      }

      opts.logger.error(`Codex execution failed: exit ${code}. stderr: ${stderr.trim()}`);
      settle(() =>
        reject(
          new CodexExecutionError(
            `Codex execution failed: exit ${code}. ${stderr.trim()}`,
            "crash",
            stderr,
          ),
        ),
      );
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, opts.timeoutMs);

    // EPIPE defense: if codex exits before we finish writing, the stdin
    // stream emits 'error' (EPIPE). Without a listener, Node treats this as
    // an unhandled error and terminates the process. The proc-level 'error'
    // handler does NOT catch stdin stream errors. EPIPE specifically is not
    // fatal to us — the 'close' event will still run and report whatever
    // stdout/stderr we got. For other stdin errors, treat as crash.
    proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        opts.logger.debug(
          "codex stdin closed before write completed (EPIPE) — child exited early",
        );
        return;
      }
      settle(() =>
        reject(
          new CodexExecutionError(
            `Codex stdin error: ${err.message}`,
            "crash",
          ),
        ),
      );
    });

    // Write prompt to stdin and close.
    try {
      proc.stdin?.write(stdinPayload);
      proc.stdin?.end();
    } catch (err) {
      settle(() =>
        reject(
          new CodexExecutionError(
            `Failed to write prompt to codex stdin: ${String(err)}`,
            "crash",
          ),
        ),
      );
    }
  });
}

export class CodexReviewer {
  private projectDir: string;
  private orchestratorDir: string;
  private mcpServerPath: string;
  private logger: Logger;
  private modelConfig: ModelConfig;
  private metrics: CodexUsageMetrics = {
    invocations: 0,
    successes: 0,
    invalid_responses: 0,
    presumed_rate_limits: 0,
    last_presumed_rate_limit_at: null,
    output_too_large_failures: 0, // CR-2: tracked separately from rate limits
    execution_errors: 0, // H-16: second-attempt crash/timeout without rate-limit signal
  };

  constructor(
    projectDir: string,
    orchestratorDir: string,
    mcpServerPath: string,
    logger: Logger,
    modelConfig: ModelConfig, // CR-3: reviewer now threads model from orchestrator config
  ) {
    this.projectDir = projectDir;
    this.orchestratorDir = orchestratorDir;
    this.mcpServerPath = mcpServerPath;
    this.logger = logger;
    this.modelConfig = modelConfig;
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Get the current Codex usage metrics.
   */
  getMetrics(): CodexUsageMetrics {
    return { ...this.metrics };
  }

  /**
   * Review a plan file. Returns a verdict and the raw Codex output.
   *
   * `round` threads the current discussion-round number so Codex sees a
   * "round X of Y" budget block and stops drip-feeding findings across
   * rounds. `context.hasPriorContext` is true for replan (cycle 2+)
   * plan reviews, where coordinator contracts/decisions from earlier
   * cycles are relevant to mention.
   */
  async reviewPlan(
    planPath: string,
    round?: RoundBudget,
    context?: { hasPriorContext?: boolean },
  ): Promise<CodexReviewResult> {
    return this.withRetryOnInvalidResponse(async () => {
      const prompt = this.buildPlanReviewPrompt({
        isInitial: true,
        round,
        hasPriorContext: context?.hasPriorContext === true,
      });
      const output = await this.runCodex(prompt, [planPath]);
      const result = this.buildResult(output, planPath);
      await this.saveReview(result, "plan-review");
      return result;
    }, "plan-review");
  }

  /**
   * Re-review a plan after a discussion round, providing the discussion response.
   */
  async reReviewPlan(
    planPath: string,
    discussionPath: string,
    round?: RoundBudget,
    context?: { hasPriorContext?: boolean },
  ): Promise<CodexReviewResult> {
    return this.withRetryOnInvalidResponse(async () => {
      const prompt = this.buildPlanReviewPrompt({
        isInitial: false,
        round,
        hasPriorContext: context?.hasPriorContext === true,
      });
      const output = await this.runCodex(prompt, [planPath, discussionPath]);
      const result = this.buildResult(output, planPath);
      await this.saveReview(result, "plan-re-review");
      return result;
    }, "plan-re-review");
  }

  /**
   * Review code changes (diff) against the plan. Returns a verdict and raw output.
   */
  async reviewCode(
    taskDescription: string,
    planPath: string,
    changedFilesPath: string,
    diffPath: string,
    round?: RoundBudget,
  ): Promise<CodexReviewResult> {
    return this.withRetryOnInvalidResponse(async () => {
      const sanitizedDescription = sanitizePromptContent(taskDescription);
      const prompt = this.buildCodeReviewPrompt({
        isInitial: true,
        round,
        taskDescription: sanitizedDescription,
      });
      const output = await this.runCodex(prompt, [planPath, changedFilesPath, diffPath]);
      const result = this.buildResult(output, diffPath);
      await this.saveReview(result, "code-review");
      return result;
    }, "code-review");
  }

  /**
   * Re-review code after fixes, including the previous review response.
   */
  async reReviewCode(
    reviewResponsePath: string,
    changedFilesPath: string,
    round?: RoundBudget,
  ): Promise<CodexReviewResult> {
    return this.withRetryOnInvalidResponse(async () => {
      const prompt = this.buildCodeReviewPrompt({
        isInitial: false,
        round,
      });
      const output = await this.runCodex(prompt, [reviewResponsePath, changedFilesPath]);
      const result = this.buildResult(output, changedFilesPath);
      await this.saveReview(result, "code-re-review");
      return result;
    }, "code-re-review");
  }

  // ----------------------------------------------------------------
  // Private: prompt composition (v0.7.7)
  // ----------------------------------------------------------------

  private buildPlanReviewPrompt(args: {
    isInitial: boolean;
    round?: RoundBudget;
    hasPriorContext: boolean;
  }): string {
    const { isInitial, round, hasPriorContext } = args;
    const role = isInitial
      ? "You are reviewing an implementation plan before any code is written."
      : "You previously reviewed this plan and raised concerns. The planner has responded. Review the updated plan alongside the response.";
    const task = isInitial
      ? [
          "## Your Task",
          "",
          "Examine the attached plan for feasibility, completeness, correctness, risk, alternatives, and ordering. Verify every claim against the actual codebase using your file-reading tools — do not take the plan's description of the current state at face value.",
        ].join("\n")
      : [
          "## Your Task",
          "",
          "Address the planner's response. For each outstanding finding, say whether you accept the response, still disagree (with evidence), or have a new concern raised by the change. Skip items that were resolved.",
        ].join("\n");

    const parts: string[] = [role, "", buildAdversarialStance("plan"), "", buildFeedbackFraming()];
    if (round) {
      parts.push("", buildRoundBudget(round));
    }
    parts.push("", buildSeverityTaxonomy("plan"), "", task);
    if (hasPriorContext) {
      parts.push("", buildCoordinatorMcpParagraphReplan());
    }
    parts.push("", JSON_FORMAT_INSTRUCTIONS);
    return parts.join("\n");
  }

  private buildCodeReviewPrompt(args: {
    isInitial: boolean;
    round?: RoundBudget;
    taskDescription?: string;
  }): string {
    const { isInitial, round, taskDescription } = args;
    const role = isInitial
      ? `You are reviewing code changes for the following task:\n\n${taskDescription ?? "(no task description provided)"}\n\nCompare the implementation against the plan and the diff.`
      : "You previously reviewed this code and requested fixes. The developer has responded. Review the updated files alongside the response.";
    const task = isInitial
      ? [
          "## Your Task",
          "",
          "For each changed file, examine the FULL file (not just the diff) to understand context. Check correctness, completeness, edge cases, error handling, and consistency with the plan. Be specific: cite file paths and line numbers.",
        ].join("\n")
      : [
          "## Your Task",
          "",
          "Verify the developer's fixes by reading the current file state. Accept or push back on disagreements with specific code evidence. If all significant issues are resolved, approve.",
        ].join("\n");

    const parts: string[] = [role, "", buildAdversarialStance("code"), "", buildFeedbackFraming()];
    if (round) {
      parts.push("", buildRoundBudget(round));
    }
    parts.push("", buildSeverityTaxonomy("code"), "", task, "", buildCoordinatorMcpParagraph(), "", JSON_FORMAT_INSTRUCTIONS);
    return parts.join("\n");
  }

  /**
   * Check if the `codex` CLI is available on the system.
   * Only returns true if `codex --version` succeeds cleanly.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 10_000 });
      this.logger.info(`Codex CLI available: ${stdout.trim()}`);
      return true;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        this.logger.warn("Codex CLI is not installed or not on PATH");
      } else {
        this.logger.error(`Codex CLI check failed: ${String(err)}`);
      }
      return false;
    }
  }

  // ----------------------------------------------------------------
  // Private: retry wrapper
  // ----------------------------------------------------------------

  /**
   * Wraps a Codex review operation with retry logic for invalid responses.
   * - If the operation returns a real verdict, returns it immediately.
   * - If CodexExecutionError with reason "not_found", rethrows immediately.
   * - If execution error (timeout/crash) or NO_VERDICT, retries once.
   * - On second failure: execution errors → RATE_LIMITED; invalid JSON → ERROR.
   */
  /**
   * CR-2: terminal handling for "output_too_large" at either attempt.
   * Retrying with the same over-large prompt will fail again, and throwing
   * would hard-stop the conductor at orchestrator.ts:548. Return an ERROR
   * verdict so orchestration stays resilient while the failure is visible.
   */
  private async outputTooLargeResult(
    err: CodexExecutionError,
    label: string,
  ): Promise<CodexReviewResult> {
    this.metrics.output_too_large_failures++;
    const result: CodexReviewResult = {
      verdict: "ERROR",
      raw_output: `CODEX OUTPUT TOO LARGE: ${err.message}`,
      issues: [],
      file_path: label,
    };
    await this.saveReview(result, `${label}-ERROR`);
    return result;
  }

  private async withRetryOnInvalidResponse(
    operation: () => Promise<CodexReviewResult>,
    label: string,
  ): Promise<CodexReviewResult> {
    this.metrics.invocations++;

    // First attempt
    let firstResult: CodexReviewResult | null = null;
    let firstExecError: CodexExecutionError | null = null;

    try {
      firstResult = await operation();
    } catch (err) {
      if (err instanceof CodexExecutionError) {
        if (err.reason === "not_found") {
          // Codex not installed — no point retrying
          throw err;
        }
        if (err.reason === "output_too_large") {
          // CR-2: terminal on first attempt (retry is pointless)
          return this.outputTooLargeResult(err, label);
        }
        firstExecError = err;
      } else {
        throw err;
      }
    }

    // Check if first attempt succeeded with a real verdict
    if (firstResult && firstResult.verdict !== "NO_VERDICT" && firstResult.verdict !== "ERROR") {
      this.metrics.successes++;
      return firstResult;
    }

    // First attempt failed — log and retry
    if (firstExecError) {
      this.logger.warn(
        `[${label}] Codex execution failed (${firstExecError.reason}): ${firstExecError.message}. Retrying...`,
      );
    } else {
      this.logger.warn(
        `[${label}] Codex returned invalid/unparseable response (verdict: ${firstResult?.verdict}). Retrying...`,
      );
    }

    // Second attempt
    this.metrics.invocations++;
    let secondResult: CodexReviewResult | null = null;
    let secondExecError: CodexExecutionError | null = null;

    try {
      secondResult = await operation();
    } catch (err) {
      if (err instanceof CodexExecutionError) {
        if (err.reason === "not_found") {
          throw err;
        }
        if (err.reason === "output_too_large") {
          // CR-2: terminal on second attempt too
          return this.outputTooLargeResult(err, label);
        }
        secondExecError = err;
      } else {
        throw err;
      }
    }

    // Check if second attempt succeeded
    if (secondResult && secondResult.verdict !== "NO_VERDICT" && secondResult.verdict !== "ERROR") {
      this.metrics.successes++;
      return secondResult;
    }

    // Both attempts failed. H-16: don't blanket-classify as RATE_LIMITED —
    // check the error's message + partialOutput (which contains stderr)
    // for actual rate-limit signals. If no signal, treat as ERROR so
    // retryCodexWithBackoff doesn't waste 16 minutes on non-rate-limit errors.
    if (secondExecError) {
      const detail = coerceLogText(secondExecError.partialOutput ?? "") + " " + secondExecError.message;
      const rlSignal = detectProviderRateLimit("codex", detail);

      if (rlSignal) {
        this.metrics.presumed_rate_limits++;
        this.metrics.last_presumed_rate_limit_at = new Date().toISOString();
        this.logger.error(
          `[${label}] Codex failed on second attempt with rate-limit signal (${rlSignal.detail}). Classified as RATE_LIMITED.`,
        );
        const filePath = firstResult?.file_path ?? secondResult?.file_path ?? label;
        const result: CodexReviewResult = {
          verdict: "RATE_LIMITED",
          raw_output: `CODEX RATE LIMITED: ${secondExecError.message}`,
          issues: [],
          file_path: filePath,
        };
        await this.saveReview(result, `${label}-RATE_LIMITED`);
        return result;
      }

      // No rate-limit evidence — terminal execution error, not rate-limited.
      this.metrics.execution_errors++;
      this.logger.error(
        `[${label}] Codex failed on second attempt with execution error (${secondExecError.reason}, no rate-limit signal). Returning ERROR.`,
      );
      const filePath = firstResult?.file_path ?? secondResult?.file_path ?? label;
      const errResult: CodexReviewResult = {
        verdict: "ERROR",
        raw_output: `CODEX EXECUTION FAILED: ${secondExecError.message}`,
        issues: [],
        file_path: filePath,
      };
      await this.saveReview(errResult, `${label}-ERROR`);
      return errResult;
    }

    // Second attempt returned output but it was invalid JSON → ERROR (not rate limited)
    this.metrics.invalid_responses++;
    this.logger.error(
      `[${label}] Codex returned output on both attempts but JSON was invalid. Returning ERROR.`,
    );

    // Return the second attempt's result (which has verdict NO_VERDICT or ERROR)
    const errorResult: CodexReviewResult = {
      verdict: "ERROR",
      raw_output: secondResult?.raw_output ?? firstResult?.raw_output ?? "Invalid Codex response on both attempts",
      issues: [],
      file_path: secondResult?.file_path ?? firstResult?.file_path ?? label,
    };
    await this.saveReview(errorResult, `${label}-ERROR`);
    return errorResult;
  }

  // ----------------------------------------------------------------
  // Private: run codex
  // ----------------------------------------------------------------

  /**
   * Execute `codex exec` with the given prompt and file contents.
   *
   * CR-2/CR-3 changes vs pre-0.7.2:
   *  - File contents are read with `readFilePrefix` (bounded; memory-safe).
   *  - Per-file cap MAX_CODEX_PROMPT_FILE_CHARS.
   *  - Hard aggregate cap MAX_CODEX_PROMPT_AGGREGATE_CHARS with clamping +
   *    single summary marker for skipped files.
   *  - Prompt delivered via stdin (`codex exec ... -`), not argv, so OS
   *    ARG_MAX is not a factor.
   *  - `--model` threaded through from modelConfig.worker.
   *  - spawn() with byte-count maxBuffer guard on stdout/stderr; overflow
   *    throws CodexExecutionError("output_too_large").
   *
   * Preserved behaviors:
   *  - Non-zero exit + stdout present → return stdout.
   *  - Timeout → CodexExecutionError("timeout", partialOutput).
   *  - ENOENT (codex missing) → CodexExecutionError("not_found").
   */
  private async runCodex(prompt: string, readPaths: string[]): Promise<string> {
    const fileContents: string[] = [];
    let aggregateChars = 0;
    let truncatedFiles = 0;
    let skippedAfterCap = 0;
    let capReached = false;

    for (const p of readPaths) {
      // Check cap BEFORE reading. Previously `readFilePrefix` ran first and
      // its result was discarded post-cap — bounded but wasteful (100K chars
      // × N files of pointless I/O). Fix: short-circuit here.
      if (capReached) {
        skippedAfterCap++;
        continue;
      }

      try {
        const { content, fullByteLength, wasTruncated } = await readFilePrefix(
          p,
          MAX_CODEX_PROMPT_FILE_CHARS,
        );
        const basename = path.basename(p);

        const remaining = MAX_CODEX_PROMPT_AGGREGATE_CHARS - aggregateChars;
        if (remaining <= 0) {
          capReached = true;
          skippedAfterCap++;
          continue;
        }

        let body = content;
        if (wasTruncated) {
          body =
            content +
            `\n\n[TRUNCATED — file is ${fullByteLength} bytes, showing first ${content.length} chars]`;
          truncatedFiles++;
        }

        const wrapperOpen = `\n\n## File: ${basename}\n\n\`\`\`\n`;
        const wrapperClose = "\n```";
        const fullChunk = wrapperOpen + body + wrapperClose;

        let chunk = fullChunk;
        if (chunk.length > remaining) {
          const marker = `\n\n[TRUNCATED_BY_AGGREGATE_CAP]`;
          chunk =
            fullChunk.slice(0, Math.max(0, remaining - marker.length)) + marker;
          truncatedFiles++;
          capReached = true;
        }

        fileContents.push(chunk);
        aggregateChars += chunk.length;
      } catch (err) {
        this.logger.warn(`Could not read file ${p}: ${String(err)}`);
      }
    }

    if (skippedAfterCap > 0) {
      fileContents.push(
        `\n\n[${skippedAfterCap} additional file(s) skipped due to aggregate prompt cap of ${MAX_CODEX_PROMPT_AGGREGATE_CHARS} chars.]`,
      );
    }

    if (truncatedFiles > 0 || skippedAfterCap > 0) {
      this.logger.warn(
        `Codex reviewer prompt: ${truncatedFiles} file(s) truncated, ${skippedAfterCap} file(s) skipped ` +
          `(aggregate cap ${MAX_CODEX_PROMPT_AGGREGATE_CHARS}). Review may be incomplete.`,
      );
    }

    const fullPrompt = prompt + fileContents.join("");
    const codexModel = getCodexModel(this.modelConfig.worker); // CR-3

    // CR-2: `-` tells codex exec to read the prompt from stdin. This avoids
    // argv size limits entirely (macOS ARG_MAX is 1MB; many Linux distros
    // are 128KB–2MB, and env counts against the same budget).
    const args: string[] = [
      "exec",
      "--full-auto",
      "--model",
      codexModel,
      "-C",
      this.projectDir,
      "-c",
      'mcp_servers.coordinator.command="node"',
      "-c",
      `mcp_servers.coordinator.args=[${JSON.stringify(this.mcpServerPath)}]`,
      "-c",
      `mcp_servers.coordinator.env.CONDUCTOR_DIR=${JSON.stringify(this.orchestratorDir)}`,
      "-c",
      'mcp_servers.coordinator.env.SESSION_ID="codex-reviewer"',
      "-c",
      "mcp_servers.coordinator.startup_timeout_sec=10",
      "-c",
      "mcp_servers.coordinator.tool_timeout_sec=30",
      "-c",
      "mcp_servers.coordinator.enabled=true",
      "-c",
      "mcp_servers.coordinator.required=false",
      "-",
    ];

    this.logger.info(
      `Running codex review (${readPaths.length} file(s), prompt ${fullPrompt.length} chars, model ${codexModel})...`,
    );

    return spawnCodexWithStdin("codex", args, fullPrompt, {
      cwd: this.projectDir,
      timeoutMs: REVIEW_TIMEOUT_MS,
      maxStdoutBytes: MAX_CODEX_STDOUT_BYTES,
      logger: this.logger,
    });
  }

  // ----------------------------------------------------------------
  // Private: structured parsing
  // ----------------------------------------------------------------

  /**
   * Parse a structured JSON response from Codex output.
   * Looks for ```json fences or raw JSON object in the output.
   * Returns parsed fields if valid, or { valid: false } if not.
   */
  private parseStructuredResponse(
    output: string,
  ): { valid: true; verdict: CodexVerdict; issues: string[]; summary: string } | { valid: false } {
    // Try to extract JSON from ```json fences first
    const fenceMatch = output.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    let jsonStr = fenceMatch?.[1]?.trim();

    // Fall back to finding a raw JSON object containing "review_performed".
    // The previous regex /\{[\s\S]*?"review_performed"[\s\S]*?\}/ was broken:
    // the non-greedy *? after "review_performed" stops at the FIRST },
    // which may be a nested object's closing brace (H13).
    // Instead, search backwards from "review_performed" for opening braces
    // and try JSON.parse progressively until we find valid JSON.
    if (!jsonStr) {
      const idx = output.indexOf('"review_performed"');
      if (idx !== -1) {
        let braceStart = output.lastIndexOf("{", idx);
        while (braceStart >= 0) {
          // H13 fix: Extract a balanced JSON object using depth tracking
          // instead of JSON.parse(substring) which fails when valid JSON
          // is followed by trailing text (JSON.parse rejects trailing content).
          const balanced = extractBalancedJsonObject(output, braceStart);
          if (balanced) {
            try {
              JSON.parse(balanced);
              jsonStr = balanced;
              break;
            } catch {
              // Balanced but not valid JSON; try earlier brace
            }
          }
          braceStart = output.lastIndexOf("{", braceStart - 1);
        }
      }
    }

    if (!jsonStr) {
      this.logger.debug("No JSON found in Codex output");
      return { valid: false };
    }

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      // Validate required fields
      if (parsed.review_performed !== true) {
        this.logger.debug("review_performed is not true");
        return { valid: false };
      }

      if (typeof parsed.verdict !== "string" || !VALID_VERDICTS.has(parsed.verdict)) {
        this.logger.debug(`Invalid verdict: ${String(parsed.verdict)}`);
        return { valid: false };
      }

      if (!Array.isArray(parsed.issues)) {
        this.logger.debug("issues is not an array");
        return { valid: false };
      }

      // Map structured issues to string[] (extract description only).
      // v0.7.7: if `severity` is malformed, infer from a leading
      // `[CATEGORY]` tag in the description before falling back to
      // "unknown". Keeps the escalation filter in sync with Codex's
      // own sense of severity even when the JSON field is wrong.
      const validSeverities = new Set(["minor", "major", "critical"]);
      const issues: string[] = [];
      for (const issue of parsed.issues as Record<string, unknown>[]) {
        if (typeof issue === "object" && issue !== null && typeof issue.description === "string") {
          let severity: string;
          if (typeof issue.severity === "string" && validSeverities.has(issue.severity)) {
            severity = issue.severity;
          } else {
            const inferred = inferSeverityFromCategory(issue.description);
            severity = inferred ?? "unknown";
          }
          issues.push(`[${severity}] ${issue.description}`);
        }
      }

      const summary = typeof parsed.summary === "string" ? parsed.summary : "";
      let verdict = parsed.verdict as CodexVerdict;

      // v0.7.7 consistency guard #1: Codex contradicts itself by
      // emitting verdict:"APPROVE" alongside blocking issues. Trust the
      // issues (they're concrete), downgrade the verdict. Keeps
      // downstream approval gating honest.
      if (verdict === "APPROVE" && hasBlockingIssues(issues)) {
        this.logger.warn(
          `Codex returned APPROVE with ${issues.length} blocking issue(s); downgrading verdict to NEEDS_DISCUSSION.`,
        );
        verdict = "NEEDS_DISCUSSION" as CodexVerdict;
      }

      // v0.7.7 consistency guard #2: non-APPROVE verdict with no parsed
      // issues is degenerate — nothing for the investigator to respond
      // to. Flag as invalid so withRetryOnInvalidResponse takes a
      // second pass.
      if (verdict !== "APPROVE" && issues.length === 0) {
        this.logger.debug(
          `Non-APPROVE verdict (${verdict}) with empty issues array; treating as invalid for retry.`,
        );
        return { valid: false };
      }

      return {
        valid: true,
        verdict,
        issues,
        summary,
      };
    } catch (err) {
      this.logger.debug(`JSON parse failed: ${String(err)}`);
      return { valid: false };
    }
  }

  // ----------------------------------------------------------------
  // Private: helpers
  // ----------------------------------------------------------------

  /**
   * Build a CodexReviewResult from raw output using structured JSON parsing.
   */
  private buildResult(output: string, filePath: string): CodexReviewResult {
    const parsed = this.parseStructuredResponse(output);

    if (parsed.valid) {
      this.logger.info(`Codex verdict: ${parsed.verdict} (${parsed.issues.length} issue(s))`);
      return {
        verdict: parsed.verdict,
        raw_output: output,
        issues: parsed.issues,
        file_path: filePath,
      };
    }

    // Invalid JSON — return NO_VERDICT so the retry wrapper can handle it
    this.logger.warn("Codex output did not contain valid structured JSON response");
    return {
      verdict: "NO_VERDICT",
      raw_output: output,
      issues: [],
      file_path: filePath,
    };
  }

  /**
   * Save the raw review output to the codex-reviews/ directory.
   * Throws on write failure so callers know the review wasn't persisted.
   */
  private async saveReview(
    result: CodexReviewResult,
    prefix: string,
  ): Promise<void> {
    const reviewsDir = getCodexReviewsDir(this.projectDir);

    // Ensure directory exists
    await mkdirSecure(reviewsDir, { recursive: true }); // H-2

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${prefix}-${timestamp}.md`;
    const filePath = path.join(reviewsDir, filename);

    const content = [
      `# Codex Review: ${prefix}`,
      ``,
      `**Verdict:** ${result.verdict}`,
      `**Reviewed:** ${result.file_path}`,
      `**Timestamp:** ${new Date().toISOString()}`,
      ``,
      `## Raw Output`,
      ``,
      result.raw_output,
      ``,
    ].join("\n");

    try {
      // A-R1 (v0.7.5): atomic write via writeJsonAtomic — tmp + fsync +
      // rename + chmod to 0o600. Previously fs.writeFile which could lose
      // review content on crash mid-save. writeJsonAtomic is content-agnostic
      // despite the name; works for the Markdown content here.
      await writeJsonAtomic(filePath, content);
      this.logger.info(`Saved review to ${filePath}`);
    } catch (err) {
      this.logger.error(`Failed to save review to ${filePath}: ${String(err)}`);
      throw err; // Propagate so caller knows
    }
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * H13 fix: Extract a balanced JSON object from text starting at the given
 * position. Uses depth tracking to find the matching closing brace,
 * respecting string literals and escape sequences.
 *
 * This avoids JSON.parse(output.substring(start)) which fails when the
 * valid JSON is followed by trailing text (JSON.parse rejects any
 * non-whitespace content after the root value).
 *
 * Exported for testing.
 */
export function extractBalancedJsonObject(text: string, start: number): string | null {
  if (start < 0 || start >= text.length || text[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.substring(start, i + 1);
      }
    }
  }

  return null;
}

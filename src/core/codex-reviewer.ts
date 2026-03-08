import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

import type { CodexReviewResult, CodexVerdict, CodexUsageMetrics } from "../utils/types.js";
import { getCodexReviewsDir } from "../utils/constants.js";
import type { Logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

/** Timeout for each codex review invocation: 5 minutes. */
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

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
    public readonly reason: "not_found" | "timeout" | "crash",
    public readonly partialOutput?: string,
  ) {
    super(message);
    this.name = "CodexExecutionError";
  }
}

export class CodexReviewer {
  private projectDir: string;
  private orchestratorDir: string;
  private mcpServerPath: string;
  private logger: Logger;
  private metrics: CodexUsageMetrics = {
    invocations: 0,
    successes: 0,
    invalid_responses: 0,
    presumed_rate_limits: 0,
    last_presumed_rate_limit_at: null,
  };

  constructor(
    projectDir: string,
    orchestratorDir: string,
    mcpServerPath: string,
    logger: Logger,
  ) {
    this.projectDir = projectDir;
    this.orchestratorDir = orchestratorDir;
    this.mcpServerPath = mcpServerPath;
    this.logger = logger;
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
   */
  async reviewPlan(planPath: string): Promise<CodexReviewResult> {
    return this.withRetryOnInvalidResponse(async () => {
      const prompt =
        "Review this implementation plan for completeness, correctness, and potential issues. " +
        "For each issue, provide a clear description. " +
        "You have access to the `coordinator` MCP server with tools: get_tasks, get_contracts, get_decisions, read_updates. " +
        "Use these to understand the full context of the project's coordination state." +
        JSON_FORMAT_INSTRUCTIONS;

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
  ): Promise<CodexReviewResult> {
    return this.withRetryOnInvalidResponse(async () => {
      const prompt =
        "You previously reviewed this plan and raised concerns. " +
        "The planner has responded to your concerns. Review the updated plan and the response. " +
        "For each remaining issue, provide a clear description. " +
        "You have access to the `coordinator` MCP server with tools: get_tasks, get_contracts, get_decisions, read_updates. " +
        "Use these to understand the full context." +
        JSON_FORMAT_INSTRUCTIONS;

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
  ): Promise<CodexReviewResult> {
    return this.withRetryOnInvalidResponse(async () => {
      const prompt =
        `Review the code changes for the following task:\n\n${taskDescription}\n\n` +
        "Compare the implementation against the plan and the diff. " +
        "Check for correctness, completeness, style, and potential bugs. " +
        "For each issue, provide a clear description. " +
        "You have access to the `coordinator` MCP server with tools: get_tasks, get_contracts, get_decisions, read_updates. " +
        "Use these to see task statuses, contracts between workers, and architectural decisions." +
        JSON_FORMAT_INSTRUCTIONS;

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
  ): Promise<CodexReviewResult> {
    return this.withRetryOnInvalidResponse(async () => {
      const prompt =
        "You previously reviewed code and requested fixes. " +
        "The developer has responded and made changes. Review the updated files and their response. " +
        "For each remaining issue, provide a clear description. " +
        "You have access to the `coordinator` MCP server with tools: get_tasks, get_contracts, get_decisions, read_updates. " +
        "Use these to verify the full context." +
        JSON_FORMAT_INSTRUCTIONS;

      const output = await this.runCodex(prompt, [reviewResponsePath, changedFilesPath]);
      const result = this.buildResult(output, changedFilesPath);
      await this.saveReview(result, "code-re-review");
      return result;
    }, "code-re-review");
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

    // Both attempts failed — classify by the SECOND attempt's failure mode.
    // If 2nd attempt had an execution error (timeout/crash/no-output) → RATE_LIMITED.
    // If 2nd attempt returned output but invalid JSON → ERROR (not rate limited).
    if (secondExecError) {
      this.metrics.presumed_rate_limits++;
      this.metrics.last_presumed_rate_limit_at = new Date().toISOString();
      this.logger.error(
        `[${label}] Codex failed on second attempt with execution error (${secondExecError.reason}). Presuming rate limit.`,
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
   * Reads files from disk and includes their contents in the prompt.
   * Returns the raw stdout on success.
   * THROWS CodexExecutionError on failure instead of returning error strings.
   */
  private async runCodex(prompt: string, readPaths: string[]): Promise<string> {
    // Read file contents and append to prompt
    const fileContents: string[] = [];
    for (const p of readPaths) {
      try {
        const content = await fs.readFile(p, "utf-8");
        const basename = path.basename(p);
        fileContents.push(`\n\n## File: ${basename}\n\n\`\`\`\n${content}\n\`\`\``);
      } catch (err) {
        this.logger.warn(`Could not read file ${p}: ${String(err)}`);
      }
    }

    const fullPrompt = prompt + fileContents.join("");

    // Use --full-auto for non-interactive review
    // No --sandbox since Codex needs MCP tool access (MCP tools are read-only anyway)
    // Configure the coordinator MCP server so review prompts can access
    // get_tasks, get_contracts, get_decisions, and read_updates tools.
    const args: string[] = [
      "exec",
      "--full-auto",
      "-C", this.projectDir,
      "-c", 'mcp_servers.coordinator.command="node"',
      "-c", `mcp_servers.coordinator.args=[${JSON.stringify(this.mcpServerPath)}]`,
      "-c", `mcp_servers.coordinator.env.CONDUCTOR_DIR=${JSON.stringify(this.orchestratorDir)}`,
      "-c", 'mcp_servers.coordinator.env.SESSION_ID="codex-reviewer"',
      "-c", "mcp_servers.coordinator.startup_timeout_sec=10",
      "-c", "mcp_servers.coordinator.tool_timeout_sec=30",
      "-c", "mcp_servers.coordinator.enabled=true",
      "-c", "mcp_servers.coordinator.required=false",
      fullPrompt,
    ];

    this.logger.info(`Running codex review (${readPaths.length} file(s), prompt ${fullPrompt.length} chars)...`);

    try {
      const { stdout, stderr } = await execFileAsync("codex", args, {
        timeout: REVIEW_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        cwd: this.projectDir,
      });

      if (stderr) {
        this.logger.debug(`codex stderr: ${stderr.trim()}`);
      }

      return stdout;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };

      if (error.code === "ENOENT") {
        this.logger.error("Codex CLI not found — is it installed and on PATH?");
        throw new CodexExecutionError(
          "Codex CLI not found. Please install codex.",
          "not_found",
        );
      }

      if (error.killed) {
        this.logger.error("Codex review timed out after 5 minutes");
        throw new CodexExecutionError(
          "Codex review timed out after 5 minutes.",
          "timeout",
          error.stdout,
        );
      }

      // Codex may exit non-zero but still produce useful output
      if (error.stdout && error.stdout.trim().length > 0) {
        this.logger.warn(
          `Codex exited with error but produced output (${error.stdout.length} chars). stderr: ${error.stderr?.trim() ?? ""}`,
        );
        return error.stdout;
      }

      this.logger.error(`Codex execution failed: ${String(err)}`);
      throw new CodexExecutionError(
        `Codex execution failed: ${String(err)}`,
        "crash",
        error.stderr,
      );
    }
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

    // Fall back to finding a raw JSON object (non-greedy to avoid over-capture)
    if (!jsonStr) {
      const rawMatch = output.match(/\{[\s\S]*?"review_performed"[\s\S]*?\}/);
      jsonStr = rawMatch?.[0];
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

      // Map structured issues to string[] (extract description only)
      const validSeverities = new Set(["minor", "major", "critical"]);
      const issues: string[] = [];
      for (const issue of parsed.issues as Record<string, unknown>[]) {
        if (typeof issue === "object" && issue !== null && typeof issue.description === "string") {
          const severity = typeof issue.severity === "string" && validSeverities.has(issue.severity)
            ? issue.severity
            : "unknown";
          issues.push(`[${severity}] ${issue.description}`);
        }
      }

      const summary = typeof parsed.summary === "string" ? parsed.summary : "";

      return {
        valid: true,
        verdict: parsed.verdict as CodexVerdict,
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
    await fs.mkdir(reviewsDir, { recursive: true });

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
      // Use secure permissions: mode 0o600 for file (owner rw only)
      await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
      this.logger.info(`Saved review to ${filePath}`);
    } catch (err) {
      this.logger.error(`Failed to save review to ${filePath}: ${String(err)}`);
      throw err; // Propagate so caller knows
    }
  }
}

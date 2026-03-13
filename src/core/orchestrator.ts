import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import chalk from "chalk";
import { queryWithTimeout } from "../utils/sdk-timeout.js";
import { logProgress } from "../utils/progress.js";

import type {
  CLIOptions,
  ExecutionWorkerManager,
  CodexReviewResult,
  CycleRecord,
  PhaseDurations,
  BlastRadius,
  FlowTracingReport,
  PlannerOutput,
  Task,
  TaskDefinition,
  ProjectConventions,
  ThreatModel,
  KnownIssue,
  ProviderUsageMonitor,
  UsageSnapshot,
  WorkerRuntime,
  ProjectProfile,
  ModelConfig,
} from "../utils/types.js";
import { MODEL_TIER_TO_ID, ConductorExitError } from "../utils/types.js";

import {
  BRANCH_PREFIX,
  getLogsDir,
  getMessagesDir,
  getOrchestratorDir,
  getPlanPath,
  getCodexReviewsDir,
  getEscalationPath,
  getPauseSignalPath,
  MAX_PLAN_DISCUSSION_ROUNDS,
  MAX_CODE_REVIEW_ROUNDS,
  MAX_DISAGREEMENT_ROUNDS,
  CODEX_RATE_LIMIT_BACKOFF_MS,
  DEFAULT_WORKER_POLL_INTERVAL_MS,
  WIND_DOWN_GRACE_PERIOD_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  USAGE_STALE_CRITICAL_MS,
  getTasksDraftPath,
  getFlowTracingSummaryPath,
  getKnownIssuesPath,
} from "../utils/constants.js";

import { Logger } from "../utils/logger.js";
import { GitManager } from "../utils/git.js";
import { StateManager } from "./state-manager.js";
import { UsageMonitor } from "./usage-monitor.js";
import { CodexUsageMonitor } from "./codex-usage-monitor.js";
import { CodexReviewer } from "./codex-reviewer.js";
import { Planner } from "./planner.js";
import { WorkerManager } from "./worker-manager.js";
import { CodexWorkerManager } from "./codex-worker-manager.js";
import { FlowTracer } from "./flow-tracer.js";
import { extractConventions } from "../utils/conventions-extractor.js";
import { loadWorkerRules } from "../utils/rules-loader.js";
import { addKnownIssues, getUnresolvedIssues } from "../utils/known-issues.js";
import { ensureGitignore } from "../utils/gitignore.js";
import {
  detectProject,
  loadCachedProfile,
  cacheProfile,
  formatProjectGuidance,
} from "./project-detector.js";
import {
  EventLog,
  recordPhaseStart,
  recordPhaseEnd,
  recordWorkerSpawn,
  recordWorkerFail,
  recordWorkerTimeout,
  recordReviewVerdict,
  recordUsageWarning,
  recordProjectDetection,
} from "./event-log.js";

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

// ============================================================
// Orchestrator
// ============================================================

export class Orchestrator {
  private state: StateManager;
  private claudeUsage: UsageMonitor;
  private codexUsage: CodexUsageMonitor;
  private codex: CodexReviewer;
  private planner: Planner;
  private workers: ExecutionWorkerManager;
  private flowTracer: FlowTracer;
  private git: GitManager;
  private logger: Logger;
  private options: CLIOptions;

  // V2: Structured event logging
  private eventLog: EventLog;

  // Stores the Q&A context gathered during initialization
  private qaContext: string = "";

  // Project conventions extracted pre-execution
  private conventions: ProjectConventions | null = null;
  private projectRules: string = "";
  private threatModel: ThreatModel | null = null;

  // V2: Auto-detected project profile
  private projectProfile: ProjectProfile | null = null;

  // Stores any user redirect guidance gathered during escalation
  private redirectGuidance: string | null = null;

  // Tracks Codex review results for accurate cycle records
  private lastPlanDiscussionRounds: number = 0;
  private lastPlanApproved: boolean = false;
  private lastCodeReviewRounds: number = 0;

  // Tracks the base branch for diffing
  private baseBranch: string = "main";

  // Tracks whether usage reached critical during execution
  private usageCritical: boolean = false;
  private usageCriticalResetsAt: string = "unknown";

  // Tracks whether a user-requested pause was detected
  private userPauseRequested: boolean = false;

  // Tracks provider rate-limit signals emitted by execution workers
  private executionRateLimit: { provider: WorkerRuntime; detail: string; resetsAt: string | null } | null = null;

  constructor(options: CLIOptions) {
    this.options = options;

    if (options.verbose) {
      process.env.VERBOSE = "1";
    }

    const logsDir = getLogsDir(options.project);
    this.logger = new Logger(logsDir, "conductor");

    this.state = new StateManager(options.project);

    this.git = new GitManager(options.project);

    const orchestratorDir = getOrchestratorDir(options.project);

    // Resolve the MCP coordination server path relative to this package's
    // dist/ directory (not the user's project). This works whether the
    // package is installed globally, linked, or run via npx.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const mcpServerPath = path.join(__dirname, "..", "mcp", "coordination-server.js");

    this.codex = new CodexReviewer(options.project, orchestratorDir, mcpServerPath, this.logger);
    this.planner = new Planner(
      options.project,
      this.logger,
      MODEL_TIER_TO_ID[options.modelConfig.worker],
      options.modelConfig.extendedContext,
    );

    this.claudeUsage = new UsageMonitor({
      threshold: options.usageThreshold,
      onWarning: (utilization) => {
        this.logger.warn(
          `Claude usage warning: ${(utilization * 100).toFixed(1)}% of 5-hour window consumed`,
        );
      },
      onCritical: (utilization, resetsAt) => {
        this.logger.error(
          `Claude usage CRITICAL: ${(utilization * 100).toFixed(1)}% consumed, resets at ${resetsAt}`,
        );
        this.usageCritical = true;
        this.usageCriticalResetsAt = resetsAt;
      },
      logger: this.logger,
    });

    this.codexUsage = new CodexUsageMonitor({
      threshold: options.usageThreshold,
      onWarning: (utilization) => {
        this.logger.warn(
          `Codex usage warning: ${(utilization * 100).toFixed(1)}% of 5-hour window consumed`,
        );
      },
      onCritical: (utilization, resetsAt) => {
        this.logger.error(
          `Codex usage CRITICAL: ${(utilization * 100).toFixed(1)}% consumed, resets at ${resetsAt}`,
        );
        this.usageCritical = true;
        this.usageCriticalResetsAt = resetsAt;
      },
      logger: this.logger,
    });

    this.workers = options.workerRuntime === "codex"
      ? new CodexWorkerManager(
          options.project,
          orchestratorDir,
          mcpServerPath,
          this.logger,
        )
      : new WorkerManager(
          options.project,
          orchestratorDir,
          mcpServerPath,
          this.logger,
          options.modelConfig,
        );

    this.flowTracer = new FlowTracer(
      options.project,
      this.logger,
      MODEL_TIER_TO_ID[options.modelConfig.worker],
      options.modelConfig.extendedContext,
    );

    // V2: Initialize event logging
    this.eventLog = new EventLog(options.project);
  }

  // ================================================================
  // Main entry point
  // ================================================================

  async run(): Promise<void> {
    // V2: Start event logging
    this.eventLog.start();

    try {
      await this.initialize();

      if (this.state.get().status === "paused") {
        return;
      }

      let planVersion = 1;
      const state = this.state.get();

      // On resume, check if tasks already exist — if so, skip planning
      // for the first cycle and go straight to execution.
      let skipPlanningThisCycle = false;
      if (this.options.resume) {
        const existingTasks = await this.state.getAllTasks();
        const hasPendingOrInProgress = existingTasks.some(
          (t) => t.status === "pending" || t.status === "in_progress",
        );
        if (hasPendingOrInProgress) {
          skipPlanningThisCycle = true;
          // Infer plan version from cycle history
          if (state.cycle_history.length > 0) {
            planVersion = state.cycle_history[state.cycle_history.length - 1].plan_version;
          }
          this.logger.info(
            `Resuming with ${existingTasks.length} existing task(s) — skipping planning phase`,
          );
        }
      }

      while (state.current_cycle < state.max_cycles) {
        // Clear stale orchestrator messages from previous cycles to avoid
        // workers picking up old wind_down signals at the start of a new cycle
        await this.clearStaleOrchestratorMessages();

        const cycleStart = Date.now();
        const cycleNum = state.current_cycle + 1;

        this.logger.info(`\n${"=".repeat(60)}`);
        this.logger.info(`  CYCLE ${cycleNum} of ${state.max_cycles}`);
        this.logger.info(`${"=".repeat(60)}\n`);

        // Phase timing tracker
        const phaseDurations: PhaseDurations = {};

        // Phase 1: Planning (skip on resume if tasks already exist)
        if (skipPlanningThisCycle) {
          skipPlanningThisCycle = false; // only skip once
          phaseDurations.planning_ms = 0; // Set to 0 when skipped (#26h)
          this.logger.info("Skipping planning phase (resuming with existing tasks).");
        } else {
          // Delete stale tasks-draft.json before planning (#4)
          // The orchestrator is the sole owner of this file's lifecycle.
          try {
            await fs.unlink(getTasksDraftPath(this.options.project));
          } catch {
            // File doesn't exist — that's fine
          }

          const planStart = Date.now();
          planVersion = await this.plan(planVersion, cycleNum > 1, cycleNum);
          phaseDurations.planning_ms = Date.now() - planStart;
        }

        // If dry run, print plan and exit
        if (this.options.dryRun) {
          const planPath = getPlanPath(this.options.project, planVersion);
          try {
            const planContent = await fs.readFile(planPath, "utf-8");
            console.log("\n" + chalk.bold.cyan("=== DRY RUN: Plan Output ===") + "\n");
            console.log(planContent);
            console.log("\n" + chalk.bold.cyan("=== End of Plan ===") + "\n");
          } catch {
            this.logger.warn("Could not read plan file for dry run display");
          }
          this.logger.info("Dry run complete. Exiting without executing.");
          return;
        }

        // Extract project conventions (pre-execution phase)
        const conventionsStart = Date.now();
        await this.state.setProgress("Conventions: extracting project patterns...");
        await logProgress(this.options.project, "conventions", "Extracting project patterns");
        this.logger.info("Extracting project conventions...");
        const canExtractConventions = await this.ensureProviderCapacity("claude", "conventions extraction");
        if (!canExtractConventions) {
          return;
        }
        const workerModelId = MODEL_TIER_TO_ID[this.options.modelConfig.worker];
        this.conventions = await extractConventions(this.options.project, workerModelId, this.options.modelConfig.extendedContext);
        this.projectRules = await loadWorkerRules(this.options.project);
        phaseDurations.conventions_ms = Date.now() - conventionsStart;

        // Pass context to worker manager
        this.workers.setWorkerContext({
          qaContext: this.qaContext,
          conventions: this.conventions,
          projectRules: this.projectRules,
          featureDescription: this.options.feature,
          threatModelSummary: this.threatModel
            ? this.formatThreatModelForWorkers(this.threatModel)
            : undefined,
          // V2: Auto-detected project guidance
          projectGuidance: this.projectProfile
            ? formatProjectGuidance(this.projectProfile)
            : undefined,
        });

        // Phase 2: Execution
        const executionStart = Date.now();
        await this.execute();
        phaseDurations.execution_ms = Date.now() - executionStart;

        if (this.state.get().status === "paused") {
          return;
        }

        if (this.executionRateLimit) {
          const { provider, detail, resetsAt } = this.executionRateLimit;
          this.executionRateLimit = null;
          await this.handleProviderRateLimit(provider, detail, resetsAt);
          // handleProviderRateLimit waits for reset and auto-resumes;
          // skip replanning — existing tasks are still valid.
          skipPlanningThisCycle = true;
          continue;
        }

        const codexReviewAvailable = this.options.skipCodex
          ? false
          : await this.codex.isAvailable();
        const canStartCodeReview = !codexReviewAvailable
          ? true
          : await this.ensureProviderCapacity("codex", "code review");
        if (!canStartCodeReview) {
          return;
        }

        const canStartFlowReview = this.options.skipFlowReview
          ? true
          : await this.ensureProviderCapacity("claude", "flow tracing");
        if (!canStartFlowReview) {
          return;
        }

        // Phase 3: Code review and flow tracing in parallel (both are read-only)
        // Set status ONCE before Promise.all to avoid concurrent setStatus/save
        // race condition (C2 fix). Individual review()/flowReview() methods must
        // NOT call setStatus — only setProgress (which is informational/idempotent).
        await this.state.setStatus("reviewing");

        // Use separate start timestamps for accurate per-phase duration tracking
        const reviewStart = Date.now();
        const flowStart = Date.now();
        const [approved, flowReport] = await Promise.all([
          this.review().then((r) => { phaseDurations.code_review_ms = Date.now() - reviewStart; return r; }),
          this.flowReview(cycleNum).then((r) => { phaseDurations.flow_tracing_ms = Date.now() - flowStart; return r; }),
        ]);



        // Track findings in known issues registry
        if (flowReport && flowReport.findings.length > 0) {
          await addKnownIssues(this.options.project, flowReport.findings.map((f) => ({
            description: `${f.title}: ${f.description}`,
            severity: f.severity,
            source: "flow_tracing" as const,
            file_path: f.file_path,
            found_in_cycle: cycleNum,
          })));
        }

        // Phase 4: Checkpoint
        const checkpointStart = Date.now();
        let result = await this.checkpoint();
        phaseDurations.checkpoint_ms = Date.now() - checkpointStart;

        // If flow tracing found critical/high issues, force another cycle
        if (flowReport && (flowReport.summary.critical > 0 || flowReport.summary.high > 0)) {
          this.logger.warn(
            `Flow tracing found ${flowReport.summary.critical} critical and ${flowReport.summary.high} high severity issues. Forcing another cycle.`,
          );
          // Create fix tasks from flow findings
          await this.createFixTasksFromFindings(flowReport);
          result = "continue";
        }

        // If code review was not approved, force another cycle
        if (!approved && result === "complete") {
          this.logger.warn("Code review not approved. Forcing another cycle.");
          result = "continue";
        }

        // Record cycle
        const completedTasks = await this.state.getTasksByStatus("completed");
        const failedTasks = await this.state.getTasksByStatus("failed");

        // Log phase durations
        this.logger.info("Phase durations: " + Object.entries(phaseDurations)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k.replace("_ms", "")}: ${Math.round(v! / 1000)}s`)
          .join(", "));

        // Compute blast radius from completed tasks
        const blastRadius = await this.computeBlastRadius(completedTasks);

        const cycleRecord: CycleRecord = {
          cycle: cycleNum,
          plan_version: planVersion,
          tasks_completed: completedTasks.length,
          tasks_failed: failedTasks.length,
          codex_plan_approved: this.lastPlanApproved,
          codex_code_approved: approved,
          plan_discussion_rounds: this.lastPlanDiscussionRounds,
          code_review_rounds: this.lastCodeReviewRounds,
          duration_ms: Date.now() - cycleStart,
          started_at: new Date(cycleStart).toISOString(),
          completed_at: new Date().toISOString(),
          flow_tracing: flowReport
            ? FlowTracer.toSummary(flowReport, phaseDurations.flow_tracing_ms ?? 0)
            : undefined,
          phase_durations: phaseDurations,
          blast_radius: blastRadius,
        };
        await this.state.recordCycle(cycleRecord);

        if (result === "complete") {
          await this.complete();
          return;
        }

        if (result === "pause") {
          await this.handleUsagePause();
          // For user-requested pause, handleUsagePause returns immediately
          // (or exits the process in non-interactive mode). Check if we're
          // still paused — if so, stop the cycle loop.
          if (this.state.get().status === "paused") {
            return;
          }
          // For usage-triggered pause, handleUsagePause waits for reset
          // then resumes. Continue to next cycle.
          continue;
        }

        if (result === "escalate") {
          const escalationResult = await this.escalateToUser(
            "Cycle limit or persistent issues",
            `Completed ${cycleNum} cycle(s). Some tasks may remain incomplete.`,
          );

          if (escalationResult === "stop") {
            this.logger.info("User requested stop. Finishing up.");
            await this.complete();
            return;
          }

          if (escalationResult === "redirect") {
            // redirectGuidance was set in escalateToUser
            this.logger.info("User provided new guidance. Replanning in next cycle.");
          }

          // "continue" falls through to next cycle
        }

        // Increment cycle and persist immediately to ensure it survives crashes
        state.current_cycle = cycleNum;
        await this.state.save();
      }

      // Exhausted all cycles
      this.logger.warn("Maximum cycles reached. Completing with current state.");
      await this.complete();
    } catch (err) {
      if (err instanceof ConductorExitError) {
        // Let the error propagate — CLI layer will handle process.exit
        // after the finally block runs cleanup (event log flush, state save).
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Conductor failed: ${message}`);
      try {
        await this.state.setStatus("failed");
      } catch {
        // Best effort
      }
      throw err;
    } finally {
      // V2: Stop event logging and flush remaining events
      await this.eventLog.stop();
    }
  }

  // ================================================================
  // Phase 0: Interactive Initialization
  // ================================================================

  private async initialize(): Promise<void> {
    const initStartTime = Date.now();
    recordPhaseStart(this.eventLog, "initialize");

    this.logger.info("Initializing conductor...");
    await logProgress(this.options.project, "initializing", "Creating directory structure");

    // Create directory structure
    await this.state.createDirectories();

    // Ensure conductor artifacts are in .gitignore
    await ensureGitignore(this.options.project);

    if (this.options.resume) {
      // Resume from existing state
      this.logger.info("Resuming from existing state...");
      const loaded = await this.state.load();

      if (loaded.base_commit_sha) {
        // Was started with --current-branch; use the saved commit SHA for diffs
        this.baseBranch = loaded.base_commit_sha;
      } else {
        this.baseBranch = loaded.branch.replace(BRANCH_PREFIX, "");
      }

      // Checkout the existing orchestration branch (skip if using current branch)
      if (!loaded.base_commit_sha) {
        try {
          await this.git.checkout(loaded.branch);
        } catch {
          this.logger.warn(`Could not checkout branch ${loaded.branch}; continuing on current branch`);
        }
      }

      if (this.options.forceResume && loaded.status !== "paused" && loaded.status !== "escalated") {
        this.logger.warn(
          `Force-resuming stale conductor state '${loaded.status}'. Any dead workers will be reset.`,
        );
      }

      // Log warning if Codex was recently rate-limited
      if (loaded.codex_metrics?.last_presumed_rate_limit_at) {
        const limitedAt = new Date(loaded.codex_metrics.last_presumed_rate_limit_at).getTime();
        const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
        if (limitedAt > fiveHoursAgo) {
          this.logger.warn(
            `Codex was rate-limited at ${loaded.codex_metrics.last_presumed_rate_limit_at}. ` +
            `Rate limit may still be in effect.`,
          );
        }
      }

      await this.ensureExecutionRuntimeAvailable();
      await this.clearPauseSignalIfPresent(this.options.forceResume ? "force-resume" : "resume");

      // V2: Load cached project profile on resume
      try {
        this.projectProfile = await loadCachedProfile(this.options.project);
        if (this.projectProfile) {
          this.logger.info(`Loaded cached project profile from ${this.projectProfile.detected_at}`);
        }
      } catch (err) {
        this.logger.warn(`Failed to load cached project profile: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!this.options.skipCodex) {
        await this.setupCodexMcpConfig();
      }
      await this.state.resume(this.options.workerRuntime);
      this.logger.info(`Resumed conductor for: ${loaded.feature}`);
      return;
    }

    // Fresh initialization
    if (this.options.currentBranch) {
      // --current-branch mode: stay on current branch, record HEAD SHA for diffs
      let branchName: string;
      let sha: string;

      try {
        if (await this.git.isDetachedHead()) {
          throw new Error(
            "Cannot use --current-branch in detached HEAD state. " +
            "Please checkout a branch first.",
          );
        }
        branchName = await this.git.getCurrentBranch();
        sha = await this.git.getHeadSha();
      } catch (err) {
        if (err instanceof Error && err.message.includes("detached HEAD")) {
          throw err;
        }
        throw new Error(
          "Cannot use --current-branch: failed to read git state. " +
          "Ensure the repository has at least one commit. " +
          `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
      this.baseBranch = sha;

      await this.state.initialize(this.options.feature, branchName, {
        maxCycles: this.options.maxCycles,
        concurrency: this.options.concurrency,
        workerRuntime: this.options.workerRuntime,
        modelConfig: this.options.modelConfig,
        baseCommitSha: sha,
      });

      this.logger.info(`Using current branch: ${branchName} (base commit: ${sha.substring(0, 8)})`);
    } else {
      // Default: create orchestration branch
      const featureSlug = slugify(this.options.feature);
      const branchName = `${BRANCH_PREFIX}${featureSlug}`;

      // Capture base branch before creating the orchestration branch
      try {
        this.baseBranch = await this.git.getCurrentBranch();
      } catch {
        this.baseBranch = "main";
      }

      // Create orchestration branch
      try {
        await this.git.createBranch(branchName);
        this.logger.info(`Created branch: ${branchName}`);
      } catch {
        this.logger.warn(`Branch ${branchName} may already exist; attempting checkout`);
        try {
          await this.git.checkout(branchName);
        } catch {
          this.logger.warn(`Could not checkout ${branchName}; continuing on current branch`);
        }
      }

      // Initialize state
      await this.state.initialize(this.options.feature, branchName, {
        maxCycles: this.options.maxCycles,
        concurrency: this.options.concurrency,
        workerRuntime: this.options.workerRuntime,
        modelConfig: this.options.modelConfig,
      });
    }

    await this.ensureExecutionRuntimeAvailable();

    // V2: Project auto-detection
    await this.state.setProgress("Initializing: detecting project configuration...");
    await logProgress(this.options.project, "initializing", "Detecting project configuration");

    try {
      // Try to load cached profile first
      this.projectProfile = await loadCachedProfile(this.options.project);

      if (!this.projectProfile) {
        // No cache - run detection
        this.logger.info("Running project auto-detection...");
        this.projectProfile = await detectProject(this.options.project);
        await cacheProfile(this.options.project, this.projectProfile);
        this.logger.info(
          `Detected: ${this.projectProfile.languages.join(", ")} project with ${this.projectProfile.frameworks.join(", ") || "no frameworks"}`
        );
      } else {
        this.logger.info(`Loaded cached project profile from ${this.projectProfile.detected_at}`);
      }
    } catch (err) {
      this.logger.warn(`Project detection failed: ${err instanceof Error ? err.message : String(err)}`);
      // Continue without project guidance
    }

    // Print welcome banner
    this.printBanner();

    // Phase: Questioning — either read from context file or run interactive Q&A
    if (this.options.contextFile) {
      // Non-interactive mode: read pre-gathered context from file
      await logProgress(this.options.project, "initializing", "Reading context file");
      this.logger.info(`Reading pre-gathered context from: ${this.options.contextFile}`);
      try {
        this.qaContext = await fs.readFile(this.options.contextFile, "utf-8");
        this.logger.info(`Loaded ${this.qaContext.length} chars of context from file`);
      } catch (err) {
        throw new Error(
          `Failed to read context file ${this.options.contextFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Interactive mode: ask questions via stdin
      await this.state.setStatus("questioning");
      await logProgress(this.options.project, "questioning", "Asking clarifying questions");
      const canAskQuestions = await this.ensureProviderCapacity("claude", "interactive questioning");
      if (!canAskQuestions) {
        return;
      }
      this.qaContext = await this.planner.askQuestions(this.options.feature);
    }

    // Set up Codex MCP config so Codex can access the coordination server
    await this.setupCodexMcpConfig();

    // V2: Record phase completion and project detection
    recordPhaseEnd(this.eventLog, "initialize", initStartTime);
    if (this.projectProfile) {
      recordProjectDetection(this.eventLog, this.projectProfile);
    }

    this.logger.info("Initialization complete.");
  }

  /**
   * Write a project-scoped `.codex/config.toml` so that Codex can access
   * the coordination MCP server during reviews. Codex runs with `-C projectDir`,
   * so it picks up this config automatically.
   */
  private async setupCodexMcpConfig(): Promise<void> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const mcpServerPath = path.resolve(
      path.join(__dirname, "..", "mcp", "coordination-server.js"),
    );
    const conductorDir = path.resolve(getOrchestratorDir(this.options.project));

    const configDir = path.join(this.options.project, ".codex");
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

    const toml = [
      "[mcp_servers.coordinator]",
      `command = "node"`,
      `args = [${JSON.stringify(mcpServerPath)}]`,
      `env = { CONDUCTOR_DIR = ${JSON.stringify(conductorDir)}, SESSION_ID = "codex-reviewer" }`,
      `startup_timeout_sec = 10`,
      `tool_timeout_sec = 30`,
      `enabled = true`,
      `required = false`,
      "",
    ].join("\n");

    const configPath = path.join(configDir, "config.toml");
    await fs.writeFile(configPath, toml, { encoding: "utf-8", mode: 0o600 });
    this.logger.debug(`Codex MCP config written to ${configPath}`);
  }

  private async ensureExecutionRuntimeAvailable(): Promise<void> {
    if (this.options.workerRuntime !== "codex") {
      return;
    }

    const codexAvailable = await this.codex.isAvailable();
    if (!codexAvailable) {
      throw new Error(
        "Codex CLI is required when --worker-runtime codex is selected. Install codex and ensure it is on PATH.",
      );
    }
  }

  private getExecutionUsageMonitor(): ProviderUsageMonitor {
    return this.getProviderUsageMonitor(this.options.workerRuntime);
  }

  private getProviderUsageMonitor(provider: WorkerRuntime): ProviderUsageMonitor {
    return provider === "codex" ? this.codexUsage : this.claudeUsage;
  }

  private async persistProviderUsage(provider: WorkerRuntime, usage: UsageSnapshot): Promise<void> {
    if (provider === "codex") {
      await this.state.updateCodexUsage(usage);
    } else {
      await this.state.updateClaudeUsage(usage);
    }

    if (provider === this.options.workerRuntime) {
      await this.state.updateUsage(usage);
    }
  }

  private async ensureExecutionCapacity(): Promise<boolean> {
    const provider = this.options.workerRuntime;
    const usageMonitor = this.getExecutionUsageMonitor();
    const snapshot = await usageMonitor.poll();
    await this.persistProviderUsage(provider, snapshot);

    if (!usageMonitor.isWindDownNeeded() && !usageMonitor.isCritical()) {
      return true;
    }

    this.usageCritical = usageMonitor.isCritical();
    this.usageCriticalResetsAt = usageMonitor.getResetTime() ?? "unknown";

    this.logger.warn(
      `${provider} usage is already ${(snapshot.five_hour * 100).toFixed(1)}% before execution. Pausing before spawning workers.`,
    );

    await this.handleUsagePause();
    return this.state.get().status !== "paused";
  }

  private async ensureProviderCapacity(provider: WorkerRuntime, phase: string): Promise<boolean> {
    const usageMonitor = this.getProviderUsageMonitor(provider);
    const snapshot = await usageMonitor.poll();
    await this.persistProviderUsage(provider, snapshot);

    // If usage data is critically stale, check if we have rate data to guide us.
    // The usage API has a ~5 request/token limit (GH #30930), so 429s are expected.
    if (usageMonitor.getStaleDurationMs() >= USAGE_STALE_CRITICAL_MS) {
      const staleMin = Math.round(usageMonitor.getStaleDurationMs() / 60_000);
      const failures = usageMonitor.getConsecutiveFailures();
      const hasRateData = usageMonitor.getUsageRatePerMinute() !== null;

      if (hasRateData) {
        // Trust rate prediction over stale absolute data
        this.logger.warn(
          `${provider} usage API stale (${staleMin}min, ${failures} failures) before ${phase}. ` +
          `Using rate prediction: ${usageMonitor.getRateSummary()}`
        );
        // Check if rate prediction says we'd exceed threshold
        if (usageMonitor.isThresholdPredicted()) {
          const detail = `${provider} rate prediction indicates threshold will be reached before ${phase}. ` +
            `(${usageMonitor.getRateSummary()})`;
          this.logger.warn(detail);
          await this.handleProviderRateLimit(provider, detail, usageMonitor.getResetTime());
          return true;
        }
      } else {
        // No rate data — safety-pause
        const detail =
          `${provider} usage data is critically stale (${staleMin}min, ${failures} consecutive failures) ` +
          `before ${phase} with no rate data. Cannot verify capacity — safety-pausing.`;
        this.logger.warn(detail);
        await this.handleProviderRateLimit(provider, detail, usageMonitor.getResetTime());
        return true;
      }
    } else if (usageMonitor.isDataStale()) {
      // Warn (but don't pause) if data is stale but below critical threshold
      const staleMin = Math.round(usageMonitor.getStaleDurationMs() / 60_000);
      this.logger.warn(
        `${provider} usage data is stale (${staleMin}min old, ` +
        `${usageMonitor.getConsecutiveFailures()} failures) before ${phase}. Proceeding with caution.`
      );
    }

    if (!usageMonitor.isWindDownNeeded() && !usageMonitor.isCritical()) {
      // Log rate prediction if available
      const rateSummary = usageMonitor.getRateSummary();
      if (rateSummary !== "rate: insufficient data") {
        this.logger.debug(`${provider} usage OK before ${phase} (${rateSummary})`);
      }
      return true;
    }

    const detail =
      `${provider} 5-hour usage is ${(snapshot.five_hour * 100).toFixed(1)}% ` +
      `before ${phase} (${usageMonitor.getRateSummary()}).`;
    await this.handleProviderRateLimit(provider, detail, usageMonitor.getResetTime());
    return true;
  }

  // ================================================================
  // Phase 1: Planning with Codex review
  // ================================================================

  private async plan(planVersion: number, isReplan: boolean, cycleNum?: number): Promise<number> {
    const planStartTime = Date.now();
    recordPhaseStart(this.eventLog, "planning");

    await this.state.setStatus("planning");
    await this.state.setProgress(`Planning: generating plan v${planVersion}...`);
    await logProgress(this.options.project, "planning", `Generating plan v${planVersion} (replan=${isReplan})`);
    this.logger.info(`Planning phase (version ${planVersion}, replan=${isReplan})...`);

    let planOutput: PlannerOutput;

    if (isReplan) {
      const canReplan = await this.ensureProviderCapacity("claude", `plan generation v${planVersion}`);
      if (!canReplan) {
        return planVersion;
      }
      const completedTasks = await this.state.getTasksByStatus("completed");
      const failedTasks = await this.state.getTasksByStatus("failed");
      const previousPlanPath = getPlanPath(this.options.project, planVersion - 1);

      // Include any redirect guidance from user escalation
      const codexFeedback = this.redirectGuidance;
      this.redirectGuidance = null;

      // Build cycle feedback from review issues, flow findings, and known issues
      const unresolvedIssues = await getUnresolvedIssues(this.options.project);
      const cycleFeedback = this.buildCycleFeedback(codexFeedback, null, unresolvedIssues, cycleNum);

      planOutput = await this.planner.replan(
        this.options.feature,
        previousPlanPath,
        completedTasks,
        failedTasks,
        codexFeedback,
        planVersion,
        cycleFeedback || undefined,
      );
    } else {
      const canCreatePlan = await this.ensureProviderCapacity("claude", `plan generation v${planVersion}`);
      if (!canCreatePlan) {
        return planVersion;
      }
      planOutput = await this.planner.createPlan(
        this.options.feature,
        this.qaContext,
        planVersion,
      );
    }

    // Store threat model if present in plan output
    if (planOutput.threat_model) {
      this.threatModel = planOutput.threat_model;
    }

    // Codex plan review (unless skipped)
    if (!this.options.skipCodex) {
      const codexAvailable = await this.codex.isAvailable();

      if (codexAvailable) {
        const canReviewPlan = await this.ensureProviderCapacity("codex", `plan review v${planVersion}`);
        if (!canReviewPlan) {
          return planVersion;
        }
        const planPath = getPlanPath(this.options.project, planVersion);
        let reviewResult = await this.retryCodexWithBackoff(
          () => this.codex.reviewPlan(planPath),
          "plan review",
        );

        let discussionRound = 0;
        const issueCounts = new Map<string, number>();

        while (
          reviewResult.verdict !== "APPROVE" &&
          reviewResult.verdict !== "ERROR" &&
          reviewResult.verdict !== "RATE_LIMITED" &&
          discussionRound < MAX_PLAN_DISCUSSION_ROUNDS
        ) {
          discussionRound++;
          await this.state.setProgress(`Planning: Codex review round ${discussionRound}/${MAX_PLAN_DISCUSSION_ROUNDS}`);
          await logProgress(this.options.project, "planning", `Codex plan review round ${discussionRound}/${MAX_PLAN_DISCUSSION_ROUNDS}`);
          this.logger.info(
            `Plan review round ${discussionRound}: verdict=${reviewResult.verdict}, ` +
            `${reviewResult.issues.length} issue(s)`,
          );

          // Track recurring issues
          for (const issue of reviewResult.issues) {
            const issueKey = issue.substring(0, 80);
            const count = (issueCounts.get(issueKey) ?? 0) + 1;
            issueCounts.set(issueKey, count);

            if (count >= MAX_DISAGREEMENT_ROUNDS) {
              this.logger.warn(`Persistent disagreement on issue: ${issueKey}`);
              const escalation = await this.escalateToUser(
                "Plan review disagreement",
                `Codex and planner disagree on: ${issue}\n\nCodex verdict: ${reviewResult.verdict}\n\nFull output:\n${reviewResult.raw_output}`,
              );

              if (escalation === "stop") {
                this.logger.info("User requested stop during plan review.");
                throw new Error("User stopped conductor during plan review");
              }
              // Clear the issue count to allow continued discussion
              issueCounts.set(issueKey, 0);
            }
          }

          // Spawn investigator to respond to Codex feedback
          await this.state.setProgress(`Planning: investigator responding to Codex feedback (round ${discussionRound})`);
          await logProgress(this.options.project, "planning", `Investigator responding to Codex feedback (round ${discussionRound})`);
          const canInvestigatePlanReview = await this.ensureProviderCapacity(
            "claude",
            `plan review investigation round ${discussionRound}`,
          );
          if (!canInvestigatePlanReview) {
            return planVersion;
          }
          const responsePath = path.join(
            getCodexReviewsDir(this.options.project),
            `plan-discussion-round-${discussionRound}.md`,
          );

          const investigatorPrompt = [
            "You are responding to a code review from Codex (OpenAI).",
            "Review the feedback and either update the plan or explain why the current approach is correct.",
            "",
            "## Codex Feedback",
            "",
            reviewResult.raw_output,
            "",
            "## Instructions",
            "",
            "1. Read the current plan and the codebase to understand the context.",
            "2. For each issue raised, either:",
            "   a. Agree and describe the fix needed, OR",
            "   b. Explain why the current approach is correct.",
            "3. If fixes are needed, update the plan file accordingly.",
            "4. Provide a clear, structured response addressing each point.",
          ].join("\n");

          let responseText = await queryWithTimeout(
            investigatorPrompt,
            { allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "LSP"], cwd: this.options.project, maxTurns: 20, settingSources: ["project"] },
            10 * 60 * 1000, // 10 min
            `plan-investigator-round-${discussionRound}`,
          );

          // Guard against empty investigator response
          if (!responseText || responseText.trim().length === 0) {
            this.logger.warn("Investigator agent produced empty response. Writing fallback.");
            responseText = "The plan has been updated to address all feedback. Please re-review the plan file directly for the latest changes.";
          }

          // Save the response
          await fs.writeFile(responsePath, responseText, { encoding: "utf-8", mode: 0o600 });
          this.logger.debug(`Discussion response saved to ${responsePath}`);

          // Re-review with the response
          const canReReviewPlan = await this.ensureProviderCapacity(
            "codex",
            `plan re-review round ${discussionRound}`,
          );
          if (!canReReviewPlan) {
            return planVersion;
          }
          reviewResult = await this.retryCodexWithBackoff(
            () => this.codex.reReviewPlan(planPath, responsePath),
            `plan re-review round ${discussionRound}`,
          );
        }

        // Persist metrics after plan review
        await this.state.updateCodexMetrics(this.codex.getMetrics());

        // Track for cycle record
        this.lastPlanDiscussionRounds = discussionRound;
        this.lastPlanApproved = reviewResult.verdict === "APPROVE";

        if (reviewResult.verdict === "APPROVE") {
          this.logger.info("Codex APPROVED the plan.");
        } else if (reviewResult.verdict === "ERROR") {
          this.logger.error(
            "Codex plan review errored out. Plan was NOT reviewed by Codex.",
          );
        } else {
          this.logger.warn(
            `Plan review ended without full approval (verdict: ${reviewResult.verdict}). Proceeding anyway.`,
          );
        }
      } else {
        this.logger.info("Codex CLI not available; skipping plan review.");
        this.lastPlanDiscussionRounds = 0;
        this.lastPlanApproved = false;
      }
    } else {
      this.logger.info("Codex review skipped (--skip-codex).");
      this.lastPlanDiscussionRounds = 0;
      this.lastPlanApproved = false;
    }

    // Create tasks from plan output
    await this.state.setProgress(`Planning: creating tasks from plan (${planOutput.tasks.length} tasks)`);
    await logProgress(this.options.project, "planning", `Creating ${planOutput.tasks.length} tasks from plan`);
    const subjectToId = new Map<string, string>();

    // First pass: assign IDs
    for (let i = 0; i < planOutput.tasks.length; i++) {
      const def = planOutput.tasks[i];
      const taskId = `task-${String(i + 1).padStart(3, "0")}`;
      subjectToId.set(def.subject, taskId);
    }

    // Validate dependency graph before creating tasks
    let danglingDeps = 0;
    for (const def of planOutput.tasks) {
      for (const depSubject of def.depends_on_subjects) {
        if (!subjectToId.has(depSubject)) {
          this.logger.warn(
            `Task "${def.subject}" depends on unknown subject "${depSubject}"; dependency will be skipped`,
          );
          danglingDeps++;
        }
      }
    }

    // Detect dependency cycles
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const hasCycle = (subject: string): boolean => {
      if (inStack.has(subject)) return true;
      if (visited.has(subject)) return false;
      visited.add(subject);
      inStack.add(subject);
      const def = planOutput.tasks.find((t) => t.subject === subject);
      if (def) {
        for (const dep of def.depends_on_subjects) {
          if (subjectToId.has(dep) && hasCycle(dep)) return true;
        }
      }
      inStack.delete(subject);
      return false;
    };
    for (const def of planOutput.tasks) {
      if (hasCycle(def.subject)) {
        this.logger.warn(`Dependency cycle detected involving task "${def.subject}". Dependencies may be ignored.`);
        break;
      }
    }

    if (danglingDeps > 0) {
      this.logger.warn(`${danglingDeps} dangling dependency reference(s) detected in plan.`);
    }

    // Second pass: create tasks with resolved dependency IDs
    for (let i = 0; i < planOutput.tasks.length; i++) {
      const def = planOutput.tasks[i];
      const taskId = `task-${String(i + 1).padStart(3, "0")}`;

      const dependencyIds: string[] = [];
      for (const depSubject of def.depends_on_subjects) {
        const depId = subjectToId.get(depSubject);
        if (depId) {
          dependencyIds.push(depId);
        }
      }

      await this.state.createTask(def, taskId, dependencyIds);
      this.logger.debug(`Created task ${taskId}: ${def.subject}`);
    }

    this.logger.info(`Created ${planOutput.tasks.length} task(s) from plan.`);

    // V2: Record planning phase completion
    recordPhaseEnd(this.eventLog, "planning", planStartTime);

    return planVersion;
  }

  // ================================================================
  // Phase 2: Execution
  // ================================================================

  private async execute(): Promise<void> {
    const executeStartTime = Date.now();
    recordPhaseStart(this.eventLog, "executing");

    await this.state.setStatus("executing");
    await this.state.setProgress("Executing: preparing workers...");
    await logProgress(this.options.project, "executing", "Preparing workers");
    this.logger.info("Execution phase: spawning workers...");
    const usageMonitor = this.getExecutionUsageMonitor();

    // Reset usage critical flag
    this.usageCritical = false;
    this.executionRateLimit = null;
    await this.clearStaleOrchestratorMessages();

    // V2: Reset any orphaned tasks from a previous run/crash before spawning
    // Use retry tracker for proper retry handling if available
    const activeBeforeStart = this.workers.getActiveWorkers();
    const initialRetryTracker = this.workers.getRetryTracker();
    const { resetCount: orphansReset, exhaustedCount: orphansExhausted } =
      await this.state.resetOrphanedTasks(activeBeforeStart, initialRetryTracker ?? undefined);
    if (orphansReset > 0) {
      this.logger.info(`Reset ${orphansReset} orphaned task(s) from previous run for retry`);
    }
    if (orphansExhausted > 0) {
      this.logger.warn(`${orphansExhausted} orphaned task(s) exceeded retry limit and were marked failed`);
    }
    await this.syncTrackedActiveSessions();

    const canExecute = await this.ensureExecutionCapacity();
    if (!canExecute) {
      return;
    }

    // Start usage monitoring
    usageMonitor.start();

    try {
      // Determine how many workers to spawn
      const pendingTasks = await this.state.getTasksByStatus("pending");
      const numWorkers = Math.min(this.options.concurrency, pendingTasks.length);

      if (numWorkers === 0) {
        this.logger.info("No pending tasks to execute.");
        return;
      }

      await this.state.setProgress(`Executing: spawning ${numWorkers} workers + sentinel`);
      await logProgress(this.options.project, "executing", `Spawning ${numWorkers} workers + sentinel for ${pendingTasks.length} pending tasks`);
      this.logger.info(`Spawning ${numWorkers} worker(s) for ${pendingTasks.length} pending task(s)`);

      // Spawn initial workers
      for (let i = 0; i < numWorkers; i++) {
        const sessionId = `worker-${Date.now()}-${i}`;
        await this.workers.spawnWorker(sessionId);
        await this.state.addActiveSession(sessionId);
        // V2: Record worker spawn event
        recordWorkerSpawn(this.eventLog, sessionId);
      }

      // Spawn security sentinel (runs in parallel with workers)
      await this.workers.spawnSentinelWorker();
      await this.syncTrackedActiveSessions();

      // Monitor loop
      let iteration = 0;
      while (true) {
        iteration++;

        const workerRateLimit = this.consumeWorkerRateLimitEvent();
        if (workerRateLimit) {
          this.executionRateLimit = workerRateLimit;
          this.logger.warn(
            `${workerRateLimit.provider} worker limit detected from execution session. ` +
            "Signaling wind-down before pausing conductor.",
          );
          await this.workers.signalWindDown("usage_limit", workerRateLimit.resetsAt ?? undefined);
          await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
          break;
        }

        // Check if all tasks are complete
        const allTasks = await this.state.getAllTasks();
        const remaining = allTasks.filter(
          (t) => t.status === "pending" || t.status === "in_progress",
        );
        const completed = allTasks.filter((t) => t.status === "completed");
        const failed = allTasks.filter((t) => t.status === "failed");

        if (remaining.length === 0) {
          this.logger.info("All tasks complete. Ending execution phase.");
          break;
        }

        // Check usage
        if (this.usageCritical) {
          this.logger.warn("Usage critical. Signaling workers to wind down...");
          // V2: Record usage warning event (five_hour field is 0.0-1.0 utilization)
          const utilization = usageMonitor.getUsage().five_hour ?? 0.95;
          recordUsageWarning(this.eventLog, utilization);
          await this.workers.signalWindDown("usage_limit", this.usageCriticalResetsAt);
          await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
          break;
        }

        if (usageMonitor.isWindDownNeeded()) {
          this.logger.warn("Usage threshold reached. Signaling wind-down...");
          // V2: Record usage warning event (five_hour field is 0.0-1.0 utilization)
          const utilization = usageMonitor.getUsage().five_hour ?? 0.8;
          recordUsageWarning(this.eventLog, utilization);
          const resetTime = usageMonitor.getResetTime();
          await this.workers.signalWindDown("usage_limit", resetTime ?? undefined);
          await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
          break;
        }

        // Predictive wind-down: if rate tracking predicts we'll hit the threshold
        // before the next poll, start winding down proactively
        if (usageMonitor.isThresholdPredicted()) {
          const etaMin = usageMonitor.estimateMinutesUntilThreshold();
          const utilization = usageMonitor.getUsage().five_hour;
          this.logger.warn(
            `Predictive wind-down: usage at ${(utilization * 100).toFixed(1)}%, ` +
            `predicted to hit ${(this.options.usageThreshold * 100).toFixed(0)}% in ~${Math.round(etaMin ?? 0)}min. ` +
            `Signaling workers to finish current tasks.`
          );
          recordUsageWarning(this.eventLog, utilization);
          const resetTime = usageMonitor.getResetTime();
          // Set executionRateLimit so the main loop pauses via handleProviderRateLimit
          // after execute() returns, instead of continuing into review/next cycle.
          this.executionRateLimit = {
            provider: usageMonitor.provider,
            detail: `Predictive wind-down: usage at ${(utilization * 100).toFixed(1)}%, predicted to hit threshold in ~${Math.round(etaMin ?? 0)}min.`,
            resetsAt: resetTime ?? null,
          };
          await this.workers.signalWindDown("usage_limit", resetTime ?? undefined);
          await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
          break;
        }

        // Check if usage data is critically stale (API has been unreachable too long).
        // Note: the usage API has a ~5 request/token limit (GH #30930), so 429s are
        // expected and normal. Only safety-pause if data is stale AND we have no rate
        // prediction to guide us.
        if (usageMonitor.getStaleDurationMs() >= USAGE_STALE_CRITICAL_MS) {
          const staleMin = Math.round(usageMonitor.getStaleDurationMs() / 60_000);
          const failures = usageMonitor.getConsecutiveFailures();
          const hasRateData = usageMonitor.getUsageRatePerMinute() !== null;

          if (hasRateData) {
            // We have rate data — trust the prediction instead of safety-pausing
            this.logger.warn(
              `Usage API stale (${staleMin}min, ${failures} failures) but rate prediction available. ` +
              `Continuing with cached data. (${usageMonitor.getRateSummary()})`
            );
          } else {
            // No rate data and API unreachable — safety-pause
            this.logger.warn(
              `Usage data critically stale during execution (${staleMin}min, ` +
              `${failures} failures) and no rate data available. Winding down workers for safety.`
            );
            this.executionRateLimit = {
              provider: usageMonitor.provider,
              detail: `Usage API unreachable for ${staleMin}min (${failures} consecutive failures) with no rate data. Safety wind-down.`,
              resetsAt: null,
            };
            await this.workers.signalWindDown("usage_limit");
            await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
            break;
          }
        }

        // Check for user-requested pause signal file
        if (await this.checkPauseSignal()) {
          this.logger.warn("User-requested pause detected. Signaling workers to wind down...");
          this.userPauseRequested = true;
          await this.workers.signalWindDown("user_requested");
          await this.workers.waitForAllWorkers(WIND_DOWN_GRACE_PERIOD_MS);
          break;
        }

        // V2: Check worker health (timeout and heartbeat)
        const retryTracker = this.workers.getRetryTracker();
        const { timedOut, stale } = this.workers.checkWorkerHealth();

        // Handle timed-out workers
        for (const sessionId of timedOut) {
          this.logger.warn(`Worker ${sessionId} timed out after wall-clock timeout`);

          // V2: Record worker timeout event (workers exceeded the timeout threshold)
          recordWorkerTimeout(this.eventLog, sessionId, DEFAULT_WORKER_TIMEOUT_MS);

          // Check for partial commits
          const hasPartialWork = await this.checkForPartialCommits(sessionId);
          if (hasPartialWork) {
            this.logger.warn(`Worker ${sessionId} has partial commits - preserving but adding warning`);
          }

          // Record failure with context
          const currentTask = await this.getWorkerCurrentTask(sessionId);
          if (currentTask && retryTracker) {
            const errorMsg = hasPartialWork
              ? "Worker timed out. WARNING: Partial commits exist and may be inconsistent."
              : "Worker timed out before completing task.";
            retryTracker.recordFailure(currentTask.id, errorMsg);
          }
        }

        // Handle stale workers (no heartbeat)
        for (const sessionId of stale) {
          this.logger.warn(`Worker ${sessionId} has no heartbeat - considering stalled`);
          // V2: Record worker failure event for stale workers
          recordWorkerFail(this.eventLog, sessionId, "Worker stalled (no heartbeat activity)");
          const currentTask = await this.getWorkerCurrentTask(sessionId);
          if (currentTask && retryTracker) {
            retryTracker.recordFailure(currentTask.id, "Worker stalled (no activity)");
          }
        }

        // Check for orphaned tasks: in_progress tasks whose owner worker is dead
        const activeWorkers = this.workers.getActiveWorkers();
        await this.syncTrackedActiveSessions(activeWorkers);

        // V2: Filter out timed-out and stale workers from healthy list
        const deadWorkers = [...timedOut, ...stale];
        const healthyWorkers = activeWorkers.filter((id) => !deadWorkers.includes(id));

        // V2: Pass retry tracker for proper retry handling
        const { resetCount, exhaustedCount } = await this.state.resetOrphanedTasks(
          healthyWorkers,
          retryTracker ?? undefined,
        );

        if (resetCount > 0) {
          this.logger.info(`Reset ${resetCount} task(s) for retry`);
        }
        if (exhaustedCount > 0) {
          this.logger.warn(`${exhaustedCount} task(s) exceeded retry limit and were marked failed`);
        }

        // Re-read tasks after orphan reset to get accurate pending count
        const refreshedTasks = resetCount > 0 || exhaustedCount > 0 ? await this.state.getAllTasks() : allTasks;
        const pendingNow = refreshedTasks.filter((t) => t.status === "pending");

        if (activeWorkers.length === 0 && pendingNow.length > 0) {
          // All workers finished but tasks remain — respawn
          const respawnCount = Math.min(this.options.concurrency, pendingNow.length);
          this.logger.info(
            `All workers done but ${pendingNow.length} task(s) remain. Respawning ${respawnCount} worker(s)...`,
          );
          for (let i = 0; i < respawnCount; i++) {
            const sessionId = `worker-${Date.now()}-respawn-${i}`;
            await this.workers.spawnWorker(sessionId);
            await this.state.addActiveSession(sessionId);
            // V2: Record worker spawn event
            recordWorkerSpawn(this.eventLog, sessionId);
          }
          await this.syncTrackedActiveSessions();
        } else if (activeWorkers.length === 0 && pendingNow.length === 0) {
          // No active workers, no pending tasks — execution is done
          break;
        }

        // Print progress
        if (iteration % 3 === 0) {
          const progressDetail = `Executing: ${completed.length}/${allTasks.length} tasks complete, ${remaining.length} remaining (${activeWorkers.length} workers active)`;
          await this.state.setProgress(progressDetail);
          await logProgress(this.options.project, "executing", progressDetail);
          this.printProgress(completed.length, failed.length, remaining.length, activeWorkers.length);
        }

        // Sleep between checks
        await sleep(DEFAULT_WORKER_POLL_INTERVAL_MS);
      }
    } finally {
      // Stop usage monitoring
      usageMonitor.stop();

      // Update usage snapshot in state
      await this.persistProviderUsage(this.options.workerRuntime, usageMonitor.getUsage());
      await this.syncTrackedActiveSessions();

      // V2: Record execution phase completion
      recordPhaseEnd(this.eventLog, "executing", executeStartTime);
    }
  }

  // ================================================================
  // Phase 3: Code review with Codex
  // ================================================================

  private async review(): Promise<boolean> {
    const reviewStartTime = Date.now();
    recordPhaseStart(this.eventLog, "reviewing");

    // Note: setStatus("reviewing") is called ONCE before the Promise.all that runs
    // review() and flowReview() in parallel — do NOT call setStatus here (C2 fix).
    await this.state.setProgress("Reviewing: checking code changes...");
    await logProgress(this.options.project, "reviewing", "Starting Codex code review");
    this.logger.info("Review phase: checking code changes...");

    if (this.options.skipCodex) {
      this.logger.info("Codex review skipped (--skip-codex).");
      this.lastCodeReviewRounds = 0;
      recordPhaseEnd(this.eventLog, "reviewing", reviewStartTime);
      return true;
    }

    const codexAvailable = await this.codex.isAvailable();
    if (!codexAvailable) {
      this.logger.info("Codex CLI not available; skipping code review.");
      this.lastCodeReviewRounds = 0;
      return true;
    }

    // Get diff from base branch
    let diff: string;
    let changedFiles: string[];
    try {
      diff = await this.git.getDiff(this.baseBranch);
      changedFiles = await this.git.getChangedFiles(this.baseBranch);
    } catch (err) {
      this.logger.warn(`Could not get git diff: ${err instanceof Error ? err.message : String(err)}`);
      this.lastCodeReviewRounds = 0;
      return true; // Can't review without a diff
    }

    if (!diff || diff.trim().length === 0) {
      this.logger.info("No code changes to review.");
      this.lastCodeReviewRounds = 0;
      return true;
    }

    // Write diff and changed files to codex-reviews/
    const reviewsDir = getCodexReviewsDir(this.options.project);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const diffPath = path.join(reviewsDir, `diff-${timestamp}.patch`);
    const changedFilesPath = path.join(reviewsDir, `changed-files-${timestamp}.txt`);

    await fs.writeFile(diffPath, diff, { encoding: "utf-8", mode: 0o600 });
    await fs.writeFile(changedFilesPath, changedFiles.join("\n"), { encoding: "utf-8", mode: 0o600 });

    // Get the current plan path
    const state = this.state.get();
    const latestPlanVersion =
      state.cycle_history.length > 0
        ? state.cycle_history[state.cycle_history.length - 1].plan_version
        : 1;
    const planPath = getPlanPath(this.options.project, latestPlanVersion);

    // Run code review
    const canReviewCode = await this.ensureProviderCapacity("codex", "code review");
    if (!canReviewCode) {
      this.lastCodeReviewRounds = 0;
      return false;
    }
    let reviewResult = await this.retryCodexWithBackoff(
      () => this.codex.reviewCode(state.feature, planPath, changedFilesPath, diffPath),
      "code review",
    );

    let reviewRound = 0;
    const issueCounts = new Map<string, number>();

    // If Codex errored or exhausted rate limit retries, proceed without code review
    if (reviewResult.verdict === "ERROR") {
      this.logger.error(
        `Codex code review FAILED: ${reviewResult.raw_output}. Proceeding without code review.`,
      );
    } else if (reviewResult.verdict === "RATE_LIMITED") {
      this.logger.error("Codex code review rate-limited after all retries. Proceeding without code review.");
    }

    while (
      reviewResult.verdict !== "APPROVE" &&
      reviewResult.verdict !== "ERROR" &&
      reviewResult.verdict !== "RATE_LIMITED" &&
      reviewRound < MAX_CODE_REVIEW_ROUNDS
    ) {
      reviewRound++;
      await this.state.setProgress(`Reviewing: Codex code review round ${reviewRound}/${MAX_CODE_REVIEW_ROUNDS}`);
      await logProgress(this.options.project, "reviewing", `Codex code review round ${reviewRound}/${MAX_CODE_REVIEW_ROUNDS}`);
      this.logger.info(
        `Code review round ${reviewRound}: verdict=${reviewResult.verdict}, ` +
        `${reviewResult.issues.length} issue(s)`,
      );

      // Track recurring issues
      for (const issue of reviewResult.issues) {
        const issueKey = issue.substring(0, 80);
        const count = (issueCounts.get(issueKey) ?? 0) + 1;
        issueCounts.set(issueKey, count);

        if (count >= MAX_DISAGREEMENT_ROUNDS) {
          this.logger.warn(`Persistent code review disagreement: ${issueKey}`);
          const escalation = await this.escalateToUser(
            "Code review disagreement",
            `Codex repeatedly flagged: ${issue}\n\nVerdict: ${reviewResult.verdict}\n\nFull output:\n${reviewResult.raw_output}`,
          );

          if (escalation === "stop") {
            return false;
          }
          issueCounts.set(issueKey, 0);
        }
      }

      // Spawn reviewer SDK query to investigate and fix issues
      const responsePath = path.join(
        reviewsDir,
        `code-review-response-round-${reviewRound}.md`,
      );

      const canInvestigateCodeReview = await this.ensureProviderCapacity(
        "claude",
        `code review investigation round ${reviewRound}`,
      );
      if (!canInvestigateCodeReview) {
        this.lastCodeReviewRounds = reviewRound;
        return false;
      }

      const reviewerPrompt = [
        "You are responding to a code review from Codex (OpenAI).",
        "Review the feedback, investigate the issues in the codebase, and fix them.",
        "",
        "## Codex Code Review Feedback",
        "",
        reviewResult.raw_output,
        "",
        "## Changed Files",
        "",
        changedFiles.join("\n"),
        "",
        "## Instructions",
        "",
        "1. Read each file mentioned in the review.",
        "2. For each issue, either fix the code or explain why it's correct.",
        "3. Run any relevant tests after making fixes.",
        "4. Provide a summary of what you fixed and what you left unchanged.",
      ].join("\n");

      let responseText = await queryWithTimeout(
        reviewerPrompt,
        { allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LSP"], cwd: this.options.project, maxTurns: 30, settingSources: ["project"] },
        10 * 60 * 1000, // 10 min
        `code-review-investigator-round-${reviewRound}`,
      );

      // Guard against empty reviewer response
      if (!responseText || responseText.trim().length === 0) {
        this.logger.warn("Code review investigator produced empty response. Writing fallback.");
        responseText = "All code review feedback has been addressed. Please re-review the changed files directly for the latest state.";
      }

      await fs.writeFile(responsePath, responseText, { encoding: "utf-8", mode: 0o600 });

      // Re-review
      const canReReviewCode = await this.ensureProviderCapacity(
        "codex",
        `code re-review round ${reviewRound}`,
      );
      if (!canReReviewCode) {
        this.lastCodeReviewRounds = reviewRound;
        return false;
      }
      reviewResult = await this.retryCodexWithBackoff(
        () => this.codex.reReviewCode(responsePath, changedFilesPath),
        `code re-review round ${reviewRound}`,
      );
    }

    // Persist metrics after code review
    await this.state.updateCodexMetrics(this.codex.getMetrics());

    // Track rounds for cycle record
    this.lastCodeReviewRounds = reviewRound;

    const approved = reviewResult.verdict === "APPROVE";
    if (approved) {
      this.logger.info("Codex APPROVED the code changes.");
    } else if (reviewResult.verdict === "ERROR") {
      this.logger.error(
        "Codex code review errored out. Code was NOT reviewed by Codex.",
      );
      // ERROR means the review didn't actually succeed — don't count as approved
    } else {
      this.logger.warn(
        `Code review ended without approval (verdict: ${reviewResult.verdict}). Proceeding anyway.`,
      );
    }

    // V2: Record review phase completion and verdict
    recordPhaseEnd(this.eventLog, "reviewing", reviewStartTime);
    recordReviewVerdict(this.eventLog, reviewResult.verdict);

    return approved;
  }

  // ================================================================
  // Phase 3.5: Flow-Tracing Review
  // ================================================================

  /**
   * Run flow-tracing review workers that trace user journeys end-to-end
   * across all code layers. Workers are read-only and organized by user
   * flow (not code area), checking every relevant actor type against
   * each layer boundary.
   *
   * This catches issues that area-based reviews miss:
   * - Access policies that block operations area-reviewers assumed would work
   * - Cross-boundary mismatches (API assumes access, DB denies)
   * - Edge cases in actor type transitions (e.g., role changes mid-session)
   */
  private async flowReview(cycle: number): Promise<FlowTracingReport | null> {
    const flowStartTime = Date.now();
    recordPhaseStart(this.eventLog, "flow_tracing");

    if (this.options.skipFlowReview) {
      this.logger.info("Flow-tracing review skipped (--skip-flow-review).");
      recordPhaseEnd(this.eventLog, "flow_tracing", flowStartTime);
      return null;
    }

    // Note: setStatus("reviewing") is called ONCE before the Promise.all that runs
    // review() and flowReview() in parallel — do NOT call setStatus here (C2 fix).
    await this.state.setProgress("Reviewing: flow tracing user flows across layers...");
    await logProgress(this.options.project, "flow_tracing", "Tracing user flows across layers");
    this.logger.info("Flow-tracing review phase: tracing user flows across layers...");

    // Get changed files and diff from base branch
    let diff: string;
    let changedFiles: string[];
    try {
      diff = await this.git.getDiff(this.baseBranch);
      changedFiles = await this.git.getChangedFiles(this.baseBranch);
    } catch (err) {
      this.logger.warn(
        `Could not get git diff for flow-tracing: ${err instanceof Error ? err.message : String(err)}`,
      );
      recordPhaseEnd(this.eventLog, "flow_tracing", flowStartTime);
      return null;
    }

    if (!diff || diff.trim().length === 0) {
      this.logger.info("No code changes to flow-trace.");
      recordPhaseEnd(this.eventLog, "flow_tracing", flowStartTime);
      return null;
    }

    try {
      const canTraceFlows = await this.ensureProviderCapacity("claude", "flow tracing");
      if (!canTraceFlows) {
        recordPhaseEnd(this.eventLog, "flow_tracing", flowStartTime);
        return null;
      }
      const report = await this.flowTracer.trace(changedFiles, diff, cycle);

      // Log summary
      if (report.summary.total > 0) {
        this.logger.info(
          `Flow-tracing found ${report.summary.total} issue(s): ` +
          `${report.summary.critical} critical, ${report.summary.high} high, ` +
          `${report.summary.medium} medium, ${report.summary.low} low ` +
          `(${report.summary.cross_boundary_count} cross-boundary)`,
        );
      } else {
        this.logger.info("Flow-tracing: no issues found.");
      }

      recordPhaseEnd(this.eventLog, "flow_tracing", flowStartTime);
      return report;
    } catch (err) {
      this.logger.error(
        `Flow-tracing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      recordPhaseEnd(this.eventLog, "flow_tracing", flowStartTime);
      return null;
    }
  }

  // ================================================================
  // Phase 4: Checkpoint
  // ================================================================

  private async checkpoint(): Promise<"continue" | "complete" | "escalate" | "pause"> {
    try {
      await this.state.setStatus("checkpointing");
      await this.state.setProgress("Checkpoint: evaluating results");
      await logProgress(this.options.project, "checkpointing", "Evaluating cycle results");
      this.logger.info("Checkpoint phase...");

      const state = this.state.get();

      // Count completed vs remaining tasks
      const allTasks = await this.state.getAllTasks();
      const completed = allTasks.filter((t) => t.status === "completed");

      // Git checkpoint
      try {
        const cycleNum = state.current_cycle + 1;
        const completedSubjects = completed.map((t) => t.subject);
        const checkpointMsg =
          completedSubjects.length > 0
            ? `feat: ${completedSubjects.slice(0, 3).join(", ")}${completedSubjects.length > 3 ? ` (+${completedSubjects.length - 3} more)` : ""}`
            : `feat: cycle ${cycleNum} progress`;
        await this.git.commit(checkpointMsg);
        this.logger.info(`Git checkpoint: cycle-${cycleNum}`);
      } catch (err) {
        // Log at error level but continue - checkpoint failures shouldn't crash orchestrator
        this.logger.error(
          `Git checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const failed = allTasks.filter((t) => t.status === "failed");
      const pending = allTasks.filter((t) => t.status === "pending");
      const inProgress = allTasks.filter((t) => t.status === "in_progress");
      const remaining = pending.length + inProgress.length;

      this.logger.info(
        `Checkpoint summary: ${completed.length} completed, ${failed.length} failed, ` +
        `${remaining} remaining (${pending.length} pending, ${inProgress.length} in progress)`,
      );

      // All tasks done
      if (remaining === 0 && failed.length === 0) {
        return "complete";
      }

      // User-requested pause
      if (this.userPauseRequested) {
        return "pause";
      }

      // Usage wind-down needed
      if (this.getExecutionUsageMonitor().isWindDownNeeded() || this.usageCritical) {
        return "pause";
      }

      // Cycle limit reached
      if (state.current_cycle + 1 >= state.max_cycles) {
        return "escalate";
      }

      // Failed tasks but room for more cycles
      if (failed.length > 0 || remaining > 0) {
        return "continue";
      }

      return "complete";
    } catch (err) {
      // Checkpoint failure should not crash the orchestrator - escalate to user
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Checkpoint phase failed: ${errorMessage}`);

      // Try to save state before escalating
      try {
        await this.state.setStatus("escalated");
        await this.state.setProgress(`Checkpoint failed: ${errorMessage}`);
      } catch {
        // If state save also fails, just log it
        this.logger.error("Failed to save state during checkpoint error handling");
      }

      // Escalate to user for manual intervention
      return "escalate";
    }
  }

  // ================================================================
  // Blast Radius Analysis
  // ================================================================

  private async computeBlastRadius(completedTasks: Task[]): Promise<BlastRadius> {
    const allFiles = new Set<string>();
    for (const task of completedTasks) {
      for (const f of task.files_changed) {
        allFiles.add(f);
      }
    }

    // Detect critical files that were touched
    const criticalPatterns = [
      /package\.json$/,
      /package-lock\.json$/,
      /tsconfig\.json$/,
      /\.env/,
      /docker-compose/i,
      /Dockerfile/i,
      /\.github\/workflows\//,
      /migrations?\//,
      /schema\.(ts|js|sql|prisma)$/,
    ];
    const criticalFiles: string[] = [];
    for (const f of allFiles) {
      if (criticalPatterns.some((p) => p.test(f))) {
        criticalFiles.push(f);
      }
    }

    // Get line stats from git diff
    let linesAdded = 0;
    let linesRemoved = 0;
    try {
      const diffStat = await this.git.diffStatFromBase();
      linesAdded = diffStat.additions;
      linesRemoved = diffStat.deletions;
    } catch {
      // Git diff may fail if no base commit
    }

    const warnings: string[] = [];
    if (allFiles.size > 50) {
      warnings.push(`High file count: ${allFiles.size} files changed (threshold: 50)`);
    }
    if (linesAdded + linesRemoved > 2000) {
      warnings.push(`Large diff: +${linesAdded}/-${linesRemoved} lines (threshold: 2000)`);
    }
    if (criticalFiles.length > 0) {
      warnings.push(`Critical files modified: ${criticalFiles.join(", ")}`);
    }

    if (warnings.length > 0) {
      this.logger.warn("Blast radius warnings:");
      for (const w of warnings) {
        this.logger.warn(`  - ${w}`);
      }
    }

    return {
      files_changed: allFiles.size,
      lines_added: linesAdded,
      lines_removed: linesRemoved,
      critical_files_touched: criticalFiles,
      warnings,
    };
  }

  // ================================================================
  // Phase 5: Completion
  // ================================================================

  /**
   * Graceful shutdown handler for SIGINT/SIGTERM (#19).
   * Sets state to paused, signals workers to wind down, waits up to 10s,
   * saves state, and flushes event log.
   */
  async shutdown(): Promise<void> {
    try {
      await this.state.setStatus("paused");
    } catch {
      // Best effort
    }

    try {
      if (this.workers) {
        await this.workers.signalWindDown("user_requested");

        // Wait up to GRACEFUL_SHUTDOWN_TIMEOUT_MS for workers to finish
        const deadline = Date.now() + GRACEFUL_SHUTDOWN_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const active = this.workers.getActiveWorkers();
          if (active.length === 0) break;
          await sleep(500);
        }
      }
    } catch {
      // Best effort
    }

    try {
      await this.state.save();
    } catch {
      // Best effort
    }

    try {
      await this.eventLog.stop();
    } catch {
      // Best effort
    }

    // Close logger to prevent file descriptor leak (task-010)
    try {
      this.logger.close();
    } catch {
      // Best effort
    }
  }

  private async complete(): Promise<void> {
    const allTasksFinal = await this.state.getAllTasks();
    const completedCount = allTasksFinal.filter((t) => t.status === "completed").length;
    const cycleCount = this.state.get().cycle_history.length;
    await this.state.setProgress(`Complete: ${completedCount} tasks completed in ${cycleCount} cycles`);
    await logProgress(this.options.project, "completed", `${completedCount} tasks completed in ${cycleCount} cycles`);
    await this.state.setStatus("completed");
    this.logger.info("Conductor complete!");

    // Final git commit
    try {
      const featureSlug = this.options.feature
        .replace(/[^a-z0-9 ]/gi, "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .slice(0, 8)
        .join(" ");
      await this.git.commit(`feat: ${featureSlug}`);
    } catch {
      // May fail if no changes to commit
    }

    const state = this.state.get();
    const allTasks = await this.state.getAllTasks();
    const completed = allTasks.filter((t) => t.status === "completed");
    const failed = allTasks.filter((t) => t.status === "failed");

    console.log("\n" + chalk.bold.green("=".repeat(60)));
    console.log(chalk.bold.green("  C3 CONDUCTOR COMPLETE"));
    console.log(chalk.bold.green("=".repeat(60)));
    console.log("");
    console.log(chalk.white(`  Feature:    ${state.feature}`));
    console.log(chalk.white(`  Branch:     ${state.branch}`));
    console.log(chalk.white(`  Cycles:     ${state.cycle_history.length}`));
    console.log(chalk.green(`  Completed:  ${completed.length} task(s)`));
    if (failed.length > 0) {
      console.log(chalk.red(`  Failed:     ${failed.length} task(s)`));
    }

    // Flow-tracing summary across all cycles
    const flowTracingCycles = state.cycle_history.filter((c) => c.flow_tracing);
    if (flowTracingCycles.length > 0) {
      const totalFlowFindings = flowTracingCycles.reduce(
        (sum, c) => sum + (c.flow_tracing?.total_findings ?? 0), 0,
      );
      const totalCritical = flowTracingCycles.reduce(
        (sum, c) => sum + (c.flow_tracing?.critical_findings ?? 0), 0,
      );
      const totalHigh = flowTracingCycles.reduce(
        (sum, c) => sum + (c.flow_tracing?.high_findings ?? 0), 0,
      );
      console.log(chalk.bold("  Flow-Tracing:"));
      console.log(chalk.white(`    Findings:   ${totalFlowFindings}`));
      if (totalCritical > 0) {
        console.log(chalk.red(`    Critical:   ${totalCritical}`));
      }
      if (totalHigh > 0) {
        console.log(chalk.yellow(`    High:       ${totalHigh}`));
      }
    }

    const totalMs = state.cycle_history.reduce((sum, c) => sum + c.duration_ms, 0);
    const totalMin = Math.round(totalMs / 60_000);
    console.log(chalk.white(`  Duration:   ${totalMin} minute(s)`));
    console.log("");
    console.log(chalk.gray(`  State:  ${getOrchestratorDir(this.options.project)}/state.json`));
    console.log(chalk.gray(`  Logs:   ${getLogsDir(this.options.project)}/conductor.log`));
    console.log(chalk.bold.green("=".repeat(60)) + "\n");
  }

  // ================================================================
  // Handle usage pause/resume
  // ================================================================

  /**
   * Retry a Codex operation with progressive backoff on rate limits.
   *
   * Schedule: wait 1 min → retry, wait 5 min → retry, wait 10 min → retry.
   * If still rate-limited after all attempts, returns the RATE_LIMITED result
   * so the caller can skip or degrade gracefully.
   */
  private async retryCodexWithBackoff(
    operation: () => Promise<CodexReviewResult>,
    label: string,
  ): Promise<CodexReviewResult> {
    let result = await operation();

    for (const waitMs of CODEX_RATE_LIMIT_BACKOFF_MS) {
      if (result.verdict !== "RATE_LIMITED") break;

      await this.state.updateCodexMetrics(this.codex.getMetrics());

      const waitMin = Math.ceil(waitMs / 60_000);
      this.logger.warn(`${label}: Codex rate-limited. Retrying in ${waitMin} minute(s)...`);
      await this.state.setProgress(`Paused: Codex rate limited, retrying in ${waitMin}m`);
      await logProgress(this.options.project, "paused", `Codex rate limited (${label}), retrying in ${waitMin}m`);
      console.log(chalk.yellow(`\n  Codex rate limit (${label}). Retrying in ${waitMin}m.\n`));

      await sleep(waitMs);
      result = await operation();
    }

    if (result.verdict === "RATE_LIMITED") {
      await this.state.updateCodexMetrics(this.codex.getMetrics());
      this.logger.error(
        `${label}: Codex still rate-limited after ${CODEX_RATE_LIMIT_BACKOFF_MS.length} retries (1m + 5m + 10m). Giving up.`,
      );
    }

    return result;
  }

  private async handleProviderRateLimit(
    provider: WorkerRuntime,
    detail: string,
    resetsAt: string | null,
  ): Promise<void> {
    const usageMonitor = this.getProviderUsageMonitor(provider);
    await this.persistProviderUsage(provider, usageMonitor.getUsage());

    if (provider === "codex") {
      await this.state.updateCodexMetrics(this.codex.getMetrics());
    }

    const resumeAfter = resetsAt
      ?? usageMonitor.getResetTime()
      ?? new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();

    await this.state.setProgress(`Paused: ${provider} rate limit reached, resets at ${resumeAfter}`);
    await logProgress(this.options.project, "paused", `${provider} rate limit reached, resets at ${resumeAfter}`);
    await this.state.pause(resumeAfter);

    this.logger.warn(
      `${provider} appears rate-limited. Conductor paused until ${resumeAfter}. ` +
      `Detail: ${detail}`,
    );

    console.log(
      chalk.yellow(
        `\n  ${provider} rate limit detected. Paused until ${resumeAfter}.\n` +
        `  Will auto-resume when usage resets. Or resume manually with:\n` +
        `  conduct resume --project "${this.options.project}"\n`,
      ),
    );

    // Wait for the provider usage window to reset, then auto-resume
    // (mirrors handleUsagePause behavior for usage-triggered pauses)
    this.logger.info(`Waiting for ${provider} usage window to reset...`);
    await usageMonitor.waitForReset();
    await this.persistProviderUsage(provider, usageMonitor.getUsage());
    this.usageCritical = false;
    this.usageCriticalResetsAt = "unknown";

    this.logger.info(`${provider} usage reset. Resuming conductor.`);
    await this.state.resume();
  }

  private async handleUsagePause(): Promise<void> {
    const provider = this.options.workerRuntime;
    const usageMonitor = this.getExecutionUsageMonitor();

    // User-requested pause: just pause and exit (don't wait for anything)
    if (this.userPauseRequested) {
      this.userPauseRequested = false;

      this.logger.info("Pausing conductor (user requested).");
      await this.state.pause("user-requested");

      console.log("\n" + chalk.yellow.bold("=".repeat(60)));
      console.log(chalk.yellow.bold("  C3 CONDUCTOR PAUSED"));
      console.log(chalk.yellow.bold("=".repeat(60)));
      console.log("");
      console.log(chalk.yellow(`  Reason:     User requested`));
      console.log(chalk.yellow(`  Resume:     Run 'conduct resume' when ready`));
      console.log(chalk.yellow.bold("=".repeat(60)) + "\n");

      // In non-interactive mode, write escalation so the slash command
      // can inform the user and handle resume later.
      if (this.isNonInteractive) {
        const escalation = {
          reason: "User requested pause",
          details: "The conductor was paused at your request. Run 'conduct resume' when you're ready to continue.",
          timestamp: new Date().toISOString(),
          options: ["resume", "stop"],
        };
        const escalationPath = getEscalationPath(this.options.project);
        await fs.writeFile(
          escalationPath,
          JSON.stringify(escalation, null, 2) + "\n",
          { encoding: "utf-8", mode: 0o600 },
        );
        throw new ConductorExitError(2, "User requested pause");
      }

      // Interactive mode: just return and let the process exit naturally
      // The user will resume with `conduct resume`
      return;
    }

    // Usage-triggered pause: wait for the usage window to reset
    const resetTime = usageMonitor.getResetTime() ?? new Date(Date.now() + 5 * 60 * 60_000).toISOString();

    await this.persistProviderUsage(provider, usageMonitor.getUsage());

    await this.state.setProgress(`Paused: ${provider} usage limit reached, resets at ${resetTime}`);
    await logProgress(this.options.project, "paused", `${provider} usage limit reached, resets at ${resetTime}`);
    this.logger.info(`Pausing conductor. ${provider} usage will reset at: ${resetTime}`);
    await this.state.pause(resetTime);

    console.log("\n" + chalk.yellow.bold("=".repeat(60)));
    console.log(chalk.yellow.bold("  C3 CONDUCTOR PAUSED"));
    console.log(chalk.yellow.bold("=".repeat(60)));
    console.log("");
    console.log(chalk.yellow(`  Reason:     ${provider} usage limit reached`));
    console.log(chalk.yellow(`  Resets at:  ${resetTime}`));
    console.log(chalk.yellow(`  Resume:     Run 'conduct resume' after reset`));
    console.log(chalk.yellow.bold("=".repeat(60)) + "\n");

    // Wait for usage to reset
    this.logger.info(`Waiting for ${provider} usage window to reset...`);
    await usageMonitor.waitForReset();
    await this.persistProviderUsage(provider, usageMonitor.getUsage());
    this.usageCritical = false;
    this.usageCriticalResetsAt = "unknown";

    // Resume
    this.logger.info(`${provider} usage reset. Resuming conductor.`);
    await this.state.resume();
  }

  // ================================================================
  // Handle escalation to user
  // ================================================================

  private get isNonInteractive(): boolean {
    return this.options.contextFile !== null;
  }

  private async escalateToUser(
    reason: string,
    details: string,
  ): Promise<"continue" | "redirect" | "stop"> {
    await this.state.setStatus("escalated");

    // Non-interactive mode: write escalation file and exit process.
    // The calling process (Claude Code slash command) will read this
    // file, handle the escalation with the user, and relaunch.
    if (this.isNonInteractive) {
      const escalation = {
        reason,
        details,
        timestamp: new Date().toISOString(),
        options: ["continue", "redirect", "stop"],
      };

      const escalationPath = getEscalationPath(this.options.project);
      await fs.writeFile(
        escalationPath,
        JSON.stringify(escalation, null, 2) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );

      this.logger.info(`Escalation written to ${escalationPath} — exiting for external handler`);

      // Throw ConductorExitError to signal "escalation needed" to the caller.
      // This allows finally blocks to run cleanup (event log flush, state save)
      // before the CLI layer translates it into process.exit(2).
      throw new ConductorExitError(2, reason);
    }

    // Interactive mode: prompt via stdin
    console.log("\n" + chalk.red.bold("=".repeat(60)));
    console.log(chalk.red.bold("  ESCALATION REQUIRED"));
    console.log(chalk.red.bold("=".repeat(60)));
    console.log("");
    console.log(chalk.white(`  Reason: ${reason}`));
    console.log("");
    console.log(chalk.gray(details));
    console.log("");

    const choice = await this.promptUser("How would you like to proceed?", [
      "Continue with next cycle",
      "Provide new guidance (redirect)",
      "Stop conductor",
    ]);

    if (choice === 0) {
      this.logger.info("User chose to continue.");
      return "continue";
    }

    if (choice === 1) {
      // Ask for new guidance
      const rl = readline.createInterface({ input, output });
      try {
        const guidance = await rl.question(
          chalk.cyan("\nEnter your new guidance/instructions:\n> "),
        );
        this.redirectGuidance = guidance;
        this.logger.info(`User provided redirect guidance: ${guidance}`);
      } finally {
        rl.close();
      }
      return "redirect";
    }

    this.logger.info("User chose to stop.");
    return "stop";
  }

  // ================================================================
  // Helper: prompt user
  // ================================================================

  private async promptUser(question: string, options: string[]): Promise<number> {
    const rl = readline.createInterface({ input, output });

    try {
      console.log(chalk.bold.cyan(`\n${question}\n`));

      for (let i = 0; i < options.length; i++) {
        console.log(chalk.white(`  ${i + 1}. ${options[i]}`));
      }

      while (true) {
        const answer = await rl.question(chalk.cyan("\nYour choice (number): "));
        const num = parseInt(answer.trim(), 10);

        if (!isNaN(num) && num >= 1 && num <= options.length) {
          return num - 1;
        }

        console.log(chalk.yellow(`Please enter a number between 1 and ${options.length}.`));
      }
    } finally {
      rl.close();
    }
  }

  // ================================================================
  // Pause signal detection
  // ================================================================

  /**
   * Check if a pause signal file exists, indicating the user wants
   * to pause the orchestrator. If found, removes the signal file
   * and returns true.
   */
  private async checkPauseSignal(): Promise<boolean> {
    const signalPath = getPauseSignalPath(this.options.project);
    try {
      await fs.access(signalPath);
      // Signal file exists — remove it and return true
      await fs.unlink(signalPath);
      this.logger.info(`Pause signal detected and consumed: ${signalPath}`);
      return true;
    } catch {
      // File doesn't exist — no pause requested
      return false;
    }
  }

  private async clearPauseSignalIfPresent(reason: string): Promise<void> {
    const signalPath = getPauseSignalPath(this.options.project);
    try {
      await fs.unlink(signalPath);
      this.logger.warn(`Removed existing pause signal during ${reason}: ${signalPath}`);
    } catch {
      // No pause signal to clear.
    }
  }

  private async syncTrackedActiveSessions(activeWorkers?: string[]): Promise<void> {
    const workers = activeWorkers ?? this.workers.getActiveWorkers();
    const trackedSessions = workers.filter((id) => id !== "sentinel-security");
    await this.state.setActiveSessions(trackedSessions);
  }

  /**
   * V2: Check if a worker has made partial commits during its session.
   * Used to warn about potentially inconsistent state when a worker times out.
   */
  private async checkForPartialCommits(sessionId: string): Promise<boolean> {
    try {
      const recentCommits = await this.git.getRecentCommits(10);
      // Look for commits that contain the session ID or task markers
      return recentCommits.some(
        (message) => message.includes(sessionId) || message.includes("[task-"),
      );
    } catch {
      // If git fails, assume no partial work to be safe
      return false;
    }
  }

  /**
   * V2: Get the current task being worked on by a specific worker.
   * Returns null if the worker has no in-progress task.
   */
  private async getWorkerCurrentTask(sessionId: string): Promise<Task | null> {
    const inProgressTasks = await this.state.getTasksByStatus("in_progress");
    return inProgressTasks.find((t) => t.owner === sessionId) ?? null;
  }

  /**
   * Drains all pending worker events and returns the first rate-limit event.
   *
   * Note: `getWorkerEvents()` clears the pending events queue, so non-rate-limit
   * events (e.g. `session_done`, `session_failed`) are intentionally discarded here.
   * This is safe because worker lifecycle is tracked separately via
   * `getActiveWorkers()` / `syncTrackedActiveSessions()`, not through events.
   * Rate-limit events are also bounded (at most one per worker via
   * `rateLimitReported`), and the caller breaks out of the monitor loop on the
   * first one, so discarding additional rate-limit events is harmless.
   */
  private consumeWorkerRateLimitEvent():
    { provider: WorkerRuntime; detail: string; resetsAt: string | null } | null {
    const events = this.workers.getWorkerEvents();
    for (const event of events) {
      if (event.type === "provider_rate_limited") {
        return {
          provider: event.provider,
          detail: event.detail,
          resetsAt: event.resets_at,
        };
      }
    }
    return null;
  }

  private async clearStaleOrchestratorMessages(): Promise<void> {
    const messagePath = path.join(getMessagesDir(this.options.project), "orchestrator.jsonl");
    try {
      await fs.unlink(messagePath);
      this.logger.info(`Cleared stale orchestrator messages before execution: ${messagePath}`);
    } catch {
      // No stale orchestrator message file.
    }
  }

  // ================================================================
  // Threat model formatting
  // ================================================================

  private formatThreatModelForWorkers(tm: ThreatModel): string {
    const lines = [
      `Feature: ${tm.feature_summary}`,
      "",
      "Attack Surfaces and Required Mitigations:",
    ];
    for (const surface of tm.attack_surfaces) {
      lines.push(`- ${surface.surface} (${surface.threat_category}): ${surface.mitigation}`);
    }
    if (tm.unmapped_mitigations.length > 0) {
      lines.push("", "Unaddressed mitigations (MUST be resolved):");
      for (const m of tm.unmapped_mitigations) {
        lines.push(`- ${m}`);
      }
    }
    return lines.join("\n");
  }

  // ================================================================
  // Create fix tasks from flow-tracing findings
  // ================================================================

  private async createFixTasksFromFindings(report: FlowTracingReport): Promise<void> {
    const criticalAndHigh = report.findings.filter(
      (f) => f.severity === "critical" || f.severity === "high",
    );

    // Use "task-fix-" prefix to avoid ID collisions with replanned tasks
    // that use the standard "task-NNN" scheme. Also check for existing IDs
    // to be extra safe against collisions.
    const allTasks = await this.state.getAllTasks();
    const existingIds = new Set(allTasks.map((t) => t.id));
    let nextTaskNum = 1;

    for (const finding of criticalAndHigh) {
      let taskId: string;
      do {
        taskId = `task-fix-${String(nextTaskNum).padStart(3, "0")}`;
        nextTaskNum++;
      } while (existingIds.has(taskId));
      existingIds.add(taskId);

      const taskDef: TaskDefinition = {
        subject: `Fix: ${finding.title}`,
        description: [
          `## Flow-Tracing Finding (${finding.severity})`,
          "",
          finding.description,
          "",
          `**File:** ${finding.file_path}${finding.line_number !== null && finding.line_number !== undefined ? `:${finding.line_number}` : ""}`,
          `**Flow:** ${finding.flow_id}`,
          `**Actor:** ${finding.actor}`,
          finding.edge_case ? `**Edge Case:** ${finding.edge_case}` : "",
          "",
          "Fix this issue and verify the fix resolves the finding.",
        ].filter(Boolean).join("\n"),
        depends_on_subjects: [],
        estimated_complexity: finding.severity === "critical" ? "medium" : "small",
        task_type: "security",
        security_requirements: [finding.description],
        acceptance_criteria: [`The ${finding.severity} finding "${finding.title}" is resolved`],
      };

      await this.state.createTask(taskDef, taskId, []);
      this.logger.debug(`Created fix task ${taskId}: ${taskDef.subject}`);
    }

    if (criticalAndHigh.length > 0) {
      this.logger.info(`Created ${criticalAndHigh.length} fix task(s) from flow-tracing findings.`);
    }
  }

  // ================================================================
  // Build cycle feedback for replanning
  // ================================================================

  private buildCycleFeedback(
    codexFeedback: string | null,
    flowReport: FlowTracingReport | null,
    unresolvedIssues: KnownIssue[],
    cycleNum?: number,
  ): string {
    const sections: string[] = [];

    if (codexFeedback) {
      sections.push("## Codex Review Feedback\n\n" + codexFeedback);
    }

    if (flowReport && flowReport.findings.length > 0) {
      const summaryPath = cycleNum
        ? getFlowTracingSummaryPath(this.options.project, cycleNum)
        : null;

      const critical = flowReport.findings.filter((f) => f.severity === "critical");
      const high = flowReport.findings.filter((f) => f.severity === "high");
      const medium = flowReport.findings.filter((f) => f.severity === "medium");
      const low = flowReport.findings.filter((f) => f.severity === "low");

      const formatFinding = (f: FlowTracingReport["findings"][0]) =>
        `- [${f.severity.toUpperCase()}] ${f.title}: ${f.description} (${f.file_path}${f.line_number !== null && f.line_number !== undefined ? `:${f.line_number}` : ""})`;

      const findingLines: string[] = [];

      if (critical.length > 0 || high.length > 0) {
        // Show critical+high verbatim, roll up medium/low
        findingLines.push(...[...critical, ...high].map(formatFinding));
        const rollUp: string[] = [];
        if (medium.length > 0) rollUp.push(`${medium.length} medium`);
        if (low.length > 0) rollUp.push(`${low.length} low`);
        if (rollUp.length > 0) {
          findingLines.push(`\nPlus ${rollUp.join(" and ")} findings.${summaryPath ? ` See: ${summaryPath}` : ""}`);
        }
      } else if (medium.length > 0) {
        // No critical/high — show medium verbatim, roll up low
        findingLines.push(...medium.map(formatFinding));
        if (low.length > 0) {
          findingLines.push(`\nPlus ${low.length} low findings.${summaryPath ? ` See: ${summaryPath}` : ""}`);
        }
      } else {
        // Only low — show verbatim
        findingLines.push(...low.map(formatFinding));
      }

      sections.push(
        "## Flow-Tracing Findings\n\n" + findingLines.join("\n"),
      );
    }

    if (unresolvedIssues.length > 0) {
      const knownIssuesPath = getKnownIssuesPath(this.options.project);

      const critical = unresolvedIssues.filter((i) => i.severity === "critical");
      const high = unresolvedIssues.filter((i) => i.severity === "high");
      const medium = unresolvedIssues.filter((i) => i.severity === "medium");
      const low = unresolvedIssues.filter((i) => i.severity === "low");

      const formatIssue = (i: KnownIssue) =>
        `- [${i.severity.toUpperCase()}] ${i.description}${i.file_path ? ` (${i.file_path})` : ""} [source: ${i.source}, cycle ${i.found_in_cycle}]`;

      const issueLines: string[] = [];

      if (critical.length > 0 || high.length > 0) {
        issueLines.push(...[...critical, ...high].map(formatIssue));
        const rollUp: string[] = [];
        if (medium.length > 0) rollUp.push(`${medium.length} medium`);
        if (low.length > 0) rollUp.push(`${low.length} low`);
        if (rollUp.length > 0) {
          issueLines.push(`\nPlus ${rollUp.join(" and ")} issues. See: ${knownIssuesPath}`);
        }
      } else if (medium.length > 0) {
        issueLines.push(...medium.map(formatIssue));
        if (low.length > 0) {
          issueLines.push(`\nPlus ${low.length} low issues. See: ${knownIssuesPath}`);
        }
      } else {
        issueLines.push(...low.map(formatIssue));
      }

      sections.push(
        "## Unresolved Known Issues\n\n" + issueLines.join("\n"),
      );
    }

    return sections.length > 0
      ? sections.join("\n\n")
      : "";
  }

  // ================================================================
  // Private helpers
  // ================================================================

  private printBanner(): void {
    console.log("");
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log(chalk.bold.cyan("  CLAUDE CODE CONDUCTOR (C3)"));
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log("");
    console.log(chalk.white(`  Feature:      ${this.options.feature}`));
    console.log(chalk.white(`  Project:      ${this.options.project}`));
    console.log(chalk.white(`  Concurrency:  ${this.options.concurrency} worker(s)`));
    console.log(chalk.white(`  Runtime:      ${this.options.workerRuntime}`));
    const mc = this.options.modelConfig;
    console.log(chalk.white(`  Worker Model: ${mc.worker} (${MODEL_TIER_TO_ID[mc.worker]})`));
    console.log(chalk.white(`  Agent Model:  ${mc.subagent} (${MODEL_TIER_TO_ID[mc.subagent]})`));
    if (mc.extendedContext) {
      console.log(chalk.white(`  Context:      Extended (1M tokens)`));
    }
    console.log(chalk.white(`  Max Cycles:   ${this.options.maxCycles}`));
    console.log(chalk.white(`  Usage Limit:  ${(this.options.usageThreshold * 100).toFixed(0)}%`));
    console.log(chalk.white(`  Skip Codex:   ${this.options.skipCodex ? "Yes" : "No"}`));
    console.log(chalk.white(`  Dry Run:      ${this.options.dryRun ? "Yes" : "No"}`));
    console.log("");
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log("");
  }

  private printProgress(
    completed: number,
    failed: number,
    remaining: number,
    activeWorkers: number,
  ): void {
    const total = completed + failed + remaining;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const bar = this.buildProgressBar(pct);

    console.log(
      chalk.gray(`  [${new Date().toLocaleTimeString()}] `) +
      chalk.white(`Progress: ${bar} ${pct}% `) +
      chalk.green(`${completed} done `) +
      chalk.red(`${failed} failed `) +
      chalk.yellow(`${remaining} remaining `) +
      chalk.cyan(`(${activeWorkers} worker(s) active)`),
    );
  }

  private buildProgressBar(percent: number): string {
    const width = 20;
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return chalk.green("\u2588".repeat(filled)) + chalk.gray("\u2591".repeat(empty));
  }
}

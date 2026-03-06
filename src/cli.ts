#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { Orchestrator } from "./core/orchestrator.js";
import type { CLIOptions, OrchestratorState, Task, UsageSnapshot, WorkerRuntime } from "./utils/types.js";
import {
  getStatePath,
  getLogsDir,
  getOrchestratorDir,
  getTasksDir,
  getPauseSignalPath,
} from "./utils/constants.js";

// ============================================================
// Helpers
// ============================================================

async function readState(projectDir: string): Promise<OrchestratorState | null> {
  const statePath = getStatePath(projectDir);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OrchestratorState>;
    return {
      ...parsed,
      worker_runtime: parsed.worker_runtime ?? "claude",
      claude_usage: parsed.claude_usage ?? null,
      codex_usage: parsed.codex_usage ?? null,
    } as OrchestratorState;
  } catch {
    return null;
  }
}

async function readAllTasks(projectDir: string): Promise<Task[]> {
  const tasksDir = getTasksDir(projectDir);
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(tasksDir, entry), "utf-8");
      tasks.push(JSON.parse(raw) as Task);
    } catch {
      // skip invalid files
    }
  }
  return tasks;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function parseWorkerRuntime(value: string): WorkerRuntime {
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw new InvalidArgumentError(
    `Invalid worker runtime "${value}". Expected "claude" or "codex".`,
  );
}

function printUsageSnapshot(label: string, usage: UsageSnapshot): void {
  console.log(chalk.white(`${label}:`));
  console.log(chalk.white(`      5-hour:       ${(usage.five_hour * 100).toFixed(1)}%`));
  console.log(chalk.white(`      7-day:        ${(usage.seven_day * 100).toFixed(1)}%`));
  if (usage.five_hour_resets_at) {
    console.log(chalk.gray(`      5h resets at:  ${usage.five_hour_resets_at}`));
  }
  console.log(chalk.gray(`      Last checked:  ${usage.last_checked}`));
}

// ============================================================
// CLI Program
// ============================================================

const program = new Command();

program
  .name("conduct")
  .description("Claude Code Conductor -- hierarchical multi-agent orchestration for large features")
  .version("0.1.5");

// ============================================================
// start command
// ============================================================

program
  .command("start")
  .description("Start a new conductor run")
  .argument("<feature>", "Feature description")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("-c, --concurrency <n>", "Number of parallel workers", "2")
  .option("--max-cycles <n>", "Maximum plan-execute-review cycles", "5")
  .option("--usage-threshold <n>", "Wind-down usage threshold (0-1)", "0.80")
  .option("--skip-codex", "Skip Codex reviews", false)
  .option("--skip-flow-review", "Skip flow-tracing review phase", false)
  .option("--dry-run", "Plan only, don't execute", false)
  .option("--current-branch", "Work on the current branch instead of creating conduct/<slug>", false)
  .option("--context-file <path>", "Path to pre-gathered context file (skips interactive Q&A)")
  .option("--worker-runtime <runtime>", "Worker execution backend: claude or codex", parseWorkerRuntime, "claude")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (feature: string, opts: Record<string, string | boolean | undefined>) => {
    const projectDir = path.resolve(opts.project as string);

    const options: CLIOptions = {
      project: projectDir,
      feature,
      concurrency: parseInt(opts.concurrency as string, 10) || 2,
      maxCycles: parseInt(opts.maxCycles as string, 10) || 5,
      usageThreshold: parseFloat(opts.usageThreshold as string) || 0.8,
      skipCodex: Boolean(opts.skipCodex),
      skipFlowReview: Boolean(opts.skipFlowReview),
      dryRun: Boolean(opts.dryRun),
      resume: false,
      verbose: Boolean(opts.verbose),
      contextFile: opts.contextFile ? path.resolve(opts.contextFile as string) : null,
      currentBranch: Boolean(opts.currentBranch),
      workerRuntime: opts.workerRuntime as WorkerRuntime,
      forceResume: false,
    };

    try {
      const orchestrator = new Orchestrator(options);
      await orchestrator.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nConductor failed: ${message}\n`));
      process.exit(1);
    }
  });

// ============================================================
// status command
// ============================================================

program
  .command("status")
  .description("Show current conductor status")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .action(async (opts: Record<string, string>) => {
    const projectDir = path.resolve(opts.project);

    const state = await readState(projectDir);
    if (!state) {
      console.log(chalk.yellow("\nNo conductor state found in this project."));
      console.log(chalk.gray(`Looked in: ${getStatePath(projectDir)}\n`));
      return;
    }

    const tasks = await readAllTasks(projectDir);
    const completed = tasks.filter((t) => t.status === "completed");
    const failed = tasks.filter((t) => t.status === "failed");
    const pending = tasks.filter((t) => t.status === "pending");
    const inProgress = tasks.filter((t) => t.status === "in_progress");

    // Status color
    const statusColors: Record<string, (s: string) => string> = {
      initializing: chalk.blue,
      questioning: chalk.blue,
      planning: chalk.cyan,
      executing: chalk.green,
      reviewing: chalk.magenta,
      flow_tracing: chalk.magenta,
      checkpointing: chalk.cyan,
      paused: chalk.yellow,
      completed: chalk.green,
      failed: chalk.red,
      escalated: chalk.red,
    };

    const colorFn = statusColors[state.status] ?? chalk.white;

    console.log("");
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log(chalk.bold.cyan("  C3 CONDUCTOR STATUS"));
    console.log(chalk.bold.cyan("=".repeat(60)));
    console.log("");
    console.log(chalk.white(`  Status:       `) + colorFn(state.status.toUpperCase()));
    if (state.progress) {
      console.log(chalk.white(`  Progress:     `) + chalk.yellow(state.progress));
    }
    console.log(chalk.white(`  Feature:      ${state.feature}`));
    console.log(chalk.white(`  Branch:       ${state.branch}`));
    console.log(chalk.white(`  Runtime:      ${state.worker_runtime}`));
    console.log(chalk.white(`  Cycle:        ${state.current_cycle} / ${state.max_cycles}`));
    console.log(chalk.white(`  Concurrency:  ${state.concurrency}`));
    console.log(chalk.white(`  Started:      ${state.started_at}`));
    console.log(chalk.white(`  Updated:      ${state.updated_at}`));
    console.log("");

    // Task summary
    console.log(chalk.bold("  Tasks:"));
    console.log(chalk.green(`    Completed:    ${completed.length}`));
    console.log(chalk.red(`    Failed:       ${failed.length}`));
    console.log(chalk.yellow(`    Pending:      ${pending.length}`));
    console.log(chalk.cyan(`    In Progress:  ${inProgress.length}`));
    console.log(chalk.white(`    Total:        ${tasks.length}`));
    console.log("");

    // Usage
    console.log(chalk.bold("  Usage:"));
    printUsageSnapshot(`    Active (${state.worker_runtime})`, state.usage);
    if (state.claude_usage && state.worker_runtime !== "claude") {
      printUsageSnapshot("    Claude SDK", state.claude_usage);
    }
    if (state.codex_usage && state.worker_runtime !== "codex") {
      printUsageSnapshot("    Codex CLI", state.codex_usage);
    }
    console.log("");

    // Pause info
    if (state.status === "paused" && state.paused_at) {
      console.log(chalk.yellow.bold("  Paused:"));
      console.log(chalk.yellow(`    Paused at:    ${state.paused_at}`));
      if (state.resume_after) {
        console.log(chalk.yellow(`    Resume after: ${state.resume_after}`));
      }
      console.log("");
    }

    // Active sessions
    if (state.active_session_ids.length > 0) {
      console.log(chalk.bold("  Active Sessions:"));
      for (const sid of state.active_session_ids) {
        console.log(chalk.cyan(`    - ${sid}`));
      }
      console.log("");
    }

    // Cycle history
    if (state.cycle_history.length > 0) {
      console.log(chalk.bold("  Cycle History:"));
      for (const cycle of state.cycle_history) {
        const duration = formatDuration(cycle.duration_ms);
        const planApproved = cycle.codex_plan_approved
          ? chalk.green("approved")
          : chalk.red("not approved");
        const codeApproved = cycle.codex_code_approved
          ? chalk.green("approved")
          : chalk.red("not approved");
        const flowInfo = cycle.flow_tracing
          ? `, flow: ${cycle.flow_tracing.total_findings} finding(s)`
          : "";
        console.log(
          chalk.white(
            `    Cycle ${cycle.cycle}: ${cycle.tasks_completed} completed, ` +
            `${cycle.tasks_failed} failed, plan ${planApproved}, ` +
            `code ${codeApproved}${flowInfo}, ${duration}`,
          ),
        );
      }
      console.log("");
    }

    // Task details
    if (tasks.length > 0) {
      console.log(chalk.bold("  Task Details:"));
      for (const task of tasks) {
        const statusIcon =
          task.status === "completed"
            ? chalk.green("[DONE]")
            : task.status === "failed"
              ? chalk.red("[FAIL]")
              : task.status === "in_progress"
                ? chalk.cyan("[WORK]")
                : chalk.gray("[PEND]");

        console.log(`    ${statusIcon} ${chalk.white(task.id)}: ${task.subject}`);
        if (task.owner) {
          console.log(chalk.gray(`           Owner: ${task.owner}`));
        }
        if (task.result_summary) {
          console.log(
            chalk.gray(`           Result: ${task.result_summary.substring(0, 80)}`),
          );
        }
      }
      console.log("");
    }

    console.log(chalk.bold.cyan("=".repeat(60)) + "\n");
  });

// ============================================================
// resume command
// ============================================================

program
  .command("resume")
  .description("Resume a paused conductor run")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("-c, --concurrency <n>", "Number of parallel workers")
  .option("--skip-codex", "Skip Codex reviews", false)
  .option("--skip-flow-review", "Skip flow-tracing review phase", false)
  .option("--worker-runtime <runtime>", "Worker execution backend: claude or codex", parseWorkerRuntime)
  .option("--force-resume", "Force resume even if state is stale (for example stuck in executing)", false)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const projectDir = path.resolve(opts.project as string);

    const state = await readState(projectDir);
    if (!state) {
      console.error(chalk.red("\nNo conductor state found. Nothing to resume.\n"));
      process.exit(1);
    }

    if (state.status === "completed" || state.status === "failed") {
      console.error(
        chalk.red(
          `\nConductor is in '${state.status}' state. ` +
          `Start a new run instead of resuming.\n`,
        ),
      );
      process.exit(1);
    }

    const forceResume = Boolean(opts.forceResume);
    const resumableStatuses = new Set(["paused", "escalated"]);
    const forceableStatuses = new Set(["executing", "planning", "reviewing", "checkpointing"]);

    if (!resumableStatuses.has(state.status)) {
      if (!forceResume || !forceableStatuses.has(state.status)) {
        console.error(
          chalk.red(
            `\nConductor is in '${state.status}' state, not 'paused' or 'escalated'. ` +
            `Cannot resume.\n`,
          ),
        );
        if (forceableStatuses.has(state.status)) {
          console.error(
            chalk.yellow("If this state is stale, retry with: conduct resume --force-resume ...\n"),
          );
        }
        process.exit(1);
      }

      console.log(
        chalk.yellow(
          `\nForce-resuming conductor from stale '${state.status}' state for: ${state.feature}\n`,
        ),
      );
    } else {
      console.log(chalk.cyan(`\nResuming conductor for: ${state.feature}\n`));
    }

    const options: CLIOptions = {
      project: projectDir,
      feature: state.feature,
      concurrency: opts.concurrency
        ? parseInt(opts.concurrency as string, 10)
        : state.concurrency,
      maxCycles: state.max_cycles,
      usageThreshold: 0.8,
      skipCodex: Boolean(opts.skipCodex),
      skipFlowReview: Boolean(opts.skipFlowReview),
      dryRun: false,
      resume: true,
      verbose: Boolean(opts.verbose),
      contextFile: null,
      currentBranch: false,
      workerRuntime: opts.workerRuntime
        ? opts.workerRuntime as WorkerRuntime
        : state.worker_runtime,
      forceResume,
    };

    try {
      const orchestrator = new Orchestrator(options);
      await orchestrator.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nResume failed: ${message}\n`));
      process.exit(1);
    }
  });

// ============================================================
// pause command
// ============================================================

program
  .command("pause")
  .description("Signal a running conductor to pause gracefully")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .action(async (opts: Record<string, string>) => {
    const projectDir = path.resolve(opts.project);

    const state = await readState(projectDir);
    if (!state) {
      console.error(chalk.red("\nNo conductor state found. Nothing to pause.\n"));
      process.exit(1);
    }

    if (state.status !== "executing" && state.status !== "planning" && state.status !== "reviewing") {
      console.error(
        chalk.red(
          `\nConductor is in '${state.status}' state. ` +
          `Can only pause when executing, planning, or reviewing.\n`,
        ),
      );
      process.exit(1);
    }

    // Write the pause signal file
    const signalPath = getPauseSignalPath(projectDir);
    const signal = {
      requested_at: new Date().toISOString(),
      requested_by: "user",
    };
    await fs.writeFile(signalPath, JSON.stringify(signal, null, 2) + "\n", "utf-8");

    console.log(chalk.yellow("\n  Pause signal sent."));
    console.log(chalk.yellow("  The conductor will pause after current workers finish their tasks."));
    console.log(chalk.yellow(`  Resume later with: conduct resume --project "${projectDir}"\n`));
  });

// ============================================================
// log command
// ============================================================

program
  .command("log")
  .description("Tail the conductor log")
  .option("-p, --project <dir>", "Project directory", process.cwd())
  .option("-n, --lines <n>", "Number of lines to show", "50")
  .action(async (opts: Record<string, string>) => {
    const projectDir = path.resolve(opts.project);
    const logPath = path.join(getLogsDir(projectDir), "conductor.log");
    const numLines = parseInt(opts.lines, 10) || 50;

    try {
      const content = await fs.readFile(logPath, "utf-8");
      const lines = content.split("\n");
      const tail = lines.slice(-numLines);

      console.log(chalk.bold.cyan(`\n--- ${logPath} (last ${numLines} lines) ---\n`));

      for (const line of tail) {
        if (line.includes("[ERROR]")) {
          console.log(chalk.red(line));
        } else if (line.includes("[WARN]")) {
          console.log(chalk.yellow(line));
        } else if (line.includes("[DEBUG]")) {
          console.log(chalk.gray(line));
        } else {
          console.log(line);
        }
      }

      console.log(chalk.bold.cyan("\n--- end of log ---\n"));
    } catch {
      console.error(chalk.red(`\nLog file not found: ${logPath}\n`));
      console.error(
        chalk.gray("Make sure a conductor run has been started in this project."),
      );
      process.exit(1);
    }
  });

// ============================================================
// Parse
// ============================================================

program.parse();

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

import type { PlannerOutput, TaskDefinition, Task, ThreatModel, RoleModelSpec } from "../utils/types.js";
import { getPlanPath, getTasksDraftPath, getTasksDir, getOrchestratorDir, PLANNER_ALLOWED_TOOLS, DEFAULT_ROLE_CONFIG } from "../utils/constants.js";
import { specToSdkArgs } from "../utils/models-config.js";
import type { Logger } from "../utils/logger.js";
import { queryWithTimeout } from "../utils/sdk-timeout.js";
import { validateTaskArray } from "../utils/task-validator.js";
import { writeFileSecure } from "../utils/secure-fs.js";
import { compactReplanPrompt } from "../utils/prompt-compactor.js";

// ============================================================
// Planner
// ============================================================

/**
 * Uses the Claude Agent SDK to analyze a codebase and create
 * detailed implementation plans broken into parallelizable tasks.
 *
 * Accepts either a `RoleModelSpec` (preferred — carries model + effort) or
 * a bare model ID string (legacy). When neither is supplied, falls back to
 * `DEFAULT_ROLE_CONFIG.planner` (Opus 4.7 xhigh).
 */
export class Planner {
  private readonly model: string;
  private readonly effort: RoleModelSpec["effort"];

  constructor(
    private projectDir: string,
    private logger: Logger,
    spec?: RoleModelSpec | string,
  ) {
    const resolved = typeof spec === "string"
      ? { model: spec, effort: DEFAULT_ROLE_CONFIG.planner.effort }
      : specToSdkArgs(spec ?? DEFAULT_ROLE_CONFIG.planner);
    this.model = resolved.model;
    this.effort = resolved.effort;
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Ask exhaustive clarifying questions about a feature.
   *
   * This is INTERACTIVE: it prints questions to stdout, reads answers
   * from stdin, and returns the combined Q&A as a context string.
   */
  async askQuestions(feature: string): Promise<string> {
    this.logger.info("Generating clarifying questions about the feature...");

    const questionPrompt = [
      "You are helping plan a large feature implementation.",
      `Ask exhaustive clarifying questions about: ${feature}`,
      "",
      "Ask about edge cases, user flows, error handling, data models,",
      "integrations, UI/UX, testing strategy, performance considerations,",
      "security implications, backwards compatibility, deployment strategy, etc.",
      "",
      "Ask specifically about security:",
      "- Authentication: Who should be able to use this feature? What auth level is required?",
      "- Authorization: What role/permission model applies? Are there multi-tenancy concerns?",
      "- Data sensitivity: What data is created/read/updated/deleted? What classification?",
      "- Rate limiting: What abuse scenarios exist? What limits are appropriate?",
      "- Audit logging: What actions need to be audit-logged?",
      "",
      "Ask at least 10 questions. Format each question with a number.",
      "Look at the codebase first to understand the existing architecture",
      "so your questions are informed and specific.",
    ].join("\n");

    // Spawn an SDK session with read-only tools so the LLM
    // can inspect the codebase to inform its questions.
    let questionsText = await queryWithTimeout(
      questionPrompt,
      {
        allowedTools: ["Read", "Glob", "Grep", "LSP"],
        cwd: this.projectDir,
        maxTurns: 20,
        model: this.model,
        effort: this.effort,
        settingSources: ["project"],
      },
      5 * 60 * 1000, // 5 min
      "question-generation",
      this.logger,
    );

    if (!questionsText) {
      this.logger.warn("No questions were generated; using fallback.");
      questionsText = "1. Could you describe the feature in more detail?";
    }

    // Print the questions to stdout
    console.log("\n========================================");
    console.log("  CLARIFYING QUESTIONS");
    console.log("========================================\n");
    console.log(questionsText);
    console.log("\n========================================");
    console.log("  Please answer each question below.");
    console.log("  Type your answer after each prompt.");
    console.log("========================================\n");

    // Parse numbered questions from the output
    const questionLines = questionsText.split("\n").filter((line) =>
      /^\s*\d+[\.\)]\s+/.test(line),
    );

    const rl = readline.createInterface({ input, output });
    const qaEntries: string[] = [];

    try {
      for (const questionLine of questionLines) {
        const trimmed = questionLine.trim();
        console.log(`\n${trimmed}`);

        const answer = await rl.question("Your answer: ");
        qaEntries.push(`Q: ${trimmed}\nA: ${answer}`);
      }

      // If we couldn't parse individual questions, ask for a single block answer
      if (qaEntries.length === 0) {
        console.log(
          "\n(Could not parse individual questions. Please provide your answers below.)\n",
        );
        console.log(questionsText);
        const answer = await rl.question("\nYour answers: ");
        qaEntries.push(`Questions:\n${questionsText}\n\nAnswers:\n${answer}`);
      }
    } finally {
      rl.close();
    }

    const qaContext = qaEntries.join("\n\n");

    this.logger.info(`Collected ${qaEntries.length} Q&A pair(s).`);

    return qaContext;
  }

  /**
   * Analyze the codebase and create a detailed implementation plan.
   *
   * Spawns an SDK session that can read the codebase, then produces
   * a plan markdown file and parsed task definitions.
   */
  async createPlan(
    feature: string,
    qaContext: string,
    planVersion: number,
  ): Promise<PlannerOutput> {
    this.logger.info(`Creating implementation plan v${planVersion}...`);

    const planPrompt = this.buildCreatePlanPrompt(feature, qaContext);
    const plannerMcp = this.createPlannerMcpServer();

    let planOutput: string;
    try {
      planOutput = await queryWithTimeout(
        planPrompt,
        {
          allowedTools: PLANNER_ALLOWED_TOOLS,
          cwd: this.projectDir,
          maxTurns: 80,
          mcpServers: { planner: plannerMcp },
          model: this.model,
          effort: this.effort,
          settingSources: ["project"],
        },
        15 * 60 * 1000, // 15 min
        "plan-creation",
        this.logger,
      );
    } finally {
      await plannerMcp.instance.close().catch(() => {});
    }

    this.logger.info(`Planner finished. planOutput truthy=${!!planOutput}, length=${planOutput.length}`);
    if (!planOutput) {
      throw new Error("Planner SDK session returned no output");
    }

    // Read tasks from the dedicated JSON file (authoritative source)
    const tasks = await this.readAndValidateTasksDraft();

    // Write the plan markdown to disk with secure permissions
    const planPath = getPlanPath(this.projectDir, planVersion);
    await writeFileSecure(planPath, planOutput);
    this.logger.info(`Plan written to ${planPath} (${tasks.length} task(s))`);

    return {
      plan_markdown: planOutput,
      tasks,
      threat_model: this.parseThreatModel(planOutput),
      anchor_task_subjects: tasks
        .filter(t => t.depends_on_subjects.length === 0)
        .filter(t => tasks.filter(other => other.depends_on_subjects.includes(t.subject)).length >= 2)
        .map(t => t.subject),
    };
  }

  /**
   * Replan after a checkpoint cycle.
   *
   * Looks at what tasks are completed, what failed, and any Codex
   * feedback, then produces an updated plan covering only remaining work.
   */
  async replan(
    feature: string,
    previousPlanPath: string,
    completedTasks: Task[],
    failedTasks: Task[],
    codexFeedback: string | null,
    planVersion: number,
    cycleFeedback?: string,
  ): Promise<PlannerOutput> {
    this.logger.info(
      `Replanning (v${planVersion}) — ${completedTasks.length} completed, ${failedTasks.length} failed`,
    );

    const rawReplanPrompt = this.buildReplanPrompt(
      feature,
      previousPlanPath,
      completedTasks,
      failedTasks,
      codexFeedback,
      cycleFeedback,
    );

    // Defense-in-depth: progressively compact the prompt if it's too large.
    // The constructor guarantees `this.model` is always populated.
    const replanPrompt = await compactReplanPrompt(
      rawReplanPrompt,
      this.projectDir,
      this.model,
      this.logger,
    );

    const plannerMcp = this.createPlannerMcpServer();

    let planOutput: string;
    try {
      planOutput = await queryWithTimeout(
        replanPrompt,
        {
          allowedTools: PLANNER_ALLOWED_TOOLS,
          cwd: this.projectDir,
          maxTurns: 80,
          mcpServers: { planner: plannerMcp },
          model: this.model,
          effort: this.effort,
          settingSources: ["project"],
        },
        15 * 60 * 1000, // 15 min
        "replan",
        this.logger,
      );
    } finally {
      await plannerMcp.instance.close().catch(() => {});
    }

    if (!planOutput) {
      throw new Error("Replanner SDK session returned no output");
    }

    // Read tasks from the dedicated JSON file (authoritative source)
    const tasks = await this.readAndValidateTasksDraft();

    const planPath = getPlanPath(this.projectDir, planVersion);
    // Use secure permissions: writeFileSecure calls chmod after write
    await writeFileSecure(planPath, planOutput);
    this.logger.info(`Replan written to ${planPath} (${tasks.length} task(s))`);

    return {
      plan_markdown: planOutput,
      tasks,
      threat_model: this.parseThreatModel(planOutput),
      anchor_task_subjects: tasks
        .filter(t => t.depends_on_subjects.length === 0)
        .filter(t => tasks.filter(other => other.depends_on_subjects.includes(t.subject)).length >= 2)
        .map(t => t.subject),
    };
  }

  // ----------------------------------------------------------------
  // Private: MCP server + task file reading
  // ----------------------------------------------------------------

  /**
   * Create an in-process MCP server with the validate_task_definitions tool.
   * The planner agent can call this tool to validate its task output before the session ends.
   */
  private createPlannerMcpServer() {
    const projectDir = this.projectDir;
    const conductorDir = getOrchestratorDir(projectDir);

    const validateTool = tool(
      "validate_task_definitions",
      "Validate task definitions JSON file. Call this after writing tasks-draft.json to check for errors. " +
      "Returns validation results including error details if any tasks are invalid.",
      {
        file_path: z.string().describe(
          "Absolute path to the tasks JSON file to validate (must be under the .conductor/ directory)",
        ),
      },
      async (args: { file_path: string }) => {
        // Constrain path to .conductor/ directory
        const resolved = path.resolve(args.file_path);
        const resolvedConductorDir = path.resolve(conductorDir) + path.sep;
        if (!resolved.startsWith(resolvedConductorDir) && resolved !== path.resolve(conductorDir)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                valid: false,
                errors: [`File path must be under ${conductorDir}`],
              }),
            }],
          };
        }

        let content: string;
        try {
          content = await fs.readFile(resolved, "utf-8");
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                valid: false,
                errors: [`Cannot read file: ${err instanceof Error ? err.message : String(err)}`],
              }),
            }],
          };
        }

        const result = validateTaskArray(content);
        if (result.valid) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ valid: true, task_count: result.tasks.length }),
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ valid: false, errors: result.errors }),
          }],
        };
      },
    );

    return createSdkMcpServer({
      name: "planner",
      version: "0.1.0",
      tools: [validateTool],
    });
  }

  /**
   * Read and validate the tasks-draft.json file written by the planner agent.
   * This is the authoritative source of task definitions — no markdown fallback.
   * Throws with diagnostics if the file is missing or invalid.
   */
  private async readAndValidateTasksDraft(): Promise<TaskDefinition[]> {
    const draftPath = getTasksDraftPath(this.projectDir);

    let content: string;
    try {
      content = await fs.readFile(draftPath, "utf-8");
    } catch (err) {
      throw new Error(
        `Planner did not write tasks-draft.json. The LLM session did not follow task output instructions. ` +
        `Expected file at: ${draftPath}. Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = validateTaskArray(content);
    if (!result.valid) {
      throw new Error(
        `tasks-draft.json failed validation:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }

    this.logger.info(`Validated ${result.tasks.length} task(s) from ${draftPath}`);
    return result.tasks;
  }

  // ----------------------------------------------------------------
  // Private: Prompt builders
  // ----------------------------------------------------------------

  private buildCreatePlanPrompt(feature: string, qaContext: string): string {
    const tasksDraftPath = getTasksDraftPath(this.projectDir);

    return [
      "You are a senior software architect planning a large feature implementation.",
      "Your job is to analyze the codebase and create a detailed, actionable plan.",
      "",
      "## Feature Description",
      "",
      feature,
      "",
      "## Q&A Context (from the user)",
      "",
      qaContext,
      "",
      "## Instructions",
      "",
      "1. Thoroughly explore the codebase using the available tools (Read, Glob, Grep, Bash).",
      "   Understand the project structure, existing patterns, frameworks, and conventions.",
      "",
      "2. Create a detailed implementation plan in Markdown with numbered steps.",
      "   Each step should be a discrete, parallelizable unit of work that one developer",
      "   (or one AI agent) can complete independently.",
      "",
      "3. For each step, describe:",
      "   - What files to create or modify",
      "   - What the implementation should do",
      "   - Key design decisions and rationale",
      "   - Dependencies on other steps (if any)",
      "   - Testing approach for that step",
      "",
      "4. Consider:",
      "   - Correct dependency ordering (what must be done first)",
      "   - Maximizing parallelism (independent tasks that can run concurrently)",
      "   - Small, focused tasks rather than monolithic ones",
      "   - Error handling and edge cases",
      "   - Testing strategy",
      "",
      "5. BEFORE creating tasks, produce a threat model section with:",
      "   - Data flows: What data moves between which components?",
      "   - Trust boundaries: Where do privilege levels change?",
      "   - Attack surfaces: For each new endpoint/input/integration, what could go wrong? (Use STRIDE: Spoofing, Tampering, Repudiation, Information Disclosure, DoS, Elevation of Privilege)",
      "   - Required mitigations: For each attack surface, what specific mitigation is needed?",
      "",
      "   Format the threat model as a JSON block tagged ```threat_model in the plan markdown.",
      "",
      "6. TASK DEFINITIONS — CRITICAL STEP:",
      "",
      "   You MUST write your task definitions as a JSON array to a dedicated file.",
      `   Use the Write tool to create: ${tasksDraftPath}`,
      "",
      "   The file must contain a JSON array where each task object has these fields:",
      "",
      "   {",
      '     "subject": "Short title for the task",',
      '     "description": "Detailed description including exact files, function signatures, API contracts...",',
      '     "depends_on_subjects": ["Subject of dependency 1", "Subject of dependency 2"],',
      '     "estimated_complexity": "small|medium|large",',
      '     "task_type": "backend_api|frontend_ui|database|security|testing|infrastructure|reverse_engineering|integration|general",',
      '     "security_requirements": ["Must use auth middleware", "Must validate input with Zod schema"],',
      '     "performance_requirements": ["Must paginate results", "Must use batch fetch"],',
      '     "acceptance_criteria": ["Type check passes", "All new endpoints have auth", "Tests added"]',
      "   }",
      "",
      "   Field descriptions:",
      "   - `subject`: A concise, unique title (used to reference the task).",
      "   - `description`: Enough detail for an autonomous agent to implement it.",
      "   - `depends_on_subjects`: Array of subject strings from other tasks that must",
      "     be completed before this one can start. Use an empty array if no dependencies.",
      "   - `estimated_complexity`: 'small' (~30 min), 'medium' (~1-2 hours), 'large' (~3+ hours).",
      "   - `task_type`: The category of work.",
      "   - `security_requirements`: Array of specific security controls this task must implement.",
      "   - `performance_requirements`: Array of specific performance constraints.",
      "   - `acceptance_criteria`: Array of verifiable conditions that must be true when done.",
      "",
      "7. AFTER writing the tasks file, you MUST call the `mcp__planner__validate_task_definitions` tool",
      `   with the file path: ${tasksDraftPath}`,
      "   This tool validates that all tasks are well-formed, have no duplicate subjects,",
      "   no dangling dependency references, and no dependency cycles.",
      "   If validation fails, fix the errors and re-write the file, then validate again.",
      "   Do NOT finish until validation passes.",
      "",
      "CRITICAL SECURITY RULE: When a task introduces a new attack surface (endpoint, file upload,",
      "webhook, user input field, external integration), you MUST include security_requirements",
      "for that task specifying the exact controls needed. If the security controls are complex enough,",
      "create a dedicated security task with task_type='security' that depends on or is depended upon",
      "by the feature task.",
      "",
      "PARALLEL SAFETY: For each pair of tasks that can run in parallel, verify they do not modify",
      "the same files. If two tasks must touch the same file, make one depend on the other, or",
      "create a shared foundation task they both depend on.",
      "",
      "ANCHOR TASKS: Mark tasks that have no dependencies and are depended upon by 2+ other tasks.",
      "These 'anchor tasks' will be executed first to establish shared foundations (types, schemas, utilities).",
      "",
      `CRITICAL: You MUST write the task definitions JSON file to ${tasksDraftPath} and validate it.`,
      "Without this file, the orchestrator cannot create tasks and the entire plan will be rejected.",
      "If you are running low on turns, prioritize writing the tasks file over further exploration.",
    ].join("\n");
  }

  private buildReplanPrompt(
    feature: string,
    previousPlanPath: string,
    completedTasks: Task[],
    failedTasks: Task[],
    codexFeedback: string | null,
    cycleFeedback?: string,
  ): string {
    const tasksDraftPath = getTasksDraftPath(this.projectDir);
    const tasksDir = getTasksDir(this.projectDir);

    const completedSummary =
      completedTasks.length > 0
        ? [
            completedTasks.map((t) => `- [COMPLETED] ${t.subject}`).join("\n"),
            "",
            `Full details (result summaries, files changed) are in: ${tasksDir}/`,
            "Read individual task JSON files if you need specifics about what a task produced.",
          ].join("\n")
        : "(none)";

    const failedSummary =
      failedTasks.length > 0
        ? failedTasks
            .map(
              (t) =>
                `- [FAILED] ${t.subject}: ${t.result_summary ?? "(no error details)"}`,
            )
            .join("\n")
        : "(none)";

    const feedbackSection = codexFeedback
      ? ["## Codex Review Feedback", "", codexFeedback, ""].join("\n")
      : "";

    const cycleFeedbackSection = cycleFeedback
      ? [
          "## Previous Cycle Findings",
          "",
          cycleFeedback,
          "",
          "For each unresolved issue above, create a specific fix task.",
          "Each fix task should reference the original finding and specify exactly what to change.",
          "",
        ].join("\n")
      : "";

    return [
      "You are a senior software architect replanning after a checkpoint.",
      "A previous cycle of work has been completed. Some tasks succeeded, some failed.",
      "You need to create an UPDATED plan that covers only the REMAINING work.",
      "",
      "## Feature Description",
      "",
      feature,
      "",
      "## Previous Plan",
      "",
      `The previous plan is at: ${previousPlanPath}`,
      "Read it if you need to understand what was originally planned.",
      "Focus on the completed/failed task status and cycle findings below.",
      "",
      "## Completed Tasks",
      "",
      completedSummary,
      "",
      "## Failed Tasks",
      "",
      failedSummary,
      "",
      feedbackSection,
      cycleFeedbackSection,
      "## Instructions",
      "",
      "1. Explore the codebase to see the current state of the implementation.",
      "   Look at what was actually built (not just what was planned).",
      "",
      "2. DO NOT re-plan completed work. Only plan remaining tasks.",
      "",
      "3. For failed tasks, analyze what went wrong and create corrected task",
      "   definitions that address the failures.",
      "",
      "4. If Codex review feedback is provided, incorporate those suggestions",
      "   into the updated plan.",
      "",
      "5. If previous cycle findings are provided (from flow-tracing or code review),",
      "   create specific fix tasks for each unresolved issue.",
      "",
      "6. Create an updated Markdown plan describing the remaining work.",
      "",
      "7. TASK DEFINITIONS — CRITICAL STEP:",
      "",
      `   Use the Write tool to write your task definitions as a JSON array to: ${tasksDraftPath}`,
      "",
      "   Each task object must have: subject, description, depends_on_subjects,",
      "   estimated_complexity, task_type, security_requirements, performance_requirements,",
      "   acceptance_criteria. Only include tasks that still need to be done.",
      "",
      "8. AFTER writing the tasks file, call `mcp__planner__validate_task_definitions`",
      `   with file path: ${tasksDraftPath}`,
      "   If validation fails, fix the errors and re-write, then validate again.",
      "   Do NOT finish until validation passes.",
    ].join("\n");
  }

  // ----------------------------------------------------------------
  // Private: Parse threat model from plan output
  // ----------------------------------------------------------------

  /**
   * Extract the threat model JSON from the plan output.
   *
   * Looks for a fenced code block tagged with `threat_model` and
   * attempts to parse it as a ThreatModel.
   */
  private parseThreatModel(planOutput: string): ThreatModel | undefined {
    const threatModelRegex = /```threat_model\s*\n([\s\S]*?)```/g;
    const match = threatModelRegex.exec(planOutput);

    if (!match) {
      this.logger.debug("No threat_model block found in plan output");
      return undefined;
    }

    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;

      if (!parsed || typeof parsed !== "object") {
        this.logger.warn("Threat model block is not a valid object");
        return undefined;
      }

      const record = parsed as Record<string, unknown>;

      const featureSummary = typeof record.feature_summary === "string"
        ? record.feature_summary
        : "";

      const dataFlows = Array.isArray(record.data_flows)
        ? record.data_flows.filter((d): d is string => typeof d === "string")
        : [];

      const trustBoundaries = Array.isArray(record.trust_boundaries)
        ? record.trust_boundaries.filter((d): d is string => typeof d === "string")
        : [];

      const attackSurfaces = Array.isArray(record.attack_surfaces)
        ? record.attack_surfaces
            .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
            .map((s) => ({
              surface: typeof s.surface === "string" ? s.surface : "",
              threat_category: typeof s.threat_category === "string" ? s.threat_category : "",
              mitigation: typeof s.mitigation === "string" ? s.mitigation : "",
              mapped_to_task: typeof s.mapped_to_task === "string" ? s.mapped_to_task : undefined,
            }))
        : [];

      const unmappedMitigations = Array.isArray(record.unmapped_mitigations)
        ? record.unmapped_mitigations.filter((d): d is string => typeof d === "string")
        : [];

      return {
        feature_summary: featureSummary,
        data_flows: dataFlows,
        trust_boundaries: trustBoundaries,
        attack_surfaces: attackSurfaces,
        unmapped_mitigations: unmappedMitigations,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to parse threat model block: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}

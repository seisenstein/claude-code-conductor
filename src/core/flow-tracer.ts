import path from "node:path";

import { queryWithTimeout } from "../utils/sdk-timeout.js";

import type {
  FlowSpec,
  FlowFinding,
  FlowFindingSeverity,
  FlowTracingReport,
  FlowTracingSummary,
  FlowConfig,
} from "../utils/types.js";

import {
  FLOW_TRACING_READ_ONLY_TOOLS,
  FLOW_TRACING_WORKER_MAX_TURNS,
  MAX_FLOW_TRACING_WORKERS,
  FLOW_TRACING_OVERALL_TIMEOUT_MS,
  getFlowTracingDir,
  getFlowTracingReportPath,
  getFlowTracingSummaryPath,
} from "../utils/constants.js";

import { getFlowWorkerPrompt } from "../flow-worker-prompt.js";
import { loadFlowConfig } from "../utils/flow-config.js";
import type { Logger } from "../utils/logger.js";
import { mkdirSecure, writeFileSecure } from "../utils/secure-fs.js";

// ============================================================
// FlowTracer
// ============================================================

/**
 * Orchestrates flow-tracing review workers that trace user journeys
 * end-to-end across all code layers. Workers are read-only and report
 * findings without modifying code.
 *
 * This runs as Phase 3.5 between code review and checkpoint.
 */
export class FlowTracer {
  constructor(
    private projectDir: string,
    private logger: Logger,
    private model?: string,
    private extendedContext?: boolean,
  ) {}

  // ----------------------------------------------------------------
  // Main entry point
  // ----------------------------------------------------------------

  /**
   * Run flow-tracing review for a given cycle.
   *
   * 1. Use an SDK query to analyze the diff and extract user flows
   * 2. Spawn parallel read-only workers to trace each flow
   * 3. Collect and deduplicate findings
   * 4. Generate a report
   */
  async trace(
    changedFiles: string[],
    diff: string,
    cycle: number,
  ): Promise<FlowTracingReport> {
    // Load project-specific flow config (or generic defaults)
    const config = await loadFlowConfig(this.projectDir);

    // Ensure flow-tracing directory exists with secure permissions
    const flowDir = getFlowTracingDir(this.projectDir);
    await mkdirSecure(flowDir, { recursive: true });

    // Step 1: Extract flows from the diff
    this.logger.info("Flow-tracing: extracting user flows from changes...");
    const flows = await this.extractFlows(changedFiles, diff, config);

    if (flows.length === 0) {
      this.logger.info("Flow-tracing: no user flows identified in changes.");
      return this.buildEmptyReport();
    }

    this.logger.info(`Flow-tracing: identified ${flows.length} user flow(s) to trace.`);
    for (const flow of flows) {
      this.logger.info(`  - ${flow.id}: ${flow.name} (${flow.actors.length} actors, ${flow.entry_points.length} entry points)`);
    }

    // Step 2: Save flow specs for reference with secure permissions
    const flowSpecsPath = path.join(flowDir, `flows-cycle-${cycle}.json`);
    await writeFileSecure(flowSpecsPath, JSON.stringify(flows, null, 2) + "\n");

    // Step 3: Trace flows in parallel (bounded concurrency) with overall timeout
    this.logger.info(`Flow-tracing: spawning workers (max ${MAX_FLOW_TRACING_WORKERS} concurrent)...`);

    // C4 fix: AbortController to cancel in-flight workers on timeout.
    // Without this, traceFlowsConcurrently() keeps spawning workers after
    // the timeout fires via Promise.race, creating orphaned SDK sessions.
    const abortController = new AbortController();

    // Shared accumulator: traceFlowsConcurrently pushes findings here
    // incrementally so they survive an overall timeout (Issue #5 fix).
    const partialFindings: FlowFinding[] = [];

    // Create timeout promise to enforce 30-minute overall deadline
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), FLOW_TRACING_OVERALL_TIMEOUT_MS);
      // Unref timer so it doesn't prevent process exit
      if (timer.unref) {
        timer.unref();
      }
    });

    const tracingPromise = this.traceFlowsConcurrently(flows, changedFiles, config, abortController.signal, partialFindings);
    const raceResult = await Promise.race([
      tracingPromise.then((findings) => ({ type: "success" as const, findings })),
      timeoutPromise.then(() => ({ type: "timeout" as const })),
    ]);

    let allFindings: FlowFinding[];
    if (raceResult.type === "timeout") {
      // C4: Abort in-flight workers to prevent orphaned SDK sessions
      abortController.abort();
      this.logger.warn(
        `Flow-tracing overall timeout exceeded (${FLOW_TRACING_OVERALL_TIMEOUT_MS / 60000} minutes). Aborting in-flight workers.`,
      );
      // Wait briefly for in-flight workers to acknowledge abort
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // Preserve findings from already-completed workers instead of discarding them
      allFindings = partialFindings;
      this.logger.info(
        `Flow-tracing: preserved ${allFindings.length} finding(s) from completed workers before timeout.`,
      );
    } else {
      allFindings = raceResult.findings;
    }

    // Step 4: Deduplicate findings
    const deduplicated = this.deduplicateFindings(allFindings);
    this.logger.info(
      `Flow-tracing: ${allFindings.length} raw finding(s), ${deduplicated.length} after deduplication.`,
    );

    // Step 5: Build and save report with secure permissions
    const report = this.buildReport(deduplicated, flows.length);
    const reportPath = getFlowTracingReportPath(this.projectDir, cycle);
    await writeFileSecure(reportPath, JSON.stringify(report, null, 2) + "\n");

    // Also write a human-readable summary with secure permissions
    const summaryPath = getFlowTracingSummaryPath(this.projectDir, cycle);
    await writeFileSecure(summaryPath, this.formatReportMarkdown(report, flows));

    this.logger.info(`Flow-tracing report saved to: ${reportPath}`);
    this.logger.info(`Flow-tracing summary saved to: ${summaryPath}`);

    return report;
  }

  /**
   * Get a FlowTracingSummary suitable for embedding in a CycleRecord.
   */
  static toSummary(report: FlowTracingReport, durationMs: number): FlowTracingSummary {
    return {
      flows_traced: report.flows_traced,
      total_findings: report.summary.total,
      critical_findings: report.summary.critical,
      high_findings: report.summary.high,
      duration_ms: durationMs,
    };
  }

  // ----------------------------------------------------------------
  // Flow extraction (uses SDK to analyze the diff)
  // ----------------------------------------------------------------

  /**
   * Use Claude to analyze the diff and identify distinct user flows
   * that should be traced. Returns structured FlowSpec objects.
   */
  private async extractFlows(changedFiles: string[], diff: string, config: FlowConfig): Promise<FlowSpec[]> {
    // Truncate diff if very large to avoid context issues
    const truncatedDiff = diff.length > 50_000
      ? diff.substring(0, 50_000) + "\n\n... [diff truncated at 50k chars] ..."
      : diff;

    // H25: Sanitize config values before injecting into prompt to prevent
    // prompt injection from malicious .conductor/flow-config.json values.
    const exampleFlowLines = config.example_flows
      .map((f) => `- "${sanitizeConfigValue(f.name)}" — ${sanitizeConfigValue(f.description, 500)}`)
      .join("\n");

    const actorTypesList = config.actor_types
      .map((a) => sanitizeConfigValue(a, 100))
      .join(", ");

    // Build a JSON example from the first config example (or a generic one)
    const exampleJson = config.example_flows.length > 0
      ? JSON.stringify([config.example_flows[0]], null, 2)
      : JSON.stringify([{
          id: "example-flow",
          name: "Example flow",
          description: "A user performs an action that crosses multiple layers.",
          entry_points: ["app/api/example/route.ts"],
          actors: config.actor_types.slice(0, 3),
          edge_cases: ["Edge case 1", "Edge case 2"],
        }], null, 2);

    const prompt = `You are analyzing code changes to identify distinct user flows that should be traced end-to-end for correctness.

## Changed Files

${changedFiles.join("\n")}

## Diff Summary

${truncatedDiff}

## Task

Analyze these changes and identify the distinct USER FLOWS (not code areas) that are affected. A user flow is a complete action path from user intent to database state change and back.

Examples of flows:
${exampleFlowLines}

For each flow, identify:
1. A short unique ID (kebab-case, e.g., "accept-invitation")
2. A descriptive name
3. The entry point files (frontend component, API route, or webhook handler)
4. Which actor types are relevant (${actorTypesList})
5. Flow-specific edge cases to check

Output your analysis as a JSON array:

\`\`\`json
${exampleJson}
\`\`\`

Focus on flows that:
- Cross multiple code layers (frontend → API → service → DB)
- Involve authorization/permission boundaries
- Have non-obvious actor types
- Touch security-sensitive operations

Output ONLY the JSON array, wrapped in the json code fence. Aim for 3-8 flows maximum.`;

    const resultText = await queryWithTimeout(
      prompt,
      { allowedTools: ["Read", "Glob", "Grep", "LSP"], cwd: this.projectDir, maxTurns: 15, model: this.model, extendedContext: this.extendedContext, settingSources: ["project"] },
      5 * 60 * 1000, // 5 min
      "flow-extraction",
    );

    return this.parseFlowSpecs(resultText);
  }

  // ----------------------------------------------------------------
  // Parallel flow tracing
  // ----------------------------------------------------------------

  /**
   * Trace all flows with bounded concurrency. Each flow gets its own
   * read-only SDK query worker.
   */
  private async traceFlowsConcurrently(
    flows: FlowSpec[],
    changedFiles: string[],
    config: FlowConfig,
    signal?: AbortSignal,
    partialFindings?: FlowFinding[],
  ): Promise<FlowFinding[]> {
    // Use shared accumulator if provided (for timeout resilience),
    // otherwise use a local array.
    const allFindings: FlowFinding[] = partialFindings ?? [];
    const queue = [...flows];
    const running: Promise<FlowFinding[]>[] = [];

    const processNext = async (): Promise<FlowFinding[]> => {
      // C4: Check abort signal before starting new work
      if (signal?.aborted) {
        return [];
      }

      const flow = queue.shift();
      if (!flow) return [];

      try {
        const findings = await this.traceOneFlow(flow, changedFiles, config, signal);
        this.logger.info(
          `Flow "${flow.name}": ${findings.length} finding(s)`,
        );
        return findings;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Flow "${flow.name}" worker failed: ${msg}`);
        return [];
      }
    };

    // Initial batch
    while (running.length < MAX_FLOW_TRACING_WORKERS && queue.length > 0) {
      running.push(processNext());
    }

    // Process remaining with sliding window
    while (running.length > 0) {
      const settled = await Promise.race(
        running.map((p, i) => p.then((result) => ({ index: i, result }))),
      );

      allFindings.push(...settled.result);
      running.splice(settled.index, 1);

      // C4: Don't start new flows if abort was signaled
      if (queue.length > 0 && !signal?.aborted) {
        running.push(processNext());
      }
    }

    return allFindings;
  }

  /**
   * Trace a single flow by spawning a read-only SDK query.
   */
  private async traceOneFlow(
    flow: FlowSpec,
    changedFiles: string[],
    config: FlowConfig,
    signal?: AbortSignal,
  ): Promise<FlowFinding[]> {
    // C4: Check abort signal before spawning SDK query
    if (signal?.aborted) {
      this.logger.info(`Flow "${flow.name}" skipped — abort signaled`);
      return [];
    }

    this.logger.info(`Tracing flow: ${flow.name}`);

    const prompt = getFlowWorkerPrompt(flow, changedFiles, config);

    // C4 fix: Create a per-worker AbortController that aborts when the
    // parent signal fires. This threads cancellation into the SDK query
    // so in-flight workers are actually killed on overall timeout, rather
    // than continuing to run as orphaned processes.
    const workerAbort = new AbortController();
    const onParentAbort = () => workerAbort.abort();
    signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const resultText = await queryWithTimeout(
        prompt,
        { allowedTools: FLOW_TRACING_READ_ONLY_TOOLS, cwd: this.projectDir, maxTurns: FLOW_TRACING_WORKER_MAX_TURNS, model: this.model, extendedContext: this.extendedContext, settingSources: ["project"], abortController: workerAbort },
        10 * 60 * 1000, // 10 min
        `flow-tracing-${flow.id}`,
      );

      // H26: Save raw output for debugging with secure permissions
      const flowDir = getFlowTracingDir(this.projectDir);
      const rawPath = path.join(flowDir, `raw-${flow.id}.md`);
      await writeFileSecure(rawPath, resultText);

      return this.parseFlowFindings(resultText, flow.id);
    } finally {
      // Clean up the event listener to avoid memory leaks
      signal?.removeEventListener("abort", onParentAbort);
    }
  }

  // ----------------------------------------------------------------
  // Parsing helpers
  // ----------------------------------------------------------------

  /**
   * Parse FlowSpec[] from the extraction worker's output.
   */
  private parseFlowSpecs(text: string): FlowSpec[] {
    try {
      // Try to find JSON in code fences
      const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) {
        this.logger.warn("Flow extraction did not return an array; wrapping.");
        return [parsed as FlowSpec];
      }

      // Validate each flow has required fields
      return parsed.filter((f: Record<string, unknown>) => {
        if (!f.id || !f.name || !f.entry_points || !f.actors) {
          this.logger.warn(`Skipping malformed flow spec: ${JSON.stringify(f).substring(0, 100)}`);
          return false;
        }
        return true;
      }) as FlowSpec[];
    } catch (err) {
      this.logger.error(
        `Failed to parse flow specs: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Parse FlowFinding[] from a flow worker's output.
   */
  private parseFlowFindings(text: string, flowId: string): FlowFinding[] {
    try {
      // Look for the delimited findings block
      const startMarker = "FLOW_FINDINGS_START";
      const endMarker = "FLOW_FINDINGS_END";
      const startIdx = text.indexOf(startMarker);
      const endIdx = text.indexOf(endMarker);

      let jsonStr: string;

      if (startIdx !== -1 && endIdx !== -1) {
        jsonStr = text.substring(startIdx + startMarker.length, endIdx).trim();
      } else {
        // Fallback: try to find JSON array in code fences
        const jsonMatch = text.match(/```(?:json)?\s*\n?(\[[\s\S]*?\])```/);
        if (jsonMatch) {
          jsonStr = jsonMatch[1].trim();
        } else {
          // C5 fix: Use balanced bracket matching instead of greedy regex.
          // The old regex /\[[\s\S]*\]/ was greedy and captured from the
          // first [ to the last ] in the entire text, producing invalid JSON.
          const balanced = findBalancedJsonArray(text);
          if (balanced) {
            jsonStr = balanced;
          } else {
            this.logger.warn(`No findings block found for flow ${flowId}`);
            return [];
          }
        }
      }

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        this.logger.warn(`Findings for flow ${flowId} is not an array`);
        return [];
      }

      // Validate and normalize each finding
      const validSeverities = new Set<string>(["critical", "high", "medium", "low"]);

      return parsed
        .filter((f: Record<string, unknown>) => {
          if (!f.title || !f.description || !f.file_path) {
            this.logger.warn(`Skipping malformed finding in flow ${flowId}`);
            return false;
          }
          return true;
        })
        .map((f: Record<string, unknown>) => ({
          flow_id: flowId,
          severity: (validSeverities.has(f.severity as string)
            ? f.severity
            : "medium") as FlowFindingSeverity,
          actor: (f.actor as string) || "unknown",
          title: f.title as string,
          description: f.description as string,
          file_path: f.file_path as string,
          line_number: typeof f.line_number === "number" ? f.line_number : undefined,
          cross_boundary: Boolean(f.cross_boundary),
          edge_case: (f.edge_case as string) || undefined,
        })) as FlowFinding[];
    } catch (err) {
      this.logger.error(
        `Failed to parse findings for flow ${flowId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ----------------------------------------------------------------
  // Deduplication
  // ----------------------------------------------------------------

  /**
   * Deduplicate findings that describe the same issue from different flows.
   * Uses file_path + title similarity as the dedup key.
   */
  private deduplicateFindings(findings: FlowFinding[]): FlowFinding[] {
    const seen = new Map<string, FlowFinding>();

    for (const finding of findings) {
      // Normalize key: file path + lowercase title prefix
      const titleKey = finding.title.toLowerCase().substring(0, 60);
      const key = `${finding.file_path}::${titleKey}`;

      const existing = seen.get(key);
      if (existing) {
        // Keep the higher severity finding
        const severityOrder: Record<string, number> = {
          critical: 4,
          high: 3,
          medium: 2,
          low: 1,
        };
        if ((severityOrder[finding.severity] ?? 0) > (severityOrder[existing.severity] ?? 0)) {
          seen.set(key, finding);
        }
      } else {
        seen.set(key, finding);
      }
    }

    return Array.from(seen.values());
  }

  // ----------------------------------------------------------------
  // Report building
  // ----------------------------------------------------------------

  private buildEmptyReport(): FlowTracingReport {
    return {
      generated_at: new Date().toISOString(),
      flows_traced: 0,
      findings: [],
      summary: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        total: 0,
        cross_boundary_count: 0,
      },
    };
  }

  private buildReport(
    findings: FlowFinding[],
    flowsTraced: number,
  ): FlowTracingReport {
    const summary = {
      critical: findings.filter((f) => f.severity === "critical").length,
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
      total: findings.length,
      cross_boundary_count: findings.filter((f) => f.cross_boundary).length,
    };

    return {
      generated_at: new Date().toISOString(),
      flows_traced: flowsTraced,
      findings: findings.sort((a, b) => {
        const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
      }),
      summary,
    };
  }

  /**
   * Format the report as a human-readable markdown summary.
   */
  private formatReportMarkdown(report: FlowTracingReport, flows: FlowSpec[]): string {
    const lines: string[] = [
      "# Flow-Tracing Review Report",
      "",
      `**Generated:** ${report.generated_at}`,
      `**Flows Traced:** ${report.flows_traced}`,
      `**Total Findings:** ${report.summary.total}`,
      `**Cross-Boundary Issues:** ${report.summary.cross_boundary_count}`,
      "",
      "## Summary",
      "",
      `| Severity | Count |`,
      `|----------|-------|`,
      `| Critical | ${report.summary.critical} |`,
      `| High     | ${report.summary.high} |`,
      `| Medium   | ${report.summary.medium} |`,
      `| Low      | ${report.summary.low} |`,
      "",
      "## Flows Traced",
      "",
    ];

    for (const flow of flows) {
      lines.push(`### ${flow.name}`);
      lines.push(`- **ID:** ${flow.id}`);
      lines.push(`- **Actors:** ${flow.actors.join(", ")}`);
      lines.push(`- **Entry Points:** ${flow.entry_points.join(", ")}`);
      lines.push("");
    }

    if (report.findings.length > 0) {
      lines.push("## Findings");
      lines.push("");

      for (const finding of report.findings) {
        const severityBadge =
          finding.severity === "critical"
            ? "**[CRITICAL]**"
            : finding.severity === "high"
              ? "**[HIGH]**"
              : finding.severity === "medium"
                ? "[MEDIUM]"
                : "[LOW]";

        lines.push(`### ${severityBadge} ${finding.title}`);
        lines.push("");
        lines.push(`- **Flow:** ${finding.flow_id}`);
        lines.push(`- **Actor:** ${finding.actor}`);
        // Use !== null && !== undefined to handle line_number=0 correctly (#26f)
        lines.push(`- **File:** \`${finding.file_path}${finding.line_number !== null && finding.line_number !== undefined ? `:${finding.line_number}` : ""}\``);
        if (finding.cross_boundary) {
          lines.push(`- **Cross-Boundary:** Yes`);
        }
        if (finding.edge_case) {
          lines.push(`- **Edge Case:** ${finding.edge_case}`);
        }
        lines.push("");
        lines.push(finding.description);
        lines.push("");
        lines.push("---");
        lines.push("");
      }
    } else {
      lines.push("## Findings");
      lines.push("");
      lines.push("No issues found during flow-tracing review.");
      lines.push("");
    }

    return lines.join("\n");
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * C5 fix: Find the first balanced JSON array in text using bracket depth
 * tracking. Unlike the greedy regex /\[[\s\S]*\]/ which captured from the
 * first [ to the last ] (almost always producing invalid JSON), this
 * function finds the first properly-balanced [...] substring.
 *
 * Exported for testing.
 */
export function findBalancedJsonArray(text: string): string | null {
  // Iterate through candidate [ positions. If the first balanced [...]
  // substring doesn't JSON.parse as an array (e.g. "[note]" in prose),
  // continue searching from the next [ position.
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf("[", searchFrom);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let endFound = false;

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

      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          const candidate = text.substring(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed)) {
              return candidate;
            }
          } catch {
            // Balanced brackets but not valid JSON array; try next [
          }
          endFound = true;
          searchFrom = i + 1;
          break;
        }
      }
    }

    // If no closing bracket was found for this start position, no point continuing
    if (!endFound) {
      return null;
    }
  }

  return null;
}

/**
 * H25: Sanitize a config string value before injecting into a prompt.
 * Prevents prompt injection by truncating and stripping role markers.
 *
 * Exported for testing.
 */
export function sanitizeConfigValue(value: string, maxLength: number = 200): string {
  if (!value) return "";
  let sanitized = value;
  // Strip role markers that could confuse the model
  sanitized = sanitized.replace(/Human:|Assistant:|System:/gi, "[removed]");
  // Strip markdown headers to prevent prompt structure manipulation
  sanitized = sanitized.replace(/^#{1,6}\s/gm, "");
  // Truncate
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "…";
  }
  return sanitized;
}

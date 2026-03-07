import fs from "node:fs/promises";
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
    const startTime = Date.now();

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
    await fs.writeFile(flowSpecsPath, JSON.stringify(flows, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });

    // Step 3: Trace flows in parallel (bounded concurrency) with overall timeout
    this.logger.info(`Flow-tracing: spawning workers (max ${MAX_FLOW_TRACING_WORKERS} concurrent)...`);

    // Create timeout promise to enforce 30-minute overall deadline
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), FLOW_TRACING_OVERALL_TIMEOUT_MS);
      // Unref timer so it doesn't prevent process exit
      if (timer.unref) {
        timer.unref();
      }
    });

    const tracingPromise = this.traceFlowsConcurrently(flows, changedFiles, config);
    const raceResult = await Promise.race([
      tracingPromise.then((findings) => ({ type: "success" as const, findings })),
      timeoutPromise.then(() => ({ type: "timeout" as const })),
    ]);

    let allFindings: FlowFinding[];
    if (raceResult.type === "timeout") {
      this.logger.warn(
        `Flow-tracing overall timeout exceeded (${FLOW_TRACING_OVERALL_TIMEOUT_MS / 60000} minutes). Returning partial results.`,
      );
      // Return empty array on timeout - partial results from individual flows may still be in progress
      allFindings = [];
    } else {
      allFindings = raceResult.findings;
    }

    // Step 4: Deduplicate findings
    const deduplicated = this.deduplicateFindings(allFindings);
    this.logger.info(
      `Flow-tracing: ${allFindings.length} raw finding(s), ${deduplicated.length} after deduplication.`,
    );

    // Step 5: Build and save report with secure permissions
    const report = this.buildReport(deduplicated, flows.length, startTime);
    const reportPath = getFlowTracingReportPath(this.projectDir, cycle);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });

    // Also write a human-readable summary with secure permissions
    const summaryPath = path.join(flowDir, `summary-cycle-${cycle}.md`);
    await fs.writeFile(summaryPath, this.formatReportMarkdown(report, flows), { encoding: "utf-8", mode: 0o600 });

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

    // Build example flows section from config
    const exampleFlowLines = config.example_flows
      .map((f) => `- "${f.name}" — ${f.description}`)
      .join("\n");

    const actorTypesList = config.actor_types.join(", ");

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
      { allowedTools: ["Read", "Glob", "Grep"], cwd: this.projectDir, maxTurns: 15 },
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
  ): Promise<FlowFinding[]> {
    const allFindings: FlowFinding[] = [];
    const queue = [...flows];
    const running: Promise<FlowFinding[]>[] = [];

    const processNext = async (): Promise<FlowFinding[]> => {
      const flow = queue.shift();
      if (!flow) return [];

      try {
        const findings = await this.traceOneFlow(flow, changedFiles, config);
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

      if (queue.length > 0) {
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
  ): Promise<FlowFinding[]> {
    this.logger.info(`Tracing flow: ${flow.name}`);

    const prompt = getFlowWorkerPrompt(flow, changedFiles, config);

    const resultText = await queryWithTimeout(
      prompt,
      { allowedTools: FLOW_TRACING_READ_ONLY_TOOLS, cwd: this.projectDir, maxTurns: FLOW_TRACING_WORKER_MAX_TURNS },
      10 * 60 * 1000, // 10 min
      `flow-tracing-${flow.id}`,
    );

    // Save raw output for debugging with secure permissions
    const flowDir = getFlowTracingDir(this.projectDir);
    const rawPath = path.join(flowDir, `raw-${flow.id}.md`);
    await fs.writeFile(rawPath, resultText, { encoding: "utf-8", mode: 0o600 });

    return this.parseFlowFindings(resultText, flow.id);
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
          // Last resort: try to find any JSON array
          const arrayMatch = text.match(/\[[\s\S]*\]/);
          if (arrayMatch) {
            jsonStr = arrayMatch[0];
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

  // TODO(dead-code): startTime parameter is unused. Was likely intended for timing metrics.
  // Consider adding duration_ms to FlowTracingReport or removing parameter.
  private buildReport(
    findings: FlowFinding[],
    flowsTraced: number,
    _startTime: number,
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

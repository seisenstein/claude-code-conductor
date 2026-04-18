#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  handleReadUpdates,
  handlePostUpdate,
  handleGetTasks,
  handleClaimTask,
  handleCompleteTask,
  handleGetSessionStatus,
  handleRegisterContract,
  handleGetContracts,
  handleRecordDecision,
  handleGetDecisions,
  handleRunTests,
  VALID_DECISION_CATEGORIES,
  MAX_READ_UPDATES_HARD_CAP,
} from "./tools.js";

// ============================================================
// Validate required environment variables
// ============================================================

function validateEnv(): void {
  if (!process.env.CONDUCTOR_DIR) {
    console.error(
      "Fatal: CONDUCTOR_DIR environment variable is required"
    );
    process.exit(1);
  }
  if (!process.env.SESSION_ID) {
    console.error("Fatal: SESSION_ID environment variable is required");
    process.exit(1);
  }
}

// ============================================================
// M-36: Error handler wrapper for MCP tool handlers
// ============================================================

/**
 * Wraps an async tool handler to catch unexpected errors and return a
 * structured error response instead of crashing the MCP server.
 */
function wrapToolHandler<T>(
  toolName: string,
  handler: (args: T) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
): (args: T) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown internal error";
      process.stderr.write(
        `[coordination-server] Error in tool '${toolName}': ${message}\n`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Internal error in ${toolName}: ${message}` }),
          },
        ],
        isError: true,
      };
    }
  };
}

// ============================================================
// MCP Server setup
// ============================================================

async function main(): Promise<void> {
  validateEnv();

  const server = new McpServer(
    {
      name: "coordination-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ----------------------------------------------------------
  // Tool: read_updates
  // ----------------------------------------------------------
  server.tool(
    "read_updates",
    "Read messages from the orchestrator and other sessions. Returns messages addressed to this session or broadcast messages. Optionally filter by timestamp or cap the number of returned messages.",
    {
      since: z.string().optional().describe(
        "ISO 8601 timestamp. Only return messages newer than this. If omitted, returns all messages."
      ),
      // H-19: optional cap on returned messages. Clamped at handler level.
      limit: z.number().int().positive().max(MAX_READ_UPDATES_HARD_CAP).optional().describe(
        `Maximum number of messages to return (most recent first by timestamp). Omit to get all matching messages. Max ${MAX_READ_UPDATES_HARD_CAP}.`,
      ),
    },
    wrapToolHandler("read_updates", async (args: { since?: string; limit?: number }) => {
      const messages = await handleReadUpdates({ since: args.since, limit: args.limit });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(messages, null, 2),
          },
        ],
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: post_update
  // ----------------------------------------------------------
  server.tool(
    "post_update",
    "Post a status update, question, or result to the shared message log. The 'from' field is automatically set to this session's ID.",
    {
      type: z.enum([
        "status",
        "question",
        "answer",
        "broadcast",
        "wind_down",
        "task_completed",
        "error",
        "escalation",
      ]).describe("The type of message to post"),
      content: z.string().describe("The message content"),
      to: z.string().optional().describe(
        "Target session ID. Omit for broadcast messages."
      ),
    },
    wrapToolHandler("post_update", async (args: { type: "status" | "question" | "answer" | "broadcast" | "wind_down" | "task_completed" | "error" | "escalation"; content: string; to?: string }) => {
      const result = await handlePostUpdate({
        type: args.type,
        content: args.content,
        to: args.to,
      });
      // M-38: Set isError when handler returns an error payload
      const isError = "error" in result;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError,
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: get_tasks
  // ----------------------------------------------------------
  server.tool(
    "get_tasks",
    "List all tasks with their current status. Optionally filter by status or get ranked claimable tasks.",
    {
      status_filter: z.enum(["pending", "in_progress", "completed", "failed"])
        .optional()
        .describe("Filter tasks by status. If omitted, returns all tasks."),
      ranked: z.boolean()
        .optional()
        .describe(
          "If true, returns only claimable tasks sorted by priority score " +
          "(critical path depth + risk + type). Highest priority first. " +
          "Response includes priority_score and critical_path_depth fields.",
        ),
    },
    wrapToolHandler("get_tasks", async (args: { status_filter?: "pending" | "in_progress" | "completed" | "failed"; ranked?: boolean }) => {
      const tasks = await handleGetTasks({
        status_filter: args.status_filter,
        ranked: args.ranked,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(tasks, null, 2),
          },
        ],
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: claim_task
  // ----------------------------------------------------------
  server.tool(
    "claim_task",
    "Atomically claim an unclaimed, unblocked task. The task must be 'pending' and all of its dependencies must be 'completed'. On success, the task status is set to 'in_progress' and assigned to this session.",
    {
      task_id: z.string().describe("The ID of the task to claim"),
    },
    wrapToolHandler("claim_task", async (args: { task_id: string }) => {
      const result = await handleClaimTask({ task_id: args.task_id });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: !result.success,
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: complete_task
  // ----------------------------------------------------------
  server.tool(
    "complete_task",
    "Mark a task as completed with a result summary. Only the session that owns (claimed) the task can complete it. Also posts a task_completed message to the orchestrator.",
    {
      task_id: z.string().describe("The ID of the task to complete"),
      result_summary: z.string().describe(
        "Summary of what was accomplished for this task"
      ),
      files_changed: z.array(z.string()).optional().describe(
        "List of file paths that were created or modified"
      ),
    },
    wrapToolHandler("complete_task", async (args: { task_id: string; result_summary: string; files_changed?: string[] }) => {
      const result = await handleCompleteTask({
        task_id: args.task_id,
        result_summary: args.result_summary,
        files_changed: args.files_changed,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: !result.success,
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: get_session_status
  // ----------------------------------------------------------
  server.tool(
    "get_session_status",
    "Check the current status of another worker session. Returns session state, current task, and progress information.",
    {
      session_id: z.string().describe("The session ID to look up"),
    },
    wrapToolHandler("get_session_status", async (args: { session_id: string }) => {
      const result = await handleGetSessionStatus({
        session_id: args.session_id,
      });

      if (!result.found) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "unknown", session_id: args.session_id }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.status, null, 2),
          },
        ],
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: register_contract
  // H-12: Added task_id parameter for accurate contract provenance
  // ----------------------------------------------------------
  server.tool(
    "register_contract",
    "Register a contract (API endpoint, type definition, event schema, or database schema) so other workers can discover and depend on it.",
    {
      contract_id: z.string().describe("Unique identifier for the contract (e.g. 'POST /api/users', 'UserProfile type')"),
      contract_type: z.enum(["api_endpoint", "type_definition", "event_schema", "database_schema"]).describe("The kind of contract being registered"),
      spec: z.string().describe("The contract specification (e.g. TypeScript interface, OpenAPI snippet, SQL DDL)"),
      task_id: z.string().optional().describe("The task ID that owns this contract. If omitted, defaults to the session ID."),
    },
    wrapToolHandler("register_contract", async (args: { contract_id: string; contract_type: "api_endpoint" | "type_definition" | "event_schema" | "database_schema"; spec: string; task_id?: string }) => {
      const result = await handleRegisterContract({
        contract_id: args.contract_id,
        contract_type: args.contract_type,
        spec: args.spec,
        task_id: args.task_id,
      });
      // M-38: Set isError when handler returns an error payload
      const isError = "error" in result;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError,
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: get_contracts
  // ----------------------------------------------------------
  server.tool(
    "get_contracts",
    "Retrieve registered contracts. Optionally filter by contract type or search pattern on contract_id.",
    {
      contract_type: z.string().optional().describe("Filter by contract type (api_endpoint, type_definition, event_schema, database_schema)"),
      pattern: z.string().optional().describe("Substring pattern to match against contract_id"),
    },
    wrapToolHandler("get_contracts", async (args: { contract_type?: string; pattern?: string }) => {
      const result = await handleGetContracts({
        contract_type: args.contract_type,
        pattern: args.pattern,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: record_decision
  // ----------------------------------------------------------
  server.tool(
    "record_decision",
    "Record an architectural decision so other workers can stay consistent. Decisions are append-only and shared across all sessions.",
    {
      // H-18: align MCP-layer validation with handler validation. Previously
      // z.string() accepted anything, letting invalid categories cross the
      // MCP boundary and fail with a less-informative error inside the handler.
      category: z.enum(VALID_DECISION_CATEGORIES).describe("Decision category (one of: naming, auth, data_model, error_handling, api_design, testing, performance, other)"),
      decision: z.string().describe("The decision that was made"),
      rationale: z.string().describe("Why this decision was made"),
      task_id: z.string().optional().describe("The task that prompted this decision"),
    },
    wrapToolHandler("record_decision", async (args: { category: string; decision: string; rationale: string; task_id?: string }) => {
      const result = await handleRecordDecision({
        category: args.category,
        decision: args.decision,
        rationale: args.rationale,
        task_id: args.task_id,
      });
      // M-38: Set isError when handler returns an error payload
      const isError = "error" in result;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError,
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: get_decisions
  // ----------------------------------------------------------
  server.tool(
    "get_decisions",
    "Retrieve all recorded architectural decisions. Optionally filter by category.",
    {
      category: z.string().optional().describe("Filter decisions by category"),
    },
    wrapToolHandler("get_decisions", async (args: { category?: string }) => {
      const result = await handleGetDecisions({
        category: args.category,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    })
  );

  // ----------------------------------------------------------
  // Tool: run_tests
  // ----------------------------------------------------------
  server.tool(
    "run_tests",
    "Run the project test suite (npm test) and return pass/fail with output. Useful for validating task completion.",
    {
      test_files: z.array(z.string()).optional().describe("Specific test files to run. If omitted, runs full test suite."),
      timeout_ms: z.number().optional().describe("Timeout in milliseconds (default 60000)"),
    },
    wrapToolHandler("run_tests", async (args: { test_files?: string[]; timeout_ms?: number }) => {
      const result = await handleRunTests({
        test_files: args.test_files,
        timeout_ms: args.timeout_ms,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    })
  );

  // ----------------------------------------------------------
  // Connect via stdio transport
  // ----------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run
main().catch((err) => {
  console.error("Coordination server fatal error:", err);
  process.exit(1);
});

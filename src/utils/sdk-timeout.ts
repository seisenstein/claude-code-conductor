import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, PermissionMode, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "./logger.js";
import type { EffortLevel } from "./types.js";

/**
 * Options passed to the Agent SDK `query()` call.
 */
export interface QueryOptions {
  allowedTools: string[];
  /**
   * Tools that MUST NOT be available to this worker. Unlike `allowedTools`
   * (which only auto-approves at the permission gate — a no-op under
   * `permissionMode: "bypassPermissions"`), `disallowedTools` actually
   * removes tools from the model's context. Use for read-only workers.
   * See `READ_ONLY_DISALLOWED_TOOLS` in constants.ts.
   */
  disallowedTools?: string[];
  cwd: string;
  maxTurns: number;
  mcpServers?: Record<string, McpServerConfig>;
  /** Claude model ID to use. If omitted, uses the CLI default. */
  model?: string;
  /**
   * Reasoning effort level (low/medium/high/xhigh/max). Forwarded to the
   * SDK's `effort` option, which maps to `output_config.effort` on the
   * Claude API and guides adaptive-thinking depth. xhigh requires Opus 4.7.
   */
  effort?: EffortLevel;
  /** Settings sources to load (e.g. ["project"] for .claude/settings.json). */
  settingSources?: SettingSource[];
  /**
   * AbortController for cancelling the SDK query externally.
   * When aborted, the SDK will stop processing and clean up resources.
   * Used by FlowTracer to cancel in-flight workers on overall timeout.
   */
  abortController?: AbortController;
  /**
   * Permission mode for the SDK session. Defaults to 'bypassPermissions'
   * since workers are headless sessions with explicit allowedTools lists.
   */
  permissionMode?: PermissionMode;
}

/**
 * Wraps the Agent SDK `query()` call with a wall-clock timeout.
 *
 * Uses `Promise.race()` against a `setTimeout`. On timeout, stops consuming
 * the async iterable and returns whatever partial result was captured.
 * If no partial result exists, returns an empty string (callers handle empty).
 *
 * @param prompt     The prompt to send to the SDK
 * @param options    SDK query options (allowedTools, cwd, maxTurns, mcpServers)
 * @param timeoutMs  Maximum wall-clock time in milliseconds
 * @param label      Human-readable label for logging on timeout
 * @returns          The result text from the SDK query, or partial/empty on timeout
 */
export async function queryWithTimeout(
  prompt: string,
  options: QueryOptions,
  timeoutMs: number,
  label: string,
  logger?: Logger,
): Promise<string> {
  let resultText = "";
  let timedOut = false;

  const queryPromise = (async () => {
    const permMode = options.permissionMode ?? "bypassPermissions";
    const asyncIterable = query({
      prompt,
      options: {
        allowedTools: options.allowedTools,
        ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
        cwd: options.cwd,
        maxTurns: options.maxTurns,
        permissionMode: permMode,
        ...(permMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.settingSources ? { settingSources: options.settingSources } : {}),
        ...(options.abortController ? { abortController: options.abortController } : {}),
      },
    });

    for await (const event of asyncIterable) {
      if (timedOut) break;
      if (event.type === "result") {
        if ("result" in event) {
          resultText =
            typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result);
        }
        if (
          "permission_denials" in event &&
          Array.isArray(event.permission_denials) &&
          event.permission_denials.length > 0
        ) {
          const msg = `[sdk-timeout] ${label}: ${event.permission_denials.length} permission denial(s): ${JSON.stringify(event.permission_denials)}`;
          if (logger) {
            logger.warn(msg);
          } else {
            process.stderr.write(msg + "\n");
          }
        }
        if ("errors" in event && Array.isArray(event.errors) && event.errors.length > 0) {
          const msg = `[sdk-timeout] ${label}: SDK errors: ${event.errors.join(", ")}`;
          if (logger) {
            logger.warn(msg);
          } else {
            process.stderr.write(msg + "\n");
          }
        }
      }
    }

    return resultText;
  })();

  let timerId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<string>((resolve) => {
    timerId = setTimeout(() => {
      timedOut = true;
      const msg = `[sdk-timeout] ${label} timed out after ${Math.round(timeoutMs / 1000)}s. Partial result: ${resultText.length} chars.`;
      if (logger) {
        logger.warn(msg);
      } else {
        process.stderr.write(msg + "\n");
      }
      resolve(resultText);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([queryPromise, timeoutPromise]);
    return result;
  } finally {
    // Always clear the timer, whether the race resolved or rejected.
    clearTimeout(timerId!);
    // If timeout won the race, the queryPromise may still reject later.
    // Attach a no-op catch to prevent unhandled promise rejection crash.
    queryPromise.catch(() => {});
  }
}

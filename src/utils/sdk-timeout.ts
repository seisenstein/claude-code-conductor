import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, SettingSource } from "@anthropic-ai/claude-agent-sdk";

/**
 * Options passed to the Agent SDK `query()` call.
 */
export interface QueryOptions {
  allowedTools: string[];
  cwd: string;
  maxTurns: number;
  mcpServers?: Record<string, McpServerConfig>;
  /** Claude model ID to use. If omitted, uses the CLI default. */
  model?: string;
  /** Enable extended 1M token context window. */
  extendedContext?: boolean;
  /** Settings sources to load (e.g. ["project"] for .claude/settings.json). */
  settingSources?: SettingSource[];
  /**
   * AbortController for cancelling the SDK query externally.
   * When aborted, the SDK will stop processing and clean up resources.
   * Used by FlowTracer to cancel in-flight workers on overall timeout.
   */
  abortController?: AbortController;
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
): Promise<string> {
  let resultText = "";
  let timedOut = false;

  const queryPromise = (async () => {
    const asyncIterable = query({
      prompt,
      options: {
        allowedTools: options.allowedTools,
        cwd: options.cwd,
        maxTurns: options.maxTurns,
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.extendedContext ? { betas: ["context-1m-2025-08-07" as const] } : {}),
        ...(options.settingSources ? { settingSources: options.settingSources } : {}),
        ...(options.abortController ? { abortController: options.abortController } : {}),
      },
    });

    for await (const event of asyncIterable) {
      if (timedOut) break;
      if (event.type === "result" && "result" in event) {
        resultText =
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result);
      }
    }

    return resultText;
  })();

  let timerId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<string>((resolve) => {
    timerId = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[sdk-timeout] ${label} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        `Partial result: ${resultText.length} chars.`,
      );
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

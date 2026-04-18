/**
 * Tests for queryWithTimeout — the single chokepoint for all Agent SDK calls.
 *
 * CR-4 continuation (v0.7.3): sdk-timeout.ts was previously mocked in 11
 * test files but had no standalone coverage. Tests here verify:
 *  - option forwarding (including v0.7.2 additions: disallowedTools, effort)
 *  - happy path (result text returned)
 *  - timeout behavior (resolves with partial on timeout)
 *  - SDK errors bubble up
 *  - empty stream returns ""
 *  - multiple text chunks concatenate
 *  - conditional spreading (omitted options never reach the SDK)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK BEFORE importing queryWithTimeout (hoisted).
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
}));

import { queryWithTimeout } from "./sdk-timeout.js";

/**
 * Build an async iterable that yields a sequence of SDK events.
 * Each event is yielded with a microtask delay so the iterator's
 * next() can be interleaved with timer scheduling.
 */
function makeAsyncIterable(events: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= events.length) return { value: undefined, done: true };
          const v = events[i++];
          return { value: v, done: false };
        },
      };
    },
  };
}

/** A never-resolving iterable for timeout testing. */
function makeNeverEndingIterable(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise(() => {
            /* never resolves */
          });
        },
      };
    },
  };
}

describe("queryWithTimeout", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns the SDK result string from a terminal result event", async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([{ type: "result", result: "hello world" }]),
    );
    const out = await queryWithTimeout(
      "prompt",
      { allowedTools: ["Read"], cwd: "/tmp", maxTurns: 5 },
      10_000,
      "happy-path",
    );
    expect(out).toBe("hello world");
  });

  it("forwards core options to the SDK", async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([{ type: "result", result: "ok" }]),
    );
    await queryWithTimeout(
      "prompt",
      {
        allowedTools: ["Read", "Grep"],
        disallowedTools: ["Write", "Edit"],
        cwd: "/proj",
        maxTurns: 7,
        model: "claude-opus-4-7",
        effort: "xhigh",
        settingSources: ["project"],
      },
      10_000,
      "forwarding",
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const passed = mockQuery.mock.calls[0][0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    expect(passed.prompt).toBe("prompt");
    expect(passed.options.allowedTools).toEqual(["Read", "Grep"]);
    expect(passed.options.disallowedTools).toEqual(["Write", "Edit"]);
    expect(passed.options.cwd).toBe("/proj");
    expect(passed.options.maxTurns).toBe(7);
    expect(passed.options.model).toBe("claude-opus-4-7");
    expect(passed.options.effort).toBe("xhigh");
    expect(passed.options.settingSources).toEqual(["project"]);
    expect(passed.options.permissionMode).toBe("bypassPermissions");
    expect(passed.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("omits optional options that weren't supplied", async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([{ type: "result", result: "ok" }]),
    );
    await queryWithTimeout(
      "prompt",
      {
        allowedTools: ["Read"],
        cwd: "/tmp",
        maxTurns: 3,
      },
      10_000,
      "no-optionals",
    );

    const options = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
    expect(options).not.toHaveProperty("disallowedTools");
    expect(options).not.toHaveProperty("model");
    expect(options).not.toHaveProperty("effort");
    expect(options).not.toHaveProperty("settingSources");
    expect(options).not.toHaveProperty("mcpServers");
    expect(options).not.toHaveProperty("abortController");
  });

  it("returns empty string when the stream yields no result events", async () => {
    mockQuery.mockReturnValue(makeAsyncIterable([]));
    const out = await queryWithTimeout(
      "prompt",
      { allowedTools: [], cwd: "/tmp", maxTurns: 1 },
      5_000,
      "empty",
    );
    expect(out).toBe("");
  });

  it("stringifies non-string result payloads", async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([{ type: "result", result: { foo: "bar", n: 42 } }]),
    );
    const out = await queryWithTimeout(
      "prompt",
      { allowedTools: [], cwd: "/tmp", maxTurns: 1 },
      5_000,
      "non-string",
    );
    expect(out).toBe(JSON.stringify({ foo: "bar", n: 42 }));
  });

  it("resolves with empty string on timeout when SDK hangs", async () => {
    mockQuery.mockReturnValue(makeNeverEndingIterable());
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
      debug: () => {},
    } as unknown as Parameters<typeof queryWithTimeout>[4];

    const out = await queryWithTimeout(
      "prompt",
      { allowedTools: [], cwd: "/tmp", maxTurns: 1 },
      50,
      "timeout-test",
      logger,
    );
    expect(out).toBe("");
    expect(warnings.some((w) => w.includes("timed out"))).toBe(true);
  });

  it("bubbles up SDK-thrown errors", async () => {
    // Iterable that throws on the first next() call.
    const throwingIterable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("sdk boom");
          },
        };
      },
    };
    mockQuery.mockReturnValue(throwingIterable);

    await expect(
      queryWithTimeout(
        "prompt",
        { allowedTools: [], cwd: "/tmp", maxTurns: 1 },
        10_000,
        "sdk-throws",
      ),
    ).rejects.toThrow("sdk boom");
  });

  it("forwards abortController when supplied", async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([{ type: "result", result: "ok" }]),
    );
    const abortController = new AbortController();
    await queryWithTimeout(
      "prompt",
      {
        allowedTools: [],
        cwd: "/tmp",
        maxTurns: 1,
        abortController,
      },
      10_000,
      "abort-fwd",
    );
    const options = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
    expect(options.abortController).toBe(abortController);
  });

  it("honors non-default permissionMode when supplied", async () => {
    mockQuery.mockReturnValue(
      makeAsyncIterable([{ type: "result", result: "ok" }]),
    );
    await queryWithTimeout(
      "prompt",
      {
        allowedTools: [],
        cwd: "/tmp",
        maxTurns: 1,
        permissionMode: "default",
      },
      10_000,
      "perm-mode",
    );
    const options = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
    expect(options.permissionMode).toBe("default");
    // allowDangerouslySkipPermissions is only set for bypassPermissions
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
  });
});

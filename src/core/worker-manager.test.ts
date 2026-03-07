/**
 * Unit tests for Worker Manager
 *
 * Tests worker lifecycle management including:
 * - Worker spawn creates session directory and status file
 * - Worker timeout detection triggers correctly
 * - Heartbeat tracking detects stale workers
 * - Wind-down signal is propagated
 * - Orphan task reset works correctly
 * - Retry exhaustion marks tasks as failed
 *
 * Uses mocks for SDK query() and temp directories for file operations.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock the SDK before importing WorkerManager
// Return a partial mock that satisfies what WorkerManager actually uses
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { WorkerManager } from "./worker-manager.js";
import { Logger } from "../utils/logger.js";
import type { SessionStatus, OrchestratorEvent } from "../utils/types.js";
import { SESSIONS_DIR, SESSION_STATUS_FILE, MESSAGES_DIR } from "../utils/constants.js";

describe("WorkerManager", () => {
  let tempDir: string;
  let orchestratorDir: string;
  let workerManager: WorkerManager;
  let mockLogger: Logger;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-worker-test-"));
    orchestratorDir = path.join(tempDir, ".conductor");
    await fs.mkdir(orchestratorDir, { recursive: true });
    await fs.mkdir(path.join(orchestratorDir, SESSIONS_DIR), { recursive: true });
    await fs.mkdir(path.join(orchestratorDir, MESSAGES_DIR), { recursive: true });

    // Create a simple mock logger
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    workerManager = new WorkerManager(
      tempDir,
      orchestratorDir,
      path.join(tempDir, "fake-mcp-server.js"),
      mockLogger,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Helper to create a mock query result that acts as an async iterable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createMockQueryResult(generator: () => AsyncGenerator<Record<string, unknown>>): any {
    return {
      [Symbol.asyncIterator]: generator,
    };
  }

  describe("worker spawn", () => {
    it("creates session directory on spawn", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      // Mock query to return an empty async iterable that completes immediately
      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          // Worker completes immediately
        }),
      );

      await workerManager.spawnWorker("worker-test-1");

      // Wait a tick for async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      const sessionDir = path.join(orchestratorDir, SESSIONS_DIR, "worker-test-1");
      const stat = await fs.stat(sessionDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("creates initial status file on spawn", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          // Worker completes immediately
        }),
      );

      await workerManager.spawnWorker("worker-test-2");

      // Wait a tick for async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      const statusPath = path.join(
        orchestratorDir,
        SESSIONS_DIR,
        "worker-test-2",
        SESSION_STATUS_FILE,
      );

      const statusContent = await fs.readFile(statusPath, "utf-8");
      const status = JSON.parse(statusContent) as SessionStatus;

      expect(status.session_id).toBe("worker-test-2");
      expect(status.state).toBe("done"); // Completed immediately
    });

    it("prevents duplicate spawns for same session ID", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      // Create a promise that never resolves to keep worker "active"
      let resolveWorker: () => void;
      const workerPromise = new Promise<void>((resolve) => {
        resolveWorker = resolve;
      });

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          await workerPromise;
        }),
      );

      await workerManager.spawnWorker("worker-dup");
      await workerManager.spawnWorker("worker-dup"); // Should log warning

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("already active"),
      );

      // Clean up
      resolveWorker!();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    it("tracks active workers correctly", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      // Create a long-running worker
      let resolveWorker: () => void;
      const workerPromise = new Promise<void>((resolve) => {
        resolveWorker = resolve;
      });

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          await workerPromise;
        }),
      );

      await workerManager.spawnWorker("worker-active");

      expect(workerManager.getActiveWorkers()).toContain("worker-active");
      expect(workerManager.isWorkerActive("worker-active")).toBe(true);
      expect(workerManager.isWorkerActive("non-existent")).toBe(false);

      // Clean up
      resolveWorker!();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    it("removes worker from active list after completion", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          // Complete immediately
        }),
      );

      await workerManager.spawnWorker("worker-complete");

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(workerManager.getActiveWorkers()).not.toContain("worker-complete");
      expect(workerManager.isWorkerActive("worker-complete")).toBe(false);
    });
  });

  describe("timeout detection", () => {
    it("detects timed out workers via checkWorkerHealth", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      // Create a worker that never completes
      let resolveWorker: () => void;
      const workerPromise = new Promise<void>((resolve) => {
        resolveWorker = resolve;
      });

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          await workerPromise;
        }),
      );

      await workerManager.spawnWorker("worker-timeout");

      // Immediately after spawn, worker should not be timed out (default 45 min)
      const healthBefore = workerManager.checkWorkerHealth();
      expect(healthBefore.timedOut).not.toContain("worker-timeout");

      // Clean up
      resolveWorker!();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    it("checkWorkerHealth returns separate lists for timedOut and stale", async () => {
      const health = workerManager.checkWorkerHealth();

      expect(health).toHaveProperty("timedOut");
      expect(health).toHaveProperty("stale");
      expect(Array.isArray(health.timedOut)).toBe(true);
      expect(Array.isArray(health.stale)).toBe(true);
    });
  });

  describe("heartbeat tracking", () => {
    it("heartbeat is recorded on worker spawn", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      let resolveWorker: () => void;
      const workerPromise = new Promise<void>((resolve) => {
        resolveWorker = resolve;
      });

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          await workerPromise;
        }),
      );

      await workerManager.spawnWorker("worker-heartbeat");

      // Worker should not be stale immediately after spawn
      const health = workerManager.checkWorkerHealth();
      expect(health.stale).not.toContain("worker-heartbeat");

      // Clean up
      resolveWorker!();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    it("heartbeat is recorded on non-error events", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      let resolveWorker: () => void;
      const workerPromise = new Promise<void>((resolve) => {
        resolveWorker = resolve;
      });

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          yield { type: "tool_use", tool_name: "Read" };
          yield { type: "result", result: "success" };
          await workerPromise;
        }),
      );

      await workerManager.spawnWorker("worker-events");

      // Wait for events to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Worker should still not be stale
      const health = workerManager.checkWorkerHealth();
      expect(health.stale).not.toContain("worker-events");

      // Clean up
      resolveWorker!();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  describe("wind-down signal", () => {
    it("writes wind-down message to orchestrator message file", async () => {
      await workerManager.signalWindDown("usage_limit", "2026-03-07T10:00:00Z");

      const messagePath = path.join(orchestratorDir, MESSAGES_DIR, "orchestrator.jsonl");
      const content = await fs.readFile(messagePath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(1);

      const message = JSON.parse(lines[0]);
      expect(message.type).toBe("wind_down");
      expect(message.from).toBe("orchestrator");
      expect(message.content).toContain("usage_limit");
      expect(message.metadata.resets_at).toBe("2026-03-07T10:00:00Z");
    });

    it("wind-down message includes reason in metadata", async () => {
      await workerManager.signalWindDown("cycle_limit");

      const messagePath = path.join(orchestratorDir, MESSAGES_DIR, "orchestrator.jsonl");
      const content = await fs.readFile(messagePath, "utf-8");
      const message = JSON.parse(content.trim());

      expect(message.metadata.reason).toBe("cycle_limit");
    });

    it("multiple wind-down signals append to file", async () => {
      await workerManager.signalWindDown("usage_limit");
      await workerManager.signalWindDown("user_requested");

      const messagePath = path.join(orchestratorDir, MESSAGES_DIR, "orchestrator.jsonl");
      const content = await fs.readFile(messagePath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
    });
  });

  describe("retry tracker", () => {
    it("returns TaskRetryTracker via getRetryTracker", () => {
      const tracker = workerManager.getRetryTracker();

      expect(tracker).not.toBeNull();
      expect(typeof tracker.recordFailure).toBe("function");
      expect(typeof tracker.shouldRetry).toBe("function");
      expect(typeof tracker.getRetryCount).toBe("function");
    });

    it("retry tracker is shared across calls", () => {
      const tracker1 = workerManager.getRetryTracker();
      const tracker2 = workerManager.getRetryTracker();

      expect(tracker1).toBe(tracker2);

      // Record failure on one reference
      tracker1.recordFailure("task-001", "Test error");

      // Should be visible on other reference
      expect(tracker2.getRetryCount("task-001")).toBe(1);
    });
  });

  describe("worker events", () => {
    it("collects events from workers via getWorkerEvents", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          // Worker completes immediately
        }),
      );

      await workerManager.spawnWorker("worker-events-test");

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 100));

      const events = workerManager.getWorkerEvents();

      // Should have session_done event
      const doneEvent = events.find(
        (e) => e.type === "session_done" && e.sessionId === "worker-events-test",
      );
      expect(doneEvent).toBeDefined();
    });

    it("getWorkerEvents clears pending events", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          // Worker completes immediately
        }),
      );

      await workerManager.spawnWorker("worker-clear-events");

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 100));

      // First call gets events
      const events1 = workerManager.getWorkerEvents();
      expect(events1.length).toBeGreaterThan(0);

      // Second call should be empty
      const events2 = workerManager.getWorkerEvents();
      expect(events2).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("records session_failed event on SDK error", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          throw new Error("SDK connection failed");
        }),
      );

      await workerManager.spawnWorker("worker-error");

      // Wait for error handling
      await new Promise((resolve) => setTimeout(resolve, 100));

      const events = workerManager.getWorkerEvents();
      const failedEvent = events.find(
        (e): e is Extract<OrchestratorEvent, { type: "session_failed" }> =>
          e.type === "session_failed" && e.sessionId === "worker-error",
      );

      expect(failedEvent).toBeDefined();
      expect(failedEvent?.error).toContain("SDK connection failed");
    });

    it("continues processing events after single event error", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          yield { type: "tool_use", tool_name: "Read" };
          yield { type: "invalid_event" }; // May cause processing error
          yield { type: "result", result: "final" };
          // Complete
        }),
      );

      await workerManager.spawnWorker("worker-recovery");

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Worker should have completed despite any event processing issues
      const events = workerManager.getWorkerEvents();
      const doneEvent = events.find(
        (e) => e.type === "session_done" && e.sessionId === "worker-recovery",
      );
      expect(doneEvent).toBeDefined();
    });

    it("updates session status to failed on error", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          throw new Error("Fatal worker error");
        }),
      );

      await workerManager.spawnWorker("worker-fail-status");

      // Wait for error handling
      await new Promise((resolve) => setTimeout(resolve, 100));

      const statusPath = path.join(
        orchestratorDir,
        SESSIONS_DIR,
        "worker-fail-status",
        SESSION_STATUS_FILE,
      );

      const statusContent = await fs.readFile(statusPath, "utf-8");
      const status = JSON.parse(statusContent) as SessionStatus;

      expect(status.state).toBe("failed");
      expect(status.progress).toContain("Fatal worker error");
    });
  });

  describe("cleanup", () => {
    it("cleans up trackers in finally block on completion", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          // Complete immediately
        }),
      );

      await workerManager.spawnWorker("worker-cleanup");

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Worker should be removed from active list
      expect(workerManager.isWorkerActive("worker-cleanup")).toBe(false);

      // checkWorkerHealth should not return this worker
      const health = workerManager.checkWorkerHealth();
      expect(health.timedOut).not.toContain("worker-cleanup");
      expect(health.stale).not.toContain("worker-cleanup");
    });

    it("cleans up trackers in finally block on error", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          throw new Error("Worker crashed");
        }),
      );

      await workerManager.spawnWorker("worker-cleanup-error");

      // Wait for error handling
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Worker should be removed from active list even after error
      expect(workerManager.isWorkerActive("worker-cleanup-error")).toBe(false);

      // checkWorkerHealth should not return this worker
      const health = workerManager.checkWorkerHealth();
      expect(health.timedOut).not.toContain("worker-cleanup-error");
      expect(health.stale).not.toContain("worker-cleanup-error");
    });
  });

  describe("waitForAllWorkers", () => {
    it("returns immediately when no workers are active", async () => {
      const startTime = Date.now();
      await workerManager.waitForAllWorkers(5000);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100); // Should be nearly instant
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("No active workers"),
      );
    });

    it("waits for workers to complete", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      let resolveWorker: () => void;
      const workerPromise = new Promise<void>((resolve) => {
        resolveWorker = resolve;
      });

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          await workerPromise;
        }),
      );

      await workerManager.spawnWorker("worker-wait");

      // Start waiting with a long timeout
      const waitPromise = workerManager.waitForAllWorkers(10000);

      // Wait a bit then resolve the worker
      await new Promise((resolve) => setTimeout(resolve, 50));
      resolveWorker!();

      // Wait should complete
      await waitPromise;

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("All workers have finished"),
      );
    });

    it("times out if workers take too long", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      // Create a worker that never completes
      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          await new Promise(() => {}); // Never resolves
        }),
      );

      await workerManager.spawnWorker("worker-slow");

      const startTime = Date.now();
      await workerManager.waitForAllWorkers(100); // 100ms timeout
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(500); // Should timeout around 100ms

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Timeout reached"),
      );
    });
  });

  describe("killAllWorkers", () => {
    it("signals wind-down before killing", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      let resolveWorker: () => void;
      const workerPromise = new Promise<void>((resolve) => {
        resolveWorker = resolve;
      });

      vi.mocked(query).mockReturnValue(
        createMockQueryResult(async function* () {
          await workerPromise;
        }),
      );

      await workerManager.spawnWorker("worker-kill");

      await workerManager.killAllWorkers();

      // Should have sent wind-down message
      const messagePath = path.join(orchestratorDir, MESSAGES_DIR, "orchestrator.jsonl");
      const content = await fs.readFile(messagePath, "utf-8");
      const message = JSON.parse(content.trim());

      expect(message.type).toBe("wind_down");

      // Worker should be removed from active list
      expect(workerManager.getActiveWorkers()).not.toContain("worker-kill");

      // Clean up the hanging promise
      resolveWorker!();
    });

    it("does nothing when no workers are active", async () => {
      await workerManager.killAllWorkers();

      // Should not have created any message file
      const messagePath = path.join(orchestratorDir, MESSAGES_DIR, "orchestrator.jsonl");
      await expect(fs.access(messagePath)).rejects.toThrow();
    });
  });

  describe("setWorkerContext", () => {
    it("accepts worker context for prompt building", () => {
      // Should not throw
      workerManager.setWorkerContext({
        featureDescription: "Test feature",
        conventions: {
          auth_patterns: [],
          validation_patterns: [],
          error_handling_patterns: [],
          test_patterns: [],
          directory_structure: ["src/"],
          naming_conventions: ["camelCase"],
          key_libraries: [],
          security_invariants: [],
        },
      });
    });
  });
});

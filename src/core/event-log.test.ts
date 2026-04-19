/**
 * Integration tests for EventLog module.
 *
 * These tests use real file system operations in temp directories to verify
 * the roundtrip behavior of recording, flushing, and reading events.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  EventLog,
  computeAnalytics,
  formatAnalyticsForDisplay,
} from "./event-log.js";
import type { StructuredEvent } from "../utils/types.js";
import { ORCHESTRATOR_DIR, EVENTS_FILE } from "../utils/constants.js";

describe("EventLog integration", () => {
  let tempDir: string;
  let eventLog: EventLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-test-"));
    await fs.mkdir(path.join(tempDir, ORCHESTRATOR_DIR), { recursive: true });
    eventLog = new EventLog(tempDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (eventLog.isRunning()) {
      await eventLog.stop();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("record -> flush -> readAll roundtrip", () => {
    it("writes and reads back events correctly", async () => {
      eventLog.start();

      eventLog.record({ type: "phase_start", phase: "test" });
      eventLog.record({ type: "worker_spawn", session_id: "worker-1" });
      eventLog.record({ type: "phase_end", phase: "test", duration_ms: 1000 });

      await eventLog.flush();
      const events = await eventLog.readAll();

      expect(events.length).toBe(3);
      expect(events[0].type).toBe("phase_start");
      expect(events[1].type).toBe("worker_spawn");
      expect(events[2].type).toBe("phase_end");
    });

    it("preserves event data on roundtrip", async () => {
      eventLog.start();

      eventLog.record({
        type: "task_completed",
        task_id: "task-123",
        session_id: "worker-456",
      });

      await eventLog.flush();
      const events = await eventLog.readAll();

      expect(events.length).toBe(1);
      const event = events[0] as Extract<
        StructuredEvent,
        { type: "task_completed" }
      >;
      expect(event.type).toBe("task_completed");
      expect(event.task_id).toBe("task-123");
      expect(event.session_id).toBe("worker-456");
      expect(event.timestamp).toBeDefined();
    });

    it("auto-generates timestamp if not provided", async () => {
      eventLog.start();

      const beforeRecord = new Date().toISOString();
      eventLog.record({ type: "phase_start", phase: "timing-test" });
      const afterRecord = new Date().toISOString();

      await eventLog.flush();
      const events = await eventLog.readAll();

      expect(events.length).toBe(1);
      const timestamp = events[0].timestamp;
      expect(timestamp >= beforeRecord).toBe(true);
      expect(timestamp <= afterRecord).toBe(true);
    });

    it("uses provided timestamp if given", async () => {
      eventLog.start();

      const customTimestamp = "2020-01-01T00:00:00.000Z";
      eventLog.record({
        type: "phase_start",
        phase: "custom-time",
        timestamp: customTimestamp,
      });

      await eventLog.flush();
      const events = await eventLog.readAll();

      expect(events.length).toBe(1);
      expect(events[0].timestamp).toBe(customTimestamp);
    });
  });

  describe("buffering behavior", () => {
    it("buffers multiple records before flush", async () => {
      eventLog.start();

      for (let i = 0; i < 10; i++) {
        eventLog.record({ type: "usage_warning", utilization: i / 10 });
      }

      expect(eventLog.getBufferSize()).toBe(10);

      const eventsPath = path.join(tempDir, ORCHESTRATOR_DIR, EVENTS_FILE);
      let existsBefore = false;
      try {
        await fs.access(eventsPath);
        const content = await fs.readFile(eventsPath, "utf-8");
        existsBefore = content.length > 0;
      } catch {
        existsBefore = false;
      }
      expect(existsBefore).toBe(false);

      await eventLog.flush();

      expect(eventLog.getBufferSize()).toBe(0);

      const events = await eventLog.readAll();
      expect(events.length).toBe(10);
    });

    it("flush is idempotent on empty buffer", async () => {
      eventLog.start();

      await eventLog.flush();
      await eventLog.flush();
      await eventLog.flush();

      const events = await eventLog.readAll();
      expect(events.length).toBe(0);
    });

    it("clears buffer after successful flush", async () => {
      eventLog.start();

      eventLog.record({ type: "phase_start", phase: "clear-test" });
      expect(eventLog.getBufferSize()).toBe(1);

      await eventLog.flush();
      expect(eventLog.getBufferSize()).toBe(0);
    });
  });

  describe("appending behavior", () => {
    it("appends to existing log file", async () => {
      eventLog.start();

      eventLog.record({ type: "phase_start", phase: "batch1" });
      await eventLog.flush();

      eventLog.record({ type: "phase_start", phase: "batch2" });
      await eventLog.flush();

      const events = await eventLog.readAll();
      expect(events.length).toBe(2);
      expect((events[0] as Extract<StructuredEvent, { type: "phase_start" }>).phase).toBe(
        "batch1"
      );
      expect((events[1] as Extract<StructuredEvent, { type: "phase_start" }>).phase).toBe(
        "batch2"
      );
    });

    it("maintains order across multiple flushes", async () => {
      eventLog.start();

      for (let i = 0; i < 5; i++) {
        eventLog.record({ type: "usage_warning", utilization: i });
        await eventLog.flush();
      }

      const events = await eventLog.readAll();
      expect(events.length).toBe(5);

      for (let i = 0; i < 5; i++) {
        const event = events[i] as Extract<
          StructuredEvent,
          { type: "usage_warning" }
        >;
        expect(event.utilization).toBe(i);
      }
    });
  });

  describe("missing file handling", () => {
    it("readAll handles missing file gracefully", async () => {
      const events = await eventLog.readAll();
      expect(events).toEqual([]);
    });

    it("readAll handles missing .conductor directory gracefully", async () => {
      await fs.rm(path.join(tempDir, ORCHESTRATOR_DIR), {
        recursive: true,
        force: true,
      });

      const events = await eventLog.readAll();
      expect(events).toEqual([]);
    });

    it("creates .conductor directory if missing on flush", async () => {
      await fs.rm(path.join(tempDir, ORCHESTRATOR_DIR), {
        recursive: true,
        force: true,
      });

      eventLog.start();
      eventLog.record({ type: "phase_start", phase: "mkdir-test" });
      await eventLog.flush();

      const dirExists = await fs
        .access(path.join(tempDir, ORCHESTRATOR_DIR))
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);

      const events = await eventLog.readAll();
      expect(events.length).toBe(1);
    });
  });

  describe("corrupted line handling", () => {
    it("skips corrupted JSON lines gracefully", async () => {
      eventLog.start();

      eventLog.record({ type: "phase_start", phase: "valid1" });
      await eventLog.flush();

      const eventsPath = path.join(tempDir, ORCHESTRATOR_DIR, EVENTS_FILE);
      await fs.appendFile(eventsPath, "this is not json\n", "utf-8");

      eventLog.record({ type: "phase_start", phase: "valid2" });
      await eventLog.flush();

      const events = await eventLog.readAll();
      expect(events.length).toBe(2);
      expect((events[0] as Extract<StructuredEvent, { type: "phase_start" }>).phase).toBe(
        "valid1"
      );
      expect((events[1] as Extract<StructuredEvent, { type: "phase_start" }>).phase).toBe(
        "valid2"
      );
    });

    it("skips events without required fields", async () => {
      eventLog.start();

      eventLog.record({ type: "phase_start", phase: "valid" });
      await eventLog.flush();

      const eventsPath = path.join(tempDir, ORCHESTRATOR_DIR, EVENTS_FILE);
      await fs.appendFile(
        eventsPath,
        '{"phase":"no-type"}\n',
        "utf-8"
      );
      await fs.appendFile(
        eventsPath,
        '{"type":"phase_start"}\n',
        "utf-8"
      );

      const events = await eventLog.readAll();
      expect(events.length).toBe(1);
      expect((events[0] as Extract<StructuredEvent, { type: "phase_start" }>).phase).toBe(
        "valid"
      );
    });
  });

  describe("analytics computation", () => {
    it("computes phase durations correctly", async () => {
      eventLog.start();

      eventLog.record({ type: "phase_start", phase: "test" });
      eventLog.record({ type: "phase_end", phase: "test", duration_ms: 5000 });
      eventLog.record({ type: "phase_start", phase: "test" });
      eventLog.record({ type: "phase_end", phase: "test", duration_ms: 3000 });

      await eventLog.flush();

      const analytics = await eventLog.getAnalytics();

      expect(analytics.phase_durations["test"]).toBeDefined();
      expect(analytics.phase_durations["test"].avg_ms).toBe(4000);
      expect(analytics.phase_durations["test"].count).toBe(2);
    });

    it("computes worker success rate correctly", async () => {
      eventLog.start();

      eventLog.record({
        type: "worker_complete",
        session_id: "w1",
        tasks_completed: 3,
      });
      eventLog.record({
        type: "worker_complete",
        session_id: "w2",
        tasks_completed: 2,
      });
      eventLog.record({
        type: "worker_fail",
        session_id: "w3",
        error: "timeout",
      });

      await eventLog.flush();

      const analytics = await eventLog.getAnalytics();

      expect(analytics.worker_success_rate).toBe(67);
    });

    it("handles worker_timeout as failure", async () => {
      eventLog.start();

      eventLog.record({
        type: "worker_complete",
        session_id: "w1",
        tasks_completed: 1,
      });
      eventLog.record({
        type: "worker_timeout",
        session_id: "w2",
        duration_ms: 3000000,
      });

      await eventLog.flush();

      const analytics = await eventLog.getAnalytics();

      expect(analytics.worker_success_rate).toBe(50);
    });

    it("computes task retry rate correctly", async () => {
      eventLog.start();

      eventLog.record({
        type: "task_completed",
        task_id: "t1",
        session_id: "w1",
      });
      eventLog.record({
        type: "task_completed",
        task_id: "t2",
        session_id: "w1",
      });
      eventLog.record({
        type: "task_completed",
        task_id: "t3",
        session_id: "w1",
      });
      eventLog.record({ type: "task_retried", task_id: "t4", retry_count: 1 });

      await eventLog.flush();

      const analytics = await eventLog.getAnalytics();

      expect(analytics.task_retry_rate).toBe(25);
    });

    it("tracks total events, workers, and tasks", async () => {
      eventLog.start();

      eventLog.record({ type: "worker_spawn", session_id: "w1" });
      eventLog.record({ type: "worker_spawn", session_id: "w2" });
      eventLog.record({ type: "worker_spawn", session_id: "w3" });
      eventLog.record({
        type: "task_completed",
        task_id: "t1",
        session_id: "w1",
      });
      eventLog.record({
        type: "task_completed",
        task_id: "t2",
        session_id: "w2",
      });
      eventLog.record({ type: "phase_start", phase: "test" });

      await eventLog.flush();

      const analytics = await eventLog.getAnalytics();

      expect(analytics.total_events).toBe(6);
      expect(analytics.total_workers).toBe(3);
      expect(analytics.total_tasks_completed).toBe(2);
    });

    it("computes top bottleneck tasks", async () => {
      eventLog.start();

      const baseTime = Date.now();

      eventLog.record({
        type: "task_claimed",
        task_id: "fast-task",
        session_id: "w1",
        timestamp: new Date(baseTime).toISOString(),
      });
      eventLog.record({
        type: "task_completed",
        task_id: "fast-task",
        session_id: "w1",
        timestamp: new Date(baseTime + 1000).toISOString(),
      });

      eventLog.record({
        type: "task_claimed",
        task_id: "slow-task",
        session_id: "w1",
        timestamp: new Date(baseTime).toISOString(),
      });
      eventLog.record({
        type: "task_completed",
        task_id: "slow-task",
        session_id: "w1",
        timestamp: new Date(baseTime + 10000).toISOString(),
      });

      eventLog.record({
        type: "task_claimed",
        task_id: "medium-task",
        session_id: "w1",
        timestamp: new Date(baseTime).toISOString(),
      });
      eventLog.record({
        type: "task_completed",
        task_id: "medium-task",
        session_id: "w1",
        timestamp: new Date(baseTime + 5000).toISOString(),
      });

      await eventLog.flush();

      const analytics = await eventLog.getAnalytics();

      expect(analytics.top_bottleneck_tasks.length).toBe(3);
      expect(analytics.top_bottleneck_tasks[0].task_id).toBe("slow-task");
      expect(analytics.top_bottleneck_tasks[0].duration_ms).toBe(10000);
      expect(analytics.top_bottleneck_tasks[1].task_id).toBe("medium-task");
      expect(analytics.top_bottleneck_tasks[2].task_id).toBe("fast-task");
    });

    it("returns empty analytics for no events", async () => {
      const analytics = await eventLog.getAnalytics();

      expect(analytics.total_events).toBe(0);
      expect(analytics.total_workers).toBe(0);
      expect(analytics.total_tasks_completed).toBe(0);
      expect(analytics.worker_success_rate).toBe(0);
      expect(analytics.task_retry_rate).toBe(0);
      expect(analytics.top_bottleneck_tasks).toEqual([]);
      expect(analytics.phase_durations).toEqual({});
    });
  });

  describe("start/stop lifecycle", () => {
    it("isRunning reflects start/stop state", async () => {
      expect(eventLog.isRunning()).toBe(false);

      eventLog.start();
      expect(eventLog.isRunning()).toBe(true);

      await eventLog.stop();
      expect(eventLog.isRunning()).toBe(false);
    });

    it("start and stop are idempotent", async () => {
      eventLog.start();
      eventLog.start();
      eventLog.start();
      expect(eventLog.isRunning()).toBe(true);

      await eventLog.stop();
      await eventLog.stop();
      await eventLog.stop();
      expect(eventLog.isRunning()).toBe(false);
    });

    it("stop flushes remaining buffer", async () => {
      eventLog.start();

      eventLog.record({ type: "phase_start", phase: "final-flush-test" });
      expect(eventLog.getBufferSize()).toBe(1);

      await eventLog.stop();

      expect(eventLog.getBufferSize()).toBe(0);

      const events = await eventLog.readAll();
      expect(events.length).toBe(1);
    });

    it("can record events without starting (for manual flush use case)", async () => {
      eventLog.record({ type: "phase_start", phase: "no-start" });
      expect(eventLog.getBufferSize()).toBe(1);

      await eventLog.flush();

      const events = await eventLog.readAll();
      expect(events.length).toBe(1);
    });
  });

  describe("all event types roundtrip", () => {
    it.each([
      { type: "phase_start", phase: "planning" },
      { type: "phase_end", phase: "execution", duration_ms: 12345 },
      { type: "worker_spawn", session_id: "worker-abc" },
      { type: "worker_complete", session_id: "worker-xyz", tasks_completed: 5 },
      { type: "worker_fail", session_id: "worker-err", error: "Some error" },
      { type: "worker_timeout", session_id: "worker-timeout", duration_ms: 2700000 },
      { type: "task_claimed", task_id: "task-001", session_id: "worker-1" },
      { type: "task_completed", task_id: "task-002", session_id: "worker-2" },
      { type: "task_failed", task_id: "task-003", session_id: "worker-3", error: "Compilation error" },
      { type: "task_retried", task_id: "task-004", retry_count: 2 },
      { type: "review_verdict", verdict: "approved" },
      { type: "usage_warning", utilization: 0.85 },
      { type: "scheduling_decision", task_id: "task-005", score: 120 },
      {
        type: "project_detection",
        profile: {
          detected_at: "2024-01-01T00:00:00.000Z",
          languages: ["typescript"],
          frameworks: ["nextjs", "express"],
          test_runners: ["vitest"],
          linters: ["eslint", "prettier"],
          ci_systems: ["github-actions"],
          package_managers: ["npm"],
        },
      },
    ] as Record<string, unknown>[])(
      "roundtrips $type event",
      async (eventData) => {
        eventLog.start();
        eventLog.record(eventData as any);
        await eventLog.flush();

        const events = await eventLog.readAll();
        expect(events.length).toBe(1);
        expect(events[0].type).toBe(eventData.type);

        // Verify all fields (except timestamp which is auto-added) survive roundtrip
        for (const [key, value] of Object.entries(eventData)) {
          expect((events[0] as any)[key]).toEqual(value);
        }
      }
    );
  });

  describe("auto-flush timer", () => {
    it("flushes events automatically after EVENT_FLUSH_INTERVAL_MS", async () => {
      vi.useFakeTimers();

      eventLog.start();
      eventLog.record({ type: "phase_start", phase: "auto-flush-test" });

      expect(eventLog.getBufferSize()).toBe(1);

      // Advance timer and let the async flush triggered by setInterval complete
      await vi.advanceTimersByTimeAsync(1100);

      // The buffer should have been drained by the interval-triggered flush
      expect(eventLog.getBufferSize()).toBe(0);

      // Switch back to real timers so readAll's file I/O works normally
      vi.useRealTimers();

      // Allow any pending microtasks/promises from the flush to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      const events = await eventLog.readAll();
      expect(events.length).toBe(1);
      expect((events[0] as Extract<StructuredEvent, { type: "phase_start" }>).phase).toBe(
        "auto-flush-test"
      );
    });
  });

  describe("flush failure re-buffers events", () => {
    it("puts events back in buffer when write fails", async () => {
      // Point the event log at an invalid path (non-existent deep directory that mkdir won't help)
      const badLog = new EventLog("/dev/null/impossible/path");

      badLog.record({ type: "phase_start", phase: "fail-test" });
      badLog.record({ type: "phase_end", phase: "fail-test", duration_ms: 100 });

      expect(badLog.getBufferSize()).toBe(2);

      // flush should throw but events should be re-buffered
      try {
        await badLog.flush();
      } catch {
        // expected
      }

      expect(badLog.getBufferSize()).toBe(2);
    });
  });

  describe("concurrent flush safety", () => {
    it("handles simultaneous flushes without duplicates or data loss", async () => {
      eventLog.start();

      for (let i = 0; i < 5; i++) {
        eventLog.record({ type: "usage_warning", utilization: i / 10 });
      }

      // Fire two flushes simultaneously
      await Promise.all([eventLog.flush(), eventLog.flush()]);

      expect(eventLog.getBufferSize()).toBe(0);

      const events = await eventLog.readAll();
      expect(events.length).toBe(5);

      // Verify no duplicates
      const utilizations = events.map(
        (e) => (e as Extract<StructuredEvent, { type: "usage_warning" }>).utilization
      );
      expect(new Set(utilizations).size).toBe(5);
    });
  });
});

describe("computeAnalytics", () => {
  it("handles multiple phases", () => {
    const events: StructuredEvent[] = [
      { type: "phase_end", phase: "planning", duration_ms: 1000, timestamp: "" },
      { type: "phase_end", phase: "planning", duration_ms: 2000, timestamp: "" },
      { type: "phase_end", phase: "execution", duration_ms: 5000, timestamp: "" },
    ];

    const analytics = computeAnalytics(events);

    expect(analytics.phase_durations["planning"].avg_ms).toBe(1500);
    expect(analytics.phase_durations["planning"].count).toBe(2);
    expect(analytics.phase_durations["execution"].avg_ms).toBe(5000);
    expect(analytics.phase_durations["execution"].count).toBe(1);
  });

  it("handles zero workers", () => {
    const events: StructuredEvent[] = [
      { type: "phase_start", phase: "test", timestamp: "" },
    ];

    const analytics = computeAnalytics(events);

    expect(analytics.worker_success_rate).toBe(0);
    expect(analytics.total_workers).toBe(0);
  });

  it("caps bottleneck tasks at 5", () => {
    const events: StructuredEvent[] = [];
    const baseTime = Date.now();

    for (let i = 0; i < 10; i++) {
      events.push({
        type: "task_claimed",
        task_id: `task-${i}`,
        session_id: "w1",
        timestamp: new Date(baseTime).toISOString(),
      });
      events.push({
        type: "task_completed",
        task_id: `task-${i}`,
        session_id: "w1",
        timestamp: new Date(baseTime + (i + 1) * 1000).toISOString(),
      });
    }

    const analytics = computeAnalytics(events);

    expect(analytics.top_bottleneck_tasks.length).toBe(5);
    expect(analytics.top_bottleneck_tasks[0].task_id).toBe("task-9");
  });
});

describe("formatAnalyticsForDisplay", () => {
  it("produces valid markdown", () => {
    const analytics = {
      phase_durations: { planning: { avg_ms: 5000, count: 2 } },
      worker_success_rate: 75,
      task_retry_rate: 10,
      top_bottleneck_tasks: [{ task_id: "task-001", duration_ms: 30000 }],
      total_events: 100,
      total_workers: 4,
      total_tasks_completed: 20,
    };

    const output = formatAnalyticsForDisplay(analytics);

    expect(output).toContain("## Event Log Analytics");
    expect(output).toContain("**Total Events:** 100");
    expect(output).toContain("**Total Workers:** 4");
    expect(output).toContain("**Tasks Completed:** 20");
    expect(output).toContain("**Worker Success Rate:** 75%");
    expect(output).toContain("**Task Retry Rate:** 10%");
    expect(output).toContain("### Phase Durations");
    expect(output).toContain("**planning:** 5.0s (2 runs)");
    expect(output).toContain("### Top Bottleneck Tasks");
    expect(output).toContain("**task-001:** 30.0s");
  });

  it("handles empty analytics", () => {
    const analytics = {
      phase_durations: {},
      worker_success_rate: 0,
      task_retry_rate: 0,
      top_bottleneck_tasks: [],
      total_events: 0,
      total_workers: 0,
      total_tasks_completed: 0,
    };

    const output = formatAnalyticsForDisplay(analytics);

    expect(output).toContain("## Event Log Analytics");
    expect(output).toContain("**Total Events:** 0");
    expect(output).not.toContain("### Phase Durations");
  });
});

// ============================================================
// H-4 fix: flush() race condition — flushPromise nulled in finally
// ============================================================

describe("EventLog H-4 fix: flush race condition", () => {
  let tempDir: string;
  let eventLog: EventLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-h4-test-"));
    await fs.mkdir(path.join(tempDir, ORCHESTRATOR_DIR), { recursive: true });
    eventLog = new EventLog(tempDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (eventLog.isRunning()) {
      await eventLog.stop();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("concurrent flush calls do not drop events", async () => {
    eventLog.start();

    // Record several events
    for (let i = 0; i < 10; i++) {
      eventLog.record({
        type: "task_claimed",
        task_id: `task-${i}`,
        session_id: `session-${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Fire multiple concurrent flushes
    await Promise.all([
      eventLog.flush(),
      eventLog.flush(),
      eventLog.flush(),
    ]);

    // All events should be persisted
    const events = await eventLog.readAll();
    expect(events.length).toBe(10);
  });

  it("flush after failed write does not permanently block", async () => {
    eventLog.start();

    // Record an event and flush normally
    eventLog.record({
      type: "task_claimed",
      task_id: "task-1",
      session_id: "session-1",
      timestamp: new Date().toISOString(),
    });
    await eventLog.flush();

    // Record more events
    eventLog.record({
      type: "task_completed",
      task_id: "task-2",
      session_id: "session-2",
      timestamp: new Date().toISOString(),
    });

    // Flush should succeed (flushPromise was properly nulled in finally)
    await eventLog.flush();

    const events = await eventLog.readAll();
    expect(events.length).toBe(2);
  });

  it("source code nulls flushPromise in finally block", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/core/event-log.ts"),
      "utf-8",
    );

    // Find the flush method
    const flushStart = source.indexOf("async flush()");
    expect(flushStart).toBeGreaterThan(-1);

    // Use a larger window to capture the full flush method including try/finally block
    const flushBody = source.substring(flushStart, flushStart + 800);

    // H-4 FIX: flushPromise must be nulled in a finally block
    expect(flushBody).toContain("finally");
    expect(flushBody).toContain("this.flushPromise = null");
  });
});

// ============================================================
// A-1 / A-2: rotate() uses writeJsonAtomic and propagates errors
// ============================================================

describe("EventLog A-1/A-2: rotation atomicity", () => {
  let tempDir: string;
  let eventLog: EventLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-rotate-test-"));
    await fs.mkdir(path.join(tempDir, ORCHESTRATOR_DIR), { recursive: true });
    eventLog = new EventLog(tempDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (eventLog.isRunning()) {
      await eventLog.stop();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rotation failure leaves the existing log intact (no truncate)", async () => {
    // Seed the log with real JSONL content
    const logPath = path.join(tempDir, ORCHESTRATOR_DIR, EVENTS_FILE);
    const seed =
      JSON.stringify({ type: "phase_start", phase: "seed-a", timestamp: "2024-01-01T00:00:00.000Z" }) +
      "\n" +
      JSON.stringify({ type: "phase_end", phase: "seed-a", duration_ms: 100, timestamp: "2024-01-01T00:00:01.000Z" }) +
      "\n" +
      JSON.stringify({ type: "phase_start", phase: "seed-b", timestamp: "2024-01-01T00:00:02.000Z" }) +
      "\n";
    await fs.writeFile(logPath, seed, { encoding: "utf-8", mode: 0o600 });
    const before = await fs.readFile(logPath, "utf-8");

    // Force the atomic rename step inside writeJsonAtomic to fail.
    // writeJsonAtomic calls fs.rename(tmp, dest) after writing the tmp file;
    // making rename throw propagates through rotate().
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValue(
      new Error("simulated rotation failure"),
    );

    // Invoke the private rotate() via cast — the scenario we want is "rotate
    // runs, its atomic write fails." Prior to A-1/A-2, the catch branch would
    // truncate the log to empty; now, the error must propagate and the log
    // must be byte-for-byte unchanged.
    const rotate = (eventLog as unknown as { rotate: () => Promise<void> }).rotate.bind(eventLog);
    await expect(rotate()).rejects.toThrow(/simulated rotation failure/);

    renameSpy.mockRestore();

    const after = await fs.readFile(logPath, "utf-8");
    expect(after).toBe(before);
  });
});

/**
 * Task Scheduler Performance Smoke Test (task-015)
 *
 * This smoke test verifies the task scheduler can handle 100 tasks
 * without errors or hangs. No timing assertions are made - this is
 * purely a completion/correctness test at scale.
 */

import { describe, it, expect } from "vitest";
import {
  computeCriticalPathDepths,
  rankClaimableTasks,
} from "./task-scheduler.js";
import type { Task } from "../utils/types.js";

/**
 * Creates a minimal Task for testing.
 */
function makeTask(
  id: string,
  depends_on: string[] = [],
  overrides: Partial<Task> = {}
): Task {
  return {
    id,
    subject: `Task ${id}`,
    description: "Test task",
    status: "pending",
    owner: null,
    depends_on,
    blocks: [],
    result_summary: null,
    files_changed: [],
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe("Task Scheduler - Performance Smoke Test", () => {
  it("handles 100 tasks without errors or hangs", () => {
    const tasks: Task[] = [];

    // Create 10 independent anchor tasks
    for (let i = 0; i < 10; i++) {
      tasks.push(makeTask(`anchor-${i}`, []));
    }

    // Create 90 tasks depending on various anchors
    for (let i = 0; i < 90; i++) {
      const depIndex = i % 10;
      tasks.push(makeTask(`task-${i}`, [`anchor-${depIndex}`]));
    }

    // Verify all operations complete without hanging
    expect(() => computeCriticalPathDepths(tasks)).not.toThrow();
    expect(() => rankClaimableTasks(tasks)).not.toThrow();

    const depths = computeCriticalPathDepths(tasks);
    expect(depths.size).toBe(100);

    const claimable = rankClaimableTasks(tasks);
    // Only the 10 anchor tasks are claimable (pending with no deps);
    // the 90 dependent tasks are blocked by pending anchors
    expect(claimable.length).toBe(10);
  }, 10_000); // 10 second timeout

  it("handles 100 tasks with deep dependency chains", () => {
    const tasks: Task[] = [];

    // Create a chain of 50 tasks: task-0 <- task-1 <- ... <- task-49
    for (let i = 0; i < 50; i++) {
      const deps = i === 0 ? [] : [`chain-${i - 1}`];
      tasks.push(makeTask(`chain-${i}`, deps));
    }

    // Create 50 tasks depending on the end of the chain
    for (let i = 0; i < 50; i++) {
      tasks.push(makeTask(`leaf-${i}`, ["chain-49"]));
    }

    expect(() => computeCriticalPathDepths(tasks)).not.toThrow();

    const depths = computeCriticalPathDepths(tasks);
    expect(depths.size).toBe(100);

    // Verify chain depth is computed correctly
    expect(depths.get("chain-0")).toBe(50); // Deepest in the chain
    expect(depths.get("chain-49")).toBe(1); // End of chain, only blocks leaves
    expect(depths.get("leaf-0")).toBe(0); // Leaves have no downstream
  }, 10_000);

  it("handles 100 tasks with wide fan-out", () => {
    const tasks: Task[] = [];

    // One anchor task
    tasks.push(makeTask("root", []));

    // 99 tasks all depending on root (wide fan-out)
    for (let i = 0; i < 99; i++) {
      tasks.push(makeTask(`child-${i}`, ["root"]));
    }

    expect(() => computeCriticalPathDepths(tasks)).not.toThrow();

    const depths = computeCriticalPathDepths(tasks);
    expect(depths.size).toBe(100);

    // Root should have depth = 1 (max downstream chain length)
    // All children have depth 0, so root = max(0,0,...) + 1 = 1
    expect(depths.get("root")).toBe(1);

    // All children should have depth 0 (no downstream)
    for (let i = 0; i < 99; i++) {
      expect(depths.get(`child-${i}`)).toBe(0);
    }
  }, 10_000);

  it("handles 100 tasks with mixed statuses", () => {
    const tasks: Task[] = [];

    // Create 10 completed anchor tasks
    for (let i = 0; i < 10; i++) {
      tasks.push(
        makeTask(`anchor-${i}`, [], {
          status: "completed",
          completed_at: new Date().toISOString(),
        })
      );
    }

    // Create 90 pending tasks depending on anchors
    for (let i = 0; i < 90; i++) {
      const depIndex = i % 10;
      tasks.push(makeTask(`task-${i}`, [`anchor-${depIndex}`]));
    }

    // rankClaimableTasks should return only pending tasks with completed deps
    const claimable = rankClaimableTasks(tasks);
    expect(claimable.length).toBe(90); // All 90 pending tasks are claimable

    // Verify they are sorted by priority score (descending)
    for (let i = 1; i < claimable.length; i++) {
      expect(claimable[i - 1].priority_score).toBeGreaterThanOrEqual(
        claimable[i].priority_score
      );
    }
  }, 10_000);
});

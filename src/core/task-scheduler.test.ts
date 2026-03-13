import { describe, expect, it } from "vitest";
import {
  computeCriticalPathDepths,
  scoreTask,
  isTaskClaimable,
  rankClaimableTasks,
} from "./task-scheduler.js";
import type { Task, TaskType } from "../utils/types.js";

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

// ============================================================
// computeCriticalPathDepths Tests
// ============================================================

describe("computeCriticalPathDepths", () => {
  it("computes correct depths for linear chain A <- B <- C", () => {
    const tasks = [
      makeTask("A"),
      makeTask("B", ["A"]),
      makeTask("C", ["B"]),
    ];

    const depths = computeCriticalPathDepths(tasks);

    expect(depths.get("A")).toBe(2);
    expect(depths.get("B")).toBe(1);
    expect(depths.get("C")).toBe(0);
  });

  it("computes correct depths for diamond dependency", () => {
    const tasks = [
      makeTask("A"),
      makeTask("B", ["A"]),
      makeTask("C", ["A"]),
      makeTask("D", ["B", "C"]),
    ];

    const depths = computeCriticalPathDepths(tasks);

    expect(depths.get("A")).toBe(2);
    expect(depths.get("B")).toBe(1);
    expect(depths.get("C")).toBe(1);
    expect(depths.get("D")).toBe(0);
  });

  it("returns depth 0 for isolated tasks", () => {
    const tasks = [makeTask("A"), makeTask("B"), makeTask("C")];

    const depths = computeCriticalPathDepths(tasks);

    expect(depths.get("A")).toBe(0);
    expect(depths.get("B")).toBe(0);
    expect(depths.get("C")).toBe(0);
  });

  it("handles cycles gracefully without infinite loops", () => {
    const tasks = [makeTask("A", ["B"]), makeTask("B", ["A"])];

    expect(() => computeCriticalPathDepths(tasks)).not.toThrow();

    const depths = computeCriticalPathDepths(tasks);

    expect(typeof depths.get("A")).toBe("number");
    expect(typeof depths.get("B")).toBe("number");
  });

  it("returns finite depths for cycle members (cycles are broken)", () => {
    const tasks = [makeTask("A", ["B"]), makeTask("B", ["A"])];

    const depths = computeCriticalPathDepths(tasks);

    // Cycle-breaking returns 0 on the back-edge, so one node gets depth 1
    // and the other gets depth 2 (via the non-broken edge). Both are finite.
    expect(Number.isFinite(depths.get("A"))).toBe(true);
    expect(Number.isFinite(depths.get("B"))).toBe(true);
  });

  it("handles self-referential dependencies", () => {
    const tasks = [makeTask("A", ["A"])];

    expect(() => computeCriticalPathDepths(tasks)).not.toThrow();

    const depths = computeCriticalPathDepths(tasks);
    expect(typeof depths.get("A")).toBe("number");
  });

  it("handles missing dependencies gracefully", () => {
    const tasks = [makeTask("A"), makeTask("B", ["X"])];

    expect(() => computeCriticalPathDepths(tasks)).not.toThrow();

    const depths = computeCriticalPathDepths(tasks);
    expect(depths.get("A")).toBe(0);
    expect(depths.get("B")).toBe(0);
  });

  it("computes correct depths for complex graph", () => {
    const tasks = [
      makeTask("A"),
      makeTask("B", ["A"]),
      makeTask("C", ["A"]),
      makeTask("D", ["B", "C"]),
      makeTask("E", ["B", "C"]),
    ];

    const depths = computeCriticalPathDepths(tasks);

    expect(depths.get("A")).toBe(2);
    expect(depths.get("B")).toBe(1);
    expect(depths.get("C")).toBe(1);
    expect(depths.get("D")).toBe(0);
    expect(depths.get("E")).toBe(0);
  });

  it("handles empty task list", () => {
    const depths = computeCriticalPathDepths([]);
    expect(depths.size).toBe(0);
  });

  it("handles single task", () => {
    const tasks = [makeTask("A")];
    const depths = computeCriticalPathDepths(tasks);
    expect(depths.get("A")).toBe(0);
  });

  it("handles a deep chain (50+ tasks) without stack overflow", () => {
    const count = 60;
    const tasks: Task[] = [];
    for (let i = 0; i < count; i++) {
      const id = `T${i}`;
      const deps = i > 0 ? [`T${i - 1}`] : [];
      tasks.push(makeTask(id, deps));
    }

    expect(() => computeCriticalPathDepths(tasks)).not.toThrow();

    const depths = computeCriticalPathDepths(tasks);

    // First task blocks all others: depth = count - 1
    expect(depths.get("T0")).toBe(count - 1);
    // Last task blocks nothing
    expect(depths.get(`T${count - 1}`)).toBe(0);
  });
});

// detectCycles tests removed — function was removed as dead code (only used in tests, not production).
// Cycle detection for task validation is handled by src/utils/task-validator.ts.

// ============================================================
// scoreTask Tests
// ============================================================

describe("scoreTask", () => {
  it.each([
    { type: "security", risk: "high", depth: 2, expected: 20 + 30 + 60 },
    { type: "database", risk: "medium", depth: 1, expected: 10 + 15 + 50 },
    { type: "backend_api", risk: "low", depth: 0, expected: 0 + 0 + 40 },
    { type: "infrastructure", risk: "high", depth: 0, expected: 0 + 30 + 30 },
    { type: "frontend_ui", risk: "low", depth: 0, expected: 0 + 0 + 20 },
    { type: "testing", risk: "low", depth: 3, expected: 30 + 0 + 10 },
    { type: "general", risk: "low", depth: 0, expected: 0 },
    { type: undefined, risk: undefined, depth: 0, expected: 0 },
  ] as { type: TaskType | undefined; risk: Task["risk_level"]; depth: number; expected: number }[])(
    "scores $type/$risk at depth $depth as $expected",
    ({ type, risk, depth, expected }) => {
      const task = makeTask("A", [], {
        ...(type !== undefined && { task_type: type }),
        ...(risk !== undefined && { risk_level: risk }),
      });
      expect(scoreTask(task, depth)).toBe(expected);
    }
  );

  it("critical path depth dominates scoring", () => {
    const lowPriorityDeepTask = makeTask("A", [], {
      task_type: "general",
      risk_level: "low",
    });

    const highPriorityShallowTask = makeTask("B", [], {
      task_type: "security",
      risk_level: "high",
    });

    // Deep task: depth 10 = 100, general = 0, low = 0 -> 100
    const deepScore = scoreTask(lowPriorityDeepTask, 10);
    // Shallow task: depth 0 = 0, security = 60, high = 30 -> 90
    const shallowScore = scoreTask(highPriorityShallowTask, 0);

    expect(deepScore).toBeGreaterThan(shallowScore);
  });
});

// ============================================================
// isTaskClaimable Tests
// ============================================================

describe("isTaskClaimable", () => {
  it("returns true for pending task with no dependencies", () => {
    const task = makeTask("A");
    expect(isTaskClaimable(task, [task])).toBe(true);
  });

  it("returns true for pending task with completed dependencies", () => {
    const taskA = makeTask("A", [], { status: "completed" });
    const taskB = makeTask("B", ["A"]);
    expect(isTaskClaimable(taskB, [taskA, taskB])).toBe(true);
  });

  it("returns false for pending task with pending dependencies", () => {
    const taskA = makeTask("A");
    const taskB = makeTask("B", ["A"]);
    expect(isTaskClaimable(taskB, [taskA, taskB])).toBe(false);
  });

  it("returns false for pending task with in_progress dependencies", () => {
    const taskA = makeTask("A", [], { status: "in_progress" });
    const taskB = makeTask("B", ["A"]);
    expect(isTaskClaimable(taskB, [taskA, taskB])).toBe(false);
  });

  it("returns false for in_progress task", () => {
    const task = makeTask("A", [], { status: "in_progress" });
    expect(isTaskClaimable(task, [task])).toBe(false);
  });

  it("returns false for completed task", () => {
    const task = makeTask("A", [], { status: "completed" });
    expect(isTaskClaimable(task, [task])).toBe(false);
  });

  it("returns false for failed task", () => {
    const task = makeTask("A", [], { status: "failed" });
    expect(isTaskClaimable(task, [task])).toBe(false);
  });

  it("returns false for task with missing dependency", () => {
    const taskB = makeTask("B", ["X"]);
    expect(isTaskClaimable(taskB, [taskB])).toBe(false);
  });

  it("handles multiple dependencies correctly", () => {
    const taskA = makeTask("A", [], { status: "completed" });
    const taskB = makeTask("B", [], { status: "completed" });
    const taskC = makeTask("C", ["A", "B"]);
    expect(isTaskClaimable(taskC, [taskA, taskB, taskC])).toBe(true);
  });

  it("returns false if any dependency is not completed", () => {
    const taskA = makeTask("A", [], { status: "completed" });
    const taskB = makeTask("B", [], { status: "pending" });
    const taskC = makeTask("C", ["A", "B"]);
    expect(isTaskClaimable(taskC, [taskA, taskB, taskC])).toBe(false);
  });
});

// ============================================================
// rankClaimableTasks Tests
// ============================================================

describe("rankClaimableTasks", () => {
  it("returns only pending tasks with completed dependencies", () => {
    const tasks = [
      makeTask("A", [], { status: "completed" }),
      makeTask("B", ["A"], { status: "pending" }),
      makeTask("C", ["A"], { status: "in_progress" }),
      makeTask("D", ["B"], { status: "pending" }), // blocked by B which is pending
    ];

    const ranked = rankClaimableTasks(tasks);

    expect(ranked.length).toBe(1);
    expect(ranked[0].id).toBe("B");
  });

  it("sorts by priority score descending", () => {
    const tasks = [
      makeTask("A", [], { task_type: "general", risk_level: "low" }),
      makeTask("B", [], { task_type: "security", risk_level: "high" }),
      makeTask("C", [], { task_type: "database", risk_level: "medium" }),
    ];

    const ranked = rankClaimableTasks(tasks);

    expect(ranked[0].id).toBe("B");
    expect(ranked[1].id).toBe("C");
    expect(ranked[2].id).toBe("A");
  });

  it("includes priority_score and critical_path_depth in results", () => {
    const tasks = [makeTask("A", [], { task_type: "security" })];

    const ranked = rankClaimableTasks(tasks);

    expect(ranked[0]).toHaveProperty("priority_score");
    expect(ranked[0]).toHaveProperty("critical_path_depth");
    expect(ranked[0].priority_score).toBe(60);
    expect(ranked[0].critical_path_depth).toBe(0);
  });

  it("returns empty array when no tasks are claimable", () => {
    const tasks = [
      makeTask("A", [], { status: "in_progress" }),
      makeTask("B", ["A"], { status: "pending" }),
    ];

    const ranked = rankClaimableTasks(tasks);
    expect(ranked).toEqual([]);
  });

  it("handles empty task list", () => {
    const ranked = rankClaimableTasks([]);
    expect(ranked).toEqual([]);
  });

  it("considers critical path depth in ranking", () => {
    // A blocks B,C which block D — only A is claimable
    const tasks = [
      makeTask("A"),
      makeTask("B", ["A"]),
      makeTask("C", ["A"]),
      makeTask("D", ["B", "C"]),
    ];

    const ranked = rankClaimableTasks(tasks);
    expect(ranked.length).toBe(1);
    expect(ranked[0].id).toBe("A");
    expect(ranked[0].critical_path_depth).toBe(2);
    expect(ranked[0].priority_score).toBe(20); // depth 2 * 10 = 20
  });

  it("produces stable ordering for tasks with equal scores", () => {
    // All tasks have same type, risk, and depth — order should be deterministic
    const tasks = [
      makeTask("X", [], { task_type: "general", risk_level: "low" }),
      makeTask("Y", [], { task_type: "general", risk_level: "low" }),
      makeTask("Z", [], { task_type: "general", risk_level: "low" }),
    ];

    const ranked1 = rankClaimableTasks(tasks);
    const ranked2 = rankClaimableTasks(tasks);

    const ids1 = ranked1.map((t) => t.id);
    const ids2 = ranked2.map((t) => t.id);
    expect(ids1).toEqual(ids2);
  });
});

// rankAllTasks tests removed — function was removed as dead code (only used in tests, not production).

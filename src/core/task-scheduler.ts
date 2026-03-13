/**
 * Task Scheduler Module (V2)
 *
 * Provides smart task scheduling based on:
 * - Critical path analysis (tasks blocking the most others get priority)
 * - Risk-based ordering (high-risk tasks run earlier to catch issues sooner)
 * - Task type priority (security > database > backend > infrastructure > frontend > testing > general)
 *
 * Scoring formula: totalScore = (criticalPathDepth * 10) + riskScore + typeScore
 */

import type { Task, TaskType } from "../utils/types.js";
import {
  TASK_TYPE_PRIORITY,
  RISK_LEVEL_SCORE,
  CRITICAL_PATH_DEPTH_MULTIPLIER,
} from "../utils/constants.js";

// ============================================================
// Types
// ============================================================

export interface RankedTask extends Task {
  priority_score: number;
  critical_path_depth: number;
}

// Maximum recursion depth to prevent stack overflow on malformed graphs
const MAX_RECURSION_DEPTH = 1000;

// ============================================================
// Critical Path Analysis
// ============================================================

/**
 * Computes the critical path depth for each task.
 *
 * Critical path depth = max downstream chain depth (how many tasks depend on this task,
 * transitively). Tasks that block more downstream work have higher depths.
 *
 * Algorithm:
 * 1. Build adjacency list: task -> tasks that depend on it (blocks)
 * 2. For each task, recursively compute max depth of blocked tasks + 1
 * 3. Memoize results to avoid recomputation
 * 4. Tasks with no dependents have depth 0
 *
 * Handles cycles gracefully by detecting and breaking them.
 * Handles missing dependencies gracefully (treats as depth 0).
 *
 * @param tasks Array of all tasks
 * @returns Map of task ID -> critical path depth
 */
export function computeCriticalPathDepths(tasks: Task[]): Map<string, number> {
  const depths = new Map<string, number>();
  const taskMap = new Map<string, Task>();
  const visiting = new Set<string>(); // For cycle detection

  // Build task lookup map
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // Build adjacency list: task -> tasks that depend on it
  // We use the "blocks" field if available, otherwise compute from depends_on
  const blocksGraph = new Map<string, string[]>();
  for (const task of tasks) {
    if (!blocksGraph.has(task.id)) {
      blocksGraph.set(task.id, []);
    }
  }

  // Build reverse dependency graph (who blocks whom)
  for (const task of tasks) {
    for (const depId of task.depends_on) {
      const blockedTasks = blocksGraph.get(depId);
      if (blockedTasks) {
        blockedTasks.push(task.id);
      }
      // If depId doesn't exist in taskMap, it's a missing dependency - ignore silently
    }
  }

  /**
   * Recursively compute depth for a task.
   * Depth = max(depth of tasks this task blocks) + 1, or 0 if no tasks depend on it.
   */
  function computeDepth(taskId: string, currentDepth: number): number {
    // Prevent stack overflow
    if (currentDepth > MAX_RECURSION_DEPTH) {
      return 0;
    }

    // Return cached result if available
    if (depths.has(taskId)) {
      return depths.get(taskId)!;
    }

    // Cycle detection
    if (visiting.has(taskId)) {
      // Cycle detected - break it by returning 0
      return 0;
    }

    visiting.add(taskId);

    const blockedTasks = blocksGraph.get(taskId) ?? [];
    let maxDownstreamDepth = 0;

    for (const blockedId of blockedTasks) {
      const downstreamDepth = computeDepth(blockedId, currentDepth + 1);
      maxDownstreamDepth = Math.max(maxDownstreamDepth, downstreamDepth + 1);
    }

    visiting.delete(taskId);
    depths.set(taskId, maxDownstreamDepth);

    return maxDownstreamDepth;
  }

  // Compute depths for all tasks
  for (const task of tasks) {
    if (!depths.has(task.id)) {
      computeDepth(task.id, 0);
    }
  }

  return depths;
}

// detectCycles() was removed as dead code — only referenced in test files, never in production code.
// Cycle detection for task validation is handled separately by src/utils/task-validator.ts.

// ============================================================
// Task Scoring
// ============================================================

/**
 * Computes the priority score for a task.
 *
 * Formula: totalScore = (criticalPathDepth * 10) + riskScore + typeScore
 *
 * Higher scores = higher priority (should be claimed first)
 *
 * @param task The task to score
 * @param criticalPathDepth The task's critical path depth
 * @returns The computed priority score
 */
export function scoreTask(task: Task, criticalPathDepth: number): number {
  const taskType = task.task_type ?? "general";
  const riskLevel = task.risk_level ?? "low";

  const typeScore = TASK_TYPE_PRIORITY[taskType as TaskType] ?? 0;
  const riskScore = RISK_LEVEL_SCORE[riskLevel] ?? 0;

  return criticalPathDepth * CRITICAL_PATH_DEPTH_MULTIPLIER + riskScore + typeScore;
}

// ============================================================
// Task Claimability
// ============================================================

/**
 * Checks if a task is claimable (pending with all dependencies completed).
 *
 * @param task The task to check
 * @param allTasks All tasks in the system
 * @returns true if the task can be claimed
 */
export function isTaskClaimable(task: Task, allTasks: Task[]): boolean {
  // Task must be pending
  if (task.status !== "pending") {
    return false;
  }

  // Build a lookup for task statuses
  const statusMap = new Map<string, string>();
  for (const t of allTasks) {
    statusMap.set(t.id, t.status);
  }

  // All dependencies must be completed
  for (const depId of task.depends_on) {
    const depStatus = statusMap.get(depId);
    // If dependency doesn't exist or isn't completed, task is not claimable
    if (depStatus !== "completed") {
      return false;
    }
  }

  return true;
}

// ============================================================
// Task Ranking
// ============================================================

/**
 * Returns claimable tasks ranked by priority score (highest first).
 *
 * Claimable tasks are:
 * - Status is "pending"
 * - All dependencies are "completed"
 *
 * Tasks are sorted by priority_score descending (highest priority first).
 *
 * @param tasks Array of all tasks
 * @returns Array of claimable tasks with priority_score and critical_path_depth attached
 */
export function rankClaimableTasks(tasks: Task[]): RankedTask[] {
  // Filter to claimable tasks only
  const claimableTasks = tasks.filter((task) => isTaskClaimable(task, tasks));

  // Compute critical path depths for all tasks (needed for accurate scoring)
  const depths = computeCriticalPathDepths(tasks);

  // Score and rank claimable tasks
  const rankedTasks: RankedTask[] = claimableTasks.map((task) => {
    const criticalPathDepth = depths.get(task.id) ?? 0;
    const priorityScore = scoreTask(task, criticalPathDepth);

    return {
      ...task,
      priority_score: priorityScore,
      critical_path_depth: criticalPathDepth,
    };
  });

  // Sort by priority score descending (highest priority first)
  rankedTasks.sort((a, b) => b.priority_score - a.priority_score);

  return rankedTasks;
}

// rankAllTasks() was removed as dead code — only referenced in test files, never in production code.

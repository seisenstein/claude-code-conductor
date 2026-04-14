import type { TaskDefinition, TaskType } from "./types.js";

// ============================================================
// Task Definition Validation
// ============================================================

const VALID_COMPLEXITIES = ["small", "medium", "large"] as const;
type Complexity = (typeof VALID_COMPLEXITIES)[number];

const VALID_TASK_TYPES: TaskType[] = [
  "backend_api", "frontend_ui", "database", "security",
  "testing", "infrastructure",
  "reverse_engineering", "integration", "general",
];

const VALID_RISK_LEVELS = ["low", "medium", "high"] as const;
type RiskLevel = (typeof VALID_RISK_LEVELS)[number];

export type ValidationSuccess = { valid: true; task: TaskDefinition };
export type ValidationFailure = { valid: false; errors: string[] };
export type ValidationResult = ValidationSuccess | ValidationFailure;

export type ArrayValidationSuccess = { valid: true; tasks: TaskDefinition[] };
export type ArrayValidationFailure = { valid: false; errors: string[] };
export type ArrayValidationResult = ArrayValidationSuccess | ArrayValidationFailure;

/**
 * Validate and normalize a single task definition object.
 */
export function validateTaskDefinition(obj: unknown): ValidationResult {
  if (!obj || typeof obj !== "object") {
    return { valid: false, errors: ["Not an object"] };
  }

  const record = obj as Record<string, unknown>;
  const errors: string[] = [];

  const subject = typeof record.subject === "string" ? record.subject.trim() : null;
  const description = typeof record.description === "string" ? record.description.trim() : null;

  if (!subject) errors.push("Missing or empty 'subject' field");
  if (!description) errors.push("Missing or empty 'description' field");

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // depends_on_subjects
  let dependsOnSubjects: string[] = [];
  if (Array.isArray(record.depends_on_subjects)) {
    dependsOnSubjects = record.depends_on_subjects.filter(
      (d): d is string => typeof d === "string",
    );
  }

  // estimated_complexity
  let complexity: Complexity = "medium";
  if (
    typeof record.estimated_complexity === "string" &&
    (VALID_COMPLEXITIES as readonly string[]).includes(record.estimated_complexity)
  ) {
    complexity = record.estimated_complexity as Complexity;
  }

  // task_type
  let taskType: TaskType = "general";
  if (
    typeof record.task_type === "string" &&
    (VALID_TASK_TYPES as string[]).includes(record.task_type)
  ) {
    taskType = record.task_type as TaskType;
  }

  // string[] fields
  const securityRequirements = extractStringArray(record.security_requirements);
  const performanceRequirements = extractStringArray(record.performance_requirements);
  const acceptanceCriteria = extractStringArray(record.acceptance_criteria);

  // risk_level
  let riskLevel: RiskLevel;
  if (
    typeof record.risk_level === "string" &&
    (VALID_RISK_LEVELS as readonly string[]).includes(record.risk_level)
  ) {
    riskLevel = record.risk_level as RiskLevel;
  } else {
    riskLevel = taskType === "security" ? "high" : "medium";
  }

  return {
    valid: true,
    task: {
      subject: subject!,
      description: description!,
      depends_on_subjects: dependsOnSubjects,
      estimated_complexity: complexity,
      task_type: taskType,
      security_requirements: securityRequirements,
      performance_requirements: performanceRequirements,
      acceptance_criteria: acceptanceCriteria,
      risk_level: riskLevel,
    },
  };
}

/**
 * Parse and validate a JSON string as an array of TaskDefinitions.
 *
 * Checks:
 * - Valid JSON
 * - Is an array
 * - Non-empty (at least one task required)
 * - Each element is a valid TaskDefinition
 * - No duplicate subjects
 * - All dependency references resolve to existing subjects
 * - No dependency cycles
 */
export function validateTaskArray(json: string): ArrayValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      valid: false,
      errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!Array.isArray(parsed)) {
    return { valid: false, errors: ["Expected a JSON array, got " + typeof parsed] };
  }

  if (parsed.length === 0) {
    return { valid: false, errors: ["Task array is empty -- at least one task is required"] };
  }

  const tasks: TaskDefinition[] = [];
  const errors: string[] = [];

  // Validate each element
  for (let i = 0; i < parsed.length; i++) {
    const result = validateTaskDefinition(parsed[i]);
    if (result.valid) {
      tasks.push(result.task);
    } else {
      errors.push(`Task [${i}]: ${result.errors.join("; ")}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check for duplicate subjects
  const subjects = new Set<string>();
  for (const task of tasks) {
    if (subjects.has(task.subject)) {
      errors.push(`Duplicate subject: "${task.subject}"`);
    }
    subjects.add(task.subject);
  }

  // Check for dangling dependency references
  for (const task of tasks) {
    for (const dep of task.depends_on_subjects) {
      if (!subjects.has(dep)) {
        errors.push(`Task "${task.subject}" depends on unknown subject "${dep}"`);
      }
    }
  }

  // Check for dependency cycles
  const cycleError = detectCycles(tasks);
  if (cycleError) {
    errors.push(cycleError);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, tasks };
}

// ============================================================
// Helpers
// ============================================================

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string");
}

function detectCycles(tasks: TaskDefinition[]): string | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const taskMap = new Map(tasks.map((t) => [t.subject, t]));

  const dfs = (subject: string): string | null => {
    if (inStack.has(subject)) return `Dependency cycle detected involving "${subject}"`;
    if (visited.has(subject)) return null;
    visited.add(subject);
    inStack.add(subject);
    const task = taskMap.get(subject);
    if (task) {
      for (const dep of task.depends_on_subjects) {
        if (taskMap.has(dep)) {
          const result = dfs(dep);
          if (result) return result;
        }
      }
    }
    inStack.delete(subject);
    return null;
  };

  for (const task of tasks) {
    const result = dfs(task.subject);
    if (result) return result;
  }
  return null;
}

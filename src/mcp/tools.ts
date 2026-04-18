import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lock } from "proper-lockfile";
import { z } from "zod";
import type {
  Message,
  MessageType,
  Task,
  TaskStatus,
  SessionStatus,
  ContractSpec,
  ArchitecturalDecision,
  ClaimTaskResult,
} from "../utils/types.js";
import {
  TASKS_DIR,
  MESSAGES_DIR,
  SESSIONS_DIR,
  SESSION_STATUS_FILE,
  CONTRACTS_DIR,
  DECISIONS_FILE,
} from "../utils/constants.js";
import { rankClaimableTasks, type RankedTask } from "../core/task-scheduler.js";
import { validateFileName, validateFileNames } from "../utils/validation.js";
import { appendJsonlLocked, mkdirSecure } from "../utils/secure-fs.js";

const execFileAsync = promisify(execFile);

// ============================================================
// Input Size Limits (#16 - DoS prevention)
// ============================================================

const MAX_RESULT_SUMMARY_LENGTH = 10_000; // 10K chars
const MAX_CONTRACT_SPEC_LENGTH = 50_000;  // 50K chars
const MAX_DECISION_LENGTH = 10_000;       // 10K chars
const MAX_MESSAGE_CONTENT_LENGTH = 10_000; // 10K chars

// Valid test file extensions (task-014 - test_files validation)
const VALID_TEST_EXTENSIONS = [
  '.test.ts',
  '.test.js',
  '.spec.ts',
  '.spec.js',
  '.test.tsx',
  '.spec.tsx',
  '.test.jsx',
  '.spec.jsx',
];

// Zod schemas for input validation
const CompleteTaskInputSchema = z.object({
  task_id: z.string(),
  result_summary: z.string().max(MAX_RESULT_SUMMARY_LENGTH, {
    message: `result_summary exceeds maximum length of ${MAX_RESULT_SUMMARY_LENGTH} characters`,
  }),
  files_changed: z.array(z.string()).optional(),
});

const RegisterContractInputSchema = z.object({
  contract_id: z.string(),
  contract_type: z.enum(["api_endpoint", "type_definition", "event_schema", "database_schema"]),
  spec: z.string().max(MAX_CONTRACT_SPEC_LENGTH, {
    message: `spec exceeds maximum length of ${MAX_CONTRACT_SPEC_LENGTH} characters`,
  }),
  task_id: z.string().optional(), // H-12: Optional task_id for accurate contract provenance
});

// M-26: Valid ArchitecturalDecision categories matching the type in types.ts
// H-18: exported so the MCP tool schema in coordination-server.ts can use
// the same enum for validation (previously used z.string(), producing a
// less informative error when invalid categories got past the MCP boundary).
export const VALID_DECISION_CATEGORIES = [
  "naming", "auth", "data_model", "error_handling",
  "api_design", "testing", "performance", "other",
] as const;

const RecordDecisionInputSchema = z.object({
  // M-26: Validate category against allowed enum values instead of allowing any string
  category: z.enum(VALID_DECISION_CATEGORIES),
  decision: z.string().max(MAX_DECISION_LENGTH, {
    message: `decision exceeds maximum length of ${MAX_DECISION_LENGTH} characters`,
  }),
  rationale: z.string().max(MAX_DECISION_LENGTH, {
    message: `rationale exceeds maximum length of ${MAX_DECISION_LENGTH} characters`,
  }),
  task_id: z.string().optional(),
});

const PostUpdateInputSchema = z.object({
  // M-25: Validate type against MessageType enum values instead of allowing any string
  type: z.enum([
    "status",
    "question",
    "answer",
    "broadcast",
    "wind_down",
    "task_completed",
    "error",
    "escalation",
  ]),
  content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH, {
    message: `content exceeds maximum length of ${MAX_MESSAGE_CONTENT_LENGTH} characters`,
  }),
  to: z.string().optional(),
});

// ============================================================
// Environment helpers
// ============================================================

function getConductorDir(): string {
  const dir = process.env.CONDUCTOR_DIR;
  if (!dir) {
    throw new Error("CONDUCTOR_DIR environment variable is not set");
  }
  return dir;
}

function getSessionId(): string {
  const id = process.env.SESSION_ID;
  if (!id) {
    throw new Error("SESSION_ID environment variable is not set");
  }
  return id;
}

function tasksDir(): string {
  return path.join(getConductorDir(), TASKS_DIR);
}

function messagesDir(): string {
  return path.join(getConductorDir(), MESSAGES_DIR);
}

function sessionsDir(): string {
  return path.join(getConductorDir(), SESSIONS_DIR);
}

function contractsDir(): string {
  return path.join(getConductorDir(), CONTRACTS_DIR);
}

function decisionsPath(): string {
  return path.join(getConductorDir(), DECISIONS_FILE);
}

function getProjectDir(): string {
  const conductorDir = getConductorDir();
  // CONDUCTOR_DIR is <project>/.conductor, so go up one level
  return path.dirname(conductorDir);
}

// ============================================================
// Utility helpers
// ============================================================

/**
 * Ensure a directory exists, creating it and parents if necessary.
 */
async function ensureDir(dir: string): Promise<void> {
  await mkdirSecure(dir, { recursive: true }); // H-2
}

/**
 * Generate a unique message ID: {SESSION_ID}-{timestamp}-{random4chars}
 */
function generateMessageId(): string {
  const sessionId = getSessionId();
  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  return `${sessionId}-${timestamp}-${rand}`;
}

/**
 * Safely read a JSON file. Returns null if the file doesn't exist.
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Safely read a JSONL file. Returns empty array if the file doesn't exist.
 * Malformed JSON lines are skipped with a warning (C3 fix).
 */
export async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const results: T[] = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as T);
      } catch {
        // Skip malformed lines - log warning but don't crash
        process.stderr.write(
          `[readJsonlFile] Skipping malformed JSON line in ${filePath}: ${line.substring(0, 100)}\n`,
        );
      }
    }
    return results;
  } catch (err: unknown) {
    const errCode = (err as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      return [];
    }
    // M-28: Re-throw permission errors (EACCES, EPERM) instead of silently swallowing.
    // Only ENOENT (file not found) should return an empty array.
    process.stderr.write(
      `[readJsonlFile] Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    throw err;
  }
}

// ============================================================
// Tool: read_updates
// ============================================================

export interface ReadUpdatesInput {
  since?: string;
  /**
   * H-19: optional cap on returned messages. When omitted, returns all
   * matching messages (preserves pre-H-19 contract). When supplied, returns
   * the `limit` most recent messages by timestamp.
   */
  limit?: number;
}

/**
 * H-19: safety rail clamping explicit `limit` requests. Not applied when
 * `limit` is unspecified — that path intentionally returns all matches.
 */
export const MAX_READ_UPDATES_HARD_CAP = 10_000;

export async function handleReadUpdates(
  input: ReadUpdatesInput
): Promise<Message[]> {
  const dir = messagesDir();
  await ensureDir(dir);

  const sessionId = getSessionId();
  // M-27: Guard against invalid timestamps — NaN would cause all messages to pass the filter
  const rawSinceTs = input.since ? new Date(input.since).getTime() : 0;
  const sinceTs = Number.isNaN(rawSinceTs) ? 0 : rawSinceTs;
  // H-19: cap is opt-in. No default cap preserves the existing contract.
  const limit = typeof input.limit === "number"
    ? Math.max(1, Math.min(input.limit, MAX_READ_UPDATES_HARD_CAP))
    : null;

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  const allMessages: Message[] = [];

  for (const file of jsonlFiles) {
    const filePath = path.join(dir, file);
    // H-19: mtime pre-filter. If `since` is supplied and the file hasn't
    // been modified since then, no message inside could be newer than
    // `since`. Invisible optimization — output is identical to pre-H-19.
    if (sinceTs > 0) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs <= sinceTs) continue;
      } catch {
        // Stat failure — fall through to regular read
      }
    }
    const messages = await readJsonlFile<Message>(filePath);
    allMessages.push(...messages);
  }

  // Filter: include messages addressed to this session or broadcasts (no `to` field)
  const filtered = allMessages.filter((msg) => {
    // Must be newer than `since`
    const msgTs = new Date(msg.timestamp).getTime();
    if (msgTs <= sinceTs) return false;

    // Must be addressed to us or be a broadcast
    if (msg.to && msg.to !== sessionId) return false;

    return true;
  });

  // Sort by timestamp ascending
  filtered.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  if (limit === null) return filtered;
  // Return the `limit` MOST RECENT messages (trailing slice), preserving
  // ascending order within the returned window.
  return filtered.slice(Math.max(0, filtered.length - limit));
}

// ============================================================
// Tool: post_update
// ============================================================

export interface PostUpdateInput {
  type: MessageType;
  content: string;
  to?: string;
}

export async function handlePostUpdate(
  input: PostUpdateInput
): Promise<Message | { error: string }> {
  // Validate input size limits (#16 - DoS prevention)
  const sizeValidation = PostUpdateInputSchema.safeParse(input);
  if (!sizeValidation.success) {
    return { error: sizeValidation.error.issues.map((e: { message: string }) => e.message).join("; ") };
  }

  const dir = messagesDir();
  await ensureDir(dir);

  const sessionId = getSessionId();
  const message: Message = {
    id: generateMessageId(),
    from: sessionId,
    type: input.type,
    content: input.content,
    timestamp: new Date().toISOString(),
  };

  if (input.to) {
    message.to = input.to;
  }

  const filePath = path.join(dir, `${sessionId}.jsonl`);

  // H7/H9: Use appendJsonlLocked for atomic create-or-open + locking.
  // This avoids the TOCTOU race where concurrent callers both see the file
  // as missing and one truncates the other's data via writeFile("").
  await appendJsonlLocked(filePath, message);

  return message;
}

// ============================================================
// Tool: get_tasks
// ============================================================

export interface GetTasksInput {
  status_filter?: TaskStatus;
  ranked?: boolean; // V2: Return tasks sorted by priority
}

/**
 * Get tasks from the task board.
 *
 * If ranked=true, returns only claimable tasks (pending with all dependencies
 * completed), sorted by priority score (highest first). The returned tasks
 * include priority_score and critical_path_depth fields.
 *
 * If ranked=false or omitted, returns all tasks sorted by ID.
 */
export async function handleGetTasks(
  input: GetTasksInput,
): Promise<Task[] | RankedTask[]> {
  const dir = tasksDir();
  await ensureDir(dir);

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const tasks: Task[] = [];

  for (const file of jsonFiles) {
    const filePath = path.join(dir, file);
    const task = await readJsonFile<Task>(filePath);
    if (task) {
      // When ranked=true, we need all tasks for dependency computation
      // so we skip status_filter here and filter after ranking
      if (!input.ranked) {
        if (!input.status_filter || task.status === input.status_filter) {
          tasks.push(task);
        }
      } else {
        tasks.push(task);
      }
    }
  }

  // V2: If ranked=true, return prioritized claimable tasks
  if (input.ranked) {
    // H-11: When status_filter is set to a non-pending value with ranked=true,
    // skip ranking (which only returns pending tasks with completed deps) and
    // just filter all tasks by the requested status.
    if (input.status_filter && input.status_filter !== "pending") {
      const filtered = tasks.filter((t) => t.status === input.status_filter);
      filtered.sort((a, b) => a.id.localeCompare(b.id));
      return filtered;
    }

    // rankClaimableTasks filters to pending tasks with completed deps
    // and returns them sorted by priority score descending
    const ranked = rankClaimableTasks(tasks);

    return ranked;
  }

  // Default: sort by id
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  return tasks;
}

// ============================================================
// Tool: claim_task
// ============================================================

export interface ClaimTaskInput {
  task_id: string;
}

export async function handleClaimTask(
  input: ClaimTaskInput
): Promise<ClaimTaskResult> {
  // Validate task_id to prevent path traversal (#28)
  const taskIdValidation = validateFileName(input.task_id);
  if (!taskIdValidation.valid) {
    return { success: false, error: `Invalid task_id: ${taskIdValidation.reason}` };
  }

  const dir = tasksDir();
  await ensureDir(dir);

  const taskPath = path.join(dir, `${input.task_id}.json`);

  // Verify the file exists before trying to lock
  try {
    await fs.access(taskPath);
  } catch {
    return { success: false, error: `Task file not found: ${input.task_id}` };
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(taskPath, { retries: { retries: 5, minTimeout: 100 } });

    // Double-check pattern: Re-read task after acquiring lock to prevent TOCTOU race (#5)
    // Another worker may have claimed or modified the task between our access check and lock acquisition
    const task = await readJsonFile<Task>(taskPath);
    if (!task) {
      return { success: false, error: `Task not found: ${input.task_id}` };
    }

    // Verify task is still pending after lock acquisition (double-check)
    if (task.status !== "pending") {
      return {
        success: false,
        error: `Task ${input.task_id} is not pending (current status: ${task.status})`,
      };
    }

    // Verify all dependencies are completed
    if (task.depends_on.length > 0) {
      for (const depId of task.depends_on) {
        // Validate dep ID to prevent path traversal (#30)
        const depValidation = validateFileName(depId);
        if (!depValidation.valid) {
          return { success: false, error: `Invalid dependency ID "${depId}": ${depValidation.reason}` };
        }
        const depPath = path.join(dir, `${depId}.json`);
        const depTask = await readJsonFile<Task>(depPath);
        if (!depTask || depTask.status !== "completed") {
          return {
            success: false,
            error: `Task ${input.task_id} is blocked by unresolved dependency: ${depId}`,
          };
        }
      }
    }

    // Claim the task
    const sessionId = getSessionId();
    task.status = "in_progress";
    task.owner = sessionId;
    task.started_at = new Date().toISOString();

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2), { encoding: "utf-8", mode: 0o600 });

    // Gather dependency context (dep IDs already validated above)
    const dependency_context: { task_id: string; result_summary: string | null; files_changed: string[] }[] = [];
    for (const depId of task.depends_on) {
      const depPath = path.join(dir, `${depId}.json`);
      const depTask = await readJsonFile<Task>(depPath);
      if (depTask) {
        dependency_context.push({
          task_id: depId,
          result_summary: depTask.result_summary,
          files_changed: depTask.files_changed,
        });
      }
    }

    // Find in-progress sibling tasks (owned by other sessions)
    const in_progress_siblings: { task_id: string; subject: string }[] = [];
    let taskFiles: string[];
    try {
      taskFiles = await fs.readdir(dir);
    } catch {
      taskFiles = [];
    }
    for (const file of taskFiles.filter((f) => f.endsWith(".json"))) {
      const siblingTask = await readJsonFile<Task>(path.join(dir, file));
      if (
        siblingTask &&
        siblingTask.status === "in_progress" &&
        siblingTask.owner !== sessionId &&
        siblingTask.id !== task.id
      ) {
        in_progress_siblings.push({
          task_id: siblingTask.id,
          subject: siblingTask.subject,
        });
      }
    }

    // Read all contracts
    const contracts: ContractSpec[] = [];
    try {
      const cDir = contractsDir();
      const contractFiles = await fs.readdir(cDir);
      for (const cf of contractFiles.filter((f) => f.endsWith(".json"))) {
        const contract = await readJsonFile<ContractSpec>(path.join(cDir, cf));
        if (contract) contracts.push(contract);
      }
      contracts.sort((a, b) => a.registered_at.localeCompare(b.registered_at));
    } catch {
      // contracts dir may not exist yet
    }

    // Read all decisions
    let decisions: ArchitecturalDecision[] = [];
    try {
      decisions = await readJsonlFile<ArchitecturalDecision>(decisionsPath());
      decisions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
      // decisions file may not exist yet
    }

    // Build warnings
    const warnings: string[] = [];
    if (in_progress_siblings.length > 0) {
      warnings.push(
        `${in_progress_siblings.length} sibling task(s) in progress concurrently - coordinate via contracts and messages.`
      );
    }

    return {
      success: true,
      task,
      dependency_context,
      in_progress_siblings,
      contracts,
      decisions,
      warnings,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during claim";
    return { success: false, error: message };
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock may already be released if the process is dying
      }
    }
  }
}

// ============================================================
// Tool: complete_task
// ============================================================

export interface CompleteTaskInput {
  task_id: string;
  result_summary: string;
  files_changed?: string[];
}

export interface CompleteTaskResult {
  success: boolean;
  task?: Task;
  error?: string;
}

export async function handleCompleteTask(
  input: CompleteTaskInput
): Promise<CompleteTaskResult> {
  // Validate task_id to prevent path traversal (#28)
  const taskIdValidation = validateFileName(input.task_id);
  if (!taskIdValidation.valid) {
    return { success: false, error: `Invalid task_id: ${taskIdValidation.reason}` };
  }

  // Validate input size limits (#16 - DoS prevention)
  const sizeValidation = CompleteTaskInputSchema.safeParse(input);
  if (!sizeValidation.success) {
    return {
      success: false,
      error: sizeValidation.error.issues.map((e: { message: string }) => e.message).join("; "),
    };
  }

  // Validate files_changed entries to prevent path traversal (#14)
  if (input.files_changed && input.files_changed.length > 0) {
    const failures = validateFileNames(input.files_changed);
    if (failures.length > 0) {
      const failureDetails = failures.map(f => `  - "${f.filename}": ${f.reason}`).join("\n");
      return {
        success: false,
        error: `Invalid files_changed entries:\n${failureDetails}`,
      };
    }
  }

  const dir = tasksDir();
  await ensureDir(dir);

  const taskPath = path.join(dir, `${input.task_id}.json`);

  // Verify the file exists before trying to lock
  try {
    await fs.access(taskPath);
  } catch {
    return { success: false, error: `Task file not found: ${input.task_id}` };
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lock(taskPath, { retries: { retries: 3, minTimeout: 100 } });

    const task = await readJsonFile<Task>(taskPath);
    if (!task) {
      return { success: false, error: `Task not found: ${input.task_id}` };
    }

    // H6: Verify task is in_progress before allowing completion
    if (task.status !== "in_progress") {
      return {
        success: false,
        error: `Cannot complete task ${input.task_id}: task is in '${task.status}' status, expected 'in_progress'`,
      };
    }

    // Verify this session owns the task
    const sessionId = getSessionId();
    if (task.owner !== sessionId) {
      return {
        success: false,
        error: `Task ${input.task_id} is owned by ${task.owner}, not ${sessionId}`,
      };
    }

    // Mark as completed
    task.status = "completed";
    task.completed_at = new Date().toISOString();
    task.result_summary = input.result_summary;
    if (input.files_changed) {
      task.files_changed = input.files_changed;
    }

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2), { encoding: "utf-8", mode: 0o600 });

    // Post a task_completed message to the orchestrator message log
    const msgDir = messagesDir();
    await ensureDir(msgDir);

    const completionMessage: Message = {
      id: generateMessageId(),
      from: sessionId,
      type: "task_completed",
      to: "orchestrator",
      content: `Task ${input.task_id} completed: ${input.result_summary}`,
      metadata: {
        task_id: input.task_id,
        files_changed: input.files_changed ?? [],
      },
      timestamp: new Date().toISOString(),
    };

    const msgPath = path.join(msgDir, `${sessionId}.jsonl`);
    await appendJsonlLocked(msgPath, completionMessage);

    return { success: true, task };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during completion";
    return { success: false, error: message };
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock may already be released
      }
    }
  }
}

// ============================================================
// Tool: get_session_status
// ============================================================

export interface GetSessionStatusInput {
  session_id: string;
}

export interface GetSessionStatusResult {
  found: boolean;
  status?: SessionStatus;
}

export async function handleGetSessionStatus(
  input: GetSessionStatusInput
): Promise<GetSessionStatusResult> {
  // Validate session_id to prevent path traversal (#29)
  const sessionIdValidation = validateFileName(input.session_id);
  if (!sessionIdValidation.valid) {
    return { found: false };
  }

  const dir = sessionsDir();
  const statusPath = path.join(dir, input.session_id, SESSION_STATUS_FILE);

  const status = await readJsonFile<SessionStatus>(statusPath);
  if (!status) {
    return { found: false };
  }

  return { found: true, status };
}

// ============================================================
// Tool: register_contract
// ============================================================

export interface RegisterContractInput {
  contract_id: string;
  contract_type: "api_endpoint" | "type_definition" | "event_schema" | "database_schema";
  spec: string;
  task_id?: string; // H-12: Optional task_id for accurate contract provenance
}

export async function handleRegisterContract(
  input: RegisterContractInput
): Promise<ContractSpec | { error: string }> {
  // Validate input size limits (#16 - DoS prevention)
  const sizeValidation = RegisterContractInputSchema.safeParse(input);
  if (!sizeValidation.success) {
    return { error: sizeValidation.error.issues.map((e: { message: string }) => e.message).join("; ") };
  }

  // Validate contract_id to prevent path traversal (#14)
  const validation = validateFileName(input.contract_id);
  if (!validation.valid) {
    return { error: `Invalid contract_id: ${validation.reason}` };
  }

  const dir = contractsDir();
  await ensureDir(dir);

  const sessionId = getSessionId();
  const contract: ContractSpec = {
    contract_id: input.contract_id,
    contract_type: input.contract_type,
    spec: input.spec,
    // H-12: Use task_id for owner_task_id when provided; fall back to sessionId for backward compat
    owner_task_id: input.task_id ?? sessionId,
    registered_by: sessionId,
    registered_at: new Date().toISOString(),
  };

  const filePath = path.join(dir, `${input.contract_id}.json`);

  // M-37: Use file locking for concurrency safety when writing contracts
  let release: (() => Promise<void>) | undefined;
  try {
    // Ensure file exists for locking (create empty if needed)
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, "{}", { encoding: "utf-8", mode: 0o600 });
    }
    release = await lock(filePath, { retries: { retries: 3, minTimeout: 100 } });
    await fs.writeFile(filePath, JSON.stringify(contract, null, 2), { encoding: "utf-8", mode: 0o600 });
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock may already be released
      }
    }
  }

  return contract;
}

// ============================================================
// Tool: get_contracts
// ============================================================

export interface GetContractsInput {
  contract_type?: string;
  pattern?: string;
}

export async function handleGetContracts(
  input: GetContractsInput
): Promise<ContractSpec[]> {
  const dir = contractsDir();
  await ensureDir(dir);

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  let contracts: ContractSpec[] = [];

  for (const file of jsonFiles) {
    const contract = await readJsonFile<ContractSpec>(path.join(dir, file));
    if (contract) contracts.push(contract);
  }

  if (input.contract_type) {
    contracts = contracts.filter((c) => c.contract_type === input.contract_type);
  }

  if (input.pattern) {
    const pat = input.pattern;
    contracts = contracts.filter((c) => c.contract_id.includes(pat));
  }

  contracts.sort((a, b) => a.registered_at.localeCompare(b.registered_at));

  return contracts;
}

// ============================================================
// Tool: record_decision
// ============================================================

export interface RecordDecisionInput {
  category: string;
  decision: string;
  rationale: string;
  task_id?: string;
}

export async function handleRecordDecision(
  input: RecordDecisionInput
): Promise<ArchitecturalDecision | { error: string }> {
  // Validate input size limits (#16 - DoS prevention)
  const sizeValidation = RecordDecisionInputSchema.safeParse(input);
  if (!sizeValidation.success) {
    return { error: sizeValidation.error.issues.map((e: { message: string }) => e.message).join("; ") };
  }

  const filePath = decisionsPath();
  await ensureDir(path.dirname(filePath));

  const sessionId = getSessionId();
  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);

  const record: ArchitecturalDecision = {
    id: `dec-${timestamp}-${rand}`,
    task_id: input.task_id ?? "",
    session_id: sessionId,
    // M-26: category is now validated by RecordDecisionInputSchema (z.enum)
    category: sizeValidation.data.category,
    decision: input.decision,
    rationale: input.rationale,
    timestamp: new Date().toISOString(),
  };

  // H8/H9: Use appendJsonlLocked for atomic create-or-open + locking.
  // This avoids the TOCTOU race where concurrent callers both see the file
  // as missing and one truncates the other's data via writeFile("").
  await appendJsonlLocked(filePath, record);

  return record;
}

// ============================================================
// Tool: get_decisions
// ============================================================

export interface GetDecisionsInput {
  category?: string;
}

export async function handleGetDecisions(
  input: GetDecisionsInput
): Promise<ArchitecturalDecision[]> {
  const filePath = decisionsPath();

  let decisions = await readJsonlFile<ArchitecturalDecision>(filePath);

  if (input.category) {
    decisions = decisions.filter((d) => d.category === input.category);
  }

  decisions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return decisions;
}

// ============================================================
// Tool: run_tests
// ============================================================

export interface RunTestsInput {
  test_files?: string[];
  timeout_ms?: number;
}

export interface RunTestsResult {
  passed: boolean;
  output: string;
}

export async function handleRunTests(
  input: RunTestsInput
): Promise<RunTestsResult> {
  const projectDir = getProjectDir();
  const timeout = input.timeout_ms ?? 60_000;

  // Validate test_files if provided (task-014 - security)
  if (input.test_files && input.test_files.length > 0) {
    for (const file of input.test_files) {
      // Check for path traversal
      const validation = validateFileName(file);
      if (!validation.valid) {
        return {
          passed: false,
          output: `Invalid test file path "${file}": ${validation.reason}`,
        };
      }
      // Check for valid test extension
      const hasValidExt = VALID_TEST_EXTENSIONS.some(ext => file.endsWith(ext));
      if (!hasValidExt) {
        return {
          passed: false,
          output: `Invalid test file extension for "${file}". Must end with one of: ${VALID_TEST_EXTENSIONS.join(', ')}`,
        };
      }
    }
  }

  const args: string[] = ["test"];
  if (input.test_files && input.test_files.length > 0) {
    args.push("--");
    args.push(...input.test_files);
  }

  try {
    const { stdout, stderr } = await execFileAsync("npm", args, {
      cwd: projectDir,
      timeout,
      env: { ...process.env },
    });
    const output = (stdout + "\n" + stderr).trim();
    return {
      passed: true,
      output: output.length > 5000 ? output.slice(-5000) : output,
    };
  } catch (err: unknown) {
    // M-31: Use safe property access instead of unsafe type cast
    const execErr = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
    const stdout = typeof execErr.stdout === "string" ? execErr.stdout : "";
    const stderr = typeof execErr.stderr === "string" ? execErr.stderr : "";
    const output = (stdout + "\n" + stderr).trim();
    return {
      passed: false,
      output: output.length > 5000 ? output.slice(-5000) : output,
    };
  }
}

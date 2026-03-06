import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lock, unlock } from "proper-lockfile";
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

const execFileAsync = promisify(execFile);

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
  await fs.mkdir(dir, { recursive: true });
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
 */
async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as T);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

// ============================================================
// Tool: read_updates
// ============================================================

export interface ReadUpdatesInput {
  since?: string;
}

export async function handleReadUpdates(
  input: ReadUpdatesInput
): Promise<Message[]> {
  const dir = messagesDir();
  await ensureDir(dir);

  const sessionId = getSessionId();
  const sinceTs = input.since ? new Date(input.since).getTime() : 0;

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

  return filtered;
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
): Promise<Message> {
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
  await fs.appendFile(filePath, JSON.stringify(message) + "\n", "utf-8");

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
    // rankClaimableTasks filters to pending tasks with completed deps
    // and returns them sorted by priority score descending
    return rankClaimableTasks(tasks);
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

    // Verify task is pending
    if (task.status !== "pending") {
      return {
        success: false,
        error: `Task ${input.task_id} is not pending (current status: ${task.status})`,
      };
    }

    // Verify all dependencies are completed
    if (task.depends_on.length > 0) {
      for (const depId of task.depends_on) {
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

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");

    // Gather dependency context
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
    let contracts: ContractSpec[] = [];
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

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");

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
    await fs.appendFile(
      msgPath,
      JSON.stringify(completionMessage) + "\n",
      "utf-8"
    );

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
}

export async function handleRegisterContract(
  input: RegisterContractInput
): Promise<ContractSpec> {
  const dir = contractsDir();
  await ensureDir(dir);

  const sessionId = getSessionId();
  const contract: ContractSpec = {
    contract_id: input.contract_id,
    contract_type: input.contract_type,
    spec: input.spec,
    owner_task_id: sessionId,
    registered_by: sessionId,
    registered_at: new Date().toISOString(),
  };

  const filePath = path.join(dir, `${input.contract_id}.json`);
  await fs.writeFile(filePath, JSON.stringify(contract, null, 2), "utf-8");

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
): Promise<ArchitecturalDecision> {
  const filePath = decisionsPath();
  await ensureDir(path.dirname(filePath));

  const sessionId = getSessionId();
  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);

  const record: ArchitecturalDecision = {
    id: `dec-${timestamp}-${rand}`,
    task_id: input.task_id ?? "",
    session_id: sessionId,
    category: input.category as ArchitecturalDecision["category"],
    decision: input.decision,
    rationale: input.rationale,
    timestamp: new Date().toISOString(),
  };

  await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");

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
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    const output = ((execErr.stdout ?? "") + "\n" + (execErr.stderr ?? "")).trim();
    return {
      passed: false,
      output: output.length > 5000 ? output.slice(-5000) : output,
    };
  }
}

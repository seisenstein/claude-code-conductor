# Security Audit: Command Injection Vectors

**Audit Date:** 2026-03-08
**Auditor:** worker-1772943462017-0
**Scope:** All Bash/execFile/spawn/execSync usage in C3 codebase

## Executive Summary

**Result: NO CRITICAL VULNERABILITIES FOUND**

The codebase follows secure command execution patterns throughout. All command execution uses `execFileAsync` (promisified `execFile`) or `spawn` which bypass shell interpretation entirely. No user-controlled input is passed unsafely to shell commands.

## Files Audited

1. `src/mcp/tools.ts` - handleRunTests() uses execFileAsync
2. `src/core/usage-monitor.ts` - execSync for macOS Keychain access
3. `src/core/codex-reviewer.ts` - Codex CLI execution
4. `src/utils/semgrep-runner.ts` - semgrep CLI execution
5. `src/core/codex-worker-manager.ts` - spawn() for Codex workers
6. `src/core/worker-manager.ts` - SDK query() (no direct command execution)
7. `src/utils/git.ts` - simple-git library commands

## Detailed Findings

### 1. src/mcp/tools.ts - handleRunTests()

**Location:** Lines 866-897
**Function:** `handleRunTests()`
**Severity:** LOW (Informational)

**Analysis:**
```typescript
const args: string[] = ["test"];
if (input.test_files && input.test_files.length > 0) {
  args.push("--");
  args.push(...input.test_files);
}
const { stdout, stderr } = await execFileAsync("npm", args, {
  cwd: projectDir,
  timeout,
  env: { ...process.env },
});
```

**Security Assessment:**
- Uses `execFileAsync` (NOT `exec` with shell)
- Arguments passed as array (bypasses shell interpretation)
- `test_files` are spread as separate arguments, not concatenated
- No shell expansion vulnerabilities possible
- Uses `"--"` separator to prevent option injection

**Potential Concern:** `test_files` entries come from MCP input and could contain malicious filenames. However:
- `execFileAsync` does not interpret shell metacharacters
- File paths are passed directly to npm
- npm's test runner handles the paths as literal strings

**Recommendation:** None required. Pattern is secure.

---

### 2. src/core/usage-monitor.ts - macOS Keychain Access

**Location:** Lines 397-400
**Function:** `readOAuthToken()` (private method)
**Severity:** LOW (Informational)

**Analysis:**
```typescript
const keychainResult = execSync(
  'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
  { encoding: "utf-8", timeout: 5000 },
).trim();
```

**Security Assessment:**
- Uses `execSync` with a hardcoded command string
- **No user-controlled input** in the command
- Command string is entirely static
- Timeout prevents hanging on unexpected keychain prompts
- stderr redirected to avoid leaking error details

**Recommendation:** None required. Pattern is secure because no external input is interpolated.

---

### 3. src/core/codex-reviewer.ts - Codex CLI Execution

**Location:** Lines 356-424
**Function:** `runCodex()` (private method)
**Severity:** LOW (Informational)

**Analysis:**
```typescript
const args: string[] = [
  "exec",
  "--full-auto",
  "-C", this.projectDir,
  "-c", 'mcp_servers.coordinator.command="node"',
  "-c", `mcp_servers.coordinator.args=[${JSON.stringify(this.mcpServerPath)}]`,
  "-c", `mcp_servers.coordinator.env.CONDUCTOR_DIR=${JSON.stringify(this.orchestratorDir)}`,
  "-c", 'mcp_servers.coordinator.env.SESSION_ID="codex-reviewer"',
  ...
  fullPrompt,
];
const { stdout, stderr } = await execFileAsync("codex", args, {
  timeout: REVIEW_TIMEOUT_MS,
  maxBuffer: 10 * 1024 * 1024,
  cwd: this.projectDir,
});
```

**Security Assessment:**
- Uses `execFileAsync` (no shell interpretation)
- Arguments passed as array
- `JSON.stringify()` used for string escaping in config values
- `fullPrompt` is constructed from hardcoded strings + file contents (read from disk)
- No MCP/external user input directly interpolated into args

**Potential Concern:** `this.projectDir`, `this.orchestratorDir`, `this.mcpServerPath` come from the orchestrator constructor. These are set by the CLI from validated paths, not from arbitrary user input.

**Recommendation:** None required. Pattern is secure.

---

### 4. src/utils/semgrep-runner.ts - Semgrep Execution

**Location:** Lines 68-80
**Function:** `runSemgrep()`
**Severity:** LOW (Informational)

**Analysis:**
```typescript
const args: string[] = ["--json"];
for (const config of configsToUse) {
  args.push(`--config=${config}`);
}
args.push(...files);

const { stdout } = await execFileAsync("semgrep", args, {
  cwd: projectDir,
  maxBuffer: 10 * 1024 * 1024,
  timeout: 120_000,
});
```

**Security Assessment:**
- Uses `execFileAsync` (no shell interpretation)
- `configsToUse` comes from `SEMGREP_DEFAULT_CONFIGS` constant or caller
- `files` array contains file paths from the orchestrator (changed files from git)
- No shell metacharacter expansion possible

**Potential Concern:** File paths in `files` array come from `git diff --name-only` output. These are actual filesystem paths, not user input.

**Recommendation:** None required. Pattern is secure.

---

### 5. src/core/codex-worker-manager.ts - Worker Spawning

**Location:** Lines 259-262
**Function:** `runCodexSession()` (private method)
**Severity:** LOW (Informational)

**Analysis:**
```typescript
const child = spawn("codex", args, {
  cwd: this.projectDir,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Where `args` is built by `buildCodexExecArgs()` (lines 472-509):
```typescript
private buildCodexExecArgs(
  sessionId: string,
  prompt: string,
  sandbox: CodexSandboxMode,
  outputPath: string,
): string[] {
  return [
    "exec",
    "--json",
    "--full-auto",
    "--sandbox", sandbox,
    ...
    "-c", `mcp_servers.coordinator.env.CONDUCTOR_DIR=${JSON.stringify(this.orchestratorDir)}`,
    "-c", `mcp_servers.coordinator.env.SESSION_ID=${JSON.stringify(sessionId)}`,
    ...
    prompt,
  ];
}
```

**Security Assessment:**
- Uses `spawn` with argument array (no shell)
- `JSON.stringify()` used for string escaping
- `sessionId` is generated internally (e.g., `worker-${Date.now()}-0`)
- `prompt` comes from `getWorkerPrompt()` which builds from static templates + orchestrator context
- `sandbox` is a string literal type (`"workspace-write"` or `"read-only"`)

**Recommendation:** None required. Pattern is secure.

---

### 6. src/utils/git.ts - simple-git Library

**Location:** Entire file
**Function:** GitManager class
**Severity:** LOW (Informational)

**Analysis:**
The file uses the `simple-git` library which internally uses `child_process` with safe argument handling.

```typescript
await this.git.checkoutLocalBranch(name);
await this.git.commit(`${GIT_CHECKPOINT_PREFIX}${tag}`);
await this.git.diff([`${base}...HEAD`]);
```

**Security Assessment:**
- `simple-git` library handles argument escaping internally
- All methods receive strings that are passed as arguments, not shell commands
- Library uses `execFile`-style execution (no shell interpretation)
- `name`, `tag`, `base` parameters come from orchestrator internals, not external user input

**Recommendation:** None required. Library provides safe command execution.

---

### 7. src/core/worker-manager.ts - Agent SDK

**Location:** Lines 383-401
**Function:** `runWorker()` (private method)
**Severity:** LOW (Informational)

**Analysis:**
```typescript
const asyncIterable = query({
  prompt: workerPrompt,
  options: {
    allowedTools: WORKER_ALLOWED_TOOLS,
    mcpServers: {
      coordinator: {
        command: "node",
        args: [this.mcpServerPath],
        env: {
          CONDUCTOR_DIR: this.orchestratorDir,
          SESSION_ID: sessionId,
        },
      },
    },
    cwd: this.projectDir,
    maxTurns: DEFAULT_WORKER_MAX_TURNS,
  },
});
```

**Security Assessment:**
- This is SDK query, not direct shell execution
- MCP server is started by the SDK with the provided config
- `mcpServerPath` is validated during orchestrator setup
- The SDK handles process spawning internally with safe patterns

**Recommendation:** None required. SDK handles execution safely.

---

### 8. Worker Prompt Bash Tool Access

**Location:** `src/worker-prompt.ts` + `src/utils/constants.ts`
**Severity:** LOW (Informational)

**Analysis:**
Workers are granted access to the `Bash` tool via `WORKER_ALLOWED_TOOLS`:
```typescript
export const WORKER_ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task",
  ...
];
```

The worker prompt includes security guidance:
- "Output Encoding: All data written to HTML, SQL, or shell contexts must be escaped or parameterized."
- Workers are instructed to follow safe patterns

**Security Assessment:**
- Workers CAN execute arbitrary bash commands
- This is by design - workers need to run tests, git commands, etc.
- Workers are Claude Code sessions with their own safety mechanisms
- The Bash tool in Claude Code has its own sandboxing and restrictions
- This is NOT command injection in C3 code - it's intentional worker capability

**Trust Model:** Workers are trusted execution environments spawned by the orchestrator. The security boundary is at the Claude Code session level, not at the C3 orchestrator level.

**Recommendation:** None required. This is intentional design, not a vulnerability.

---

## Summary Table

| File | Function | Method | User Input | Shell? | Verdict |
|------|----------|--------|------------|--------|---------|
| tools.ts | handleRunTests() | execFileAsync | test_files array | No | SECURE |
| usage-monitor.ts | readOAuthToken() | execSync | None (hardcoded) | Yes* | SECURE |
| codex-reviewer.ts | runCodex() | execFileAsync | None (internal) | No | SECURE |
| semgrep-runner.ts | runSemgrep() | execFileAsync | files array | No | SECURE |
| codex-worker-manager.ts | runCodexSession() | spawn | sessionId (internal) | No | SECURE |
| git.ts | Various | simple-git lib | Branch names (internal) | No | SECURE |
| worker-manager.ts | runWorker() | SDK query() | N/A | N/A | SECURE |

\* The execSync in usage-monitor.ts uses shell interpretation BUT with a fully hardcoded command string with no variable interpolation.

## Existing Protections Verified

1. **execFileAsync pattern**: All command execution (except one hardcoded case) uses `execFileAsync` which does NOT invoke a shell and treats arguments literally.

2. **Argument arrays**: Commands pass arguments as arrays, not concatenated strings, preventing shell metacharacter injection.

3. **JSON.stringify escaping**: Configuration values interpolated into Codex args use `JSON.stringify()` for proper escaping.

4. **Path validation**: File paths used in commands come from orchestrator internals (git diff output, validated project paths), not arbitrary user input.

5. **MCP input validation**: The `handleRunTests()` function receives `test_files` via MCP but these are passed as literal arguments to npm, not shell-interpreted.

6. **simple-git library**: Git operations use a well-maintained library that handles escaping internally.

## Conclusion

**NO CRITICAL OR HIGH SEVERITY COMMAND INJECTION VULNERABILITIES FOUND**

The C3 codebase follows secure command execution patterns:
- Consistently uses `execFileAsync`/`spawn` with argument arrays (no shell interpretation)
- The single `execSync` usage has a fully hardcoded command with no variable interpolation
- User/MCP input is never directly interpolated into shell commands
- Libraries (simple-git) provide additional safety layers

The design correctly separates:
- C3 orchestrator code (uses safe patterns)
- Worker sessions (Claude Code sessions with their own safety mechanisms)

No fixes are required.

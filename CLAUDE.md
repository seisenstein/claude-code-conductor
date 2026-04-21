# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (src/ -> dist/)
npm run dev          # Watch mode compilation
npm test             # Run tests (vitest, no project tests yet)
npm link             # Install `conduct` CLI globally
npm run setup        # Install /conduct slash command to ~/.claude/commands/
conduct init         # Detect project stack, generate flow config, scaffold rules, analyze design system
```

No linter is configured. The project uses TypeScript strict mode (ES2022 target, Node16 modules).

## LSP Integration

This project has the `typescript-lsp` plugin enabled (see `.claude/settings.json`). **Use LSP tools proactively** when working with this codebase:

- **`goToDefinition`** — Jump to where a type, function, or variable is defined. Use this instead of grepping for definitions.
- **`findReferences`** — Find all usages of a symbol across the codebase. Use this before renaming or refactoring to understand impact.
- **`hover`** — Get type information and documentation for a symbol. Use this to understand types without reading entire files.
- **`documentSymbol`** — List all symbols in a file (classes, methods, properties). Use this to understand file structure before diving in.
- **`goToImplementation`** — Find concrete implementations of interfaces or abstract methods.
- **`incomingCalls` / `outgoingCalls`** — Trace call hierarchies. Use this to understand how functions connect.

**When to prefer LSP over Grep/Glob:**
- Finding where a type or function is defined → `goToDefinition` (not Grep)
- Finding all usages of a symbol → `findReferences` (not Grep)
- Understanding a symbol's type signature → `hover` (not reading the source file)
- Navigating class/interface hierarchies → `goToImplementation`
- Understanding call chains → `incomingCalls`/`outgoingCalls`

**Prerequisite:** `typescript-language-server` must be installed globally (`npm install -g typescript-language-server typescript`).

## What This Project Does

Claude Code Conductor (C3) is a hierarchical multi-agent orchestration system that decomposes large features into parallel tasks and coordinates headless Claude Code worker sessions. It runs in cycles of: **init check -> plan -> conventions extraction -> execute (parallel workers + security sentinel) -> code review + flow-trace + design-spec-update (parallel) -> checkpoint**.

Workers are full Claude Code sessions spawned via the Agent SDK. They coordinate through a custom MCP server with shared contracts, architectural decisions, and dependency context. All run state persists to `.conductor/` in the target project directory.

The system is designed to produce secure, performant code on the first pass through a security-first pipeline: STRIDE threat modeling during planning, a security constitution in every worker prompt, a real-time security sentinel during execution, semgrep static analysis, and checkpoint gating that forces additional cycles when critical issues are found.

## Architecture

### Conductor Loop (`src/core/orchestrator.ts`)
The central class that drives the lifecycle through phases: init check -> plan -> conventions extraction -> execute -> review + flow-trace + design-spec-update (parallel) -> checkpoint. Decides whether to start another cycle or escalate to the user. Gates checkpoints on review and flow-tracing results -- if critical/high findings exist, auto-generates fix tasks and forces another cycle. Tracks known issues across cycles and feeds them back into replanning.

### Planning System
- **Planner** (`src/core/planner.ts`) -- Decomposes features into typed tasks with dependencies, security requirements, performance requirements, and acceptance criteria. Generates STRIDE threat models before task decomposition. Identifies anchor tasks (shared foundations that must execute first). Asks security-focused clarifying questions (auth, authorization, data sensitivity, rate limiting, audit logging).
- **Task types**: `backend_api`, `frontend_ui`, `database`, `security`, `testing`, `infrastructure`, `reverse_engineering`, `integration`, `general`. Each type gets specific worker guidance.
- **CodexReviewer** (`src/core/codex-reviewer.ts`) -- Calls external `codex` CLI for plan discussion (up to 5 rounds) and code review (up to 5 rounds).

### Worker System
- **WorkerManager** (`src/core/worker-manager.ts`) -- Spawns headless Claude Code sessions via `@anthropic-ai/claude-agent-sdk`. Injects shared context (Q&A, conventions, rules, threat model) into every worker prompt via `setWorkerContext()`. Also spawns a security sentinel worker.
- **Worker Prompt** (`src/worker-prompt.ts`) -- Builds comprehensive worker prompts with: security constitution (input validation, auth, authorization, output encoding, secrets), performance rules, definition of done checklist, project conventions, project-specific rules, design system spec (for frontend_ui workers), threat model context, and task-type-specific guidelines. Accepts a `WorkerPromptContext` object.
- **Security Sentinel** -- A read-only worker that runs alongside execution workers, monitoring completed tasks in real-time and broadcasting security findings via MCP.
- **MCP Coordination Server** (`src/mcp/coordination-server.ts` + `src/mcp/tools.ts`) -- Workers coordinate through 11 MCP tools:
  - Task management: `get_tasks`, `claim_task`, `complete_task`
  - Messaging: `read_updates`, `post_update`, `get_session_status`
  - Cross-worker coordination: `register_contract`, `get_contracts`, `record_decision`, `get_decisions`
  - Testing: `run_tests`
  - `claim_task` returns rich context: dependency summaries, in-progress sibling tasks, all registered contracts and decisions.

### Flow Tracing & Performance
- **Flow Tracer** (`src/core/flow-tracer.ts`) -- Spawns read-only workers to trace user flows through code changes across all configured layers. Loads project-specific flow config from `.conductor/flow-config.json`. Runs in parallel with code review.
- **Flow Worker Prompt** (`src/flow-worker-prompt.ts`) -- Generates prompts from configurable layers, actor types, and edge cases.
- **Performance Worker Prompt** (`src/performance-worker-prompt.ts`) -- Traces flows for performance anti-patterns: N+1 queries, missing pagination, missing indexes, synchronous blocking, large payloads, missing caching, unbounded in-memory operations.

### Security & Quality Infrastructure
- **Conventions Extractor** (`src/utils/conventions-extractor.ts`) -- Spawns a read-only agent to analyze the project's codebase and extract patterns (auth, validation, error handling, tests, directory structure, naming, libraries, security invariants). Cached for 1 hour.
- **Rules Loader** (`src/utils/rules-loader.ts`) -- Loads `.conductor/rules.md` or `.conductor/worker-rules.md` for project-specific rules injected into worker prompts.
- **Semgrep Runner** (`src/utils/semgrep-runner.ts`) -- Runs semgrep static analysis on changed files. Supports configurable rule configs (defaults: `p/typescript`, `p/owasp-top-ten`, `p/cwe-top-25`). Gracefully degrades if semgrep is not installed.
- **Known Issues** (`src/utils/known-issues.ts`) -- Persistent issue registry across cycles. Deduplicates findings, tracks which cycle found/addressed each issue, and feeds unresolved issues back into replanning.

### State & Infrastructure
- **StateManager** (`src/core/state-manager.ts`) -- Persists `OrchestratorState` to `.conductor/state.json`. All tasks, sessions, messages, contracts, decisions, and reviews also persist under `.conductor/`.
- **UsageMonitor** (`src/core/usage-monitor.ts`) -- Polls Anthropic OAuth API to track 5-hour usage window. Auto-pauses at 80% utilization, resumes at 50%.
- **Flow Config** (`src/utils/flow-config.ts`) -- Loads per-project flow-tracing configuration from `.conductor/flow-config.json` with generic defaults.
- **Types** (`src/utils/types.ts`) -- All shared TypeScript types including `OrchestratorState`, `Task`, `TaskDefinition` (with `task_type`, `security_requirements`, `performance_requirements`, `acceptance_criteria`), `ThreatModel`, `ContractSpec`, `ArchitecturalDecision`, `ProjectConventions`, `KnownIssue`, `FlowConfig`, `SemgrepFinding`, `CompletionVerification`, `DesignSpec`, `ComponentInfo`, `VariantExample`, `SharedPrimitive`, `InitResult`, etc.
- **Constants** (`src/utils/constants.ts`) -- Configuration defaults, file paths, tool allowlists, thresholds, semgrep configs, sentinel/extraction settings, design spec analyzer settings.

### Entry Points
- **CLI** (`src/cli.ts`) -- Commands: `init`, `start`, `status`, `resume`, `pause`, `log`. Uses Commander.js. CLI binary is `conduct`.
- **Slash Command** (`commands/conduct.md`) -- Interactive guide for invoking from within Claude Code. Installed to `~/.claude/commands/` by `src/setup.ts`.

### Init System
- **Init Command** (`src/core/init.ts`) -- Orchestrates project initialization: detects stack via project-detector, generates framework-specific flow config, scaffolds worker rules template, and analyzes frontend design system. Writes to `.conductor/` with existing-file-safe pattern (existing configs → `recommended-configs/` instead of overwriting).
- **Design Spec Analyzer** (`src/utils/design-spec-analyzer.ts`) -- Spawns a read-only agent to analyze frontend component trees: shared primitives, variant systems (cva, styled-components, etc.), theming approach, naming conventions. Results cached to `.conductor/design-spec.json` for 1 hour.
- **Design Spec Updater** (`src/utils/design-spec-updater.ts`) -- Lightweight post-cycle agent that checks changed frontend files against the current design spec. Patches the spec with new/modified/removed components. Warns if shared component base styles were modified. Runs in parallel with code review and flow tracing.
- **Flow Config Generator** (`src/utils/flow-config-generator.ts`) -- Template-based flow config generation for 7 framework types: Next.js, React SPA, Vue, Svelte, Angular, Node API, Python API. Falls back to generic DEFAULT_FLOW_CONFIG.

## Key Design Decisions

- **Security-first pipeline**: Threat modeling during planning, security constitution in worker prompts, real-time sentinel during execution, semgrep + flow tracing during review, checkpoint gating on results. Every phase has a security angle.
- **Git branch isolation**: All changes go to `conduct/<feature-slug>` branches.
- **Worker tool allowlists**: Workers get `WORKER_ALLOWED_TOOLS` (constants.ts) including the 6 new coordination tools. Flow-tracing and sentinel workers are restricted to read-only tools.
- **Rich task definitions**: Tasks carry `task_type`, `security_requirements`, `performance_requirements`, `acceptance_criteria`, `risk_level`, and `review_feedback`. The planner generates all of these.
- **Cross-worker coordination**: Contracts (API schemas, type defs) and architectural decisions are shared through MCP tools. `claim_task` returns dependency context so workers know what predecessors produced.
- **Parallel review + flow tracing + design spec update**: Code review, flow tracing, and design spec update run via `Promise.allSettled()` (v0.7.3 H-4). If flow-tracing rejects, a synthetic `FlowTracingReport` (marked with `actor: "conductor"`, `file_path: "<flow-tracing-infrastructure>"`) is injected to force another cycle; `createFixTasksFromFindings` skips synthetic findings via `isSyntheticFlowInfraFinding`. After 2 consecutive flow-tracing rejections (`consecutive_flow_tracing_failures` counter on `OrchestratorState`), the orchestrator escalates to the user.
- **Checkpoint gating**: If flow tracing finds critical/high issues or code review fails, the checkpoint auto-generates fix tasks and forces another cycle. The system does not ship known-bad code.
- **Known issues registry**: Findings from any source (Codex, flow tracing, semgrep, sentinel) persist across cycles and feed back into replanning.
- **Escalation model**: After `MAX_DISAGREEMENT_ROUNDS` (2) or `DEFAULT_MAX_CYCLES` (5), the conductor writes `escalation.json` and pauses for human guidance.
- **Default concurrency is 2** parallel workers (`DEFAULT_CONCURRENCY`), plus the security sentinel.
- **Design spec integration**: Frontend design system analysis from `conduct init` is injected into `frontend_ui` worker prompts. Workers see shared primitives, variant patterns, and theming — preventing them from modifying shared component base styles. Post-cycle updater keeps the spec fresh.
- **Existing-file-safe init**: `conduct init` never overwrites existing config files. If a file already exists, the new version goes to `.conductor/recommended-configs/` for manual comparison.
- **Configurable per-project**: `.conductor/rules.md` for worker rules, `.conductor/flow-config.json` for flow-tracing layers/actors/edge-cases, `.conductor/design-spec.json` for frontend design system context.

## Patterns added v0.7.2 – v0.7.7

Security and reliability patterns introduced across recent patch cycles. Use these when touching the affected code paths.

### Codex review convergence (v0.7.7)

- **`src/core/codex-review-gating.ts`** — single source of truth for every layer that decides whether a review issue is "blocking". Exports `CATEGORY_TO_SEVERITY` (free-text taxonomy label → severity bucket; `PRAISE → minor` is defensive), `inferSeverityFromCategory` (parser fallback), `hasBlockingIssues` (treats `[critical]` / `[major]` / `[unknown]` as blocking), `hasOnlyMinorIssues` (requires non-empty + all `[minor]`), and `normalizeIssueKey` (strips severity + category prefix, collapses whitespace, truncates to 80 chars for recurrence tracking). Imported by the prompt builder, the parser, and the orchestrator so the three layers can never drift.
- **`src/core/codex-review-prompts.ts`** — pure-function prompt composition ported from `/Users/cameron/Documents/ClaudeCodexDiscussion`. Exports `buildAdversarialStance`, `buildFeedbackFraming`, `buildRoundBudget` (three modes: normal / `FINAL PLANNED ROUND` at `current === softCap` / `OVERTIME` past `softCap`), `buildSeverityTaxonomy` (mapping table sourced from `CATEGORY_TO_SEVERITY`), `buildCoordinatorMcpParagraph` (full, for code reviews), `buildCoordinatorMcpParagraphReplan` (trimmed — contracts + decisions only — for cycle-2+ plan reviews). Each of the four reviewer methods composes these into its prompt.
- **`CodexReviewer.reviewPlan` / `reReviewPlan`** take `round?: RoundBudget` + `context?: { hasPriorContext?: boolean }`. Cycle-1 plan prompts omit the coordinator MCP paragraph (nothing to query); cycle-2+ (replan) plan prompts include the trimmed paragraph; code prompts always include the full paragraph. Gate on `isReplan` at orchestrator call sites, NOT `planVersion > 1`.
- **`CodexReviewer.reviewCode` / `reReviewCode`** take `round?: RoundBudget`.
- **`parseStructuredResponse` consistency guards** (v0.7.7): (a) on malformed `severity`, fall back to `inferSeverityFromCategory(description)` before "unknown"; (b) `verdict:"APPROVE"` + `hasBlockingIssues(issues)` → downgrade verdict to `NEEDS_DISCUSSION` (trust the issues, not the author's verdict); (c) non-APPROVE + `issues.length === 0` → return `{valid:false}` so `withRetryOnInvalidResponse` retries (nothing actionable to respond to).
- **Orchestrator gating** uses the shared predicates consistently: while-loop continuation checks `hasBlockingIssues`; escalation counting filters by `hasBlockingIssues` and keys by `normalizeIssueKey` so severity / category prefix drift across rounds can't evade recurrence tracking; `lastPlanApproved` and code-review `approved` include `hasOnlyMinorIssues` so minor-only outcomes propagate as approval (no cycle-burn at `orchestrator.ts:587`).
- **softCap math**: `softCap = MAX_*_ROUNDS + 1` to include the initial review alongside up to 5 re-review rounds. `RoundBudget.current` threads the **discussion-round number**, not the literal invocation count — `withRetryOnInvalidResponse` can silently double invocations but Codex doesn't need to see retries.
- **Convergence rule surfaced to Codex in every prompt**: "If every finding is `minor`, verdict MUST be `APPROVE`." The orchestrator short-circuits anyway if Codex non-complies.

### Run archival (v0.7.6)

- **`src/core/archiver.ts`** — source of truth for run archival. Exports `archiveCurrentRun`, `listArchives`, `readArchive`, `pruneArchives`, `detectStaleTerminalState`, `finalizePartialArchive`, `deriveSlug`. All archive paths go through here.
- **`.conductor/archive/<slug>-[FAILED-]<YYYYMMDD-HHMMSS>/`** is the on-disk layout. Each archive dir contains a moved snapshot of the run's artifacts + `_archive-meta.json` (shape in `ArchiveMeta` type). Legacy manual archives without the meta file are surfaced as `final_status: "unknown"`, `archive_version: 0`.
- **Archival runs in `orchestrator.run().finally`** after `await this.eventLog.stop()` and `await this.logger.close()` — both writers must be fully flushed before file moves. `complete()` and the `catch(err)` block only SET `this.terminalArchivalReason`; the finally block does the actual archival.
- **`Logger.close()` is now `Promise<void>`** — it resolves on the WriteStream's `end` callback so archival has a real flush barrier. Callers that don't need the barrier (process-exit handler) can still fire-and-forget.
- **`readState()` in `src/cli.ts` distinguishes ENOENT from other fs errors** via a new `"unreadable"` branch, so the `conduct start` Hook 1 guard doesn't mistake a permission error for "no state".
- **`conduct start` Hook 1**: post-lock state classification — only `missing | ok+completed | ok+failed` proceed; `paused/escalated/executing/planning/...` → exit 2 with recovery guidance; `invalid/unreadable` → exit 1. See `src/cli.ts`.
- **`conduct start` Hook 2**: fail-closed stale-terminal auto-archive. If archival throws, the CLI refuses to start (preserves prior artifacts for manual recovery).
- **`conduct archive [list|inspect|prune]`** CLI subcommand group. Lock files (`conductor.lock`, `conductor.lock.info`) are NEVER archived or deleted — the CLI holds them during archival and `releaseLock()` handles cleanup.

### Filesystem writes

- **`writeJsonAtomic(destPath, content, options?)`** from `src/utils/secure-fs.ts` — tmp + fsync + atomic rename + chmod to 0o600, with automatic tmp cleanup on failure. Content-agnostic (the name is historical; works for JSON, Markdown, or any string). Use for any persistence write where a crash mid-save must not corrupt the target. Currently used at 11+ sites (all task/contract/decision/review/event-log writes). v0.7.4 A-1 / v0.7.5 A-R1 + A-R2 + A-R2-prereq.
- **`mkdirSecure(dir, { recursive })`** from `src/utils/secure-fs.ts` — mkdir with post-mkdir chmod to 0o700 to defeat umask (v0.7.2 H-2). Always pair with `writeJsonAtomic` or `writeFileSecure` for full directory+file security.

### Identifier validation

- **`validateFileName(id)`** — permits relative paths (forward slash allowed). Use for `files_changed` and similar path-shaped values.
- **`validateIdentifier(id)`** from `src/utils/validation.ts` (v0.7.4 A-4) — stricter: rejects forward slash, backslash, colon, AND their URL-encoded forms (%2F, %5C, %3A). Use for any value that becomes a filesystem path segment: `task_id`, `session_id`, `contract_id`, dep task IDs. The pre-existing assumption that `contract_id` supported endpoint-style values like `"POST /api/users"` was broken in code (would ENOENT); v0.7.4 corrected both the code and the tool schema description.

### Prompt sanitization

- **`sanitizePromptSection(content, maxLength?)`** from `src/utils/sanitize.ts` — strips role markers (`Human:`, `Assistant:`), length-caps, neutralizes injection patterns. Apply to any user-ish text before interpolating into a worker prompt.
- Used in `worker-manager.buildWorkerPrompt` (v0.7.4 A-6, Claude side) and `CodexWorkerManager.buildCorrectiveRetryText` (v0.7.5 N-1, Codex side — covers 3 retry paths including the previously-gapped Path C concurrency fallback).

### Logging / observability

- **`redactSecrets(text)`** from `src/utils/logger.ts` (v0.7.2 H-1) — pattern-matches and redacts API keys, bearer tokens, JWT-shaped secrets. The logger applies this on disk writes automatically.
- **Event log also redacts** (v0.7.4 A-3) — `event-log.ts` runs `redactSecrets()` on each event's `error` field on both append and rotation paths. Worker failure messages containing stderr/stack-traces can carry credentials; this closes that leak.
- **Event log rotation is now atomic and non-destructive** (v0.7.4 A-2 folded into A-1): rotation uses `writeJsonAtomic`; a failed rotation propagates the error instead of truncating the log to empty.

### State persistence

- **`state.json.bak` recovery** (v0.7.3 H-5) — every successful save writes a `.bak` sibling. On load failure, falls back to `.bak` and renames the corrupt primary to `state.json.corrupt-<ts>` for forensics.
- **fsync before rename** (v0.7.3 H-6) — `StateManager.save()` fsyncs the tmp file AND the parent directory before the atomic rename, for power-loss durability.
- **`resume()` uses transient "initializing" status** (v0.7.3 H-13) — prevents a crash-after-resume from falsely claiming execution was in progress.
- **State-schema backfill via `.default(0)`** — three counter fields use this pattern so pre-upgrade state.json files load cleanly:
  - `codex_metrics.output_too_large_failures` (v0.7.2)
  - `codex_metrics.execution_errors` (v0.7.3)
  - `consecutive_flow_tracing_failures` on `OrchestratorState` (v0.7.4 A-7)

### MCP tools

- **`record_decision` uses `z.enum(VALID_DECISION_CATEGORIES)`** at the schema layer (v0.7.3 H-18) to match the handler's validator.
- **`read_updates` has an opt-in `limit`** and an invisible **mtime pre-filter** (v0.7.3 H-19). The TOCTOU residual is documented in code at `handleReadUpdates`; on coarse-mtime filesystems, callers should advance `since` by the max-returned-timestamp each call.

### Codex reviewer

- **Rate-limit detection via `detectProviderRateLimit()`** (v0.7.3 H-16) — second-attempt errors are classified as RATE_LIMITED only if the message matches a provider rate-limit pattern; otherwise they're classified as ERROR and counted under `execution_errors`.
- **Model threading** (v0.7.2 CR-3) — `CodexReviewer` accepts a `ModelConfig` and passes the resolved model to every `codex exec` invocation.

### Worker tool restriction

- **`disallowedTools: READ_ONLY_DISALLOWED_TOOLS`** is the SDK-enforced restriction for read-only workers (v0.7.2 CR-1). Applied at 9+ call sites: sentinel, flow-tracing extraction + per-flow trace, planner question-gen, prompt-compactor, rules-extractor, conventions-extractor, design-spec-analyzer, design-spec-updater, flow-config-analyzer. Execution workers still use `allowedTools`; full SDK-enforced restriction for execution workers is tracked as H-3 for v0.8.0.

### New test files added post-v0.7.2

- `src/utils/sanitize.test.ts` (v0.7.2)
- `src/utils/secure-fs.test.ts` (v0.7.2, extended v0.7.4 for writeJsonAtomic + v0.7.5 for tmp cleanup)
- `src/utils/logger.test.ts` (v0.7.2, includes redactSecrets patterns)
- `src/utils/sdk-timeout.test.ts` (v0.7.3 CR-4)
- `src/utils/state-schema.test.ts` (v0.7.3 CR-4)
- `src/utils/rules-extractor-verify.test.ts` (v0.7.4 T-3)
- `src/core/orchestrator-parallel-review.test.ts` (v0.7.4 T-1)

### Specs

Patch-level specs and implementation plans live at `.claude/specs/*.md`:
- `v0.7.2-critical-fixes.md`
- `v0.7.3-high-fixes.md`
- `v0.7.4-remaining-highs.md` (+ `v0.7.4-implementation-plan.md`)
- `v0.7.5-follow-ups.md`

Each is the authoritative record of what that patch shipped and which Codex review rounds shaped the design.

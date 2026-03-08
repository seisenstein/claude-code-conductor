# Conductor Self-Improvement Mission v2

You are working on Claude Code Conductor (C3) — a hierarchical multi-agent orchestration system. The codebase has already had one round of improvements (v0.1.6) that added: specialized worker personas per task type, phase timing metrics, blast radius detection, atomic state writes, and dependency graph validation. This session focuses on the next layer of high-impact improvements.

## Your Mission

Deeply explore this codebase (read every file in `src/`), understand the current state including recent changes, then design and implement the next round of improvements. Use the conductor itself (`/conduct`) to plan, execute, and review these improvements where feasible.

## Phase 1: Deep Exploration (do this FIRST)

Read and understand the full system. Pay special attention to:

- `src/worker-personas.ts` (new) — the persona system and how it integrates with `worker-prompt.ts`
- `src/core/orchestrator.ts` — the main loop, especially the phase timing, blast radius, and dependency validation code
- `src/core/state-manager.ts` — the atomic write pattern
- `src/mcp/tools.ts` — the MCP tool implementations (concurrency gaps, missing features)
- `src/core/worker-manager.ts` — worker spawning, event handling, rate limit detection
- `src/core/flow-tracer.ts` — how flows are extracted and traced
- `src/utils/types.ts` — all type definitions including new PhaseDurations, BlastRadius

## Phase 2: Improvement Design

After exploring, consider ALL of these improvement areas. Pick the highest-impact subset that you can implement well. Quality over quantity.

### 1. Worker Resilience & Lifecycle

The worker manager has no timeout on individual workers and no retry mechanism for failed tasks. This is a real problem in production:

- **Worker timeout**: Add a configurable per-worker timeout (e.g., 30 minutes). If a worker exceeds it, kill it and reset its task to pending.
- **Task retry with context**: When a task fails, don't just leave it failed. Retry it (up to N times) with the error context injected so the next worker knows what went wrong.
- **Worker heartbeat**: Workers should periodically signal they're alive via `post_update`. The orchestrator should detect stalled workers (no heartbeat for X minutes) and reclaim their tasks.
- **Graceful degradation on worker crash**: If a worker crashes mid-task, ensure its partial work (committed files) is preserved and the next worker can pick up from where it left off.

### 2. MCP Coordination Hardening

The MCP tools have real concurrency and data integrity gaps:

- **Contract versioning**: `register_contract` silently overwrites. Add a `version` field and keep history. Workers should be warned when a contract they depend on has changed.
- **Locking for contracts and decisions**: `handleClaimTask` uses `proper-lockfile` but `register_contract` and `record_decision` don't. Two workers writing simultaneously can corrupt data.
- **Shared learnings tool**: Add a new MCP tool `share_learning` that lets workers post "I tried X and it didn't work because Y" so other workers can avoid repeating mistakes. This is different from `post_update` — learnings are queryable and persist across the session.
- **Contract validation at claim time**: When `claim_task` returns contracts, include a check: does this task's description reference any contracts that don't exist yet? Warn the worker.
- **Message routing improvements**: Add a `topic` field to messages so workers can subscribe to relevant topics instead of reading everything.

### 3. Smart Task Scheduling

Tasks are currently claimed FIFO. Smarter scheduling could dramatically improve throughput:

- **Critical path prioritization**: Tasks that block the most other tasks should be claimed first. Compute the critical path from the dependency graph and expose it via `get_tasks`.
- **Risk-based ordering**: High-risk tasks (security type, high risk_level) should run earlier in the cycle so issues are caught sooner.
- **Task affinity**: If a worker completed task A and task B depends on A, prefer assigning B to the same worker (it already has context).
- **Estimated complexity weighting**: Don't assign two "large" tasks to the same worker if smaller tasks are available for other workers.

### 4. Incremental Review During Execution

Currently, code review only happens AFTER all workers finish. This is wasteful — issues found late are expensive to fix:

- **Per-task review**: After each task completes, run a lightweight review (semgrep on changed files + a quick Claude check) before the worker moves to its next task.
- **Early termination on critical findings**: If a task introduces a critical security issue, pause execution immediately rather than letting other workers build on top of it.
- **Review findings fed back to active workers**: If a review finds an issue in task A's output, and task B depends on A, notify B's worker via MCP message.

### 5. Project Auto-Detection & Adaptation

The conductor currently uses generic defaults. It could be much smarter about adapting to the project:

- **Framework detection**: Auto-detect the project framework (Next.js, Express, FastAPI, Django, Rails, etc.) from package.json/requirements.txt/Gemfile and inject framework-specific guidance into worker prompts.
- **Test framework detection**: Detect vitest/jest/mocha/pytest/etc. and tell workers the correct test commands.
- **Linter/formatter detection**: Detect ESLint, Prettier, Black, etc. and tell workers to run them before committing.
- **CI pipeline awareness**: Read `.github/workflows/` or `.gitlab-ci.yml` and tell workers what CI checks will run, so they can pre-validate locally.
- **Auto-generate rules**: If the project has a `CLAUDE.md` or `CONTRIBUTING.md`, extract relevant rules into `.conductor/rules.md` automatically.

### 6. Security Pipeline Expansion

The current security pipeline is semgrep + sentinel + STRIDE threat model. It could be stronger:

- **Dependency audit gate**: Run `npm audit` (or `pip audit`, `bundle audit`) and gate on critical/high findings. New dependencies should trigger extra scrutiny.
- **Secret scanning**: Integrate trufflehog or gitleaks to scan for accidentally committed secrets before checkpoint.
- **Security-focused test generation**: After the security sentinel runs, have it generate concrete test cases for the vulnerabilities it identifies, then feed those to a testing worker.
- **SBOM generation**: Generate a Software Bill of Materials after each cycle for compliance tracking.

### 7. Enhanced Flow Tracing

Flow tracing is powerful but has gaps:

- **Flow caching across cycles**: If the same files are touched in consecutive cycles, don't re-extract flows from scratch. Cache the flow specs and only re-trace.
- **Performance flow tracing**: The `performance-worker-prompt.ts` exists but isn't wired into the main flow. Integrate it so performance anti-patterns (N+1 queries, missing pagination, etc.) are caught alongside correctness issues.
- **Flow priority**: If there are many flows, prioritize by: flows that touch security-sensitive code > flows that cross trust boundaries > other flows.
- **Targeted tracing**: Instead of tracing all flows every cycle, only re-trace flows whose entry points or critical files were modified in this cycle.

### 8. Observability & Debugging

Operating the conductor is currently a black box during execution:

- **Structured event log**: Replace the current text log with a structured JSONL event log that records every phase transition, worker spawn/complete/fail, task claim/complete, and review verdict with timestamps.
- **Live progress in status command**: `conduct status` currently reads static state.json. Add a `--watch` mode that polls and displays real-time progress.
- **Worker output capture**: Save each worker's full output (tool calls, reasoning) to `.conductor/sessions/<id>/transcript.md` for post-mortem debugging.
- **Phase bottleneck analysis**: After a run completes, analyze phase_durations across cycles and suggest optimizations (e.g., "planning took 40% of total time — consider using --context-file to skip Q&A").
- **Cost estimation**: Track approximate token usage per worker/phase and report estimated costs.

### 9. Testing the Conductor

The conductor has almost no tests (only 10 tests for provider-limit and codex-usage utilities). Critical logic is untested:

- **Unit tests for worker-personas.ts**: Test that every TaskType maps to a persona and that formatPersonaPrompt produces valid markdown.
- **Unit tests for dependency graph validation**: Test cycle detection, dangling references, and valid graphs.
- **Unit tests for blast radius detection**: Test critical file pattern matching and warning generation.
- **Unit tests for MCP tools**: Test claim_task locking, contract registration, decision recording.
- **Integration test for state-manager**: Test atomic writes (simulate crash during save, verify state.json is not corrupted).
- **Snapshot tests for worker prompts**: Capture and snapshot the full prompt for each task type to catch unintended regressions.

### 10. Conductor Self-Awareness

Meta-improvements that make the conductor better at running itself:

- **Run history**: Save a summary of each conductor run (feature, cycles, tasks, duration, findings) to `.conductor/history.json`. Future runs can reference past patterns.
- **Adaptive concurrency**: If workers keep hitting rate limits, automatically reduce concurrency for the next cycle. If utilization is low, increase it.
- **Checkpoint rollback**: If a cycle produces worse code than the previous checkpoint (more test failures, more semgrep findings), offer to rollback to the previous checkpoint.
- **Smart resume**: When resuming, analyze what was in-progress and what already completed to give the user a clear summary of where things stand and what will happen next.

## Phase 3: Implementation

Once you've decided on your improvements, use the conductor to implement them:

```
/conduct <your improvement description>
```

Key configuration notes:
- Use `--concurrency 2` (this is a TypeScript project)
- Don't skip Codex reviews — they catch real issues
- Use `--context-file` with your exploration findings pre-loaded
- This is a self-referential improvement — the conductor is modifying itself. For changes to the orchestrator loop itself (`orchestrator.ts`), implement manually. For new utilities, tests, MCP tools, and self-contained modules, the conductor can handle them.

**Strategy for self-referential changes:**
1. First implement all new modules (utilities, MCP tools, tests) via the conductor
2. Then manually integrate them into the orchestrator loop and worker manager
3. Build and test after each integration step

## Important Constraints

- **Don't break existing functionality.** Every change must maintain backward compatibility with existing `.conductor/` state files and CLI options.
- **Keep the version bumping convention.** Bump patch version in both `package.json` and `src/cli.ts` for each meaningful change.
- **Build and test after every change.** `npm run build && npx vitest run` must pass.
- **Commit incrementally.** Group related changes into focused commits with clear messages.
- **Be pragmatic.** A few well-implemented improvements are better than many half-baked ones.
- **Respect the existing architecture.** New features should follow existing patterns (file-based persistence, SDK queries for agent work, MCP for coordination).
- **The conductor runs on Max subscriptions with 5-hour usage windows.** Improvements should be mindful of token efficiency.

## What Already Exists (Don't Duplicate)

These were added in v0.1.6 — build on them, don't recreate:
- **Worker personas** (`src/worker-personas.ts`): 7 specialized personas with checklists, anti-patterns, domain guidance
- **Phase timing** (`PhaseDurations` in types, instrumented in orchestrator cycle loop)
- **Blast radius detection** (`BlastRadius` in types, `computeBlastRadius()` in orchestrator)
- **Atomic state writes** (write-to-temp-then-rename in state-manager.ts)
- **Dependency graph validation** (dangling ref detection + cycle detection before task creation)

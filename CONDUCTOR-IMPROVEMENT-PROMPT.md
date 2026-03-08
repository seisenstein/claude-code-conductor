# Conductor Self-Improvement Mission

You are working on Claude Code Conductor (C3) — a hierarchical multi-agent orchestration system that decomposes large features into parallel tasks, spawns headless Claude Code worker sessions, coordinates them via MCP, and reviews with Codex. The codebase is at the current working directory.

## Your Mission

Deeply explore this codebase, understand every component, then design and implement a set of high-impact improvements. You will use the conductor itself (`/conduct`) to plan, execute, and review these improvements.

## Phase 1: Deep Exploration (do this FIRST, before planning anything)

Spend significant time reading and understanding the full system. Read every file in `src/`, `commands/`, the README, and CLAUDE.md. Understand:

- The full orchestrator lifecycle (plan → conventions → execute → review → checkpoint)
- How workers are spawned and coordinated (Agent SDK + MCP tools)
- How the security pipeline works end-to-end
- How flow tracing works
- How Codex review integration works
- The state management and persistence model
- The CLI entry points and option handling
- How the Codex worker runtime differs from Claude workers
- The known issues registry and how findings flow between phases

## Phase 2: Improvement Design

After exploring, think deeply about these improvement areas. You don't have to do all of them — pick the ones that would have the highest impact and are feasible to implement well. But consider ALL of these:

### 1. Specialized Worker Personas
Right now every worker gets the same prompt with minor task-type variations. Consider:
- Should there be distinct personas (e.g., "security engineer", "frontend specialist", "database architect", "test engineer") with deeply specialized knowledge and tool preferences?
- Could personas carry specialized checklists, anti-patterns to watch for, and domain-specific conventions?
- How would persona selection work — based on task_type, or something smarter?
- Could the planner assign personas to tasks explicitly?

### 2. Frontend Work Quality
The conductor currently does weak frontend work. Think about:
- Can workers take screenshots of their work using a browser automation tool and verify visual output?
- Should there be a visual review phase that renders components and checks them?
- Can we inject frontend-specific knowledge: accessibility (WCAG), responsive design patterns, component library conventions, CSS architecture?
- Should frontend tasks get a specialized validation step (lighthouse, axe-core, visual diff)?
- Can we add a "design review" worker that evaluates UI output against design principles?
- Think about what tooling or MCP servers would help here (Playwright, Puppeteer, screenshot comparison).

### 3. Security Testing Tools
Beyond semgrep, consider:
- Can we integrate OWASP ZAP or similar DAST tools for runtime security testing?
- Should there be a dedicated dependency audit step (npm audit, Snyk)?
- Can we add secret scanning (trufflehog, gitleaks) as a gate?
- Should the security sentinel be more structured — running specific checks rather than just "read and look"?
- Can we generate and run security-focused test cases automatically?
- Think about making the semgrep integration more configurable and adding custom rules.

### 4. Guard Rails and Safety
- Should there be a token/cost budget that the conductor tracks and enforces?
- Can we add rollback capability — if a cycle produces bad code, revert to the last checkpoint?
- Should there be a dependency change review gate (any new `npm install` needs approval)?
- Can we detect and prevent workers from going off-task or making unrelated changes?
- Should there be file-level ownership (certain files can only be modified by certain task types)?
- Can we add a "blast radius" check — flag changes that touch too many files or critical paths?

### 5. Worker Coordination
- Can workers share learned context more effectively (not just contracts/decisions, but "I tried X and it didn't work because Y")?
- Should there be a "tech lead" worker that reviews integration points between parallel workers in real-time?
- Can we detect merge conflicts between parallel workers earlier and coordinate resolution?
- Should workers be able to request help from other workers on specific sub-problems?
- Can we improve the anchor task system to handle more complex dependency graphs?

### 6. Smarter Planning
- Can the planner analyze the project's CI/CD pipeline and incorporate its checks?
- Should planning consider historical data from previous conductor runs on the same project?
- Can we make task estimation smarter (use codebase complexity metrics)?
- Should the planner generate integration test tasks that span multiple implementation tasks?
- Can the planner identify when a feature requires infrastructure changes and flag them early?

### 7. Review Quality
- Can we make flow tracing more targeted (trace only the flows that the feature actually affects)?
- Should there be a performance profiling step (run benchmarks before/after)?
- Can we add a "documentation review" phase that ensures API docs, README, and comments are updated?
- Should the code review phase check for test coverage thresholds?
- Can we integrate with the project's existing CI checks as part of the review?

### 8. Observability and Debugging
- Can we add a real-time dashboard or TUI for monitoring conductor runs?
- Should there be structured logging with trace IDs across workers?
- Can we add timing metrics for each phase to identify bottlenecks?
- Should there be a "replay" mode that can re-run a conductor session from saved state?
- Can we add better error diagnostics when workers fail?

### 9. Project Adaptation
- Can the conductor learn from a project's `.github/`, CI config, and existing tooling to auto-configure?
- Should there be project profiles (e.g., "Next.js app", "Express API", "CLI tool") with pre-configured conventions?
- Can we auto-detect the test framework, linter, formatter and inject appropriate commands?
- Should `.conductor/rules.md` be auto-generated from existing CLAUDE.md or CONTRIBUTING.md?

### 10. Testing the Conductor Itself
- The conductor has almost no tests. Can we add unit tests for the core logic?
- Should there be integration tests that run a mini conductor session?
- Can we add snapshot tests for worker prompts?
- Should we test the MCP coordination server tools?

## Phase 3: Implementation

Once you've decided on your improvements, use the conductor to implement them:

```
/conduct <your improvement description>
```

Configure it with appropriate settings for a self-referential improvement run. Consider:
- Use `--concurrency 2` (this is a TypeScript project, parallelism helps)
- Don't skip Codex reviews — they catch real issues
- Use `--context-file` if you want to pre-load your exploration findings

If the conductor can't handle certain meta-improvements (like changing its own orchestrator loop), implement those manually and use the conductor for the rest.

## Important Constraints

- **Don't break existing functionality.** Every change must maintain backward compatibility with existing `.conductor/` state files and CLI options.
- **Keep the version bumping convention.** Bump patch version in both `package.json` and `src/cli.ts` for each meaningful change.
- **Build and test after every change.** `npm run build && npx vitest run` must pass.
- **Commit incrementally.** Don't batch everything into one massive commit.
- **Be pragmatic.** A few well-implemented improvements are better than many half-baked ones. Pick the highest-impact items and do them right.
- **Consider the conductor's own usage patterns.** It runs on Max subscriptions with 5-hour usage windows. Improvements should respect these constraints.

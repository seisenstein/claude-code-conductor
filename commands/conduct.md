You are launching the Claude Code Conductor (C3). This system decomposes a large feature into parallel tasks, spawns headless worker sessions (Claude Code by default, or Codex CLI if selected), coordinates them via a custom MCP server, gets Codex reviews, and handles usage limits -- all autonomously.

The user's feature description is: $ARGUMENTS

## Your Role

You are the **interactive front-end** for the conductor. The conductor itself runs as a background process with no stdin, so YOU handle all user interaction -- Q&A, configuration, escalations -- and communicate with the conductor via files.

## Phase 1: Gather Context

### Step 1: Validate the feature description

If `$ARGUMENTS` is empty or unclear, ask the user to describe the feature they want to implement.

### Step 2: Exhaustive Clarifying Questions

Before launching the conductor, YOU must ask the user thorough clarifying questions about the feature. This is critical -- the conductor cannot ask questions interactively.

First, explore the codebase yourself to understand the existing architecture.

Then ask questions using the **AskUserQuestion tool** in batches of up to 4 at a time (the tool's limit). Each question should use the multi-select or single-select format as appropriate, with well-chosen options that reflect what you learned from the codebase. Use the "Other" option (automatically provided) as the escape hatch for free-text answers.

You need to cover **at least 10 questions** across these areas:
- Edge cases and error handling
- User flows and UI/UX expectations
- Data models and database changes
- API design and integrations
- Authentication/authorization implications
- Testing strategy
- Performance considerations
- Backwards compatibility
- Deployment concerns
- Any project-specific conventions you noticed in the codebase

Ask in rounds of 3-4 questions until all areas are covered. After each round, review the answers and ask follow-up questions if anything is unclear or needs more detail. Use what you learn from earlier answers to make later questions more specific.

### Step 3: Confirm configuration

Use the AskUserQuestion tool to confirm configuration. Use a **two-step flow**:

**First**, ask a single question:
- "Do you want to use all default conductor settings, or customize?"
- Options: "Use all defaults" (description: "2 workers, Claude runtime, per-role model defaults, 5 max cycles, Codex reviews on, 15-min status checks") and "Customize" (description: "I want to change one or more settings")

**If the user selects "Use all defaults"**, proceed with defaults. Do not ask further config questions.

**Per-role defaults** (v0.7.0+, from `DEFAULT_ROLE_CONFIG` in `src/utils/constants.ts`):
- planner, security worker, sentinel → **opus-4-7 xhigh** (reasoning/security wins)
- frontend_ui worker → **opus-4-7 high** (better frontend)
- backend / database / infrastructure / integration / testing / reverse_engineering / general workers → **opus-4-6 high** (avoids 4.7 stub-code regressions on backend)
- flow tracer / conventions extractor / rules extractor / design-spec analyzer / design-spec updater → **sonnet-4-6 medium**

Users can edit `.conductor/models.json` to override any role, or pass `--<group>-model` / `--<group>-effort` CLI flags at launch.

**If the user selects "Customize"**, ask **two** follow-up multiSelect questions (AskUserQuestion allows max 4 options each):

**Question 1**: "Which core settings do you want to change?" with options:
  - **Concurrency** (default: 2 parallel workers)
  - **Worker runtime** (default: Claude workers; switch to Codex CLI workers)
  - **Model selection** (default: per-role defaults above; customize per-group or use legacy two-tier)
  - **Max cycles** (default: 5 cycles before escalating)

**Question 2**: "Any other settings to change?" with options:
  - **Skip Codex** (default: No -- Codex reviews plans and code each cycle)
  - **Skip flow-review** (default: No -- set to yes to skip flow-tracing security review phase)
  - **Current branch** (default: No -- set to yes to work on current branch instead of creating conduct/<slug>)
  - **Dry run / Monitor interval** (default: No dry run, 15-min status checks)

Both questions can be asked in a single AskUserQuestion call (the tool supports up to 4 questions per call). Then ask specific follow-up questions for each selected setting.

**If "Dry run / Monitor interval" is chosen**, ask which they want to change:
- **Dry run**: "Enable dry run mode? (only generate the plan, don't execute)" Options: Yes, No. Default: No.
- **Monitor interval**: "How often should I check on the conductor?" Options: 5 minutes (frequent updates, good for short runs), 10 minutes, 15 minutes (default, good balance), 30 minutes (less frequent, good for long runs). Default: 15 minutes.

**If "Model selection" is chosen**, ask which override style the user wants:

**Q: "How do you want to override model selection?"** Options:
- **Per-group flags (recommended)** — override a specific group of roles (planner, security, frontend, backend, analyzer) while the rest keep their per-role defaults. Use `--<group>-model <tier>` / `--<group>-effort <level>`.
- **Edit `.conductor/models.json`** — full per-role granularity; run `conduct init` first to materialize the file.
- **Legacy two-tier** — one tier for all execution workers, one for all analyzers (pre-0.7.0 behavior). Uses `--worker-model` / `--subagent-model`.

Follow-up questions depend on the choice:

**If "Per-group flags"**, ask for the groups the user wants to change (multiSelect): **planner**, **security** (worker_security + sentinel), **frontend** (worker_frontend_ui), **backend** (backend_api + database + infrastructure + integration), **analyzer** (flow tracer + rules + conventions + design-spec). Then for each chosen group ask:
- **Tier** (single-select): `opus-4-7` (Jan 2026, strongest reasoning, adaptive thinking only), `opus-4-6` (still has /fast, recommended for backend), `sonnet-4-6` (balanced), `haiku-4-5` (fastest/cheapest). Default: whatever the per-role default is for that group.
- **Effort** (single-select): `low` | `medium` | `high` | `xhigh` (Opus 4.7 only) | `max`. Default: per-role default.
- Optionally **default-effort** for any role without a group-specific effort set.

**If "Legacy two-tier"**, ask:
- **Worker tier**: Options: `opus-4-7`, `opus-4-6`, `sonnet-4-6`, `haiku-4-5` (aliases `opus`/`sonnet`/`haiku` still accepted). Default: opus-4-6.
- **Subagent tier**: same options. Default: sonnet-4-6.
- **Extended context** (only if worker is sonnet): "Use 1M token context window? (billed as extra usage)" Default: No. Note: Opus variants always include 1M at no extra cost.

**If "Edit `.conductor/models.json`"**, tell the user to quit, run `conduct init` (which writes the file materialized with per-role defaults), edit the file, and re-invoke `/conduct`.

## Phase 2: Write Context File & Launch

### Step 4: Write the context file

Once you have all answers, write a comprehensive context file to `.conductor/context.md` in the project directory. The file should contain:

```markdown
# Feature: <feature description>

## User Requirements

<Detailed feature description combining the original request and all Q&A>

## Q&A

<All questions and answers, formatted as:>
Q1: <question>
A1: <answer>

Q2: <question>
A2: <answer>
...

## Codebase Notes

<Any relevant observations you made about the existing codebase architecture, patterns, conventions, etc.>

## Configuration

Concurrency: <n>
Worker Runtime: <claude|codex>
Model Selection Mode: <per-role-defaults | per-group-flags | legacy-two-tier | models-json>
<only if per-group-flags:>
  Planner Model/Effort: <tier>/<level>
  Security Model/Effort: <tier>/<level>
  Frontend Model/Effort: <tier>/<level>
  Backend Model/Effort: <tier>/<level>
  Analyzer Model/Effort: <tier>/<level>
  Default Effort: <level>
<only if legacy-two-tier:>
  Worker Tier: <opus-4-7|opus-4-6|sonnet-4-6|haiku-4-5|opus|sonnet|haiku>
  Subagent Tier: <same options>
  Extended Context: <yes/no>
Max Cycles: <n>
Usage Threshold: <n>%
Skip Codex: <yes/no>
Skip Flow-Review: <yes/no>
Current Branch: <yes/no>
```

Create the `.conductor` directory first if it doesn't exist:
```bash
mkdir -p "$(pwd)/.conductor"
```

Then write the context file using your Write tool to `<project>/.conductor/context.md`.

### Step 5: Launch the conductor

Run it as a background process. Include only the flags that match the user's choices:

```bash
conduct start "<feature description>" \
  --project "$(pwd)" \
  --context-file "$(pwd)/.conductor/context.md" \
  [--worker-runtime <claude|codex>] \
  [--worker-model <tier> --subagent-model <tier>] \        # legacy two-tier (v0.6.x compat)
  [--extended-context] \                                   # only with --worker-model sonnet
  [--planner-model <tier>] [--planner-effort <level>] \    # per-group overrides (v0.7.0)
  [--security-model <tier>] [--security-effort <level>] \
  [--frontend-model <tier>] [--frontend-effort <level>] \
  [--backend-model <tier>] [--backend-effort <level>] \
  [--analyzer-model <tier>] [--analyzer-effort <level>] \
  [--default-effort <level>] \                             # applies to roles w/o group flag
  --concurrency <n> \
  --max-cycles <n> \
  --usage-threshold <threshold> \
  [--skip-codex] \
  [--skip-flow-review] \
  [--current-branch] \
  [--dry-run] \
  --verbose \
  2>&1 | tee "$(pwd)/.conductor/logs/conductor-stdout.log" &
```

**Valid tiers:** `opus-4-7`, `opus-4-6`, `sonnet-4-6`, `haiku-4-5` (legacy aliases `opus`/`sonnet`/`haiku` still accepted → 4.6/4.6/4.5).
**Valid effort levels:** `low` | `medium` | `high` | `xhigh` (Opus 4.7 only) | `max`.

Tell the user the conductor has launched and give them these commands to monitor:
- **Status**: `conduct status --project "$(pwd)"`
- **Progress**: `tail -1 .conductor/progress.jsonl` (latest sub-step)
- **Logs**: `conduct log --project "$(pwd)" -n 100`
- **Full stdout**: `tail -f .conductor/logs/conductor-stdout.log`

### Step 6: Start automatic monitoring

After launching, immediately set up a recurring check using **CronCreate** to monitor the conductor. Use the configured monitor interval (default: 15 minutes). Convert the interval to a cron expression (e.g., 5m → `*/5 * * * *`, 15m → `*/15 * * * *`, 30m → `*/30 * * * *`):

```
CronCreate(
  cron: "*/<interval_minutes> * * * *",
  prompt: "Check on the conductor run: run `conduct status --project \"$(pwd)\"` and report progress. If status is COMPLETED, cancel this cron job with CronDelete, show the final results summary, and check if there is a conduct/ branch to merge. If status is FAILED, check the logs with `tail -30 .conductor/logs/conductor.log` and either resume or report the error. If status is PAUSED, check for escalation files.",
  recurring: true
)
```

Tell the user you've set up automatic monitoring at the configured interval. Include the cron job ID so they can cancel it manually if needed.

## Phase 3: Monitor for Escalations

The 15-minute cron job handles routine monitoring automatically. When it fires, run:
```bash
conduct status --project "$(pwd)"
```

**If COMPLETED**: Cancel the cron job with CronDelete. Show the user a summary of results (task counts, cycle count, any review findings). If on a conduct/ branch, ask the user if they want to merge to main.

**If FAILED**: Check the logs:
```bash
tail -30 "$(pwd)/.conductor/logs/conductor.log"
```
Attempt to diagnose the failure. If it looks recoverable (e.g., a worker crashed), clean up stale state and resume:
```bash
conduct resume --project "$(pwd)" --force-resume --verbose
```
If not recoverable, report the error to the user and cancel the cron job.

**If PAUSED**: Check for escalation or rate limit pause:
```bash
cat "$(pwd)/.conductor/escalation.json" 2>/dev/null
```

If an escalation file exists:
1. Read it and show the user the reason and details
2. Ask the user how they want to proceed:
   - **Continue**: Just resume with `conduct resume`
   - **Redirect**: Get new guidance from the user, write it to `.conductor/context.md`, then resume
   - **Stop**: Leave it stopped, cancel the cron job
3. Delete the escalation file after handling it
4. If continuing/redirecting, run: `conduct resume --project "$(pwd)" --verbose`

If paused due to rate limit (check progress message), just report the pause and expected resume time. The conductor will auto-resume when the rate limit resets -- no action needed.

**If EXECUTING/PLANNING/REVIEWING**: Report the current progress (task counts, active workers, usage %) and let the cron continue.

If the run is stuck in a stale state like `executing` even though no workers are alive, resume with:
`conduct resume --project "$(pwd)" --force-resume --verbose`

## Other Operations

If the user says "status", "resume", "pause", "logs", or similar instead of describing a feature:

- **Status**: `conduct status --project "$(pwd)"`
- **Pause**: `conduct pause --project "$(pwd)"` -- sends a graceful pause signal. Workers finish their current task, then the conductor pauses. Resume later with `conduct resume`.
- **Resume**: `conduct resume --project "$(pwd)" --verbose`
- **Logs**: `conduct log --project "$(pwd)" -n 100`

## Important Notes

- Execution workers default to Claude Code sessions. If the user wants Codex CLI to generate code, launch with `--worker-runtime codex`.
- Usage is monitored via the OAuth endpoint -- auto-pauses at the threshold, auto-resumes when the window resets.
- All state lives in `.conductor/` inside the project. Runs survive crashes and can be resumed.
- Code goes on a `conduct/<feature-slug>` git branch. Use `--current-branch` to work on the current branch instead.
- Flow-tracing security review runs after code review each cycle. Use `--skip-flow-review` to disable it for faster iterations.
- If `conduct` is not found, the user needs to run `npm link` inside the `claude-code-conductor` package directory.

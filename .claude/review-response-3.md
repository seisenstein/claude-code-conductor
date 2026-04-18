# Review: Rules Extractor Feature

## INVESTIGATION COMPLETE

**Issues Found:** 3
**Severity:** 1 medium, 1 medium, 1 low

---

### Issue 1: Tests do NOT mock `extractProjectRules` -- will spawn real agents if guidance files exist

**Severity:** Medium

**Investigation:**
`src/core/init.test.ts` mocks four dependencies at the top of the file:
- `./project-detector.js`
- `../utils/design-spec-analyzer.js`
- `../utils/flow-config-generator.js`
- `../utils/gitignore.js`

But it does NOT mock `../utils/rules-extractor.js`. This means `extractProjectRules()` is called for real during every test.

**Why it works today:** The tests create temp directories in `/tmp/` that have no `CLAUDE.md`, `.cursorrules`, or `.claude/rules/` directory. So `hasGuidanceFiles()` returns `false` and the function returns `FALLBACK_TEMPLATE` without ever calling the Agent SDK. This is why all 22 tests pass -- and why we see "No project guidance files found" printed 22 times in the test output.

**Why this is a problem:**
1. If any test ever creates a `CLAUDE.md` in the temp dir (e.g., testing a project that has guidance), the test will try to spawn a real headless Claude Code session via `queryWithTimeout()`. This makes the test slow, flaky, requires API credentials, and costs money.
2. The test for "writes to recommended-configs/ when rules.md already exists" (line 289) creates `.conductor/rules.md` but not `CLAUDE.md`, so it still dodges the agent. But the test is not actually verifying that `extractProjectRules` was called with the right arguments -- it's just verifying file-writing behavior using the fallback template.
3. There is no test coverage for the case where guidance files DO exist and the agent produces extracted rules.

**Fix:** Add a `vi.mock("../utils/rules-extractor.js", ...)` that returns a mock `extractProjectRules` function returning a predictable string. Then add assertions that it was called with `(tempDir, model, logger)`.

**File:** `src/core/init.test.ts` (missing mock at lines 23-37)

---

### Issue 2: Version not bumped -- commit says v0.5.1 but code says 0.5.0

**Severity:** Medium

**Investigation:**
The latest commit `537aea5` has message: `feat: extract project rules from guidance files during conduct init (v0.5.1)`

But:
- `package.json` line 3: `"version": "0.5.0"`
- `src/cli.ts` line 366: `.version("0.5.0")`

The MEMORY.md says to bump version in both files on every update, and the commit claims v0.5.1, but the bump was never actually applied.

**Files:** `package.json:3`, `src/cli.ts:366`

---

### Issue 3: `settingSources: ["project"]` is safe but could add noise to extraction

**Severity:** Low / Not a real issue

**Investigation:**
The concern was that `settingSources: ["project"]` might cause the rules extraction agent to read the project's own CLAUDE.md via the settings system, creating circular output where the agent's system prompt already contains the project instructions.

This is technically true -- the agent will have CLAUDE.md loaded as part of its system prompt AND it will read CLAUDE.md via the Read tool as instructed by the extraction prompt. However:
1. This is the same pattern used by every other agent in the codebase (conventions-extractor, design-spec-analyzer, planner, etc.) -- all use `settingSources: ["project"]`.
2. The extraction prompt explicitly tells the agent to read guidance files and extract rules from them, so reading CLAUDE.md via the tool is intentional.
3. The output format (```rules block) and parsing logic prevent the system prompt from bleeding into the output.
4. The main benefit of `settingSources: ["project"]` is that the agent inherits project-level MCP servers and tool configurations, which may be needed.

**Verdict:** Not a problem. Consistent with existing patterns.

---

### Other checks performed (no issues found):

- **No leftover RULES_TEMPLATE references**: Grep for `RULES_TEMPLATE` across the entire repo returns zero results. The old static template was cleanly removed.
- **rules-loader.ts compatibility**: `loadWorkerRules()` just does `fs.readFile(rulesPath, "utf-8")` and returns the string. It has no format expectations -- any markdown content works. The extracted rules and the fallback template both produce valid markdown.
- **worker-prompt.ts compatibility**: Section 6 (line 237) checks `context.projectRules && context.projectRules.trim().length > 0` and wraps it in `sanitizePromptSection()`. No format assumptions -- works with any non-empty string.
- **Constants properly placed**: `RULES_EXTRACTOR_MAX_TURNS` (25) and `RULES_EXTRACTOR_TIMEOUT_MS` (3 min) are at lines 53-54 of constants.ts, grouped logically next to `CONVENTIONS_EXTRACTION_MAX_TURNS` and `DESIGN_SPEC_ANALYZER_*` constants.
- **Error handling in rules-extractor.ts**: Robust. Falls back to template on: no guidance files, agent exception, empty response, unparseable output, output too short (<50 chars). All paths produce valid rules content.
- **Bash in allowedTools**: The rules extraction agent has `Bash` in its allowed tools (line 114). This is unusual for a read-only extraction agent -- the conventions-extractor only uses `["Read", "Glob", "Grep", "Bash", "LSP"]` too, so this is consistent. Not a bug, but worth noting that a read-only agent has write-capable tools.

---

## Summary

| # | Issue | Severity | Action Needed |
|---|-------|----------|---------------|
| 1 | Tests don't mock extractProjectRules | Medium | Add vi.mock for rules-extractor.js |
| 2 | Version says 0.5.0, commit says 0.5.1 | Medium | Bump to 0.5.1 in package.json + cli.ts |
| 3 | settingSources: ["project"] circularity | Low | No action -- matches existing patterns |

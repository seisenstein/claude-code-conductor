/**
 * Tests for flow-config-analyzer.ts
 *
 * Mocks the SDK and verifies parse/coerce/fallback behavior. A separate
 * `flow-config-analyzer.live.test.ts` (skipped by default) can exercise
 * the real LLM end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mock queryWithTimeout BEFORE importing the analyzer (vitest hoists vi.mock)
vi.mock("./sdk-timeout.js", () => ({
  queryWithTimeout: vi.fn(),
}));

import { analyzeFlowConfig } from "./flow-config-analyzer.js";
import { queryWithTimeout } from "./sdk-timeout.js";
import { ORCHESTRATOR_DIR, MODELS_CONFIG_FILE } from "./constants.js";
import type { FlowConfig, ProjectProfile } from "./types.js";

const SEED: FlowConfig = {
  layers: [{ name: "Generic Layer", checks: ["generic check"] }],
  actor_types: ["generic_actor"],
  edge_cases: ["generic edge case"],
  example_flows: [],
};

const PROFILE: ProjectProfile = {
  detected_at: "2026-04-17T00:00:00Z",
  languages: ["typescript"],
  frameworks: [],
  test_runners: ["vitest"],
  linters: [],
  ci_systems: [],
  package_managers: ["npm"],
  archetype: "cli",
};

async function makeTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fca-test-"));
  await fs.mkdir(path.join(dir, ORCHESTRATOR_DIR), { recursive: true });
  return dir;
}

function mockAgent(output: string): void {
  vi.mocked(queryWithTimeout).mockResolvedValue(output);
}

describe("analyzeFlowConfig", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await makeTempProject();
    vi.mocked(queryWithTimeout).mockReset();
  });
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns the seed when the SDK throws", async () => {
    vi.mocked(queryWithTimeout).mockRejectedValue(new Error("sdk boom"));
    const result = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(result.analyzed).toBe(false);
    expect(result.flowConfig).toEqual(SEED);
    expect(result.warnings.some((w) => /sdk boom/.test(w))).toBe(true);
  });

  it("returns the seed when the SDK returns empty output", async () => {
    mockAgent("");
    const result = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(result.analyzed).toBe(false);
    expect(result.flowConfig).toEqual(SEED);
  });

  it("returns the seed when the SDK output is unparseable", async () => {
    mockAgent("not even close to json {");
    const result = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(result.analyzed).toBe(false);
    expect(result.flowConfig).toEqual(SEED);
  });

  it("returns the seed AND reports analyzed=false when the parsed JSON has no layers", async () => {
    mockAgent("```json\n" + JSON.stringify({
      archetype: "cli",
      layers: [],
      actor_types: ["interactive_user"],
      edge_cases: [],
      example_flows: [],
    }) + "\n```");
    const result = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    // Coerce-level fallback now propagates as analyzed=false so callers
    // (init, status) don't mistake a malformed agent response for tailored output.
    expect(result.analyzed).toBe(false);
    expect(result.flowConfig).toEqual(SEED);
  });

  it("does NOT cache the seed when coerce fell back (regression: malformed output must re-analyze)", async () => {
    // First call: agent returns layers=[], analyzer falls back to seed and
    // must NOT write the cache (otherwise the next call would hit a stale
    // 1-hour cache instead of re-attempting analysis).
    mockAgent("```json\n" + JSON.stringify({
      layers: [],
      actor_types: [],
      edge_cases: [],
      example_flows: [],
    }) + "\n```");
    await analyzeFlowConfig(tempDir, SEED, PROFILE);
    const cachePath = path.join(tempDir, ORCHESTRATOR_DIR, "flow-config.json");
    await expect(fs.stat(cachePath)).rejects.toThrow();

    // Second call should re-invoke the agent (cache miss) — agent now
    // returns valid output and the cache fills.
    vi.mocked(queryWithTimeout).mockReset();
    mockAgent("```json\n" + JSON.stringify({
      layers: [{ name: "Real Layer", checks: ["c"] }],
      actor_types: [],
      edge_cases: [],
      example_flows: [],
    }) + "\n```");
    const second = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(second.analyzed).toBe(true);
    expect(vi.mocked(queryWithTimeout)).toHaveBeenCalledTimes(1);
  });

  it("accepts well-formed analyzer output and returns it", async () => {
    const cliOutput = {
      archetype: "cli",
      layers: [
        { name: "CLI Entry", checks: ["validate args", "set exit codes"] },
        { name: "Core Logic", checks: ["atomic file writes"] },
      ],
      actor_types: ["interactive_user", "ci_runner"],
      edge_cases: ["stale lock", "SIGINT mid-run"],
      example_flows: [
        {
          id: "init",
          name: "Init",
          description: "User runs init",
          entry_points: ["src/cli.ts"],
          actors: ["interactive_user"],
          edge_cases: ["existing config"],
        },
      ],
    };
    mockAgent("```json\n" + JSON.stringify(cliOutput) + "\n```");

    const result = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(result.analyzed).toBe(true);
    expect(result.flowConfig.layers.length).toBe(2);
    expect(result.flowConfig.layers[0].name).toBe("CLI Entry");
    expect(result.flowConfig.actor_types).toEqual(["interactive_user", "ci_runner"]);
    expect(result.flowConfig.example_flows[0].id).toBe("init");
  });

  it("flags refined archetype only when it differs from the heuristic", async () => {
    // Seed says "cli", agent agrees -> no refinement
    mockAgent("```json\n" + JSON.stringify({
      archetype: "cli",
      layers: [{ name: "L", checks: ["c"] }],
      actor_types: [],
      edge_cases: [],
      example_flows: [],
    }) + "\n```");
    const same = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(same.refinedArchetype).toBeUndefined();

    // Reset cache by writing nothing
    await fs.unlink(path.join(tempDir, ORCHESTRATOR_DIR, "flow-config.json")).catch(() => {});
    vi.mocked(queryWithTimeout).mockReset();

    // Same project but agent disagrees -> refinement reported
    mockAgent("```json\n" + JSON.stringify({
      archetype: "library",
      layers: [{ name: "L", checks: ["c"] }],
      actor_types: [],
      edge_cases: [],
      example_flows: [],
    }) + "\n```");
    const diff = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(diff.refinedArchetype).toBe("library");
  });

  it("ignores invalid archetype values in agent output", async () => {
    mockAgent("```json\n" + JSON.stringify({
      archetype: "spaceship",
      layers: [{ name: "L", checks: ["c"] }],
      actor_types: [],
      edge_cases: [],
      example_flows: [],
    }) + "\n```");
    const result = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(result.refinedArchetype).toBeUndefined();
  });

  it("caches the result and reuses it within the TTL", async () => {
    const goodOutput = "```json\n" + JSON.stringify({
      archetype: "cli",
      layers: [{ name: "Cached Layer", checks: ["x"] }],
      actor_types: ["a"],
      edge_cases: ["e"],
      example_flows: [],
    }) + "\n```";
    mockAgent(goodOutput);

    const first = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(first.analyzed).toBe(true);
    expect(vi.mocked(queryWithTimeout)).toHaveBeenCalledTimes(1);

    // Second call within TTL — should hit cache, NOT call queryWithTimeout again
    const second = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(second.analyzed).toBe(true);
    expect(vi.mocked(queryWithTimeout)).toHaveBeenCalledTimes(1); // still 1
    expect(second.flowConfig.layers[0].name).toBe("Cached Layer");
  });

  it("strips fenced code block when present and tolerates raw JSON when absent", async () => {
    const raw = JSON.stringify({
      layers: [{ name: "Raw", checks: ["x"] }],
      actor_types: [],
      edge_cases: [],
      example_flows: [],
    });
    mockAgent(raw); // no ```json fence
    const result = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(result.analyzed).toBe(true);
    expect(result.flowConfig.layers[0].name).toBe("Raw");
  });

  it("filters out malformed entries inside layers/example_flows but keeps valid ones", async () => {
    mockAgent("```json\n" + JSON.stringify({
      layers: [
        { name: "Valid", checks: ["x", 42, "y"] }, // 42 should be filtered out
        { /* missing name */ checks: ["z"] },
        { name: "", checks: ["a"] }, // empty name dropped
      ],
      actor_types: ["good", 7], // 7 dropped
      edge_cases: ["yes", null], // null dropped
      example_flows: [
        { id: "ok", name: "OK", description: "d", entry_points: [], actors: [], edge_cases: [] },
        { /* missing id */ name: "X", description: "d", entry_points: [], actors: [], edge_cases: [] },
      ],
    }) + "\n```");

    const result = await analyzeFlowConfig(tempDir, SEED, PROFILE);
    expect(result.analyzed).toBe(true);
    expect(result.flowConfig.layers.length).toBe(1);
    expect(result.flowConfig.layers[0].checks).toEqual(["x", "y"]);
    expect(result.flowConfig.actor_types).toEqual(["good"]);
    expect(result.flowConfig.edge_cases).toEqual(["yes"]);
    expect(result.flowConfig.example_flows.length).toBe(1);
    expect(result.flowConfig.example_flows[0].id).toBe("ok");
  });

  it("does NOT touch existing models.json or other .conductor files", async () => {
    const modelsPath = path.join(tempDir, ORCHESTRATOR_DIR, MODELS_CONFIG_FILE);
    await fs.writeFile(modelsPath, '{"sentinel-only":true}');

    mockAgent("```json\n" + JSON.stringify({
      layers: [{ name: "L", checks: ["c"] }],
      actor_types: [],
      edge_cases: [],
      example_flows: [],
    }) + "\n```");

    await analyzeFlowConfig(tempDir, SEED, PROFILE);

    const modelsAfter = await fs.readFile(modelsPath, "utf-8");
    expect(modelsAfter).toBe('{"sentinel-only":true}');
  });
});

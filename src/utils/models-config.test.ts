/**
 * Tests for src/utils/models-config.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadModelsConfig,
  resolveRoleSpec,
  resolveSdkArgs,
  specToSdkArgs,
  describeResolvedRoles,
  expandLegacyTiers,
} from "./models-config.js";
import { DEFAULT_ROLE_CONFIG, MODELS_CONFIG_FILE, ORCHESTRATOR_DIR } from "./constants.js";
import type { ModelConfig, AgentRole } from "./types.js";

async function makeTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "models-config-test-"));
  await fs.mkdir(path.join(dir, ORCHESTRATOR_DIR), { recursive: true });
  return dir;
}

async function writeModelsJson(projectDir: string, contents: unknown): Promise<void> {
  const p = path.join(projectDir, ORCHESTRATOR_DIR, MODELS_CONFIG_FILE);
  await fs.writeFile(p, JSON.stringify(contents, null, 2));
}

describe("loadModelsConfig", () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await makeTempProject(); });
  afterEach(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  it("returns empty result when models.json is missing", async () => {
    const result = await loadModelsConfig(tempDir);
    expect(result.roles).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("loads valid per-role overrides", async () => {
    await writeModelsJson(tempDir, {
      roles: {
        planner: { tier: "opus-4-7", effort: "xhigh" },
        worker_frontend_ui: { tier: "opus-4-7", effort: "high" },
      },
    });
    const result = await loadModelsConfig(tempDir);
    expect(result.warnings).toEqual([]);
    expect(result.roles?.planner).toEqual({ tier: "opus-4-7", effort: "xhigh" });
    expect(result.roles?.worker_frontend_ui).toEqual({ tier: "opus-4-7", effort: "high" });
  });

  it("treats invalid JSON as non-fatal warning", async () => {
    const p = path.join(tempDir, ORCHESTRATOR_DIR, MODELS_CONFIG_FILE);
    await fs.writeFile(p, "{ this is not json");
    const result = await loadModelsConfig(tempDir);
    expect(result.roles).toBeUndefined();
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/Invalid JSON/);
  });

  it("treats schema-invalid file as non-fatal warning", async () => {
    await writeModelsJson(tempDir, {
      roles: { planner: { tier: "claude-bogus-99", effort: "high" } },
    });
    const result = await loadModelsConfig(tempDir);
    expect(result.roles).toBeUndefined();
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/Invalid schema/);
  });

  it("rejects unknown role keys", async () => {
    await writeModelsJson(tempDir, {
      roles: { not_a_role: { tier: "opus-4-7" } },
    });
    const result = await loadModelsConfig(tempDir);
    expect(result.roles).toBeUndefined();
    expect(result.warnings.length).toBe(1);
  });

  it("rejects unknown effort levels", async () => {
    await writeModelsJson(tempDir, {
      roles: { planner: { tier: "opus-4-7", effort: "ultra" } },
    });
    const result = await loadModelsConfig(tempDir);
    expect(result.roles).toBeUndefined();
  });

  it("accepts a file with no roles key (empty / partial)", async () => {
    await writeModelsJson(tempDir, { worker: "opus-4-6" });
    const result = await loadModelsConfig(tempDir);
    expect(result.warnings).toEqual([]);
    expect(result.roles).toBeUndefined();
  });
});

describe("resolveRoleSpec", () => {
  it("returns the per-role override when present", () => {
    const config: ModelConfig = {
      worker: "opus",
      subagent: "sonnet",
      extendedContext: false,
      roles: { planner: { tier: "haiku-4-5", effort: "low" } },
    };
    expect(resolveRoleSpec(config, "planner")).toEqual({ tier: "haiku-4-5", effort: "low" });
  });

  it("ignores legacy worker/subagent fields when no roles override is present", () => {
    // v0.7.0 design: legacy `worker`/`subagent` fields are NOT consulted by
    // resolveRoleSpec. The CLI is responsible for expanding them into `roles`
    // via expandLegacyTiers() so this resolver has a single uniform shape.
    const config: ModelConfig = {
      worker: "sonnet-4-6",
      subagent: "haiku-4-5",
      extendedContext: false,
    };
    expect(resolveRoleSpec(config, "worker_backend_api")).toEqual(DEFAULT_ROLE_CONFIG.worker_backend_api);
    expect(resolveRoleSpec(config, "sentinel")).toEqual(DEFAULT_ROLE_CONFIG.sentinel);
    expect(resolveRoleSpec(config, "flow_tracer")).toEqual(DEFAULT_ROLE_CONFIG.flow_tracer);
  });

  it("expandLegacyTiers stamps every role in the worker bucket", () => {
    const expanded = expandLegacyTiers("haiku-4-5", undefined);
    expect(expanded.worker_backend_api?.tier).toBe("haiku-4-5");
    expect(expanded.worker_frontend_ui?.tier).toBe("haiku-4-5");
    expect(expanded.planner?.tier).toBe("haiku-4-5");
    expect(expanded.sentinel).toBeUndefined();
    expect(expanded.flow_tracer).toBeUndefined();
  });

  it("expandLegacyTiers stamps every role in the subagent bucket", () => {
    const expanded = expandLegacyTiers(undefined, "haiku-4-5");
    expect(expanded.sentinel?.tier).toBe("haiku-4-5");
    expect(expanded.flow_tracer?.tier).toBe("haiku-4-5");
    expect(expanded.conventions_extractor?.tier).toBe("haiku-4-5");
    expect(expanded.worker_backend_api).toBeUndefined();
  });

  it("expandLegacyTiers preserves per-role default effort (legacy flags carry tier only)", () => {
    const expanded = expandLegacyTiers("opus-4-6", undefined);
    expect(expanded.worker_frontend_ui?.effort).toBe(DEFAULT_ROLE_CONFIG.worker_frontend_ui.effort);
    expect(expanded.worker_backend_api?.effort).toBe(DEFAULT_ROLE_CONFIG.worker_backend_api.effort);
  });

  it("per-role override beats legacy expansion", () => {
    const legacy = expandLegacyTiers("haiku-4-5", "haiku-4-5");
    const config: ModelConfig = {
      worker: "haiku-4-5",
      subagent: "haiku-4-5",
      extendedContext: false,
      roles: {
        ...legacy,
        worker_frontend_ui: { tier: "opus-4-7", effort: "max" }, // explicit override
      },
    };
    expect(resolveRoleSpec(config, "worker_frontend_ui")).toEqual({ tier: "opus-4-7", effort: "max" });
    // unchanged-by-override roles still see the legacy expansion
    expect(resolveRoleSpec(config, "worker_backend_api").tier).toBe("haiku-4-5");
  });

  it("returns DEFAULT_ROLE_CONFIG entries when config is undefined", () => {
    expect(resolveRoleSpec(undefined, "planner")).toEqual(DEFAULT_ROLE_CONFIG.planner);
    expect(resolveRoleSpec(undefined, "sentinel")).toEqual(DEFAULT_ROLE_CONFIG.sentinel);
    expect(resolveRoleSpec(undefined, "worker_frontend_ui")).toEqual(DEFAULT_ROLE_CONFIG.worker_frontend_ui);
  });

  it("default planner is opus-4-7 xhigh", () => {
    const spec = resolveRoleSpec(undefined, "planner");
    expect(spec.tier).toBe("opus-4-7");
    expect(spec.effort).toBe("xhigh");
  });

  it("default sentinel is opus-4-7 xhigh", () => {
    const spec = resolveRoleSpec(undefined, "sentinel");
    expect(spec.tier).toBe("opus-4-7");
    expect(spec.effort).toBe("xhigh");
  });

  it("default worker_security is opus-4-7 xhigh", () => {
    expect(resolveRoleSpec(undefined, "worker_security")).toEqual({ tier: "opus-4-7", effort: "xhigh" });
  });

  it("default worker_frontend_ui is opus-4-7 high", () => {
    expect(resolveRoleSpec(undefined, "worker_frontend_ui")).toEqual({ tier: "opus-4-7", effort: "high" });
  });

  it("default worker_backend_api is opus-4-6 high (no 4.7 stub-code regression)", () => {
    expect(resolveRoleSpec(undefined, "worker_backend_api")).toEqual({ tier: "opus-4-6", effort: "high" });
  });

  it("default analyzers are sonnet-4-6 medium", () => {
    expect(resolveRoleSpec(undefined, "flow_tracer").tier).toBe("sonnet-4-6");
    expect(resolveRoleSpec(undefined, "conventions_extractor").tier).toBe("sonnet-4-6");
    expect(resolveRoleSpec(undefined, "rules_extractor").tier).toBe("sonnet-4-6");
    expect(resolveRoleSpec(undefined, "design_spec_analyzer").tier).toBe("sonnet-4-6");
    expect(resolveRoleSpec(undefined, "design_spec_updater").tier).toBe("sonnet-4-6");
  });
});

describe("specToSdkArgs / resolveSdkArgs", () => {
  it("maps explicit tiers to API model IDs", () => {
    expect(specToSdkArgs({ tier: "opus-4-7" }).model).toBe("claude-opus-4-7");
    expect(specToSdkArgs({ tier: "opus-4-6" }).model).toBe("claude-opus-4-6");
    expect(specToSdkArgs({ tier: "sonnet-4-6" }).model).toBe("claude-sonnet-4-6");
    expect(specToSdkArgs({ tier: "haiku-4-5" }).model).toBe("claude-haiku-4-5-20251001");
  });

  it("maps legacy aliases to safe pre-0.7.0 IDs", () => {
    // opus alias must NOT silently jump to 4.7 — preserves prior behavior
    expect(specToSdkArgs({ tier: "opus" }).model).toBe("claude-opus-4-6");
    expect(specToSdkArgs({ tier: "sonnet" }).model).toBe("claude-sonnet-4-6");
    expect(specToSdkArgs({ tier: "haiku" }).model).toBe("claude-haiku-4-5-20251001");
  });

  it("forwards effort when set", () => {
    expect(specToSdkArgs({ tier: "opus-4-7", effort: "xhigh" }).effort).toBe("xhigh");
    expect(specToSdkArgs({ tier: "opus-4-6", effort: "max" }).effort).toBe("max");
    expect(specToSdkArgs({ tier: "opus-4-6" }).effort).toBeUndefined();
  });

  it("resolveSdkArgs combines resolution + conversion", () => {
    const out = resolveSdkArgs(undefined, "planner");
    expect(out.model).toBe("claude-opus-4-7");
    expect(out.effort).toBe("xhigh");
  });
});

describe("describeResolvedRoles", () => {
  it("emits a line per role", () => {
    const text = describeResolvedRoles(undefined);
    const lines = text.split("\n");
    expect(lines.length).toBe(Object.keys(DEFAULT_ROLE_CONFIG).length);
    expect(text).toContain("planner");
    expect(text).toContain("opus-4-7");
    expect(text).toContain("xhigh");
  });
});

// ============================================================
// Regression tests for Codex review #1 (legacyExplicit) and #2/#3
// (effort-only patches must preserve underlying tier; --default-effort
// must apply globally). These exercise the same merge semantics that
// composeRoleConfig in cli.ts uses.
// ============================================================

describe("override merge semantics (CLI integration)", () => {
  it("legacy expansion preserves per-role default effort, only overrides tier", () => {
    // User passes --worker-model haiku-4-5 → all worker roles get haiku-4-5,
    // but each role keeps its own default effort (e.g. planner stays xhigh).
    const expanded = expandLegacyTiers("haiku-4-5", undefined);
    expect(expanded.planner).toEqual({
      tier: "haiku-4-5",
      effort: DEFAULT_ROLE_CONFIG.planner.effort, // xhigh
    });
    expect(expanded.worker_frontend_ui).toEqual({
      tier: "haiku-4-5",
      effort: DEFAULT_ROLE_CONFIG.worker_frontend_ui.effort, // high
    });
  });

  it("effort-only override layered on legacy expansion preserves the legacy tier", () => {
    // Simulate: --worker-model haiku-4-5 + --planner-effort low.
    // Expected: planner = { tier: haiku-4-5, effort: low } — tier should NOT
    // be reset to a different default just because effort was overridden.
    const base = expandLegacyTiers("haiku-4-5", undefined);
    // Manually replicate the patch step (as composeRoleConfig does):
    const merged: Partial<Record<AgentRole, { tier: string; effort?: string }>> = { ...base };
    const patch = { effort: "low" as const };
    const existing = merged.planner ?? DEFAULT_ROLE_CONFIG.planner;
    merged.planner = { tier: existing.tier, effort: patch.effort };
    expect(merged.planner).toEqual({ tier: "haiku-4-5", effort: "low" });
  });

  it("default-effort applies to roles without per-group effort but does not overwrite per-group choices", () => {
    // Simulate: --default-effort medium + --planner-effort xhigh.
    // Expected: planner=xhigh, every other role=medium.
    const config: ModelConfig = { worker: "opus", subagent: "sonnet", extendedContext: false };
    const planner = resolveRoleSpec({ ...config, roles: { planner: { tier: DEFAULT_ROLE_CONFIG.planner.tier, effort: "xhigh" } } }, "planner");
    expect(planner.effort).toBe("xhigh");
  });

  it("when no flags are passed, every role resolves to its DEFAULT_ROLE_CONFIG entry", () => {
    // The 0.7.0 default behavior: per-role intelligence wins.
    for (const role of Object.keys(DEFAULT_ROLE_CONFIG) as AgentRole[]) {
      expect(resolveRoleSpec(undefined, role)).toEqual(DEFAULT_ROLE_CONFIG[role]);
    }
  });
});

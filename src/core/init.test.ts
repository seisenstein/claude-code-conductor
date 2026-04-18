/**
 * Tests for src/core/init.ts — the `conduct init` command logic.
 *
 * Tests cover:
 * - Basic init flow (creates .conductor/, generates configs, scaffolds rules)
 * - Frontend detection (calls analyzeDesignSystem only for frontend frameworks)
 * - Existing file handling (writes to recommended-configs/ when files exist)
 * - Design spec pre-existing file race condition fix
 * - ensureGitignore integration
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { DesignSpec, ProjectProfile } from "../utils/types.js";

// ============================================================
// Mocks — must be set up before importing the module under test
// ============================================================

vi.mock("./project-detector.js", () => ({
  detectProjectWithCache: vi.fn(),
  cacheProfile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/design-spec-analyzer.js", () => ({
  analyzeDesignSystem: vi.fn(),
}));

vi.mock("../utils/flow-config-generator.js", () => ({
  generateFlowConfig: vi.fn(),
}));

// v0.7.1: flow-config-analyzer runs an LLM-based refinement. In tests we
// stub it to pass the seed through unchanged so we can still assert on the
// seed flow-config generator's output.
vi.mock("../utils/flow-config-analyzer.js", () => ({
  analyzeFlowConfig: vi.fn().mockImplementation(async (_projectDir, seed) => ({
    flowConfig: seed,
    analyzed: false,
    warnings: [],
  })),
}));

vi.mock("../utils/rules-extractor.js", () => ({
  extractProjectRules: vi.fn(),
}));

vi.mock("../utils/gitignore.js", () => ({
  ensureGitignore: vi.fn(),
}));

// Suppress console.log output during tests
vi.mock("chalk", () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
}));

import { runInit } from "./init.js";
import { detectProjectWithCache } from "./project-detector.js";
import { analyzeDesignSystem } from "../utils/design-spec-analyzer.js";
import { generateFlowConfig } from "../utils/flow-config-generator.js";
import { analyzeFlowConfig } from "../utils/flow-config-analyzer.js";
import { extractProjectRules } from "../utils/rules-extractor.js";
import { ensureGitignore } from "../utils/gitignore.js";
import { DEFAULT_FLOW_CONFIG } from "../utils/flow-config.js";

// ============================================================
// Fixtures
// ============================================================

const MOCK_PROFILE_FRONTEND: ProjectProfile = {
  detected_at: new Date().toISOString(),
  languages: ["typescript"],
  frameworks: ["react", "nextjs"],
  test_runners: ["vitest"],
  linters: ["eslint"],
  ci_systems: [],
  package_managers: ["npm"],
};

const MOCK_PROFILE_BACKEND: ProjectProfile = {
  detected_at: new Date().toISOString(),
  languages: ["typescript"],
  frameworks: ["express"],
  test_runners: ["jest"],
  linters: [],
  ci_systems: [],
  package_managers: ["npm"],
};

const MOCK_PROFILE_EMPTY: ProjectProfile = {
  detected_at: new Date().toISOString(),
  languages: ["typescript"],
  frameworks: [],
  test_runners: [],
  linters: [],
  ci_systems: [],
  package_managers: ["npm"],
};

const MOCK_DESIGN_SPEC: DesignSpec = {
  generated_at: new Date().toISOString(),
  framework: "react",
  component_hierarchy: {
    primitives: [{ name: "Button", file_path: "components/ui/button.tsx", variant_count: 9 }],
    composed: [{ name: "SearchBar", file_path: "components/search-bar.tsx" }],
    page_level: [{ name: "Dashboard", file_path: "app/dashboard/page.tsx" }],
  },
  variant_system: {
    approach: "cva",
    libraries: ["class-variance-authority"],
    examples: [],
  },
  theming: {
    approach: "tailwind",
    token_file: "tailwind.config.ts",
    color_system: "CSS custom properties",
  },
  naming_conventions: {
    files: "kebab-case.tsx",
    components: "PascalCase",
    props: "camelCase",
    css_classes: "tailwind utility classes",
  },
  shared_primitives: [
    {
      name: "Button",
      file_path: "components/ui/button.tsx",
      variant_count: 9,
      size_count: 6,
      consumers: 15,
      variant_approach: "cva",
      description: "Button with 9 cva variants",
    },
  ],
};

const MOCK_FLOW_CONFIG = { ...DEFAULT_FLOW_CONFIG };

// ============================================================
// Test setup
// ============================================================

describe("runInit", () => {
  let tempDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-test-"));

    // Set default mock return values
    vi.mocked(detectProjectWithCache).mockResolvedValue(MOCK_PROFILE_FRONTEND);
    vi.mocked(generateFlowConfig).mockReturnValue(MOCK_FLOW_CONFIG);
    vi.mocked(analyzeDesignSystem).mockResolvedValue(MOCK_DESIGN_SPEC);
    vi.mocked(analyzeFlowConfig).mockImplementation(async (_projectDir, seed) => ({
      flowConfig: seed,
      analyzed: false,
      warnings: [],
    }));
    vi.mocked(extractProjectRules).mockResolvedValue("# Conductor Worker Rules\n\n## Architecture Rules\n- Use secureHandler for all API routes\n");
    vi.mocked(ensureGitignore).mockResolvedValue();

    // Suppress console.log noise
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Basic flow tests
  // ============================================================

  describe("basic flow", () => {
    it("creates .conductor/ directory", async () => {
      await runInit(tempDir);
      const stat = await fs.stat(path.join(tempDir, ".conductor"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("generates flow-config.json", async () => {
      await runInit(tempDir);
      const configPath = path.join(tempDir, ".conductor", "flow-config.json");
      const content = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.layers).toBeDefined();
      expect(parsed.actor_types).toBeDefined();
    });

    it("scaffolds rules.md", async () => {
      await runInit(tempDir);
      const rulesPath = path.join(tempDir, ".conductor", "rules.md");
      const content = await fs.readFile(rulesPath, "utf-8");
      expect(content).toContain("Conductor Worker Rules");
      expect(content).toContain("Architecture Rules");
      expect(content).toContain("secureHandler"); // from mock extractProjectRules
    });

    it("returns correct InitResult structure", async () => {
      const result = await runInit(tempDir);
      expect(result.projectProfile).toEqual(MOCK_PROFILE_FRONTEND);
      expect(result.hasFrontend).toBe(true);
      expect(result.designSpec).toEqual(MOCK_DESIGN_SPEC);
      expect(result.files.created.length).toBeGreaterThan(0);
      expect(Array.isArray(result.files.recommended)).toBe(true);
      expect(Array.isArray(result.files.skipped)).toBe(true);
    });
  });

  // ============================================================
  // Frontend detection tests
  // ============================================================

  describe("frontend detection", () => {
    it("calls analyzeDesignSystem when profile has 'react' framework", async () => {
      const reactProfile = { ...MOCK_PROFILE_FRONTEND, frameworks: ["react"] };
      vi.mocked(detectProjectWithCache).mockResolvedValue(reactProfile);

      await runInit(tempDir);
      expect(analyzeDesignSystem).toHaveBeenCalledWith(tempDir, undefined, undefined);
    });

    it("calls analyzeDesignSystem when profile has 'nextjs' framework", async () => {
      const nextProfile = { ...MOCK_PROFILE_FRONTEND, frameworks: ["nextjs"] };
      vi.mocked(detectProjectWithCache).mockResolvedValue(nextProfile);

      await runInit(tempDir);
      expect(analyzeDesignSystem).toHaveBeenCalled();
    });

    it("calls analyzeDesignSystem when profile has 'vue' framework", async () => {
      const vueProfile = { ...MOCK_PROFILE_FRONTEND, frameworks: ["vue"] };
      vi.mocked(detectProjectWithCache).mockResolvedValue(vueProfile);

      await runInit(tempDir);
      expect(analyzeDesignSystem).toHaveBeenCalled();
    });

    it("skips analyzeDesignSystem when profile has only 'express' framework", async () => {
      vi.mocked(detectProjectWithCache).mockResolvedValue(MOCK_PROFILE_BACKEND);

      const result = await runInit(tempDir);
      expect(analyzeDesignSystem).not.toHaveBeenCalled();
      expect(result.hasFrontend).toBe(false);
      expect(result.designSpec).toBeNull();
    });

    it("skips analyzeDesignSystem when profile has no frameworks", async () => {
      vi.mocked(detectProjectWithCache).mockResolvedValue(MOCK_PROFILE_EMPTY);

      const result = await runInit(tempDir);
      expect(analyzeDesignSystem).not.toHaveBeenCalled();
      expect(result.hasFrontend).toBe(false);
    });

    it("handles null return from analyzeDesignSystem", async () => {
      vi.mocked(analyzeDesignSystem).mockResolvedValue(null);

      const result = await runInit(tempDir);
      expect(result.designSpec).toBeNull();
    });
  });

  // ============================================================
  // Existing file handling tests
  // ============================================================

  describe("existing file handling", () => {
    it("writes to recommended-configs/ when flow-config.json already exists and !force", async () => {
      // Pre-create the flow-config.json
      const conductorDir = path.join(tempDir, ".conductor");
      await fs.mkdir(conductorDir, { recursive: true });
      await fs.writeFile(path.join(conductorDir, "flow-config.json"), "{}", "utf-8");

      // Mock no frontend to simplify
      vi.mocked(detectProjectWithCache).mockResolvedValue(MOCK_PROFILE_BACKEND);

      const result = await runInit(tempDir);
      expect(result.files.recommended.some((f) => f.includes("flow-config.json"))).toBe(true);
      expect(result.files.created.every((f) => !f.includes("flow-config.json"))).toBe(true);

      // Verify recommended-configs/ has the file
      const recPath = path.join(conductorDir, "recommended-configs", "flow-config.json");
      const content = await fs.readFile(recPath, "utf-8");
      expect(JSON.parse(content)).toBeDefined();
    });

    it("overwrites existing flow-config.json when force=true", async () => {
      const conductorDir = path.join(tempDir, ".conductor");
      await fs.mkdir(conductorDir, { recursive: true });
      await fs.writeFile(path.join(conductorDir, "flow-config.json"), "{}", "utf-8");

      vi.mocked(detectProjectWithCache).mockResolvedValue(MOCK_PROFILE_BACKEND);

      const result = await runInit(tempDir, { force: true });
      expect(result.files.created.some((f) => f.includes("flow-config.json"))).toBe(true);
      expect(result.files.recommended.every((f) => !f.includes("flow-config.json"))).toBe(true);
    });

    it("writes to recommended-configs/ when rules.md already exists and !force", async () => {
      const conductorDir = path.join(tempDir, ".conductor");
      await fs.mkdir(conductorDir, { recursive: true });
      await fs.writeFile(path.join(conductorDir, "rules.md"), "existing rules", "utf-8");

      vi.mocked(detectProjectWithCache).mockResolvedValue(MOCK_PROFILE_BACKEND);

      const result = await runInit(tempDir);
      expect(result.files.recommended.some((f) => f.includes("rules.md"))).toBe(true);
    });
  });

  // ============================================================
  // Design spec existing-file handling (race condition fix)
  // ============================================================

  describe("design spec existing-file handling", () => {
    it("writes to recommended-configs/ when design-spec.json existed before analysis", async () => {
      // Pre-create the design-spec.json to simulate an existing spec
      const conductorDir = path.join(tempDir, ".conductor");
      await fs.mkdir(conductorDir, { recursive: true });
      await fs.writeFile(
        path.join(conductorDir, "design-spec.json"),
        JSON.stringify({ existing: true }),
        "utf-8",
      );

      const result = await runInit(tempDir);
      expect(result.files.recommended.some((f) => f.includes("design-spec.json"))).toBe(true);
      expect(result.files.created.every((f) => !f.includes("design-spec.json"))).toBe(true);
    });

    it("records design-spec.json as created when it did not exist before analysis", async () => {
      // Don't pre-create the design-spec.json — it should be recorded as created
      const result = await runInit(tempDir);
      expect(result.files.created.some((f) => f.includes("design-spec.json"))).toBe(true);
      expect(result.files.recommended.every((f) => !f.includes("design-spec.json"))).toBe(true);
    });

    it("overwrites design spec when force=true even if it existed", async () => {
      const conductorDir = path.join(tempDir, ".conductor");
      await fs.mkdir(conductorDir, { recursive: true });
      await fs.writeFile(
        path.join(conductorDir, "design-spec.json"),
        JSON.stringify({ existing: true }),
        "utf-8",
      );

      const result = await runInit(tempDir, { force: true });
      // force=true means it should be recorded as created, not recommended
      expect(result.files.created.some((f) => f.includes("design-spec.json"))).toBe(true);
    });
  });

  // ============================================================
  // ensureGitignore integration
  // ============================================================

  describe("ensureGitignore integration", () => {
    it("calls ensureGitignore during init", async () => {
      await runInit(tempDir);
      expect(ensureGitignore).toHaveBeenCalledWith(tempDir);
    });

    it("calls ensureGitignore before other operations", async () => {
      // Track call order
      const callOrder: string[] = [];
      vi.mocked(ensureGitignore).mockImplementation(async () => {
        callOrder.push("gitignore");
      });
      vi.mocked(detectProjectWithCache).mockImplementation(async () => {
        callOrder.push("detect");
        return MOCK_PROFILE_BACKEND;
      });

      await runInit(tempDir);
      expect(callOrder.indexOf("gitignore")).toBeLessThan(callOrder.indexOf("detect"));
    });
  });

  // ============================================================
  // File permissions
  // ============================================================

  describe("file permissions", () => {
    it("creates .conductor/ with mode 0o700", async () => {
      await runInit(tempDir);
      const stat = await fs.stat(path.join(tempDir, ".conductor"));
      // Check that owner has rwx (on unix systems)
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
    });

    it("creates config files with mode 0o600", async () => {
      vi.mocked(detectProjectWithCache).mockResolvedValue(MOCK_PROFILE_BACKEND);
      await runInit(tempDir);

      if (process.platform !== "win32") {
        const flowStat = await fs.stat(path.join(tempDir, ".conductor", "flow-config.json"));
        expect(flowStat.mode & 0o777).toBe(0o600);

        const rulesStat = await fs.stat(path.join(tempDir, ".conductor", "rules.md"));
        expect(rulesStat.mode & 0o777).toBe(0o600);
      }
    });
  });

  // ============================================================
  // Options passthrough
  // ============================================================

  describe("options passthrough", () => {
    it("passes model to analyzeDesignSystem", async () => {
      await runInit(tempDir, { model: "sonnet" });
      expect(analyzeDesignSystem).toHaveBeenCalledWith(
        tempDir,
        "sonnet",
        undefined, // no logger when verbose=false
      );
    });

    it("passes force to detectProjectWithCache", async () => {
      await runInit(tempDir, { force: true });
      expect(detectProjectWithCache).toHaveBeenCalledWith(tempDir, true);
    });
  });
});

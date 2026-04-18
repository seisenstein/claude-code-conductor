/**
 * Tests for design-spec-analyzer.ts:
 *
 * - Cache logic (age-based, miss, stale)
 * - parseDesignSpecOutput (fenced JSON, raw JSON, tryFixJson, defaults, empty)
 * - loadDesignSpec (cached, missing, malformed)
 * - Error handling (agent failure, cache write failure)
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { DesignSpec } from "./types.js";

// ============================================================
// Mock SDK dependency
// ============================================================

const mockQueryWithTimeout = vi.fn();
vi.mock("./sdk-timeout.js", () => ({
  queryWithTimeout: (...args: unknown[]) => mockQueryWithTimeout(...args),
}));

// ============================================================
// Helpers
// ============================================================

const SAMPLE_SPEC: DesignSpec = {
  generated_at: "2024-01-01T00:00:00.000Z",
  framework: "react",
  component_hierarchy: {
    primitives: [
      { name: "Button", file_path: "components/ui/button.tsx", variant_count: 9 },
    ],
    composed: [
      { name: "SearchBar", file_path: "components/search-bar.tsx" },
    ],
    page_level: [
      { name: "Dashboard", file_path: "app/dashboard/page.tsx" },
    ],
  },
  variant_system: {
    approach: "cva",
    libraries: ["class-variance-authority", "clsx"],
    examples: [
      {
        component: "Button",
        file_path: "components/ui/button.tsx",
        pattern: "cva with variant and size props",
        variants: ["default", "destructive", "outline"],
      },
    ],
  },
  theming: {
    approach: "tailwind",
    token_file: "tailwind.config.ts",
    color_system: "CSS custom properties via Tailwind theme",
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

function wrapInFencedBlock(obj: unknown): string {
  return `Here is the analysis:\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\nDone.`;
}

function makeStderrSpy() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

// ============================================================
// Tests
// ============================================================

describe("analyzeDesignSystem", () => {
  let tempDir: string;
  let stderrSpy: ReturnType<typeof makeStderrSpy>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsa-test-"));
    stderrSpy = makeStderrSpy();
    mockQueryWithTimeout.mockReset();
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // Lazy import to ensure mocks are set up first
  async function getAnalyzer() {
    return await import("./design-spec-analyzer.js");
  }

  // ----------------------------------------------------------
  // Cache tests
  // ----------------------------------------------------------

  describe("cache logic", () => {
    it("returns cached spec when cache file is < 1 hour old", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      // Write a cached spec
      const conductorDir = path.join(tempDir, ".conductor");
      await fs.mkdir(conductorDir, { recursive: true });
      await fs.writeFile(
        path.join(conductorDir, "design-spec.json"),
        JSON.stringify(SAMPLE_SPEC),
      );

      const result = await analyzeDesignSystem(tempDir);

      expect(result).toEqual(SAMPLE_SPEC);
      // queryWithTimeout should NOT have been called — we got the cache hit
      expect(mockQueryWithTimeout).not.toHaveBeenCalled();
    });

    it("re-analyzes when cache file is > 1 hour old", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      // Write a cached spec
      const conductorDir = path.join(tempDir, ".conductor");
      await fs.mkdir(conductorDir, { recursive: true });
      const specPath = path.join(conductorDir, "design-spec.json");
      await fs.writeFile(specPath, JSON.stringify(SAMPLE_SPEC));

      // Set mtime to 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
      await fs.utimes(specPath, twoHoursAgo, twoHoursAgo);

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(SAMPLE_SPEC));

      const result = await analyzeDesignSystem(tempDir);

      // Should have called the agent
      expect(mockQueryWithTimeout).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result!.framework).toBe("react");
    });

    it("proceeds with analysis when no cache file exists", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(SAMPLE_SPEC));

      const result = await analyzeDesignSystem(tempDir);

      expect(mockQueryWithTimeout).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result!.shared_primitives).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------
  // parseDesignSpecOutput tests (tested via analyzeDesignSystem with mocked agent)
  // ----------------------------------------------------------

  describe("JSON parsing (via analyzeDesignSystem)", () => {
    it("parses valid JSON from ```json fenced block", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(SAMPLE_SPEC));

      const result = await analyzeDesignSystem(tempDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("react");
      expect(result!.component_hierarchy.primitives).toHaveLength(1);
      expect(result!.component_hierarchy.primitives[0].name).toBe("Button");
    });

    it("parses valid JSON without fenced block (raw JSON)", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue(JSON.stringify(SAMPLE_SPEC));

      const result = await analyzeDesignSystem(tempDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("react");
    });

    it("returns null for empty agent response (no components)", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue("");

      const result = await analyzeDesignSystem(tempDir);

      // Empty response -> defaults -> no primitives/composed/shared -> returns null
      expect(result).toBeNull();
    });

    it("returns null when no primitives/composed/shared_primitives found", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      const noFrontendSpec = {
        ...SAMPLE_SPEC,
        component_hierarchy: { primitives: [], composed: [], page_level: [] },
        shared_primitives: [],
      };

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(noFrontendSpec));

      const result = await analyzeDesignSystem(tempDir);

      expect(result).toBeNull();
    });

    it("handles trailing commas in JSON via tryFixJson", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      // JSON with trailing commas — should be fixed by tryFixJson
      const badJson = `{
        "generated_at": "2024-01-01T00:00:00.000Z",
        "framework": "react",
        "component_hierarchy": {
          "primitives": [{"name": "Button", "file_path": "button.tsx", "variant_count": 3,}],
          "composed": [],
          "page_level": [],
        },
        "variant_system": { "approach": "cva", "libraries": [], "examples": [], },
        "theming": { "approach": "tailwind", },
        "naming_conventions": { "files": "kebab-case", "components": "PascalCase", "props": "camelCase", "css_classes": "tailwind", },
        "shared_primitives": [{"name": "Button", "file_path": "button.tsx", "variant_count": 3, "consumers": 5, "variant_approach": "cva", "description": "btn",}],
      }`;

      mockQueryWithTimeout.mockResolvedValue(badJson);

      const result = await analyzeDesignSystem(tempDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("react");
      expect(result!.shared_primitives[0].name).toBe("Button");
    });

    it("handles comments in JSON via tryFixJson", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      const jsonWithComments = `{
        // This is the design spec
        "generated_at": "2024-01-01T00:00:00.000Z",
        "framework": "vue",
        "component_hierarchy": {
          "primitives": [{"name": "VBtn", "file_path": "components/VBtn.vue"}],
          "composed": [],
          "page_level": []
        },
        "variant_system": { "approach": "prop-based", "libraries": [], "examples": [] },
        "theming": { "approach": "css-variables" },
        "naming_conventions": { "files": "PascalCase.vue", "components": "PascalCase", "props": "camelCase", "css_classes": "BEM" },
        "shared_primitives": [{"name": "VBtn", "file_path": "components/VBtn.vue", "variant_count": 5, "consumers": 8, "variant_approach": "prop-based", "description": "Vue button"}]
      }`;

      mockQueryWithTimeout.mockResolvedValue(jsonWithComments);

      const result = await analyzeDesignSystem(tempDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("vue");
      expect(result!.shared_primitives[0].name).toBe("VBtn");
    });

    it("returns null for completely invalid text (no valid JSON)", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue(
        "I could not analyze this project because it has no frontend components at all. Sorry!",
      );

      const result = await analyzeDesignSystem(tempDir);

      // Invalid text -> defaults -> no primitives -> returns null
      expect(result).toBeNull();
    });

    it("preserves all fields from valid response", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(SAMPLE_SPEC));

      const result = await analyzeDesignSystem(tempDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("react");
      expect(result!.component_hierarchy.primitives).toHaveLength(1);
      expect(result!.component_hierarchy.composed).toHaveLength(1);
      expect(result!.component_hierarchy.page_level).toHaveLength(1);
      expect(result!.variant_system.approach).toBe("cva");
      expect(result!.variant_system.libraries).toEqual(["class-variance-authority", "clsx"]);
      expect(result!.variant_system.examples).toHaveLength(1);
      expect(result!.theming.approach).toBe("tailwind");
      expect(result!.theming.token_file).toBe("tailwind.config.ts");
      expect(result!.theming.color_system).toBe("CSS custom properties via Tailwind theme");
      expect(result!.naming_conventions.files).toBe("kebab-case.tsx");
      expect(result!.naming_conventions.components).toBe("PascalCase");
      expect(result!.naming_conventions.props).toBe("camelCase");
      expect(result!.naming_conventions.css_classes).toBe("tailwind utility classes");
      expect(result!.shared_primitives).toHaveLength(1);
      expect(result!.shared_primitives[0].consumers).toBe(15);
    });

    it("uses defaults for missing nested fields", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      // Minimal valid spec with primitives but missing many fields
      const minimalSpec = {
        framework: "react",
        component_hierarchy: {
          primitives: [{ name: "Button", file_path: "button.tsx" }],
        },
        shared_primitives: [
          {
            name: "Button",
            file_path: "button.tsx",
            variant_count: 1,
            consumers: 2,
            variant_approach: "props",
            description: "btn",
          },
        ],
      };

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(minimalSpec));

      const result = await analyzeDesignSystem(tempDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("react");
      // Missing composed/page_level should default to []
      expect(result!.component_hierarchy.composed).toEqual([]);
      expect(result!.component_hierarchy.page_level).toEqual([]);
      // Missing variant_system fields should default
      expect(result!.variant_system.approach).toBe("unknown");
      expect(result!.variant_system.libraries).toEqual([]);
      expect(result!.variant_system.examples).toEqual([]);
      // Missing theming should default
      expect(result!.theming.approach).toBe("none");
      // Missing naming_conventions should default to "unknown"
      expect(result!.naming_conventions.files).toBe("unknown");
      expect(result!.naming_conventions.components).toBe("unknown");
    });

    it("uses defaults for non-string framework field", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      const specWithBadTypes = {
        framework: 42,
        component_hierarchy: {
          primitives: [{ name: "Div", file_path: "div.tsx" }],
        },
        shared_primitives: [
          { name: "Div", file_path: "div.tsx", variant_count: 0, consumers: 1, variant_approach: "none", description: "d" },
        ],
      };

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(specWithBadTypes));

      const result = await analyzeDesignSystem(tempDir);

      expect(result).not.toBeNull();
      expect(result!.framework).toBe("unknown");
    });
  });

  // ----------------------------------------------------------
  // Error handling tests
  // ----------------------------------------------------------

  describe("error handling", () => {
    it("returns null when queryWithTimeout throws", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockRejectedValue(new Error("Agent crashed"));

      const result = await analyzeDesignSystem(tempDir);

      expect(result).toBeNull();
      // Check that warning was written
      const warnings = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes("Agent crashed"))).toBe(true);
    });

    it("warns but does not crash when cache write fails", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      // Return valid spec from agent
      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(SAMPLE_SPEC));

      // Make the .conductor directory path a file to prevent mkdir from working
      // Actually, let's use a path that doesn't allow writing
      // Instead, test with a project dir that has a file where .conductor should be
      const blockerPath = path.join(tempDir, ".conductor");
      await fs.writeFile(blockerPath, "not a directory");

      const result = await analyzeDesignSystem(tempDir);

      // Should still return the parsed spec (just couldn't cache it)
      expect(result).not.toBeNull();
      expect(result!.framework).toBe("react");
      // Should have warned about cache failure
      const warnings = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes("Failed to cache design spec"))).toBe(true);
    });

    it("passes correct options to queryWithTimeout", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(SAMPLE_SPEC));

      await analyzeDesignSystem(tempDir, "claude-sonnet-4-6");

      expect(mockQueryWithTimeout).toHaveBeenCalledTimes(1);
      const [prompt, options, timeout, label] = mockQueryWithTimeout.mock.calls[0];
      expect(prompt).toContain("frontend design system analyzer");
      expect(options.allowedTools).toEqual(["Read", "Glob", "Grep", "Bash", "LSP"]);
      expect(options.cwd).toBe(tempDir);
      expect(options.maxTurns).toBe(30);
      expect(options.model).toBe("claude-sonnet-4-6");
      expect(options.settingSources).toEqual(["project"]);
      expect(timeout).toBe(4 * 60 * 1000);
      expect(label).toBe("design-spec-analysis");
    });
  });

  // ----------------------------------------------------------
  // Cache write verification (permissions)
  // ----------------------------------------------------------

  describe("cache write", () => {
    it("writes cached spec with secure permissions", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(SAMPLE_SPEC));

      await analyzeDesignSystem(tempDir);

      const specPath = path.join(tempDir, ".conductor", "design-spec.json");
      const stat = await fs.stat(specPath);
      // Check file exists
      expect(stat.isFile()).toBe(true);
      // Check permissions (0o600 = owner rw only)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("creates .conductor directory with secure permissions", async () => {
      const { analyzeDesignSystem } = await getAnalyzer();

      mockQueryWithTimeout.mockResolvedValue(wrapInFencedBlock(SAMPLE_SPEC));

      await analyzeDesignSystem(tempDir);

      const dirPath = path.join(tempDir, ".conductor");
      const stat = await fs.stat(dirPath);
      expect(stat.isDirectory()).toBe(true);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });
});

// ============================================================
// loadDesignSpec tests
// ============================================================

describe("loadDesignSpec", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsa-load-test-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function getAnalyzer() {
    return await import("./design-spec-analyzer.js");
  }

  it("returns cached spec from file", async () => {
    const { loadDesignSpec } = await getAnalyzer();

    const conductorDir = path.join(tempDir, ".conductor");
    await fs.mkdir(conductorDir, { recursive: true });
    await fs.writeFile(
      path.join(conductorDir, "design-spec.json"),
      JSON.stringify(SAMPLE_SPEC),
    );

    const result = await loadDesignSpec(tempDir);

    expect(result).toEqual(SAMPLE_SPEC);
  });

  it("returns undefined when file does not exist", async () => {
    const { loadDesignSpec } = await getAnalyzer();

    const result = await loadDesignSpec(tempDir);

    expect(result).toBeUndefined();
  });

  it("returns undefined for malformed JSON", async () => {
    const { loadDesignSpec } = await getAnalyzer();

    const conductorDir = path.join(tempDir, ".conductor");
    await fs.mkdir(conductorDir, { recursive: true });
    await fs.writeFile(
      path.join(conductorDir, "design-spec.json"),
      "NOT VALID JSON {{{",
    );

    const result = await loadDesignSpec(tempDir);

    expect(result).toBeUndefined();
  });
});

// ============================================================
// Source verification: pattern consistency
// ============================================================

describe("design-spec-analyzer pattern verification", () => {
  it("does not call console.warn()", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/design-spec-analyzer.ts"),
      "utf-8",
    );
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly).not.toContain("console.warn(");
  });

  it("uses process.stderr.write for warning fallback", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/design-spec-analyzer.ts"),
      "utf-8",
    );
    expect(source).toContain("process.stderr.write");
  });

  it("uses secure file permissions (0o600 for files, mkdirSecure for directories)", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/utils/design-spec-analyzer.ts"),
      "utf-8",
    );
    // Files still use writeFile with mode: 0o600 directly
    expect(source).toContain("mode: 0o600");
    // Directories now use mkdirSecure, which wraps fs.mkdir + fs.chmod to
    // defeat umask (H-2). Assert the helper is imported and used here.
    expect(source).toContain("mkdirSecure");
  });
});

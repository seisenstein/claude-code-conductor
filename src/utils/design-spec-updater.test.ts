/**
 * Tests for design-spec-updater.ts:
 *
 * - filterFrontendFiles (via updateDesignSpec behavior)
 * - updateDesignSpec (mocked agent, JSON parsing, error handling)
 * - Atomic write verification (temp file + rename pattern)
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { DesignSpec, DesignSpecUpdateResult } from "./types.js";
import { updateDesignSpec } from "./design-spec-updater.js";

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

describe("updateDesignSpec", () => {
  let tempDir: string;
  let stderrSpy: ReturnType<typeof makeStderrSpy>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsu-test-"));
    stderrSpy = makeStderrSpy();
    mockQueryWithTimeout.mockReset();
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------
  // filterFrontendFiles (tested through updateDesignSpec)
  // --------------------------------------------------------

  describe("frontend file filtering", () => {
    it("returns no-op when changedFiles has no frontend files", async () => {
      const result = await updateDesignSpec(
        tempDir,
        ["src/utils/helper.ts", "src/index.js", "styles/main.css"],
        SAMPLE_SPEC,
      );
      expect(result).toEqual({ updated: false, warnings: [] });
      expect(mockQueryWithTimeout).not.toHaveBeenCalled();
    });

    it("calls agent when .tsx files are present", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({ updated: false, warnings: [], updated_spec: null }),
      );
      await updateDesignSpec(
        tempDir,
        ["src/components/button.tsx", "src/utils/helper.ts"],
        SAMPLE_SPEC,
      );
      expect(mockQueryWithTimeout).toHaveBeenCalledOnce();
    });

    it("calls agent when .jsx files are present", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({ updated: false, warnings: [], updated_spec: null }),
      );
      await updateDesignSpec(tempDir, ["src/App.jsx"], SAMPLE_SPEC);
      expect(mockQueryWithTimeout).toHaveBeenCalledOnce();
    });

    it("calls agent when .vue files are present", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({ updated: false, warnings: [], updated_spec: null }),
      );
      await updateDesignSpec(tempDir, ["src/MyComponent.vue"], SAMPLE_SPEC);
      expect(mockQueryWithTimeout).toHaveBeenCalledOnce();
    });

    it("calls agent when .svelte files are present", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({ updated: false, warnings: [], updated_spec: null }),
      );
      await updateDesignSpec(tempDir, ["src/App.svelte"], SAMPLE_SPEC);
      expect(mockQueryWithTimeout).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------
  // JSON parsing and result handling
  // --------------------------------------------------------

  describe("result parsing", () => {
    it("returns { updated: false } when agent returns empty response", async () => {
      mockQueryWithTimeout.mockResolvedValue("");
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result).toEqual({ updated: false, warnings: [] });
    });

    it("parses valid update result with updated: false from fenced block", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({ updated: false, warnings: [], updated_spec: null }),
      );
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.updated).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it("parses valid update result with updated: true and writes spec", async () => {
      const updatedSpec: DesignSpec = {
        ...SAMPLE_SPEC,
        component_hierarchy: {
          ...SAMPLE_SPEC.component_hierarchy,
          composed: [
            ...SAMPLE_SPEC.component_hierarchy.composed,
            { name: "NewComponent", file_path: "components/new-component.tsx" },
          ],
        },
      };

      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({
          updated: true,
          warnings: ["Added NewComponent to composed hierarchy"],
          updated_spec: updatedSpec,
        }),
      );

      // Create the .conductor directory for the spec write
      await fs.mkdir(path.join(tempDir, ".conductor"), { recursive: true });

      const result = await updateDesignSpec(
        tempDir,
        ["components/new-component.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.updated).toBe(true);
      expect(result.warnings).toEqual(["Added NewComponent to composed hierarchy"]);

      // Verify the spec was written to disk
      const specPath = path.join(tempDir, ".conductor", "design-spec.json");
      const written = JSON.parse(await fs.readFile(specPath, "utf-8")) as DesignSpec;
      expect(written.component_hierarchy.composed).toHaveLength(2);
      expect(written.component_hierarchy.composed[1].name).toBe("NewComponent");
      // Verify generated_at was updated
      expect(written.generated_at).not.toBe(SAMPLE_SPEC.generated_at);
    });

    it("extracts warnings from agent output", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({
          updated: false,
          warnings: [
            "Button base styles modified in components/ui/button.tsx",
            "This may break 15 consumers",
          ],
          updated_spec: null,
        }),
      );

      const result = await updateDesignSpec(
        tempDir,
        ["components/ui/button.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.warnings).toEqual([
        "Button base styles modified in components/ui/button.tsx",
        "This may break 15 consumers",
      ]);
    });

    it("parses raw JSON without fenced block", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        JSON.stringify({ updated: false, warnings: ["raw warning"], updated_spec: null }),
      );
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.updated).toBe(false);
      expect(result.warnings).toEqual(["raw warning"]);
    });

    it("handles trailing commas in JSON via fix-up", async () => {
      // JSON with trailing commas (common LLM output)
      const badJson = `\`\`\`json
{
  "updated": false,
  "warnings": ["trailing comma warning",],
  "updated_spec": null,
}
\`\`\``;
      mockQueryWithTimeout.mockResolvedValue(badJson);
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.updated).toBe(false);
      expect(result.warnings).toEqual(["trailing comma warning"]);
    });

    it("handles completely invalid/unparseable text gracefully", async () => {
      mockQueryWithTimeout.mockResolvedValue("This is not JSON at all, just some random text without any braces.");
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result).toEqual({ updated: false, warnings: [] });
    });

    it("filters non-string values from warnings array", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({
          updated: false,
          warnings: ["valid warning", 42, null, "another valid"],
          updated_spec: null,
        }),
      );
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.warnings).toEqual(["valid warning", "another valid"]);
    });

    it("returns empty warnings when warnings field is not an array", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({
          updated: false,
          warnings: "not an array",
          updated_spec: null,
        }),
      );
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.warnings).toEqual([]);
    });
  });

  // --------------------------------------------------------
  // Error handling
  // --------------------------------------------------------

  describe("error handling", () => {
    it("returns error warning when agent throws", async () => {
      mockQueryWithTimeout.mockRejectedValue(new Error("Agent timed out"));
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.updated).toBe(false);
      expect(result.warnings).toEqual(["Agent error: Agent timed out"]);
    });

    it("returns error warning when agent throws non-Error", async () => {
      mockQueryWithTimeout.mockRejectedValue("string error");
      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );
      expect(result.updated).toBe(false);
      expect(result.warnings).toEqual(["Agent error: string error"]);
    });

    it("handles write failure gracefully without throwing", async () => {
      const updatedSpec: DesignSpec = { ...SAMPLE_SPEC };
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({
          updated: true,
          warnings: [],
          updated_spec: updatedSpec,
        }),
      );

      // Use a path that doesn't exist and can't be created (invalid chars)
      // Instead, make the .conductor dir read-only so write fails
      const conductorDir = path.join(tempDir, ".conductor");
      await fs.mkdir(conductorDir, { recursive: true });
      await fs.chmod(conductorDir, 0o444);

      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );

      // Should still return the result, just warn about the write failure
      expect(result.updated).toBe(true);
      expect(result.warnings).toEqual([]);

      // Restore permissions for cleanup
      await fs.chmod(conductorDir, 0o755);
    });
  });

  // --------------------------------------------------------
  // Atomic write verification
  // --------------------------------------------------------

  describe("atomic write pattern", () => {
    it("writes to temp file then renames (atomic write)", async () => {
      const updatedSpec: DesignSpec = {
        ...SAMPLE_SPEC,
        framework: "vue",
      };

      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({
          updated: true,
          warnings: [],
          updated_spec: updatedSpec,
        }),
      );

      // Create the .conductor directory
      await fs.mkdir(path.join(tempDir, ".conductor"), { recursive: true });

      const result = await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );

      expect(result.updated).toBe(true);

      // Verify the final file exists
      const specPath = path.join(tempDir, ".conductor", "design-spec.json");
      const written = JSON.parse(await fs.readFile(specPath, "utf-8")) as DesignSpec;
      expect(written.framework).toBe("vue");

      // Verify the temp file does NOT exist (cleaned up)
      const tmpPath = specPath + ".tmp";
      await expect(fs.stat(tmpPath)).rejects.toThrow();
    });

    it("sets generated_at to current time on updated spec", async () => {
      const before = new Date().toISOString();

      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({
          updated: true,
          warnings: [],
          updated_spec: { ...SAMPLE_SPEC },
        }),
      );

      await fs.mkdir(path.join(tempDir, ".conductor"), { recursive: true });

      await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );

      const after = new Date().toISOString();

      const specPath = path.join(tempDir, ".conductor", "design-spec.json");
      const written = JSON.parse(await fs.readFile(specPath, "utf-8")) as DesignSpec;
      expect(written.generated_at >= before).toBe(true);
      expect(written.generated_at <= after).toBe(true);
    });

    it("uses secure file permissions (0o600) for written spec", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({
          updated: true,
          warnings: [],
          updated_spec: { ...SAMPLE_SPEC },
        }),
      );

      await fs.mkdir(path.join(tempDir, ".conductor"), { recursive: true });

      await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
      );

      const specPath = path.join(tempDir, ".conductor", "design-spec.json");
      const stats = await fs.stat(specPath);
      // Check that file permissions are 0o600 (owner read/write only)
      // On macOS/Linux, mode includes file type bits, so mask with 0o777
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  // --------------------------------------------------------
  // Agent prompt construction
  // --------------------------------------------------------

  describe("agent prompt construction", () => {
    it("passes frontend files and current spec to agent", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({ updated: false, warnings: [], updated_spec: null }),
      );

      await updateDesignSpec(
        tempDir,
        ["components/button.tsx", "components/card.tsx", "utils/helper.ts"],
        SAMPLE_SPEC,
      );

      expect(mockQueryWithTimeout).toHaveBeenCalledOnce();
      const prompt = mockQueryWithTimeout.mock.calls[0][0] as string;
      // Should mention the frontend files
      expect(prompt).toContain("components/button.tsx");
      expect(prompt).toContain("components/card.tsx");
      // Should NOT mention non-frontend files
      expect(prompt).not.toContain("utils/helper.ts");
      // Should contain the current spec JSON
      expect(prompt).toContain('"framework": "react"');
      // Should contain the shared primitive file path
      expect(prompt).toContain("components/ui/button.tsx");
    });

    it("passes correct options to queryWithTimeout", async () => {
      mockQueryWithTimeout.mockResolvedValue(
        wrapInFencedBlock({ updated: false, warnings: [], updated_spec: null }),
      );

      // H-11: pass a tier shorthand instead of a raw SDK model ID. The old
      // behavior pushed any string straight to `model`; resolveLooseModelArg
      // now resolves tiers through MODEL_TIER_TO_ID and falls back for
      // unknown values. Use "sonnet-4-6" (a valid tier) and assert the
      // resolved SDK model ID.
      await updateDesignSpec(
        tempDir,
        ["src/app.tsx"],
        SAMPLE_SPEC,
        "sonnet-4-6",
      );

      const options = mockQueryWithTimeout.mock.calls[0][1] as Record<string, unknown>;
      expect(options.allowedTools).toEqual(["Read", "Glob", "Grep", "Bash", "LSP"]);
      expect(options.cwd).toBe(tempDir);
      expect(options.model).toBe("claude-sonnet-4-6");
      expect(options.settingSources).toEqual(["project"]);
    });
  });
});

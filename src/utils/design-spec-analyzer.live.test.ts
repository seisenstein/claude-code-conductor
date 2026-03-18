/**
 * Live integration test for design-spec-analyzer.ts
 *
 * This test spawns a real agent to analyze /Users/cameron/Documents/promptable
 * and validates the output. It is NOT run by default.
 *
 * To run: LIVE_TEST=1 npx vitest run src/utils/design-spec-analyzer.live.test.ts
 *
 * Expected: Button component with ~9 cva variants, correct consumer counts, tailwind theming.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const LIVE = !!process.env.LIVE_TEST;
const PROMPTABLE_DIR = "/Users/cameron/Documents/promptable";

describe.skipIf(!LIVE)("design-spec-analyzer live test", () => {
  it(
    "analyzes promptable project and produces valid design-spec.json",
    async () => {
      // Check that the target project exists
      try {
        await fs.access(PROMPTABLE_DIR);
      } catch {
        throw new Error(
          `Target project not found at ${PROMPTABLE_DIR}. ` +
            "This live test requires the promptable project to be present.",
        );
      }

      // Import the real analyzer (no mocks)
      const { analyzeDesignSystem } = await import("./design-spec-analyzer.js");

      // Delete any existing cache to force a fresh analysis
      const specPath = path.join(PROMPTABLE_DIR, ".conductor", "design-spec.json");
      try {
        await fs.unlink(specPath);
      } catch {
        // No cached file — that's fine
      }

      // Run the analysis (this spawns a real agent — may take 2-4 minutes)
      const result = await analyzeDesignSystem(PROMPTABLE_DIR, "claude-sonnet-4-6");

      // ----------------------------------------------------------
      // Validate the result
      // ----------------------------------------------------------

      expect(result).not.toBeNull();
      expect(result).toBeDefined();

      // Framework should be react or nextjs
      expect(["react", "nextjs"]).toContain(result!.framework);

      // Should have primitives
      expect(result!.component_hierarchy.primitives.length).toBeGreaterThan(0);

      // Should find Button as a shared primitive
      const buttonPrimitive = result!.shared_primitives.find(
        (p) => p.name.toLowerCase() === "button",
      );
      expect(buttonPrimitive).toBeDefined();

      // Button should have cva variants (approximately 9)
      expect(buttonPrimitive!.variant_count).toBeGreaterThanOrEqual(5);

      // Button should have consumers > 0
      expect(buttonPrimitive!.consumers).toBeGreaterThan(0);

      // Button variant approach should be cva
      expect(buttonPrimitive!.variant_approach.toLowerCase()).toContain("cva");

      // Variant system should use cva
      expect(result!.variant_system.approach.toLowerCase()).toContain("cva");

      // Libraries should include class-variance-authority
      const libs = result!.variant_system.libraries.map((l) => l.toLowerCase());
      expect(libs.some((l) => l.includes("class-variance-authority") || l.includes("cva"))).toBe(
        true,
      );

      // Theming should be tailwind-related
      expect(result!.theming.approach.toLowerCase()).toContain("tailwind");

      // Naming conventions should be populated
      expect(result!.naming_conventions.files).not.toBe("unknown");
      expect(result!.naming_conventions.components).not.toBe("unknown");

      // Verify the spec was cached to disk
      const cachedRaw = await fs.readFile(specPath, "utf-8");
      const cached = JSON.parse(cachedRaw);
      expect(cached.framework).toBe(result!.framework);
      expect(cached.shared_primitives.length).toBe(result!.shared_primitives.length);

      // Log summary for manual verification
      console.log("\n=== Live Test Summary ===");
      console.log(`Framework: ${result!.framework}`);
      console.log(`Primitives: ${result!.component_hierarchy.primitives.length}`);
      console.log(`Composed: ${result!.component_hierarchy.composed.length}`);
      console.log(`Page-level: ${result!.component_hierarchy.page_level.length}`);
      console.log(`Shared primitives: ${result!.shared_primitives.length}`);
      console.log(`Variant system: ${result!.variant_system.approach}`);
      console.log(`Theming: ${result!.theming.approach}`);
      if (buttonPrimitive) {
        console.log(
          `Button: ${buttonPrimitive.variant_count} variants, ${buttonPrimitive.consumers} consumers, ${buttonPrimitive.variant_approach}`,
        );
      }
      console.log("========================\n");
    },
    // 5-minute timeout for live test
    5 * 60 * 1000,
  );
});

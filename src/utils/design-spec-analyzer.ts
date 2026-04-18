import fs from "node:fs/promises";
import path from "node:path";
import type { DesignSpec, ComponentInfo, VariantExample, SharedPrimitive, RoleModelSpec } from "./types.js";
import {
  getDesignSpecPath,
  DESIGN_SPEC_ANALYZER_MAX_TURNS,
  DESIGN_SPEC_ANALYZER_TIMEOUT_MS,
  DEFAULT_ROLE_CONFIG,
  READ_ONLY_DISALLOWED_TOOLS,
} from "./constants.js";
import { specToSdkArgs } from "./models-config.js";
import { queryWithTimeout } from "./sdk-timeout.js";
import { mkdirSecure } from "./secure-fs.js";
import type { Logger } from "./logger.js";

const DEFAULT_DESIGN_SPEC: DesignSpec = {
  generated_at: new Date().toISOString(),
  framework: "unknown",
  component_hierarchy: { primitives: [], composed: [], page_level: [] },
  variant_system: { approach: "unknown", libraries: [], examples: [] },
  theming: { approach: "none" },
  naming_conventions: { files: "unknown", components: "unknown", props: "unknown", css_classes: "unknown" },
  shared_primitives: [],
};

const ANALYSIS_PROMPT = `You are a frontend design system analyzer. Your job is to deeply analyze this project's component architecture, variant patterns, theming, and shared primitives.

Follow these steps carefully:

1. **Identify the frontend framework**: Check package.json for react, vue, svelte, angular, or similar. Note the framework.

2. **Find all component files**: Use Glob to find component files:
   - React/Next.js: \`**/components/**/*.tsx\`, \`**/ui/**/*.tsx\`, \`**/app/**/*.tsx\`
   - Vue: \`**/*.vue\`
   - Svelte: \`**/*.svelte\`
   Exclude node_modules, .next, dist, build directories.

3. **Analyze the variant system**: Search for how components handle variants:
   - Use Grep to search for \`class-variance-authority\`, \`cva\`, \`variants\`, \`VariantProps\`
   - Search for \`styled-components\`, \`styled\`, \`css\` tagged template literals
   - Search for \`tailwind-variants\`, \`tv(\`
   - Read 3-5 component files that use variants to understand the pattern in detail

4. **Identify shared primitives**: These are low-level reusable components used in many places.
   - Look in directories like \`components/ui/\`, \`components/common/\`, \`components/shared/\`, \`ui/\`
   - For each primitive, use Grep to search for its import across the codebase to count consumers
   - Read each primitive file to count its variants (look for variant definitions in cva, props, etc.)

5. **Analyze theming**: Search for theme configuration:
   - Check for \`tailwind.config\` files (Tailwind CSS)
   - Search for CSS custom properties (\`--\`) in global CSS files
   - Check for theme providers or design token files
   - Note the theming approach and where tokens/variables are defined

6. **Classify component hierarchy**:
   - **Primitives**: Small, reusable UI atoms (Button, Input, Badge, Label, etc.)
   - **Composed**: Components built from primitives (SearchBar, UserCard, FormField, etc.)
   - **Page-level**: Full page or layout components

7. **Document naming conventions**:
   - File naming pattern (PascalCase.tsx, kebab-case.tsx, etc.)
   - Component naming (PascalCase, camelCase)
   - Props naming convention
   - CSS class approach (Tailwind utilities, BEM, CSS modules, etc.)

After completing your analysis, output EXACTLY one JSON block in this format:

\`\`\`json
{
  "generated_at": "ISO timestamp",
  "framework": "react|vue|svelte|angular",
  "component_hierarchy": {
    "primitives": [{"name": "Button", "file_path": "components/ui/button.tsx", "variant_count": 9, "description": "Primary button with cva variants"}],
    "composed": [{"name": "SearchBar", "file_path": "components/search-bar.tsx", "description": "Search input with filter dropdown"}],
    "page_level": [{"name": "DashboardPage", "file_path": "app/dashboard/page.tsx"}]
  },
  "variant_system": {
    "approach": "cva",
    "libraries": ["class-variance-authority", "clsx"],
    "examples": [{"component": "Button", "file_path": "components/ui/button.tsx", "pattern": "cva with variant and size props", "variants": ["default", "destructive", "outline", "secondary", "ghost", "link"]}]
  },
  "theming": {
    "approach": "tailwind",
    "token_file": "tailwind.config.ts",
    "color_system": "CSS custom properties via Tailwind theme"
  },
  "naming_conventions": {
    "files": "kebab-case.tsx",
    "components": "PascalCase",
    "props": "camelCase",
    "css_classes": "tailwind utility classes"
  },
  "shared_primitives": [
    {"name": "Button", "file_path": "components/ui/button.tsx", "variant_count": 9, "size_count": 6, "consumers": 15, "variant_approach": "cva", "description": "Button: 9 variants via cva (default, destructive, outline, secondary, ghost, link, action, action-outline, filter), 6 sizes"}
  ]
}
\`\`\`

Be thorough and precise. Only report what you actually find. If there are no frontend components, output a JSON with empty arrays and "none" for approaches. Limit primitives to the 20 most-used components. For consumers count, count the number of unique files that import each primitive.`;

/**
 * Attempt to parse JSON, returning null on failure.
 */
function tryParseJson(text: string, warn: (msg: string) => void): Record<string, unknown> | null {
  try {
    const result: unknown = JSON.parse(text);
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch (error) {
    warn(`JSON parse attempt failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Attempt to fix common JSON issues from LLM output.
 */
function tryFixJson(text: string): string {
  let fixed = text;
  fixed = fixed.replace(/\/\/[^\n]*/g, "");
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");
  const braceStart = fixed.indexOf("{");
  const braceEnd = fixed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    fixed = fixed.substring(braceStart, braceEnd + 1);
  }
  return fixed;
}

/**
 * Analyze the frontend design system by spawning a read-only SDK agent.
 * Results are cached to .conductor/design-spec.json.
 * Returns null if no frontend components are found.
 */
export async function analyzeDesignSystem(
  projectDir: string,
  modelSpec?: RoleModelSpec | string,
  logger?: Logger,
): Promise<DesignSpec | null> {
  const specPath = getDesignSpecPath(projectDir);
  const warn = (msg: string) => (logger ? logger.warn(msg) : process.stderr.write(msg + "\n"));

  const sdkArgs = typeof modelSpec === "string"
    ? { model: modelSpec, effort: DEFAULT_ROLE_CONFIG.design_spec_analyzer.effort }
    : specToSdkArgs(modelSpec ?? DEFAULT_ROLE_CONFIG.design_spec_analyzer);

  // Check cache (< 1 hour old)
  try {
    const stat = await fs.stat(specPath);
    const age = Date.now() - stat.mtimeMs;
    if (age < 3_600_000) {
      const cached = JSON.parse(await fs.readFile(specPath, "utf-8"));
      return cached as DesignSpec;
    }
  } catch {
    // No cache — proceed with analysis
  }

  let resultText = "";
  try {
    resultText = await queryWithTimeout(
      ANALYSIS_PROMPT,
      {
        allowedTools: ["Read", "Glob", "Grep", "Bash", "LSP"],
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // CR-1
        cwd: projectDir,
        maxTurns: DESIGN_SPEC_ANALYZER_MAX_TURNS,
        model: sdkArgs.model,
        effort: sdkArgs.effort,
        settingSources: ["project"],
      },
      DESIGN_SPEC_ANALYZER_TIMEOUT_MS,
      "design-spec-analysis",
      logger,
    );
  } catch (error) {
    warn(`Design spec analysis agent failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const spec = parseDesignSpecOutput(resultText, logger);

  // If no primitives and no composed components found, this project has no frontend
  if (
    spec.component_hierarchy.primitives.length === 0 &&
    spec.component_hierarchy.composed.length === 0 &&
    spec.shared_primitives.length === 0
  ) {
    warn("Design spec analysis found no frontend components; skipping design spec.");
    return null;
  }

  // Cache to disk
  try {
    await mkdirSecure(path.dirname(specPath), { recursive: true }); // H-2
    await fs.writeFile(specPath, JSON.stringify(spec, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (error) {
    warn(`Failed to cache design spec: ${error instanceof Error ? error.message : String(error)}`);
  }

  return spec;
}

/**
 * Load a cached design spec from disk without re-analyzing.
 * Returns undefined if no cached spec exists.
 */
export async function loadDesignSpec(projectDir: string): Promise<DesignSpec | undefined> {
  try {
    const specPath = getDesignSpecPath(projectDir);
    const raw = await fs.readFile(specPath, "utf-8");
    return JSON.parse(raw) as DesignSpec;
  } catch {
    return undefined;
  }
}

function parseDesignSpecOutput(text: string, logger?: Logger): DesignSpec {
  const warn = (msg: string) => (logger ? logger.warn(msg) : process.stderr.write(msg + "\n"));

  if (!text || text.trim() === "") {
    warn("Design spec analysis returned empty response; using defaults.");
    return { ...DEFAULT_DESIGN_SPEC, generated_at: new Date().toISOString() };
  }

  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  const jsonText = jsonBlockMatch ? jsonBlockMatch[1] : text;

  const parsed = tryParseJson(jsonText.trim(), warn) ?? tryParseJson(tryFixJson(jsonText.trim()), warn);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const preview = text.substring(0, 500);
    warn(
      `Failed to parse design spec JSON from agent output; using defaults.\n` +
        `Raw output preview (first 500 chars):\n${preview}`,
    );
    return { ...DEFAULT_DESIGN_SPEC, generated_at: new Date().toISOString() };
  }

  // Safely extract nested objects with defaults
  const hierarchy = parsed.component_hierarchy as Record<string, unknown> | undefined;
  const variantSystem = parsed.variant_system as Record<string, unknown> | undefined;
  const theming = parsed.theming as Record<string, unknown> | undefined;
  const namingConv = parsed.naming_conventions as Record<string, unknown> | undefined;

  const spec: DesignSpec = {
    generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : new Date().toISOString(),
    framework: typeof parsed.framework === "string" ? parsed.framework : "unknown",
    component_hierarchy: {
      primitives: Array.isArray(hierarchy?.primitives)
        ? (hierarchy.primitives as ComponentInfo[])
        : [],
      composed: Array.isArray(hierarchy?.composed) ? (hierarchy.composed as ComponentInfo[]) : [],
      page_level: Array.isArray(hierarchy?.page_level)
        ? (hierarchy.page_level as ComponentInfo[])
        : [],
    },
    variant_system: {
      approach: typeof variantSystem?.approach === "string" ? variantSystem.approach : "unknown",
      libraries: Array.isArray(variantSystem?.libraries)
        ? (variantSystem.libraries as string[])
        : [],
      examples: Array.isArray(variantSystem?.examples)
        ? (variantSystem.examples as VariantExample[])
        : [],
    },
    theming: {
      approach: typeof theming?.approach === "string" ? theming.approach : "none",
      token_file: typeof theming?.token_file === "string" ? theming.token_file : undefined,
      color_system: typeof theming?.color_system === "string" ? theming.color_system : undefined,
    },
    naming_conventions: {
      files: typeof namingConv?.files === "string" ? namingConv.files : "unknown",
      components: typeof namingConv?.components === "string" ? namingConv.components : "unknown",
      props: typeof namingConv?.props === "string" ? namingConv.props : "unknown",
      css_classes: typeof namingConv?.css_classes === "string" ? namingConv.css_classes : "unknown",
    },
    shared_primitives: Array.isArray(parsed.shared_primitives)
      ? (parsed.shared_primitives as SharedPrimitive[])
      : [],
  };

  return spec;
}

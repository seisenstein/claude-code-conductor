import fs from "node:fs/promises";
import path from "node:path";
import type { DesignSpec, DesignSpecUpdateResult, RoleModelSpec } from "./types.js";
import {
  getDesignSpecPath,
  DESIGN_SPEC_UPDATER_MAX_TURNS,
  DESIGN_SPEC_UPDATER_TIMEOUT_MS,
  DEFAULT_ROLE_CONFIG,
  READ_ONLY_DISALLOWED_TOOLS,
} from "./constants.js";
import { specToSdkArgs } from "./models-config.js";
import { queryWithTimeout } from "./sdk-timeout.js";
import type { Logger } from "./logger.js";

/** Frontend file extensions to watch for design spec changes. */
const FRONTEND_EXTENSIONS = new Set([".tsx", ".jsx", ".vue", ".svelte"]);

/**
 * Check whether any of the changed files are frontend component files.
 */
function filterFrontendFiles(changedFiles: string[]): string[] {
  return changedFiles.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return FRONTEND_EXTENSIONS.has(ext);
  });
}

/**
 * Update the design spec based on files changed in the current cycle.
 *
 * This is a lightweight post-cycle operation that:
 * 1. Filters changed files to frontend components only
 * 2. Spawns a read-only agent to diff changes against the current spec
 * 3. Patches the spec with new/modified/removed components
 * 4. Warns if shared component base styles were modified
 *
 * Returns a no-op result if no frontend files changed.
 */
export async function updateDesignSpec(
  projectDir: string,
  changedFiles: string[],
  currentSpec: DesignSpec,
  modelSpec?: RoleModelSpec | string,
  logger?: Logger,
): Promise<DesignSpecUpdateResult> {
  const warn = (msg: string) => (logger ? logger.warn(msg) : process.stderr.write(msg + "\n"));

  const frontendFiles = filterFrontendFiles(changedFiles);
  if (frontendFiles.length === 0) {
    return { updated: false, warnings: [] };
  }

  // Build the known shared primitives list for the agent to check against
  const primitivePaths = currentSpec.shared_primitives.map((p) => p.file_path);

  const prompt = buildUpdatePrompt(frontendFiles, currentSpec, primitivePaths);

  const sdkArgs = typeof modelSpec === "string"
    ? { model: modelSpec, effort: DEFAULT_ROLE_CONFIG.design_spec_updater.effort }
    : specToSdkArgs(modelSpec ?? DEFAULT_ROLE_CONFIG.design_spec_updater);

  let resultText = "";
  try {
    resultText = await queryWithTimeout(
      prompt,
      {
        allowedTools: ["Read", "Glob", "Grep", "Bash", "LSP"],
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // CR-1
        cwd: projectDir,
        maxTurns: DESIGN_SPEC_UPDATER_MAX_TURNS,
        model: sdkArgs.model,
        effort: sdkArgs.effort,
        settingSources: ["project"],
      },
      DESIGN_SPEC_UPDATER_TIMEOUT_MS,
      "design-spec-update",
      logger,
    );
  } catch (error) {
    warn(`Design spec updater agent failed: ${error instanceof Error ? error.message : String(error)}`);
    return { updated: false, warnings: [`Agent error: ${error instanceof Error ? error.message : String(error)}`] };
  }

  return parseUpdateResult(resultText, projectDir, currentSpec, logger);
}

function buildUpdatePrompt(
  changedFiles: string[],
  currentSpec: DesignSpec,
  primitivePaths: string[],
): string {
  const fileList = changedFiles.map((f) => `- ${f}`).join("\n");
  const primitiveList =
    primitivePaths.length > 0
      ? primitivePaths.map((p) => `- ${p}`).join("\n")
      : "(none)";

  return `You are a design spec updater. The following frontend files were changed in the last work cycle. Your job is to check if the design spec needs updating.

## Changed frontend files
${fileList}

## Known shared primitives (DO NOT MODIFY THESE BASE STYLES)
${primitiveList}

## Current design spec
\`\`\`json
${JSON.stringify(currentSpec, null, 2)}
\`\`\`

## Your tasks

1. **Read each changed file** to understand what changed.
2. **Check for shared primitive modifications**: If any of the known shared primitive files were changed, check if their DEFAULT/BASE styles were modified (not just new variants added). Report this as a warning.
3. **Check for new components**: If new component files were created, classify them (primitive/composed/page_level) and add to the hierarchy.
4. **Check for new variants**: If new variants were added to existing components, update variant_count and shared_primitives entries.
5. **Check for removed components**: If component files were deleted, remove from the spec.

Output EXACTLY one JSON block:

\`\`\`json
{
  "updated": true,
  "warnings": ["Button base styles modified in components/ui/button.tsx — this may break 15 consumers"],
  "updated_spec": { ...full updated design spec... }
}
\`\`\`

If no changes to the design spec are needed, output:

\`\`\`json
{
  "updated": false,
  "warnings": [],
  "updated_spec": null
}
\`\`\`

Be precise. Only report actual changes you observe in the code.`;
}

async function parseUpdateResult(
  text: string,
  projectDir: string,
  _currentSpec: DesignSpec,
  logger?: Logger,
): Promise<DesignSpecUpdateResult> {
  const warn = (msg: string) => (logger ? logger.warn(msg) : process.stderr.write(msg + "\n"));

  if (!text || text.trim() === "") {
    warn("Design spec updater returned empty response.");
    return { updated: false, warnings: [] };
  }

  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  const jsonText = jsonBlockMatch ? jsonBlockMatch[1] : text;

  let parsed: Record<string, unknown> | null = null;
  try {
    const result: unknown = JSON.parse(jsonText.trim());
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      parsed = result as Record<string, unknown>;
    }
  } catch {
    // Try to fix common issues
    try {
      let fixed = jsonText.trim();
      fixed = fixed.replace(/,\s*([}\]])/g, "$1");
      const braceStart = fixed.indexOf("{");
      const braceEnd = fixed.lastIndexOf("}");
      if (braceStart >= 0 && braceEnd > braceStart) {
        fixed = fixed.substring(braceStart, braceEnd + 1);
      }
      const result: unknown = JSON.parse(fixed);
      if (result !== null && typeof result === "object" && !Array.isArray(result)) {
        parsed = result as Record<string, unknown>;
      }
    } catch {
      // Give up
    }
  }

  if (!parsed) {
    warn("Failed to parse design spec update result.");
    return { updated: false, warnings: [] };
  }

  const warnings = Array.isArray(parsed.warnings)
    ? (parsed.warnings as string[]).filter((w) => typeof w === "string")
    : [];

  const updated = parsed.updated === true;

  // If there's an updated spec, write it to disk atomically (temp file + rename)
  if (updated && parsed.updated_spec && typeof parsed.updated_spec === "object") {
    const updatedSpec = parsed.updated_spec as DesignSpec;
    updatedSpec.generated_at = new Date().toISOString();

    const specPath = getDesignSpecPath(projectDir);
    const tmpPath = specPath + ".tmp";
    try {
      await fs.mkdir(path.dirname(specPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmpPath, JSON.stringify(updatedSpec, null, 2), { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tmpPath, specPath);
    } catch (err) {
      warn(`Failed to write updated design spec: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Clean up temp file if it still exists (in case rename failed)
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Temp file may not exist if rename succeeded
      }
    }
  }

  return { updated, warnings };
}

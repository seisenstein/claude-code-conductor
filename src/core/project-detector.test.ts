/**
 * Unit tests for Project Detector Module.
 *
 * These tests use temp directories with real file system operations
 * to verify detection logic for various project types.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  detectProject,
  loadCachedProfile,
  cacheProfile,
  detectProjectWithCache,
  formatProjectGuidance,
} from "./project-detector.js";
import type { ProjectProfile } from "../utils/types.js";
import { ORCHESTRATOR_DIR } from "../utils/constants.js";

// ============================================================
// Test Helpers
// ============================================================

let tempDir: string;

async function createFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(tempDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

async function createPackageJson(
  deps: Record<string, string> = {},
  devDeps: Record<string, string> = {}
): Promise<void> {
  await createFile(
    "package.json",
    JSON.stringify({
      name: "test-project",
      dependencies: deps,
      devDependencies: devDeps,
    })
  );
}

// ============================================================
// Setup / Teardown
// ============================================================

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-detect-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ============================================================
// Language Detection Tests
// ============================================================

describe("detectProject - Language Detection", () => {
  it("detects TypeScript from tsconfig.json", async () => {
    await createFile("tsconfig.json", "{}");
    await createPackageJson();

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
  });

  it("detects TypeScript from package.json dependency", async () => {
    await createPackageJson({}, { typescript: "^5.0.0" });

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
  });

  it("detects JavaScript when no TypeScript present", async () => {
    await createPackageJson({ express: "^4.18.0" });

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("javascript");
    expect(profile.languages).not.toContain("typescript");
  });

  it("detects Python from pyproject.toml", async () => {
    await createFile("pyproject.toml", '[project]\nname = "test"');

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
  });

  it("detects Python from requirements.txt", async () => {
    await createFile("requirements.txt", "flask>=2.0.0\nrequests>=2.28.0");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
  });

  it("detects Python from Pipfile", async () => {
    await createFile("Pipfile", "[packages]\nflask = '*'");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
  });

  it("detects Python from setup.py", async () => {
    await createFile("setup.py", "from setuptools import setup\nsetup()");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
  });

  it("detects multiple languages", async () => {
    await createFile("tsconfig.json", "{}");
    await createPackageJson();
    await createFile("pyproject.toml", '[project]\nname = "test"');

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
    expect(profile.languages).toContain("python");
  });

  it("returns empty languages for empty project", async () => {
    const profile = await detectProject(tempDir);

    expect(profile.languages).toEqual([]);
  });
});

// ============================================================
// Framework Detection Tests
// ============================================================

describe("detectProject - Framework Detection", () => {
  describe("Node.js Frameworks", () => {
    it("detects Next.js", async () => {
      await createFile("tsconfig.json", "{}");
      await createPackageJson({ next: "^14.0.0", react: "^18.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("nextjs");
      expect(profile.frameworks).toContain("react");
    });

    it("detects Express", async () => {
      await createPackageJson({ express: "^4.18.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("express");
    });

    it("detects NestJS", async () => {
      await createFile("tsconfig.json", "{}");
      await createPackageJson({ "@nestjs/core": "^10.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("nestjs");
    });

    it("detects React", async () => {
      await createPackageJson({ react: "^18.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("react");
    });

    it("detects Vue", async () => {
      await createPackageJson({ vue: "^3.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("vue");
    });

    it("detects Angular", async () => {
      await createFile("tsconfig.json", "{}");
      await createPackageJson({ "@angular/core": "^17.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("angular");
    });

    it("detects Svelte", async () => {
      await createPackageJson({}, { svelte: "^4.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("svelte");
    });

    it("detects Fastify", async () => {
      await createFile("tsconfig.json", "{}");
      await createPackageJson({ fastify: "^4.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("fastify");
    });
  });

  describe("Python Frameworks", () => {
    it("detects FastAPI from pyproject.toml", async () => {
      await createFile(
        "pyproject.toml",
        `[project]
name = "test"
dependencies = ["fastapi>=0.100.0"]`
      );

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("fastapi");
    });

    it("detects Django from pyproject.toml", async () => {
      await createFile(
        "pyproject.toml",
        `[project]
name = "test"
dependencies = ["django>=4.0.0"]`
      );

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("django");
    });

    it("detects Flask from pyproject.toml", async () => {
      await createFile(
        "pyproject.toml",
        `[project]
name = "test"
dependencies = ["flask>=2.0.0"]`
      );

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("flask");
    });

    it("detects FastAPI from requirements.txt", async () => {
      await createFile("requirements.txt", "fastapi>=0.100.0\nuvicorn>=0.23.0");

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("fastapi");
    });

    it("detects Django from requirements.txt", async () => {
      await createFile("requirements.txt", "Django>=4.0\npsycopg2>=2.9");

      const profile = await detectProject(tempDir);

      expect(profile.frameworks).toContain("django");
    });
  });
});

// ============================================================
// Test Runner Detection Tests
// ============================================================

describe("detectProject - Test Runner Detection", () => {
  it("detects vitest", async () => {
    await createPackageJson({}, { vitest: "^2.0.0" });

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("vitest");
  });

  it("detects jest", async () => {
    await createPackageJson({}, { jest: "^29.0.0" });

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("jest");
  });

  it("detects mocha", async () => {
    await createPackageJson({}, { mocha: "^10.0.0" });

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("mocha");
  });

  it("detects pytest from pyproject.toml", async () => {
    await createFile(
      "pyproject.toml",
      `[project]
dependencies = ["pytest>=7.0.0"]`
    );

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("pytest");
  });

  it("detects pytest from pytest.ini", async () => {
    await createFile("pytest.ini", "[pytest]\ntestpaths = tests");

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("pytest");
  });

  it("detects pytest from requirements.txt", async () => {
    await createFile("requirements.txt", "pytest>=7.0\npytest-cov>=4.0");

    const profile = await detectProject(tempDir);

    expect(profile.test_runners).toContain("pytest");
  });
});

// ============================================================
// Linter Detection Tests
// ============================================================

describe("detectProject - Linter Detection", () => {
  describe("Node.js Linters", () => {
    it("detects ESLint from package.json", async () => {
      await createPackageJson({}, { eslint: "^8.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("eslint");
    });

    it("detects ESLint from config file", async () => {
      await createPackageJson();
      await createFile(".eslintrc.json", '{"extends": "eslint:recommended"}');

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("eslint");
    });

    it("detects ESLint from eslint.config.js", async () => {
      await createPackageJson();
      await createFile("eslint.config.js", "export default []");

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("eslint");
    });

    it("detects Prettier from package.json", async () => {
      await createPackageJson({}, { prettier: "^3.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("prettier");
    });

    it("detects Prettier from config file", async () => {
      await createPackageJson();
      await createFile(".prettierrc", '{"semi": true}');

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("prettier");
    });

    it("detects Biome from package.json", async () => {
      await createPackageJson({}, { "@biomejs/biome": "^1.0.0" });

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("biome");
    });

    it("detects Biome from biome.json", async () => {
      await createPackageJson();
      await createFile("biome.json", '{"$schema": "..."}');

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("biome");
    });
  });

  describe("Python Linters", () => {
    it("detects Ruff from ruff.toml", async () => {
      await createFile("ruff.toml", "line-length = 120");

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("ruff");
    });

    it("detects Ruff from .ruff.toml", async () => {
      await createFile(".ruff.toml", "line-length = 100");

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("ruff");
    });

    it("detects Ruff from pyproject.toml", async () => {
      await createFile(
        "pyproject.toml",
        `[tool.ruff]
line-length = 120`
      );

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("ruff");
    });

    it("detects Black from pyproject.toml", async () => {
      await createFile(
        "pyproject.toml",
        `[tool.black]
line-length = 100`
      );

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("black");
    });

    it("detects mypy from pyproject.toml", async () => {
      await createFile(
        "pyproject.toml",
        `[tool.mypy]
python_version = "3.11"`
      );

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("mypy");
    });

    it("detects mypy from mypy.ini", async () => {
      await createFile("mypy.ini", "[mypy]\npython_version = 3.11");

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("mypy");
    });

    it("detects isort from pyproject.toml", async () => {
      await createFile(
        "pyproject.toml",
        `[tool.isort]
profile = "black"`
      );

      const profile = await detectProject(tempDir);

      expect(profile.linters).toContain("isort");
    });
  });
});

// ============================================================
// CI System Detection Tests
// ============================================================

describe("detectProject - CI System Detection", () => {
  it("detects GitHub Actions", async () => {
    await createFile(".github/workflows/ci.yml", "name: CI\non: push");

    const profile = await detectProject(tempDir);

    expect(profile.ci_systems).toContain("github-actions");
  });

  it("detects GitLab CI", async () => {
    await createFile(".gitlab-ci.yml", "stages:\n  - build");

    const profile = await detectProject(tempDir);

    expect(profile.ci_systems).toContain("gitlab-ci");
  });

  it("detects CircleCI", async () => {
    await createFile(".circleci/config.yml", "version: 2.1");

    const profile = await detectProject(tempDir);

    expect(profile.ci_systems).toContain("circleci");
  });

  it("detects Travis CI", async () => {
    await createFile(".travis.yml", "language: node_js");

    const profile = await detectProject(tempDir);

    expect(profile.ci_systems).toContain("travis-ci");
  });

  it("detects Jenkins", async () => {
    await createFile("Jenkinsfile", "pipeline { }");

    const profile = await detectProject(tempDir);

    expect(profile.ci_systems).toContain("jenkins");
  });

  it("detects Azure Pipelines", async () => {
    await createFile("azure-pipelines.yml", "trigger: main");

    const profile = await detectProject(tempDir);

    expect(profile.ci_systems).toContain("azure-pipelines");
  });
});

// ============================================================
// Package Manager Detection Tests
// ============================================================

describe("detectProject - Package Manager Detection", () => {
  describe("Node.js Package Managers", () => {
    it("detects npm", async () => {
      await createPackageJson();
      await createFile("package-lock.json", "{}");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("npm");
    });

    it("detects yarn", async () => {
      await createPackageJson();
      await createFile("yarn.lock", "");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("yarn");
    });

    it("detects pnpm", async () => {
      await createPackageJson();
      await createFile("pnpm-lock.yaml", "");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("pnpm");
    });

    it("detects bun", async () => {
      await createPackageJson();
      await createFile("bun.lockb", "");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("bun");
    });
  });

  describe("Python Package Managers", () => {
    it("detects pip", async () => {
      await createFile("requirements.txt", "flask>=2.0");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("pip");
    });

    it("detects pipenv", async () => {
      await createFile("Pipfile", "[packages]");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("pipenv");
    });

    it("detects poetry", async () => {
      await createFile("poetry.lock", "");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("poetry");
    });

    it("detects pdm", async () => {
      await createFile("pdm.lock", "");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("pdm");
    });

    it("detects uv", async () => {
      await createFile("uv.lock", "");

      const profile = await detectProject(tempDir);

      expect(profile.package_managers).toContain("uv");
    });
  });
});

// ============================================================
// Caching Tests
// ============================================================

describe("Caching Functions", () => {
  it("cacheProfile writes profile to disk", async () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["typescript"],
      frameworks: ["express"],
      test_runners: ["vitest"],
      linters: ["eslint"],
      ci_systems: ["github-actions"],
      package_managers: ["npm"],
    };

    await cacheProfile(tempDir, profile);

    const cached = await loadCachedProfile(tempDir);
    expect(cached).toEqual(profile);
  });

  it("loadCachedProfile returns null for missing file", async () => {
    const cached = await loadCachedProfile(tempDir);
    expect(cached).toBeNull();
  });

  it("detectProjectWithCache uses cache when available", async () => {
    // Create a cached profile
    const cachedProfile: ProjectProfile = {
      detected_at: "2020-01-01T00:00:00.000Z",
      languages: ["typescript"],
      frameworks: ["cached-framework"],
      test_runners: [],
      linters: [],
      ci_systems: [],
      package_managers: [],
    };
    await cacheProfile(tempDir, cachedProfile);

    // Create actual project files (different from cache)
    await createPackageJson({ express: "^4.0.0" });

    // Should return cached version
    const profile = await detectProjectWithCache(tempDir);

    expect(profile.frameworks).toContain("cached-framework");
    expect(profile.detected_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("detectProjectWithCache refreshes when forceRefresh is true", async () => {
    // Create a cached profile
    const cachedProfile: ProjectProfile = {
      detected_at: "2020-01-01T00:00:00.000Z",
      languages: [],
      frameworks: ["old-framework"],
      test_runners: [],
      linters: [],
      ci_systems: [],
      package_managers: [],
    };
    await cacheProfile(tempDir, cachedProfile);

    // Create actual project files
    await createPackageJson({ express: "^4.0.0" });

    // Force refresh should detect actual project
    const profile = await detectProjectWithCache(tempDir, true);

    expect(profile.frameworks).toContain("express");
    expect(profile.frameworks).not.toContain("old-framework");
    expect(profile.detected_at).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("detectProjectWithCache caches result after detection", async () => {
    await createPackageJson({ express: "^4.0.0" });

    // First call - should detect and cache
    await detectProjectWithCache(tempDir);

    // Verify cache was written
    const cached = await loadCachedProfile(tempDir);
    expect(cached).not.toBeNull();
    expect(cached?.frameworks).toContain("express");
  });
});

// ============================================================
// formatProjectGuidance Tests
// ============================================================

describe("formatProjectGuidance", () => {
  it("produces valid markdown with all detected features", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["typescript", "javascript"],
      frameworks: ["nextjs", "react"],
      test_runners: ["vitest"],
      linters: ["eslint", "prettier"],
      ci_systems: ["github-actions"],
      package_managers: ["npm"],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("## Project Profile");
    expect(guidance).toContain("typescript");
    expect(guidance).toContain("nextjs");
    expect(guidance).toContain("vitest");
    expect(guidance).toContain("eslint");
    expect(guidance).toContain("github-actions");
    expect(guidance).toContain("npm");
  });

  it("includes Useful Commands section", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["typescript"],
      frameworks: [],
      test_runners: ["vitest"],
      linters: ["eslint"],
      ci_systems: [],
      package_managers: ["npm"],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("### Useful Commands");
    expect(guidance).toContain("npm install");
    expect(guidance).toContain("npx vitest run");
    expect(guidance).toContain("npx eslint");
    expect(guidance).toContain("npx tsc --noEmit");
  });

  it("handles empty profile gracefully", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: [],
      frameworks: [],
      test_runners: [],
      linters: [],
      ci_systems: [],
      package_managers: [],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("## Project Profile");
    // Should not throw
    expect(typeof guidance).toBe("string");
  });

  it("includes test command with runner info", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: [],
      frameworks: [],
      test_runners: ["jest"],
      linters: [],
      ci_systems: [],
      package_managers: ["npm"],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("npx jest");
  });

  it("includes pytest command for Python projects", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["python"],
      frameworks: [],
      test_runners: ["pytest"],
      linters: [],
      ci_systems: [],
      package_managers: ["pip"],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("pytest");
  });

  it("prefers pnpm over npm when both present", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: [],
      frameworks: [],
      test_runners: [],
      linters: [],
      ci_systems: [],
      package_managers: ["npm", "pnpm"],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("pnpm install");
  });

  it("shows ruff lint command for Python", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["python"],
      frameworks: [],
      test_runners: [],
      linters: ["ruff"],
      ci_systems: [],
      package_managers: ["pip"],
    };

    const guidance = formatProjectGuidance(profile);

    expect(guidance).toContain("ruff check");
  });

  it("shows biome lint command when available", () => {
    const profile: ProjectProfile = {
      detected_at: new Date().toISOString(),
      languages: ["typescript"],
      frameworks: [],
      test_runners: [],
      linters: ["biome", "eslint"],
      ci_systems: [],
      package_managers: ["npm"],
    };

    const guidance = formatProjectGuidance(profile);

    // Biome preferred over eslint
    expect(guidance).toContain("npx biome check");
  });
});

// ============================================================
// Full Detection Integration Test
// ============================================================

describe("Full Project Detection", () => {
  it("detects complete TypeScript/Node.js project", async () => {
    await createFile("tsconfig.json", "{}");
    await createPackageJson(
      { express: "^4.18.0" },
      { typescript: "^5.0.0", vitest: "^2.0.0", eslint: "^8.0.0" }
    );
    await createFile("package-lock.json", "{}");
    await createFile(".github/workflows/ci.yml", "on: push");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
    expect(profile.frameworks).toContain("express");
    expect(profile.test_runners).toContain("vitest");
    expect(profile.linters).toContain("eslint");
    expect(profile.ci_systems).toContain("github-actions");
    expect(profile.package_managers).toContain("npm");
    expect(profile.detected_at).toBeDefined();
  });

  it("detects complete Python/FastAPI project", async () => {
    await createFile(
      "pyproject.toml",
      `[project]
name = "myapi"
dependencies = ["fastapi>=0.100.0"]

[tool.ruff]
line-length = 100

[tool.pytest.ini_options]
testpaths = ["tests"]`
    );
    await createFile("poetry.lock", "");
    await createFile(".github/workflows/ci.yml", "on: push");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("python");
    expect(profile.frameworks).toContain("fastapi");
    expect(profile.test_runners).toContain("pytest");
    expect(profile.linters).toContain("ruff");
    expect(profile.ci_systems).toContain("github-actions");
    expect(profile.package_managers).toContain("poetry");
  });

  it("handles mixed TypeScript + Python monorepo", async () => {
    // TypeScript/Node.js
    await createFile("tsconfig.json", "{}");
    await createPackageJson({ next: "^14.0.0" }, { vitest: "^2.0.0" });
    await createFile("pnpm-lock.yaml", "");

    // Python
    await createFile("pyproject.toml", '[project]\nname="service"');
    await createFile("requirements.txt", "fastapi>=0.100.0\npytest>=7.0");

    const profile = await detectProject(tempDir);

    expect(profile.languages).toContain("typescript");
    expect(profile.languages).toContain("python");
    expect(profile.frameworks).toContain("nextjs");
    expect(profile.frameworks).toContain("fastapi");
    expect(profile.test_runners).toContain("vitest");
    expect(profile.test_runners).toContain("pytest");
    expect(profile.package_managers).toContain("pnpm");
    expect(profile.package_managers).toContain("pip");
  });
});

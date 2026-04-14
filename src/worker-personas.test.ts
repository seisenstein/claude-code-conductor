import { describe, expect, it } from "vitest";
import { getPersona, formatPersonaPrompt } from "./worker-personas.js";
import type { TaskType } from "./utils/types.js";

const ALL_TASK_TYPES: TaskType[] = [
  "security",
  "backend_api",
  "frontend_ui",
  "database",
  "testing",
  "infrastructure",
  "reverse_engineering",
  "integration",
  "general",
];

describe("getPersona", () => {
  it.each([
    ["security", "Security Engineer"],
    ["backend_api", "Backend Engineer"],
    ["database", "Database Architect"],
    ["frontend_ui", "Frontend Specialist"],
    ["testing", "Test Engineer"],
    ["infrastructure", "Infrastructure Engineer"],
    ["reverse_engineering", "Reverse Engineering Analyst"],
    ["integration", "Integration Engineer"],
    ["general", "Software Engineer"],
  ] as const)("getPersona(%s) returns role %s", (taskType, expectedRole) => {
    const persona = getPersona(taskType);
    expect(persona.role).toBe(expectedRole);
  });

  it("returns valid WorkerPersona for all task types", () => {
    for (const taskType of ALL_TASK_TYPES) {
      const persona = getPersona(taskType);
      expect(persona).toHaveProperty("role");
      expect(persona).toHaveProperty("identity");
      expect(persona.checklist).toBeInstanceOf(Array);
      expect(persona.checklist.length).toBeGreaterThan(0);
      expect(persona.antiPatterns).toBeInstanceOf(Array);
      expect(persona.antiPatterns.length).toBeGreaterThan(0);
      expect(persona.domainGuidance).toBeTruthy();
    }
  });
});

describe("formatPersonaPrompt", () => {
  it("includes all required sections for every task type", () => {
    for (const taskType of ALL_TASK_TYPES) {
      const persona = getPersona(taskType);
      const prompt = formatPersonaPrompt(persona);
      expect(prompt).toContain("## Your Role:");
      expect(prompt).toContain("### Pre-Completion Checklist");
      expect(prompt).toContain("### Anti-Patterns to Avoid");
      expect(prompt).toContain("### Domain Guidance");
      expect(prompt).toContain("- [ ]");
      expect(prompt).toContain("- **AVOID:**");
    }
  });

  it("formats checklist items with checkboxes and anti-patterns with AVOID prefix", () => {
    const persona = getPersona("database");
    const prompt = formatPersonaPrompt(persona);
    for (const item of persona.checklist) {
      expect(prompt).toContain(`- [ ] ${item}`);
    }
    for (const ap of persona.antiPatterns) {
      expect(prompt).toContain(`- **AVOID:** ${ap}`);
    }
  });

  it("handles security persona specific content", () => {
    const persona = getPersona("security");
    const prompt = formatPersonaPrompt(persona);
    expect(prompt).toContain("OWASP");
    expect(prompt).toContain("Injection");
    expect(prompt).toContain("authentication");
  });

  it("handles backend_api persona specific content", () => {
    const persona = getPersona("backend_api");
    const prompt = formatPersonaPrompt(persona);
    expect(prompt).toContain("API");
    expect(prompt).toContain("pagination");
    expect(prompt).toContain("HTTP");
  });

  it("handles database persona specific content", () => {
    const persona = getPersona("database");
    const prompt = formatPersonaPrompt(persona);
    expect(prompt).toContain("migration");
    expect(prompt).toContain("index");
    expect(prompt).toContain("constraint");
  });
});

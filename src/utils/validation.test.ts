import { describe, expect, it } from "vitest";

import {
  validateFileName,
  validateBounds,
  assertValidFileName,
  validateFileNames,
  validateIdentifier,
} from "./validation.js";

describe("validateFileName", () => {
  describe("valid filenames", () => {
    it("accepts simple filenames", () => {
      expect(validateFileName("file.txt")).toEqual({ valid: true });
      expect(validateFileName("README.md")).toEqual({ valid: true });
      expect(validateFileName("package.json")).toEqual({ valid: true });
    });

    it("accepts filenames with dots", () => {
      expect(validateFileName("file.test.ts")).toEqual({ valid: true });
      expect(validateFileName(".gitignore")).toEqual({ valid: true });
      expect(validateFileName(".env.local")).toEqual({ valid: true });
    });

    it("accepts relative paths with forward slashes", () => {
      expect(validateFileName("src/utils/validation.ts")).toEqual({ valid: true });
      expect(validateFileName("path/to/file.txt")).toEqual({ valid: true });
    });

    it("accepts filenames with hyphens and underscores", () => {
      expect(validateFileName("my-file_name.ts")).toEqual({ valid: true });
      expect(validateFileName("some_component-test.tsx")).toEqual({ valid: true });
    });

    it("accepts filenames with spaces", () => {
      expect(validateFileName("my file.txt")).toEqual({ valid: true });
    });
  });

  describe("path traversal attacks", () => {
    it("rejects parent directory references", () => {
      const result = validateFileName("../secret.txt");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("..");
    });

    it("rejects nested path traversal", () => {
      expect(validateFileName("foo/../bar/../../etc/passwd").valid).toBe(false);
      expect(validateFileName("path/to/../../secret").valid).toBe(false);
    });

    it("rejects URL-encoded path traversal", () => {
      expect(validateFileName("%2e%2e/secret").valid).toBe(false);
      expect(validateFileName("%2e%2e%2fsecret").valid).toBe(false);
    });

    it("rejects double URL-encoded path traversal", () => {
      expect(validateFileName("%252e%252e/secret").valid).toBe(false);
    });

    it("rejects triple URL-encoded path traversal", () => {
      expect(validateFileName("%25252e%25252e/secret").valid).toBe(false);
    });

    it("rejects mixed encoding attacks", () => {
      expect(validateFileName("..%2f..%2fpasswd").valid).toBe(false);
      expect(validateFileName(".%2e/secret").valid).toBe(false);
    });
  });

  describe("absolute paths", () => {
    it("rejects Unix absolute paths", () => {
      const result = validateFileName("/etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Absolute");
    });

    it("rejects Windows absolute paths", () => {
      expect(validateFileName("C:\\Windows\\System32").valid).toBe(false);
      expect(validateFileName("D:/Documents/file.txt").valid).toBe(false);
    });

    it("rejects UNC paths", () => {
      expect(validateFileName("\\\\server\\share").valid).toBe(false);
      expect(validateFileName("//server/share").valid).toBe(false);
    });
  });

  describe("backslash handling", () => {
    it("rejects backslashes", () => {
      const result = validateFileName("path\\to\\file");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("backslash");
    });

    it("rejects URL-encoded backslashes", () => {
      expect(validateFileName("path%5Cto%5Cfile").valid).toBe(false);
    });
  });

  describe("null bytes and control characters", () => {
    it("rejects null bytes", () => {
      const result = validateFileName("file.txt\x00.exe");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("null byte");
    });

    it("rejects control characters", () => {
      expect(validateFileName("file\x01name").valid).toBe(false);
      expect(validateFileName("file\x1Fname").valid).toBe(false);
    });

    it("allows tabs and newlines in filenames (they exist in practice)", () => {
      // While unusual, some systems allow these
      expect(validateFileName("file\tname").valid).toBe(true);
    });
  });

  describe("empty and whitespace", () => {
    it("rejects empty string", () => {
      const result = validateFileName("");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("empty");
    });

    it("rejects whitespace-only string", () => {
      expect(validateFileName("   ").valid).toBe(false);
      expect(validateFileName("\t\n").valid).toBe(false);
    });
  });
});

describe("validateBounds", () => {
  describe("valid values", () => {
    it("accepts values within bounds", () => {
      expect(() => validateBounds("count", 5, 1, 10)).not.toThrow();
      expect(() => validateBounds("ratio", 0.5, 0.1, 1.0)).not.toThrow();
    });

    it("accepts boundary values (inclusive)", () => {
      expect(() => validateBounds("min", 1, 1, 10)).not.toThrow();
      expect(() => validateBounds("max", 10, 1, 10)).not.toThrow();
    });

    it("accepts zero when in range", () => {
      expect(() => validateBounds("offset", 0, -5, 5)).not.toThrow();
    });

    it("accepts negative numbers when in range", () => {
      expect(() => validateBounds("temp", -10, -20, 0)).not.toThrow();
    });
  });

  describe("out of bounds", () => {
    it("throws for values below minimum", () => {
      expect(() => validateBounds("concurrency", 0, 1, 10)).toThrow(
        "concurrency must be at least 1, got: 0",
      );
    });

    it("throws for values above maximum", () => {
      expect(() => validateBounds("maxCycles", 25, 1, 20)).toThrow(
        "maxCycles must be at most 20, got: 25",
      );
    });

    it("includes parameter name in error message", () => {
      expect(() => validateBounds("usageThreshold", 1.5, 0.1, 1.0)).toThrow(
        /usageThreshold/,
      );
    });
  });

  describe("invalid types", () => {
    it("throws for NaN", () => {
      expect(() => validateBounds("value", NaN, 0, 10)).toThrow(
        "value must be a number",
      );
    });

    it("throws for Infinity", () => {
      expect(() => validateBounds("value", Infinity, 0, 10)).toThrow(
        "value must be a finite number",
      );
    });

    it("throws for -Infinity", () => {
      expect(() => validateBounds("value", -Infinity, 0, 10)).toThrow(
        "value must be a finite number",
      );
    });

    it("throws for non-number values", () => {
      // @ts-expect-error - Testing runtime behavior with invalid types
      expect(() => validateBounds("value", "5", 0, 10)).toThrow(
        "value must be a number, got: string",
      );

      // @ts-expect-error - Testing runtime behavior with invalid types
      expect(() => validateBounds("value", null, 0, 10)).toThrow(
        "value must be a number",
      );
    });
  });
});

describe("assertValidFileName", () => {
  it("does not throw for valid filenames", () => {
    expect(() => assertValidFileName("valid.txt")).not.toThrow();
    expect(() => assertValidFileName("src/file.ts")).not.toThrow();
  });

  it("throws for invalid filenames", () => {
    expect(() => assertValidFileName("../secret")).toThrow("Invalid filename");
    expect(() => assertValidFileName("/etc/passwd")).toThrow("Invalid filename");
    expect(() => assertValidFileName("")).toThrow("Invalid filename");
  });

  it("includes the reason in the error message", () => {
    expect(() => assertValidFileName("..")).toThrow(/path traversal/i);
  });
});

describe("validateIdentifier", () => {
  it("accepts a plain identifier", () => {
    expect(validateIdentifier("task-001")).toEqual({ valid: true });
  });

  it("rejects forward slash with 'path separators' reason", () => {
    const result = validateIdentifier("subdir/task-001");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("path separators");
  });

  it("rejects backslash", () => {
    const result = validateIdentifier("path\\task");
    expect(result.valid).toBe(false);
    // validateFileName catches backslash first with its own message; either
    // rejection is acceptable as long as the identifier is rejected.
    expect(result.reason).toBeTruthy();
  });

  it("rejects colon", () => {
    const result = validateIdentifier("C:task");
    expect(result.valid).toBe(false);
    // Could be caught either by the Windows-drive-letter check in
    // validateFileName or by the new path-separator check.
    expect(result.reason).toBeTruthy();
  });

  it("still applies existing validateFileName rejections (e.g. '..')", () => {
    const result = validateIdentifier("..");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/path traversal/i);
  });
});

describe("validateFileNames", () => {
  it("returns empty array for all valid filenames", () => {
    const result = validateFileNames(["a.txt", "b/c.ts", "d.json"]);
    expect(result).toEqual([]);
  });

  it("returns failures for invalid filenames", () => {
    const result = validateFileNames(["valid.txt", "../secret", "/etc/passwd"]);
    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe("../secret");
    expect(result[1].filename).toBe("/etc/passwd");
  });

  it("includes reason for each failure", () => {
    const result = validateFileNames(["../..", "C:\\file"]);
    expect(result).toHaveLength(2);
    expect(result[0].reason).toContain("..");
    expect(result[1].reason).toContain("backslash");
  });

  it("handles empty array", () => {
    expect(validateFileNames([])).toEqual([]);
  });
});

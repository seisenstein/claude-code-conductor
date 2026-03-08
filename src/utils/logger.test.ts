/**
 * Logger Tests (task-010)
 *
 * Tests for the Logger class, specifically:
 * 1. close() ends the write stream
 * 2. Double-close is safe (idempotent)
 * 3. closed flag prevents writes after close
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Logger } from "./logger.js";

describe("Logger", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "logger-test-")
    );
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  describe("close()", () => {
    it("ends the write stream", async () => {
      const logDir = path.join(tempDir, "logs");
      const logger = new Logger(logDir, "test");

      // Write something first
      logger.info("test message");

      // Close the logger
      logger.close();

      // Verify isClosed returns true
      expect(logger.isClosed()).toBe(true);

      // Small delay to let the stream finish
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify the log file exists and contains the message
      const logPath = path.join(logDir, "test.log");
      const content = await fsPromises.readFile(logPath, "utf-8");
      expect(content).toContain("test message");
    });

    it("is idempotent - double-close is safe", () => {
      const logDir = path.join(tempDir, "logs");
      const logger = new Logger(logDir, "test");

      // Close twice - should not throw
      expect(() => {
        logger.close();
        logger.close();
      }).not.toThrow();

      // Should still be closed
      expect(logger.isClosed()).toBe(true);
    });

    it("multiple close calls have no effect after first close", () => {
      const logDir = path.join(tempDir, "logs");
      const logger = new Logger(logDir, "test");

      logger.close();
      const closedAfterFirst = logger.isClosed();

      logger.close();
      logger.close();
      const closedAfterMultiple = logger.isClosed();

      expect(closedAfterFirst).toBe(true);
      expect(closedAfterMultiple).toBe(true);
    });
  });

  describe("writes after close", () => {
    it("does not throw when writing after close", () => {
      const logDir = path.join(tempDir, "logs");
      const logger = new Logger(logDir, "test");

      logger.close();

      // These should not throw
      expect(() => logger.info("message")).not.toThrow();
      expect(() => logger.warn("message")).not.toThrow();
      expect(() => logger.error("message")).not.toThrow();
      expect(() => logger.debug("message")).not.toThrow();
    });

    it("ignores writes after close", async () => {
      const logDir = path.join(tempDir, "logs");
      const logger = new Logger(logDir, "test");

      // Write before close
      logger.info("before close");

      logger.close();

      // Write after close (should be ignored)
      logger.info("after close");

      // Small delay to ensure any writes complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify only the first message is in the log
      const logPath = path.join(logDir, "test.log");
      const content = await fsPromises.readFile(logPath, "utf-8");
      expect(content).toContain("before close");
      expect(content).not.toContain("after close");
    });
  });

  describe("isClosed()", () => {
    it("returns false before close", () => {
      const logDir = path.join(tempDir, "logs");
      const logger = new Logger(logDir, "test");

      expect(logger.isClosed()).toBe(false);

      // Clean up
      logger.close();
    });

    it("returns true after close", () => {
      const logDir = path.join(tempDir, "logs");
      const logger = new Logger(logDir, "test");

      logger.close();

      expect(logger.isClosed()).toBe(true);
    });
  });

  describe("log file creation", () => {
    it("creates log directory with secure permissions", async () => {
      const logDir = path.join(tempDir, "secure-logs");
      const logger = new Logger(logDir, "test");

      // Check directory permissions (0o700 = owner rwx only)
      const stat = await fsPromises.stat(logDir);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);

      // Clean up
      logger.close();
    });

    it("creates log file with secure permissions", async () => {
      const logDir = path.join(tempDir, "secure-logs");
      const logger = new Logger(logDir, "test");

      // Write something to create the file
      logger.info("test");

      // Small delay to ensure file is created
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check file permissions (0o600 = owner rw only)
      const logPath = path.join(logDir, "test.log");
      const stat = await fsPromises.stat(logPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);

      // Clean up
      logger.close();
    });
  });
});

#!/usr/bin/env node

/**
 * Setup script for claude-code-conductor.
 * Copies the /conduct slash command to ~/.claude/commands/ so it's
 * available globally in Claude Code.
 *
 * Run manually:  npm run setup
 * Runs automatically on npm install (postinstall hook).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSecureSync } from "./utils/secure-fs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const quiet = process.argv.includes("--quiet");

function log(msg: string): void {
  if (!quiet) {
    console.log(msg);
  }
}

function main(): void {
  // Source: commands/conduct.md relative to the package root
  // At runtime this file is dist/setup.js, so package root is one level up
  const packageRoot = path.resolve(__dirname, "..");
  const sourceFile = path.join(packageRoot, "commands", "conduct.md");

  if (!fs.existsSync(sourceFile)) {
    if (!quiet) {
      console.error(`Source command file not found: ${sourceFile}`);
      console.error("Make sure 'commands/conduct.md' exists in the package.");
    }
    process.exit(1);
  }

  // Destination: ~/.claude/commands/conduct.md
  const destDir = path.join(os.homedir(), ".claude", "commands");
  const destFile = path.join(destDir, "conduct.md");

  // Create ~/.claude/commands/ if it doesn't exist
  // Use secure permissions: mode 0o700 (owner rwx only)
  if (!fs.existsSync(destDir)) {
    mkdirSecureSync(destDir, { recursive: true }); // H-2
    log(`Created directory: ${destDir}`);
  }

  // Check if there's already one and if it's different
  if (fs.existsSync(destFile)) {
    const existing = fs.readFileSync(destFile, "utf-8");
    const incoming = fs.readFileSync(sourceFile, "utf-8");

    if (existing === incoming) {
      log("Slash command /conduct is already up to date.");
      return;
    }

    // Back up the old one with secure permissions
    const backupFile = path.join(destDir, "conduct.md.backup");
    fs.copyFileSync(destFile, backupFile);
    fs.chmodSync(backupFile, 0o600);
    log(`Backed up existing command to: ${backupFile}`);
  }

  // Copy the command file and set secure permissions
  fs.copyFileSync(sourceFile, destFile);
  fs.chmodSync(destFile, 0o600);
  log(`Installed /conduct slash command to: ${destFile}`);
  log("");
  log("You can now use '/conduct <feature>' in Claude Code!");
  log("");
  log("If the 'conduct' CLI is not on your PATH, run:");
  log("  npm link");
  log("from this package directory.");
}

main();

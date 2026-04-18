import fs from "fs";
import path from "path";
import chalk from "chalk";
import { mkdirSecureSync } from "./secure-fs.js";

/**
 * Redact likely secrets from a log line before writing to disk.
 * Defense in depth — not a substitute for not logging secrets in the first place.
 *
 * Patterns cover:
 *  - Anthropic API keys (sk-ant-*)
 *  - Authorization header values (Authorization: ..., Bearer ...)
 *  - JSON-style secret fields ("token":"...", "api_key":"...", "password":"...")
 *  - URL/config-style secret fields (token=..., api_key=..., password=...)
 *  - Long hex strings (40+ chars — likely session tokens / HMACs / SHAs)
 *
 * Note: the hex pattern may also match commit SHAs or long checksums. Those
 * aren't secret, so the collateral damage is acceptable for a log file.
 */
const SECRET_PATTERNS: Array<[RegExp, string | ((m: string) => string)]> = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "sk-ant-***REDACTED***"],
  [/Authorization\s*[:=]\s*[A-Za-z0-9._~+/=\s-]+/gi, "Authorization: ***REDACTED***"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer ***REDACTED***"],
  // JSON-style: "token": "abc123", "api_key":"...", "password":"..."
  [
    /"(api[_-]?key|token|secret|password|passwd|auth)"\s*:\s*"[^"]{6,}"/gi,
    (m: string) => m.replace(/:\s*"[^"]+"/, ': "***REDACTED***"'),
  ],
  // URL/config-style: token=abc123, api_key=..., password=...
  [
    /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi,
    (m: string) =>
      m.replace(/([:=]\s*)[A-Za-z0-9._~+/=-]{8,}/, "$1***REDACTED***"),
  ],
  // Long hex (40+ chars)
  [/\b[a-f0-9]{40,}\b/g, "***HEX_REDACTED***"],
];

export function redactSecrets(line: string): string {
  let out = line;
  for (const [re, replacement] of SECRET_PATTERNS) {
    if (typeof replacement === "string") {
      out = out.replace(re, replacement);
    } else {
      out = out.replace(re, replacement);
    }
  }
  return out;
}

export class Logger {
  private name: string;
  private logFilePath: string;
  private logStream: fs.WriteStream;
  private closed: boolean = false;
  private exitHandler: (() => void) | null = null;

  constructor(logDir: string, name: string) {
    this.name = name;

    // Ensure the log directory exists with secure permissions (H-2: chmod-enforced 0o700)
    mkdirSecureSync(logDir, { recursive: true });

    this.logFilePath = path.join(logDir, `${name}.log`);
    // Use mode 0o600 for owner-only read/write access (security requirement #15).
    // Note: createWriteStream's `mode` only applies to newly-created files —
    // existing files keep their pre-existing mode. After the stream opens,
    // chmod unconditionally to defeat both umask AND pre-existing broad modes.
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: "a", mode: 0o600 });
    this.logStream.on("open", () => {
      try {
        fs.chmodSync(this.logFilePath, 0o600);
      } catch {
        // Best-effort: file may not exist yet in edge cases; ignore.
      }
    });

    // Safety net: close stream on process exit to prevent file descriptor leak (task-010).
    // Store reference so we can remove it in close() to avoid listener accumulation.
    this.exitHandler = () => this.close();
    process.on("exit", this.exitHandler);
  }

  /**
   * Close the write stream. Idempotent - safe to call multiple times.
   * Fixes file descriptor leak when Logger instances are not explicitly closed.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.logStream.end();
    // Remove the process exit listener to prevent listener accumulation
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }
  }

  /**
   * Check if the logger has been closed.
   */
  isClosed(): boolean {
    return this.closed;
  }

  info(message: string): void {
    const timestamp = this.getTimestamp();
    const plain = `[${timestamp}] [INFO]  [${this.name}] ${message}`;
    const colored = `${chalk.gray(`[${timestamp}]`)} ${chalk.blue("[INFO]")}  ${chalk.cyan(`[${this.name}]`)} ${message}`;
    console.log(colored);
    this.writeToFile(plain);
  }

  warn(message: string): void {
    const timestamp = this.getTimestamp();
    const plain = `[${timestamp}] [WARN]  [${this.name}] ${message}`;
    const colored = `${chalk.gray(`[${timestamp}]`)} ${chalk.yellow("[WARN]")}  ${chalk.cyan(`[${this.name}]`)} ${chalk.yellow(message)}`;
    console.warn(colored);
    this.writeToFile(plain);
  }

  error(message: string): void {
    const timestamp = this.getTimestamp();
    const plain = `[${timestamp}] [ERROR] [${this.name}] ${message}`;
    const colored = `${chalk.gray(`[${timestamp}]`)} ${chalk.red("[ERROR]")} ${chalk.cyan(`[${this.name}]`)} ${chalk.red(message)}`;
    console.error(colored);
    this.writeToFile(plain);
  }

  debug(message: string): void {
    if (!process.env.VERBOSE) {
      return;
    }
    const timestamp = this.getTimestamp();
    const plain = `[${timestamp}] [DEBUG] [${this.name}] ${message}`;
    const colored = `${chalk.gray(`[${timestamp}]`)} ${chalk.magenta("[DEBUG]")} ${chalk.cyan(`[${this.name}]`)} ${chalk.gray(message)}`;
    console.log(colored);
    this.writeToFile(plain);
  }

  private getTimestamp(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  private writeToFile(line: string): void {
    // Don't write to closed stream
    if (this.closed) return;
    // H-1: redact likely secrets before persisting to disk. Console output
    // stays unredacted so interactive debugging isn't hindered.
    this.logStream.write(redactSecrets(line) + "\n");
  }
}

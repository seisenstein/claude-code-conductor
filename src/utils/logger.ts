import fs from "fs";
import path from "path";
import chalk from "chalk";

export class Logger {
  private name: string;
  private logFilePath: string;
  private logStream: fs.WriteStream;

  constructor(logDir: string, name: string) {
    this.name = name;

    // Ensure the log directory exists with secure permissions (owner-only)
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });

    this.logFilePath = path.join(logDir, `${name}.log`);
    // Use mode 0o600 for owner-only read/write access (security requirement #15)
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: "a", mode: 0o600 });
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
    this.logStream.write(line + "\n");
  }
}

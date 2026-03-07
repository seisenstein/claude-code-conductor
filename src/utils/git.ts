import { simpleGit, SimpleGit } from "simple-git";
import { GIT_CHECKPOINT_PREFIX } from "./constants.js";

export class GitManager {
  private git: SimpleGit;

  constructor(projectDir: string) {
    this.git = simpleGit(projectDir);
  }

  /**
   * Create a new branch from the current HEAD.
   */
  async createBranch(name: string): Promise<void> {
    await this.git.checkoutLocalBranch(name);
  }

  /**
   * Checkout an existing branch.
   */
  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  /**
   * Get the name of the currently checked-out branch.
   */
  async getCurrentBranch(): Promise<string> {
    const result = await this.git.revparse(["--abbrev-ref", "HEAD"]);
    return result.trim();
  }

  /**
   * Get the full SHA of the current HEAD commit.
   */
  async getHeadSha(): Promise<string> {
    const result = await this.git.revparse(["HEAD"]);
    return result.trim();
  }

  /**
   * Check if the repository is in a detached HEAD state.
   */
  async isDetachedHead(): Promise<boolean> {
    const branch = await this.getCurrentBranch();
    return branch === "HEAD";
  }

  /**
   * Create a checkpoint commit: stage all changes and commit with
   * a checkpoint-prefixed tag message.
   *
   * @throws Error if repository is in detached HEAD state
   */
  async checkpoint(tag: string): Promise<void> {
    // Check for detached HEAD state before attempting checkpoint
    if (await this.isDetachedHead()) {
      throw new Error(
        "Cannot create checkpoint: repository is in detached HEAD state. " +
        "Please checkout a branch before creating a checkpoint."
      );
    }

    await this.git.add("-A");
    await this.git.commit(`${GIT_CHECKPOINT_PREFIX}${tag}`);
  }

  /**
   * Stage all changes and commit with the given message.
   */
  async commit(message: string): Promise<void> {
    await this.git.add("-A");
    await this.git.commit(message);
  }

  /**
   * Get the diff from a base branch to the current HEAD.
   * Returns the full diff output as a string.
   */
  async getDiff(base: string): Promise<string> {
    return await this.git.diff([`${base}...HEAD`]);
  }

  /**
   * Get the list of files changed between a base branch and HEAD.
   */
  async getChangedFiles(base: string): Promise<string[]> {
    const result = await this.git.diff(["--name-only", `${base}...HEAD`]);
    return result
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }

  /**
   * Pull with rebase from the remote tracking branch.
   */
  async pullRebase(): Promise<void> {
    await this.git.pull(["--rebase"]);
  }

  /**
   * Get line-level diff statistics from the base commit to HEAD.
   * Returns total additions and deletions.
   */
  async diffStatFromBase(): Promise<{ additions: number; deletions: number }> {
    const result = await this.git.diff(["--shortstat", "HEAD"]);
    let additions = 0;
    let deletions = 0;
    const addMatch = result.match(/(\d+) insertion/);
    const delMatch = result.match(/(\d+) deletion/);
    if (addMatch) additions = parseInt(addMatch[1], 10);
    if (delMatch) deletions = parseInt(delMatch[1], 10);
    return { additions, deletions };
  }

  /**
   * Get recent commit messages.
   * Returns array of commit messages for the last `maxCount` commits.
   */
  async getRecentCommits(maxCount: number = 10): Promise<string[]> {
    try {
      const result = await this.git.log({ maxCount });
      return result.all.map((commit) => commit.message);
    } catch {
      return [];
    }
  }
}

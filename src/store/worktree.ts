import { execFile } from "node:child_process";
import { access, lstat, mkdir, readdir, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_SWARM_SETTINGS,
  SWARM_DIR,
  SWARM_MAX_DIFF_BYTES,
} from "../constants.js";
import {
  SwarmProtocolError,
  type AutoRebaseResult,
  type BaseBranchCleanCheck,
  type CreateWorktreeResult,
  type DiffSummary,
  type IWorktreeManager,
  type MergeBranchResult,
  type RepoReadyResult,
  type SafeTeardownResult,
  type SafeTeardownTarget,
  type TeardownEntryResult,
} from "../types.js";
import { normalizeRelativeRepoPath } from "./swarm-store.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const RM_RETRY_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"]);
const UNMERGED_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export interface WorktreeManagerOptions {
  gitTimeoutMs?: number;
}

interface GitExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeDirectoryWithRetry(
  targetPath: string,
  maxAttempts = 5,
): Promise<void> {
  let delayMs = 40;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return;
      }
      if (!code || !RM_RETRY_CODES.has(code) || attempt === maxAttempts) {
        throw err;
      }
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  const suffix = `\n... [diff truncated at ${maxBytes} bytes]\n`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const sliceLen = Math.max(0, maxBytes - suffixBytes);
  // Decode cleanly without breaking multi-byte UTF-8 sequences at boundary.
  let end = sliceLen;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${buf.subarray(0, end).toString("utf8")}${suffix}`;
}

/**
 * Parse `git status --porcelain=v1 -z -uall` output into normalized repo-relative paths.
 */
function parsePorcelainZPaths(output: string): string[] {
  const files: string[] = [];
  const tokens = output.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    i += 1;
    if (!token || token.length < 4) {
      continue;
    }
    const x = token[0];
    const y = token[1];
    const rawPath = token.slice(3);
    const normalized = normalizeRelativeRepoPath(rawPath);
    if (normalized) {
      files.push(normalized);
    }
    // Rename ('R') or Copy ('C') entries emit a second NUL-terminated original path.
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const origPath = tokens[i];
      i += 1;
      if (origPath) {
        const normalizedOrig = normalizeRelativeRepoPath(origPath);
        if (normalizedOrig) {
          files.push(normalizedOrig);
        }
      }
    }
  }
  return files;
}

function parsePorcelainUnmergedPaths(output: string): string[] {
  const files: string[] = [];
  for (const rawLine of output.split("\n")) {
    if (rawLine.length < 4) continue;
    const xy = rawLine.slice(0, 2);
    if (UNMERGED_STATUS_CODES.has(xy)) {
      const normalized = normalizeRelativeRepoPath(rawLine.slice(3));
      if (normalized) {
        files.push(normalized);
      }
    }
  }
  return files;
}

export class WorktreeManager implements IWorktreeManager {
  readonly repoRoot: string;
  private gitTimeoutMs: number;
  private readonly identityOverrideCache = new Map<string, string[]>();

  constructor(repoRoot: string, options?: WorktreeManagerOptions) {
    this.repoRoot = path.resolve(repoRoot);
    this.gitTimeoutMs = Math.max(
      1_000,
      Math.floor(options?.gitTimeoutMs ?? DEFAULT_SWARM_SETTINGS.gitTimeoutMs),
    );
  }

  setGitTimeoutMs(timeoutMs: number): void {
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      this.gitTimeoutMs = Math.max(1, Math.floor(timeoutMs));
    }
  }

  private async runGit(
    args: string[],
    options?: {
      cwd?: string;
      timeoutMs?: number;
      allowFailure?: boolean;
      maxBuffer?: number;
    },
  ): Promise<GitExecResult> {
    const cwd = options?.cwd ? path.resolve(options.cwd) : this.repoRoot;
    const timeout = options?.timeoutMs ?? this.gitTimeoutMs;
    const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;

    const gitArgs = ["-c", "core.quotePath=false", ...args];

    try {
      const { stdout, stderr } = await execFileAsync("git", gitArgs, {
        cwd,
        timeout,
        maxBuffer,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
      });
      return { ok: true, exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as Error & {
        code?: number | string;
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
      };
      const stdout = typeof e.stdout === "string" ? e.stdout : "";
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      const exitCode = typeof e.code === "number" ? e.code : 1;

      if (options?.allowFailure && !e.killed) {
        return { ok: false, exitCode, stdout, stderr };
      }

      const detail = stderr.trim() || e.message || "unknown git failure";
      const reason = e.killed
        ? `git ${args.join(" ")} timed out after ${timeout}ms`
        : `git ${args.join(" ")} failed: ${detail}`;

      throw new SwarmProtocolError("GIT_ERROR", reason, {
        args,
        cwd,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut: Boolean(e.killed),
      });
    }
  }

  private async getIdentityOverrideArgs(cwd: string): Promise<string[]> {
    const cacheKey = path.resolve(cwd);
    const cached = this.identityOverrideCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const [nameRes, emailRes] = await Promise.all([
      this.runGit(["config", "--get", "user.name"], {
        cwd,
        allowFailure: true,
      }),
      this.runGit(["config", "--get", "user.email"], {
        cwd,
        allowFailure: true,
      }),
    ]);
    const extra: string[] = [];
    if (!nameRes.ok || !nameRes.stdout.trim()) {
      extra.push("-c", "user.name=pi-swarm");
    }
    if (!emailRes.ok || !emailRes.stdout.trim()) {
      extra.push("-c", "user.email=pi-swarm@local");
    }
    this.identityOverrideCache.set(cacheKey, extra);
    return extra;
  }

  private async branchExists(branch: string, cwd?: string): Promise<boolean> {
    const res = await this.runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd, allowFailure: true },
    );
    return res.ok;
  }

  async deleteBranch(branch: string): Promise<boolean> {
    if (!(await this.branchExists(branch))) {
      return false;
    }
    const res = await this.runGit(["branch", "-D", "--", branch], {
      allowFailure: true,
    });
    return res.ok;
  }

  /**
   * Linked git worktrees have a `.git` file pointing back to the main repo;
   * isolated `branch` clones have their own standalone `.git` directory.
   */
  private async isIsolatedClone(dirPath: string): Promise<boolean> {
    try {
      const st = await lstat(path.join(path.resolve(dirPath), ".git"));
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  private async ensureSwarmExcluded(effectiveRepoRoot: string): Promise<void> {
    const commonDirRes = await this.runGit(["rev-parse", "--git-common-dir"], {
      cwd: effectiveRepoRoot,
    });
    const gitCommonDir = path.resolve(
      effectiveRepoRoot,
      commonDirRes.stdout.trim(),
    );
    const excludePath = path.join(gitCommonDir, "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });

    let existing = "";
    try {
      existing = await readFile(excludePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }

    const rootPattern = `${SWARM_DIR}/`;
    const nestedPattern = `**/${SWARM_DIR}/`;
    const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
    const missing: string[] = [];
    if (!lines.has(rootPattern) && !lines.has(SWARM_DIR)) {
      missing.push(rootPattern);
    }
    if (!lines.has(nestedPattern) && !lines.has(`**/${SWARM_DIR}`)) {
      missing.push(nestedPattern);
    }
    if (missing.length === 0) {
      return;
    }

    const prefix =
      existing.length === 0
        ? ""
        : existing.endsWith("\n")
          ? ""
          : "\n";
    const header = lines.has("# pi-swarm state & worktrees")
      ? ""
      : "# pi-swarm state & worktrees\n";
    const addition = `${prefix}${header}${missing.join("\n")}\n`;
    await writeFile(excludePath, `${existing}${addition}`, "utf8");
  }

  async ensureRepoReady(preferredBaseBranch?: string): Promise<RepoReadyResult> {
    const trimmedPreferred = preferredBaseBranch?.trim();
    if (trimmedPreferred === "HEAD") {
      throw new SwarmProtocolError(
        "WRONG_BRANCH",
        'Cannot use detached "HEAD" as base branch; check out or specify a named local branch (e.g. "main").',
        { preferredBaseBranch: trimmedPreferred },
      );
    }

    await mkdir(this.repoRoot, { recursive: true });

    let initializedRepo = false;
    let createdInitialCommit = false;
    let effectiveRoot = this.repoRoot;

    const insideCheck = await this.runGit(
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: this.repoRoot, allowFailure: true },
    );

    if (!insideCheck.ok || insideCheck.stdout.trim() !== "true") {
      const initBranch = preferredBaseBranch?.trim() || "main";
      const initRes = await this.runGit(["init", "-b", initBranch], {
        cwd: this.repoRoot,
        allowFailure: true,
      });
      if (!initRes.ok) {
        await this.runGit(["init"], { cwd: this.repoRoot });
        await this.runGit(
          ["symbolic-ref", "HEAD", `refs/heads/${initBranch}`],
          { cwd: this.repoRoot },
        );
      }
      initializedRepo = true;
    }

    const topLevelRes = await this.runGit(["rev-parse", "--show-toplevel"], {
      cwd: this.repoRoot,
    });
    effectiveRoot = path.resolve(topLevelRes.stdout.trim());

    const headCheck = await this.runGit(["rev-parse", "--verify", "HEAD"], {
      cwd: effectiveRoot,
      allowFailure: true,
    });
    if (!headCheck.ok) {
      if (preferredBaseBranch?.trim()) {
        await this.runGit(
          ["symbolic-ref", "HEAD", `refs/heads/${preferredBaseBranch.trim()}`],
          { cwd: effectiveRoot, allowFailure: true },
        );
      }
      const identityArgs = await this.getIdentityOverrideArgs(effectiveRoot);
      await this.runGit(
        [...identityArgs, "commit", "--allow-empty", "-m", "chore: initial commit"],
        { cwd: effectiveRoot },
      );
      createdInitialCommit = true;
    }

    await this.ensureSwarmExcluded(effectiveRoot);

    let baseBranch: string;
    if (preferredBaseBranch?.trim()) {
      const target = preferredBaseBranch.trim();
      if (target === "HEAD") {
        throw new SwarmProtocolError(
          "WRONG_BRANCH",
          'Cannot use detached "HEAD" as base branch; check out or specify a named local branch (e.g. "main").',
          { preferredBaseBranch: target },
        );
      }
      const exists = await this.branchExists(target, effectiveRoot);
      if (!exists) {
        throw new SwarmProtocolError(
          "WRONG_BRANCH",
          `Preferred base branch "${target}" does not exist locally.`,
          { preferredBaseBranch: target },
        );
      }
      baseBranch = target;
    } else {
      baseBranch = await this.getCurrentBranch(effectiveRoot);
      if (!baseBranch || baseBranch === "HEAD") {
        throw new SwarmProtocolError(
          "WRONG_BRANCH",
          'Repository is in detached HEAD state; check out a named local branch (e.g. "main") or pass an explicit baseBranch.',
          { currentBranch: baseBranch || "HEAD" },
        );
      }
    }

    const headShaRes = await this.runGit(["rev-parse", `refs/heads/${baseBranch}`], {
      cwd: effectiveRoot,
      allowFailure: true,
    });
    const headSha = headShaRes.ok
      ? headShaRes.stdout.trim()
      : await this.getHeadSha(effectiveRoot);

    return {
      repoRoot: effectiveRoot,
      baseBranch,
      headSha,
      initializedRepo,
      createdInitialCommit,
    };
  }

  async getCurrentBranch(cwd?: string): Promise<string> {
    const res = await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      allowFailure: true,
    });
    if (res.ok && res.stdout.trim()) {
      return res.stdout.trim();
    }
    const sym = await this.runGit(["symbolic-ref", "--short", "HEAD"], { cwd });
    return sym.stdout.trim();
  }

  async listLocalBranches(): Promise<string[]> {
    const res = await this.runGit([
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/",
    ]);
    return res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
  }

  async createWorktree(options: {
    branch: string;
    baseBranch: string;
    worktreePath: string;
    reuseExistingBranch?: boolean;
    mode?: "share" | "branch";
  }): Promise<CreateWorktreeResult> {
    const resolvedWorktree = await this.assertSafeWorktreeTarget(
      options.worktreePath,
    );
    await mkdir(path.dirname(resolvedWorktree), { recursive: true });

    const baseShaRes = await this.runGit([
      "rev-parse",
      "--verify",
      options.baseBranch,
    ]);
    const baseSha = baseShaRes.stdout.trim();

    const mode = options.mode ?? "share";
    const exists = await this.branchExists(options.branch);
    if (exists && !options.reuseExistingBranch) {
      throw new SwarmProtocolError(
        "GIT_ERROR",
        `Branch "${options.branch}" already exists in repository.`,
        { branch: options.branch },
      );
    }

    if (mode === "branch") {
      if (await pathExists(resolvedWorktree)) {
        const isClone = await this.isIsolatedClone(resolvedWorktree);
        if (options.reuseExistingBranch && isClone) {
          const currentBranch = await this.getCurrentBranch(resolvedWorktree).catch(
            () => "",
          );
          if (currentBranch === options.branch) {
            return {
              branch: options.branch,
              worktreePath: resolvedWorktree,
              baseSha,
            };
          }
          if (currentBranch) {
            throw new SwarmProtocolError(
              "WRONG_BRANCH",
              `Existing clone "${resolvedWorktree}" is on branch "${currentBranch}", expected "${options.branch}".`,
              {
                worktreePath: resolvedWorktree,
                currentBranch,
                expectedBranch: options.branch,
              },
            );
          }
        }
        if (!options.reuseExistingBranch) {
          throw new SwarmProtocolError(
            "GIT_ERROR",
            `Clone directory "${resolvedWorktree}" already exists.`,
            { worktreePath: resolvedWorktree },
          );
        }
        if (await this.isWorktreeDirty(resolvedWorktree)) {
          throw new SwarmProtocolError(
            "DIRTY_WORKTREE",
            `Existing directory "${resolvedWorktree}" has uncommitted changes or files.`,
            { worktreePath: resolvedWorktree },
          );
        }
        await removeDirectoryWithRetry(resolvedWorktree);
      }

      const cloneBranch =
        exists && options.reuseExistingBranch ? options.branch : options.baseBranch;
      const topLevel = (
        await this.runGit(["rev-parse", "--show-toplevel"])
      ).stdout.trim();
      await this.runGit([
        "clone",
        "--branch",
        cloneBranch,
        topLevel,
        resolvedWorktree,
      ]);

      const cloneBranchExists = await this.branchExists(
        options.branch,
        resolvedWorktree,
      );
      if (cloneBranchExists) {
        await this.runGit(["checkout", options.branch], {
          cwd: resolvedWorktree,
        });
      } else {
        const remoteRef = `refs/remotes/origin/${options.branch}`;
        const remoteExistsRes = await this.runGit(
          ["show-ref", "--verify", "--quiet", remoteRef],
          { cwd: resolvedWorktree, allowFailure: true },
        );
        if (remoteExistsRes.ok) {
          await this.runGit(["checkout", "-B", options.branch, remoteRef], {
            cwd: resolvedWorktree,
          });
        } else {
          await this.runGit(["checkout", "-b", options.branch], {
            cwd: resolvedWorktree,
          });
        }
      }

      await this.ensureSwarmExcluded(resolvedWorktree).catch(() => {});

      return {
        branch: options.branch,
        worktreePath: resolvedWorktree,
        baseSha,
      };
    }

    if (exists && options.reuseExistingBranch) {
      if (await pathExists(resolvedWorktree)) {
        const insideRes = await this.runGit(
          ["rev-parse", "--is-inside-work-tree"],
          { cwd: resolvedWorktree, allowFailure: true },
        );
        if (insideRes.ok && insideRes.stdout.trim() === "true") {
          const topRes = await this.runGit(["rev-parse", "--show-toplevel"], {
            cwd: resolvedWorktree,
            allowFailure: true,
          });
          if (topRes.ok && topRes.stdout.trim()) {
            const [realWorktree, realTop] = await Promise.all([
              realpath(resolvedWorktree).catch(() => resolvedWorktree),
              realpath(topRes.stdout.trim()).catch(() =>
                path.resolve(topRes.stdout.trim()),
              ),
            ]);
            if (realWorktree === realTop) {
              const currentBranch = await this.getCurrentBranch(resolvedWorktree);
              if (currentBranch === options.branch) {
                return {
                  branch: options.branch,
                  worktreePath: resolvedWorktree,
                  baseSha,
                };
              }
              throw new SwarmProtocolError(
                "WRONG_BRANCH",
                `Existing worktree "${resolvedWorktree}" is on branch "${currentBranch}", expected "${options.branch}".`,
                {
                  worktreePath: resolvedWorktree,
                  currentBranch,
                  expectedBranch: options.branch,
                },
              );
            }
          }
        }
        const emptyCheck = await readdir(resolvedWorktree).catch(() => null);
        if (emptyCheck && emptyCheck.length === 0) {
          await removeDirectoryWithRetry(resolvedWorktree);
        }
      }
      await this.runGit(["worktree", "prune"], { allowFailure: true });
      await this.runGit(["worktree", "add", resolvedWorktree, options.branch]);
    } else {
      if (await pathExists(resolvedWorktree)) {
        const emptyCheck = await readdir(resolvedWorktree).catch(() => null);
        if (emptyCheck && emptyCheck.length === 0) {
          await removeDirectoryWithRetry(resolvedWorktree);
        }
      }
      await this.runGit([
        "worktree",
        "add",
        "-b",
        options.branch,
        resolvedWorktree,
        options.baseBranch,
      ]);
    }

    return {
      branch: options.branch,
      worktreePath: resolvedWorktree,
      baseSha,
    };
  }

  private async resolveRealWorktreePath(targetPath: string): Promise<string> {
    const resolved = path.resolve(targetPath);
    const missingSegments: string[] = [];
    let curr = resolved;
    while (!(await pathExists(curr))) {
      const parent = path.dirname(curr);
      if (parent === curr) {
        break;
      }
      missingSegments.unshift(path.basename(curr));
      curr = parent;
    }
    const realAncestor = await realpath(curr).catch(() => curr);
    return missingSegments.length > 0
      ? path.join(realAncestor, ...missingSegments)
      : realAncestor;
  }

  /**
   * Ensure destructive worktree/clone removal can never target `this.repoRoot`
   * or any path outside `<repoRoot>/.pi/swarm/worktrees/`.
   */
  private async assertSafeWorktreeTarget(worktreePath: string): Promise<string> {
    const resolvedRepo = path.resolve(this.repoRoot);
    const resolved = path.resolve(worktreePath);
    const realRepo = await realpath(this.repoRoot).catch(() => resolvedRepo);
    const realWorktreesRoot = path.join(realRepo, SWARM_DIR, "worktrees");
    const realTarget = await this.resolveRealWorktreePath(resolved);
    const rel = path.relative(realWorktreesRoot, realTarget);
    if (
      realTarget === realRepo ||
      realTarget === realWorktreesRoot ||
      rel === "" ||
      rel.startsWith("..") ||
      path.isAbsolute(rel)
    ) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Refusing to remove worktree path outside ${SWARM_DIR}/worktrees: ${resolved}`,
        { worktreePath: resolved },
      );
    }

    // Walk every path component strictly inside repoRoot (from .pi down through resolved)
    // so symlinks inside .pi/swarm/worktrees or resolved itself are rejected.
    let curr = resolved;
    while (curr !== resolvedRepo && curr !== realRepo) {
      const parent = path.dirname(curr);
      if (parent === curr) {
        break;
      }
      try {
        const st = await lstat(curr);
        if (st.isSymbolicLink()) {
          throw new SwarmProtocolError(
            "PERMISSION_DENIED",
            `Refusing to traverse symlinked worktree path: ${curr}`,
            { worktreePath: resolved, symlinkPath: curr },
          );
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
      }
      const realParent = await realpath(parent).catch(() => parent);
      if (realParent === realRepo) {
        break;
      }
      curr = parent;
    }

    return resolved;
  }

  async removeWorktree(
    worktreePath: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const resolvedWorktree = await this.assertSafeWorktreeTarget(worktreePath);
    const force = Boolean(options?.force);

    if (!force && (await this.isWorktreeDirty(resolvedWorktree))) {
      throw new SwarmProtocolError(
        "DIRTY_WORKTREE",
        `Worktree "${resolvedWorktree}" has uncommitted changes.`,
        { worktreePath: resolvedWorktree },
      );
    }

    if (await this.isIsolatedClone(resolvedWorktree)) {
      await removeDirectoryWithRetry(resolvedWorktree);
      await rmdir(path.dirname(resolvedWorktree)).catch(() => {});
      return;
    }

    const args = force
      ? ["worktree", "remove", "--force", resolvedWorktree]
      : ["worktree", "remove", resolvedWorktree];

    const res = await this.runGit(args, { allowFailure: force });
    if (!res.ok && force) {
      // Fall back to direct removal + prune when directory exists or was partially removed.
      if (await pathExists(resolvedWorktree)) {
        await removeDirectoryWithRetry(resolvedWorktree);
      }
    } else if (await pathExists(resolvedWorktree)) {
      // Handle lingering empty directories or transient ENOTEMPTY on macOS/Linux.
      await removeDirectoryWithRetry(resolvedWorktree);
    }

    await rmdir(path.dirname(resolvedWorktree)).catch(() => {});
    await this.runGit(["worktree", "prune"], { allowFailure: true });
  }

  async getHeadSha(cwd?: string): Promise<string> {
    const res = await this.runGit(["rev-parse", "HEAD"], { cwd });
    return res.stdout.trim();
  }

  async getCommitCountAhead(
    baseBranch: string,
    targetRef: string,
    cwd?: string,
  ): Promise<number> {
    const res = await this.runGit(
      ["rev-list", "--count", `${baseBranch}..${targetRef}`],
      { cwd },
    );
    const parsed = Number.parseInt(res.stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async getChangedFiles(
    baseBranch: string,
    targetRef: string,
    cwd?: string,
  ): Promise<string[]> {
    const files = new Set<string>();

    // Committed changes between merge-base(baseBranch, targetRef) and targetRef.
    const diffRes = await this.runGit(
      ["diff", "--name-only", `${baseBranch}...${targetRef}`],
      { cwd, allowFailure: true },
    );
    const committedOutput = diffRes.ok
      ? diffRes.stdout
      : (
          await this.runGit(
            ["diff", "--name-only", `${baseBranch}..${targetRef}`],
            { cwd },
          )
        ).stdout;

    for (const rawLine of committedOutput.split(/\r?\n/)) {
      const normalized = normalizeRelativeRepoPath(rawLine);
      if (normalized) {
        files.add(normalized);
      }
    }

    // When inspecting an explicit worktree directory at HEAD (or its checked-out branch),
    // also include uncommitted modified/staged/untracked files.
    if (cwd) {
      let includeWorkingTree = targetRef === "HEAD";
      if (!includeWorkingTree) {
        const currentBranch = await this.getCurrentBranch(cwd).catch(() => "");
        if (currentBranch && currentBranch === targetRef) {
          includeWorkingTree = true;
        }
      }
      if (includeWorkingTree) {
        const statusRes = await this.runGit(
          ["status", "--porcelain=v1", "-z", "-uall"],
          { cwd, allowFailure: true },
        );
        if (statusRes.ok && statusRes.stdout.length > 0) {
          for (const dirtyPath of parsePorcelainZPaths(statusRes.stdout)) {
            files.add(dirtyPath);
          }
        }
      }
    }

    return [...files].sort();
  }

  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    const resolved = path.resolve(worktreePath);
    if (!(await pathExists(resolved))) {
      return false;
    }
    const realRepo = await realpath(this.repoRoot).catch(() => path.resolve(this.repoRoot));
    const realTarget = await realpath(resolved).catch(() => resolved);
    if (realTarget !== realRepo) {
      // Never walk up to repoRoot/.git when a member worktree lacks its own .git entry.
      if (!(await pathExists(path.join(realTarget, ".git")))) {
        const entries = await readdir(realTarget);
        return entries.length > 0;
      }
      const topRes = await this.runGit(["rev-parse", "--show-toplevel"], {
        cwd: realTarget,
        allowFailure: true,
      });
      if (!topRes.ok || !topRes.stdout.trim()) {
        return true;
      }
      const realTop = await realpath(topRes.stdout.trim()).catch(() =>
        path.resolve(topRes.stdout.trim()),
      );
      if (realTop !== realTarget) {
        return true;
      }
    }
    const res = await this.runGit(
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: resolved },
    );
    return res.stdout.trim().length > 0;
  }

  async isBaseCleanOnBranch(
    expectedBranch: string,
  ): Promise<BaseBranchCleanCheck> {
    const currentBranch = await this.getCurrentBranch(this.repoRoot);
    const dirty = await this.isWorktreeDirty(this.repoRoot);

    if (currentBranch !== expectedBranch) {
      return {
        ok: false,
        currentBranch,
        dirty,
        reason: `Base repository is on branch "${currentBranch}", expected "${expectedBranch}".`,
      };
    }
    if (dirty) {
      return {
        ok: false,
        currentBranch,
        dirty,
        reason: `Base repository on "${expectedBranch}" has uncommitted changes.`,
      };
    }
    return {
      ok: true,
      currentBranch,
      dirty: false,
    };
  }

  async autoRebase(
    worktreePath: string,
    baseBranch: string,
  ): Promise<AutoRebaseResult> {
    const resolved = path.resolve(worktreePath);

    if (await this.isWorktreeDirty(resolved)) {
      return {
        status: "skipped_dirty",
        message: `Worktree "${resolved}" has uncommitted changes; skipping auto-rebase.`,
      };
    }

    let rebaseTarget = baseBranch;
    if (await this.isIsolatedClone(resolved)) {
      const fetchRes = await this.runGit(
        ["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
        { cwd: resolved, allowFailure: true },
      );
      if (fetchRes.ok) {
        rebaseTarget = `origin/${baseBranch}`;
      }
    }

    // Check if rebaseTarget is already an ancestor of HEAD.
    const ancestorRes = await this.runGit(
      ["merge-base", "--is-ancestor", rebaseTarget, "HEAD"],
      { cwd: resolved, allowFailure: true },
    );
    if (ancestorRes.ok) {
      return {
        status: "up-to-date",
        newHeadSha: await this.getHeadSha(resolved),
      };
    }

    const identityArgs = await this.getIdentityOverrideArgs(resolved);
    const rebaseRes = await this.runGit(
      [...identityArgs, "rebase", rebaseTarget],
      { cwd: resolved, allowFailure: true },
    );

    if (rebaseRes.ok) {
      return {
        status: "rebased",
        newHeadSha: await this.getHeadSha(resolved),
      };
    }

    // Collect conflicting files before aborting so caller receives actionable diagnostics.
    const conflictSet = new Set<string>();
    const unmergedDiff = await this.runGit(
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd: resolved, allowFailure: true },
    );
    if (unmergedDiff.ok) {
      for (const line of unmergedDiff.stdout.split(/\r?\n/)) {
        const normalized = normalizeRelativeRepoPath(line);
        if (normalized) conflictSet.add(normalized);
      }
    }
    if (conflictSet.size === 0) {
      const statusRes = await this.runGit(["status", "--porcelain"], {
        cwd: resolved,
        allowFailure: true,
      });
      if (statusRes.ok) {
        for (const f of parsePorcelainUnmergedPaths(statusRes.stdout)) {
          conflictSet.add(f);
        }
      }
    }

    // Always abort cleanly so the worktree is never left stuck mid-rebase.
    await this.runGit(["rebase", "--abort"], {
      cwd: resolved,
      allowFailure: true,
    });

    const conflictFiles = [...conflictSet].sort();
    return {
      status: "conflict",
      conflictFiles,
      message:
        conflictFiles.length > 0
          ? `Rebase onto "${baseBranch}" conflicted in: ${conflictFiles.join(", ")}`
          : `Rebase onto "${baseBranch}" failed and was aborted cleanly: ${(rebaseRes.stderr || rebaseRes.stdout).trim()}`,
    };
  }

  async mergeBranch(options: {
    baseBranch: string;
    branch: string;
    commitMessage?: string;
    noFf?: boolean;
    sourceWorktreePath?: string;
  }): Promise<MergeBranchResult> {
    const baseCheck = await this.isBaseCleanOnBranch(options.baseBranch);
    if (baseCheck.currentBranch !== options.baseBranch) {
      throw new SwarmProtocolError(
        "WRONG_BRANCH",
        baseCheck.reason ??
          `Base repository is on "${baseCheck.currentBranch}", expected "${options.baseBranch}".`,
        {
          expectedBranch: options.baseBranch,
          currentBranch: baseCheck.currentBranch,
        },
      );
    }
    if (baseCheck.dirty) {
      throw new SwarmProtocolError(
        "DIRTY_BASE",
        baseCheck.reason ??
          `Base repository on "${options.baseBranch}" has uncommitted changes.`,
        { baseBranch: options.baseBranch },
      );
    }

    if (options.sourceWorktreePath) {
      await this.fetchBranchFromClone(options.sourceWorktreePath, options.branch);
    }

    const commitsAhead = await this.getCommitCountAhead(
      options.baseBranch,
      options.branch,
    );

    if (commitsAhead === 0) {
      return {
        mergedCommitSha: await this.getHeadSha(this.repoRoot),
        strategy: "noop",
        changedFiles: [],
      };
    }

    const changedFiles = await this.getChangedFiles(
      options.baseBranch,
      options.branch,
    );

    const branchTipSha = (
      await this.runGit(["rev-parse", options.branch])
    ).stdout.trim();
    const useNoFf = options.noFf !== false;
    const message =
      options.commitMessage?.trim() ||
      `swarm: merge ${options.branch} into ${options.baseBranch}`;
    const identityArgs = await this.getIdentityOverrideArgs(this.repoRoot);

    const mergeArgs = useNoFf
      ? [...identityArgs, "merge", "--no-ff", "-m", message, options.branch]
      : [...identityArgs, "merge", "-m", message, options.branch];

    const mergeRes = await this.runGit(mergeArgs, { allowFailure: true });
    if (!mergeRes.ok) {
      const conflictSet = new Set<string>();
      const unmergedDiff = await this.runGit(
        ["diff", "--name-only", "--diff-filter=U"],
        { allowFailure: true },
      );
      if (unmergedDiff.ok) {
        for (const line of unmergedDiff.stdout.split(/\r?\n/)) {
          const normalized = normalizeRelativeRepoPath(line);
          if (normalized) conflictSet.add(normalized);
        }
      }
      await this.runGit(["merge", "--abort"], { allowFailure: true });

      const conflictFiles = [...conflictSet].sort();
      throw new SwarmProtocolError(
        "REBASE_CONFLICT",
        conflictFiles.length > 0
          ? `Merge conflict merging "${options.branch}" into "${options.baseBranch}": ${conflictFiles.join(", ")}`
          : `Failed to merge "${options.branch}" into "${options.baseBranch}": ${(mergeRes.stderr || mergeRes.stdout).trim()}`,
        {
          baseBranch: options.baseBranch,
          branch: options.branch,
          conflictFiles,
        },
      );
    }

    const mergedCommitSha = await this.getHeadSha(this.repoRoot);
    const strategy: MergeBranchResult["strategy"] =
      !useNoFf && mergedCommitSha === branchTipSha ? "fast-forward" : "merge";

    return {
      mergedCommitSha,
      strategy,
      changedFiles,
    };
  }

  async fetchBranchFromClone(
    sourceWorktreePath: string,
    branch: string,
  ): Promise<boolean> {
    const resolvedSource = path.resolve(sourceWorktreePath);
    if (!(await this.isIsolatedClone(resolvedSource))) {
      return false;
    }
    await this.runGit([
      "fetch",
      resolvedSource,
      `+refs/heads/${branch}:refs/heads/${branch}`,
    ]);
    return true;
  }

  async getDiffSummary(
    baseBranch: string,
    targetRef: string,
    options?: { maxDiffBytes?: number; cwd?: string },
  ): Promise<DiffSummary> {
    const requestedCwd = options?.cwd ? path.resolve(options.cwd) : undefined;
    const cwd =
      requestedCwd && (await pathExists(requestedCwd)) ? requestedCwd : undefined;
    const maxDiffBytes = options?.maxDiffBytes ?? SWARM_MAX_DIFF_BYTES;

    let compareBase = baseBranch;
    if (cwd && (await this.isIsolatedClone(cwd))) {
      const fetchRes = await this.runGit(
        ["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
        { cwd, allowFailure: true },
      );
      if (fetchRes.ok) {
        compareBase = `origin/${baseBranch}`;
      }
    }

    const headSha = (
      await this.runGit(["rev-parse", targetRef], { cwd })
    ).stdout.trim();
    const commitsAhead = await this.getCommitCountAhead(
      compareBase,
      targetRef,
      cwd,
    );
    const changedFiles = await this.getChangedFiles(compareBase, targetRef, cwd);

    let diffRange = `${compareBase}...${targetRef}`;
    if (cwd) {
      const currentBranch = await this.getCurrentBranch(cwd).catch(() => "");
      if (targetRef === "HEAD" || (currentBranch && currentBranch === targetRef)) {
        const mbRes = await this.runGit(["merge-base", compareBase, "HEAD"], {
          cwd,
          allowFailure: true,
        });
        diffRange =
          mbRes.ok && mbRes.stdout.trim() ? mbRes.stdout.trim() : compareBase;
      }
    }

    const statRes = await this.runGit(
      ["diff", "--stat", diffRange],
      { cwd, allowFailure: true },
    );
    const stat = (statRes.ok ? statRes.stdout : "").trim();

    const diffRes = await this.runGit(
      ["diff", diffRange],
      {
        cwd,
        allowFailure: true,
        maxBuffer: Math.max(maxDiffBytes * 2, DEFAULT_MAX_BUFFER),
      },
    );
    const rawDiff = diffRes.ok ? diffRes.stdout : "";
    const diff = truncateUtf8Bytes(rawDiff, maxDiffBytes);

    return {
      baseBranch,
      branch: targetRef,
      headSha,
      commitsAhead,
      changedFiles,
      stat,
      diff,
    };
  }

  async safeTeardown(
    targets: SafeTeardownTarget[],
    options?: { deleteBranches?: boolean; force?: boolean },
  ): Promise<SafeTeardownResult> {
    const removed: TeardownEntryResult[] = [];
    const skipped: TeardownEntryResult[] = [];
    const errors: TeardownEntryResult[] = [];
    const deleteBranches = Boolean(options?.deleteBranches);
    const force = Boolean(options?.force);

    for (const target of targets) {
      const resolvedPath = path.resolve(target.worktreePath);
      try {
        if (target.hasActiveAgent) {
          skipped.push({
            memberName: target.memberName,
            worktreePath: resolvedPath,
            branch: target.branch,
            action: "skipped_active",
            reason: "Member has an active running agent.",
          });
          continue;
        }

        await this.assertSafeWorktreeTarget(resolvedPath);

        if (!(await pathExists(resolvedPath))) {
          if (
            deleteBranches &&
            target.branch &&
            (await this.branchExists(target.branch))
          ) {
            const delRes = await this.runGit(
              ["branch", "-D", "--", target.branch],
              { allowFailure: true },
            );
            if (!delRes.ok && (await this.branchExists(target.branch))) {
              errors.push({
                memberName: target.memberName,
                worktreePath: resolvedPath,
                branch: target.branch,
                action: "error",
                reason:
                  (delRes.stderr || delRes.stdout).trim() ||
                  `Failed to delete branch "${target.branch}".`,
              });
              continue;
            }
            removed.push({
              memberName: target.memberName,
              worktreePath: resolvedPath,
              branch: target.branch,
              action: "removed",
              reason: "Worktree directory already removed; deleted branch.",
            });
            continue;
          }
          skipped.push({
            memberName: target.memberName,
            worktreePath: resolvedPath,
            branch: target.branch,
            action: "missing",
            reason: "Worktree directory does not exist.",
          });
          continue;
        }

        const dirty = await this.isWorktreeDirty(resolvedPath);
        if (dirty && !force) {
          skipped.push({
            memberName: target.memberName,
            worktreePath: resolvedPath,
            branch: target.branch,
            action: "skipped_dirty",
            reason:
              "Worktree has uncommitted changes; preserved to avoid data loss.",
          });
          continue;
        }

        // Preserve committed branches from isolated `branch` clones before removing dir when keeping branches.
        if (!deleteBranches && target.branch) {
          if (dirty || force) {
            await this.fetchBranchFromClone(resolvedPath, target.branch).catch(() => {});
          } else {
            await this.fetchBranchFromClone(resolvedPath, target.branch);
          }
        }

        // Deregister worktree BEFORE any branch operations.
        await this.removeWorktree(resolvedPath, { force: true });

        if (deleteBranches && target.branch) {
          const delRes = await this.runGit(
            ["branch", "-D", "--", target.branch],
            { allowFailure: true },
          );
          if (!delRes.ok && (await this.branchExists(target.branch))) {
            errors.push({
              memberName: target.memberName,
              worktreePath: resolvedPath,
              branch: target.branch,
              action: "error",
              reason:
                (delRes.stderr || delRes.stdout).trim() ||
                `Worktree removed, but failed to delete branch "${target.branch}".`,
            });
            continue;
          }
        }

        removed.push({
          memberName: target.memberName,
          worktreePath: resolvedPath,
          branch: target.branch,
          action: "removed",
          ...(dirty && force ? { reason: "Force-removed dirty worktree" } : {}),
        });
      } catch (err) {
        errors.push({
          memberName: target.memberName,
          worktreePath: resolvedPath,
          branch: target.branch,
          action: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.runGit(["worktree", "prune"], { allowFailure: true });
    return { removed, skipped, errors };
  }
}

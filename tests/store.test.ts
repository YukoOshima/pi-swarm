import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  SWARM_DIR,
  SWARM_RUNS_DIR,
  SWARM_SETTINGS_FILE,
  SWARM_STATE_FILE,
} from "../src/constants.js";
import { SwarmBoard, filterMentions, parseMentions } from "../src/store/board.js";
import { SwarmStore } from "../src/store/swarm-store.js";
import { WorktreeManager } from "../src/store/worktree.js";
import type { SwarmMilestone } from "../src/types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return stdout.trim();
}

async function initPlainRepo(repoDir: string): Promise<void> {
  await git(repoDir, ["init", "-b", "main"]);
  await writeFile(path.join(repoDir, "app.txt"), "initial\n", "utf8");
  await git(repoDir, ["add", "app.txt"]);
  await git(repoDir, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "initial commit",
  ]);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

describe("SwarmStore v0.7.0 contract fields (phase, milestones, turnStartedAt, llmTurns)", () => {
  it("persists and reloads phase, milestones, turnStartedAt, and llmTurns cleanly", async () => {
    const root = await makeTempDir("pi-swarm-store-contract-");
    const store = new SwarmStore(root);

    const initialMilestones: SwarmMilestone[] = [
      { label: "Design contract", status: "done", owner: "architect" },
      { label: "Implement store fixes", status: "in_progress", owner: "coder" },
      { label: "Verify tests", status: "pending" },
    ];

    const created = await store.createRun({
      id: "run-contract",
      title: "Store Contract",
      objective: "Verify v0.7.0 persistence fields",
      baseBranch: "main",
      ownerSessionId: "sess-1",
      phase: "wave-1",
      milestones: initialMilestones,
    });

    assert.equal(created.phase, "wave-1");
    assert.deepEqual(created.milestones, initialMilestones);

    const startedAt = "2026-11-23T06:00:00.000Z";
    await store.addMember("run-contract", {
      name: "coder",
      agentId: "agt-coder",
      role: "worker",
      parentName: "orchestrator",
      brief: "Implement fixes",
      workspace: "share",
      cwd: root,
      turnStartedAt: startedAt,
      llmTurns: 3,
    });

    // Reload from a brand new SwarmStore instance to bypass in-memory cache
    const freshStore = new SwarmStore(root);
    let loaded = await freshStore.loadRun("run-contract");
    assert.equal(loaded.phase, "wave-1");
    assert.deepEqual(loaded.milestones, initialMilestones);
    assert.equal(loaded.members.coder.turnStartedAt, startedAt);
    assert.equal(loaded.members.coder.llmTurns, 3);

    // Update phase, milestones, llmTurns, and turnStartedAt
    const updatedMilestones: SwarmMilestone[] = [
      { label: "Design contract", status: "done", owner: "architect" },
      { label: "Implement store fixes", status: "done", owner: "coder" },
      { label: "Verify tests", status: "blocked", owner: "checker" },
    ];
    await freshStore.updateRun("run-contract", {
      phase: "  wave-2  ",
      milestones: updatedMilestones,
    });
    const nextStartedAt = "2026-11-23T06:15:00.000Z";
    await freshStore.updateMember("run-contract", "coder", {
      turnStartedAt: nextStartedAt,
      llmTurns: 12.9,
    });

    const verifyStore = new SwarmStore(root);
    loaded = await verifyStore.loadRun("run-contract");
    assert.equal(loaded.phase, "wave-2");
    assert.deepEqual(loaded.milestones, updatedMilestones);
    assert.equal(loaded.members.coder.turnStartedAt, nextStartedAt);
    assert.equal(loaded.members.coder.llmTurns, 12);

    // Clearing optional fields via null removes them cleanly
    await verifyStore.updateRun("run-contract", {
      phase: null,
      milestones: null,
    });
    await verifyStore.updateMember("run-contract", "coder", {
      turnStartedAt: null,
    });

    const afterClearStore = new SwarmStore(root);
    loaded = await afterClearStore.loadRun("run-contract");
    assert.equal(loaded.phase, undefined);
    assert.equal(loaded.milestones, undefined);
    assert.equal(loaded.members.coder.turnStartedAt, undefined);
    assert.equal(loaded.members.coder.llmTurns, 12);
  });

  it("loads legacy state.json without new fields and normalizes malformed values safely", async () => {
    const root = await makeTempDir("pi-swarm-store-legacy-");
    const runDir = path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "run-legacy");
    await mkdir(runDir, { recursive: true });

    const now = "2026-11-23T05:00:00.000Z";
    const legacyState = {
      version: 2,
      id: "run-legacy",
      title: "Legacy Run",
      objective: "Pre-v0.7.0 persisted run",
      strategy: "",
      acceptanceCriteria: "",
      baseBranch: "main",
      ownerSessionId: "sess-old",
      ownerPid: 12345,
      status: "active",
      maxConcurrency: 4,
      validatorEnabled: true,
      keepWorkersWarm: true,
      roleModels: {},
      revision: 3,
      members: {
        worker: {
          name: "worker",
          agentId: "agt-1",
          role: "worker",
          state: "waiting",
          parentName: "orchestrator",
          brief: "Legacy worker",
          workspace: "inherit",
          cwd: root,
          channels: ["main"],
          lastReadSeq: 2,
          turns: 2,
          tokens: 1500,
          cost: 0.01,
          humanStopped: false,
          logTail: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      memberOrder: ["worker"],
      channels: {},
      boardHead: 2,
      createdAt: now,
      updatedAt: now,
    };

    const statePath = path.join(runDir, SWARM_STATE_FILE);
    await writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

    const store = new SwarmStore(root);
    const loadedLegacy = await store.loadRun("run-legacy");
    assert.equal(loadedLegacy.phase, undefined);
    assert.equal(loadedLegacy.milestones, undefined);
    assert.equal(loadedLegacy.members.worker.turnStartedAt, undefined);
    assert.equal(loadedLegacy.members.worker.llmTurns, undefined);

    // Malformed values in state.json should be normalized / stripped safely
    const malformedState = {
      ...legacyState,
      id: "run-malformed",
      phase: "   ",
      milestones: [
        { label: "  Valid step  ", status: "done", owner: "  worker  " },
        { label: "", status: "done" },
        { label: "Bad status", status: "unknown" },
        null,
        { label: "In progress step", status: "in_progress", owner: "   " },
      ],
      members: {
        worker: {
          ...legacyState.members.worker,
          turnStartedAt: "   ",
          llmTurns: -5,
        },
      },
    };
    const malformedDir = path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "run-malformed");
    await mkdir(malformedDir, { recursive: true });
    await writeFile(
      path.join(malformedDir, SWARM_STATE_FILE),
      `${JSON.stringify(malformedState, null, 2)}\n`,
      "utf8",
    );

    const loadedMalformed = await store.loadRun("run-malformed");
    assert.equal(loadedMalformed.phase, undefined);
    assert.deepEqual(loadedMalformed.milestones, [
      { label: "Valid step", status: "done", owner: "worker" },
      { label: "In progress step", status: "in_progress" },
    ]);
    assert.equal(loadedMalformed.members.worker.turnStartedAt, undefined);
    assert.equal(loadedMalformed.members.worker.llmTurns, undefined);
  });
});

describe("WorktreeManager P0 DIRTY_BASE & P1 missing_worktree autoRebase fixes", () => {
  it("ignores untracked .pi/swarm/ and .pi/pi-swarm-settings.json on repoRoot while catching real dirty files", async () => {
    const repoDir = await makeTempDir("pi-swarm-dirty-base-");
    await initPlainRepo(repoDir);
    const wtMgr = new WorktreeManager(repoDir);

    // Confirm repo has NO .gitignore and NO .git/info/exclude entry for .pi
    const excludePath = path.join(repoDir, ".git", "info", "exclude");
    await writeFile(excludePath, "# empty exclude\n", "utf8");

    // Create untracked .pi/swarm/... and .pi/pi-swarm-settings.json directly
    const swarmRunDir = path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, "run-1");
    await mkdir(swarmRunDir, { recursive: true });
    await writeFile(path.join(swarmRunDir, "state.json"), '{"id":"run-1"}\n', "utf8");
    await writeFile(path.join(swarmRunDir, "board.jsonl"), "", "utf8");
    await writeFile(
      path.join(repoDir, ".pi", SWARM_SETTINGS_FILE),
      '{"autoRebase":true}\n',
      "utf8",
    );

    // Git itself reports them as untracked, yet isWorktreeDirty & isBaseCleanOnBranch treat base as clean
    const rawGitStatus = await git(repoDir, ["status", "--porcelain", "-uall"]);
    assert.match(rawGitStatus, /\?\? \.pi\/pi-swarm-settings\.json/);
    assert.match(rawGitStatus, /\?\? \.pi\/swarm\/runs\/run-1\/state\.json/);

    assert.equal(await wtMgr.isWorktreeDirty(repoDir), false);
    const cleanCheck = await wtMgr.isBaseCleanOnBranch("main");
    assert.equal(cleanCheck.ok, true);
    assert.equal(cleanCheck.dirty, false);

    // Merging a feature branch should NOT fail with DIRTY_BASE
    const wtPath = path.join(repoDir, SWARM_DIR, "worktrees", "run-1", "wt-coder");
    await wtMgr.createWorktree({
      branch: "swarm/run-1/coder",
      baseBranch: "main",
      worktreePath: wtPath,
      mode: "share",
    });
    await writeFile(path.join(wtPath, "feature.txt"), "hello\n", "utf8");
    await git(wtPath, ["add", "feature.txt"]);
    await git(wtPath, [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "feat: add feature.txt",
    ]);

    const merged = await wtMgr.mergeBranch({
      baseBranch: "main",
      branch: "swarm/run-1/coder",
    });
    assert.equal(merged.strategy, "merge");
    assert.deepEqual(merged.changedFiles, ["feature.txt"]);

    // Real untracked file inside .pi/ (NOT swarm/ or pi-swarm-settings.json) MUST be reported dirty
    const otherPiFile = path.join(repoDir, ".pi", "custom-notes.json");
    await writeFile(otherPiFile, "{}\n", "utf8");
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), true);
    await rm(otherPiFile);
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), false);

    // Real untracked file at repo root MUST be reported dirty
    const strayFile = path.join(repoDir, "untracked.txt");
    await writeFile(strayFile, "stray\n", "utf8");
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), true);
    const dirtyBaseCheck = await wtMgr.isBaseCleanOnBranch("main");
    assert.equal(dirtyBaseCheck.ok, false);
    assert.equal(dirtyBaseCheck.dirty, true);
    await rm(strayFile);
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), false);

    // Modified tracked file MUST be reported dirty
    await writeFile(path.join(repoDir, "app.txt"), "modified\n", "utf8");
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), true);
    await git(repoDir, ["checkout", "--", "app.txt"]);
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), false);

    // Staged .pi/pi-swarm-settings.json (status A, not ??) MUST be reported dirty
    await git(repoDir, ["add", `.pi/${SWARM_SETTINGS_FILE}`]);
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), true);
    await git(repoDir, ["reset", "HEAD", "--", `.pi/${SWARM_SETTINGS_FILE}`]);
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), false);
  });

  it("returns missing_worktree (non-conflict) from autoRebase when worktree directory does not exist", async () => {
    const repoDir = await makeTempDir("pi-swarm-missing-wt-");
    await initPlainRepo(repoDir);
    const wtMgr = new WorktreeManager(repoDir);

    const missingPath = path.join(
      repoDir,
      SWARM_DIR,
      "worktrees",
      "run-missing",
      "wt-builder",
    );
    const result = await wtMgr.autoRebase(missingPath, "main");
    assert.equal(result.status, "missing_worktree");
    assert.notEqual(result.status, "conflict");
    assert.match(result.message ?? "", /does not exist/i);

    // Also verify after a real worktree is deleted out from under a branch
    await wtMgr.createWorktree({
      branch: "swarm/run-missing/builder",
      baseBranch: "main",
      worktreePath: missingPath,
      mode: "share",
    });
    await writeFile(path.join(missingPath, "built.txt"), "ok\n", "utf8");
    await git(missingPath, ["add", "built.txt"]);
    await git(missingPath, [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "feat: add built.txt",
    ]);
    await wtMgr.removeWorktree(missingPath);

    const afterRemoval = await wtMgr.autoRebase(missingPath, "main");
    assert.equal(afterRemoval.status, "missing_worktree");
    assert.notEqual(afterRemoval.status, "conflict");
  });
});

describe("Board roster-aware mention filtering", () => {
  it("preserves @all, @orchestrator, and known roster handles while dropping prose tokens like @mention/@param/@type", () => {
    const text =
      "Wait for the @mention from @slugger, check @param and @type annotations, cc @all and @orchestrator and @Checker (ignore foo@bar.com and @#backend).";

    // Backward compatible when knownMembers is omitted
    assert.deepEqual(parseMentions(text), [
      "mention",
      "slugger",
      "param",
      "type",
      "all",
      "orchestrator",
      "Checker",
    ]);

    // Roster-aware filtering preserves all, orchestrator, and known members (case-insensitive)
    assert.deepEqual(parseMentions(text, ["slugger", "checker"]), [
      "slugger",
      "all",
      "orchestrator",
      "Checker",
    ]);

    // Empty knownMembers still preserves @all and @orchestrator while dropping prose tokens
    assert.deepEqual(parseMentions(text, []), ["all", "orchestrator"]);

    // Direct filterMentions helper
    assert.deepEqual(
      filterMentions(
        ["@mention", "slugger", "PARAM", "all", "Orchestrator", "type", "checker"],
        new Set(["@slugger"]),
      ),
      ["slugger", "all", "Orchestrator"],
    );
    assert.deepEqual(
      filterMentions(["@mention", "slugger", "SLUGGER"]),
      ["mention", "slugger"],
    );
  });

  it("filters mentions in SwarmBoard.post and SwarmStore.postBoardMessage when knownMembers is provided", async () => {
    const root = await makeTempDir("pi-swarm-board-filter-");
    const board = new SwarmBoard(root);
    const store = new SwarmStore(root);

    await store.createRun({
      id: "run-mentions",
      title: "Mention Filter",
      objective: "Verify roster-aware board mentions",
      baseBranch: "main",
      ownerSessionId: "sess-1",
    });
    await store.addMember("run-mentions", {
      name: "slugger",
      agentId: "agt-slugger",
      role: "worker",
      parentName: "orchestrator",
      brief: "Build slugify",
      workspace: "inherit",
      cwd: root,
    });
    await store.addMember("run-mentions", {
      name: "checker",
      agentId: "agt-checker",
      role: "validator",
      parentName: "orchestrator",
      brief: "Audit slugify",
      workspace: "inherit",
      cwd: root,
    });

    // Store postBoardMessage WITH knownMembers drops prose tokens (@mention, @param, @type)
    const filteredMsg = await store.postBoardMessage("run-mentions", {
      from: "checker",
      fromRole: "validator",
      text: "Waiting for @mention from @slugger; see @param and @type before notifying @orchestrator or @all.",
      mentions: ["mention", "checker"],
      knownMembers: ["slugger", "checker"],
    });
    assert.deepEqual(filteredMsg.mentions, [
      "slugger",
      "orchestrator",
      "all",
      "checker",
    ]);

    // Store postBoardMessage WITHOUT knownMembers retains full backward compatibility
    const unfilteredMsg = await store.postBoardMessage("run-mentions", {
      from: "checker",
      fromRole: "validator",
      text: "Check @param and @slugger",
    });
    assert.deepEqual(unfilteredMsg.mentions, ["param", "slugger"]);

    // Persisted board.jsonl reflects filtered mentions
    const readBack = await board.read("run-mentions", { seqs: [filteredMsg.seq] });
    assert.equal(readBack.messages.length, 1);
    assert.deepEqual(readBack.messages[0].mentions, [
      "slugger",
      "orchestrator",
      "all",
      "checker",
    ]);

    // Sanity check JSONL on disk directly
    const rawBoard = await readFile(board.getBoardPath("run-mentions"), "utf8");
    const firstLine = JSON.parse(rawBoard.trim().split("\n")[0]) as {
      mentions: string[];
    };
    assert.deepEqual(firstLine.mentions, [
      "slugger",
      "orchestrator",
      "all",
      "checker",
    ]);
  });
});

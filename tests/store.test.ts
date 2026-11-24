import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
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
  ASSERTION_STATUSES,
  DRAFTING_TOOLS,
  FEATURE_STATUSES,
  HANDOFF_ITEM_TYPES,
  HANDOFF_RESOLUTIONS,
  SWARM_ACTIONS,
  SWARM_CORE_TOOLS,
  SWARM_DIR,
  SWARM_FEATURES_FILE,
  SWARM_MISSION_FILE,
  SWARM_MISSION_OPS,
  SWARM_PATHS,
  SWARM_RUNS_DIR,
  SWARM_SETTINGS_FILE,
  SWARM_STATE_FILE,
  SWARM_VALIDATION_CONTRACT_FILE,
  SWARM_VALIDATION_STATE_FILE,
} from "../src/constants.js";
import { SwarmBoard, filterMentions, parseMentions } from "../src/store/board.js";
import { SwarmStore } from "../src/store/swarm-store.js";
import { WorktreeManager } from "../src/store/worktree.js";
import type {
  MissionAssertion,
  MissionAuditRecord,
  MissionCommandEntry,
  MissionFeature,
  MissionHandoffItem,
  SwarmMilestone,
} from "../src/types.js";

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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("SwarmStore v0.8.0 Dynamic Mission Goal Engine persistence & artifacts", () => {
  it("exports mission constants and keeps core/drafting tool counts invariant", () => {
    assert.equal(SWARM_CORE_TOOLS.length, 4);
    assert.equal(DRAFTING_TOOLS.length, 3);
    assert.ok(SWARM_ACTIONS.includes("mission"));
    assert.deepEqual(SWARM_MISSION_OPS, [
      "status",
      "upsert_assertions",
      "remove_assertion",
      "verify_assertion",
      "upsert_features",
      "update_feature",
      "resolve_handoff",
      "set_manifest",
    ]);
    assert.deepEqual(ASSERTION_STATUSES, ["pending", "passed", "failed", "blocked"]);
    assert.deepEqual(FEATURE_STATUSES, [
      "pending",
      "in_progress",
      "completed",
      "failed",
      "cancelled",
    ]);
    assert.deepEqual(HANDOFF_ITEM_TYPES, [
      "discovered_issue",
      "incomplete_work",
      "critical_context",
    ]);
    assert.deepEqual(HANDOFF_RESOLUTIONS, ["open", "tracked", "dismissed"]);
    assert.equal(SWARM_PATHS.missionFile, SWARM_MISSION_FILE);
    assert.equal(SWARM_PATHS.validationContractFile, SWARM_VALIDATION_CONTRACT_FILE);
    assert.equal(SWARM_PATHS.validationStateFile, SWARM_VALIDATION_STATE_FILE);
    assert.equal(SWARM_PATHS.featuresFile, SWARM_FEATURES_FILE);
  });

  it("round-trips mission fields, sealed milestones, and legacy/malformed state.json safely", async () => {
    const root = await makeTempDir("pi-swarm-v080-mission-roundtrip-");
    const store = new SwarmStore(root);
    const ts = "2026-11-24T02:00:00.000Z";

    const milestones: SwarmMilestone[] = [
      {
        label: "Foundation",
        status: "done",
        owner: "architect",
        sealed: true,
        sealedAt: ts,
      },
      {
        label: "Execution",
        status: "in_progress",
        owner: "builder",
        sealed: false,
      },
    ];

    const assertions: MissionAssertion[] = [
      {
        id: "VAL-AUTH-001",
        title: "Session token refresh",
        description: "Expired tokens refresh transparently without user logout.",
        evidenceRequired: "Integration test output covering 401 -> refresh -> retry",
        status: "pending",
        updatedAt: ts,
      },
      {
        id: "VAL-AUTH-002",
        title: "Revoked token rejection",
        description: "Revoked refresh tokens return 403 and clear session.",
        status: "passed",
        evidence: "tests/auth.test.ts passed (8/8)",
        verifiedBy: "auditor",
        verifiedByRole: "validator",
        updatedAt: ts,
      },
    ];

    const features: MissionFeature[] = [
      {
        id: "feat-token-refresh",
        title: "Implement token refresh interceptor",
        description: "Add single-flight refresh mutex in HTTP client.",
        milestone: "Execution",
        dependsOn: ["feat-token-types"],
        filesOwned: ["src/auth/refresh.ts", "tests/auth.test.ts"],
        preconditions: ["Base auth store exists"],
        expectedBehavior: ["Queues concurrent 401 requests onto one refresh call"],
        verificationSteps: ["npm test -- tests/auth.test.ts"],
        fulfills: ["VAL-AUTH-001", "VAL-AUTH-002"],
        status: "in_progress",
        assignedMember: "builder",
        updatedAt: ts,
      },
    ];

    const handoffItems: MissionHandoffItem[] = [
      {
        id: "ho-1",
        type: "discovered_issue",
        sourceMember: "builder",
        sourceFeatureId: "feat-token-refresh",
        summary: "Legacy cookie parser drops SameSite=Strict attribute",
        resolution: "open",
        createdAt: ts,
      },
    ];

    const commands: MissionCommandEntry[] = [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "test", command: "npm test" },
    ];

    const boundaries = [
      "Do not modify external OAuth provider endpoints",
      "Never log raw bearer tokens",
    ];

    const lastAudit: MissionAuditRecord = {
      verdict: "disapproved",
      summary: "VAL-AUTH-001 still pending verification.",
      auditor: "auditor",
      timestamp: ts,
    };

    const created = await store.createRun({
      id: "run-mission-v080",
      title: "Auth Refresh Mission",
      objective: "Deliver resilient token refresh",
      strategy: "Wave 1 foundation, Wave 2 interceptor + audit",
      acceptanceCriteria: "All VAL-AUTH-* assertions pass",
      baseBranch: "main",
      ownerSessionId: "sess-v080",
      milestones,
      assertions,
      features,
      handoffItems,
      commands,
      boundaries,
      lastAudit,
    });

    assert.deepEqual(created.milestones, milestones);
    assert.deepEqual(created.assertions, assertions);
    assert.deepEqual(created.features, features);
    assert.deepEqual(created.handoffItems, handoffItems);
    assert.deepEqual(created.commands, commands);
    assert.deepEqual(created.boundaries, boundaries);
    assert.deepEqual(created.lastAudit, lastAudit);

    // Reload from a fresh SwarmStore instance
    const reloadStore = new SwarmStore(root);
    let loaded = await reloadStore.loadRun("run-mission-v080");
    assert.deepEqual(loaded.milestones, milestones);
    assert.deepEqual(loaded.assertions, assertions);
    assert.deepEqual(loaded.features, features);
    assert.deepEqual(loaded.handoffItems, handoffItems);
    assert.deepEqual(loaded.commands, commands);
    assert.deepEqual(loaded.boundaries, boundaries);
    assert.deepEqual(loaded.lastAudit, lastAudit);

    // Update handoff resolution, feature completion, assertion verification, and audit approval
    const ts2 = "2026-11-24T02:30:00.000Z";
    const updatedAssertions: MissionAssertion[] = [
      {
        ...assertions[0],
        status: "passed",
        evidence: "Verified single-flight refresh in tests/auth.test.ts",
        verifiedBy: "auditor",
        verifiedByRole: "validator",
        updatedAt: ts2,
      },
      assertions[1],
    ];
    const updatedFeatures: MissionFeature[] = [
      {
        ...features[0],
        status: "completed",
        mergedCommitSha: "abc1234",
        updatedAt: ts2,
      },
    ];
    const updatedHandoffs: MissionHandoffItem[] = [
      {
        ...handoffItems[0],
        resolution: "tracked",
        trackedFeatureId: "feat-cookie-fix",
        justification: "Tracked in follow-up milestone",
        resolvedAt: ts2,
      },
    ];
    const approvedAudit: MissionAuditRecord = {
      verdict: "approved",
      summary: "All VAL-AUTH-* assertions verified with clean evidence.",
      auditor: "auditor",
      timestamp: ts2,
    };

    await reloadStore.updateRun("run-mission-v080", {
      assertions: updatedAssertions,
      features: updatedFeatures,
      handoffItems: updatedHandoffs,
      lastAudit: approvedAudit,
    });

    const verifyStore = new SwarmStore(root);
    loaded = await verifyStore.loadRun("run-mission-v080");
    assert.deepEqual(loaded.assertions, updatedAssertions);
    assert.deepEqual(loaded.features, updatedFeatures);
    assert.deepEqual(loaded.handoffItems, updatedHandoffs);
    assert.deepEqual(loaded.lastAudit, approvedAudit);

    // Clear all mission fields via null
    await verifyStore.updateRun("run-mission-v080", {
      assertions: null,
      features: null,
      handoffItems: null,
      commands: null,
      boundaries: null,
      lastAudit: null,
    });

    const clearedStore = new SwarmStore(root);
    loaded = await clearedStore.loadRun("run-mission-v080");
    assert.equal(loaded.assertions, undefined);
    assert.equal(loaded.features, undefined);
    assert.equal(loaded.handoffItems, undefined);
    assert.equal(loaded.commands, undefined);
    assert.equal(loaded.boundaries, undefined);
    assert.equal(loaded.lastAudit, undefined);

    // Verify legacy state.json lacking v0.8.0 fields + malformed mission payloads normalize safely
    const legacyDir = path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "run-legacy-v080");
    await mkdir(legacyDir, { recursive: true });
    const legacyRaw = {
      version: 2,
      id: "run-legacy-v080",
      title: "Legacy Run",
      objective: "Pre-v0.8.0 run without mission keys",
      strategy: "",
      acceptanceCriteria: "",
      baseBranch: "main",
      ownerSessionId: "sess-legacy",
      ownerPid: 111,
      status: "active",
      maxConcurrency: 4,
      validatorEnabled: true,
      keepWorkersWarm: true,
      roleModels: {},
      revision: 1,
      members: {},
      memberOrder: [],
      channels: {},
      boardHead: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    await writeFile(
      path.join(legacyDir, SWARM_STATE_FILE),
      `${JSON.stringify(legacyRaw, null, 2)}\n`,
      "utf8",
    );
    const loadedLegacy = await clearedStore.loadRun("run-legacy-v080");
    assert.equal(loadedLegacy.assertions, undefined);
    assert.equal(loadedLegacy.features, undefined);
    assert.equal(loadedLegacy.handoffItems, undefined);
    assert.equal(loadedLegacy.commands, undefined);
    assert.equal(loadedLegacy.boundaries, undefined);
    assert.equal(loadedLegacy.lastAudit, undefined);

    // Malformed mission entries should be stripped / sanitized without crashing
    const malformedDir = path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "run-malformed-v080");
    await mkdir(malformedDir, { recursive: true });
    const malformedRaw = {
      ...legacyRaw,
      id: "run-malformed-v080",
      milestones: [
        { label: "  M1  ", status: "done", sealed: true, sealedAt: "  2026-11-24T00:00:00Z  " },
        { label: "M2", status: "pending", sealed: "not-a-bool", sealedAt: "   " },
      ],
      assertions: [
        { id: "__proto__", title: "Bad proto", description: "x", status: "pending", updatedAt: ts },
        { id: "VAL-1", title: "  Valid  ", description: "  Desc  ", status: "passed", verifiedByRole: "invalid-role" },
        { id: "VAL-BAD", title: "Bad status", description: "x", status: "bogus" },
        { id: "", title: "Empty id", description: "x", status: "pending" },
      ],
      features: [
        { id: "feat-ok", title: "  Feature OK  ", description: "  Work  ", milestone: " M1 ", fulfills: [" VAL-1 ", ""], status: "pending" },
        { id: "feat-bad", title: "Bad", description: "", milestone: "M1", fulfills: [], status: "unknown" },
      ],
      handoffItems: [
        { id: "ho-ok", type: "critical_context", sourceMember: " worker-1 ", summary: " Note ", resolution: "dismissed", justification: " Not needed " },
        { id: "ho-bad", type: "wrong", sourceMember: "w", summary: "s", resolution: "open" },
      ],
      commands: [
        { name: " build ", command: " npm run build " },
        { name: "", command: "echo nope" },
      ],
      boundaries: ["  No network calls  ", "", 42],
      lastAudit: { verdict: "unknown", summary: "bad" },
    };
    await writeFile(
      path.join(malformedDir, SWARM_STATE_FILE),
      `${JSON.stringify(malformedRaw, null, 2)}\n`,
      "utf8",
    );
    const loadedMalformed = await clearedStore.loadRun("run-malformed-v080");
    assert.deepEqual(loadedMalformed.milestones, [
      { label: "M1", status: "done", sealed: true, sealedAt: "2026-11-24T00:00:00Z" },
      { label: "M2", status: "pending" },
    ]);
    assert.deepEqual(loadedMalformed.assertions, [
      {
        id: "VAL-1",
        title: "Valid",
        description: "Desc",
        status: "passed",
        updatedAt: ts,
      },
    ]);
    assert.deepEqual(loadedMalformed.features, [
      {
        id: "feat-ok",
        title: "Feature OK",
        description: "Work",
        milestone: "M1",
        fulfills: ["VAL-1"],
        status: "pending",
        updatedAt: ts,
      },
    ]);
    assert.deepEqual(loadedMalformed.handoffItems, [
      {
        id: "ho-ok",
        type: "critical_context",
        sourceMember: "worker-1",
        summary: "Note",
        resolution: "dismissed",
        justification: "Not needed",
        createdAt: ts,
      },
    ]);
    assert.deepEqual(loadedMalformed.commands, [
      { name: "build", command: "npm run build" },
    ]);
    assert.deepEqual(loadedMalformed.boundaries, ["No network calls"]);
    assert.equal(loadedMalformed.lastAudit, undefined);
  });

  it("auto-materializes Droid Mission artifacts and skips unchanged rewrites via diff cache", async () => {
    const root = await makeTempDir("pi-swarm-v080-artifacts-");
    const store = new SwarmStore(root);
    const ts = "2026-11-24T03:00:00.000Z";

    // Plain run without assertions/features: creates mission.md only
    await store.createRun({
      id: "run-plain",
      title: "Plain Run",
      objective: "Simple task without mission contract",
      baseBranch: "main",
      ownerSessionId: "sess-plain",
    });
    const plainDir = store.getRunDir("run-plain");
    assert.equal(await exists(path.join(plainDir, SWARM_MISSION_FILE)), true);
    assert.equal(
      await exists(path.join(plainDir, SWARM_VALIDATION_CONTRACT_FILE)),
      false,
    );
    assert.equal(
      await exists(path.join(plainDir, SWARM_VALIDATION_STATE_FILE)),
      false,
    );
    assert.equal(await exists(path.join(plainDir, SWARM_FEATURES_FILE)), false);

    // Full mission run: creates all 4 artifacts
    const assertions: MissionAssertion[] = [
      {
        id: "VAL-API-001",
        title: "Health endpoint returns 200",
        description: "GET /health responds with { ok: true }.",
        evidenceRequired: "curl /health test output",
        status: "pending",
        updatedAt: ts,
      },
    ];
    const features: MissionFeature[] = [
      {
        id: "feat-health",
        title: "Health route",
        description: "Add GET /health handler",
        milestone: "M1",
        fulfills: ["VAL-API-001"],
        status: "pending",
        updatedAt: ts,
      },
    ];
    await store.createRun({
      id: "run-artifacts",
      title: "API Service Mission",
      objective: "Ship reliable health endpoint",
      strategy: "Single wave implementation + validator check",
      acceptanceCriteria: "VAL-API-001 verified",
      baseBranch: "main",
      ownerSessionId: "sess-art",
      milestones: [
        {
          label: "M1",
          status: "in_progress",
          owner: "worker-api",
          sealed: true,
          sealedAt: ts,
        },
      ],
      commands: [{ name: "test", command: "npm test" }],
      boundaries: ["Keep zero external runtime dependencies"],
      assertions,
      features,
    });

    const runDir = store.getRunDir("run-artifacts");
    const missionPath = path.join(runDir, SWARM_MISSION_FILE);
    const contractPath = path.join(runDir, SWARM_VALIDATION_CONTRACT_FILE);
    const valStatePath = path.join(runDir, SWARM_VALIDATION_STATE_FILE);
    const featuresPath = path.join(runDir, SWARM_FEATURES_FILE);

    const missionMd = await readFile(missionPath, "utf8");
    assert.match(missionMd, /# API Service Mission/);
    assert.match(missionMd, /Ship reliable health endpoint/);
    assert.match(missionMd, /\*\*test:\*\* `npm test`/);
    assert.match(missionMd, /Keep zero external runtime dependencies/);
    assert.match(missionMd, /\[in_progress\] \*\*M1\*\* \(owner: @worker-api\) \[SEALED at 2026-11-24T03:00:00\.000Z\]/);

    const contractMd = await readFile(contractPath, "utf8");
    assert.match(contractMd, /### VAL-API-001: Health endpoint returns 200/);
    assert.match(contractMd, /- \*\*Status:\*\* \[ \] `PENDING`/);
    assert.match(contractMd, /GET \/health responds with \{ ok: true \}\./);
    assert.match(contractMd, /curl \/health test output/);

    const valStateJson = JSON.parse(await readFile(valStatePath, "utf8")) as {
      assertions: Record<string, { status: string; updatedAt: string }>;
    };
    assert.deepEqual(valStateJson, {
      assertions: {
        "VAL-API-001": {
          status: "pending",
          updatedAt: ts,
        },
      },
    });

    const featuresJson = JSON.parse(await readFile(featuresPath, "utf8")) as {
      features: MissionFeature[];
    };
    assert.deepEqual(featuresJson, { features });

    // Record file inodes & mtimes to verify diff-cached skipping on unrelated updates
    const statMission1 = await lstat(missionPath);
    const statContract1 = await lstat(contractPath);
    const statValState1 = await lstat(valStatePath);
    const statFeatures1 = await lstat(featuresPath);

    // Unrelated member + board mutations must NOT rewrite any of the 4 mission artifacts
    await store.addMember("run-artifacts", {
      name: "worker-api",
      agentId: "agt-api",
      role: "worker",
      parentName: "orchestrator",
      brief: "Implement /health",
      workspace: "inherit",
      cwd: root,
    });
    await store.postBoardMessage("run-artifacts", {
      from: "worker-api",
      fromRole: "worker",
      text: "Working on /health endpoint",
    });

    const statMission2 = await lstat(missionPath);
    const statContract2 = await lstat(contractPath);
    const statValState2 = await lstat(valStatePath);
    const statFeatures2 = await lstat(featuresPath);

    assert.equal(statMission2.ino, statMission1.ino);
    assert.equal(statContract2.ino, statContract1.ino);
    assert.equal(statValState2.ino, statValState1.ino);
    assert.equal(statFeatures2.ino, statFeatures1.ino);

    // Updating ONLY assertions rewrites validation-contract.md & validation-state.json while keeping mission.md & features.json untouched
    const tsVerified = "2026-11-24T03:10:00.000Z";
    await store.updateRun("run-artifacts", {
      assertions: [
        {
          ...assertions[0],
          status: "passed",
          evidence: "GET /health -> 200 OK { ok: true }",
          verifiedBy: "checker",
          verifiedByRole: "validator",
          updatedAt: tsVerified,
        },
      ],
    });

    const statMission3 = await lstat(missionPath);
    const statContract3 = await lstat(contractPath);
    const statValState3 = await lstat(valStatePath);
    const statFeatures3 = await lstat(featuresPath);

    assert.equal(statMission3.ino, statMission1.ino);
    assert.equal(statFeatures3.ino, statFeatures1.ino);
    assert.notEqual(statContract3.ino, statContract1.ino);
    assert.notEqual(statValState3.ino, statValState1.ino);

    const updatedContractMd = await readFile(contractPath, "utf8");
    assert.match(updatedContractMd, /- \*\*Status:\*\* \[x\] `PASSED`/);
    assert.match(updatedContractMd, /GET \/health -> 200 OK \{ ok: true \}/);
    assert.match(updatedContractMd, /@checker \(validator\)/);

    const updatedValState = JSON.parse(await readFile(valStatePath, "utf8")) as {
      assertions: Record<string, unknown>;
    };
    assert.deepEqual(updatedValState, {
      assertions: {
        "VAL-API-001": {
          status: "passed",
          evidence: "GET /health -> 200 OK { ok: true }",
          verifiedBy: "checker",
          verifiedByRole: "validator",
          updatedAt: tsVerified,
        },
      },
    });

    // Clearing assertions & features removes validation-contract.md, validation-state.json, and features.json
    await store.updateRun("run-artifacts", {
      assertions: null,
      features: null,
    });
    assert.equal(await exists(missionPath), true);
    assert.equal(await exists(contractPath), false);
    assert.equal(await exists(valStatePath), false);
    assert.equal(await exists(featuresPath), false);
  });
});

describe("BoardMessage structured worker handoff fields", () => {
  it("persists and reloads non-empty featureId, discoveredIssues, leftUndone, and verificationEvidence", async () => {
    const root = await makeTempDir("pi-swarm-board-handoff-");
    const store = new SwarmStore(root);

    await store.createRun({
      id: "run-handoff",
      title: "Handoff Board Test",
      objective: "Verify structured worker handoffs on board.jsonl",
      baseBranch: "main",
      ownerSessionId: "sess-ho",
    });

    const handoffMsg = await store.postBoardMessage("run-handoff", {
      from: "worker-1",
      fromRole: "worker",
      kind: "done",
      text: "@validator [done] Implemented feature feat-auth",
      featureId: "  feat-auth  ",
      discoveredIssues: ["  Race condition in legacy logout  ", "", "   "],
      leftUndone: ["  Rate-limit metrics endpoint  "],
      verificationEvidence: "  npm run test:file tests/auth.test.ts (12/12 pass)  ",
    });

    assert.equal(handoffMsg.featureId, "feat-auth");
    assert.deepEqual(handoffMsg.discoveredIssues, [
      "Race condition in legacy logout",
    ]);
    assert.deepEqual(handoffMsg.leftUndone, ["Rate-limit metrics endpoint"]);
    assert.equal(
      handoffMsg.verificationEvidence,
      "npm run test:file tests/auth.test.ts (12/12 pass)",
    );

    // Posting empty/blank optional handoff fields omits them cleanly
    const plainMsg = await store.postBoardMessage("run-handoff", {
      from: "worker-1",
      fromRole: "worker",
      text: "Quick status note",
      featureId: "   ",
      discoveredIssues: ["", "  "],
      leftUndone: [],
      verificationEvidence: "",
    });
    assert.equal(plainMsg.featureId, undefined);
    assert.equal(plainMsg.discoveredIssues, undefined);
    assert.equal(plainMsg.leftUndone, undefined);
    assert.equal(plainMsg.verificationEvidence, undefined);
    assert.equal("featureId" in plainMsg, false);
    assert.equal("discoveredIssues" in plainMsg, false);
    assert.equal("leftUndone" in plainMsg, false);
    assert.equal("verificationEvidence" in plainMsg, false);

    // Reload from a brand-new SwarmBoard instance to verify JSONL disk parsing
    const freshBoard = new SwarmBoard(root);
    const readAll = await freshBoard.read("run-handoff");
    assert.equal(readAll.messages.length, 2);
    assert.equal(readAll.messages[0].featureId, "feat-auth");
    assert.deepEqual(readAll.messages[0].discoveredIssues, [
      "Race condition in legacy logout",
    ]);
    assert.deepEqual(readAll.messages[0].leftUndone, [
      "Rate-limit metrics endpoint",
    ]);
    assert.equal(
      readAll.messages[0].verificationEvidence,
      "npm run test:file tests/auth.test.ts (12/12 pass)",
    );
    assert.equal("featureId" in readAll.messages[1], false);

    // Search matches structured handoff fields too
    const byFeature = await freshBoard.read("run-handoff", {
      search: "feat-auth",
    });
    assert.equal(byFeature.messages.length, 1);
    assert.equal(byFeature.messages[0].seq, handoffMsg.seq);

    const byIssue = await freshBoard.read("run-handoff", {
      search: "race condition",
    });
    assert.equal(byIssue.messages.length, 1);
    assert.equal(byIssue.messages[0].seq, handoffMsg.seq);
  });
});

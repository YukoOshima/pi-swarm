import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  DEFAULT_SWARM_SETTINGS,
  FINAL_AUDIT_MISSION_ID,
  FINAL_VALIDATOR_BOARD_NAME,
  ORCHESTRATOR_BOARD_NAME,
  SWARM_AUDITS_DIR,
  SWARM_BOARD_FILE,
  SWARM_DIR,
  SWARM_LOCKS_DIR,
  SWARM_LOG_TAIL_LIMIT,
  SWARM_MISSIONS_FILE,
  SWARM_REVIEWS_DIR,
  SWARM_RUNS_DIR,
  SWARM_SETTINGS_FILE,
  SWARM_STATE_FILE,
} from "../src/constants.js";
import {
  SwarmBoard,
  SwarmLedger,
  SwarmStore,
  WorktreeManager,
  assertOwnerSession,
  findScopeViolations,
  formatBoardMessage,
  formatBoardMessages,
  formatLedgerActivity,
  formatLedgerEvent,
  getGlobalSettingsPath,
  getProjectSettingsPath,
  loadLayeredSwarmSettings,
  loadSwarmSettings,
  normalizeScopePath,
  parseMentions,
  sanitizeSwarmSettings,
  saveSwarmSettings,
  scopesOverlap,
} from "../src/store/index.js";
import {
  isSwarmProtocolError,
  type FinalAuditVerdict,
  type MissionPlanInput,
  type MissionReviewVerdict,
  type SwarmEvent,
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

async function commitFile(
  cwd: string,
  relPath: string,
  content: string,
  message: string,
): Promise<string> {
  const fullPath = path.join(cwd, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  await git(cwd, ["add", relPath]);
  await git(cwd, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message,
  ]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function makeMission(
  overrides: Partial<MissionPlanInput> & { id: string; title: string },
): MissionPlanInput {
  return {
    kind: "build",
    description: `Description for ${overrides.id}`,
    scope: [`src/${overrides.id.toLowerCase()}`],
    deps: [],
    verification: "npm test",
    ...overrides,
  };
}

function assertProtocolCode(err: unknown, expectedCode: string): boolean {
  assert.ok(
    isSwarmProtocolError(err),
    `Expected SwarmProtocolError(${expectedCode}), got ${String(err)}`,
  );
  assert.equal(
    err.code,
    expectedCode,
    `Unexpected code: ${err.code} (${err.message})`,
  );
  return true;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ============================================================================
// 1. Plan Validation & Protocol Invariants
// ============================================================================

describe("SwarmStore.validatePlan & protocol invariants", () => {
  it("computes multi-wave topological DAG and deterministic feat/<slug> branches", async () => {
    const root = await makeTempDir("pi-swarm-plan-");
    const store = new SwarmStore(root);

    const missions: MissionPlanInput[] = [
      makeMission({ id: "M1", title: "Build Auth Core", scope: ["src/auth"] }),
      makeMission({
        id: "M2",
        title: "Add Storage Layer",
        scope: ["src/storage"],
      }),
      makeMission({
        id: "M3",
        title: "Wire HTTP API",
        scope: ["src/api"],
        deps: ["M1", "M2"],
      }),
      makeMission({
        id: "M4",
        title: "Write Integration Report",
        kind: "artifact",
        scope: ["docs/report.md"],
        deps: ["M3"],
      }),
    ];

    const result = store.validatePlan(missions, {
      baseBranch: "main",
      existingBranches: ["main", "feat/unrelated"],
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.waves, [["M1", "M2"], ["M3"], ["M4"]]);
    assert.deepEqual(result.branches, {
      M1: "feat/build-auth-core",
      M2: "feat/add-storage-layer",
      M3: "feat/wire-http-api",
      M4: "feat/write-integration-report",
    });
  });

  it("rejects dependency cycles (multi-node and self-loop) with CYCLE_DETECTED", async () => {
    const root = await makeTempDir("pi-swarm-cycle-");
    const store = new SwarmStore(root);

    const cyclic = store.validatePlan([
      makeMission({
        id: "M1",
        title: "Mission One",
        scope: ["src/a"],
        deps: ["M2"],
      }),
      makeMission({
        id: "M2",
        title: "Mission Two",
        scope: ["src/b"],
        deps: ["M1"],
      }),
    ]);
    assert.equal(cyclic.valid, false);
    assert.ok(cyclic.errors.some((e) => e.code === "CYCLE_DETECTED"));
    assert.deepEqual(cyclic.waves, []);

    const selfLoop = store.validatePlan([
      makeMission({
        id: "M1",
        title: "Self Loop",
        scope: ["src/a"],
        deps: ["M1"],
      }),
    ]);
    assert.equal(selfLoop.valid, false);
    assert.ok(selfLoop.errors.some((e) => e.code === "CYCLE_DETECTED"));
  });

  it("rejects missing dependencies and duplicate mission IDs", async () => {
    const root = await makeTempDir("pi-swarm-deps-");
    const store = new SwarmStore(root);

    const missing = store.validatePlan([
      makeMission({
        id: "M1",
        title: "First Task",
        scope: ["src/a"],
        deps: ["M99"],
      }),
    ]);
    assert.equal(missing.valid, false);
    assert.ok(missing.errors.some((e) => e.code === "MISSING_DEP"));

    const dup = store.validatePlan([
      makeMission({ id: "M1", title: "Alpha One", scope: ["src/a"] }),
      makeMission({ id: "M1", title: "Beta Two", scope: ["src/b"] }),
    ]);
    assert.equal(dup.valid, false);
    assert.ok(dup.errors.some((e) => e.code === "DUPLICATE_MISSION"));
  });

  it("enforces printable ASCII titles (INVALID_TITLE) and globally unique branches (DUPLICATE_BRANCH)", async () => {
    const root = await makeTempDir("pi-swarm-titles-");
    const store = new SwarmStore(root);

    for (const badTitle of [
      "实现认证",
      "Add Auth 🚀",
      "Line1\nLine2",
      "   ",
      "---",
    ]) {
      const res = store.validatePlan([
        makeMission({ id: "M1", title: badTitle, scope: ["src/a"] }),
      ]);
      assert.equal(
        res.valid,
        false,
        `Expected title ${JSON.stringify(badTitle)} to fail`,
      );
      assert.ok(res.errors.some((e) => e.code === "INVALID_TITLE"));
    }

    // Collides with existing local git branch
    const gitCollision = store.validatePlan(
      [makeMission({ id: "M1", title: "Add Auth", scope: ["src/a"] })],
      { existingBranches: ["main", "feat/add-auth"] },
    );
    assert.equal(gitCollision.valid, false);
    assert.ok(gitCollision.errors.some((e) => e.code === "DUPLICATE_BRANCH"));

    // Collides within the same batch via slug normalization
    const batchCollision = store.validatePlan([
      makeMission({ id: "M1", title: "Add Auth", scope: ["src/a"] }),
      makeMission({ id: "M2", title: "add_auth!", scope: ["src/b"] }),
    ]);
    assert.equal(batchCollision.valid, false);
    assert.ok(batchCollision.errors.some((e) => e.code === "DUPLICATE_BRANCH"));
  });

  it("enforces build scope disjointness, allows non-exclusive survey scope, and releases scope on merged/abandoned", async () => {
    const root = await makeTempDir("pi-swarm-scope-");
    const store = new SwarmStore(root);

    // Build scope prefix overlap fails
    const overlap = store.validatePlan([
      makeMission({ id: "M1", title: "Store Core", scope: ["src/store"] }),
      makeMission({
        id: "M2",
        title: "Store Ledger",
        scope: ["src/store/ledger.ts"],
      }),
    ]);
    assert.equal(overlap.valid, false);
    assert.ok(overlap.errors.some((e) => e.code === "SCOPE_OVERLAP"));

    // Sibling prefix with shared string prefix does NOT overlap (src/store vs src/store-v2)
    assert.equal(scopesOverlap("src/store", "src/store-v2"), false);
    assert.equal(scopesOverlap("src/store", "src/store/a.ts"), true);

    const siblingOk = store.validatePlan([
      makeMission({ id: "M1", title: "Store Core", scope: ["./src/store/"] }),
      makeMission({ id: "M2", title: "Store V2", scope: ["src/store-v2"] }),
      // Survey sharing exact path with open build mission is allowed!
      makeMission({
        id: "S1",
        title: "Audit Store",
        kind: "survey",
        scope: ["src/store"],
      }),
    ]);
    assert.equal(siblingOk.valid, true);

    // Trailing directory glob suffixes normalize cleanly; embedded/partial wildcards are rejected
    assert.equal(normalizeScopePath("src/store/**"), "src/store");
    assert.equal(normalizeScopePath("src/store/*"), "src/store");
    assert.equal(normalizeScopePath("src/routes/[id]"), "src/routes/[id]");

    // Rejects forbidden/traversal/absolute/wildcard scope paths (including .pi/swarm)
    for (const badScope of [
      "../escape",
      "/etc/passwd",
      ".git/config",
      ".pi/swarm/runs",
      "src\\win",
      "src/*.ts",
      "src/**/index.ts",
      "src/file?.ts",
      "*",
      "**",
    ]) {
      assert.throws(
        () => normalizeScopePath(badScope),
        (err) => assertProtocolCode(err, "SCOPE_VIOLATION"),
      );
    }

    // Wildcard scope in validatePlan cannot sneak overlapping build missions past plan validation
    const wildcardPlan = store.validatePlan([
      makeMission({ id: "M1", title: "Glob Mission", scope: ["src/*.ts"] }),
      makeMission({ id: "M2", title: "Concrete Mission", scope: ["src/a.ts"] }),
    ]);
    assert.equal(wildcardPlan.valid, false);
    assert.ok(wildcardPlan.errors.some((e) => e.code === "SCOPE_VIOLATION"));

    // Create run, verify scope lock while open, then release on merged and abandoned
    const run = await store.createRun({
      id: "run-scope",
      objective: "Scope lifecycle",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-1",
      missions: [
        makeMission({ id: "M1", title: "Alpha Module", scope: ["src/alpha"] }),
        makeMission({ id: "M2", title: "Beta Module", scope: ["src/beta"] }),
      ],
    });

    // Adding overlapping build mission while M1 is planned fails
    await assert.rejects(
      () =>
        store.addMissions(run.id, [
          makeMission({
            id: "M3",
            title: "Alpha Followup",
            scope: ["src/alpha/sub.ts"],
          }),
        ]),
      (err) => assertProtocolCode(err, "SCOPE_OVERLAP"),
    );

    // Transition M1 -> active -> completed -> merged (releases src/alpha!)
    await store.updateMission(run.id, "M1", { status: "active" });
    await store.updateMission(run.id, "M1", { status: "completed" });
    await store.markMerged(run.id, "M1", "abc1234567890");

    // Abandon M2 (releases src/beta!)
    await store.updateMission(run.id, "M2", {
      status: "abandoned",
      callerRole: "orchestrator",
    });

    // Historical branch name from merged M1 is STILL blocked!
    await assert.rejects(
      () =>
        store.addMissions(run.id, [
          makeMission({
            id: "M3",
            title: "Alpha Module",
            scope: ["src/alpha/sub.ts"],
          }),
        ]),
      (err) => assertProtocolCode(err, "DUPLICATE_BRANCH"),
    );

    // New build missions with fresh titles CAN reclaim released scopes from M1 & M2!
    const updated = await store.addMissions(run.id, [
      makeMission({
        id: "M3",
        title: "Alpha Submodule",
        scope: ["src/alpha/sub.ts"],
        deps: ["M1"],
      }),
      makeMission({
        id: "M4",
        title: "Beta Replacement",
        scope: ["src/beta"],
      }),
    ]);
    assert.deepEqual(updated.missionOrder, ["M1", "M2", "M3", "M4"]);
  });
});

// ============================================================================
// 2. Shared Message Board (SwarmBoard + parseMentions + formatting)
// ============================================================================

describe("SwarmBoard shared message board (board.jsonl)", () => {
  it("parses @mentions accurately while ignoring emails, duplicates, and trailing punctuation", () => {
    assert.deepEqual(parseMentions("@M1 please review"), ["M1"]);
    assert.deepEqual(
      parseMentions(
        "Hey @M1, check (@validator-M1), [@final-validator], `@orchestrator`, and @all!",
      ),
      ["M1", "validator-M1", "final-validator", "orchestrator", "all"],
    );
    // Email addresses must NOT be extracted as mentions
    assert.deepEqual(
      parseMentions(
        "Contact foo@bar.com, user.name+tag@sub.example.org, a-b@c.io, a_b@d.net, mailto:ops@site.dev.",
      ),
      [],
    );
    // Mixed emails + real mentions + trailing dots + case-insensitive dedup
    assert.deepEqual(
      parseMentions(
        "Email admin@example.com or ask @M1. Also ping @m1 and @M1.2: thanks!",
      ),
      ["M1", "M1.2"],
    );
    assert.deepEqual(parseMentions(""), []);
  });

  it("formats single and multi-line board messages cleanly", () => {
    assert.equal(formatBoardMessages([]), "(no board messages yet)");

    const msg1 = {
      seq: 4,
      runId: "run-b",
      from: "validator-M1",
      fromRole: "validator" as const,
      text: "Fix missing null check on line 42",
      mentions: ["M1"],
      kind: "review" as const,
      missionId: "M1",
      timestamp: "2026-11-20T12:00:00.000Z",
    };
    assert.equal(
      formatBoardMessage(msg1),
      "#4 [validator-M1 -> @M1] [review] Fix missing null check on line 42",
    );

    const msg2 = {
      seq: 5,
      runId: "run-b",
      from: "M1",
      fromRole: "worker" as const,
      text: "[done] Fixed null check and re-ran tests",
      mentions: ["orchestrator"],
      kind: "done" as const,
      missionId: "M1",
      timestamp: "2026-11-20T12:01:00.000Z",
    };
    // Does not duplicate [done] when text already starts with [done]
    assert.equal(
      formatBoardMessage(msg2),
      "#5 [M1 -> @orchestrator] [done] Fixed null check and re-ran tests",
    );

    const msg3 = {
      seq: 6,
      runId: "run-b",
      from: "M2",
      fromRole: "worker" as const,
      text: "reader.ts landed",
      mentions: [],
      kind: "chat" as const,
      timestamp: "2026-11-20T12:02:00.000Z",
    };
    assert.equal(formatBoardMessage(msg3), "#6 [M2] reader.ts landed");

    const formatted = formatBoardMessages([msg1, msg2, msg3]);
    assert.equal(formatted.split("\n").length, 3);
  });

  it("persists monotonic LF-only board.jsonl, supports since/seqs/limit reads, concurrent posts & symlink protection", async () => {
    const root = await makeTempDir("pi-swarm-board-");
    const board = new SwarmBoard(root);

    // Empty board returns head 0
    assert.equal(await board.getHead("run-board"), 0);
    assert.deepEqual(await board.read("run-board"), { messages: [], head: 0 });

    // Concurrent posts serialize cleanly with monotonic seq 1..6
    const posted = await Promise.all([
      board.post("run-board", {
        from: "orchestrator",
        fromRole: "orchestrator",
        text: "@M1 start auth core (email ignored: dev@example.com)",
        kind: "brief",
        missionId: "M1",
      }),
      board.post("run-board", {
        from: "M1",
        fromRole: "worker",
        text: "@validator-M1 [done] ready for audit",
        kind: "done",
        missionId: "M1",
      }),
      board.post("run-board", {
        from: "validator-M1",
        fromRole: "validator",
        text: "@M1 please handle empty token",
        kind: "review",
        missionId: "M1",
      }),
      board.post("run-board", {
        from: "M1",
        fromRole: "worker",
        text: "@validator-M1 fixed in commit abc1234",
        kind: "fix",
        missionId: "M1",
      }),
      board.post("run-board", {
        from: "validator-M1",
        fromRole: "validator",
        text: "@orchestrator clean merge approved",
        kind: "review",
        missionId: "M1",
      }),
      board.post("run-board", {
        from: "orchestrator",
        fromRole: "orchestrator",
        text: "@all M1 merged into main",
        kind: "decision",
        mentions: ["@M2"],
      }),
    ]);

    assert.deepEqual(
      posted.map((m) => m.seq),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(posted[0].mentions, ["M1"]);
    assert.deepEqual(posted[5].mentions, ["all", "M2"]);
    assert.equal(await board.getHead("run-board"), 6);

    // Verify LF-only JSONL on disk at .pi/swarm/runs/<runId>/board.jsonl
    const boardPath = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-board",
      SWARM_BOARD_FILE,
    );
    const rawBoard = await readFile(boardPath, "utf8");
    assert.equal(rawBoard.includes("\r"), false);
    assert.equal(rawBoard.trim().split("\n").length, 6);

    // read({ since }) returns oldest messages after cursor up to limit
    const since2 = await board.read("run-board", { since: 2, limit: 2 });
    assert.equal(since2.head, 6);
    assert.deepEqual(
      since2.messages.map((m) => m.seq),
      [3, 4],
    );

    // read({ seqs }) returns exact matching seqs in ascending order, ignoring missing/duplicate seqs
    const exact = await board.read("run-board", { seqs: [5, 2, 99, 2] });
    assert.equal(exact.head, 6);
    assert.deepEqual(
      exact.messages.map((m) => m.seq),
      [2, 5],
    );

    // read({ limit }) without since returns most recent N in oldest-first order
    const recent3 = await board.read("run-board", { limit: 3 });
    assert.equal(recent3.head, 6);
    assert.deepEqual(
      recent3.messages.map((m) => m.seq),
      [4, 5, 6],
    );

    // Malformed trailing line is ignored gracefully
    await writeFile(boardPath, `${rawBoard}{truncated-json\n`, "utf8");
    const afterCorrupt = await board.read("run-board");
    assert.equal(afterCorrupt.head, 6);
    assert.equal(afterCorrupt.messages.length, 6);

    // Path traversal & symlink protection
    assert.throws(
      () => board.getBoardPath("../escape"),
      (err) => assertProtocolCode(err, "SCOPE_VIOLATION"),
    );

    const outside = path.join(root, "outside-board.jsonl");
    await writeFile(outside, "", "utf8");
    const symRunDir = path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "sym-board");
    await mkdir(symRunDir, { recursive: true });
    await symlink(outside, path.join(symRunDir, SWARM_BOARD_FILE));
    await assert.rejects(
      () => board.read("sym-board"),
      (err) => assertProtocolCode(err, "SCOPE_VIOLATION"),
    );
    await assert.rejects(
      () =>
        board.post("sym-board", {
          from: "orchestrator",
          fromRole: "orchestrator",
          text: "nope",
        }),
      (err) => assertProtocolCode(err, "SCOPE_VIOLATION"),
    );
  });
});

// ============================================================================
// 3. Store Persistence, Locks, Revisions, Reviews, Board Delegation, Warm Roster
// ============================================================================

describe("SwarmStore persistence, state machine, board delegation, warm roster & ledger", () => {
  it("persists state atomically, checks optimistic revisions, renders MISSIONS.md with 3-role models, and recovers stale locks", async () => {
    const root = await makeTempDir("pi-swarm-store-");
    const store = new SwarmStore(root, { staleLockMs: 200 });

    const created = await store.createRun({
      id: "run-1",
      objective: "Implement swarm store",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-owner",
      ownerPid: process.pid,
      keepWorkersWarm: true,
      roleModels: {
        orchestrator: { model: "anthropic/claude-opus-4", thinkingLevel: "high" },
        worker: { model: "openai/gpt-5", thinkingLevel: "medium" },
        validator: { model: "google/gemini-2.5-pro", thinkingLevel: "high" },
        fallbackModels: ["openai/gpt-4.1"],
      },
      missions: [
        makeMission({
          id: "M1",
          title: "Core Logic",
          scope: ["src/core"],
          tasks: ["Create types", { id: "T2", title: "Add tests" }],
        }),
        makeMission({
          id: "M2",
          title: "Deliver Spec",
          kind: "artifact",
          scope: ["docs/spec.md"],
          deps: ["M1"],
        }),
      ],
    });

    assert.equal(created.revision, 1);
    assert.equal(created.validatorEnabled, true);
    assert.equal(created.maxValidationRounds, 3);
    assert.equal(created.finalValidatorEnabled, true);
    assert.equal(created.keepWorkersWarm, true);
    assert.equal(created.roleModels?.worker?.model, "openai/gpt-5");
    assert.equal(created.missions.M1.tasks.length, 2);
    assert.equal(created.missions.M1.tasks[0].id, "T1");
    assert.equal(created.missions.M1.tasks[1].id, "T2");
    assert.equal(await store.getActiveRunId(), "run-1");

    const runs = await store.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].missionCount, 2);

    // Verify MISSIONS.md generated with Swarm header, 3-role models, mission table & Final Verification
    const mdPath = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-1",
      SWARM_MISSIONS_FILE,
    );
    const md1 = await readFile(mdPath, "utf8");
    assert.match(md1, /^# Swarm Missions — run-1/m);
    assert.match(
      md1,
      /\*\*Models:\*\* Orchestrator: `anthropic\/claude-opus-4` \(high\) \| Worker: `openai\/gpt-5` \(medium\) \| Validator: `google\/gemini-2\.5-pro` \(high\) \| Fallbacks: `openai\/gpt-4\.1`/,
    );
    assert.match(
      md1,
      /\| ID \| Title \| Kind \| Deps \| Branch \| Scope \| Status \| Review \| Retries \|/,
    );
    assert.match(
      md1,
      /\| M1 \| Core Logic \| build \| - \| `feat\/core-logic` \| `src\/core` \| planned \| - \| 0 \|/,
    );
    assert.match(md1, /## Final Verification/);

    // Optimistic revision check rejects stale writer
    await assert.rejects(
      () => store.updateRun("run-1", { status: "paused", expectedRevision: 99 }),
      (err) => assertProtocolCode(err, "REVISION_CONFLICT"),
    );

    const paused = await store.updateRun("run-1", {
      status: "paused",
      expectedRevision: 1,
    });
    assert.equal(paused.revision, 2);
    assert.equal(paused.status, "paused");
    assert.equal(await store.getActiveRunId(), "run-1");

    // Simulate a stale lockfile left by a dead PID -> store automatically recovers it
    const lockPath = path.join(root, SWARM_DIR, SWARM_LOCKS_DIR, "run-1.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999_999_999,
        token: "dead-lock",
        hostname: os.hostname(),
        createdAt: new Date(Date.now() - 5_000).toISOString(),
      }),
      "utf8",
    );
    const oldTime = new Date(Date.now() - 5_000);
    await utimes(lockPath, oldTime, oldTime);

    const resumed = await store.updateRun("run-1", {
      status: "active",
      expectedRevision: 2,
    });
    assert.equal(resumed.status, "active");
    assert.equal(resumed.revision, 3);
    assert.equal(await exists(lockPath), false);

    // Concurrent mutations serialize cleanly without lost updates
    await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        store.updateMission("run-1", "M1", {
          progressSummary: `step-${idx}`,
        }),
      ),
    );
    const afterConcurrent = await store.loadRun("run-1");
    assert.equal(afterConcurrent.revision, 11);
  });

  it("delegates board posts/reads, tracks sender lastPostBoardSeq, and handles warm roster lifecycle without spurious worker_exited", async () => {
    const root = await makeTempDir("pi-swarm-warm-");
    const store = new SwarmStore(root);

    await store.createRun({
      id: "run-warm",
      objective: "Warm persistent workers & board delegation",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-warm",
      missions: [
        makeMission({ id: "M1", title: "Auth Core", scope: ["src/auth"] }),
      ],
    });

    // Register worker & validator roster entries
    const afterWorkerSpawn = await store.registerRoster("run-warm", {
      agentId: "wrk-M1-1",
      name: "M1",
      role: "worker",
      missionId: "M1",
      worktreePath: store.getWorktreePath("run-warm", "M1"),
      branch: "feat/auth-core",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
      lastReadBoardSeq: 0,
      turns: 1,
    });
    assert.equal(afterWorkerSpawn.roster["wrk-M1-1"].status, "working");
    assert.equal(afterWorkerSpawn.roster["wrk-M1-1"].model, "openai/gpt-5");
    assert.equal(afterWorkerSpawn.roster["wrk-M1-1"].turns, 1);

    // Duplicate registration while working or waiting is rejected
    await assert.rejects(
      () =>
        store.registerRoster("run-warm", {
          agentId: "wrk-M1-1",
          name: "M1",
          role: "worker",
          missionId: "M1",
          worktreePath: store.getWorktreePath("run-warm", "M1"),
          branch: "feat/auth-core",
        }),
      (err) => assertProtocolCode(err, "INVALID_TRANSITION"),
    );

    // Worker posts to board via store -> updates lastPostBoardSeq & appends single board_posted event
    const msg1 = await store.postBoardMessage("run-warm", {
      from: "M1",
      fromRole: "worker",
      text: "@validator-M1 [done] auth core implemented",
      kind: "done",
      missionId: "M1",
    });
    assert.equal(msg1.seq, 1);
    assert.deepEqual(msg1.mentions, ["validator-M1"]);
    assert.equal(await store.getBoardHead("run-warm"), 1);

    const afterPost = await store.loadRun("run-warm");
    assert.equal(afterPost.roster["wrk-M1-1"].lastPostBoardSeq, 1);

    // Orchestrator post does not need a roster entry and still records seq #2 + board_posted
    const msg2 = await store.postBoardMessage("run-warm", {
      from: ORCHESTRATOR_BOARD_NAME,
      fromRole: "orchestrator",
      text: "@validator-M1 please audit M1",
      kind: "brief",
      missionId: "M1",
    });
    assert.equal(msg2.seq, 2);

    const boardRead = await store.readBoard("run-warm", { since: 0 });
    assert.equal(boardRead.head, 2);
    assert.equal(boardRead.messages.length, 2);

    // Transition worker: working -> waiting (MUST NOT emit worker_exited!)
    const waitingState = await store.updateRoster("run-warm", "wrk-M1-1", {
      status: "waiting",
      lastReadBoardSeq: 2,
      currentActivity: null,
    });
    assert.equal(waitingState.roster["wrk-M1-1"].status, "waiting");
    assert.equal(waitingState.roster["wrk-M1-1"].lastReadBoardSeq, 2);
    assert.equal(waitingState.roster["wrk-M1-1"].currentActivity, undefined);

    // Register validator -> emits validator_spawned
    await store.registerRoster("run-warm", {
      agentId: "val-M1-1",
      name: "validator-M1",
      role: "validator",
      missionId: "M1",
      worktreePath: store.getWorktreePath("run-warm", "M1"),
      branch: "feat/auth-core",
      model: "anthropic/claude-sonnet-4",
    });

    // Wake worker & hot-switch model + clear thinkingLevel: waiting -> working (NO worker_exited!)
    const wokenState = await store.updateRoster("run-warm", "wrk-M1-1", {
      status: "working",
      model: "anthropic/claude-opus-4",
      thinkingLevel: null,
      turns: 2,
      endedAt: null,
      currentActivity: "Addressing validator findings",
    });
    assert.equal(wokenState.roster["wrk-M1-1"].status, "working");
    assert.equal(wokenState.roster["wrk-M1-1"].model, "anthropic/claude-opus-4");
    assert.equal(wokenState.roster["wrk-M1-1"].thinkingLevel, undefined);
    assert.equal(wokenState.roster["wrk-M1-1"].turns, 2);
    assert.equal(
      wokenState.roster["wrk-M1-1"].currentActivity,
      "Addressing validator findings",
    );

    // Check ledger so far: ZERO worker_exited events during working -> waiting -> working!
    const midEvents = await store.getRecentEvents("run-warm", 50);
    assert.equal(
      midEvents.filter((e) => e.type === "worker_spawned").length,
      1,
    );
    assert.equal(
      midEvents.filter((e) => e.type === "validator_spawned").length,
      1,
    );
    assert.equal(midEvents.filter((e) => e.type === "board_posted").length, 2);
    assert.equal(midEvents.filter((e) => e.type === "worker_exited").length, 0);

    // Kill worker permanently -> emits agent_killed
    const killedState = await store.updateRoster("run-warm", "wrk-M1-1", {
      status: "killed",
      endedAt: new Date().toISOString(),
    });
    assert.equal(killedState.roster["wrk-M1-1"].status, "killed");

    // Validator fails -> emits worker_exited
    await store.updateRoster("run-warm", "val-M1-1", {
      status: "failed",
      error: "Provider timeout",
      endedAt: new Date().toISOString(),
    });

    const finalEvents = await store.getRecentEvents("run-warm", 50);
    assert.equal(
      finalEvents.filter((e) => e.type === "agent_killed").length,
      1,
    );
    assert.equal(
      finalEvents.filter((e) => e.type === "worker_exited").length,
      1,
    );
  });

  it("enforces transitions, validator role checks, scope patching, validation_submitted auto-flip, and artifact approval", async () => {
    const root = await makeTempDir("pi-swarm-lifecycle-");
    const store = new SwarmStore(root);

    await store.createRun({
      id: "run-life",
      objective: "Full mission lifecycle",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-1",
      missions: [
        makeMission({ id: "M1", title: "Build Feature", scope: ["src/feat"] }),
        makeMission({ id: "M2", title: "Other Feature", scope: ["src/other"] }),
        makeMission({
          id: "A1",
          title: "Generate Audit Report",
          kind: "artifact",
          scope: ["docs/audit.md"],
        }),
      ],
    });

    // Invalid transition: planned -> merged or planned -> completed
    await assert.rejects(
      () => store.updateMission("run-life", "M1", { status: "completed" }),
      (err) => assertProtocolCode(err, "INVALID_TRANSITION"),
    );
    await assert.rejects(
      () => store.markMerged("run-life", "M1", "sha1"),
      (err) => assertProtocolCode(err, "INVALID_TRANSITION"),
    );

    // Role enforcement: worker cannot abandon or merge; validator cannot mutate mission or patch scope
    await assert.rejects(
      () =>
        store.updateMission("run-life", "M1", {
          status: "abandoned",
          callerRole: "worker",
        }),
      (err) => assertProtocolCode(err, "ROLE_FORBIDDEN"),
    );
    await assert.rejects(
      () =>
        store.updateMission("run-life", "M1", {
          status: "active",
          callerRole: "validator",
        }),
      (err) => assertProtocolCode(err, "ROLE_FORBIDDEN"),
    );
    await assert.rejects(
      () =>
        store.patchMissionScope("run-life", "M1", ["src/feat", "src/extra"], {
          callerRole: "validator",
        }),
      (err) => assertProtocolCode(err, "ROLE_FORBIDDEN"),
    );

    // Scope patching rejects overlap with M2, accepts disjoint expansion
    await assert.rejects(
      () =>
        store.patchMissionScope(
          "run-life",
          "M1",
          ["src/feat", "src/other/sub.ts"],
          { callerRole: "worker" },
        ),
      (err) => assertProtocolCode(err, "SCOPE_OVERLAP"),
    );
    const patched = await store.patchMissionScope(
      "run-life",
      "M1",
      ["src/feat", "src/shared-utils"],
      { callerRole: "worker" },
    );
    assert.deepEqual(patched.missions.M1.scope, [
      "src/feat",
      "src/shared-utils",
    ]);

    // Worker runs M1 -> active -> completed
    await store.updateMission("run-life", "M1", {
      status: "active",
      callerRole: "worker",
    });
    await store.updateMission("run-life", "M1", {
      status: "completed",
      progressSummary: "Implemented feature",
      callerRole: "worker",
    });

    // Round 1 non-clean review automatically flips completed -> active & persists verdict file!
    const badVerdict: MissionReviewVerdict = {
      commitSha: "1111111abcdef",
      missionId: "M1",
      branch: "feat/build-feature",
      reviewedAt: new Date().toISOString(),
      reviewerAgentId: "validator-M1",
      status: "p1-1items",
      merge: "fix-then-merge",
      findings: [
        {
          severity: "p1",
          title: "Missing null check",
          detail: "Handle empty input safely",
          file: "src/feat/index.ts",
          line: 42,
        },
      ],
      checks: [{ name: "npm test", passed: true }],
      decision: "Fix p1 issue before merge",
    };

    const afterR1 = await store.recordReview("run-life", "M1", badVerdict);
    assert.equal(afterR1.missions.M1.status, "active");
    assert.equal(afterR1.missions.M1.reviewRound, 1);
    assert.equal(afterR1.missions.M1.lastReviewedSha, "1111111abcdef");

    const r1File = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-life",
      SWARM_REVIEWS_DIR,
      "M1-r1.json",
    );
    const r1Disk = JSON.parse(
      await readFile(r1File, "utf8"),
    ) as MissionReviewVerdict;
    assert.equal(r1Disk.round, 1);
    assert.equal(r1Disk.status, "p1-1items");

    // Worker fixes & re-completes -> Round 2 "clean" + "hold" ALSO flips completed -> active!
    await store.updateMission("run-life", "M1", {
      status: "completed",
      callerRole: "worker",
    });
    const holdVerdict: MissionReviewVerdict = {
      commitSha: "1515151abcdef",
      missionId: "M1",
      branch: "feat/build-feature",
      reviewedAt: new Date().toISOString(),
      reviewerAgentId: "validator-M1",
      status: "clean",
      merge: "hold",
      findings: [],
      checks: [{ name: "npm test", passed: true }],
      decision: "Hold pending follow-up check",
    };
    const afterHold = await store.recordReview("run-life", "M1", holdVerdict);
    assert.equal(afterHold.missions.M1.status, "active");
    assert.equal(afterHold.missions.M1.reviewRound, 2);

    // Worker re-completes -> Round 3 clean + merge keeps status "completed"
    await store.updateMission("run-life", "M1", {
      status: "completed",
      callerRole: "worker",
    });
    const cleanVerdict: MissionReviewVerdict = {
      commitSha: "2222222abcdef",
      missionId: "M1",
      branch: "feat/build-feature",
      reviewedAt: new Date().toISOString(),
      reviewerAgentId: "validator-M1",
      status: "clean",
      merge: "merge",
      findings: [],
      checks: [{ name: "npm test", passed: true }],
      decision: "Clean and ready to merge",
    };

    const afterR3 = await store.recordReview("run-life", "M1", cleanVerdict);
    assert.equal(afterR3.missions.M1.status, "completed");
    assert.equal(afterR3.missions.M1.reviewRound, 3);
    assert.equal(afterR3.missions.M1.lastReviewedSha, "2222222abcdef");

    const reviewEvents = (await store.getRecentEvents("run-life", 50)).filter(
      (e) => e.type === "validation_submitted",
    );
    assert.equal(reviewEvents.length, 3);

    // Worker cannot call markMerged
    await assert.rejects(
      () => store.markMerged("run-life", "M1", "3333333", { callerRole: "worker" }),
      (err) => assertProtocolCode(err, "ROLE_FORBIDDEN"),
    );

    // Orchestrator merges M1 -> terminal state blocks further transitions
    const merged = await store.markMerged("run-life", "M1", "3333333abcdef");
    assert.equal(merged.missions.M1.status, "merged");
    assert.equal(merged.missions.M1.mergedCommitSha, "3333333abcdef");
    await assert.rejects(
      () => store.updateMission("run-life", "M1", { status: "active" }),
      (err) => assertProtocolCode(err, "INVALID_TRANSITION"),
    );

    // Artifact approval works on artifact mission A1 and rejects build mission M2
    await assert.rejects(
      () => store.approveArtifact("run-life", "M2", "aaaa1111"),
      (err) => assertProtocolCode(err, "INVALID_TRANSITION"),
    );
    const approved = await store.approveArtifact("run-life", "A1", "aaaa1111bbbb", {
      approvedBy: "human",
    });
    assert.equal(approved.missions.A1.humanApprovedSha, "aaaa1111bbbb");
    assert.ok(approved.missions.A1.humanApprovedAt);

    // Verify MISSIONS.md updated with both review badge and artifact approval
    const md = await readFile(
      path.join(
        root,
        SWARM_DIR,
        SWARM_RUNS_DIR,
        "run-life",
        SWARM_MISSIONS_FILE,
      ),
      "utf8",
    );
    assert.match(md, /clean \(merge\) @2222222/);
    assert.match(md, /approved @aaaa111/);
  });

  it("supports inbox queues, findings, roster logTail bounding, ledger formatting, symlink protection & ownership checks", async () => {
    const root = await makeTempDir("pi-swarm-comms-");
    const store = new SwarmStore(root, {
      isPidAlive: (pid) => pid === 4242,
    });

    const state = await store.createRun({
      id: "run-comms",
      objective: "Comms & audit",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-A",
      ownerPid: 4242,
      missions: [
        makeMission({
          id: "S1",
          title: "Explore Codebase",
          kind: "survey",
          scope: ["src"],
        }),
      ],
    });

    // Live-session ownership check
    await store.assertOwnerSession("run-comms", "sess-A");
    await assert.rejects(
      () => store.assertOwnerSession("run-comms", "sess-B"),
      (err) => assertProtocolCode(err, "OWNERSHIP_CONFLICT"),
    );
    // Dead PID allows takeover
    assertOwnerSession({ ...state, ownerPid: 9999 }, "sess-B", {
      isPidAlive: (pid) => pid === 4242,
    });

    // Inbox send, unread read, markRead
    const m1 = await store.sendMessage("run-comms", {
      from: "orchestrator",
      to: "S1",
      missionId: "S1",
      text: "Check auth middleware",
    });
    const m2 = await store.sendMessage("run-comms", {
      from: "orchestrator",
      to: "S1",
      missionId: "S1",
      text: "Also inspect session cookies",
    });
    assert.ok(m1.id && m2.id);

    const unread1 = await store.readInbox("run-comms", "S1", {
      unreadOnly: true,
      markRead: true,
      limit: 1,
    });
    assert.equal(unread1.length, 1);
    assert.equal(unread1[0].id, m1.id);
    assert.ok(unread1[0].readAt);

    const unread2 = await store.readInbox("run-comms", "S1", {
      unreadOnly: true,
      markRead: true,
    });
    assert.equal(unread2.length, 1);
    assert.equal(unread2[0].id, m2.id);

    const unreadAfter = await store.readInbox("run-comms", "S1", {
      unreadOnly: true,
    });
    assert.equal(unreadAfter.length, 0);

    const allMsgs = await store.readInbox("run-comms", "S1");
    assert.equal(allMsgs.length, 2);

    // Findings persisted to file and run state
    const finding = await store.recordFinding("run-comms", {
      missionId: "S1",
      author: "worker-S1",
      title: "JWT expiry bug",
      summary: "Refresh token never rotates",
      details: "Detailed trace...",
      files: ["src/auth/jwt.ts"],
    });
    const loaded = await store.loadRun("run-comms");
    assert.equal(loaded.findings.length, 1);
    assert.equal(loaded.findings[0].id, finding.id);

    // Roster logTail bounding
    await store.registerRoster("run-comms", {
      agentId: "agent-1",
      name: "S1",
      role: "worker",
      missionId: "S1",
      worktreePath: store.getWorktreePath("run-comms", "S1"),
      branch: loaded.missions.S1.branch,
    });
    for (let i = 0; i < SWARM_LOG_TAIL_LIMIT + 10; i += 1) {
      await store.updateRoster("run-comms", "agent-1", { logLine: `line-${i}` });
    }
    const afterLogs = await store.loadRun("run-comms");
    assert.equal(
      afterLogs.roster["agent-1"].logTail.length,
      SWARM_LOG_TAIL_LIMIT,
    );
    assert.equal(afterLogs.roster["agent-1"].logTail[0], "line-10");

    // Append-only ledger ordering & formatting
    const recent = await store.getRecentEvents("run-comms", 3);
    assert.equal(recent.length, 3);
    assert.ok((recent[0].seq ?? 0) < (recent[1].seq ?? 0));
    const formatted = formatLedgerActivity(recent);
    assert.match(formatted, /finding_recorded/);

    // Direct SwarmLedger handles corrupted trailing line gracefully
    const ledgerPath = path.join(root, "custom-events.jsonl");
    const ledger = new SwarmLedger(ledgerPath);
    await ledger.append({ runId: "r", type: "run_created", summary: "first" });
    await writeFile(
      ledgerPath,
      `${await readFile(ledgerPath, "utf8")}{broken-json\n`,
      "utf8",
    );
    const allEvts = await ledger.readAll();
    assert.equal(allEvts.length, 1);
    assert.equal(allEvts[0].summary, "first");

    // Format new SwarmEventType values cleanly
    const ts = "2026-11-20T12:00:00.000Z";
    const swarmEvts: SwarmEvent[] = [
      {
        id: "b1",
        runId: "r",
        type: "board_posted",
        timestamp: ts,
        actor: "M1",
        summary: "Posted update",
        data: { seq: 7, kind: "done" },
      },
      {
        id: "w1",
        runId: "r",
        type: "agent_woken",
        timestamp: ts,
        actor: "M1",
        missionId: "M1",
        summary: "Woken by validator",
        data: { boardSeq: 8 },
      },
      {
        id: "m1",
        runId: "r",
        type: "agent_model_switched",
        timestamp: ts,
        actor: "orchestrator",
        missionId: "M1",
        summary: "Switched on rate limit",
        data: { previousModel: "openai/gpt-5", model: "anthropic/claude-opus-4" },
      },
      {
        id: "k1",
        runId: "r",
        type: "agent_killed",
        timestamp: ts,
        actor: "orchestrator",
        missionId: "M1",
        summary: 'worker "M1" killed.',
      },
      {
        id: "v1",
        runId: "r",
        type: "validator_spawned",
        timestamp: ts,
        actor: "orchestrator",
        missionId: "M1",
        summary: "Spawned validator",
        data: { model: "google/gemini-2.5-pro" },
      },
      {
        id: "v2",
        runId: "r",
        type: "validation_submitted",
        timestamp: ts,
        actor: "validator-M1",
        missionId: "M1",
        summary: "Checked diff",
        data: { status: "clean", merge: "merge" },
      },
    ];
    assert.match(formatLedgerEvent(swarmEvts[0]), /board_posted \[#7 · done\] \(M1\)/);
    assert.match(formatLedgerEvent(swarmEvts[1]), /agent_woken \[M1 · #8\] \(M1\)/);
    assert.match(
      formatLedgerEvent(swarmEvts[2]),
      /agent_model_switched \[M1 · openai\/gpt-5 -> anthropic\/claude-opus-4\] \(orchestrator\)/,
    );
    assert.match(formatLedgerEvent(swarmEvts[3]), /agent_killed \[M1\] \(orchestrator\)/);
    assert.match(
      formatLedgerEvent(swarmEvts[4]),
      /validator_spawned \[M1 · google\/gemini-2\.5-pro\] \(orchestrator\)/,
    );
    assert.match(
      formatLedgerEvent(swarmEvts[5]),
      /validation_submitted \[M1 · clean · merge\] \(validator-M1\)/,
    );

    // Path traversal & symlink protection
    assert.throws(
      () => store.getRunDir("../escape"),
      (err) => assertProtocolCode(err, "SCOPE_VIOLATION"),
    );

    const symlinkTarget = path.join(root, "outside.json");
    await writeFile(symlinkTarget, "{}", "utf8");
    const evilRunDir = path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "evil-sym");
    await mkdir(evilRunDir, { recursive: true });
    await symlink(symlinkTarget, path.join(evilRunDir, SWARM_STATE_FILE));
    await assert.rejects(
      () => store.loadRun("evil-sym"),
      (err) => assertProtocolCode(err, "SCOPE_VIOLATION"),
    );
  });
});

// ============================================================================
// 4. Layered Settings Loader/Saver & 3-Role Models + fallbackModels + keepWorkersWarm
// ============================================================================

describe("Layered SwarmSettings loader, saver & sanitization", () => {
  it("uses pi-swarm-settings.json paths, merges defaults <- global <- project, and clamps invalid bounds", async () => {
    const tmp = await makeTempDir("pi-swarm-settings-");
    const globalDir = path.join(tmp, "global-agent");
    const projectRoot = path.join(tmp, "project");
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    assert.equal(
      getGlobalSettingsPath({ globalDir }),
      path.join(globalDir, SWARM_SETTINGS_FILE),
    );
    assert.equal(
      getProjectSettingsPath(projectRoot),
      path.join(projectRoot, ".pi", SWARM_SETTINGS_FILE),
    );

    // Defaults when neither file exists
    const defaults = await loadSwarmSettings(projectRoot, { globalDir });
    assert.deepEqual(defaults, DEFAULT_SWARM_SETTINGS);
    assert.equal(defaults.keepWorkersWarm, true);
    assert.deepEqual(defaults.fallbackModels, []);

    // Save global layer with 3-role models + fallbackModels
    await saveSwarmSettings(
      "global",
      {
        maxConcurrency: 5,
        orchestratorModel: "anthropic/claude-opus-4",
        orchestratorThinkingLevel: "high",
        workerModel: "openai/gpt-5",
        workerThinkingLevel: "medium",
        validatorModel: "google/gemini-2.5-pro",
        validatorThinkingLevel: "xhigh",
        fallbackModels: [
          "  openai/gpt-4.1  ",
          "",
          "anthropic/claude-sonnet-4",
          "openai/gpt-4.1", // duplicate -> deduped
        ],
        keepWorkersWarm: false,
        autoRebase: false,
      },
      { globalDir, projectRoot },
    );

    const afterGlobal = await loadSwarmSettings(projectRoot, { globalDir });
    assert.equal(afterGlobal.orchestratorModel, "anthropic/claude-opus-4");
    assert.equal(afterGlobal.orchestratorThinkingLevel, "high");
    assert.equal(afterGlobal.workerModel, "openai/gpt-5");
    assert.equal(afterGlobal.workerThinkingLevel, "medium");
    assert.equal(afterGlobal.validatorModel, "google/gemini-2.5-pro");
    assert.equal(afterGlobal.validatorThinkingLevel, "xhigh");
    assert.deepEqual(afterGlobal.fallbackModels, [
      "openai/gpt-4.1",
      "anthropic/claude-sonnet-4",
    ]);
    assert.equal(afterGlobal.keepWorkersWarm, false);

    // Save project layer overriding select keys and testing out-of-range clamping
    await saveSwarmSettings(
      "project",
      {
        maxConcurrency: 0, // should clamp to 1
        maxValidationRounds: 99, // should clamp to 10
        rateLimitBaseBackoffMs: 10_000,
        rateLimitMaxBackoffMs: 2_000, // should clamp >= base (10_000)
        workerModel: "", // clears global workerModel
        keepWorkersWarm: true,
      },
      { globalDir, projectRoot },
    );

    const layered = await loadLayeredSwarmSettings(projectRoot, { globalDir });
    assert.equal(layered.settings.maxConcurrency, 1);
    assert.equal(layered.settings.maxValidationRounds, 10);
    assert.equal(layered.settings.rateLimitBaseBackoffMs, 10_000);
    assert.equal(layered.settings.rateLimitMaxBackoffMs, 10_000);
    assert.equal(layered.settings.autoRebase, false); // inherited from global
    assert.equal(layered.settings.keepWorkersWarm, true); // overridden by project
    assert.equal(layered.settings.workerThinkingLevel, "medium"); // inherited from global
    assert.equal(layered.settings.workerModel, undefined); // cleared by project ""
    assert.equal(layered.settings.orchestratorModel, "anthropic/claude-opus-4");
    assert.equal(layered.settings.validatorModel, "google/gemini-2.5-pro");

    // Sanitizer ignores invalid thinking level and non-numeric values
    const sanitized = sanitizeSwarmSettings({
      maxConcurrency: Number.NaN,
      maxValidationRounds: -4,
      validatorThinkingLevel: "ultra-invalid" as never,
      keepWorkersWarm: "yes" as never,
      fallbackModels: ["  m1  ", 42 as never, "", "m2", "m1"],
      gitTimeoutMs: 50,
    });
    assert.equal(sanitized.maxConcurrency, DEFAULT_SWARM_SETTINGS.maxConcurrency);
    assert.equal(sanitized.maxValidationRounds, 1);
    assert.equal(sanitized.validatorThinkingLevel, undefined);
    assert.equal(sanitized.keepWorkersWarm, true);
    assert.deepEqual(sanitized.fallbackModels, ["m1", "m2"]);
    assert.equal(sanitized.gitTimeoutMs, 1_000);
  });

  it("supports Validator & Final Validator settings defaults, bounds (1..10), and project-layer null clears", async () => {
    const tmp = await makeTempDir("pi-swarm-validator-settings-");
    const globalDir = path.join(tmp, "global-agent");
    const projectRoot = path.join(tmp, "project");
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    // Defaults
    const defaults = await loadSwarmSettings(projectRoot, { globalDir });
    assert.equal(defaults.validatorEnabled, true);
    assert.equal(defaults.finalValidatorEnabled, true);
    assert.equal(defaults.maxValidationRounds, 3);
    assert.equal(defaults.maxFinalAuditRounds, 2);
    assert.equal(defaults.autoFixOnAuditFail, true);
    assert.equal(defaults.validatorModel, undefined);
    assert.equal(defaults.validatorThinkingLevel, undefined);

    // Bounds & invalid value clamping
    const clampedLow = sanitizeSwarmSettings({
      validatorEnabled: "not-a-bool" as never,
      finalValidatorEnabled: "not-a-bool" as never,
      maxValidationRounds: 0,
      maxFinalAuditRounds: 0,
      autoFixOnAuditFail: 123 as never,
      orchestratorModel: "   ",
      validatorModel: "   ",
      validatorThinkingLevel: "bogus" as never,
    });
    assert.equal(clampedLow.validatorEnabled, true);
    assert.equal(clampedLow.finalValidatorEnabled, true);
    assert.equal(clampedLow.maxValidationRounds, 1);
    assert.equal(clampedLow.maxFinalAuditRounds, 1);
    assert.equal(clampedLow.autoFixOnAuditFail, true);
    assert.equal(clampedLow.orchestratorModel, undefined);
    assert.equal(clampedLow.validatorModel, undefined);
    assert.equal(clampedLow.validatorThinkingLevel, undefined);

    const clampedHigh = sanitizeSwarmSettings({
      finalValidatorEnabled: false,
      maxFinalAuditRounds: 42,
      autoFixOnAuditFail: false,
      validatorModel: "  anthropic/claude-opus-4  ",
      validatorThinkingLevel: "xhigh",
    });
    assert.equal(clampedHigh.finalValidatorEnabled, false);
    assert.equal(clampedHigh.maxFinalAuditRounds, 10);
    assert.equal(clampedHigh.autoFixOnAuditFail, false);
    assert.equal(clampedHigh.validatorModel, "anthropic/claude-opus-4");
    assert.equal(clampedHigh.validatorThinkingLevel, "xhigh");

    // Global sets models, thinking levels & fallbackModels; project clears via null
    await saveSwarmSettings(
      "global",
      {
        finalValidatorEnabled: true,
        maxFinalAuditRounds: 4,
        autoFixOnAuditFail: false,
        orchestratorModel: "anthropic/claude-opus-4",
        orchestratorThinkingLevel: "high",
        validatorModel: "openai/gpt-5",
        validatorThinkingLevel: "high",
        fallbackModels: ["openai/gpt-4.1", "google/gemini-2.5-pro"],
      },
      { globalDir, projectRoot },
    );

    const inherited = await loadSwarmSettings(projectRoot, { globalDir });
    assert.equal(inherited.maxFinalAuditRounds, 4);
    assert.equal(inherited.autoFixOnAuditFail, false);
    assert.equal(inherited.orchestratorModel, "anthropic/claude-opus-4");
    assert.equal(inherited.validatorModel, "openai/gpt-5");
    assert.equal(inherited.validatorThinkingLevel, "high");
    assert.deepEqual(inherited.fallbackModels, [
      "openai/gpt-4.1",
      "google/gemini-2.5-pro",
    ]);

    await saveSwarmSettings(
      "project",
      {
        maxFinalAuditRounds: 99, // clamps to 10
        orchestratorModel: null as unknown as undefined,
        validatorModel: null as unknown as undefined,
        validatorThinkingLevel: null as unknown as undefined,
        fallbackModels: null as unknown as string[],
      },
      { globalDir, projectRoot },
    );

    const layered = await loadLayeredSwarmSettings(projectRoot, { globalDir });
    assert.equal(layered.settings.maxFinalAuditRounds, 10);
    assert.equal(layered.settings.autoFixOnAuditFail, false); // inherited from global
    assert.equal(layered.settings.orchestratorModel, undefined); // cleared by project null
    assert.equal(layered.settings.validatorModel, undefined); // cleared by project null
    assert.equal(layered.settings.validatorThinkingLevel, undefined); // cleared by project null
    assert.deepEqual(layered.settings.fallbackModels, []); // cleared by project null

    // Verify null persisted cleanly in project file
    const rawProject = JSON.parse(
      await readFile(layered.projectPath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(rawProject.orchestratorModel, null);
    assert.equal(rawProject.validatorModel, null);
    assert.equal(rawProject.validatorThinkingLevel, null);
    assert.equal(rawProject.fallbackModels, null);

    // Explicit undefined removes project override so global is inherited again
    await saveSwarmSettings(
      "project",
      {
        orchestratorModel: undefined,
        validatorModel: undefined,
        validatorThinkingLevel: undefined,
        fallbackModels: undefined,
      },
      { globalDir, projectRoot },
    );
    const reInherited = await loadSwarmSettings(projectRoot, { globalDir });
    assert.equal(reInherited.orchestratorModel, "anthropic/claude-opus-4");
    assert.equal(reInherited.validatorModel, "openai/gpt-5");
    assert.equal(reInherited.validatorThinkingLevel, "high");
    assert.deepEqual(reInherited.fallbackModels, [
      "openai/gpt-4.1",
      "google/gemini-2.5-pro",
    ]);
  });
});

// ============================================================================
// 5. Run-Level Final Validator / Goal Auditor Store Contract
// ============================================================================

describe("SwarmStore Final Validator / Goal Auditor lifecycle", () => {
  it("initializes final-audit & swarm defaults, creates audits/ dir, and backfills partial state.json on loadRun", async () => {
    const root = await makeTempDir("pi-swarm-audit-init-");
    const store = new SwarmStore(root);

    const created = await store.createRun({
      id: "run-audit-init",
      objective: "Verify final audit initialization",
      verificationContract: "npm test && npm run typecheck",
      baseBranch: "main",
      ownerSessionId: "sess-1",
      missions: [
        makeMission({ id: "M1", title: "Init Feature", scope: ["src/init"] }),
      ],
    });

    assert.equal(created.finalValidatorEnabled, true);
    assert.equal(created.maxFinalAuditRounds, 2);
    assert.equal(created.autoFixOnAuditFail, true);
    assert.equal(created.keepWorkersWarm, true);
    assert.equal(created.finalAuditStatus, "idle");
    assert.equal(created.finalAuditRound, 0);

    // audits/ directory exists immediately after createRun
    const auditsDir = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-audit-init",
      SWARM_AUDITS_DIR,
    );
    assert.equal(await exists(auditsDir), true);

    // Simulate a partial state.json missing optional newer fields
    const statePath = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-audit-init",
      SWARM_STATE_FILE,
    );
    const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    delete raw.validatorEnabled;
    delete raw.maxValidationRounds;
    delete raw.finalValidatorEnabled;
    delete raw.maxFinalAuditRounds;
    delete raw.autoFixOnAuditFail;
    delete raw.keepWorkersWarm;
    delete raw.finalAuditStatus;
    delete raw.finalAuditRound;
    await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const backfilled = await store.loadRun("run-audit-init");
    assert.equal(
      backfilled.validatorEnabled,
      DEFAULT_SWARM_SETTINGS.validatorEnabled,
    );
    assert.equal(
      backfilled.maxValidationRounds,
      DEFAULT_SWARM_SETTINGS.maxValidationRounds,
    );
    assert.equal(
      backfilled.finalValidatorEnabled,
      DEFAULT_SWARM_SETTINGS.finalValidatorEnabled,
    );
    assert.equal(
      backfilled.maxFinalAuditRounds,
      DEFAULT_SWARM_SETTINGS.maxFinalAuditRounds,
    );
    assert.equal(
      backfilled.autoFixOnAuditFail,
      DEFAULT_SWARM_SETTINGS.autoFixOnAuditFail,
    );
    assert.equal(
      backfilled.keepWorkersWarm,
      DEFAULT_SWARM_SETTINGS.keepWorkersWarm,
    );
    assert.equal(backfilled.finalAuditStatus, "idle");
    assert.equal(backfilled.finalAuditRound, 0);
  });

  it("supports final-validator roster with FINAL_AUDIT_MISSION_ID, blocks validator mutations, and persists audits/MISSIONS.md/ledger", async () => {
    const root = await makeTempDir("pi-swarm-audit-flow-");
    const store = new SwarmStore(root);

    await store.createRun({
      id: "run-audit",
      objective: "End-to-end audit flow",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-audit",
      maxFinalAuditRounds: 3,
      missions: [
        makeMission({ id: "M1", title: "Core Module", scope: ["src/core"] }),
      ],
    });

    // Validator cannot mutate missions or patch scope
    await assert.rejects(
      () =>
        store.updateMission("run-audit", "M1", {
          status: "active",
          callerRole: "validator",
        }),
      (err) => assertProtocolCode(err, "ROLE_FORBIDDEN"),
    );
    await assert.rejects(
      () =>
        store.patchMissionScope("run-audit", "M1", ["src/core", "src/extra"], {
          callerRole: "validator",
        }),
      (err) => assertProtocolCode(err, "ROLE_FORBIDDEN"),
    );

    // Non-final-validator roles cannot register with FINAL_AUDIT_MISSION_ID
    for (const nonFinalRole of ["worker", "validator"] as const) {
      await assert.rejects(
        () =>
          store.registerRoster("run-audit", {
            agentId: `bad-${nonFinalRole}`,
            name: `${nonFinalRole}-run`,
            role: nonFinalRole,
            missionId: FINAL_AUDIT_MISSION_ID,
            worktreePath: root,
            branch: "main",
          }),
        (err) => assertProtocolCode(err, "NOT_FOUND"),
      );
    }

    // Transition run -> verifying + finalAuditStatus -> running (must NOT duplicate final_audit_started)
    const verifying = await store.updateRun("run-audit", {
      status: "verifying",
      finalAuditStatus: "running",
    });
    assert.equal(verifying.status, "verifying");
    assert.equal(verifying.finalAuditStatus, "running");
    assert.equal(await store.getActiveRunId(), "run-audit");

    // Register Final Validator roster entry with FINAL_AUDIT_MISSION_ID -> auto-emits single final_audit_started
    const withFinalValidator = await store.registerRoster("run-audit", {
      agentId: "final-val-r1",
      name: FINAL_VALIDATOR_BOARD_NAME,
      role: "final-validator",
      missionId: FINAL_AUDIT_MISSION_ID,
      worktreePath: root,
      branch: "main",
    });
    assert.equal(
      withFinalValidator.roster["final-val-r1"].role,
      "final-validator",
    );
    assert.equal(
      withFinalValidator.roster["final-val-r1"].missionId,
      FINAL_AUDIT_MISSION_ID,
    );

    // Validation errors on recordFinalAudit
    await assert.rejects(
      () =>
        store.recordFinalAudit("run-audit", {
          commitSha: "abc1234",
          baseBranch: "main",
          auditedAt: new Date().toISOString(),
          verifierAgentId: "final-val-r1",
          verdict: "maybe" as never,
          summary: "Invalid verdict",
          checks: [],
          findings: [],
          round: 1,
        }),
      (err) => assertProtocolCode(err, "INVALID_TRANSITION"),
    );
    await assert.rejects(
      () =>
        store.recordFinalAudit("run-audit", {
          commitSha: "   ",
          baseBranch: "main",
          auditedAt: new Date().toISOString(),
          verifierAgentId: "final-val-r1",
          verdict: "approved",
          summary: "Missing commit sha",
          checks: [],
          findings: [],
          round: 1,
        }),
      (err) => assertProtocolCode(err, "AUDIT_REQUIRED"),
    );
    await assert.rejects(
      () =>
        store.recordFinalAudit("run-audit", {
          commitSha: "abc1234567890",
          baseBranch: "main",
          auditedAt: new Date().toISOString(),
          verifierAgentId: "final-val-r1",
          verdict: "approved",
          summary: "   ",
          checks: [],
          findings: [],
          round: 1,
        }),
      (err) => assertProtocolCode(err, "AUDIT_REQUIRED"),
    );

    // Record Round 1 disapproved verdict
    const r1Verdict: FinalAuditVerdict = {
      commitSha: "deadbeef1234567",
      baseBranch: "main",
      auditedAt: new Date().toISOString(),
      verifierAgentId: "final-val-r1",
      verdict: "disapproved",
      summary: "Integration test failed on empty token",
      checks: [
        { name: "npm run typecheck", passed: true },
        { name: "npm test", passed: false, detail: "1 failing test" },
      ],
      findings: [
        {
          severity: "p1",
          title: "Missing empty token guard",
          detail: "Auth middleware throws on empty bearer header",
          file: "src/core/auth.ts",
          line: 18,
        },
      ],
      recommendedMissions: [
        {
          title: "Guard Empty Bearer Token",
          description: "Handle empty bearer header gracefully",
          scope: ["src/core"],
          verification: "npm test",
        },
      ],
      round: 1,
    };

    const afterR1 = await store.recordFinalAudit("run-audit", r1Verdict);
    assert.equal(afterR1.finalAuditStatus, "disapproved");
    assert.equal(afterR1.finalAuditRound, 1);
    assert.equal(afterR1.lastAuditedSha, "deadbeef1234567");
    assert.equal(afterR1.latestFinalAudit?.verdict, "disapproved");

    // Verify atomic persistence to audits/audit-r1.json
    const r1Path = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-audit",
      SWARM_AUDITS_DIR,
      "audit-r1.json",
    );
    const r1Disk = JSON.parse(
      await readFile(r1Path, "utf8"),
    ) as FinalAuditVerdict;
    assert.equal(r1Disk.round, 1);
    assert.equal(r1Disk.commitSha, "deadbeef1234567");
    assert.equal(r1Disk.verdict, "disapproved");
    assert.equal(r1Disk.findings.length, 1);

    // Verify MISSIONS.md includes Final Verification section
    const mdPath = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-audit",
      SWARM_MISSIONS_FILE,
    );
    const md1 = await readFile(mdPath, "utf8");
    assert.match(md1, /## Final Verification/);
    assert.match(md1, /\*\*Enabled:\*\* yes \(auto-fix: yes\)/);
    assert.match(md1, /\*\*Status:\*\* `disapproved`/);
    assert.match(md1, /\*\*Rounds:\*\* 1\/3/);
    assert.match(md1, /\*\*Last Audited SHA:\*\* `deadbee`/);
    assert.match(md1, /checks: 1\/2, findings: 1/);
    assert.match(md1, /Integration test failed on empty token/);

    // Verify exact ledger counts (no duplicate final_audit_started / final_audit_result)
    const eventsAfterR1 = await store.getRecentEvents("run-audit", 50);
    assert.equal(
      eventsAfterR1.filter((e) => e.type === "final_audit_started").length,
      1,
    );
    assert.equal(
      eventsAfterR1.filter((e) => e.type === "final_audit_result").length,
      1,
    );

    // Verify updateRoster works for final-validator role (failed -> worker_exited with [final-audit] tag)
    await store.updateRoster("run-audit", "final-val-r1", {
      status: "failed",
      endedAt: new Date().toISOString(),
    });
    const eventsAfterExit = await store.getRecentEvents("run-audit", 50);
    const exitEvt = eventsAfterExit.find((e) => e.type === "worker_exited");
    assert.ok(exitEvt);
    assert.match(formatLedgerEvent(exitEvt), /\[final-audit\]/);

    // Adding a fix mission resets status -> active and finalAuditStatus -> idle while preserving finalAuditRound
    await store.updateMission("run-audit", "M1", { status: "active" });
    await store.updateMission("run-audit", "M1", { status: "completed" });
    await store.markMerged("run-audit", "M1", "aaa1111");

    const afterFixAdd = await store.addMissions("run-audit", [
      makeMission({
        id: "F1",
        title: "Guard Empty Bearer Token",
        scope: ["src/core"],
        deps: ["M1"],
      }),
    ]);
    assert.equal(afterFixAdd.status, "active");
    assert.equal(afterFixAdd.finalAuditStatus, "idle");
    assert.equal(afterFixAdd.finalAuditRound, 1);

    // Also test addMissions reset from approved state
    await store.recordFinalAudit("run-audit", {
      commitSha: "cafebabe9876543",
      baseBranch: "main",
      auditedAt: new Date().toISOString(),
      verifierAgentId: "final-val-r2",
      verdict: "approved",
      summary: "All checks green",
      checks: [{ name: "npm test", passed: true }],
      findings: [],
      round: 2,
    });
    const afterApprovedAdd = await store.addMissions("run-audit", [
      makeMission({
        id: "M2",
        title: "Followup Docs",
        kind: "artifact",
        scope: ["docs/followup.md"],
      }),
    ]);
    assert.equal(afterApprovedAdd.status, "active");
    assert.equal(afterApprovedAdd.finalAuditStatus, "idle");
    assert.equal(afterApprovedAdd.finalAuditRound, 2);

    // Verify crisp formatLedgerEvent formatting for all 4 final audit event types
    const baseTs = "2026-11-20T12:00:00.000Z";
    const sampleEvents: SwarmEvent[] = [
      {
        id: "e1",
        runId: "run-audit",
        type: "final_audit_started",
        timestamp: baseTs,
        actor: "orchestrator",
        missionId: FINAL_AUDIT_MISSION_ID,
        summary: "Started Final Validator on main",
        data: { round: 1, baseBranch: "main", commitSha: "deadbeef123" },
      },
      {
        id: "e2",
        runId: "run-audit",
        type: "final_audit_result",
        timestamp: baseTs,
        actor: "final-val-r1",
        summary: "Final audit round 1 approved @cafebab — All checks green",
        data: {
          round: 1,
          verdict: "approved",
          commitSha: "cafebabe987",
          checksPassed: 2,
          checksTotal: 2,
          findingsCount: 0,
        },
      },
      {
        id: "e3",
        runId: "run-audit",
        type: "final_audit_skipped",
        timestamp: baseTs,
        actor: "alice",
        summary: "Skipped by alice: emergency hotfix",
        data: { skippedBy: "alice", reason: "emergency hotfix" },
      },
      {
        id: "e4",
        runId: "run-audit",
        type: "final_audit_autofix_planned",
        timestamp: baseTs,
        actor: "final-validator",
        summary: "Scheduled auto-fix mission",
        data: { missionIds: ["F1", "F2"] },
      },
    ];

    assert.match(
      formatLedgerEvent(sampleEvents[0]),
      /final_audit_started \[r1 · @deadbee\] \(orchestrator\)/,
    );
    assert.match(
      formatLedgerEvent(sampleEvents[1]),
      /final_audit_result \[APPROVED · checks 2\/2 · 0 findings\] \(final-val-r1\)/,
    );
    assert.match(
      formatLedgerEvent(sampleEvents[2]),
      /final_audit_skipped \(alice\) Skipped by alice: emergency hotfix/,
    );
    assert.match(
      formatLedgerEvent(sampleEvents[3]),
      /final_audit_autofix_planned \[F1, F2\] \(final-validator\)/,
    );
  });

  it("enforces strictly human-only skipFinalAudit (ROLE_FORBIDDEN for non-human or omitted callerRole) and completes run when all missions are terminal", async () => {
    const root = await makeTempDir("pi-swarm-audit-skip-");
    const store = new SwarmStore(root);

    await store.createRun({
      id: "run-skip",
      objective: "Skip sovereignty test",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-skip",
      missions: [
        makeMission({ id: "M1", title: "Ship Core", scope: ["src/core"] }),
        makeMission({ id: "M2", title: "Optional Extra", scope: ["src/extra"] }),
      ],
    });

    // Omitted callerRole MUST be rejected with ROLE_FORBIDDEN
    await assert.rejects(
      () => store.skipFinalAudit("run-skip", { reason: "omitted role" }),
      (err) => assertProtocolCode(err, "ROLE_FORBIDDEN"),
    );

    // Non-human caller roles MUST be rejected with ROLE_FORBIDDEN
    for (const forbiddenRole of ["orchestrator", "worker", "validator"] as const) {
      await assert.rejects(
        () =>
          store.skipFinalAudit("run-skip", {
            callerRole: forbiddenRole,
            reason: "trying to bypass",
          }),
        (err) => assertProtocolCode(err, "ROLE_FORBIDDEN"),
      );
    }

    // While missions are still open, human skip sets finalAuditStatus=skipped WITHOUT marking run completed
    const skippedOpen = await store.skipFinalAudit("run-skip", {
      callerRole: "human",
      skippedBy: "operator",
      reason: "pre-approved manual check",
    });
    assert.equal(skippedOpen.finalAuditStatus, "skipped");
    assert.equal(skippedOpen.finalAuditSkippedBy, "operator");
    assert.ok(skippedOpen.finalAuditSkippedAt);
    assert.equal(skippedOpen.finalAuditSkipReason, "pre-approved manual check");
    assert.equal(skippedOpen.status, "active");

    // Complete/merge M1 and abandon M2 -> all missions terminal, simulate verifying state
    await store.updateMission("run-skip", "M1", { status: "active" });
    await store.updateMission("run-skip", "M1", { status: "completed" });
    await store.markMerged("run-skip", "M1", "1234567890abcdef");
    await store.updateMission("run-skip", "M2", {
      status: "abandoned",
      callerRole: "orchestrator",
    });
    await store.updateRun("run-skip", {
      status: "verifying",
      finalAuditStatus: "disapproved",
    });

    // Human skip when all missions are terminal transitions run -> completed and emits both events
    const completed = await store.skipFinalAudit("run-skip", {
      callerRole: "human",
      skippedBy: "human",
      reason: "verified manually in staging",
    });
    assert.equal(completed.finalAuditStatus, "skipped");
    assert.equal(completed.status, "completed");
    assert.equal(completed.finalAuditSkipReason, "verified manually in staging");

    const events = await store.getRecentEvents("run-skip", 50);
    assert.equal(
      events.filter((e) => e.type === "final_audit_skipped").length,
      2,
    );
    assert.equal(events.filter((e) => e.type === "run_completed").length, 1);

    // MISSIONS.md renders skip details cleanly
    const md = await readFile(
      path.join(
        root,
        SWARM_DIR,
        SWARM_RUNS_DIR,
        "run-skip",
        SWARM_MISSIONS_FILE,
      ),
      "utf8",
    );
    assert.match(md, /## Final Verification/);
    assert.match(md, /\*\*Status:\*\* `skipped`/);
    assert.match(md, /\*\*Skipped:\*\* by human .* verified manually in staging/);
  });
});

// ============================================================================
// 6. Real Git Worktrees, Scope Checking, Auto-Rebase, Merge & Safe Teardown
// ============================================================================

describe("WorktreeManager real git repository workflows", () => {
  it("initializes an empty repo cleanly and excludes .pi/swarm/ from git status", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-init-");
    const wtMgr = new WorktreeManager(repoDir);

    const ready = await wtMgr.ensureRepoReady("main");
    assert.equal(ready.initializedRepo, true);
    assert.equal(ready.createdInitialCommit, true);
    assert.equal(ready.baseBranch, "main");
    assert.ok(ready.headSha.length >= 40);

    // Verify .git/info/exclude contains .pi/swarm/
    const excludeContent = await readFile(
      path.join(repoDir, ".git", "info", "exclude"),
      "utf8",
    );
    assert.match(excludeContent, /\.pi\/swarm\//);

    // Writing files inside .pi/swarm/ must NOT make base repo dirty
    const store = new SwarmStore(repoDir);
    await store.createRun({
      id: "run-clean",
      objective: "Clean git status check",
      verificationContract: "none",
      baseBranch: "main",
      ownerSessionId: "sess-1",
      missions: [
        makeMission({ id: "M1", title: "First Mission", scope: ["src/a"] }),
      ],
    });
    await store.postBoardMessage("run-clean", {
      from: "orchestrator",
      fromRole: "orchestrator",
      text: "@M1 ready",
      kind: "brief",
    });

    const baseCheck = await wtMgr.isBaseCleanOnBranch("main");
    assert.equal(baseCheck.ok, true);
    assert.equal(baseCheck.dirty, false);
    assert.equal(baseCheck.currentBranch, "main");
  });

  it("creates worktree, enforces scope violations (committed & untracked), auto-rebases cleanly, and merges serialized", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-flow-");
    const wtMgr = new WorktreeManager(repoDir);
    const store = new SwarmStore(repoDir);
    await wtMgr.ensureRepoReady("main");

    // Create initial baseline files on main
    await commitFile(repoDir, "src/base.txt", "base\n", "add base file");

    const run = await store.createRun({
      id: "run-git",
      objective: "Parallel worktree flow",
      verificationContract: "tests pass",
      baseBranch: "main",
      ownerSessionId: "sess-git",
      missions: [
        makeMission({ id: "M1", title: "Feature Alpha", scope: ["src/alpha"] }),
        makeMission({ id: "M2", title: "Feature Beta", scope: ["src/beta"] }),
      ],
    });

    const wt1 = await wtMgr.createWorktree({
      branch: run.missions.M1.branch,
      baseBranch: "main",
      worktreePath: run.missions.M1.worktreePath,
    });
    const wt2 = await wtMgr.createWorktree({
      branch: run.missions.M2.branch,
      baseBranch: "main",
      worktreePath: run.missions.M2.worktreePath,
    });

    // Duplicate branch rejected when reuseExistingBranch is false
    await assert.rejects(
      () =>
        wtMgr.createWorktree({
          branch: run.missions.M1.branch,
          baseBranch: "main",
          worktreePath: path.join(repoDir, ".pi/swarm/worktrees/dup"),
        }),
      (err) => assertProtocolCode(err, "DUPLICATE_BRANCH"),
    );

    // M1 commits cleanly inside scope
    await commitFile(
      wt1.worktreePath,
      "src/alpha/mod.ts",
      "export const a = 1;\n",
      "add alpha",
    );
    const m1Changed = await wtMgr.getChangedFiles(
      "main",
      "HEAD",
      wt1.worktreePath,
    );
    assert.deepEqual(m1Changed, ["src/alpha/mod.ts"]);
    assert.deepEqual(findScopeViolations(m1Changed, run.missions.M1.scope), []);

    // Diff summary works and reports commitsAhead === 1
    const diffSummary = await wtMgr.getDiffSummary("main", run.missions.M1.branch);
    assert.equal(diffSummary.commitsAhead, 1);
    assert.deepEqual(diffSummary.changedFiles, ["src/alpha/mod.ts"]);
    assert.match(diffSummary.diff, /export const a = 1;/);

    // Untracked file outside scope in M2 is detected by getChangedFiles + findScopeViolations!
    await commitFile(
      wt2.worktreePath,
      "src/beta/mod.ts",
      "export const b = 2;\n",
      "add beta",
    );
    const roguePath = path.join(wt2.worktreePath, "src/outside/rogue.ts");
    await mkdir(path.dirname(roguePath), { recursive: true });
    await writeFile(roguePath, "oops\n", "utf8");

    const m2ChangedDirty = await wtMgr.getChangedFiles(
      "main",
      "HEAD",
      wt2.worktreePath,
    );
    assert.deepEqual(
      findScopeViolations(m2ChangedDirty, run.missions.M2.scope),
      ["src/outside/rogue.ts"],
    );

    // Dirty worktree skips autoRebase safely
    const skippedRebase = await wtMgr.autoRebase(wt2.worktreePath, "main");
    assert.equal(skippedRebase.status, "skipped_dirty");

    // Clean up rogue untracked file in M2
    await rm(roguePath);

    // Merge M1 into main -> base advances!
    const merge1 = await wtMgr.mergeBranch({
      baseBranch: "main",
      branch: run.missions.M1.branch,
      commitMessage: "merge M1 alpha",
    });
    assert.equal(merge1.strategy, "merge");
    assert.deepEqual(merge1.changedFiles, ["src/alpha/mod.ts"]);
    assert.equal(await exists(path.join(repoDir, "src/alpha/mod.ts")), true);

    // Now main has advanced; auto-rebase clean M2 onto updated main!
    const rebased2 = await wtMgr.autoRebase(wt2.worktreePath, "main");
    assert.equal(rebased2.status, "rebased");
    assert.ok(rebased2.newHeadSha);
    assert.equal(
      await exists(path.join(wt2.worktreePath, "src/alpha/mod.ts")),
      true,
    );

    // Running autoRebase again reports up-to-date
    const upToDate = await wtMgr.autoRebase(wt2.worktreePath, "main");
    assert.equal(upToDate.status, "up-to-date");

    // Merge M2 into main
    const merge2 = await wtMgr.mergeBranch({
      baseBranch: "main",
      branch: run.missions.M2.branch,
      commitMessage: "merge M2 beta",
    });
    assert.equal(merge2.strategy, "merge");
    assert.equal(await exists(path.join(repoDir, "src/beta/mod.ts")), true);
  });

  it("aborts cleanly on autoRebase conflict and enforces DIRTY_BASE / WRONG_BRANCH on mergeBranch", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-conflict-");
    const wtMgr = new WorktreeManager(repoDir);
    await wtMgr.ensureRepoReady("main");
    await commitFile(
      repoDir,
      "shared.txt",
      "line1\noriginal\nline3\n",
      "seed shared.txt",
    );

    const wtPath = path.join(repoDir, ".pi/swarm/worktrees/run-c/wt-M1");
    await wtMgr.createWorktree({
      branch: "feat/conflict-mission",
      baseBranch: "main",
      worktreePath: wtPath,
    });

    // Conflicting edit in mission worktree AND on main
    await commitFile(
      wtPath,
      "shared.txt",
      "line1\nmission-change\nline3\n",
      "mission edit",
    );
    await commitFile(
      repoDir,
      "shared.txt",
      "line1\nmain-change\nline3\n",
      "main edit",
    );

    const rebaseRes = await wtMgr.autoRebase(wtPath, "main");
    assert.equal(rebaseRes.status, "conflict");
    assert.deepEqual(rebaseRes.conflictFiles, ["shared.txt"]);
    // Worktree MUST be cleanly aborted (not dirty / not stuck mid-rebase!)
    assert.equal(await wtMgr.isWorktreeDirty(wtPath), false);
    assert.equal(await wtMgr.getCurrentBranch(wtPath), "feat/conflict-mission");

    // DIRTY_BASE guard on mergeBranch
    await writeFile(path.join(repoDir, "uncommitted.txt"), "dirty\n", "utf8");
    await assert.rejects(
      () =>
        wtMgr.mergeBranch({
          baseBranch: "main",
          branch: "feat/conflict-mission",
        }),
      (err) => assertProtocolCode(err, "DIRTY_BASE"),
    );
    await rm(path.join(repoDir, "uncommitted.txt"));

    // WRONG_BRANCH guard on mergeBranch
    await git(repoDir, ["checkout", "-b", "other-branch"]);
    await assert.rejects(
      () =>
        wtMgr.mergeBranch({
          baseBranch: "main",
          branch: "feat/conflict-mission",
        }),
      (err) => assertProtocolCode(err, "WRONG_BRANCH"),
    );
    await git(repoDir, ["checkout", "main"]);

    // Direct merge conflict aborts cleanly and throws REBASE_CONFLICT
    await assert.rejects(
      () =>
        wtMgr.mergeBranch({
          baseBranch: "main",
          branch: "feat/conflict-mission",
        }),
      (err) => assertProtocolCode(err, "REBASE_CONFLICT"),
    );
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), false);
  });

  it("safeTeardown protects dirty & active worktrees, preserves branches & audit trail by default, and deletes branches only when requested", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-teardown-");
    const wtMgr = new WorktreeManager(repoDir);
    const store = new SwarmStore(repoDir);
    await wtMgr.ensureRepoReady("main");

    const run = await store.createRun({
      id: "run-td",
      objective: "Safe teardown verification",
      verificationContract: "none",
      baseBranch: "main",
      ownerSessionId: "sess-td",
      missions: [
        makeMission({ id: "M1", title: "Clean Mission", scope: ["src/clean"] }),
        makeMission({ id: "M2", title: "Dirty Mission", scope: ["src/dirty"] }),
        makeMission({
          id: "M3",
          title: "Active Mission",
          scope: ["src/active"],
        }),
        makeMission({
          id: "M4",
          title: "Delete Branch Mission",
          scope: ["src/del"],
        }),
      ],
    });

    for (const id of ["M1", "M2", "M3", "M4"] as const) {
      await wtMgr.createWorktree({
        branch: run.missions[id].branch,
        baseBranch: "main",
        worktreePath: run.missions[id].worktreePath,
      });
    }

    // Make M2 dirty with uncommitted work that MUST NOT be deleted
    const dirtyFile = path.join(run.missions.M2.worktreePath, "wip.txt");
    await writeFile(dirtyFile, "precious uncommitted work\n", "utf8");

    // Default safeTeardown preserves branches and audit trail
    const td1 = await wtMgr.safeTeardown([
      {
        missionId: "M1",
        worktreePath: run.missions.M1.worktreePath,
        branch: run.missions.M1.branch,
        hasActiveAgent: false,
      },
      {
        missionId: "M2",
        worktreePath: run.missions.M2.worktreePath,
        branch: run.missions.M2.branch,
        hasActiveAgent: false,
      },
      {
        missionId: "M3",
        worktreePath: run.missions.M3.worktreePath,
        branch: run.missions.M3.branch,
        hasActiveAgent: true,
      },
      {
        missionId: "M9",
        worktreePath: path.join(repoDir, ".pi/swarm/worktrees/run-td/wt-M9"),
        branch: "feat/nonexistent",
        hasActiveAgent: false,
      },
    ]);

    assert.equal(td1.errors.length, 0);
    assert.deepEqual(
      td1.removed.map((r) => r.missionId),
      ["M1"],
    );
    assert.deepEqual(
      td1.skipped.map((s) => ({ id: s.missionId, action: s.action })),
      [
        { id: "M2", action: "skipped_dirty" },
        { id: "M3", action: "skipped_active" },
        { id: "M9", action: "missing" },
      ],
    );

    // M1 worktree removed, M1 branch preserved!
    assert.equal(await exists(run.missions.M1.worktreePath), false);
    const branchesAfter1 = await wtMgr.listLocalBranches();
    assert.ok(branchesAfter1.includes(run.missions.M1.branch));

    // M2 uncommitted work and M3 active worktree remain intact!
    assert.equal(
      await readFile(dirtyFile, "utf8"),
      "precious uncommitted work\n",
    );
    assert.equal(await exists(run.missions.M3.worktreePath), true);

    // .pi/swarm/runs/ audit trail is completely intact!
    const reloaded = await store.loadRun("run-td");
    assert.equal(reloaded.id, "run-td");

    // Explicit deleteBranches: true removes M4 worktree BEFORE deleting M4 branch
    const td2 = await wtMgr.safeTeardown(
      [
        {
          missionId: "M4",
          worktreePath: run.missions.M4.worktreePath,
          branch: run.missions.M4.branch,
          hasActiveAgent: false,
        },
      ],
      { deleteBranches: true },
    );
    assert.equal(td2.removed.length, 1);
    assert.equal(await exists(run.missions.M4.worktreePath), false);
    const branchesAfter2 = await wtMgr.listLocalBranches();
    assert.equal(branchesAfter2.includes(run.missions.M4.branch), false);
  });

  it("reuses an existing checked-out worktree on retry / review fix rounds and re-attaches removed worktrees", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-reuse-");
    const wtMgr = new WorktreeManager(repoDir);
    await wtMgr.ensureRepoReady("main");

    const wtPath = path.join(repoDir, ".pi/swarm/worktrees/run-r/wt-M1");
    const first = await wtMgr.createWorktree({
      branch: "feat/retry-mission",
      baseBranch: "main",
      worktreePath: wtPath,
    });

    // Simulate worker commit in round 1 + uncommitted WIP before retry/fix round
    const round1Sha = await commitFile(
      first.worktreePath,
      "src/retry.ts",
      "export const round = 1;\n",
      "round 1 commit",
    );
    await writeFile(
      path.join(first.worktreePath, "wip.tmp"),
      "in-progress\n",
      "utf8",
    );

    // Re-calling createWorktree with reuseExistingBranch: true on the SAME existing worktree succeeds!
    const reused = await wtMgr.createWorktree({
      branch: "feat/retry-mission",
      baseBranch: "main",
      worktreePath: wtPath,
      reuseExistingBranch: true,
    });
    assert.equal(reused.branch, "feat/retry-mission");
    assert.equal(reused.worktreePath, first.worktreePath);
    assert.equal(await wtMgr.getHeadSha(reused.worktreePath), round1Sha);
    assert.equal(
      await readFile(path.join(reused.worktreePath, "wip.tmp"), "utf8"),
      "in-progress\n",
    );

    // Asking reuseExistingBranch: true with a DIFFERENT branch at the same worktree path throws WRONG_BRANCH
    await git(repoDir, ["branch", "feat/other-branch", "main"]);
    await assert.rejects(
      () =>
        wtMgr.createWorktree({
          branch: "feat/other-branch",
          baseBranch: "main",
          worktreePath: wtPath,
          reuseExistingBranch: true,
        }),
      (err) => assertProtocolCode(err, "WRONG_BRANCH"),
    );

    // Removing the worktree (keeping the branch) and calling createWorktree(reuseExistingBranch: true) re-attaches cleanly
    await rm(path.join(reused.worktreePath, "wip.tmp"));
    await wtMgr.removeWorktree(wtPath, { force: true });
    assert.equal(await exists(wtPath), false);

    const reattached = await wtMgr.createWorktree({
      branch: "feat/retry-mission",
      baseBranch: "main",
      worktreePath: wtPath,
      reuseExistingBranch: true,
    });
    assert.equal(reattached.branch, "feat/retry-mission");
    assert.equal(await wtMgr.getHeadSha(reattached.worktreePath), round1Sha);
  });
});

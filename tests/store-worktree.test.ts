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
  DEFAULT_CHANNEL,
  DEFAULT_SWARM_SETTINGS,
  RESERVED_MEMBER_NAMES,
  SWARM_BOARD_FILE,
  SWARM_DEFAULT_STALL_TIMEOUT_MS,
  SWARM_DIR,
  SWARM_EVENTS_FILE,
  SWARM_LOCKS_DIR,
  SWARM_LOG_TAIL_LIMIT,
  SWARM_ROSTER_FILE,
  SWARM_RUNS_DIR,
  SWARM_SETTINGS_FILE,
  SWARM_STATE_FILE,
  SWARM_STATE_VERSION,
} from "../src/constants.js";
import {
  SWARM_SETTINGS_BOUNDS,
  SwarmBoard,
  SwarmLedger,
  SwarmStore,
  WorktreeManager,
  assertOwnerSession,
  deriveMemberBranch,
  formatBoardMessage,
  formatBoardMessages,
  formatLedgerActivity,
  formatLedgerEvent,
  getGlobalSettingsPath,
  getProjectSettingsPath,
  loadLayeredSwarmSettings,
  loadSwarmSettings,
  parseChannelMentions,
  parseMentions,
  sanitizeSwarmSettings,
  saveSwarmSettings,
  validateChannelName,
  validateMemberName,
} from "../src/store/index.js";
import {
  isSwarmProtocolError,
  type BoardMessage,
  type SwarmErrorCode,
  type SwarmEvent,
  type SwarmEventType,
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

function assertProtocolCode(err: unknown, expectedCode: SwarmErrorCode): boolean {
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
// 1. Shared Message Board (SwarmBoard, mentions, channels, search, formatting)
// ============================================================================

describe("SwarmBoard shared message board (board.jsonl)", () => {
  it("parses @mentions accurately while excluding emails and NOT confusing @#channel with @name", () => {
    assert.deepEqual(parseMentions("@M1 please review"), ["M1"]);
    assert.deepEqual(
      parseMentions(
        "Hey @parser, check (@worker-1), [@verifier], `@orchestrator`, and @all! Ping:@M1,cc:@helper-2",
      ),
      ["parser", "worker-1", "verifier", "orchestrator", "all", "M1", "helper-2"],
    );
    // Email addresses and double-@ must NOT be extracted as mentions
    assert.deepEqual(
      parseMentions(
        "Contact foo@bar.com, user.name+tag@sub.example.org, a-b@c.io, a_b@d.net, mailto:ops@site.dev, @@double.",
      ),
      [],
    );
    // Channel mentions (@#channel) must NOT be parsed as member @mentions!
    assert.deepEqual(
      parseMentions(
        "Notify @#backend and @#frontend, ask @parser, email dev@example.com, ping @Parser.",
      ),
      ["parser"],
    );
    // Trailing dots & case-insensitive dedup preserving first-seen casing
    assert.deepEqual(
      parseMentions("Ask @M1. Also ping @m1 and @M1.2: thanks!"),
      ["M1", "M1.2"],
    );
    assert.deepEqual(parseMentions(""), []);
  });

  it("parses @#channel mentions cleanly (lowercased, deduplicated, keeping main for engine/store validation)", () => {
    assert.deepEqual(
      parseChannelMentions(
        "Cross-post to @#backend, (@#Frontend), [@#api-v2], `@#Backend`, and @#x.",
      ),
      ["backend", "frontend", "api-v2", "x"],
    );
    // Preserves "main" without @# so store/engine can explicitly reject @#main
    assert.deepEqual(parseChannelMentions("Do not wake @#main or @#MAIN"), [
      "main",
    ]);
    // Ignores member mentions, email-like prefixes, double-at, and numeric starts
    assert.deepEqual(
      parseChannelMentions(
        "@parser @all foo@#bar @@#baz @#123 email@domain.com",
      ),
      [],
    );
    assert.deepEqual(parseChannelMentions(""), []);
  });

  it("formats single and multi-line board messages cleanly with channel, mentions, and kind", () => {
    assert.equal(formatBoardMessages([]), "(no board messages yet)");

    const msg1: BoardMessage = {
      seq: 4,
      runId: "run-b",
      channel: "backend",
      from: "verifier",
      fromRole: "validator",
      text: "Fix missing null check on line 42",
      mentions: ["parser"],
      channelMentions: [],
      kind: "review",
      timestamp: "2026-11-20T12:00:00.000Z",
    };
    assert.equal(
      formatBoardMessage(msg1),
      "#4 [backend] verifier -> @parser: [review] Fix missing null check on line 42",
    );

    const msg2: BoardMessage = {
      seq: 5,
      runId: "run-b",
      channel: "main",
      from: "parser",
      fromRole: "worker",
      text: "[done] Fixed null check and re-ran tests",
      mentions: ["orchestrator"],
      channelMentions: ["frontend"],
      kind: "done",
      timestamp: "2026-11-20T12:01:00.000Z",
    };
    // Does not duplicate [done] when text already starts with [done]
    assert.equal(
      formatBoardMessage(msg2),
      "#5 [main] parser -> @orchestrator, @#frontend: [done] Fixed null check and re-ran tests",
    );

    const msg3: BoardMessage = {
      seq: 6,
      runId: "run-b",
      channel: "main",
      from: "worker-1",
      fromRole: "worker",
      text: "reader.ts landed",
      mentions: [],
      channelMentions: [],
      kind: "chat",
      timestamp: "2026-11-20T12:02:00.000Z",
    };
    assert.equal(formatBoardMessage(msg3), "#6 [main] worker-1: reader.ts landed");

    const formatted = formatBoardMessages([msg1, msg2, msg3]);
    assert.equal(formatted.split("\n").length, 3);
  });

  it("persists monotonic LF-only board.jsonl and supports channel, memberChannels, search, seqs, since & limit filtering", async () => {
    const root = await makeTempDir("pi-swarm-board-");
    const board = new SwarmBoard(root);

    assert.equal(await board.getHead("run-board"), 0);
    assert.deepEqual(await board.read("run-board"), { messages: [], head: 0 });

    // Concurrent posts across multiple channels serialize cleanly with monotonic seq 1..6
    const posted = await Promise.all([
      board.post("run-board", {
        from: "orchestrator",
        fromRole: "orchestrator",
        text: "@parser start auth core (email ignored: dev@example.com)",
        kind: "brief",
      }),
      board.post("run-board", {
        from: "parser",
        fromRole: "worker",
        channel: "backend",
        text: "@verifier [done] JWT validator ready in backend",
        kind: "done",
      }),
      board.post("run-board", {
        from: "ui-dev",
        fromRole: "worker",
        channel: "frontend",
        text: "@#backend need /me endpoint schema",
        kind: "update",
      }),
      board.post("run-board", {
        from: "verifier",
        fromRole: "validator",
        channel: "backend",
        text: "@parser handle empty bearer token",
        kind: "review",
      }),
      board.post("run-board", {
        from: "parser",
        fromRole: "worker",
        text: "@orchestrator [done] all backend tests pass",
        kind: "done",
      }),
      board.post("run-board", {
        from: "monitor",
        fromRole: "monitor",
        channel: "ops",
        text: "@orchestrator swarm quiet check",
        kind: "stall",
        mentions: ["@all"],
        channelMentions: ["@#Backend"],
      }),
    ]);

    assert.deepEqual(
      posted.map((m) => m.seq),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(posted[0].channel, DEFAULT_CHANNEL);
    assert.deepEqual(posted[0].mentions, ["parser"]);
    assert.deepEqual(posted[0].channelMentions, []);
    assert.equal(posted[2].channel, "frontend");
    assert.deepEqual(posted[2].mentions, []);
    assert.deepEqual(posted[2].channelMentions, ["backend"]);
    assert.deepEqual(posted[5].mentions, ["orchestrator", "all"]);
    assert.deepEqual(posted[5].channelMentions, ["backend"]);
    assert.equal(await board.getHead("run-board"), 6);

    // LF-only JSONL on disk
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

    // channel: "*" returns all channels
    const allCh = await board.read("run-board", { channel: "*" });
    assert.equal(allCh.head, 6);
    assert.deepEqual(
      allCh.messages.map((m) => m.seq),
      [1, 2, 3, 4, 5, 6],
    );

    // channel: "backend" returns only backend messages, preserving global head
    const backendOnly = await board.read("run-board", { channel: "backend" });
    assert.equal(backendOnly.head, 6);
    assert.deepEqual(
      backendOnly.messages.map((m) => m.seq),
      [2, 4],
    );

    // memberChannels filters cleanly to "main" OR any channel in memberChannels
    const memberView = await board.read("run-board", {
      memberChannels: ["backend"],
    });
    assert.equal(memberView.head, 6);
    assert.deepEqual(
      memberView.messages.map((m) => m.seq),
      [1, 2, 4, 5],
    );

    // Case-insensitive substring search across text, from, channel, mentions
    const searchText = await board.read("run-board", { search: "JWT" });
    assert.deepEqual(
      searchText.messages.map((m) => m.seq),
      [2],
    );
    const searchFrom = await board.read("run-board", { search: "UI-DEV" });
    assert.deepEqual(
      searchFrom.messages.map((m) => m.seq),
      [3],
    );
    const searchChannel = await board.read("run-board", { search: "ops" });
    assert.deepEqual(
      searchChannel.messages.map((m) => m.seq),
      [6],
    );
    const searchMention = await board.read("run-board", {
      search: "@verifier",
    });
    assert.deepEqual(
      searchMention.messages.map((m) => m.seq),
      [2],
    );

    // since + limit returns oldest after cursor
    const since1 = await board.read("run-board", { since: 1, limit: 2 });
    assert.equal(since1.head, 6);
    assert.deepEqual(
      since1.messages.map((m) => m.seq),
      [2, 3],
    );

    // seqs returns exact matching seqs in ascending order, ignoring missing/duplicate
    const exact = await board.read("run-board", { seqs: [5, 2, 99, 2] });
    assert.equal(exact.head, 6);
    assert.deepEqual(
      exact.messages.map((m) => m.seq),
      [2, 5],
    );

    // limit without since returns most recent N oldest-first
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

    // Validation & security guards
    await assert.rejects(
      () =>
        board.post("run-board", {
          from: "   ",
          fromRole: "worker",
          text: "empty sender",
        }),
      (err) => assertProtocolCode(err, "INVALID_INPUT"),
    );
    await assert.rejects(
      () =>
        board.post("run-board", {
          from: "parser",
          fromRole: "worker",
          channel: "bad channel!",
          text: "bad channel",
        }),
      (err) => assertProtocolCode(err, "INVALID_CHANNEL"),
    );
    assert.throws(
      () => board.getBoardPath("../escape"),
      (err) => assertProtocolCode(err, "INVALID_INPUT"),
    );

    // Symlink protection
    const outside = path.join(root, "outside-board.jsonl");
    await writeFile(outside, "", "utf8");
    const symRunDir = path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "sym-board");
    await mkdir(symRunDir, { recursive: true });
    await symlink(outside, path.join(symRunDir, SWARM_BOARD_FILE));
    await assert.rejects(
      () => board.read("sym-board"),
      (err) => assertProtocolCode(err, "PERMISSION_DENIED"),
    );
    await assert.rejects(
      () =>
        board.post("sym-board", {
          from: "orchestrator",
          fromRole: "orchestrator",
          text: "nope",
        }),
      (err) => assertProtocolCode(err, "PERMISSION_DENIED"),
    );
  });
});

// ============================================================================
// 2. SwarmStore v2: Runs, Members, Channels, Board Delegation, ROSTER.md, Locks
// ============================================================================

describe("SwarmStore v2 dynamic roster, channels, board delegation, locks & ROSTER.md", () => {
  it("validates member and channel names strictly and derives deterministic member branches", () => {
    assert.equal(validateMemberName("parser"), "parser");
    assert.equal(validateMemberName("worker-1"), "worker-1");
    assert.equal(validateChannelName("backend"), "backend");
    assert.equal(validateChannelName("api-v2"), "api-v2");
    assert.equal(deriveMemberBranch("run_12345", "parser"), "swarm/run-12345/parser");

    for (const reserved of RESERVED_MEMBER_NAMES) {
      assert.throws(
        () => validateMemberName(reserved),
        (err) => assertProtocolCode(err, "INVALID_NAME"),
      );
    }
    for (const badName of ["", "Parser", "1worker", "bad_name", "a b", " leading", "a".repeat(33)]) {
      assert.throws(
        () => validateMemberName(badName),
        (err) => assertProtocolCode(err, "INVALID_NAME"),
      );
    }
    for (const badChan of ["", "Backend", "1chan", "bad_chan", "#backend", "a b", "a".repeat(33)]) {
      assert.throws(
        () => validateChannelName(badChan),
        (err) => assertProtocolCode(err, "INVALID_CHANNEL"),
      );
    }
  });

  it("creates v2 run, writes ROSTER.md, enforces optimistic revisions, recovers stale locks & serializes concurrent updates", async () => {
    const root = await makeTempDir("pi-swarm-store-");
    const store = new SwarmStore(root, { staleLockMs: 200 });

    const created = await store.createRun({
      id: "run-v2",
      title: "Dynamic Auth Refactor",
      objective: "Refactor authentication with parallel workers and validator review",
      strategy: "Phase 1: research -> Phase 2: implement -> Phase 3: verify",
      acceptanceCriteria: "npm test && npm run typecheck pass with 0 errors",
      baseBranch: "main",
      ownerSessionId: "sess-owner",
      ownerPid: process.pid,
      maxConcurrency: 4,
      validatorEnabled: true,
      keepWorkersWarm: true,
      roleModels: {
        orchestrator: { model: "anthropic/claude-opus-4", thinkingLevel: "high" },
        worker: { model: "openai/gpt-5", thinkingLevel: "medium" },
        validator: { model: "google/gemini-2.5-pro", thinkingLevel: "high" },
        fallbackModels: ["openai/gpt-4.1"],
      },
    });

    assert.equal(created.version, SWARM_STATE_VERSION);
    assert.equal(created.revision, 1);
    assert.equal(created.boardHead, 0);
    assert.equal(created.title, "Dynamic Auth Refactor");
    assert.ok(created.channels[DEFAULT_CHANNEL]);
    assert.equal(created.channels[DEFAULT_CHANNEL].archived, false);
    assert.equal(await store.getActiveRunId(), "run-v2");

    // Duplicate runId rejected
    await assert.rejects(
      () =>
        store.createRun({
          id: "run-v2",
          title: "Dup",
          objective: "Dup",
          baseBranch: "main",
          ownerSessionId: "sess-owner",
        }),
      (err) => assertProtocolCode(err, "INVALID_INPUT"),
    );

    // Check ROSTER.md written on createRun
    const rosterPath = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-v2",
      SWARM_ROSTER_FILE,
    );
    const roster1 = await readFile(rosterPath, "utf8");
    assert.match(roster1, /^# Dynamic Auth Refactor$/m);
    assert.match(roster1, /## Objective/);
    assert.match(roster1, /## Strategy/);
    assert.match(roster1, /## Acceptance Criteria/);
    assert.match(
      roster1,
      /\*\*Models:\*\* Orchestrator: `anthropic\/claude-opus-4` \(high\) \| Worker: `openai\/gpt-5` \(medium\) \| Validator: `google\/gemini-2\.5-pro` \(high\) \| Fallbacks: `openai\/gpt-4\.1`/,
    );
    assert.match(roster1, /\| Channel \| Status \| Topic \| Subscribers \| Created By \|/);
    assert.match(
      roster1,
      /\| Name \| Role \| State \| Model \| Workspace \| Parent \| Channels \| Turns \| Last Read\/Post \| Parked On \|/,
    );

    // Optimistic revision conflict
    await assert.rejects(
      () => store.updateRun("run-v2", { status: "paused", expectedRevision: 99 }),
      (err) => assertProtocolCode(err, "REVISION_CONFLICT"),
    );

    // Rename & pause emit run_titled and run_paused
    const paused = await store.updateRun("run-v2", {
      title: "Dynamic Auth Refactor v2",
      status: "paused",
      expectedRevision: 1,
    });
    assert.equal(paused.revision, 2);
    assert.equal(paused.title, "Dynamic Auth Refactor v2");
    assert.equal(paused.status, "paused");
    assert.equal(await store.getActiveRunId(), "run-v2");

    // Simulate stale lockfile from dead PID -> automatically recovered
    const lockPath = path.join(root, SWARM_DIR, SWARM_LOCKS_DIR, "run-v2.lock");
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

    const resumed = await store.updateRun("run-v2", {
      status: "active",
      expectedRevision: 2,
    });
    assert.equal(resumed.status, "active");
    assert.equal(resumed.revision, 3);
    assert.equal(await exists(lockPath), false);

    // Register a member and run 8 concurrent updates -> no lost updates
    await store.addMember("run-v2", {
      name: "parser",
      agentId: "agt-parser-1",
      role: "worker",
      parentName: "orchestrator",
      brief: "Implement token parser",
      workspace: "inherit",
      cwd: root,
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        store.updateMember("run-v2", "parser", {
          logLine: `step-${idx}`,
        }),
      ),
    );
    const afterConcurrent = await store.loadRun("run-v2");
    assert.equal(afterConcurrent.revision, 12); // 3 + 1(addMember) + 8(updates)
    assert.equal(afterConcurrent.members.parser.logTail.length, 8);

    const events = await store.getRecentEvents("run-v2", 50);
    assert.deepEqual(
      events.map((e) => e.type),
      ["run_created", "run_titled", "run_paused", "run_resumed", "member_added"],
    );
  });

  it("manages members, reserved names, channels (create/subscribe/unsubscribe/archive), board posts & auto-emitted events", async () => {
    const root = await makeTempDir("pi-swarm-channels-");
    const store = new SwarmStore(root);

    await store.createRun({
      id: "run-dyn",
      title: "Channel & Roster Test",
      objective: "Verify full member and channel lifecycle",
      baseBranch: "main",
      ownerSessionId: "sess-dyn",
    });

    // Reject reserved names and invalid names on addMember
    for (const bad of ["orchestrator", "coordinator", "all", "monitor", "BadName"]) {
      await assert.rejects(
        () =>
          store.addMember("run-dyn", {
            name: bad,
            agentId: "agt-bad",
            role: "worker",
            parentName: "orchestrator",
            brief: "nope",
            workspace: "inherit",
            cwd: root,
          }),
        (err) => assertProtocolCode(err, "INVALID_NAME"),
      );
    }

    // Create a channel before spawning members
    const backendCh = await store.createChannel("run-dyn", {
      name: "backend",
      topic: "API & storage coordination",
      createdBy: "orchestrator",
    });
    assert.equal(backendCh.name, "backend");
    assert.equal(backendCh.archived, false);
    assert.deepEqual(backendCh.subscribers, []);

    // Duplicate channel rejected
    await assert.rejects(
      () =>
        store.createChannel("run-dyn", {
          name: "backend",
          createdBy: "orchestrator",
        }),
      (err) => assertProtocolCode(err, "INVALID_CHANNEL"),
    );

    // Adding member with nonexistent channel rejected
    await assert.rejects(
      () =>
        store.addMember("run-dyn", {
          name: "parser",
          agentId: "agt-1",
          role: "worker",
          parentName: "orchestrator",
          brief: "Parse input",
          workspace: "share",
          cwd: store.getWorktreePath("run-dyn", "parser"),
          branch: "swarm/run-dyn/parser",
          channels: ["missing-ch"],
        }),
      (err) => assertProtocolCode(err, "INVALID_CHANNEL"),
    );

    // Add worker subscribed to backend (channels[0] is "backend", "main" implicitly included)
    const afterAdd1 = await store.addMember("run-dyn", {
      name: "parser",
      agentId: "agt-parser",
      role: "worker",
      parentName: "orchestrator",
      groupPrefix: "worker",
      brief: "Implement parser module",
      workspace: "share",
      cwd: store.getWorktreePath("run-dyn", "parser"),
      branch: "swarm/run-dyn/parser",
      channels: ["backend"],
      model: "openai/gpt-5",
      thinkingLevel: "medium",
    });
    assert.deepEqual(afterAdd1.members.parser.channels, ["backend", "main"]);
    assert.deepEqual(afterAdd1.channels.backend.subscribers, ["parser"]);
    assert.deepEqual(afterAdd1.channels.main.subscribers, ["parser"]);

    // Duplicate member name rejected
    await assert.rejects(
      () =>
        store.addMember("run-dyn", {
          name: "parser",
          agentId: "agt-parser-2",
          role: "worker",
          parentName: "orchestrator",
          brief: "Duplicate",
          workspace: "inherit",
          cwd: root,
        }),
      (err) => assertProtocolCode(err, "DUPLICATE_MEMBER"),
    );

    // Add validator member
    await store.addMember("run-dyn", {
      name: "verifier",
      agentId: "agt-verifier",
      role: "validator",
      parentName: "orchestrator",
      brief: "Review parser diff",
      workspace: "inherit",
      cwd: root,
      model: "google/gemini-2.5-pro",
      thinkingLevel: "high",
    });

    // Subscribe & unsubscribe verifier to #backend
    const subCh = await store.subscribeChannel("run-dyn", "backend", "verifier");
    assert.deepEqual(subCh.subscribers, ["parser", "verifier"]);
    let loaded = await store.loadRun("run-dyn");
    assert.deepEqual(loaded.members.verifier.channels, ["main", "backend"]);

    const unsubCh = await store.unsubscribeChannel(
      "run-dyn",
      "backend",
      "verifier",
    );
    assert.deepEqual(unsubCh.subscribers, ["parser"]);
    loaded = await store.loadRun("run-dyn");
    assert.deepEqual(loaded.members.verifier.channels, ["main"]);

    // Cannot unsubscribe from or archive "main"
    await assert.rejects(
      () => store.unsubscribeChannel("run-dyn", "main", "verifier"),
      (err) => assertProtocolCode(err, "INVALID_CHANNEL"),
    );
    await assert.rejects(
      () => store.archiveChannel("run-dyn", "main"),
      (err) => assertProtocolCode(err, "INVALID_CHANNEL"),
    );

    // Post board message to #backend -> updates state.boardHead & parser.lastPostSeq/lastPostTime
    const msg1 = await store.postBoardMessage("run-dyn", {
      from: "parser",
      fromRole: "worker",
      channel: "backend",
      text: "@verifier [done] parser ready for review",
      kind: "done",
    });
    assert.equal(msg1.seq, 1);
    assert.equal(msg1.channel, "backend");
    loaded = await store.loadRun("run-dyn");
    assert.equal(loaded.boardHead, 1);
    assert.equal(loaded.members.parser.lastPostSeq, 1);
    assert.equal(loaded.members.parser.lastPostTime, msg1.timestamp);

    // Posting to nonexistent channel fails with INVALID_CHANNEL
    await assert.rejects(
      () =>
        store.postBoardMessage("run-dyn", {
          from: "parser",
          fromRole: "worker",
          channel: "ghost",
          text: "hello",
        }),
      (err) => assertProtocolCode(err, "INVALID_CHANNEL"),
    );

    // Archive #backend -> removes it from parser.channels, rejects future subscribe/post/addMember
    const archived = await store.archiveChannel("run-dyn", "backend", "orchestrator");
    assert.equal(archived.archived, true);
    assert.ok(archived.archivedAt);
    loaded = await store.loadRun("run-dyn");
    assert.deepEqual(loaded.members.parser.channels, ["main"]);

    await assert.rejects(
      () => store.subscribeChannel("run-dyn", "backend", "verifier"),
      (err) => assertProtocolCode(err, "CHANNEL_ARCHIVED"),
    );
    await assert.rejects(
      () =>
        store.postBoardMessage("run-dyn", {
          from: "parser",
          fromRole: "worker",
          channel: "backend",
          text: "too late",
        }),
      (err) => assertProtocolCode(err, "CHANNEL_ARCHIVED"),
    );
    await assert.rejects(
      () =>
        store.addMember("run-dyn", {
          name: "late-worker",
          agentId: "agt-late",
          role: "worker",
          parentName: "orchestrator",
          brief: "join archived",
          workspace: "inherit",
          cwd: root,
          channels: ["backend"],
        }),
      (err) => assertProtocolCode(err, "CHANNEL_ARCHIVED"),
    );

    // Test updateMember fields, null clears, logTail cap, and exact auto-emitted events
    await store.updateMember("run-dyn", "parser", {
      state: "waiting",
      briefSeq: 1,
      lastReadSeq: 1,
      parkedOn: "waiting for @verifier",
      turns: 2,
      tokens: 1500,
      tokenBreakdown: {
        input: 1000,
        output: 400,
        cacheRead: 100,
        cacheWrite: 0,
        total: 1500,
      },
      cost: 0.042,
      currentActivity: "idle",
      lastTool: "post_message",
      logTail: Array.from({ length: SWARM_LOG_TAIL_LIMIT + 10 }, (_, i) => `l${i}`),
      error: "transient warning",
    });

    // Clear nullable fields & transition waiting -> working (NO auto-event) -> stopped -> merged -> killed
    await store.updateMember("run-dyn", "parser", {
      state: "working",
      thinkingLevel: null,
      parkedOn: null,
      currentActivity: null,
      lastTool: null,
      error: null,
    });
    let parserRec = (await store.loadRun("run-dyn")).members.parser;
    assert.equal(parserRec.thinkingLevel, undefined);
    assert.equal(parserRec.parkedOn, undefined);
    assert.equal(parserRec.currentActivity, undefined);
    assert.equal(parserRec.lastTool, undefined);
    assert.equal(parserRec.error, undefined);
    assert.equal(parserRec.logTail.length, SWARM_LOG_TAIL_LIMIT);

    await store.updateMember("run-dyn", "parser", {
      state: "stopped",
      humanStopped: true,
    });
    await store.updateMember("run-dyn", "parser", {
      mergedCommitSha: "abcdef1234567890",
    });
    // Re-setting the exact same mergedCommitSha must NOT emit a duplicate member_merged
    await store.updateMember("run-dyn", "parser", {
      mergedCommitSha: "abcdef1234567890",
    });
    await store.updateMember("run-dyn", "parser", {
      state: "killed",
      endedAt: new Date().toISOString(),
    });

    // Killed member cannot transition back to waiting/working
    await assert.rejects(
      () => store.updateMember("run-dyn", "parser", { state: "working" }),
      (err) => assertProtocolCode(err, "MEMBER_KILLED"),
    );
    // Unknown member fails with MEMBER_NOT_FOUND
    await assert.rejects(
      () => store.updateMember("run-dyn", "nobody", { state: "waiting" }),
      (err) => assertProtocolCode(err, "MEMBER_NOT_FOUND"),
    );

    // Complete run & verify ROSTER.md + listRuns + exact ledger event sequence
    await store.updateRun("run-dyn", {
      status: "completed",
      completionSummary: "All parser tasks merged and verified.",
    });

    assert.equal(await store.getActiveRunId(), null);
    const runs = await store.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].title, "Channel & Roster Test");
    assert.equal(runs[0].memberCount, 2);
    assert.equal(runs[0].workingCount, 1); // verifier still working
    assert.equal(runs[0].boardHead, 1);

    const rosterMd = await readFile(
      path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "run-dyn", SWARM_ROSTER_FILE),
      "utf8",
    );
    assert.match(rosterMd, /\| `#backend` \| archived \|/);
    assert.match(rosterMd, /\| parser \| worker \| killed \|/);
    assert.match(rosterMd, /## Completion Summary/);
    assert.match(rosterMd, /All parser tasks merged and verified\./);

    const events = await store.getRecentEvents("run-dyn", 50);
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "run_created",
        "channel_created",
        "member_added",
        "member_added",
        "channel_updated",
        "channel_updated",
        "board_posted",
        "channel_archived",
        "member_waiting",
        "member_stopped",
        "member_merged",
        "member_killed",
        "run_completed",
      ],
    );
  });

  it("enforces live-session ownership, symlink guards, and partial state.json backfilling", async () => {
    const root = await makeTempDir("pi-swarm-owner-");
    const store = new SwarmStore(root);

    const run = await store.createRun({
      id: "run-own",
      title: "Ownership Check",
      objective: "Verify ownership checks and backfilling",
      baseBranch: "main",
      ownerSessionId: "sess-a",
      ownerPid: process.pid,
    });

    // Same session allowed
    assert.doesNotThrow(() => assertOwnerSession(run, "sess-a"));
    // Different session while owner PID alive throws OWNERSHIP_CONFLICT
    assert.throws(
      () => assertOwnerSession(run, "sess-b", { isPidAlive: () => true }),
      (err) => assertProtocolCode(err, "OWNERSHIP_CONFLICT"),
    );
    // Different session when owner PID dead is allowed
    assert.doesNotThrow(() =>
      assertOwnerSession(run, "sess-b", { isPidAlive: () => false }),
    );

    // Partial state.json backfills safely on loadRun
    const statePath = path.join(
      root,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      "run-own",
      SWARM_STATE_FILE,
    );
    const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    delete raw.channels;
    delete raw.boardHead;
    delete raw.strategy;
    delete raw.acceptanceCriteria;
    delete raw.keepWorkersWarm;
    await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const backfilled = await store.loadRun("run-own");
    assert.equal(backfilled.version, 2);
    assert.ok(backfilled.channels[DEFAULT_CHANNEL]);
    assert.equal(backfilled.boardHead, 0);
    assert.equal(backfilled.strategy, "");
    assert.equal(backfilled.acceptanceCriteria, "");
    assert.equal(backfilled.keepWorkersWarm, DEFAULT_SWARM_SETTINGS.keepWorkersWarm);

    // Symlinked state.json rejected with PERMISSION_DENIED
    const outside = path.join(root, "outside-state.json");
    await writeFile(outside, "{}", "utf8");
    const symRunDir = path.join(root, SWARM_DIR, SWARM_RUNS_DIR, "sym-run");
    await mkdir(symRunDir, { recursive: true });
    await symlink(outside, path.join(symRunDir, SWARM_STATE_FILE));
    await assert.rejects(
      () => store.loadRun("sym-run"),
      (err) => assertProtocolCode(err, "PERMISSION_DENIED"),
    );
  });
});

// ============================================================================
// 3. SwarmLedger & v2 Event Formatting
// ============================================================================

describe("SwarmLedger & formatLedgerEvent (all v2 SwarmEventTypes)", () => {
  it("formats every v2 SwarmEventType cleanly and persists serialized LF-only JSONL", async () => {
    const root = await makeTempDir("pi-swarm-ledger-");
    const eventsPath = path.join(root, SWARM_EVENTS_FILE);
    const ledger = new SwarmLedger(eventsPath);

    assert.equal(formatLedgerActivity([]), "(no activity yet)");

    const allTypes: SwarmEventType[] = [
      "run_created",
      "run_titled",
      "run_paused",
      "run_resumed",
      "run_completed",
      "run_abandoned",
      "member_added",
      "member_woken",
      "member_waiting",
      "member_stopped",
      "member_killed",
      "member_model_switched",
      "member_merged",
      "member_error",
      "board_posted",
      "channel_created",
      "channel_updated",
      "channel_archived",
      "stall_detected",
      "rate_limit_backoff",
      "teardown_completed",
    ];

    const appended = await Promise.all(
      allTypes.map((type) =>
        ledger.append({
          runId: "run-ledger",
          type,
          actor: "orchestrator",
          memberName: type.startsWith("member_") || type === "stall_detected" || type === "rate_limit_backoff"
            ? "parser"
            : undefined,
          channel: type.startsWith("channel_") || type === "board_posted"
            ? "backend"
            : undefined,
          summary: `Event ${type}`,
          data: {
            baseBranch: "main",
            title: "My Swarm",
            role: "worker",
            workspace: "share",
            model: "openai/gpt-5",
            previousModel: "openai/gpt-4.1",
            boardSeq: 7,
            boardHead: 9,
            seq: 7,
            kind: "review",
            commitSha: "deadbeef1234567",
            backoffMs: 5000,
            removed: 2,
            skipped: 1,
            errors: 0,
          },
        }),
      ),
    );

    assert.equal(appended.length, allTypes.length);
    assert.deepEqual(
      appended.map((e) => e.seq),
      allTypes.map((_, i) => i + 1),
    );

    const recent = await ledger.readRecent(allTypes.length);
    assert.equal(recent.length, allTypes.length);
    const formatted = ledger.format(recent);
    assert.equal(formatted.split("\n").length, allTypes.length);

    // Spot-check key formatted v2 event lines
    const byType = new Map<SwarmEventType, SwarmEvent>(
      recent.map((e) => [e.type, e]),
    );
    assert.match(
      formatLedgerEvent(byType.get("member_model_switched")!),
      /member_model_switched \[parser · openai\/gpt-4\.1 -> openai\/gpt-5\] \(orchestrator\)/,
    );
    assert.match(
      formatLedgerEvent(byType.get("member_merged")!),
      /member_merged \[parser · @deadbee\] \(orchestrator\)/,
    );
    assert.match(
      formatLedgerEvent(byType.get("board_posted")!),
      /board_posted \[#7 · #backend · review\] \(orchestrator\)/,
    );
    assert.match(
      formatLedgerEvent(byType.get("channel_archived")!),
      /channel_archived \[#backend\] \(orchestrator\)/,
    );
    assert.match(
      formatLedgerEvent(byType.get("stall_detected")!),
      /stall_detected \[parser · head #9\] \(orchestrator\)/,
    );
    assert.match(
      formatLedgerEvent(byType.get("rate_limit_backoff")!),
      /rate_limit_backoff \[parser · 5000ms\] \(orchestrator\)/,
    );
    assert.match(
      formatLedgerEvent(byType.get("teardown_completed")!),
      /teardown_completed \[removed 2 · skipped 1\] \(orchestrator\)/,
    );

    // Symlink protection on ledger
    const outside = path.join(root, "outside-events.jsonl");
    await writeFile(outside, "", "utf8");
    const symEvents = path.join(root, "sym-events.jsonl");
    await symlink(outside, symEvents);
    await assert.rejects(
      () => new SwarmLedger(symEvents).readAll(),
      (err) => assertProtocolCode(err, "PERMISSION_DENIED"),
    );
  });
});

// ============================================================================
// 4. SwarmSettings (3-Role Models, Legacy v1 Compatibility, Bounds & Layering)
// ============================================================================

describe("SwarmSettings layered persistence & legacy compatibility", () => {
  it("loads defaults, stays 100% compatible with legacy v1 settings files, and layers global/project overrides cleanly", async () => {
    const tmp = await makeTempDir("pi-swarm-settings-");
    const globalDir = path.join(tmp, "global-agent");
    const projectRoot = path.join(tmp, "project");
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    // Defaults
    const defaults = await loadSwarmSettings(projectRoot, { globalDir });
    assert.equal(defaults.maxConcurrency, 6);
    assert.equal(defaults.validatorEnabled, true);
    assert.equal(defaults.keepWorkersWarm, true);
    assert.equal(defaults.stallWatchdogEnabled, true);
    assert.equal(defaults.stallTimeoutMs, SWARM_DEFAULT_STALL_TIMEOUT_MS);
    assert.equal(defaults.autoRebase, true);
    assert.equal(defaults.autoTeardownOnComplete, false);
    assert.deepEqual(defaults.fallbackModels, []);

    // Simulate an existing v1 ~/.pi/agent/pi-swarm-settings.json with removed legacy keys!
    const globalFile = getGlobalSettingsPath({ globalDir });
    assert.equal(globalFile, path.join(globalDir, SWARM_SETTINGS_FILE));
    assert.equal(
      getProjectSettingsPath(projectRoot),
      path.join(projectRoot, ".pi", SWARM_SETTINGS_FILE),
    );
    await writeFile(
      globalFile,
      JSON.stringify(
        {
          orchestratorModel: "anthropic/claude-opus-4",
          orchestratorThinkingLevel: "high",
          workerModel: "openai/gpt-5",
          workerThinkingLevel: "medium",
          validatorModel: "google/gemini-2.5-pro",
          validatorThinkingLevel: "xhigh",
          fallbackModels: ["openai/gpt-4.1", "anthropic/claude-sonnet-4"],
          maxConcurrency: 8,
          keepWorkersWarm: false,
          autoRebase: false,
          // Legacy v1 keys & unknown keys MUST be ignored without throwing or warning!
          finalValidatorEnabled: true,
          maxValidationRounds: 5,
          maxFinalAuditRounds: 3,
          autoFixOnAuditFail: false,
          autoMergeClean: true,
          someUnknownFutureKey: { nested: true },
        },
        null,
        2,
      ),
      "utf8",
    );

    const fromLegacy = await loadLayeredSwarmSettings(projectRoot, { globalDir });
    assert.deepEqual(fromLegacy.warnings, []);
    assert.equal(fromLegacy.settings.orchestratorModel, "anthropic/claude-opus-4");
    assert.equal(fromLegacy.settings.orchestratorThinkingLevel, "high");
    assert.equal(fromLegacy.settings.workerModel, "openai/gpt-5");
    assert.equal(fromLegacy.settings.workerThinkingLevel, "medium");
    assert.equal(fromLegacy.settings.validatorModel, "google/gemini-2.5-pro");
    assert.equal(fromLegacy.settings.validatorThinkingLevel, "xhigh");
    assert.deepEqual(fromLegacy.settings.fallbackModels, [
      "openai/gpt-4.1",
      "anthropic/claude-sonnet-4",
    ]);
    assert.equal(fromLegacy.settings.maxConcurrency, 8);
    assert.equal(fromLegacy.settings.keepWorkersWarm, false);
    assert.equal(fromLegacy.settings.autoRebase, false);
    assert.equal(fromLegacy.settings.stallWatchdogEnabled, true);
    assert.equal(fromLegacy.settings.stallTimeoutMs, 45_000);

    // Project layer overrides, clamps out-of-range values, and clears global model via "" / null
    await saveSwarmSettings(
      "project",
      {
        maxConcurrency: 0, // clamps to 1
        stallWatchdogEnabled: false,
        stallTimeoutMs: 100, // clamps to SWARM_SETTINGS_BOUNDS.stallTimeoutMs.min (1000)
        rateLimitBaseBackoffMs: 10_000,
        rateLimitMaxBackoffMs: 2_000, // clamps >= base (10_000)
        workerModel: "", // clears global workerModel
        validatorModel: null as unknown as undefined, // clears global validatorModel
        keepWorkersWarm: true,
      },
      { globalDir, projectRoot },
    );

    const layered = await loadLayeredSwarmSettings(projectRoot, { globalDir });
    assert.equal(layered.settings.maxConcurrency, 1);
    assert.equal(layered.settings.stallWatchdogEnabled, false);
    assert.equal(
      layered.settings.stallTimeoutMs,
      SWARM_SETTINGS_BOUNDS.stallTimeoutMs.min,
    );
    assert.equal(layered.settings.rateLimitBaseBackoffMs, 10_000);
    assert.equal(layered.settings.rateLimitMaxBackoffMs, 10_000);
    assert.equal(layered.settings.autoRebase, false); // inherited from global
    assert.equal(layered.settings.keepWorkersWarm, true); // overridden by project
    assert.equal(layered.settings.workerModel, undefined); // cleared by project ""
    assert.equal(layered.settings.validatorModel, undefined); // cleared by project null
    assert.equal(layered.settings.orchestratorModel, "anthropic/claude-opus-4");

    // Explicit undefined removes project override so global is inherited again
    await saveSwarmSettings(
      "project",
      {
        workerModel: undefined,
        validatorModel: undefined,
      },
      { globalDir, projectRoot },
    );
    const reInherited = await loadSwarmSettings(projectRoot, { globalDir });
    assert.equal(reInherited.workerModel, "openai/gpt-5");
    assert.equal(reInherited.validatorModel, "google/gemini-2.5-pro");

    // Sanitizer handles malformed types & clamps upper/lower bounds
    const sanitized = sanitizeSwarmSettings({
      maxConcurrency: Number.NaN,
      stallTimeoutMs: 999_999_999,
      stallWatchdogEnabled: "not-bool" as never,
      validatorThinkingLevel: "ultra-invalid" as never,
      fallbackModels: ["  m1  ", 42 as never, "", "m2", "m1"],
      gitTimeoutMs: 50,
    });
    assert.equal(sanitized.maxConcurrency, DEFAULT_SWARM_SETTINGS.maxConcurrency);
    assert.equal(
      sanitized.stallTimeoutMs,
      SWARM_SETTINGS_BOUNDS.stallTimeoutMs.max,
    );
    assert.equal(sanitized.stallWatchdogEnabled, true);
    assert.equal(sanitized.validatorThinkingLevel, undefined);
    assert.deepEqual(sanitized.fallbackModels, ["m1", "m2"]);
    assert.equal(sanitized.gitTimeoutMs, SWARM_SETTINGS_BOUNDS.gitTimeoutMs.min);

    // Symlinked project settings file rejected on write
    const outside = path.join(tmp, "outside-settings.json");
    await writeFile(outside, "{}", "utf8");
    const symProject = path.join(tmp, "sym-settings.json");
    await symlink(outside, symProject);
    await assert.rejects(
      () =>
        saveSwarmSettings(
          "project",
          { maxConcurrency: 4 },
          { projectPath: symProject },
        ),
      (err) => assertProtocolCode(err, "PERMISSION_DENIED"),
    );
  });
});

// ============================================================================
// 5. Real Git Worktrees (Rebase, Merge, Diff, Reuse & Safe memberName Teardown)
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

    const excludeContent = await readFile(
      path.join(repoDir, ".git", "info", "exclude"),
      "utf8",
    );
    assert.match(excludeContent, /\.pi\/swarm\//);

    // Writing store/board files inside .pi/swarm/ must NOT make base repo dirty
    const store = new SwarmStore(repoDir);
    await store.createRun({
      id: "run-clean",
      title: "Clean Git Status",
      objective: "Verify .pi/swarm excluded from git status",
      baseBranch: "main",
      ownerSessionId: "sess-1",
    });
    await store.postBoardMessage("run-clean", {
      from: "orchestrator",
      fromRole: "orchestrator",
      text: "@all ready",
      kind: "brief",
    });

    const baseCheck = await wtMgr.isBaseCleanOnBranch("main");
    assert.equal(baseCheck.ok, true);
    assert.equal(baseCheck.dirty, false);
    assert.equal(baseCheck.currentBranch, "main");
  });

  it("creates member worktrees, detects committed/untracked changes, auto-rebases cleanly, and merges", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-flow-");
    const wtMgr = new WorktreeManager(repoDir);
    const store = new SwarmStore(repoDir);
    await wtMgr.ensureRepoReady("main");

    await commitFile(repoDir, "src/base.txt", "base\n", "add base file");

    const branchA = deriveMemberBranch("run-git", "alpha");
    const branchB = deriveMemberBranch("run-git", "beta");
    const pathA = store.getWorktreePath("run-git", "alpha");
    const pathB = store.getWorktreePath("run-git", "beta");

    const wtA = await wtMgr.createWorktree({
      branch: branchA,
      baseBranch: "main",
      worktreePath: pathA,
    });
    const wtB = await wtMgr.createWorktree({
      branch: branchB,
      baseBranch: "main",
      worktreePath: pathB,
    });

    // Duplicate branch rejected when reuseExistingBranch is false
    await assert.rejects(
      () =>
        wtMgr.createWorktree({
          branch: branchA,
          baseBranch: "main",
          worktreePath: path.join(repoDir, ".pi/swarm/worktrees/dup"),
        }),
      (err) => assertProtocolCode(err, "GIT_ERROR"),
    );

    await commitFile(
      wtA.worktreePath,
      "src/alpha/mod.ts",
      "export const a = 1;\n",
      "add alpha",
    );
    assert.deepEqual(
      await wtMgr.getChangedFiles("main", "HEAD", wtA.worktreePath),
      ["src/alpha/mod.ts"],
    );

    const diffSummary = await wtMgr.getDiffSummary("main", branchA);
    assert.equal(diffSummary.commitsAhead, 1);
    assert.deepEqual(diffSummary.changedFiles, ["src/alpha/mod.ts"]);
    assert.match(diffSummary.diff, /export const a = 1;/);

    // Commit in beta + untracked file -> detected by getChangedFiles & skipped by autoRebase
    await commitFile(
      wtB.worktreePath,
      "src/beta/mod.ts",
      "export const b = 2;\n",
      "add beta",
    );
    const wipPath = path.join(wtB.worktreePath, "src/beta/wip.ts");
    await writeFile(wipPath, "wip\n", "utf8");
    assert.deepEqual(
      await wtMgr.getChangedFiles("main", "HEAD", wtB.worktreePath),
      ["src/beta/mod.ts", "src/beta/wip.ts"],
    );
    assert.equal((await wtMgr.autoRebase(wtB.worktreePath, "main")).status, "skipped_dirty");

    await rm(wipPath);

    // Merge alpha into main -> main advances
    const mergeA = await wtMgr.mergeBranch({
      baseBranch: "main",
      branch: branchA,
      commitMessage: "merge alpha",
    });
    assert.equal(mergeA.strategy, "merge");
    assert.deepEqual(mergeA.changedFiles, ["src/alpha/mod.ts"]);
    assert.equal(await exists(path.join(repoDir, "src/alpha/mod.ts")), true);

    // Auto-rebase beta onto updated main
    const rebasedB = await wtMgr.autoRebase(wtB.worktreePath, "main");
    assert.equal(rebasedB.status, "rebased");
    assert.ok(rebasedB.newHeadSha);
    assert.equal(await exists(path.join(wtB.worktreePath, "src/alpha/mod.ts")), true);

    // Running autoRebase again reports up-to-date
    assert.equal((await wtMgr.autoRebase(wtB.worktreePath, "main")).status, "up-to-date");

    // Fast-forward merge beta when noFf: false
    const mergeB = await wtMgr.mergeBranch({
      baseBranch: "main",
      branch: branchB,
      noFf: false,
    });
    assert.equal(mergeB.strategy, "fast-forward");
    assert.equal(await exists(path.join(repoDir, "src/beta/mod.ts")), true);
  });

  it("aborts cleanly on rebase/merge conflicts and enforces DIRTY_BASE & WRONG_BRANCH", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-conflict-");
    const wtMgr = new WorktreeManager(repoDir);
    await wtMgr.ensureRepoReady("main");
    await commitFile(
      repoDir,
      "shared.txt",
      "line1\noriginal\nline3\n",
      "seed shared.txt",
    );

    const wtPath = path.join(repoDir, ".pi/swarm/worktrees/run-c/wt-worker");
    await wtMgr.createWorktree({
      branch: "swarm/run-c/worker",
      baseBranch: "main",
      worktreePath: wtPath,
    });

    await commitFile(
      wtPath,
      "shared.txt",
      "line1\nworker-change\nline3\n",
      "worker edit",
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
    assert.equal(await wtMgr.isWorktreeDirty(wtPath), false);
    assert.equal(await wtMgr.getCurrentBranch(wtPath), "swarm/run-c/worker");

    // DIRTY_BASE guard
    await writeFile(path.join(repoDir, "uncommitted.txt"), "dirty\n", "utf8");
    await assert.rejects(
      () =>
        wtMgr.mergeBranch({
          baseBranch: "main",
          branch: "swarm/run-c/worker",
        }),
      (err) => assertProtocolCode(err, "DIRTY_BASE"),
    );
    await rm(path.join(repoDir, "uncommitted.txt"));

    // WRONG_BRANCH guard
    await git(repoDir, ["checkout", "-b", "other-branch"]);
    await assert.rejects(
      () =>
        wtMgr.mergeBranch({
          baseBranch: "main",
          branch: "swarm/run-c/worker",
        }),
      (err) => assertProtocolCode(err, "WRONG_BRANCH"),
    );
    await git(repoDir, ["checkout", "main"]);

    // Direct merge conflict aborts cleanly & throws REBASE_CONFLICT
    await assert.rejects(
      () =>
        wtMgr.mergeBranch({
          baseBranch: "main",
          branch: "swarm/run-c/worker",
        }),
      (err) => assertProtocolCode(err, "REBASE_CONFLICT"),
    );
    assert.equal(await wtMgr.isWorktreeDirty(repoDir), false);
  });

  it("safeTeardown uses memberName, protects dirty & active worktrees, and deletes branches only when requested", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-teardown-");
    const wtMgr = new WorktreeManager(repoDir);
    const store = new SwarmStore(repoDir);
    await wtMgr.ensureRepoReady("main");

    await store.createRun({
      id: "run-td",
      title: "Safe Teardown Verification",
      objective: "Ensure dirty/active member worktrees are never wiped",
      baseBranch: "main",
      ownerSessionId: "sess-td",
    });

    const members = ["clean-w", "dirty-w", "active-w", "delete-w"] as const;
    const paths: Record<string, string> = {};
    const branches: Record<string, string> = {};

    for (const name of members) {
      paths[name] = store.getWorktreePath("run-td", name);
      branches[name] = deriveMemberBranch("run-td", name);
      await wtMgr.createWorktree({
        branch: branches[name],
        baseBranch: "main",
        worktreePath: paths[name],
      });
    }

    const dirtyFile = path.join(paths["dirty-w"], "wip.txt");
    await writeFile(dirtyFile, "precious uncommitted work\n", "utf8");

    const td1 = await wtMgr.safeTeardown([
      {
        memberName: "clean-w",
        worktreePath: paths["clean-w"],
        branch: branches["clean-w"],
        hasActiveAgent: false,
      },
      {
        memberName: "dirty-w",
        worktreePath: paths["dirty-w"],
        branch: branches["dirty-w"],
        hasActiveAgent: false,
      },
      {
        memberName: "active-w",
        worktreePath: paths["active-w"],
        branch: branches["active-w"],
        hasActiveAgent: true,
      },
      {
        memberName: "ghost-w",
        worktreePath: store.getWorktreePath("run-td", "ghost-w"),
        branch: "swarm/run-td/ghost-w",
        hasActiveAgent: false,
      },
    ]);

    assert.equal(td1.errors.length, 0);
    assert.deepEqual(
      td1.removed.map((r) => r.memberName),
      ["clean-w"],
    );
    assert.deepEqual(
      td1.skipped.map((s) => ({ name: s.memberName, action: s.action })),
      [
        { name: "dirty-w", action: "skipped_dirty" },
        { name: "active-w", action: "skipped_active" },
        { name: "ghost-w", action: "missing" },
      ],
    );

    assert.equal(await exists(paths["clean-w"]), false);
    assert.ok((await wtMgr.listLocalBranches()).includes(branches["clean-w"]));
    assert.equal(await readFile(dirtyFile, "utf8"), "precious uncommitted work\n");
    assert.equal(await exists(paths["active-w"]), true);
    assert.equal((await store.loadRun("run-td")).id, "run-td");

    const td2 = await wtMgr.safeTeardown(
      [
        {
          memberName: "delete-w",
          worktreePath: paths["delete-w"],
          branch: branches["delete-w"],
          hasActiveAgent: false,
        },
      ],
      { deleteBranches: true },
    );
    assert.equal(td2.removed.length, 1);
    assert.equal(td2.removed[0].memberName, "delete-w");
    assert.equal(await exists(paths["delete-w"]), false);
    assert.equal((await wtMgr.listLocalBranches()).includes(branches["delete-w"]), false);
  });

  it("reuses existing checked-out worktrees and re-attaches removed worktrees cleanly", async () => {
    const repoDir = await makeTempDir("pi-swarm-git-reuse-");
    const wtMgr = new WorktreeManager(repoDir);
    await wtMgr.ensureRepoReady("main");

    const wtPath = path.join(repoDir, ".pi/swarm/worktrees/run-r/wt-parser");
    const first = await wtMgr.createWorktree({
      branch: "swarm/run-r/parser",
      baseBranch: "main",
      worktreePath: wtPath,
    });

    const round1Sha = await commitFile(
      first.worktreePath,
      "src/retry.ts",
      "export const round = 1;\n",
      "round 1 commit",
    );
    await writeFile(path.join(first.worktreePath, "wip.tmp"), "in-progress\n", "utf8");

    const reused = await wtMgr.createWorktree({
      branch: "swarm/run-r/parser",
      baseBranch: "main",
      worktreePath: wtPath,
      reuseExistingBranch: true,
    });
    assert.equal(reused.branch, "swarm/run-r/parser");
    assert.equal(reused.worktreePath, first.worktreePath);
    assert.equal(await wtMgr.getHeadSha(reused.worktreePath), round1Sha);
    assert.equal(
      await readFile(path.join(reused.worktreePath, "wip.tmp"), "utf8"),
      "in-progress\n",
    );

    await git(repoDir, ["branch", "swarm/run-r/other", "main"]);
    await assert.rejects(
      () =>
        wtMgr.createWorktree({
          branch: "swarm/run-r/other",
          baseBranch: "main",
          worktreePath: wtPath,
          reuseExistingBranch: true,
        }),
      (err) => assertProtocolCode(err, "WRONG_BRANCH"),
    );

    await rm(path.join(reused.worktreePath, "wip.tmp"));
    await wtMgr.removeWorktree(wtPath, { force: true });
    assert.equal(await exists(wtPath), false);

    const reattached = await wtMgr.createWorktree({
      branch: "swarm/run-r/parser",
      baseBranch: "main",
      worktreePath: wtPath,
      reuseExistingBranch: true,
    });
    assert.equal(reattached.branch, "swarm/run-r/parser");
    assert.equal(await wtMgr.getHeadSha(reattached.worktreePath), round1Sha);
  });
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  DRAFTING_TOOLS,
  ORCHESTRATOR_NAME,
  SWARM_CORE_TOOLS,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../src/constants.js";
import { SWARM_SUBCOMMANDS } from "../src/index.js";
import {
  buildMemberSystemPrompt,
  buildOrchestratorStandbySection,
  buildWakeupPrompt,
  createMemberScopedTools,
  createSwarmTools,
  createWorkerGuardExtensionFactory,
  isForbiddenWorkerBashCommand,
} from "../src/runtime/index.js";
import {
  SwarmToolParamsSchema,
  SwarmWaitToolParamsSchema,
} from "../src/runtime/swarm-tools.js";
import type {
  ParkOrchestratorWaitOptions,
  SpawnMemberRequest,
  SwarmMemberRecord,
  SwarmRunState,
} from "../src/types.js";

function makeSampleRun(overrides?: Partial<SwarmRunState>): SwarmRunState {
  const now = new Date().toISOString();
  return {
    version: 2,
    id: "run-gold-rt",
    title: "Goldilocks Runtime Calibration",
    objective: "Calibrate runtime guards, prompts, and tool schemas",
    strategy: "Disjoint inherit workers + live validator",
    acceptanceCriteria: "npm run typecheck && npm test",
    baseBranch: "main",
    ownerSessionId: "sess-gold-rt",
    ownerPid: process.pid,
    status: "active",
    maxConcurrency: 4,
    validatorEnabled: true,
    keepWorkersWarm: true,
    roleModels: {},
    commands: [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "test", command: "npm test" },
    ],
    assertions: [
      {
        id: "VAL-RT-001",
        title: "Runtime guard works",
        description: "Blocks out-of-scope inherit edits",
        status: "pending",
        updatedAt: now,
      },
      {
        id: "VAL-RT-002",
        title: "Batch verify works",
        description: "Stamps multiple assertions atomically",
        status: "pending",
        updatedAt: now,
      },
    ],
    features: [
      {
        id: "feat-rt",
        title: "Runtime Guard",
        description: "Enforce filesOwned and git guardrails",
        milestone: "M1",
        filesOwned: ["src/runtime/**"],
        fulfills: ["VAL-RT-001", "VAL-RT-002"],
        status: "in_progress",
        assignedMember: "worker-rt",
        updatedAt: now,
      },
    ],
    revision: 1,
    members: {},
    memberOrder: [],
    channels: {
      main: {
        name: "main",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: now,
        archived: false,
        subscribers: [],
      },
    },
    boardHead: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSampleMember(
  name: string,
  role: "worker" | "validator",
  workspace: "inherit" | "share" | "branch" = "inherit",
  extra?: Partial<SwarmMemberRecord>,
): SwarmMemberRecord {
  const now = new Date().toISOString();
  return {
    name,
    agentId: `${name}-1`,
    role,
    state: "working",
    parentName: ORCHESTRATOR_NAME,
    brief: `Work on ${name}`,
    workspace,
    cwd: workspace === "inherit" ? "/repo" : `/repo/.pi/swarm/worktrees/wt-${name}`,
    ...(workspace !== "inherit" ? { branch: `swarm/run-gold-rt/${name}` } : {}),
    channels: ["main"],
    lastReadSeq: 1,
    turns: 0,
    tokens: 0,
    cost: 0,
    humanStopped: false,
    logTail: [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

async function listTsFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFilesRecursive(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("Goldilocks Calibration — Transport, Swarm Tools, Role Prompts & Hard Invariants", () => {
  it("1. enforces workspace='inherit' shared-tree git guardrails while preserving read-only git commands and share/branch commits", () => {
    const blockedInheritGitCommands = [
      "git checkout feat-other",
      "git checkout main",
      "git checkout -b feat-new",
      "git checkout -B feat-new",
      "git c''heckout feat-other",
      "git switch feat-other",
      "git switch -c feat-new",
      'git commit -m "should belong to user"',
      "git commit -am 'wip'",
      "git c\"\"ommit -m test",
      "git merge feat-other",
      "git rebase main",
      "git cherry-pick abc1234",
      "git branch -D old-branch",
      "git reset --hard HEAD",
      "git clean -fd",
      "git stash",
    ];

    for (const cmd of blockedInheritGitCommands) {
      const res = isForbiddenWorkerBashCommand(cmd, "", "/repo", {
        workspace: "inherit",
      });
      assert.equal(
        res.allowed,
        false,
        `Expected inherit worker bash guard to block: ${cmd}`,
      );
      assert.ok(res.reason && res.reason.length > 20);
    }

    // Check clear reason explaining shared live working tree vs user ownership
    const commitRes = isForbiddenWorkerBashCommand(
      'git commit -m "wip"',
      "",
      "/repo",
      { workspace: "inherit" },
    );
    assert.equal(commitRes.allowed, false);
    assert.match(commitRes.reason ?? "", /workspace: "inherit"/);
    assert.match(commitRes.reason ?? "", /shares the live working tree/i);
    assert.match(commitRes.reason ?? "", /belong to the user/i);

    // Read-only git commands MUST still be allowed in workspace: "inherit"
    const allowedInheritGitCommands = [
      "git status",
      "git status --short && npm test",
      "git diff",
      "git diff HEAD -- src/runtime/engine.ts",
      "git log -n 5 --oneline",
      "git show HEAD:src/types.ts",
      "git rev-parse HEAD",
      "git merge-base main HEAD",
      "git branch",
      "git branch -a",
      "git branch --list",
      "git branch --show-current",
      'echo "fixed git commit message formatting"',
    ];

    for (const cmd of allowedInheritGitCommands) {
      const res = isForbiddenWorkerBashCommand(cmd, "", "/repo", {
        workspace: "inherit",
      });
      assert.equal(
        res.allowed,
        true,
        `Expected inherit worker bash guard to allow read-only command: ${cmd} (reason: ${res.reason ?? "none"})`,
      );
    }

    // Opt-in isolated share/branch worktrees STILL allow git commit and branch-local operations
    const wtPath = "/repo/.pi/swarm/worktrees/run-1/wt-share";
    assert.equal(
      isForbiddenWorkerBashCommand('git commit -m "clean slice commit"', "main", wtPath, {
        workspace: "share",
      }).allowed,
      true,
    );
    assert.equal(
      isForbiddenWorkerBashCommand("git checkout -b sub-exp", "main", wtPath, {
        workspace: "branch",
      }).allowed,
      true,
    );
  });

  it("2. enforces createWorkerGuardExtensionFactory filesOwned & peerFilesOwned on inherit workers with backward-compatible wildcard/empty fallback", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-files-owned-"));
    try {
      await mkdir(path.join(repoDir, "src", "runtime"), { recursive: true });
      await mkdir(path.join(repoDir, "src", "ui"), { recursive: true });
      await mkdir(path.join(repoDir, "src", "drafting"), { recursive: true });

      const attachGuard = (req: SpawnMemberRequest) => {
        let handler!: (event: any) => any;
        createWorkerGuardExtensionFactory(req, "main")({
          on(ev: string, fn: (event: any) => any) {
            if (ev === "tool_call") handler = fn;
          },
        } as any);
        return handler;
      };

      const baseReq: SpawnMemberRequest = {
        agentId: "worker-rt-1",
        name: "worker-rt",
        role: "worker",
        runId: "run-1",
        cwd: repoDir,
        workspace: "inherit",
        parentName: ORCHESTRATOR_NAME,
        brief: "Implement runtime changes",
        systemPrompt: "sys",
        initialPrompt: "go",
        keepWarm: true,
        filesOwned: ["src/types.ts", "src/runtime", "tests/*.test.ts"],
        peerFilesOwned: {
          "gold-ui": ["src/ui/**"],
          "gold-drafting": ["src/drafting/"],
        },
      };

      const scopedGuard = attachGuard(baseReq);

      // Exact file, directory prefix, and glob matches are ALLOWED
      assert.equal(
        scopedGuard({ toolName: "edit", input: { path: "src/types.ts" } }),
        undefined,
      );
      assert.equal(
        scopedGuard({ toolName: "write", input: { path: "src/runtime/engine.ts" } }),
        undefined,
      );
      assert.equal(
        scopedGuard({ toolName: "write", input: { path: "tests/runtime.test.ts" } }),
        undefined,
      );

      // Out-of-scope edit matching peerFilesOwned names the owning peer + lists filesOwned + cites upsert_features
      const blockedPeerUi = scopedGuard({
        toolName: "edit",
        input: { path: "src/ui/dashboard-widget.ts" },
      });
      assert.equal(blockedPeerUi?.block, true);
      assert.match(String(blockedPeerUi?.reason), /owned by @gold-ui/);
      assert.match(
        String(blockedPeerUi?.reason),
        /src\/types\.ts, src\/runtime, tests\/\*\.test\.ts/,
      );
      assert.match(String(blockedPeerUi?.reason), /upsert_features/);

      const blockedPeerDraft = scopedGuard({
        toolName: "write",
        input: { path: path.join(repoDir, "src/drafting/draft-tools.ts") },
      });
      assert.equal(blockedPeerDraft?.block, true);
      assert.match(String(blockedPeerDraft?.reason), /owned by @gold-drafting/);

      // Out-of-scope unowned file is also blocked cleanly
      const blockedUnowned = scopedGuard({
        toolName: "write",
        input: { path: "src/index.ts" },
      });
      assert.equal(blockedUnowned?.block, true);
      assert.match(String(blockedUnowned?.reason), /outside @worker-rt's filesOwned slice/);

      // Backward compatibility: undefined, empty [], or ["*"] filesOwned do NOT block write/edit
      for (const unrestricted of [undefined, [], ["*"], ["src/runtime/**", "*"]]) {
        const openGuard = attachGuard({
          ...baseReq,
          filesOwned: unrestricted,
        });
        assert.equal(
          openGuard({ toolName: "write", input: { path: "src/ui/anything.ts" } }),
          undefined,
        );
        // Protected .pi/swarm/ and .git/ paths remain blocked even when unrestricted!
        assert.equal(
          openGuard({ toolName: "write", input: { path: ".pi/swarm/state.json" } })?.block,
          true,
        );
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("3. exposes flat wait_for_all on swarm_wait and batch assertion_ids on orchestrator & member swarm tools", async () => {
    let capturedWaitOpts: ParkOrchestratorWaitOptions | undefined;
    let capturedMissionInput: any;

    const stubEngine: any = {
      getSnapshot: () => ({
        run: makeSampleRun(),
        activeRunId: "run-gold-rt",
        workingMemberNames: ["scout-1", "scout-2"],
        waitingMemberNames: [],
        boardHead: 3,
        recentBoard: [],
        recentEvents: [],
        roleModels: {},
        totalTokens: 0,
        totalCost: 0,
        updatedAt: new Date().toISOString(),
      }),
      parkOrchestratorWait: async (opts: ParkOrchestratorWaitOptions) => {
        capturedWaitOpts = opts;
        return {
          parked: true,
          messages: [],
          head: 3,
          activeMembers: ["scout-1", "scout-2"],
          waitForAll: opts.waitForAll,
          summary: "Parked waiting (wait_for_all).",
        };
      },
      manageMission: async (input: any) => {
        capturedMissionInput = input;
        return {
          op: input.op,
          assertions: [],
          features: [],
          milestones: [],
          summary: "Batch verified.",
        };
      },
    };

    const orchTools = createSwarmTools({ engine: stubEngine });
    const waitTool = orchTools.find((t) => t.name === SWARM_WAIT_TOOL)!;
    const swarmTool = orchTools.find((t) => t.name === SWARM_TOOL)!;

    const waitRes = await waitTool.execute(
      "tc-w1",
      { since: 3, wait_for_all: true },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    assert.equal(capturedWaitOpts?.waitForAll, true);
    assert.equal((waitRes as any).terminate, true);

    await swarmTool.execute(
      "tc-m1",
      {
        action: "mission",
        mission_op: "verify_assertion",
        assertion_ids: ["VAL-RT-001", "VAL-RT-002"],
        assertion_status: "passed",
        evidence: "npm test passed (20/20)",
      },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    assert.deepEqual(capturedMissionInput?.assertionIds, ["VAL-RT-001", "VAL-RT-002"]);

    // Verify member-scoped validator swarm tool also forwards assertion_ids
    let capturedValidatorMission: any;
    const memberTools = createMemberScopedTools(
      {
        postMessage: async () => ({}) as any,
        readBoard: async () => ({ messages: [], head: 0 }),
        getStatus: async () => ({}) as any,
        listModels: async () => [],
        addHelper: async () => [],
        killHelper: async () => {},
        switchModel: async () => ({ targetName: "val", model: "m" }),
        manageChannel: async () => ({ action: "list", summary: "" }),
        manageMission: async (input) => {
          capturedValidatorMission = input;
          return { op: input.op, summary: "Verified batch" };
        },
      },
      { name: "val", role: "validator", runId: "run-gold-rt" },
    );
    const valSwarmTool = memberTools.find((t) => t.name === SWARM_TOOL)!;
    await valSwarmTool.execute(
      "tc-val-batch",
      {
        action: "mission",
        mission_op: "verify_assertion",
        assertion_ids: ["VAL-RT-001", "VAL-RT-002"],
        assertion_status: "passed",
        evidence: "Verified both assertions in 1 call",
      } as any,
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    assert.deepEqual(capturedValidatorMission?.assertionIds, [
      "VAL-RT-001",
      "VAL-RT-002",
    ]);
  });

  it("4. calibrates worker, validator, and standby role-prompts while preserving existing required contract cues", () => {
    const run = makeSampleRun();
    const inheritWorker = makeSampleMember("worker-rt", "worker", "inherit");
    const shareWorker = makeSampleMember("worker-share", "worker", "share");
    const validator = makeSampleMember("validator", "validator", "inherit");

    const inheritPrompt = buildMemberSystemPrompt(run, inheritWorker);
    assert.match(inheritPrompt, /mission-worker-base/);
    assert.match(inheritPrompt, /do \*\*NOT\*\* run full-repo baseline `build`\/`test` suites before editing when `library\/testing\.md` already has baseline notes/);
    assert.match(inheritPrompt, /tsbuildinfo/);
    assert.match(inheritPrompt, /automatically marks your assigned feature `completed`/);
    assert.match(inheritPrompt, /do NOT call `update_feature` to mark features `completed`/);
    assert.match(inheritPrompt, /Batch independent read, inspection, or verification shell commands/);

    const sharePrompt = buildMemberSystemPrompt(run, shareWorker);
    assert.match(sharePrompt, /Isolated Worktree Commits/);

    const valPrompt = buildMemberSystemPrompt(run, validator, {
      scratchDir: "/tmp/pi-swarm-validator/run-gold-rt/validator",
    });
    assert.match(valPrompt, /assertion_ids/);
    assert.match(valPrompt, /1 tool call/);
    assert.match(valPrompt, /STRICTLY READ-ONLY/);

    const valWake = buildWakeupPrompt(validator, [], 5);
    assert.match(valWake, /assertion_ids/);

    const standby = buildOrchestratorStandbySection();
    assert.match(standby, /1–4 known target files/);
    assert.match(standby, /skip_contract_review: true/);
    assert.match(standby, /5\+ file cross-module/);
    assert.match(standby, /wait_for_all:true/);
    assert.match(standby, /\/swarm exit/);
  });

  it("5. preserves all hard invariants (tool/subcommand counts, zero Type.Union/Type.Record/anyOf/oneOf in swarm-tools.ts, zero replaceControlCharacters/tower in src/)", async () => {
    assert.equal(SWARM_SUBCOMMANDS.length, 21);
    assert.equal(SWARM_CORE_TOOLS.length, 4);
    assert.equal(DRAFTING_TOOLS.length, 3);
    assert.equal(SWARM_CORE_TOOLS.length + DRAFTING_TOOLS.length, 7);

    const swarmToolsPath = path.resolve(
      import.meta.dirname,
      "../src/runtime/swarm-tools.ts",
    );
    const swarmToolsSrc = await readFile(swarmToolsPath, "utf8");
    assert.equal(
      /\bType\.Union\b/.test(swarmToolsSrc),
      false,
      "swarm-tools.ts must contain zero Type.Union",
    );
    assert.equal(
      /\bType\.Record\b/.test(swarmToolsSrc),
      false,
      "swarm-tools.ts must contain zero Type.Record",
    );
    assert.equal(
      /\banyOf\b/.test(swarmToolsSrc),
      false,
      "swarm-tools.ts must contain zero anyOf",
    );
    assert.equal(
      /\boneOf\b/.test(swarmToolsSrc),
      false,
      "swarm-tools.ts must contain zero oneOf",
    );

    const schemasJson = JSON.stringify([
      SwarmToolParamsSchema,
      SwarmWaitToolParamsSchema,
    ]);
    assert.equal(schemasJson.includes('"anyOf"'), false);
    assert.equal(schemasJson.includes('"oneOf"'), false);

    const srcDir = path.resolve(import.meta.dirname, "../src");
    const allSrcFiles = await listTsFilesRecursive(srcDir);
    assert.ok(allSrcFiles.length > 0);
    for (const filePath of allSrcFiles) {
      const content = await readFile(filePath, "utf8");
      assert.equal(
        content.includes("replaceControlCharacters"),
        false,
        `Forbidden replaceControlCharacters found in ${filePath}`,
      );
      assert.equal(
        /tower/i.test(content),
        false,
        `Forbidden case-insensitive "tower" found in ${filePath}`,
      );
    }
  });
});

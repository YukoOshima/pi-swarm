import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  ALL_SWARM_EXTENSION_TOOLS,
  DEFAULT_SWARM_SETTINGS,
  DRAFTING_TOOLS,
  IDLE_SWARM_TOOLS as CONSTANTS_IDLE_SWARM_TOOLS,
  POST_MESSAGE_TOOL,
  PROPOSE_SWARM_PLAN_TOOL,
  READ_BOARD_TOOL,
  RESERVED_MEMBER_NAMES,
  SWARM_CORE_TOOLS,
  SWARM_DRAFT_ENTRY,
  SWARM_DRAFT_VERSION,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_QUESTION_TOOL,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../src/constants.js";
import {
  applySwarmToolProfile,
  buildDirectPlanPrompt,
  buildDraftingKickoffPrompt,
  buildDraftingSystemOverlay,
  buildRoleModelsFromSettings,
  clearDraft,
  createDraftingTools,
  DraftStateController,
  escapeXml,
  formatProposalTranscriptSummary,
  getSwarmToolsForMode,
  IDLE_SWARM_TOOLS,
  isDraftActive,
  ProposeSwarmPlanParamsSchema,
  registerDraftingTools,
  rehydrateDraft,
  startDraft,
  startOrResolveDraft,
  updateDraft,
  validateProposedSwarmPlan,
  type DraftingDeps,
  type ProposeSwarmPlanParams,
  type ProposeSwarmPlanToolDetails,
  type SwarmDraftState,
  type SwarmQuestionnaireToolDetails,
  type SwarmQuestionToolDetails,
} from "../src/drafting/index.js";
import {
  SwarmProtocolError,
  type IQuestionnaireUI,
  type IWorktreeManager,
  type ProposedSwarmPlan,
  type QuestionSpec,
  type QuestionnaireResult,
  type SwarmRunState,
  type SwarmSettings,
} from "../src/types.js";

// ============================================================================
// Lightweight Mocks
// ============================================================================

interface RecordedEntry {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data?: unknown;
}

class MockPiHarness {
  activeTools: string[];
  setActiveToolsCalls: string[][] = [];
  branchEntries: SessionEntry[] = [];
  registeredTools = new Map<string, any>();
  private nextId = 1;

  constructor(initialTools?: string[]) {
    this.activeTools = initialTools ?? [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "other_ext_tool",
      SWARM_TOOL,
    ];
  }

  get api(): ExtensionAPI {
    return {
      getActiveTools: () => [...this.activeTools],
      setActiveTools: (names: string[]) => {
        this.activeTools = [...names];
        this.setActiveToolsCalls.push([...names]);
      },
      appendEntry: <T = unknown>(customType: string, data?: T) => {
        const prev = this.branchEntries[this.branchEntries.length - 1];
        const entry: RecordedEntry = {
          type: "custom",
          id: `e${this.nextId++}`,
          parentId: prev ? prev.id : null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        };
        this.branchEntries.push(entry as unknown as SessionEntry);
      },
      registerTool: (tool: any) => {
        this.registeredTools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI;
  }

  appendCompactionEntry(summary = "Compacted earlier conversation"): void {
    const prev = this.branchEntries[this.branchEntries.length - 1];
    this.branchEntries.push({
      type: "compaction",
      id: `c${this.nextId++}`,
      parentId: prev ? prev.id : null,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId: prev ? prev.id : "root",
      tokensBefore: 12000,
    } as unknown as SessionEntry);
  }

  createContext(overrides?: {
    hasUI?: boolean;
    cwd?: string;
    selectResult?: string | undefined;
    selectThrows?: Error;
    branch?: SessionEntry[];
  }): ExtensionToolContext {
    const branchRef = () => overrides?.branch ?? this.branchEntries;
    return {
      cwd: overrides?.cwd ?? "/tmp/mock-repo",
      mode: "tui",
      hasUI: overrides?.hasUI ?? true,
      sessionManager: {
        getBranch: () => [...branchRef()],
        getSessionId: () => "sess-test-1",
      },
      ui: {
        select: async (_title: string, _options: string[]) => {
          if (overrides?.selectThrows) {
            throw overrides.selectThrows;
          }
          return overrides?.selectResult;
        },
        notify: () => {},
      },
      tools: [],
      executeTool: async () => {
        throw new Error("not implemented");
      },
    } as unknown as ExtensionToolContext;
  }
}

function createMockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    dim: (text: string) => text,
  } as unknown as Theme;
}

function createMockWorktree(opts?: {
  currentBranch?: string;
  getCurrentBranchThrows?: boolean;
}): IWorktreeManager {
  return {
    repoRoot: "/tmp/mock-repo",
    getCurrentBranch: async () => {
      if (opts?.getCurrentBranchThrows) {
        throw new Error("not a git repository");
      }
      return opts?.currentBranch ?? "main";
    },
    listLocalBranches: async () => [opts?.currentBranch ?? "main"],
  } as unknown as IWorktreeManager;
}

function createMockRun(plan: ProposedSwarmPlan): SwarmRunState {
  const now = new Date().toISOString();
  const initialNames = (plan.initialMembers ?? []).map((m) => m.name);
  return {
    version: 2,
    id: "run-20261120-dyn",
    title: plan.title,
    objective: plan.objective,
    strategy: plan.strategy,
    acceptanceCriteria: plan.acceptanceCriteria,
    baseBranch: plan.baseBranch,
    ownerSessionId: "sess-test-1",
    ownerPid: process.pid,
    status: "active",
    maxConcurrency: plan.maxConcurrency,
    validatorEnabled: plan.validatorEnabled,
    keepWorkersWarm: DEFAULT_SWARM_SETTINGS.keepWorkersWarm,
    roleModels: plan.roleModels ?? {},
    revision: 1,
    members: {},
    memberOrder: initialNames,
    channels: {
      main: {
        name: "main",
        createdBy: "orchestrator",
        createdAt: now,
        archived: false,
        subscribers: initialNames,
      },
    },
    boardHead: initialNames.length,
    createdAt: now,
    updatedAt: now,
  };
}

function makeSamplePlanParams(
  overrides?: Partial<ProposeSwarmPlanParams>,
): ProposeSwarmPlanParams {
  return {
    title: "OAuth & Audit Rollout",
    objective: "Implement OAuth2 PKCE login and structured security audit logging.",
    strategy:
      "Phase 1: Spawn read-only scout to inspect auth hooks. Phase 2: Dynamically launch isolated workers for OAuth client and audit logger, coordinating contracts on the shared board. Phase 3: Run read-only validator on merged diffs and iterate until green.",
    acceptance_criteria:
      "npm test && npm run typecheck passes with 0 errors; OAuth PKCE exchange and audit event sinks verified.",
    initial_members: [
      {
        name: "scout",
        role: "worker",
        workspace: "inherit",
        brief: "Inspect existing auth middleware and post contract summary on #main.",
      },
      {
        name: "oauth-dev",
        role: "worker",
        workspace: "share",
        brief: "Implement OAuth2 PKCE client and unit tests in an isolated worktree.",
        channels: ["auth"],
      },
      {
        name: "verifier",
        role: "validator",
        workspace: "inherit",
        brief: "Audit OAuth and audit-log changes read-only and report findings via @mention.",
      },
    ],
    ...overrides,
  };
}

// ============================================================================
// 1. Draft State & Rehydration Tests (version: 2)
// ============================================================================

describe("draft-state: rehydrateDraft (version: 2) & lifecycle", () => {
  it("returns null on empty branch, starts version: 2 draft, merges questionnaireEcho, and clones defensively", () => {
    const harness = new MockPiHarness();
    const ctx = harness.createContext();

    assert.equal(rehydrateDraft(ctx), null);

    const started = startDraft(harness.api, {
      mode: "swarm",
      seed: "Build dynamic multi-agent runner",
      validatorEnabled: true,
      maxConcurrency: 4,
      baseBranch: "develop",
    });

    assert.equal(started.version, SWARM_DRAFT_VERSION);
    assert.equal(started.version, 2);
    assert.equal(isDraftActive(started), true);

    const rehydrated1 = rehydrateDraft(ctx);
    assert.ok(rehydrated1);
    assert.equal(rehydrated1.version, 2);
    assert.equal(rehydrated1.seed, "Build dynamic multi-agent runner");
    assert.equal(rehydrated1.baseBranch, "develop");
    assert.equal(rehydrated1.maxConcurrency, 4);
    assert.equal(rehydrated1.validatorEnabled, true);
    assert.equal(rehydrated1.autoConfirm, undefined);

    // Update with questionnaireEcho + toggled validatorEnabled & autoConfirm
    const updated = updateDraft(harness.api, rehydrated1, {
      validatorEnabled: false,
      maxConcurrency: 6,
      questionnaireEcho: { q1: "Use SQLite" },
    });
    assert.equal(updated.validatorEnabled, false);
    assert.equal(updated.maxConcurrency, 6);
    assert.deepEqual(updated.questionnaireEcho, { q1: "Use SQLite" });

    // Second update merges questionnaireEcho without dropping q1
    updateDraft(harness.api, updated, {
      questionnaireEcho: { q2: "Dynamic board waves" },
    });

    const rehydrated2 = rehydrateDraft(ctx);
    assert.ok(rehydrated2);
    assert.equal(rehydrated2.validatorEnabled, false);
    assert.equal(rehydrated2.maxConcurrency, 6);
    assert.deepEqual(rehydrated2.questionnaireEcho, {
      q1: "Use SQLite",
      q2: "Dynamic board waves",
    });

    // Mutating returned object does not mutate underlying session entry
    rehydrated2.questionnaireEcho!.q1 = "mutated";
    assert.equal(rehydrateDraft(ctx)?.questionnaireEcho?.q1, "Use SQLite");
  });

  it("initializes validatorEnabled and maxConcurrency from options -> settings -> defaults", () => {
    const harness = new MockPiHarness();
    const ctx = harness.createContext();

    // From settings when omitted in options
    const fromSettings = startDraft(
      harness.api,
      {
        mode: "swarm",
        seed: "Settings fallback",
      },
      { settings: { validatorEnabled: false, maxConcurrency: 5 } },
    );
    assert.equal(fromSettings.validatorEnabled, false);
    assert.equal(fromSettings.maxConcurrency, 5);
    assert.equal(rehydrateDraft(ctx)?.validatorEnabled, false);
    assert.equal(rehydrateDraft(ctx)?.maxConcurrency, 5);

    // Explicit options override settings
    const fromOption = startDraft(
      harness.api,
      {
        mode: "swarm",
        seed: "Explicit override",
        validatorEnabled: true,
        maxConcurrency: 3,
      },
      { settings: { validatorEnabled: false, maxConcurrency: 5 } },
    );
    assert.equal(fromOption.validatorEnabled, true);
    assert.equal(fromOption.maxConcurrency, 3);
    assert.equal(rehydrateDraft(ctx)?.validatorEnabled, true);
    assert.equal(rehydrateDraft(ctx)?.maxConcurrency, 3);

    // Defaults when both options & settings omit values
    const fromDefault = startDraft(harness.api, {
      seed: "Default fallback",
    });
    assert.equal(fromDefault.validatorEnabled, DEFAULT_SWARM_SETTINGS.validatorEnabled);
    assert.equal(fromDefault.maxConcurrency, DEFAULT_SWARM_SETTINGS.maxConcurrency);
  });

  it("rejects legacy version: 1 entries and malformed draft entries during rehydration", () => {
    const harness = new MockPiHarness();
    const ctx = harness.createContext();

    harness.api.appendEntry(SWARM_DRAFT_ENTRY, {
      version: 1,
      mode: "swarm",
      seed: "Legacy v1 draft",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 3,
    });
    assert.equal(rehydrateDraft(ctx), null);

    // Malformed entry (wrong autoConfirm type)
    harness.api.appendEntry(SWARM_DRAFT_ENTRY, {
      version: 2,
      mode: "swarm",
      seed: "Bad autoConfirm",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 3,
      autoConfirm: "yes",
    });
    assert.equal(rehydrateDraft(ctx), null);
  });

  it("rehydrates autoConfirm, survives compaction entries, and respects clearedAt tombstones", () => {
    const harness = new MockPiHarness();
    const ctx = harness.createContext();

    const draft = startDraft(harness.api, {
      mode: "swarm",
      seed: "Refactor storage layer",
      validatorEnabled: true,
      maxConcurrency: 3,
      autoConfirm: true,
    });
    assert.equal(draft.autoConfirm, true);

    // Simulate Pi auto-compaction occurring mid-draft
    harness.appendCompactionEntry("Compacted prior turns");

    const afterCompact = rehydrateDraft(ctx);
    assert.ok(afterCompact);
    assert.equal(afterCompact.version, 2);
    assert.equal(afterCompact.seed, "Refactor storage layer");
    assert.equal(afterCompact.autoConfirm, true);

    // Clear draft -> appends clearedAt tombstone
    const tombstone = clearDraft(harness.api, afterCompact, "idle");
    assert.ok(tombstone.clearedAt);
    assert.equal(isDraftActive(tombstone), false);

    // Scanning backwards stops at tombstone even though older active entry exists
    assert.equal(rehydrateDraft(ctx), null);

    // Another compaction after tombstone still stays tombstoned
    harness.appendCompactionEntry("Second compaction");
    assert.equal(rehydrateDraft(ctx), null);

    // Starting a brand-new tweak draft after tombstone works cleanly
    startDraft(harness.api, {
      mode: "tweak",
      seed: "Expand validator checks",
      targetRunId: "run-42",
      validatorEnabled: false,
      maxConcurrency: 2,
    });

    const fresh = rehydrateDraft(ctx);
    assert.ok(fresh);
    assert.equal(fresh.version, 2);
    assert.equal(fresh.mode, "tweak");
    assert.equal(fresh.targetRunId, "run-42");
    assert.equal(fresh.seed, "Expand validator checks");
    assert.equal(fresh.autoConfirm, undefined);
    assert.notEqual(fresh.seed, draft.seed);
  });

  it("is strictly branch-local when inspecting alternate session tree branches", () => {
    const harness = new MockPiHarness();
    startDraft(harness.api, {
      mode: "swarm",
      seed: "Branch A draft",
      validatorEnabled: true,
      maxConcurrency: 3,
    });

    const snapshotBeforeClear = [...harness.branchEntries];
    clearDraft(harness.api, rehydrateDraft(harness.createContext()), "idle");

    // Current branch (after clear) has no active draft
    assert.equal(rehydrateDraft(harness.createContext()), null);

    // Alternate branch (prior to clear) still sees Branch A draft
    const altBranchCtx = harness.createContext({ branch: snapshotBeforeClear });
    const altDraft = rehydrateDraft(altBranchCtx);
    assert.ok(altDraft);
    assert.equal(altDraft.version, 2);
    assert.equal(altDraft.seed, "Branch A draft");
  });
});

// ============================================================================
// 2. Idempotent Tool-Profile Swap Tests (7 Extension Tools)
// ============================================================================

describe("draft-state: applySwarmToolProfile idempotency across 7 tools", () => {
  it("deletes ONLY the 7 ALL_SWARM_EXTENSION_TOOLS, preserves host/3rd-party tools, swaps cleanly across idle/drafting/running, and skips no-op writes", () => {
    assert.equal(ALL_SWARM_EXTENSION_TOOLS.length, 7);
    assert.equal(SWARM_CORE_TOOLS.length, 4);
    assert.equal(DRAFTING_TOOLS.length, 3);
    assert.deepEqual(IDLE_SWARM_TOOLS, [SWARM_TOOL]);
    assert.deepEqual(IDLE_SWARM_TOOLS, CONSTANTS_IDLE_SWARM_TOOLS);
    assert.deepEqual(getSwarmToolsForMode("idle"), [SWARM_TOOL]);
    assert.deepEqual(getSwarmToolsForMode("drafting"), [
      SWARM_QUESTION_TOOL,
      SWARM_QUESTIONNAIRE_TOOL,
      PROPOSE_SWARM_PLAN_TOOL,
    ]);
    assert.deepEqual(getSwarmToolsForMode("running"), [
      SWARM_TOOL,
      POST_MESSAGE_TOOL,
      READ_BOARD_TOOL,
      SWARM_WAIT_TOOL,
    ]);

    const hostAndThirdParty = [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "custom_mcp_query",
    ];
    const harness = new MockPiHarness([...hostAndThirdParty, SWARM_TOOL]);

    // Already in "idle" profile -> MUST NOT call setActiveTools
    assert.equal(applySwarmToolProfile(harness.api, "idle"), false);
    assert.equal(harness.setActiveToolsCalls.length, 0);

    // Swap to "drafting" -> removes swarm, adds 3 drafting tools, preserves all host/3rd-party tools
    assert.equal(applySwarmToolProfile(harness.api, "drafting"), true);
    assert.equal(harness.setActiveToolsCalls.length, 1);
    for (const tool of hostAndThirdParty) {
      assert.ok(harness.activeTools.includes(tool), `must keep host tool ${tool}`);
    }
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(harness.activeTools.includes(tool), `must activate drafting tool ${tool}`);
    }
    for (const tool of SWARM_CORE_TOOLS) {
      assert.ok(!harness.activeTools.includes(tool), `must hide core tool ${tool} during drafting`);
    }

    // Calling "drafting" again -> NO-OP (prompt-cache safe)
    assert.equal(applySwarmToolProfile(harness.api, "drafting"), false);
    assert.equal(harness.setActiveToolsCalls.length, 1);

    // Reordering active tools does not trigger unnecessary setActiveTools
    harness.activeTools.reverse();
    assert.equal(applySwarmToolProfile(harness.api, "drafting"), false);
    assert.equal(harness.setActiveToolsCalls.length, 1);

    // Swap to "running" -> removes 3 drafting tools, adds 4 SWARM_CORE_TOOLS
    assert.equal(applySwarmToolProfile(harness.api, "running"), true);
    assert.equal(harness.setActiveToolsCalls.length, 2);
    for (const tool of hostAndThirdParty) {
      assert.ok(harness.activeTools.includes(tool));
    }
    for (const tool of SWARM_CORE_TOOLS) {
      assert.ok(
        harness.activeTools.includes(tool),
        `running profile must include core tool ${tool}`,
      );
    }
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(!harness.activeTools.includes(tool));
    }
    const activeRunningSwarmTools = harness.activeTools.filter((t) =>
      (ALL_SWARM_EXTENSION_TOOLS as readonly string[]).includes(t),
    );
    assert.equal(activeRunningSwarmTools.length, 4);

    // Calling "running" again -> NO-OP
    assert.equal(applySwarmToolProfile(harness.api, "running"), false);
    assert.equal(harness.setActiveToolsCalls.length, 2);

    // Swap back to "idle" -> ONLY `swarm` among ALL_SWARM_EXTENSION_TOOLS
    assert.equal(applySwarmToolProfile(harness.api, "idle"), true);
    assert.equal(harness.setActiveToolsCalls.length, 3);
    const activeIdleSwarmTools = harness.activeTools.filter((t) =>
      (ALL_SWARM_EXTENSION_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(activeIdleSwarmTools, [SWARM_TOOL]);
    assert.ok(!harness.activeTools.includes(POST_MESSAGE_TOOL));
    assert.ok(!harness.activeTools.includes(READ_BOARD_TOOL));
    assert.ok(!harness.activeTools.includes(SWARM_WAIT_TOOL));
    for (const tool of hostAndThirdParty) {
      assert.ok(harness.activeTools.includes(tool));
    }
  });

  it("DraftStateController.rehydrate syncs tool profiles accurately for drafting, running, and idle", () => {
    const harness = new MockPiHarness();
    const controller = new DraftStateController(harness.api);
    const ctx = harness.createContext();

    harness.api.appendEntry(SWARM_DRAFT_ENTRY, {
      version: 2,
      mode: "swarm",
      seed: "Rehydrate sync",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 4,
    });

    const rehydrated = controller.rehydrate(ctx, { syncToolProfile: true });
    assert.ok(rehydrated);
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(harness.activeTools.includes(tool));
    }
    assert.ok(!harness.activeTools.includes(SWARM_TOOL));

    controller.clear();
    controller.rehydrate(ctx, { syncToolProfile: true, hasActiveRun: true });
    for (const tool of SWARM_CORE_TOOLS) {
      assert.ok(harness.activeTools.includes(tool));
    }
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(!harness.activeTools.includes(tool));
    }

    controller.rehydrate(ctx, { syncToolProfile: true, hasActiveRun: false });
    const activeSwarm = harness.activeTools.filter((t) =>
      (ALL_SWARM_EXTENSION_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(activeSwarm, [SWARM_TOOL]);
  });
});

// ============================================================================
// 3. Existing Draft Conflict Dialog (Resume / Replace / Cancel) + Modal Hooks
// ============================================================================

describe("draft-state: startOrResolveDraft conflict handling", () => {
  it("handles Resume, Replace, Cancel, headless cancel, and balanced modal depth hooks", async () => {
    const harness = new MockPiHarness();
    let modalDepth = 0;
    let maxDepth = 0;
    const hooks = {
      onModalEnter: () => {
        modalDepth += 1;
        maxDepth = Math.max(maxDepth, modalDepth);
      },
      onModalExit: () => {
        modalDepth -= 1;
      },
    };

    const existing = startDraft(harness.api, {
      seed: "Existing goal",
      validatorEnabled: true,
      maxConcurrency: 3,
    });

    // Headless context (hasUI: false) cancels without invoking modal
    const headlessCtx = harness.createContext({ hasUI: false });
    const headless = await startOrResolveDraft(
      harness.api,
      headlessCtx,
      existing,
      { seed: "New goal", validatorEnabled: false, maxConcurrency: 2 },
      hooks,
    );
    assert.equal(headless.action, "cancelled");
    assert.equal(maxDepth, 0);

    // Resume
    const resumeCtx = harness.createContext({
      selectResult: "Resume — continue the active draft",
    });
    const resumed = await startOrResolveDraft(
      harness.api,
      resumeCtx,
      existing,
      { seed: "New goal", validatorEnabled: false, maxConcurrency: 2 },
      hooks,
    );
    assert.equal(resumed.action, "resumed");
    assert.equal(resumed.draft?.seed, "Existing goal");
    assert.equal(modalDepth, 0);
    assert.equal(maxDepth, 1);

    // Cancel (Esc returns undefined)
    const cancelCtx = harness.createContext({ selectResult: undefined });
    const cancelled = await startOrResolveDraft(
      harness.api,
      cancelCtx,
      existing,
      { seed: "New goal", validatorEnabled: false, maxConcurrency: 2 },
      hooks,
    );
    assert.equal(cancelled.action, "cancelled");
    assert.equal(cancelled.draft?.seed, "Existing goal");
    assert.equal(modalDepth, 0);

    // Replace
    const replaceCtx = harness.createContext({
      selectResult: "Replace — discard active draft and start fresh",
    });
    const replaced = await startOrResolveDraft(
      harness.api,
      replaceCtx,
      existing,
      { seed: "Replacement goal", validatorEnabled: false, maxConcurrency: 5 },
      hooks,
    );
    assert.equal(replaced.action, "replaced");
    assert.equal(replaced.draft?.seed, "Replacement goal");
    assert.equal(replaced.draft?.maxConcurrency, 5);
    assert.equal(rehydrateDraft(replaceCtx)?.seed, "Replacement goal");
    assert.equal(modalDepth, 0);

    // Modal exit still fires even if ui.select throws
    const throwingCtx = harness.createContext({
      selectThrows: new Error("dialog crashed"),
    });
    await assert.rejects(
      () =>
        startOrResolveDraft(
          harness.api,
          throwingCtx,
          replaced.draft,
          { seed: "Another", validatorEnabled: true, maxConcurrency: 2 },
          hooks,
        ),
      /dialog crashed/,
    );
    assert.equal(modalDepth, 0);
  });
});

// ============================================================================
// 4. Drafting Tools: swarm_question & swarm_questionnaire
// ============================================================================

describe("draft-tools: swarm_question & swarm_questionnaire", () => {
  it("persists question and questionnaire answers into draft.questionnaireEcho and handles cancellation/errors gracefully", async () => {
    const harness = new MockPiHarness();
    const modalEvents: string[] = [];
    const draftChanges: Array<SwarmDraftState | null> = [];
    let nextQuestionResp: { cancelled: boolean; answer?: string; isCustom: boolean } = {
      cancelled: false,
      answer: "PostgreSQL",
      isCustom: false,
    };
    let nextQuestionnaireResp: QuestionnaireResult = {
      cancelled: false,
      answers: {
        auth: "OAuth2 PKCE",
        tests: "node:test + typecheck",
      },
      items: [
        {
          id: "auth",
          question: "Which auth flow?",
          answer: "OAuth2 PKCE",
          isCustom: false,
        },
        {
          id: "tests",
          question: "What verification gate?",
          answer: "node:test + typecheck",
          isCustom: true,
        },
      ],
    };

    const receivedSpecs: QuestionSpec[] = [];
    const ui: IQuestionnaireUI = {
      askQuestion: async (_ctx, spec) => {
        receivedSpecs.push(spec);
        return nextQuestionResp;
      },
      askQuestionnaire: async (_ctx, specs) => {
        receivedSpecs.push(...specs);
        return nextQuestionnaireResp;
      },
      confirmProposal: async () => ({
        action: "cancel",
        validatorEnabled: true,
        maxConcurrency: 3,
      }),
    };

    const deps: DraftingDeps = {
      worktree: createMockWorktree(),
      ui,
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
      onModalEnter: () => modalEvents.push("enter"),
      onModalExit: () => modalEvents.push("exit"),
      onDraftChanged: (draft) => draftChanges.push(draft),
    };

    const controller = registerDraftingTools(harness.api, deps);
    assert.ok(harness.registeredTools.has(SWARM_QUESTION_TOOL));
    assert.ok(harness.registeredTools.has(SWARM_QUESTIONNAIRE_TOOL));
    assert.ok(harness.registeredTools.has(PROPOSE_SWARM_PLAN_TOOL));

    controller.start({
      seed: "Build auth + DB",
      validatorEnabled: true,
      maxConcurrency: 3,
    });

    const ctx = harness.createContext();
    const questionTool = harness.registeredTools.get(SWARM_QUESTION_TOOL);
    const questionnaireTool = harness.registeredTools.get(SWARM_QUESTIONNAIRE_TOOL);

    // Empty question returns isError
    const emptyQ = await questionTool.execute(
      "tc-0",
      { question: "   " },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(emptyQ.isError, true);

    // prepareArguments normalizes string options
    const prepared = questionTool.prepareArguments({
      id: "db",
      question: "Which database engine?",
      options: ["PostgreSQL", "SQLite"],
      recommended: "PostgreSQL",
    });
    assert.deepEqual(prepared.options, [
      { label: "PostgreSQL" },
      { label: "SQLite" },
    ]);

    // Execute swarm_question
    const qResult = await questionTool.execute(
      "tc-1",
      prepared,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(qResult.isError, undefined);
    const qDetails = qResult.details as SwarmQuestionToolDetails;
    assert.equal(qDetails.cancelled, false);
    assert.equal(qDetails.answer, "PostgreSQL");
    assert.deepEqual(controller.getDraft()?.questionnaireEcho, {
      db: "PostgreSQL",
    });
    assert.deepEqual(rehydrateDraft(ctx)?.questionnaireEcho, {
      db: "PostgreSQL",
    });

    const theme = createMockTheme();
    assert.match(
      questionTool.renderCall(prepared, theme, {} as any).render(100).join("\n"),
      /swarm_question/,
    );

    // Execute swarm_question with user dismissal -> non-error, echo unchanged
    nextQuestionResp = { cancelled: true, isCustom: false };
    const cancelledQ = await questionTool.execute(
      "tc-2",
      { id: "cache", question: "Add Redis?" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(cancelledQ.isError, undefined);
    assert.equal((cancelledQ.details as SwarmQuestionToolDetails).cancelled, true);
    assert.deepEqual(rehydrateDraft(ctx)?.questionnaireEcho, {
      db: "PostgreSQL",
    });

    // Execute swarm_questionnaire -> merges answers with prior echo
    const qnArgs = {
      questions: [
        {
          id: "auth",
          question: "Which auth flow?",
          options: [{ label: "OAuth2 PKCE" }, { label: "API Key" }],
          recommended: "OAuth2 PKCE",
        },
        {
          id: "tests",
          question: "What verification gate?",
          options: [{ label: "Unit only" }, { label: "Unit + integration" }],
        },
      ],
    };
    const qnResult = await questionnaireTool.execute(
      "tc-3",
      qnArgs,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(qnResult.isError, undefined);
    const qnDetails = qnResult.details as SwarmQuestionnaireToolDetails;
    assert.equal(qnDetails.cancelled, false);
    assert.match(qnResult.content[0].text, /OAuth2 PKCE/);
    assert.match(qnResult.content[0].text, /node:test \+ typecheck \(custom\)/);
    assert.deepEqual(rehydrateDraft(ctx)?.questionnaireEcho, {
      db: "PostgreSQL",
      auth: "OAuth2 PKCE",
      tests: "node:test + typecheck",
    });
    assert.match(
      questionnaireTool.renderCall(qnArgs, theme, {} as any).render(100).join("\n"),
      /swarm_questionnaire/,
    );

    // Execute swarm_questionnaire with cancellation -> graceful non-error
    nextQuestionnaireResp = { cancelled: true, answers: {}, items: [] };
    const cancelledQn = await questionnaireTool.execute(
      "tc-4",
      {
        questions: [
          {
            id: "deploy",
            question: "Target runtime?",
            options: [{ label: "Node 22" }],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(cancelledQn.isError, undefined);
    assert.equal(
      (cancelledQn.details as SwarmQuestionnaireToolDetails).cancelled,
      true,
    );

    // Reject empty questions list
    const emptyQn = await questionnaireTool.execute(
      "tc-5",
      { questions: [] },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(emptyQn.isError, true);

    // Verify modal hooks were paired cleanly for all 4 UI invocations
    assert.deepEqual(modalEvents, [
      "enter",
      "exit",
      "enter",
      "exit",
      "enter",
      "exit",
      "enter",
      "exit",
    ]);
    assert.equal(draftChanges.length, 2);
  });
});

// ============================================================================
// 5. Drafting Tool: propose_swarm_plan (Dynamic Antigravity Swarm)
// ============================================================================

describe("draft-tools: propose_swarm_plan", () => {
  it("registers all 3 drafting tools with sequential executionMode, model-only exposure, defaultActive: false, and Google-compatible schemas (zero anyOf)", () => {
    const harness = new MockPiHarness();
    const { tools } = createDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "cancel",
          validatorEnabled: true,
          maxConcurrency: 3,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    assert.equal(tools.length, 3);
    for (const tool of tools) {
      assert.equal(tool.executionMode, "sequential");
      assert.equal(tool.defaultActive, false);
      assert.equal(tool.exposure, "model-only");
      const schemaJson = JSON.stringify(tool.parameters);
      assert.ok(
        !schemaJson.includes('"anyOf"'),
        `${tool.name} schema must not contain anyOf for Google API`,
      );
      assert.ok(
        !schemaJson.includes('"oneOf"'),
        `${tool.name} schema must not contain oneOf for Google API`,
      );
    }

    const propose = tools.find((t) => t.name === PROPOSE_SWARM_PLAN_TOOL)!;
    assert.equal(propose.label, "Swarm Plan");
    const proposeJson = JSON.stringify(propose.parameters);
    assert.ok(proposeJson.includes('"title"'));
    assert.ok(proposeJson.includes('"objective"'));
    assert.ok(proposeJson.includes('"strategy"'));
    assert.ok(proposeJson.includes('"acceptance_criteria"'));
    assert.ok(proposeJson.includes('"base_branch"'));
    assert.ok(proposeJson.includes('"max_concurrency"'));
    assert.ok(proposeJson.includes('"type":"integer"'));
    assert.ok(proposeJson.includes('"validator_enabled"'));
    assert.ok(proposeJson.includes('"initial_members"'));
    assert.ok(proposeJson.includes('"enum":["worker","validator"]'));
    assert.ok(proposeJson.includes('"enum":["inherit","share","branch"]'));
    assert.ok(proposeJson.includes('"channels"'));
    // Rigid Mission DAG fields must be gone
    assert.ok(!proposeJson.includes('"missions"'));
    assert.ok(!proposeJson.includes('"verification_contract"'));
    assert.ok(!proposeJson.includes('"final_validator_enabled"'));
  });

  it("validates required fields and initial_members (invalid pattern, reserved names, duplicates, bad channels) BEFORE opening confirmProposal", async () => {
    const harness = new MockPiHarness();
    let confirmCalls = 0;
    let planConfirmedCalls = 0;

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => {
          confirmCalls++;
          return { action: "confirm", validatorEnabled: true, maxConcurrency: 3 };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        planConfirmedCalls++;
        return createMockRun(plan);
      },
    });

    controller.start({
      seed: "Validation test",
      validatorEnabled: true,
      maxConcurrency: 4,
    });

    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // 1. Empty required fields
    const emptyRes = await proposeTool.execute(
      "tc-empty",
      {
        title: "   ",
        objective: "",
        strategy: " ",
        acceptance_criteria: "",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(emptyRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.equal(planConfirmedCalls, 0);
    assert.match(emptyRes.content[0].text, /\[SwarmProtocolError:INVALID_INPUT\]/);
    const emptyDetails = emptyRes.details as ProposeSwarmPlanToolDetails;
    assert.equal(emptyDetails.outcome, "validation_error");
    assert.equal(emptyDetails.errors?.length, 4);

    // 2. Invalid member name pattern (uppercase / underscore / leading digit / spaces)
    const badNameRes = await proposeTool.execute(
      "tc-bad-name",
      makeSamplePlanParams({
        initial_members: [
          { name: "Bad_Name", role: "worker", brief: "Invalid uppercase/underscore" },
          { name: "9worker", role: "worker", brief: "Starts with digit" },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(badNameRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(badNameRes.content[0].text, /\[SwarmProtocolError:INVALID_NAME\]/);
    assert.match(badNameRes.content[0].text, /Bad_Name/);
    assert.match(badNameRes.content[0].text, /9worker/);

    // 3. Reserved member names (every entry in RESERVED_MEMBER_NAMES)
    for (const reserved of RESERVED_MEMBER_NAMES) {
      const reservedRes = await proposeTool.execute(
        `tc-reserved-${reserved}`,
        makeSamplePlanParams({
          initial_members: [
            { name: reserved, role: "worker", brief: "Attempting reserved name" },
          ],
        }),
        undefined,
        undefined,
        ctx,
      );
      assert.equal(reservedRes.isError, true, `reserved name "${reserved}" must fail`);
      assert.equal(confirmCalls, 0);
      assert.match(reservedRes.content[0].text, /\[SwarmProtocolError:INVALID_NAME\]/);
      assert.match(reservedRes.content[0].text, /reserved/i);
    }

    // 4. Duplicate initial member names
    const dupRes = await proposeTool.execute(
      "tc-dup",
      makeSamplePlanParams({
        initial_members: [
          { name: "scout", role: "worker", brief: "First scout" },
          { name: "scout", role: "validator", brief: "Duplicate scout" },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(dupRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(dupRes.content[0].text, /\[SwarmProtocolError:DUPLICATE_MEMBER\]/);
    assert.match(dupRes.content[0].text, /Duplicate initial member name "scout"/);

    // 5. Invalid channel name & empty brief
    const badChannelRes = await proposeTool.execute(
      "tc-bad-ch",
      makeSamplePlanParams({
        initial_members: [
          {
            name: "parser",
            role: "worker",
            brief: "  ",
            channels: ["Valid_Bad"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(badChannelRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(badChannelRes.content[0].text, /\[SwarmProtocolError:INVALID_CHANNEL\]/);
    assert.match(badChannelRes.content[0].text, /\[SwarmProtocolError:INVALID_INPUT\]/);

    // Draft stays active after validation failures so Orchestrator can fix and retry
    assert.equal(controller.isActive(), true);
    assert.equal(planConfirmedCalls, 0);

    // Direct helper test on valid input without initial_members
    const validNoMembers = validateProposedSwarmPlan(
      makeSamplePlanParams({ initial_members: undefined }),
    );
    assert.equal(validNoMembers.valid, true);
    if (validNoMembers.valid) {
      assert.equal(validNoMembers.initialMembers, undefined);
    }
  });

  it("derives 3-role roleModels via buildRoleModelsFromSettings and attaches them to ProposedSwarmPlan", async () => {
    const customSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      orchestratorModel: "anthropic/claude-opus-4",
      orchestratorThinkingLevel: "high",
      workerModel: "anthropic/claude-sonnet-4",
      workerThinkingLevel: "medium",
      validatorModel: "openai/gpt-5",
      validatorThinkingLevel: "low",
      fallbackModels: ["google/gemini-2.5-pro", "  openai/gpt-4.1  "],
    };

    const derived = buildRoleModelsFromSettings(customSettings);
    assert.deepEqual(derived, {
      orchestrator: { model: "anthropic/claude-opus-4", thinkingLevel: "high" },
      worker: { model: "anthropic/claude-sonnet-4", thinkingLevel: "medium" },
      validator: { model: "openai/gpt-5", thinkingLevel: "low" },
      fallbackModels: ["google/gemini-2.5-pro", "openai/gpt-4.1"],
    });

    const harness = new MockPiHarness();
    const seenPlans: ProposedSwarmPlan[] = [];
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          seenPlans.push(plan);
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
      getSettings: () => customSettings,
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({
      seed: "3-role model propagation",
      validatorEnabled: true,
      maxConcurrency: 4,
    });

    const res = await harness.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute(
        "tc-models",
        makeSamplePlanParams(),
        undefined,
        undefined,
        harness.createContext(),
      );

    assert.equal(res.isError, undefined);
    assert.deepEqual(seenPlans[0]?.roleModels, derived);
    assert.deepEqual(confirmedPlans[0]?.roleModels, derived);
    assert.match(
      res.content[0].text,
      /\*\*Models:\*\* Orchestrator: anthropic\/claude-opus-4 \(high\) \| Worker: anthropic\/claude-sonnet-4 \(medium\) \| Validator: openai\/gpt-5 \(low\)/,
    );
    assert.match(
      res.content[0].text,
      /\*\*Fallbacks:\*\* google\/gemini-2\.5-pro, openai\/gpt-4\.1/,
    );
  });

  it("confirm calls onPlanConfirmed with toggled settings, clears draft, swaps tool profile to the 4 SWARM_CORE_TOOLS, and returns terminate: true", async () => {
    const harness = new MockPiHarness();
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ currentBranch: "release/v2" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "confirm",
          validatorEnabled: false,
          maxConcurrency: 5,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({
      seed: "OAuth + audit",
      validatorEnabled: true,
      maxConcurrency: 3,
    });

    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const result = await proposeTool.execute(
      "tc-confirm",
      makeSamplePlanParams(),
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.terminate, true);

    const confirmedPlan = confirmedPlans[0];
    assert.ok(confirmedPlan);
    assert.equal(confirmedPlan.title, "OAuth & Audit Rollout");
    assert.equal(confirmedPlan.baseBranch, "release/v2");
    assert.equal(confirmedPlan.validatorEnabled, false);
    assert.equal(confirmedPlan.maxConcurrency, 5);
    assert.equal(confirmedPlan.initialMembers?.length, 3);
    assert.ok(confirmedPlan.roleModels);

    // Draft cleared with tombstone and tool profile swapped to `"running"` (the 4 SWARM_CORE_TOOLS)
    assert.equal(controller.isActive(), false);
    assert.equal(rehydrateDraft(ctx), null);
    for (const tool of SWARM_CORE_TOOLS) {
      assert.ok(harness.activeTools.includes(tool), `must activate core tool ${tool}`);
    }
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(!harness.activeTools.includes(tool), `must hide drafting tool ${tool}`);
    }
    assert.ok(harness.activeTools.includes("read"));
    assert.ok(harness.activeTools.includes("other_ext_tool"));

    const details = result.details as ProposeSwarmPlanToolDetails;
    assert.equal(details.outcome, "confirmed");
    assert.equal(details.runId, "run-20261120-dyn");
    assert.equal(details.plan?.validatorEnabled, false);
    assert.equal(details.plan?.maxConcurrency, 5);
    assert.match(result.content[0].text, /## Swarm Plan Proposal: OAuth & Audit Rollout/);
    assert.match(result.content[0].text, /\*\*Validator Policy:\*\* OFF/);
    assert.match(result.content[0].text, /CONFIRMED/);
  });

  it("continue keeps draft active, persists toggled validatorEnabled & maxConcurrency, and carries them into the next proposal round", async () => {
    const harness = new MockPiHarness();
    let onPlanConfirmedCalled = false;
    let dialogRound = 0;
    const seenPlans: ProposedSwarmPlan[] = [];
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          dialogRound++;
          seenPlans.push(plan);
          if (dialogRound === 1) {
            return {
              action: "continue",
              validatorEnabled: false,
              maxConcurrency: 2,
              feedback: "Start with a single scout first before spawning oauth-dev",
            };
          }
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS, maxConcurrency: 6 }),
      onPlanConfirmed: async (plan) => {
        onPlanConfirmedCalled = true;
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({
      seed: "OAuth + audit",
      validatorEnabled: true,
      maxConcurrency: 4,
    });

    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // Round 1 -> user toggles validator OFF, concurrency 2, chooses continue
    const res1 = await proposeTool.execute(
      "tc-refine-1",
      makeSamplePlanParams(),
      undefined,
      undefined,
      ctx,
    );

    assert.equal(seenPlans[0]?.validatorEnabled, true);
    assert.equal(seenPlans[0]?.maxConcurrency, 4);
    assert.equal(res1.isError, undefined);
    assert.equal(res1.terminate, undefined);
    assert.equal(onPlanConfirmedCalled, false);
    assert.equal(controller.isActive(), true);
    assert.equal(controller.getDraft()?.validatorEnabled, false);
    assert.equal(controller.getDraft()?.maxConcurrency, 2);

    // Persisted in branch-local entry too
    const rehydrated = rehydrateDraft(ctx);
    assert.ok(rehydrated);
    assert.equal(rehydrated.validatorEnabled, false);
    assert.equal(rehydrated.maxConcurrency, 2);

    const details1 = res1.details as ProposeSwarmPlanToolDetails;
    assert.equal(details1.outcome, "continue");
    assert.equal(details1.plan?.validatorEnabled, false);
    assert.equal(details1.plan?.maxConcurrency, 2);
    assert.match(res1.content[0].text, /CONTINUE REFINING/);
    assert.match(
      res1.content[0].text,
      /Start with a single scout first before spawning oauth-dev/,
    );

    // Round 2 -> model omits validator_enabled & max_concurrency; inherits persisted toggled values
    const res2 = await proposeTool.execute(
      "tc-refine-2",
      makeSamplePlanParams({ initial_members: undefined }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(seenPlans[1]?.validatorEnabled, false);
    assert.equal(seenPlans[1]?.maxConcurrency, 2);
    assert.equal(confirmedPlans[0]?.validatorEnabled, false);
    assert.equal(confirmedPlans[0]?.maxConcurrency, 2);
    assert.equal(res2.terminate, true);
    assert.equal(onPlanConfirmedCalled, true);
  });

  it("cancel tombstones draft, restores idle tool profile (swarm only), and returns terminate: true", async () => {
    const harness = new MockPiHarness();
    let onPlanConfirmedCalled = false;

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "cancel",
          validatorEnabled: true,
          maxConcurrency: 3,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        onPlanConfirmedCalled = true;
        return createMockRun(plan);
      },
    });

    controller.start({
      seed: "Discardable plan",
      validatorEnabled: true,
      maxConcurrency: 3,
    });

    const ctx = harness.createContext();
    const res = await harness.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute("tc-cancel", makeSamplePlanParams(), undefined, undefined, ctx);

    assert.equal(res.isError, undefined);
    assert.equal(res.terminate, true);
    assert.equal(onPlanConfirmedCalled, false);
    assert.equal(controller.isActive(), false);
    assert.equal(rehydrateDraft(ctx), null);

    // Tool profile restored to idle (ONLY `swarm` among ALL_SWARM_EXTENSION_TOOLS)
    const activeSwarm = harness.activeTools.filter((t) =>
      (ALL_SWARM_EXTENSION_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(activeSwarm, [SWARM_TOOL]);
    assert.match(res.content[0].text, /CANCELLED/);
    assert.match(res.content[0].text, /Swarm Plan Proposal/);
  });

  it("supports /swarm direct autoConfirm without opening confirmation modal (while still running pre-modal validation)", async () => {
    const harness = new MockPiHarness();
    let confirmCalls = 0;
    let modalHooksCalled = 0;
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ getCurrentBranchThrows: true }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => {
          confirmCalls++;
          return { action: "cancel", validatorEnabled: true, maxConcurrency: 3 };
        },
      },
      getSettings: () => ({
        ...DEFAULT_SWARM_SETTINGS,
        workerModel: "anthropic/claude-sonnet-4",
      }),
      onModalEnter: () => {
        modalHooksCalled++;
      },
      onModalExit: () => {
        modalHooksCalled++;
      },
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({
      seed: "Direct launch goal",
      validatorEnabled: true,
      maxConcurrency: 4,
      autoConfirm: true,
    });

    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // Invalid initial_members still rejected even under autoConfirm
    const invalidRes = await proposeTool.execute(
      "tc-direct-invalid",
      makeSamplePlanParams({
        initial_members: [
          { name: "monitor", role: "validator", brief: "Reserved monitor name" },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(invalidRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.equal(confirmedPlans.length, 0);
    assert.match(invalidRes.content[0].text, /\[SwarmProtocolError:INVALID_NAME\]/);

    // Valid plan launches immediately with baseBranch fallback to "main"
    const res = await proposeTool.execute(
      "tc-direct-ok",
      makeSamplePlanParams(),
      undefined,
      undefined,
      ctx,
    );

    assert.equal(res.isError, undefined);
    assert.equal(confirmCalls, 0, "autoConfirm must bypass confirmation modal");
    assert.equal(modalHooksCalled, 0, "autoConfirm must not trigger modal guards");
    assert.equal(res.terminate, true);
    assert.equal(confirmedPlans.length, 1);
    assert.equal(confirmedPlans[0]?.baseBranch, "main");
    assert.equal(
      confirmedPlans[0]?.roleModels?.worker?.model,
      "anthropic/claude-sonnet-4",
    );
    assert.equal((res.details as ProposeSwarmPlanToolDetails).autoConfirmed, true);
    assert.equal(rehydrateDraft(ctx), null);
    for (const tool of SWARM_CORE_TOOLS) {
      assert.ok(harness.activeTools.includes(tool));
    }
  });

  it("preserves draft and returns isError with [SwarmProtocolError:...] when onPlanConfirmed throws", async () => {
    const harness = new MockPiHarness();
    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "confirm",
          validatorEnabled: true,
          maxConcurrency: 3,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async () => {
        throw new SwarmProtocolError(
          "DIRTY_BASE",
          "Working tree on main has uncommitted edits",
        );
      },
    });

    controller.start({
      seed: "Dirty repo test",
      validatorEnabled: true,
      maxConcurrency: 3,
    });

    const res = await harness.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute(
        "tc-err",
        makeSamplePlanParams(),
        undefined,
        undefined,
        harness.createContext(),
      );

    assert.equal(res.isError, true);
    assert.equal(res.terminate, undefined);
    assert.match(res.content[0].text, /\[SwarmProtocolError:DIRTY_BASE\]/);
    assert.equal(controller.isActive(), true, "draft must stay active on launch failure");
  });

  it("renderCall prints full formatted Flexible Swarm Plan & renderResult formats all outcomes cleanly", () => {
    const harness = new MockPiHarness();
    registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "confirm",
          validatorEnabled: true,
          maxConcurrency: 3,
        }),
      },
      getSettings: () => ({
        ...DEFAULT_SWARM_SETTINGS,
        orchestratorModel: "claude-opus-4",
        workerModel: "claude-sonnet-4",
        validatorModel: "gpt-5",
      }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const theme = createMockTheme();
    const rendered = proposeTool
      .renderCall(makeSamplePlanParams(), theme, {} as any)
      .render(160)
      .join("\n");

    assert.match(rendered, /Swarm Plan/);
    assert.match(rendered, /propose_swarm_plan/);
    assert.match(rendered, /\*\*Title:\*\* OAuth & Audit Rollout/);
    assert.match(rendered, /\*\*Objective:\*\* Implement OAuth2 PKCE login/);
    assert.match(rendered, /\*\*Validator Policy:\*\* ON/);
    assert.match(
      rendered,
      /\*\*Models:\*\* Orchestrator: claude-opus-4 \| Worker: claude-sonnet-4 \| Validator: gpt-5/,
    );
    assert.match(rendered, /### Dynamic Strategy/);
    assert.match(rendered, /### Acceptance Criteria/);
    assert.match(rendered, /\| Name \| Role \| Workspace \| Brief \|/);
    assert.match(rendered, /\| \*\*scout\*\* \| `worker` \| `inherit` \|/);
    assert.match(rendered, /\| \*\*oauth-dev\*\* \| `worker` \| `share` \|/);
    assert.match(rendered, /\| \*\*verifier\*\* \| `validator` \| `inherit` \|/);

    // Explicit validator_enabled: false reflected in renderCall
    const validatorOffRendered = proposeTool
      .renderCall(
        makeSamplePlanParams({ validator_enabled: false }),
        theme,
        {} as any,
      )
      .render(160)
      .join("\n");
    assert.match(validatorOffRendered, /\*\*Validator Policy:\*\* OFF/);

    // Partial/streaming args never throw
    const partialComponent = proposeTool.renderCall({} as any, theme, {} as any);
    assert.ok(partialComponent.render(80).length > 0);

    // renderResult for confirmed / direct / continue / cancelled / expanded
    const confirmedText = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Full proposal body" }],
          details: {
            outcome: "confirmed",
            runId: "run-99",
            autoConfirmed: true,
            plan: {
              title: "Goal",
              objective: "Goal objective",
              strategy: "Dynamic waves",
              acceptanceCriteria: "npm test",
              baseBranch: "main",
              maxConcurrency: 4,
              validatorEnabled: true,
            },
          },
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(120)
      .join("\n");
    assert.match(confirmedText, /Swarm Plan confirmed \(direct\)/);
    assert.match(confirmedText, /run-99/);
    assert.match(confirmedText, /Validator: ON, concurrency: 4/);

    const continueText = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Refine body" }],
          details: {
            outcome: "continue",
            plan: {
              title: "Goal",
              objective: "Goal objective",
              strategy: "Dynamic waves",
              acceptanceCriteria: "npm test",
              baseBranch: "main",
              maxConcurrency: 2,
              validatorEnabled: false,
            },
          },
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(120)
      .join("\n");
    assert.match(continueText, /Swarm Plan refinement/);
    assert.match(continueText, /Validator: OFF, concurrency: 2/);

    const cancelledText = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Cancelled body" }],
          details: { outcome: "cancelled" },
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(100)
      .join("\n");
    assert.match(cancelledText, /Swarm Plan cancelled/);

    const expandedText = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Full proposal body" }],
          details: { outcome: "confirmed", runId: "run-99" },
        },
        { expanded: true, isPartial: false },
        theme,
        {} as any,
      )
      .render(100)
      .join("\n");
    assert.match(expandedText, /Full proposal body/);
  });
});

// ============================================================================
// 6. Prompts & Transcript Summary Formatter Tests
// ============================================================================

describe("draft-prompts: prompt builders, escapeXml & formatProposalTranscriptSummary", () => {
  it("escapes XML special characters safely", () => {
    assert.equal(
      escapeXml(`<script attr="a" & 'b'>`),
      "&lt;script attr=&quot;a&quot; &amp; &apos;b&apos;&gt;",
    );
  });

  it("buildDraftingKickoffPrompt guides upfront clarification and Flexible Dynamic Swarm Plan (not rigid file-level DAG)", () => {
    const prompt = buildDraftingKickoffPrompt("Add <fast> cache & tests", "swarm", {
      baseBranch: "main",
      maxConcurrency: 6,
      validatorEnabled: true,
      roleModels: {
        orchestrator: { model: "claude-opus-4" },
        worker: { model: "claude-sonnet-4" },
        validator: { model: "gpt-5" },
      },
      existingEcho: { cache_backend: "Redis" },
    });

    assert.match(prompt, /<swarm_drafting_kickoff mode="swarm">/);
    assert.match(prompt, /Add &lt;fast&gt; cache &amp; tests/);
    assert.match(prompt, /max_concurrency="6"/);
    assert.match(prompt, /validator_enabled="true"/);
    assert.match(prompt, /Dynamic Antigravity Swarm/);
    assert.match(prompt, /Flexible Dynamic Swarm Plan/);
    assert.match(prompt, /DO NOT start editing/i);
    assert.match(prompt, /read.*grep.*find.*ls/);
    assert.match(prompt, new RegExp(SWARM_QUESTIONNAIRE_TOOL));
    assert.match(prompt, new RegExp(SWARM_QUESTION_TOOL));
    assert.match(prompt, new RegExp(PROPOSE_SWARM_PLAN_TOOL));
    assert.match(prompt, /`title`/);
    assert.match(prompt, /`objective`/);
    assert.match(prompt, /`strategy`/);
    assert.match(prompt, /`acceptance_criteria`/);
    assert.match(prompt, /`initial_members`/);
    assert.match(prompt, /NOT.*rigid pre-locked file-level DAG/i);
    assert.match(prompt, /Message Board/);
    assert.match(prompt, /Redis/);
    assert.match(prompt, /Do NOT dump the full plan/i);

    // Tweak mode includes target_run context
    const tweakPrompt = buildDraftingKickoffPrompt("Adjust concurrency", "tweak", {
      targetRun: {
        id: "run-12",
        title: "Cache Overhaul",
        objective: "Build LRU cache",
        baseBranch: "main",
        memberCount: 3,
      },
    });
    assert.match(tweakPrompt, /mode="tweak"/);
    assert.match(tweakPrompt, /<target_run id="run-12" title="Cache Overhaul"/);
  });

  it("buildDraftingSystemOverlay & buildDirectPlanPrompt generate concise structured Dynamic Swarm prompts", () => {
    const draft: SwarmDraftState = {
      version: 2,
      mode: "swarm",
      seed: "Build CLI",
      startedAt: new Date().toISOString(),
      validatorEnabled: false,
      maxConcurrency: 4,
      baseBranch: "main",
      autoConfirm: true,
      questionnaireEcho: { cli_lib: "commander" },
    };

    const overlay = buildDraftingSystemOverlay(draft);
    assert.match(overlay, /swarm_drafting_active/);
    assert.match(overlay, /validator_enabled="false"/);
    assert.match(overlay, /max_concurrency="4"/);
    assert.match(overlay, /auto_confirm="true"/);
    assert.match(overlay, /Dynamic Antigravity Swarm/);
    assert.match(overlay, /commander/);
    assert.match(overlay, new RegExp(PROPOSE_SWARM_PLAN_TOOL));

    const settings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      maxConcurrency: 5,
      validatorEnabled: true,
    };
    const directPrompt = buildDirectPlanPrompt("Migrate build scripts", "main", settings);
    assert.match(directPrompt, /swarm_direct_plan/);
    assert.match(directPrompt, /auto_confirm="true"/);
    assert.match(directPrompt, /autoConfirm: true/);
    assert.match(directPrompt, /Skip interactive Q&A/i);
    assert.match(directPrompt, /max_concurrency="5"/);
    assert.match(directPrompt, /validator_enabled="true"/);
    assert.match(directPrompt, /Flexible Dynamic Swarm Plan/);
    assert.match(directPrompt, /Migrate build scripts/);
    assert.match(directPrompt, new RegExp(PROPOSE_SWARM_PLAN_TOOL));
  });

  it("formatProposalTranscriptSummary renders Title, Objective, Base Branch, Max Concurrency, Models, Validator Policy, Dynamic Strategy, Acceptance Criteria, and optional Initial Members table", () => {
    const basePlan: ProposedSwarmPlan = {
      title: "Dynamic Swarm Engine",
      objective: "Refactor runtime to dynamic board-driven workers and validators.",
      strategy: "Wave 1: contract types. Wave 2: parallel store/drafting/runtime/ui.",
      acceptanceCriteria: "All unit tests and strict tsc pass with 0 errors.",
      baseBranch: "main",
      maxConcurrency: 6,
      validatorEnabled: true,
    };

    // Without initialMembers and without explicit roleModels
    const minimalSummary = formatProposalTranscriptSummary(basePlan);
    assert.match(minimalSummary, /## Swarm Plan Proposal: Dynamic Swarm Engine/);
    assert.match(minimalSummary, /\*\*Title:\*\* Dynamic Swarm Engine/);
    assert.match(
      minimalSummary,
      /\*\*Objective:\*\* Refactor runtime to dynamic board-driven workers and validators\./,
    );
    assert.match(
      minimalSummary,
      /\*\*Base Branch:\*\* `main` \| \*\*Max Concurrency:\*\* 6 \| \*\*Validator Policy:\*\* ON/,
    );
    assert.match(
      minimalSummary,
      /\*\*Models:\*\* Orchestrator: default \| Worker: default \| Validator: default/,
    );
    assert.match(minimalSummary, /### Dynamic Strategy/);
    assert.match(minimalSummary, /Wave 1: contract types/);
    assert.match(minimalSummary, /### Acceptance Criteria/);
    assert.match(minimalSummary, /All unit tests and strict tsc pass/);
    assert.match(minimalSummary, /Initial Members: none pre-specified/);
    assert.ok(!minimalSummary.includes("| Name | Role | Workspace | Brief |"));

    // With explicit roleModels, validator OFF, and initialMembers (including omitted workspace default & channels)
    const fullSummary = formatProposalTranscriptSummary({
      ...basePlan,
      validatorEnabled: false,
      roleModels: {
        orchestrator: { model: "claude-opus-4", thinkingLevel: "high" },
        worker: { model: "claude-sonnet-4" },
        validator: { model: "gpt-5", thinkingLevel: "medium" },
        fallbackModels: ["gemini-2.5-pro"],
      },
      initialMembers: [
        {
          name: "scout",
          role: "worker",
          brief: "Map modules | check exports",
        },
        {
          name: "builder",
          role: "worker",
          workspace: "share",
          brief: "Implement core runtime",
          channels: ["runtime", "board"],
        },
        {
          name: "auditor",
          role: "validator",
          workspace: "inherit",
          brief: "Verify diffs read-only",
        },
      ],
    });

    assert.match(fullSummary, /\*\*Validator Policy:\*\* OFF/);
    assert.match(
      fullSummary,
      /\*\*Models:\*\* Orchestrator: claude-opus-4 \(high\) \| Worker: claude-sonnet-4 \| Validator: gpt-5 \(medium\) \| \*\*Fallbacks:\*\* gemini-2\.5-pro/,
    );
    assert.match(fullSummary, /### Initial Members \(3\)/);
    assert.match(fullSummary, /\| Name \| Role \| Workspace \| Brief \|/);
    assert.match(
      fullSummary,
      /\| \*\*scout\*\* \| `worker` \| `inherit` \| Map modules \\\| check exports \|/,
    );
    assert.match(
      fullSummary,
      /\| \*\*builder\*\* \| `worker` \| `share` \| Implement core runtime _\(channels: #runtime, #board\)_ \|/,
    );
    assert.match(
      fullSummary,
      /\| \*\*auditor\*\* \| `validator` \| `inherit` \| Verify diffs read-only \|/,
    );
  });
});

// ============================================================================
// 7. v0.3.6 Audit Regression Tests (Draft Sync, Cancel, Schema, Blank Question, Prototype Keys)
// ============================================================================

describe("v0.3.6 drafting regression fixes", () => {
  it("sets maximum: 64 on max_concurrency schema and rejects prototype keys in validateProposedSwarmPlan", () => {
    const schemaJson = JSON.stringify(ProposeSwarmPlanParamsSchema);
    assert.ok(!schemaJson.includes('"anyOf"'));
    assert.ok(!schemaJson.includes('"oneOf"'));
    const maxConcProp = ProposeSwarmPlanParamsSchema.properties
      .max_concurrency as unknown as Record<string, unknown>;
    assert.equal(maxConcProp.minimum, 1);
    assert.equal(maxConcProp.maximum, 64);

    const protoMemberRes = validateProposedSwarmPlan(
      makeSamplePlanParams({
        initial_members: [
          { name: "constructor", role: "worker", brief: "Prototype key test" },
        ],
      }),
    );
    assert.equal(protoMemberRes.valid, false);
    if (!protoMemberRes.valid) {
      assert.equal(protoMemberRes.issues[0]?.code, "INVALID_NAME");
    }

    const protoChannelRes = validateProposedSwarmPlan(
      makeSamplePlanParams({
        initial_members: [
          {
            name: "parser",
            role: "worker",
            brief: "Valid member",
            channels: ["constructor"],
          },
        ],
      }),
    );
    assert.equal(protoChannelRes.valid, false);
    if (!protoChannelRes.valid) {
      assert.equal(protoChannelRes.issues[0]?.code, "INVALID_CHANNEL");
    }
  });

  it("rejects blank/whitespace-only question text in swarm_questionnaire and falls back from detached HEAD to main", async () => {
    const harness = new MockPiHarness();
    const confirmedPlans: ProposedSwarmPlan[] = [];
    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ currentBranch: "HEAD" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => {
          throw new Error("should not open modal on blank question");
        },
        confirmProposal: async (_ctx, plan) => ({
          action: "confirm",
          validatorEnabled: plan.validatorEnabled,
          maxConcurrency: plan.maxConcurrency,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({
      seed: "Detached HEAD + blank question check",
      validatorEnabled: true,
      maxConcurrency: 4,
    });

    const ctx = harness.createContext();
    const qnTool = harness.registeredTools.get(SWARM_QUESTIONNAIRE_TOOL);
    const blankRes = await qnTool.execute(
      "tc-blank",
      {
        questions: [
          {
            id: "q1",
            question: "   \t  ",
            options: [{ label: "Yes" }],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(blankRes.isError, true);

    const proposeRes = await harness.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute("tc-head-fallback", makeSamplePlanParams(), undefined, undefined, ctx);
    assert.equal(proposeRes.isError, undefined);
    assert.equal(confirmedPlans[0]?.baseBranch, "main");
  });

  it("rehydrates branch-local state on startOrResolve and ensureDraftSynced across branch switches without leaking stale in-memory drafts", async () => {
    const harness = new MockPiHarness();
    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: false, answer: "Option A", isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "cancel",
          validatorEnabled: true,
          maxConcurrency: 3,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    // Start draft on Branch A (populates controller.current)
    controller.start({
      seed: "Branch A only",
      validatorEnabled: true,
      maxConcurrency: 3,
    });
    assert.equal(controller.isActive(), true);

    // Switch to Branch B (empty session branch -> no active draft on Branch B)
    const branchBCtx = harness.createContext({ branch: [], hasUI: false });
    const startB = await controller.startOrResolve(branchBCtx, {
      seed: "Branch B fresh draft",
      validatorEnabled: false,
      maxConcurrency: 2,
    });
    // Must start cleanly instead of hitting conflict dialog from Branch A's stale this.current
    assert.equal(startB.action, "started");
    assert.equal(startB.draft?.seed, "Branch B fresh draft");

    // Now switch to Branch C (also empty) and execute swarm_question -> must NOT echo into Branch A's draft
    const branchCCtx = harness.createContext({ branch: [] });
    const qTool = harness.registeredTools.get(SWARM_QUESTION_TOOL);
    await qTool.execute(
      "tc-branch-c",
      { id: "q_c", question: "Pick one", options: [{ label: "Option A" }] },
      undefined,
      undefined,
      branchCCtx,
    );
    assert.equal(controller.getDraft(), null);
  });

  it("handles tweak cancel tool profile restoration and delegates profile sync when onDraftChanged is provided", async () => {
    // 1. Without onDraftChanged, cancelling a tweak draft restores "running" tool profile
    const harnessTweak = new MockPiHarness();
    const tweakCtrl = registerDraftingTools(harnessTweak.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "cancel",
          validatorEnabled: true,
          maxConcurrency: 3,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });
    tweakCtrl.start({
      mode: "tweak",
      targetRunId: "run-active-1",
      seed: "Tweak running swarm",
      validatorEnabled: true,
      maxConcurrency: 4,
    });
    await harnessTweak.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute(
        "tc-tweak-cancel",
        makeSamplePlanParams(),
        undefined,
        undefined,
        harnessTweak.createContext(),
      );
    for (const tool of SWARM_CORE_TOOLS) {
      assert.ok(
        harnessTweak.activeTools.includes(tool),
        `tweak cancel must restore core tool ${tool}`,
      );
    }

    // 2. With onDraftChanged, cancel delegates profile sync instead of calling setActiveTools directly
    const harnessDelegated = new MockPiHarness();
    let onDraftChangedCount = 0;
    const delegatedCtrl = registerDraftingTools(harnessDelegated.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "cancel",
          validatorEnabled: true,
          maxConcurrency: 3,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
      onDraftChanged: () => {
        onDraftChangedCount += 1;
      },
    });
    delegatedCtrl.start({
      seed: "Delegated cancel",
      validatorEnabled: true,
      maxConcurrency: 3,
    });
    const callsBeforeCancel = harnessDelegated.setActiveToolsCalls.length;
    await harnessDelegated.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute(
        "tc-delegated-cancel",
        makeSamplePlanParams(),
        undefined,
        undefined,
        harnessDelegated.createContext(),
      );
    assert.equal(onDraftChangedCount, 1);
    assert.equal(harnessDelegated.setActiveToolsCalls.length, callsBeforeCancel);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
  InitialMemberProposalSchema,
  isDraftActive,
  ProposeSwarmPlanParamsSchema,
  registerDraftingTools,
  rehydrateDraft,
  startDraft,
  startOrResolveDraft,
  SwarmQuestionnaireItemSchema,
  SwarmQuestionnaireParamsSchema,
  SwarmQuestionParamsSchema,
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
  assertFeatureDependencyDag,
  assertProposedSwarmPlan,
  assertServiceManifest,
  deriveMilestonesFromFeatures,
  MissionAssertionProposalSchema,
  MissionCommandProposalSchema,
  MissionFeatureProposalSchema,
  MissionServiceProposalSchema,
  type ProposeSwarmPlanInput,
} from "../src/drafting/draft-tools.js";
import {
  SwarmProtocolError,
  type ContractReviewResult,
  type IQuestionnaireUI,
  type ISwarmStore,
  type IWorktreeManager,
  type ProposalDialogOutcome,
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
  overrides?: Partial<ProposeSwarmPlanInput>,
): ProposeSwarmPlanInput {
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
    const collapsedRendered = proposeTool
      .renderCall(makeSamplePlanParams(), theme, {} as any)
      .render(160)
      .join("\n");
    assert.match(collapsedRendered, /Swarm Plan/);
    assert.match(collapsedRendered, /propose_swarm_plan/);
    assert.match(collapsedRendered, /Title: OAuth & Audit Rollout/);
    assert.match(collapsedRendered, /validator:ON/);
    assert.match(collapsedRendered, /\(Ctrl\+O to expand\)/);
    assert.ok(!collapsedRendered.includes("### Dynamic Strategy"));

    const rendered = proposeTool
      .renderCall(makeSamplePlanParams(), theme, { expanded: true } as any)
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

    // Explicit validator_enabled: false reflected in renderCall (collapsed & expanded)
    const validatorOffCollapsed = proposeTool
      .renderCall(
        makeSamplePlanParams({ validator_enabled: false }),
        theme,
        {} as any,
      )
      .render(160)
      .join("\n");
    assert.match(validatorOffCollapsed, /validator:OFF/);

    const validatorOffRendered = proposeTool
      .renderCall(
        makeSamplePlanParams({ validator_enabled: false }),
        theme,
        { expanded: true } as any,
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

// ============================================================================
// 8. v0.3.7 Audit Regression Tests (Detached HEAD, maxConcurrency Cap, Prototype Keys)
// ============================================================================

describe("v0.3.7 drafting regression fixes", () => {
  it("rejects base_branch 'HEAD' and '-' prefixes in validateProposedSwarmPlan and ignores draft baseBranch 'HEAD' in resolveBaseBranch", async () => {
    for (const badBranch of ["HEAD", "  HEAD  ", "-foo", "--orphan"]) {
      const res = validateProposedSwarmPlan(
        makeSamplePlanParams({ base_branch: badBranch }),
      );
      assert.equal(res.valid, false, `expected ${badBranch} to be rejected`);
      if (!res.valid) {
        assert.equal(res.issues[0]?.code, "WRONG_BRANCH");
        assert.equal(res.issues[0]?.field, "base_branch");
      }
    }

    const harness = new MockPiHarness();
    const confirmedPlans: ProposedSwarmPlan[] = [];
    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ currentBranch: "develop" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
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

    // Draft initialized with detached HEAD -> resolveBaseBranch ignores "HEAD" and detects "develop"
    controller.start({
      seed: "Draft with detached HEAD",
      baseBranch: "HEAD",
      validatorEnabled: true,
      maxConcurrency: 4,
    });
    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const res = await proposeTool.execute(
      "tc-draft-head",
      makeSamplePlanParams(),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(res.isError, undefined);
    assert.equal(confirmedPlans[0]?.baseBranch, "develop");
  });

  it("treats baseBranch 'HEAD' as unset in buildDirectPlanPrompt & buildDraftingKickoffPrompt", () => {
    const settings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      maxConcurrency: 4,
      validatorEnabled: true,
    };

    const directHead = buildDirectPlanPrompt("Ship feature", "HEAD", settings);
    assert.match(directHead, /base_branch="\(auto-detect current branch\)"/);
    assert.ok(!directHead.includes('base_branch: "HEAD"'));
    assert.match(directHead, /Omit `base_branch`/);

    const kickoffHead = buildDraftingKickoffPrompt("Ship feature", "swarm", {
      baseBranch: "HEAD",
    });
    assert.match(kickoffHead, /base_branch="\(auto-detect current branch\)"/);
  });

  it("caps maxConcurrency at 64 across draft-state and propose_swarm_plan", async () => {
    const harness = new MockPiHarness();
    const started = startDraft(harness.api, {
      seed: "Cap concurrency",
      maxConcurrency: 999,
    });
    assert.equal(started.maxConcurrency, 64);

    const updated = updateDraft(harness.api, started, { maxConcurrency: 500 });
    assert.equal(updated.maxConcurrency, 64);

    const ctx = harness.createContext();
    assert.equal(rehydrateDraft(ctx)?.maxConcurrency, 64);

    const confirmedPlans: ProposedSwarmPlan[] = [];
    let callCount = 0;
    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              action: "continue",
              validatorEnabled: true,
              maxConcurrency: 500,
              feedback: "Keep refining",
            };
          }
          return {
            action: "confirm",
            validatorEnabled: true,
            maxConcurrency: 200,
          };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });
    controller.start({ seed: "Tool cap", maxConcurrency: 128 });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const theme = createMockTheme();
    const collapsed = proposeTool
      .renderCall(makeSamplePlanParams({ max_concurrency: 999 }), theme, {} as any)
      .render(120)
      .join("\n");
    assert.match(collapsed, /max:64/);
    const rendered = proposeTool
      .renderCall(makeSamplePlanParams({ max_concurrency: 999 }), theme, { expanded: true } as any)
      .render(120)
      .join("\n");
    assert.match(rendered, /\*\*Max Concurrency:\*\* 64/);

    const contRes = await proposeTool.execute(
      "tc-cap-cont",
      makeSamplePlanParams({ max_concurrency: 999 }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(
      (contRes.details as ProposeSwarmPlanToolDetails).plan?.maxConcurrency,
      64,
    );
    assert.equal(controller.getDraft()?.maxConcurrency, 64);

    const confRes = await proposeTool.execute(
      "tc-cap-conf",
      makeSamplePlanParams({ max_concurrency: 999 }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(
      (confRes.details as ProposeSwarmPlanToolDetails).plan?.maxConcurrency,
      64,
    );
    assert.equal(confirmedPlans[0]?.maxConcurrency, 64);
  });

  it("validates questionnaireEcho shape on rehydrate, strips prototype keys in cloneEcho, and sanitizes prototype question ids", async () => {
    const harness = new MockPiHarness();
    const ctx = harness.createContext();

    // Non-object / array questionnaireEcho is rejected on rehydrate
    for (const badEcho of [[], "bad", 123, null]) {
      harness.api.appendEntry(SWARM_DRAFT_ENTRY, {
        version: 2,
        mode: "swarm",
        seed: "Bad echo shape",
        startedAt: new Date().toISOString(),
        validatorEnabled: true,
        maxConcurrency: 3,
        questionnaireEcho: badEcho,
      });
      assert.equal(rehydrateDraft(ctx), null);
    }

    // Prototype keys in questionnaireEcho are stripped in startDraft & updateDraft
    const protoEcho = JSON.parse(
      '{"__proto__":"pollute","constructor":"bad","toString":"fn","valid_q":"ok"}',
    ) as Record<string, string>;
    const cleanDraft = startDraft(harness.api, {
      seed: "Clean echo",
      questionnaireEcho: protoEcho,
    });
    assert.deepEqual(cleanDraft.questionnaireEcho, { valid_q: "ok" });
    assert.equal(Object.hasOwn(cleanDraft.questionnaireEcho!, "constructor"), false);

    // swarm_question & swarm_questionnaire sanitize prototype question IDs and use Object.hasOwn
    const seenIds: string[] = [];
    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async (_ctx, spec) => {
          seenIds.push(spec.id);
          return { cancelled: false, answer: "Answer 1", isCustom: false };
        },
        askQuestionnaire: async (_ctx, specs) => {
          seenIds.push(...specs.map((s) => s.id));
          return {
            cancelled: false,
            answers: {},
            items: [
              {
                id: "toString",
                question: "Pick one",
                answer: "Own answer",
                isCustom: false,
              },
            ],
          };
        },
        confirmProposal: async () => ({
          action: "cancel",
          validatorEnabled: true,
          maxConcurrency: 3,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });
    controller.start({ seed: "Proto question ids" });

    const qTool = harness.registeredTools.get(SWARM_QUESTION_TOOL);
    const qRes = await qTool.execute(
      "tc-proto-q",
      qTool.prepareArguments({
        id: "constructor",
        question: "Which mode?",
        options: [{ label: "A" }],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal((qRes.details as SwarmQuestionToolDetails).id, "q_constructor");

    const qnTool = harness.registeredTools.get(SWARM_QUESTIONNAIRE_TOOL);
    const qnRes = await qnTool.execute(
      "tc-proto-qn",
      qnTool.prepareArguments({
        questions: [
          {
            id: "toString",
            question: "Pick one",
            options: [{ label: "Own answer" }],
          },
          {
            id: "__proto__",
            question: "Pick two",
            options: [{ label: "Safe" }],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    const qnDetails = qnRes.details as SwarmQuestionnaireToolDetails;
    assert.deepEqual(seenIds, ["q_constructor", "q_toString", "q___proto__"]);
    assert.equal(Object.hasOwn(qnDetails.answers, "q_toString"), true);
    assert.equal(qnDetails.answers.q_toString, "Own answer");
    assert.equal(controller.getDraft()?.questionnaireEcho?.q_constructor, "Answer 1");
    assert.equal(controller.getDraft()?.questionnaireEcho?.q_toString, "Own answer");
  });

  it("propose_swarm_plan continue branch preserves outcome.roleModels and falls back to updated settings", async () => {
    const harness = new MockPiHarness();
    let currentSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      workerModel: "anthropic/claude-sonnet-4-5",
      workerThinkingLevel: "medium",
    };

    const outcomes: ProposalDialogOutcome[] = [
      {
        action: "continue",
        validatorEnabled: true,
        maxConcurrency: 4,
        feedback: "Keep refining with new picker models",
        roleModels: {
          orchestrator: { model: "openai/gpt-5", thinkingLevel: "high" },
          worker: { model: "google/gemini-2.5-pro", thinkingLevel: "low" },
        },
      },
      {
        action: "continue",
        validatorEnabled: false,
        maxConcurrency: 2,
        feedback: "Updated via settings directly",
      },
    ];

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({
          cancelled: true,
          answers: {},
          items: [],
        }),
        confirmProposal: async () => {
          const next = outcomes.shift()!;
          if (!next.roleModels) {
            currentSettings = {
              ...currentSettings,
              validatorModel: "anthropic/claude-opus-4-6",
              validatorThinkingLevel: "xhigh",
            };
          }
          return next;
        },
      },
      getSettings: () => currentSettings,
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    controller.start({ seed: "Continue roleModels test" });
    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // 1. Explicit outcome.roleModels preserved on "continue"
    const res1 = await proposeTool.execute(
      "tc-cont-rm-1",
      makeSamplePlanParams(),
      undefined,
      undefined,
      ctx,
    );
    const details1 = res1.details as ProposeSwarmPlanToolDetails;
    assert.equal(details1.outcome, "continue");
    assert.deepEqual(details1.plan?.roleModels, {
      orchestrator: { model: "openai/gpt-5", thinkingLevel: "high" },
      worker: { model: "google/gemini-2.5-pro", thinkingLevel: "low" },
    });
    assert.match(res1.content[0].text, /Orchestrator: openai\/gpt-5 \(high\)/);
    assert.match(res1.content[0].text, /Worker: google\/gemini-2\.5-pro \(low\)/);

    // 2. Omitted outcome.roleModels reads refreshed deps.getSettings()
    const res2 = await proposeTool.execute(
      "tc-cont-rm-2",
      makeSamplePlanParams(),
      undefined,
      undefined,
      ctx,
    );
    const details2 = res2.details as ProposeSwarmPlanToolDetails;
    assert.equal(details2.outcome, "continue");
    assert.equal(details2.plan?.roleModels?.validator?.model, "anthropic/claude-opus-4-6");
    assert.equal(details2.plan?.roleModels?.validator?.thinkingLevel, "xhigh");
    assert.match(res2.content[0].text, /Validator: anthropic\/claude-opus-4-6 \(xhigh\)/);
  });
});

// ============================================================================
// 9. v0.6.0 Drafting Prompts & Polished TUI Tool Renderers Tests
// ============================================================================

describe("v0.6.0 drafting prompts & polished TUI renderers", () => {
  it("enforces recon-first, 0-or-1-to-3 '(Recommended)' Q&A, right-sizing, disjoint file ownership waves, and runnable verification commands across prompts", () => {
    const kickoff = buildDraftingKickoffPrompt("Refactor auth & session store", "swarm", {
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
    });
    // Recon FIRST
    assert.match(kickoff, /FIRST/);
    assert.match(kickoff, /package\.json/);
    // Lean Q&A: 0 questions when clear, at most 1–3 high-leverage trade-off questions, (Recommended) first
    assert.match(kickoff, /0 questions/);
    assert.match(kickoff, /1–3 high-leverage trade-off questions/);
    assert.match(kickoff, /\(Recommended\)/);
    assert.match(kickoff, /Never interrogate the user on obvious details/i);
    // Right-sizing
    assert.match(kickoff, /1–2 workers/);
    assert.match(kickoff, /Disjoint parallel `share` authors \+ independent `validator`/);
    // Wave-by-wave disjoint file/directory ownership & runnable verification commands
    assert.match(
      kickoff,
      /wave-by-wave execution with disjoint file\/directory ownership boundaries/,
    );
    assert.match(kickoff, /exact runnable verification commands/);

    const overlay = buildDraftingSystemOverlay({
      version: 2,
      mode: "swarm",
      seed: "Refactor auth",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 4,
      baseBranch: "main",
    });
    assert.match(overlay, /FIRST/);
    assert.match(overlay, /0 questions/);
    assert.match(overlay, /1–3 high-leverage trade-off questions/);
    assert.match(overlay, /\(Recommended\)/);
    assert.match(overlay, /1–2 workers/);
    assert.match(overlay, /disjoint file\/directory ownership boundaries/);
    assert.match(overlay, /exact runnable verification commands/);

    const direct = buildDirectPlanPrompt("Fix parser edge case", "main", {
      maxConcurrency: 3,
      validatorEnabled: true,
    });
    assert.match(direct, /Skip interactive Q&A/);
    assert.match(direct, /FIRST/);
    assert.match(direct, /1–2 workers/);
    assert.match(direct, /wave-by-wave execution with disjoint file\/directory ownership boundaries/);
    assert.match(direct, /exact runnable verification commands/);
  });

  it("polishes formatProposalTranscriptSummary with member breakdown, launch note, and clean fallback filtering", () => {
    const summary = formatProposalTranscriptSummary({
      title: "Multi-Slice Upgrade",
      objective: "Upgrade drafting & TUI renderers cleanly.",
      strategy: "Wave 1: disjoint `share` workers per module -> `@verifier` review.",
      acceptanceCriteria: "`npm run typecheck && npm test` passes 100%.",
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
      feedback: "Prioritize narrow 40-col readability",
      roleModels: {
        orchestrator: { model: "anthropic/claude-opus-4-6", thinkingLevel: "high" },
        worker: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" },
        validator: { model: "openai/gpt-5", thinkingLevel: "high" },
        fallbackModels: ["  ", "google/gemini-2.5-pro", ""],
      },
      initialMembers: [
        {
          name: "draft-dev",
          role: "worker",
          workspace: "share",
          brief: "Own src/drafting/*",
        },
        {
          name: "ui-dev",
          role: "worker",
          workspace: "share",
          brief: "Own src/ui/*",
        },
        {
          name: "verifier",
          role: "validator",
          workspace: "inherit",
          brief: "Audit both branches read-only",
        },
      ],
    });

    assert.match(summary, /> \*\*Launch Note:\*\* Prioritize narrow 40-col readability/);
    assert.match(summary, /### Dynamic Strategy \(Waves & Disjoint Ownership\)/);
    assert.match(summary, /### Acceptance Criteria & Verification/);
    assert.match(
      summary,
      /### Initial Members \(3\) — 2 workers · 1 validator · 2 isolated worktrees/,
    );
    assert.match(summary, /\*\*Fallbacks:\*\* google\/gemini-2\.5-pro$/m);
  });

  it("renders sleek collapsed vs expanded views for swarm_question, swarm_questionnaire, and propose_swarm_plan", () => {
    const harness = new MockPiHarness();
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
      getSettings: () => ({
        ...DEFAULT_SWARM_SETTINGS,
        orchestratorModel: "anthropic/claude-opus-4-6",
        orchestratorThinkingLevel: "high",
        workerModel: "anthropic/claude-sonnet-4-5",
        workerThinkingLevel: "medium",
        validatorModel: "openai/gpt-5",
        validatorThinkingLevel: "low",
        fallbackModels: ["google/gemini-2.5-pro"],
      }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    const theme = createMockTheme();
    const questionTool = harness.registeredTools.get(SWARM_QUESTION_TOOL);
    const questionnaireTool = harness.registeredTools.get(SWARM_QUESTIONNAIRE_TOOL);
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // 1. swarm_question renderCall (collapsed vs expanded) & renderResult
    const qArgs = {
      id: "storage_engine",
      question: "Which state store should we use?",
      context: "Repo currently bundles better-sqlite3 in package.json.",
      options: [
        { label: "(Recommended) SQLite WAL", description: "Zero external services" },
        { label: "PostgreSQL", description: "Shared cluster" },
      ],
      allow_custom: true,
    };
    const qCallCollapsed = questionTool
      .renderCall(qArgs, theme, { expanded: false } as any)
      .render(120)
      .join("\n");
    assert.match(qCallCollapsed, /❓.*swarm_question.*\[storage_engine\].*\(2 options \+ custom\)/);
    assert.match(qCallCollapsed, /Choices:.*\(Recommended\) SQLite WAL ★ · PostgreSQL/);
    assert.ok(!qCallCollapsed.includes("Zero external services"));

    const qCallExpanded = questionTool
      .renderCall(qArgs, theme, { expanded: true } as any)
      .render(120)
      .join("\n");
    assert.match(qCallExpanded, /1\. \(Recommended\) SQLite WAL ★ — Zero external services/);
    assert.match(qCallExpanded, /2\. PostgreSQL — Shared cluster/);

    const qResCollapsed = questionTool
      .renderResult(
        {
          content: [{ type: "text", text: "Answer: SQLite WAL" }],
          details: {
            cancelled: false,
            id: "storage_engine",
            question: "Which state store should we use?",
            answer: "SQLite WAL",
            isCustom: true,
          },
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(120)
      .join("\n");
    assert.match(qResCollapsed, /✓ \[ANSWERED\] \[storage_engine\] SQLite WAL \(custom\)/);

    const qResExpanded = questionTool
      .renderResult(
        {
          content: [{ type: "text", text: "Answer: SQLite WAL" }],
          details: {
            cancelled: false,
            id: "storage_engine",
            question: "Which state store should we use?",
            answer: "SQLite WAL",
            isCustom: false,
          },
        },
        { expanded: true, isPartial: false },
        theme,
        {} as any,
      )
      .render(120)
      .join("\n");
    assert.match(qResExpanded, /Question: Which state store should we use\?/);
    assert.match(qResExpanded, /Answer:\s+SQLite WAL/);

    const qResSkipped = questionTool
      .renderResult(
        {
          content: [{ type: "text", text: "Dismissed" }],
          details: { cancelled: true, id: "q1", question: "Skip?" },
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(120)
      .join("\n");
    assert.match(qResSkipped, /○ \[SKIPPED\] Question dismissed by user\./);

    // 2. swarm_questionnaire renderCall & renderResult (collapsed summary vs expanded)
    const qnArgs = {
      questions: [
        {
          id: "scope",
          question: "Which modules are in scope?",
          options: [
            { label: "(Recommended) Core + UI", description: "Full vertical slice" },
            { label: "Core only", description: "Minimal backend patch" },
          ],
        },
        {
          id: "verify",
          question: "Run integration suite?",
          options: [{ label: "Yes" }, { label: "Unit only" }],
          recommended: "Yes",
        },
      ],
    };
    const qnCallCollapsed = questionnaireTool
      .renderCall(qnArgs, theme, { expanded: false } as any)
      .render(120)
      .join("\n");
    assert.match(
      qnCallCollapsed,
      /📋.*swarm_questionnaire.*\(2 questions · 4 options: scope, verify\)/,
    );
    assert.match(qnCallCollapsed, /1\. \[scope\] Which modules are in scope\? \(2 options · ★ Core \+ UI\)/);
    assert.match(qnCallCollapsed, /2\. \[verify\] Run integration suite\? \(2 options · ★ Yes\)/);
    assert.ok(!qnCallCollapsed.includes("Full vertical slice"));

    const qnCallExpanded = questionnaireTool
      .renderCall(qnArgs, theme, { expanded: true } as any)
      .render(120)
      .join("\n");
    assert.match(qnCallExpanded, /Full vertical slice/);

    const qnResPayload = {
      content: [
        {
          type: "text" as const,
          text: "Questionnaire answers recorded:\n- [scope] Which modules?\n  Answer: Core + UI\n- [verify] Integration?\n  Answer: Custom gate (custom)",
        },
      ],
      details: {
        cancelled: false,
        questionCount: 2,
        answers: {
          scope: "Core + UI",
          verify: "Custom gate",
        },
        items: [
          { id: "scope", question: "Which modules?", answer: "Core + UI", isCustom: false },
          { id: "verify", question: "Integration?", answer: "Custom gate", isCustom: true },
        ],
      } satisfies SwarmQuestionnaireToolDetails,
    };
    const qnResCollapsed = questionnaireTool
      .renderResult(qnResPayload, { expanded: false, isPartial: false }, theme, {} as any)
      .render(120)
      .join("\n");
    assert.match(qnResCollapsed, /✓ \[RECORDED\] Recorded 2 questionnaire answer\(s\)\./);
    assert.match(qnResCollapsed, /• scope: Core \+ UI/);
    assert.match(qnResCollapsed, /• verify: Custom gate \(custom\)/);
    assert.match(qnResCollapsed, /\(Ctrl\+O to expand\)/);

    const qnResExpanded = questionnaireTool
      .renderResult(qnResPayload, { expanded: true, isPartial: false }, theme, {} as any)
      .render(120)
      .join("\n");
    assert.match(qnResExpanded, /✓ \[RECORDED\] Recorded 2\/2 questionnaire answer\(s\)/);
    assert.match(qnResExpanded, /Questionnaire answers recorded:/);

    // 3. propose_swarm_plan renderCall (mode badge + model pills) & renderResult badges
    controller.start({
      mode: "tweak",
      seed: "Refine active swarm",
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
    });
    const planCallText = proposeTool
      .renderCall(makeSamplePlanParams(), theme, {} as any)
      .render(160)
      .join("\n");
    assert.match(planCallText, /🗺 Swarm Plan \(propose_swarm_plan\) \[TWEAK\]/);
    assert.match(
      planCallText,
      /Role Models: \[Orch:claude-opus-4-6\(high\) · Work:claude-sonnet-4-5\(medium\) · Val:gpt-5\(low\) · \+1 fb\]/,
    );

    const confirmedCollapsed = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Full proposal markdown" }],
          details: {
            outcome: "confirmed",
            runId: "run-v060",
            autoConfirmed: false,
            plan: {
              title: "Ship v0.6.0",
              objective: "Polish drafting",
              strategy: "Wave 1",
              acceptanceCriteria: "npm run typecheck",
              baseBranch: "main",
              maxConcurrency: 4,
              validatorEnabled: true,
              feedback: "Run full integration check before done",
              initialMembers: [
                { name: "author", role: "worker", workspace: "share", brief: "Edit slice" },
              ],
              roleModels: {
                orchestrator: { model: "anthropic/claude-opus-4-6", thinkingLevel: "high" },
                worker: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" },
                validator: { model: "openai/gpt-5", thinkingLevel: "low" },
              },
            },
          } satisfies ProposeSwarmPlanToolDetails,
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(160)
      .join("\n");
    assert.match(confirmedCollapsed, /✓ \[CONFIRMED\] Swarm Plan confirmed — launched run run-v060/);
    assert.match(confirmedCollapsed, /branch:main · 1 initial member · \[Orch:claude-opus-4-6\(high\)/);
    assert.match(confirmedCollapsed, /Note: Run full integration check before done/);

    const validationErrText = proposeTool
      .renderResult(
        {
          isError: true,
          content: [{ type: "text", text: "[SwarmProtocolError:INVALID_NAME] Bad name" }],
          details: {
            outcome: "validation_error",
            errors: [{ code: "INVALID_NAME", message: "Bad name" }],
          } satisfies ProposeSwarmPlanToolDetails,
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(120)
      .join("\n");
    assert.match(validationErrText, /✗ \[VALIDATION ERROR · 1 issue\]/);
  });

  it("handles null, undefined, partial, and malformed arguments/results in renderCall & renderResult without throwing", () => {
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

    const theme = createMockTheme();
    for (const tool of tools) {
      assert.ok(tool.renderCall, `${tool.name} must define renderCall`);
      assert.ok(tool.renderResult, `${tool.name} must define renderResult`);

      for (const weirdArgs of [
        undefined,
        null,
        {},
        { options: [null, 42, {}, "Valid"], questions: [null, "bad", { options: null }] },
        { initial_members: [null, 123, { channels: [null, 99, "main"] }] },
      ]) {
        const comp = tool.renderCall!(weirdArgs as any, theme, undefined as any);
        assert.ok(Array.isArray(comp.render(80)));
      }

      for (const weirdResult of [
        undefined,
        null,
        {},
        { isError: true, content: null, details: null },
        { content: [{ type: "text", text: "Partial..." }], details: undefined },
      ]) {
        const compCollapsed = tool.renderResult!(
          weirdResult as any,
          undefined as any,
          theme,
          undefined as any,
        );
        assert.ok(Array.isArray(compCollapsed.render(80)));

        const compPartial = tool.renderResult!(
          weirdResult as any,
          { expanded: false, isPartial: true },
          theme,
          undefined as any,
        );
        assert.ok(Array.isArray(compPartial.render(80)));

        const compExpanded = tool.renderResult!(
          weirdResult as any,
          { expanded: true, isPartial: false },
          theme,
          undefined as any,
        );
        assert.ok(Array.isArray(compExpanded.render(80)));
      }
    }
  });

  it("renders ✗ [ERROR] when Pi ToolExecutionComponent strips result.isError and passes context.isError: true (or details.error)", () => {
    const harness = new MockPiHarness();
    registerDraftingTools(harness.api, {
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

    const theme = createMockTheme();
    const questionTool = harness.registeredTools.get(SWARM_QUESTION_TOOL);
    const questionnaireTool = harness.registeredTools.get(SWARM_QUESTIONNAIRE_TOOL);
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // 1. swarm_question empty-question error (details.cancelled === true, result.isError stripped, context.isError: true)
    const qEmptyErr = questionTool
      .renderResult(
        {
          content: [{ type: "text", text: "Question text must not be empty." }],
          details: { cancelled: true, id: "question", question: "" },
        },
        { expanded: false, isPartial: false },
        theme,
        { isError: true } as any,
      )
      .render(120)
      .join("\n");
    assert.match(qEmptyErr, /✗ \[ERROR\] Question text must not be empty\./);
    assert.doesNotMatch(qEmptyErr, /\[SKIPPED\]/);

    // Non-string details.answer falls back cleanly without throwing
    const qMalformedAnswer = questionTool
      .renderResult(
        {
          content: [{ type: "text", text: "Fallback text" }],
          details: { cancelled: false, id: "q1", question: "Q?", answer: 12345 as any },
        },
        { expanded: false, isPartial: false },
        theme,
        { isError: false } as any,
      )
      .render(120)
      .join("\n");
    assert.match(qMalformedAnswer, /Fallback text/);

    // 2. swarm_questionnaire empty-questions error via context.isError: true AND via details.error alone
    const qnCtxErr = questionnaireTool
      .renderResult(
        {
          content: [
            { type: "text", text: "Questionnaire must include at least one question." },
          ],
          details: {
            cancelled: true,
            questionCount: 0,
            answers: {},
            error: "empty_questions",
          },
        },
        { expanded: false, isPartial: false },
        theme,
        { isError: true } as any,
      )
      .render(120)
      .join("\n");
    assert.match(
      qnCtxErr,
      /✗ \[ERROR\] Questionnaire must include at least one question\./,
    );
    assert.doesNotMatch(qnCtxErr, /\[CANCELLED\]/);

    const qnDetailsErr = questionnaireTool
      .renderResult(
        {
          content: [{ type: "text", text: "Question #1 text must not be empty." }],
          details: {
            cancelled: true,
            questionCount: 1,
            answers: {},
            error: "empty_question_text",
          },
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(120)
      .join("\n");
    assert.match(qnDetailsErr, /✗ \[ERROR\] Question #1 text must not be empty\./);

    // 3. Schema/runtime error with details: undefined and context.isError: true across all 3 tools
    for (const tool of [questionTool, questionnaireTool, proposeTool]) {
      const schemaErr = tool
        .renderResult(
          {
            content: [{ type: "text", text: "Schema validation failed" }],
            details: undefined,
          },
          { expanded: false, isPartial: false },
          theme,
          { isError: true } as any,
        )
        .render(120)
        .join("\n");
      assert.match(
        schemaErr,
        /✗ \[ERROR\] Schema validation failed/,
        `${tool.name} must render ✗ [ERROR] when context.isError is true`,
      );
    }
  });
});

// ============================================================================
// 10. v0.7.0 Collapsible Proposal Preview, Wave-1 Guidance & Schema Invariants
// ============================================================================

describe("v0.7.0 collapsible proposal renderCall, wave-1 prompt guidance & schema invariants", () => {
  it("propose_swarm_plan.renderCall renders crisp 3–4 line summary when collapsed and full plan when expanded, honoring keyHint & isPartial", () => {
    const harness = new MockPiHarness();
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
      getSettings: () => ({
        ...DEFAULT_SWARM_SETTINGS,
        orchestratorModel: "anthropic/claude-opus-4-6",
        orchestratorThinkingLevel: "high",
        workerModel: "anthropic/claude-sonnet-4-5",
        workerThinkingLevel: "medium",
        validatorModel: "openai/gpt-5",
        validatorThinkingLevel: "low",
      }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    controller.start({
      mode: "swarm",
      seed: "Ship v0.7.0 upgrades",
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
    });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const theme = createMockTheme();

    // 1. Collapsed with no initial_members -> crisp 3-line summary card + fallback Ctrl+O hint
    const noMembersLines = proposeTool
      .renderCall(
        makeSamplePlanParams({
          title: "Compact Card Plan",
          base_branch: "release/v0.7",
          max_concurrency: 5,
          initial_members: undefined,
        }),
        theme,
        { expanded: false } as any,
      )
      .render(160);
    assert.equal(noMembersLines.length, 3);
    const noMembersText = noMembersLines.join("\n");
    assert.match(
      noMembersText,
      /🗺 Swarm Plan \(propose_swarm_plan\) \[PROPOSAL\] \(release\/v0\.7 · max:5 · validator:ON · dynamic waves\)/,
    );
    assert.match(noMembersText, /Title: Compact Card Plan \(Ctrl\+O to expand\)/);
    assert.match(noMembersText, /Role Models: \[Orch:claude-opus-4-6\(high\)/);
    assert.ok(!noMembersText.includes("Implement OAuth2 PKCE login"));
    assert.ok(!noMembersText.includes("### Dynamic Strategy"));
    assert.ok(!noMembersText.includes("### Acceptance Criteria"));

    // 2. Collapsed with >4 initial_members -> crisp 4-line summary card with +N more overflow & custom keyHint
    const keyHintCalls: Array<[string, string]> = [];
    const fiveMemberLines = proposeTool
      .renderCall(
        makeSamplePlanParams({
          initial_members: [
            { name: "alpha", role: "worker", workspace: "share", brief: "Own src/a.ts" },
            { name: "beta", role: "worker", workspace: "share", brief: "Own src/b.ts" },
            { name: "gamma", role: "worker", workspace: "share", brief: "Own src/c.ts" },
            { name: "delta", role: "worker", workspace: "share", brief: "Own src/d.ts" },
            { name: "epsilon", role: "worker", workspace: "branch", brief: "Own src/e.ts" },
          ],
        }),
        theme,
        {
          expanded: false,
          keyHint: (kb: string, desc: string) => {
            keyHintCalls.push([kb, desc]);
            return "Alt+E to expand";
          },
        } as any,
      )
      .render(200);
    assert.equal(fiveMemberLines.length, 4);
    assert.deepEqual(keyHintCalls, [["app.tools.expand", "to expand"]]);
    const fiveMemberText = fiveMemberLines.join("\n");
    assert.match(fiveMemberText, /5 members/);
    assert.match(fiveMemberText, /Title: OAuth & Audit Rollout \(Alt\+E to expand\)/);
    assert.match(
      fiveMemberText,
      /Initial Wave: alpha\(worker\/share\) · beta\(worker\/share\) · gamma\(worker\/share\) · delta\(worker\/share\) · \+1 more/,
    );
    assert.ok(!fiveMemberText.includes("Own src/a.ts"));

    // Already-parenthesized keyHint is not double-wrapped
    const preWrappedText = proposeTool
      .renderCall(makeSamplePlanParams({ initial_members: undefined }), theme, {
        expanded: false,
        keyHint: () => "(Space to expand)",
      } as any)
      .render(160)
      .join("\n");
    assert.match(preWrappedText, /\(Space to expand\)/);
    assert.ok(!preWrappedText.includes("((Space to expand))"));

    // 3. Partial streaming handling (empty args vs partial title) stays compact and never throws
    const partialEmpty = proposeTool
      .renderCall({} as any, theme, { expanded: false, isPartial: true } as any)
      .render(160)
      .join("\n");
    assert.match(partialEmpty, /Title: Drafting… ⏳ \(Ctrl\+O to expand\)/);

    const partialWithTitle = proposeTool
      .renderCall({ title: "Half-streamed Plan" } as any, theme, {
        expanded: false,
        isPartial: true,
      } as any)
      .render(160)
      .join("\n");
    assert.match(
      partialWithTitle,
      /Title: Half-streamed Plan ⏳ streaming… \(Ctrl\+O to expand\)/,
    );

    // 4. Expanded mode renders the full plan details cleanly
    const expandedText = proposeTool
      .renderCall(makeSamplePlanParams(), theme, { expanded: true } as any)
      .render(160)
      .join("\n");
    assert.match(expandedText, /## Swarm Plan Proposal: OAuth & Audit Rollout/);
    assert.match(expandedText, /\*\*Objective:\*\* Implement OAuth2 PKCE login/);
    assert.match(expandedText, /### Dynamic Strategy \(Waves & Disjoint Ownership\)/);
    assert.match(expandedText, /### Acceptance Criteria & Verification/);
    assert.match(expandedText, /\| \*\*oauth-dev\*\* \| `worker` \| `share` \|/);

    // 5. renderResult also respects context.keyHint with graceful Ctrl+O fallback
    const confirmedWithHint = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Full proposal" }],
          details: {
            outcome: "confirmed",
            runId: "run-hint-1",
            plan: {
              title: "Hint Check",
              objective: "Check keyHint",
              strategy: "Wave 1",
              acceptanceCriteria: "npm test",
              baseBranch: "main",
              maxConcurrency: 3,
              validatorEnabled: true,
            },
          } satisfies ProposeSwarmPlanToolDetails,
        },
        { expanded: false, isPartial: false },
        theme,
        { keyHint: () => "F2 to expand" } as any,
      )
      .render(160)
      .join("\n");
    assert.match(confirmedWithHint, /\(F2 to expand\)/);
  });

  it("guides orchestrators to spawn wave-1 workers only (on-demand validator) and use already-installed repo scripts instead of npx -y", () => {
    const kickoff = buildDraftingKickoffPrompt("Implement slugify helper", "swarm", {
      baseBranch: "main",
      maxConcurrency: 3,
      validatorEnabled: true,
    });
    const overlay = buildDraftingSystemOverlay({
      version: 2,
      mode: "swarm",
      seed: "Implement slugify helper",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 3,
      baseBranch: "main",
    });
    const direct = buildDirectPlanPrompt("Implement slugify helper", "main", {
      maxConcurrency: 3,
      validatorEnabled: true,
    });

    for (const [label, text] of [
      ["kickoff", kickoff],
      ["overlay", overlay],
      ["direct", direct],
    ] as const) {
      assert.match(text, /wave-1 workers only/i, `${label} must recommend wave-1 workers only`);
      assert.match(
        text,
        /validator.*on demand/i,
        `${label} must recommend spawning validator on demand`,
      );
      assert.match(
        text,
        /already-installed/i,
        `${label} must reference already-installed verification scripts`,
      );
      assert.match(
        text,
        /npx -y/i,
        `${label} must explicitly warn against speculative npx -y downloads`,
      );
    }

    const initialMembersDesc = String(
      (ProposeSwarmPlanParamsSchema.properties.initial_members as { description?: string })
        ?.description ?? "",
    );
    assert.match(initialMembersDesc, /wave-1 workers only/i);
    assert.match(initialMembersDesc, /on demand/i);
    assert.match(initialMembersDesc, /already-installed/i);
    assert.match(initialMembersDesc, /npx -y/i);

    const briefDesc = String(
      (InitialMemberProposalSchema.properties.brief as { description?: string })?.description ??
        "",
    );
    assert.match(briefDesc, /concise/i);
    assert.match(briefDesc, /already-installed/i);
    assert.match(briefDesc, /npx -y/i);
  });

  it("enforces zero Type.Union, anyOf, and oneOf in drafting tool schemas and draft-tools.ts source", () => {
    const forbiddenKeys: string[] = [];
    const visitSchema = (node: unknown, path: string): void => {
      if (!node || typeof node !== "object") {
        return;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          visitSchema(node[i], `${path}[${i}]`);
        }
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "anyOf" || k === "oneOf") {
          forbiddenKeys.push(`${path}.${k}`);
        }
        visitSchema(v, `${path}.${k}`);
      }
    };

    visitSchema(SwarmQuestionParamsSchema, "SwarmQuestionParamsSchema");
    visitSchema(SwarmQuestionnaireItemSchema, "SwarmQuestionnaireItemSchema");
    visitSchema(SwarmQuestionnaireParamsSchema, "SwarmQuestionnaireParamsSchema");
    visitSchema(InitialMemberProposalSchema, "InitialMemberProposalSchema");
    visitSchema(ProposeSwarmPlanParamsSchema, "ProposeSwarmPlanParamsSchema");
    assert.deepEqual(forbiddenKeys, []);

    const draftToolsPath = fileURLToPath(
      new URL("../src/drafting/draft-tools.ts", import.meta.url),
    );
    const source = readFileSync(draftToolsPath, "utf8");
    assert.equal(/\bType\.Union\b/.test(source), false, "draft-tools.ts must not use Type.Union");
    assert.equal(/\banyOf\b/.test(source), false, "draft-tools.ts must not contain anyOf");
    assert.equal(/\boneOf\b/.test(source), false, "draft-tools.ts must not contain oneOf");
  });
});

// ============================================================================
// 11. v0.8.0 Contract-First Mission TDD, Tweak Merge & Proposal Rendering
// ============================================================================

describe("v0.8.0 Mission-Level TDD planning, 100% fulfills & DAG gates, tweak merge & renderCall", () => {
  it("normalizes VAL-* assertions, milestone features, auto-derived milestones, commands & boundaries onto ProposedSwarmPlan", async () => {
    const harness = new MockPiHarness();
    const seenModalPlans: ProposedSwarmPlan[] = [];
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          seenModalPlans.push(plan);
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({
      mode: "swarm",
      seed: "Build PKCE auth + audit pipeline",
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
    });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const rawParams = proposeTool.prepareArguments({
      ...makeSamplePlanParams({ initial_members: undefined }),
      commands: [
        { name: " typecheck ", command: " npm run typecheck " },
        { name: "test", command: "npm test" },
      ],
      boundaries: [
        "  Do not modify legacy-db/  ",
        "Reserve local ports 4100-4110",
      ],
      assertions: [
        {
          id: " VAL-AUTH-001 ",
          title: " PKCE Exchange ",
          description: " Exchanges authorization code + verifier for session token ",
          evidence_required: " npm run test:file tests/auth.test.ts passes ",
        },
        {
          id: "VAL-AUTH-002",
          title: "Token Refresh Rotation",
          description: "Rotates refresh family and rejects replayed tokens",
        },
        {
          id: "VAL-AUDIT-001",
          title: "Structured Audit Sink",
          description: "Emits JSONL security events for login and refresh",
          evidence_required: "tests/audit.test.ts verifies JSONL output",
        },
      ],
      features: [
        {
          id: " pkce-client ",
          title: " OAuth2 PKCE Client ",
          description: " Implement PKCE challenge/verifier exchange ",
          milestone: " M1: Core Auth ",
          files_owned: [" src/auth/pkce.ts ", "tests/auth.test.ts"],
          preconditions: [" package.json scripts verified "],
          expected_behavior: [" Valid code returns token "],
          verification_steps: [" npm run test:file tests/auth.test.ts "],
          fulfills: [" VAL-AUTH-001 "],
        },
        {
          id: "audit-sink",
          title: "Audit Event Sink",
          description: "Implement append-only JSONL audit sink in parallel worktree",
          milestone: "M1: Core Auth",
          files_owned: ["src/audit/sink.ts", "tests/audit.test.ts"],
          fulfills: ["VAL-AUDIT-001"],
        },
        {
          id: "refresh-rotation",
          title: "Refresh Rotation Guard",
          description: "Wire token family rotation with audit logging",
          milestone: "M2: Session Hardening",
          depends_on: ["pkce-client", "audit-sink"],
          files_owned: ["src/auth/refresh.ts"],
          fulfills: ["VAL-AUTH-002"],
        },
      ],
    });

    const res = await proposeTool.execute(
      "tc-v080-norm",
      rawParams,
      undefined,
      undefined,
      harness.createContext(),
    );

    assert.equal(res.isError, undefined);
    assert.equal(seenModalPlans.length, 1);
    assert.equal(confirmedPlans.length, 1);

    const plan = confirmedPlans[0]!;
    assert.deepEqual(plan.commands, [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "test", command: "npm test" },
    ]);
    assert.deepEqual(plan.boundaries, [
      "Do not modify legacy-db/",
      "Reserve local ports 4100-4110",
    ]);

    assert.equal(plan.assertions?.length, 3);
    assert.equal(plan.assertions?.[0]?.id, "VAL-AUTH-001");
    assert.equal(plan.assertions?.[0]?.title, "PKCE Exchange");
    assert.equal(
      plan.assertions?.[0]?.evidenceRequired,
      "npm run test:file tests/auth.test.ts passes",
    );
    assert.equal(plan.assertions?.[0]?.status, "pending");
    assert.ok(plan.assertions?.[0]?.updatedAt);
    assert.equal(plan.assertions?.[1]?.evidenceRequired, undefined);

    assert.equal(plan.features?.length, 3);
    assert.equal(plan.features?.[0]?.id, "pkce-client");
    assert.equal(plan.features?.[0]?.milestone, "M1: Core Auth");
    assert.deepEqual(plan.features?.[0]?.filesOwned, [
      "src/auth/pkce.ts",
      "tests/auth.test.ts",
    ]);
    assert.deepEqual(plan.features?.[0]?.preconditions, [
      "package.json scripts verified",
    ]);
    assert.deepEqual(plan.features?.[0]?.expectedBehavior, [
      "Valid code returns token",
    ]);
    assert.deepEqual(plan.features?.[0]?.verificationSteps, [
      "npm run test:file tests/auth.test.ts",
    ]);
    assert.deepEqual(plan.features?.[0]?.fulfills, ["VAL-AUTH-001"]);
    assert.equal(plan.features?.[0]?.status, "pending");
    assert.deepEqual(plan.features?.[2]?.dependsOn, ["pkce-client", "audit-sink"]);

    // Milestones auto-derived in exact first-seen feature milestone order
    assert.deepEqual(plan.milestones, [
      { label: "M1: Core Auth", status: "pending" },
      { label: "M2: Session Hardening", status: "pending" },
    ]);
  });

  it("enforces pre-modal 100% fulfills coverage gate (unclaimed orphan assertions, omitted features, unknown fulfills, duplicate 1-to-1 fulfills, and duplicate IDs)", async () => {
    const harness = new MockPiHarness();
    let confirmCalls = 0;

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => {
          confirmCalls += 1;
          return { action: "confirm", validatorEnabled: true, maxConcurrency: 3 };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });
    controller.start({ seed: "Fulfills gate test" });

    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // 1. Unclaimed orphan assertion when features only claim 1 of 2 assertions
    const unclaimedRes = await proposeTool.execute(
      "tc-unclaimed",
      makeSamplePlanParams({
        assertions: [
          {
            id: "VAL-CORE-001",
            title: "Claimed",
            description: "Claimed behavior",
          },
          {
            id: "VAL-CORE-002",
            title: "Orphan",
            description: "Unclaimed behavior",
          },
        ],
        features: [
          {
            id: "feat-1",
            title: "Feature 1",
            description: "Implements VAL-CORE-001 only",
            milestone: "M1",
            fulfills: ["VAL-CORE-001"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(unclaimedRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(unclaimedRes.content[0].text, /\[SwarmProtocolError:INVALID_INPUT\]/);
    assert.match(unclaimedRes.content[0].text, /VAL-CORE-002/);
    assert.match(unclaimedRes.content[0].text, /100%/);

    // 2. Non-empty assertions with features omitted altogether
    const noFeaturesRes = await proposeTool.execute(
      "tc-no-features",
      makeSamplePlanParams({
        assertions: [
          {
            id: "VAL-ONLY-001",
            title: "Standalone assertion",
            description: "No features provided",
          },
        ],
        features: undefined,
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(noFeaturesRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(noFeaturesRes.content[0].text, /VAL-ONLY-001/);

    // 3. Feature fulfills an unknown assertion ID not defined in assertions
    const unknownValRes = await proposeTool.execute(
      "tc-unknown-val",
      makeSamplePlanParams({
        assertions: [
          {
            id: "VAL-KNOWN-001",
            title: "Known",
            description: "Defined assertion",
          },
        ],
        features: [
          {
            id: "feat-1",
            title: "Feature 1",
            description: "Claims unknown VAL",
            milestone: "M1",
            fulfills: ["VAL-KNOWN-001", "VAL-GHOST-999"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(unknownValRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(unknownValRes.content[0].text, /VAL-GHOST-999/);
    assert.match(unknownValRes.content[0].text, /unknown assertion/i);

    // 4. Duplicate fulfills claiming the same VAL-* across multiple features (1-to-1 leaf rule)
    const dupFulfillsRes = await proposeTool.execute(
      "tc-dup-fulfills",
      makeSamplePlanParams({
        assertions: [
          {
            id: "VAL-SHARED-001",
            title: "Shared assertion",
            description: "Must be owned by one feature",
          },
        ],
        features: [
          {
            id: "feat-alpha",
            title: "Alpha",
            description: "First claimant",
            milestone: "M1",
            fulfills: ["VAL-SHARED-001"],
          },
          {
            id: "feat-beta",
            title: "Beta",
            description: "Second claimant",
            milestone: "M1",
            fulfills: ["VAL-SHARED-001"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(dupFulfillsRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(dupFulfillsRes.content[0].text, /Duplicate fulfills claim/i);
    assert.match(dupFulfillsRes.content[0].text, /VAL-SHARED-001/);
    assert.match(dupFulfillsRes.content[0].text, /feat-alpha/);
    assert.match(dupFulfillsRes.content[0].text, /feat-beta/);

    // 5. Duplicate assertion IDs & duplicate feature IDs
    const dupIdsValidation = validateProposedSwarmPlan(
      makeSamplePlanParams({
        assertions: [
          { id: "VAL-DUP-001", title: "One", description: "First" },
          { id: "VAL-DUP-001", title: "Two", description: "Duplicate" },
        ],
        features: [
          {
            id: "same-feat",
            title: "F1",
            description: "First",
            milestone: "M1",
            fulfills: ["VAL-DUP-001"],
          },
          {
            id: "same-feat",
            title: "F2",
            description: "Second",
            milestone: "M1",
          },
        ],
      }),
    );
    assert.equal(dupIdsValidation.valid, false);
    if (!dupIdsValidation.valid) {
      assert.ok(
        dupIdsValidation.issues.some((i) =>
          /Duplicate assertion id "VAL-DUP-001"/.test(i.message),
        ),
      );
      assert.ok(
        dupIdsValidation.issues.some((i) =>
          /Duplicate feature id "same-feat"/.test(i.message),
        ),
      );
    }
  });

  it("rejects depends_on unknown targets, self-cycles, and multi-hop dependency cycles with SwarmProtocolError('INVALID_INPUT')", async () => {
    // Direct helper throws genuine SwarmProtocolError("INVALID_INPUT", ...)
    assert.throws(
      () =>
        assertFeatureDependencyDag([
          { id: "feat-self", dependsOn: ["feat-self"] },
        ]),
      (err: unknown) =>
        err instanceof SwarmProtocolError &&
        err.code === "INVALID_INPUT" &&
        /self-cycle/i.test(err.message),
    );

    assert.throws(
      () =>
        assertFeatureDependencyDag([
          { id: "feat-a", dependsOn: ["feat-missing"] },
        ]),
      (err: unknown) =>
        err instanceof SwarmProtocolError &&
        err.code === "INVALID_INPUT" &&
        /unknown feature "feat-missing"/i.test(err.message),
    );

    assert.throws(
      () =>
        assertFeatureDependencyDag([
          { id: "root" },
          { id: "cycle-a", dependsOn: ["cycle-b"] },
          { id: "cycle-b", dependsOn: ["cycle-c"] },
          { id: "cycle-c", dependsOn: ["cycle-a"] },
        ]),
      (err: unknown) =>
        err instanceof SwarmProtocolError &&
        err.code === "INVALID_INPUT" &&
        /cycle-a -> cycle-b -> cycle-c -> cycle-a/.test(err.message),
    );

    // Pre-modal tool execution rejects cycles before confirmProposal
    const harness = new MockPiHarness();
    let confirmCalls = 0;
    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => {
          confirmCalls += 1;
          return { action: "confirm", validatorEnabled: true, maxConcurrency: 3 };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });
    controller.start({ seed: "Cycle check" });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const cycleRes = await proposeTool.execute(
      "tc-cycle",
      makeSamplePlanParams({
        assertions: [
          { id: "VAL-1", title: "V1", description: "D1" },
          { id: "VAL-2", title: "V2", description: "D2" },
        ],
        features: [
          {
            id: "f1",
            title: "Feature 1",
            description: "Depends on f2",
            milestone: "M1",
            depends_on: ["f2"],
            fulfills: ["VAL-1"],
          },
          {
            id: "f2",
            title: "Feature 2",
            description: "Depends on f1",
            milestone: "M1",
            depends_on: ["f1"],
            fulfills: ["VAL-2"],
          },
        ],
      }),
      undefined,
      undefined,
      harness.createContext(),
    );

    assert.equal(cycleRes.isError, true);
    assert.equal(confirmCalls, 0);
    const details = cycleRes.details as ProposeSwarmPlanToolDetails;
    assert.equal(details.outcome, "validation_error");
    assert.equal(details.errorCode, "INVALID_INPUT");
    assert.match(cycleRes.content[0].text, /\[SwarmProtocolError:INVALID_INPUT\]/);
    assert.match(cycleRes.content[0].text, /f1 -> f2 -> f1/);
  });

  it("smart-merges assertions & features in tweak mode (preserving passed/completed state, resetting modified assertions, and blocking new features in sealed milestones)", async () => {
    const existingRun: SwarmRunState = {
      ...createMockRun({
        title: "Active Auth Mission",
        objective: "Ship auth & session",
        strategy: "Wave 1 -> Wave 2",
        acceptanceCriteria: "npm test",
        baseBranch: "main",
        maxConcurrency: 4,
        validatorEnabled: true,
      }),
      id: "run_tweak_target",
      commands: [{ name: "test", command: "npm test" }],
      boundaries: ["Keep port 3000 untouched"],
      assertions: [
        {
          id: "VAL-AUTH-001",
          title: "PKCE Login",
          description: "PKCE login issues signed session token",
          evidenceRequired: "tests/auth.test.ts passes",
          status: "passed",
          evidence: "tests/auth.test.ts: 8/8 passed",
          verifiedBy: "verifier",
          verifiedByRole: "validator",
          updatedAt: "2026-11-24T01:00:00.000Z",
        },
        {
          id: "VAL-SESS-001",
          title: "Session Refresh",
          description: "Refresh endpoint rotates session token",
          evidenceRequired: "unit test",
          status: "passed",
          evidence: "tests/session.test.ts: 4/4 passed",
          verifiedBy: "verifier",
          verifiedByRole: "validator",
          updatedAt: "2026-11-24T01:10:00.000Z",
        },
      ],
      features: [
        {
          id: "feat-login",
          title: "PKCE Login Slice",
          description: "Implement PKCE login handler",
          milestone: "M1: Core Auth",
          fulfills: ["VAL-AUTH-001"],
          status: "completed",
          assignedMember: "auth-worker",
          mergedCommitSha: "a1b2c3d4e5f6",
          updatedAt: "2026-11-24T00:55:00.000Z",
        },
        {
          id: "feat-session",
          title: "Session Refresh Slice",
          description: "Implement session rotation",
          milestone: "M2: Session",
          dependsOn: ["feat-login"],
          fulfills: ["VAL-SESS-001"],
          status: "in_progress",
          assignedMember: "sess-worker",
          updatedAt: "2026-11-24T01:08:00.000Z",
        },
      ],
      milestones: [
        {
          label: "M1: Core Auth",
          status: "done",
          owner: "verifier",
          sealed: true,
          sealedAt: "2026-11-24T01:02:00.000Z",
        },
        {
          label: "M2: Session",
          status: "in_progress",
        },
      ],
    };

    const mockStore = {
      loadRun: async (runId: string) => {
        if (runId === existingRun.id) {
          return structuredClone(existingRun);
        }
        throw new SwarmProtocolError("NOT_FOUND", `Run ${runId} not found`);
      },
    } as unknown as ISwarmStore;

    const harness = new MockPiHarness();
    let confirmCalls = 0;
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const controller = registerDraftingTools(harness.api, {
      store: mockStore,
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          confirmCalls += 1;
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({
      mode: "tweak",
      targetRunId: existingRun.id,
      seed: "Add audit logging milestone and tighten session refresh evidence",
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
    });

    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // 1. Reject adding a new feature into already sealed "M1: Core Auth" BEFORE modal
    const sealedErrRes = await proposeTool.execute(
      "tc-tweak-sealed-err",
      makeSamplePlanParams({
        assertions: [
          {
            id: "VAL-AUTH-001",
            title: "PKCE Login",
            description: "PKCE login issues signed session token",
            evidence_required: "tests/auth.test.ts passes",
          },
          {
            id: "VAL-SESS-001",
            title: "Session Refresh",
            description: "Refresh endpoint rotates session token",
            evidence_required: "unit test",
          },
          {
            id: "VAL-EXTRA-001",
            title: "Extra Auth Check",
            description: "Intruding into sealed milestone",
          },
        ],
        features: [
          {
            id: "feat-login",
            title: "PKCE Login Slice",
            description: "Implement PKCE login handler",
            milestone: "M1: Core Auth",
            fulfills: ["VAL-AUTH-001"],
          },
          {
            id: "feat-intruder",
            title: "Intruder Feature",
            description: "Attempts to enter sealed M1: Core Auth",
            milestone: "M1: Core Auth",
            fulfills: ["VAL-EXTRA-001"],
          },
          {
            id: "feat-session",
            title: "Session Refresh Slice",
            description: "Implement session rotation",
            milestone: "M2: Session",
            depends_on: ["feat-login"],
            fulfills: ["VAL-SESS-001"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );

    assert.equal(sealedErrRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(sealedErrRes.content[0].text, /\[SwarmProtocolError:INVALID_INPUT\]/);
    assert.match(sealedErrRes.content[0].text, /sealed milestone "M1: Core Auth"/i);
    assert.equal(controller.isActive(), true);

    // 2. Valid tweak:
    // - VAL-AUTH-001 unchanged -> preserves "passed" + evidence + verifiedBy
    // - VAL-SESS-001 evidence_required changed -> resets to "pending" & clears stale evidence
    // - VAL-AUDIT-001 added -> "pending"
    // - feat-login -> preserves "completed" + mergedCommitSha
    // - feat-session -> preserves "in_progress" + assignedMember
    // - feat-audit added in new milestone "M3: Audit" -> "pending"
    // - sealed milestone "M1: Core Auth" stays sealed!
    const validTweakRes = await proposeTool.execute(
      "tc-tweak-ok",
      makeSamplePlanParams({
        assertions: [
          {
            id: "VAL-AUTH-001",
            title: "PKCE Login (Retitled)",
            description: "PKCE login issues signed session token",
            evidence_required: "tests/auth.test.ts passes",
          },
          {
            id: "VAL-SESS-001",
            title: "Session Refresh",
            description: "Refresh endpoint rotates session token",
            evidence_required: "integration replay-detection test",
          },
          {
            id: "VAL-AUDIT-001",
            title: "Audit Log",
            description: "Writes JSONL audit entries",
            evidence_required: "tests/audit.test.ts passes",
          },
        ],
        features: [
          {
            id: "feat-login",
            title: "PKCE Login Slice",
            description: "Implement PKCE login handler",
            milestone: "M1: Core Auth",
            fulfills: ["VAL-AUTH-001"],
          },
          {
            id: "feat-session",
            title: "Session Refresh Slice",
            description: "Implement session rotation",
            milestone: "M2: Session",
            depends_on: ["feat-login"],
            fulfills: ["VAL-SESS-001"],
          },
          {
            id: "feat-audit",
            title: "Audit Trail Slice",
            description: "Add structured audit trail",
            milestone: "M3: Audit",
            depends_on: ["feat-session"],
            fulfills: ["VAL-AUDIT-001"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );

    assert.equal(validTweakRes.isError, undefined);
    assert.equal(confirmCalls, 1);
    assert.equal(confirmedPlans.length, 1);

    const tweakedPlan = confirmedPlans[0]!;
    // Unchanged commands & boundaries preserved from existingRun when omitted in tweak params
    assert.deepEqual(tweakedPlan.commands, [{ name: "test", command: "npm test" }]);
    assert.deepEqual(tweakedPlan.boundaries, ["Keep port 3000 untouched"]);

    const aAuth = tweakedPlan.assertions?.find((a) => a.id === "VAL-AUTH-001");
    assert.ok(aAuth);
    assert.equal(aAuth.status, "passed");
    assert.equal(aAuth.evidence, "tests/auth.test.ts: 8/8 passed");
    assert.equal(aAuth.verifiedBy, "verifier");
    assert.equal(aAuth.verifiedByRole, "validator");
    assert.equal(aAuth.title, "PKCE Login (Retitled)");

    const aSess = tweakedPlan.assertions?.find((a) => a.id === "VAL-SESS-001");
    assert.ok(aSess);
    assert.equal(aSess.status, "pending");
    assert.equal(aSess.evidence, undefined);
    assert.equal(aSess.verifiedBy, undefined);

    const aAudit = tweakedPlan.assertions?.find((a) => a.id === "VAL-AUDIT-001");
    assert.ok(aAudit);
    assert.equal(aAudit.status, "pending");

    const fLogin = tweakedPlan.features?.find((f) => f.id === "feat-login");
    assert.ok(fLogin);
    assert.equal(fLogin.status, "completed");
    assert.equal(fLogin.mergedCommitSha, "a1b2c3d4e5f6");
    assert.equal(fLogin.assignedMember, "auth-worker");

    const fSession = tweakedPlan.features?.find((f) => f.id === "feat-session");
    assert.ok(fSession);
    assert.equal(fSession.status, "in_progress");
    assert.equal(fSession.assignedMember, "sess-worker");

    const fAudit = tweakedPlan.features?.find((f) => f.id === "feat-audit");
    assert.ok(fAudit);
    assert.equal(fAudit.status, "pending");

    assert.deepEqual(tweakedPlan.milestones, [
      {
        label: "M1: Core Auth",
        status: "done",
        owner: "verifier",
        sealed: true,
        sealedAt: "2026-11-24T01:02:00.000Z",
      },
      {
        label: "M2: Session",
        status: "in_progress",
      },
      {
        label: "M3: Audit",
        status: "pending",
      },
    ]);

    // Also verify deriveMilestonesFromFeatures unseals a milestone if its fulfilled assertion resets to pending
    const unsealedCheck = deriveMilestonesFromFeatures(
      [fLogin],
      existingRun.milestones,
      [{ ...aAuth, status: "pending" }],
    );
    assert.equal(unsealedCheck[0]?.sealed, undefined);
  });

  it("renders crisp collapsed counts and rich expanded Commands & Boundaries, Validation Contract (VAL-*), and Features by Milestone views + Droid contract prompts", () => {
    const harness = new MockPiHarness();
    registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => ({
          action: "cancel",
          validatorEnabled: true,
          maxConcurrency: 4,
        }),
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const theme = createMockTheme();

    const missionParams = makeSamplePlanParams({
      commands: [
        { name: "typecheck", command: "npm run typecheck" },
        { name: "test", command: "npm test" },
      ],
      boundaries: ["Never modify prod-secrets/", "Use ports 4500-4510"],
      assertions: [
        {
          id: "VAL-AUTH-001",
          title: "PKCE Exchange",
          description: "Validates code_verifier and issues token",
          evidence_required: "tests/auth.test.ts green",
        },
        {
          id: "VAL-AUDIT-001",
          title: "Audit Log",
          description: "Appends JSONL security event",
          evidence_required: "tests/audit.test.ts green",
        },
        {
          id: "VAL-INT-001",
          title: "End-to-End Flow",
          description: "Full login + audit smoke check",
        },
      ],
      features: [
        {
          id: "oauth-pkce",
          title: "OAuth PKCE",
          description: "PKCE token endpoint",
          milestone: "M1: Foundation",
          files_owned: ["src/auth/pkce.ts"],
          fulfills: ["VAL-AUTH-001"],
        },
        {
          id: "audit-logger",
          title: "Audit Logger",
          description: "JSONL audit event writer",
          milestone: "M1: Foundation",
          files_owned: ["src/audit/logger.ts"],
          fulfills: ["VAL-AUDIT-001"],
        },
        {
          id: "auth-integration",
          title: "Auth Integration",
          description: "Wire PKCE with audit logger",
          milestone: "M2: Integration",
          depends_on: ["oauth-pkce", "audit-logger"],
          files_owned: ["src/auth/index.ts"],
          fulfills: ["VAL-INT-001"],
        },
      ],
    });

    // Collapsed renderCall includes crisp counts: 3 features · 3 VAL assertions · 2 milestones
    const collapsedText = proposeTool
      .renderCall(missionParams, theme, { expanded: false } as any)
      .render(180)
      .join("\n");
    assert.match(collapsedText, /3 features · 3 VAL assertions · 2 milestones/);

    // Expanded renderCall & formatProposalTranscriptSummary include all 3 new sections
    const expandedText = proposeTool
      .renderCall(missionParams, theme, { expanded: true } as any)
      .render(180)
      .join("\n");
    assert.match(expandedText, /### Commands & Boundaries/);
    assert.match(expandedText, /`typecheck`: `npm run typecheck`/);
    assert.match(expandedText, /Never modify prod-secrets\//);
    assert.match(expandedText, /### Validation Contract \(VAL-\*\) \(3\)/);
    assert.match(expandedText, /`VAL-AUTH-001`/);
    assert.match(expandedText, /tests\/auth\.test\.ts green/);
    assert.match(
      expandedText,
      /### Features by Milestone \(3 features · 2 milestones\)/,
    );
    assert.match(expandedText, /#### M1: Foundation/);
    assert.match(expandedText, /#### M2: Integration/);
    assert.match(expandedText, /dependsOn/);
    assert.match(expandedText, /fulfills/);
    assert.match(expandedText, /`oauth-pkce`, `audit-logger`/);
    assert.match(expandedText, /`VAL-INT-001`/);

    // Prompts instill Operational Recon, Mission-Level TDD (VAL-* -> features), and Living Dynamic Workflow
    const kickoff = buildDraftingKickoffPrompt("Ship mission", "swarm", {
      baseBranch: "main",
    });
    const overlay = buildDraftingSystemOverlay({
      version: 2,
      mode: "swarm",
      seed: "Ship mission",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 4,
      baseBranch: "main",
    });
    const direct = buildDirectPlanPrompt("Ship mission", "main", {
      maxConcurrency: 4,
      validatorEnabled: true,
    });

    for (const [label, promptText] of [
      ["kickoff", kickoff],
      ["overlay", overlay],
      ["direct", direct],
    ] as const) {
      assert.match(promptText, /VAL-<AREA>-<NNN>/, `${label} must reference VAL-<AREA>-<NNN>`);
      assert.match(promptText, /fulfills/, `${label} must reference 100% fulfills coverage`);
      assert.match(promptText, /depends_on/, `${label} must reference depends_on DAG`);
      assert.match(promptText, /files_owned/, `${label} must reference disjoint files_owned`);
      assert.match(
        promptText,
        /swarm\{action:"mission"\}/,
        `${label} must document dynamic mid-mission extensibility via swarm{action:"mission"}`,
      );
      assert.match(
        promptText,
        /swarm\{action:"add"\}/,
        `${label} must document dynamic worker extensibility via swarm{action:"add"}`,
      );
    }
  });

  it("enforces zero Type.Union, Type.Record, anyOf, oneOf, replaceControlCharacters, and tower across drafting schemas and sources", () => {
    const forbiddenKeys: string[] = [];
    const visitSchema = (node: unknown, path: string): void => {
      if (!node || typeof node !== "object") {
        return;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          visitSchema(node[i], `${path}[${i}]`);
        }
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "anyOf" || k === "oneOf") {
          forbiddenKeys.push(`${path}.${k}`);
        }
        visitSchema(v, `${path}.${k}`);
      }
    };

    visitSchema(MissionAssertionProposalSchema, "MissionAssertionProposalSchema");
    visitSchema(MissionFeatureProposalSchema, "MissionFeatureProposalSchema");
    visitSchema(MissionCommandProposalSchema, "MissionCommandProposalSchema");
    visitSchema(ProposeSwarmPlanParamsSchema, "ProposeSwarmPlanParamsSchema");
    assert.deepEqual(forbiddenKeys, []);

    const draftToolsSource = readFileSync(
      fileURLToPath(new URL("../src/drafting/draft-tools.ts", import.meta.url)),
      "utf8",
    );
    const draftPromptsSource = readFileSync(
      fileURLToPath(new URL("../src/drafting/draft-prompts.ts", import.meta.url)),
      "utf8",
    );

    assert.equal(
      /\bType\.Union\b/.test(draftToolsSource),
      false,
      "draft-tools.ts must not use Type.Union",
    );
    assert.equal(
      /\bType\.Record\b/.test(draftToolsSource),
      false,
      "draft-tools.ts must not use Type.Record",
    );
    assert.equal(
      /\banyOf\b/.test(draftToolsSource),
      false,
      "draft-tools.ts must not contain anyOf",
    );
    assert.equal(
      /\boneOf\b/.test(draftToolsSource),
      false,
      "draft-tools.ts must not contain oneOf",
    );

    for (const [name, src] of [
      ["draft-tools.ts", draftToolsSource],
      ["draft-prompts.ts", draftPromptsSource],
    ] as const) {
      assert.equal(
        /replaceControlCharacters/.test(src),
        false,
        `${name} must not reference replaceControlCharacters`,
      );
      assert.equal(
        /tower/i.test(src),
        false,
        `${name} must not contain case-insensitive 'tower'`,
      );
    }
  });
});

// ============================================================================
// 12. v0.9.0 Mandatory Schema Contract, Services Manifest & Adversarial Review
// ============================================================================

describe("v0.9.0 mandatory contract schema, services manifest & adversarial contract review", () => {
  it("requires assertions and features (minItems: 1) in ProposeSwarmPlanParamsSchema while preserving legacy JS omission and rejecting empty [] arrays with INVALID_INPUT", async () => {
    const requiredFields = (ProposeSwarmPlanParamsSchema as { required?: string[] })
      .required ?? [];
    assert.ok(
      requiredFields.includes("assertions"),
      "ProposeSwarmPlanParamsSchema.required must include 'assertions'",
    );
    assert.ok(
      requiredFields.includes("features"),
      "ProposeSwarmPlanParamsSchema.required must include 'features'",
    );

    const assertionsProp = ProposeSwarmPlanParamsSchema.properties
      .assertions as unknown as Record<string, unknown>;
    const featuresProp = ProposeSwarmPlanParamsSchema.properties
      .features as unknown as Record<string, unknown>;
    assert.equal(assertionsProp.minItems, 1);
    assert.equal(featuresProp.minItems, 1);

    // Legacy JS direct call omitting both assertions & features still succeeds cleanly
    const legacyPlan = assertProposedSwarmPlan(
      makeSamplePlanParams({ assertions: undefined, features: undefined }),
    );
    assert.equal(legacyPlan.valid, true);
    assert.equal(legacyPlan.assertions, undefined);
    assert.equal(legacyPlan.features, undefined);

    // Empty [] arrays throw genuine SwarmProtocolError("INVALID_INPUT", ...)
    assert.throws(
      () =>
        assertProposedSwarmPlan(
          makeSamplePlanParams({
            assertions: [],
            features: [
              {
                id: "feat-1",
                title: "Feature 1",
                description: "Valid feature",
                milestone: "M1",
              },
            ],
          }),
        ),
      (err: unknown) =>
        err instanceof SwarmProtocolError &&
        err.code === "INVALID_INPUT" &&
        /assertions.*at least 1/i.test(err.message),
    );

    assert.throws(
      () =>
        assertProposedSwarmPlan(
          makeSamplePlanParams({
            assertions: [
              {
                id: "VAL-1",
                title: "Assertion 1",
                description: "Testable assertion",
              },
            ],
            features: [],
          }),
        ),
      (err: unknown) =>
        err instanceof SwarmProtocolError &&
        err.code === "INVALID_INPUT" &&
        /features.*at least 1/i.test(err.message),
    );

    assert.throws(
      () =>
        assertProposedSwarmPlan(
          makeSamplePlanParams({ assertions: [], features: [] }),
        ),
      (err: unknown) =>
        err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
    );

    // Tool execute rejects empty [] arrays before opening confirmation modal
    const harness = new MockPiHarness();
    let confirmCalls = 0;
    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => {
          confirmCalls += 1;
          return { action: "confirm", validatorEnabled: true, maxConcurrency: 3 };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });
    controller.start({ seed: "Empty array guard" });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const ctx = harness.createContext();

    const emptyBothRes = await proposeTool.execute(
      "tc-empty-arrays",
      proposeTool.prepareArguments({
        ...makeSamplePlanParams(),
        assertions: [],
        features: [],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(emptyBothRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.equal(
      (emptyBothRes.details as ProposeSwarmPlanToolDetails).errorCode,
      "INVALID_INPUT",
    );
    assert.match(emptyBothRes.content[0].text, /\[SwarmProtocolError:INVALID_INPUT\]/);

    // Legacy JS tool execute omitting assertions & features succeeds
    const legacyExecRes = await proposeTool.execute(
      "tc-legacy-ok",
      proposeTool.prepareArguments(makeSamplePlanParams()),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(legacyExecRes.isError, undefined);
    assert.equal(confirmCalls, 1);
  });

  it("normalizes services manifest, merges in tweak mode, renders in renderCall & transcript summary, and rejects duplicate ports & service depends_on cycles", async () => {
    const portProp = MissionServiceProposalSchema.properties
      .port as unknown as Record<string, unknown>;
    assert.equal(portProp.type, "integer");
    assert.equal(portProp.minimum, 1);
    assert.equal(portProp.maximum, 65535);

    // Direct helper throws SwarmProtocolError("INVALID_INPUT") on duplicate ports & DAG cycles
    assert.throws(
      () =>
        assertServiceManifest([
          { name: "api", port: 4100 },
          { name: "web", port: 4100 },
        ]),
      (err: unknown) =>
        err instanceof SwarmProtocolError &&
        err.code === "INVALID_INPUT" &&
        /Duplicate service port 4100/i.test(err.message),
    );

    assert.throws(
      () =>
        assertServiceManifest([
          { name: "api", port: 4100, dependsOn: ["worker"] },
          { name: "worker", port: 4101, dependsOn: ["api"] },
        ]),
      (err: unknown) =>
        err instanceof SwarmProtocolError &&
        err.code === "INVALID_INPUT" &&
        /api -> worker -> api/.test(err.message),
    );

    assert.throws(
      () =>
        assertServiceManifest([
          { name: "api", port: 4100, dependsOn: ["missing-db"] },
        ]),
      (err: unknown) =>
        err instanceof SwarmProtocolError &&
        err.code === "INVALID_INPUT" &&
        /unknown service "missing-db"/i.test(err.message),
    );

    const harness = new MockPiHarness();
    let confirmCalls = 0;
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const existingRun: SwarmRunState = {
      ...createMockRun({
        title: "Services Tweak Base",
        objective: "Run DB + API",
        strategy: "Wave 1 -> Wave 2",
        acceptanceCriteria: "npm test",
        baseBranch: "main",
        maxConcurrency: 4,
        validatorEnabled: true,
      }),
      id: "run_svc_tweak",
      services: [
        {
          name: "postgres",
          start: "pg_ctl -D .pg start -o '-p 5439'",
          stop: "pg_ctl -D .pg stop",
          healthcheck: "pg_isready -p 5439",
          port: 5439,
        },
      ],
      assertions: [
        {
          id: "VAL-DB-001",
          title: "DB Ready",
          description: "Postgres responds on 5439",
          status: "passed",
          overridden: true,
          overrideJustification:
            "Verified against local embedded Postgres fixture in CI environment.",
          evidence: "[OVERRIDE] Verified against local embedded Postgres fixture.",
          updatedAt: "2026-11-24T08:00:00.000Z",
        },
      ],
      features: [
        {
          id: "db-bootstrap",
          title: "DB Bootstrap",
          description: "Configure embedded DB",
          milestone: "M1",
          fulfills: ["VAL-DB-001"],
          status: "completed",
          mergedCommitSha: "deadbeef1234",
          updatedAt: "2026-11-24T08:00:00.000Z",
        },
      ],
    };

    const mockStore = {
      loadRun: async (id: string) => {
        if (id === existingRun.id) return structuredClone(existingRun);
        throw new SwarmProtocolError("NOT_FOUND", `Run ${id} not found`);
      },
    } as unknown as ISwarmStore;

    const controller = registerDraftingTools(harness.api, {
      store: mockStore,
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          confirmCalls += 1;
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({ mode: "swarm", seed: "Service stack" });
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const ctx = harness.createContext();

    // 1. Reject duplicate service ports before modal
    const dupPortRes = await proposeTool.execute(
      "tc-dup-port",
      proposeTool.prepareArguments({
        ...makeSamplePlanParams(),
        assertions: [{ id: "VAL-SVC-001", title: "API", description: "Serves HTTP" }],
        features: [
          {
            id: "api-server",
            title: "API Server",
            description: "Start HTTP server",
            milestone: "M1",
            fulfills: ["VAL-SVC-001"],
          },
        ],
        services: [
          { name: "api", start: "npm run start:api -- --port 4200", port: 4200 },
          { name: "admin", start: "npm run start:admin -- --port 4200", port: 4200 },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(dupPortRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(dupPortRes.content[0].text, /Duplicate service port 4200/i);

    // 2. Reject service depends_on cycle before modal
    const svcCycleRes = await proposeTool.execute(
      "tc-svc-cycle",
      proposeTool.prepareArguments({
        ...makeSamplePlanParams(),
        assertions: [{ id: "VAL-SVC-001", title: "API", description: "Serves HTTP" }],
        features: [
          {
            id: "api-server",
            title: "API Server",
            description: "Start HTTP server",
            milestone: "M1",
            fulfills: ["VAL-SVC-001"],
          },
        ],
        services: [
          { name: "gateway", start: "node gateway.js", port: 4201, depends_on: ["auth"] },
          { name: "auth", start: "node auth.js", port: 4202, depends_on: ["gateway"] },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(svcCycleRes.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(svcCycleRes.content[0].text, /gateway -> auth -> gateway/);

    // 3. Valid services normalization + collapsed & expanded renderCall + transcript summary
    const validSvcArgs = proposeTool.prepareArguments({
      ...makeSamplePlanParams({ initial_members: undefined }),
      commands: [
        { name: "init", command: "npm run generate:types" },
        { name: "test", command: "npm test" },
      ],
      services: [
        {
          name: " redis ",
          start: " redis-server --port 6389 ",
          stop: " redis-cli -p 6389 shutdown ",
          healthcheck: " redis-cli -p 6389 ping ",
          port: 6389,
        },
        {
          name: " api ",
          start: " PORT=4300 node server.js ",
          healthcheck: " curl -sf http://127.0.0.1:4300/healthz ",
          port: 4300,
          depends_on: [" redis "],
        },
      ],
      assertions: [
        {
          id: "VAL-SVC-001",
          title: "API Healthz",
          description: "GET /healthz returns 200 OK with Redis connected",
          evidence_required: "curl -sf http://127.0.0.1:4300/healthz",
        },
      ],
      features: [
        {
          id: "api-health",
          title: "API Health Endpoint",
          description: "Implement /healthz with Redis ping",
          milestone: "M1: Core Services",
          files_owned: ["src/server.ts"],
          fulfills: ["VAL-SVC-001"],
        },
      ],
    });

    const theme = createMockTheme();
    const collapsedSvc = proposeTool
      .renderCall(validSvcArgs, theme, { expanded: false } as any)
      .render(180)
      .join("\n");
    assert.match(
      collapsedSvc,
      /1 feature · 1 VAL assertion · 1 milestone · 2 services \(:6389, :4300\)/,
    );

    const expandedSvc = proposeTool
      .renderCall(validSvcArgs, theme, { expanded: true } as any)
      .render(180)
      .join("\n");
    assert.match(expandedSvc, /\*\*Services & Ports:\*\*/);
    assert.match(expandedSvc, /\*\*redis\*\* \(`:6389`\)/);
    assert.match(expandedSvc, /\*\*api\*\* \(`:4300`\).*dependsOn: `redis`/);

    const okSvcRes = await proposeTool.execute(
      "tc-svc-ok",
      validSvcArgs,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(okSvcRes.isError, undefined);
    assert.equal(confirmCalls, 1);
    assert.deepEqual(confirmedPlans[0]?.services, [
      {
        name: "redis",
        start: "redis-server --port 6389",
        stop: "redis-cli -p 6389 shutdown",
        healthcheck: "redis-cli -p 6389 ping",
        port: 6389,
      },
      {
        name: "api",
        start: "PORT=4300 node server.js",
        healthcheck: "curl -sf http://127.0.0.1:4300/healthz",
        port: 4300,
        dependsOn: ["redis"],
      },
    ]);

    // 4. Tweak mode merges existingRun.services (and rejects port collision against carried-over service) + preserves overridden assertion metadata
    controller.start({
      mode: "tweak",
      targetRunId: existingRun.id,
      seed: "Add HTTP API on top of existing postgres",
    });

    const tweakPortCollision = await proposeTool.execute(
      "tc-tweak-svc-port-clash",
      proposeTool.prepareArguments({
        ...makeSamplePlanParams(),
        assertions: [
          {
            id: "VAL-DB-001",
            title: "DB Ready",
            description: "Postgres responds on 5439",
          },
        ],
        features: [
          {
            id: "db-bootstrap",
            title: "DB Bootstrap",
            description: "Configure embedded DB",
            milestone: "M1",
            fulfills: ["VAL-DB-001"],
          },
        ],
        services: [{ name: "api", start: "node api.js", port: 5439 }],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(tweakPortCollision.isError, true);
    assert.match(tweakPortCollision.content[0].text, /Duplicate service port 5439/i);

    const tweakMergeOk = await proposeTool.execute(
      "tc-tweak-svc-merge-ok",
      proposeTool.prepareArguments({
        ...makeSamplePlanParams(),
        assertions: [
          {
            id: "VAL-DB-001",
            title: "DB Ready",
            description: "Postgres responds on 5439",
          },
          {
            id: "VAL-API-001",
            title: "API Ready",
            description: "API responds on 4400",
          },
        ],
        features: [
          {
            id: "db-bootstrap",
            title: "DB Bootstrap",
            description: "Configure embedded DB",
            milestone: "M1",
            fulfills: ["VAL-DB-001"],
          },
          {
            id: "api-layer",
            title: "API Layer",
            description: "Add HTTP server depending on postgres",
            milestone: "M2",
            depends_on: ["db-bootstrap"],
            fulfills: ["VAL-API-001"],
          },
        ],
        services: [
          {
            name: "api",
            start: "PORT=4400 node api.js",
            port: 4400,
            depends_on: ["postgres"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(tweakMergeOk.isError, undefined);
    const mergedTweakPlan = confirmedPlans[1]!;
    assert.equal(mergedTweakPlan.services?.length, 2);
    assert.equal(mergedTweakPlan.services?.[0]?.name, "postgres");
    assert.equal(mergedTweakPlan.services?.[1]?.name, "api");
    assert.deepEqual(mergedTweakPlan.services?.[1]?.dependsOn, ["postgres"]);
    const preservedDbAssert = mergedTweakPlan.assertions?.find(
      (a) => a.id === "VAL-DB-001",
    );
    assert.equal(preservedDbAssert?.overridden, true);
    assert.match(
      preservedDbAssert?.overrideJustification ?? "",
      /embedded Postgres fixture/,
    );
  });

  it("bounces blocking reviewProposedContract findings on Pass 1 (skipping modal & keeping draft active) and proceeds cleanly to confirmation on Pass 2", async () => {
    const harness = new MockPiHarness();
    let confirmCalls = 0;
    let reviewerCalls = 0;
    const confirmedPlans: ProposedSwarmPlan[] = [];
    let reviewerImpl: (plan: ProposedSwarmPlan) => Promise<ContractReviewResult | undefined> =
      async () => ({
        approved: false,
        summary: "Missing rate-limit assertion and speculative npx command.",
        findings: [
          {
            severity: "blocking",
            category: "missing_assertion",
            message: "Objective requires brute-force protection, but no VAL-RATE-* assertion exists.",
            suggestion: "Add VAL-RATE-001 asserting 429 response after 5 failed attempts.",
          },
          {
            severity: "warning",
            category: "invalid_command",
            message: "Prefer npm test over ad-hoc runner flags.",
          },
        ],
      });

    const controller = registerDraftingTools(harness.api, {
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          confirmCalls += 1;
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
      reviewProposedContract: async (plan) => {
        reviewerCalls += 1;
        return reviewerImpl(plan);
      },
    });

    controller.start({
      mode: "swarm",
      seed: "Add login + brute-force rate limiter",
      validatorEnabled: true,
      maxConcurrency: 4,
    });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const ctx = harness.createContext();
    const theme = createMockTheme();

    // Pass 1: reviewer rejects -> skips confirmProposal, keeps draft active, returns structured findings
    const pass1Res = await proposeTool.execute(
      "tc-review-pass1",
      proposeTool.prepareArguments({
        ...makeSamplePlanParams(),
        assertions: [
          {
            id: "VAL-AUTH-001",
            title: "Login Token",
            description: "Valid credentials return signed JWT",
          },
        ],
        features: [
          {
            id: "login-jwt",
            title: "JWT Login",
            description: "Implement POST /login",
            milestone: "M1",
            fulfills: ["VAL-AUTH-001"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );

    assert.equal(pass1Res.isError, undefined);
    assert.equal(reviewerCalls, 1);
    assert.equal(confirmCalls, 0);
    assert.equal(confirmedPlans.length, 0);
    assert.equal(controller.isActive(), true);

    const pass1Details = pass1Res.details as ProposeSwarmPlanToolDetails;
    assert.equal(pass1Details.status, "contract_review_changes_requested");
    assert.equal(pass1Details.outcome, "contract_review_changes_requested");
    assert.equal(pass1Details.reviewPass, 1);
    assert.match(pass1Res.content[0].text, /contract_review_changes_requested/);
    assert.match(pass1Res.content[0].text, /\[BLOCKING\] \(missing_assertion\)/);
    assert.match(pass1Res.content[0].text, /VAL-RATE-001/);
    assert.match(pass1Res.content[0].text, /\[WARNING\] \(invalid_command\)/);

    // Verify renderResult formats contract_review_changes_requested cleanly in collapsed & expanded modes
    const collapsedBounce = proposeTool
      .renderResult(pass1Res, { expanded: false } as any, theme, {} as any)
      .render(160)
      .join("\n");
    assert.match(collapsedBounce, /\[CONTRACT REVIEW\]/);
    assert.match(collapsedBounce, /2 findings/);

    const expandedBounce = proposeTool
      .renderResult(pass1Res, { expanded: true } as any, theme, {} as any)
      .render(160)
      .join("\n");
    assert.match(expandedBounce, /\[CONTRACT REVIEW · CHANGES REQUESTED\]/);
    assert.match(expandedBounce, /VAL-RATE-001/);

    // Pass 2 (even if reviewer is still picky and returns approved: false!):
    // Max 1 automatic bounce per draft -> attaches remaining notes to plan summary & proceeds to confirmProposal!
    const pass2Res = await proposeTool.execute(
      "tc-review-pass2",
      proposeTool.prepareArguments({
        ...makeSamplePlanParams(),
        assertions: [
          {
            id: "VAL-AUTH-001",
            title: "Login Token",
            description: "Valid credentials return signed JWT",
          },
          {
            id: "VAL-RATE-001",
            title: "Brute-Force Rate Limit",
            description: "Returns 429 after 5 failed login attempts",
          },
        ],
        features: [
          {
            id: "login-jwt",
            title: "JWT Login",
            description: "Implement POST /login",
            milestone: "M1",
            fulfills: ["VAL-AUTH-001"],
          },
          {
            id: "rate-limiter",
            title: "Login Rate Limiter",
            description: "Enforce 5-attempt window",
            milestone: "M1",
            fulfills: ["VAL-RATE-001"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );

    assert.equal(pass2Res.isError, undefined);
    assert.equal(reviewerCalls, 2);
    assert.equal(confirmCalls, 1);
    assert.equal(confirmedPlans.length, 1);
    assert.equal(
      (pass2Res.details as ProposeSwarmPlanToolDetails).outcome,
      "confirmed",
    );
    assert.match(
      confirmedPlans[0]?.feedback ?? "",
      /Adversarial Contract Review \(Pass 2\)/,
    );
    assert.match(pass2Res.content[0].text, /Adversarial Contract Review \(Pass 2\)/);

    // Also verify validatorEnabled: false skips reviewProposedContract entirely
    controller.start({
      mode: "swarm",
      seed: "Fast unvalidated draft",
      validatorEnabled: false,
      maxConcurrency: 2,
    });
    const prevReviewerCalls = reviewerCalls;
    const noValRes = await proposeTool.execute(
      "tc-review-disabled",
      proposeTool.prepareArguments({
        ...makeSamplePlanParams({ validator_enabled: false }),
        assertions: [{ id: "VAL-FAST-001", title: "Fast", description: "Check" }],
        features: [
          {
            id: "fast-feat",
            title: "Fast Feat",
            description: "Quick slice",
            milestone: "M1",
            fulfills: ["VAL-FAST-001"],
          },
        ],
      }),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(noValRes.isError, undefined);
    assert.equal(reviewerCalls, prevReviewerCalls);

    // Verify upgraded v0.9.0 prompts include MANDATORY assertions/features, "init", services, Adversarial Contract Review & dispatch_ready
    const kickoff = buildDraftingKickoffPrompt("Build fullstack app", "swarm");
    const overlay = buildDraftingSystemOverlay({
      version: 2,
      mode: "swarm",
      seed: "Build fullstack app",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 4,
    });
    const direct = buildDirectPlanPrompt("Build fullstack app", "main", {
      maxConcurrency: 4,
      validatorEnabled: true,
    });
    for (const [name, promptText] of [
      ["kickoff", kickoff],
      ["overlay", overlay],
      ["direct", direct],
    ] as const) {
      assert.match(promptText, /MANDATORY/, `${name} must emphasize MANDATORY contract`);
      assert.match(promptText, /services/, `${name} must mention services manifest`);
      assert.match(promptText, /init/, `${name} must mention optional init setup command`);
      assert.match(
        promptText,
        /Adversarial Contract Review/,
        `${name} must mention Adversarial Contract Review`,
      );
      assert.match(
        promptText,
        /dispatch_ready/,
        `${name} must mention mission_op:"dispatch_ready"`,
      );
    }
  });

  it("maintains zero Type.Union, Type.Record, anyOf, oneOf, replaceControlCharacters, and tower across v0.9.0 MissionServiceProposalSchema and sources", () => {
    const forbiddenKeys: string[] = [];
    const visitSchema = (node: unknown, path: string): void => {
      if (!node || typeof node !== "object") {
        return;
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          visitSchema(node[i], `${path}[${i}]`);
        }
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "anyOf" || k === "oneOf") {
          forbiddenKeys.push(`${path}.${k}`);
        }
        visitSchema(v, `${path}.${k}`);
      }
    };

    visitSchema(MissionServiceProposalSchema, "MissionServiceProposalSchema");
    visitSchema(ProposeSwarmPlanParamsSchema, "ProposeSwarmPlanParamsSchema");
    assert.deepEqual(forbiddenKeys, []);

    const draftToolsSource = readFileSync(
      fileURLToPath(new URL("../src/drafting/draft-tools.ts", import.meta.url)),
      "utf8",
    );
    const draftPromptsSource = readFileSync(
      fileURLToPath(new URL("../src/drafting/draft-prompts.ts", import.meta.url)),
      "utf8",
    );

    assert.equal(/\bType\.Union\b/.test(draftToolsSource), false);
    assert.equal(/\bType\.Record\b/.test(draftToolsSource), false);
    assert.equal(/\banyOf\b/.test(draftToolsSource), false);
    assert.equal(/\boneOf\b/.test(draftToolsSource), false);
    assert.equal(/replaceControlCharacters/.test(draftToolsSource), false);
    assert.equal(/replaceControlCharacters/.test(draftPromptsSource), false);
    assert.equal(/tower/i.test(draftToolsSource), false);
    assert.equal(/tower/i.test(draftPromptsSource), false);
  });
});

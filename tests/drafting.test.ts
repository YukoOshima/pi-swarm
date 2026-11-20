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
  ORCHESTRATOR_TOOLS,
  PROPOSE_SWARM_PLAN_TOOL,
  SWARM_BOARD_POST_TOOL,
  SWARM_BOARD_READ_TOOL,
  SWARM_DRAFT_ENTRY,
  SWARM_FINDING_TOOL,
  SWARM_KILL_TOOL,
  SWARM_MERGE_TOOL,
  SWARM_MISSION_TOOL,
  SWARM_MODEL_TOOL,
  SWARM_PLAN_ADD_TOOL,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_QUESTION_TOOL,
  SWARM_SPAWN_TOOL,
  SWARM_STATUS_TOOL,
  SWARM_TEARDOWN_TOOL,
  SWARM_VERIFY_TOOL,
} from "../src/constants.js";
import {
  applySwarmToolProfile,
  buildDirectPlanPrompt,
  buildDraftingKickoffPrompt,
  buildDraftingSystemOverlay,
  buildRoleModelsFromSettings,
  clearDraft,
  computePreviewWaves,
  createDraftingTools,
  DraftStateController,
  escapeXml,
  formatProposalTranscriptSummary,
  getSwarmToolsForMode,
  IDLE_SWARM_TOOLS,
  isDraftActive,
  rehydrateDraft,
  registerDraftingTools,
  startDraft,
  startOrResolveDraft,
  updateDraft,
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
  type ISwarmStore,
  type IWorktreeManager,
  type MissionPlanInput,
  type PlanValidationOptions,
  type PlanValidationResult,
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
      SWARM_STATUS_TOOL,
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

function createMockStore(
  validateImpl?: (
    missions: MissionPlanInput[],
    options?: PlanValidationOptions,
  ) => PlanValidationResult,
): ISwarmStore {
  const defaultValidate = (
    missions: MissionPlanInput[],
    options?: PlanValidationOptions,
  ): PlanValidationResult => {
    const waves = computePreviewWaves(missions);
    const branches: Record<string, string> = {};
    const existing = new Set(options?.existingBranches ?? []);
    const errors: PlanValidationResult["errors"] = [];

    for (const m of missions) {
      if (/[^\x20-\x7E]/.test(m.title)) {
        errors.push({
          code: "INVALID_TITLE",
          missionId: m.id,
          message: `Mission "${m.id}" title must be printable ASCII.`,
        });
      }
      const slug = m.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const branch = `feat/${slug || m.id.toLowerCase()}`;
      if (existing.has(branch)) {
        errors.push({
          code: "DUPLICATE_BRANCH",
          missionId: m.id,
          message: `Branch "${branch}" already exists locally.`,
        });
      }
      branches[m.id] = branch;
    }

    return {
      valid: errors.length === 0,
      errors,
      waves,
      branches,
    };
  };

  return {
    projectRoot: "/tmp/mock-repo",
    validatePlan: validateImpl ?? defaultValidate,
  } as unknown as ISwarmStore;
}

function createMockWorktree(opts?: {
  currentBranch?: string;
  localBranches?: string[];
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
    listLocalBranches: async () => opts?.localBranches ?? ["main"],
  } as unknown as IWorktreeManager;
}

function createMockRun(plan: ProposedSwarmPlan): SwarmRunState {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: "run-20261120-abc",
    objective: plan.objective,
    verificationContract: plan.verificationContract,
    baseBranch: plan.baseBranch,
    ownerSessionId: "sess-test-1",
    ownerPid: process.pid,
    status: "active",
    maxConcurrency: plan.maxConcurrency,
    validatorEnabled: plan.validatorEnabled,
    maxValidationRounds: DEFAULT_SWARM_SETTINGS.maxValidationRounds,
    finalValidatorEnabled:
      plan.finalValidatorEnabled ?? DEFAULT_SWARM_SETTINGS.finalValidatorEnabled,
    maxFinalAuditRounds: DEFAULT_SWARM_SETTINGS.maxFinalAuditRounds,
    autoFixOnAuditFail: DEFAULT_SWARM_SETTINGS.autoFixOnAuditFail,
    keepWorkersWarm: DEFAULT_SWARM_SETTINGS.keepWorkersWarm,
    finalAuditStatus: "idle",
    finalAuditRound: 0,
    ...(plan.roleModels ? { roleModels: plan.roleModels } : {}),
    revision: 1,
    missions: {},
    missionOrder: plan.missions.map((m) => m.id),
    roster: {},
    findings: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeSamplePlanParams(): ProposeSwarmPlanParams {
  return {
    objective: "Implement OAuth login and audit logging",
    verification_contract: "npm test && npm run typecheck passes with 0 errors",
    missions: [
      {
        id: "M1",
        title: "Survey auth middleware",
        kind: "survey",
        description: "Inspect existing auth hooks and token storage.",
        scope: ["src/auth"],
        deps: [],
        verification: `Record architecture findings via ${SWARM_FINDING_TOOL}`,
      },
      {
        id: "M2",
        title: "Add OAuth provider client",
        kind: "build",
        description: "Implement OAuth token exchange client and unit tests.",
        scope: ["src/oauth", "tests/oauth.test.ts"],
        deps: ["M1"],
        verification: "npm run test:file -- tests/oauth.test.ts",
        tasks: [
          { id: "t1", title: "Implement OAuth client" },
          { id: "t2", title: "Add unit tests" },
        ],
      },
      {
        id: "M3",
        title: "Add audit logger module",
        kind: "build",
        description: "Add structured security audit logger.",
        scope: ["src/audit", "tests/audit.test.ts"],
        deps: ["M1"],
        verification: "npm run test:file -- tests/audit.test.ts",
      },
      {
        id: "M4",
        title: "Write migration runbook",
        kind: "artifact",
        description: "Produce rollout runbook for operators.",
        scope: ["docs/oauth-runbook.md"],
        deps: ["M2", "M3"],
        verification: "Review docs/oauth-runbook.md accuracy",
      },
    ],
  };
}

// ============================================================================
// 1. Draft State & Rehydration Tests
// ============================================================================

describe("draft-state: rehydrateDraft & lifecycle", () => {
  it("returns null on empty branch and rehydrates active draft across updates", () => {
    const harness = new MockPiHarness();
    const ctx = harness.createContext();

    assert.equal(rehydrateDraft(ctx), null);

    const started = startDraft(harness.api, {
      mode: "swarm",
      seed: "Build parallel task runner",
      validatorEnabled: true,
      maxConcurrency: 4,
      baseBranch: "develop",
    });

    assert.equal(isDraftActive(started), true);
    const rehydrated1 = rehydrateDraft(ctx);
    assert.ok(rehydrated1);
    assert.equal(rehydrated1.seed, "Build parallel task runner");
    assert.equal(rehydrated1.baseBranch, "develop");
    assert.equal(rehydrated1.maxConcurrency, 4);
    assert.equal(rehydrated1.validatorEnabled, true);
    assert.equal(
      rehydrated1.finalValidatorEnabled,
      DEFAULT_SWARM_SETTINGS.finalValidatorEnabled,
    );

    // Update with questionnaire echo + toggled validatorEnabled & finalValidatorEnabled
    const updated = updateDraft(harness.api, rehydrated1, {
      validatorEnabled: false,
      finalValidatorEnabled: false,
      questionnaireEcho: { q1: "Use SQLite" },
    });
    assert.equal(updated.validatorEnabled, false);
    assert.equal(updated.finalValidatorEnabled, false);
    assert.deepEqual(updated.questionnaireEcho, { q1: "Use SQLite" });

    // Second update merges questionnaireEcho without dropping q1 or finalValidatorEnabled
    updateDraft(harness.api, updated, {
      questionnaireEcho: { q2: "Strict scope checks" },
    });

    const rehydrated2 = rehydrateDraft(ctx);
    assert.ok(rehydrated2);
    assert.equal(rehydrated2.validatorEnabled, false);
    assert.equal(rehydrated2.finalValidatorEnabled, false);
    assert.deepEqual(rehydrated2.questionnaireEcho, {
      q1: "Use SQLite",
      q2: "Strict scope checks",
    });

    // Mutating returned object does not mutate underlying session entry
    rehydrated2.questionnaireEcho!.q1 = "mutated";
    assert.equal(rehydrateDraft(ctx)?.questionnaireEcho?.q1, "Use SQLite");
  });

  it("initializes validatorEnabled and finalValidatorEnabled from options -> settings -> defaults", () => {
    const harness = new MockPiHarness();
    const ctx = harness.createContext();

    // From settings when omitted in options
    const fromSettings = startDraft(
      harness.api,
      {
        mode: "swarm",
        seed: "Settings fallback",
        maxConcurrency: 2,
      },
      { settings: { validatorEnabled: false, finalValidatorEnabled: false } },
    );
    assert.equal(fromSettings.validatorEnabled, false);
    assert.equal(fromSettings.finalValidatorEnabled, false);
    assert.equal(rehydrateDraft(ctx)?.validatorEnabled, false);
    assert.equal(rehydrateDraft(ctx)?.finalValidatorEnabled, false);

    // Explicit options override settings
    const fromOption = startDraft(
      harness.api,
      {
        mode: "swarm",
        seed: "Explicit override",
        validatorEnabled: true,
        finalValidatorEnabled: true,
        maxConcurrency: 2,
      },
      { settings: { validatorEnabled: false, finalValidatorEnabled: false } },
    );
    assert.equal(fromOption.validatorEnabled, true);
    assert.equal(fromOption.finalValidatorEnabled, true);
    assert.equal(rehydrateDraft(ctx)?.validatorEnabled, true);
    assert.equal(rehydrateDraft(ctx)?.finalValidatorEnabled, true);

    // Entry without optional finalValidatorEnabled still rehydrates cleanly
    harness.api.appendEntry(SWARM_DRAFT_ENTRY, {
      version: 1,
      mode: "swarm",
      seed: "Minimal draft",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 3,
    });
    const minimal = rehydrateDraft(ctx);
    assert.ok(minimal);
    assert.equal(minimal.seed, "Minimal draft");
    assert.equal(minimal.validatorEnabled, true);
    assert.equal(minimal.finalValidatorEnabled, undefined);
  });

  it("survives compaction entries on the branch and respects clearedAt tombstones", () => {
    const harness = new MockPiHarness();
    const ctx = harness.createContext();

    const draft = startDraft(harness.api, {
      mode: "swarm",
      seed: "Refactor storage layer",
      validatorEnabled: true,
      maxConcurrency: 3,
      autoConfirm: true,
    });

    // Simulate Pi auto-compaction occurring mid-draft
    harness.appendCompactionEntry("Compacted prior turns");

    const afterCompact = rehydrateDraft(ctx);
    assert.ok(afterCompact);
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

    // Starting a brand-new draft after tombstone works cleanly
    startDraft(harness.api, {
      mode: "tweak",
      seed: "Add metrics mission",
      targetRunId: "run-42",
      validatorEnabled: false,
      maxConcurrency: 2,
    });

    const fresh = rehydrateDraft(ctx);
    assert.ok(fresh);
    assert.equal(fresh.mode, "tweak");
    assert.equal(fresh.targetRunId, "run-42");
    assert.equal(fresh.seed, "Add metrics mission");
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
    assert.equal(altDraft.seed, "Branch A draft");
  });
});

// ============================================================================
// 2. Idempotent Tool-Profile Swap Tests
// ============================================================================

describe("draft-state: applySwarmToolProfile idempotency", () => {
  it("preserves host and third-party tools, swaps cleanly to all 12 ORCHESTRATOR_TOOLS / 3 DRAFTING_TOOLS / IDLE_SWARM_TOOLS, and skips no-op writes", () => {
    assert.equal(ORCHESTRATOR_TOOLS.length, 12);
    assert.equal(DRAFTING_TOOLS.length, 3);
    assert.deepEqual(IDLE_SWARM_TOOLS, [SWARM_STATUS_TOOL]);
    assert.deepEqual(getSwarmToolsForMode("idle"), [SWARM_STATUS_TOOL]);
    assert.deepEqual(getSwarmToolsForMode("drafting"), DRAFTING_TOOLS);
    assert.deepEqual(getSwarmToolsForMode("running"), ORCHESTRATOR_TOOLS);

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
    const harness = new MockPiHarness([...hostAndThirdParty, SWARM_STATUS_TOOL]);

    // Already in "idle" profile -> must NOT call setActiveTools
    const changedIdle1 = applySwarmToolProfile(harness.api, "idle");
    assert.equal(changedIdle1, false);
    assert.equal(harness.setActiveToolsCalls.length, 0);

    // Swap to "drafting" -> removes swarm_status, adds 3 drafting tools, keeps all host/3rd-party
    const changedDrafting1 = applySwarmToolProfile(harness.api, "drafting");
    assert.equal(changedDrafting1, true);
    assert.equal(harness.setActiveToolsCalls.length, 1);
    for (const tool of hostAndThirdParty) {
      assert.ok(harness.activeTools.includes(tool), `must keep host tool ${tool}`);
    }
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(harness.activeTools.includes(tool), `must activate drafting tool ${tool}`);
    }
    for (const tool of ORCHESTRATOR_TOOLS) {
      assert.ok(!harness.activeTools.includes(tool), `must hide orchestrator tool ${tool}`);
    }

    // Calling "drafting" again -> NO-OP (prompt-cache safe!)
    const changedDrafting2 = applySwarmToolProfile(harness.api, "drafting");
    assert.equal(changedDrafting2, false);
    assert.equal(harness.setActiveToolsCalls.length, 1);

    // Even if active tools are returned in a different order, sorted-set comparison avoids no-op
    harness.activeTools.reverse();
    const changedDrafting3 = applySwarmToolProfile(harness.api, "drafting");
    assert.equal(changedDrafting3, false);
    assert.equal(harness.setActiveToolsCalls.length, 1);

    // Swap to "running" -> removes drafting tools, adds all 12 orchestrator tools
    const expectedOrchestratorTools = [
      SWARM_STATUS_TOOL,
      SWARM_BOARD_POST_TOOL,
      SWARM_BOARD_READ_TOOL,
      SWARM_MISSION_TOOL,
      SWARM_SPAWN_TOOL,
      SWARM_MODEL_TOOL,
      SWARM_KILL_TOOL,
      SWARM_FINDING_TOOL,
      SWARM_MERGE_TOOL,
      SWARM_VERIFY_TOOL,
      SWARM_PLAN_ADD_TOOL,
      SWARM_TEARDOWN_TOOL,
    ];
    const changedRunning1 = applySwarmToolProfile(harness.api, "running");
    assert.equal(changedRunning1, true);
    assert.equal(harness.setActiveToolsCalls.length, 2);
    for (const tool of hostAndThirdParty) {
      assert.ok(harness.activeTools.includes(tool));
    }
    for (const tool of expectedOrchestratorTools) {
      assert.ok(
        harness.activeTools.includes(tool),
        `running profile must include orchestrator tool ${tool}`,
      );
    }
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(!harness.activeTools.includes(tool));
    }
    const activeRunningSwarmTools = harness.activeTools.filter((t) =>
      (ALL_SWARM_EXTENSION_TOOLS as readonly string[]).includes(t),
    );
    assert.equal(activeRunningSwarmTools.length, 12);

    // Calling "running" again -> NO-OP
    assert.equal(applySwarmToolProfile(harness.api, "running"), false);
    assert.equal(harness.setActiveToolsCalls.length, 2);

    // Swap back to "idle" -> only swarm_status among ALL_SWARM_EXTENSION_TOOLS
    assert.equal(applySwarmToolProfile(harness.api, "idle"), true);
    assert.equal(harness.setActiveToolsCalls.length, 3);
    const activeSwarmTools = harness.activeTools.filter((t) =>
      (ALL_SWARM_EXTENSION_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(activeSwarmTools, [SWARM_STATUS_TOOL]);
    assert.ok(!harness.activeTools.includes(SWARM_VERIFY_TOOL));
    assert.ok(!harness.activeTools.includes(SWARM_BOARD_POST_TOOL));
    for (const tool of hostAndThirdParty) {
      assert.ok(harness.activeTools.includes(tool));
    }
  });
});

// ============================================================================
// 3. Existing Draft Conflict Dialog (Resume / Replace / Cancel) + Modal Hooks
// ============================================================================

describe("draft-state: startOrResolveDraft conflict handling", () => {
  it("handles Resume, Replace, Cancel and always balances modal depth hooks", async () => {
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
  it("persists question and questionnaire answers into draft.questionnaireEcho and handles cancellation gracefully", async () => {
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
        tests: "Vitest + integration",
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
          question: "What test coverage?",
          answer: "Vitest + integration",
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
      store: createMockStore(),
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

    // Test prepareArguments normalizing string options
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

    // Verify renderCall uses swarm_question label
    const theme = createMockTheme();
    assert.match(
      questionTool.renderCall(prepared, theme, {} as any).render(100).join("\n"),
      /swarm_question/,
    );

    // Execute swarm_question with user cancellation -> graceful non-error, echo unchanged
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
          question: "What test coverage?",
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
    assert.match(qnResult.content[0].text, /Vitest \+ integration \(custom\)/);
    assert.deepEqual(rehydrateDraft(ctx)?.questionnaireEcho, {
      db: "PostgreSQL",
      auth: "OAuth2 PKCE",
      tests: "Vitest + integration",
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
// 5. Drafting Tool: propose_swarm_plan
// ============================================================================

describe("draft-tools: propose_swarm_plan", () => {
  it("uses sequential executionMode and Google-compatible StringEnum mission kind schema with validator flags", () => {
    const harness = new MockPiHarness();
    const { tools } = createDraftingTools(harness.api, {
      store: createMockStore(),
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

    const propose = tools.find((t) => t.name === PROPOSE_SWARM_PLAN_TOOL)!;
    assert.equal(propose.executionMode, "sequential");
    assert.equal(propose.defaultActive, false);
    assert.equal(propose.exposure, "model-only");
    assert.equal(propose.label, "Swarm Plan");

    const schemaJson = JSON.stringify(propose.parameters);
    assert.ok(!schemaJson.includes('"anyOf"'), "Schema must not contain anyOf for Google API");
    assert.ok(schemaJson.includes('"enum":["build","artifact","survey"]'));
    assert.ok(schemaJson.includes('"validator_enabled"'));
    assert.ok(schemaJson.includes('"final_validator_enabled"'));
    assert.ok(!schemaJson.includes('"review_enabled"'));
    assert.ok(!schemaJson.includes('"final_verifier_enabled"'));
  });

  it("derives 3-role roleModels from settings via buildRoleModelsFromSettings and attaches them to ProposedSwarmPlan", async () => {
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
      store: createMockStore(),
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          seenPlans.push(plan);
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            finalValidatorEnabled: plan.finalValidatorEnabled,
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
      maxConcurrency: 3,
    });

    const res = await harness.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute("tc-models", makeSamplePlanParams(), undefined, undefined, harness.createContext());

    assert.equal(res.isError, undefined);
    assert.deepEqual(seenPlans[0]?.roleModels, derived);
    assert.deepEqual(confirmedPlans[0]?.roleModels, derived);
    assert.match(
      res.content[0].text,
      /\*\*Models:\*\* Orchestrator: anthropic\/claude-opus-4 \(high\) \| Worker: anthropic\/claude-sonnet-4 \(medium\) \| Validator: openai\/gpt-5 \(low\)/,
    );
    assert.match(res.content[0].text, /\*\*Fallbacks:\*\* google\/gemini-2\.5-pro, openai\/gpt-4\.1/);
  });

  it("rejects invalid plans BEFORE calling ui.confirmProposal with [SwarmProtocolError:<CODE>]", async () => {
    const harness = new MockPiHarness();
    let confirmCalls = 0;
    let planConfirmedCalls = 0;

    const invalidStore = createMockStore(() => ({
      valid: false,
      errors: [
        {
          code: "SCOPE_OVERLAP",
          missionId: "M2",
          message: 'Build missions M1 and M2 have overlapping scope "src/auth".',
          details: { conflictingMissionId: "M1", path: "src/auth" },
        },
        {
          code: "CYCLE_DETECTED",
          message: "Dependency cycle detected: M1 -> M2 -> M1",
        },
      ],
      waves: [],
      branches: {},
    }));

    const controller = registerDraftingTools(harness.api, {
      store: invalidStore,
      worktree: createMockWorktree({ currentBranch: "main", localBranches: ["main"] }),
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
      seed: "Overlapping test",
      validatorEnabled: true,
      maxConcurrency: 3,
    });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const result = await proposeTool.execute(
      "tc-invalid",
      makeSamplePlanParams(),
      undefined,
      undefined,
      harness.createContext(),
    );

    assert.equal(result.isError, true);
    assert.equal(confirmCalls, 0, "confirmProposal MUST NOT be called for invalid plans");
    assert.equal(planConfirmedCalls, 0);
    assert.match(result.content[0].text, /\[SwarmProtocolError:SCOPE_OVERLAP\]/);
    assert.match(result.content[0].text, /\[SwarmProtocolError:CYCLE_DETECTED\]/);
    assert.equal(controller.isActive(), true, "draft stays active so model can fix errors");

    // Also verify thrown SwarmProtocolError from validatePlan is caught cleanly
    const throwingStore = createMockStore(() => {
      throw new SwarmProtocolError("INVALID_TITLE", "Title must be printable ASCII");
    });
    const harness2 = new MockPiHarness();
    registerDraftingTools(harness2.api, {
      store: throwingStore,
      worktree: createMockWorktree(),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => {
          confirmCalls++;
          return { action: "confirm", validatorEnabled: true, maxConcurrency: 3 };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    const res2 = await harness2.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute(
        "tc-throw",
        makeSamplePlanParams(),
        undefined,
        undefined,
        harness2.createContext(),
      );
    assert.equal(res2.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(res2.content[0].text, /\[SwarmProtocolError:INVALID_TITLE\]/);
  });

  it("confirms valid plan -> calls onPlanConfirmed with toggled settings, clears draft, swaps profile to all 12 ORCHESTRATOR_TOOLS, returns terminate: true", async () => {
    const harness = new MockPiHarness();
    const confirmedPlans: ProposedSwarmPlan[] = [];
    const passedValidations: Array<PlanValidationResult | undefined> = [];

    const controller = registerDraftingTools(harness.api, {
      store: createMockStore(),
      worktree: createMockWorktree({
        currentBranch: "release/v2",
        localBranches: ["main", "release/v2"],
      }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, _plan, options) => {
          passedValidations.push(options?.validation);
          // User toggled Per-Mission Validator OFF, Final Validator OFF, and increased concurrency to 5
          return {
            action: "confirm",
            validatorEnabled: false,
            finalValidatorEnabled: false,
            maxConcurrency: 5,
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
    const passedValidation = passedValidations[0];
    assert.ok(passedValidation?.valid);
    assert.deepEqual(passedValidation?.waves, [["M1"], ["M2", "M3"], ["M4"]]);

    const confirmedPlan = confirmedPlans[0];
    assert.ok(confirmedPlan);
    assert.equal(confirmedPlan.baseBranch, "release/v2");
    assert.equal(confirmedPlan.validatorEnabled, false);
    assert.equal(confirmedPlan.finalValidatorEnabled, false);
    assert.equal(confirmedPlan.maxConcurrency, 5);
    assert.equal(confirmedPlan.missions.length, 4);
    assert.ok(confirmedPlan.roleModels);

    // Draft cleared with tombstone and tool profile swapped to running (all 12 ORCHESTRATOR_TOOLS)
    assert.equal(controller.isActive(), false);
    assert.equal(rehydrateDraft(ctx), null);
    for (const tool of ORCHESTRATOR_TOOLS) {
      assert.ok(harness.activeTools.includes(tool), `must activate ${tool}`);
    }
    assert.ok(harness.activeTools.includes(SWARM_VERIFY_TOOL));
    assert.ok(harness.activeTools.includes(SWARM_BOARD_POST_TOOL));
    assert.ok(harness.activeTools.includes(SWARM_MODEL_TOOL));
    assert.ok(harness.activeTools.includes(SWARM_KILL_TOOL));
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(!harness.activeTools.includes(tool));
    }

    const details = result.details as ProposeSwarmPlanToolDetails;
    assert.equal(details.outcome, "confirmed");
    assert.equal(details.runId, "run-20261120-abc");
    assert.equal(details.plan?.validatorEnabled, false);
    assert.equal(details.plan?.finalValidatorEnabled, false);
    assert.match(result.content[0].text, /Swarm Mission Plan Proposal/);
    assert.match(result.content[0].text, /\*\*Per-Mission Validator:\*\* OFF/);
    assert.match(result.content[0].text, /\*\*Final Validator:\*\* OFF/);
    assert.match(result.content[0].text, /Validator: OFF, Final Validator: OFF/);
    assert.match(result.content[0].text, /CONFIRMED/);
    assert.match(result.content[0].text, /Wave 2 \(2 parallel\)/);
  });

  it("refine (continue) keeps draft active, persists toggled validatorEnabled/finalValidatorEnabled/maxConcurrency, and flows from settings -> draft -> propose -> confirm", async () => {
    const harness = new MockPiHarness();
    let onPlanConfirmedCalled = false;
    let dialogRound = 0;
    const seenPlans: ProposedSwarmPlan[] = [];
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const controller = registerDraftingTools(harness.api, {
      store: createMockStore(),
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          dialogRound++;
          seenPlans.push(plan);
          if (dialogRound === 1) {
            // User toggled Per-Mission Validator OFF and Final Validator ON
            return {
              action: "continue",
              validatorEnabled: false,
              finalValidatorEnabled: true,
              maxConcurrency: 2,
              feedback: "Split M2 into client and middleware",
            };
          }
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            finalValidatorEnabled: plan.finalValidatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
      // Settings start with finalValidatorEnabled: false -> must flow into draft & Round 1 proposal
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS, finalValidatorEnabled: false }),
      onPlanConfirmed: async (plan) => {
        onPlanConfirmedCalled = true;
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    // Omit finalValidatorEnabled -> controller inherits false from settings
    controller.start({
      seed: "OAuth + audit",
      validatorEnabled: true,
      maxConcurrency: 3,
    });
    assert.equal(controller.getDraft()?.finalValidatorEnabled, false);

    const ctx = harness.createContext();
    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);

    // Round 1 -> sees finalValidatorEnabled: false from settings/draft, user toggles it ON and continues
    const res1 = await proposeTool.execute(
      "tc-refine-1",
      makeSamplePlanParams(),
      undefined,
      undefined,
      ctx,
    );

    assert.equal(seenPlans[0]?.finalValidatorEnabled, false);
    assert.equal(res1.isError, undefined);
    assert.equal(res1.terminate, undefined);
    assert.equal(onPlanConfirmedCalled, false);
    assert.equal(controller.isActive(), true);
    assert.equal(controller.getDraft()?.validatorEnabled, false);
    assert.equal(controller.getDraft()?.finalValidatorEnabled, true);
    assert.equal(controller.getDraft()?.maxConcurrency, 2);

    // Persisted in branch-local entry too!
    const rehydrated = rehydrateDraft(ctx);
    assert.ok(rehydrated);
    assert.equal(rehydrated.validatorEnabled, false);
    assert.equal(rehydrated.finalValidatorEnabled, true);
    assert.equal(rehydrated.maxConcurrency, 2);

    const details1 = res1.details as ProposeSwarmPlanToolDetails;
    assert.equal(details1.outcome, "continue");
    assert.equal(details1.plan?.finalValidatorEnabled, true);
    assert.match(res1.content[0].text, /CONTINUE REFINING/);
    assert.match(res1.content[0].text, /Split M2 into client and middleware/);
    assert.match(res1.content[0].text, /\*\*Per-Mission Validator:\*\* OFF/);
    assert.match(res1.content[0].text, /\*\*Final Validator:\*\* ON/);
    assert.match(res1.content[0].text, /Validator: OFF, Final Validator: ON/);

    // Round 2 -> model omits validator_enabled/final_validator_enabled/max_concurrency; inherits persisted toggled values!
    const res2 = await proposeTool.execute(
      "tc-refine-2",
      makeSamplePlanParams(),
      undefined,
      undefined,
      ctx,
    );
    assert.equal(seenPlans[1]?.validatorEnabled, false);
    assert.equal(seenPlans[1]?.finalValidatorEnabled, true);
    assert.equal(seenPlans[1]?.maxConcurrency, 2);
    assert.equal(confirmedPlans[0]?.finalValidatorEnabled, true);
    assert.equal(res2.terminate, true);
    assert.equal(onPlanConfirmedCalled, true);
  });

  it("honors explicit validator_enabled and final_validator_enabled parameter overrides in propose_swarm_plan", async () => {
    const harness = new MockPiHarness();
    const seenPlans: ProposedSwarmPlan[] = [];
    const confirmedPlans: ProposedSwarmPlan[] = [];

    const controller = registerDraftingTools(harness.api, {
      store: createMockStore(),
      worktree: createMockWorktree({ currentBranch: "main" }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async (_ctx, plan) => {
          seenPlans.push(plan);
          // Even when UI omits finalValidatorEnabled, plan.finalValidatorEnabled propagates on confirm
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
      getSettings: () => ({
        ...DEFAULT_SWARM_SETTINGS,
        validatorEnabled: true,
        finalValidatorEnabled: true,
      }),
      onPlanConfirmed: async (plan) => {
        confirmedPlans.push(plan);
        return createMockRun(plan);
      },
    });

    controller.start({
      seed: "Override validator flags",
      validatorEnabled: true,
      finalValidatorEnabled: true,
      maxConcurrency: 3,
    });

    const res = await harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL).execute(
      "tc-override",
      {
        ...makeSamplePlanParams(),
        validator_enabled: false,
        final_validator_enabled: false,
      },
      undefined,
      undefined,
      harness.createContext(),
    );

    assert.equal(res.isError, undefined);
    assert.equal(seenPlans[0]?.validatorEnabled, false);
    assert.equal(seenPlans[0]?.finalValidatorEnabled, false);
    assert.equal(confirmedPlans[0]?.validatorEnabled, false);
    assert.equal(confirmedPlans[0]?.finalValidatorEnabled, false);
  });

  it("cancel tombstones draft, restores idle tool profile, and returns terminate: true", async () => {
    const harness = new MockPiHarness();
    let onPlanConfirmedCalled = false;

    const controller = registerDraftingTools(harness.api, {
      store: createMockStore(),
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

    // Tool profile restored to idle (only swarm_status among swarm tools)
    const activeSwarm = harness.activeTools.filter((t) =>
      (ALL_SWARM_EXTENSION_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(activeSwarm, [SWARM_STATUS_TOOL]);
    assert.match(res.content[0].text, /CANCELLED/);
    assert.match(res.content[0].text, /Swarm Mission Plan Proposal/);
  });

  it("supports /swarm direct autoConfirm without opening confirmation modal", async () => {
    const harness = new MockPiHarness();
    let confirmCalls = 0;
    let launchedRunId: string | undefined;
    let confirmedPlan: ProposedSwarmPlan | undefined;

    const controller = registerDraftingTools(harness.api, {
      store: createMockStore(),
      worktree: createMockWorktree({ currentBranch: "main" }),
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
        finalValidatorEnabled: false,
        workerModel: "anthropic/claude-sonnet-4",
      }),
      onPlanConfirmed: async (plan) => {
        confirmedPlan = plan;
        const run = createMockRun(plan);
        launchedRunId = run.id;
        return run;
      },
    });

    controller.start({
      seed: "Direct launch goal",
      validatorEnabled: true,
      maxConcurrency: 4,
      baseBranch: "main",
      autoConfirm: true,
    });

    const ctx = harness.createContext();
    const res = await harness.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute("tc-direct", makeSamplePlanParams(), undefined, undefined, ctx);

    assert.equal(confirmCalls, 0, "autoConfirm must bypass confirmation modal");
    assert.equal(res.terminate, true);
    assert.equal(launchedRunId, "run-20261120-abc");
    assert.equal(confirmedPlan?.finalValidatorEnabled, false);
    assert.equal(confirmedPlan?.roleModels?.worker?.model, "anthropic/claude-sonnet-4");
    assert.equal((res.details as ProposeSwarmPlanToolDetails).autoConfirmed, true);
    assert.equal(rehydrateDraft(ctx), null);
  });

  it("preserves draft and returns isError with [SwarmProtocolError:...] if onPlanConfirmed throws SwarmProtocolError", async () => {
    const harness = new MockPiHarness();
    const controller = registerDraftingTools(harness.api, {
      store: createMockStore(),
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
        throw new SwarmProtocolError("DIRTY_BASE", "Working tree on main has uncommitted edits");
      },
    });

    controller.start({
      seed: "Dirty repo test",
      validatorEnabled: true,
      maxConcurrency: 3,
    });

    const res = await harness.registeredTools
      .get(PROPOSE_SWARM_PLAN_TOOL)
      .execute("tc-err", makeSamplePlanParams(), undefined, undefined, harness.createContext());

    assert.equal(res.isError, true);
    assert.equal(res.terminate, undefined);
    assert.match(res.content[0].text, /\[SwarmProtocolError:DIRTY_BASE\]/);
    assert.equal(controller.isActive(), true, "draft must stay active on launch failure");
  });

  it("renderCall outputs full formatted Mission DAG table & 3-role models and renderResult formats all states with pi-swarm labels", () => {
    const harness = new MockPiHarness();
    registerDraftingTools(harness.api, {
      store: createMockStore(),
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
    const callComponent = proposeTool.renderCall(makeSamplePlanParams(), theme, {} as any);
    const rendered = callComponent.render(160).join("\n");

    assert.match(rendered, /Swarm Plan/);
    assert.match(rendered, /propose_swarm_plan/);
    assert.match(rendered, /Implement OAuth login and audit logging/);
    assert.match(
      rendered,
      /\*\*Models:\*\* Orchestrator: claude-opus-4 \| Worker: claude-sonnet-4 \| Validator: gpt-5/,
    );
    assert.match(rendered, /\*\*Per-Mission Validator:\*\* ON/);
    assert.match(rendered, /\*\*Final Validator:\*\* ON/);
    assert.match(rendered, /Wave 1/);
    assert.match(rendered, /Wave 2 \(2 parallel\)/);
    assert.match(rendered, /Wave 3/);
    assert.match(
      rendered,
      /\| ID \| Title \| Kind \| Branch \| Scope \| Deps \| Verification \| Tasks \|/,
    );
    assert.match(rendered, /feat\/add-oauth-provider-client/);
    assert.match(rendered, /src\/oauth/);
    assert.match(rendered, /Implement OAuth client/);

    // Explicit validator_enabled & final_validator_enabled: false reflected in renderCall
    const validatorsOffRendered = proposeTool
      .renderCall(
        {
          ...makeSamplePlanParams(),
          validator_enabled: false,
          final_validator_enabled: false,
        },
        theme,
        {} as any,
      )
      .render(160)
      .join("\n");
    assert.match(validatorsOffRendered, /\*\*Per-Mission Validator:\*\* OFF/);
    assert.match(validatorsOffRendered, /\*\*Final Validator:\*\* OFF/);

    // Partial/streaming args must never throw in renderCall
    const partialComponent = proposeTool.renderCall({} as any, theme, {} as any);
    assert.ok(partialComponent.render(80).length > 0);

    // renderResult for confirmed (compact + expanded + with plan flags)
    const compactText = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Full proposal body" }],
          details: { outcome: "confirmed", runId: "run-99" },
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(100)
      .join("\n");
    assert.match(compactText, /Swarm Plan confirmed/);
    assert.match(compactText, /run-99/);

    const confirmedWithFlagsText = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Full proposal body" }],
          details: {
            outcome: "confirmed",
            runId: "run-100",
            plan: {
              objective: "Goal",
              baseBranch: "main",
              maxConcurrency: 3,
              validatorEnabled: true,
              finalValidatorEnabled: false,
              verificationContract: "npm test",
              missions: [],
            },
          },
        },
        { expanded: false, isPartial: false },
        theme,
        {} as any,
      )
      .render(120)
      .join("\n");
    assert.match(confirmedWithFlagsText, /Validator: ON, Final Validator: OFF/);

    const continueText = proposeTool
      .renderResult(
        {
          content: [{ type: "text", text: "Refine body" }],
          details: {
            outcome: "continue",
            plan: {
              objective: "Goal",
              baseBranch: "main",
              maxConcurrency: 2,
              validatorEnabled: false,
              finalValidatorEnabled: true,
              verificationContract: "npm test",
              missions: [],
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
    assert.match(continueText, /Validator: OFF, Final Validator: ON/);

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

  it("rejects duplicate local branches before modal, falls back to main when repo not initialized, and normalizes string tasks", async () => {
    const harness = new MockPiHarness();
    let confirmCalls = 0;

    registerDraftingTools(harness.api, {
      store: createMockStore(),
      worktree: createMockWorktree({
        getCurrentBranchThrows: true,
        localBranches: ["main", "feat/add-oauth-provider-client"],
      }),
      ui: {
        askQuestion: async () => ({ cancelled: true, isCustom: false }),
        askQuestionnaire: async () => ({ cancelled: true, answers: {}, items: [] }),
        confirmProposal: async () => {
          confirmCalls++;
          return { action: "confirm", validatorEnabled: true, maxConcurrency: 3 };
        },
      },
      getSettings: () => ({ ...DEFAULT_SWARM_SETTINGS }),
      onPlanConfirmed: async (plan) => createMockRun(plan),
    });

    const proposeTool = harness.registeredTools.get(PROPOSE_SWARM_PLAN_TOOL);
    const rawParams = {
      ...makeSamplePlanParams(),
      missions: makeSamplePlanParams().missions.map((m) =>
        m.id === "M2" ? { ...m, tasks: ["Write client", "Write tests"] } : m,
      ),
    };
    const prepared = proposeTool.prepareArguments(rawParams);
    assert.deepEqual(prepared.missions[1].tasks, [
      { title: "Write client" },
      { title: "Write tests" },
    ]);

    const res = await proposeTool.execute(
      "tc-dup-branch",
      prepared,
      undefined,
      undefined,
      harness.createContext(),
    );
    assert.equal(res.isError, true);
    assert.equal(confirmCalls, 0);
    assert.match(res.content[0].text, /\[SwarmProtocolError:DUPLICATE_BRANCH\]/);

    // Verify DraftStateController rehydrate + syncToolProfile across idle/drafting/running
    const controller = new DraftStateController(harness.api);
    const ctx = harness.createContext();
    harness.api.appendEntry(SWARM_DRAFT_ENTRY, {
      version: 1,
      mode: "swarm",
      seed: "Rehydrate sync",
      startedAt: new Date().toISOString(),
      validatorEnabled: true,
      maxConcurrency: 3,
    });
    const rehydrated = controller.rehydrate(ctx, { syncToolProfile: true });
    assert.ok(rehydrated);
    for (const tool of DRAFTING_TOOLS) {
      assert.ok(harness.activeTools.includes(tool));
    }
    controller.clear();
    controller.rehydrate(ctx, { syncToolProfile: true, hasActiveRun: true });
    for (const tool of ORCHESTRATOR_TOOLS) {
      assert.ok(harness.activeTools.includes(tool));
    }
    controller.rehydrate(ctx, { syncToolProfile: true, hasActiveRun: false });
    assert.ok(harness.activeTools.includes(SWARM_STATUS_TOOL));
    assert.ok(!harness.activeTools.includes(PROPOSE_SWARM_PLAN_TOOL));
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

  it("buildDraftingKickoffPrompt describes the 3-role Antigravity Swarm, Message Board, Validators, and drafting tools", () => {
    const prompt = buildDraftingKickoffPrompt("Add <fast> cache & tests", "swarm", {
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
      finalValidatorEnabled: false,
      roleModels: {
        orchestrator: { model: "claude-opus-4" },
        worker: { model: "claude-sonnet-4" },
        validator: { model: "gpt-5" },
      },
      existingEcho: { cache_backend: "Redis" },
    });

    assert.match(prompt, /<swarm_drafting_kickoff mode="swarm">/);
    assert.match(prompt, /Add &lt;fast&gt; cache &amp; tests/);
    assert.match(prompt, /validator_enabled="true"/);
    assert.match(prompt, /final_validator_enabled="false"/);
    assert.match(prompt, /Orchestrator/);
    assert.match(prompt, /Workers/i);
    assert.match(prompt, /Message Board/);
    assert.match(prompt, /#seq/);
    assert.match(prompt, /@mention/);
    assert.match(prompt, /warm persistent sessions/i);
    assert.match(prompt, /Per-Mission Validators?/i);
    assert.match(prompt, /tip commit SHA/i);
    assert.match(prompt, /@<mission>/);
    assert.match(prompt, /Final Validator/i);
    assert.match(prompt, /DO NOT start editing/i);
    assert.match(prompt, /read.*grep.*find.*ls/);
    assert.match(prompt, new RegExp(SWARM_QUESTIONNAIRE_TOOL));
    assert.match(prompt, new RegExp(SWARM_QUESTION_TOOL));
    assert.match(prompt, new RegExp(PROPOSE_SWARM_PLAN_TOOL));
    assert.match(prompt, /Printable ASCII/i);
    assert.match(prompt, /Pairwise-disjoint/i);
    assert.match(prompt, /verification_contract/i);
    assert.match(prompt, /Do NOT dump the full plan/i);
    assert.match(prompt, /Redis/);
  });

  it("buildDraftingSystemOverlay & buildDirectPlanPrompt generate concise structured pi-swarm prompts", () => {
    const draft: SwarmDraftState = {
      version: 1,
      mode: "swarm",
      seed: "Build CLI",
      startedAt: new Date().toISOString(),
      validatorEnabled: false,
      finalValidatorEnabled: false,
      maxConcurrency: 2,
      baseBranch: "main",
      questionnaireEcho: { cli_lib: "commander" },
    };

    const overlay = buildDraftingSystemOverlay(draft);
    assert.match(overlay, /swarm_drafting_active/);
    assert.match(overlay, /validator_enabled="false"/);
    assert.match(overlay, /final_validator_enabled="false"/);
    assert.match(overlay, /Message Board/);
    assert.match(overlay, /Final Validator/i);
    assert.match(overlay, /commander/);
    assert.match(overlay, new RegExp(PROPOSE_SWARM_PLAN_TOOL));

    const settings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      maxConcurrency: 5,
      validatorEnabled: true,
      finalValidatorEnabled: true,
    };
    const directPrompt = buildDirectPlanPrompt("Migrate build scripts", "main", settings);
    assert.match(directPrompt, /swarm_direct_plan/);
    assert.match(directPrompt, /Skip interactive Q&A/i);
    assert.match(directPrompt, /max_concurrency="5"/);
    assert.match(directPrompt, /validator_enabled="true"/);
    assert.match(directPrompt, /final_validator_enabled="true"/);
    assert.match(directPrompt, /Final Validator/i);
    assert.match(directPrompt, /verification_contract/i);
    assert.match(directPrompt, /Migrate build scripts/);
    assert.match(directPrompt, new RegExp(PROPOSE_SWARM_PLAN_TOOL));
  });

  it("formatProposalTranscriptSummary renders 3-role Models, Validator/Final Validator flags, and wave-by-wave Mission DAG tables", () => {
    const params = makeSamplePlanParams();
    const plan: ProposedSwarmPlan = {
      objective: params.objective,
      baseBranch: "main",
      maxConcurrency: 3,
      validatorEnabled: true,
      verificationContract: params.verification_contract,
      missions: params.missions,
    };
    const waves = [["M1"], ["M2", "M3"], ["M4"]];
    const branches = {
      M1: "feat/survey-auth-middleware",
      M2: "feat/add-oauth-provider-client",
      M3: "feat/add-audit-logger-module",
      M4: "feat/write-migration-runbook",
    };

    // Default when roleModels & finalValidatorEnabled are omitted -> "default" models, Final Validator ON
    const summary = formatProposalTranscriptSummary(plan, waves, branches);

    assert.match(summary, /## Swarm Mission Plan Proposal/);
    assert.match(summary, /\*\*Objective:\*\* Implement OAuth login and audit logging/);
    assert.match(summary, /\*\*Base Branch:\*\* `main`/);
    assert.match(summary, /\*\*Concurrency:\*\* 3/);
    assert.match(summary, /\*\*Per-Mission Validator:\*\* ON/);
    assert.match(summary, /\*\*Final Validator:\*\* ON/);
    assert.match(
      summary,
      /\*\*Models:\*\* Orchestrator: default \| Worker: default \| Validator: default/,
    );
    assert.match(summary, /\*\*Verification Contract:\*\* npm test && npm run typecheck/);

    // Explicit roleModels & finalValidatorEnabled: false -> configured trio & OFF
    const summaryWithModelsAndOff = formatProposalTranscriptSummary(
      {
        ...plan,
        validatorEnabled: false,
        finalValidatorEnabled: false,
        roleModels: {
          orchestrator: { model: "claude-opus-4", thinkingLevel: "high" },
          worker: { model: "claude-sonnet-4" },
          validator: { model: "gpt-5", thinkingLevel: "medium" },
          fallbackModels: ["gemini-2.5-pro"],
        },
      },
      waves,
      branches,
    );
    assert.match(summaryWithModelsAndOff, /\*\*Per-Mission Validator:\*\* OFF/);
    assert.match(summaryWithModelsAndOff, /\*\*Final Validator:\*\* OFF/);
    assert.match(
      summaryWithModelsAndOff,
      /\*\*Models:\*\* Orchestrator: claude-opus-4 \(high\) \| Worker: claude-sonnet-4 \| Validator: gpt-5 \(medium\) \| \*\*Fallbacks:\*\* gemini-2\.5-pro/,
    );

    // Wave headers & Mission DAG table columns
    assert.match(summary, /#### Wave 1/);
    assert.match(summary, /#### Wave 2 \(2 parallel\)/);
    assert.match(summary, /#### Wave 3/);
    assert.match(
      summary,
      /\| ID \| Title \| Kind \| Branch \| Scope \| Deps \| Verification \| Tasks \|/,
    );

    // Mission rows
    assert.match(
      summary,
      /\| \*\*M1\*\* \| Survey auth middleware \| `survey` \| `feat\/survey-auth-middleware` \| `src\/auth` \| none \|/,
    );
    assert.match(
      summary,
      /\| \*\*M2\*\* \| Add OAuth provider client \| `build` \| `feat\/add-oauth-provider-client` \| `src\/oauth`, `tests\/oauth\.test\.ts` \| M1 \| npm run test:file -- tests\/oauth\.test\.ts \| \[ \] `t1` Implement OAuth client; \[ \] `t2` Add unit tests \|/,
    );
    assert.match(
      summary,
      /\| \*\*M4\*\* \| Write migration runbook \| `artifact` \| `feat\/write-migration-runbook` \| `docs\/oauth-runbook\.md` \| M2, M3 \|/,
    );
  });
});

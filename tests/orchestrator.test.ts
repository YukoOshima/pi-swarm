import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SWARM_SETTINGS,
  FINAL_AUDIT_MISSION_ID,
  ORCHESTRATOR_TOOLS,
  SWARM_BOARD_POST_TOOL,
  SWARM_BOARD_READ_TOOL,
  SWARM_FINAL_VERDICT_TOOL,
  SWARM_FINDING_TOOL,
  SWARM_KILL_TOOL,
  SWARM_MAX_BOARD_HOPS,
  SWARM_MERGE_TOOL,
  SWARM_MISSION_TOOL,
  SWARM_MODEL_TOOL,
  SWARM_PLAN_ADD_TOOL,
  SWARM_SPAWN_TOOL,
  SWARM_STATUS_TOOL,
  SWARM_TEARDOWN_TOOL,
  SWARM_VERIFY_TOOL,
} from "../src/constants.js";
import {
  buildFinalValidatorSystemPrompt,
  buildFinalValidatorTaskPrompt,
  buildOrchestratorContextSummary,
  buildValidatorSystemPrompt,
  buildWorkerSystemPrompt,
  ConcurrencyGate,
  createOrchestratorTools,
  createSwarmVerifyTool,
  findOutOfScopeFiles,
  InProcessPiTransport,
  isForbiddenWorkerBashCommand,
  isPathInScope,
  isProtectedSwarmPath,
  isRateLimitOrTransientError,
  isReadOnlyValidationCommand,
  parseRetryAfterMs,
  RateLimitBreaker,
  resolveRoleModel,
  selectFallbackModel,
  SwarmOrchestrator,
} from "../src/runtime/index.js";
import {
  type AgentTurnResult,
  type AutoRebaseResult,
  type BaseBranchCleanCheck,
  type BoardMessage,
  type CallerRole,
  type CreateRunInput,
  type CreateWorktreeResult,
  type DiffSummary,
  type FinalAuditVerdict,
  type FinalValidatorSpawnRequest,
  type InboxMessage,
  type ISwarmStore,
  type ISwarmTransport,
  isSwarmProtocolError,
  type IWorktreeManager,
  type MergeBranchResult,
  type MissionPlanInput,
  type MissionRecord,
  type MissionReviewVerdict,
  type ModelSwitchResult,
  type PersistentAgentHandle,
  type PlanValidationIssue,
  type PlanValidationOptions,
  type PlanValidationResult,
  type PostBoardMessageInput,
  type ReadBoardOptions,
  type ReadBoardResult,
  type ReadInboxOptions,
  type RecordFindingInput,
  type RegisterRosterInput,
  type RepoReadyResult,
  type RosterAgentStatus,
  type RosterUpdateInput,
  type RunSummary,
  type RunUpdateInput,
  type SafeTeardownResult,
  type SafeTeardownTarget,
  type SendMessageInput,
  type SwarmEvent,
  type SwarmEventInput,
  type SwarmFindingRecord,
  type SwarmOrchestratorEvent,
  SwarmProtocolError,
  type SwarmRunState,
  type SwarmSettings,
  type ValidatorSpawnRequest,
  type WorkerSpawnRequest,
  type WorkerTelemetryEvent,
} from "../src/types.js";

// ============================================================================
// Test Utilities
// ============================================================================

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mission"
  );
}

const MENTION_RE = /(?:^|[\s([{"'`,;:])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

function mockParseMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const token = m[1]?.replace(/[.,;:!?)]+$/, "");
    if (!token) continue;
    const lower = token.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(token);
    }
  }
  return out;
}

// ============================================================================
// Faithful In-Memory Mock Store (Zero imports from src/store/*)
// ============================================================================

class MockSwarmStore implements ISwarmStore {
  readonly projectRoot = "/mock/repo";
  private readonly runs = new Map<string, SwarmRunState>();
  private readonly events = new Map<string, SwarmEvent[]>();
  private readonly boards = new Map<string, BoardMessage[]>();
  private readonly inboxes = new Map<string, InboxMessage[]>();
  private activeRunId: string | null = null;
  private idSeq = 0;

  async createRun(input: CreateRunInput): Promise<SwarmRunState> {
    const now = new Date().toISOString();
    const id = input.id ?? `run-${++this.idSeq}`;
    const missions: Record<string, MissionRecord> = {};
    const missionOrder: string[] = [];

    for (const m of input.missions) {
      const tasks = (m.tasks ?? []).map((t, idx) =>
        typeof t === "string"
          ? { id: `T${idx + 1}`, title: t, done: false }
          : { id: t.id ?? `T${idx + 1}`, title: t.title, done: Boolean(t.done) },
      );
      missions[m.id] = {
        id: m.id,
        title: m.title,
        kind: m.kind,
        description: m.description,
        scope: [...m.scope],
        deps: [...m.deps],
        verification: m.verification,
        tasks,
        branch: `feat/${slugify(m.title)}`,
        worktreePath: this.getWorktreePath(id, m.id),
        status: "planned",
        reviewRound: 0,
        retryCount: 0,
        humanStopped: false,
        createdAt: now,
        updatedAt: now,
      };
      missionOrder.push(m.id);
    }

    const state: SwarmRunState = {
      version: 1,
      id,
      objective: input.objective,
      verificationContract: input.verificationContract,
      baseBranch: input.baseBranch,
      ownerSessionId: input.ownerSessionId,
      ownerPid: input.ownerPid ?? process.pid,
      status: "active",
      maxConcurrency: input.maxConcurrency ?? DEFAULT_SWARM_SETTINGS.maxConcurrency,
      validatorEnabled: input.validatorEnabled ?? DEFAULT_SWARM_SETTINGS.validatorEnabled,
      maxValidationRounds: input.maxValidationRounds ?? DEFAULT_SWARM_SETTINGS.maxValidationRounds,
      finalValidatorEnabled:
        input.finalValidatorEnabled ?? DEFAULT_SWARM_SETTINGS.finalValidatorEnabled,
      maxFinalAuditRounds: input.maxFinalAuditRounds ?? DEFAULT_SWARM_SETTINGS.maxFinalAuditRounds,
      autoFixOnAuditFail: input.autoFixOnAuditFail ?? DEFAULT_SWARM_SETTINGS.autoFixOnAuditFail,
      keepWorkersWarm: input.keepWorkersWarm ?? DEFAULT_SWARM_SETTINGS.keepWorkersWarm,
      finalAuditStatus: "idle",
      finalAuditRound: 0,
      roleModels: input.roleModels ? structuredClone(input.roleModels) : undefined,
      revision: 1,
      missions,
      missionOrder,
      roster: {},
      findings: [],
      createdAt: now,
      updatedAt: now,
    };

    this.runs.set(id, state);
    this.events.set(id, []);
    this.boards.set(id, []);
    this.inboxes.set(id, []);
    this.activeRunId = id;
    return structuredClone(state);
  }

  async loadRun(runId: string): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    }
    return structuredClone(run);
  }

  async listRuns(): Promise<RunSummary[]> {
    return Array.from(this.runs.values()).map((r) => {
      const list = Object.values(r.missions);
      return {
        id: r.id,
        objective: r.objective,
        baseBranch: r.baseBranch,
        status: r.status,
        missionCount: list.length,
        mergedCount: list.filter((m) => m.status === "merged").length,
        activeCount: list.filter((m) => m.status === "active").length,
        ownerSessionId: r.ownerSessionId,
        ownerPid: r.ownerPid,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  async getActiveRunId(): Promise<string | null> {
    return this.activeRunId;
  }

  async updateRun(runId: string, patch: RunUpdateInput): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    }
    const prev = run.status;
    if (patch.status !== undefined) run.status = patch.status;
    if (patch.objective !== undefined) run.objective = patch.objective;
    if (patch.verificationContract !== undefined) run.verificationContract = patch.verificationContract;
    if (patch.baseBranch !== undefined) run.baseBranch = patch.baseBranch;
    if (patch.maxConcurrency !== undefined) run.maxConcurrency = patch.maxConcurrency;
    if (patch.validatorEnabled !== undefined) run.validatorEnabled = patch.validatorEnabled;
    if (patch.maxValidationRounds !== undefined) run.maxValidationRounds = patch.maxValidationRounds;
    if (patch.finalValidatorEnabled !== undefined) run.finalValidatorEnabled = patch.finalValidatorEnabled;
    if (patch.maxFinalAuditRounds !== undefined) run.maxFinalAuditRounds = patch.maxFinalAuditRounds;
    if (patch.autoFixOnAuditFail !== undefined) run.autoFixOnAuditFail = patch.autoFixOnAuditFail;
    if (patch.keepWorkersWarm !== undefined) run.keepWorkersWarm = patch.keepWorkersWarm;
    if (patch.roleModels !== undefined) run.roleModels = structuredClone(patch.roleModels);
    if (patch.finalAuditStatus !== undefined) run.finalAuditStatus = patch.finalAuditStatus;
    if (patch.ownerSessionId !== undefined) run.ownerSessionId = patch.ownerSessionId;
    if (patch.ownerPid !== undefined) run.ownerPid = patch.ownerPid;
    run.revision += 1;
    run.updatedAt = new Date().toISOString();
    if (patch.status && patch.status !== prev) {
      const eventType =
        patch.status === "paused"
          ? "run_paused"
          : (patch.status === "active" || patch.status === "verifying") && prev === "paused"
            ? "run_resumed"
            : patch.status === "completed"
              ? "run_completed"
              : patch.status === "abandoned"
                ? "run_abandoned"
                : null;
      if (eventType) {
        await this.appendEvent({
          runId,
          type: eventType,
          actor: patch.actor ?? "orchestrator",
          summary: `Run ${runId} transitioned ${prev} -> ${patch.status}`,
        });
      }
    }
    return structuredClone(run);
  }

  async addMissions(
    runId: string,
    missions: MissionPlanInput[],
    options?: { existingBranches?: readonly string[]; expectedRevision?: number; actor?: string },
  ): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    }
    const existingIds = new Set(Object.keys(run.missions));
    const batchIds = new Set<string>();
    const existingBranches = new Set([
      ...(options?.existingBranches ?? []),
      ...Object.values(run.missions).map((m) => m.branch),
    ]);

    for (const m of missions) {
      if (existingIds.has(m.id) || batchIds.has(m.id)) {
        throw new SwarmProtocolError("DUPLICATE_MISSION", `Duplicate mission ID "${m.id}".`);
      }
      batchIds.add(m.id);
      const branch = `feat/${slugify(m.title)}`;
      if (existingBranches.has(branch)) {
        throw new SwarmProtocolError("DUPLICATE_BRANCH", `Branch "${branch}" already exists.`);
      }
      existingBranches.add(branch);
    }

    const allKnownIds = new Set([...existingIds, ...batchIds]);
    for (const m of missions) {
      for (const dep of m.deps) {
        if (!allKnownIds.has(dep)) {
          throw new SwarmProtocolError("MISSING_DEP", `Mission "${m.id}" references unknown dep "${dep}".`);
        }
      }
    }

    const now = new Date().toISOString();
    for (const m of missions) {
      run.missions[m.id] = {
        id: m.id,
        title: m.title,
        kind: m.kind,
        description: m.description,
        scope: [...m.scope],
        deps: [...m.deps],
        verification: m.verification,
        tasks: (m.tasks ?? []).map((t, idx) =>
          typeof t === "string"
            ? { id: `T${idx + 1}`, title: t, done: false }
            : { id: t.id ?? `T${idx + 1}`, title: t.title, done: Boolean(t.done) },
        ),
        branch: `feat/${slugify(m.title)}`,
        worktreePath: this.getWorktreePath(runId, m.id),
        status: "planned",
        reviewRound: 0,
        retryCount: 0,
        humanStopped: false,
        createdAt: now,
        updatedAt: now,
      };
      run.missionOrder.push(m.id);
    }
    if (
      run.status === "verifying" ||
      run.finalAuditStatus === "disapproved" ||
      run.finalAuditStatus === "approved"
    ) {
      run.status = "active";
      run.finalAuditStatus = "idle";
    }
    run.revision += 1;
    run.updatedAt = now;
    return structuredClone(run);
  }

  async updateMission(
    runId: string,
    missionId: string,
    patch: Parameters<ISwarmStore["updateMission"]>[2],
  ): Promise<SwarmRunState> {
    if (patch.callerRole === "validator") {
      throw new SwarmProtocolError("ROLE_FORBIDDEN", "Validators cannot mutate mission records.");
    }
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const m = run.missions[missionId];
    if (!m) throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);

    const prevStatus = m.status;
    if (patch.status !== undefined) m.status = patch.status;
    if (patch.progressSummary !== undefined) m.progressSummary = patch.progressSummary;
    if (patch.worktreePath !== undefined) m.worktreePath = patch.worktreePath;
    if (patch.reviewRound !== undefined) m.reviewRound = patch.reviewRound;
    if (patch.retryCount !== undefined) m.retryCount = patch.retryCount;
    if (patch.humanStopped !== undefined) m.humanStopped = patch.humanStopped;
    if (patch.error === null) {
      delete m.error;
    } else if (patch.error !== undefined) {
      m.error = patch.error;
    }
    if (patch.tasks !== undefined) {
      m.tasks = structuredClone(patch.tasks);
    }
    if (patch.taskDoneIds) {
      const doneSet = new Set(patch.taskDoneIds);
      const now = new Date().toISOString();
      for (const task of m.tasks) {
        if (doneSet.has(task.id)) {
          task.done = true;
          task.completedAt = now;
        }
      }
    }
    m.updatedAt = new Date().toISOString();
    run.revision += 1;
    run.updatedAt = m.updatedAt;
    if (patch.status && patch.status !== prevStatus) {
      const type =
        patch.status === "active"
          ? "mission_started"
          : patch.status === "completed"
            ? "mission_completed"
            : patch.status === "abandoned"
              ? "mission_abandoned"
              : patch.status === "failed"
                ? "mission_failed"
                : "mission_progress";
      await this.appendEvent({
        runId,
        type,
        actor: patch.actor ?? patch.callerRole ?? "orchestrator",
        missionId,
        summary: `Mission ${missionId} ${prevStatus} -> ${patch.status}`,
      });
    } else if (patch.progressSummary !== undefined || patch.taskDoneIds?.length) {
      await this.appendEvent({
        runId,
        type: "mission_progress",
        actor: patch.actor ?? patch.callerRole ?? "orchestrator",
        missionId,
        summary: patch.progressSummary ?? "Completed tasks",
      });
    }
    return structuredClone(run);
  }

  async patchMissionScope(
    runId: string,
    missionId: string,
    scope: string[],
    options?: { expectedRevision?: number; callerRole?: CallerRole; actor?: string },
  ): Promise<SwarmRunState> {
    if (options?.callerRole === "validator") {
      throw new SwarmProtocolError("ROLE_FORBIDDEN", "Validators cannot patch mission scope.");
    }
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const m = run.missions[missionId];
    if (!m) throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);
    m.scope = [...scope];
    m.updatedAt = new Date().toISOString();
    run.revision += 1;
    await this.appendEvent({
      runId,
      type: "mission_scope_patched",
      missionId,
      summary: `Patched scope for ${missionId}`,
    });
    return structuredClone(run);
  }

  async recordReview(
    runId: string,
    missionId: string,
    verdict: MissionReviewVerdict,
  ): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const m = run.missions[missionId];
    if (!m) throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);

    m.reviewRound += 1;
    m.lastReviewedSha = verdict.commitSha;
    m.latestReview = structuredClone({ ...verdict, round: m.reviewRound });

    if (verdict.status !== "clean" || verdict.merge !== "merge") {
      if (m.status === "completed") {
        m.status = "active";
      }
    }
    m.updatedAt = new Date().toISOString();
    run.revision += 1;
    await this.appendEvent({
      runId,
      type: "validation_submitted",
      actor: verdict.reviewerAgentId,
      missionId,
      agentId: verdict.reviewerAgentId,
      summary: `Validation ${verdict.status} (${verdict.merge})`,
    });
    return structuredClone(run);
  }

  async recordFinalAudit(runId: string, verdict: FinalAuditVerdict): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    if (verdict.verdict !== "approved" && verdict.verdict !== "disapproved") {
      throw new SwarmProtocolError("INVALID_TRANSITION", `Invalid final audit verdict: ${String(verdict.verdict)}`);
    }
    if (!verdict.commitSha?.trim() || !verdict.summary?.trim()) {
      throw new SwarmProtocolError("INVALID_TRANSITION", "Final audit verdict requires non-empty commitSha and summary.");
    }
    run.latestFinalAudit = structuredClone(verdict);
    run.lastAuditedSha = verdict.commitSha;
    run.finalAuditRound = verdict.round;
    run.finalAuditStatus = verdict.verdict;
    run.revision += 1;
    run.updatedAt = new Date().toISOString();
    await this.appendEvent({
      runId,
      type: "final_audit_result",
      actor: verdict.verifierAgentId,
      missionId: FINAL_AUDIT_MISSION_ID,
      agentId: verdict.verifierAgentId,
      summary: `Final audit round ${verdict.round}: ${verdict.verdict} (${verdict.summary})`,
      data: { verdict: verdict.verdict, commitSha: verdict.commitSha, round: verdict.round },
    });
    return structuredClone(run);
  }

  async skipFinalAudit(
    runId: string,
    options?: {
      skippedBy?: string;
      reason?: string;
      expectedRevision?: number;
      callerRole?: CallerRole;
    },
  ): Promise<SwarmRunState> {
    if (options?.callerRole && options.callerRole !== "human") {
      throw new SwarmProtocolError(
        "ROLE_FORBIDDEN",
        `Role "${options.callerRole}" is forbidden from skipping final validation. Human-only action.`,
      );
    }
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const now = new Date().toISOString();
    run.finalAuditStatus = "skipped";
    run.finalAuditSkippedBy = options?.skippedBy ?? "human";
    run.finalAuditSkippedAt = now;
    if (options?.reason !== undefined) {
      run.finalAuditSkipReason = options.reason;
    }
    run.revision += 1;
    run.updatedAt = now;
    await this.appendEvent({
      runId,
      type: "final_audit_skipped",
      actor: run.finalAuditSkippedBy,
      missionId: FINAL_AUDIT_MISSION_ID,
      summary: `Final audit skipped by ${run.finalAuditSkippedBy}${options?.reason ? `: ${options.reason}` : ""}`,
    });

    const missions = run.missionOrder
      .map((id) => run.missions[id])
      .filter((m): m is MissionRecord => Boolean(m));
    if (
      missions.length > 0 &&
      missions.every((m) => m.status === "merged" || m.status === "abandoned") &&
      run.status !== "completed"
    ) {
      run.status = "completed";
      await this.appendEvent({
        runId,
        type: "run_completed",
        actor: run.finalAuditSkippedBy,
        summary: `Run ${runId} completed (final audit skipped)`,
      });
    }
    return structuredClone(run);
  }

  async approveArtifact(
    runId: string,
    missionId: string,
    commitSha: string,
  ): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const m = run.missions[missionId];
    if (!m) throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);
    m.humanApprovedSha = commitSha;
    m.humanApprovedAt = new Date().toISOString();
    m.updatedAt = m.humanApprovedAt;
    run.revision += 1;
    await this.appendEvent({
      runId,
      type: "artifact_approved",
      missionId,
      summary: `Artifact ${missionId} approved`,
    });
    return structuredClone(run);
  }

  async markMerged(
    runId: string,
    missionId: string,
    mergedCommitSha: string | null,
  ): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const m = run.missions[missionId];
    if (!m) throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);
    m.status = "merged";
    m.mergedAt = new Date().toISOString();
    if (mergedCommitSha !== null) {
      m.mergedCommitSha = mergedCommitSha;
    }
    m.updatedAt = m.mergedAt;
    run.revision += 1;
    await this.appendEvent({
      runId,
      type: "merge_succeeded",
      missionId,
      summary: `Mission ${missionId} merged`,
    });
    return structuredClone(run);
  }

  async registerRoster(runId: string, entry: RegisterRosterInput): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    run.roster[entry.agentId] = {
      agentId: entry.agentId,
      name: entry.name,
      role: entry.role,
      missionId: entry.missionId,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      status: entry.status ?? "working",
      model: entry.model,
      thinkingLevel: entry.thinkingLevel,
      lastReadBoardSeq: entry.lastReadBoardSeq ?? 0,
      turns: entry.turns ?? 1,
      startedAt: entry.startedAt ?? new Date().toISOString(),
      humanStopped: false,
      tokens: 0,
      cost: 0,
      logTail: [],
    };
    run.revision += 1;
    await this.appendEvent({
      runId,
      type:
        entry.role === "final-validator"
          ? "final_audit_started"
          : entry.role === "validator"
            ? "validator_spawned"
            : "worker_spawned",
      missionId: entry.missionId,
      agentId: entry.agentId,
      summary: `Spawned ${entry.role} ${entry.name} (${entry.agentId})`,
    });
    return structuredClone(run);
  }

  async updateRoster(
    runId: string,
    agentId: string,
    patch: RosterUpdateInput,
  ): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const r = run.roster[agentId];
    if (!r) throw new SwarmProtocolError("NOT_FOUND", `Roster "${agentId}" not found.`);
    const prevStatus = r.status;
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.model !== undefined) r.model = patch.model;
    if (patch.thinkingLevel === null) delete r.thinkingLevel;
    else if (patch.thinkingLevel !== undefined) r.thinkingLevel = patch.thinkingLevel;
    if (patch.lastReadBoardSeq !== undefined) r.lastReadBoardSeq = patch.lastReadBoardSeq;
    if (patch.lastPostBoardSeq !== undefined) r.lastPostBoardSeq = patch.lastPostBoardSeq;
    if (patch.turns !== undefined) r.turns = patch.turns;
    if (patch.endedAt === null) delete r.endedAt;
    else if (patch.endedAt !== undefined) r.endedAt = patch.endedAt;
    if (patch.humanStopped !== undefined) r.humanStopped = patch.humanStopped;
    if (patch.currentActivity === null) delete r.currentActivity;
    else if (patch.currentActivity !== undefined) r.currentActivity = patch.currentActivity;
    if (patch.lastTool !== undefined) r.lastTool = patch.lastTool;
    if (patch.tokens !== undefined) r.tokens = patch.tokens;
    if (patch.tokenBreakdown !== undefined) r.tokenBreakdown = patch.tokenBreakdown;
    if (patch.cost !== undefined) r.cost = patch.cost;
    if (patch.logLine) r.logTail.push(patch.logLine);
    if (patch.logTail) r.logTail = [...patch.logTail];
    if (patch.error === null) delete r.error;
    else if (patch.error !== undefined) r.error = patch.error;

    if (patch.status && patch.status !== prevStatus) {
      if (patch.status === "killed") {
        await this.appendEvent({
          runId,
          type: "agent_killed",
          missionId: r.missionId,
          agentId,
          summary: `${r.role} ${r.name} killed`,
        });
      } else if (patch.status === "stopped") {
        await this.appendEvent({
          runId,
          type: "worker_stopped",
          missionId: r.missionId,
          agentId,
          summary: `${r.role} ${r.name} stopped`,
        });
      } else if (patch.status === "failed" || patch.status === "died") {
        await this.appendEvent({
          runId,
          type: "worker_exited",
          missionId: r.missionId,
          agentId,
          summary: `${r.role} ${r.name} exited (${patch.status})`,
        });
      }
      // Note: NO event emitted on transition to `waiting` or `working` (matches SwarmStore!)
    }
    return structuredClone(run);
  }

  async postBoardMessage(runId: string, input: PostBoardMessageInput): Promise<BoardMessage> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const list = this.boards.get(runId) ?? [];
    const seq = list.length + 1;
    const mentions =
      input.mentions && input.mentions.length > 0
        ? [...input.mentions]
        : mockParseMentions(input.text);
    const msg: BoardMessage = {
      seq,
      runId,
      from: input.from,
      fromRole: input.fromRole,
      text: input.text,
      mentions,
      kind: input.kind ?? "chat",
      missionId: input.missionId,
      timestamp: new Date().toISOString(),
    };
    list.push(msg);
    this.boards.set(runId, list);

    for (const r of Object.values(run.roster)) {
      if (r.name.toLowerCase() === input.from.toLowerCase() || r.agentId === input.from) {
        r.lastPostBoardSeq = seq;
      }
    }

    await this.appendEvent({
      runId,
      type: "board_posted",
      actor: input.from,
      missionId: input.missionId,
      summary: `#${seq} ${input.from}: ${input.text.slice(0, 80)}`,
      data: { seq, kind: msg.kind, mentions },
    });

    return structuredClone(msg);
  }

  async readBoard(runId: string, options?: ReadBoardOptions): Promise<ReadBoardResult> {
    const list = this.boards.get(runId) ?? [];
    const head = list.length;
    if (options?.seqs && options.seqs.length > 0) {
      const seqSet = new Set(options.seqs);
      const matched = list.filter((m) => seqSet.has(m.seq));
      return { messages: structuredClone(matched), head };
    }
    if (options?.since !== undefined) {
      const limit = options.limit ?? 50;
      const matched = list.filter((m) => m.seq > options.since!).slice(0, limit);
      return { messages: structuredClone(matched), head };
    }
    const limit = options?.limit ?? 20;
    return { messages: structuredClone(list.slice(-limit)), head };
  }

  async getBoardHead(runId: string): Promise<number> {
    return (this.boards.get(runId) ?? []).length;
  }

  async sendMessage(runId: string, message: SendMessageInput): Promise<InboxMessage> {
    const list = this.inboxes.get(runId) ?? [];
    const msg: InboxMessage = {
      id: `msg-${++this.idSeq}`,
      from: message.from,
      to: message.to,
      missionId: message.missionId,
      text: message.text,
      createdAt: new Date().toISOString(),
    };
    list.push(msg);
    this.inboxes.set(runId, list);
    return structuredClone(msg);
  }

  async readInbox(
    runId: string,
    recipient: string,
    options?: ReadInboxOptions,
  ): Promise<InboxMessage[]> {
    const list = this.inboxes.get(runId) ?? [];
    const matched = list.filter((m) => {
      if (m.to !== recipient) return false;
      if (options?.unreadOnly && m.readAt) return false;
      return true;
    });
    const sliced = options?.limit ? matched.slice(0, options.limit) : matched;
    if (options?.markRead) {
      const now = new Date().toISOString();
      for (const m of sliced) {
        m.readAt = now;
      }
    }
    return structuredClone(sliced);
  }

  async recordFinding(runId: string, finding: RecordFindingInput): Promise<SwarmFindingRecord> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const record: SwarmFindingRecord = {
      id: `finding-${++this.idSeq}`,
      missionId: finding.missionId,
      author: finding.author,
      title: finding.title,
      summary: finding.summary,
      details: finding.details,
      files: finding.files ? [...finding.files] : undefined,
      createdAt: new Date().toISOString(),
    };
    run.findings.push(record);
    run.revision += 1;
    await this.appendEvent({
      runId,
      type: "finding_recorded",
      actor: finding.author,
      missionId: finding.missionId,
      summary: `Finding: ${finding.title}`,
    });
    return structuredClone(record);
  }

  async appendEvent(event: SwarmEventInput): Promise<SwarmEvent> {
    const list = this.events.get(event.runId) ?? [];
    const full: SwarmEvent = {
      id: event.id ?? `ev-${++this.idSeq}`,
      seq: list.length + 1,
      runId: event.runId,
      type: event.type,
      timestamp: event.timestamp ?? new Date().toISOString(),
      actor: event.actor,
      missionId: event.missionId,
      agentId: event.agentId,
      summary: event.summary,
      data: event.data,
    };
    list.push(full);
    this.events.set(event.runId, list);
    return structuredClone(full);
  }

  async getRecentEvents(runId: string, limit = 20): Promise<SwarmEvent[]> {
    const list = this.events.get(runId) ?? [];
    return structuredClone(list.slice(-limit));
  }

  renderMissionsMarkdown(_state: SwarmRunState): string {
    return "# Swarm Missions\n";
  }

  validatePlan(
    missions: MissionPlanInput[],
    options?: PlanValidationOptions,
  ): PlanValidationResult {
    const errors: PlanValidationIssue[] = [];
    const branches: Record<string, string> = {};
    const existingIds = new Set(Object.keys(options?.existingMissions ?? {}));
    const seenIds = new Set<string>();
    const seenBranches = new Set<string>([
      ...(options?.existingBranches ?? []),
      ...Object.values(options?.existingMissions ?? {}).map((m) => m.branch),
    ]);

    const normScope = (raw: string): string | null => {
      const s = raw.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
      if (
        !s ||
        s.startsWith("/") ||
        s.includes("..") ||
        s.includes("*") ||
        s.includes("?") ||
        s === ".git" ||
        s.startsWith(".git/") ||
        s === ".pi/swarm" ||
        s.startsWith(".pi/swarm/")
      ) {
        return null;
      }
      return s;
    };
    const overlaps = (a: string, b: string): boolean =>
      a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

    const openBuildScopes: Array<{ id: string; scope: string[] }> = [];
    for (const m of Object.values(options?.existingMissions ?? {})) {
      if (m.kind === "build" && m.status !== "merged" && m.status !== "abandoned") {
        openBuildScopes.push({ id: m.id, scope: m.scope.map((s) => normScope(s) ?? s) });
      }
    }

    for (const m of missions) {
      if (existingIds.has(m.id) || seenIds.has(m.id)) {
        errors.push({ code: "DUPLICATE_MISSION", message: `Duplicate mission ID "${m.id}"`, missionId: m.id });
      }
      seenIds.add(m.id);

      if (!/^[ -~]+$/.test(m.title.trim()) || !/[A-Za-z0-9]/.test(m.title.trim())) {
        errors.push({ code: "INVALID_TITLE", message: `Invalid non-ASCII title for "${m.id}"`, missionId: m.id });
      }

      const branch = `feat/${slugify(m.title)}`;
      if (seenBranches.has(branch)) {
        errors.push({ code: "DUPLICATE_BRANCH", message: `Duplicate branch "${branch}"`, missionId: m.id });
      }
      seenBranches.add(branch);
      branches[m.id] = branch;

      if (m.scope.length === 0) {
        errors.push({ code: "SCOPE_VIOLATION", message: `Mission "${m.id}" must declare non-empty scope`, missionId: m.id });
      }
      const normList: string[] = [];
      for (const raw of m.scope) {
        const n = normScope(raw);
        if (!n) {
          errors.push({ code: "SCOPE_VIOLATION", message: `Invalid scope path "${raw}" on "${m.id}"`, missionId: m.id });
        } else {
          normList.push(n);
        }
      }

      if (m.kind === "build") {
        for (const other of openBuildScopes) {
          for (const a of normList) {
            for (const b of other.scope) {
              if (overlaps(a, b)) {
                errors.push({
                  code: "SCOPE_OVERLAP",
                  message: `Scope "${a}" on "${m.id}" overlaps "${b}" on "${other.id}"`,
                  missionId: m.id,
                });
              }
            }
          }
        }
        openBuildScopes.push({ id: m.id, scope: normList });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      waves: errors.length === 0 ? [missions.map((m) => m.id)] : [],
      branches,
    };
  }

  getRunDir(runId: string): string {
    return `/mock/repo/.pi/swarm/runs/${runId}`;
  }

  getWorktreePath(runId: string, slot: string): string {
    return `/mock/repo/.pi/swarm/worktrees/${runId}-${slot}`;
  }
}

// ============================================================================
// Controllable Mock Worktree Manager
// ============================================================================

interface MockBranchState {
  branch: string;
  worktreePath: string;
  headSha: string;
  commitsAhead: number;
  changedFiles: string[];
  dirty: boolean;
  rebaseResult?: AutoRebaseResult;
}

class MockWorktreeManager implements IWorktreeManager {
  readonly repoRoot = "/mock/repo";
  baseBranch = "main";
  baseSha = "base000000000";
  baseDirty = false;
  readonly branches = new Map<string, MockBranchState>();
  readonly byWorktree = new Map<string, MockBranchState>();
  readonly mergedBranches: Array<{ branch: string; baseBranch: string; mergedCommitSha: string }> = [];
  readonly createWorktreeCalls: Array<{ branch: string; worktreePath: string; reuseExistingBranch?: boolean }> = [];
  failCreateWorktreeForBranch = new Set<string>();
  mergeCallCount = 0;
  private shaCounter = 0;

  private getState(refOrPath?: string): MockBranchState | undefined {
    if (!refOrPath) return undefined;
    return this.byWorktree.get(refOrPath) ?? this.branches.get(refOrPath);
  }

  simulateCommit(branch: string, changedFiles: string[], shaOverride?: string): string {
    const st = this.branches.get(branch);
    if (!st) throw new Error(`Unknown branch ${branch}`);
    const sha = shaOverride ?? `sha-${++this.shaCounter}-${branch.replace(/\//g, "-")}`;
    st.headSha = sha;
    st.commitsAhead += 1;
    st.changedFiles = Array.from(new Set([...st.changedFiles, ...changedFiles]));
    st.dirty = false;
    return sha;
  }

  async ensureRepoReady(preferredBaseBranch?: string): Promise<RepoReadyResult> {
    if (preferredBaseBranch) this.baseBranch = preferredBaseBranch;
    return {
      repoRoot: this.repoRoot,
      baseBranch: this.baseBranch,
      headSha: this.baseSha,
      initializedRepo: false,
      createdInitialCommit: false,
    };
  }

  async getCurrentBranch(): Promise<string> {
    return this.baseBranch;
  }

  async listLocalBranches(): Promise<string[]> {
    return [this.baseBranch, ...Array.from(this.branches.keys())];
  }

  async createWorktree(options: {
    branch: string;
    baseBranch: string;
    worktreePath: string;
    reuseExistingBranch?: boolean;
  }): Promise<CreateWorktreeResult> {
    this.createWorktreeCalls.push({
      branch: options.branch,
      worktreePath: options.worktreePath,
      reuseExistingBranch: options.reuseExistingBranch,
    });
    if (this.failCreateWorktreeForBranch.has(options.branch)) {
      throw new SwarmProtocolError("GIT_ERROR", `Simulated worktree error for ${options.branch}`);
    }
    let st = this.branches.get(options.branch);
    if (!st) {
      st = {
        branch: options.branch,
        worktreePath: options.worktreePath,
        headSha: this.baseSha,
        commitsAhead: 0,
        changedFiles: [],
        dirty: false,
      };
      this.branches.set(options.branch, st);
    } else {
      st.worktreePath = options.worktreePath;
    }
    this.byWorktree.set(options.worktreePath, st);
    return {
      branch: options.branch,
      worktreePath: options.worktreePath,
      baseSha: this.baseSha,
    };
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    this.byWorktree.delete(worktreePath);
  }

  async getHeadSha(cwd?: string): Promise<string> {
    const st = this.getState(cwd);
    return st ? st.headSha : this.baseSha;
  }

  async getCommitCountAhead(_baseBranch: string, targetRef: string, cwd?: string): Promise<number> {
    const st = this.branches.get(targetRef) ?? this.getState(cwd);
    return st ? st.commitsAhead : 0;
  }

  async getChangedFiles(_baseBranch: string, targetRef: string, cwd?: string): Promise<string[]> {
    const st = this.branches.get(targetRef) ?? this.getState(cwd);
    return st ? [...st.changedFiles] : [];
  }

  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    return this.byWorktree.get(worktreePath)?.dirty ?? false;
  }

  async isBaseCleanOnBranch(expectedBranch: string): Promise<BaseBranchCleanCheck> {
    if (this.baseBranch !== expectedBranch) {
      return {
        ok: false,
        currentBranch: this.baseBranch,
        dirty: this.baseDirty,
        reason: `Expected branch "${expectedBranch}", got "${this.baseBranch}".`,
      };
    }
    if (this.baseDirty) {
      return {
        ok: false,
        currentBranch: this.baseBranch,
        dirty: true,
        reason: "Base checkout has uncommitted changes.",
      };
    }
    return { ok: true, currentBranch: this.baseBranch, dirty: false };
  }

  async autoRebase(worktreePath: string, _baseBranch: string): Promise<AutoRebaseResult> {
    const st = this.byWorktree.get(worktreePath);
    if (!st) return { status: "up-to-date" };
    if (st.dirty) return { status: "skipped_dirty", message: "Dirty worktree" };
    if (st.rebaseResult) {
      return st.rebaseResult;
    }
    return { status: "up-to-date", newHeadSha: st.headSha };
  }

  async mergeBranch(options: {
    baseBranch: string;
    branch: string;
    commitMessage?: string;
    noFf?: boolean;
  }): Promise<MergeBranchResult> {
    this.mergeCallCount += 1;
    const st = this.branches.get(options.branch);
    const mergedSha = `merge-${this.mergeCallCount}-${st?.headSha ?? "head"}`;
    this.baseSha = mergedSha;
    this.mergedBranches.push({
      branch: options.branch,
      baseBranch: options.baseBranch,
      mergedCommitSha: mergedSha,
    });
    return {
      mergedCommitSha: mergedSha,
      strategy: "merge",
      changedFiles: st ? [...st.changedFiles] : [],
    };
  }

  async getDiffSummary(baseBranch: string, targetRef: string, options?: { cwd?: string }): Promise<DiffSummary> {
    const st = this.branches.get(targetRef) ?? this.getState(options?.cwd);
    const changedFiles = st ? [...st.changedFiles] : [];
    return {
      baseBranch,
      branch: targetRef,
      headSha: st?.headSha ?? this.baseSha,
      commitsAhead: st?.commitsAhead ?? 0,
      changedFiles,
      stat: changedFiles.map((f) => ` ${f} | 10 ++++++++++`).join("\n"),
      diff: changedFiles.map((f) => `diff --git a/${f} b/${f}\n+// changed`).join("\n"),
    };
  }

  async safeTeardown(targets: SafeTeardownTarget[]): Promise<SafeTeardownResult> {
    const removed: SafeTeardownResult["removed"] = [];
    const skipped: SafeTeardownResult["skipped"] = [];
    const errors: SafeTeardownResult["errors"] = [];

    for (const t of targets) {
      if (t.hasActiveAgent) {
        skipped.push({
          missionId: t.missionId,
          worktreePath: t.worktreePath,
          branch: t.branch,
          action: "skipped_active",
          reason: "Active agent running",
        });
        continue;
      }
      const st = this.byWorktree.get(t.worktreePath);
      if (st?.dirty) {
        skipped.push({
          missionId: t.missionId,
          worktreePath: t.worktreePath,
          branch: t.branch,
          action: "skipped_dirty",
          reason: "Uncommitted changes",
        });
        continue;
      }
      this.byWorktree.delete(t.worktreePath);
      removed.push({
        missionId: t.missionId,
        worktreePath: t.worktreePath,
        branch: t.branch,
        action: "removed",
      });
    }
    return { removed, skipped, errors };
  }
}

// ============================================================================
// Scriptable Mock Persistent Swarm Transport (Warm Sessions + Hot Model Switch)
// ============================================================================

interface ScriptTurnControls {
  turn: number;
  prompt: string;
  history: string[];
  getModel: () => string | undefined;
  steers: string[];
  followUps: string[];
  isAborted: () => boolean;
  onAbort: (cb: (reason?: string) => void) => void;
  postBoard: (text: string, kind?: BoardMessage["kind"]) => Promise<BoardMessage>;
}

type WorkerTurnHandler = (
  req: WorkerSpawnRequest,
  controls: ScriptTurnControls,
) => Promise<AgentTurnResult>;

type ValidatorTurnHandler = (
  req: ValidatorSpawnRequest,
  controls: ScriptTurnControls,
) => Promise<AgentTurnResult>;

type FinalValidatorTurnHandler = (
  req: FinalValidatorSpawnRequest,
  controls: ScriptTurnControls,
) => Promise<AgentTurnResult>;

interface TrackedMockHandle {
  agentId: string;
  name: string;
  missionId: string;
  role: "worker" | "validator" | "final-validator";
  handle: PersistentAgentHandle;
  history: string[];
  wakePrompts: string[];
  modelSwitches: Array<{ model: string; thinkingLevel?: ThinkingLevel }>;
  killed: boolean;
  killReason?: string;
  getWakeCount: () => number;
}

class MockSwarmTransport implements ISwarmTransport {
  readonly workerRequests: WorkerSpawnRequest[] = [];
  readonly validatorRequests: ValidatorSpawnRequest[] = [];
  readonly finalValidatorRequests: FinalValidatorSpawnRequest[] = [];
  readonly trackedHandles: TrackedMockHandle[] = [];
  readonly steersByAgent = new Map<string, string[]>();
  readonly followUpsByAgent = new Map<string, string[]>();
  readonly rejectModels = new Set<string>(["nonexistent/model"]);

  private readonly onWorker: WorkerTurnHandler;
  private readonly onValidator: ValidatorTurnHandler;
  private readonly onSwitchModel?: (
    agentName: string,
    modelOverride: string,
    thinkingLevel?: ThinkingLevel,
  ) => Promise<void> | void;
  readonly spawnFinalValidator?: (
    request: FinalValidatorSpawnRequest,
  ) => Promise<PersistentAgentHandle>;

  constructor(handlers: {
    onWorker: WorkerTurnHandler;
    onValidator?: ValidatorTurnHandler;
    onFinalValidator?: FinalValidatorTurnHandler;
    onSwitchModel?: (
      agentName: string,
      modelOverride: string,
      thinkingLevel?: ThinkingLevel,
    ) => Promise<void> | void;
  }) {
    this.onWorker = handlers.onWorker;
    this.onSwitchModel = handlers.onSwitchModel;
    this.onValidator =
      handlers.onValidator ??
      (async (req, ctrl) => ({
        agentId: req.agentId,
        name: req.name,
        missionId: req.mission.id,
        role: "validator",
        outcome: "completed",
        summary: "Clean validation",
        model: ctrl.getModel(),
        reviewVerdict: {
          commitSha: req.targetCommitSha ?? "",
          missionId: req.mission.id,
          branch: req.branch,
          reviewedAt: new Date().toISOString(),
          reviewerAgentId: req.agentId,
          status: "clean",
          merge: "merge",
          findings: [],
          checks: [{ name: "scope", passed: true }],
          decision: "Looks good to merge.",
        },
        tokens: 150,
        cost: 0.002,
      }));

    if (handlers.onFinalValidator) {
      const onFinalValidator = handlers.onFinalValidator;
      this.spawnFinalValidator = async (
        request: FinalValidatorSpawnRequest,
      ): Promise<PersistentAgentHandle> => {
        this.finalValidatorRequests.push(request);
        return this.createPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          keepWarm: request.keepWarm,
          initialPrompt: request.prompt,
          initialModel: request.modelOverride,
          runId: request.runId,
          store: request.store,
          onBoardPost: request.onBoardPost,
          runTurn: (ctrl) => onFinalValidator(request, ctrl),
        });
      };
    }
  }

  async spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle> {
    this.workerRequests.push(request);
    return this.createPersistentHandle({
      agentId: request.agentId,
      name: request.name,
      missionId: request.mission.id,
      role: "worker",
      keepWarm: request.keepWarm,
      initialPrompt: request.prompt,
      initialModel: request.modelOverride,
      runId: request.runId,
      store: request.store,
      onBoardPost: request.onBoardPost,
      runTurn: (ctrl) => this.onWorker(request, ctrl),
    });
  }

  async spawnValidator(request: ValidatorSpawnRequest): Promise<PersistentAgentHandle> {
    this.validatorRequests.push(request);
    return this.createPersistentHandle({
      agentId: request.agentId,
      name: request.name,
      missionId: request.mission.id,
      role: "validator",
      keepWarm: request.keepWarm,
      initialPrompt: request.prompt,
      initialModel: request.modelOverride,
      runId: request.runId,
      store: request.store,
      onBoardPost: request.onBoardPost,
      runTurn: (ctrl) => this.onValidator(request, ctrl),
    });
  }

  getTrackedByName(name: string): TrackedMockHandle[] {
    return this.trackedHandles.filter((h) => h.name === name);
  }

  private createPersistentHandle(opts: {
    agentId: string;
    name: string;
    missionId: string;
    role: "worker" | "validator" | "final-validator";
    keepWarm: boolean;
    initialPrompt: string;
    initialModel?: string;
    runId: string;
    store?: ISwarmStore;
    onBoardPost?: (msg: BoardMessage) => Promise<void> | void;
    runTurn: (controls: ScriptTurnControls) => Promise<AgentTurnResult>;
  }): PersistentAgentHandle {
    const steers: string[] = [];
    const followUps: string[] = [];
    const history: string[] = [];
    const wakePrompts: string[] = [];
    const modelSwitches: Array<{ model: string; thinkingLevel?: ThinkingLevel }> = [];
    this.steersByAgent.set(opts.agentId, steers);
    this.followUpsByAgent.set(opts.agentId, followUps);

    let state: RosterAgentStatus = "working";
    let currentModel: string | undefined = opts.initialModel;
    let aborted = false;
    let killed = false;
    let turnNumber = 0;
    let wakeCount = 0;
    let abortListeners: Array<(reason?: string) => void> = [];

    const executeTurn = async (prompt: string): Promise<AgentTurnResult> => {
      turnNumber += 1;
      aborted = false;
      abortListeners = [];
      state = "working";
      history.push(prompt);

      const controls: ScriptTurnControls = {
        turn: turnNumber,
        prompt,
        history,
        getModel: () => currentModel,
        steers,
        followUps,
        isAborted: () => aborted || killed,
        onAbort: (cb) => {
          if (aborted || killed) cb("Aborted");
          else abortListeners.push(cb);
        },
        postBoard: async (text, kind = "chat") => {
          if (!opts.store) {
            throw new Error("MockSwarmTransport postBoard requires store");
          }
          const msg = await opts.store.postBoardMessage(opts.runId, {
            from: opts.name,
            fromRole: opts.role === "worker" ? "worker" : "validator",
            text,
            kind,
            missionId: opts.missionId === FINAL_AUDIT_MISSION_ID ? undefined : opts.missionId,
          });
          if (opts.onBoardPost) {
            await opts.onBoardPost(msg);
          }
          return msg;
        },
      };

      const res = await opts.runTurn(controls);
      if (killed) {
        state = "killed";
      } else if (opts.keepWarm) {
        if (res.outcome === "completed" || res.outcome === "rate_limited") {
          state = "waiting";
        } else if (res.outcome === "aborted") {
          state = "stopped";
        } else {
          state = "failed";
        }
      } else {
        state = res.outcome === "completed" || res.outcome === "aborted" ? "stopped" : "failed";
      }
      return {
        ...res,
        name: res.name || opts.name,
        model: res.model ?? currentModel,
      };
    };

    let currentTurnPromise: Promise<AgentTurnResult> = executeTurn(opts.initialPrompt);

    const handle: PersistentAgentHandle = {
      agentId: opts.agentId,
      name: opts.name,
      missionId: opts.missionId,
      role: opts.role,

      getState(): RosterAgentStatus {
        return state;
      },

      getModel(): string | undefined {
        return currentModel;
      },

      async wake(prompt: string): Promise<AgentTurnResult> {
        if (killed || state === "killed") {
          throw new SwarmProtocolError("AGENT_KILLED", `Agent "${opts.name}" has been killed.`);
        }
        if (state !== "waiting") {
          throw new SwarmProtocolError("AGENT_NOT_WAITING", `Agent "${opts.name}" is ${state}.`);
        }
        wakeCount += 1;
        wakePrompts.push(prompt);
        currentTurnPromise = executeTurn(prompt);
        return currentTurnPromise;
      },

      async steer(message: string): Promise<void> {
        if (killed) return;
        steers.push(message);
      },

      async followUp(message: string): Promise<void> {
        if (killed) return;
        followUps.push(message);
      },

      async switchModel(
        modelOverride: string,
        thinkingLevel?: ThinkingLevel,
      ): Promise<ModelSwitchResult> {
        if (killed || state === "killed") {
          throw new SwarmProtocolError("AGENT_KILLED", `Agent "${opts.name}" has been killed.`);
        }
        if (state !== "waiting") {
          throw new SwarmProtocolError(
            "AGENT_NOT_WAITING",
            `Agent "${opts.name}" is currently ${state}; wait for waiting state before switching models.`,
          );
        }
        const trimmed = modelOverride.trim();
        if (!trimmed || rejectModels.has(trimmed)) {
          throw new SwarmProtocolError("MODEL_NOT_FOUND", `Model "${trimmed}" not found.`);
        }
        if (onSwitchModel) {
          await onSwitchModel(opts.name, trimmed, thinkingLevel);
        }
        if (killed || handle.getState() === "killed") {
          throw new SwarmProtocolError("AGENT_KILLED", `Agent "${opts.name}" was killed during model switch.`);
        }
        currentModel = trimmed;
        modelSwitches.push({ model: trimmed, thinkingLevel });
        return { model: trimmed, thinkingLevel };
      },

      async abort(reason?: string): Promise<void> {
        if (killed) return;
        aborted = true;
        if (state !== "working") {
          state = "stopped";
        }
        for (const cb of abortListeners.splice(0, abortListeners.length)) {
          cb(reason);
        }
      },

      async kill(reason?: string): Promise<void> {
        killed = true;
        aborted = true;
        state = "killed";
        tracked.killed = true;
        tracked.killReason = reason;
        for (const cb of abortListeners.splice(0, abortListeners.length)) {
          cb(reason);
        }
      },

      get currentTurn(): Promise<AgentTurnResult> {
        return currentTurnPromise;
      },
    };

    const rejectModels = this.rejectModels;
    const onSwitchModel = this.onSwitchModel;
    const tracked: TrackedMockHandle = {
      agentId: opts.agentId,
      name: opts.name,
      missionId: opts.missionId,
      role: opts.role,
      handle,
      history,
      wakePrompts,
      modelSwitches,
      killed: false,
      getWakeCount: () => wakeCount,
    };
    this.trackedHandles.push(tracked);

    return handle;
  }
}

function makeSettings(overrides: Partial<SwarmSettings> = {}): SwarmSettings {
  return {
    ...DEFAULT_SWARM_SETTINGS,
    rateLimitBaseBackoffMs: 40,
    rateLimitMaxBackoffMs: 160,
    ...overrides,
  };
}

// ============================================================================
// 1. 3-Role Models, Warm Sessions, Peer Board & Hot Model Switch Tests
// ============================================================================

describe("Pi Swarm 3-Role Models, Warm Persistent Sessions & Shared Board", () => {
  it("resolves 3-role models: workerModel -> Workers, validatorModel -> BOTH Per-Mission & Final Validators", async () => {
    // Unit-check resolveRoleModel directly
    const cfg = makeSettings({
      orchestratorModel: "anthropic/claude-opus-4",
      orchestratorThinkingLevel: "high",
      workerModel: "openai/gpt-5-codex",
      workerThinkingLevel: "medium",
      validatorModel: "anthropic/claude-sonnet-4",
      validatorThinkingLevel: "high",
      fallbackModels: ["google/gemini-2.5-pro"],
    });
    assert.deepEqual(resolveRoleModel("orchestrator", cfg), {
      model: "anthropic/claude-opus-4",
      thinkingLevel: "high",
    });
    assert.deepEqual(resolveRoleModel("worker", cfg), {
      model: "openai/gpt-5-codex",
      thinkingLevel: "medium",
    });
    assert.deepEqual(resolveRoleModel("validator", cfg), {
      model: "anthropic/claude-sonnet-4",
      thinkingLevel: "high",
    });
    assert.deepEqual(resolveRoleModel("worker", cfg, "custom/fast-model", "low"), {
      model: "custom/fast-model",
      thinkingLevel: "low",
    });

    // End-to-end check inside SwarmOrchestrator
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, ["src/core.ts"], "core-sha-1");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Implemented core",
          workerDone: { missionId: req.mission.id, summary: "Implemented core" },
          tokens: 200,
          cost: 0.002,
        };
      },
      onFinalValidator: async (req) => ({
        agentId: req.agentId,
        name: req.name,
        missionId: FINAL_AUDIT_MISSION_ID,
        role: "final-validator",
        outcome: "completed",
        summary: "Approved",
        finalAuditVerdict: {
          commitSha: req.targetCommitSha,
          baseBranch: req.baseBranch,
          auditedAt: new Date().toISOString(),
          verifierAgentId: req.agentId,
          verdict: "approved",
          summary: "Verified on base",
          checks: [{ name: "tests", passed: true }],
          findings: [],
          round: req.round,
        },
        tokens: 250,
        cost: 0.003,
      }),
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => cfg,
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "3-role model verification",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-3role",
      validatorEnabled: true,
      finalValidatorEnabled: true,
      missions: [
        {
          id: "M1",
          title: "Core logic",
          kind: "build",
          description: "Build core",
          scope: ["src/core.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    assert.equal(transport.workerRequests[0]!.modelOverride, "openai/gpt-5-codex");
    assert.equal(transport.workerRequests[0]!.thinkingLevel, "medium");
    assert.equal(transport.validatorRequests[0]!.modelOverride, "anthropic/claude-sonnet-4");
    assert.equal(transport.validatorRequests[0]!.thinkingLevel, "high");
    assert.equal(transport.finalValidatorRequests[0]!.modelOverride, "anthropic/claude-sonnet-4");
    assert.equal(transport.finalValidatorRequests[0]!.thinkingLevel, "high");

    const snap = orchestrator.getSnapshot();
    assert.equal(snap.roleModels.orchestrator?.model, "anthropic/claude-opus-4");
    assert.equal(snap.roleModels.worker?.model, "openai/gpt-5-codex");
    assert.equal(snap.roleModels.validator?.model, "anthropic/claude-sonnet-4");
    assert.deepEqual(snap.roleModels.fallbackModels, ["google/gemini-2.5-pro"]);

    await orchestrator.dispose();
  });

  it("runs warm Worker fix loop: Worker parks waiting -> Validator rejects -> @M1 wakes EXACT SAME handle (spawnCount=1, wakeCount=1) -> fix -> clean -> auto-killed on merge", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let reviewAttempts = 0;
    const seenReviewShas: string[] = [];
    const seenWorkerTurns: Array<{ turn: number; agentId: string; historyLen: number; prompt: string }> = [];

    const transport = new MockSwarmTransport({
      onWorker: async (req, ctrl) => {
        seenWorkerTurns.push({
          turn: ctrl.turn,
          agentId: req.agentId,
          historyLen: ctrl.history.length,
          prompt: ctrl.prompt,
        });
        if (ctrl.turn === 2) {
          // Verify warm wakeup prompt includes validator feedback and board reference!
          assert.match(ctrl.prompt, /Missing null check/);
          assert.match(ctrl.prompt, /p1-1items/);
          assert.match(ctrl.prompt, /board #\d+/i);
        }
        worktree.simulateCommit(req.branch, ["src/auth.ts"], `auth-sha-${ctrl.turn}`);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: ctrl.turn === 1 ? "Initial implementation" : "Fixed null check",
          workerDone: {
            missionId: req.mission.id,
            summary: ctrl.turn === 1 ? "Initial implementation" : "Fixed null check",
          },
          tokens: 300 * ctrl.turn,
          cost: 0.005 * ctrl.turn,
        };
      },
      onValidator: async (req) => {
        reviewAttempts += 1;
        seenReviewShas.push(req.targetCommitSha ?? "");
        if (reviewAttempts === 1) {
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "validator",
            outcome: "completed",
            summary: "Found P1 defect",
            reviewVerdict: {
              commitSha: req.targetCommitSha ?? "",
              missionId: req.mission.id,
              branch: req.branch,
              reviewedAt: new Date().toISOString(),
              reviewerAgentId: req.agentId,
              status: "p1-1items",
              merge: "fix-then-merge",
              findings: [
                {
                  severity: "p1",
                  title: "Missing null check",
                  detail: "Token parser throws on empty header.",
                  file: "src/auth.ts",
                  line: 42,
                },
              ],
              checks: [{ name: "unit-tests", passed: false, detail: "empty header crashes" }],
              decision: "Fix null handling before merge.",
            },
            tokens: 200,
            cost: 0.003,
          };
        }
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "validator",
          outcome: "completed",
          summary: "Clean after fix",
          reviewVerdict: {
            commitSha: req.targetCommitSha ?? "",
            missionId: req.mission.id,
            branch: req.branch,
            reviewedAt: new Date().toISOString(),
            reviewerAgentId: req.agentId,
            status: "clean",
            merge: "merge",
            findings: [],
            checks: [{ name: "unit-tests", passed: true }],
            decision: "Null check fixed and verified.",
          },
          tokens: 180,
          cost: 0.003,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: true,
          finalValidatorEnabled: false,
          autoMergeClean: true,
          keepWorkersWarm: true,
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Add auth parser",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-warm-fix",
      validatorEnabled: true,
      finalValidatorEnabled: false,
      keepWorkersWarm: true,
      maxValidationRounds: 3,
      missions: [
        {
          id: "M1",
          title: "Auth parser",
          kind: "build",
          description: "Parse auth headers",
          scope: ["src/auth.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    // CRITICAL ASSERTIONS: Warm persistent Worker reused across fix loop!
    assert.equal(transport.workerRequests.length, 1, "Expected exactly 1 Worker spawn (warm reuse!)");
    const m1Tracked = transport.getTrackedByName("M1");
    assert.equal(m1Tracked.length, 1);
    assert.equal(m1Tracked[0]!.getWakeCount(), 1, "Expected exact same Worker woken once for fix round");
    assert.equal(seenWorkerTurns.length, 2);
    assert.equal(seenWorkerTurns[0]!.agentId, seenWorkerTurns[1]!.agentId);
    assert.equal(seenWorkerTurns[1]!.historyLen, 2, "Expected preserved conversation history");

    // Validator ran fresh on both SHAs
    assert.equal(reviewAttempts, 2);
    assert.deepEqual(seenReviewShas, ["auth-sha-1", "auth-sha-2"]);

    // After merge, BOTH warm worker & validator handles MUST be auto-killed!
    assert.equal(m1Tracked[0]!.killed, true);
    assert.equal(m1Tracked[0]!.handle.getState(), "killed");
    for (const v of transport.getTrackedByName("validator-M1")) {
      assert.equal(v.killed, true);
      assert.equal(v.handle.getState(), "killed");
    }

    const finalRun = await store.loadRun(run.id);
    assert.equal(finalRun.missions.M1!.status, "merged");
    assert.equal(finalRun.missions.M1!.reviewRound, 2);
    assert.equal(finalRun.missions.M1!.latestReview?.commitSha, "auth-sha-2");
    assert.equal(finalRun.roster[m1Tracked[0]!.agentId]!.status, "killed");
    assert.equal(finalRun.roster[m1Tracked[0]!.agentId]!.turns, 2);

    // Check shared board captured brief, [done], @M1 [review r1], [done], [review r2] clean!
    const board = await store.readBoard(run.id, { limit: 50 });
    assert.ok(board.messages.some((m) => m.kind === "done" && m.from === "M1"));
    assert.ok(
      board.messages.some(
        (m) => m.kind === "review" && m.from === "validator-M1" && m.mentions.includes("M1"),
      ),
    );
    const ledger = await store.getRecentEvents(run.id, 100);
    assert.ok(ledger.some((e) => e.type === "agent_woken"));
    assert.ok(ledger.some((e) => e.type === "agent_killed"));

    await orchestrator.dispose();
  });

  it("supports cross-worker @mention board collaboration and enforces SWARM_MAX_BOARD_HOPS loop cap", async () => {
    // Sub-test A: Worker M2 posts `@M1 what's the schema?` -> wakes warm waiting M1 -> M1 replies `@M2 ...`
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      const m2CanAsk = createDeferred<void>();
      const m1Replied = createDeferred<void>();
      const m2Finish = createDeferred<void>();

      const transport = new MockSwarmTransport({
        onWorker: async (req, ctrl) => {
          if (req.mission.id === "M1") {
            if (ctrl.turn === 1) {
              worktree.simulateCommit(req.branch, ["src/schema.ts"], "schema-sha-1");
              return {
                agentId: req.agentId,
                name: req.name,
                missionId: "M1",
                role: "worker",
                outcome: "completed",
                summary: "Defined User schema",
                workerDone: { missionId: "M1", summary: "Defined User schema" },
                tokens: 120,
                cost: 0.001,
              };
            }
            // Woken on turn 2 by M2's @M1 board post!
            assert.match(ctrl.prompt, /what is the User schema/i);
            await ctrl.postBoard("@M2 User is { id: string; email: string } (ref #1)", "handoff");
            m1Replied.resolve();
            return {
              agentId: req.agentId,
              name: req.name,
              missionId: "M1",
              role: "worker",
              outcome: "completed",
              summary: "Replied with User schema",
              tokens: 160,
              cost: 0.002,
            };
          }

          // M2 waits until M1 is parked in waiting, asks @M1 on the board, receives followUp!
          await m2CanAsk.promise;
          await ctrl.postBoard("@M1 what is the User schema?", "chat");
          await m1Replied.promise;
          await m2Finish.promise;
          worktree.simulateCommit(req.branch, ["src/consumer.ts"], "consumer-sha-1");
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: "M2",
            role: "worker",
            outcome: "completed",
            summary: "Built consumer using M1 schema",
            workerDone: { missionId: "M2", summary: "Built consumer" },
            tokens: 150,
            cost: 0.002,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () =>
          makeSettings({
            maxConcurrency: 2,
            validatorEnabled: false,
            finalValidatorEnabled: false,
            autoMergeClean: false,
            keepWorkersWarm: true,
          }),
        getHostContext: () => undefined,
      });

      const run = await store.createRun({
        objective: "Cross-worker schema collaboration",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-collab",
        maxConcurrency: 2,
        validatorEnabled: false,
        finalValidatorEnabled: false,
        keepWorkersWarm: true,
        missions: [
          {
            id: "M1",
            title: "Schema module",
            kind: "build",
            description: "Define schema",
            scope: ["src/schema.ts"],
            deps: [],
            verification: "npm test",
          },
          {
            id: "M2",
            title: "Consumer module",
            kind: "build",
            description: "Use schema",
            scope: ["src/consumer.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);

      // Wait for M1 to finish turn 1 and park warm in `waiting`!
      await waitFor(() => orchestrator.getSnapshot().waitingAgentIds.length === 1);
      const m1Tracked = transport.getTrackedByName("M1")[0]!;
      assert.equal(m1Tracked.handle.getState(), "waiting");

      // Let M2 ask @M1 on the shared board -> wakes warm M1!
      m2CanAsk.resolve();
      await m1Replied.promise;
      await waitFor(() => m1Tracked.handle.getState() === "waiting");

      // M1 was woken once, answered @M2, returned to waiting, and stayed completed (not corrupted!)
      assert.equal(m1Tracked.getWakeCount(), 1);
      assert.equal((await store.loadRun(run.id)).missions.M1!.status, "completed");

      // M2 received M1's reply via followUp while working!
      const m2Tracked = transport.getTrackedByName("M2")[0]!;
      await waitFor(() => (transport.followUpsByAgent.get(m2Tracked.agentId)?.length ?? 0) >= 1);
      assert.match(transport.followUpsByAgent.get(m2Tracked.agentId)![0]!, /email: string/);

      m2Finish.resolve();
      await waitFor(async () => (await store.loadRun(run.id)).missions.M2!.status === "completed");
      await orchestrator.dispose();
    }

    // Sub-test B: Infinite ping-pong loop between M1 and M2 is capped at SWARM_MAX_BOARD_HOPS!
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      let pingPongs = 0;

      const transport = new MockSwarmTransport({
        onWorker: async (req, ctrl) => {
          if (ctrl.turn === 1) {
            worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
            return {
              agentId: req.agentId,
              name: req.name,
              missionId: req.mission.id,
              role: "worker",
              outcome: "completed",
              summary: `Initial ${req.mission.id}`,
              workerDone: { missionId: req.mission.id, summary: `Initial ${req.mission.id}` },
              tokens: 50,
              cost: 0,
            };
          }
          // Every woken turn yields a tick (simulating LLM generation) and pings the other peer infinitely!
          await new Promise((r) => setImmediate(r));
          pingPongs += 1;
          const peer = req.mission.id === "M1" ? "M2" : "M1";
          await ctrl.postBoard(`@${peer} ping #${pingPongs}`, "chat");
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: `Pinged ${peer}`,
            tokens: 50,
            cost: 0,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () =>
          makeSettings({
            maxConcurrency: 2,
            validatorEnabled: false,
            finalValidatorEnabled: false,
            autoMergeClean: false,
            keepWorkersWarm: true,
          }),
        getHostContext: () => undefined,
      });

      const wakeups: SwarmOrchestratorEvent[] = [];
      orchestrator.subscribe((e) => {
        if (e.type === "wakeup_needed") wakeups.push(e);
      });

      const run = await store.createRun({
        objective: "Hop cap test",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-hops",
        maxConcurrency: 2,
        validatorEnabled: false,
        finalValidatorEnabled: false,
        keepWorkersWarm: true,
        missions: [
          {
            id: "M1",
            title: "Ping alpha",
            kind: "build",
            description: "Alpha",
            scope: ["src/a.ts"],
            deps: [],
            verification: "npm test",
          },
          {
            id: "M2",
            title: "Ping beta",
            kind: "build",
            description: "Beta",
            scope: ["src/b.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);
      await waitFor(() => orchestrator.getSnapshot().waitingAgentIds.length === 2);

      // Kick off ping-pong by waking M1 from orchestrator
      await orchestrator.postToBoard({
        from: "orchestrator",
        fromRole: "orchestrator",
        text: "@M1 start chatting with M2",
        kind: "chat",
      });

      await waitFor(() => wakeups.some((w) => /hop cap/i.test(w.summary)));
      // Give any in-flight microtasks a tick to confirm loop completely stopped
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(pingPongs <= SWARM_MAX_BOARD_HOPS + 2, `Expected hop cap stop, got ${pingPongs}`);

      const board = await store.readBoard(run.id, { limit: 100 });
      assert.ok(board.messages.some((m) => m.kind === "stall" && /board-guard/i.test(m.text)));

      await orchestrator.dispose();
    }
  });

  it("supports hot model switching (waiting succeeds, working -> AGENT_NOT_WAITING, killed -> AGENT_KILLED) and automatic quota fallback on 429", async () => {
    // Unit-test selectFallbackModel
    assert.equal(
      selectFallbackModel("anthropic/claude-opus-4", ["anthropic/claude-opus-4", "openai/gpt-5", "google/gemini-2.5-pro"]),
      "openai/gpt-5",
    );
    assert.equal(
      selectFallbackModel(
        "openai/gpt-5",
        ["openai/gpt-5", "google/gemini-2.5-pro"],
        new Set(["google/gemini-2.5-pro"]),
      ),
      undefined,
    );

    // Sub-test A: Manual hot model switching rules (`working` fails, `waiting` succeeds, `killed` fails)
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      const m1Gate = createDeferred<void>();

      const transport = new MockSwarmTransport({
        onWorker: async (req, ctrl) => {
          if (ctrl.turn === 1) {
            await m1Gate.promise;
          }
          worktree.simulateCommit(req.branch, ["src/mod.ts"], `mod-sha-${ctrl.turn}`);
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: `Turn ${ctrl.turn} on ${ctrl.getModel()}`,
            workerDone: { missionId: req.mission.id, summary: "done" },
            tokens: 100,
            cost: 0.001,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () =>
          makeSettings({
            workerModel: "anthropic/claude-sonnet-4",
            validatorEnabled: false,
            finalValidatorEnabled: false,
            autoMergeClean: false,
            keepWorkersWarm: true,
          }),
        getHostContext: () => undefined,
      });

      const run = await store.createRun({
        objective: "Hot model switch rules",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-model-switch",
        validatorEnabled: false,
        finalValidatorEnabled: false,
        keepWorkersWarm: true,
        missions: [
          {
            id: "M1",
            title: "Switchable worker",
            kind: "build",
            description: "Build mod",
            scope: ["src/mod.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);
      await waitFor(() => orchestrator.getSnapshot().workingAgentIds.length === 1);

      // 1. While working -> MUST reject with AGENT_NOT_WAITING!
      await assert.rejects(
        () => orchestrator.switchAgentModel("M1", "openai/gpt-5"),
        (err: unknown) => isSwarmProtocolError(err) && err.code === "AGENT_NOT_WAITING",
      );

      // Let M1 finish turn 1 and park warm in `waiting`
      m1Gate.resolve();
      await waitFor(() => orchestrator.getSnapshot().waitingAgentIds.length === 1);

      // 2. While waiting -> MUST succeed, preserve history, log event & board post!
      const updatedRoster = await orchestrator.switchAgentModel("M1", "openai/gpt-5", "high");
      assert.equal(updatedRoster.model, "openai/gpt-5");
      assert.equal(updatedRoster.thinkingLevel, "high");

      const m1Tracked = transport.getTrackedByName("M1")[0]!;
      assert.equal(m1Tracked.handle.getModel(), "openai/gpt-5");
      assert.deepEqual(m1Tracked.modelSwitches, [{ model: "openai/gpt-5", thinkingLevel: "high" }]);

      const events = await store.getRecentEvents(run.id, 50);
      assert.ok(events.some((e) => e.type === "agent_model_switched"));
      const board = await store.readBoard(run.id, { limit: 50 });
      assert.ok(board.messages.some((m) => m.kind === "model_switch" && /openai\/gpt-5/.test(m.text)));

      // Unknown model -> MODEL_NOT_FOUND
      await assert.rejects(
        () => orchestrator.switchAgentModel("M1", "nonexistent/model"),
        (err: unknown) => isSwarmProtocolError(err) && err.code === "MODEL_NOT_FOUND",
      );

      // 3. After kill -> MUST reject with AGENT_KILLED!
      await orchestrator.killAgent("M1", "Done testing");
      await assert.rejects(
        () => orchestrator.switchAgentModel("M1", "google/gemini-2.5-pro"),
        (err: unknown) => isSwarmProtocolError(err) && err.code === "AGENT_KILLED",
      );

      await orchestrator.dispose();
    }

    // Sub-test B: Automatic quota fallback on rate_limited hot-switches warm handle without cold respawn!
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      const modelsSeenByWorker: Array<string | undefined> = [];

      const transport = new MockSwarmTransport({
        onWorker: async (req, ctrl) => {
          modelsSeenByWorker.push(ctrl.getModel());
          if (ctrl.turn === 1) {
            return {
              agentId: req.agentId,
              name: req.name,
              missionId: req.mission.id,
              role: "worker",
              outcome: "rate_limited",
              summary: "HTTP 429 quota exhausted",
              error: "HTTP 429 quota exhausted",
              tokens: 50,
              cost: 0,
            };
          }
          worktree.simulateCommit(req.branch, ["src/fallback.ts"], "fb-sha-1");
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: `Completed on fallback ${ctrl.getModel()}`,
            workerDone: { missionId: req.mission.id, summary: "Done on fallback" },
            tokens: 180,
            cost: 0.002,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () =>
          makeSettings({
            workerModel: "anthropic/claude-opus-4",
            fallbackModels: ["anthropic/claude-opus-4", "openai/gpt-5-mini"],
            validatorEnabled: false,
            finalValidatorEnabled: false,
            autoMergeClean: true,
            keepWorkersWarm: true,
          }),
        getHostContext: () => undefined,
      });

      const run = await store.createRun({
        objective: "Auto quota fallback test",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-quota-fb",
        validatorEnabled: false,
        finalValidatorEnabled: false,
        keepWorkersWarm: true,
        missions: [
          {
            id: "M1",
            title: "Fallback module",
            kind: "build",
            description: "Build fallback",
            scope: ["src/fallback.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);
      await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

      // Exact same Worker handle was hot-switched from claude-opus-4 -> gpt-5-mini and woken!
      assert.equal(transport.workerRequests.length, 1);
      assert.deepEqual(modelsSeenByWorker, ["anthropic/claude-opus-4", "openai/gpt-5-mini"]);
      const m1Tracked = transport.getTrackedByName("M1")[0]!;
      assert.equal(m1Tracked.getWakeCount(), 1);
      assert.equal(m1Tracked.history.length, 2);

      const events = await store.getRecentEvents(run.id, 50);
      assert.ok(events.some((e) => e.type === "agent_model_switched"));
      assert.equal(events.filter((e) => e.type === "rate_limit_backoff").length, 0);

      await orchestrator.dispose();
    }
  });
});

// ============================================================================
// 2. Orchestrator End-to-End DAG, Gate, Rate-Limit & Sovereignty Tests
// ============================================================================

describe("SwarmOrchestrator", () => {
  it("runs Wave 1 build missions in parallel up to maxConcurrency, waits for both to merge, runs Wave 2, and finishes run", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const m1Gate = createDeferred<void>();
    const m2Gate = createDeferred<void>();
    let currentRunningWorkers = 0;
    let maxConcurrentWorkers = 0;
    const spawnOrder: string[] = [];

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        spawnOrder.push(req.mission.id);
        currentRunningWorkers += 1;
        maxConcurrentWorkers = Math.max(maxConcurrentWorkers, currentRunningWorkers);
        try {
          req.onTelemetry?.({
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            type: "tool_start",
            timestamp: new Date().toISOString(),
            toolName: "write",
            activity: `write: ${req.mission.scope[0]}`,
            logLine: `writing ${req.mission.scope[0]}`,
          });
          if (req.mission.id === "M1") await m1Gate.promise;
          if (req.mission.id === "M2") await m2Gate.promise;
          worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: `Completed ${req.mission.id}`,
            workerDone: { missionId: req.mission.id, summary: `Completed ${req.mission.id}` },
            tokens: 500,
            cost: 0.01,
          };
        } finally {
          currentRunningWorkers -= 1;
        }
      },
    });

    const settings = makeSettings({
      maxConcurrency: 2,
      validatorEnabled: true,
      finalValidatorEnabled: false,
      autoMergeClean: true,
    });
    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => settings,
      getHostContext: () => undefined,
    });

    const events: SwarmOrchestratorEvent[] = [];
    orchestrator.subscribe((e) => events.push(e));

    const run = await store.createRun({
      objective: "Build multi-wave feature",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-1",
      maxConcurrency: 2,
      validatorEnabled: true,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Core module",
          kind: "build",
          description: "Implement core",
          scope: ["src/core.ts"],
          deps: [],
          verification: "npm test",
        },
        {
          id: "M2",
          title: "Utils module",
          kind: "build",
          description: "Implement utils",
          scope: ["src/utils.ts"],
          deps: [],
          verification: "npm test",
        },
        {
          id: "M3",
          title: "Integration module",
          kind: "build",
          description: "Wire core and utils",
          scope: ["src/index.ts"],
          deps: ["M1", "M2"],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);

    await waitFor(() => spawnOrder.length === 2);
    assert.deepEqual(new Set(spawnOrder), new Set(["M1", "M2"]));
    assert.equal(maxConcurrentWorkers, 2);
    assert.equal((await store.loadRun(run.id)).missions.M3!.status, "planned");

    m1Gate.resolve();
    await waitFor(async () => (await store.loadRun(run.id)).missions.M1!.status === "merged");
    assert.equal((await store.loadRun(run.id)).missions.M3!.status, "planned");
    assert.equal(spawnOrder.includes("M3"), false);

    m2Gate.resolve();
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    const finalRun = await store.loadRun(run.id);
    assert.equal(finalRun.missions.M1!.status, "merged");
    assert.equal(finalRun.missions.M2!.status, "merged");
    assert.equal(finalRun.missions.M3!.status, "merged");
    assert.equal(transport.validatorRequests.length, 3);
    assert.equal(worktree.mergedBranches.length, 3);

    assert.ok(events.some((e) => e.type === "run_finished"));
    assert.ok(events.some((e) => e.type === "wakeup_needed"));
    const snap = orchestrator.getSnapshot();
    assert.equal(snap.totalTokens, 3 * (500 + 150));

    await orchestrator.dispose();
  });

  it("handles cold-worker fallback fix loop when keepWorkersWarm=false", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let workerAttempts = 0;
    let reviewAttempts = 0;

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        workerAttempts += 1;
        if (workerAttempts === 2) {
          assert.match(req.systemPromptAppendix ?? "", /Missing null check/);
          assert.match(req.systemPromptAppendix ?? "", /p1-1items/);
        }
        worktree.simulateCommit(req.branch, ["src/auth.ts"], `cold-sha-${workerAttempts}`);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: workerAttempts === 1 ? "Initial" : "Fixed",
          tokens: 200,
          cost: 0.002,
        };
      },
      onValidator: async (req) => {
        reviewAttempts += 1;
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "validator",
          outcome: "completed",
          summary: reviewAttempts === 1 ? "Defect" : "Clean",
          reviewVerdict: {
            commitSha: req.targetCommitSha ?? "",
            missionId: req.mission.id,
            branch: req.branch,
            reviewedAt: new Date().toISOString(),
            reviewerAgentId: req.agentId,
            status: reviewAttempts === 1 ? "p1-1items" : "clean",
            merge: reviewAttempts === 1 ? "fix-then-merge" : "merge",
            findings:
              reviewAttempts === 1
                ? [{ severity: "p1", title: "Missing null check", detail: "Empty header throws" }]
                : [],
            checks: [{ name: "tests", passed: reviewAttempts > 1 }],
            decision: reviewAttempts === 1 ? "Fix null check" : "Clean",
          },
          tokens: 150,
          cost: 0.002,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: true,
          finalValidatorEnabled: false,
          autoMergeClean: true,
          keepWorkersWarm: false,
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Cold fix loop",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-cold-fix",
      validatorEnabled: true,
      finalValidatorEnabled: false,
      keepWorkersWarm: false,
      missions: [
        {
          id: "M1",
          title: "Cold auth",
          kind: "build",
          description: "Build auth",
          scope: ["src/auth.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    assert.equal(transport.workerRequests.length, 2);
    assert.equal(workerAttempts, 2);
    assert.equal(reviewAttempts, 2);

    await orchestrator.dispose();
  });

  it("enforces stale validation SHA guard: new commit after clean validation blocks merge with STALE_REVIEW until re-validated", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, ["src/cache.ts"], "cache-sha-1");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Implemented cache",
          tokens: 200,
          cost: 0.002,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({ validatorEnabled: true, finalValidatorEnabled: false, autoMergeClean: false }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Add cache",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-stale",
      validatorEnabled: true,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Cache layer",
          kind: "build",
          description: "Implement cache",
          scope: ["src/cache.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).missions.M1!.latestReview?.commitSha === "cache-sha-1");

    const missionBranch = (await store.loadRun(run.id)).missions.M1!.branch;
    worktree.simulateCommit(missionBranch, ["src/cache.ts"], "cache-sha-2");

    await assert.rejects(
      () => orchestrator.mergeMission("M1"),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "STALE_REVIEW",
    );
    assert.equal(worktree.mergeCallCount, 0);

    await orchestrator.tick();
    await waitFor(async () => (await store.loadRun(run.id)).missions.M1!.latestReview?.commitSha === "cache-sha-2");

    const merged = await orchestrator.mergeMission("M1");
    assert.ok(merged?.mergedCommitSha);
    assert.equal((await store.loadRun(run.id)).missions.M1!.status, "merged");

    await orchestrator.dispose();
  });

  it("blocks artifact mission merge with ARTIFACT_UNAPPROVED until approveArtifact signs off exact tip SHA", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, ["docs/report.md"], "artifact-sha-1");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Generated architecture report in docs/report.md",
          tokens: 250,
          cost: 0.004,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({ validatorEnabled: true, finalValidatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const wakeups: SwarmOrchestratorEvent[] = [];
    orchestrator.subscribe((e) => {
      if (e.type === "wakeup_needed") wakeups.push(e);
    });

    const run = await store.createRun({
      objective: "Write architecture report",
      verificationContract: "docs exist",
      baseBranch: "main",
      ownerSessionId: "sess-artifact",
      validatorEnabled: true,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "A1",
          title: "Architecture report",
          kind: "artifact",
          description: "Produce architecture report",
          scope: ["docs/report.md"],
          deps: [],
          verification: "check docs/report.md",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(
      async () =>
        (await store.loadRun(run.id)).missions.A1!.status === "completed" &&
        wakeups.some((w) => w.missionId === "A1" && /approve/i.test(w.summary)),
    );

    assert.equal(transport.validatorRequests.length, 0);
    assert.ok(wakeups.some((w) => w.missionId === "A1" && /approve/i.test(w.summary)));
    assert.deepEqual(orchestrator.getSnapshot().pendingArtifactApprovals, ["A1"]);

    await assert.rejects(
      () => orchestrator.mergeMission("A1"),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "ARTIFACT_UNAPPROVED",
    );

    await orchestrator.approveArtifact("A1", { approvedBy: "alice", autoMerge: true });
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    const finalRun = await store.loadRun(run.id);
    assert.equal(finalRun.missions.A1!.humanApprovedSha, "artifact-sha-1");
    assert.equal(finalRun.missions.A1!.status, "merged");
    assert.equal(worktree.mergeCallCount, 1);

    await orchestrator.dispose();
  });

  it("closes survey mission with zero diff and injects its findings into downstream dependent worker prompt", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let capturedDownstreamPrompt = "";

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        if (req.mission.kind === "survey") {
          await store.recordFinding(req.runId, {
            missionId: req.mission.id,
            author: req.name,
            title: "Pi SDK Tool Allowlist Rule",
            summary: "options.tools also filters options.customTools",
            details: "Always include custom tool names inside options.tools.",
            files: ["src/runtime/transport.ts"],
          });
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: "Recorded Pi SDK findings",
            tokens: 180,
            cost: 0.002,
          };
        }
        capturedDownstreamPrompt = req.systemPromptAppendix ?? "";
        worktree.simulateCommit(req.branch, ["src/feature.ts"], "feat-sha-1");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Implemented feature using survey findings",
          tokens: 300,
          cost: 0.004,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({ validatorEnabled: false, finalValidatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Research then implement",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-survey",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "S1",
          title: "Survey SDK",
          kind: "survey",
          description: "Inspect Pi SDK constraints",
          scope: ["src/"],
          deps: [],
          verification: "record findings",
        },
        {
          id: "M2",
          title: "Implement feature",
          kind: "build",
          description: "Build feature respecting survey findings",
          scope: ["src/feature.ts"],
          deps: ["S1"],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    const finalRun = await store.loadRun(run.id);
    assert.equal(finalRun.missions.S1!.status, "merged");
    assert.equal(finalRun.missions.S1!.mergedCommitSha, undefined);
    assert.equal(finalRun.missions.M2!.status, "merged");
    assert.equal(worktree.mergeCallCount, 1);
    assert.match(capturedDownstreamPrompt, /Pi SDK Tool Allowlist Rule/);
    assert.match(capturedDownstreamPrompt, /options\.tools also filters options\.customTools/);

    await orchestrator.dispose();
  });

  it("rejects survey mission that produces a git diff (SURVEY_HAS_DIFF)", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, ["src/oops.ts"], "illegal-survey-sha");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Accidentally edited a file",
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => makeSettings({ validatorEnabled: false, finalValidatorEnabled: false }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Read-only survey",
      verificationContract: "zero diff",
      baseBranch: "main",
      ownerSessionId: "sess-survey-diff",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "S1",
          title: "Bad survey",
          kind: "survey",
          description: "Survey",
          scope: ["src/"],
          deps: [],
          verification: "none",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).missions.S1!.status === "failed");
    assert.match((await store.loadRun(run.id)).missions.S1!.error ?? "", /SURVEY_HAS_DIFF/);

    await orchestrator.dispose();
  });

  it("activates shared 429 circuit breaker backoff without immediate respawn storm when no fallbackModels configured and recovers cleanly", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let m1Attempts = 0;
    const turnTimestamps: number[] = [];

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        turnTimestamps.push(Date.now());
        if (req.mission.id === "M1") {
          m1Attempts += 1;
          if (m1Attempts === 1) {
            return {
              agentId: req.agentId,
              name: req.name,
              missionId: req.mission.id,
              role: "worker",
              outcome: "rate_limited",
              summary: "HTTP 429 Too Many Requests",
              error: "HTTP 429 Too Many Requests",
              retryAfterMs: 80,
              tokens: 20,
              cost: 0,
            };
          }
        }
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: `Done ${req.mission.id}`,
          tokens: 150,
          cost: 0.002,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          maxConcurrency: 1,
          validatorEnabled: false,
          finalValidatorEnabled: false,
          autoMergeClean: true,
          rateLimitBaseBackoffMs: 80,
          rateLimitMaxBackoffMs: 400,
          maxRetries: 2,
          fallbackModels: [],
        }),
      getHostContext: () => undefined,
      random: () => 0,
    });

    const run = await store.createRun({
      objective: "Rate-limit recovery test",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-rl",
      maxConcurrency: 1,
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "First task",
          kind: "build",
          description: "Task 1",
          scope: ["src/a.ts"],
          deps: [],
          verification: "npm test",
        },
        {
          id: "M2",
          title: "Second task",
          kind: "build",
          description: "Task 2",
          scope: ["src/b.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);

    await waitFor(() => orchestrator.getSnapshot().rateLimitUntil !== undefined);
    assert.equal(turnTimestamps.length, 1);

    // Calling tick() manually while backed off MUST NOT launch M1 or M2!
    await orchestrator.tick();
    assert.equal(turnTimestamps.length, 1);

    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    assert.equal(m1Attempts, 2);
    assert.ok(turnTimestamps.length >= 3);
    assert.ok(
      turnTimestamps[1]! - turnTimestamps[0]! >= 70,
      `Expected backoff delay >= 70ms, got ${turnTimestamps[1]! - turnTimestamps[0]!}ms`,
    );

    const events = await store.getRecentEvents(run.id, 50);
    assert.ok(events.some((e) => e.type === "rate_limit_backoff"));

    await orchestrator.dispose();
  });

  it("respects human sovereignty: human-stopped worker is NEVER auto-restarted until explicit retryMission", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let m1SpawnCount = 0;

    const transport = new MockSwarmTransport({
      onWorker: async (req, controls) => {
        if (req.mission.id === "M1") {
          m1SpawnCount += 1;
          if (m1SpawnCount === 1) {
            return await new Promise<AgentTurnResult>((resolve) => {
              controls.onAbort((reason) => {
                resolve({
                  agentId: req.agentId,
                  name: req.name,
                  missionId: req.mission.id,
                  role: "worker",
                  outcome: "aborted",
                  summary: reason ?? "Aborted",
                  error: reason ?? "Aborted",
                  tokens: 50,
                  cost: 0.001,
                });
              });
            });
          }
        }
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: `Completed ${req.mission.id}`,
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          maxConcurrency: 2,
          validatorEnabled: false,
          finalValidatorEnabled: false,
          autoMergeClean: true,
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Human stop test",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-stop",
      maxConcurrency: 2,
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Stoppable mission",
          kind: "build",
          description: "Work 1",
          scope: ["src/m1.ts"],
          deps: [],
          verification: "npm test",
        },
        {
          id: "M2",
          title: "Independent mission",
          kind: "build",
          description: "Work 2",
          scope: ["src/m2.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(() => m1SpawnCount === 1);

    await orchestrator.stopAgent("M1", { humanStopped: true, reason: "Paused by user" });

    await waitFor(async () => (await store.loadRun(run.id)).missions.M2!.status === "merged");
    await orchestrator.tick();
    await orchestrator.tick();

    const midRun = await store.loadRun(run.id);
    assert.equal(midRun.missions.M1!.status, "stopped");
    assert.equal(midRun.missions.M1!.humanStopped, true);
    assert.equal(m1SpawnCount, 1);

    await assert.rejects(
      () => orchestrator.spawnForMission({ missionId: "M1" }),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "INVALID_TRANSITION",
    );

    await orchestrator.retryMission("M1", { reason: "User approved restart" });
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
    assert.equal(m1SpawnCount, 2);
    assert.equal((await store.loadRun(run.id)).missions.M1!.status, "merged");

    await orchestrator.dispose();
  });

  it("handles rebase conflict cleanly by emitting wakeup_needed and preserving base branch", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, ["src/shared.ts"], "conflict-sha-1");
        const st = worktree.branches.get(req.branch)!;
        st.rebaseResult = {
          status: "conflict",
          conflictFiles: ["src/shared.ts"],
          message: "Auto-rebase conflicted in src/shared.ts",
        };
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Committed shared.ts",
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: true,
          finalValidatorEnabled: false,
          autoMergeClean: true,
          autoRebase: true,
        }),
      getHostContext: () => undefined,
    });

    const wakeups: SwarmOrchestratorEvent[] = [];
    orchestrator.subscribe((e) => {
      if (e.type === "wakeup_needed") wakeups.push(e);
    });

    const run = await store.createRun({
      objective: "Rebase conflict handling",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-conflict",
      validatorEnabled: true,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Conflicting change",
          kind: "build",
          description: "Edit shared file",
          scope: ["src/shared.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    const initialBaseSha = worktree.baseSha;
    await orchestrator.startRun(run.id);

    await waitFor(async () => (await store.loadRun(run.id)).missions.M1!.status === "failed");

    assert.equal(worktree.mergeCallCount, 0);
    assert.equal(worktree.baseSha, initialBaseSha);
    assert.ok(wakeups.some((w) => w.missionId === "M1" && /conflict/i.test(w.summary)));

    const events = await store.getRecentEvents(run.id, 30);
    assert.ok(events.some((e) => e.type === "merge_conflict"));

    await orchestrator.dispose();
  });

  it("repairs out-of-scope worker commits via warm wakeup before validation", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let turns = 0;

    const transport = new MockSwarmTransport({
      onWorker: async (req, ctrl) => {
        turns += 1;
        if (turns === 1) {
          worktree.simulateCommit(req.branch, ["src/allowed.ts", "src/forbidden.ts"], "bad-scope-sha");
        } else {
          assert.match(ctrl.prompt, /src\/forbidden\.ts/);
          const st = worktree.branches.get(req.branch)!;
          st.changedFiles = ["src/allowed.ts"];
          st.headSha = "good-scope-sha";
        }
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: turns === 1 ? "Committed with stray edit" : "Reverted stray edit",
          tokens: 120,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: true,
          finalValidatorEnabled: false,
          autoMergeClean: true,
          maxRetries: 2,
          keepWorkersWarm: true,
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Scope repair test",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-scope",
      validatorEnabled: true,
      finalValidatorEnabled: false,
      keepWorkersWarm: true,
      missions: [
        {
          id: "M1",
          title: "Scoped edit",
          kind: "build",
          description: "Only edit src/allowed.ts",
          scope: ["src/allowed.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    assert.equal(turns, 2);
    assert.equal(transport.workerRequests.length, 1); // Warm wakeup!
    assert.equal(transport.validatorRequests.length, 1);
    assert.equal(transport.validatorRequests[0]!.targetCommitSha, "good-scope-sha");

    await orchestrator.dispose();
  });

  it("escalates with wakeup_needed when validation rejections exceed maxValidationRounds", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let workerTurns = 0;
    let validationRuns = 0;

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        workerTurns += 1;
        worktree.simulateCommit(req.branch, ["src/buggy.ts"], `buggy-sha-${workerTurns}`);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: `Attempt ${workerTurns}`,
          tokens: 100,
          cost: 0.001,
        };
      },
      onValidator: async (req) => {
        validationRuns += 1;
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "validator",
          outcome: "completed",
          summary: "Still failing",
          reviewVerdict: {
            commitSha: req.targetCommitSha ?? "",
            missionId: req.mission.id,
            branch: req.branch,
            reviewedAt: new Date().toISOString(),
            reviewerAgentId: req.agentId,
            status: "p1-1items",
            merge: "fix-then-merge",
            findings: [{ severity: "p1", title: "Persistent bug", detail: "Still broken" }],
            checks: [{ name: "tests", passed: false }],
            decision: "Still broken.",
          },
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({ validatorEnabled: true, finalValidatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const wakeups: SwarmOrchestratorEvent[] = [];
    orchestrator.subscribe((e) => {
      if (e.type === "wakeup_needed") wakeups.push(e);
    });

    const run = await store.createRun({
      objective: "Max validation rounds escalation",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-maxval",
      validatorEnabled: true,
      finalValidatorEnabled: false,
      maxValidationRounds: 1,
      missions: [
        {
          id: "M1",
          title: "Buggy mission",
          kind: "build",
          description: "Fix bug",
          scope: ["src/buggy.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).missions.M1!.status === "failed");

    assert.equal(validationRuns, 2);
    assert.equal(worktree.mergeCallCount, 0);
    assert.ok(wakeups.some((w) => w.missionId === "M1" && /exceeded max validation rounds/i.test(w.summary)));

    await orchestrator.dispose();
  });

  it("delivers live steerAgent messages both to inbox and to running worker handle", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const workerGate = createDeferred<void>();
    let liveAgentId = "";

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        liveAgentId = req.agentId;
        await workerGate.promise;
        worktree.simulateCommit(req.branch, ["src/steered.ts"], "steered-sha");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Followed steer instruction",
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({ validatorEnabled: false, finalValidatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Live steering test",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-steer",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Steerable task",
          kind: "build",
          description: "Implement task",
          scope: ["src/steered.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(() => liveAgentId.length > 0);

    await orchestrator.steerAgent("M1", "Use streaming parser instead of regex");
    assert.deepEqual(transport.steersByAgent.get(liveAgentId), [
      "Use streaming parser instead of regex",
    ]);

    const inbox = await store.readInbox(run.id, liveAgentId, { unreadOnly: true });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.text, "Use streaming parser instead of regex");

    workerGate.resolve();
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
    await orchestrator.dispose();
  });

  it("does not infinite-loop or spam wakeups when autoMergeClean hits persistent DIRTY_BASE, and recovers on resume", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    worktree.baseDirty = true;

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, ["src/clean.ts"], "dirty-base-sha");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Committed clean.ts",
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({ validatorEnabled: true, finalValidatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const wakeups: SwarmOrchestratorEvent[] = [];
    orchestrator.subscribe((e) => {
      if (e.type === "wakeup_needed") wakeups.push(e);
    });

    const run = await store.createRun({
      objective: "Dirty base guard",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-dirty-base",
      validatorEnabled: true,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Clean build",
          kind: "build",
          description: "Build feature",
          scope: ["src/clean.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(() => wakeups.length >= 1);

    await new Promise((r) => setTimeout(r, 80));
    await orchestrator.tick();
    await orchestrator.tick();

    const rejectedEvents = (await store.getRecentEvents(run.id, 100)).filter(
      (e) => e.type === "merge_rejected",
    );
    assert.equal(wakeups.length, 1);
    assert.equal(rejectedEvents.length, 1);
    assert.equal(worktree.mergeCallCount, 0);

    worktree.baseDirty = false;
    await orchestrator.resume(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
    assert.equal(worktree.mergeCallCount, 1);

    await orchestrator.dispose();
  });

  it("isolates per-mission launch failures in tick() so independent sibling missions are not starved", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    worktree.failCreateWorktreeForBranch.add("feat/broken-mission");

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: `Completed ${req.mission.id}`,
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          maxConcurrency: 2,
          validatorEnabled: false,
          finalValidatorEnabled: false,
          autoMergeClean: true,
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Launch error isolation",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-iso",
      maxConcurrency: 2,
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Broken mission",
          kind: "build",
          description: "Fails at worktree creation",
          scope: ["src/a.ts"],
          deps: [],
          verification: "npm test",
        },
        {
          id: "M2",
          title: "Healthy sibling",
          kind: "build",
          description: "Should still run and merge",
          scope: ["src/b.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).missions.M2!.status === "merged");

    const finalRun = await store.loadRun(run.id);
    assert.equal(finalRun.missions.M1!.status, "failed");
    assert.match(finalRun.missions.M1!.error ?? "", /GIT_ERROR/);
    assert.equal(finalRun.missions.M2!.status, "merged");

    await orchestrator.dispose();
  });

  it("passes reuseExistingBranch=false on first spawn even when worktreePath is pre-populated, and true on retry", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let attempts = 0;

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "failed",
            summary: "Transient error",
            error: "Transient error",
            tokens: 50,
            cost: 0,
          };
        }
        worktree.simulateCommit(req.branch, ["src/x.ts"], "x-sha-1");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Succeeded on retry",
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: false,
          finalValidatorEnabled: false,
          autoMergeClean: true,
          maxRetries: 2,
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "reuseExistingBranch check",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-reuse",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Retryable task",
          kind: "build",
          description: "Task",
          scope: ["src/x.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    assert.ok(run.missions.M1!.worktreePath.length > 0);
    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    assert.equal(worktree.createWorktreeCalls.length, 2);
    assert.equal(worktree.createWorktreeCalls[0]!.reuseExistingBranch, false);
    assert.equal(worktree.createWorktreeCalls[1]!.reuseExistingBranch, true);

    await orchestrator.dispose();
  });

  it("clears missionWorkingAgent before stopAgent() resolves so immediate teardown does not skip_active, and emits no duplicate ledger events", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const neverEndingDone = createDeferred<AgentTurnResult>();
    let spawned = false;

    const transport = new MockSwarmTransport({
      onWorker: async () => {
        spawned = true;
        return neverEndingDone.promise;
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => makeSettings({ validatorEnabled: false, finalValidatorEnabled: false }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Stop then teardown immediately",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-teardown-stop",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Long worker",
          kind: "build",
          description: "Hangs until stopped",
          scope: ["src/hang.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(() => spawned);

    await orchestrator.stopAgent("M1", { humanStopped: true, reason: "Stopping now" });

    const td = await orchestrator.teardown({ runId: run.id, sessionId: "sess-teardown-stop" });
    assert.equal(td.skipped.length, 0);
    assert.equal(td.removed.length, 1);
    assert.equal(td.removed[0]!.missionId, "M1");

    const events = await store.getRecentEvents(run.id, 100);
    assert.equal(events.filter((e) => e.type === "worker_spawned").length, 1);
    assert.equal(events.filter((e) => e.type === "worker_stopped").length, 1);
    assert.equal(events.filter((e) => e.type === "mission_started").length, 1);

    neverEndingDone.resolve({
      agentId: "w-M1-1",
      name: "M1",
      missionId: "M1",
      role: "worker",
      outcome: "aborted",
      summary: "Aborted",
      tokens: 0,
      cost: 0,
    });
    await orchestrator.dispose();
  });
});

// ============================================================================
// 3. Rate-Limit Breaker & ConcurrencyGate Unit Tests
// ============================================================================

describe("RateLimitBreaker & ConcurrencyGate", () => {
  it("detects HTTP 429 / quota / overloaded errors and parses Retry-After hints", () => {
    assert.equal(isRateLimitOrTransientError("HTTP 429 Too Many Requests"), true);
    assert.equal(isRateLimitOrTransientError(new Error("Provider overloaded (529)")), true);
    assert.equal(isRateLimitOrTransientError({ status: 429, message: "slow down" }), true);
    assert.equal(isRateLimitOrTransientError("SyntaxError: unexpected token"), false);

    assert.equal(parseRetryAfterMs("Rate limit exceeded; retry after 12s"), 12_000);
    assert.equal(parseRetryAfterMs("Please wait 2500ms before retrying"), 2_500);
    assert.equal(parseRetryAfterMs({ headers: { "Retry-After": "5" } }), 5_000);
    assert.equal(parseRetryAfterMs({ retryAfterMs: 3200 }), 3_200);
  });

  it("applies exponential backoff with jitter and caps at maxBackoffMs", () => {
    let clock = 1000;
    const breaker = new RateLimitBreaker({
      baseBackoffMs: 100,
      maxBackoffMs: 350,
      jitterRatio: 0.2,
      now: () => clock,
      random: () => 0.5,
    });

    const d1 = breaker.recordRateLimit();
    assert.equal(d1, 110);
    assert.equal(breaker.getConsecutiveFailures(), 1);
    assert.equal(breaker.isBackedOff(), true);

    const d2 = breaker.recordRateLimit();
    assert.equal(d2, 220);

    const d3 = breaker.recordRateLimit();
    assert.equal(d3, 350);

    clock += 400;
    assert.equal(breaker.isBackedOff(), false);
    assert.equal(breaker.getBackoffUntil(), 0);

    breaker.recordSuccess();
    assert.equal(breaker.getConsecutiveFailures(), 0);
  });

  it("ConcurrencyGate enforces slot limits and global pause/resume", async () => {
    const gate = new ConcurrencyGate(2);
    const r1 = gate.tryAcquire();
    const r2 = gate.tryAcquire();
    assert.ok(r1 && r2);
    assert.equal(gate.tryAcquire(), null);
    assert.equal(gate.getActiveCount(), 2);

    let thirdAcquired = false;
    const thirdPromise = gate.acquire().then((rel) => {
      thirdAcquired = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(thirdAcquired, false);

    r1();
    const r3 = await thirdPromise;
    assert.equal(thirdAcquired, true);

    gate.pause();
    assert.equal(gate.tryAcquire(), null);
    r2();
    r3();
    assert.equal(gate.getActiveCount(), 0);
    assert.equal(gate.tryAcquire(), null);

    gate.resume();
    const r4 = gate.tryAcquire();
    assert.ok(r4);
    r4();
  });
});

// ============================================================================
// 4. Guards, Prompts & All 12 Orchestrator Tools
// ============================================================================

describe("Guards, Prompts & Orchestrator Tools", () => {
  it("enforces path scope boundaries and protected .pi/swarm & .git directories", () => {
    assert.equal(isProtectedSwarmPath(".pi/swarm/runs/r1/state.json"), true);
    assert.equal(isProtectedSwarmPath(".git/HEAD"), true);
    assert.equal(isProtectedSwarmPath("src/runtime/orchestrator.ts"), false);

    assert.equal(isPathInScope("src/runtime/transport.ts", ["src/runtime"]), true);
    assert.equal(isPathInScope("src/runtime-extra/foo.ts", ["src/runtime"]), false);
    assert.equal(isPathInScope("tests/orchestrator.test.ts", ["tests/*.test.ts"]), true);
    assert.equal(isPathInScope(".pi/swarm/state.json", ["."]), false);

    assert.deepEqual(
      findOutOfScopeFiles(["src/runtime/a.ts", "src/ui/b.ts", ".pi/swarm/state.json"], ["src/runtime"]),
      ["src/ui/b.ts", ".pi/swarm/state.json"],
    );
  });

  it("blocks mutating bash commands for validators and unsafe git/swarm ops for workers", () => {
    assert.equal(isReadOnlyValidationCommand("git diff main...HEAD --stat").allowed, true);
    assert.equal(isReadOnlyValidationCommand("npm run test:file -- tests/orchestrator.test.ts 2>&1").allowed, true);
    assert.equal(isReadOnlyValidationCommand("rg 'a => b' src/").allowed, true);
    assert.equal(isReadOnlyValidationCommand("echo hacked > src/a.ts").allowed, false);
    assert.equal(isReadOnlyValidationCommand("npm test 2> err.log").allowed, false);
    assert.equal(isReadOnlyValidationCommand("git commit -m 'sneaky'").allowed, false);
    assert.equal(isReadOnlyValidationCommand("rm -rf src/a.ts").allowed, false);
    assert.equal(isReadOnlyValidationCommand("sed -i '' 's/a/b/' src/a.ts").allowed, false);

    assert.equal(isForbiddenWorkerBashCommand("git commit -m 'feat: ok'", "main").allowed, true);
    assert.equal(isForbiddenWorkerBashCommand("git merge main", "main").allowed, false);
    assert.equal(isForbiddenWorkerBashCommand("git checkout main", "main").allowed, false);
    assert.equal(isForbiddenWorkerBashCommand("rm -rf .pi/swarm/runs", "main").allowed, false);
  });

  it("exposes all 12 orchestrator tools and enforces SwarmProtocolError formatting", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const roleChanges: Array<{ role: string; model: string; thinking?: ThinkingLevel }> = [];

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "done",
          workerDone: { missionId: req.mission.id, summary: "done" },
          tokens: 100,
          cost: 0.001,
        };
      },
    });
    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: false,
          finalValidatorEnabled: false,
          autoMergeClean: false,
          keepWorkersWarm: true,
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Tool verification",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "owner-sess",
      ownerPid: process.pid,
      validatorEnabled: false,
      finalValidatorEnabled: false,
      keepWorkersWarm: true,
      missions: [
        {
          id: "M1",
          title: "Alpha mission",
          kind: "build",
          description: "Alpha",
          scope: ["src/alpha.ts"],
          deps: [],
          verification: "npm test",
          tasks: ["Write alpha"],
        },
      ],
    });
    await orchestrator.attachRun(run.id);

    const tools = createOrchestratorTools({
      store,
      worktree,
      orchestrator,
      getActiveRunId: () => run.id,
      getSessionId: () => "owner-sess",
      onRoleModelChanged: (role, model, thinking) => {
        roleChanges.push({ role, model, thinking });
      },
    });

    assert.equal(tools.length, 12);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...ORCHESTRATOR_TOOLS].sort(),
    );

    const byName = new Map(tools.map((t) => [t.name, t]));
    const fakeCtx = {
      sessionManager: { getSessionId: () => "owner-sess" },
    } as unknown as ExtensionToolContext;

    // 1. swarm_status
    const statusRes = await byName.get(SWARM_STATUS_TOOL)!.execute("tc1", {}, undefined, undefined, fakeCtx);
    assert.equal(statusRes.isError, undefined);
    assert.match((statusRes.content[0] as { text: string }).text, /Alpha mission/);
    assert.match((statusRes.content[0] as { text: string }).text, /Role Models/);

    // 2. swarm_merge on planned mission -> SwarmProtocolError:INVALID_TRANSITION
    const badMerge = await byName
      .get(SWARM_MERGE_TOOL)!
      .execute("tc2", { missionId: "M1" }, undefined, undefined, fakeCtx);
    assert.equal(badMerge.isError, true);
    assert.match((badMerge.content[0] as { text: string }).text, /\[SwarmProtocolError:INVALID_TRANSITION\]/);

    // 3. swarm_plan_add with missing dep -> SwarmProtocolError:MISSING_DEP
    const badAdd = await byName.get(SWARM_PLAN_ADD_TOOL)!.execute(
      "tc3",
      {
        missions: [
          {
            id: "M2",
            title: "Beta mission",
            kind: "build",
            description: "Beta",
            scope: ["src/beta.ts"],
            deps: ["M999"],
            verification: "npm test",
          },
        ],
      },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.equal(badAdd.isError, true);
    assert.match((badAdd.content[0] as { text: string }).text, /\[SwarmProtocolError:MISSING_DEP\]/);

    // 4. swarm_mission task_done
    const taskRes = await byName.get(SWARM_MISSION_TOOL)!.execute(
      "tc4",
      { missionId: "M1", action: "task_done", taskIds: ["T1"] },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.equal(taskRes.isError, undefined);
    assert.equal((await store.loadRun(run.id)).missions.M1!.tasks[0]!.done, true);

    // 5. swarm_finding record + list
    const recFinding = await byName.get(SWARM_FINDING_TOOL)!.execute(
      "tc5",
      {
        action: "record",
        missionId: "M1",
        title: "Check",
        summary: "Summary",
        details: "Details",
      },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.equal(recFinding.isError, undefined);
    const listFinding = await byName
      .get(SWARM_FINDING_TOOL)!
      .execute("tc6", { action: "list" }, undefined, undefined, fakeCtx);
    assert.match((listFinding.content[0] as { text: string }).text, /Check/);

    // 6. swarm_board_post + swarm_board_read
    const postRes = await byName
      .get(SWARM_BOARD_POST_TOOL)!
      .execute("tc7", { text: "@M1 use strict types", kind: "decision", mission_id: "M1" }, undefined, undefined, fakeCtx);
    assert.equal(postRes.isError, undefined);
    const postDetails = postRes.details as { seq: number; mentions: string[] };
    assert.equal(postDetails.seq, 1);
    assert.deepEqual(postDetails.mentions, ["M1"]);

    const readRes = await byName
      .get(SWARM_BOARD_READ_TOOL)!
      .execute("tc8", { seqs: [1] }, undefined, undefined, fakeCtx);
    assert.match((readRes.content[0] as { text: string }).text, /use strict types/);

    // 7. swarm_model role default update
    const roleModelRes = await byName
      .get(SWARM_MODEL_TOOL)!
      .execute("tc9", { target: "worker", model: "openai/gpt-5", thinking_level: "high" }, undefined, undefined, fakeCtx);
    assert.equal(roleModelRes.isError, undefined);
    assert.deepEqual(roleChanges, [{ role: "worker", model: "openai/gpt-5", thinking: "high" }]);

    // 8. Spawn M1 -> wait for warm waiting -> hot-switch model via swarm_model -> kill via swarm_kill!
    const spawnRes = await byName
      .get(SWARM_SPAWN_TOOL)!
      .execute("tc10", { missionId: "M1" }, undefined, undefined, fakeCtx);
    assert.equal(spawnRes.isError, undefined);
    await waitFor(() => orchestrator.getSnapshot().waitingAgentIds.length === 1);

    const agentModelRes = await byName
      .get(SWARM_MODEL_TOOL)!
      .execute("tc11", { target: "M1", model: "anthropic/claude-opus-4" }, undefined, undefined, fakeCtx);
    assert.equal(agentModelRes.isError, undefined);
    assert.match((agentModelRes.content[0] as { text: string }).text, /claude-opus-4/);

    const killRes = await byName
      .get(SWARM_KILL_TOOL)!
      .execute("tc12", { target: "M1", reason: "Clean test shutdown" }, undefined, undefined, fakeCtx);
    assert.equal(killRes.isError, undefined);
    assert.equal(orchestrator.getSnapshot().waitingAgentIds.length, 0);

    // 9. swarm_spawn respects humanStopped unless force=true
    await store.updateMission(run.id, "M1", { humanStopped: true, status: "stopped" });
    const blockedSpawn = await byName
      .get(SWARM_SPAWN_TOOL)!
      .execute("tc13", { missionId: "M1" }, undefined, undefined, fakeCtx);
    assert.equal(blockedSpawn.isError, true);
    assert.match((blockedSpawn.content[0] as { text: string }).text, /\[SwarmProtocolError:INVALID_TRANSITION\]/);

    // 10. swarm_teardown enforces live-session ownership guard
    const foreignTools = createOrchestratorTools({
      store,
      worktree,
      orchestrator,
      getActiveRunId: () => run.id,
      getSessionId: () => "other-session",
    });
    const foreignTeardown = foreignTools.find((t) => t.name === SWARM_TEARDOWN_TOOL)!;
    const teardownBlocked = await foreignTeardown.execute("tc14", {}, undefined, undefined, fakeCtx);
    assert.equal(teardownBlocked.isError, true);
    assert.match((teardownBlocked.content[0] as { text: string }).text, /\[SwarmProtocolError:OWNERSHIP_CONFLICT\]/);

    // 11. Prompt builders & buildOrchestratorContextSummary
    const latestRun = await store.loadRun(run.id);
    const workerSys = buildWorkerSystemPrompt(latestRun, latestRun.missions.M1!);
    assert.match(workerSys, /swarm_board_post/);
    assert.match(workerSys, /wakeup doorbell/);
    assert.match(workerSys, /waiting/);

    const validatorSys = buildValidatorSystemPrompt(
      latestRun,
      latestRun.missions.M1!,
      await worktree.getDiffSummary("main", latestRun.missions.M1!.branch),
      ["src/alpha.ts"],
      "abc123456789",
    );
    assert.match(validatorSys, /validator-M1/);
    assert.match(validatorSys, /@M1/);

    const summary = buildOrchestratorContextSummary(orchestrator.getSnapshot());
    assert.match(summary, /Tool verification/);
    assert.match(summary, /Role Models:/);
    assert.match(summary, /HUMAN-STOPPED/);
    assert.match(summary, /swarm_verify/);
    assert.match(summary, /swarm_model/);
    assert.match(summary, /swarm_board_post/);

    await orchestrator.dispose();
  });
});

// ============================================================================
// 5. Run-Level Final Validator / Goal Auditor End-to-End Tests
// ============================================================================

describe("Run-Level Final Validator / Goal Auditor", () => {
  it("runs happy-path post-merge Final Validator on baseBranch at exact baseHeadSha -> approved -> completed", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const validatorGate = createDeferred<void>();
    let observedVerifyingStatus = false;
    let observedRunningAgentId: string | undefined;

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: `Implemented ${req.mission.id}`,
          tokens: 300,
          cost: 0.005,
        };
      },
      onFinalValidator: async (req) => {
        assert.equal(req.repoRoot, worktree.repoRoot);
        assert.equal(req.baseBranch, "main");
        assert.equal(req.targetCommitSha, worktree.baseSha);
        assert.equal(req.round, 1);
        assert.equal(req.modelOverride, "validator-pro-model");
        assert.match(req.systemPromptAppendix ?? "", /untrusted claims/i);
        assert.match(req.systemPromptAppendix ?? "", new RegExp(SWARM_FINAL_VERDICT_TOOL));
        assert.match(req.prompt, /untrusted claim/i);

        req.onTelemetry?.({
          agentId: req.agentId,
          name: req.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          type: "tool_start",
          timestamp: new Date().toISOString(),
          toolName: "bash",
          activity: "bash: npm test",
          logLine: "> bash: npm test",
        });

        await validatorGate.promise;
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          outcome: "completed",
          summary: "All integration checks pass.",
          finalAuditVerdict: {
            commitSha: req.targetCommitSha,
            baseBranch: req.baseBranch,
            auditedAt: new Date().toISOString(),
            verifierAgentId: req.agentId,
            verdict: "approved",
            summary: "All integration checks and contract items verified on main.",
            checks: [
              { name: "typecheck", passed: true, detail: "0 errors" },
              { name: "unit-tests", passed: true, detail: "all passed" },
            ],
            findings: [],
            round: req.round,
          },
          tokens: 400,
          cost: 0.008,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: true,
          autoMergeClean: true,
          finalValidatorEnabled: true,
          validatorModel: "validator-pro-model",
        }),
      getHostContext: () => undefined,
    });

    const events: SwarmOrchestratorEvent[] = [];
    orchestrator.subscribe((e) => {
      events.push(e);
      if (e.snapshot.run?.status === "verifying") {
        observedVerifyingStatus = true;
      }
      if (e.snapshot.finalAuditRunningAgentId) {
        observedRunningAgentId = e.snapshot.finalAuditRunningAgentId;
      }
    });

    const run = await store.createRun({
      objective: "Ship integrated widget",
      verificationContract: "npm run typecheck && npm test",
      baseBranch: "main",
      ownerSessionId: "sess-fv-happy",
      validatorEnabled: true,
      finalValidatorEnabled: true,
      missions: [
        {
          id: "M1",
          title: "Backend API",
          kind: "build",
          description: "Build API",
          scope: ["src/api.ts"],
          deps: [],
          verification: "npm test",
        },
        {
          id: "M2",
          title: "Frontend client",
          kind: "build",
          description: "Wire API client",
          scope: ["src/client.ts"],
          deps: ["M1"],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);

    await waitFor(() => transport.finalValidatorRequests.length === 1);
    const midSnap = orchestrator.getSnapshot();
    assert.equal(midSnap.run?.status, "verifying");
    assert.equal(midSnap.finalAuditStatus, "running");
    assert.ok(midSnap.finalAuditRunningAgentId);
    assert.match(buildOrchestratorContextSummary(midSnap), /status=verifying/);
    assert.match(buildOrchestratorContextSummary(midSnap), /swarm_verify/);

    validatorGate.resolve();
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    const finalRun = await store.loadRun(run.id);
    assert.equal(observedVerifyingStatus, true);
    assert.ok(observedRunningAgentId);
    assert.equal(finalRun.finalAuditStatus, "approved");
    assert.equal(finalRun.finalAuditRound, 1);
    assert.equal(finalRun.lastAuditedSha, worktree.baseSha);
    assert.equal(finalRun.latestFinalAudit?.verdict, "approved");
    assert.equal(finalRun.latestFinalAudit?.commitSha, worktree.baseSha);
    assert.ok(events.some((e) => e.type === "run_finished"));
    assert.ok(events.some((e) => e.type === "wakeup_needed"));

    const ledger = await store.getRecentEvents(run.id, 100);
    assert.equal(ledger.filter((e) => e.type === "final_audit_started").length, 1);
    assert.equal(ledger.filter((e) => e.type === "final_audit_result").length, 1);

    const finalSnap = orchestrator.getSnapshot();
    assert.equal(finalSnap.finalAuditStatus, "approved");
    assert.equal(finalSnap.finalAuditRunningAgentId, undefined);
    assert.match(buildOrchestratorContextSummary(finalSnap), /status=approved/);

    await orchestrator.dispose();
  });

  it("skips Final Validator when finalValidatorEnabled=false or when all missions are abandoned", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "done",
          tokens: 100,
          cost: 0.001,
        };
      },
      onFinalValidator: async () => {
        throw new Error("Final Validator should NOT have been spawned!");
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const run1 = await store.createRun({
      objective: "No final validator run",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-no-fv",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      missions: [
        {
          id: "M1",
          title: "Quick build",
          kind: "build",
          description: "Quick",
          scope: ["src/quick.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });
    await orchestrator.startRun(run1.id);
    await waitFor(async () => (await store.loadRun(run1.id)).status === "completed");
    assert.equal(transport.finalValidatorRequests.length, 0);

    const run2 = await store.createRun({
      objective: "All abandoned run",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-abandoned",
      validatorEnabled: false,
      finalValidatorEnabled: true,
      missions: [
        {
          id: "M1",
          title: "Cancelled task",
          kind: "build",
          description: "Cancel me",
          scope: ["src/cancel.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });
    await store.updateMission(run2.id, "M1", { status: "abandoned" });
    await orchestrator.startRun(run2.id);
    await waitFor(async () => (await store.loadRun(run2.id)).status === "completed");
    assert.equal(transport.finalValidatorRequests.length, 0);

    await orchestrator.dispose();
  });

  it("auto-remediates on disapproved Round 1: adds F1 -> Worker -> Validator -> Merge -> Final Validator Round 2 on new SHA -> approved", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const auditedShas: string[] = [];

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: `Completed ${req.mission.id}`,
          tokens: 200,
          cost: 0.003,
        };
      },
      onFinalValidator: async (req) => {
        auditedShas.push(req.targetCommitSha);
        if (req.round === 1) {
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "completed",
            summary: "Missing wiring in src/wiring.ts",
            finalAuditVerdict: {
              commitSha: req.targetCommitSha,
              baseBranch: req.baseBranch,
              auditedAt: new Date().toISOString(),
              verifierAgentId: req.agentId,
              verdict: "disapproved",
              summary: "Cross-mission export mismatch in src/wiring.ts",
              checks: [{ name: "typecheck", passed: false, detail: "missing export" }],
              findings: [
                {
                  severity: "p1",
                  title: "Missing index export",
                  detail: "src/wiring.ts does not export featureFn",
                  file: "src/wiring.ts",
                  line: 12,
                },
              ],
              recommendedMissions: [
                {
                  title: "Core module — fix export",
                  description: "Export featureFn from src/wiring.ts and add integration test",
                  scope: ["src/wiring.ts"],
                  verification: "npm run typecheck && npm test",
                  tasks: ["Export featureFn", "Verify typecheck"],
                },
              ],
              round: req.round,
            },
            tokens: 250,
            cost: 0.004,
          };
        }

        assert.equal(req.round, 2);
        assert.ok(req.priorAudits && req.priorAudits.length === 1);
        assert.equal(req.priorAudits[0]!.verdict, "disapproved");
        assert.match(req.prompt, /Missing index export/);

        return {
          agentId: req.agentId,
          name: req.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          outcome: "completed",
          summary: "Wiring fixed and verified.",
          finalAuditVerdict: {
            commitSha: req.targetCommitSha,
            baseBranch: req.baseBranch,
            auditedAt: new Date().toISOString(),
            verifierAgentId: req.agentId,
            verdict: "approved",
            summary: "All checks now pass after F1 fix.",
            checks: [{ name: "typecheck", passed: true }],
            findings: [],
            round: req.round,
          },
          tokens: 220,
          cost: 0.004,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: true,
          autoMergeClean: true,
          finalValidatorEnabled: true,
          maxFinalAuditRounds: 2,
          autoFixOnAuditFail: true,
          validatorModel: "shared-validator-model",
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Integrated export feature",
      verificationContract: "npm run typecheck && npm test",
      baseBranch: "main",
      ownerSessionId: "sess-autofix",
      validatorEnabled: true,
      finalValidatorEnabled: true,
      maxFinalAuditRounds: 2,
      autoFixOnAuditFail: true,
      missions: [
        {
          id: "M1",
          title: "Core module",
          kind: "build",
          description: "Implement core",
          scope: ["src/core.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

    const finalRun = await store.loadRun(run.id);
    assert.ok(finalRun.missions.F1, "Expected auto-fix mission F1 to be planned");
    assert.equal(finalRun.missions.F1!.status, "merged");
    assert.match(finalRun.missions.F1!.title, /^[ -~]+$/);
    assert.equal(finalRun.finalAuditStatus, "approved");
    assert.equal(finalRun.finalAuditRound, 2);
    assert.equal(auditedShas.length, 2);
    assert.notEqual(auditedShas[0], auditedShas[1]);
    assert.equal(transport.finalValidatorRequests[0]!.modelOverride, "shared-validator-model");

    assert.equal(transport.workerRequests.length, 2);
    assert.equal(transport.validatorRequests.length, 2);
    assert.equal(worktree.mergedBranches.length, 2);

    const ledger = await store.getRecentEvents(run.id, 100);
    assert.equal(ledger.filter((e) => e.type === "final_audit_autofix_planned").length, 1);
    assert.equal(ledger.filter((e) => e.type === "final_audit_started").length, 2);
    assert.equal(ledger.filter((e) => e.type === "final_audit_result").length, 2);

    await orchestrator.dispose();
  });

  it("parks on disapproved without tight-looping and recovers via fix mission, skipFinalAudit, or runFinalAudit(force)", async () => {
    // Sub-scenario A: autoFix off -> parks -> addMissions -> approved
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      let auditCalls = 0;

      const transport = new MockSwarmTransport({
        onWorker: async (req) => {
          worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: `Done ${req.mission.id}`,
            tokens: 100,
            cost: 0.001,
          };
        },
        onFinalValidator: async (req) => {
          auditCalls += 1;
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "completed",
            summary: auditCalls === 1 ? "Missing docs" : "Docs verified",
            finalAuditVerdict: {
              commitSha: req.targetCommitSha,
              baseBranch: req.baseBranch,
              auditedAt: new Date().toISOString(),
              verifierAgentId: req.agentId,
              verdict: auditCalls === 1 ? "disapproved" : "approved",
              summary: auditCalls === 1 ? "README missing usage example" : "README updated and verified",
              checks: [{ name: "docs", passed: auditCalls > 1 }],
              findings:
                auditCalls === 1
                  ? [{ severity: "p1", title: "Missing README usage", detail: "Add usage section" }]
                  : [],
              round: req.round,
            },
            tokens: 100,
            cost: 0.001,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
        getHostContext: () => undefined,
      });

      const wakeups: SwarmOrchestratorEvent[] = [];
      orchestrator.subscribe((e) => {
        if (e.type === "wakeup_needed") wakeups.push(e);
      });

      const run = await store.createRun({
        objective: "Manual remediation test",
        verificationContract: "docs exist",
        baseBranch: "main",
        ownerSessionId: "sess-park-a",
        validatorEnabled: false,
        finalValidatorEnabled: true,
        autoFixOnAuditFail: false,
        missions: [
          {
            id: "M1",
            title: "Build lib",
            kind: "build",
            description: "Lib",
            scope: ["src/lib.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);
      await waitFor(async () => (await store.loadRun(run.id)).finalAuditStatus === "disapproved");

      await orchestrator.tick();
      await orchestrator.tick();
      assert.equal(auditCalls, 1);
      assert.equal(wakeups.length, 1);
      assert.equal((await store.loadRun(run.id)).status, "active");
      assert.match(buildOrchestratorContextSummary(orchestrator.getSnapshot()), /status=disapproved/);

      await store.addMissions(run.id, [
        {
          id: "M2",
          title: "Update readme",
          kind: "build",
          description: "Add usage example",
          scope: ["README.md"],
          deps: [],
          verification: "check README",
        },
      ]);
      await orchestrator.tick();
      await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
      assert.equal(auditCalls, 2);
      assert.equal((await store.loadRun(run.id)).finalAuditStatus, "approved");

      await orchestrator.dispose();
    }

    // Sub-scenario B: invalid overlapping recommendedMissions -> parks -> human skipFinalAudit completes
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      let auditCalls = 0;

      const transport = new MockSwarmTransport({
        onWorker: async (req) => {
          worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: "done",
            tokens: 100,
            cost: 0.001,
          };
        },
        onFinalValidator: async (req) => {
          auditCalls += 1;
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "completed",
            summary: "Broken",
            finalAuditVerdict: {
              commitSha: req.targetCommitSha,
              baseBranch: req.baseBranch,
              auditedAt: new Date().toISOString(),
              verifierAgentId: req.agentId,
              verdict: "disapproved",
              summary: "Overlapping recommended fix missions",
              checks: [{ name: "tests", passed: false }],
              findings: [{ severity: "p1", title: "Bug", detail: "Broken" }],
              recommendedMissions: [
                {
                  title: "Fix one",
                  description: "Touch src/a.ts",
                  scope: ["src/a.ts"],
                  verification: "npm test",
                },
                {
                  title: "Fix two",
                  description: "Also touch src/a.ts (overlap!)",
                  scope: ["src/a.ts"],
                  verification: "npm test",
                },
              ],
              round: req.round,
            },
            tokens: 100,
            cost: 0.001,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
        getHostContext: () => undefined,
      });

      const events: SwarmOrchestratorEvent[] = [];
      orchestrator.subscribe((e) => events.push(e));

      const run = await store.createRun({
        objective: "Overlap fallback & skip test",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-park-b",
        validatorEnabled: false,
        finalValidatorEnabled: true,
        autoFixOnAuditFail: true,
        maxFinalAuditRounds: 2,
        missions: [
          {
            id: "M1",
            title: "Task a",
            kind: "build",
            description: "Build a",
            scope: ["src/a.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);
      await waitFor(async () => (await store.loadRun(run.id)).finalAuditStatus === "disapproved");
      await orchestrator.tick();

      const parked = await store.loadRun(run.id);
      assert.equal(auditCalls, 1);
      assert.equal(parked.missionOrder.length, 1);
      assert.ok(events.some((e) => e.type === "wakeup_needed" && /SCOPE_OVERLAP/.test(e.summary)));

      await orchestrator.skipFinalAudit({ reason: "Verified manually", skippedBy: "alice" });
      const skipped = await store.loadRun(run.id);
      assert.equal(skipped.finalAuditStatus, "skipped");
      assert.equal(skipped.finalAuditSkippedBy, "alice");
      assert.equal(skipped.status, "completed");
      assert.ok(events.some((e) => e.type === "run_finished"));
      assert.match(buildOrchestratorContextSummary(orchestrator.getSnapshot()), /status=skipped/);

      await orchestrator.dispose();
    }

    // Sub-scenario C: maxFinalAuditRounds reached -> parks -> runFinalAudit({ force: true }) succeeds
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      let auditCalls = 0;

      const transport = new MockSwarmTransport({
        onWorker: async (req) => {
          worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: "done",
            tokens: 100,
            cost: 0.001,
          };
        },
        onFinalValidator: async (req) => {
          auditCalls += 1;
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "completed",
            summary: auditCalls === 1 ? "Flaky env issue" : "Passed on rerun",
            finalAuditVerdict: {
              commitSha: req.targetCommitSha,
              baseBranch: req.baseBranch,
              auditedAt: new Date().toISOString(),
              verifierAgentId: req.agentId,
              verdict: auditCalls === 1 ? "disapproved" : "approved",
              summary: auditCalls === 1 ? "Needs manual env fix" : "Env fixed and verified",
              checks: [{ name: "e2e", passed: auditCalls > 1 }],
              findings: auditCalls === 1 ? [{ severity: "p1", title: "Env issue", detail: "Missing config" }] : [],
              recommendedMissions: [
                {
                  title: "Fix config",
                  description: "Should not auto-run since maxFinalAuditRounds=1",
                  scope: ["src/cfg.ts"],
                  verification: "npm test",
                },
              ],
              round: req.round,
            },
            tokens: 100,
            cost: 0.001,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
        getHostContext: () => undefined,
      });

      const run = await store.createRun({
        objective: "Force rerun after max rounds",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-park-c",
        validatorEnabled: false,
        finalValidatorEnabled: true,
        autoFixOnAuditFail: true,
        maxFinalAuditRounds: 1,
        missions: [
          {
            id: "M1",
            title: "Main task",
            kind: "build",
            description: "Build main",
            scope: ["src/main.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);
      await waitFor(async () => (await store.loadRun(run.id)).finalAuditStatus === "disapproved");
      await orchestrator.tick();
      assert.equal(auditCalls, 1);
      assert.equal((await store.loadRun(run.id)).missionOrder.length, 1);

      await orchestrator.runFinalAudit({ force: true });
      await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
      assert.equal(auditCalls, 2);
      assert.equal((await store.loadRun(run.id)).finalAuditStatus, "approved");

      await orchestrator.dispose();
    }
  });

  it("enforces Final Validator safety checks: rejects dirty-base verdict, discards stale-SHA verdict, and emits single pre-audit DIRTY_BASE wakeup", async () => {
    // Safety Check 1: Final Validator dirties baseBranch
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();

      const transport = new MockSwarmTransport({
        onWorker: async (req) => {
          worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: "done",
            tokens: 100,
            cost: 0.001,
          };
        },
        onFinalValidator: async (req) => {
          worktree.baseDirty = true;
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "completed",
            summary: "Approved (illegally mutated base)",
            finalAuditVerdict: {
              commitSha: req.targetCommitSha,
              baseBranch: req.baseBranch,
              auditedAt: new Date().toISOString(),
              verifierAgentId: req.agentId,
              verdict: "approved",
              summary: "Looks clean",
              checks: [{ name: "tests", passed: true }],
              findings: [],
              round: req.round,
            },
            tokens: 100,
            cost: 0.001,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
        getHostContext: () => undefined,
      });

      const events: SwarmOrchestratorEvent[] = [];
      orchestrator.subscribe((e) => events.push(e));

      const run = await store.createRun({
        objective: "Dirty base validator guard",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-dirty-fv",
        validatorEnabled: false,
        finalValidatorEnabled: true,
        missions: [
          {
            id: "M1",
            title: "Clean change",
            kind: "build",
            description: "Build",
            scope: ["src/c.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);
      await waitFor(() => events.some((e) => e.type === "error" && /DIRTY_BASE/.test(e.summary)));

      const afterRun = await store.loadRun(run.id);
      assert.notEqual(afterRun.status, "completed");
      assert.equal(afterRun.latestFinalAudit, undefined);
      assert.ok(events.some((e) => e.type === "wakeup_needed" && /DIRTY_BASE/.test(e.summary)));

      await orchestrator.tick();
      assert.equal(transport.finalValidatorRequests.length, 1);

      await orchestrator.dispose();
    }

    // Safety Check 2: baseBranch HEAD moves mid-audit -> stale verdict discarded -> fresh audit
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      const seenShas: string[] = [];

      const transport = new MockSwarmTransport({
        onWorker: async (req) => {
          worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: "done",
            tokens: 100,
            cost: 0.001,
          };
        },
        onFinalValidator: async (req) => {
          seenShas.push(req.targetCommitSha);
          if (seenShas.length === 1) {
            worktree.baseSha = "manual-hotfix-sha-999";
          }
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "completed",
            summary: "Approved",
            finalAuditVerdict: {
              commitSha: req.targetCommitSha,
              baseBranch: req.baseBranch,
              auditedAt: new Date().toISOString(),
              verifierAgentId: req.agentId,
              verdict: "approved",
              summary: `Approved ${req.targetCommitSha}`,
              checks: [{ name: "tests", passed: true }],
              findings: [],
              round: req.round,
            },
            tokens: 100,
            cost: 0.001,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
        getHostContext: () => undefined,
      });

      const run = await store.createRun({
        objective: "Stale SHA discard guard",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-stale-fv",
        validatorEnabled: false,
        finalValidatorEnabled: true,
        missions: [
          {
            id: "M1",
            title: "Initial build",
            kind: "build",
            description: "Build",
            scope: ["src/s.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });

      await orchestrator.startRun(run.id);
      await waitFor(async () => (await store.loadRun(run.id)).status === "completed");

      assert.equal(seenShas.length, 2);
      assert.notEqual(seenShas[0], seenShas[1]);
      assert.equal(seenShas[1], "manual-hotfix-sha-999");

      const finalRun = await store.loadRun(run.id);
      assert.equal(finalRun.finalAuditStatus, "approved");
      assert.equal(finalRun.lastAuditedSha, "manual-hotfix-sha-999");
      assert.equal(finalRun.finalAuditRound, 1);

      await orchestrator.dispose();
    }

    // Pre-audit dirty base check: single wakeup, recovers on resume
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      worktree.baseDirty = true;
      let auditRuns = 0;

      const transport = new MockSwarmTransport({
        onWorker: async (req) => ({
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "done",
          tokens: 0,
          cost: 0,
        }),
        onFinalValidator: async (req) => {
          auditRuns += 1;
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "completed",
            summary: "Approved",
            finalAuditVerdict: {
              commitSha: req.targetCommitSha,
              baseBranch: req.baseBranch,
              auditedAt: new Date().toISOString(),
              verifierAgentId: req.agentId,
              verdict: "approved",
              summary: "Verified cleanly after base was cleaned",
              checks: [{ name: "tests", passed: true }],
              findings: [],
              round: req.round,
            },
            tokens: 100,
            cost: 0.001,
          };
        },
      });

      const orchestrator = new SwarmOrchestrator({
        store,
        worktree,
        transport,
        getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
        getHostContext: () => undefined,
      });

      const wakeups: SwarmOrchestratorEvent[] = [];
      orchestrator.subscribe((e) => {
        if (e.type === "wakeup_needed") wakeups.push(e);
      });

      const run = await store.createRun({
        objective: "Pre-audit dirty base deterministic",
        verificationContract: "npm test",
        baseBranch: "main",
        ownerSessionId: "sess-pre-dirty",
        validatorEnabled: false,
        finalValidatorEnabled: true,
        missions: [
          {
            id: "M1",
            title: "Already merged",
            kind: "build",
            description: "Merged",
            scope: ["src/p.ts"],
            deps: [],
            verification: "npm test",
          },
        ],
      });
      await store.updateMission(run.id, "M1", { status: "completed" });
      await store.markMerged(run.id, "M1", "merged-sha-p");

      await orchestrator.startRun(run.id);
      await orchestrator.tick();
      await orchestrator.tick();

      assert.equal(auditRuns, 0);
      assert.equal(wakeups.length, 1);
      assert.match(wakeups[0]!.summary, /DIRTY_BASE/);

      worktree.baseDirty = false;
      await orchestrator.resume(run.id);
      await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
      assert.equal(auditRuns, 1);

      await orchestrator.dispose();
    }
  });

  it("supports human stopAgent on running Final Validator without auto-restart, and 429 rate-limit backoff recovery", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let validatorAttempt = 0;

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "done",
          tokens: 100,
          cost: 0.001,
        };
      },
      onFinalValidator: async (req, controls) => {
        validatorAttempt += 1;
        if (validatorAttempt === 1) {
          return await new Promise<AgentTurnResult>((resolve) => {
            controls.onAbort((reason) => {
              resolve({
                agentId: req.agentId,
                name: req.name,
                missionId: FINAL_AUDIT_MISSION_ID,
                role: "final-validator",
                outcome: "aborted",
                summary: reason ?? "Stopped",
                error: reason ?? "Stopped",
                tokens: 40,
                cost: 0.001,
              });
            });
          });
        }
        if (validatorAttempt === 2) {
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "rate_limited",
            summary: "HTTP 429 Too Many Requests",
            error: "HTTP 429 Too Many Requests",
            retryAfterMs: 50,
            tokens: 10,
            cost: 0,
          };
        }
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          outcome: "completed",
          summary: "Approved after retry",
          finalAuditVerdict: {
            commitSha: req.targetCommitSha,
            baseBranch: req.baseBranch,
            auditedAt: new Date().toISOString(),
            verifierAgentId: req.agentId,
            verdict: "approved",
            summary: "Verified cleanly after backoff",
            checks: [{ name: "tests", passed: true }],
            findings: [],
            round: req.round,
          },
          tokens: 150,
          cost: 0.002,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: false,
          autoMergeClean: true,
          rateLimitBaseBackoffMs: 40,
          rateLimitMaxBackoffMs: 200,
          maxRetries: 2,
          fallbackModels: [],
        }),
      getHostContext: () => undefined,
      random: () => 0,
    });

    const run = await store.createRun({
      objective: "Stop and 429 final validator recovery",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-fv-stop-429",
      validatorEnabled: false,
      finalValidatorEnabled: true,
      missions: [
        {
          id: "M1",
          title: "Feature x",
          kind: "build",
          description: "Build x",
          scope: ["src/x.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(() => Boolean(orchestrator.getSnapshot().finalAuditRunningAgentId));
    const runningId = orchestrator.getSnapshot().finalAuditRunningAgentId!;

    await orchestrator.stopAgent(runningId, { humanStopped: true, reason: "Inspecting manually" });
    await orchestrator.tick();
    await orchestrator.tick();
    assert.equal(validatorAttempt, 1);
    assert.equal(orchestrator.getSnapshot().finalAuditRunningAgentId, undefined);
    assert.equal((await store.loadRun(run.id)).roster[runningId]!.status, "stopped");
    assert.equal((await store.loadRun(run.id)).roster[runningId]!.humanStopped, true);

    await orchestrator.runFinalAudit({ force: true });
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
    assert.equal(validatorAttempt, 3);
    assert.equal((await store.loadRun(run.id)).finalAuditStatus, "approved");

    const ledger = await store.getRecentEvents(run.id, 100);
    assert.ok(ledger.some((e) => e.type === "rate_limit_backoff" && e.missionId === FINAL_AUDIT_MISSION_ID));

    await orchestrator.dispose();
  });

  it("tests swarm_verify tool (status & run), human-only skipFinalAudit guard, and Final Validator prompt builders", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let auditAttempt = 0;

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Implemented module",
          tokens: 100,
          cost: 0.001,
        };
      },
      onFinalValidator: async (req) => {
        auditAttempt += 1;
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          outcome: "completed",
          summary: auditAttempt === 1 ? "Needs fix" : "All good",
          finalAuditVerdict: {
            commitSha: req.targetCommitSha,
            baseBranch: req.baseBranch,
            auditedAt: new Date().toISOString(),
            verifierAgentId: req.agentId,
            verdict: auditAttempt === 1 ? "disapproved" : "approved",
            summary: auditAttempt === 1 ? "Found integration gap" : "Integration verified",
            checks: [{ name: "integration", passed: auditAttempt > 1 }],
            findings:
              auditAttempt === 1
                ? [{ severity: "p1", title: "Gap", detail: "Missing glue", file: "src/index.ts", line: 10 }]
                : [],
            recommendedMissions:
              auditAttempt === 1
                ? [{ title: "Add glue", description: "Wire module", scope: ["src/index.ts"], verification: "npm test" }]
                : undefined,
            round: req.round,
          },
          tokens: 120,
          cost: 0.002,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Verify tool & guard test",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-verify-tool",
      validatorEnabled: false,
      finalValidatorEnabled: true,
      autoFixOnAuditFail: false,
      missions: [
        {
          id: "M1",
          title: "Module one",
          kind: "build",
          description: "Build module one",
          scope: ["src/mod1.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });
    await orchestrator.attachRun(run.id);

    const verifyTool = createSwarmVerifyTool({
      store,
      worktree,
      orchestrator,
      getActiveRunId: () => run.id,
    });
    assert.equal(verifyTool.name, SWARM_VERIFY_TOOL);

    const fakeCtx = {
      sessionManager: { getSessionId: () => "sess-verify-tool" },
    } as unknown as ExtensionToolContext;

    // 1. action="run" while M1 is still planned -> INVALID_TRANSITION
    const earlyRun = await verifyTool.execute("tv1", { action: "run" }, undefined, undefined, fakeCtx);
    assert.equal(earlyRun.isError, true);
    assert.match((earlyRun.content[0] as { text: string }).text, /\[SwarmProtocolError:INVALID_TRANSITION\]/);

    // 2. Forcibly passing action="skip" -> ROLE_FORBIDDEN (human-only!)
    const forbiddenSkip = await verifyTool.execute(
      "tv2",
      { action: "skip" as unknown as "run" },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.equal(forbiddenSkip.isError, true);
    assert.match((forbiddenSkip.content[0] as { text: string }).text, /\[SwarmProtocolError:ROLE_FORBIDDEN\]/);

    // 3. Store skipFinalAudit rejects orchestrator role with ROLE_FORBIDDEN!
    await assert.rejects(
      () => store.skipFinalAudit(run.id, { callerRole: "orchestrator", reason: "Trying to bypass" }),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "ROLE_FORBIDDEN",
    );

    // 4. Run M1 -> merges -> Final Validator Round 1 disapproves -> inspect via swarm_verify action="status"
    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).finalAuditStatus === "disapproved");

    const statusRes = await verifyTool.execute("tv3", { action: "status" }, undefined, undefined, fakeCtx);
    assert.equal(statusRes.isError, undefined);
    const statusText = (statusRes.content[0] as { text: string }).text;
    assert.match(statusText, /Status: disapproved/);
    assert.match(statusText, /Found integration gap/);
    assert.match(statusText, /Missing glue/);
    assert.match(statusText, /Add glue/);
    const statusDetails = statusRes.details as Record<string, unknown>;
    assert.equal(statusDetails.finalValidatorEnabled, true);
    assert.equal(statusDetails.finalAuditStatus, "disapproved");
    assert.equal(statusDetails.round, 1);

    // 5. Verify prompt builders directly
    const currentRun = await store.loadRun(run.id);
    const mergedList = [currentRun.missions.M1!];
    const sysPrompt = buildFinalValidatorSystemPrompt(currentRun, mergedList, worktree.baseSha, 2);
    const taskPrompt = buildFinalValidatorTaskPrompt(
      currentRun,
      mergedList,
      currentRun.findings,
      currentRun.latestFinalAudit ? [currentRun.latestFinalAudit] : [],
      worktree.baseSha,
    );
    assert.match(sysPrompt, /Final Validator \/ Goal Auditor/);
    assert.match(sysPrompt, /untrusted claims/i);
    assert.match(sysPrompt, /pairwise-disjoint/i);
    assert.match(taskPrompt, /Prior Final Audit Rounds/);
    assert.match(taskPrompt, /Found integration gap/);

    // 6. Trigger re-run via swarm_verify action="run" with force=true -> approves & completes!
    const rerunRes = await verifyTool.execute(
      "tv4",
      { action: "run", force: true },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.equal(rerunRes.isError, undefined);
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
    assert.equal((await store.loadRun(run.id)).finalAuditStatus, "approved");

    await orchestrator.dispose();
  });

  it("clears stale finalAuditBlockedSha when addMissions reopens run so zero-diff survey/abandoned closures still trigger fresh validation", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    let auditCalls = 0;

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        if (req.mission.kind === "survey") {
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: "Survey verified findings with zero diff",
            tokens: 80,
            cost: 0.001,
          };
        }
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: `Completed ${req.mission.id}`,
          tokens: 100,
          cost: 0.001,
        };
      },
      onFinalValidator: async (req) => {
        auditCalls += 1;
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          outcome: "completed",
          summary: auditCalls === 1 ? "Needs survey confirmation" : "Verified after follow-up",
          finalAuditVerdict: {
            commitSha: req.targetCommitSha,
            baseBranch: req.baseBranch,
            auditedAt: new Date().toISOString(),
            verifierAgentId: req.agentId,
            verdict: auditCalls === 1 ? "disapproved" : "approved",
            summary: auditCalls === 1 ? "Need verification evidence" : "Evidence confirmed",
            checks: [{ name: "contract", passed: auditCalls > 1 }],
            findings:
              auditCalls === 1
                ? [{ severity: "p1", title: "Missing evidence", detail: "Confirm API contract" }]
                : [],
            round: req.round,
          },
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Stale blocked SHA regression",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-stale-block-sha",
      validatorEnabled: false,
      finalValidatorEnabled: true,
      autoFixOnAuditFail: false,
      missions: [
        {
          id: "M1",
          title: "Primary build",
          kind: "build",
          description: "Build primary feature",
          scope: ["src/primary.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(async () => (await store.loadRun(run.id)).finalAuditStatus === "disapproved");

    const baseShaAfterM1 = worktree.baseSha;
    await orchestrator.tick();
    await orchestrator.tick();
    assert.equal(auditCalls, 1);

    await store.addMissions(run.id, [
      {
        id: "S1",
        title: "Verify api contract",
        kind: "survey",
        description: "Inspect API contract without mutating code",
        scope: ["src/primary.ts"],
        deps: [],
        verification: "record findings",
      },
    ]);
    await orchestrator.tick();

    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
    assert.equal(worktree.baseSha, baseShaAfterM1);
    assert.equal(auditCalls, 2);
    assert.equal((await store.loadRun(run.id)).finalAuditStatus, "approved");

    await orchestrator.dispose();
  });

  it("displays 1-based running audit round (1/2 during R1, 2/2 during R2) in swarm_verify, swarm_status, and orchestrator context summary", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const r1Gate = createDeferred<void>();
    const r2Gate = createDeferred<void>();

    const transport = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree.simulateCommit(req.branch, [req.mission.scope[0]!]);
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "done",
          tokens: 100,
          cost: 0.001,
        };
      },
      onFinalValidator: async (req) => {
        if (req.round === 1) {
          await r1Gate.promise;
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: FINAL_AUDIT_MISSION_ID,
            role: "final-validator",
            outcome: "completed",
            summary: "R1 disapproved",
            finalAuditVerdict: {
              commitSha: req.targetCommitSha,
              baseBranch: req.baseBranch,
              auditedAt: new Date().toISOString(),
              verifierAgentId: req.agentId,
              verdict: "disapproved",
              summary: "R1 needs rerun",
              checks: [{ name: "tests", passed: false }],
              findings: [{ severity: "p1", title: "Gap", detail: "Needs check" }],
              round: 1,
            },
            tokens: 100,
            cost: 0.001,
          };
        }
        await r2Gate.promise;
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          outcome: "completed",
          summary: "R2 approved",
          finalAuditVerdict: {
            commitSha: req.targetCommitSha,
            baseBranch: req.baseBranch,
            auditedAt: new Date().toISOString(),
            verifierAgentId: req.agentId,
            verdict: "approved",
            summary: "R2 clean",
            checks: [{ name: "tests", passed: true }],
            findings: [],
            round: 2,
          },
          tokens: 100,
          cost: 0.001,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => makeSettings({ validatorEnabled: false, autoMergeClean: true }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Running round display test",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-running-round",
      validatorEnabled: false,
      finalValidatorEnabled: true,
      autoFixOnAuditFail: false,
      maxFinalAuditRounds: 2,
      missions: [
        {
          id: "M1",
          title: "Core task",
          kind: "build",
          description: "Build core",
          scope: ["src/core.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    const tools = createOrchestratorTools({
      store,
      worktree,
      orchestrator,
      getActiveRunId: () => run.id,
      getSessionId: () => "sess-running-round",
    });
    const statusTool = tools.find((t) => t.name === SWARM_STATUS_TOOL)!;
    const verifyTool = tools.find((t) => t.name === SWARM_VERIFY_TOOL)!;
    const fakeCtx = {
      sessionManager: { getSessionId: () => "sess-running-round" },
    } as unknown as ExtensionToolContext;

    await orchestrator.startRun(run.id);
    await waitFor(() => transport.finalValidatorRequests.length === 1);

    assert.equal((await store.loadRun(run.id)).finalAuditRound, 0);
    const r1VerifyStatus = await verifyTool.execute("r1-vs", { action: "status" }, undefined, undefined, fakeCtx);
    assert.match((r1VerifyStatus.content[0] as { text: string }).text, /Round: 1\/2/);
    assert.equal((r1VerifyStatus.details as Record<string, unknown>).round, 1);

    const r1SwarmStatus = await statusTool.execute("r1-ts", {}, undefined, undefined, fakeCtx);
    assert.match((r1SwarmStatus.content[0] as { text: string }).text, /r1\/2/);
    assert.match((r1SwarmStatus.content[0] as { text: string }).text, /round 1\/2/);

    const r1CtxSummary = buildOrchestratorContextSummary(orchestrator.getSnapshot());
    assert.match(r1CtxSummary, /round=1\/2/);

    r1Gate.resolve();
    await waitFor(async () => (await store.loadRun(run.id)).finalAuditStatus === "disapproved");

    const r2Trigger = await verifyTool.execute("r2-run", { action: "run", force: true }, undefined, undefined, fakeCtx);
    await waitFor(() => transport.finalValidatorRequests.length === 2);

    assert.match((r2Trigger.content[0] as { text: string }).text, /round=2\/2/);
    assert.equal((r2Trigger.details as Record<string, unknown>).round, 2);

    const r2VerifyStatus = await verifyTool.execute("r2-vs", { action: "status" }, undefined, undefined, fakeCtx);
    assert.match((r2VerifyStatus.content[0] as { text: string }).text, /Round: 2\/2/);
    assert.equal((r2VerifyStatus.details as Record<string, unknown>).round, 2);

    const r2SwarmStatus = await statusTool.execute("r2-ts", {}, undefined, undefined, fakeCtx);
    assert.match((r2SwarmStatus.content[0] as { text: string }).text, /r2\/2/);
    assert.match((r2SwarmStatus.content[0] as { text: string }).text, /round 2\/2/);

    const r2CtxSummary = buildOrchestratorContextSummary(orchestrator.getSnapshot());
    assert.match(r2CtxSummary, /round=2\/2/);

    r2Gate.resolve();
    await waitFor(async () => (await store.loadRun(run.id)).status === "completed");
    await orchestrator.dispose();
  });
});

// ============================================================================
// Verifier Regression Suite (Board #61 Findings 1-5)
// ============================================================================

describe("Verifier Regression Suite (#61)", () => {
  function makeMockModelRuntime() {
    const models = [
      {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        provider: "anthropic",
        id: "claude-opus-4",
        name: "Claude Opus 4",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        provider: "openai",
        id: "gpt-5",
        name: "GPT-5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ];
    return {
      models,
      hostContext: {
        model: models[0],
        modelRegistry: {
          runtime: {
            getModels: () => models,
            hasConfiguredAuth: () => true,
          },
        },
      } as unknown as ExtensionContext,
    };
  }

  function makeDummyMission(id = "M1"): MissionRecord {
    const now = new Date().toISOString();
    return {
      id,
      title: `Mission ${id}`,
      kind: "build",
      description: "Test mission",
      scope: ["src/a.ts"],
      deps: [],
      verification: "npm test",
      tasks: [],
      branch: `feat/mission-${id.toLowerCase()}`,
      worktreePath: process.cwd(),
      status: "active",
      reviewRound: 0,
      retryCount: 0,
      humanStopped: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("Finding #1: InProcessPiTransport disposes AgentSession cleanly and never emits 'started' after early kill() during createAgentSession()", async () => {
    const { hostContext, models } = makeMockModelRuntime();
    const createStarted = createDeferred<void>();
    const createGate = createDeferred<void>();

    let createdCount = 0;
    let bindExtensionsCalls = 0;
    let subscribeCalls = 0;
    let promptCalls = 0;
    let disposeCalls = 0;

    const fakeSession = {
      model: models[0],
      extensionRunner: { hasHandlers: () => false, emit: async () => {} },
      bindExtensions: async () => {
        bindExtensionsCalls += 1;
      },
      subscribe: () => {
        subscribeCalls += 1;
        return () => {};
      },
      prompt: async () => {
        promptCalls += 1;
      },
      abort: async () => {},
      steer: async () => {},
      followUp: async () => {},
      setModel: async () => {},
      setThinkingLevel: () => {},
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      }),
      dispose: () => {
        disposeCalls += 1;
      },
    } as unknown as AgentSession;

    const transport = new InProcessPiTransport({
      createSession: (async () => {
        createdCount += 1;
        createStarted.resolve();
        await createGate.promise;
        return { session: fakeSession, extensionsResult: { extensions: [], errors: [], runtime: {} } };
      }) as unknown as NonNullable<ConstructorParameters<typeof InProcessPiTransport>[0]>["createSession"],
    });

    const telemetry: WorkerTelemetryEvent[] = [];
    const handle = await transport.spawnWorker({
      agentId: "w-M1-early-kill",
      name: "M1",
      role: "worker",
      runId: "run-early-kill",
      mission: makeDummyMission("M1"),
      objective: "Test early kill",
      verificationContract: "npm test",
      baseBranch: "main",
      worktreePath: process.cwd(),
      branch: "feat/mission-m1",
      prompt: "Do work",
      systemPromptAppendix: "",
      boardCursor: 0,
      keepWarm: true,
      modelOverride: "anthropic/claude-sonnet-4",
      hostContext,
      onTelemetry: (ev) => telemetry.push(ev),
    });

    // Wait until createAgentSession() is in flight, then kill BEFORE it resolves
    await createStarted.promise;
    await handle.kill("Cancelled during startup");
    assert.equal(handle.getState(), "killed");

    // Now let createAgentSession() resolve — transport must dispose created session and NOT start it
    createGate.resolve();
    const res = await handle.currentTurn;

    assert.equal(createdCount, 1);
    assert.equal(disposeCalls, 1, "created AgentSession must be disposed despite early kill()");
    assert.equal(bindExtensionsCalls, 0, "bindExtensions must not run after kill()");
    assert.equal(subscribeCalls, 0, "subscribe must not run after kill()");
    assert.equal(promptCalls, 0, "prompt must not run after kill()");
    assert.equal(res.outcome, "aborted");
    assert.equal(handle.getState(), "killed");
    assert.ok(telemetry.some((e) => e.type === "killed"), "killed telemetry should be emitted");
    assert.ok(
      !telemetry.some((e) => e.type === "started"),
      "started telemetry must NEVER be emitted after early kill()",
    );
  });

  it("Finding #2: InProcessPiTransport serializes switchModel() against wake()/switchModel()/kill() and enforces strict waiting state", async () => {
    const { hostContext, models } = makeMockModelRuntime();
    const setModelGates: Array<ReturnType<typeof createDeferred<void>>> = [];
    const setModelStarted: Array<ReturnType<typeof createDeferred<void>>> = [];
    const thinkingCalls: ThinkingLevel[] = [];
    let disposeCalls = 0;

    const makeFakeSession = () =>
      ({
        model: models[0],
        extensionRunner: { hasHandlers: () => false, emit: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        abort: async () => {},
        steer: async () => {},
        followUp: async () => {},
        setModel: async (nextModel: unknown) => {
          const idx = setModelGates.length;
          const gate = createDeferred<void>();
          const started = createDeferred<void>();
          setModelGates.push(gate);
          setModelStarted.push(started);
          started.resolve();
          await gate.promise;
          (fakeSession as { model: unknown }).model = nextModel;
        },
        setThinkingLevel: (level: ThinkingLevel) => {
          thinkingCalls.push(level);
        },
        getSessionStats: () => ({
          tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 },
          cost: 0.001,
        }),
        dispose: () => {
          disposeCalls += 1;
        },
      }) as unknown as AgentSession;

    let fakeSession = makeFakeSession();
    const transport = new InProcessPiTransport({
      createSession: (async () => ({
        session: fakeSession,
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      })) as unknown as NonNullable<ConstructorParameters<typeof InProcessPiTransport>[0]>["createSession"],
    });

    const handle = await transport.spawnWorker({
      agentId: "w-M1-switch-race",
      name: "M1",
      role: "worker",
      runId: "run-switch-race",
      mission: makeDummyMission("M1"),
      objective: "Test switchModel races",
      verificationContract: "npm test",
      baseBranch: "main",
      worktreePath: process.cwd(),
      branch: "feat/mission-m1",
      prompt: "Initial turn",
      systemPromptAppendix: "",
      boardCursor: 0,
      keepWarm: true,
      modelOverride: "anthropic/claude-sonnet-4",
      hostContext,
    });

    await handle.currentTurn;
    assert.equal(handle.getState(), "waiting");

    // 1. Start deferred switchModel -> concurrent wake() and switchModel() MUST reject with AGENT_NOT_WAITING
    const switch1Promise = handle.switchModel("anthropic/claude-opus-4", "high");
    await waitFor(() => setModelStarted.length === 1);
    await setModelStarted[0]!.promise;

    await assert.rejects(
      () => handle.wake("mid-switch wake"),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "AGENT_NOT_WAITING",
    );
    await assert.rejects(
      () => handle.switchModel("openai/gpt-5"),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "AGENT_NOT_WAITING",
    );

    setModelGates[0]!.resolve();
    const sw1 = await switch1Promise;
    assert.equal(sw1.model, "anthropic/claude-opus-4");
    assert.equal(sw1.thinkingLevel, "high");
    assert.deepEqual(thinkingCalls, ["high"]);

    // 2. Concurrent kill() during pending setModel() -> must reject with AGENT_KILLED (never TypeError!)
    const switch2Promise = handle.switchModel("openai/gpt-5", "medium");
    await waitFor(() => setModelStarted.length === 2);
    await setModelStarted[1]!.promise;

    await handle.kill("Killed mid-switch");
    setModelGates[1]!.resolve();

    await assert.rejects(
      () => switch2Promise,
      (err: unknown) => isSwarmProtocolError(err) && err.code === "AGENT_KILLED",
    );
    assert.equal(thinkingCalls.length, 1, "setThinkingLevel must not be called after kill()");
    assert.equal(disposeCalls, 1);

    // 3. Stopped handle (after abort()) -> switchModel() MUST reject with AGENT_NOT_WAITING (strict waiting-only!)
    fakeSession = makeFakeSession();
    const handle2 = await transport.spawnWorker({
      agentId: "w-M2-stopped",
      name: "M2",
      role: "worker",
      runId: "run-switch-race",
      mission: makeDummyMission("M2"),
      objective: "Test stopped switchModel rejection",
      verificationContract: "npm test",
      baseBranch: "main",
      worktreePath: process.cwd(),
      branch: "feat/mission-m2",
      prompt: "Initial turn",
      systemPromptAppendix: "",
      boardCursor: 0,
      keepWarm: true,
      modelOverride: "anthropic/claude-sonnet-4",
      hostContext,
    });
    await handle2.currentTurn;
    assert.equal(handle2.getState(), "waiting");
    await handle2.abort("Paused/stopped");
    assert.equal(handle2.getState(), "stopped");

    await assert.rejects(
      () => handle2.switchModel("openai/gpt-5"),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "AGENT_NOT_WAITING",
    );
    await handle2.kill("Cleanup");
  });

  it("Finding #3: simultaneous @mention board wakeups deliver every message without silently dropping concurrent posts", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const deliveredTexts: string[] = [];
    const errors: SwarmOrchestratorEvent[] = [];

    // Add a small deterministic async tick to readBoard so the two concurrent routeBoardMessage calls overlap!
    const origReadBoard = store.readBoard.bind(store);
    let readBoardDelayEnabled = false;
    store.readBoard = async (runId, opts) => {
      if (readBoardDelayEnabled) {
        await new Promise((r) => setTimeout(r, 15));
      }
      return origReadBoard(runId, opts);
    };

    const transport = new MockSwarmTransport({
      onWorker: async (req, ctrl) => {
        if (ctrl.turn === 1) {
          worktree.simulateCommit(req.branch, ["src/m1.ts"], "sha-m1-done");
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: "M1 committed and parked warm",
            workerDone: { missionId: req.mission.id, summary: "M1 committed" },
            tokens: 100,
            cost: 0.001,
          };
        }
        // Record every wake prompt and followUp delivered on board wakeup turns
        deliveredTexts.push(ctrl.prompt);
        await new Promise((r) => setTimeout(r, 10));
        for (const f of ctrl.followUps) {
          deliveredTexts.push(f);
        }
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Replied on board",
          tokens: 50,
          cost: 0.0005,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          validatorEnabled: false,
          autoMergeClean: false,
          finalValidatorEnabled: false,
          keepWorkersWarm: true,
        }),
      getHostContext: () => undefined,
    });
    orchestrator.subscribe((ev) => {
      if (ev.type === "error") {
        errors.push(ev);
      }
    });

    const run = await store.createRun({
      objective: "Simultaneous @mention wakeup delivery",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-concurrent-mentions",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      keepWorkersWarm: true,
      missions: [
        {
          id: "M1",
          title: "Target worker",
          kind: "build",
          description: "Complete and wait warm",
          scope: ["src/m1.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await waitFor(
      async () =>
        (await store.loadRun(run.id)).missions.M1!.status === "completed" &&
        transport.getTrackedByName("M1")[0]?.handle.getState() === "waiting",
    );

    readBoardDelayEnabled = true;

    // Fire TWO simultaneous @M1 posts while M1 is parked in waiting state!
    await Promise.all([
      orchestrator.postToBoard({
        from: "M2",
        fromRole: "worker",
        text: "@M1 alpha-payload-first",
      }),
      orchestrator.postToBoard({
        from: "M3",
        fromRole: "worker",
        text: "@M1 beta-payload-second",
      }),
    ]);

    await waitFor(() => {
      const combined = deliveredTexts.join("\n");
      return (
        combined.includes("alpha-payload-first") &&
        combined.includes("beta-payload-second") &&
        transport.getTrackedByName("M1")[0]?.handle.getState() === "waiting"
      );
    });

    const combined = deliveredTexts.join("\n");
    assert.ok(combined.includes("alpha-payload-first"), "M1 must receive first concurrent @mention");
    assert.ok(combined.includes("beta-payload-second"), "M1 must receive second concurrent @mention");
    assert.equal(errors.length, 0, "Zero orchestrator error events should be emitted");

    await orchestrator.dispose();
  });

  it("Finding #4: holds reservation across quota fallback switch, enforces strict waiting on switchAgentModel, and aborts wakeAgent cleanly if killed mid-await", async () => {
    // --- Sub-case 4a: Quota fallback switch window cannot be raced by tick() or @M1 mentions ---
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const switchStarted = createDeferred<void>();
    const switchGate = createDeferred<void>();
    const seenModels: Array<string | undefined> = [];
    const receivedPrompts: string[] = [];

    const transport = new MockSwarmTransport({
      onSwitchModel: async (agentName, targetModel) => {
        if (agentName === "M1" && targetModel === "openai/gpt-5-fallback") {
          switchStarted.resolve();
          await switchGate.promise;
        }
      },
      onWorker: async (req, ctrl) => {
        seenModels.push(ctrl.getModel());
        receivedPrompts.push(ctrl.prompt);
        if (ctrl.turn === 1) {
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "rate_limited",
            summary: "429 quota exhausted",
            error: "HTTP 429 rate limit",
            tokens: 40,
            cost: 0.0004,
          };
        }
        if (ctrl.turn === 2) {
          worktree.simulateCommit(req.branch, ["src/m1.ts"], "sha-m1-fallback");
          return {
            agentId: req.agentId,
            name: req.name,
            missionId: req.mission.id,
            role: "worker",
            outcome: "completed",
            summary: "Completed on fallback model",
            workerDone: { missionId: req.mission.id, summary: "Fallback done" },
            tokens: 90,
            cost: 0.0009,
          };
        }
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Handled queued ping",
          tokens: 30,
          cost: 0.0003,
        };
      },
    });

    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () =>
        makeSettings({
          workerModel: "anthropic/claude-sonnet-4",
          fallbackModels: ["openai/gpt-5-fallback"],
          validatorEnabled: false,
          autoMergeClean: false,
          finalValidatorEnabled: false,
          keepWorkersWarm: true,
        }),
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "Quota fallback race guard",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-fallback-race",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      keepWorkersWarm: true,
      missions: [
        {
          id: "M1",
          title: "Fallback worker",
          kind: "build",
          description: "Recover via fallback model",
          scope: ["src/m1.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orchestrator.startRun(run.id);
    await switchStarted.promise;

    const trackedM1 = transport.getTrackedByName("M1")[0]!;
    // While quota fallback switchModel() is in flight:
    // 1. tick() MUST NOT wake M1 on the old rate-limited model or spawn a duplicate worker
    await orchestrator.tick();
    assert.equal(transport.workerRequests.length, 1, "No duplicate worker spawn during quota switch");
    assert.equal(trackedM1.getWakeCount(), 0, "M1 must not wake on old model during quota switch");

    // 2. Concurrent switchAgentModel() MUST reject with AGENT_NOT_WAITING
    await assert.rejects(
      () => orchestrator.switchAgentModel("M1", "openai/gpt-5-other"),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "AGENT_NOT_WAITING",
    );

    // 3. Board @M1 mention during switch MUST be queued, NOT wake M1 on old model!
    await orchestrator.postToBoard({
      from: "orchestrator",
      fromRole: "orchestrator",
      text: "@M1 queued-during-fallback-switch",
    });
    assert.equal(trackedM1.getWakeCount(), 0, "Board mention must queue during fallback switch");

    // Release fallback switch -> M1 wakes on fallback model, finishes mission, then drains queued board ping!
    switchGate.resolve();
    await waitFor(
      async () =>
        (await store.loadRun(run.id)).missions.M1!.status === "completed" &&
        receivedPrompts.some((p) => p.includes("queued-during-fallback-switch")) &&
        trackedM1.handle.getState() === "waiting",
    );

    assert.equal(transport.workerRequests.length, 1);
    assert.equal(seenModels[0], "anthropic/claude-sonnet-4");
    assert.equal(seenModels[1], "openai/gpt-5-fallback");
    assert.equal(seenModels[2], "openai/gpt-5-fallback");

    // --- Sub-case 4b: switchAgentModel() rejects 'stopped' agent with AGENT_NOT_WAITING ---
    await orchestrator.stopAgent("M1", { humanStopped: true, reason: "User stopped" });
    assert.equal(trackedM1.handle.getState(), "stopped");
    await assert.rejects(
      () => orchestrator.switchAgentModel("M1", "openai/gpt-5"),
      (err: unknown) => isSwarmProtocolError(err) && err.code === "AGENT_NOT_WAITING",
    );
    await orchestrator.dispose();

    // --- Sub-case 4c: wakeAgent() aborts cleanly if killAgent() runs while awaiting store.updateRoster ---
    const store2 = new MockSwarmStore();
    const worktree2 = new MockWorktreeManager();
    const wakeRosterHit = createDeferred<void>();
    const wakeRosterGate = createDeferred<void>();
    const origUpdateRoster = store2.updateRoster.bind(store2);
    let interceptWakeRoster = false;
    store2.updateRoster = async (rId, aId, patch) => {
      if (interceptWakeRoster && patch.status === "working") {
        interceptWakeRoster = false;
        wakeRosterHit.resolve();
        await wakeRosterGate.promise;
      }
      return origUpdateRoster(rId, aId, patch);
    };

    const transport2 = new MockSwarmTransport({
      onWorker: async (req) => {
        worktree2.simulateCommit(req.branch, ["src/k.ts"], "sha-k1");
        return {
          agentId: req.agentId,
          name: req.name,
          missionId: req.mission.id,
          role: "worker",
          outcome: "completed",
          summary: "Done",
          workerDone: { missionId: req.mission.id, summary: "Done" },
          tokens: 50,
          cost: 0.0005,
        };
      },
    });

    const errors2: SwarmOrchestratorEvent[] = [];
    const orch2 = new SwarmOrchestrator({
      store: store2,
      worktree: worktree2,
      transport: transport2,
      getSettings: () =>
        makeSettings({
          validatorEnabled: false,
          autoMergeClean: false,
          finalValidatorEnabled: false,
          keepWorkersWarm: true,
        }),
      getHostContext: () => undefined,
    });
    orch2.subscribe((ev) => {
      if (ev.type === "error") errors2.push(ev);
    });

    const run2 = await store2.createRun({
      objective: "Kill mid-wakeAgent store await",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-kill-mid-wake",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      keepWorkersWarm: true,
      missions: [
        {
          id: "M1",
          title: "Kill target",
          kind: "build",
          description: "Park warm then kill mid-wake",
          scope: ["src/k.ts"],
          deps: [],
          verification: "npm test",
        },
      ],
    });

    await orch2.startRun(run2.id);
    await waitFor(
      async () =>
        (await store2.loadRun(run2.id)).missions.M1!.status === "completed" &&
        transport2.getTrackedByName("M1")[0]?.handle.getState() === "waiting",
    );

    const tracked2 = transport2.getTrackedByName("M1")[0]!;
    interceptWakeRoster = true;

    // Trigger board wakeup -> enters wakeAgent and pauses inside store.updateRoster(status: "working")
    const postPromise = orch2.postToBoard({
      from: "orchestrator",
      fromRole: "orchestrator",
      text: "@M1 wake that will be killed",
    });
    await wakeRosterHit.promise;

    // Kill M1 while wakeAgent is still awaiting updateRoster, then let updateRoster resolve
    await orch2.killAgent("M1", "Killed mid-wake");
    wakeRosterGate.resolve();
    await postPromise;
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(tracked2.getWakeCount(), 0, "handle.wake() must NEVER be called after killAgent()");
    assert.equal(tracked2.handle.getState(), "killed");
    assert.equal(
      (await store2.loadRun(run2.id)).roster[tracked2.agentId]?.status,
      "killed",
      "Roster status must remain 'killed' and not revert to 'working'",
    );
    assert.equal(errors2.length, 0, "Killing during wakeAgent must not emit spurious error events");
    await orch2.dispose();
  });

  it("Finding #5: swarm_model clears role defaults without storing literal 'default', preserves thinkingLevel, and refreshes orchestrator snapshot", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const transport = new MockSwarmTransport({
      onWorker: async (req) => ({
        agentId: req.agentId,
        name: req.name,
        missionId: req.mission.id,
        role: "worker",
        outcome: "completed",
        summary: "noop",
        tokens: 10,
        cost: 0,
      }),
    });

    const settings = makeSettings({});
    const orchestrator = new SwarmOrchestrator({
      store,
      worktree,
      transport,
      getSettings: () => settings,
      getHostContext: () => undefined,
    });

    const run = await store.createRun({
      objective: "swarm_model role update & clear behavior",
      verificationContract: "npm test",
      baseBranch: "main",
      ownerSessionId: "sess-swarm-model",
      roleModels: {
        worker: { model: "anthropic/claude-sonnet-4", thinkingLevel: "high" },
        validator: { model: "openai/o3", thinkingLevel: "high" },
      },
      missions: [
        {
          id: "M1",
          title: "Placeholder",
          kind: "survey",
          description: "Survey",
          scope: ["src"],
          deps: [],
          verification: "none",
        },
      ],
    });
    await orchestrator.attachRun(run.id);

    // 1. Test WITHOUT onRoleModelChanged wired:
    const toolsNoCallback = createOrchestratorTools({
      store,
      worktree,
      orchestrator,
      getActiveRunId: () => run.id,
      getSessionId: () => "sess-swarm-model",
    });
    const modelTool = toolsNoCallback.find((t) => t.name === SWARM_MODEL_TOOL)!;
    const fakeCtx = {
      sessionManager: { getSessionId: () => "sess-swarm-model" },
    } as unknown as ExtensionToolContext;

    // 1a. Updating only model MUST preserve existing thinkingLevel AND refresh orchestrator.getSnapshot()!
    const updateRes = await modelTool.execute(
      "m-upd",
      { target: "worker", model: "openai/gpt-5" },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.ok(!("isError" in updateRes && updateRes.isError));
    const afterUpdateRun = await store.loadRun(run.id);
    assert.equal(afterUpdateRun.roleModels?.worker?.model, "openai/gpt-5");
    assert.equal(afterUpdateRun.roleModels?.worker?.thinkingLevel, "high");
    assert.equal(orchestrator.getSnapshot().roleModels.worker?.model, "openai/gpt-5");
    assert.equal(orchestrator.getSnapshot().roleModels.worker?.thinkingLevel, "high");

    // 1b. Clearing with "default" MUST set model & thinkingLevel to undefined (NEVER literal "default"!)
    const clearRes = await modelTool.execute(
      "m-clr",
      { target: "worker", model: "default" },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.ok(!("isError" in clearRes && clearRes.isError));
    assert.match((clearRes.content[0] as { text: string }).text, /Cleared "worker"/);
    const clearDetails = clearRes.details as Record<string, unknown>;
    assert.equal(clearDetails.model, undefined);
    assert.equal(clearDetails.cleared, true);

    const afterClearRun = await store.loadRun(run.id);
    assert.equal(afterClearRun.roleModels?.worker?.model, undefined);
    assert.equal(afterClearRun.roleModels?.worker?.thinkingLevel, undefined);
    assert.equal(orchestrator.getSnapshot().roleModels.worker?.model, undefined);
    assert.equal(orchestrator.getSnapshot().roleModels.worker?.thinkingLevel, undefined);

    // 1c. Clearing with "clear" + explicit thinking_level keeps only the explicit thinkingLevel
    const clearWithThinking = await modelTool.execute(
      "m-clr-t",
      { target: "validator", model: "clear", thinking_level: "medium" },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.ok(!("isError" in clearWithThinking && clearWithThinking.isError));
    const afterValClear = await store.loadRun(run.id);
    assert.equal(afterValClear.roleModels?.validator?.model, undefined);
    assert.equal(afterValClear.roleModels?.validator?.thinkingLevel, "medium");
    assert.equal(orchestrator.getSnapshot().roleModels.validator?.model, undefined);
    assert.equal(orchestrator.getSnapshot().roleModels.validator?.thinkingLevel, "medium");

    // 2. Test WITH onRoleModelChanged wired (mirroring src/index.ts): must NOT clobber cleared model back to "default"!
    const toolsWithCallback = createOrchestratorTools({
      store,
      worktree,
      orchestrator,
      getActiveRunId: () => run.id,
      getSessionId: () => "sess-swarm-model",
      onRoleModelChanged: async (role, modelVal, thinking) => {
        const clearing = ["default", "clear", "reset", "none"].includes(modelVal.toLowerCase());
        const current = await store.loadRun(run.id);
        await store.updateRun(run.id, {
          roleModels: {
            ...(current.roleModels ?? {}),
            [role]: clearing
              ? { ...(thinking !== undefined ? { thinkingLevel: thinking } : {}) }
              : {
                  model: modelVal,
                  ...(thinking ?? current.roleModels?.[role]?.thinkingLevel
                    ? { thinkingLevel: thinking ?? current.roleModels?.[role]?.thinkingLevel }
                    : {}),
                },
          },
        });
      },
    });
    const modelToolWithCb = toolsWithCallback.find((t) => t.name === SWARM_MODEL_TOOL)!;

    await modelToolWithCb.execute(
      "m-cb-set",
      { target: "orchestrator", model: "anthropic/claude-opus-4", thinking_level: "high" },
      undefined,
      undefined,
      fakeCtx,
    );
    assert.equal((await store.loadRun(run.id)).roleModels?.orchestrator?.model, "anthropic/claude-opus-4");
    assert.equal((await store.loadRun(run.id)).roleModels?.orchestrator?.thinkingLevel, "high");

    await modelToolWithCb.execute(
      "m-cb-clear",
      { target: "orchestrator", model: "reset" },
      undefined,
      undefined,
      fakeCtx,
    );
    const finalRun = await store.loadRun(run.id);
    assert.equal(finalRun.roleModels?.orchestrator?.model, undefined, "Must NOT overwrite clear with 'reset'");
    assert.equal(finalRun.roleModels?.orchestrator?.thinkingLevel, undefined);
    assert.equal(orchestrator.getSnapshot().roleModels.orchestrator?.model, undefined);

    await orchestrator.dispose();
  });
});

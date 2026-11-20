import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FINAL_AUDIT_MISSION_ID,
  FINAL_VALIDATOR_BOARD_NAME,
  ORCHESTRATOR_BOARD_NAME,
  SWARM_BOARD_POST_TOOL,
  SWARM_BRANCH_PREFIX,
  SWARM_FINAL_VERDICT_TOOL,
  SWARM_LOG_TAIL_LIMIT,
  SWARM_MAX_BOARD_HOPS,
  SWARM_MAX_DIFF_BYTES,
  SWARM_PLAN_ADD_TOOL,
  SWARM_REVIEW_VERDICT_TOOL,
  SWARM_WORKER_DONE_TOOL,
} from "../constants.js";
import {
  type AgentTurnResult,
  type BoardMessage,
  type BoardMessageKind,
  type CallerRole,
  type FinalAuditVerdict,
  type FinalValidatorSpawnRequest,
  type ISwarmOrchestrator,
  type ISwarmStore,
  type ISwarmTransport,
  isSwarmProtocolError,
  type IWorktreeManager,
  type MergeBranchResult,
  type MissionPlanInput,
  type MissionRecord,
  type MissionReviewVerdict,
  type PersistentAgentHandle,
  type PostBoardMessageInput,
  type ReadBoardOptions,
  type ReadBoardResult,
  type RosterAgentRole,
  type RosterAgentStatus,
  type RosterEntry,
  type SafeTeardownResult,
  type SafeTeardownTarget,
  type SpawnMissionOptions,
  type SuggestedFixMission,
  type SwarmEvent,
  type SwarmFindingRecord,
  type SwarmOrchestratorEvent,
  type SwarmOrchestratorEventType,
  SwarmProtocolError,
  type SwarmRoleModels,
  type SwarmRunState,
  type SwarmSettings,
  type SwarmSnapshot,
  type ValidatorSpawnRequest,
  type WorkerSpawnRequest,
  type WorkerTelemetryEvent,
} from "../types.js";
import { RateLimitBreaker, selectFallbackModel } from "./rate-limit.js";
import {
  buildFinalValidatorSystemPrompt,
  buildFinalValidatorTaskPrompt,
  buildValidatorSystemPrompt,
  buildValidatorTaskPrompt,
  buildWorkerSystemPrompt,
  buildWorkerTaskPrompt,
  formatBoardExcerptLine,
} from "./role-prompts.js";
import { findOutOfScopeFiles, resolveRoleModel } from "./transport.js";

// ============================================================================
// Orchestrator Dependencies & Internal Types
// ============================================================================

export interface SwarmOrchestratorDeps {
  store: ISwarmStore;
  worktree: IWorktreeManager;
  transport: ISwarmTransport;
  getSettings: () => SwarmSettings;
  getHostContext: () => ExtensionContext | undefined;
  /** Optional clock override (primarily for deterministic tests). */
  now?: () => number;
  /** Optional RNG override for backoff jitter (primarily for deterministic tests). */
  random?: () => number;
}

type ActiveTurnKind = "mission" | "board_peer" | "validation" | "final_validation";

interface LiveAgentEntry {
  handle: PersistentAgentHandle;
  agentId: string;
  name: string;
  runId: string;
  missionId: string;
  role: RosterAgentRole;
  working: boolean;
  waking: boolean;
  switchingModel: boolean;
  killed: boolean;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  lastReadBoardSeq: number;
  deliveredBoardSeqs: Set<number>;
  turns: number;
  triedModels: Set<string>;
  pendingBoardWakes: BoardMessage[];
  startedAt: number;
}

const MENTION_FALLBACK_RE = /(?:^|[\s([{"'`,;:])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

function extractFallbackMentions(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  MENTION_FALLBACK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_FALLBACK_RE.exec(text)) !== null) {
    const handle = match[1];
    if (!handle) {
      continue;
    }
    const lower = handle.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(handle);
    }
  }
  return result;
}

function getEffectiveMentions(msg: BoardMessage): string[] {
  if (msg.mentions && msg.mentions.length > 0) {
    return msg.mentions;
  }
  return extractFallbackMentions(msg.text);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

function slugifyFixTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/**
 * Normalizes a suggested fix mission title into printable ASCII containing at
 * least one alphanumeric character and ensures its derived `feat/<slug>` branch
 * does not collide with `usedBranches`.
 */
function normalizeAsciiFixTitle(
  rawTitle: string,
  missionId: string,
  usedBranches: Set<string>,
): string {
  const cleaned = rawTitle
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const baseTitle = cleaned && /[A-Za-z0-9]/.test(cleaned) ? cleaned : `Fix ${missionId}`;

  let candidate = baseTitle;
  let slug = slugifyFixTitle(candidate);
  let branch = `${SWARM_BRANCH_PREFIX}${slug}`;
  if (!slug || usedBranches.has(branch)) {
    const idSuffix = missionId.toLowerCase();
    const maxPrefixLen = Math.max(8, 60 - idSuffix.length);
    candidate = `${baseTitle.slice(0, maxPrefixLen).trim()} ${missionId}`;
    slug = slugifyFixTitle(candidate);
    branch = `${SWARM_BRANCH_PREFIX}${slug}`;
    let counter = 2;
    while (!slug || usedBranches.has(branch)) {
      const numSuffix = `${idSuffix}-${counter}`;
      candidate = `${baseTitle.slice(0, Math.max(8, 60 - numSuffix.length)).trim()} ${missionId} ${counter}`;
      slug = slugifyFixTitle(candidate);
      branch = `${SWARM_BRANCH_PREFIX}${slug}`;
      counter += 1;
    }
  }
  usedBranches.add(branch);
  return candidate;
}

/**
 * Converts Final Validator `recommendedMissions` into normalized `MissionPlanInput[]`
 * with unique IDs (`F1`, `F2`, ...), printable ASCII titles, and `deps: []`.
 */
function buildAutoFixMissionPlans(
  run: SwarmRunState,
  recommended: readonly SuggestedFixMission[],
  existingBranches: readonly string[],
): MissionPlanInput[] {
  const usedIds = new Set<string>(Object.keys(run.missions));
  const usedBranches = new Set<string>([
    ...existingBranches,
    ...Object.values(run.missions).map((m) => m.branch),
  ]);

  let nextFixNum = 1;
  const allocateFixId = (): string => {
    while (usedIds.has(`F${nextFixNum}`)) {
      nextFixNum += 1;
    }
    const id = `F${nextFixNum}`;
    usedIds.add(id);
    nextFixNum += 1;
    return id;
  };

  return recommended.map((rec) => {
    const id = allocateFixId();
    const title = normalizeAsciiFixTitle(rec.title ?? "", id, usedBranches);
    const kind = rec.kind === "artifact" ? "artifact" : "build";
    const scope = Array.isArray(rec.scope)
      ? rec.scope.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const description = rec.description?.trim() || title;
    const verification =
      rec.verification?.trim() ||
      run.verificationContract.trim() ||
      "Verify fix and run project verification checks";
    const tasks = rec.tasks && rec.tasks.length > 0 ? rec.tasks : undefined;

    return {
      id,
      title,
      kind,
      description,
      scope,
      deps: [],
      verification,
      ...(tasks ? { tasks } : {}),
    };
  });
}

function formatValidationWakePrompt(
  mission: MissionRecord,
  verdict: MissionReviewVerdict,
  boardSeq: number,
): string {
  const lines: string[] = [
    `[Validation round ${verdict.round ?? mission.reviewRound} feedback — board #${boardSeq} from validator-${mission.id}]`,
    `Status: ${verdict.status} | Merge: ${verdict.merge} | Audited commit: ${verdict.commitSha.slice(0, 12)}`,
    `Decision: ${verdict.decision}`,
  ];

  if (verdict.findings.length > 0) {
    lines.push("", "Findings to fix:");
    for (const f of verdict.findings) {
      const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
      const sug = f.suggestion ? ` Suggestion: ${f.suggestion}` : "";
      lines.push(`- [${f.severity.toUpperCase()}] ${f.title}${loc}: ${f.detail}${sug}`);
    }
  }

  const failedChecks = verdict.checks.filter((c) => !c.passed);
  if (failedChecks.length > 0) {
    lines.push("", "Failed checks:");
    for (const c of failedChecks) {
      lines.push(`- [FAIL] ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    }
  }

  lines.push(
    "",
    `Address every P1/P2 finding and failed check on branch \`${mission.branch}\`, re-run verification, make a clean commit, and call \`${SWARM_WORKER_DONE_TOOL}\`.`,
  );

  return lines.join("\n");
}

function formatVerdictBoardPost(missionId: string, verdict: MissionReviewVerdict): string {
  const lines: string[] = [
    `@${missionId} [review r${verdict.round ?? 1}] ${verdict.status} (${verdict.merge}): ${verdict.decision}`,
  ];
  for (const f of verdict.findings.slice(0, 8)) {
    const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
    lines.push(`- [${f.severity.toUpperCase()}] ${f.title}${loc}: ${f.detail}`);
  }
  lines.push(`Please fix, commit cleanly, and call ${SWARM_WORKER_DONE_TOOL}.`);
  return lines.join("\n");
}

// ============================================================================
// SwarmOrchestrator
// ============================================================================

/**
 * Hybrid event-driven Pi Swarm orchestrator:
 * - Resolves 3-role models (`orchestrator`, `worker`, `validator`) + quota fallback switching.
 * - Routes shared message board `@mention` wakeups between warm persistent agents with loop protection.
 * - Runs warm peer-to-peer validation fix loops (waking the exact warm Worker with full context!).
 * - Serializes DAG scheduling (`tick`) and merges (`mergeMission`) with hard per-kind gates.
 * - Runs an independent read-only Run-Level Final Validator (`final-validator`) after merge.
 * - Auto-kills warm mission handles on merge/abandon so memory stays lean.
 * - Respects human sovereignty (human-stopped agents never auto-restart; artifacts require sign-off).
 */
export class SwarmOrchestrator implements ISwarmOrchestrator {
  private readonly store: ISwarmStore;
  private readonly worktree: IWorktreeManager;
  private readonly transport: ISwarmTransport;
  private readonly getSettings: () => SwarmSettings;
  private readonly getHostContext: () => ExtensionContext | undefined;
  private readonly now: () => number;
  private readonly rateLimitBreaker: RateLimitBreaker;

  private activeRunId: string | null = null;
  private cachedRun: SwarmRunState | null = null;
  private cachedRecentEvents: SwarmEvent[] = [];
  private cachedBoardHead = 0;
  private cachedRecentBoard: BoardMessage[] = [];
  private orchestratorReadBoardSeq = 0;
  private unreadOrchestratorMessages = 0;
  private lastHostContext?: ExtensionContext;

  /** All live (non-killed) persistent handles keyed by agentId (`working`, `waiting`, or `stopped`). */
  private readonly handles = new Map<string, LiveAgentEntry>();
  /** Case-insensitive board name (`m1`, `validator-m1`, `final-validator`) -> live agentId. */
  private readonly handleByName = new Map<string, string>();
  /** Warm worker handle per mission (`missionId -> agentId`). */
  private readonly workerHandleByMission = new Map<string, string>();
  /** Latest validator handle per mission (`missionId -> agentId`). */
  private readonly validatorHandleByMission = new Map<string, string>();
  /** Currently WORKING mission/audit agent (`missionId -> agentId`). */
  private readonly missionWorkingAgent = new Map<string, string>();

  private readonly humanStoppedAgents = new Set<string>();
  private readonly humanStoppedMissions = new Set<string>();
  private readonly pendingFixInstructions = new Map<string, string>();
  private readonly liveLogTails = new Map<string, string[]>();
  private readonly autoMergeInFlight = new Set<string>();
  private readonly autoMergeBlockedByMission = new Map<string, { tipSha: string; code: string }>();
  private readonly finalAuditHistory = new Map<string, FinalAuditVerdict[]>();
  private readonly listeners = new Set<(event: SwarmOrchestratorEvent) => void>();

  private peerBoardHopCount = 0;
  private boardHopWarningEmitted = false;

  private finalAuditBlockedSha: string | null = null;
  private finalAuditBlockedReason: string | null = null;
  private finalAuditRetryCount = 0;
  private finalAuditRetrySha: string | null = null;

  private tickChain: Promise<void> = Promise.resolve();
  private mergeChain: Promise<void> = Promise.resolve();
  private rosterWriteChain: Promise<void> = Promise.resolve();
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private agentCounter = 0;
  private disposed = false;

  constructor(deps: SwarmOrchestratorDeps) {
    this.store = deps.store;
    this.worktree = deps.worktree;
    this.transport = deps.transport;
    this.getSettings = deps.getSettings;
    this.getHostContext = deps.getHostContext;
    this.now = deps.now ?? (() => Date.now());

    const settings = this.getSettings();
    this.rateLimitBreaker = new RateLimitBreaker({
      baseBackoffMs: settings.rateLimitBaseBackoffMs,
      maxBackoffMs: settings.rateLimitMaxBackoffMs,
      now: this.now,
      random: deps.random,
    });
  }

  // ==========================================================================
  // Public Lifecycle & Scheduling API
  // ==========================================================================

  async startRun(runId: string, hostContext?: ExtensionContext): Promise<SwarmRunState> {
    if (hostContext) {
      this.lastHostContext = hostContext;
    }
    if (this.activeRunId !== runId) {
      this.resetPerRunTransientState();
    }
    this.activeRunId = runId;
    this.syncBreakerConfig();
    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      summary: `Attached and started Swarm run ${runId}`,
    });
    await this.tick(hostContext);
    return this.store.loadRun(runId);
  }

  async attachRun(runId: string | null, hostContext?: ExtensionContext): Promise<SwarmSnapshot> {
    if (hostContext) {
      this.lastHostContext = hostContext;
    }
    const switchedRun = this.activeRunId !== runId;
    if (switchedRun) {
      this.resetPerRunTransientState();
    }
    this.activeRunId = runId;
    if (!runId) {
      this.cachedRun = null;
      this.cachedRecentEvents = [];
      this.cachedBoardHead = 0;
      this.cachedRecentBoard = [];
      this.orchestratorReadBoardSeq = 0;
      this.unreadOrchestratorMessages = 0;
      this.emitEvent("snapshot_changed", {
        runId: null,
        summary: "Detached Swarm run",
      });
      return this.getSnapshot();
    }
    this.syncBreakerConfig();
    const run = await this.refreshState(runId);
    if (
      switchedRun &&
      run &&
      run.finalAuditStatus === "disapproved" &&
      run.lastAuditedSha
    ) {
      this.finalAuditBlockedSha = run.lastAuditedSha;
    }
    const snapshot = this.getSnapshot();
    this.emitEvent("snapshot_changed", {
      runId,
      summary: `Attached to Swarm run ${runId}`,
    });
    return snapshot;
  }

  async pause(runId?: string, reason?: string): Promise<SwarmRunState> {
    const targetRunId = this.requireRunId(runId);
    this.clearBackoffTimer();
    const updated = await this.store.updateRun(targetRunId, {
      status: "paused",
      actor: ORCHESTRATOR_BOARD_NAME,
    });
    await this.refreshState(targetRunId);
    this.emitEvent("snapshot_changed", {
      runId: targetRunId,
      summary: reason ? `Swarm run paused: ${reason}` : "Swarm run paused",
    });
    return updated;
  }

  async resume(runId?: string, hostContext?: ExtensionContext): Promise<SwarmRunState> {
    const targetRunId = this.requireRunId(runId);
    if (hostContext) {
      this.lastHostContext = hostContext;
    }
    this.autoMergeBlockedByMission.clear();
    this.clearFinalAuditBlockState();
    await this.store.updateRun(targetRunId, {
      status: "active",
      actor: ORCHESTRATOR_BOARD_NAME,
    });
    await this.refreshState(targetRunId);
    this.emitEvent("snapshot_changed", {
      runId: targetRunId,
      summary: "Swarm run resumed",
    });
    await this.tick(hostContext);
    return this.store.loadRun(targetRunId);
  }

  async tick(hostContext?: ExtensionContext): Promise<void> {
    if (hostContext) {
      this.lastHostContext = hostContext;
    }
    const next = this.tickChain.then(
      () => this.tickInternal(),
      () => this.tickInternal(),
    );
    this.tickChain = next.catch(() => {});
    return next;
  }

  private scheduleTick(): void {
    if (this.disposed) {
      return;
    }
    void this.tick().catch((err) => {
      this.emitEvent("error", {
        runId: this.activeRunId,
        summary: `Orchestrator tick failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }

  async spawnForMission(options: SpawnMissionOptions): Promise<PersistentAgentHandle> {
    const runId = this.requireRunId();
    if (options.hostContext) {
      this.lastHostContext = options.hostContext;
    }
    const run = await this.store.loadRun(runId);
    const mission = run.missions[options.missionId];
    if (!mission) {
      throw new SwarmProtocolError("NOT_FOUND", `Mission "${options.missionId}" not found.`);
    }
    if (mission.status === "merged" || mission.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Mission "${mission.id}" is already terminal (${mission.status}).`,
      );
    }
    if (this.missionWorkingAgent.has(mission.id)) {
      throw new SwarmProtocolError(
        "OWNERSHIP_CONFLICT",
        `Mission "${mission.id}" already has an active working agent (${this.missionWorkingAgent.get(mission.id)}).`,
      );
    }
    if ((mission.humanStopped || this.humanStoppedMissions.has(mission.id)) && !options.force) {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Mission "${mission.id}" was stopped by human. Use retryMission or pass force=true only on explicit user request.`,
      );
    }

    if (options.force && (mission.humanStopped || this.humanStoppedMissions.has(mission.id))) {
      this.humanStoppedMissions.delete(mission.id);
      await this.store.updateMission(runId, mission.id, {
        humanStopped: false,
        status: mission.worktreePath ? "active" : "planned",
        error: null,
        callerRole: "orchestrator",
        actor: ORCHESTRATOR_BOARD_NAME,
      });
    }

    const refreshedRun = await this.store.loadRun(runId);
    const refreshedMission = refreshedRun.missions[mission.id]!;
    const role: RosterAgentRole = options.role ?? "worker";
    if (role === "final-validator") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        "Final Validator is run-level; use runFinalAudit() instead of spawnForMission().",
      );
    }

    if (role === "validator") {
      if (refreshedMission.kind !== "build") {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Validators only audit "build" missions (got "${refreshedMission.kind}").`,
        );
      }
      if (refreshedMission.status !== "completed") {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Mission "${refreshedMission.id}" must be "completed" before spawning a validator (currently "${refreshedMission.status}").`,
        );
      }
      return this.launchValidator(refreshedRun, refreshedMission, undefined, {
        modelOverride: options.modelOverride,
        thinkingLevel: options.thinkingLevel,
      });
    }

    return this.launchWorker(refreshedRun, refreshedMission, {
      promptOverride: options.promptOverride,
      modelOverride: options.modelOverride,
      thinkingLevel: options.thinkingLevel,
    });
  }

  // ==========================================================================
  // Shared Message Board & Peer-to-Peer @mention Router
  // ==========================================================================

  async postToBoard(input: PostBoardMessageInput): Promise<BoardMessage> {
    const runId = this.requireRunId();
    const msg = await this.store.postBoardMessage(runId, input);
    this.recordBoardMessageInCache(msg);

    if (input.from.trim().toLowerCase() === ORCHESTRATOR_BOARD_NAME) {
      this.orchestratorReadBoardSeq = Math.max(this.orchestratorReadBoardSeq, msg.seq);
    }

    await this.routeBoardMessage(runId, msg, { routePeers: true });
    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      missionId: msg.missionId,
      summary: `Board #${msg.seq} from ${msg.from}: ${msg.text.slice(0, 80)}`,
    });
    return msg;
  }

  async readBoard(options?: ReadBoardOptions): Promise<ReadBoardResult> {
    const runId = this.requireRunId();
    const res = await this.store.readBoard(runId, options);
    this.cachedBoardHead = Math.max(this.cachedBoardHead, res.head);
    this.orchestratorReadBoardSeq = Math.max(this.orchestratorReadBoardSeq, res.head);
    this.recomputeUnreadOrchestratorCount();
    return res;
  }

  private async postBoardInternal(
    runId: string,
    input: PostBoardMessageInput,
    options: { routePeers?: boolean; suppressOrchestratorWakeup?: boolean } = {},
  ): Promise<BoardMessage> {
    const msg = await this.store.postBoardMessage(runId, input);
    this.recordBoardMessageInCache(msg);
    if (input.from.trim().toLowerCase() === ORCHESTRATOR_BOARD_NAME) {
      this.orchestratorReadBoardSeq = Math.max(this.orchestratorReadBoardSeq, msg.seq);
    }
    if (options.routePeers) {
      await this.routeBoardMessage(runId, msg, {
        routePeers: true,
        suppressOrchestratorWakeup: options.suppressOrchestratorWakeup,
      });
    }
    return msg;
  }

  private async handleSubagentBoardPost(runId: string, sender: LiveAgentEntry, msg: BoardMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.recordBoardMessageInCache(msg);
    sender.lastReadBoardSeq = Math.max(sender.lastReadBoardSeq, msg.seq);
    this.queueRosterUpdate(runId, sender.agentId, {
      lastReadBoardSeq: sender.lastReadBoardSeq,
      lastPostBoardSeq: msg.seq,
    });

    await this.routeBoardMessage(runId, msg, { routePeers: true });
    this.emitEvent("snapshot_changed", {
      runId,
      missionId: msg.missionId ?? sender.missionId,
      agentId: sender.agentId,
      summary: `Board #${msg.seq} from ${msg.from}: ${msg.text.slice(0, 80)}`,
    });
  }

  private async routeBoardMessage(
    runId: string,
    msg: BoardMessage,
    options: { routePeers: boolean; suppressOrchestratorWakeup?: boolean },
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    const mentions = getEffectiveMentions(msg);
    const lowerMentions = new Set(mentions.map((m) => m.toLowerCase()));
    const fromLower = msg.from.trim().toLowerCase();

    // Reset peer-to-peer cascade counter whenever orchestrator or human posts fresh guidance
    if (msg.fromRole === "orchestrator" || msg.fromRole === "human") {
      this.peerBoardHopCount = 0;
      this.boardHopWarningEmitted = false;
    }

    // Check @orchestrator wakeup
    const mentionsOrchestrator =
      lowerMentions.has(ORCHESTRATOR_BOARD_NAME) ||
      (lowerMentions.has("all") && fromLower !== ORCHESTRATOR_BOARD_NAME);
    if (mentionsOrchestrator && fromLower !== ORCHESTRATOR_BOARD_NAME) {
      if (msg.seq > this.orchestratorReadBoardSeq) {
        this.unreadOrchestratorMessages += 1;
      }
      if (!options.suppressOrchestratorWakeup && lowerMentions.has(ORCHESTRATOR_BOARD_NAME)) {
        this.emitEvent("wakeup_needed", {
          runId,
          missionId: msg.missionId,
          summary: `[Board #${msg.seq} from ${msg.from}] ${msg.text.slice(0, 180)}`,
        });
      }
    }

    if (!options.routePeers || lowerMentions.size === 0) {
      return;
    }

    // Resolve target live handles
    const targets: LiveAgentEntry[] = [];
    const seenIds = new Set<string>();
    const addCandidate = (entry: LiveAgentEntry | undefined): void => {
      if (!entry || seenIds.has(entry.agentId)) {
        return;
      }
      if (entry.runId !== runId) {
        return;
      }
      if (entry.name.toLowerCase() === fromLower || entry.agentId.toLowerCase() === fromLower) {
        return;
      }
      if (entry.killed || entry.handle.getState() === "killed") {
        return;
      }
      seenIds.add(entry.agentId);
      targets.push(entry);
    };

    if (lowerMentions.has("all")) {
      for (const entry of this.handles.values()) {
        addCandidate(entry);
      }
    }
    for (const mention of lowerMentions) {
      if (mention === "all" || mention === ORCHESTRATOR_BOARD_NAME) {
        continue;
      }
      const byNameId = this.handleByName.get(mention);
      if (byNameId) {
        addCandidate(this.handles.get(byNameId));
        continue;
      }
      // Also allow matching by exact agentId
      for (const entry of this.handles.values()) {
        if (entry.agentId.toLowerCase() === mention) {
          addCandidate(entry);
          break;
        }
      }
    }

    if (targets.length === 0) {
      return;
    }

    const run = await this.store.loadRun(runId).catch(() => this.cachedRun);
    const isPeerMessage = msg.fromRole === "worker" || msg.fromRole === "validator";

    for (const target of targets) {
      const rosterEntry = run?.roster[target.agentId];
      if (
        this.humanStoppedAgents.has(target.agentId) ||
        this.humanStoppedMissions.has(target.missionId) ||
        rosterEntry?.humanStopped
      ) {
        continue;
      }

      // Enforce SWARM_MAX_BOARD_HOPS cap on peer-to-peer wakeup cascades
      if (isPeerMessage) {
        if (this.peerBoardHopCount >= SWARM_MAX_BOARD_HOPS) {
          if (!this.boardHopWarningEmitted) {
            this.boardHopWarningEmitted = true;
            await this.postBoardInternal(
              runId,
              {
                from: ORCHESTRATOR_BOARD_NAME,
                fromRole: "orchestrator",
                kind: "stall",
                text: `[board-guard] Peer-to-peer @mention wakeup cap (${SWARM_MAX_BOARD_HOPS} hops) reached at #${msg.seq}; halting automatic peer wakeups to prevent infinite loop.`,
              },
              { routePeers: false },
            );
            this.emitEvent("wakeup_needed", {
              runId,
              summary: `Swarm board peer-to-peer hop cap (${SWARM_MAX_BOARD_HOPS}) reached at #${msg.seq} (${msg.from} -> @${target.name}). Inspect the board and intervene if needed.`,
            });
          }
          return;
        }
        this.peerBoardHopCount += 1;
      }

      if (target.deliveredBoardSeqs.has(msg.seq)) {
        continue;
      }

      const state = target.handle.getState();
      if (target.working || target.waking || target.switchingModel) {
        if (target.working && !target.waking && !target.switchingModel && state === "working") {
          // Actively executing turn: deliver via followUp so the agent sees it at the end of its current step
          const followUpText = `[Board #${msg.seq} from ${msg.from}] ${msg.text}`;
          target.deliveredBoardSeqs.add(msg.seq);
          target.lastReadBoardSeq = Math.max(target.lastReadBoardSeq, msg.seq);
          this.queueRosterUpdate(runId, target.agentId, {
            lastReadBoardSeq: target.lastReadBoardSeq,
          });
          void target.handle.followUp(followUpText).catch(() => {});
        } else if (!target.killed && state !== "killed") {
          // Mid-wake, mid-model-switch, or just parked in waiting while completion/wake setup is finishing:
          // queue so dispatchBoardWakeForTarget or drainPendingBoardWakes absorbs & delivers it without dropping!
          if (!target.pendingBoardWakes.some((queued) => queued.seq === msg.seq)) {
            target.pendingBoardWakes.push(msg);
          }
        }
        continue;
      }

      if (state === "waiting") {
        if (this.rateLimitBreaker.isBackedOff()) {
          continue;
        }
        // Synchronously reserve waking state BEFORE awaiting readBoard/updateRoster to prevent duplicate wakes!
        target.waking = true;
        await this.dispatchBoardWakeForTarget(runId, target, msg);
      }
    }
  }

  private async dispatchBoardWakeForTarget(
    runId: string,
    target: LiveAgentEntry,
    triggerMsg: BoardMessage,
  ): Promise<void> {
    const queueUndelivered = (messages: readonly BoardMessage[]): void => {
      if (this.disposed || target.killed || target.handle.getState() === "killed") {
        return;
      }
      for (const m of messages) {
        if (
          !target.deliveredBoardSeqs.has(m.seq) &&
          !target.pendingBoardWakes.some((queued) => queued.seq === m.seq)
        ) {
          target.pendingBoardWakes.push(m);
        }
      }
    };

    try {
      if (
        this.disposed ||
        target.killed ||
        target.handle.getState() === "killed" ||
        this.humanStoppedAgents.has(target.agentId) ||
        this.humanStoppedMissions.has(target.missionId)
      ) {
        return;
      }
      if (this.rateLimitBreaker.isBackedOff()) {
        return;
      }
      if (target.working || target.switchingModel || target.handle.getState() !== "waiting") {
        queueUndelivered([triggerMsg]);
        return;
      }

      const unreadRes = await this.store
        .readBoard(runId, { since: target.lastReadBoardSeq, limit: 20 })
        .catch(() => ({ messages: [triggerMsg], head: triggerMsg.seq }));

      // Absorb any concurrent @mentions that arrived in pendingBoardWakes while awaiting readBoard!
      const extraQueued = target.pendingBoardWakes.splice(0, target.pendingBoardWakes.length);
      const mergedBySeq = new Map<number, BoardMessage>();
      for (const m of unreadRes.messages) {
        if (!target.deliveredBoardSeqs.has(m.seq)) {
          mergedBySeq.set(m.seq, m);
        }
      }
      if (!target.deliveredBoardSeqs.has(triggerMsg.seq)) {
        mergedBySeq.set(triggerMsg.seq, triggerMsg);
      }
      for (const m of extraQueued) {
        if (!target.deliveredBoardSeqs.has(m.seq)) {
          mergedBySeq.set(m.seq, m);
        }
      }

      const batchMessages = Array.from(mergedBySeq.values()).sort((a, b) => a.seq - b.seq);
      if (batchMessages.length === 0) {
        return;
      }

      const latestTrigger = batchMessages[batchMessages.length - 1] ?? triggerMsg;
      const maxBoardSeq = Math.max(
        unreadRes.head,
        triggerMsg.seq,
        ...batchMessages.map((m) => m.seq),
      );
      const deltaLines = batchMessages.map((m) => formatBoardExcerptLine(m, 400)).join("\n");

      const wakePrompt = [
        `[Board wakeup #${latestTrigger.seq} from ${latestTrigger.from}]`,
        "Unread board messages since your last turn:",
        deltaLines,
        "",
        `Respond concisely using \`${SWARM_BOARD_POST_TOOL}\` (address \`@${latestTrigger.from}\` if replying; refer to earlier posts as #seq). If this requires branch edits, apply & commit cleanly and call \`${SWARM_WORKER_DONE_TOOL}\`.`,
      ].join("\n");

      // Re-check right before waking in case another path changed state while awaiting readBoard
      if (
        this.disposed ||
        target.killed ||
        target.handle.getState() === "killed" ||
        this.humanStoppedAgents.has(target.agentId) ||
        this.humanStoppedMissions.has(target.missionId)
      ) {
        return;
      }
      const currentState = target.handle.getState();
      if (target.working || target.switchingModel || currentState !== "waiting") {
        if (currentState === "working" && !target.switchingModel) {
          for (const m of batchMessages) {
            target.deliveredBoardSeqs.add(m.seq);
            target.lastReadBoardSeq = Math.max(target.lastReadBoardSeq, m.seq);
            void target.handle.followUp(`[Board #${m.seq} from ${m.from}] ${m.text}`).catch(() => {});
          }
          this.queueRosterUpdate(runId, target.agentId, {
            lastReadBoardSeq: target.lastReadBoardSeq,
          });
        } else {
          queueUndelivered(batchMessages);
        }
        return;
      }

      // Mark delivered BEFORE calling wakeAgent so concurrent routeBoardMessage coroutines don't duplicate
      const newlyMarkedSeqs: number[] = [];
      for (const m of batchMessages) {
        if (!target.deliveredBoardSeqs.has(m.seq)) {
          target.deliveredBoardSeqs.add(m.seq);
          newlyMarkedSeqs.push(m.seq);
        }
      }

      // wakeAgent synchronously sets target.working = true and target.waking = false before its first await
      void this.wakeAgent(runId, target, wakePrompt, {
        turnKind: "board_peer",
        reason: `board #${latestTrigger.seq} from ${latestTrigger.from}`,
        boardHead: maxBoardSeq,
        actor: latestTrigger.from,
      }).catch((err) => {
        if (!target.killed) {
          for (const seq of newlyMarkedSeqs) {
            target.deliveredBoardSeqs.delete(seq);
          }
        }
        if (isSwarmProtocolError(err) && err.code === "AGENT_KILLED") {
          return;
        }
        this.emitEvent("error", {
          runId,
          missionId: target.missionId,
          agentId: target.agentId,
          summary: `Failed to wake ${target.name} on board #${latestTrigger.seq}: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    } finally {
      target.waking = false;
    }
  }

  private drainPendingBoardWakes(runId: string, entry: LiveAgentEntry): void {
    if (
      this.disposed ||
      entry.killed ||
      entry.working ||
      entry.waking ||
      entry.switchingModel ||
      entry.pendingBoardWakes.length === 0 ||
      entry.handle.getState() !== "waiting" ||
      this.rateLimitBreaker.isBackedOff() ||
      this.humanStoppedAgents.has(entry.agentId) ||
      this.humanStoppedMissions.has(entry.missionId)
    ) {
      return;
    }
    const undelivered = entry.pendingBoardWakes.filter((m) => !entry.deliveredBoardSeqs.has(m.seq));
    entry.pendingBoardWakes.length = 0;
    if (undelivered.length === 0) {
      return;
    }
    // Keep all undelivered messages in pendingBoardWakes except latest so dispatchBoardWakeForTarget merges the full batch
    const latest = undelivered.pop()!;
    if (undelivered.length > 0) {
      entry.pendingBoardWakes.push(...undelivered);
    }
    entry.waking = true;
    void this.dispatchBoardWakeForTarget(runId, entry, latest);
  }

  private async wakeAgent(
    runId: string,
    entry: LiveAgentEntry,
    prompt: string,
    options: {
      turnKind: ActiveTurnKind;
      reason: string;
      boardHead?: number;
      actor?: string;
      reviewedSha?: string;
      finalAuditSha?: string;
      finalAuditRound?: number;
    },
  ): Promise<void> {
    if (entry.killed || entry.handle.getState() === "killed") {
      throw new SwarmProtocolError(
        "AGENT_KILLED",
        `Agent "${entry.name}" (${entry.agentId}) has been killed and cannot be woken.`,
      );
    }
    const currentState = entry.handle.getState();
    if (entry.working || entry.switchingModel || currentState !== "waiting") {
      throw new SwarmProtocolError(
        "AGENT_NOT_WAITING",
        `Agent "${entry.name}" (${entry.agentId}) is not waiting (currently "${entry.switchingModel ? "switchingModel" : entry.working ? "working" : currentState}").`,
      );
    }

    // Reserve working state synchronously BEFORE any await to eliminate double-wake races!
    entry.working = true;
    entry.waking = false;
    entry.turns += 1;
    if (options.boardHead !== undefined) {
      entry.lastReadBoardSeq = Math.max(entry.lastReadBoardSeq, options.boardHead);
    }
    if (options.turnKind !== "board_peer" || !this.missionWorkingAgent.has(entry.missionId)) {
      this.missionWorkingAgent.set(entry.missionId, entry.agentId);
    }

    const wakeBoardCursor = entry.lastReadBoardSeq;
    const wakeTurn = entry.turns;

    try {
      await this.store.updateRoster(runId, entry.agentId, {
        status: "working",
        turns: wakeTurn,
        lastReadBoardSeq: wakeBoardCursor,
        endedAt: null,
        currentActivity: `woken: ${options.reason}`,
        error: null,
      });

      if (this.disposed || entry.killed || entry.handle.getState() === "killed") {
        // Ensure a concurrent killAgent() roster status isn't overwritten back to "working"
        if (!this.disposed && entry.killed) {
          await this.store
            .updateRoster(runId, entry.agentId, {
              status: "killed",
              endedAt: new Date(this.now()).toISOString(),
            })
            .catch(() => {});
        }
        throw new SwarmProtocolError(
          "AGENT_KILLED",
          `Agent "${entry.name}" (${entry.agentId}) was killed before wake prompt could be delivered.`,
        );
      }

      await this.store.appendEvent({
        runId,
        type: "agent_woken",
        actor: options.actor ?? ORCHESTRATOR_BOARD_NAME,
        missionId: entry.missionId,
        agentId: entry.agentId,
        summary: `Woke ${entry.name} (turn ${wakeTurn}): ${options.reason}`,
        data: {
          name: entry.name,
          turn: wakeTurn,
          turnKind: options.turnKind,
          boardHead: wakeBoardCursor,
        },
      });

      await this.refreshState(runId);

      // Re-check after store awaits in case killAgent()/stopAgent()/dispose() raced in!
      if (this.disposed || entry.killed || entry.handle.getState() === "killed") {
        throw new SwarmProtocolError(
          "AGENT_KILLED",
          `Agent "${entry.name}" (${entry.agentId}) was killed before wake prompt could be delivered.`,
        );
      }
      if (
        this.humanStoppedAgents.has(entry.agentId) ||
        this.humanStoppedMissions.has(entry.missionId) ||
        entry.handle.getState() !== "waiting"
      ) {
        throw new SwarmProtocolError(
          "AGENT_NOT_WAITING",
          `Agent "${entry.name}" (${entry.agentId}) is no longer waiting (currently "${entry.handle.getState()}").`,
        );
      }

      this.emitEvent("snapshot_changed", {
        runId,
        missionId: entry.missionId,
        agentId: entry.agentId,
        summary: `Woke ${entry.name} (${options.reason})`,
      });

      const turnPromise = entry.handle.wake(prompt);
      this.attachTurnCompletionHandler(runId, entry, turnPromise, {
        turnKind: options.turnKind,
        reviewedSha: options.reviewedSha,
        finalAuditSha: options.finalAuditSha,
        finalAuditRound: options.finalAuditRound,
      });
    } catch (err) {
      entry.working = false;
      if (this.missionWorkingAgent.get(entry.missionId) === entry.agentId) {
        this.missionWorkingAgent.delete(entry.missionId);
      }
      throw err;
    }
  }

  // ==========================================================================
  // Mid-Flight Control, Hot Model Switching & Kill API
  // ==========================================================================

  async switchAgentModel(
    agentNameOrId: string,
    modelOverride: string,
    thinkingLevel?: ThinkingLevel,
  ): Promise<RosterEntry> {
    const runId = this.requireRunId();
    const run = await this.store.loadRun(runId);
    const resolved = this.resolveTarget(run, agentNameOrId);

    if (!resolved.live) {
      if (resolved.agentId && run.roster[resolved.agentId]) {
        const roster = run.roster[resolved.agentId]!;
        if (roster.status === "killed") {
          throw new SwarmProtocolError(
            "AGENT_KILLED",
            `Agent "${roster.name}" (${roster.agentId}) has been killed and cannot switch models.`,
          );
        }
        throw new SwarmProtocolError(
          "AGENT_KILLED",
          `Agent "${roster.name}" (${roster.agentId}) has no live persistent session.`,
        );
      }
      throw new SwarmProtocolError(
        "NOT_FOUND",
        `No agent found matching "${agentNameOrId}".`,
      );
    }

    const entry = resolved.live;
    const state = entry.handle.getState();
    if (entry.killed || state === "killed") {
      throw new SwarmProtocolError(
        "AGENT_KILLED",
        `Agent "${entry.name}" (${entry.agentId}) has been killed and cannot switch models.`,
      );
    }
    if (entry.working || entry.waking || entry.switchingModel || state !== "waiting") {
      throw new SwarmProtocolError(
        "AGENT_NOT_WAITING",
        `Agent "${entry.name}" (${entry.agentId}) is not in waiting state (currently "${entry.switchingModel ? "switchingModel" : entry.waking ? "waking" : entry.working ? "working" : state}"). Wait until it parks in waiting state before switching models.`,
      );
    }

    entry.switchingModel = true;
    try {
      const prevModel = entry.model ?? entry.handle.getModel() ?? run.roster[entry.agentId]?.model;
      const switched = await entry.handle.switchModel(modelOverride, thinkingLevel);
      if (this.disposed || entry.killed || entry.handle.getState() === "killed") {
        throw new SwarmProtocolError(
          "AGENT_KILLED",
          `Agent "${entry.name}" (${entry.agentId}) was killed while switching models.`,
        );
      }
      entry.model = switched.model;
      if (switched.thinkingLevel !== undefined) {
        entry.thinkingLevel = switched.thinkingLevel;
      }
      entry.triedModels.add(modelOverride.trim());
      entry.triedModels.add(switched.model);

      const updatedRun = await this.store.updateRoster(runId, entry.agentId, {
        model: switched.model,
        ...(switched.thinkingLevel !== undefined ? { thinkingLevel: switched.thinkingLevel } : {}),
        currentActivity: `model switched -> ${switched.model}`,
      });

      await this.store.appendEvent({
        runId,
        type: "agent_model_switched",
        actor: ORCHESTRATOR_BOARD_NAME,
        missionId: entry.missionId,
        agentId: entry.agentId,
        summary: `Switched ${entry.name} model ${prevModel ?? "default"} -> ${switched.model}`,
        data: {
          name: entry.name,
          fromModel: prevModel,
          toModel: switched.model,
          thinkingLevel: switched.thinkingLevel,
        },
      });

      await this.postBoardInternal(
        runId,
        {
          from: ORCHESTRATOR_BOARD_NAME,
          fromRole: "orchestrator",
          kind: "model_switch",
          missionId: entry.missionId !== FINAL_AUDIT_MISSION_ID ? entry.missionId : undefined,
          text: `[model] ${entry.name} switched to ${switched.model}${switched.thinkingLevel ? ` (${switched.thinkingLevel})` : ""}`,
        },
        { routePeers: false },
      );

      await this.refreshState(runId);
      this.emitEvent("snapshot_changed", {
        runId,
        missionId: entry.missionId,
        agentId: entry.agentId,
        summary: `Switched ${entry.name} to model ${switched.model}`,
      });

      return updatedRun.roster[entry.agentId]!;
    } finally {
      entry.switchingModel = false;
      this.drainPendingBoardWakes(runId, entry);
    }
  }

  async steerAgent(
    agentNameOrId: string,
    message: string,
    mode: "steer" | "followUp" = "steer",
  ): Promise<void> {
    const runId = this.requireRunId();
    const run = await this.store.loadRun(runId);
    const resolved = this.resolveTarget(run, agentNameOrId);

    const rawRecipient = resolved.agentId ?? resolved.missionId ?? agentNameOrId;
    const recipient = rawRecipient === FINAL_AUDIT_MISSION_ID ? FINAL_VALIDATOR_BOARD_NAME : rawRecipient;
    await this.store.sendMessage(runId, {
      from: ORCHESTRATOR_BOARD_NAME,
      to: recipient,
      missionId: resolved.missionId,
      text: message,
    });

    await this.store.appendEvent({
      runId,
      type: "worker_steered",
      actor: ORCHESTRATOR_BOARD_NAME,
      missionId: resolved.missionId,
      agentId: resolved.agentId,
      summary: `Sent ${mode} message to ${resolved.live?.name ?? recipient}: ${message.slice(0, 100)}`,
    });

    if (resolved.live && !resolved.live.killed) {
      const state = resolved.live.handle.getState();
      if (resolved.live.working || state === "working") {
        if (mode === "followUp") {
          await resolved.live.handle.followUp(message);
        } else {
          await resolved.live.handle.steer(message);
        }
      } else if (!resolved.live.waking && !resolved.live.switchingModel && state === "waiting") {
        const mission = resolved.missionId ? run.missions[resolved.missionId] : undefined;
        const turnKind: ActiveTurnKind =
          resolved.live.role === "worker" && mission && mission.status === "active"
            ? "mission"
            : "board_peer";
        await this.wakeAgent(runId, resolved.live, `[Orchestrator guidance] ${message}`, {
          turnKind,
          reason: `steered by ${ORCHESTRATOR_BOARD_NAME}`,
          boardHead: this.cachedBoardHead,
          actor: ORCHESTRATOR_BOARD_NAME,
        });
      }
    }

    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      missionId: resolved.missionId,
      agentId: resolved.agentId,
      summary: `Steered ${resolved.live?.name ?? recipient}`,
    });
  }

  async stopAgent(
    agentNameOrId: string,
    options?: { humanStopped?: boolean; reason?: string },
  ): Promise<void> {
    const runId = this.requireRunId();
    const humanStopped = options?.humanStopped ?? true;
    const reason = options?.reason ?? (humanStopped ? "Stopped by user" : "Stopped by orchestrator");
    const run = await this.store.loadRun(runId);
    const resolved = this.resolveTarget(run, agentNameOrId);

    if (!resolved.live && !resolved.missionId && !resolved.agentId) {
      throw new SwarmProtocolError("NOT_FOUND", `No agent or mission found matching "${agentNameOrId}".`);
    }

    // Mark human-stopped BEFORE aborting so async completion handler sees it immediately!
    if (humanStopped) {
      if (resolved.agentId) {
        this.humanStoppedAgents.add(resolved.agentId);
      }
      if (resolved.missionId) {
        this.humanStoppedMissions.add(resolved.missionId);
      }
    }

    if (resolved.missionId === FINAL_AUDIT_MISSION_ID) {
      if (humanStopped) {
        const currentSha = await this.worktree.getHeadSha(this.worktree.repoRoot).catch(() => null);
        if (currentSha) {
          this.finalAuditBlockedSha = currentSha;
        }
      }
      if (run.status === "verifying" || run.finalAuditStatus === "running") {
        await this.store.updateRun(runId, {
          status: "active",
          finalAuditStatus: run.latestFinalAudit ? run.latestFinalAudit.verdict : "idle",
          actor: humanStopped ? "human" : ORCHESTRATOR_BOARD_NAME,
        });
      }
    } else if (resolved.missionId) {
      const mission = run.missions[resolved.missionId];
      if (mission && mission.status !== "merged" && mission.status !== "abandoned") {
        await this.store.updateMission(runId, resolved.missionId, {
          status: "stopped",
          humanStopped,
          error: reason,
          callerRole: humanStopped ? "human" : "orchestrator",
          actor: humanStopped ? "human" : ORCHESTRATOR_BOARD_NAME,
        });
      }
    }

    if (resolved.agentId && run.roster[resolved.agentId]) {
      await this.store.updateRoster(runId, resolved.agentId, {
        status: "stopped",
        humanStopped,
        endedAt: new Date(this.now()).toISOString(),
        currentActivity: reason,
      });
    }

    if (resolved.live) {
      const entry = resolved.live;
      entry.working = false;
      entry.waking = false;
      entry.pendingBoardWakes.length = 0;
      if (this.missionWorkingAgent.get(entry.missionId) === entry.agentId) {
        this.missionWorkingAgent.delete(entry.missionId);
      }
      await entry.handle.abort(reason);
      await Promise.race([
        entry.handle.currentTurn.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 200)),
      ]);
    }

    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      missionId: resolved.missionId,
      agentId: resolved.agentId,
      summary: `Stopped ${resolved.live?.name ?? resolved.agentId ?? resolved.missionId}`,
    });
  }

  async killAgent(agentNameOrId: string, reason?: string): Promise<void> {
    const runId = this.requireRunId();
    const run = await this.store.loadRun(runId);
    const resolved = this.resolveTarget(run, agentNameOrId);

    if (!resolved.live && !resolved.agentId) {
      throw new SwarmProtocolError("NOT_FOUND", `No agent found matching "${agentNameOrId}".`);
    }

    const killReason = reason?.trim() || "Killed by orchestrator";

    if (resolved.live) {
      const entry = resolved.live;
      entry.killed = true;
      entry.working = false;
      entry.waking = false;
      entry.switchingModel = false;
      entry.pendingBoardWakes.length = 0;
      this.unregisterHandle(entry);
      await entry.handle.kill(killReason);
    }

    const targetAgentId = resolved.live?.agentId ?? resolved.agentId;
    if (targetAgentId && run.roster[targetAgentId] && run.roster[targetAgentId]!.status !== "killed") {
      await this.store.updateRoster(runId, targetAgentId, {
        status: "killed",
        endedAt: new Date(this.now()).toISOString(),
        currentActivity: killReason,
      });
    }

    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      missionId: resolved.missionId,
      agentId: targetAgentId,
      summary: `Killed ${resolved.live?.name ?? targetAgentId}: ${killReason}`,
    });
  }

  private async killMissionHandles(runId: string, missionId: string, reason: string): Promise<void> {
    const toKill = Array.from(this.handles.values()).filter(
      (entry) => entry.runId === runId && entry.missionId === missionId && !entry.killed,
    );
    for (const entry of toKill) {
      entry.killed = true;
      entry.working = false;
      entry.waking = false;
      entry.switchingModel = false;
      entry.pendingBoardWakes.length = 0;
      this.unregisterHandle(entry);
      try {
        await entry.handle.kill(reason);
      } catch {
        // best-effort cleanup
      }
      try {
        await this.store.updateRoster(runId, entry.agentId, {
          status: "killed",
          endedAt: new Date(this.now()).toISOString(),
          currentActivity: reason,
        });
      } catch {
        // best-effort roster update
      }
    }
  }

  private async killHandleEntry(runId: string, entry: LiveAgentEntry, reason: string): Promise<void> {
    if (entry.killed) {
      this.unregisterHandle(entry);
      return;
    }
    entry.killed = true;
    entry.working = false;
    entry.waking = false;
    entry.switchingModel = false;
    entry.pendingBoardWakes.length = 0;
    this.unregisterHandle(entry);
    try {
      await entry.handle.kill(reason);
    } catch {
      // best-effort cleanup
    }
    try {
      await this.store.updateRoster(runId, entry.agentId, {
        status: "killed",
        endedAt: new Date(this.now()).toISOString(),
        currentActivity: reason,
      });
    } catch {
      // best-effort roster update
    }
  }

  async retryMission(
    missionId: string,
    options?: { reason?: string; hostContext?: ExtensionContext },
  ): Promise<SwarmRunState> {
    const runId = this.requireRunId();
    if (options?.hostContext) {
      this.lastHostContext = options.hostContext;
    }
    const run = await this.store.loadRun(runId);
    const mission = run.missions[missionId];
    if (!mission) {
      throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);
    }
    if (mission.status === "merged" || mission.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Cannot retry terminal mission "${missionId}" (${mission.status}).`,
      );
    }
    if (this.missionWorkingAgent.has(missionId)) {
      throw new SwarmProtocolError(
        "OWNERSHIP_CONFLICT",
        `Mission "${missionId}" already has an active working agent.`,
      );
    }

    // Kill any stale stopped/failed handles for this mission so retry launches fresh cleanly
    await this.killMissionHandles(runId, missionId, "Killed before mission retry");

    this.humanStoppedMissions.delete(missionId);
    this.autoMergeBlockedByMission.delete(missionId);
    if (options?.reason?.trim()) {
      const existing = this.pendingFixInstructions.get(missionId);
      this.pendingFixInstructions.set(
        missionId,
        existing
          ? `${existing}\n\nAdditional retry guidance: ${options.reason.trim()}`
          : options.reason.trim(),
      );
    }

    const hasRunBefore =
      Object.values(run.roster).some((r) => r.missionId === missionId) ||
      mission.retryCount > 0 ||
      mission.reviewRound > 0;
    const nextStatus =
      mission.status === "completed"
        ? "completed"
        : hasRunBefore
          ? "active"
          : "planned";

    await this.store.updateMission(runId, missionId, {
      status: nextStatus,
      humanStopped: false,
      retryCount: 0,
      error: null,
      callerRole: "orchestrator",
      actor: ORCHESTRATOR_BOARD_NAME,
    });

    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      missionId,
      summary: `Retrying mission ${missionId}`,
    });
    await this.tick(options?.hostContext);
    return this.store.loadRun(runId);
  }

  async approveArtifact(
    missionId: string,
    options?: { commitSha?: string; approvedBy?: string; autoMerge?: boolean },
  ): Promise<SwarmRunState> {
    const runId = this.requireRunId();
    const run = await this.store.loadRun(runId);
    const mission = run.missions[missionId];
    if (!mission) {
      throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);
    }
    if (mission.kind !== "artifact") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Mission "${missionId}" is kind "${mission.kind}"; human artifact approval only applies to "artifact" missions.`,
      );
    }
    if (mission.status !== "completed") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Artifact mission "${missionId}" must be "completed" before approval (currently "${mission.status}").`,
      );
    }

    const commitSha = options?.commitSha ?? (await this.worktree.getHeadSha(mission.worktreePath));
    const approvedBy = options?.approvedBy ?? "human";
    await this.store.approveArtifact(runId, missionId, commitSha, { approvedBy });
    this.autoMergeBlockedByMission.delete(missionId);

    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      missionId,
      summary: `Artifact ${missionId} approved at ${commitSha.slice(0, 12)}`,
    });

    const shouldAutoMerge = options?.autoMerge ?? this.getSettings().autoMergeClean;
    if (shouldAutoMerge) {
      await this.mergeMission(missionId, { callerRole: "human", actor: approvedBy });
    }

    return this.store.loadRun(runId);
  }

  // ==========================================================================
  // Strictly Serialized Merge Gate
  // ==========================================================================

  async mergeMission(
    missionId: string,
    options?: { callerRole?: CallerRole; actor?: string },
  ): Promise<MergeBranchResult | null> {
    const callerRole = options?.callerRole ?? "orchestrator";
    if (callerRole !== "orchestrator" && callerRole !== "human") {
      throw new SwarmProtocolError(
        "ROLE_FORBIDDEN",
        `Caller role "${callerRole}" is forbidden from merging missions. Only orchestrator or human may merge.`,
      );
    }

    this.autoMergeBlockedByMission.delete(missionId);

    let result: MergeBranchResult | null = null;
    const queued = this.mergeChain.then(
      async () => {
        result = await this.mergeMissionInternal(missionId, {
          callerRole,
          actor: options?.actor ?? callerRole,
        });
      },
      async () => {
        result = await this.mergeMissionInternal(missionId, {
          callerRole,
          actor: options?.actor ?? callerRole,
        });
      },
    );
    this.mergeChain = queued.catch(() => {});
    await queued;
    return result;
  }

  private async mergeMissionInternal(
    missionId: string,
    options: { callerRole: CallerRole; actor: string },
  ): Promise<MergeBranchResult | null> {
    const runId = this.requireRunId();
    const run = await this.store.loadRun(runId);
    const mission = run.missions[missionId];
    if (!mission) {
      throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);
    }
    if (mission.status === "merged" || mission.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Mission "${missionId}" is already ${mission.status}.`,
      );
    }
    if (mission.status !== "completed") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Mission "${missionId}" must be "completed" before merge (currently "${mission.status}").`,
      );
    }
    if (this.missionWorkingAgent.has(missionId) || this.hasWorkingHandleForMission(missionId)) {
      throw new SwarmProtocolError(
        "OWNERSHIP_CONFLICT",
        `Cannot merge mission "${missionId}" while agent ${this.missionWorkingAgent.get(missionId) ?? "handle"} is still working.`,
      );
    }

    // ------------------------------------------------------------------------
    // Case 1: survey (zero-diff closure)
    // ------------------------------------------------------------------------
    if (mission.kind === "survey") {
      if (mission.worktreePath) {
        const dirty = await this.worktree.isWorktreeDirty(mission.worktreePath);
        const commitsAhead = await this.worktree.getCommitCountAhead(
          run.baseBranch,
          mission.branch,
          mission.worktreePath,
        );
        const changedFiles = await this.worktree.getChangedFiles(
          run.baseBranch,
          mission.branch,
          mission.worktreePath,
        );
        if (dirty || commitsAhead > 0 || changedFiles.length > 0) {
          await this.store.appendEvent({
            runId,
            type: "merge_rejected",
            actor: options.actor,
            missionId,
            summary: `Rejected survey closure for ${missionId}: non-zero diff detected`,
            data: { dirty, commitsAhead, changedFiles },
          });
          throw new SwarmProtocolError(
            "SURVEY_HAS_DIFF",
            `Survey mission "${missionId}" must produce zero git diff (dirty=${dirty}, commitsAhead=${commitsAhead}, changedFiles=${changedFiles.length}).`,
            { dirty, commitsAhead, changedFiles },
          );
        }
      }

      await this.store.appendEvent({
        runId,
        type: "merge_started",
        actor: options.actor,
        missionId,
        summary: `Closing zero-diff survey mission ${missionId}`,
      });
      await this.store.markMerged(runId, missionId, null, {
        callerRole: options.callerRole,
        actor: options.actor,
      });
      this.finalAuditBlockedSha = null;
      this.finalAuditBlockedReason = null;

      // Auto-kill warm handles for closed survey mission to keep memory lean
      await this.killMissionHandles(runId, missionId, `Survey ${missionId} closed`);

      await this.refreshState(runId);
      this.emitEvent("snapshot_changed", {
        runId,
        missionId,
        summary: `Survey ${missionId} closed; scheduling downstream waves`,
      });
      this.scheduleTick();
      return null;
    }

    // ------------------------------------------------------------------------
    // Case 2: build | artifact (strict git & gate verification)
    // ------------------------------------------------------------------------
    const dirty = await this.worktree.isWorktreeDirty(mission.worktreePath);
    if (dirty) {
      await this.recordMergeRejection(runId, missionId, options.actor, "DIRTY_WORKTREE", "Worktree has uncommitted changes.");
      throw new SwarmProtocolError(
        "DIRTY_WORKTREE",
        `Mission "${missionId}" worktree "${mission.worktreePath}" has uncommitted changes.`,
      );
    }

    const commitsAhead = await this.worktree.getCommitCountAhead(
      run.baseBranch,
      mission.branch,
      mission.worktreePath,
    );
    if (commitsAhead < 1) {
      await this.recordMergeRejection(
        runId,
        missionId,
        options.actor,
        "INVALID_TRANSITION",
        "Branch has zero commits ahead of base branch.",
      );
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Mission "${missionId}" branch "${mission.branch}" has no commits ahead of "${run.baseBranch}".`,
      );
    }

    const changedFiles = await this.worktree.getChangedFiles(
      run.baseBranch,
      mission.branch,
      mission.worktreePath,
    );
    const outOfScope = findOutOfScopeFiles(changedFiles, mission.scope);
    if (outOfScope.length > 0) {
      await this.recordMergeRejection(
        runId,
        missionId,
        options.actor,
        "SCOPE_VIOLATION",
        `Changed files outside scope: ${outOfScope.join(", ")}`,
      );
      throw new SwarmProtocolError(
        "SCOPE_VIOLATION",
        `Mission "${missionId}" modified files outside declared scope [${mission.scope.join(", ")}]: ${outOfScope.join(", ")}`,
        { outOfScope, scope: mission.scope },
      );
    }

    const tipSha = await this.worktree.getHeadSha(mission.worktreePath);

    if (mission.kind === "build" && run.validatorEnabled) {
      const review = mission.latestReview;
      if (!review) {
        await this.recordMergeRejection(
          runId,
          missionId,
          options.actor,
          "REVIEW_REQUIRED",
          "No independent validation recorded.",
        );
        throw new SwarmProtocolError(
          "REVIEW_REQUIRED",
          `Build mission "${missionId}" requires a clean independent validation before merge.`,
        );
      }
      if (review.commitSha !== tipSha) {
        await this.recordMergeRejection(
          runId,
          missionId,
          options.actor,
          "STALE_REVIEW",
          `Latest validation covers ${review.commitSha}, but branch tip is ${tipSha}.`,
        );
        throw new SwarmProtocolError(
          "STALE_REVIEW",
          `Validation for "${missionId}" is pinned to ${review.commitSha}, which does not match current tip ${tipSha}. Re-validation is required.`,
          { reviewedSha: review.commitSha, currentSha: tipSha },
        );
      }
      if (review.status !== "clean" || review.merge !== "merge") {
        await this.recordMergeRejection(
          runId,
          missionId,
          options.actor,
          "REVIEW_REQUIRED",
          `Validation verdict is ${review.status} (${review.merge}); clean merge verdict required.`,
        );
        throw new SwarmProtocolError(
          "REVIEW_REQUIRED",
          `Build mission "${missionId}" latest validation is ${review.status} (${review.merge}); a clean "merge" verdict is required.`,
          { status: review.status, merge: review.merge },
        );
      }
    }

    if (mission.kind === "artifact") {
      if (!mission.humanApprovedSha || mission.humanApprovedSha !== tipSha) {
        await this.recordMergeRejection(
          runId,
          missionId,
          options.actor,
          "ARTIFACT_UNAPPROVED",
          `Artifact requires explicit human approval for tip ${tipSha}.`,
        );
        throw new SwarmProtocolError(
          "ARTIFACT_UNAPPROVED",
          `Artifact mission "${missionId}" at ${tipSha} requires explicit human approval (/swarm approve ${missionId}) before merge.`,
          { approvedSha: mission.humanApprovedSha, currentSha: tipSha },
        );
      }
    }

    // Verify main checkout is clean and on baseBranch
    const baseCheck = await this.worktree.isBaseCleanOnBranch(run.baseBranch);
    if (!baseCheck.ok) {
      const code = baseCheck.dirty ? "DIRTY_BASE" : "WRONG_BRANCH";
      const message =
        baseCheck.reason ??
        (baseCheck.dirty
          ? `Base repo checkout has uncommitted changes on "${baseCheck.currentBranch}".`
          : `Base repo checkout is on "${baseCheck.currentBranch}", expected "${run.baseBranch}".`);
      await this.recordMergeRejection(runId, missionId, options.actor, code, message);
      throw new SwarmProtocolError(code, message, {
        currentBranch: baseCheck.currentBranch,
        expectedBranch: run.baseBranch,
        dirty: baseCheck.dirty,
      });
    }

    await this.store.appendEvent({
      runId,
      type: "merge_started",
      actor: options.actor,
      missionId,
      summary: `Merging ${mission.branch} (${tipSha.slice(0, 12)}) into ${run.baseBranch}`,
      data: { branch: mission.branch, baseBranch: run.baseBranch, tipSha },
    });

    // Auto-rebase onto updated baseBranch if enabled
    const settings = this.getSettings();
    if (settings.autoRebase) {
      const rebaseRes = await this.worktree.autoRebase(mission.worktreePath, run.baseBranch);
      if (rebaseRes.status === "conflict") {
        const conflictFiles = rebaseRes.conflictFiles ?? [];
        const detail =
          rebaseRes.message ??
          `Rebase conflict merging "${mission.branch}" onto "${run.baseBranch}"${conflictFiles.length > 0 ? `: ${conflictFiles.join(", ")}` : ""}`;

        await this.store.appendEvent({
          runId,
          type: "merge_conflict",
          actor: options.actor,
          missionId,
          summary: detail,
          data: { conflictFiles, baseBranch: run.baseBranch, branch: mission.branch },
        });
        await this.store.updateMission(runId, missionId, {
          status: "failed",
          error: `[REBASE_CONFLICT] ${detail}`,
          callerRole: options.callerRole,
          actor: options.actor,
        });
        this.pendingFixInstructions.set(
          missionId,
          `Auto-rebase of branch \`${mission.branch}\` onto \`${run.baseBranch}\` conflicted${conflictFiles.length > 0 ? ` in: ${conflictFiles.join(", ")}` : ""}. Resolve conflicts cleanly inside your scope, run verification, and commit.`,
        );
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          summary: detail,
        });
        this.emitEvent("wakeup_needed", {
          runId,
          missionId,
          summary: `Rebase conflict on mission ${missionId} ("${mission.title}"): ${detail}`,
        });
        throw new SwarmProtocolError("REBASE_CONFLICT", detail, { conflictFiles });
      }

      if (rebaseRes.status === "skipped_dirty") {
        const msg = rebaseRes.message ?? "Worktree became dirty during auto-rebase.";
        await this.recordMergeRejection(runId, missionId, options.actor, "DIRTY_WORKTREE", msg);
        throw new SwarmProtocolError("DIRTY_WORKTREE", msg);
      }

      if (rebaseRes.status === "rebased") {
        await this.store.appendEvent({
          runId,
          type: "merge_rebased",
          actor: options.actor,
          missionId,
          summary: `Auto-rebased ${mission.branch} onto ${run.baseBranch}${rebaseRes.newHeadSha ? ` (${rebaseRes.newHeadSha.slice(0, 12)})` : ""}`,
        });
        const postRebaseChanged = await this.worktree.getChangedFiles(
          run.baseBranch,
          mission.branch,
          mission.worktreePath,
        );
        const postRebaseOut = findOutOfScopeFiles(postRebaseChanged, mission.scope);
        if (postRebaseOut.length > 0) {
          await this.recordMergeRejection(
            runId,
            missionId,
            options.actor,
            "SCOPE_VIOLATION",
            `Post-rebase diff violates scope: ${postRebaseOut.join(", ")}`,
          );
          throw new SwarmProtocolError(
            "SCOPE_VIOLATION",
            `Post-rebase diff for "${missionId}" violates scope: ${postRebaseOut.join(", ")}`,
            { outOfScope: postRebaseOut },
          );
        }
      }
    }

    // Perform actual Git merge into baseBranch
    const mergeRes = await this.worktree.mergeBranch({
      baseBranch: run.baseBranch,
      branch: mission.branch,
      commitMessage: `swarm(${mission.id}): ${mission.title}`,
    });

    // Mark merged in store (releases scope lock & auto-appends merge_succeeded!)
    await this.store.markMerged(runId, missionId, mergeRes.mergedCommitSha, {
      callerRole: options.callerRole,
      actor: options.actor,
    });
    this.finalAuditBlockedSha = null;
    this.finalAuditBlockedReason = null;

    // Auto-kill warm Worker and Validator handles once mission is merged so memory stays lean!
    await this.killMissionHandles(runId, missionId, `Mission ${missionId} merged`);

    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      missionId,
      summary: `Mission ${missionId} merged into ${run.baseBranch}`,
    });
    this.scheduleTick();
    return mergeRes;
  }

  private async recordMergeRejection(
    runId: string,
    missionId: string,
    actor: string,
    code: string,
    reason: string,
  ): Promise<void> {
    await this.store.appendEvent({
      runId,
      type: "merge_rejected",
      actor,
      missionId,
      summary: `Merge rejected for ${missionId} [${code}]: ${reason}`,
      data: { code, reason },
    });
  }

  // ==========================================================================
  // Run-Level Final Validation Control API
  // ==========================================================================

  async runFinalAudit(options?: {
    runId?: string;
    force?: boolean;
    hostContext?: ExtensionContext;
  }): Promise<SwarmRunState> {
    const targetRunId = this.requireRunId(options?.runId);
    if (options?.hostContext) {
      this.lastHostContext = options.hostContext;
    }

    const run = await this.store.loadRun(targetRunId);
    const missions = run.missionOrder
      .map((id) => run.missions[id])
      .filter((m): m is MissionRecord => Boolean(m));
    const openMissions = missions.filter(
      (m) => m.status !== "merged" && m.status !== "abandoned",
    );
    if (openMissions.length > 0) {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        `Cannot run final validation while ${openMissions.length} mission(s) are still open (${openMissions.map((m) => `${m.id}:${m.status}`).join(", ")}). All missions must be merged or abandoned first.`,
        { openMissionIds: openMissions.map((m) => m.id) },
      );
    }

    const mergedCount = missions.filter((m) => m.status === "merged").length;
    if (mergedCount === 0) {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        "Cannot run final validation because no missions were merged (all missions were abandoned).",
      );
    }

    if (this.missionWorkingAgent.has(FINAL_AUDIT_MISSION_ID)) {
      throw new SwarmProtocolError(
        "OWNERSHIP_CONFLICT",
        `Final Validator (${this.missionWorkingAgent.get(FINAL_AUDIT_MISSION_ID)}) is already running.`,
      );
    }

    if (typeof this.transport.spawnFinalValidator !== "function") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        "Active Swarm transport does not support Final Validator sessions (spawnFinalValidator is not available).",
      );
    }

    if (run.finalAuditStatus === "approved" && !options?.force) {
      return run;
    }

    this.activeRunId = targetRunId;
    this.clearFinalAuditBlockState();
    await this.store.updateRun(targetRunId, {
      status: "active",
      finalValidatorEnabled: true,
      finalAuditStatus: "pending",
      actor: ORCHESTRATOR_BOARD_NAME,
    });

    await this.refreshState(targetRunId);
    this.emitEvent("snapshot_changed", {
      runId: targetRunId,
      missionId: FINAL_AUDIT_MISSION_ID,
      summary: options?.force
        ? "Re-running Final Validation (force)"
        : "Triggered Final Validation",
    });

    await this.tick(options?.hostContext);
    return this.store.loadRun(targetRunId);
  }

  async skipFinalAudit(options?: {
    runId?: string;
    reason?: string;
    skippedBy?: string;
  }): Promise<SwarmRunState> {
    const targetRunId = this.requireRunId(options?.runId);
    const skippedBy = options?.skippedBy ?? "human";

    const runningValidatorId = this.missionWorkingAgent.get(FINAL_AUDIT_MISSION_ID);
    if (runningValidatorId) {
      await this.stopAgent(runningValidatorId, {
        humanStopped: true,
        reason: options?.reason ?? `Final validation skipped by ${skippedBy}`,
      });
    }
    await this.killMissionHandles(targetRunId, FINAL_AUDIT_MISSION_ID, `Final validation skipped by ${skippedBy}`);

    const updated = await this.store.skipFinalAudit(targetRunId, {
      skippedBy,
      reason: options?.reason,
      callerRole: "human",
    });

    this.clearFinalAuditBlockState();
    if (updated.status === "completed") {
      this.clearBackoffTimer();
      await this.killAllRunHandles(targetRunId, "Run completed");
      if (this.getSettings().autoTeardownOnComplete) {
        try {
          await this.teardown({ runId: targetRunId, sessionId: updated.ownerSessionId });
        } catch {
          // non-fatal during run completion
        }
      }
    }

    await this.refreshState(targetRunId);
    this.emitEvent("snapshot_changed", {
      runId: targetRunId,
      missionId: FINAL_AUDIT_MISSION_ID,
      summary: `Final validation skipped by ${skippedBy}${options?.reason ? `: ${options.reason}` : ""}`,
    });

    if (updated.status === "completed") {
      this.emitEvent("run_finished", {
        runId: targetRunId,
        summary: `Swarm run ${targetRunId} finished (final validation skipped by ${skippedBy}).`,
      });
      this.emitEvent("wakeup_needed", {
        runId: targetRunId,
        summary: `Swarm run ${targetRunId} completed (final validation skipped by ${skippedBy}). Present the summary to the user.`,
      });
    }

    return this.store.loadRun(targetRunId);
  }

  // ==========================================================================
  // Safe Teardown, Snapshot & Disposal
  // ==========================================================================

  async teardown(options?: {
    runId?: string;
    deleteBranches?: boolean;
    sessionId?: string;
  }): Promise<SafeTeardownResult> {
    const targetRunId = this.requireRunId(options?.runId);
    const run = await this.store.loadRun(targetRunId);

    // Live-session ownership guard: block dismantling another live session's active fleet!
    if (
      options?.sessionId &&
      run.ownerSessionId &&
      options.sessionId !== run.ownerSessionId &&
      (isPidAlive(run.ownerPid) || this.getWorkingCount() > 0)
    ) {
      throw new SwarmProtocolError(
        "OWNERSHIP_CONFLICT",
        `Run "${run.id}" is owned by active session "${run.ownerSessionId}" (pid ${run.ownerPid}). Refusing teardown from session "${options.sessionId}".`,
        {
          ownerSessionId: run.ownerSessionId,
          ownerPid: run.ownerPid,
          callerSessionId: options.sessionId,
        },
      );
    }

    const targets: SafeTeardownTarget[] = [];
    for (const id of run.missionOrder) {
      const m = run.missions[id];
      if (!m || !m.worktreePath) {
        continue;
      }
      targets.push({
        missionId: m.id,
        worktreePath: m.worktreePath,
        branch: m.branch,
        hasActiveAgent: this.missionWorkingAgent.has(m.id) || this.hasWorkingHandleForMission(m.id),
      });
    }

    const result = await this.worktree.safeTeardown(targets, {
      deleteBranches: options?.deleteBranches ?? false,
    });

    // Kill any warm handles belonging to worktrees that were removed
    for (const removed of result.removed) {
      await this.killMissionHandles(targetRunId, removed.missionId, "Worktree torn down");
    }

    await this.store.appendEvent({
      runId: targetRunId,
      type: "teardown_completed",
      actor: options?.sessionId ?? ORCHESTRATOR_BOARD_NAME,
      summary: `Teardown removed ${result.removed.length}, skipped ${result.skipped.length}, errors ${result.errors.length}`,
      data: {
        removed: result.removed.map((r) => r.missionId),
        skipped: result.skipped.map((s) => ({ missionId: s.missionId, action: s.action })),
        errors: result.errors.map((e) => ({ missionId: e.missionId, reason: e.reason })),
      },
    });

    await this.refreshState(targetRunId);
    this.emitEvent("snapshot_changed", {
      runId: targetRunId,
      summary: `Teardown completed (${result.removed.length} removed, ${result.skipped.length} skipped)`,
    });
    return result;
  }

  getSnapshot(): SwarmSnapshot {
    const run = this.cachedRun;
    const settings = this.getSettings();

    const workingAgentIds: string[] = [];
    const waitingAgentIds: string[] = [];
    for (const entry of this.handles.values()) {
      if (entry.killed) {
        continue;
      }
      if (entry.working || entry.waking || entry.switchingModel) {
        workingAgentIds.push(entry.agentId);
      } else if (entry.handle.getState() === "waiting") {
        waitingAgentIds.push(entry.agentId);
      }
    }

    let totalTokens = 0;
    let totalCost = 0;
    const pendingReviews: string[] = [];
    const pendingArtifactApprovals: string[] = [];
    const readyToMerge: string[] = [];

    if (run) {
      for (const entry of Object.values(run.roster)) {
        totalTokens += entry.tokens || 0;
        totalCost += entry.cost || 0;
      }

      for (const id of run.missionOrder) {
        const m = run.missions[id];
        if (!m || m.status !== "completed") {
          continue;
        }
        if (m.kind === "build") {
          if (run.validatorEnabled) {
            const clean =
              m.latestReview &&
              m.latestReview.status === "clean" &&
              m.latestReview.merge === "merge" &&
              (!m.lastReviewedSha || m.latestReview.commitSha === m.lastReviewedSha);
            if (clean && !this.missionWorkingAgent.has(m.id)) {
              readyToMerge.push(m.id);
            } else {
              pendingReviews.push(m.id);
            }
          } else if (!this.missionWorkingAgent.has(m.id)) {
            readyToMerge.push(m.id);
          }
        } else if (m.kind === "artifact") {
          if (m.humanApprovedSha) {
            readyToMerge.push(m.id);
          } else {
            pendingArtifactApprovals.push(m.id);
          }
        } else if (m.kind === "survey") {
          readyToMerge.push(m.id);
        }
      }
    }

    const roleModels: SwarmRoleModels = {
      orchestrator: {
        model: run?.roleModels?.orchestrator?.model ?? settings.orchestratorModel,
        thinkingLevel:
          run?.roleModels?.orchestrator?.thinkingLevel ?? settings.orchestratorThinkingLevel,
      },
      worker: {
        model: run?.roleModels?.worker?.model ?? settings.workerModel,
        thinkingLevel: run?.roleModels?.worker?.thinkingLevel ?? settings.workerThinkingLevel,
      },
      validator: {
        model: run?.roleModels?.validator?.model ?? settings.validatorModel,
        thinkingLevel:
          run?.roleModels?.validator?.thinkingLevel ?? settings.validatorThinkingLevel,
      },
      fallbackModels: [...(run?.roleModels?.fallbackModels ?? settings.fallbackModels ?? [])],
    };

    const backoffUntil = this.rateLimitBreaker.getBackoffUntil();
    const finalAuditRunningAgentId = this.missionWorkingAgent.get(FINAL_AUDIT_MISSION_ID);

    return {
      run,
      activeRunId: this.activeRunId,
      runningAgentIds: [...workingAgentIds],
      workingAgentIds,
      waitingAgentIds,
      runningCount: workingAgentIds.length,
      maxConcurrency: run?.maxConcurrency ?? settings.maxConcurrency,
      rateLimitUntil: backoffUntil > 0 ? backoffUntil : undefined,
      rateLimitReason: backoffUntil > 0 ? this.rateLimitBreaker.getLastReason() : undefined,
      boardHead: this.cachedBoardHead,
      recentBoard: [...this.cachedRecentBoard],
      recentEvents: [...this.cachedRecentEvents],
      unreadOrchestratorMessages: this.unreadOrchestratorMessages,
      roleModels,
      totalTokens,
      totalCost,
      pendingReviews,
      pendingArtifactApprovals,
      readyToMerge,
      finalAuditStatus: run?.finalAuditStatus,
      latestFinalAudit: run?.latestFinalAudit,
      finalAuditRunningAgentId,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  subscribe(listener: (event: SwarmOrchestratorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearBackoffTimer();

    const active = Array.from(this.handles.values());
    await Promise.allSettled(active.map((entry) => entry.handle.kill("Session shutdown")));
    this.handles.clear();
    this.handleByName.clear();
    this.workerHandleByMission.clear();
    this.validatorHandleByMission.clear();
    this.missionWorkingAgent.clear();
    this.resetPerRunTransientState();
    this.finalAuditHistory.clear();
    this.listeners.clear();
  }

  // ==========================================================================
  // Internal Scheduling Loop (Serialized via tickChain)
  // ==========================================================================

  private async tryLaunchMission(
    runId: string,
    mission: MissionRecord,
    role: RosterAgentRole,
    launchFn: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await launchFn();
      return true;
    } catch (err) {
      const msg = isSwarmProtocolError(err)
        ? `[${err.code}] ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      try {
        await this.store.updateMission(runId, mission.id, {
          status: "failed",
          error: `Failed to launch ${role}: ${msg}`,
          callerRole: "orchestrator",
          actor: ORCHESTRATOR_BOARD_NAME,
        });
      } catch {
        // best-effort status persistence
      }
      await this.refreshState(runId);
      this.emitEvent("error", {
        runId,
        missionId: mission.id,
        summary: `Failed to launch ${role} for ${mission.id}: ${msg}`,
      });
      this.emitEvent("wakeup_needed", {
        runId,
        missionId: mission.id,
        summary: `Mission ${mission.id} ("${mission.title}") failed to launch ${role}: ${msg}`,
      });
      return false;
    }
  }

  private async killAllRunHandles(runId: string, reason: string): Promise<void> {
    const entries = Array.from(this.handles.values()).filter(
      (e) => e.runId === runId && !e.killed,
    );
    for (const entry of entries) {
      await this.killHandleEntry(runId, entry, reason);
    }
  }

  private async completeRun(
    runId: string,
    run: SwarmRunState,
    options?: { agentId?: string; auditVerdict?: FinalAuditVerdict },
  ): Promise<void> {
    this.clearBackoffTimer();
    await this.killAllRunHandles(runId, "Run completed");
    await this.store.updateRun(runId, {
      status: "completed",
      actor: ORCHESTRATOR_BOARD_NAME,
    });
    if (this.getSettings().autoTeardownOnComplete) {
      try {
        await this.teardown({ runId, sessionId: run.ownerSessionId });
      } catch {
        // non-fatal during run completion
      }
    }
    await this.refreshState(runId);
    this.emitEvent("snapshot_changed", {
      runId,
      agentId: options?.agentId,
      summary: `Run ${runId} completed`,
    });
    this.emitEvent("run_finished", {
      runId,
      agentId: options?.agentId,
      summary: options?.auditVerdict
        ? `Swarm run ${runId} finished: Final Validator approved ${run.baseBranch}@${options.auditVerdict.commitSha.slice(0, 12)}.`
        : `Swarm run ${runId} finished: all missions merged/abandoned.`,
    });
    this.emitEvent("wakeup_needed", {
      runId,
      agentId: options?.agentId,
      summary: options?.auditVerdict
        ? `Swarm run ${runId} completed and passed Final Validation (${options.auditVerdict.summary}). Present the final summary to the user.`
        : `Swarm run ${runId} completed! Present the summary to the user.`,
    });
  }

  private async tickInternal(): Promise<void> {
    if (this.disposed || !this.activeRunId) {
      return;
    }

    const runId = this.activeRunId;
    this.syncBreakerConfig();
    const run = await this.refreshState(runId);
    if (!run || (run.status !== "active" && run.status !== "verifying")) {
      this.emitEvent("snapshot_changed", {
        runId,
        summary: run ? `Run ${runId} status is ${run.status}` : "No active run",
      });
      return;
    }

    const missions = run.missionOrder
      .map((id) => run.missions[id])
      .filter((m): m is MissionRecord => Boolean(m));

    // 1. Check for run completion / Post-Merge Run-Level Final Validator gate
    const allMissionsTerminal =
      missions.length > 0 &&
      missions.every((m) => m.status === "merged" || m.status === "abandoned");

    if (allMissionsTerminal) {
      const mergedMissions = missions.filter((m) => m.status === "merged");
      const shouldVerify =
        mergedMissions.length > 0 &&
        run.finalValidatorEnabled &&
        run.finalAuditStatus !== "approved" &&
        run.finalAuditStatus !== "skipped" &&
        typeof this.transport.spawnFinalValidator === "function";

      if (shouldVerify) {
        if (this.missionWorkingAgent.has(FINAL_AUDIT_MISSION_ID)) {
          return;
        }
        if (this.humanStoppedMissions.has(FINAL_AUDIT_MISSION_ID)) {
          return;
        }
        if (this.rateLimitBreaker.isBackedOff()) {
          this.scheduleBackoffWakeup();
          this.emitEvent("snapshot_changed", {
            runId,
            missionId: FINAL_AUDIT_MISSION_ID,
            summary: `Rate-limit backoff active before Final Validator (${this.rateLimitBreaker.getRemainingMs()}ms remaining)`,
          });
          return;
        }

        const baseCheck = await this.worktree.isBaseCleanOnBranch(run.baseBranch);
        if (!baseCheck.ok) {
          const code = baseCheck.dirty ? "DIRTY_BASE" : "WRONG_BRANCH";
          const reason =
            baseCheck.reason ??
            (baseCheck.dirty
              ? `Base repo checkout has uncommitted changes on "${baseCheck.currentBranch}".`
              : `Base repo checkout is on "${baseCheck.currentBranch}", expected "${run.baseBranch}".`);
          const blockKey = `${code}:${baseCheck.currentBranch}:${baseCheck.dirty}`;
          if (this.finalAuditBlockedReason !== blockKey) {
            this.finalAuditBlockedReason = blockKey;
            this.emitEvent("snapshot_changed", {
              runId,
              missionId: FINAL_AUDIT_MISSION_ID,
              summary: `Final Validator paused [${code}]: ${reason}`,
            });
            this.emitEvent("wakeup_needed", {
              runId,
              missionId: FINAL_AUDIT_MISSION_ID,
              summary: `Final Validator cannot run on "${run.baseBranch}" [${code}]: ${reason}. Clean or switch the base repo, then run /swarm verify (or resume).`,
            });
          }
          return;
        }
        this.finalAuditBlockedReason = null;

        const baseHeadSha = await this.worktree.getHeadSha(this.worktree.repoRoot);
        if (this.finalAuditBlockedSha === baseHeadSha) {
          return;
        }

        if (this.finalAuditRetrySha !== baseHeadSha) {
          this.finalAuditRetrySha = baseHeadSha;
          this.finalAuditRetryCount = 0;
        }

        await this.tryLaunchFinalValidator(run, mergedMissions, baseHeadSha);
        return;
      }

      await this.completeRun(runId, run);
      return;
    }

    // Clear stale final-audit park markers once new missions reopen the run (finalAuditStatus reset to "idle")
    if (run.finalAuditStatus === "idle") {
      this.finalAuditBlockedSha = null;
      this.finalAuditBlockedReason = null;
    }

    if (this.missionWorkingAgent.has(FINAL_AUDIT_MISSION_ID)) {
      return;
    }

    // 2. Respect shared rate-limit circuit breaker
    if (this.rateLimitBreaker.isBackedOff()) {
      this.scheduleBackoffWakeup();
      this.emitEvent("snapshot_changed", {
        runId,
        summary: `Rate-limit backoff active (${this.rateLimitBreaker.getRemainingMs()}ms remaining)`,
      });
      return;
    }

    const settings = this.getSettings();
    const maxSlots = Math.max(1, run.maxConcurrency || settings.maxConcurrency);
    let spawnedAny = false;

    // 3. Priority A: Spawn independent validators for completed build missions needing validation
    if (run.validatorEnabled) {
      for (const mission of missions) {
        if (this.getWorkingCount() >= maxSlots || this.rateLimitBreaker.isBackedOff()) {
          break;
        }
        if (
          mission.kind !== "build" ||
          mission.status !== "completed" ||
          mission.humanStopped ||
          this.humanStoppedMissions.has(mission.id) ||
          this.missionWorkingAgent.has(mission.id)
        ) {
          continue;
        }

        let tipSha: string;
        try {
          tipSha = await this.worktree.getHeadSha(mission.worktreePath);
        } catch {
          continue;
        }

        const hasMatchingReview =
          mission.latestReview !== undefined && mission.latestReview.commitSha === tipSha;
        if (!hasMatchingReview) {
          const launched = await this.tryLaunchMission(runId, mission, "validator", () =>
            this.launchValidator(run, mission, tipSha),
          );
          if (launched) {
            spawnedAny = true;
          }
        } else if (
          mission.latestReview?.status === "clean" &&
          mission.latestReview.merge === "merge" &&
          settings.autoMergeClean
        ) {
          this.enqueueAutoMerge(runId, mission.id, tipSha);
        }
      }
    }

    // 4. Priority B: Spawn workers for ready planned missions (all deps merged or abandoned)
    for (const mission of missions) {
      if (this.getWorkingCount() >= maxSlots || this.rateLimitBreaker.isBackedOff()) {
        break;
      }
      if (
        mission.status !== "planned" ||
        mission.humanStopped ||
        this.humanStoppedMissions.has(mission.id) ||
        this.missionWorkingAgent.has(mission.id)
      ) {
        continue;
      }
      const depsReady = mission.deps.every((depId) => {
        const dep = run.missions[depId];
        return dep !== undefined && (dep.status === "merged" || dep.status === "abandoned");
      });
      if (!depsReady) {
        continue;
      }
      const launched = await this.tryLaunchMission(runId, mission, "worker", () =>
        this.launchWorker(run, mission),
      );
      if (launched) {
        spawnedAny = true;
      }
    }

    // 5. Priority C: Resume active missions without a working agent (warm fix rounds / retries)
    for (const mission of missions) {
      if (this.getWorkingCount() >= maxSlots || this.rateLimitBreaker.isBackedOff()) {
        break;
      }
      if (
        mission.status !== "active" ||
        mission.humanStopped ||
        this.humanStoppedMissions.has(mission.id) ||
        this.missionWorkingAgent.has(mission.id)
      ) {
        continue;
      }
      if (mission.reviewRound > run.maxValidationRounds) {
        continue;
      }
      if (mission.retryCount > settings.maxRetries) {
        continue;
      }
      const launched = await this.tryLaunchMission(runId, mission, "worker", () =>
        this.launchOrWakeWorker(run, mission),
      );
      if (launched) {
        spawnedAny = true;
      }
    }

    if (spawnedAny) {
      await this.refreshState(runId);
      this.emitEvent("snapshot_changed", {
        runId,
        summary: `Scheduled agents (${this.getWorkingCount()}/${maxSlots} working)`,
      });
    }
  }

  // ==========================================================================
  // Launching & Waking Workers, Validators & Final Validator
  // ==========================================================================

  private getWarmWorkerForMission(missionId: string): LiveAgentEntry | undefined {
    const agentId = this.workerHandleByMission.get(missionId);
    if (!agentId) {
      return undefined;
    }
    const entry = this.handles.get(agentId);
    if (!entry || entry.killed || entry.working || entry.waking || entry.switchingModel) {
      return undefined;
    }
    if (entry.handle.getState() !== "waiting") {
      return undefined;
    }
    return entry;
  }

  private async launchOrWakeWorker(
    run: SwarmRunState,
    mission: MissionRecord,
  ): Promise<PersistentAgentHandle> {
    if (run.keepWorkersWarm) {
      const warmWorker = this.getWarmWorkerForMission(mission.id);
      if (warmWorker) {
        const fixInstruction = this.pendingFixInstructions.get(mission.id);
        if (fixInstruction !== undefined) {
          this.pendingFixInstructions.delete(mission.id);
        }
        const wakePrompt = fixInstruction
          ? `Repair required for mission ${mission.id} ("${mission.title}") on branch \`${mission.branch}\`:\n\n${fixInstruction}\n\nFix cleanly, verify, commit, and call \`${SWARM_WORKER_DONE_TOOL}\`.`
          : mission.latestReview
            ? formatValidationWakePrompt(mission, mission.latestReview, this.cachedBoardHead)
            : buildWorkerTaskPrompt(run, mission);

        await this.wakeAgent(run.id, warmWorker, wakePrompt, {
          turnKind: "mission",
          reason: fixInstruction
            ? `repair attempt ${mission.retryCount}`
            : `fix round ${mission.reviewRound}`,
          boardHead: this.cachedBoardHead,
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        return warmWorker.handle;
      }
    }
    return this.launchWorker(run, mission);
  }

  private async launchWorker(
    run: SwarmRunState,
    mission: MissionRecord,
    options: {
      promptOverride?: string;
      modelOverride?: string;
      thinkingLevel?: ThinkingLevel;
    } = {},
  ): Promise<PersistentAgentHandle> {
    const settings = this.getSettings();
    const targetWorktreePath = mission.worktreePath || this.store.getWorktreePath(run.id, mission.id);
    const reuseExistingBranch =
      mission.status !== "planned" ||
      mission.retryCount > 0 ||
      mission.reviewRound > 0;

    // If an old non-working handle exists for this mission's worker, dispose it before spawning fresh
    const priorWorkerId = this.workerHandleByMission.get(mission.id);
    if (priorWorkerId) {
      const prior = this.handles.get(priorWorkerId);
      if (prior && !prior.working) {
        await this.killHandleEntry(run.id, prior, "Replaced by fresh worker spawn");
      }
    }

    const created = await this.worktree.createWorktree({
      branch: mission.branch,
      baseBranch: run.baseBranch,
      worktreePath: targetWorktreePath,
      reuseExistingBranch,
    });

    let currentRun = run;
    if (mission.status === "planned" || mission.worktreePath !== created.worktreePath) {
      currentRun = await this.store.updateMission(run.id, mission.id, {
        status: "active",
        worktreePath: created.worktreePath,
        error: null,
        callerRole: "orchestrator",
        actor: ORCHESTRATOR_BOARD_NAME,
      });
    }

    const updatedMission = currentRun.missions[mission.id]!;
    const agentId = this.nextAgentId("worker", mission.id);
    const name = updatedMission.id;

    // Gather upstream findings from declared dependencies and completed/merged survey missions
    const depSet = new Set(updatedMission.deps);
    const upstreamFindings: SwarmFindingRecord[] = currentRun.findings.filter((f) => {
      if (f.missionId === updatedMission.id) {
        return false;
      }
      if (depSet.has(f.missionId)) {
        return true;
      }
      const source = currentRun.missions[f.missionId];
      return source?.kind === "survey" && (source.status === "completed" || source.status === "merged");
    });

    // Read unread inbox messages targeted to this mission
    const inboxMessages = await this.store.readInbox(run.id, updatedMission.id, {
      unreadOnly: true,
      markRead: true,
      limit: 20,
    });
    const contextMessages = inboxMessages.map((m) => `[from ${m.from}] ${m.text}`);

    // Snapshot recent board context and cursor at spawn time
    const boardSnap = await this.store.readBoard(run.id, { limit: 12 }).catch(() => ({
      messages: [] as BoardMessage[],
      head: this.cachedBoardHead,
    }));

    const fixInstruction = this.pendingFixInstructions.get(updatedMission.id);
    if (fixInstruction !== undefined) {
      this.pendingFixInstructions.delete(updatedMission.id);
    }

    const systemPromptAppendix = buildWorkerSystemPrompt(
      currentRun,
      updatedMission,
      upstreamFindings,
      boardSnap.messages,
    );
    const taskPrompt = buildWorkerTaskPrompt(currentRun, updatedMission, {
      promptOverride: options.promptOverride,
      contextMessages,
      fixInstruction,
    });

    // Resolve worker role model
    const resolvedModel = resolveRoleModel(
      "worker",
      settings,
      options.modelOverride ?? currentRun.roleModels?.worker?.model,
      options.thinkingLevel ?? currentRun.roleModels?.worker?.thinkingLevel,
    );

    // Post concise spawn brief on shared board (without re-routing back to this worker)
    const briefMsg = await this.postBoardInternal(
      run.id,
      {
        from: ORCHESTRATOR_BOARD_NAME,
        fromRole: "orchestrator",
        kind: "brief",
        missionId: updatedMission.id,
        text: `@${name} [brief] ${updatedMission.kind} "${updatedMission.title}" on ${updatedMission.branch} (scope: ${updatedMission.scope.join(", ")})`,
      },
      { routePeers: false },
    );
    const spawnBoardCursor = Math.max(boardSnap.head, briefMsg.seq);

    await this.store.registerRoster(run.id, {
      agentId,
      name,
      role: "worker",
      missionId: updatedMission.id,
      worktreePath: created.worktreePath,
      branch: updatedMission.branch,
      status: "working",
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      lastReadBoardSeq: spawnBoardCursor,
      turns: 1,
      startedAt: new Date(this.now()).toISOString(),
    });

    let liveEntry: LiveAgentEntry | undefined;
    const request: WorkerSpawnRequest = {
      agentId,
      name,
      role: "worker",
      runId: run.id,
      mission: updatedMission,
      objective: currentRun.objective,
      verificationContract: currentRun.verificationContract,
      baseBranch: currentRun.baseBranch,
      worktreePath: created.worktreePath,
      branch: updatedMission.branch,
      prompt: taskPrompt,
      systemPromptAppendix,
      boardCursor: spawnBoardCursor,
      keepWarm: currentRun.keepWorkersWarm,
      contextMessages: contextMessages.length > 0 ? contextMessages : undefined,
      modelOverride: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      hostContext: this.getHostContext() ?? this.lastHostContext,
      store: this.store,
      onTelemetry: (ev) => this.handleTelemetry(run.id, ev),
      onBoardPost: async (msg) => {
        if (liveEntry) {
          await this.handleSubagentBoardPost(run.id, liveEntry, msg);
        }
      },
    };

    const handle = await this.transport.spawnWorker(request);
    liveEntry = this.registerHandle(run.id, updatedMission.id, "worker", handle, {
      model: handle.getModel() ?? resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      boardCursor: spawnBoardCursor,
    });

    this.attachTurnCompletionHandler(run.id, liveEntry, handle.currentTurn, {
      turnKind: "mission",
    });

    return handle;
  }

  private async launchValidator(
    run: SwarmRunState,
    mission: MissionRecord,
    precomputedTipSha?: string,
    options: {
      modelOverride?: string;
      thinkingLevel?: ThinkingLevel;
    } = {},
  ): Promise<PersistentAgentHandle> {
    const settings = this.getSettings();
    const tipSha = precomputedTipSha ?? (await this.worktree.getHeadSha(mission.worktreePath));

    // Kill any previous round's validator handle for this mission so fresh unbiased eyes pin exact tipSha
    const priorValId = this.validatorHandleByMission.get(mission.id);
    if (priorValId) {
      const prior = this.handles.get(priorValId);
      if (prior && !prior.working) {
        await this.killHandleEntry(run.id, prior, "Replaced by fresh validation round");
      }
    }

    const diffSummary = await this.worktree.getDiffSummary(run.baseBranch, mission.branch, {
      maxDiffBytes: SWARM_MAX_DIFF_BYTES,
      cwd: mission.worktreePath,
    });

    const boardSnap = await this.store.readBoard(run.id, { limit: 15 }).catch(() => ({
      messages: [] as BoardMessage[],
      head: this.cachedBoardHead,
    }));

    const agentId = this.nextAgentId("validator", mission.id);
    const name = `validator-${mission.id}`;

    const systemPromptAppendix = buildValidatorSystemPrompt(
      run,
      mission,
      diffSummary,
      diffSummary.changedFiles,
      tipSha,
      boardSnap.messages,
    );
    const taskPrompt = buildValidatorTaskPrompt(mission, diffSummary, tipSha, boardSnap.messages);

    // Resolve validator role model (3-role model: validator!)
    const resolvedModel = resolveRoleModel(
      "validator",
      settings,
      options.modelOverride ?? run.roleModels?.validator?.model,
      options.thinkingLevel ?? run.roleModels?.validator?.thinkingLevel,
    );

    await this.store.registerRoster(run.id, {
      agentId,
      name,
      role: "validator",
      missionId: mission.id,
      worktreePath: mission.worktreePath,
      branch: mission.branch,
      status: "working",
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      lastReadBoardSeq: boardSnap.head,
      turns: 1,
      startedAt: new Date(this.now()).toISOString(),
    });

    let liveEntry: LiveAgentEntry | undefined;
    const request: ValidatorSpawnRequest = {
      agentId,
      name,
      role: "validator",
      runId: run.id,
      mission,
      objective: run.objective,
      verificationContract: run.verificationContract,
      baseBranch: run.baseBranch,
      worktreePath: mission.worktreePath,
      branch: mission.branch,
      prompt: taskPrompt,
      systemPromptAppendix,
      boardCursor: boardSnap.head,
      keepWarm: run.keepWorkersWarm,
      targetCommitSha: tipSha,
      diffSummary,
      modelOverride: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      hostContext: this.getHostContext() ?? this.lastHostContext,
      store: this.store,
      onTelemetry: (ev) => this.handleTelemetry(run.id, ev),
      onBoardPost: async (msg) => {
        if (liveEntry) {
          await this.handleSubagentBoardPost(run.id, liveEntry, msg);
        }
      },
    };

    const handle = await this.transport.spawnValidator(request);
    liveEntry = this.registerHandle(run.id, mission.id, "validator", handle, {
      model: handle.getModel() ?? resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      boardCursor: boardSnap.head,
    });

    this.attachTurnCompletionHandler(run.id, liveEntry, handle.currentTurn, {
      turnKind: "validation",
      reviewedSha: tipSha,
    });

    return handle;
  }

  private async tryLaunchFinalValidator(
    run: SwarmRunState,
    mergedMissions: readonly MissionRecord[],
    baseHeadSha: string,
  ): Promise<boolean> {
    try {
      await this.launchFinalValidator(run, mergedMissions, baseHeadSha);
      return true;
    } catch (err) {
      const msg = isSwarmProtocolError(err)
        ? `[${err.code}] ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      this.finalAuditBlockedSha = baseHeadSha;
      try {
        await this.store.updateRun(run.id, {
          status: "active",
          finalAuditStatus: run.latestFinalAudit ? run.latestFinalAudit.verdict : "pending",
          actor: ORCHESTRATOR_BOARD_NAME,
        });
      } catch {
        // best-effort status persistence
      }
      await this.refreshState(run.id);
      this.emitEvent("error", {
        runId: run.id,
        missionId: FINAL_AUDIT_MISSION_ID,
        summary: `Failed to launch Final Validator: ${msg}`,
      });
      this.emitEvent("wakeup_needed", {
        runId: run.id,
        missionId: FINAL_AUDIT_MISSION_ID,
        summary: `Final Validator failed to launch for ${run.baseBranch}@${baseHeadSha.slice(0, 12)}: ${msg}. Run /swarm verify to retry or /swarm verify --skip.`,
      });
      return false;
    }
  }

  private async launchFinalValidator(
    run: SwarmRunState,
    mergedMissions: readonly MissionRecord[],
    baseHeadSha: string,
  ): Promise<PersistentAgentHandle> {
    if (typeof this.transport.spawnFinalValidator !== "function") {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        "Transport does not support Final Validator sessions (spawnFinalValidator is not implemented).",
      );
    }

    // Kill any prior final-validator handle cleanly before starting fresh round
    await this.killMissionHandles(run.id, FINAL_AUDIT_MISSION_ID, "Replaced by fresh final validation round");

    const settings = this.getSettings();
    const round = (run.finalAuditRound || 0) + 1;
    const agentId = this.nextAgentId("final-validator", FINAL_AUDIT_MISSION_ID);
    const name = FINAL_VALIDATOR_BOARD_NAME;

    const history = this.finalAuditHistory.get(run.id) ?? [];
    const priorAudits: FinalAuditVerdict[] = [...history];
    if (
      run.latestFinalAudit &&
      !priorAudits.some(
        (a) =>
          a.round === run.latestFinalAudit!.round &&
          a.commitSha === run.latestFinalAudit!.commitSha,
      )
    ) {
      priorAudits.push(run.latestFinalAudit);
    }

    const boardSnap = await this.store.readBoard(run.id, { limit: 20 }).catch(() => ({
      messages: [] as BoardMessage[],
      head: this.cachedBoardHead,
    }));

    const systemPromptAppendix = buildFinalValidatorSystemPrompt(
      run,
      mergedMissions,
      baseHeadSha,
      round,
      boardSnap.messages,
    );
    const taskPrompt = buildFinalValidatorTaskPrompt(
      run,
      mergedMissions,
      run.findings,
      priorAudits,
      baseHeadSha,
      boardSnap.messages,
    );

    // 3-Role model resolution: BOTH per-mission Validator AND Final Validator resolve `validator` role!
    const resolvedModel = resolveRoleModel(
      "validator",
      settings,
      run.roleModels?.validator?.model,
      run.roleModels?.validator?.thinkingLevel,
    );

    await this.store.updateRun(run.id, {
      status: "verifying",
      finalAuditStatus: "running",
      actor: ORCHESTRATOR_BOARD_NAME,
    });

    // SwarmStore.registerRoster auto-emits "final_audit_started" for role === "final-validator"
    await this.store.registerRoster(run.id, {
      agentId,
      name,
      role: "final-validator",
      missionId: FINAL_AUDIT_MISSION_ID,
      worktreePath: this.worktree.repoRoot,
      branch: run.baseBranch,
      status: "working",
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      lastReadBoardSeq: boardSnap.head,
      turns: 1,
      startedAt: new Date(this.now()).toISOString(),
    });

    let liveEntry: LiveAgentEntry | undefined;
    const request: FinalValidatorSpawnRequest = {
      agentId,
      name,
      runId: run.id,
      objective: run.objective,
      verificationContract: run.verificationContract,
      baseBranch: run.baseBranch,
      repoRoot: this.worktree.repoRoot,
      targetCommitSha: baseHeadSha,
      round,
      maxRounds: run.maxFinalAuditRounds,
      mergedMissions: [...mergedMissions],
      findings: [...run.findings],
      priorAudits: priorAudits.length > 0 ? priorAudits : undefined,
      prompt: taskPrompt,
      systemPromptAppendix,
      boardCursor: boardSnap.head,
      keepWarm: run.keepWorkersWarm,
      modelOverride: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      hostContext: this.getHostContext() ?? this.lastHostContext,
      store: this.store,
      onTelemetry: (ev) => this.handleTelemetry(run.id, ev),
      onBoardPost: async (msg) => {
        if (liveEntry) {
          await this.handleSubagentBoardPost(run.id, liveEntry, msg);
        }
      },
    };

    let handle: PersistentAgentHandle;
    try {
      handle = await this.transport.spawnFinalValidator(request);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.store
        .updateRoster(run.id, agentId, {
          status: "failed",
          endedAt: new Date(this.now()).toISOString(),
          error: errMsg,
          currentActivity: `launch failed: ${errMsg.slice(0, 80)}`,
        })
        .catch(() => {});
      throw err;
    }

    liveEntry = this.registerHandle(run.id, FINAL_AUDIT_MISSION_ID, "final-validator", handle, {
      model: handle.getModel() ?? resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      boardCursor: boardSnap.head,
    });

    await this.refreshState(run.id);
    this.emitEvent("snapshot_changed", {
      runId: run.id,
      missionId: FINAL_AUDIT_MISSION_ID,
      agentId,
      summary: `Final Validator started (round ${round}/${run.maxFinalAuditRounds}) on ${run.baseBranch}@${baseHeadSha.slice(0, 12)}`,
    });

    this.attachTurnCompletionHandler(run.id, liveEntry, handle.currentTurn, {
      turnKind: "final_validation",
      finalAuditSha: baseHeadSha,
      finalAuditRound: round,
    });

    return handle;
  }

  private attachTurnCompletionHandler(
    runId: string,
    entry: LiveAgentEntry,
    turnPromise: Promise<AgentTurnResult>,
    meta: {
      turnKind: ActiveTurnKind;
      reviewedSha?: string;
      finalAuditSha?: string;
      finalAuditRound?: number;
    },
  ): void {
    const dispatch = (result: AgentTurnResult): void => {
      if (entry.role === "worker") {
        void this.handleWorkerTurnComplete(runId, entry.missionId, entry, result, meta.turnKind);
      } else if (entry.role === "validator") {
        void this.handleValidatorTurnComplete(
          runId,
          entry.missionId,
          entry,
          meta.reviewedSha ?? "",
          result,
          meta.turnKind,
        );
      } else {
        void this.handleFinalValidatorTurnComplete(
          runId,
          entry,
          meta.finalAuditSha ?? "",
          meta.finalAuditRound ?? 1,
          result,
          meta.turnKind,
        );
      }
    };

    turnPromise.then(dispatch, (err) => {
      const errorText = err instanceof Error ? err.message : String(err);
      dispatch({
        agentId: entry.agentId,
        name: entry.name,
        missionId: entry.missionId,
        role: entry.role,
        outcome: "failed",
        summary: errorText,
        model: entry.model,
        tokens: 0,
        cost: 0,
        error: errorText,
      });
    });
  }

  // ==========================================================================
  // Automatic Quota Fallback Model Switch Helper
  // ==========================================================================

  private canAttemptQuotaFallback(entry: LiveAgentEntry, result: AgentTurnResult): boolean {
    if (this.disposed || entry.killed) {
      return false;
    }
    const handleState = entry.handle.getState();
    if (handleState !== "waiting") {
      return false;
    }
    const settings = this.getSettings();
    const fallbacks =
      this.cachedRun?.roleModels?.fallbackModels &&
      this.cachedRun.roleModels.fallbackModels.length > 0
        ? this.cachedRun.roleModels.fallbackModels
        : settings.fallbackModels;
    if (!fallbacks || fallbacks.length === 0) {
      return false;
    }
    const currentModel = entry.model ?? entry.handle.getModel() ?? result.model;
    const candidate = selectFallbackModel(currentModel, fallbacks, entry.triedModels);
    return candidate !== undefined;
  }

  private async tryQuotaFallbackSwitch(
    runId: string,
    run: SwarmRunState,
    entry: LiveAgentEntry,
    result: AgentTurnResult,
    options: {
      turnKind: ActiveTurnKind;
      resumePrompt: string;
      reviewedSha?: string;
      finalAuditSha?: string;
      finalAuditRound?: number;
    },
  ): Promise<boolean> {
    if (
      this.disposed ||
      entry.killed ||
      this.humanStoppedAgents.has(entry.agentId) ||
      this.humanStoppedMissions.has(entry.missionId)
    ) {
      return false;
    }
    const handleState = entry.handle.getState();
    if (handleState !== "waiting") {
      return false;
    }

    const currentModel = entry.model ?? entry.handle.getModel() ?? result.model;
    if (currentModel?.trim()) {
      entry.triedModels.add(currentModel.trim());
    }

    const settings = this.getSettings();
    const fallbacks =
      run.roleModels?.fallbackModels && run.roleModels.fallbackModels.length > 0
        ? run.roleModels.fallbackModels
        : settings.fallbackModels;

    const nextModel = selectFallbackModel(currentModel, fallbacks, entry.triedModels);
    if (!nextModel) {
      return false;
    }
    entry.triedModels.add(nextModel);

    try {
      const switched = await entry.handle.switchModel(nextModel, entry.thinkingLevel);
      if (
        this.disposed ||
        entry.killed ||
        this.humanStoppedAgents.has(entry.agentId) ||
        this.humanStoppedMissions.has(entry.missionId) ||
        entry.handle.getState() !== "waiting"
      ) {
        return false;
      }

      const prevModel = currentModel ?? "default";
      entry.model = switched.model;
      if (switched.thinkingLevel !== undefined) {
        entry.thinkingLevel = switched.thinkingLevel;
      }
      entry.triedModels.add(switched.model);

      await this.store.updateRoster(runId, entry.agentId, {
        model: switched.model,
        ...(switched.thinkingLevel !== undefined ? { thinkingLevel: switched.thinkingLevel } : {}),
        tokens: result.tokens,
        tokenBreakdown: result.tokenBreakdown,
        cost: result.cost,
        currentActivity: `fallback model -> ${switched.model}`,
        error: null,
      });

      await this.store.appendEvent({
        runId,
        type: "agent_model_switched",
        actor: ORCHESTRATOR_BOARD_NAME,
        missionId: entry.missionId,
        agentId: entry.agentId,
        summary: `Auto-switched ${entry.name} from ${prevModel} -> ${switched.model} after rate limit/quota error`,
        data: {
          name: entry.name,
          fromModel: prevModel,
          toModel: switched.model,
          reason: "rate_limited_fallback",
        },
      });

      await this.postBoardInternal(
        runId,
        {
          from: ORCHESTRATOR_BOARD_NAME,
          fromRole: "orchestrator",
          kind: "model_switch",
          missionId: entry.missionId !== FINAL_AUDIT_MISSION_ID ? entry.missionId : undefined,
          text: `[model] ${entry.name} auto-switched to ${switched.model} after rate limit/quota error; resuming warm session.`,
        },
        { routePeers: false },
      );

      if (
        this.disposed ||
        entry.killed ||
        this.humanStoppedAgents.has(entry.agentId) ||
        this.humanStoppedMissions.has(entry.missionId) ||
        entry.handle.getState() !== "waiting"
      ) {
        return false;
      }

      // Synchronously hand off switchingModel -> wakeAgent(working = true) with zero await gap!
      entry.switchingModel = false;
      await this.wakeAgent(runId, entry, options.resumePrompt, {
        turnKind: options.turnKind,
        reason: `quota fallback -> ${switched.model}`,
        boardHead: this.cachedBoardHead,
        actor: ORCHESTRATOR_BOARD_NAME,
        reviewedSha: options.reviewedSha,
        finalAuditSha: options.finalAuditSha,
        finalAuditRound: options.finalAuditRound,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Worker, Validator & Final Validator Turn Completion Handlers
  // ==========================================================================

  private async handleWorkerTurnComplete(
    runId: string,
    missionId: string,
    entry: LiveAgentEntry,
    result: AgentTurnResult,
    turnKind: ActiveTurnKind,
  ): Promise<void> {
    const agentId = entry.agentId;

    // Engage shared circuit breaker synchronously BEFORE releasing slot if no warm fallback model exists!
    let preRecordedDelayMs: number | undefined;
    const isRateLimited =
      result.outcome === "rate_limited" &&
      !this.humanStoppedAgents.has(agentId) &&
      !this.humanStoppedMissions.has(missionId);
    const hasFallback = isRateLimited && this.canAttemptQuotaFallback(entry, result);

    if (isRateLimited && !hasFallback) {
      const reason = result.error ?? "Provider rate limit (HTTP 429)";
      preRecordedDelayMs = this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
    }

    // Mark not working immediately; keep switchingModel & missionWorkingAgent reserved while attempting quota fallback!
    entry.working = false;
    if (result.model) {
      entry.model = result.model;
    }
    let fallbackReservationHeld = hasFallback;
    if (fallbackReservationHeld) {
      entry.switchingModel = true;
    } else if (this.missionWorkingAgent.get(missionId) === agentId) {
      this.missionWorkingAgent.delete(missionId);
    }

    const releaseFallbackReservation = (): void => {
      if (!fallbackReservationHeld) {
        return;
      }
      fallbackReservationHeld = false;
      entry.switchingModel = false;
      if (!entry.working && this.missionWorkingAgent.get(missionId) === agentId) {
        this.missionWorkingAgent.delete(missionId);
      }
    };

    try {
      const settings = this.getSettings();
      const run = await this.store.loadRun(runId);
      const mission = run.missions[missionId];
      if (!mission) {
        return;
      }

      const rosterEntry = run.roster[agentId];
      const wasHumanStopped =
        this.humanStoppedAgents.has(agentId) ||
        this.humanStoppedMissions.has(missionId) ||
        mission.humanStopped ||
        Boolean(rosterEntry?.humanStopped);

      // If rate_limited and an untried fallback model is configured on a warm handle, hot-switch & resume!
      if (result.outcome === "rate_limited" && !wasHumanStopped && hasFallback) {
        const switched = await this.tryQuotaFallbackSwitch(runId, run, entry, result, {
          turnKind,
          resumePrompt: `Your model was switched to a fallback model after a rate-limit/quota error. Continue working on mission ${missionId} ("${mission.title}") from where you left off.`,
        });
        if (switched) {
          fallbackReservationHeld = false;
          return;
        }
        releaseFallbackReservation();
        // Fallback failed -> engage breaker now
        const reason = result.error ?? "Provider rate limit (HTTP 429)";
        preRecordedDelayMs = this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
      } else {
        releaseFallbackReservation();
      }

      const handleState = entry.handle.getState();
      const keptWarmWaiting =
        !wasHumanStopped &&
        !entry.killed &&
        run.keepWorkersWarm &&
        result.outcome === "completed" &&
        handleState === "waiting";

      const nextRosterStatus: RosterAgentStatus = wasHumanStopped
        ? "stopped"
        : entry.killed || handleState === "killed"
          ? "killed"
          : keptWarmWaiting
            ? "waiting"
            : result.outcome === "completed" || result.outcome === "aborted"
              ? "stopped"
              : "failed";

      if (nextRosterStatus === "killed" || (!run.keepWorkersWarm && !keptWarmWaiting)) {
        if (!entry.killed && handleState !== "waiting") {
          this.unregisterHandle(entry);
        }
      }

      if (rosterEntry) {
        await this.store.updateRoster(runId, agentId, {
          status: nextRosterStatus,
          humanStopped: wasHumanStopped,
          model: entry.model,
          turns: entry.turns,
          lastReadBoardSeq: entry.lastReadBoardSeq,
          endedAt: keptWarmWaiting ? null : new Date(this.now()).toISOString(),
          tokens: result.tokens,
          tokenBreakdown: result.tokenBreakdown,
          cost: result.cost,
          currentActivity: keptWarmWaiting
            ? "waiting (warm)"
            : result.error
              ? `${result.outcome}: ${result.error.slice(0, 80)}`
              : result.outcome,
          error: result.error ?? null,
        });
      }

      // Human sovereignty invariant: NEVER auto-restart human-stopped agents!
      if (wasHumanStopped) {
        this.humanStoppedAgents.delete(agentId);
        if (mission.status !== "stopped" && mission.status !== "merged" && mission.status !== "abandoned") {
          await this.store.updateMission(runId, missionId, {
            status: "stopped",
            humanStopped: true,
            callerRole: "human",
            actor: "human",
          });
        }
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Worker ${entry.name} stopped by human; will not auto-restart`,
        });
        this.scheduleTick();
        return;
      }

      if (this.disposed || entry.killed || mission.status === "merged" || mission.status === "abandoned") {
        await this.refreshState(runId);
        return;
      }

      // If this was a peer-to-peer board Q&A wake without calling swarm_worker_done,
      // simply return the warm worker to `waiting` without altering mission state!
      if (turnKind === "board_peer" && !result.workerDone && result.outcome === "completed") {
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `${entry.name} finished board reply and returned to warm waiting state`,
        });
        this.drainPendingBoardWakes(runId, entry);
        return;
      }

      // ----------------------------------------------------------------------
      // Outcome: rate_limited (shared circuit breaker)
      // ----------------------------------------------------------------------
      if (result.outcome === "rate_limited") {
        const reason = result.error ?? "Provider rate limit (HTTP 429)";
        const delayMs =
          preRecordedDelayMs ?? this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
        await this.store.appendEvent({
          runId,
          type: "rate_limit_backoff",
          actor: ORCHESTRATOR_BOARD_NAME,
          missionId,
          agentId,
          summary: `Rate limit on ${missionId}; fleet backing off ${delayMs}ms (${reason})`,
          data: {
            delayMs,
            retryAfterMs: result.retryAfterMs,
            consecutiveFailures: this.rateLimitBreaker.getConsecutiveFailures(),
          },
        });

        // Dispose non-reusable handle on rate limit backoff so retry starts cleanly if not warm
        if (handleState !== "waiting") {
          this.unregisterHandle(entry);
        }

        const nextRetry = mission.retryCount + 1;
        if (nextRetry <= settings.maxRetries) {
          await this.store.updateMission(runId, missionId, {
            status: "active",
            retryCount: nextRetry,
            error: `Rate limited (attempt ${nextRetry}/${settings.maxRetries}); backing off ${delayMs}ms`,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId,
            agentId,
            summary: `Rate-limited on ${missionId}; scheduled re-tick in ${delayMs}ms`,
          });
          this.scheduleBackoffWakeup();
        } else {
          await this.store.updateMission(runId, missionId, {
            status: "failed",
            retryCount: nextRetry,
            error: `Exceeded max retries (${settings.maxRetries}) after rate limiting: ${reason}`,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId,
            agentId,
            summary: `Mission ${missionId} failed after rate-limit retries`,
          });
          this.emitEvent("wakeup_needed", {
            runId,
            missionId,
            agentId,
            summary: `Mission ${missionId} failed after ${settings.maxRetries} rate-limit retries: ${reason}`,
          });
          this.scheduleBackoffWakeup();
        }
        return;
      }

      // ----------------------------------------------------------------------
      // Outcome: aborted (non-human)
      // ----------------------------------------------------------------------
      if (result.outcome === "aborted") {
        if (run.status === "active" && mission.status === "active") {
          await this.store.updateMission(runId, missionId, {
            status: "stopped",
            error: result.error ?? "Aborted",
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
        }
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Worker ${entry.name} aborted`,
        });
        return;
      }

      // ----------------------------------------------------------------------
      // Outcome: failed
      // ----------------------------------------------------------------------
      if (result.outcome === "failed") {
        // Kill failed handle so retry launches cleanly on fresh session
        await this.killHandleEntry(runId, entry, "Worker turn failed");
        const errMsg = result.error ?? "Worker failed without details";
        const nextRetry = mission.retryCount + 1;

        if (nextRetry <= settings.maxRetries) {
          await this.store.updateMission(runId, missionId, {
            status: "active",
            retryCount: nextRetry,
            error: `Retry ${nextRetry}/${settings.maxRetries}: ${errMsg}`,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          this.pendingFixInstructions.set(
            missionId,
            `Previous worker attempt failed with error: ${errMsg}. Inspect the worktree state, recover cleanly, and complete the mission.`,
          );
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId,
            agentId,
            summary: `Worker failed on ${missionId}; scheduling retry ${nextRetry}/${settings.maxRetries}`,
          });
          this.scheduleTick();
        } else {
          await this.store.updateMission(runId, missionId, {
            status: "failed",
            retryCount: nextRetry,
            error: errMsg,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId,
            agentId,
            summary: `Mission ${missionId} failed`,
          });
          this.emitEvent("wakeup_needed", {
            runId,
            missionId,
            agentId,
            summary: `Mission ${missionId} ("${mission.title}") failed after ${settings.maxRetries} retries: ${errMsg}`,
          });
          this.scheduleTick();
        }
        return;
      }

      // ----------------------------------------------------------------------
      // Outcome: completed -> enforce post-worker kind gates!
      // ----------------------------------------------------------------------
      if (!this.rateLimitBreaker.isBackedOff()) {
        this.rateLimitBreaker.recordSuccess();
      }
      this.autoMergeBlockedByMission.delete(missionId);

      if (mission.kind === "survey") {
        const dirty = await this.worktree.isWorktreeDirty(mission.worktreePath);
        const commitsAhead = await this.worktree.getCommitCountAhead(
          run.baseBranch,
          mission.branch,
          mission.worktreePath,
        );
        const changedFiles = await this.worktree.getChangedFiles(
          run.baseBranch,
          mission.branch,
          mission.worktreePath,
        );
        if (dirty || commitsAhead > 0 || changedFiles.length > 0) {
          const msg = `[SURVEY_HAS_DIFF] Survey mission ${missionId} must produce zero diff (dirty=${dirty}, commitsAhead=${commitsAhead}, changedFiles=${changedFiles.length}).`;
          await this.store.updateMission(runId, missionId, {
            status: "failed",
            error: msg,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", { runId, missionId, agentId, summary: msg });
          this.emitEvent("wakeup_needed", { runId, missionId, agentId, summary: msg });
          this.scheduleTick();
          return;
        }

        await this.store.updateMission(runId, missionId, {
          status: "completed",
          progressSummary: result.summary,
          error: null,
          callerRole: "orchestrator",
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        await this.postBoardInternal(
          runId,
          {
            from: entry.name,
            fromRole: "worker",
            kind: "done",
            missionId,
            text: `@${ORCHESTRATOR_BOARD_NAME} [done] ${missionId} (survey): ${result.summary.slice(0, 200)}`,
          },
          { routePeers: false },
        );
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Survey ${missionId} completed`,
        });
        this.enqueueAutoMerge(runId, missionId, "survey-zero-diff");
        return;
      }

      // build & artifact both require: clean worktree, >=1 commit ahead, diff inside scope!
      const validationFailure = await this.validateCommittedWork(run, mission);
      if (validationFailure) {
        await this.handleValidationFailure(runId, run, mission, entry, validationFailure);
        return;
      }

      const tipSha = await this.worktree.getHeadSha(mission.worktreePath);

      // Post [done] handoff on the shared board BEFORE flipping mission to completed so
      // observers see the board handoff immediately once status === "completed".
      const doneTarget =
        mission.kind === "build" && run.validatorEnabled
          ? `@validator-${mission.id}`
          : `@${ORCHESTRATOR_BOARD_NAME}`;
      await this.postBoardInternal(
        runId,
        {
          from: entry.name,
          fromRole: "worker",
          kind: "done",
          missionId,
          text: `${doneTarget} [done] ${mission.id} ("${mission.title}") @ ${tipSha.slice(0, 12)}: ${result.summary.slice(0, 200)}`,
        },
        { routePeers: false },
      );

      await this.store.updateMission(runId, missionId, {
        status: "completed",
        progressSummary: result.summary,
        error: null,
        callerRole: "orchestrator",
        actor: ORCHESTRATOR_BOARD_NAME,
      });

      await this.refreshState(runId);
      this.emitEvent("snapshot_changed", {
        runId,
        missionId,
        agentId,
        summary: `Mission ${missionId} ready (${mission.kind === "artifact" ? "awaiting human approval" : run.validatorEnabled ? "awaiting validation" : "ready to merge"})`,
      });

      if (mission.kind === "artifact") {
        this.emitEvent("wakeup_needed", {
          runId,
          missionId,
          agentId,
          summary: `Artifact mission ${missionId} ("${mission.title}") is committed and awaiting explicit human approval (/swarm approve ${missionId}).`,
        });
        this.drainPendingBoardWakes(runId, entry);
        this.scheduleTick();
        return;
      }

      // mission.kind === "build"
      if (run.validatorEnabled) {
        this.drainPendingBoardWakes(runId, entry);
        this.scheduleTick();
      } else if (settings.autoMergeClean) {
        this.enqueueAutoMerge(runId, missionId, tipSha);
      } else {
        this.emitEvent("wakeup_needed", {
          runId,
          missionId,
          agentId,
          summary: `Build mission ${missionId} ("${mission.title}") is ready to merge (autoMergeClean is disabled).`,
        });
        this.drainPendingBoardWakes(runId, entry);
        this.scheduleTick();
      }
    } catch (err) {
      this.emitEvent("error", {
        runId,
        missionId,
        agentId,
        summary: `Error handling worker completion for ${missionId}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      releaseFallbackReservation();
    }
  }

  private async validateCommittedWork(run: SwarmRunState, mission: MissionRecord): Promise<string | null> {
    const dirty = await this.worktree.isWorktreeDirty(mission.worktreePath);
    if (dirty) {
      return `Worktree "${mission.worktreePath}" has uncommitted or untracked changes. Commit all intended changes (or clean untracked files) so \`git status --porcelain\` is empty.`;
    }
    const commitsAhead = await this.worktree.getCommitCountAhead(
      run.baseBranch,
      mission.branch,
      mission.worktreePath,
    );
    if (commitsAhead < 1) {
      return `Branch "${mission.branch}" has zero commits ahead of "${run.baseBranch}". Commit your changes on "${mission.branch}" before finishing.`;
    }
    const changedFiles = await this.worktree.getChangedFiles(
      run.baseBranch,
      mission.branch,
      mission.worktreePath,
    );
    const outOfScope = findOutOfScopeFiles(changedFiles, mission.scope);
    if (outOfScope.length > 0) {
      return `Committed diff touches files outside declared scope [${mission.scope.join(", ")}]: ${outOfScope.join(", ")}. Revert out-of-scope edits and commit cleanly inside your declared scope.`;
    }
    return null;
  }

  private async handleValidationFailure(
    runId: string,
    run: SwarmRunState,
    mission: MissionRecord,
    entry: LiveAgentEntry,
    reason: string,
  ): Promise<void> {
    const settings = this.getSettings();
    const nextRetry = mission.retryCount + 1;
    if (nextRetry <= settings.maxRetries) {
      await this.store.updateMission(runId, mission.id, {
        status: "active",
        retryCount: nextRetry,
        error: reason,
        callerRole: "orchestrator",
        actor: ORCHESTRATOR_BOARD_NAME,
      });

      const repairBoardMsg = await this.postBoardInternal(
        runId,
        {
          from: ORCHESTRATOR_BOARD_NAME,
          fromRole: "orchestrator",
          kind: "fix",
          missionId: mission.id,
          text: `@${mission.id} [repair ${nextRetry}/${settings.maxRetries}] ${reason} Fix cleanly, commit, and call ${SWARM_WORKER_DONE_TOOL}.`,
        },
        { routePeers: false },
      );

      // Wake warm Worker directly if parked in waiting state!
      const maxSlots = Math.max(1, run.maxConcurrency || settings.maxConcurrency);
      if (
        run.keepWorkersWarm &&
        !entry.killed &&
        !entry.working &&
        entry.handle.getState() === "waiting" &&
        !this.rateLimitBreaker.isBackedOff() &&
        this.getWorkingCount() < maxSlots
      ) {
        const repairPrompt = `Repair required for mission ${mission.id} ("${mission.title}") on branch \`${mission.branch}\` (board #${repairBoardMsg.seq}):\n\n${reason}\n\nResolve the issue cleanly, ensure verification passes and git status is clean, and finish by calling \`${SWARM_WORKER_DONE_TOOL}\`.`;
        await this.wakeAgent(runId, entry, repairPrompt, {
          turnKind: "mission",
          reason: `post-completion repair ${nextRetry}/${settings.maxRetries}`,
          boardHead: repairBoardMsg.seq,
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        return;
      }

      this.pendingFixInstructions.set(mission.id, reason);
      await this.refreshState(runId);
      this.emitEvent("snapshot_changed", {
        runId,
        missionId: mission.id,
        agentId: entry.agentId,
        summary: `Post-completion check failed for ${mission.id}; requesting repair (${nextRetry}/${settings.maxRetries})`,
      });
      this.scheduleTick();
    } else {
      await this.store.updateMission(runId, mission.id, {
        status: "failed",
        retryCount: nextRetry,
        error: reason,
        callerRole: "orchestrator",
        actor: ORCHESTRATOR_BOARD_NAME,
      });
      await this.refreshState(runId);
      this.emitEvent("snapshot_changed", {
        runId,
        missionId: mission.id,
        agentId: entry.agentId,
        summary: `Mission ${mission.id} escalated after validation failures`,
      });
      this.emitEvent("wakeup_needed", {
        runId,
        missionId: mission.id,
        agentId: entry.agentId,
        summary: `Mission ${mission.id} ("${mission.title}") failed post-completion checks: ${reason}`,
      });
      this.scheduleTick();
    }
  }

  private async handleValidatorTurnComplete(
    runId: string,
    missionId: string,
    entry: LiveAgentEntry,
    reviewedSha: string,
    result: AgentTurnResult,
    turnKind: ActiveTurnKind,
  ): Promise<void> {
    const agentId = entry.agentId;

    let preRecordedDelayMs: number | undefined;
    const isRateLimited =
      result.outcome === "rate_limited" &&
      !this.humanStoppedAgents.has(agentId) &&
      !this.humanStoppedMissions.has(missionId);
    const hasFallback = isRateLimited && this.canAttemptQuotaFallback(entry, result);

    if (isRateLimited && !hasFallback) {
      const reason = result.error ?? "Validator hit provider rate limit (HTTP 429)";
      preRecordedDelayMs = this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
    }

    entry.working = false;
    if (result.model) {
      entry.model = result.model;
    }
    let fallbackReservationHeld = hasFallback;
    if (fallbackReservationHeld) {
      entry.switchingModel = true;
    } else if (this.missionWorkingAgent.get(missionId) === agentId) {
      this.missionWorkingAgent.delete(missionId);
    }

    const releaseFallbackReservation = (): void => {
      if (!fallbackReservationHeld) {
        return;
      }
      fallbackReservationHeld = false;
      entry.switchingModel = false;
      if (!entry.working && this.missionWorkingAgent.get(missionId) === agentId) {
        this.missionWorkingAgent.delete(missionId);
      }
    };

    try {
      const settings = this.getSettings();
      const run = await this.store.loadRun(runId);
      const mission = run.missions[missionId];
      if (!mission) {
        return;
      }

      const rosterEntry = run.roster[agentId];
      const wasHumanStopped =
        this.humanStoppedAgents.has(agentId) ||
        this.humanStoppedMissions.has(missionId) ||
        mission.humanStopped ||
        Boolean(rosterEntry?.humanStopped);

      if (result.outcome === "rate_limited" && !wasHumanStopped && hasFallback) {
        const switched = await this.tryQuotaFallbackSwitch(runId, run, entry, result, {
          turnKind,
          reviewedSha,
          resumePrompt: `Your model was switched to a fallback model after a rate-limit/quota error. Resume auditing mission ${missionId}@${reviewedSha.slice(0, 12)} and submit your verdict via \`${SWARM_REVIEW_VERDICT_TOOL}\`.`,
        });
        if (switched) {
          fallbackReservationHeld = false;
          return;
        }
        releaseFallbackReservation();
        const reason = result.error ?? "Validator hit provider rate limit (HTTP 429)";
        preRecordedDelayMs = this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
      } else {
        releaseFallbackReservation();
      }

      const handleState = entry.handle.getState();
      const keptWarmWaiting =
        !wasHumanStopped &&
        !entry.killed &&
        run.keepWorkersWarm &&
        result.outcome === "completed" &&
        handleState === "waiting";

      const nextRosterStatus: RosterAgentStatus = wasHumanStopped
        ? "stopped"
        : entry.killed || handleState === "killed"
          ? "killed"
          : keptWarmWaiting
            ? "waiting"
            : result.outcome === "completed" && (result.reviewVerdict || turnKind === "board_peer")
              ? "stopped"
              : result.outcome === "aborted"
                ? "stopped"
                : "failed";

      if (rosterEntry) {
        await this.store.updateRoster(runId, agentId, {
          status: nextRosterStatus,
          humanStopped: wasHumanStopped,
          model: entry.model,
          turns: entry.turns,
          lastReadBoardSeq: entry.lastReadBoardSeq,
          endedAt: keptWarmWaiting ? null : new Date(this.now()).toISOString(),
          tokens: result.tokens,
          tokenBreakdown: result.tokenBreakdown,
          cost: result.cost,
          currentActivity: result.reviewVerdict
            ? `verdict: ${result.reviewVerdict.status} (${result.reviewVerdict.merge})`
            : keptWarmWaiting
              ? "waiting (warm)"
              : result.error ?? result.outcome,
          error: result.error ?? null,
        });
      }

      if (wasHumanStopped) {
        this.humanStoppedAgents.delete(agentId);
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Validator ${entry.name} stopped by human; will not auto-restart`,
        });
        this.scheduleTick();
        return;
      }

      // If woken solely to answer a peer board question, return quietly to warm waiting state!
      if (turnKind === "board_peer" && !result.reviewVerdict) {
        await this.refreshState(runId);
        this.drainPendingBoardWakes(runId, entry);
        return;
      }

      if (this.disposed || entry.killed || mission.status !== "completed") {
        await this.refreshState(runId);
        return;
      }

      if (result.outcome === "rate_limited") {
        const reason = result.error ?? "Validator hit provider rate limit (HTTP 429)";
        const delayMs =
          preRecordedDelayMs ?? this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
        await this.store.appendEvent({
          runId,
          type: "rate_limit_backoff",
          actor: ORCHESTRATOR_BOARD_NAME,
          missionId,
          agentId,
          summary: `Validator rate-limited on ${missionId}; fleet backing off ${delayMs}ms`,
        });
        const nextRetry = mission.retryCount + 1;
        if (nextRetry <= settings.maxRetries) {
          await this.store.updateMission(runId, missionId, {
            retryCount: nextRetry,
            error: `Validator rate-limited; backing off ${delayMs}ms`,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId,
            agentId,
            summary: `Validator rate-limited on ${missionId}; backoff ${delayMs}ms`,
          });
          this.scheduleBackoffWakeup();
        } else {
          await this.store.updateMission(runId, missionId, {
            status: "failed",
            retryCount: nextRetry,
            error: `Validator exceeded max retries after rate limiting: ${reason}`,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("wakeup_needed", {
            runId,
            missionId,
            agentId,
            summary: `Validator for ${missionId} exceeded max retries after rate limiting: ${reason}`,
          });
          this.scheduleBackoffWakeup();
        }
        return;
      }

      if (result.outcome !== "completed" || !result.reviewVerdict) {
        const errMsg = result.error ?? `Validator exited without calling ${SWARM_REVIEW_VERDICT_TOOL}`;
        const nextRetry = mission.retryCount + 1;
        if (result.outcome !== "aborted" && nextRetry <= settings.maxRetries) {
          await this.store.updateMission(runId, missionId, {
            retryCount: nextRetry,
            error: errMsg,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId,
            agentId,
            summary: `Validator failed on ${missionId}; retrying (${nextRetry}/${settings.maxRetries})`,
          });
          this.scheduleTick();
        } else {
          await this.store.updateMission(runId, missionId, {
            status: "failed",
            retryCount: nextRetry,
            error: errMsg,
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", { runId, missionId, agentId, summary: errMsg });
          this.emitEvent("wakeup_needed", {
            runId,
            missionId,
            agentId,
            summary: `Independent validation failed for ${missionId}: ${errMsg}`,
          });
          this.scheduleTick();
        }
        return;
      }

      if (!this.rateLimitBreaker.isBackedOff()) {
        this.rateLimitBreaker.recordSuccess();
      }

      // Safety Check 1: Read-only Validator must NEVER have dirtied the worktree!
      const validatorDirtied = await this.worktree.isWorktreeDirty(mission.worktreePath);
      if (validatorDirtied) {
        const msg = `[DIRTY_WORKTREE] Read-only validator ${entry.name} left uncommitted changes in ${mission.worktreePath}. Refusing merge!`;
        await this.store.updateMission(runId, missionId, {
          status: "failed",
          error: msg,
          callerRole: "orchestrator",
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        await this.refreshState(runId);
        this.emitEvent("error", { runId, missionId, agentId, summary: msg });
        this.emitEvent("wakeup_needed", { runId, missionId, agentId, summary: msg });
        return;
      }

      // Safety Check 2: Mission branch tip SHA must STILL equal reviewedSha (no stale race!)
      const currentTipSha = await this.worktree.getHeadSha(mission.worktreePath);
      if (currentTipSha !== reviewedSha) {
        await this.store.appendEvent({
          runId,
          type: "validation_submitted",
          actor: entry.name,
          missionId,
          agentId,
          summary: `Discarded stale validation for ${missionId}@${reviewedSha.slice(0, 12)} (tip moved to ${currentTipSha.slice(0, 12)}); re-queuing validation`,
          data: { stale: true, reviewedSha, currentTipSha },
        });
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Tip moved during validation of ${missionId}; scheduling fresh validation`,
        });
        this.scheduleTick();
        return;
      }

      const verdict: MissionReviewVerdict = {
        ...result.reviewVerdict,
        commitSha: reviewedSha,
        missionId: mission.id,
        branch: mission.branch,
        reviewerAgentId: agentId,
        reviewedAt: result.reviewVerdict.reviewedAt || new Date(this.now()).toISOString(),
        round: mission.reviewRound + 1,
      };

      // store.recordReview records the verdict, auto-appends validation_submitted,
      // and automatically flips completed -> active if non-clean!
      const updatedRun = await this.store.recordReview(runId, missionId, verdict);

      if (verdict.status === "clean" && verdict.merge === "merge") {
        await this.postBoardInternal(
          runId,
          {
            from: entry.name,
            fromRole: "validator",
            kind: "review",
            missionId,
            text: `@${ORCHESTRATOR_BOARD_NAME} [review r${verdict.round}] clean (merge) @ ${reviewedSha.slice(0, 12)}: ${verdict.decision}`,
          },
          { routePeers: false },
        );

        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Validation for ${missionId}: ${verdict.status} (${verdict.merge})`,
        });

        this.autoMergeBlockedByMission.delete(missionId);
        if (settings.autoMergeClean) {
          this.enqueueAutoMerge(runId, missionId, reviewedSha);
        } else {
          this.emitEvent("wakeup_needed", {
            runId,
            missionId,
            agentId,
            summary: `Mission ${missionId} passed independent validation (${verdict.status}); ready for merge.`,
          });
          this.scheduleTick();
        }
        return;
      }

      // Non-clean verdict (`fix-then-merge` or `hold`)
      const updatedMission = updatedRun.missions[missionId]!;

      if (verdict.merge === "hold") {
        await this.postBoardInternal(
          runId,
          {
            from: entry.name,
            fromRole: "validator",
            kind: "review",
            missionId,
            text: `@${ORCHESTRATOR_BOARD_NAME} [review r${verdict.round}] ${verdict.status} (hold): ${verdict.decision}`,
          },
          { routePeers: false },
        );
        await this.store.updateMission(runId, missionId, {
          status: "failed",
          error: `Validator HOLD (${verdict.status}): ${verdict.decision}`,
          callerRole: "orchestrator",
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Mission ${missionId} placed on HOLD by validator`,
        });
        this.emitEvent("wakeup_needed", {
          runId,
          missionId,
          agentId,
          summary: `Validator placed mission ${missionId} ("${mission.title}") on HOLD: ${verdict.decision}`,
        });
        this.scheduleTick();
        return;
      }

      // Post @<M1> fix-then-merge review feedback on the shared board!
      const reviewBoardMsg = await this.postBoardInternal(
        runId,
        {
          from: entry.name,
          fromRole: "validator",
          kind: "review",
          missionId,
          text: formatVerdictBoardPost(missionId, verdict),
        },
        { routePeers: false },
      );

      if (updatedMission.reviewRound <= updatedRun.maxValidationRounds) {
        if (updatedMission.status !== "active") {
          await this.store.updateMission(runId, missionId, {
            status: "active",
            callerRole: "orchestrator",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
        }

        // Warm Peer-to-Peer Fix Loop: wake the EXACT SAME warm Worker handle if parked in waiting state!
        const maxSlots = Math.max(1, updatedRun.maxConcurrency || settings.maxConcurrency);
        const warmWorker = updatedRun.keepWorkersWarm
          ? this.getWarmWorkerForMission(missionId)
          : undefined;

        if (
          warmWorker &&
          !this.humanStoppedMissions.has(missionId) &&
          !this.humanStoppedAgents.has(warmWorker.agentId) &&
          !this.rateLimitBreaker.isBackedOff() &&
          this.getWorkingCount() < maxSlots
        ) {
          const wakePrompt = formatValidationWakePrompt(
            updatedMission,
            verdict,
            reviewBoardMsg.seq,
          );
          await this.wakeAgent(runId, warmWorker, wakePrompt, {
            turnKind: "mission",
            reason: `validation r${updatedMission.reviewRound} (#${reviewBoardMsg.seq})`,
            boardHead: reviewBoardMsg.seq,
            actor: entry.name,
          });
          return;
        }

        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Validation requested fixes on ${missionId} (round ${updatedMission.reviewRound}/${updatedRun.maxValidationRounds}); scheduling worker`,
        });
        this.scheduleTick();
      } else {
        const msg = `Mission ${missionId} exceeded max validation rounds (${updatedRun.maxValidationRounds}). Last verdict: ${verdict.status} — ${verdict.decision}`;
        await this.store.updateMission(runId, missionId, {
          status: "failed",
          error: msg,
          callerRole: "orchestrator",
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId,
          agentId,
          summary: `Mission ${missionId} escalated after exceeding max validation rounds`,
        });
        this.emitEvent("wakeup_needed", {
          runId,
          missionId,
          agentId,
          summary: msg,
        });
        this.scheduleTick();
      }
    } catch (err) {
      this.emitEvent("error", {
        runId,
        missionId,
        agentId,
        summary: `Error handling validator completion for ${missionId}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      releaseFallbackReservation();
    }
  }

  private async handleFinalValidatorTurnComplete(
    runId: string,
    entry: LiveAgentEntry,
    auditedBaseSha: string,
    round: number,
    result: AgentTurnResult,
    turnKind: ActiveTurnKind,
  ): Promise<void> {
    const agentId = entry.agentId;

    let preRecordedDelayMs: number | undefined;
    const isRateLimited =
      result.outcome === "rate_limited" &&
      !this.humanStoppedAgents.has(agentId) &&
      !this.humanStoppedMissions.has(FINAL_AUDIT_MISSION_ID);
    const hasFallback = isRateLimited && this.canAttemptQuotaFallback(entry, result);

    if (isRateLimited && !hasFallback) {
      const reason = result.error ?? "Final Validator hit provider rate limit (HTTP 429)";
      preRecordedDelayMs = this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
    }

    entry.working = false;
    if (result.model) {
      entry.model = result.model;
    }
    let fallbackReservationHeld = hasFallback;
    if (fallbackReservationHeld) {
      entry.switchingModel = true;
    } else if (this.missionWorkingAgent.get(FINAL_AUDIT_MISSION_ID) === agentId) {
      this.missionWorkingAgent.delete(FINAL_AUDIT_MISSION_ID);
    }

    const releaseFallbackReservation = (): void => {
      if (!fallbackReservationHeld) {
        return;
      }
      fallbackReservationHeld = false;
      entry.switchingModel = false;
      if (!entry.working && this.missionWorkingAgent.get(FINAL_AUDIT_MISSION_ID) === agentId) {
        this.missionWorkingAgent.delete(FINAL_AUDIT_MISSION_ID);
      }
    };

    try {
      const settings = this.getSettings();
      const run = await this.store.loadRun(runId);
      const rosterEntry = run.roster[agentId];
      const wasHumanStopped =
        this.humanStoppedAgents.has(agentId) ||
        this.humanStoppedMissions.has(FINAL_AUDIT_MISSION_ID) ||
        Boolean(rosterEntry?.humanStopped);

      if (result.outcome === "rate_limited" && !wasHumanStopped && hasFallback) {
        const switched = await this.tryQuotaFallbackSwitch(runId, run, entry, result, {
          turnKind,
          finalAuditSha: auditedBaseSha,
          finalAuditRound: round,
          resumePrompt: `Your model was switched to a fallback model after a rate-limit/quota error. Resume final validation of ${run.baseBranch}@${auditedBaseSha.slice(0, 12)} and submit your verdict via \`${SWARM_FINAL_VERDICT_TOOL}\`.`,
        });
        if (switched) {
          fallbackReservationHeld = false;
          return;
        }
        releaseFallbackReservation();
        const reason = result.error ?? "Final Validator hit provider rate limit (HTTP 429)";
        preRecordedDelayMs = this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
      } else {
        releaseFallbackReservation();
      }

      const handleState = entry.handle.getState();
      const keptWarmWaiting =
        !wasHumanStopped &&
        !entry.killed &&
        run.keepWorkersWarm &&
        result.outcome === "completed" &&
        handleState === "waiting";

      const nextRosterStatus: RosterAgentStatus = wasHumanStopped
        ? "stopped"
        : entry.killed || handleState === "killed"
          ? "killed"
          : keptWarmWaiting
            ? "waiting"
            : result.outcome === "completed" && (result.finalAuditVerdict || turnKind === "board_peer")
              ? "stopped"
              : result.outcome === "aborted"
                ? "stopped"
                : "failed";

      if (rosterEntry) {
        await this.store.updateRoster(runId, agentId, {
          status: nextRosterStatus,
          humanStopped: wasHumanStopped,
          model: entry.model,
          turns: entry.turns,
          lastReadBoardSeq: entry.lastReadBoardSeq,
          endedAt: keptWarmWaiting ? null : new Date(this.now()).toISOString(),
          tokens: result.tokens,
          tokenBreakdown: result.tokenBreakdown,
          cost: result.cost,
          currentActivity: result.finalAuditVerdict
            ? `verdict: ${result.finalAuditVerdict.verdict} (${result.finalAuditVerdict.findings.length} findings)`
            : keptWarmWaiting
              ? "waiting (warm)"
              : result.error ?? result.outcome,
          error: result.error ?? null,
        });
      }

      if (
        this.disposed ||
        entry.killed ||
        run.status === "completed" ||
        run.status === "abandoned" ||
        run.finalAuditStatus === "skipped"
      ) {
        this.humanStoppedAgents.delete(agentId);
        await this.refreshState(runId);
        return;
      }

      if (wasHumanStopped) {
        this.humanStoppedAgents.delete(agentId);
        this.finalAuditBlockedSha = auditedBaseSha;
        if (run.status === "verifying" || run.finalAuditStatus === "running") {
          await this.store.updateRun(runId, {
            status: "active",
            finalAuditStatus: run.latestFinalAudit ? run.latestFinalAudit.verdict : "idle",
            actor: "human",
          });
        }
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId: FINAL_AUDIT_MISSION_ID,
          agentId,
          summary: `Final Validator ${agentId} stopped by human; will not auto-restart`,
        });
        return;
      }

      if (turnKind === "board_peer" && !result.finalAuditVerdict) {
        await this.refreshState(runId);
        this.drainPendingBoardWakes(runId, entry);
        return;
      }

      if (run.status === "paused") {
        await this.refreshState(runId);
        return;
      }

      // ----------------------------------------------------------------------
      // Outcome: rate_limited
      // ----------------------------------------------------------------------
      if (result.outcome === "rate_limited") {
        const reason = result.error ?? "Final Validator hit provider rate limit (HTTP 429)";
        const delayMs =
          preRecordedDelayMs ?? this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, reason);
        await this.store.appendEvent({
          runId,
          type: "rate_limit_backoff",
          actor: ORCHESTRATOR_BOARD_NAME,
          missionId: FINAL_AUDIT_MISSION_ID,
          agentId,
          summary: `Final Validator rate-limited; fleet backing off ${delayMs}ms (${reason})`,
          data: {
            delayMs,
            retryAfterMs: result.retryAfterMs,
            consecutiveFailures: this.rateLimitBreaker.getConsecutiveFailures(),
          },
        });

        this.finalAuditRetryCount += 1;
        if (this.finalAuditRetryCount <= settings.maxRetries) {
          await this.store.updateRun(runId, {
            status: "verifying",
            finalAuditStatus: "pending",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId: FINAL_AUDIT_MISSION_ID,
            agentId,
            summary: `Final Validator rate-limited; backing off ${delayMs}ms (retry ${this.finalAuditRetryCount}/${settings.maxRetries})`,
          });
          this.scheduleBackoffWakeup();
        } else {
          this.finalAuditBlockedSha = auditedBaseSha;
          await this.store.updateRun(runId, {
            status: "active",
            finalAuditStatus: run.latestFinalAudit ? run.latestFinalAudit.verdict : "pending",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId: FINAL_AUDIT_MISSION_ID,
            agentId,
            summary: "Final Validator exceeded max retries after rate limiting",
          });
          this.emitEvent("wakeup_needed", {
            runId,
            missionId: FINAL_AUDIT_MISSION_ID,
            agentId,
            summary: `Final Validator exceeded max retries (${settings.maxRetries}) after rate limiting: ${reason}. Run /swarm verify to retry or /swarm verify --skip.`,
          });
          this.scheduleBackoffWakeup();
        }
        return;
      }

      // ----------------------------------------------------------------------
      // Outcome: failed / aborted / missing verdict
      // ----------------------------------------------------------------------
      if (result.outcome !== "completed" || !result.finalAuditVerdict) {
        const errMsg =
          result.error ?? `Final Validator exited without calling ${SWARM_FINAL_VERDICT_TOOL}`;
        if (result.outcome === "aborted") {
          this.finalAuditBlockedSha = auditedBaseSha;
          await this.store.updateRun(runId, {
            status: "active",
            finalAuditStatus: run.latestFinalAudit ? run.latestFinalAudit.verdict : "pending",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId: FINAL_AUDIT_MISSION_ID,
            agentId,
            summary: `Final Validator ${agentId} aborted`,
          });
          return;
        }

        this.finalAuditRetryCount += 1;
        if (this.finalAuditRetryCount <= settings.maxRetries) {
          await this.store.updateRun(runId, {
            status: "verifying",
            finalAuditStatus: "pending",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId: FINAL_AUDIT_MISSION_ID,
            agentId,
            summary: `Final Validator failed; retrying (${this.finalAuditRetryCount}/${settings.maxRetries}): ${errMsg}`,
          });
          this.scheduleTick();
        } else {
          this.finalAuditBlockedSha = auditedBaseSha;
          await this.store.updateRun(runId, {
            status: "active",
            finalAuditStatus: run.latestFinalAudit ? run.latestFinalAudit.verdict : "pending",
            actor: ORCHESTRATOR_BOARD_NAME,
          });
          await this.refreshState(runId);
          this.emitEvent("snapshot_changed", {
            runId,
            missionId: FINAL_AUDIT_MISSION_ID,
            agentId,
            summary: errMsg,
          });
          this.emitEvent("wakeup_needed", {
            runId,
            missionId: FINAL_AUDIT_MISSION_ID,
            agentId,
            summary: `Final Validator failed after ${settings.maxRetries} retries: ${errMsg}. Run /swarm verify to retry or /swarm verify --skip.`,
          });
        }
        return;
      }

      if (!this.rateLimitBreaker.isBackedOff()) {
        this.rateLimitBreaker.recordSuccess();
      }
      this.finalAuditRetryCount = 0;

      // Safety Check 1: Read-only Final Validator must NEVER dirty baseBranch!
      const baseCheck = await this.worktree.isBaseCleanOnBranch(run.baseBranch);
      if (!baseCheck.ok) {
        const code = baseCheck.dirty ? "DIRTY_BASE" : "WRONG_BRANCH";
        const msg = `[${code}] Read-only Final Validator ${agentId} left base repo dirty or off "${run.baseBranch}" (${baseCheck.reason ?? baseCheck.currentBranch}). Rejecting verdict!`;
        this.finalAuditBlockedSha = auditedBaseSha;
        await this.store.updateRun(runId, {
          status: "active",
          finalAuditStatus: run.latestFinalAudit ? run.latestFinalAudit.verdict : "pending",
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        await this.refreshState(runId);
        this.emitEvent("error", {
          runId,
          missionId: FINAL_AUDIT_MISSION_ID,
          agentId,
          summary: msg,
        });
        this.emitEvent("wakeup_needed", {
          runId,
          missionId: FINAL_AUDIT_MISSION_ID,
          agentId,
          summary: `${msg} Clean the base checkout, then run /swarm verify (or /swarm verify --skip).`,
        });
        return;
      }

      // Safety Check 2: baseBranch HEAD SHA must still equal auditedBaseSha!
      const currentHeadSha = await this.worktree.getHeadSha(this.worktree.repoRoot);
      if (currentHeadSha !== auditedBaseSha) {
        await this.store.appendEvent({
          runId,
          type: "final_audit_result",
          actor: agentId,
          missionId: FINAL_AUDIT_MISSION_ID,
          agentId,
          summary: `Discarded stale Final Validator verdict for ${run.baseBranch}@${auditedBaseSha.slice(0, 12)} (HEAD moved to ${currentHeadSha.slice(0, 12)}); scheduling fresh audit`,
          data: { stale: true, auditedBaseSha, currentHeadSha },
        });
        await this.store.updateRun(runId, {
          status: "verifying",
          finalAuditStatus: "pending",
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        await this.refreshState(runId);
        this.emitEvent("snapshot_changed", {
          runId,
          missionId: FINAL_AUDIT_MISSION_ID,
          agentId,
          summary: `Base branch moved during final validation; scheduling fresh audit at ${currentHeadSha.slice(0, 12)}`,
        });
        this.scheduleTick();
        return;
      }

      // Record pinned verdict (SwarmStore.recordFinalAudit auto-emits final_audit_result)
      const verdict: FinalAuditVerdict = {
        ...result.finalAuditVerdict,
        commitSha: auditedBaseSha,
        baseBranch: run.baseBranch,
        verifierAgentId: agentId,
        auditedAt: result.finalAuditVerdict.auditedAt || new Date(this.now()).toISOString(),
        round,
      };

      const updatedRun = await this.store.recordFinalAudit(runId, verdict);
      const history = this.finalAuditHistory.get(runId) ?? [];
      history.push(verdict);
      this.finalAuditHistory.set(runId, history);

      await this.postBoardInternal(
        runId,
        {
          from: FINAL_VALIDATOR_BOARD_NAME,
          fromRole: "validator",
          kind: "review",
          text: `@${ORCHESTRATOR_BOARD_NAME} [final-audit r${verdict.round}] ${verdict.verdict} @ ${auditedBaseSha.slice(0, 12)}: ${verdict.summary}`,
        },
        { routePeers: false },
      );

      if (verdict.verdict === "approved") {
        this.finalAuditBlockedSha = null;
        this.finalAuditBlockedReason = null;
        await this.completeRun(runId, updatedRun, { agentId, auditVerdict: verdict });
        return;
      }

      // Verdict === "disapproved" -> Auto-Remediation or Park & Wakeup
      let autoFixRejectReason: string | undefined;
      if (
        updatedRun.autoFixOnAuditFail &&
        verdict.round < updatedRun.maxFinalAuditRounds &&
        verdict.recommendedMissions &&
        verdict.recommendedMissions.length > 0
      ) {
        const existingBranches = await this.worktree.listLocalBranches();
        const fixMissions = buildAutoFixMissionPlans(
          updatedRun,
          verdict.recommendedMissions,
          existingBranches,
        );
        const missingScopes = fixMissions.filter((m) => m.scope.length === 0);
        if (missingScopes.length > 0) {
          autoFixRejectReason = `Recommended fix mission(s) missing concrete scope: ${missingScopes.map((m) => m.id).join(", ")}`;
        } else {
          const validation = this.store.validatePlan(fixMissions, {
            existingMissions: updatedRun.missions,
            existingBranches,
            baseBranch: updatedRun.baseBranch,
          });
          if (!validation.valid) {
            autoFixRejectReason = validation.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
          } else {
            try {
              const afterAdd = await this.store.addMissions(runId, fixMissions, {
                existingBranches,
                actor: FINAL_VALIDATOR_BOARD_NAME,
              });
              if (afterAdd.status === "verifying" || afterAdd.finalAuditStatus !== "idle") {
                await this.store.updateRun(runId, {
                  status: "active",
                  finalAuditStatus: "idle",
                  actor: ORCHESTRATOR_BOARD_NAME,
                });
              }
              await this.store.appendEvent({
                runId,
                type: "final_audit_autofix_planned",
                actor: FINAL_VALIDATOR_BOARD_NAME,
                missionId: FINAL_AUDIT_MISSION_ID,
                agentId,
                summary: `Auto-planned ${fixMissions.length} fix mission(s) (${fixMissions.map((m) => m.id).join(", ")}) after Final Validator round ${verdict.round}`,
                data: {
                  round: verdict.round,
                  commitSha: auditedBaseSha,
                  missionIds: fixMissions.map((m) => m.id),
                },
              });
              await this.killHandleEntry(runId, entry, "Disapproved; spawning remediation wave");
              this.finalAuditBlockedSha = null;
              this.finalAuditBlockedReason = null;
              await this.refreshState(runId);
              this.emitEvent("snapshot_changed", {
                runId,
                missionId: FINAL_AUDIT_MISSION_ID,
                agentId,
                summary: `Final Validator round ${verdict.round} disapproved; auto-planned fix mission(s): ${fixMissions.map((m) => `${m.id} ("${m.title}")`).join(", ")}`,
              });
              this.scheduleTick();
              return;
            } catch (addErr) {
              autoFixRejectReason =
                addErr instanceof Error ? addErr.message : String(addErr);
            }
          }
        }
      } else if (!updatedRun.autoFixOnAuditFail) {
        autoFixRejectReason = "autoFixOnAuditFail is disabled";
      } else if (verdict.round >= updatedRun.maxFinalAuditRounds) {
        autoFixRejectReason = `reached maxFinalAuditRounds (${updatedRun.maxFinalAuditRounds})`;
      } else {
        autoFixRejectReason = "validator did not provide recommendedMissions";
      }

      // Park cleanly on auditedBaseSha with ZERO tight loop; wake orchestrator/human
      this.finalAuditBlockedSha = auditedBaseSha;
      await this.store.updateRun(runId, {
        status: "active",
        finalAuditStatus: "disapproved",
        actor: ORCHESTRATOR_BOARD_NAME,
      });
      await this.refreshState(runId);

      const findingsBrief =
        verdict.findings.length > 0
          ? verdict.findings
              .map((f) => {
                const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
                return `[${f.severity.toUpperCase()}] ${f.title}${loc}: ${f.detail}`;
              })
              .join(" | ")
          : "none listed";

      const summaryText = `Final Validator round ${verdict.round}/${updatedRun.maxFinalAuditRounds} DISAPPROVED ${run.baseBranch}@${auditedBaseSha.slice(0, 12)}: ${verdict.summary}`;
      this.emitEvent("snapshot_changed", {
        runId,
        missionId: FINAL_AUDIT_MISSION_ID,
        agentId,
        summary: summaryText,
      });
      this.emitEvent("wakeup_needed", {
        runId,
        missionId: FINAL_AUDIT_MISSION_ID,
        agentId,
        summary: `${summaryText}. Auto-remediation skipped (${autoFixRejectReason}). Findings: ${findingsBrief}. Next steps: add fix mission(s) via ${SWARM_PLAN_ADD_TOOL}, re-run verification via /swarm verify, or human may skip via /swarm verify --skip.`,
      });
    } catch (err) {
      this.emitEvent("error", {
        runId,
        missionId: FINAL_AUDIT_MISSION_ID,
        agentId,
        summary: `Error handling Final Validator result: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      releaseFallbackReservation();
    }
  }

  private enqueueAutoMerge(runId: string, missionId: string, tipSha: string): void {
    if (this.disposed || this.autoMergeInFlight.has(missionId)) {
      return;
    }
    const blocked = this.autoMergeBlockedByMission.get(missionId);
    if (blocked && blocked.tipSha === tipSha) {
      return;
    }

    this.autoMergeInFlight.add(missionId);
    void this.mergeMission(missionId, { callerRole: "orchestrator", actor: ORCHESTRATOR_BOARD_NAME })
      .then(() => {
        this.autoMergeInFlight.delete(missionId);
        this.autoMergeBlockedByMission.delete(missionId);
      })
      .catch((err) => {
        this.autoMergeInFlight.delete(missionId);
        const code = isSwarmProtocolError(err) ? err.code : "ERROR";
        this.autoMergeBlockedByMission.set(missionId, { tipSha, code });

        if (isSwarmProtocolError(err) && err.code === "REBASE_CONFLICT") {
          return;
        }
        const msg = isSwarmProtocolError(err)
          ? `[${err.code}] ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
        this.emitEvent("wakeup_needed", {
          runId,
          missionId,
          summary: `Auto-merge blocked for mission ${missionId}: ${msg}`,
        });
        this.scheduleTick();
      });
  }

  // ==========================================================================
  // Live Telemetry, Board Cache & State Helpers
  // ==========================================================================

  private handleTelemetry(runId: string, event: WorkerTelemetryEvent): void {
    if (this.disposed) {
      return;
    }

    if (event.logLine) {
      const tail = this.liveLogTails.get(event.agentId) ?? [];
      tail.push(event.logLine);
      if (tail.length > SWARM_LOG_TAIL_LIMIT) {
        tail.splice(0, tail.length - SWARM_LOG_TAIL_LIMIT);
      }
      this.liveLogTails.set(event.agentId, tail);
    }

    const liveEntry = this.handles.get(event.agentId);
    if (liveEntry && event.model) {
      liveEntry.model = event.model;
    }

    if (this.cachedRun && this.cachedRun.id === runId) {
      const entry = this.cachedRun.roster[event.agentId];
      if (entry) {
        if (event.model) {
          entry.model = event.model;
        }
        if (event.activity) {
          entry.currentActivity = event.activity;
        }
        if (event.toolName) {
          entry.lastTool = event.toolName;
        }
        if (event.tokens !== undefined) {
          entry.tokens = event.tokens;
        }
        if (event.tokenBreakdown) {
          entry.tokenBreakdown = event.tokenBreakdown;
        }
        if (event.cost !== undefined) {
          entry.cost = event.cost;
        }
        const liveTail = this.liveLogTails.get(event.agentId);
        if (liveTail) {
          entry.logTail = [...liveTail];
        }
      }
    }

    this.emitEvent("snapshot_changed", {
      runId,
      missionId: event.missionId,
      agentId: event.agentId,
      summary: event.activity ?? event.type,
    });

    if (
      event.type === "started" ||
      event.type === "woken" ||
      event.type === "model_switched" ||
      event.type === "tool_start" ||
      event.type === "turn_end" ||
      event.type === "rate_limit"
    ) {
      this.queueRosterUpdate(runId, event.agentId, {
        model: event.model,
        currentActivity: event.activity,
        lastTool: event.toolName,
        tokens: event.tokens,
        tokenBreakdown: event.tokenBreakdown,
        cost: event.cost,
        logLine: event.logLine,
      });
    }
  }

  private queueRosterUpdate(
    runId: string,
    agentId: string,
    patch: Parameters<ISwarmStore["updateRoster"]>[2],
  ): void {
    this.rosterWriteChain = this.rosterWriteChain
      .then(() => this.store.updateRoster(runId, agentId, patch))
      .then(
        () => {},
        () => {},
      );
  }

  private recordBoardMessageInCache(msg: BoardMessage): void {
    this.cachedBoardHead = Math.max(this.cachedBoardHead, msg.seq);
    if (!this.cachedRecentBoard.some((existing) => existing.seq === msg.seq)) {
      this.cachedRecentBoard.push(msg);
      if (this.cachedRecentBoard.length > 30) {
        this.cachedRecentBoard.splice(0, this.cachedRecentBoard.length - 30);
      }
    }
  }

  private recomputeUnreadOrchestratorCount(): void {
    let unread = 0;
    for (const msg of this.cachedRecentBoard) {
      if (msg.seq <= this.orchestratorReadBoardSeq) {
        continue;
      }
      if (msg.from.trim().toLowerCase() === ORCHESTRATOR_BOARD_NAME) {
        continue;
      }
      const mentions = getEffectiveMentions(msg).map((m) => m.toLowerCase());
      if (mentions.includes(ORCHESTRATOR_BOARD_NAME) || mentions.includes("all")) {
        unread += 1;
      }
    }
    this.unreadOrchestratorMessages = unread;
  }

  private async refreshState(runId: string): Promise<SwarmRunState | null> {
    try {
      const run = await this.store.loadRun(runId);
      for (const [agentId, liveTail] of this.liveLogTails.entries()) {
        const entry = run.roster[agentId];
        if (entry && liveTail.length > entry.logTail.length) {
          entry.logTail = [...liveTail];
        }
      }
      this.cachedRun = run;
      this.cachedRecentEvents = await this.store.getRecentEvents(runId, 20);

      const boardRes = await this.store.readBoard(runId, { limit: 30 }).catch(() => ({
        messages: this.cachedRecentBoard,
        head: this.cachedBoardHead,
      }));
      this.cachedBoardHead = boardRes.head;
      this.cachedRecentBoard = boardRes.messages;

      this.recomputeUnreadOrchestratorCount();
      return run;
    } catch {
      return this.cachedRun;
    }
  }

  private registerHandle(
    runId: string,
    missionId: string,
    role: RosterAgentRole,
    handle: PersistentAgentHandle,
    meta: { model?: string; thinkingLevel?: ThinkingLevel; boardCursor: number },
  ): LiveAgentEntry {
    const triedModels = new Set<string>();
    if (meta.model?.trim()) {
      triedModels.add(meta.model.trim());
    }
    const entry: LiveAgentEntry = {
      handle,
      agentId: handle.agentId,
      name: handle.name,
      runId,
      missionId,
      role,
      working: true,
      waking: false,
      switchingModel: false,
      killed: false,
      model: meta.model,
      thinkingLevel: meta.thinkingLevel,
      lastReadBoardSeq: meta.boardCursor,
      deliveredBoardSeqs: new Set<number>(),
      turns: 1,
      triedModels,
      pendingBoardWakes: [],
      startedAt: this.now(),
    };
    this.handles.set(handle.agentId, entry);
    this.handleByName.set(handle.name.toLowerCase(), handle.agentId);
    if (role === "worker") {
      this.workerHandleByMission.set(missionId, handle.agentId);
    } else if (role === "validator") {
      this.validatorHandleByMission.set(missionId, handle.agentId);
    }
    this.missionWorkingAgent.set(missionId, handle.agentId);
    return entry;
  }

  private unregisterHandle(entry: LiveAgentEntry): void {
    this.handles.delete(entry.agentId);
    if (this.handleByName.get(entry.name.toLowerCase()) === entry.agentId) {
      this.handleByName.delete(entry.name.toLowerCase());
    }
    if (this.workerHandleByMission.get(entry.missionId) === entry.agentId) {
      this.workerHandleByMission.delete(entry.missionId);
    }
    if (this.validatorHandleByMission.get(entry.missionId) === entry.agentId) {
      this.validatorHandleByMission.delete(entry.missionId);
    }
    if (this.missionWorkingAgent.get(entry.missionId) === entry.agentId) {
      this.missionWorkingAgent.delete(entry.missionId);
    }
  }

  private getWorkingCount(): number {
    let count = 0;
    for (const entry of this.handles.values()) {
      if (!entry.killed && (entry.working || entry.waking || entry.switchingModel)) {
        count += 1;
      }
    }
    return count;
  }

  private hasWorkingHandleForMission(missionId: string): boolean {
    for (const entry of this.handles.values()) {
      if (
        entry.missionId === missionId &&
        !entry.killed &&
        (entry.working || entry.waking || entry.switchingModel)
      ) {
        return true;
      }
    }
    return false;
  }

  private resolveTarget(
    run: SwarmRunState,
    agentNameOrId: string,
  ): { agentId?: string; missionId?: string; live?: LiveAgentEntry } {
    const query = agentNameOrId.trim();
    const queryLower = query.toLowerCase();

    // 1. Exact live agentId match
    const liveByAgent = this.handles.get(query);
    if (liveByAgent) {
      return {
        agentId: liveByAgent.agentId,
        missionId: liveByAgent.missionId,
        live: liveByAgent,
      };
    }

    // 2. Case-insensitive live board handle name match (e.g. "M1", "validator-M1", "final-validator")
    const liveIdByName = this.handleByName.get(queryLower);
    if (liveIdByName) {
      const live = this.handles.get(liveIdByName);
      if (live) {
        return {
          agentId: live.agentId,
          missionId: live.missionId,
          live,
        };
      }
    }

    // 3. Currently working agent for missionId
    const activeAgentForMission = this.missionWorkingAgent.get(query);
    if (activeAgentForMission) {
      const live = this.handles.get(activeAgentForMission);
      return {
        agentId: activeAgentForMission,
        missionId: query,
        live,
      };
    }

    // 4. Warm worker handle for missionId
    const warmWorkerId = this.workerHandleByMission.get(query);
    if (warmWorkerId) {
      const live = this.handles.get(warmWorkerId);
      if (live) {
        return {
          agentId: live.agentId,
          missionId: query,
          live,
        };
      }
    }

    // 5. Roster entry by exact agentId
    if (run.roster[query]) {
      return {
        agentId: query,
        missionId: run.roster[query]!.missionId,
      };
    }

    // 6. Roster entry by case-insensitive handle name (most recent first)
    const rosterByName = Object.values(run.roster)
      .filter((r) => r.name.toLowerCase() === queryLower)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (rosterByName[0]) {
      return {
        agentId: rosterByName[0].agentId,
        missionId: rosterByName[0].missionId,
      };
    }

    // 7. Mission ID (or final audit sentinel)
    if (run.missions[query] || query === FINAL_AUDIT_MISSION_ID) {
      const matching = Object.values(run.roster)
        .filter((r) => r.missionId === query)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return {
        agentId: matching[0]?.agentId,
        missionId: query,
      };
    }

    return {};
  }

  private resetPerRunTransientState(): void {
    this.autoMergeInFlight.clear();
    this.autoMergeBlockedByMission.clear();
    this.peerBoardHopCount = 0;
    this.boardHopWarningEmitted = false;
    this.cachedBoardHead = 0;
    this.cachedRecentBoard = [];
    this.orchestratorReadBoardSeq = 0;
    this.unreadOrchestratorMessages = 0;
    this.clearFinalAuditBlockState();
  }

  private clearFinalAuditBlockState(): void {
    this.finalAuditBlockedSha = null;
    this.finalAuditBlockedReason = null;
    this.finalAuditRetryCount = 0;
    this.finalAuditRetrySha = null;
    this.humanStoppedMissions.delete(FINAL_AUDIT_MISSION_ID);
  }

  private scheduleBackoffWakeup(): void {
    if (this.disposed) {
      return;
    }
    const remaining = this.rateLimitBreaker.getRemainingMs();
    if (remaining <= 0) {
      this.scheduleTick();
      return;
    }
    this.clearBackoffTimer();
    const waitMs = Math.max(10, remaining + 15);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.scheduleTick();
    }, waitMs);
  }

  private clearBackoffTimer(): void {
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private syncBreakerConfig(): void {
    const settings = this.getSettings();
    this.rateLimitBreaker.configure({
      baseBackoffMs: settings.rateLimitBaseBackoffMs,
      maxBackoffMs: settings.rateLimitMaxBackoffMs,
    });
  }

  private nextAgentId(role: RosterAgentRole, missionId: string): string {
    this.agentCounter += 1;
    if (role === "final-validator") {
      return `fv-final-${this.agentCounter}`;
    }
    const prefix = role === "validator" ? "v" : "w";
    return `${prefix}-${missionId}-${this.agentCounter}`;
  }

  private requireRunId(override?: string): string {
    const id = override ?? this.activeRunId;
    if (!id) {
      throw new SwarmProtocolError("NOT_FOUND", "No active Swarm run.");
    }
    return id;
  }

  private emitEvent(
    type: SwarmOrchestratorEventType,
    payload: { runId: string | null; missionId?: string; agentId?: string; summary: string },
  ): void {
    if (this.listeners.size === 0) {
      return;
    }
    const event: SwarmOrchestratorEvent = {
      type,
      runId: payload.runId,
      missionId: payload.missionId,
      agentId: payload.agentId,
      summary: payload.summary,
      snapshot: this.getSnapshot(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // isolate subscriber failures
      }
    }
  }
}

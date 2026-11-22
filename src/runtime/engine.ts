import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertOwnerSession, isPrototypeKey } from "../store/index.js";
import {
  ALL_MENTION_NAME,
  CHANNEL_NAME_PATTERN,
  DEFAULT_CHANNEL,
  DEFAULT_SWARM_SETTINGS,
  MEMBER_NAME_PATTERN,
  MONITOR_NAME,
  ORCHESTRATOR_NAME,
  RESERVED_MEMBER_NAMES,
  SWARM_BRANCH_PREFIX,
  SWARM_MAX_BOARD_HOPS,
} from "../constants.js";
import {
  type AddHelperInput,
  type AddMemberInput,
  type AgentTelemetryEvent,
  type AgentTurnResult,
  type AvailableModelInfo,
  type BoardMessage,
  type BoardMessageKind,
  type CallerRole,
  type CompleteRunOptions,
  type ISwarmEngine,
  type ISwarmStore,
  type ISwarmTransport,
  type IWorktreeManager,
  type KillMemberOptions,
  type ManageChannelInput,
  type ManageChannelResult,
  type MemberEngineBridge,
  type MergeBranchResult,
  type MergeMemberOptions,
  type ParkOrchestratorWaitOptions,
  type ParkOrchestratorWaitResult,
  type PersistentAgentHandle,
  type PostBoardMessageInput,
  type ReadBoardOptions,
  type ReadBoardResult,
  type SafeTeardownResult,
  type SafeTeardownTarget,
  type StopMemberOptions,
  type SwarmChannelRecord,
  type SwarmEngineEvent,
  type SwarmEngineEventType,
  type SwarmEvent,
  type SwarmMemberRecord,
  type SwarmMemberRole,
  type SwarmMemberStatusEntry,
  type SwarmModelRole,
  SwarmProtocolError,
  type SwarmRoleModels,
  type SwarmRosterStatus,
  type SwarmRunState,
  type SwarmSettings,
  type SwarmSnapshot,
  type SwarmWorkspaceMode,
  type SwitchModelOptions,
  type SwitchModelResult,
  type TeardownOptions,
  type TokenUsage,
  type WaitForBoardOptions,
  type WaitForBoardResult,
} from "../types.js";
import {
  ConcurrencyGate,
  RateLimitBreaker,
  selectFallbackModel,
} from "./rate-limit.js";
import {
  buildMemberInitialPrompt,
  buildMemberSystemPrompt,
  buildWakeupPrompt,
} from "./role-prompts.js";
import {
  extractSessionMessages,
  resolveRoleModel,
  sanitizeForkSeedMessages,
} from "./transport.js";

// ============================================================================
// Parsing & Helper Utilities
// ============================================================================

const RESERVED_SET: ReadonlySet<string> = new Set<string>(RESERVED_MEMBER_NAMES);

/** Matches `@<name>` handles (not emails, not `@@`, and NOT `@#channel`). */
const HANDLE_MENTION_RE =
  /(?<![A-Za-z0-9._%+@-])@(?!#)([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;

/** Matches `@#<channel>` channel broadcasts (1–32 chars starting with ASCII letter; not emails or `@@#`). */
const CHANNEL_MENTION_RE =
  /(?<![A-Za-z0-9._%+\-@])@#([A-Za-z](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?)/g;

const WAIT_TELEMETRY_RE = /^swarm_wait since=#(\d+) mentions_only=(true|false)$/;

const BOARD_CACHE_LIMIT = 200;
const EVENT_CACHE_LIMIT = 50;
const MAX_SHARD_COUNT = 32;

function parseHandleMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  HANDLE_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HANDLE_MENTION_RE.exec(text)) !== null) {
    const handle = match[1]!;
    const key = handle.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(handle);
    }
  }
  return out;
}

function parseChannelMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  CHANNEL_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHANNEL_MENTION_RE.exec(text)) !== null) {
    const ch = match[1]!.toLowerCase();
    if (!seen.has(ch)) {
      seen.add(ch);
      out.push(ch);
    }
  }
  return out;
}

function mergeUniqueLower(lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      const cleaned = raw.trim().replace(/^@#?/, "").toLowerCase();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function getOwnMember(
  run: SwarmRunState | null | undefined,
  name: string,
): SwarmMemberRecord | undefined {
  if (!run || !Object.hasOwn(run.members, name)) {
    return undefined;
  }
  return run.members[name];
}

function getOwnChannel(
  run: SwarmRunState | null | undefined,
  name: string,
): SwarmChannelRecord | undefined {
  if (!run || !Object.hasOwn(run.channels, name)) {
    return undefined;
  }
  return run.channels[name];
}

function validateMemberName(rawName: string): string {
  const name = rawName.trim();
  if (!name || !MEMBER_NAME_PATTERN.test(name)) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Invalid member name "${rawName}". Names must match ${MEMBER_NAME_PATTERN.source} (short lowercase alphanumeric/hyphen).`,
      { name: rawName },
    );
  }
  if (RESERVED_SET.has(name.toLowerCase())) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Member name "${name}" is reserved (${RESERVED_MEMBER_NAMES.join(", ")}).`,
      { name },
    );
  }
  if (isPrototypeKey(name)) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Member name "${name}" is a reserved prototype key.`,
      { name },
    );
  }
  return name;
}

function validateChannelName(rawName: string): string {
  const name = rawName.trim().toLowerCase();
  if (!name || !CHANNEL_NAME_PATTERN.test(name) || isPrototypeKey(name)) {
    throw new SwarmProtocolError(
      "INVALID_CHANNEL",
      `Invalid channel name "${rawName}". Channel names must match ${CHANNEL_NAME_PATTERN.source}.`,
      { channel: rawName },
    );
  }
  return name;
}

function isOrchestratorOrHuman(role: CallerRole | undefined): boolean {
  return role === undefined || role === "orchestrator" || role === "human";
}

function buildRoleModelsSnapshot(
  settings: SwarmSettings,
  runRoleModels?: SwarmRoleModels,
): SwarmRoleModels {
  return {
    orchestrator: {
      model: runRoleModels?.orchestrator?.model ?? settings.orchestratorModel,
      thinkingLevel:
        runRoleModels?.orchestrator?.thinkingLevel ?? settings.orchestratorThinkingLevel,
    },
    worker: {
      model: settings.workerModel ?? runRoleModels?.worker?.model,
      thinkingLevel: settings.workerThinkingLevel ?? runRoleModels?.worker?.thinkingLevel,
    },
    validator: {
      model: settings.validatorModel ?? runRoleModels?.validator?.model,
      thinkingLevel: settings.validatorThinkingLevel ?? runRoleModels?.validator?.thinkingLevel,
    },
    fallbackModels:
      settings.fallbackModels.length > 0
        ? [...settings.fallbackModels]
        : [...(runRoleModels?.fallbackModels ?? [])],
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function mergeTokenBreakdown(
  prior: TokenUsage | undefined,
  current: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!prior && !current) {
    return undefined;
  }
  return {
    input: (prior?.input ?? 0) + (current?.input ?? 0),
    output: (prior?.output ?? 0) + (current?.output ?? 0),
    cacheRead: (prior?.cacheRead ?? 0) + (current?.cacheRead ?? 0),
    cacheWrite: (prior?.cacheWrite ?? 0) + (current?.cacheWrite ?? 0),
    total: (prior?.total ?? 0) + (current?.total ?? 0),
  };
}

function sanitizeStallMentionsText(
  text: string,
  allowedMentions: readonly string[],
): string {
  const allowedLower = new Set(allowedMentions.map((m) => m.toLowerCase()));
  const allowCoordinatorAlias = allowedLower.has(ORCHESTRATOR_NAME);
  const kept = new Set<string>();
  const withoutSecondaryHandles = text.replace(
    HANDLE_MENTION_RE,
    (full, handle: string) => {
      const lower = handle.toLowerCase();
      const isAllowed =
        allowedLower.has(lower) || (allowCoordinatorAlias && lower === "coordinator");
      if (isAllowed && !kept.has(lower)) {
        kept.add(lower);
        return full;
      }
      return handle;
    },
  );
  return withoutSecondaryHandles.replace(CHANNEL_MENTION_RE, (_full, ch: string) => `#${ch}`);
}

// ============================================================================
// Internal Runtime Structures
// ============================================================================

interface LiveMember {
  name: string;
  agentId: string;
  role: SwarmMemberRole;
  handle?: PersistentAgentHandle;
  /** True while waiting for concurrency slot or spawning transport handle. */
  spawning: boolean;
  /** Synchronous lock while dispatching a wake/revive to prevent concurrent wake() races. */
  waking: boolean;
  /** True from turn launch through the end of handleTurnFinished (closes async post-turn race window). */
  turnActive: boolean;
  /** Synchronous lock while hot-switching models on a waiting session. */
  switchingModel: boolean;
  /** Whether this parked member only wakes on mentions (`true`) or any channel message (`false`). */
  parkedMentionsOnly: boolean;
  /** Board messages queued while spawning, waking, working, or switching models (coalesced on next wake). */
  pendingWakes: BoardMessage[];
  /** Sequence numbers already delivered to this member (prevents duplicate delivery). */
  deliveredSeqs: Set<number>;
  /** Models already attempted on this member (for quota fallback selection). */
  triedModels: Set<string>;
  /** Last known conversation snapshot (for forking even if session later pauses/stops). */
  lastMessages: AgentMessage[];
  /** Live telemetry log tail preserved across cache refreshes and persisted on turn end. */
  logTail: string[];
  /** Live last tool name preserved across cache refreshes. */
  lastTool?: string;
  /** Live activity description while working, preserved across cache refreshes. */
  currentActivity?: string;
  /** Latest swarm_wait request captured during current turn. */
  lastWaitRequest?: { since: number; mentionsOnly: boolean };
  /** Pending deferred self model switch scheduled by the member while working. */
  pendingSelfModelSwitch?: {
    model: string;
    thinkingLevel?: ThinkingLevel;
    reason?: string;
    callerName: string;
    callerRole: CallerRole;
  };
  /** AbortController for cancelling in-flight concurrency/backoff waits on stop/kill/dispose. */
  launchAbort?: AbortController;
  /** Per-attempt token to prevent cancelled launch/wake/revive coroutines from clobbering newer attempts. */
  attemptToken?: symbol;
  /** Active concurrency slot release callback, if currently holding a slot. */
  releaseSlot?: () => void;
  /** Number of consecutive automatic retries attempted after rate_limited turns. */
  retryCount: number;
  /** Timer handle for pending automatic rate-limit retry. */
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Cumulative tokens persisted from previous handles before revival. */
  priorHandlesTokens: number;
  /** Cumulative token breakdown persisted from previous handles before revival. */
  priorHandlesBreakdown?: TokenUsage;
  /** Cumulative cost persisted from previous handles before revival. */
  priorHandlesCost: number;
}

interface BoardWaiter {
  since: number;
  mentionsOnly: boolean;
  targetName: string;
  targetChannels: readonly string[];
  onProgress?: (summary: string) => void;
  resolve: (result: WaitForBoardResult) => void;
  cleanup: () => void;
}

// ============================================================================
// SwarmEngine Dependencies & Implementation
// ============================================================================

export interface SwarmEngineDeps {
  store: ISwarmStore;
  worktree: IWorktreeManager;
  transport: ISwarmTransport;
  settings?: Partial<SwarmSettings>;
  getSettings?: () => SwarmSettings;
  now?: () => number;
  generateAgentId?: (name: string) => string;
}

/**
 * Dynamic Antigravity Swarm execution engine (`ISwarmEngine`).
 *
 * Orchestrates:
 * - Dynamic member lifecycle (`addMembers` single / `n` / `tasks[]`, helpers, `fork`, `killMember`, `stopMember`)
 * - 3-role model resolution (`orchestrator` / `worker` / `validator`) + warm hot model switching (`switchModel`) + quota auto-fallback
 * - Shared Message Board & channels (`postMessage`, `readBoard`, `manageChannel`) with `@name`, `@prefix`, `@#channel`, `@all` wakeup routing, zero-drop coalescing, and hop-cap safety
 * - Blocking `waitForBoard` with anti-deadlock `all_idle` exit, `AbortSignal`, and live progress callbacks
 * - Zero-token Stall Watchdog timer posting `[stall]` from `monitor` when the swarm goes silent
 * - Isolated `share` / `branch` Git worktree provisioning, auto-rebase, merge, dirty-worktree guards, and safe teardown
 */
export class SwarmEngine implements ISwarmEngine {
  private readonly store: ISwarmStore;
  private readonly worktree: IWorktreeManager;
  private readonly transport: ISwarmTransport;
  private readonly staticSettings?: Partial<SwarmSettings>;
  private readonly getSettingsFn?: () => SwarmSettings;
  private readonly nowFn: () => number;
  private readonly generateAgentIdFn: (name: string) => string;

  private activeRunId: string | null = null;
  private cachedRun: SwarmRunState | null = null;
  private cachedBoard: BoardMessage[] = [];
  private cachedEvents: SwarmEvent[] = [];
  private hostContext?: ExtensionContext;

  private readonly liveMembers = new Map<string, LiveMember>();
  private readonly listeners = new Set<(event: SwarmEngineEvent) => void>();
  private readonly boardWaiters = new Set<BoardWaiter>();
  private readonly rateLimitBreaker: RateLimitBreaker;
  private readonly concurrencyGate: ConcurrencyGate;

  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private stallNoticePostedAtHead: number | null = null;
  private lastMonitorNudgeSeq: number | null = null;
  private monitorRunning = false;
  private activeMonitorHandle?: PersistentAgentHandle;
  private activeMonitorAbort?: AbortController;
  private monitorTokens = 0;
  private monitorCost = 0;
  private orchestratorWait: {
    since: number;
    mentionsOnly: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private runDonePosted = false;
  private boardHopCount = 0;
  private hopCapAlerted = false;
  private disposed = false;

  constructor(deps: SwarmEngineDeps) {
    this.store = deps.store;
    this.worktree = deps.worktree;
    this.transport = deps.transport;
    this.staticSettings = deps.settings;
    this.getSettingsFn = deps.getSettings;
    this.nowFn = deps.now ?? (() => Date.now());
    this.generateAgentIdFn =
      deps.generateAgentId ??
      ((name: string) => `${name}-${randomBytes(3).toString("hex")}`);

    const initialSettings = this.getEffectiveSettings();
    this.rateLimitBreaker = new RateLimitBreaker({
      baseBackoffMs: initialSettings.rateLimitBaseBackoffMs,
      maxBackoffMs: initialSettings.rateLimitMaxBackoffMs,
      now: this.nowFn,
    });
    this.concurrencyGate = new ConcurrencyGate(
      initialSettings.maxConcurrency,
      this.rateLimitBreaker,
    );
  }

  // --------------------------------------------------------------------------
  // Run Lifecycle (startRun / attachRun / setTitle / pause / resume / completeRun)
  // --------------------------------------------------------------------------

  async startRun(
    runId: string,
    hostContext?: ExtensionContext,
  ): Promise<SwarmRunState> {
    if (hostContext) {
      this.hostContext = hostContext;
    }
    const snapshot = await this.attachRun(runId, hostContext);
    if (!snapshot.run) {
      throw new SwarmProtocolError("NOT_FOUND", `Swarm run "${runId}" could not be loaded.`);
    }
    if (snapshot.run.status === "paused") {
      return this.resume(runId, hostContext);
    }
    if (snapshot.run.status === "active") {
      this.concurrencyGate.resume();
    }
    return snapshot.run;
  }

  async attachRun(
    runId: string | null,
    hostContext?: ExtensionContext,
  ): Promise<SwarmSnapshot> {
    if (hostContext) {
      this.hostContext = hostContext;
    }

    if (runId === null) {
      this.cancelStallWatchdog();
      await this.cancelActiveMonitor("Detached from Swarm run");
      this.clearOrchestratorWait("Detached from Swarm run.");
      this.resolveAllWaiters("run_ended", "Detached from Swarm run.");
      await this.disposeLiveHandles("Detached from Swarm run");
      this.activeRunId = null;
      this.cachedRun = null;
      this.cachedBoard = [];
      this.cachedEvents = [];
      this.runDonePosted = false;
      this.stallNoticePostedAtHead = null;
      this.lastMonitorNudgeSeq = null;
      this.boardHopCount = 0;
      this.hopCapAlerted = false;
      this.monitorTokens = 0;
      this.monitorCost = 0;
      const snap = this.getSnapshot();
      this.emitEngineEvent("snapshot_changed", "Detached from Swarm run.");
      return snap;
    }

    const isSameRun = this.activeRunId === runId;
    if (this.activeRunId && !isSameRun) {
      this.cancelStallWatchdog();
      await this.cancelActiveMonitor(`Switched focus to run ${runId}`);
      this.clearOrchestratorWait(`Switched focus to run ${runId}.`);
      this.resolveAllWaiters("run_ended", `Switched focus to run ${runId}.`);
      this.monitorTokens = 0;
      this.monitorCost = 0;
      await this.disposeLiveHandles("Switched active run");
    }

    let run = await this.store.loadRun(runId);

    // Crash/restart recovery: when attaching a run after a fresh process start (no live handles in memory),
    // normalize stale persisted `working` members to `stopped` so `@mention` revives them from disk `sessionFile`.
    if (!isSameRun && (run.status === "active" || run.status === "paused")) {
      for (const m of Object.values(run.members)) {
        if (m.state === "working" && !this.liveMembers.has(m.name)) {
          run = await this.store.updateMember(run.id, m.name, {
            state: "stopped",
            currentActivity: null,
            parkedOn: "stopped (reloaded; @mention to revive)",
          });
        }
      }
    }
    const boardRes = await this.store
      .readBoard(runId, { channel: "*", limit: BOARD_CACHE_LIMIT })
      .catch(() => ({ messages: [] as BoardMessage[], head: run.boardHead }));
    const events = await this.store
      .getRecentEvents(runId, EVENT_CACHE_LIMIT)
      .catch(() => [] as SwarmEvent[]);

    this.activeRunId = run.id;
    this.setCachedRun(run);
    this.cachedBoard = boardRes.messages;
    this.cachedEvents = events;
    this.runDonePosted = run.status === "completed" || run.status === "abandoned";
    if (!isSameRun) {
      this.stallNoticePostedAtHead = null;
      this.lastMonitorNudgeSeq = null;
      this.boardHopCount = 0;
      this.hopCapAlerted = false;
    }

    const settings = this.getEffectiveSettings();
    this.rateLimitBreaker.configure({
      baseBackoffMs: settings.rateLimitBaseBackoffMs,
      maxBackoffMs: settings.rateLimitMaxBackoffMs,
    });
    this.concurrencyGate.setMaxConcurrency(run.maxConcurrency || settings.maxConcurrency);
    if (run.status === "paused") {
      this.concurrencyGate.pause();
    } else {
      this.concurrencyGate.resume();
    }

    if (isSameRun && (run.status === "completed" || run.status === "abandoned")) {
      this.cancelStallWatchdog();
      await this.cancelActiveMonitor(`Swarm run ${run.status}`);
      this.clearOrchestratorWait(`Swarm run ${run.status}.`);
      this.resolveAllWaiters("run_ended", `Swarm run ${run.status}.`);
      await this.disposeLiveHandles(`Swarm run ${run.status}`);
    } else if (run.status === "active") {
      this.maybeArmStallWatchdog();
    }

    const snap = this.getSnapshot();
    this.emitEngineEvent("snapshot_changed", `Attached to Swarm run "${run.title}" (${run.id}).`);
    return snap;
  }

  async setTitle(
    title: string,
    options?: { callerRole?: CallerRole; actor?: string },
  ): Promise<SwarmRunState> {
    return this.updateDirection({ title }, options);
  }

  async updateDirection(
    patch: {
      title?: string;
      objective?: string;
      strategy?: string;
      acceptanceCriteria?: string;
    },
    options?: { callerRole?: CallerRole; actor?: string },
  ): Promise<SwarmRunState> {
    if (!isOrchestratorOrHuman(options?.callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${options?.callerRole}" is not allowed to change swarm title or direction.`,
      );
    }
    const run = this.requireActiveRun();
    const updatePatch: {
      title?: string;
      objective?: string;
      strategy?: string;
      acceptanceCriteria?: string;
      actor?: string;
    } = {
      actor: options?.actor ?? ORCHESTRATOR_NAME,
    };

    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      if (!trimmed) {
        throw new SwarmProtocolError("INVALID_INPUT", "Swarm title must be non-empty.");
      }
      updatePatch.title = trimmed;
    }
    if (patch.objective !== undefined) {
      const trimmed = patch.objective.trim();
      if (!trimmed) {
        throw new SwarmProtocolError("INVALID_INPUT", "Swarm objective must be non-empty.");
      }
      updatePatch.objective = trimmed;
    }
    if (patch.strategy !== undefined) {
      updatePatch.strategy = patch.strategy.trim();
    }
    if (patch.acceptanceCriteria !== undefined) {
      updatePatch.acceptanceCriteria = patch.acceptanceCriteria.trim();
    }

    const updated = await this.store.updateRun(run.id, updatePatch);
    await this.refreshCache(updated);
    this.emitEngineEvent("snapshot_changed", `Updated swarm "${updated.title}".`);
    return updated;
  }

  async pause(runId?: string, reason?: string): Promise<SwarmRunState> {
    const targetRunId = runId?.trim() || this.activeRunId;
    if (!targetRunId) {
      throw new SwarmProtocolError("NOT_FOUND", "No active Swarm run to pause.");
    }
    const targetRun = await this.store.loadRun(targetRunId);
    if (targetRun.status === "completed" || targetRun.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot pause a ${targetRun.status} Swarm run.`,
      );
    }

    // Non-focused run: update ONLY the store without touching active liveMembers/concurrencyGate/cachedRun
    if (targetRunId !== this.activeRunId) {
      let updated = await this.store.updateRun(targetRunId, {
        status: "paused",
        actor: ORCHESTRATOR_NAME,
      });
      for (const member of Object.values(updated.members)) {
        if (member.state === "working") {
          updated = await this.store.updateMember(targetRunId, member.name, {
            state: "stopped",
            ...(member.sessionFile ? { sessionFile: member.sessionFile } : {}),
            currentActivity: null,
            parkedOn: reason ?? "paused",
            actor: ORCHESTRATOR_NAME,
          });
        }
      }
      return updated;
    }

    // Focused run: synchronously disarm watchdog/gates/flags first so concurrent turn finishes cannot race
    if (this.cachedRun && this.cachedRun.id === targetRunId) {
      this.cachedRun.status = "paused";
    }
    this.cancelStallWatchdog();
    this.clearOrchestratorWait(reason ?? "Swarm run paused.");
    this.concurrencyGate.pause();
    this.resolveAllWaiters("run_ended", reason ?? "Swarm run paused.");

    for (const live of this.liveMembers.values()) {
      this.cancelMemberRetryTimer(live);
      live.launchAbort?.abort();
      live.attemptToken = undefined;
      live.spawning = false;
      live.waking = false;
      live.turnActive = false;
      live.switchingModel = false;
      live.pendingSelfModelSwitch = undefined;
      live.lastWaitRequest = undefined;
      live.currentActivity = undefined;
      live.pendingWakes.length = 0;
      live.releaseSlot?.();
      live.releaseSlot = undefined;
    }

    await this.cancelActiveMonitor(reason ?? "Swarm run paused");

    let updated = await this.store.updateRun(targetRunId, {
      status: "paused",
      actor: ORCHESTRATOR_NAME,
    });
    await this.refreshCache(updated);

    // Abort & dispose any working handles (or handles whose persisted member state is still working) in parallel
    const capturedSessionFiles = new Map<string, string>();
    const workingLives = Array.from(this.liveMembers.values()).filter(
      (live) =>
        Boolean(live.handle) &&
        (live.handle!.getState() === "working" ||
          getOwnMember(updated, live.name)?.state === "working"),
    );
    await Promise.all(
      workingLives.map(async (live) => {
        const handle = live.handle;
        if (!handle) {
          return;
        }
        await handle.abort(reason ?? "Swarm run paused").catch(() => {});
        await Promise.race([
          handle.currentTurn.catch(() => {}),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 250);
            t.unref?.();
          }),
        ]);
        live.lastMessages = sanitizeForkSeedMessages(handle.getConversationMessages());
        const sessionFile = handle.getSessionFile?.();
        if (sessionFile) {
          capturedSessionFiles.set(live.name, sessionFile);
        }
        await handle.kill("Paused").catch(() => {});
        live.handle = undefined;
      }),
    );

    for (const member of Object.values(updated.members)) {
      if (member.state === "working") {
        const sessionFile = capturedSessionFiles.get(member.name) ?? member.sessionFile;
        updated = await this.store.updateMember(targetRunId, member.name, {
          state: "stopped",
          ...(sessionFile ? { sessionFile } : {}),
          currentActivity: null,
          parkedOn: reason ?? "paused",
          actor: ORCHESTRATOR_NAME,
        });
      }
    }
    await this.refreshCache(updated);
    this.cancelStallWatchdog();
    this.emitEngineEvent("snapshot_changed", `Paused Swarm run ${targetRunId}.`);
    return updated;
  }

  async resume(
    runId?: string,
    hostContext?: ExtensionContext,
  ): Promise<SwarmRunState> {
    if (hostContext) {
      this.hostContext = hostContext;
    }
    const targetRunId = runId?.trim() || this.activeRunId;
    if (!targetRunId) {
      throw new SwarmProtocolError("NOT_FOUND", "No Swarm run specified to resume.");
    }
    const targetRun = await this.store.loadRun(targetRunId);
    if (targetRun.status === "completed" || targetRun.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot resume a ${targetRun.status} Swarm run.`,
      );
    }
    if (this.activeRunId !== targetRunId) {
      await this.attachRun(targetRunId, hostContext);
    }
    const updated = await this.store.updateRun(targetRunId, {
      status: "active",
      actor: ORCHESTRATOR_NAME,
    });
    this.runDonePosted = false;
    this.stallNoticePostedAtHead = null;
    this.lastMonitorNudgeSeq = null;
    this.boardHopCount = 0;
    this.hopCapAlerted = false;
    this.concurrencyGate.resume();
    await this.refreshCache(updated);
    this.maybeArmStallWatchdog();
    this.emitEngineEvent("snapshot_changed", `Resumed Swarm run ${targetRunId}.`);
    return updated;
  }

  async completeRun(options: CompleteRunOptions): Promise<SwarmRunState> {
    if (!isOrchestratorOrHuman(options.callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${options.callerRole}" is not allowed to complete the Swarm run.`,
      );
    }
    const summary = options.summary.trim();
    if (!summary) {
      throw new SwarmProtocolError("INVALID_INPUT", "Completion summary must be non-empty.");
    }
    const run = this.requireActiveRun();
    const currentRun = await this.store.loadRun(run.id);
    if (currentRun.status === "completed" || currentRun.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot complete a ${currentRun.status} Swarm run.`,
      );
    }
    const sid = options.sessionId?.trim();
    if (sid) {
      if (this.store.assertOwnerSession) {
        await this.store.assertOwnerSession(currentRun, sid);
      } else {
        assertOwnerSession(currentRun, sid);
      }
    }
    const actor = options.actor ?? ORCHESTRATOR_NAME;

    // Silence watchdog immediately and prevent any further wakes
    this.runDonePosted = true;
    this.cancelStallWatchdog();
    await this.cancelActiveMonitor("Run completed");
    this.clearOrchestratorWait("Run completed.");
    this.cancelStallWatchdog();

    // Post `[done] <summary>` (NO @mentions!) on board directly so Stall Watchdog stays quiet
    const safeSummary = summary.replace(/@(?=#?[A-Za-z0-9])/g, "");
    const doneMsg = await this.store.postBoardMessage(run.id, {
      from: actor,
      fromRole: options.callerRole ?? "orchestrator",
      channel: DEFAULT_CHANNEL,
      kind: "done",
      text: `[done] ${safeSummary}`,
      mentions: [],
      channelMentions: [],
    });
    this.recordBoardMessageInCache(doneMsg);
    this.emitEngineEvent("board_posted", `Posted completion #${doneMsg.seq}`, {
      seq: doneMsg.seq,
    });

    // Dispose all warm/live AgentSession handles cleanly (preserving worktrees safely!)
    await this.disposeLiveHandles("Run completed");

    // Mark any still-working or warm-waiting member records as stopped (0 active)
    const latestRun = await this.store.loadRun(run.id);
    const nowIso = new Date(this.nowFn()).toISOString();
    for (const member of Object.values(latestRun.members)) {
      if (member.state === "working" || member.state === "waiting") {
        await this.store.updateMember(run.id, member.name, {
          state: "stopped",
          currentActivity: null,
          parkedOn: "run completed",
          endedAt: nowIso,
          actor,
        });
      }
    }

    const completed = await this.store.updateRun(run.id, {
      status: "completed",
      completionSummary: summary,
      actor,
    });

    const shouldTeardown =
      options.teardown ?? this.getEffectiveSettings().autoTeardownOnComplete;
    if (shouldTeardown) {
      await this.teardown({
        runId: run.id,
        deleteBranches: options.deleteBranches,
        sessionId: options.sessionId,
      });
    }

    const finalRun = await this.store.loadRun(run.id);
    await this.refreshCache(finalRun);
    this.resolveAllWaiters("run_ended", `Swarm run completed: ${summary}`);
    this.emitEngineEvent("run_finished", `Swarm run "${completed.title}" completed: ${summary}`);
    this.emitEngineEvent("snapshot_changed", `Swarm run "${completed.title}" completed.`);
    return finalRun;
  }

  // --------------------------------------------------------------------------
  // Dynamic Member Management (addMembers, switchModel, steer, stop, kill, merge)
  // --------------------------------------------------------------------------

  async addMembers(input: AddMemberInput): Promise<SwarmMemberRecord[]> {
    if (input.hostContext) {
      this.hostContext = input.hostContext;
    }
    const run = this.requireActiveRun();
    if (run.status === "completed" || run.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot add members to a ${run.status} Swarm run.`,
      );
    }

    const callerRole: CallerRole = input.callerRole ?? "orchestrator";
    const callerName =
      input.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    // Permission & role validation
    let parentName: string = ORCHESTRATOR_NAME;
    let parentMember: SwarmMemberRecord | undefined;

    if (callerRole === "worker" || callerRole === "validator") {
      parentMember = this.findMember(run, callerName);
      if (!parentMember) {
        throw new SwarmProtocolError(
          "MEMBER_NOT_FOUND",
          `Caller member "${callerName}" was not found in run "${run.id}".`,
        );
      }
      if (parentMember.state === "killed") {
        throw new SwarmProtocolError(
          "MEMBER_KILLED",
          `Killed member "${callerName}" cannot add helpers.`,
        );
      }
      parentName = parentMember.name;
      if (callerRole === "validator" && input.role && input.role !== "validator") {
        throw new SwarmProtocolError(
          "ROLE_FORBIDDEN",
          `Read-only validator "@${parentName}" may only add read-only "validator" helpers.`,
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${callerRole}" is not allowed to add swarm members.`,
      );
    }

    const memberRole: SwarmMemberRole =
      callerRole === "validator" ? "validator" : (input.role ?? "worker");

    const baseName = validateMemberName(input.name);
    const brief = input.brief?.trim() ?? "";
    if (!brief) {
      throw new SwarmProtocolError("INVALID_INPUT", "Member brief must be non-empty.");
    }

    const hasTasks = Array.isArray(input.tasks) && input.tasks.length > 0;
    const hasCount = input.n !== undefined && input.n > 1;
    if (hasTasks && hasCount) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        'Specify either "n" or "tasks", not both.',
      );
    }

    // Build member spawn specifications (single, n copies, or sharded tasks[])
    interface MemberSpec {
      name: string;
      groupPrefix?: string;
      brief: string;
    }

    const specs: MemberSpec[] = [];
    if (hasTasks) {
      if (input.tasks!.length > MAX_SHARD_COUNT) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Too many sharded tasks (${input.tasks!.length}); maximum is ${MAX_SHARD_COUNT}.`,
        );
      }
      for (let i = 0; i < input.tasks!.length; i++) {
        const target = input.tasks![i]!.trim();
        if (!target) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            `Task slice at index ${i} must be non-empty.`,
          );
        }
        const shardName = validateMemberName(`${baseName}-${i + 1}`);
        specs.push({
          name: shardName,
          groupPrefix: baseName,
          brief: `${brief}\n\nAssigned slice (${i + 1}/${input.tasks!.length}): ${target}`,
        });
      }
    } else if (hasCount) {
      const count = input.n!;
      if (!Number.isInteger(count) || count < 1 || count > MAX_SHARD_COUNT) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Invalid member copy count n=${String(count)} (expected integer 1..${MAX_SHARD_COUNT}).`,
        );
      }
      for (let i = 1; i <= count; i++) {
        const shardName = validateMemberName(`${baseName}-${i}`);
        specs.push({
          name: shardName,
          groupPrefix: baseName,
          brief,
        });
      }
    } else {
      specs.push({
        name: baseName,
        brief,
      });
    }

    // Reject duplicates (including previously killed names — killed names are never reused!)
    const batchNames = new Set<string>();
    for (const spec of specs) {
      const lower = spec.name.toLowerCase();
      const hasLive = Array.from(this.liveMembers.keys()).some(
        (k) => k.toLowerCase() === lower,
      );
      if (batchNames.has(lower) || this.findMember(run, spec.name) || hasLive) {
        throw new SwarmProtocolError(
          "DUPLICATE_MEMBER",
          `Member name "${spec.name}" already exists in this Swarm run (killed names cannot be reused).`,
          { name: spec.name },
        );
      }
      batchNames.add(lower);
    }

    // Resolve and validate channels
    let channels: string[];
    if (input.channels && input.channels.length > 0) {
      channels = [];
      const seen = new Set<string>();
      for (const rawCh of input.channels) {
        const ch = validateChannelName(rawCh);
        const record = getOwnChannel(run, ch);
        if (!record) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            `Channel "#${ch}" does not exist. Create it first via swarm{action:"channel", op:"create"}.`,
            { channel: ch },
          );
        }
        if (record.archived) {
          throw new SwarmProtocolError(
            "CHANNEL_ARCHIVED",
            `Channel "#${ch}" is archived and cannot accept new members.`,
            { channel: ch },
          );
        }
        if (!seen.has(ch)) {
          seen.add(ch);
          channels.push(ch);
        }
      }
    } else if (parentMember) {
      const inherited = parentMember.channels.filter((ch) => {
        const rec = getOwnChannel(run, ch);
        return Boolean(rec && !rec.archived);
      });
      channels = inherited.length > 0 ? [...inherited] : [DEFAULT_CHANNEL];
    } else {
      channels = [DEFAULT_CHANNEL];
    }
    const primaryChannel = channels[0] ?? DEFAULT_CHANNEL;

    // Resolve TRUE Conversation Fork (`input.fork`) before creating worktrees/members
    let forkedFrom: string | undefined;
    let seedMessages: AgentMessage[] | undefined;
    if (input.fork?.trim()) {
      const forkTarget = input.fork.trim();
      const forkLower = forkTarget.toLowerCase();
      if (forkLower === ORCHESTRATOR_NAME || forkLower === "coordinator") {
        const ctx = input.hostContext ?? this.hostContext;
        seedMessages = sanitizeForkSeedMessages(extractSessionMessages(ctx?.sessionManager));
        forkedFrom = ORCHESTRATOR_NAME;
      } else {
        const sourceMember = this.findMember(run, forkTarget);
        if (!sourceMember) {
          throw new SwarmProtocolError(
            "MEMBER_NOT_FOUND",
            `Cannot fork from unknown member "${forkTarget}".`,
            { fork: forkTarget },
          );
        }
        const sourceLive = this.liveMembers.get(sourceMember.name);
        if (sourceLive?.handle) {
          seedMessages = sanitizeForkSeedMessages(sourceLive.handle.getConversationMessages());
        } else if (sourceLive && sourceLive.lastMessages.length > 0) {
          seedMessages = sanitizeForkSeedMessages(sourceLive.lastMessages);
        } else if (sourceMember.state === "killed") {
          throw new SwarmProtocolError(
            "MEMBER_KILLED",
            `Cannot fork from killed member "@${sourceMember.name}" (session disposed).`,
            { fork: sourceMember.name },
          );
        } else if (sourceMember.sessionFile) {
          try {
            const reopened = SessionManager.open(sourceMember.sessionFile);
            seedMessages = sanitizeForkSeedMessages(extractSessionMessages(reopened));
          } catch {
            seedMessages = [];
          }
        } else {
          seedMessages = [];
        }
        forkedFrom = sourceMember.name;
      }
    }

    // Resolve 3-role model (`worker` vs `validator`, with explicit override taking precedence)
    const settings = this.getEffectiveSettings();
    const roleDefaultFromRun = run.roleModels[memberRole];
    const resolvedFromSettings = resolveRoleModel(
      memberRole,
      settings,
      input.model,
      input.thinkingLevel,
    );
    const effectiveModel =
      resolvedFromSettings.model ?? roleDefaultFromRun?.model?.trim() ?? undefined;
    const effectiveThinking =
      resolvedFromSettings.thinkingLevel ?? roleDefaultFromRun?.thinkingLevel;

    const workspaceMode: SwarmWorkspaceMode = input.workspace ?? "inherit";
    const safeRunBranchSegment =
      run.id
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "run";
    const createdRecords: SwarmMemberRecord[] = [];
    const launches: Array<{
      memberName: string;
      briefSeq: number;
      seedMessages?: AgentMessage[];
    }> = [];

    if (isOrchestratorOrHuman(callerRole)) {
      this.boardHopCount = 0;
      this.hopCapAlerted = false;
    }

    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");

    const preparedSpecs: Array<{
      spec: (typeof specs)[number];
      cwd: string;
      branch?: string;
    }> = [];
    const provisionedWorktrees: Array<{ worktreePath: string; branch?: string }> = [];

    try {
      for (const spec of specs) {
        let cwd: string;
        let branch: string | undefined;

        if (workspaceMode === "share" || workspaceMode === "branch") {
          branch = `${SWARM_BRANCH_PREFIX}${safeRunBranchSegment}/${spec.name}`;
          const worktreePath = this.store.getWorktreePath(run.id, spec.name);
          const createdWt = await this.worktree.createWorktree({
            branch,
            baseBranch: run.baseBranch,
            worktreePath,
            mode: workspaceMode,
          });
          cwd = createdWt.worktreePath;
          branch = createdWt.branch;
          provisionedWorktrees.push({ worktreePath: cwd, branch });
        } else {
          cwd =
            parentMember && parentMember.workspace !== "inherit"
              ? parentMember.cwd
              : this.worktree.repoRoot;
        }

        preparedSpecs.push({ spec, cwd, branch });
      }
    } catch (err) {
      for (const wt of provisionedWorktrees) {
        await this.worktree.removeWorktree(wt.worktreePath, { force: true }).catch(() => {});
        if (wt.branch) {
          await this.worktree.deleteBranch?.(wt.branch).catch(() => {});
        }
      }
      throw err;
    }

    const registeredWorktrees = new Set<string>();
    const preRegisteredLiveNames: string[] = [];
    try {
      for (const { spec, cwd, branch } of preparedSpecs) {
        const agentId = this.generateAgentIdFn(spec.name);
        // Register LiveMember SYNCHRONOUSLY as spawning BEFORE store.addMember so concurrent peer
        // @all / @<prefix> posts during registration queue into pendingWakes instead of spawning duplicates!
        const live: LiveMember = {
          name: spec.name,
          agentId,
          role: memberRole,
          spawning: true,
          waking: false,
          turnActive: false,
          switchingModel: false,
          parkedMentionsOnly: true,
          pendingWakes: [],
          deliveredSeqs: new Set<number>(),
          triedModels: new Set<string>(effectiveModel ? [effectiveModel] : []),
          lastMessages: seedMessages ? sanitizeForkSeedMessages(seedMessages) : [],
          logTail: [],
          currentActivity: "queued to start",
          retryCount: 0,
          priorHandlesTokens: 0,
          priorHandlesBreakdown: undefined,
          priorHandlesCost: 0,
        };
        this.liveMembers.set(spec.name, live);
        preRegisteredLiveNames.push(spec.name);

        await this.store.addMember(
          run.id,
          {
            name: spec.name,
            agentId,
            role: memberRole,
            parentName,
            groupPrefix: spec.groupPrefix,
            brief: spec.brief,
            workspace: workspaceMode,
            cwd,
            branch,
            forkedFrom,
            channels,
            state: "working",
            model: effectiveModel,
            thinkingLevel: effectiveThinking,
            lastReadSeq: this.cachedRun?.boardHead ?? run.boardHead,
          },
          { actor: callerName },
        );
        if (workspaceMode === "share" || workspaceMode === "branch") {
          registeredWorktrees.add(cwd);
        }

        // Post public brief on the shared board as callerName
        const briefMsg = await this.store.postBoardMessage(run.id, {
          from: callerName,
          fromRole: callerRole,
          channel: primaryChannel,
          kind: "brief",
          text: `@${spec.name} ${spec.brief}`,
        });
        this.recordBoardMessageInCache(briefMsg);
        live.deliveredSeqs.add(briefMsg.seq);

        const updatedRun = await this.store.updateMember(run.id, spec.name, {
          briefSeq: briefMsg.seq,
          lastReadSeq: briefMsg.seq,
          currentActivity: "queued to start",
          actor: callerName,
        });
        this.setCachedRun(updatedRun);

        const memberRecord = getOwnMember(updatedRun, spec.name)!;
        live.logTail = [...memberRecord.logTail];
        createdRecords.push(memberRecord);

        this.emitEngineEvent("board_posted", `Posted brief #${briefMsg.seq} for @${spec.name}`, {
          memberName: spec.name,
          seq: briefMsg.seq,
        });
        this.notifyWaitersOnMessage(briefMsg);

        launches.push({
          memberName: spec.name,
          briefSeq: briefMsg.seq,
          seedMessages: seedMessages ? sanitizeForkSeedMessages(seedMessages) : undefined,
        });
      }
    } catch (err) {
      for (const name of preRegisteredLiveNames) {
        this.liveMembers.delete(name);
      }
      for (const wt of provisionedWorktrees) {
        if (!registeredWorktrees.has(wt.worktreePath)) {
          await this.worktree.removeWorktree(wt.worktreePath, { force: true }).catch(() => {});
          if (wt.branch) {
            await this.worktree.deleteBranch?.(wt.branch).catch(() => {});
          }
        }
      }
      throw err;
    }

    await this.refreshCache();
    this.emitEngineEvent(
      "snapshot_changed",
      `Added ${createdRecords.length} member(s): ${createdRecords.map((m) => `@${m.name}`).join(", ")}`,
    );

    // Launch all newly registered members asynchronously
    const effectiveCtx = input.hostContext ?? this.hostContext;
    for (const launch of launches) {
      void this.launchMemberInitialTurn(
        run.id,
        launch.memberName,
        launch.briefSeq,
        launch.seedMessages,
        effectiveCtx,
      );
    }

    return createdRecords;
  }

  async postMessage(input: PostBoardMessageInput): Promise<BoardMessage> {
    const run = this.requireActiveRun();
    const text = input.text?.trim() ?? "";
    if (!text) {
      throw new SwarmProtocolError("INVALID_INPUT", "Board message text must be non-empty.");
    }

    // Parse & validate channel mentions (`@#<ch>`): reject `@#main`, unknown, or archived channels
    const parsedChMentions = mergeUniqueLower([
      parseChannelMentions(text),
      input.channelMentions,
    ]);
    for (const ch of parsedChMentions) {
      if (ch === DEFAULT_CHANNEL) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          'Cannot mention "@#main". Use "@all" for swarm-wide notices or target a specific channel.',
          { channel: ch },
        );
      }
      const chRecord = getOwnChannel(run, ch);
      if (!chRecord) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          `Channel "#${ch}" does not exist.`,
          { channel: ch },
        );
      }
      if (chRecord.archived) {
        throw new SwarmProtocolError(
          "CHANNEL_ARCHIVED",
          `Channel "#${ch}" is archived and cannot be mentioned.`,
          { channel: ch },
        );
      }
    }

    // Resolve and validate target post channel
    const senderMember = this.findMember(run, input.from);
    const channel = (
      input.channel?.trim().toLowerCase() ||
      senderMember?.channels[0] ||
      DEFAULT_CHANNEL
    );
    const channelRecord = getOwnChannel(run, channel);
    if (!channelRecord) {
      throw new SwarmProtocolError(
        "INVALID_CHANNEL",
        `Channel "#${channel}" does not exist.`,
        { channel },
      );
    }
    if (channelRecord.archived) {
      throw new SwarmProtocolError(
        "CHANNEL_ARCHIVED",
        `Channel "#${channel}" is archived and cannot receive posts.`,
        { channel },
      );
    }

    // Parse handle mentions (`@name`, `@prefix`, `@all`) ignoring emails and `@#channel`
    const parsedMentions = mergeUniqueLower([parseHandleMentions(text), input.mentions]);

    const msg = await this.store.postBoardMessage(run.id, {
      ...input,
      text,
      channel,
      mentions: parsedMentions,
      channelMentions: parsedChMentions,
    });

    // Ensure consistent normalized mentions on returned object even with minimal mock stores
    const normalizedMsg: BoardMessage = {
      ...msg,
      channel: msg.channel || channel,
      mentions: mergeUniqueLower([msg.mentions, parsedMentions]),
      channelMentions: mergeUniqueLower([msg.channelMentions, parsedChMentions]),
    };

    this.recordBoardMessageInCache(normalizedMsg);
    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");
    this.stallNoticePostedAtHead = null;
    this.lastMonitorNudgeSeq = null;

    if (normalizedMsg.fromRole === "orchestrator" || normalizedMsg.fromRole === "human") {
      this.boardHopCount = 0;
      this.hopCapAlerted = false;
    }

    // Keep cached run synced with new boardHead / sender lastPostSeq
    const latestRun = await this.store.loadRun(run.id);
    this.setCachedRun(latestRun);

    this.emitEngineEvent("board_posted", `Posted #${normalizedMsg.seq} from ${normalizedMsg.from}`, {
      memberName: senderMember?.name,
      seq: normalizedMsg.seq,
    });

    // Route wakeups SYNCHRONOUSLY marking `live.waking = true` BEFORE resolving waiters or returning!
    let emittedOrchWakeup = false;
    if (latestRun.status === "active" && normalizedMsg.fromRole !== "monitor") {
      emittedOrchWakeup = await this.routeBoardMessageWakeups(latestRun, normalizedMsg);
    }

    // If Orchestrator is parked in non-blocking `swarm_wait`, check if this message wakes it (without double-emitting!)
    this.maybeWakeParkedOrchestratorOnMessage(normalizedMsg, emittedOrchWakeup);

    // Notify blocking `waitForBoard` waiters immediately
    this.notifyWaitersOnMessage(normalizedMsg);

    // Re-arm watchdog if 0 working and no waiter is blocked (and not done)
    this.maybeArmStallWatchdog();

    return normalizedMsg;
  }

  clearOrchestratorWait(_reason?: string): void {
    if (!this.orchestratorWait) {
      return;
    }
    if (this.orchestratorWait.timer) {
      clearTimeout(this.orchestratorWait.timer);
      this.orchestratorWait.timer = null;
    }
    this.orchestratorWait = null;
    this.maybeArmStallWatchdog();
  }

  async parkOrchestratorWait(
    options: ParkOrchestratorWaitOptions,
  ): Promise<ParkOrchestratorWaitResult> {
    const since = Number.isFinite(options.since) ? Math.max(0, Math.floor(options.since)) : 0;
    const mentionsOnly = options.mentionsOnly ?? true;
    const currentHead = this.cachedRun?.boardHead ?? 0;

    if (!this.activeRunId || !this.cachedRun || this.cachedRun.status !== "active") {
      return {
        parked: false,
        wokeBy: "run_ended",
        messages: [],
        head: currentHead,
        activeMembers: [],
        summary: "Swarm run is not active.",
      };
    }

    const runId = this.activeRunId;
    const initial = await this.store.readBoard(runId, {
      since,
      channel: "*",
      limit: Number.MAX_SAFE_INTEGER,
    });
    const latestHead = Math.max(initial.head, this.cachedRun?.boardHead ?? 0);

    const mergedBySeq = new Map<number, BoardMessage>();
    for (const m of initial.messages) {
      mergedBySeq.set(m.seq, m);
    }
    for (const m of this.getCachedMessagesSince(since)) {
      mergedBySeq.set(m.seq, m);
    }
    const mergedUnread = Array.from(mergedBySeq.values()).sort((a, b) => a.seq - b.seq);

    if (
      this.disposed ||
      this.activeRunId !== runId ||
      !this.cachedRun ||
      this.cachedRun.status !== "active"
    ) {
      return {
        parked: false,
        wokeBy: "run_ended",
        messages: mergedUnread,
        head: latestHead,
        activeMembers: [],
        summary: "Swarm run is not active.",
      };
    }

    const immediateMatches = mergedUnread.filter((m) =>
      this.doesMessageMatchWaiter(m, ORCHESTRATOR_NAME, mentionsOnly, []),
    );
    const activeMembers = this.getWorkingOrPendingMemberNames();

    if (immediateMatches.length > 0) {
      return {
        parked: false,
        wokeBy: "message",
        messages: mergedUnread,
        head: latestHead,
        activeMembers,
        summary: `${immediateMatches.length} matching board message(s) already waiting since #${since}.`,
      };
    }

    if (activeMembers.length === 0) {
      const digest = this.buildAllIdleDigest();
      return {
        parked: false,
        wokeBy: "all_idle",
        messages: mergedUnread,
        head: latestHead,
        activeMembers: [],
        summary: digest
          ? `All swarm members are idle (0 working/pending); nothing left to wait for. ${digest}`
          : "All swarm members are idle (0 working/pending); nothing left to wait for.",
      };
    }

    // Arm non-blocking Orchestrator wait and end Orchestrator's current turn cleanly!
    if (this.orchestratorWait?.timer) {
      clearTimeout(this.orchestratorWait.timer);
    }
    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (
      options.timeoutMs !== undefined &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
    ) {
      const waitTimeout = Math.max(10, options.timeoutMs);
      const parkedRunId = runId;
      timer = setTimeout(() => {
        if (!this.orchestratorWait || this.disposed || this.activeRunId !== parkedRunId) {
          return;
        }
        const expired = this.orchestratorWait;
        this.orchestratorWait = null;
        const unread = this.getCachedMessagesSince(expired.since);
        this.emitEngineEvent(
          "wakeup_needed",
          `swarm_wait timed out after ${Math.round(waitTimeout)}ms (board #${this.cachedRun?.boardHead ?? latestHead})`,
          { ...(unread.length > 0 ? { messages: unread } : {}) },
        );
      }, waitTimeout);
      timer.unref?.();
    }

    this.orchestratorWait = {
      since,
      mentionsOnly,
      timer,
    };

    return {
      parked: true,
      messages: [],
      head: latestHead,
      activeMembers,
      summary: `Parked waiting on ${activeMembers.length} active member(s) since #${since}.`,
    };
  }

  async readBoard(options?: ReadBoardOptions): Promise<ReadBoardResult> {
    const run = this.requireActiveRun();
    const res = await this.store.readBoard(run.id, options);
    return res;
  }

  async waitForBoard(options: WaitForBoardOptions): Promise<WaitForBoardResult> {
    const since = Number.isFinite(options.since) ? Math.max(0, Math.floor(options.since)) : 0;
    const mentionsOnly = options.mentionsOnly ?? true;
    const targetName = (options.targetName?.trim() || ORCHESTRATOR_NAME).toLowerCase();
    const targetChannels = options.targetChannels ?? [];

    const currentHead = this.cachedRun?.boardHead ?? 0;

    if (options.signal?.aborted) {
      return {
        wokeBy: "aborted",
        messages: [],
        head: currentHead,
        summary: "Wait cancelled by abort signal.",
      };
    }

    if (!this.activeRunId || !this.cachedRun || this.cachedRun.status !== "active") {
      return {
        wokeBy: "run_ended",
        messages: [],
        head: currentHead,
        summary: "Swarm run is not active.",
      };
    }

    const runId = this.activeRunId;
    const initial = await this.store.readBoard(runId, {
      since,
      channel: "*",
      limit: Number.MAX_SAFE_INTEGER,
    });

    // Re-check abort, run lifecycle, and mid-await messages synchronously BEFORE adding waiter!
    const latestHead = Math.max(initial.head, this.cachedRun?.boardHead ?? 0);
    const mergedBySeq = new Map<number, BoardMessage>();
    for (const m of initial.messages) {
      mergedBySeq.set(m.seq, m);
    }
    for (const m of this.getCachedMessagesSince(since)) {
      mergedBySeq.set(m.seq, m);
    }
    const mergedUnread = Array.from(mergedBySeq.values()).sort((a, b) => a.seq - b.seq);

    if (options.signal?.aborted) {
      return {
        wokeBy: "aborted",
        messages: mergedUnread,
        head: latestHead,
        summary: "Wait cancelled by abort signal.",
      };
    }

    if (
      this.disposed ||
      this.activeRunId !== runId ||
      !this.cachedRun ||
      this.cachedRun.status !== "active"
    ) {
      return {
        wokeBy: "run_ended",
        messages: mergedUnread,
        head: latestHead,
        summary: "Swarm run is not active.",
      };
    }

    const immediateMatches = mergedUnread.filter((m) =>
      this.doesMessageMatchWaiter(m, targetName, mentionsOnly, targetChannels),
    );
    if (immediateMatches.length > 0) {
      return {
        wokeBy: "message",
        messages: mergedUnread,
        head: latestHead,
        summary: `${immediateMatches.length} matching board message(s) already waiting since #${since}.`,
      };
    }

    // Anti-deadlock check: if NO member is working, spawning, waking, or switching models -> return immediately!
    const activeNames = this.getWorkingOrPendingMemberNames();
    if (activeNames.length === 0) {
      const digest = this.buildAllIdleDigest();
      return {
        wokeBy: "all_idle",
        messages: mergedUnread,
        head: latestHead,
        summary: digest
          ? `All swarm members are idle (0 working/pending); nothing left to wait for. ${digest}`
          : "All swarm members are idle (0 working/pending); nothing left to wait for.",
      };
    }

    // Orchestrator is actively waiting -> cancel Stall Watchdog so it won't double-alert
    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");

    return new Promise<WaitForBoardResult>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let progressInterval: ReturnType<typeof setInterval> | null = null;

      const emitProgress = (): void => {
        if (!options.onProgress || settled) return;
        const working = this.getWorkingOrPendingMemberNames();
        const head = this.cachedRun?.boardHead ?? initial.head;
        const statusParts = working.map((name) => {
          const m = getOwnMember(this.cachedRun, name);
          const act = m?.currentActivity ? ` (${m.currentActivity})` : "";
          return `@${name}${act}`;
        });
        try {
          options.onProgress(
            `Waiting on ${working.length} active member(s): ${statusParts.join(", ") || "none"} | board=#${head}`,
          );
        } catch {
          // progress callback errors must not break waitForBoard
        }
      };

      const onAbort = (): void => {
        finish({
          wokeBy: "aborted",
          messages: this.getCachedMessagesSince(since),
          head: this.cachedRun?.boardHead ?? initial.head,
          summary: "Wait cancelled by abort signal.",
        });
      };

      const cleanup = (): void => {
        this.boardWaiters.delete(waiter);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      };

      const finish = (result: WaitForBoardResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const waiter: BoardWaiter = {
        since,
        mentionsOnly,
        targetName,
        targetChannels,
        onProgress: options.onProgress,
        resolve: finish,
        cleanup,
      };

      this.boardWaiters.add(waiter);

      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (
        options.timeoutMs !== undefined &&
        Number.isFinite(options.timeoutMs) &&
        options.timeoutMs > 0
      ) {
        timeoutHandle = setTimeout(() => {
          finish({
            wokeBy: "timeout",
            messages: this.getCachedMessagesSince(since),
            head: this.cachedRun?.boardHead ?? initial.head,
            summary: `Timed out after ${Math.round(options.timeoutMs!)}ms while waiting on board.`,
          });
        }, options.timeoutMs);
        timeoutHandle.unref?.();
      }

      if (options.onProgress) {
        emitProgress();
        progressInterval = setInterval(emitProgress, 1000);
        progressInterval.unref?.();
      }
    });
  }

  async switchModel(options: SwitchModelOptions): Promise<SwitchModelResult> {
    return this.performSwitchModel(options, { holdSwitchingLock: false });
  }

  private async performSwitchModel(
    options: SwitchModelOptions,
    internal: { holdSwitchingLock: boolean },
  ): Promise<SwitchModelResult> {
    if (options.hostContext) {
      this.hostContext = options.hostContext;
    }
    const run = this.requireActiveRun();
    const modelOverride = options.model?.trim() ?? "";
    if (!modelOverride) {
      throw new SwarmProtocolError("INVALID_INPUT", "Model identifier must be non-empty.");
    }

    const callerRole: CallerRole = options.callerRole ?? "orchestrator";
    const callerName =
      options.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);
    const targetRaw = options.targetName?.trim().replace(/^@/, "") || callerName;

    // Switching orchestrator role model
    if (
      targetRaw.toLowerCase() === ORCHESTRATOR_NAME ||
      targetRaw.toLowerCase() === "coordinator"
    ) {
      if (!isOrchestratorOrHuman(callerRole)) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" cannot switch the orchestrator's model.`,
        );
      }
      const previousModel = run.roleModels.orchestrator?.model;
      const nextThinking =
        options.thinkingLevel ?? run.roleModels.orchestrator?.thinkingLevel;
      const nextRoleModels: SwarmRoleModels = {
        ...run.roleModels,
        orchestrator: {
          model: modelOverride,
          thinkingLevel: nextThinking,
        },
      };
      const updated = await this.store.updateRun(run.id, {
        roleModels: nextRoleModels,
        actor: callerName,
      });

      await this.store.appendEvent({
        runId: run.id,
        type: "member_model_switched",
        actor: callerName,
        memberName: ORCHESTRATOR_NAME,
        summary: `Switched @${ORCHESTRATOR_NAME} model -> ${modelOverride}${nextThinking ? ` (${nextThinking})` : ""}${options.reason ? ` (${options.reason})` : ""}`,
        data: {
          previousModel,
          model: modelOverride,
          thinkingLevel: nextThinking,
          reason: options.reason,
        },
      });

      const noticeMsg = await this.store.postBoardMessage(run.id, {
        from: callerName,
        fromRole: callerRole,
        channel: DEFAULT_CHANNEL,
        kind: "model_switch",
        text: `[model] ${ORCHESTRATOR_NAME} switched to ${modelOverride}${nextThinking ? ` (${nextThinking})` : ""}${options.reason ? ` — ${options.reason}` : ""}`,
        mentions: [],
        channelMentions: [],
      });
      this.recordBoardMessageInCache(noticeMsg);
      this.emitEngineEvent("board_posted", `Posted model switch #${noticeMsg.seq}`, {
        memberName: ORCHESTRATOR_NAME,
        seq: noticeMsg.seq,
      });

      await this.refreshCache(updated);
      this.emitEngineEvent(
        "snapshot_changed",
        `Switched orchestrator model -> ${modelOverride}`,
      );
      return {
        targetName: ORCHESTRATOR_NAME,
        model: modelOverride,
        thinkingLevel: nextThinking,
      };
    }

    const member = this.findMember(run, targetRaw);
    if (!member) {
      throw new SwarmProtocolError(
        "MEMBER_NOT_FOUND",
        `Member "${targetRaw}" was not found in Swarm run "${run.id}".`,
        { targetName: targetRaw },
      );
    }

    // Permission boundary: workers/validators may switch ONLY themselves or helpers they added!
    if (callerRole === "worker" || callerRole === "validator") {
      if (member.name !== callerName && member.parentName !== callerName) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" may only switch models for itself or helpers it added, not "@${member.name}".`,
          { callerName, targetName: member.name },
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${callerRole}" cannot switch member models.`,
      );
    }

    if (member.state === "killed") {
      throw new SwarmProtocolError(
        "MEMBER_KILLED",
        `Member "@${member.name}" has been killed and cannot switch models.`,
        { memberName: member.name },
      );
    }
    const live = this.liveMembers.get(member.name);
    const liveState = live?.handle?.getState() ?? member.state;
    const isWorkingSelfSwitch =
      (callerRole === "worker" || callerRole === "validator") &&
      member.name === callerName &&
      (member.state === "working" ||
        liveState === "working" ||
        Boolean(live?.turnActive) ||
        Boolean(live?.spawning) ||
        Boolean(live?.waking));

    // Deferred Self Model Switch (Defect #3): when a worker/validator calls `swarm{action:"model"}`
    // on itself while running, validate the target model now, schedule switch + immediate resume for turn end.
    if (isWorkingSelfSwitch && live) {
      let validatedModel = modelOverride;
      let validatedThinking = options.thinkingLevel;
      if (this.transport.resolveModel) {
        const resolved = await this.transport.resolveModel(
          modelOverride,
          options.thinkingLevel,
          this.hostContext,
        );
        validatedModel = resolved.model;
        validatedThinking = resolved.thinkingLevel ?? options.thinkingLevel;
      }
      live.pendingSelfModelSwitch = {
        model: validatedModel,
        thinkingLevel: validatedThinking,
        reason: options.reason,
        callerName,
        callerRole,
      };
      return {
        targetName: member.name,
        model: validatedModel,
        thinkingLevel: validatedThinking,
        deferred: true,
      };
    }

    const isParkedState = member.state === "waiting" || member.state === "stopped";
    if (
      !isParkedState ||
      liveState === "working" ||
      live?.spawning ||
      live?.waking ||
      live?.turnActive ||
      (!internal.holdSwitchingLock && live?.switchingModel)
    ) {
      throw new SwarmProtocolError(
        "MEMBER_NOT_WAITING",
        `Member "@${member.name}" is currently "${live?.switchingModel ? "switchingModel" : liveState}" (not waiting). Wait until it parks in waiting state before switching models.`,
        { memberName: member.name, state: live?.switchingModel ? "switchingModel" : liveState },
      );
    }

    // Ensure a LiveMember record exists if member is persisted `stopped` so lock & revive work cleanly
    let activeLive = live;
    if (!activeLive) {
      activeLive = {
        name: member.name,
        agentId: member.agentId,
        role: member.role,
        spawning: false,
        waking: false,
        turnActive: false,
        switchingModel: false,
        parkedMentionsOnly: true,
        pendingWakes: [],
        deliveredSeqs: new Set<number>(),
        triedModels: new Set<string>(member.model ? [member.model] : []),
        lastMessages: [],
        logTail: [...member.logTail],
        lastTool: member.lastTool,
        retryCount: 0,
        priorHandlesTokens: member.tokens,
        priorHandlesBreakdown: member.tokenBreakdown ? { ...member.tokenBreakdown } : undefined,
        priorHandlesCost: member.cost,
      };
      this.liveMembers.set(member.name, activeLive);
    }

    // Acquire synchronous switchingModel lock BEFORE any await so concurrent @mentions queue safely!
    const wasColdParkedBeforeSwitch =
      member.state === "stopped" || (member.state === "waiting" && !activeLive.handle);
    const acquiredLock = !internal.holdSwitchingLock;
    if (acquiredLock) {
      this.cancelMemberRetryTimer(activeLive);
      activeLive.switchingModel = true;
    }

    let switchSucceeded = false;
    let shouldAutoResume = false;
    let resumePromptText = "";
    try {
      let resolvedModel = modelOverride;
      let resolvedThinking = options.thinkingLevel;

      if (activeLive.handle && activeLive.handle.getState() === "waiting") {
        const switched = await activeLive.handle.switchModel(modelOverride, options.thinkingLevel);
        resolvedModel = switched.model;
        resolvedThinking = switched.thinkingLevel ?? options.thinkingLevel;
        activeLive.triedModels.add(resolvedModel);
      } else {
        if (this.transport.resolveModel) {
          const resolved = await this.transport.resolveModel(
            modelOverride,
            options.thinkingLevel,
            this.hostContext,
          );
          resolvedModel = resolved.model;
          resolvedThinking = resolved.thinkingLevel ?? options.thinkingLevel;
        }
        activeLive.triedModels.add(resolvedModel);
      }

      const updatedRun = await this.store.updateMember(run.id, member.name, {
        model: resolvedModel,
        thinkingLevel: resolvedThinking ?? null,
        error: null,
        actor: callerName,
      });

      await this.store.appendEvent({
        runId: run.id,
        type: "member_model_switched",
        actor: callerName,
        memberName: member.name,
        agentId: member.agentId,
        summary: `Switched @${member.name} model -> ${resolvedModel}${resolvedThinking ? ` (${resolvedThinking})` : ""}${options.reason ? ` (${options.reason})` : ""}`,
        data: {
          previousModel: member.model,
          model: resolvedModel,
          thinkingLevel: resolvedThinking,
          reason: options.reason,
        },
      });

      // Post non-waking `[model]` notice on board (no `@` so it doesn't duplicate-wake)
      const noticeMsg = await this.store.postBoardMessage(run.id, {
        from: callerName,
        fromRole: callerRole,
        channel: member.channels[0] ?? DEFAULT_CHANNEL,
        kind: "model_switch",
        text: `[model] ${member.name} switched to ${resolvedModel}${resolvedThinking ? ` (${resolvedThinking})` : ""}${options.reason ? ` — ${options.reason}` : ""}`,
        mentions: [],
        channelMentions: [],
      });
      this.recordBoardMessageInCache(noticeMsg);
      this.emitEngineEvent("board_posted", `Posted model switch #${noticeMsg.seq}`, {
        memberName: member.name,
        seq: noticeMsg.seq,
      });

      await this.refreshCache(updatedRun);
      this.emitEngineEvent(
        "snapshot_changed",
        `${activeLive.handle?.getState() === "waiting" ? "Hot-switched" : "Switched"} @${member.name} model -> ${resolvedModel}`,
        { memberName: member.name },
      );

      switchSucceeded = true;
      const latestMemberAfter = getOwnMember(this.cachedRun, member.name);
      const isWarmWaiting =
        latestMemberAfter?.state === "waiting" && activeLive.handle?.getState() === "waiting";
      const canReviveColdAfter =
        wasColdParkedBeforeSwitch &&
        !latestMemberAfter?.humanStopped &&
        (latestMemberAfter?.state === "stopped" ||
          (latestMemberAfter?.state === "waiting" && !activeLive.handle));
      shouldAutoResume =
        options.autoResume !== false &&
        !internal.holdSwitchingLock &&
        activeLive.switchingModel &&
        !this.disposed &&
        this.activeRunId === run.id &&
        this.cachedRun?.status === "active" &&
        (isWarmWaiting || canReviveColdAfter);
      if (shouldAutoResume) {
        const reasonNote = options.reason ? ` (${options.reason})` : "";
        resumePromptText = `Your model was ${isWarmWaiting ? "hot-switched" : "switched"} to "${resolvedModel}"${resolvedThinking ? ` (${resolvedThinking})` : ""}${reasonNote} with your conversation history preserved. Resume any unfinished work immediately, or post an update / call swarm_wait if already done.`;
      }

      return {
        targetName: member.name,
        model: resolvedModel,
        thinkingLevel: resolvedThinking,
        member: latestMemberAfter,
        ...(shouldAutoResume ? { resumed: true } : {}),
      };
    } finally {
      if (acquiredLock) {
        const stillLive = this.liveMembers.get(member.name) === activeLive;
        const lockStillHeld = activeLive.switchingModel;
        const currentMember = getOwnMember(this.cachedRun, member.name);
        const canAutoResumeWarm =
          currentMember?.state === "waiting" && activeLive.handle?.getState() === "waiting";
        const canAutoReviveCold =
          wasColdParkedBeforeSwitch &&
          !currentMember?.humanStopped &&
          (currentMember?.state === "stopped" ||
            (currentMember?.state === "waiting" && !activeLive.handle));

        if (
          stillLive &&
          lockStillHeld &&
          !this.disposed &&
          this.activeRunId === run.id &&
          this.cachedRun?.status === "active" &&
          switchSucceeded &&
          options.autoResume !== false &&
          (canAutoResumeWarm || canAutoReviveCold)
        ) {
          // Atomically hand off switchingModel -> waking so the switched member immediately resumes!
          activeLive.switchingModel = false;
          activeLive.waking = true;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          if (canAutoResumeWarm) {
            void this.drainMemberPendingWakes(run.id, member.name, resumePromptText);
          } else {
            void this.reviveMemberWithPendingWakes(run.id, member.name, resumePromptText);
          }
        } else if (
          stillLive &&
          lockStillHeld &&
          !this.disposed &&
          this.activeRunId === run.id &&
          this.cachedRun?.status === "active" &&
          (canAutoResumeWarm || canAutoReviveCold) &&
          activeLive.pendingWakes.length > 0
        ) {
          // Atomically hand off switchingModel -> waking to drain wakes queued during switch!
          activeLive.switchingModel = false;
          activeLive.waking = true;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          if (canAutoResumeWarm) {
            void this.drainMemberPendingWakes(run.id, member.name);
          } else {
            void this.reviveMemberWithPendingWakes(run.id, member.name);
          }
        } else {
          activeLive.switchingModel = false;
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
        }
      }
    }
  }

  async steerMember(
    memberName: string,
    message: string,
    mode: "steer" | "followUp" = "steer",
    options?: { callerName?: string; callerRole?: CallerRole },
  ): Promise<{ delivery: "steered" | "followUp" | "woken" }> {
    const run = this.requireActiveRun();
    if (run.status !== "active") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot steer members while Swarm run is ${run.status}.`,
      );
    }
    const member = this.findMember(run, memberName);
    if (!member) {
      throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
    }

    const callerRole: CallerRole = options?.callerRole ?? "orchestrator";
    const callerName =
      options?.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    if (callerRole === "worker" || callerRole === "validator") {
      if (member.parentName !== callerName) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" may only steer helpers it added, not "@${member.name}".`,
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError("PERMISSION_DENIED", `Role "${callerRole}" cannot steer members.`);
    }

    if (member.state === "killed") {
      throw new SwarmProtocolError("MEMBER_KILLED", `Member "@${member.name}" has been killed.`);
    }

    const trimmedMsg = message.trim();
    if (!trimmedMsg) {
      throw new SwarmProtocolError("INVALID_INPUT", "Steering message must be non-empty.");
    }

    const live = this.liveMembers.get(member.name);
    if (live) {
      this.cancelMemberRetryTimer(live);
    }
    const isLiveWorking = Boolean(live?.handle) && live!.handle!.getState() === "working";

    if (isLiveWorking && live?.handle) {
      if (mode === "followUp") {
        await live.handle.followUp(trimmedMsg);
        return { delivery: "followUp" };
      }
      await live.handle.steer(trimmedMsg);
      return { delivery: "steered" };
    }

    // Parked waiting or stopped -> wake/revive cleanly via board post targeting @<member>
    await this.postMessage({
      from: callerName,
      fromRole: callerRole,
      channel: member.channels[0] ?? DEFAULT_CHANNEL,
      kind: "decision",
      text: `@${member.name} [steer] ${trimmedMsg}`,
    });
    return { delivery: "woken" };
  }

  async stopMember(memberName: string, options?: StopMemberOptions): Promise<void> {
    const run = this.requireActiveRun();
    const member = this.findMember(run, memberName);
    if (!member) {
      throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
    }

    const callerRole: CallerRole = options?.callerRole ?? "orchestrator";
    const callerName =
      options?.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    if (callerRole === "worker" || callerRole === "validator") {
      if (member.name !== callerName && member.parentName !== callerName) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" may only stop itself or helpers it added, not "@${member.name}".`,
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError("PERMISSION_DENIED", `Role "${callerRole}" cannot stop members.`);
    }

    if (member.state === "killed") {
      throw new SwarmProtocolError("MEMBER_KILLED", `Member "@${member.name}" is already killed.`);
    }

    let capturedSessionFile = member.sessionFile;
    const live = this.liveMembers.get(member.name);
    if (live) {
      this.cancelMemberRetryTimer(live);
      live.launchAbort?.abort();
      live.attemptToken = undefined;
      live.spawning = false;
      live.waking = false;
      live.turnActive = false;
      live.switchingModel = false;
      live.pendingSelfModelSwitch = undefined;
      live.lastWaitRequest = undefined;
      live.parkedMentionsOnly = true;
      live.currentActivity = undefined;
      live.pendingWakes.length = 0;
      if (live.handle) {
        const handle = live.handle;
        await handle.abort(options?.reason ?? "Stopped").catch(() => {});
        await Promise.race([
          handle.currentTurn.catch(() => {}),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 250);
            t.unref?.();
          }),
        ]);
        live.lastMessages = sanitizeForkSeedMessages(handle.getConversationMessages());
        capturedSessionFile = handle.getSessionFile?.() ?? capturedSessionFile;
        await handle.kill(options?.reason ?? "Stopped").catch(() => {});
        live.handle = undefined;
      }
      live.releaseSlot?.();
      live.releaseSlot = undefined;
    }

    const humanStopped = options?.humanStopped ?? callerRole === "human";
    const updated = await this.store.updateMember(run.id, member.name, {
      state: "stopped",
      humanStopped,
      ...(capturedSessionFile ? { sessionFile: capturedSessionFile } : {}),
      currentActivity: null,
      parkedOn: options?.reason ?? (humanStopped ? "stopped by user" : "stopped"),
      actor: callerName,
    });
    await this.refreshCache(updated);
    this.emitEngineEvent("snapshot_changed", `Stopped @${member.name}`, {
      memberName: member.name,
    });
    this.checkAllIdleAndNotifyWaiters();
    this.maybeArmStallWatchdog();
  }

  async killMember(memberName: string, options?: KillMemberOptions): Promise<void> {
    const run = this.requireActiveRun();
    const member = this.findMember(run, memberName);
    if (!member) {
      throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
    }

    const callerRole: CallerRole = options?.callerRole ?? "orchestrator";
    const callerName =
      options?.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    // Permission boundary: workers/validators may ONLY kill helpers they added!
    if (callerRole === "worker" || callerRole === "validator") {
      if (member.parentName !== callerName) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" may only kill helpers it added, not "@${member.name}".`,
          { callerName, targetName: member.name, parentName: member.parentName },
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError("PERMISSION_DENIED", `Role "${callerRole}" cannot kill members.`);
    }

    if (member.state === "killed") {
      return;
    }

    const hasOwnWorktree =
      (member.workspace === "share" || member.workspace === "branch") &&
      Boolean(member.cwd) &&
      member.cwd !== this.worktree.repoRoot;

    // Dirty worktree guard BEFORE killing / deleting worktree!
    if (hasOwnWorktree && !options?.force) {
      const dirty = await this.worktree.isWorktreeDirty(member.cwd).catch(() => false);
      if (dirty) {
        throw new SwarmProtocolError(
          "DIRTY_WORKTREE",
          `Refusing to delete dirty worktree for "@${member.name}" (${member.cwd}). Commit/merge its changes first or pass force=true.`,
          { memberName: member.name, worktreePath: member.cwd },
        );
      }
    }

    const live = this.liveMembers.get(member.name);
    if (live) {
      this.cancelMemberRetryTimer(live);
      live.launchAbort?.abort();
      live.attemptToken = undefined;
      live.spawning = false;
      live.waking = false;
      live.turnActive = false;
      live.switchingModel = false;
      live.pendingSelfModelSwitch = undefined;
      live.lastWaitRequest = undefined;
      live.parkedMentionsOnly = true;
      live.currentActivity = undefined;
      live.pendingWakes.length = 0;
      if (live.handle) {
        await live.handle.kill(options?.reason ?? "Killed").catch(() => {});
      }
      live.releaseSlot?.();
      live.releaseSlot = undefined;
      this.liveMembers.delete(member.name);
    }

    if (hasOwnWorktree) {
      try {
        // Preserve committed unmerged branches from isolated `branch` clones in base repo before deleting clone dir!
        if (
          member.workspace === "branch" &&
          member.branch &&
          !member.mergedCommitSha &&
          this.worktree.fetchBranchFromClone
        ) {
          if (options?.force) {
            await this.worktree.fetchBranchFromClone(member.cwd, member.branch).catch(() => {});
          } else {
            await this.worktree.fetchBranchFromClone(member.cwd, member.branch);
          }
        }
        await this.worktree.removeWorktree(member.cwd, { force: Boolean(options?.force) });
      } catch (err) {
        if (member.state === "working" || member.state === "waiting") {
          const stoppedRun = await this.store
            .updateMember(run.id, member.name, {
              state: "stopped",
              currentActivity: null,
              parkedOn: "kill worktree cleanup failed",
              actor: callerName,
            })
            .catch(() => undefined);
          if (stoppedRun) {
            await this.refreshCache(stoppedRun);
            this.emitEngineEvent("snapshot_changed", `Stopped @${member.name} after kill cleanup error`, {
              memberName: member.name,
            });
          }
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        throw err;
      }
    }

    const nowIso = new Date(this.nowFn()).toISOString();
    const updated = await this.store.updateMember(run.id, member.name, {
      state: "killed",
      currentActivity: null,
      parkedOn: options?.reason ?? "killed",
      endedAt: nowIso,
      actor: callerName,
    });
    await this.refreshCache(updated);
    this.emitEngineEvent("snapshot_changed", `Killed @${member.name}`, {
      memberName: member.name,
    });
    this.checkAllIdleAndNotifyWaiters();
    this.maybeArmStallWatchdog();
  }

  async mergeMember(
    memberName: string,
    options?: MergeMemberOptions,
  ): Promise<MergeBranchResult | null> {
    if (!isOrchestratorOrHuman(options?.callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${options?.callerRole}" is not allowed to merge worktrees. Only @${ORCHESTRATOR_NAME} can merge.`,
      );
    }
    const run = this.requireActiveRun();
    const member = this.findMember(run, memberName);
    if (!member) {
      throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
    }

    if (member.workspace === "inherit" || !member.branch) {
      return null;
    }

    const live = this.liveMembers.get(member.name);
    const liveState = live?.handle?.getState() ?? member.state;
    if (
      member.state === "working" ||
      liveState === "working" ||
      live?.spawning ||
      live?.waking ||
      live?.turnActive ||
      live?.switchingModel
    ) {
      throw new SwarmProtocolError(
        "MEMBER_NOT_WAITING",
        `Cannot merge "@${member.name}" while it is still working. Wait until it parks in waiting state.`,
        { memberName: member.name },
      );
    }

    // 1. Verify member worktree is clean (skip if already removed after kill — branch still exists!)
    if (member.state !== "killed" && member.cwd && member.cwd !== this.worktree.repoRoot) {
      const dirty = await this.worktree.isWorktreeDirty(member.cwd);
      if (dirty) {
        throw new SwarmProtocolError(
          "DIRTY_WORKTREE",
          `Worktree for "@${member.name}" (${member.cwd}) has uncommitted changes. Ask @${member.name} to commit cleanly before merging.`,
          { memberName: member.name, worktreePath: member.cwd },
        );
      }
    }

    // 2. Verify base checkout is clean and on run.baseBranch
    const baseCheck = await this.worktree.isBaseCleanOnBranch(run.baseBranch);
    if (!baseCheck.ok) {
      if (baseCheck.currentBranch && baseCheck.currentBranch !== run.baseBranch) {
        throw new SwarmProtocolError(
          "WRONG_BRANCH",
          baseCheck.reason ??
            `Base repository is on "${baseCheck.currentBranch}", expected "${run.baseBranch}".`,
          { expected: run.baseBranch, actual: baseCheck.currentBranch },
        );
      }
      throw new SwarmProtocolError(
        "DIRTY_BASE",
        baseCheck.reason ?? `Base branch "${run.baseBranch}" has uncommitted changes.`,
        { baseBranch: run.baseBranch },
      );
    }

    // 3. Auto-rebase onto baseBranch when enabled and worktree is live
    const settings = this.getEffectiveSettings();
    if (
      settings.autoRebase &&
      member.state !== "killed" &&
      member.cwd &&
      member.cwd !== this.worktree.repoRoot
    ) {
      const rebaseRes = await this.worktree.autoRebase(member.cwd, run.baseBranch);
      if (rebaseRes.status === "conflict") {
        throw new SwarmProtocolError(
          "REBASE_CONFLICT",
          rebaseRes.message ??
            `Rebase conflict while rebasing "${member.branch}" onto "${run.baseBranch}".`,
          {
            memberName: member.name,
            branch: member.branch,
            conflictFiles: rebaseRes.conflictFiles ?? [],
          },
        );
      }
      if (rebaseRes.status === "skipped_dirty") {
        throw new SwarmProtocolError(
          "DIRTY_WORKTREE",
          rebaseRes.message ?? `Worktree for "@${member.name}" is dirty.`,
          { memberName: member.name },
        );
      }
    }

    // 4. Merge branch into baseBranch
    const mergeRes = await this.worktree.mergeBranch({
      baseBranch: run.baseBranch,
      branch: member.branch,
      commitMessage:
        options?.commitMessage ?? `swarm(${member.name}): merge ${member.branch}`,
      noFf: options?.noFf ?? true,
      sourceWorktreePath: member.cwd,
    });

    const actor = options?.callerName ?? ORCHESTRATOR_NAME;
    const updated = await this.store.updateMember(run.id, member.name, {
      mergedCommitSha: mergeRes.mergedCommitSha,
      actor,
    });
    await this.refreshCache(updated);
    this.emitEngineEvent(
      "snapshot_changed",
      `Merged @${member.name} (${member.branch}) -> ${mergeRes.mergedCommitSha.slice(0, 12)}`,
      { memberName: member.name },
    );

    return mergeRes;
  }

  // --------------------------------------------------------------------------
  // Channels
  // --------------------------------------------------------------------------

  async manageChannel(input: ManageChannelInput): Promise<ManageChannelResult> {
    const run = this.requireActiveRun();
    const callerRole: CallerRole = input.callerRole ?? "orchestrator";
    const callerName =
      input.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    switch (input.action) {
      case "list": {
        const channels = Object.values(run.channels);
        const lines = channels.map(
          (c) =>
            `#${c.name}${c.archived ? " [archived]" : ""} (${c.subscribers.length} subscribers)${c.topic ? ` — ${c.topic}` : ""}`,
        );
        return {
          action: "list",
          channels,
          summary:
            channels.length > 0
              ? `Channels (${channels.length}):\n${lines.join("\n")}`
              : "No channels.",
        };
      }

      case "create": {
        if (!isOrchestratorOrHuman(callerRole)) {
          throw new SwarmProtocolError(
            "PERMISSION_DENIED",
            `Role "${callerRole}" cannot create channels. Ask @${ORCHESTRATOR_NAME}.`,
          );
        }
        const name = validateChannelName(input.name ?? "");
        if (name === DEFAULT_CHANNEL) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            'Channel "#main" already exists by default.',
          );
        }
        if (run.channels && Object.hasOwn(run.channels, name)) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            `Channel "#${name}" already exists.`,
            { channel: name },
          );
        }
        const created = await this.store.createChannel(run.id, {
          name,
          topic: input.topic?.trim() || undefined,
          createdBy: callerName,
        });
        await this.refreshCache();
        this.emitEngineEvent("snapshot_changed", `Created channel #${created.name}`);
        return {
          action: "create",
          channel: created,
          summary: `Created channel #${created.name}${created.topic ? ` — ${created.topic}` : ""}.`,
        };
      }

      case "archive": {
        if (!isOrchestratorOrHuman(callerRole)) {
          throw new SwarmProtocolError(
            "PERMISSION_DENIED",
            `Role "${callerRole}" cannot archive channels. Ask @${ORCHESTRATOR_NAME}.`,
          );
        }
        const name = validateChannelName(input.name ?? "");
        if (name === DEFAULT_CHANNEL) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            'Default channel "#main" cannot be archived.',
          );
        }
        if (!getOwnChannel(run, name)) {
          throw new SwarmProtocolError("INVALID_CHANNEL", `Channel "#${name}" does not exist.`);
        }
        const archived = await this.store.archiveChannel(run.id, name, callerName);
        await this.refreshCache();
        this.emitEngineEvent("snapshot_changed", `Archived channel #${archived.name}`);
        return {
          action: "archive",
          channel: archived,
          summary: `Archived channel #${archived.name}.`,
        };
      }

      case "join":
      case "leave": {
        const name = validateChannelName(input.name ?? "");
        const channelRecord = getOwnChannel(run, name);
        if (!channelRecord) {
          throw new SwarmProtocolError("INVALID_CHANNEL", `Channel "#${name}" does not exist.`);
        }
        if (input.action === "join" && channelRecord.archived) {
          throw new SwarmProtocolError(
            "CHANNEL_ARCHIVED",
            `Channel "#${name}" is archived and cannot be joined.`,
          );
        }
        if (input.action === "leave" && name === DEFAULT_CHANNEL) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            'Members cannot leave default channel "#main".',
          );
        }

        const targetName =
          input.member?.trim().replace(/^@/, "") ||
          (callerRole === "worker" || callerRole === "validator" ? callerName : "");
        if (!targetName) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            `Member name is required for channel "${input.action}".`,
          );
        }
        const member = this.findMember(run, targetName);
        if (!member) {
          throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${targetName}" not found.`);
        }
        if (member.state === "killed") {
          throw new SwarmProtocolError("MEMBER_KILLED", `Member "@${member.name}" is killed.`);
        }

        if (callerRole === "worker" || callerRole === "validator") {
          if (member.name !== callerName && member.parentName !== callerName) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Member "@${callerName}" may only change channel membership for itself or its helpers, not "@${member.name}".`,
            );
          }
        } else if (!isOrchestratorOrHuman(callerRole)) {
          throw new SwarmProtocolError(
            "PERMISSION_DENIED",
            `Role "${callerRole}" cannot modify channel subscriptions.`,
          );
        }

        const updatedChannel =
          input.action === "join"
            ? await this.store.subscribeChannel(run.id, name, member.name)
            : await this.store.unsubscribeChannel(run.id, name, member.name);
        await this.refreshCache();
        this.emitEngineEvent(
          "snapshot_changed",
          `${member.name} ${input.action === "join" ? "joined" : "left"} #${name}`,
          { memberName: member.name },
        );
        return {
          action: input.action,
          channel: updatedChannel,
          summary: `@${member.name} ${input.action === "join" ? "joined" : "left"} #${name}.`,
        };
      }

      default:
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Unsupported channel action: ${String(input.action)}`,
        );
    }
  }

  // --------------------------------------------------------------------------
  // Teardown, Models, Snapshot, Subscription & Dispose
  // --------------------------------------------------------------------------

  async teardown(options?: TeardownOptions): Promise<SafeTeardownResult> {
    const targetRunId = options?.runId?.trim() || this.activeRunId;
    if (!targetRunId) {
      throw new SwarmProtocolError("NOT_FOUND", "No Swarm run specified for teardown.");
    }
    const run = await this.store.loadRun(targetRunId);
    const sid = options?.sessionId?.trim();
    if (sid) {
      if (this.store.assertOwnerSession) {
        await this.store.assertOwnerSession(run, sid);
      } else {
        assertOwnerSession(run, sid);
      }
    }
    const targets: SafeTeardownTarget[] = [];

    for (const member of Object.values(run.members)) {
      if (
        (member.workspace === "share" || member.workspace === "branch") &&
        member.cwd &&
        member.branch &&
        member.cwd !== this.worktree.repoRoot
      ) {
        const live = this.liveMembers.get(member.name);
        const hasActiveAgent =
          member.state === "working" ||
          Boolean(live?.spawning) ||
          Boolean(live?.waking) ||
          Boolean(live?.turnActive) ||
          Boolean(live?.switchingModel) ||
          live?.handle?.getState() === "working";
        targets.push({
          memberName: member.name,
          worktreePath: member.cwd,
          branch: member.branch,
          hasActiveAgent,
        });
      }
    }

    const result = await this.worktree.safeTeardown(targets, {
      deleteBranches: options?.deleteBranches ?? false,
      force: options?.force ?? false,
    });

    await this.store.appendEvent({
      runId: run.id,
      type: "teardown_completed",
      actor: ORCHESTRATOR_NAME,
      summary: `Teardown removed ${result.removed.length}, skipped ${result.skipped.length}, errors ${result.errors.length}`,
      data: {
        removed: result.removed.map((r) => r.memberName),
        skipped: result.skipped.map((s) => ({ memberName: s.memberName, action: s.action })),
        errors: result.errors.map((e) => ({ memberName: e.memberName, reason: e.reason })),
      },
    });

    if (this.activeRunId === run.id) {
      await this.refreshCache();
      this.emitEngineEvent("snapshot_changed", `Teardown completed for run ${run.id}.`);
    }

    return result;
  }

  async listModels(options?: {
    all?: boolean;
    hostContext?: ExtensionContext;
  }): Promise<AvailableModelInfo[]> {
    const ctx = options?.hostContext ?? this.hostContext;
    const raw = (await this.transport.listAvailableModels?.(ctx)) ?? [];
    const settings = this.getEffectiveSettings();

    const roleMap = new Map<string, SwarmModelRole[]>();
    const addRole = (model: string | undefined, role: SwarmModelRole): void => {
      const key = model?.trim().toLowerCase();
      if (!key) return;
      const list = roleMap.get(key) ?? [];
      if (!list.includes(role)) {
        list.push(role);
      }
      roleMap.set(key, list);
    };
    addRole(settings.orchestratorModel, "orchestrator");
    addRole(settings.workerModel, "worker");
    addRole(settings.validatorModel, "validator");

    const enriched: AvailableModelInfo[] = raw.map((m) => {
      const roles = [
        ...(roleMap.get(m.fullId.toLowerCase()) ?? []),
        ...(roleMap.get(m.id.toLowerCase()) ?? []),
      ];
      const uniqueRoles = Array.from(new Set(roles));
      return {
        ...m,
        suggested: m.suggested ?? uniqueRoles.length > 0,
        ...(uniqueRoles.length > 0 ? { activeRoles: uniqueRoles } : {}),
      };
    });

    if (options?.all || enriched.length <= 20) {
      return enriched;
    }
    const suggested = enriched.filter((m) => m.suggested || (m.activeRoles?.length ?? 0) > 0);
    return suggested.length > 0 ? suggested : enriched.slice(0, 20);
  }

  getSnapshot(): SwarmSnapshot {
    const run = this.cachedRun;
    const settings = this.getEffectiveSettings();
    const roleModels = buildRoleModelsSnapshot(settings, run?.roleModels);

    let totalTokens = this.monitorTokens;
    let totalCost = this.monitorCost;
    const workingMemberNames: string[] = [];
    const waitingMemberNames: string[] = [];

    if (run) {
      for (const name of run.memberOrder) {
        const m = getOwnMember(run, name);
        if (!m) continue;
        totalTokens += m.tokens;
        totalCost += m.cost;
        const live = this.liveMembers.get(m.name);
        const isWorking =
          m.state === "working" ||
          Boolean(live?.spawning) ||
          Boolean(live?.waking) ||
          Boolean(live?.turnActive) ||
          Boolean(live?.switchingModel) ||
          live?.handle?.getState() === "working";
        if (isWorking && m.state !== "killed") {
          workingMemberNames.push(m.name);
        } else if (m.state === "waiting") {
          waitingMemberNames.push(m.name);
        }
      }
    }

    const backoffUntil = this.rateLimitBreaker.getBackoffUntil();
    return {
      run,
      activeRunId: this.activeRunId,
      workingMemberNames,
      waitingMemberNames,
      boardHead: run?.boardHead ?? 0,
      recentBoard: [...this.cachedBoard],
      recentEvents: [...this.cachedEvents],
      roleModels,
      totalTokens,
      totalCost,
      ...(backoffUntil > 0
        ? {
            rateLimitUntil: backoffUntil,
            rateLimitReason: this.rateLimitBreaker.getLastReason(),
          }
        : {}),
      updatedAt: new Date(this.nowFn()).toISOString(),
    };
  }

  subscribe(listener: (event: SwarmEngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelStallWatchdog();
    await this.cancelActiveMonitor("Engine disposed");
    this.clearOrchestratorWait("Swarm engine disposed.");
    this.resolveAllWaiters("run_ended", "Swarm engine disposed.");
    await this.disposeLiveHandles("Engine disposed");
    this.listeners.clear();
  }

  // --------------------------------------------------------------------------
  // Internal Member Launch, Wakeup & Turn Lifecycle
  // --------------------------------------------------------------------------

  private async launchMemberInitialTurn(
    runId: string,
    memberName: string,
    briefSeq: number,
    seedMessages: AgentMessage[] | undefined,
    hostContext: ExtensionContext | undefined,
  ): Promise<void> {
    const live = this.liveMembers.get(memberName);
    if (!live || this.disposed) {
      return;
    }

    const launchAbort = new AbortController();
    const attemptToken = Symbol("launch");
    live.launchAbort = launchAbort;
    live.attemptToken = attemptToken;

    const isCurrentAttempt = (): boolean =>
      this.liveMembers.get(memberName) === live && live.attemptToken === attemptToken;

    const isCancelled = (): boolean =>
      this.disposed ||
      this.activeRunId !== runId ||
      !isCurrentAttempt() ||
      launchAbort.signal.aborted;

    let release: (() => void) | undefined;
    const releaseCurrentSlot = (): void => {
      if (release) {
        const fn = release;
        release = undefined;
        fn();
        if (live.releaseSlot === fn) {
          live.releaseSlot = undefined;
        }
      }
    };

    try {
      release = await this.concurrencyGate.acquire(launchAbort.signal);
      if (isCurrentAttempt()) {
        live.releaseSlot = release;
      } else {
        releaseCurrentSlot();
        return;
      }

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.spawning = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const run = await this.store.loadRun(runId);
      const member = getOwnMember(run, memberName);
      if (isCancelled() || !member || member.state === "killed" || member.state === "stopped" || run.status !== "active") {
        if (isCurrentAttempt()) {
          live.spawning = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const systemPrompt = buildMemberSystemPrompt(run, member);
      const initialPrompt = buildMemberInitialPrompt(run, member, briefSeq);
      const engineApi = this.createMemberBridge(runId, member);
      const isIsolatedWorktree =
        member.workspace !== "inherit" ||
        path.resolve(member.cwd) !== path.resolve(this.store.projectRoot);
      live.lastWaitRequest = undefined;

      const handle = await this.transport.spawnMember({
        agentId: member.agentId,
        name: member.name,
        role: member.role,
        runId,
        cwd: member.cwd,
        branch: member.branch,
        baseBranch: run.baseBranch,
        workspace: member.workspace,
        isIsolatedWorktree,
        parentName: member.parentName,
        brief: member.brief,
        systemPrompt,
        initialPrompt,
        keepWarm: run.keepWorkersWarm,
        modelOverride: member.model,
        thinkingLevel: member.thinkingLevel,
        seedMessages,
        sessionDir: this.store.getMemberSessionDir?.(runId),
        sessionFile: member.sessionFile,
        hostContext,
        onTelemetry: (evt) => this.handleTelemetry(runId, evt),
        engineApi,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.spawning = false;
        }
        await handle.kill("Cancelled during launch").catch(() => {});
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      live.handle = handle;
      live.spawning = false;
      live.turnActive = true;

      const resolvedModel = handle.getModel();
      if (resolvedModel) {
        live.triedModels.add(resolvedModel);
      }
      const sessionFile = handle.getSessionFile?.() ?? member.sessionFile;

      const startActivity =
        member.role === "validator" ? "validating" : "working on assignment";
      live.currentActivity = startActivity;

      const updated = await this.store.updateMember(runId, memberName, {
        state: "working",
        model: resolvedModel ?? member.model,
        thinkingLevel: handle.getThinkingLevel() ?? member.thinkingLevel ?? null,
        ...(sessionFile ? { sessionFile } : {}),
        currentActivity: startActivity,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.turnActive = false;
        }
        await handle.kill("Cancelled after launch").catch(() => {});
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }

      this.setCachedRun(updated);
      this.emitEngineEvent("snapshot_changed", `Started @${memberName}`, { memberName });

      const result = await handle.currentTurn;
      releaseCurrentSlot();

      await this.handleTurnFinished(runId, memberName, result, attemptToken);
    } catch (err) {
      if (isCurrentAttempt()) {
        live.spawning = false;
        live.turnActive = false;
      }
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
      if (isAbortError(err) || isCancelled()) {
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleLaunchError(runId, memberName, errMsg, attemptToken);
    } finally {
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
    }
  }

  private async drainMemberPendingWakes(
    runId: string,
    memberName: string,
    directPrompt?: string,
  ): Promise<void> {
    const live = this.liveMembers.get(memberName);
    if (!live || this.disposed) {
      return;
    }

    const launchAbort = new AbortController();
    const attemptToken = Symbol("wake");
    live.launchAbort = launchAbort;
    live.attemptToken = attemptToken;

    const isCurrentAttempt = (): boolean =>
      this.liveMembers.get(memberName) === live && live.attemptToken === attemptToken;

    const isCancelled = (): boolean =>
      this.disposed ||
      this.activeRunId !== runId ||
      !isCurrentAttempt() ||
      launchAbort.signal.aborted;

    let release: (() => void) | undefined;
    const releaseCurrentSlot = (): void => {
      if (release) {
        const fn = release;
        release = undefined;
        fn();
        if (live.releaseSlot === fn) {
          live.releaseSlot = undefined;
        }
      }
    };

    try {
      release = await this.concurrencyGate.acquire(launchAbort.signal);
      if (isCurrentAttempt()) {
        live.releaseSlot = release;
      } else {
        releaseCurrentSlot();
        return;
      }

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const run = await this.store.loadRun(runId);
      const member = getOwnMember(run, memberName);
      if (
        isCancelled() ||
        !member ||
        member.state === "killed" ||
        (member.state === "stopped" && member.humanStopped) ||
        run.status !== "active"
      ) {
        if (isCurrentAttempt()) {
          live.waking = false;
          live.pendingWakes.length = 0;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const batch = live.pendingWakes.splice(0, live.pendingWakes.length);
      if (batch.length === 0 && !directPrompt) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      // If persisted stopped (non-humanStopped) or no warm waiting handle, revive fresh handle
      if (member.state === "stopped" || !live.handle || live.handle.getState() !== "waiting") {
        live.pendingWakes.unshift(...batch);
        releaseCurrentSlot();
        await this.reviveMemberWithPendingWakes(runId, memberName, directPrompt);
        return;
      }

      const maxSeq = batch.reduce((acc, m) => Math.max(acc, m.seq), member.lastReadSeq);
      const prompt =
        directPrompt && batch.length > 0
          ? `${directPrompt}\n\n${buildWakeupPrompt(member, batch, run.boardHead)}`
          : (directPrompt ?? buildWakeupPrompt(member, batch, run.boardHead));

      live.parkedMentionsOnly = true;
      live.currentActivity = "woken by board";

      const updated = await this.store.updateMember(runId, memberName, {
        state: "working",
        humanStopped: false,
        lastReadSeq: Math.max(member.lastReadSeq, maxSeq),
        currentActivity: "woken by board",
        error: null,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
          live.turnActive = false;
        }
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      this.setCachedRun(updated);

      await this.store.appendEvent({
        runId,
        type: "member_woken",
        actor: batch[0]?.from ?? ORCHESTRATOR_NAME,
        memberName: member.name,
        agentId: member.agentId,
        summary:
          batch.length > 0
            ? `Woke @${member.name} with ${batch.length} board message(s) (${batch.map((m) => `#${m.seq}`).join(", ")})`
            : `Woke @${member.name} after model hot-switch`,
      });

      if (isCancelled() || !live.handle || live.handle.getState() !== "waiting") {
        if (isCurrentAttempt()) {
          live.waking = false;
          live.turnActive = false;
        }
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      this.emitEngineEvent("snapshot_changed", `Woke @${memberName}`, { memberName });

      live.turnActive = true;
      live.lastWaitRequest = undefined;
      const turnPromise = live.handle.wake(prompt);
      for (const m of batch) {
        live.deliveredSeqs.add(m.seq);
      }
      // Handle is now synchronously in `working` state; clear waking lock so new posts queue into pendingWakes!
      live.waking = false;
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }

      const result = await turnPromise;
      releaseCurrentSlot();

      await this.handleTurnFinished(runId, memberName, result, attemptToken);
    } catch (err) {
      if (isCurrentAttempt()) {
        live.waking = false;
        live.turnActive = false;
      }
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
      if (isAbortError(err) || isCancelled()) {
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleLaunchError(runId, memberName, errMsg, attemptToken);
    } finally {
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
    }
  }

  private async reviveMemberWithPendingWakes(
    runId: string,
    memberName: string,
    directPrompt?: string,
  ): Promise<void> {
    const live = this.liveMembers.get(memberName);
    if (!live || this.disposed) {
      return;
    }

    const launchAbort = new AbortController();
    const attemptToken = Symbol("revive");
    live.launchAbort = launchAbort;
    live.attemptToken = attemptToken;

    const isCurrentAttempt = (): boolean =>
      this.liveMembers.get(memberName) === live && live.attemptToken === attemptToken;

    const isCancelled = (): boolean =>
      this.disposed ||
      this.activeRunId !== runId ||
      !isCurrentAttempt() ||
      launchAbort.signal.aborted;

    let release: (() => void) | undefined;
    const releaseCurrentSlot = (): void => {
      if (release) {
        const fn = release;
        release = undefined;
        fn();
        if (live.releaseSlot === fn) {
          live.releaseSlot = undefined;
        }
      }
    };

    try {
      release = await this.concurrencyGate.acquire(launchAbort.signal);
      if (isCurrentAttempt()) {
        live.releaseSlot = release;
      } else {
        releaseCurrentSlot();
        return;
      }

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const run = await this.store.loadRun(runId);
      const member = getOwnMember(run, memberName);
      if (isCancelled() || !member || member.state === "killed" || run.status !== "active") {
        if (isCurrentAttempt()) {
          live.waking = false;
          live.pendingWakes.length = 0;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const batch = live.pendingWakes.splice(0, live.pendingWakes.length);
      if (batch.length === 0 && !directPrompt) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      // Cleanly dispose any stale handle before spawning replacement
      if (live.handle) {
        live.lastMessages = sanitizeForkSeedMessages(live.handle.getConversationMessages());
        await live.handle.kill("Reviving stopped member").catch(() => {});
        if (isCurrentAttempt()) {
          live.handle = undefined;
        }
      }

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const maxSeq = batch.reduce((acc, m) => Math.max(acc, m.seq), member.lastReadSeq);
      const prompt =
        directPrompt && batch.length > 0
          ? `${directPrompt}\n\n${buildWakeupPrompt(member, batch, run.boardHead)}`
          : (directPrompt ?? buildWakeupPrompt(member, batch, run.boardHead));
      const systemPrompt = buildMemberSystemPrompt(run, member);
      const engineApi = this.createMemberBridge(runId, member);

      // Accumulate persisted usage from prior handle lifetimes before spawning replacement handle
      live.priorHandlesTokens = member.tokens;
      live.priorHandlesBreakdown = member.tokenBreakdown
        ? { ...member.tokenBreakdown }
        : undefined;
      live.priorHandlesCost = member.cost;
      const isIsolatedWorktree =
        member.workspace !== "inherit" ||
        path.resolve(member.cwd) !== path.resolve(this.store.projectRoot);
      live.lastWaitRequest = undefined;

      const handle = await this.transport.spawnMember({
        agentId: member.agentId,
        name: member.name,
        role: member.role,
        runId,
        cwd: member.cwd,
        branch: member.branch,
        baseBranch: run.baseBranch,
        workspace: member.workspace,
        isIsolatedWorktree,
        parentName: member.parentName,
        brief: member.brief,
        systemPrompt,
        initialPrompt: prompt,
        keepWarm: run.keepWorkersWarm,
        modelOverride: member.model,
        thinkingLevel: member.thinkingLevel,
        seedMessages: live.lastMessages.length > 0 ? live.lastMessages : undefined,
        sessionDir: this.store.getMemberSessionDir?.(runId),
        sessionFile: member.sessionFile,
        hostContext: this.hostContext,
        onTelemetry: (evt) => this.handleTelemetry(runId, evt),
        engineApi,
      });

      // Critically check cancellation IMMEDIATELY after spawnMember so stopped/killed/paused/disposed runs never leak handles!
      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        await handle.kill("Cancelled during revive").catch(() => {});
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      for (const m of batch) {
        live.deliveredSeqs.add(m.seq);
      }
      live.handle = handle;
      live.turnActive = true;
      live.waking = false;
      live.parkedMentionsOnly = true;
      live.currentActivity = "revived by board";
      const latestSessionFile = handle.getSessionFile?.() ?? member.sessionFile;

      const updated = await this.store.updateMember(runId, memberName, {
        state: "working",
        humanStopped: false,
        lastReadSeq: Math.max(member.lastReadSeq, maxSeq),
        ...(latestSessionFile ? { sessionFile: latestSessionFile } : {}),
        currentActivity: "revived by board",
        error: null,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.turnActive = false;
        }
        await handle.kill("Cancelled after revive").catch(() => {});
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      this.setCachedRun(updated);

      await this.store.appendEvent({
        runId,
        type: "member_woken",
        actor: batch[0]?.from ?? ORCHESTRATOR_NAME,
        memberName: member.name,
        agentId: member.agentId,
        summary: `Revived @${member.name} with ${batch.length} board message(s)`,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.turnActive = false;
        }
        await handle.kill("Cancelled after revive").catch(() => {});
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }

      this.emitEngineEvent("snapshot_changed", `Revived @${memberName}`, { memberName });

      const result = await handle.currentTurn;
      releaseCurrentSlot();

      await this.handleTurnFinished(runId, memberName, result, attemptToken);
    } catch (err) {
      if (isCurrentAttempt()) {
        live.waking = false;
        live.turnActive = false;
      }
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
      if (isAbortError(err) || isCancelled()) {
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleLaunchError(runId, memberName, errMsg, attemptToken);
    } finally {
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
    }
  }

  private async ensureNotResurrectedAfterCancel(
    runId: string,
    memberName: string,
    attemptToken?: symbol,
  ): Promise<void> {
    if (this.disposed) return;
    if (attemptToken && this.liveMembers.get(memberName)?.attemptToken !== attemptToken) {
      return;
    }
    try {
      const current = await this.store.loadRun(runId);
      if (attemptToken && this.liveMembers.get(memberName)?.attemptToken !== attemptToken) {
        return;
      }
      const m = getOwnMember(current, memberName);
      if (m && m.state === "working") {
        const reverted = await this.store.updateMember(runId, memberName, {
          state: "stopped",
          currentActivity: null,
        });
        this.setCachedRun(reverted);
      }
    } catch {
      // ignore cleanup error
    }
  }

  private async handleTurnFinished(
    runId: string,
    memberName: string,
    result: AgentTurnResult,
    attemptToken?: symbol,
  ): Promise<void> {
    const live = this.liveMembers.get(memberName);
    if (this.disposed || this.activeRunId !== runId) {
      if (live && (!attemptToken || live.attemptToken === attemptToken)) {
        live.turnActive = false;
      }
      return;
    }
    if (attemptToken && (!live || live.attemptToken !== attemptToken)) {
      return;
    }

    if (live?.handle) {
      live.lastMessages = sanitizeForkSeedMessages(live.handle.getConversationMessages());
    }

    const run = await this.store.loadRun(runId);
    const currentLive = this.liveMembers.get(memberName);
    if (this.disposed || this.activeRunId !== runId) {
      return;
    }
    if (attemptToken && (!currentLive || currentLive.attemptToken !== attemptToken)) {
      return;
    }
    const member = getOwnMember(run, memberName);
    if (!member || member.state === "killed") {
      if (currentLive) currentLive.turnActive = false;
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }
    if (!currentLive || !currentLive.turnActive) {
      // Stopped/paused concurrently while loadRun was in flight; never overwrite stopped back to waiting.
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    const isStillValidTurn = (): boolean =>
      !this.disposed &&
      !this.runDonePosted &&
      this.activeRunId === runId &&
      this.cachedRun?.status === "active" &&
      Boolean(live) &&
      this.liveMembers.get(memberName) === live &&
      (!attemptToken || live!.attemptToken === attemptToken);

    const waitReq = live?.lastWaitRequest;
    if (live) {
      live.lastWaitRequest = undefined;
      live.currentActivity = undefined;
    }

    const nextTurns = member.turns + 1;
    const nextTokens = Math.max(
      member.tokens,
      (live?.priorHandlesTokens ?? 0) + result.tokens,
    );
    const nextTokenBreakdown =
      mergeTokenBreakdown(live?.priorHandlesBreakdown, result.tokenBreakdown) ??
      member.tokenBreakdown;
    const nextCost = Math.max(
      member.cost,
      (live?.priorHandlesCost ?? 0) + result.cost,
    );
    const effectiveModel = result.model ?? live?.handle?.getModel() ?? member.model;
    const effectiveThinking =
      result.thinkingLevel ?? live?.handle?.getThinkingLevel() ?? member.thinkingLevel;
    const latestSessionFile =
      (currentLive?.handle ?? live?.handle)?.getSessionFile?.() ?? member.sessionFile;
    const persistedTelemetry = {
      ...(latestSessionFile ? { sessionFile: latestSessionFile } : {}),
      ...(live && live.logTail.length > 0 ? { logTail: [...live.logTail] } : {}),
      ...(live?.lastTool !== undefined ? { lastTool: live.lastTool } : {}),
    };

    if (result.outcome === "killed") {
      const nowIso = new Date(this.nowFn()).toISOString();
      const updated = await this.store.updateMember(runId, memberName, {
        state: "killed",
        turns: nextTurns,
        tokens: nextTokens,
        tokenBreakdown: nextTokenBreakdown,
        cost: nextCost,
        model: effectiveModel,
        thinkingLevel: effectiveThinking ?? null,
        currentActivity: null,
        parkedOn: result.summary || "killed",
        endedAt: nowIso,
        ...persistedTelemetry,
      });
      this.liveMembers.delete(memberName);
      await this.refreshCache(updated);
      this.emitEngineEvent("snapshot_changed", `@${memberName} killed`, { memberName });
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    if (result.outcome === "stopped") {
      const updated = await this.store.updateMember(runId, memberName, {
        state: "stopped",
        turns: nextTurns,
        tokens: nextTokens,
        tokenBreakdown: nextTokenBreakdown,
        cost: nextCost,
        model: effectiveModel,
        thinkingLevel: effectiveThinking ?? null,
        ...(result.stopReason !== "aborted"
          ? {
              lastReadSeq: Math.max(
                member.lastReadSeq,
                waitReq?.since ?? 0,
                member.lastPostSeq ?? 0,
              ),
            }
          : {}),
        currentActivity: null,
        parkedOn: result.summary?.slice(0, 120) || "stopped",
        ...persistedTelemetry,
      });
      await this.refreshCache(updated);
      if (live) {
        live.parkedMentionsOnly = true;
      }

      // Deferred Self Model Switch when keepWorkersWarm === false: execute model switch and revive onto new model.
      if (
        live?.pendingSelfModelSwitch &&
        !getOwnMember(updated, memberName)?.humanStopped &&
        isStillValidTurn()
      ) {
        const pendingSwitch = live.pendingSelfModelSwitch;
        live.pendingSelfModelSwitch = undefined;
        live.switchingModel = true;
        live.turnActive = false;
        try {
          const switched = await this.performSwitchModel(
            {
              targetName: memberName,
              model: pendingSwitch.model,
              thinkingLevel: pendingSwitch.thinkingLevel,
              reason: pendingSwitch.reason,
              callerName: pendingSwitch.callerName,
              callerRole: pendingSwitch.callerRole,
              autoResume: false,
            },
            { holdSwitchingLock: true },
          );
          if (
            !isStillValidTurn() ||
            !live.switchingModel ||
            getOwnMember(this.cachedRun, memberName)?.humanStopped
          ) {
            live.switchingModel = false;
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          live.waking = true;
          live.switchingModel = false;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          const reasonNote = pendingSwitch.reason ? ` (${pendingSwitch.reason})` : "";
          const resumeMsg = `Self model switch to "${switched.model}"${switched.thinkingLevel ? ` (${switched.thinkingLevel})` : ""} completed${reasonNote} with conversation history preserved. Continue your work immediately.`;
          void this.reviveMemberWithPendingWakes(runId, memberName, resumeMsg);
          return;
        } catch (err) {
          live.switchingModel = false;
          live.pendingWakes.length = 0;
          const switchErr = err instanceof Error ? err.message : String(err);
          if (isStillValidTurn()) {
            await this.postMonitorOrchestratorAlert(
              runId,
              `@${ORCHESTRATOR_NAME} [error] Deferred self model switch for @${memberName} failed: ${switchErr}`,
              "update",
            );
          }
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
          return;
        }
      }

      if (
        live &&
        live.pendingWakes.length > 0 &&
        isStillValidTurn() &&
        !getOwnMember(this.cachedRun, memberName)?.humanStopped &&
        result.stopReason !== "aborted"
      ) {
        live.pendingSelfModelSwitch = undefined;
        live.turnActive = false;
        live.waking = true;
        this.cancelStallWatchdog();
        void this.cancelActiveMonitor("Swarm activity resumed");
        this.emitEngineEvent("snapshot_changed", `@${memberName} stopped`, { memberName });
        void this.reviveMemberWithPendingWakes(runId, memberName);
        return;
      }

      if (live) {
        live.pendingSelfModelSwitch = undefined;
        live.turnActive = false;
      }
      this.emitEngineEvent("snapshot_changed", `@${memberName} stopped`, { memberName });
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    if (result.outcome === "waiting") {
      this.rateLimitBreaker.recordSuccess();
      const parkedOn = waitReq
        ? `waiting (since #${waitReq.since})`
        : result.summary.replace(/\s+/g, " ").trim().slice(0, 120) || "waiting";

      const updated = await this.store.updateMember(runId, memberName, {
        state: "waiting",
        turns: nextTurns,
        tokens: nextTokens,
        tokenBreakdown: nextTokenBreakdown,
        cost: nextCost,
        model: effectiveModel,
        thinkingLevel: effectiveThinking ?? null,
        lastReadSeq: Math.max(member.lastReadSeq, waitReq?.since ?? 0, member.lastPostSeq ?? 0),
        parkedOn,
        currentActivity: null,
        error: null,
        ...persistedTelemetry,
      });
      await this.refreshCache(updated);

      // Remember whether this parked member asked for mentions_only=false so future non-mention posts wake it!
      if (live) {
        live.retryCount = 0;
        live.parkedMentionsOnly = waitReq ? waitReq.mentionsOnly : true;
      }

      // Deferred Self Model Switch (Defect #3): if this member scheduled `swarm{action:"model"}` on itself
      // during this turn, apply the hot switch NOW while parked in waiting, then immediately resume it!
      if (
        live?.pendingSelfModelSwitch &&
        live.handle?.getState() === "waiting" &&
        isStillValidTurn() &&
        !getOwnMember(this.cachedRun, memberName)?.humanStopped
      ) {
        const pendingSwitch = live.pendingSelfModelSwitch;
        live.pendingSelfModelSwitch = undefined;
        live.switchingModel = true;
        live.turnActive = false;
        try {
          const switched = await this.performSwitchModel(
            {
              targetName: memberName,
              model: pendingSwitch.model,
              thinkingLevel: pendingSwitch.thinkingLevel,
              reason: pendingSwitch.reason,
              callerName: pendingSwitch.callerName,
              callerRole: pendingSwitch.callerRole,
              autoResume: false,
            },
            { holdSwitchingLock: true },
          );
          if (
            !isStillValidTurn() ||
            !live.switchingModel ||
            getOwnMember(this.cachedRun, memberName)?.humanStopped
          ) {
            live.switchingModel = false;
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          live.waking = true;
          live.switchingModel = false;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          const reasonNote = pendingSwitch.reason ? ` (${pendingSwitch.reason})` : "";
          const resumeMsg = `Self model hot-switch to "${switched.model}"${switched.thinkingLevel ? ` (${switched.thinkingLevel})` : ""} completed${reasonNote} with full conversation history preserved. Continue your work immediately.`;
          void this.drainMemberPendingWakes(runId, memberName, resumeMsg);
          return;
        } catch (err) {
          live.switchingModel = false;
          const switchErr = err instanceof Error ? err.message : String(err);
          if (isStillValidTurn()) {
            await this.postMonitorOrchestratorAlert(
              runId,
              `@${ORCHESTRATOR_NAME} [error] Deferred self model switch for @${memberName} failed: ${switchErr}`,
              "update",
            );
          }
          if (
            live.pendingWakes.length > 0 &&
            live.handle?.getState() === "waiting" &&
            isStillValidTurn() &&
            !getOwnMember(this.cachedRun, memberName)?.humanStopped
          ) {
            live.waking = true;
            this.cancelStallWatchdog();
            void this.cancelActiveMonitor("Swarm activity resumed");
            void this.drainMemberPendingWakes(runId, memberName);
            return;
          }
          live.pendingWakes.length = 0;
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
          return;
        }
      }

      if (live) {
        live.pendingSelfModelSwitch = undefined;
      }

      // Check for unread non-mention messages if the member explicitly called swarm_wait{mentions_only:false}
      if (live && waitReq && !waitReq.mentionsOnly && isStillValidTurn()) {
        const unread = await this.store.readBoard(runId, {
          since: Math.max(waitReq.since, member.briefSeq ?? 0),
          memberChannels: member.channels,
          limit: 50,
        });
        if (
          !isStillValidTurn() ||
          !live.turnActive ||
          getOwnMember(this.cachedRun, memberName)?.humanStopped
        ) {
          live.turnActive = false;
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
          return;
        }
        for (const msg of unread.messages) {
          if (
            msg.from !== memberName &&
            !live.deliveredSeqs.has(msg.seq) &&
            !live.pendingWakes.some((w) => w.seq === msg.seq)
          ) {
            live.pendingWakes.push(msg);
          }
        }
      }

      // Atomically hand off turnActive -> waking if any wakes coalesced while working/finishing!
      if (live && live.pendingWakes.length > 0 && isStillValidTurn()) {
        live.turnActive = false;
        live.waking = true;
        this.cancelStallWatchdog();
        void this.cancelActiveMonitor("Swarm activity resumed");
        this.emitEngineEvent("snapshot_changed", `@${memberName} parked in waiting`, {
          memberName,
        });
        void this.drainMemberPendingWakes(runId, memberName);
        return;
      }

      if (live) live.turnActive = false;
      this.emitEngineEvent("snapshot_changed", `@${memberName} parked in waiting`, {
        memberName,
      });
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    if (result.outcome === "rate_limited") {
      if (live) {
        live.pendingSelfModelSwitch = undefined;
        if (effectiveModel) {
          live.triedModels.add(effectiveModel);
        }
      }

      const settings = this.getEffectiveSettings();
      const errorText = result.error ?? "Provider rate limited (429)";
      const nextState = live?.handle?.getState() === "waiting" ? "waiting" : "stopped";

      const updated = await this.store.updateMember(runId, memberName, {
        state: nextState,
        turns: nextTurns,
        tokens: nextTokens,
        tokenBreakdown: nextTokenBreakdown,
        cost: nextCost,
        model: effectiveModel,
        thinkingLevel: effectiveThinking ?? null,
        currentActivity: null,
        parkedOn: `rate limited: ${errorText.slice(0, 80)}`,
        error: errorText,
        ...persistedTelemetry,
      });
      await this.refreshCache(updated);

      // Attempt automatic hot-switch to next untried fallback model with ZERO lock gap!
      const fallback = selectFallbackModel(
        effectiveModel,
        settings.fallbackModels,
        live?.triedModels,
      );
      if (
        fallback &&
        live &&
        live.handle?.getState() === "waiting" &&
        isStillValidTurn() &&
        !getOwnMember(this.cachedRun, memberName)?.humanStopped
      ) {
        live.triedModels.add(fallback);
        // Atomic handoff: turnActive -> switchingModel (prevents concurrent @mention from racing wake!)
        live.switchingModel = true;
        live.turnActive = false;
        try {
          await this.performSwitchModel(
            {
              targetName: memberName,
              model: fallback,
              reason: `Auto-fallback after rate limit (${errorText})`,
              callerName: ORCHESTRATOR_NAME,
              callerRole: "orchestrator",
              autoResume: false,
            },
            { holdSwitchingLock: true },
          );
          if (
            !isStillValidTurn() ||
            !live.switchingModel ||
            getOwnMember(this.cachedRun, memberName)?.humanStopped
          ) {
            live.switchingModel = false;
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          // Atomic handoff: switchingModel -> waking!
          live.waking = true;
          live.switchingModel = false;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          void this.drainMemberPendingWakes(
            runId,
            memberName,
            `Model automatically hot-switched to "${fallback}" after provider rate limit (${errorText}). Continue your work with your preserved conversation history.`,
          );
          return;
        } catch {
          live.switchingModel = false;
          if (!isStillValidTurn()) {
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          // Re-acquire turnActive lock while scheduling backoff/retry below
          live.turnActive = true;
        }
      }

      if (live && !isStillValidTurn()) {
        live.turnActive = false;
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      // Engage shared fleet rate-limit breaker
      const delayMs = this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, errorText);
      await this.store.appendEvent({
        runId,
        type: "rate_limit_backoff",
        actor: MONITOR_NAME,
        memberName,
        agentId: member.agentId,
        summary: `Rate-limit backoff (${Math.ceil(delayMs / 1000)}s) after ${memberName} hit: ${errorText}`,
        data: {
          delayMs,
          error: errorText,
          model: effectiveModel,
          retryCount: live?.retryCount ?? 0,
          maxRetries: settings.maxRetries,
        },
      });

      // Automatic backoff retry when `settings.maxRetries` allows and warm handle is parked waiting
      if (
        live &&
        live.handle?.getState() === "waiting" &&
        isStillValidTurn() &&
        live.turnActive &&
        !getOwnMember(this.cachedRun, memberName)?.humanStopped &&
        settings.maxRetries > 0 &&
        live.retryCount < settings.maxRetries
      ) {
        this.cancelMemberRetryTimer(live);
        live.retryCount += 1;
        const attempt = live.retryCount;
        const maxRetries = settings.maxRetries;
        const backoffSecs = Math.max(1, Math.ceil(delayMs / 1000));
        const parkedLabel = `rate limited; auto-retry ${attempt}/${maxRetries} in ${backoffSecs}s`;

        const scheduledRun = await this.store.updateMember(runId, memberName, {
          parkedOn: parkedLabel,
        });
        await this.refreshCache(scheduledRun);

        if (
          !isStillValidTurn() ||
          !live.turnActive ||
          getOwnMember(this.cachedRun, memberName)?.humanStopped ||
          live.handle?.getState() !== "waiting"
        ) {
          live.turnActive = false;
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
          return;
        }

        live.retryTimer = setTimeout(() => {
          live.retryTimer = undefined;
          if (
            this.disposed ||
            this.activeRunId !== runId ||
            this.cachedRun?.status !== "active" ||
            this.liveMembers.get(memberName) !== live ||
            live.handle?.getState() !== "waiting" ||
            live.spawning ||
            live.waking ||
            live.turnActive ||
            live.switchingModel
          ) {
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          live.waking = true;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          const retryPrompt = `Rate-limit backoff elapsed (automatic retry ${attempt}/${maxRetries} after ${errorText}). Continue your work from where you left off.`;
          void this.drainMemberPendingWakes(runId, memberName, retryPrompt);
        }, delayMs);
        live.retryTimer.unref?.();
        live.turnActive = false;

        this.emitEngineEvent(
          "snapshot_changed",
          `Scheduled retry ${attempt}/${maxRetries} for @${memberName} in ${backoffSecs}s`,
          { memberName },
        );
        return;
      }

      if (live) {
        live.turnActive = false;
      }
      if (isStillValidTurn()) {
        await this.postMonitorOrchestratorAlert(
          runId,
          `@${ORCHESTRATOR_NAME} [rate-limit] Member ${memberName} hit rate limit (${errorText}); backoff ${Math.ceil(delayMs / 1000)}s. Hot-switch with swarm{action:"model"} or message member to retry.`,
          "update",
        );
      }
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    // `failed` -> park in `waiting` (when warm handle alive) with error recorded so Orchestrator can hot-switch or retry!
    const errorText = result.error ?? "Member turn failed";
    const parkedState = live?.handle?.getState() === "waiting" ? "waiting" : "stopped";
    const updated = await this.store.updateMember(runId, memberName, {
      state: parkedState,
      turns: nextTurns,
      tokens: nextTokens,
      tokenBreakdown: nextTokenBreakdown,
      cost: nextCost,
      model: effectiveModel,
      thinkingLevel: effectiveThinking ?? null,
      currentActivity: null,
      parkedOn: `error: ${errorText.slice(0, 100)}`,
      error: errorText,
      ...persistedTelemetry,
    });
    await this.store.appendEvent({
      runId,
      type: "member_error",
      actor: memberName,
      memberName,
      agentId: member.agentId,
      summary: `Member ${memberName} failed: ${errorText}`,
      data: { error: errorText, stopReason: result.stopReason },
    });
    await this.refreshCache(updated);
    if (live) {
      live.pendingSelfModelSwitch = undefined;
      live.turnActive = false;
    }
    if (isStillValidTurn()) {
      await this.postMonitorOrchestratorAlert(
        runId,
        `@${ORCHESTRATOR_NAME} [error] Member ${memberName} encountered an error: ${errorText}. Switch its model or message it to retry.`,
        "update",
      );
    }
    this.checkAllIdleAndNotifyWaiters();
    this.maybeArmStallWatchdog();
  }

  private async handleLaunchError(
    runId: string,
    memberName: string,
    errMsg: string,
    attemptToken?: symbol,
  ): Promise<void> {
    if (this.disposed || this.activeRunId !== runId) {
      return;
    }
    const live = this.liveMembers.get(memberName);
    if (attemptToken && live && live.attemptToken !== attemptToken) {
      return;
    }
    if (live) {
      live.pendingWakes.length = 0;
      live.pendingSelfModelSwitch = undefined;
    }
    try {
      const latestRun = await this.store.loadRun(runId);
      const current = getOwnMember(latestRun, memberName);
      // Never resurrect killed or stopped members back to "waiting"!
      if (!current || current.state === "killed" || current.state === "stopped") {
        this.setCachedRun(latestRun);
        return;
      }
      const nextState = live?.handle?.getState() === "waiting" ? "waiting" : "stopped";
      const updated = await this.store.updateMember(runId, memberName, {
        state: nextState,
        currentActivity: null,
        parkedOn: `launch error: ${errMsg.slice(0, 100)}`,
        error: errMsg,
      });
      await this.store.appendEvent({
        runId,
        type: "member_error",
        actor: memberName,
        memberName,
        summary: `Launch error for ${memberName}: ${errMsg}`,
        data: { error: errMsg },
      });
      await this.refreshCache(updated);
      await this.postMonitorOrchestratorAlert(
        runId,
        `@${ORCHESTRATOR_NAME} [error] Member ${memberName} failed to launch: ${errMsg}`,
        "update",
      );
    } catch {
      // avoid cascading errors
    } finally {
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
    }
  }

  // --------------------------------------------------------------------------
  // Board Wakeup Routing & Coalescing
  // --------------------------------------------------------------------------

  private async routeBoardMessageWakeups(
    run: SwarmRunState,
    msg: BoardMessage,
  ): Promise<boolean> {
    const senderLower = msg.from.toLowerCase();
    const mentionsLower = new Set(msg.mentions.map((m) => m.toLowerCase()));
    const chMentionsLower = new Set(msg.channelMentions.map((c) => c.toLowerCase()));

    // Check if @orchestrator / @coordinator / @all / @#channel should wake the main Pi session
    const wakesOrchestrator =
      msg.fromRole !== "orchestrator" &&
      (mentionsLower.has(ORCHESTRATOR_NAME) ||
        mentionsLower.has("coordinator") ||
        mentionsLower.has(ALL_MENTION_NAME) ||
        chMentionsLower.size > 0);

    if (wakesOrchestrator) {
      let unreadMessages: BoardMessage[] = [msg];
      if (this.orchestratorWait && msg.seq > this.orchestratorWait.since) {
        const since = this.orchestratorWait.since;
        this.clearOrchestratorWait();
        unreadMessages = this.getCachedMessagesSince(since);
        if (unreadMessages.length === 0) {
          unreadMessages = [msg];
        }
      }
      this.emitEngineEvent(
        "wakeup_needed",
        `Board #${msg.seq} from ${msg.from} addressed @${ORCHESTRATOR_NAME}`,
        { seq: msg.seq, messages: unreadMessages },
      );
    }

    // Resolve all target non-killed members (never wake the sender!)
    const targetNames = new Set<string>();
    const allMembers = Object.values(run.members).filter(
      (m) => m.state !== "killed" && m.name.toLowerCase() !== senderLower,
    );

    for (const handle of mentionsLower) {
      if (handle === ALL_MENTION_NAME) {
        for (const m of allMembers) {
          targetNames.add(m.name);
        }
        continue;
      }
      if (handle === ORCHESTRATOR_NAME || handle === "coordinator" || handle === MONITOR_NAME) {
        continue;
      }
      const exact = allMembers.find((m) => m.name.toLowerCase() === handle);
      if (exact) {
        targetNames.add(exact.name);
        continue;
      }
      // Group prefix wakeup (`@parser` wakes `parser-1..k`)
      for (const m of allMembers) {
        if (m.groupPrefix && m.groupPrefix.toLowerCase() === handle) {
          targetNames.add(m.name);
        }
      }
    }

    // Channel broadcast wakeup (`@#backend` wakes every subscribed non-killed member)
    for (const ch of chMentionsLower) {
      const chRecord = getOwnChannel(run, ch);
      if (!chRecord || chRecord.archived) continue;
      for (const m of allMembers) {
        if (m.channels.includes(ch) || chRecord.subscribers.includes(m.name)) {
          targetNames.add(m.name);
        }
      }
    }

    // Wake parked members who explicitly waited with `swarm_wait{mentions_only: false}`
    // on any non-self post in DEFAULT_CHANNEL or one of their subscribed channels!
    for (const m of allMembers) {
      if (m.state !== "waiting") continue;
      const live = this.liveMembers.get(m.name);
      if (live && live.parkedMentionsOnly === false) {
        if (msg.channel === DEFAULT_CHANNEL || m.channels.includes(msg.channel)) {
          targetNames.add(m.name);
        }
      }
    }

    // Respect human-stop sovereignty: peer @mentions NEVER revive humanStopped members,
    // while explicit human or orchestrator messages MAY revive them!
    const eligibleTargets: string[] = [];
    for (const name of targetNames) {
      const member = getOwnMember(run, name);
      if (!member || member.state === "killed") continue;
      if (member.state === "stopped" && member.humanStopped) {
        if (msg.fromRole !== "human" && msg.fromRole !== "orchestrator") {
          continue;
        }
      }
      eligibleTargets.push(name);
    }

    if (eligibleTargets.length === 0) {
      return wakesOrchestrator;
    }

    // Enforce SWARM_MAX_BOARD_HOPS safety cap on peer-to-peer bounce chains!
    if (msg.fromRole === "worker" || msg.fromRole === "validator") {
      if (this.boardHopCount >= SWARM_MAX_BOARD_HOPS) {
        if (!this.hopCapAlerted) {
          this.hopCapAlerted = true;
          await this.postMonitorOrchestratorAlert(
            run.id,
            `@${ORCHESTRATOR_NAME} [hop-cap] Reached SWARM_MAX_BOARD_HOPS (${SWARM_MAX_BOARD_HOPS}) peer-to-peer wakeups at #${msg.seq}. Inspect the board and post an orchestrator decision to reset hops.`,
            "update",
          );
        }
        return wakesOrchestrator;
      }
      this.boardHopCount += 1;
    }

    // Deliver to each eligible target cleanly with synchronous waking lock + coalescing
    for (const targetName of eligibleTargets) {
      this.deliverBoardMessageToMember(run.id, targetName, msg);
    }
    return wakesOrchestrator;
  }

  private maybeWakeParkedOrchestratorOnMessage(
    msg: BoardMessage,
    alreadyEmittedWakeup: boolean,
  ): void {
    if (alreadyEmittedWakeup || !this.orchestratorWait) {
      return;
    }
    if (msg.seq <= this.orchestratorWait.since) {
      return;
    }
    if (
      this.doesMessageMatchWaiter(
        msg,
        ORCHESTRATOR_NAME,
        this.orchestratorWait.mentionsOnly,
        [],
      )
    ) {
      const since = this.orchestratorWait.since;
      this.clearOrchestratorWait();
      const unread = this.getCachedMessagesSince(since);
      this.emitEngineEvent(
        "wakeup_needed",
        `New board message #${msg.seq} from ${msg.from} in #${msg.channel}`,
        {
          seq: msg.seq,
          messages: unread.length > 0 ? unread : [msg],
        },
      );
    }
  }

  private deliverBoardMessageToMember(
    runId: string,
    memberName: string,
    msg: BoardMessage,
  ): void {
    const run = this.cachedRun;
    const member = getOwnMember(run, memberName);
    if (!member || member.state === "killed") {
      return;
    }

    let live = this.liveMembers.get(memberName);
    if (!live) {
      live = {
        name: member.name,
        agentId: member.agentId,
        role: member.role,
        spawning: false,
        waking: false,
        turnActive: false,
        switchingModel: false,
        parkedMentionsOnly: true,
        pendingWakes: [],
        deliveredSeqs: new Set<number>(),
        triedModels: new Set<string>(member.model ? [member.model] : []),
        lastMessages: [],
        logTail: [...member.logTail],
        lastTool: member.lastTool,
        retryCount: 0,
        priorHandlesTokens: member.tokens,
        priorHandlesBreakdown: member.tokenBreakdown ? { ...member.tokenBreakdown } : undefined,
        priorHandlesCost: member.cost,
      };
      this.liveMembers.set(memberName, live);
    }

    if (
      live.deliveredSeqs.has(msg.seq) ||
      live.pendingWakes.some((w) => w.seq === msg.seq)
    ) {
      return;
    }
    live.pendingWakes.push(msg);
    this.cancelMemberRetryTimer(live);

    // If currently spawning, waking, finishing/running a turn, or switching models -> queue safely!
    if (
      live.spawning ||
      live.waking ||
      live.turnActive ||
      live.switchingModel ||
      live.handle?.getState() === "working"
    ) {
      return;
    }

    // Synchronously acquire `waking` lock before scheduling async dispatch so simultaneous posts coalesce!
    live.waking = true;
    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");

    if (live.handle && live.handle.getState() === "waiting") {
      void this.drainMemberPendingWakes(runId, memberName);
    } else {
      void this.reviveMemberWithPendingWakes(runId, memberName);
    }
  }

  // --------------------------------------------------------------------------
  // Waiter Matching, Anti-Deadlock & Zero-Token Stall Watchdog
  // --------------------------------------------------------------------------

  private doesMessageMatchWaiter(
    msg: BoardMessage,
    targetName: string,
    mentionsOnly: boolean,
    targetChannels: readonly string[],
  ): boolean {
    if (msg.from.toLowerCase() === targetName) {
      return false;
    }
    if (!mentionsOnly) {
      return true;
    }
    const mentions = msg.mentions.map((m) => m.toLowerCase());
    if (mentions.includes(targetName) || mentions.includes(ALL_MENTION_NAME)) {
      return true;
    }
    if (targetName === ORCHESTRATOR_NAME && mentions.includes("coordinator")) {
      return true;
    }
    if (msg.channelMentions.length > 0) {
      if (targetName === ORCHESTRATOR_NAME) {
        return true;
      }
      const chSet = new Set(targetChannels.map((c) => c.toLowerCase()));
      if (msg.channelMentions.some((ch) => chSet.has(ch.toLowerCase()))) {
        return true;
      }
    }
    return false;
  }

  private notifyWaitersOnMessage(msg: BoardMessage): void {
    if (this.boardWaiters.size === 0) {
      return;
    }
    const head = Math.max(this.cachedRun?.boardHead ?? 0, msg.seq);
    for (const waiter of Array.from(this.boardWaiters)) {
      if (msg.seq <= waiter.since) {
        continue;
      }
      if (
        this.doesMessageMatchWaiter(
          msg,
          waiter.targetName,
          waiter.mentionsOnly,
          waiter.targetChannels,
        )
      ) {
        const unread = this.getCachedMessagesSince(waiter.since);
        waiter.resolve({
          wokeBy: "message",
          messages: unread.length > 0 ? unread : [msg],
          head,
          summary: `New message #${msg.seq} from ${msg.from} in #${msg.channel}.`,
        });
      }
    }
  }

  private buildAllIdleDigest(): string {
    const run = this.cachedRun;
    if (!run) {
      return "";
    }
    const entries: string[] = [];
    for (const name of run.memberOrder) {
      const m = getOwnMember(run, name);
      if (!m || m.state === "killed") {
        continue;
      }
      const postLabel =
        m.lastPostSeq !== undefined ? `lastPost=#${m.lastPostSeq}` : "no board post";
      const parkedDetail = m.parkedOn
        ? ` — ${m.parkedOn.replace(/\s+/g, " ").trim().slice(0, 80)}`
        : "";
      entries.push(`@${m.name} [${m.state}, ${postLabel}${parkedDetail}]`);
    }
    if (entries.length === 0) {
      return "";
    }
    return `Roster: ${entries.join("; ")}.`;
  }

  private checkAllIdleAndNotifyWaiters(): void {
    const active = this.getWorkingOrPendingMemberNames();
    if (active.length > 0) {
      return;
    }
    const digest = this.buildAllIdleDigest();
    if (this.orchestratorWait) {
      const since = this.orchestratorWait.since;
      this.clearOrchestratorWait();
      const unread = this.getCachedMessagesSince(since);
      this.emitEngineEvent(
        "wakeup_needed",
        digest
          ? `All active swarm members have finished and parked (all_idle). ${digest}`
          : "All active swarm members have finished and parked (all_idle).",
        unread.length > 0 ? { messages: unread } : undefined,
      );
    }
    if (this.boardWaiters.size === 0) {
      return;
    }
    const head = this.cachedRun?.boardHead ?? 0;
    const waiterSummary = digest
      ? `All active swarm members have finished and parked in waiting/stopped state. ${digest}`
      : "All active swarm members have finished and parked in waiting/stopped state.";
    for (const waiter of Array.from(this.boardWaiters)) {
      waiter.resolve({
        wokeBy: "all_idle",
        messages: this.getCachedMessagesSince(waiter.since),
        head,
        summary: waiterSummary,
      });
    }
  }

  private resolveAllWaiters(
    wokeBy: WaitForBoardResult["wokeBy"],
    summary: string,
  ): void {
    const head = this.cachedRun?.boardHead ?? 0;
    for (const waiter of Array.from(this.boardWaiters)) {
      waiter.resolve({
        wokeBy,
        messages: this.getCachedMessagesSince(waiter.since),
        head,
        summary,
      });
    }
  }

  private cancelMemberRetryTimer(live: LiveMember): void {
    if (live.retryTimer) {
      clearTimeout(live.retryTimer);
      live.retryTimer = undefined;
    }
  }

  private async cancelActiveMonitor(reason: string): Promise<void> {
    const abort = this.activeMonitorAbort;
    this.activeMonitorAbort = undefined;
    abort?.abort();
    const handle = this.activeMonitorHandle;
    this.activeMonitorHandle = undefined;
    this.monitorRunning = false;
    if (handle) {
      await handle.kill(reason).catch(() => {});
    }
  }

  private cancelStallWatchdog(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private maybeArmStallWatchdog(): void {
    this.cancelStallWatchdog();
    if (this.disposed || this.runDonePosted) {
      return;
    }
    const settings = this.getEffectiveSettings();
    if (!settings.stallWatchdogEnabled) {
      return;
    }
    const run = this.cachedRun;
    if (!run || run.status !== "active") {
      return;
    }
    if (this.boardWaiters.size > 0 || this.orchestratorWait) {
      return;
    }
    if (this.monitorRunning) {
      return;
    }
    // Require at least one live (non-killed) member parked before considering swarm stalled
    const nonKilled = Object.values(run.members).filter((m) => m.state !== "killed");
    if (nonKilled.length === 0) {
      return;
    }
    if (this.getWorkingOrPendingMemberNames().length > 0) {
      return;
    }
    if (this.stallNoticePostedAtHead === run.boardHead) {
      return;
    }

    const armedHead = run.boardHead;
    const armedRunId = run.id;
    const timeoutMs = Math.max(10, settings.stallTimeoutMs);

    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      void this.fireStallWatchdog(armedRunId, armedHead, timeoutMs);
    }, timeoutMs);
    this.stallTimer.unref?.();
  }

  private async fireStallWatchdog(
    runId: string,
    armedHead: number,
    timeoutMs: number,
  ): Promise<void> {
    if (
      this.disposed ||
      this.runDonePosted ||
      this.activeRunId !== runId ||
      this.boardWaiters.size > 0 ||
      Boolean(this.orchestratorWait) ||
      this.monitorRunning
    ) {
      return;
    }
    const run = this.cachedRun;
    if (!run || run.status !== "active" || run.boardHead !== armedHead) {
      return;
    }
    if (this.getWorkingOrPendingMemberNames().length > 0) {
      return;
    }

    const isNudgeEscalation =
      this.lastMonitorNudgeSeq !== null && armedHead === this.lastMonitorNudgeSeq;
    const settings = this.getEffectiveSettings();
    if (settings.stallMonitorMode === "llm" && !isNudgeEscalation) {
      const llmOutcome = await this.runSmartLlmMonitor(run, armedHead, timeoutMs, settings);
      if (llmOutcome === "handled") {
        if (this.getWorkingOrPendingMemberNames().length === 0) {
          this.maybeArmStallWatchdog();
        }
        return;
      }
      if (llmOutcome === "cancelled") {
        return;
      }
      // If LLM monitor errored or didn't post `[noop]`, re-verify run didn't advance then fall back deterministically
      if (
        this.disposed ||
        this.runDonePosted ||
        this.activeRunId !== runId ||
        this.boardWaiters.size > 0 ||
        Boolean(this.orchestratorWait) ||
        this.cachedRun?.status !== "active" ||
        this.cachedRun.boardHead !== armedHead ||
        this.getWorkingOrPendingMemberNames().length > 0
      ) {
        return;
      }
    }

    const rosterSummary = run.memberOrder
      .map((name) => getOwnMember(run, name))
      .filter((m): m is SwarmMemberRecord => Boolean(m && m.state !== "killed"))
      .map((m) => `${m.name}[${m.state}${m.parkedOn ? `:${m.parkedOn.slice(0, 32)}` : ""}]`)
      .join(", ");

    const latestSeqs =
      this.cachedBoard.length > 0
        ? this.cachedBoard
            .slice(-3)
            .map((m) => `#${m.seq}(${m.from})`)
            .join(", ")
        : "none";

    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const escalationNote = isNudgeEscalation
      ? `Nudged worker parked again without advancing board past #${armedHead}. `
      : "";
    const text = `@${ORCHESTRATOR_NAME} [stall] ${escalationNote}Swarm has been idle for ${seconds}s with 0 working members (board #${armedHead}). Roster: ${rosterSummary}. Latest posts: ${latestSeqs}. Wake a member, spawn next phase, or call swarm{action:"done"}.`;

    await this.emitStallMessage(runId, armedHead, timeoutMs, text, [ORCHESTRATOR_NAME], "deterministic");
  }

  private async emitStallMessage(
    runId: string,
    armedHead: number,
    timeoutMs: number,
    text: string,
    mentions: string[],
    mode: "llm" | "deterministic",
    abortSignal?: AbortSignal,
  ): Promise<BoardMessage | null> {
    if (
      abortSignal?.aborted ||
      this.disposed ||
      this.runDonePosted ||
      this.activeRunId !== runId ||
      this.cachedRun?.status !== "active" ||
      this.cachedRun.boardHead !== armedHead ||
      Boolean(this.orchestratorWait) ||
      this.boardWaiters.size > 0 ||
      this.getWorkingOrPendingMemberNames().length > 0
    ) {
      return null;
    }
    try {
      const sanitizedText = sanitizeStallMentionsText(text, mentions);
      const stallMsg = await this.store.postBoardMessage(runId, {
        from: MONITOR_NAME,
        fromRole: "monitor",
        channel: DEFAULT_CHANNEL,
        kind: "stall",
        text: sanitizedText,
        mentions,
        channelMentions: [],
      });
      this.recordBoardMessageInCache(stallMsg);

      const lowerMentions = mentions.map((m) => m.toLowerCase());
      const hitsOrchestrator =
        lowerMentions.length === 0 ||
        lowerMentions.includes(ORCHESTRATOR_NAME) ||
        lowerMentions.includes("coordinator") ||
        lowerMentions.includes(ALL_MENTION_NAME);

      if (hitsOrchestrator) {
        this.stallNoticePostedAtHead = stallMsg.seq;
        this.lastMonitorNudgeSeq = null;
      } else {
        this.lastMonitorNudgeSeq = stallMsg.seq;
      }

      await this.store.appendEvent({
        runId,
        type: "stall_detected",
        actor: MONITOR_NAME,
        summary: `Stall detected (${mode}) after ${timeoutMs}ms idle at board #${armedHead}`,
        data: { armedHead, stallSeq: stallMsg.seq, timeoutMs, mode, mentions },
      });

      const refreshed = await this.store.loadRun(runId);
      await this.refreshCache(refreshed);

      const latestRun = refreshed;

      this.emitEngineEvent("board_posted", `Posted stall alert #${stallMsg.seq}`, {
        seq: stallMsg.seq,
      });
      this.emitEngineEvent("stall_detected", `Swarm stalled at #${armedHead} (alert #${stallMsg.seq})`, {
        seq: stallMsg.seq,
        ...(!hitsOrchestrator && mentions[0] ? { memberName: mentions[0] } : {}),
      });

      if (hitsOrchestrator) {
        let unread = this.getCachedMessagesSince(
          this.orchestratorWait ? this.orchestratorWait.since : Math.max(0, stallMsg.seq - 1),
        );
        if (this.orchestratorWait) {
          this.clearOrchestratorWait();
        }
        if (unread.length === 0) {
          unread = [stallMsg];
        }
        this.emitEngineEvent("wakeup_needed", `Stall alert #${stallMsg.seq} for @${ORCHESTRATOR_NAME}`, {
          seq: stallMsg.seq,
          messages: unread,
        });
      } else if (latestRun.status === "active") {
        // Wake ONLY the specific target(s) that the smart monitor identified as the bottleneck
        await this.routeBoardMessageWakeups(latestRun, {
          ...stallMsg,
          mentions,
          channelMentions: [],
        });
      }

      this.notifyWaitersOnMessage(stallMsg);
      return stallMsg;
    } catch {
      return null;
    }
  }

  private async runSmartLlmMonitor(
    run: SwarmRunState,
    armedHead: number,
    timeoutMs: number,
    settings: SwarmSettings,
  ): Promise<"handled" | "cancelled" | "fallback"> {
    this.monitorRunning = true;
    const abort = new AbortController();
    this.activeMonitorAbort = abort;
    let handle: PersistentAgentHandle | undefined;
    let monitorSuperseded = false;
    const isMonitorCheckStillValid = (): boolean =>
      !abort.signal.aborted &&
      !this.disposed &&
      !this.runDonePosted &&
      this.activeRunId === run.id &&
      this.cachedRun?.status === "active" &&
      this.cachedRun.boardHead === armedHead &&
      !this.orchestratorWait &&
      this.boardWaiters.size === 0 &&
      this.getWorkingOrPendingMemberNames().length === 0;

    try {
      const recent = await this.store
        .readBoard(run.id, { channel: "*", limit: 15 })
        .catch(() => ({ messages: this.cachedBoard.slice(-15), head: run.boardHead }));

      const rosterLines = run.memberOrder
        .map((n) => getOwnMember(run, n))
        .filter((m): m is SwarmMemberRecord => Boolean(m && m.state !== "killed"))
        .map(
          (m) =>
            `- @${m.name} (${m.role}) state=${m.state} parent=@${m.parentName} turns=${m.turns} lastPost=${m.lastPostSeq ? `#${m.lastPostSeq}` : "none"} parkedOn=${m.parkedOn ?? "-"} error=${m.error ?? "-"}`,
        )
        .join("\n");

      const boardLines = recent.messages
        .map((m) => `#${m.seq} [#${m.channel}] ${m.from}: ${m.text.replace(/\s+/g, " ").slice(0, 320)}`)
        .join("\n");

      const monitorSystemPrompt = [
        "# Pi Swarm Monitor (`@monitor` — Read-Only Stall Diagnostician)",
        "You diagnose whether the swarm has genuinely stalled and post ONE concise nudge naming ONLY the single member who can unstick the run.",
        "Rules:",
        "1. If `[done]` has already been delivered, work looks finished, or the swarm is legitimately waiting on the human, do NOT post to the board — simply reply with `[noop]`.",
        "2. Otherwise call `post_message` ONCE starting with `@<single-target> [stall] <concrete actionable instruction>` — target `@<member>` if a worker/validator left work incomplete, errored, or missed a handoff, OR `@orchestrator` if next-phase decisions/merges/completion are needed.",
        "3. Never edit files or spawn workers; you only have `read_board` and `post_message`.",
      ].join("\n");

      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      const monitorPrompt = [
        `Swarm "${run.title}" (${run.id}) has been idle for ${seconds}s with 0 working members (board head: #${armedHead}).`,
        `Objective: ${run.objective}`,
        "",
        "Active Roster:",
        rosterLines || "(none)",
        "",
        "Recent Board Messages:",
        boardLines || "(empty)",
        "",
        "Diagnose now: either reply `[noop]` or call `post_message` ONCE naming the single member `@<target>` who can unstick the swarm.",
      ].join("\n");

      let monitorPosted = false;
      const monitorBridge: MemberEngineBridge = {
        postMessage: async ({ text }) => {
          if (!isMonitorCheckStillValid()) {
            monitorSuperseded = true;
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              "Monitor stall check was superseded by new swarm activity.",
            );
          }

          const parsedMentions = mergeUniqueLower([parseHandleMentions(text)]);
          const candidate = parsedMentions[0];
          let targetMentions: string[];
          let effectiveText = text;

          if (
            !candidate ||
            candidate === ORCHESTRATOR_NAME ||
            candidate === "coordinator" ||
            candidate === ALL_MENTION_NAME
          ) {
            targetMentions =
              candidate === ALL_MENTION_NAME ? [ALL_MENTION_NAME] : [ORCHESTRATOR_NAME];
            if (!candidate) {
              effectiveText = `@${ORCHESTRATOR_NAME} ${text}`;
            }
          } else {
            const currentRun = this.cachedRun;
            const exactTarget = currentRun
              ? Object.values(currentRun.members).find(
                  (m) =>
                    m.name.toLowerCase() === candidate &&
                    m.state !== "killed" &&
                    !(m.state === "stopped" && m.humanStopped),
                )
              : undefined;
            const groupTargets =
              !exactTarget && currentRun
                ? Object.values(currentRun.members).filter(
                    (m) =>
                      m.groupPrefix?.toLowerCase() === candidate &&
                      m.state !== "killed" &&
                      !(m.state === "stopped" && m.humanStopped),
                  )
                : [];
            if (exactTarget || groupTargets.length > 0) {
              targetMentions = [exactTarget ? exactTarget.name : candidate];
            } else {
              // Rewrite invalid/killed/humanStopped mention to @orchestrator
              const escapedCandidate = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              effectiveText = text.replace(
                new RegExp(`@${escapedCandidate}\\b`, "gi"),
                `@${ORCHESTRATOR_NAME}`,
              );
              if (
                !parseHandleMentions(effectiveText).some(
                  (m) => m.toLowerCase() === ORCHESTRATOR_NAME,
                )
              ) {
                effectiveText = `@${ORCHESTRATOR_NAME} ${effectiveText}`;
              }
              targetMentions = [ORCHESTRATOR_NAME];
            }
          }

          effectiveText = sanitizeStallMentionsText(effectiveText, targetMentions);

          const posted = await this.emitStallMessage(
            run.id,
            armedHead,
            timeoutMs,
            effectiveText,
            targetMentions,
            "llm",
            abort.signal,
          );
          if (!posted) {
            if (!isMonitorCheckStillValid()) {
              monitorSuperseded = true;
            }
            throw new SwarmProtocolError("NOT_FOUND", "Failed to post monitor diagnosis.");
          }
          monitorPosted = true;
          return posted;
        },
        readBoard: async (options) => this.readBoard(options),
        getStatus: async () => {
          const latest =
            this.cachedRun && this.activeRunId === run.id
              ? this.cachedRun
              : await this.store.loadRun(run.id);
          return this.buildRosterStatus(latest);
        },
        listModels: async (options) => this.listModels(options),
        addHelper: async () => {
          throw new SwarmProtocolError("PERMISSION_DENIED", "Monitor cannot spawn members.");
        },
        killHelper: async () => {
          throw new SwarmProtocolError("PERMISSION_DENIED", "Monitor cannot kill members.");
        },
        switchModel: async () => {
          throw new SwarmProtocolError("PERMISSION_DENIED", "Monitor cannot switch models.");
        },
        manageChannel: async () => {
          throw new SwarmProtocolError("PERMISSION_DENIED", "Monitor cannot manage channels.");
        },
      };

      const monitorModel =
        settings.validatorModel ??
        settings.workerModel ??
        settings.orchestratorModel;
      const monitorThinking =
        settings.validatorThinkingLevel ?? settings.workerThinkingLevel;

      handle = await this.transport.spawnMember({
        agentId: this.generateAgentIdFn(MONITOR_NAME),
        name: MONITOR_NAME,
        role: "validator",
        runId: run.id,
        cwd: this.worktree.repoRoot,
        workspace: "inherit",
        parentName: ORCHESTRATOR_NAME,
        brief: "Read-only stall diagnosis",
        systemPrompt: monitorSystemPrompt,
        initialPrompt: monitorPrompt,
        keepWarm: false,
        modelOverride: monitorModel,
        thinkingLevel: monitorThinking,
        hostContext: this.hostContext,
        engineApi: monitorBridge,
        isMonitor: true,
      });

      if (abort.signal.aborted || this.disposed) {
        await handle.kill("Monitor cancelled before turn start").catch(() => {});
        return "cancelled";
      }

      this.activeMonitorHandle = handle;

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const turnResult = await Promise.race([
        handle.currentTurn,
        new Promise<AgentTurnResult | null>((resolve) => {
          timeoutTimer = setTimeout(() => resolve(null), 30_000);
          timeoutTimer.unref?.();
          onAbort = () => resolve(null);
          abort.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (onAbort) {
          abort.signal.removeEventListener("abort", onAbort);
        }
      });

      if (turnResult) {
        const addedTokens = Math.max(0, turnResult.tokens || 0);
        const addedCost = Math.max(0, turnResult.cost || 0);
        if (addedTokens > 0 || addedCost > 0) {
          this.monitorTokens += addedTokens;
          this.monitorCost += addedCost;
          this.emitEngineEvent("snapshot_changed", "Updated @monitor usage", {
            memberName: MONITOR_NAME,
          });
        }
      }

      if (abort.signal.aborted || this.disposed || monitorSuperseded) {
        return "cancelled";
      }

      if (monitorPosted) {
        return "handled";
      }
      if (turnResult && /\[noop\]/i.test(turnResult.summary)) {
        if (!isMonitorCheckStillValid()) {
          return "cancelled";
        }
        this.stallNoticePostedAtHead = armedHead;
        this.lastMonitorNudgeSeq = null;
        return "handled";
      }
      return "fallback";
    } catch {
      return abort.signal.aborted || this.disposed || monitorSuperseded ? "cancelled" : "fallback";
    } finally {
      if (this.activeMonitorAbort === abort) {
        this.activeMonitorAbort = undefined;
      }
      if (this.activeMonitorHandle === handle) {
        this.activeMonitorHandle = undefined;
      }
      this.monitorRunning = false;
      if (handle) {
        await handle.kill("Monitor check complete").catch(() => {});
      }
    }
  }

  private async postMonitorOrchestratorAlert(
    runId: string,
    text: string,
    kind: BoardMessageKind,
  ): Promise<void> {
    try {
      const alertMsg = await this.store.postBoardMessage(runId, {
        from: MONITOR_NAME,
        fromRole: "monitor",
        channel: DEFAULT_CHANNEL,
        kind,
        text,
        mentions: [ORCHESTRATOR_NAME],
        channelMentions: [],
      });
      this.recordBoardMessageInCache(alertMsg);
      const refreshed = await this.store.loadRun(runId);
      this.setCachedRun(refreshed);
      this.emitEngineEvent("board_posted", `Posted monitor alert #${alertMsg.seq}`, {
        seq: alertMsg.seq,
      });
      let unread = this.getCachedMessagesSince(
        this.orchestratorWait ? this.orchestratorWait.since : Math.max(0, alertMsg.seq - 1),
      );
      if (this.orchestratorWait) {
        this.clearOrchestratorWait();
      }
      if (unread.length === 0) {
        unread = [alertMsg];
      }
      this.emitEngineEvent("wakeup_needed", text, { seq: alertMsg.seq, messages: unread });
      this.notifyWaitersOnMessage(alertMsg);
    } catch {
      this.emitEngineEvent("wakeup_needed", text);
    }
  }

  // --------------------------------------------------------------------------
  // Telemetry & Member Engine Bridge
  // --------------------------------------------------------------------------

  private handleTelemetry(runId: string, evt: AgentTelemetryEvent): void {
    if (this.disposed || this.activeRunId !== runId) {
      return;
    }

    const live = this.liveMembers.get(evt.name);
    if (live) {
      if (evt.activity !== undefined) {
        live.currentActivity = evt.activity;
      }
      if (evt.toolName !== undefined) {
        live.lastTool = evt.toolName;
      }
      if (evt.logLine) {
        live.logTail = [...live.logTail, evt.logLine].slice(-50);
        const waitMatch = evt.logLine.match(WAIT_TELEMETRY_RE);
        if (waitMatch) {
          live.lastWaitRequest = {
            since: Number.parseInt(waitMatch[1]!, 10),
            mentionsOnly: waitMatch[2] === "true",
          };
        }
      }
    }

    // Fast in-memory cachedRun patch for crisp real-time UI rendering
    const existingMember = getOwnMember(this.cachedRun, evt.name);
    if (existingMember && this.cachedRun) {
      const member: SwarmMemberRecord = { ...existingMember };
      if (evt.activity !== undefined) {
        member.currentActivity = evt.activity;
      }
      if (evt.toolName !== undefined) {
        member.lastTool = evt.toolName;
      }
      if (evt.tokens !== undefined) {
        member.tokens = Math.max(
          member.tokens,
          (live?.priorHandlesTokens ?? 0) + evt.tokens,
        );
      }
      if (evt.tokenBreakdown !== undefined) {
        member.tokenBreakdown = mergeTokenBreakdown(
          live?.priorHandlesBreakdown,
          evt.tokenBreakdown,
        );
      }
      if (evt.cost !== undefined) {
        member.cost = Math.max(
          member.cost,
          (live?.priorHandlesCost ?? 0) + evt.cost,
        );
      }
      if (evt.logLine) {
        member.logTail = live ? [...live.logTail] : [...member.logTail, evt.logLine].slice(-50);
      }
      member.updatedAt = evt.timestamp;
      this.cachedRun.members[evt.name] = member;
    }

    this.emitEngineEvent(
      "snapshot_changed",
      evt.logLine ?? evt.activity ?? `${evt.name}: ${evt.type}`,
      { memberName: evt.name },
    );
  }

  private createMemberBridge(
    runId: string,
    member: SwarmMemberRecord,
  ): MemberEngineBridge {
    const assertBridgeActive = (): SwarmMemberRecord => {
      if (this.disposed || this.activeRunId !== runId) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Swarm run "${runId}" is no longer active for member "@${member.name}".`,
        );
      }
      const currentMember = getOwnMember(this.cachedRun, member.name);
      if (!currentMember || currentMember.state === "killed") {
        throw new SwarmProtocolError(
          "MEMBER_KILLED",
          `Member "@${member.name}" has been killed and can no longer invoke Swarm tools.`,
        );
      }
      return currentMember;
    };

    return {
      postMessage: async ({ text, channel, kind }) => {
        const latest = assertBridgeActive();
        const isDonePost = kind === "done" || /^\s*\[done\]/i.test(text);
        const hasAnyMention =
          parseHandleMentions(text).length > 0 || parseChannelMentions(text).length > 0;
        const effectiveText =
          isDonePost && !hasAnyMention ? `@${latest.parentName} ${text.trimStart()}` : text;
        return this.postMessage({
          from: latest.name,
          fromRole: latest.role,
          text: effectiveText,
          channel: channel ?? latest.channels[0] ?? DEFAULT_CHANNEL,
          kind,
          ...(isDonePost && !hasAnyMention ? { mentions: [latest.parentName] } : {}),
        });
      },

      readBoard: async (options?: ReadBoardOptions) => {
        const latest = assertBridgeActive();
        const effectiveOptions: ReadBoardOptions = {
          ...options,
          ...(options?.channel === undefined
            ? { memberChannels: latest.channels }
            : {}),
        };
        const res = await this.readBoard(effectiveOptions);
        const isUnfilteredFeedRead =
          !options?.seqs &&
          !options?.search &&
          (!options?.channel || options.channel === "*") &&
          (options?.limit === undefined || options.limit > 0);
        if (isUnfilteredFeedRead && this.activeRunId === runId) {
          let readUpToSeq = 0;
          if (res.messages.length > 0) {
            for (const m of res.messages) {
              if (m.seq > readUpToSeq) {
                readUpToSeq = m.seq;
              }
            }
          } else if (options?.since !== undefined) {
            readUpToSeq = res.head;
          }
          if (readUpToSeq > latest.lastReadSeq) {
            void this.store
              .updateMember(runId, latest.name, { lastReadSeq: readUpToSeq })
              .then((u) => {
                this.setCachedRun(u);
              })
              .catch(() => {});
          }
        }
        return res;
      },

      getStatus: async (): Promise<SwarmRosterStatus> => {
        assertBridgeActive();
        const run =
          this.cachedRun && this.activeRunId === runId
            ? this.cachedRun
            : await this.store.loadRun(runId);
        return this.buildRosterStatus(run);
      },

      listModels: async (options?: { all?: boolean }) => {
        assertBridgeActive();
        return this.listModels(options);
      },

      addHelper: async (input: AddHelperInput) => {
        assertBridgeActive();
        return this.addMembers({
          ...input,
          callerName: member.name,
          callerRole: member.role,
          hostContext: this.hostContext,
        });
      },

      killHelper: async (name: string, reason?: string, force?: boolean) => {
        assertBridgeActive();
        return this.killMember(name, {
          reason,
          force,
          callerName: member.name,
          callerRole: member.role,
        });
      },

      stopHelper: async (name: string, reason?: string) => {
        assertBridgeActive();
        return this.stopMember(name, {
          reason,
          callerName: member.name,
          callerRole: member.role,
        });
      },

      steerHelper: async (
        name: string,
        message: string,
        mode?: "steer" | "followUp",
      ) => {
        assertBridgeActive();
        return this.steerMember(name, message, mode, {
          callerName: member.name,
          callerRole: member.role,
        });
      },

      switchModel: async (
        targetName: string | undefined,
        model: string,
        thinkingLevel?: ThinkingLevel,
        reason?: string,
      ) => {
        assertBridgeActive();
        return this.switchModel({
          targetName: targetName?.trim().replace(/^@/, "") || member.name,
          model,
          thinkingLevel,
          reason,
          callerName: member.name,
          callerRole: member.role,
          hostContext: this.hostContext,
        });
      },

      manageChannel: async (input: ManageChannelInput) => {
        assertBridgeActive();
        return this.manageChannel({
          ...input,
          callerName: member.name,
          callerRole: member.role,
        });
      },
    };
  }

  // --------------------------------------------------------------------------
  // Internal State & Cache Helpers
  // --------------------------------------------------------------------------

  private getEffectiveSettings(): SwarmSettings {
    const base = this.getSettingsFn
      ? this.getSettingsFn()
      : { ...DEFAULT_SWARM_SETTINGS, ...this.staticSettings };
    return {
      ...DEFAULT_SWARM_SETTINGS,
      ...base,
      fallbackModels: [...(base.fallbackModels ?? [])],
    };
  }

  private requireActiveRun(): SwarmRunState {
    if (!this.activeRunId || !this.cachedRun) {
      throw new SwarmProtocolError(
        "NOT_FOUND",
        "No active Swarm run. Start or attach to a Swarm run first.",
      );
    }
    return this.cachedRun;
  }

  private findMember(run: SwarmRunState, name: string): SwarmMemberRecord | undefined {
    const clean = name.trim().replace(/^@/, "");
    const direct = getOwnMember(run, clean);
    if (direct) return direct;
    const lower = clean.toLowerCase();
    return Object.values(run.members).find((m) => m.name.toLowerCase() === lower);
  }

  private buildRosterStatus(run: SwarmRunState): SwarmRosterStatus {
    const members: SwarmMemberStatusEntry[] = run.memberOrder
      .map((n) => getOwnMember(run, n))
      .filter((m): m is SwarmMemberRecord => Boolean(m))
      .map((m) => ({
        name: m.name,
        role: m.role,
        state: m.state,
        parentName: m.parentName,
        groupPrefix: m.groupPrefix,
        workspace: m.workspace,
        branch: m.branch,
        model: m.model,
        thinkingLevel: m.thinkingLevel,
        channels: m.channels,
        parkedOn: m.parkedOn,
        currentActivity: m.currentActivity,
        lastPostSeq: m.lastPostSeq,
        lastPostTime: m.lastPostTime,
        turns: m.turns,
        tokens: m.tokens,
        cost: m.cost,
      }));
    return {
      runId: run.id,
      title: run.title,
      status: run.status,
      baseBranch: run.baseBranch,
      boardHead: run.boardHead,
      members,
      channels: Object.values(run.channels),
    };
  }

  private getWorkingOrPendingMemberNames(): string[] {
    const run = this.cachedRun;
    if (!run) return [];
    const active = new Set<string>();
    for (const member of Object.values(run.members)) {
      if (member.state === "killed") continue;
      const live = this.liveMembers.get(member.name);
      if (
        member.state === "working" ||
        live?.spawning ||
        live?.waking ||
        live?.turnActive ||
        live?.switchingModel ||
        Boolean(live?.retryTimer) ||
        live?.handle?.getState() === "working"
      ) {
        active.add(member.name);
      }
    }
    return Array.from(active);
  }

  private recordBoardMessageInCache(msg: BoardMessage): void {
    const idx = this.cachedBoard.findIndex((m) => m.seq === msg.seq);
    if (idx >= 0) {
      this.cachedBoard[idx] = msg;
    } else {
      this.cachedBoard.push(msg);
      if (this.cachedBoard.length > BOARD_CACHE_LIMIT) {
        this.cachedBoard = this.cachedBoard.slice(-BOARD_CACHE_LIMIT);
      }
    }
    if (this.cachedRun && msg.seq > this.cachedRun.boardHead) {
      this.cachedRun.boardHead = msg.seq;
    }
  }

  private getCachedMessagesSince(since: number): BoardMessage[] {
    return this.cachedBoard.filter((m) => m.seq > since);
  }

  private setCachedRun(nextRun: SwarmRunState): void {
    if (
      this.cachedRun &&
      this.cachedRun.id === nextRun.id &&
      nextRun.revision < this.cachedRun.revision
    ) {
      return;
    }
    const prevHead =
      this.cachedRun && this.cachedRun.id === nextRun.id
        ? this.cachedRun.boardHead
        : 0;
    const mergedMembers: Record<string, SwarmMemberRecord> = { ...nextRun.members };
    if (this.liveMembers.size > 0) {
      for (const [name, m] of Object.entries(mergedMembers)) {
        const live = this.liveMembers.get(name);
        if (!live) continue;
        const preserveLogTail =
          live.logTail.length > m.logTail.length ? [...live.logTail] : m.logTail;
        const preserveLastTool = live.lastTool ?? m.lastTool;
        const isWorking = m.state === "working" || live.turnActive || live.spawning;
        const preserveActivity =
          isWorking && live.currentActivity ? live.currentActivity : m.currentActivity;
        if (
          preserveLogTail !== m.logTail ||
          preserveLastTool !== m.lastTool ||
          preserveActivity !== m.currentActivity
        ) {
          mergedMembers[name] = {
            ...m,
            logTail: preserveLogTail,
            lastTool: preserveLastTool,
            currentActivity: preserveActivity,
          };
        }
      }
    }
    this.cachedRun = {
      ...nextRun,
      members: mergedMembers,
      boardHead: Math.max(nextRun.boardHead, prevHead),
    };
  }

  private async refreshCache(knownRun?: SwarmRunState): Promise<void> {
    if (!this.activeRunId) return;
    try {
      const next = knownRun ?? (await this.store.loadRun(this.activeRunId));
      this.setCachedRun(next);
      this.cachedEvents = await this.store
        .getRecentEvents(this.activeRunId, EVENT_CACHE_LIMIT)
        .catch(() => this.cachedEvents);
    } catch {
      // retain prior cache on transient read failure
    }
  }

  private async disposeLiveHandles(reason: string): Promise<void> {
    const entries = Array.from(this.liveMembers.values());
    this.liveMembers.clear();
    await Promise.all(
      entries.map(async (live) => {
        this.cancelMemberRetryTimer(live);
        live.launchAbort?.abort();
        live.spawning = false;
        live.waking = false;
        live.turnActive = false;
        live.switchingModel = false;
        live.pendingSelfModelSwitch = undefined;
        live.lastWaitRequest = undefined;
        live.parkedMentionsOnly = true;
        live.currentActivity = undefined;
        live.pendingWakes.length = 0;
        live.releaseSlot?.();
        live.releaseSlot = undefined;
        if (live.handle) {
          await live.handle.kill(reason).catch(() => {});
        }
      }),
    );
  }

  private emitEngineEvent(
    type: SwarmEngineEventType,
    summary: string,
    extra?: { memberName?: string; seq?: number; messages?: BoardMessage[] },
  ): void {
    if (this.listeners.size === 0) return;
    const event: SwarmEngineEvent = {
      type,
      runId: this.activeRunId,
      memberName: extra?.memberName,
      seq: extra?.seq,
      ...(extra?.messages !== undefined ? { messages: extra.messages } : {}),
      summary,
      snapshot: this.getSnapshot(),
    };
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // listener errors must never disrupt the engine
      }
    }
  }
}

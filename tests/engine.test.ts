import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type ExtensionContext,
  type ExtensionToolContext,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CHANNEL,
  DEFAULT_SWARM_SETTINGS,
  ORCHESTRATOR_NAME,
  POST_MESSAGE_TOOL,
  READ_BOARD_TOOL,
  SWARM_CORE_TOOLS,
  SWARM_MAX_BOARD_HOPS,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../src/constants.js";
import {
  buildMemberSystemPrompt,
  buildOrchestratorPlaybookSection,
  ConcurrencyGate,
  createMemberScopedTools,
  createSwarmTools,
  createWorkerGuardExtensionFactory,
  formatBoardEntryFull,
  InProcessPiTransport,
  isForbiddenWorkerBashCommand,
  isProtectedSwarmPath,
  isRateLimitOrTransientError,
  isReadOnlyValidationCommand,
  parseRetryAfterMs,
  RateLimitBreaker,
  resolveRoleModel,
  sanitizeForkSeedMessages,
  selectFallbackModel,
  SwarmEngine,
} from "../src/runtime/index.js";
import {
  type AgentTurnResult,
  type AutoRebaseResult,
  type AvailableModelInfo,
  type BaseBranchCleanCheck,
  type BoardMessage,
  type CreateChannelInput,
  type CreateRunInput,
  type CreateWorktreeResult,
  type DiffSummary,
  type ISwarmStore,
  type ISwarmTransport,
  type IWorktreeManager,
  type MemberUpdateInput,
  type MergeBranchResult,
  type ModelSwitchResult,
  type PersistentAgentHandle,
  type PostBoardMessageInput,
  type ReadBoardOptions,
  type ReadBoardResult,
  type RegisterMemberInput,
  type RepoReadyResult,
  type RunSummary,
  type RunUpdateInput,
  type SafeTeardownResult,
  type SafeTeardownTarget,
  type SpawnMemberRequest,
  type SwarmChannelRecord,
  type SwarmEngineEvent,
  type SwarmEvent,
  type SwarmEventInput,
  type SwarmMemberRecord,
  type SwarmMemberState,
  SwarmProtocolError,
  type SwarmRunState,
  type SwarmSettings,
} from "../src/types.js";

// ============================================================================
// Test Utilities
// ============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(stepMs);
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms`);
}

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantTextMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function cloneState<T>(val: T): T {
  return structuredClone(val);
}

// ============================================================================
// In-Memory Mock Store (Implements ISwarmStore)
// ============================================================================

class MockSwarmStore implements ISwarmStore {
  readonly projectRoot = "/repo";
  private readonly runs = new Map<string, SwarmRunState>();
  private readonly boards = new Map<string, BoardMessage[]>();
  readonly events: SwarmEvent[] = [];
  private seqCounter = 0;

  async createRun(input: CreateRunInput): Promise<SwarmRunState> {
    const now = new Date().toISOString();
    const id = input.id ?? `run-${this.runs.size + 1}`;
    const state: SwarmRunState = {
      version: 2,
      id,
      title: input.title,
      objective: input.objective,
      strategy: input.strategy ?? "",
      acceptanceCriteria: input.acceptanceCriteria ?? "",
      baseBranch: input.baseBranch,
      ownerSessionId: input.ownerSessionId,
      ownerPid: input.ownerPid ?? process.pid,
      status: "active",
      maxConcurrency: input.maxConcurrency ?? 6,
      validatorEnabled: input.validatorEnabled ?? true,
      keepWorkersWarm: input.keepWorkersWarm ?? true,
      roleModels: input.roleModels ?? {},
      revision: 1,
      members: {},
      memberOrder: [],
      channels: {
        [DEFAULT_CHANNEL]: {
          name: DEFAULT_CHANNEL,
          topic: "Default swarm channel",
          createdBy: ORCHESTRATOR_NAME,
          createdAt: now,
          archived: false,
          subscribers: [],
        },
      },
      boardHead: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(id, state);
    this.boards.set(id, []);
    await this.appendEvent({
      runId: id,
      type: "run_created",
      actor: ORCHESTRATOR_NAME,
      summary: `Created run ${id}`,
    });
    return cloneState(state);
  }

  async loadRun(runId: string): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    }
    return cloneState(run);
  }

  async listRuns(): Promise<RunSummary[]> {
    return Array.from(this.runs.values()).map((r) => {
      const members = Object.values(r.members);
      return {
        id: r.id,
        title: r.title,
        objective: r.objective,
        baseBranch: r.baseBranch,
        status: r.status,
        memberCount: members.length,
        workingCount: members.filter((m) => m.state === "working").length,
        waitingCount: members.filter((m) => m.state === "waiting").length,
        boardHead: r.boardHead,
        ownerSessionId: r.ownerSessionId,
        ownerPid: r.ownerPid,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  async getActiveRunId(): Promise<string | null> {
    for (const r of this.runs.values()) {
      if (r.status === "active") return r.id;
    }
    return null;
  }

  async updateRun(runId: string, patch: RunUpdateInput): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    }
    if (patch.title !== undefined) run.title = patch.title;
    if (patch.objective !== undefined) run.objective = patch.objective;
    if (patch.strategy !== undefined) run.strategy = patch.strategy;
    if (patch.acceptanceCriteria !== undefined) run.acceptanceCriteria = patch.acceptanceCriteria;
    if (patch.baseBranch !== undefined) run.baseBranch = patch.baseBranch;
    if (patch.status !== undefined) run.status = patch.status;
    if (patch.maxConcurrency !== undefined) run.maxConcurrency = patch.maxConcurrency;
    if (patch.validatorEnabled !== undefined) run.validatorEnabled = patch.validatorEnabled;
    if (patch.keepWorkersWarm !== undefined) run.keepWorkersWarm = patch.keepWorkersWarm;
    if (patch.roleModels !== undefined) run.roleModels = cloneState(patch.roleModels);
    if (patch.completionSummary !== undefined) run.completionSummary = patch.completionSummary;
    run.revision += 1;
    run.updatedAt = new Date().toISOString();
    return cloneState(run);
  }

  async addMember(
    runId: string,
    member: RegisterMemberInput,
  ): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    }
    if (run.members[member.name]) {
      throw new SwarmProtocolError("DUPLICATE_MEMBER", `Duplicate member "${member.name}"`);
    }
    const now = member.createdAt ?? new Date().toISOString();
    const channels = member.channels?.length ? [...member.channels] : [DEFAULT_CHANNEL];
    const record: SwarmMemberRecord = {
      name: member.name,
      agentId: member.agentId,
      role: member.role,
      state: member.state ?? "working",
      parentName: member.parentName,
      groupPrefix: member.groupPrefix,
      brief: member.brief,
      briefSeq: member.briefSeq,
      workspace: member.workspace,
      cwd: member.cwd,
      branch: member.branch,
      forkedFrom: member.forkedFrom,
      channels,
      model: member.model,
      thinkingLevel: member.thinkingLevel,
      lastReadSeq: member.lastReadSeq ?? 0,
      turns: 0,
      tokens: 0,
      cost: 0,
      humanStopped: false,
      logTail: [],
      createdAt: now,
      updatedAt: now,
    };
    run.members[member.name] = record;
    run.memberOrder.push(member.name);
    for (const ch of channels) {
      const chRec = run.channels[ch];
      if (chRec && !chRec.subscribers.includes(member.name)) {
        chRec.subscribers.push(member.name);
      }
    }
    run.revision += 1;
    run.updatedAt = now;
    await this.appendEvent({
      runId,
      type: "member_added",
      memberName: member.name,
      agentId: member.agentId,
      summary: `Added @${member.name}`,
    });
    return cloneState(run);
  }

  async updateMember(
    runId: string,
    memberName: string,
    patch: MemberUpdateInput,
  ): Promise<SwarmRunState> {
    const run = this.runs.get(runId);
    if (!run) throw new SwarmProtocolError("NOT_FOUND", `Run "${runId}" not found.`);
    const m = run.members[memberName];
    if (!m) throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);

    const prevState = m.state;
    const prevMerged = m.mergedCommitSha;
    if (patch.state !== undefined) m.state = patch.state;
    if (patch.briefSeq !== undefined) m.briefSeq = patch.briefSeq;
    if (patch.branch !== undefined) m.branch = patch.branch;
    if (patch.mergedCommitSha !== undefined) m.mergedCommitSha = patch.mergedCommitSha;
    if (patch.channels !== undefined) m.channels = [...patch.channels];
    if (patch.model !== undefined) m.model = patch.model;
    if (patch.thinkingLevel !== undefined) {
      m.thinkingLevel = patch.thinkingLevel === null ? undefined : patch.thinkingLevel;
    }
    if (patch.lastReadSeq !== undefined) m.lastReadSeq = patch.lastReadSeq;
    if (patch.lastPostSeq !== undefined) m.lastPostSeq = patch.lastPostSeq;
    if (patch.lastPostTime !== undefined) m.lastPostTime = patch.lastPostTime;
    if (patch.parkedOn !== undefined) {
      m.parkedOn = patch.parkedOn === null ? undefined : patch.parkedOn;
    }
    if (patch.turns !== undefined) m.turns = patch.turns;
    if (patch.tokens !== undefined) m.tokens = patch.tokens;
    if (patch.tokenBreakdown !== undefined) m.tokenBreakdown = patch.tokenBreakdown;
    if (patch.cost !== undefined) m.cost = patch.cost;
    if (patch.humanStopped !== undefined) m.humanStopped = patch.humanStopped;
    if (patch.currentActivity !== undefined) {
      m.currentActivity = patch.currentActivity === null ? undefined : patch.currentActivity;
    }
    if (patch.lastTool !== undefined) {
      m.lastTool = patch.lastTool === null ? undefined : patch.lastTool;
    }
    if (patch.logTail !== undefined) m.logTail = [...patch.logTail];
    if (patch.logLine !== undefined) m.logTail = [...m.logTail, patch.logLine].slice(-50);
    if (patch.error !== undefined) m.error = patch.error === null ? undefined : patch.error;
    if (patch.endedAt !== undefined) m.endedAt = patch.endedAt === null ? undefined : patch.endedAt;

    m.updatedAt = new Date().toISOString();
    run.revision += 1;
    run.updatedAt = m.updatedAt;

    if (prevState !== m.state) {
      if (m.state === "waiting") {
        await this.appendEvent({ runId, type: "member_waiting", memberName, summary: `${memberName} waiting` });
      } else if (m.state === "stopped") {
        await this.appendEvent({ runId, type: "member_stopped", memberName, summary: `${memberName} stopped` });
      } else if (m.state === "killed") {
        await this.appendEvent({ runId, type: "member_killed", memberName, summary: `${memberName} killed` });
      }
    }
    if (m.mergedCommitSha && m.mergedCommitSha !== prevMerged) {
      await this.appendEvent({ runId, type: "member_merged", memberName, summary: `${memberName} merged` });
    }
    return cloneState(run);
  }

  async createChannel(runId: string, input: CreateChannelInput): Promise<SwarmChannelRecord> {
    const run = this.runs.get(runId)!;
    const ch: SwarmChannelRecord = {
      name: input.name,
      topic: input.topic,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      archived: false,
      subscribers: [...(input.subscribers ?? [])],
    };
    run.channels[ch.name] = ch;
    run.revision += 1;
    return cloneState(ch);
  }

  async subscribeChannel(runId: string, channelName: string, memberName: string): Promise<SwarmChannelRecord> {
    const run = this.runs.get(runId)!;
    const ch = run.channels[channelName]!;
    if (!ch.subscribers.includes(memberName)) {
      ch.subscribers.push(memberName);
    }
    const m = run.members[memberName];
    if (m && !m.channels.includes(channelName)) {
      m.channels.push(channelName);
    }
    run.revision += 1;
    return cloneState(ch);
  }

  async unsubscribeChannel(runId: string, channelName: string, memberName: string): Promise<SwarmChannelRecord> {
    const run = this.runs.get(runId)!;
    const ch = run.channels[channelName]!;
    ch.subscribers = ch.subscribers.filter((s) => s !== memberName);
    const m = run.members[memberName];
    if (m) {
      m.channels = m.channels.filter((c) => c !== channelName);
      if (m.channels.length === 0) m.channels.push(DEFAULT_CHANNEL);
    }
    run.revision += 1;
    return cloneState(ch);
  }

  async archiveChannel(runId: string, channelName: string): Promise<SwarmChannelRecord> {
    const run = this.runs.get(runId)!;
    const ch = run.channels[channelName]!;
    ch.archived = true;
    ch.archivedAt = new Date().toISOString();
    run.revision += 1;
    return cloneState(ch);
  }

  async postBoardMessage(runId: string, input: PostBoardMessageInput): Promise<BoardMessage> {
    const run = this.runs.get(runId)!;
    const list = this.boards.get(runId)!;
    const seq = run.boardHead + 1;
    const msg: BoardMessage = {
      seq,
      runId,
      channel: input.channel ?? DEFAULT_CHANNEL,
      from: input.from,
      fromRole: input.fromRole,
      text: input.text,
      mentions: [...(input.mentions ?? [])],
      channelMentions: [...(input.channelMentions ?? [])],
      kind: input.kind ?? "chat",
      timestamp: new Date().toISOString(),
    };
    list.push(msg);
    run.boardHead = seq;
    const sender = run.members[input.from];
    if (sender) {
      sender.lastPostSeq = seq;
      sender.lastPostTime = msg.timestamp;
    }
    run.revision += 1;
    return cloneState(msg);
  }

  async readBoard(runId: string, options?: ReadBoardOptions): Promise<ReadBoardResult> {
    const all = this.boards.get(runId) ?? [];
    const head = all.length > 0 ? all[all.length - 1]!.seq : 0;
    let filtered = [...all];

    if (options?.channel && options.channel !== "*") {
      filtered = filtered.filter((m) => m.channel === options.channel);
    } else if (!options?.channel && options?.memberChannels) {
      const allowed = new Set([DEFAULT_CHANNEL, ...options.memberChannels]);
      filtered = filtered.filter((m) => allowed.has(m.channel));
    }

    if (options?.search?.trim()) {
      const q = options.search.trim().toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.text.toLowerCase().includes(q) ||
          m.from.toLowerCase().includes(q) ||
          m.channel.toLowerCase().includes(q) ||
          m.mentions.some((x) => x.toLowerCase().includes(q)),
      );
    }

    if (options?.seqs) {
      const set = new Set(options.seqs);
      return {
        messages: cloneState(filtered.filter((m) => set.has(m.seq)).sort((a, b) => a.seq - b.seq)),
        head,
      };
    }

    if (options?.since !== undefined) {
      const after = filtered.filter((m) => m.seq > options.since!);
      const limit = options.limit ?? 50;
      return { messages: cloneState(after.slice(0, limit)), head };
    }

    const limit = options?.limit ?? 20;
    return { messages: cloneState(filtered.slice(-limit)), head };
  }

  async getBoardHead(runId: string): Promise<number> {
    return this.runs.get(runId)?.boardHead ?? 0;
  }

  async appendEvent(event: SwarmEventInput): Promise<SwarmEvent> {
    this.seqCounter += 1;
    const full: SwarmEvent = {
      id: event.id ?? `evt-${this.seqCounter}`,
      seq: this.seqCounter,
      runId: event.runId,
      type: event.type,
      timestamp: event.timestamp ?? new Date().toISOString(),
      actor: event.actor,
      memberName: event.memberName,
      agentId: event.agentId,
      channel: event.channel,
      summary: event.summary,
      data: event.data,
    };
    this.events.push(full);
    return cloneState(full);
  }

  async getRecentEvents(runId: string, limit = 50): Promise<SwarmEvent[]> {
    return cloneState(this.events.filter((e) => e.runId === runId).slice(-limit));
  }

  renderRosterMarkdown(state: SwarmRunState): string {
    return `# ${state.title}`;
  }

  getRunDir(runId: string): string {
    return `${this.projectRoot}/.pi/swarm/runs/${runId}`;
  }

  getWorktreePath(runId: string, memberName: string): string {
    return `${this.projectRoot}/.pi/swarm/worktrees/${runId}/wt-${memberName}`;
  }
}

// ============================================================================
// In-Memory Mock Worktree Manager (Implements IWorktreeManager)
// ============================================================================

class MockWorktreeManager implements IWorktreeManager {
  readonly repoRoot = "/repo";
  readonly createdWorktrees: Array<{ branch: string; baseBranch: string; worktreePath: string }> = [];
  readonly removedWorktrees: Array<{ worktreePath: string; force?: boolean }> = [];
  readonly mergedBranches: Array<{ baseBranch: string; branch: string }> = [];
  readonly dirtyPaths = new Set<string>();
  failCreateWorktreeFor?: string;
  baseBranchCheck: BaseBranchCleanCheck = { ok: true, currentBranch: "main", dirty: false };
  rebaseResult: AutoRebaseResult = { status: "up-to-date" };
  nextMergeSha = "abcdef1234567890abcdef1234567890abcdef12";

  async ensureRepoReady(preferredBaseBranch = "main"): Promise<RepoReadyResult> {
    return {
      repoRoot: this.repoRoot,
      baseBranch: preferredBaseBranch,
      headSha: "1111111111111111111111111111111111111111",
      initializedRepo: false,
      createdInitialCommit: false,
    };
  }

  async getCurrentBranch(): Promise<string> {
    return this.baseBranchCheck.currentBranch;
  }

  async listLocalBranches(): Promise<string[]> {
    return ["main", ...this.createdWorktrees.map((w) => w.branch)];
  }

  async createWorktree(options: {
    branch: string;
    baseBranch: string;
    worktreePath: string;
  }): Promise<CreateWorktreeResult> {
    if (this.failCreateWorktreeFor && options.branch.includes(this.failCreateWorktreeFor)) {
      throw new SwarmProtocolError("GIT_ERROR", `Simulated worktree failure for ${options.branch}`);
    }
    this.createdWorktrees.push(options);
    return {
      branch: options.branch,
      worktreePath: options.worktreePath,
      baseSha: "1111111111111111111111111111111111111111",
    };
  }

  async removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void> {
    this.removedWorktrees.push({ worktreePath, force: options?.force });
    this.dirtyPaths.delete(worktreePath);
  }

  async getHeadSha(): Promise<string> {
    return this.nextMergeSha;
  }

  async getCommitCountAhead(): Promise<number> {
    return 1;
  }

  async getChangedFiles(): Promise<string[]> {
    return ["src/feature.ts"];
  }

  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    return this.dirtyPaths.has(worktreePath);
  }

  async isBaseCleanOnBranch(expectedBranch: string): Promise<BaseBranchCleanCheck> {
    if (!this.baseBranchCheck.ok) {
      return this.baseBranchCheck;
    }
    return { ok: true, currentBranch: expectedBranch, dirty: false };
  }

  async autoRebase(): Promise<AutoRebaseResult> {
    return this.rebaseResult;
  }

  async mergeBranch(options: {
    baseBranch: string;
    branch: string;
  }): Promise<MergeBranchResult> {
    this.mergedBranches.push({ baseBranch: options.baseBranch, branch: options.branch });
    return {
      mergedCommitSha: this.nextMergeSha,
      strategy: "merge",
      changedFiles: ["src/feature.ts"],
    };
  }

  async getDiffSummary(baseBranch: string, targetRef: string): Promise<DiffSummary> {
    return {
      baseBranch,
      branch: targetRef,
      headSha: this.nextMergeSha,
      commitsAhead: 1,
      changedFiles: ["src/feature.ts"],
      stat: "1 file changed",
      diff: "",
    };
  }

  async safeTeardown(targets: SafeTeardownTarget[]): Promise<SafeTeardownResult> {
    const removed: SafeTeardownResult["removed"] = [];
    const skipped: SafeTeardownResult["skipped"] = [];
    for (const t of targets) {
      if (t.hasActiveAgent) {
        skipped.push({
          memberName: t.memberName,
          worktreePath: t.worktreePath,
          branch: t.branch,
          action: "skipped_active",
        });
      } else if (this.dirtyPaths.has(t.worktreePath)) {
        skipped.push({
          memberName: t.memberName,
          worktreePath: t.worktreePath,
          branch: t.branch,
          action: "skipped_dirty",
        });
      } else {
        removed.push({
          memberName: t.memberName,
          worktreePath: t.worktreePath,
          branch: t.branch,
          action: "removed",
        });
      }
    }
    return { removed, skipped, errors: [] };
  }
}

// ============================================================================
// Scripted Deterministic Transport (Implements ISwarmTransport)
// ============================================================================

interface ScriptedTurnContext {
  request: SpawnMemberRequest;
  prompt: string;
  turnIndex: number;
  model: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  messages: AgentMessage[];
  handle: ScriptedHandleRecord;
}

type TurnHandler = (ctx: ScriptedTurnContext) => Promise<Partial<AgentTurnResult> | void>;

interface ScriptedHandleRecord {
  handle: PersistentAgentHandle;
  request: SpawnMemberRequest;
  wakePrompts: string[];
  switchedModels: Array<{ model: string; thinkingLevel?: ThinkingLevel }>;
  steers: string[];
  followUps: string[];
  killed: boolean;
  aborted: boolean;
  messages: AgentMessage[];
}

class ScriptedTransport implements ISwarmTransport {
  readonly spawns: SpawnMemberRequest[] = [];
  readonly handles = new Map<string, ScriptedHandleRecord>();
  availableModels: AvailableModelInfo[] = [
    { id: "claude-opus-4-6", provider: "anthropic", fullId: "anthropic/claude-opus-4-6", reasoning: true },
    { id: "claude-sonnet-4-5", provider: "anthropic", fullId: "anthropic/claude-sonnet-4-5", reasoning: true },
    { id: "gemini-2.5-pro", provider: "google", fullId: "google/gemini-2.5-pro", reasoning: true },
  ];
  private readonly handlers = new Map<string, TurnHandler>();
  private defaultHandler: TurnHandler = async () => ({ outcome: "waiting", summary: "done" });

  onMember(nameOrPattern: string, handler: TurnHandler): void {
    this.handlers.set(nameOrPattern, handler);
  }

  setDefaultHandler(handler: TurnHandler): void {
    this.defaultHandler = handler;
  }

  private resolveHandler(name: string): TurnHandler {
    const exact = this.handlers.get(name);
    if (exact) return exact;
    for (const [key, fn] of this.handlers.entries()) {
      if (key.endsWith("*") && name.startsWith(key.slice(0, -1))) {
        return fn;
      }
    }
    return this.defaultHandler;
  }

  async resolveModel(
    modelOverride: string,
    thinkingLevel?: ThinkingLevel,
  ): Promise<ModelSwitchResult> {
    const found = this.availableModels.find(
      (m) =>
        m.fullId.toLowerCase() === modelOverride.trim().toLowerCase() ||
        m.id.toLowerCase() === modelOverride.trim().toLowerCase(),
    );
    if (!found) {
      throw new SwarmProtocolError(
        "MODEL_NOT_FOUND",
        `Unknown model "${modelOverride}".`,
      );
    }
    return {
      model: found.fullId,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  async listAvailableModels(): Promise<AvailableModelInfo[]> {
    return [...this.availableModels];
  }

  async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
    this.spawns.push(request);
    let state: SwarmMemberState = "working";
    let model = request.modelOverride;
    let thinkingLevel = request.thinkingLevel;
    let turnIndex = 0;
    const messages: AgentMessage[] = [...(request.seedMessages ?? [])];

    const record: ScriptedHandleRecord = {
      handle: null as unknown as PersistentAgentHandle,
      request,
      wakePrompts: [],
      switchedModels: [],
      steers: [],
      followUps: [],
      killed: false,
      aborted: false,
      messages,
    };

    const runTurn = async (prompt: string): Promise<AgentTurnResult> => {
      turnIndex += 1;
      messages.push(makeUserMessage(prompt));
      const handler = this.resolveHandler(request.name);
      const partial = (await handler({
        request,
        prompt,
        turnIndex,
        model,
        thinkingLevel,
        messages,
        handle: record,
      })) ?? {};

      if (record.killed) {
        state = "killed";
        return {
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          outcome: "killed",
          summary: "killed",
          model,
          thinkingLevel,
          tokens: 100,
          cost: 0.001,
        };
      }

      const outcome = partial.outcome ?? "waiting";
      const summary = partial.summary ?? `${request.name} turn ${turnIndex}`;
      messages.push(makeAssistantTextMessage(summary));

      if (outcome === "waiting" || outcome === "rate_limited" || outcome === "failed") {
        state = request.keepWarm ? "waiting" : "stopped";
      } else if (outcome === "stopped") {
        state = "stopped";
      } else {
        state = "killed";
      }

      return {
        agentId: request.agentId,
        name: request.name,
        role: request.role,
        outcome,
        summary,
        model: partial.model ?? model,
        thinkingLevel: partial.thinkingLevel ?? thinkingLevel,
        tokens: partial.tokens ?? turnIndex * 100,
        cost: partial.cost ?? turnIndex * 0.002,
        error: partial.error,
        stopReason: partial.stopReason,
        retryAfterMs: partial.retryAfterMs,
      };
    };

    let currentTurnPromise = runTurn(request.initialPrompt);

    const handle: PersistentAgentHandle = {
      agentId: request.agentId,
      name: request.name,
      role: request.role,
      getState: () => state,
      getModel: () => model,
      getThinkingLevel: () => thinkingLevel,
      getConversationMessages: () => structuredClone(messages),
      wake: async (prompt: string) => {
        if (state === "killed") {
          throw new SwarmProtocolError("MEMBER_KILLED", `${request.name} killed`);
        }
        if (state !== "waiting") {
          throw new SwarmProtocolError("MEMBER_NOT_WAITING", `${request.name} is ${state}`);
        }
        record.wakePrompts.push(prompt);
        state = "working";
        currentTurnPromise = runTurn(prompt);
        return currentTurnPromise;
      },
      steer: async (message: string) => {
        record.steers.push(message);
      },
      followUp: async (message: string) => {
        record.followUps.push(message);
      },
      switchModel: async (modelOverride: string, nextThinking?: ThinkingLevel): Promise<ModelSwitchResult> => {
        if (state === "killed") {
          throw new SwarmProtocolError("MEMBER_KILLED", `${request.name} killed`);
        }
        if (state !== "waiting") {
          throw new SwarmProtocolError("MEMBER_NOT_WAITING", `${request.name} is ${state}`);
        }
        model = modelOverride;
        thinkingLevel = nextThinking ?? thinkingLevel;
        record.switchedModels.push({ model: modelOverride, thinkingLevel });
        return { model, thinkingLevel };
      },
      abort: async () => {
        record.aborted = true;
        if (state !== "killed") {
          state = "stopped";
        }
      },
      kill: async () => {
        record.killed = true;
        state = "killed";
      },
      get currentTurn() {
        return currentTurnPromise;
      },
    };

    record.handle = handle;
    this.handles.set(request.name, record);
    return handle;
  }
}

async function createTestHarness(settings?: Partial<SwarmSettings>) {
  const store = new MockSwarmStore();
  const worktree = new MockWorktreeManager();
  const transport = new ScriptedTransport();
  let idCounter = 0;
  const engine = new SwarmEngine({
    store,
    worktree,
    transport,
    settings: {
      stallWatchdogEnabled: false, // opt-in explicitly in watchdog tests
      ...settings,
    },
    generateAgentId: (name) => `${name}-id${++idCounter}`,
  });
  const run = await store.createRun({
    id: "run-dyn",
    title: "Dynamic Swarm Test",
    objective: "Build and validate the dynamic feature",
    strategy: "Research -> Scaffold -> Parallel build -> Independent validate",
    acceptanceCriteria: "All tests pass and validator approves",
    baseBranch: "main",
    ownerSessionId: "sess-1",
    maxConcurrency: settings?.maxConcurrency ?? 6,
    validatorEnabled: true,
    keepWorkersWarm: true,
  });
  await engine.startRun(run.id);
  return { store, worktree, transport, engine, run };
}

// ============================================================================
// 1. Dynamic Multi-Phase Orchestration & Peer-to-Peer Warm Fix Loop
// ============================================================================

describe("SwarmEngine — Dynamic Multi-Phase Collaboration", () => {
  it("runs researcher -> scaffold -> parallel workers -> independent validator -> warm peer-to-peer fix loop -> done", async () => {
    const { engine, transport, store } = await createTestHarness();
    const events: SwarmEngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    try {
      // Phase 1: Read-only researcher posts #2 findings to @orchestrator
      transport.onMember("researcher", async ({ request }) => {
        await request.engineApi!.postMessage({
          text: "@orchestrator [done] Found existing parser in src/parser.ts (uses Result<T>).",
        });
      });

      await engine.addMembers({
        name: "researcher",
        role: "worker",
        brief: "Inspect src/parser.ts and report interfaces.",
      });
      const phase1 = await engine.waitForBoard({ since: 1, timeoutMs: 2000 });
      assert.equal(phase1.wokeBy, "message");
      assert.ok(phase1.messages.some((m) => m.from === "researcher" && m.text.includes("[done]")));
      const researchSeq = phase1.messages.find((m) => m.from === "researcher")!.seq;

      // Phase 2: Scaffold worker references #researchSeq without copy-pasting
      transport.onMember("scaffold", async ({ request }) => {
        const ref = await request.engineApi!.readBoard({ seqs: [researchSeq] });
        assert.equal(ref.messages.length, 1);
        await request.engineApi!.postMessage({
          text: `@orchestrator [done] Landed shared types based on #${researchSeq}.`,
        });
      });
      await engine.addMembers({
        name: "scaffold",
        brief: `Read #${researchSeq} via read_board and land shared types.`,
      });
      const phase2 = await engine.waitForBoard({ since: phase1.head, timeoutMs: 2000 });
      assert.equal(phase2.wokeBy, "message");

      // Phase 3: Parallel workers -> independent read-only validator -> warm peer fix loop!
      let authorFixCount = 0;
      transport.onMember("author-a", async ({ request, turnIndex }) => {
        if (turnIndex === 1) {
          await request.engineApi!.postMessage({
            text: "@verifier Implemented parser-a; please audit.",
          });
        } else {
          authorFixCount += 1;
          await request.engineApi!.postMessage({
            text: "@verifier Fixed null guard on line 42; ready to re-verify.",
          });
        }
      });

      let validatorAudits = 0;
      transport.onMember("verifier", async ({ request }) => {
        validatorAudits += 1;
        if (validatorAudits === 1) {
          // Bounce directly to @author-a WITHOUT waking @orchestrator!
          await request.engineApi!.postMessage({
            text: "@author-a Bug in parser-a.ts:42 missing null guard. Please fix.",
            kind: "review",
          });
        } else {
          await request.engineApi!.postMessage({
            text: "@orchestrator [done] Audited author-a fix: all checks pass!",
            kind: "review",
          });
        }
      });

      // Spawn verifier first (waiting) and author-a (triggers peer-to-peer loop)
      await engine.addMembers({
        name: "verifier",
        role: "validator",
        brief: "Independently audit author-a when ready.",
      });
      await waitUntil(() => engine.getSnapshot().run?.members.verifier?.state === "waiting");

      // Reset validator counter after initial startup check, now author-a triggers real audit -> fix -> re-audit!
      validatorAudits = 0;
      const beforePhase3 = engine.getSnapshot().boardHead;
      await engine.addMembers({
        name: "author-a",
        role: "worker",
        brief: "Implement parser-a and hand off to @verifier.",
      });

      const phase3 = await engine.waitForBoard({ since: beforePhase3, timeoutMs: 2000 });
      assert.equal(phase3.wokeBy, "message");
      assert.equal(authorFixCount, 1, "author-a should have been woken warm for peer fix loop");
      assert.equal(validatorAudits, 2, "verifier should audit, bounce, and re-audit");
      assert.equal(transport.handles.get("author-a")!.wakePrompts.length, 1);
      assert.ok(
        phase3.messages.some(
          (m) => m.from === "verifier" && m.text.includes("[done]"),
        ),
      );

      // Phase 4: Complete run cleanly
      const finished = await engine.completeRun({
        summary: "All modules built and independently validated.",
      });
      assert.equal(finished.status, "completed");
      assert.ok(events.some((e) => e.type === "run_finished"));

      // Verify warm handles were disposed cleanly
      assert.equal(transport.handles.get("author-a")!.killed, true);
      assert.equal(transport.handles.get("verifier")!.killed, true);

      // Verify [done] post has NO @ mentions
      const board = await store.readBoard("run-dyn", { limit: 10 });
      const lastMsg = board.messages[board.messages.length - 1]!;
      assert.equal(lastMsg.kind, "done");
      assert.equal(lastMsg.mentions.length, 0);
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 2. Sharded Spawning (n & tasks[]) + @prefix Group Wakeup + Naming Rules
// ============================================================================

describe("SwarmEngine — Sharded Spawning, @prefix Wakeup & Naming Rules", () => {
  it("supports n:3 homogeneous copies, tasks[] sharding, @prefix wakeup, and rejects reserved/killed-name reuse", async () => {
    const { engine, transport } = await createTestHarness();
    try {
      // Spawn n: 3 homogeneous workers -> worker-1..3
      const copies = await engine.addMembers({
        name: "worker",
        n: 3,
        brief: "Process shard",
      });
      assert.deepEqual(
        copies.map((m) => m.name),
        ["worker-1", "worker-2", "worker-3"],
      );
      assert.ok(copies.every((m) => m.groupPrefix === "worker"));

      // Spawn tasks[] sharded workers -> slice-1..2 with per-slice briefs
      const sharded = await engine.addMembers({
        name: "slice",
        tasks: ["src/a.ts", "src/b.ts"],
        brief: "Refactor target module",
      });
      assert.deepEqual(
        sharded.map((m) => m.name),
        ["slice-1", "slice-2"],
      );
      assert.ok(sharded[0]!.brief.includes("src/a.ts"));
      assert.ok(sharded[1]!.brief.includes("src/b.ts"));

      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // @prefix group wakeup wakes all 3 `worker-*` members (and NOT `slice-*`)!
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@worker sync on updated API contract",
      });
      await waitUntil(
        () =>
          transport.handles.get("worker-1")!.wakePrompts.length === 1 &&
          transport.handles.get("worker-2")!.wakePrompts.length === 1 &&
          transport.handles.get("worker-3")!.wakePrompts.length === 1,
      );
      assert.equal(transport.handles.get("slice-1")!.wakePrompts.length, 0);

      // Kill worker-2 and verify its name CANNOT be reused!
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);
      await engine.killMember("worker-2", { reason: "done" });
      await assert.rejects(
        () => engine.addMembers({ name: "worker-2", brief: "Reuse attempt" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "DUPLICATE_MEMBER",
      );

      // Reserved & malformed names rejected
      await assert.rejects(
        () => engine.addMembers({ name: "orchestrator", brief: "Illegal" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "INVALID_NAME",
      );
      await assert.rejects(
        () => engine.addMembers({ name: "Bad Name!", brief: "Illegal" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "INVALID_NAME",
      );
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 3. TRUE Conversation Forking (Member & Orchestrator + Transport Seeding)
// ============================================================================

describe("SwarmEngine & Transport — TRUE Conversation Forking", () => {
  it("forks live AgentMessage[] from a warm member and from orchestrator hostContext", async () => {
    const { engine, transport } = await createTestHarness();
    try {
      await engine.addMembers({
        name: "scout",
        brief: "Discover database schema",
      });
      await waitUntil(() => engine.getSnapshot().run?.members.scout?.state === "waiting");

      // Fork from warm member `scout`
      const forkedFromScout = await engine.addMembers({
        name: "builder",
        fork: "scout",
        brief: "Implement migrations using scout's conversation context.",
      });
      assert.equal(forkedFromScout[0]!.forkedFrom, "scout");
      await waitUntil(() => transport.spawns.some((s) => s.name === "builder"));
      const builderSpawn = transport.spawns.find((s) => s.name === "builder")!;
      assert.ok(builderSpawn.seedMessages && builderSpawn.seedMessages.length >= 2);

      // Fork from `orchestrator` hostContext (including mid-tool-call dangling toolCall stripping!)
      const hostMsgs: AgentMessage[] = [
        makeUserMessage("Plan the auth overhaul"),
        makeAssistantTextMessage("We will use JWT with rotation."),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Spawning auth worker..." },
            { type: "toolCall", id: "dangling-tc-1", name: "swarm", arguments: { action: "add" } },
          ],
          stopReason: "toolUse",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
      ];

      const mockHostCtx = {
        sessionManager: {
          buildSessionProjection: () => ({
            entries: [],
            messages: hostMsgs,
            thinkingLevel: "off",
            model: null,
          }),
        },
      } as unknown as ExtensionContext;

      const forkedFromOrch = await engine.addMembers({
        name: "auth-dev",
        fork: "orchestrator",
        brief: "Implement JWT rotation.",
        hostContext: mockHostCtx,
      });
      assert.equal(forkedFromOrch[0]!.forkedFrom, "orchestrator");

      await waitUntil(() => transport.spawns.some((s) => s.name === "auth-dev"));
      const authSpawn = transport.spawns.find((s) => s.name === "auth-dev")!;
      assert.ok(authSpawn.seedMessages && authSpawn.seedMessages.length === 3);
      // Verify the dangling unresolved toolCall block was stripped while text survived!
      const lastSeed = authSpawn.seedMessages![2] as unknown as {
        content: Array<{ type: string }>;
      };
      assert.equal(lastSeed.content.some((c) => c.type === "toolCall"), false);
      assert.equal(lastSeed.content.some((c) => c.type === "text"), true);
    } finally {
      await engine.dispose();
    }
  });

  it("InProcessPiTransport seeds SessionManager.inMemory before createAgentSession and exposes getConversationMessages()", async () => {
    let capturedSessionManager: { buildSessionContext: () => { messages: AgentMessage[] } } | undefined;
    let capturedAllowedTools: string[] | undefined;
    let disposedCount = 0;

    const fakeCreateSession = (async (options: Record<string, unknown>) => {
      capturedSessionManager = options.sessionManager as typeof capturedSessionManager;
      capturedAllowedTools = options.tools as string[];

      const listeners = new Set<(e: unknown) => void>();
      const fakeSession = {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        sessionManager: options.sessionManager,
        extensionRunner: { hasHandlers: () => false, emit: async () => {} },
        bindExtensions: async () => {},
        subscribe: (fn: (e: unknown) => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        prompt: async () => {
          const sm = options.sessionManager as { appendMessage: (m: AgentMessage) => void };
          const reply = makeAssistantTextMessage("Forked session reply!");
          sm.appendMessage(reply);
          for (const l of listeners) {
            l({ type: "message_end", message: reply });
          }
        },
        abort: async () => {},
        dispose: () => {
          disposedCount += 1;
        },
        getSessionStats: () => ({
          tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 },
          cost: 0.001,
        }),
      } as unknown as AgentSession;

      return { session: fakeSession, extensionsResult: { extensions: [], errors: [], runtime: {} } };
    }) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession;

    const transport = new InProcessPiTransport({
      createSession: fakeCreateSession,
    });

    const seed = [
      makeUserMessage("Earlier discovery question"),
      makeAssistantTextMessage("Earlier discovery answer"),
    ];
    const handle = await transport.spawnMember({
      agentId: "forked-1",
      name: "forked",
      role: "validator",
      runId: "run-1",
      cwd: process.cwd(),
      workspace: "inherit",
      parentName: ORCHESTRATOR_NAME,
      brief: "Audit changes",
      systemPrompt: "Read-only validator",
      initialPrompt: "Start audit",
      keepWarm: true,
      seedMessages: seed,
    });

    const turn = await handle.currentTurn;
    assert.equal(turn.outcome, "waiting");
    assert.ok(capturedSessionManager, "SessionManager should be passed to createAgentSession");
    const seededMessages = handle.getConversationMessages();
    assert.equal(seededMessages.length, 3, "2 seeded messages + 1 new assistant reply");

    // Verify validator tool allowlist has read-only tools + bash + 4 core swarm tools (NO write/edit!)
    assert.ok(capturedAllowedTools);
    assert.ok(capturedAllowedTools!.includes(SWARM_TOOL));
    assert.ok(capturedAllowedTools!.includes(POST_MESSAGE_TOOL));
    assert.ok(capturedAllowedTools!.includes(READ_BOARD_TOOL));
    assert.ok(capturedAllowedTools!.includes(SWARM_WAIT_TOOL));
    assert.equal(capturedAllowedTools!.includes("write"), false);
    assert.equal(capturedAllowedTools!.includes("edit"), false);

    // Kill twice -> WeakSet guarantees leak-free single disposal!
    await handle.kill("done");
    await handle.kill("done again");
    assert.equal(disposedCount, 1);
  });
});

// ============================================================================
// 4. Worker Helper Spawning, Permission Boundaries & Human-Stop Sovereignty
// ============================================================================

describe("SwarmEngine — Helper Spawning, Permissions & Human-Stop Sovereignty", () => {
  it("enforces worker/validator helper permissions and respects human-stopped sovereignty", async () => {
    const { engine, transport } = await createTestHarness();
    try {
      await engine.addMembers({ name: "lead", brief: "Lead worker" });
      await engine.addMembers({ name: "sibling", brief: "Sibling worker" });
      await engine.addMembers({ name: "auditor", role: "validator", brief: "Read-only auditor" });
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      const leadBridge = transport.handles.get("lead")!.request.engineApi!;
      const auditorBridge = transport.handles.get("auditor")!.request.engineApi!;

      // Lead spawns its own helper
      const helpers = await leadBridge.addHelper({
        name: "sub-helper",
        brief: "Investigate edge case and report to @lead.",
      });
      assert.equal(helpers[0]!.parentName, "lead");
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // Lead CAN hot-switch model and kill its own helper
      const switched = await leadBridge.switchModel("sub-helper", "google/gemini-2.5-pro", "low");
      assert.equal(switched.model, "google/gemini-2.5-pro");
      await leadBridge.killHelper("sub-helper", "integrated");
      assert.equal(engine.getSnapshot().run?.members["sub-helper"]?.state, "killed");

      // Lead CANNOT kill or switch model of sibling!
      await assert.rejects(
        () => leadBridge.killHelper("sibling"),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );
      await assert.rejects(
        () => leadBridge.switchModel("sibling", "google/gemini-2.5-pro"),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );

      // Worker CANNOT call title / merge / done!
      await assert.rejects(
        () => engine.setTitle("Hijacked", { callerRole: "worker", actor: "lead" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );
      await assert.rejects(
        () => engine.mergeMember("lead", { callerRole: "worker", callerName: "lead" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );
      await assert.rejects(
        () => engine.completeRun({ summary: "done", callerRole: "worker", actor: "lead" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );

      // Validator CANNOT spawn a write-capable worker helper, CAN spawn read-only validator helper!
      await assert.rejects(
        () =>
          auditorBridge.addHelper({
            name: "bad-helper",
            role: "worker",
            brief: "Try to edit files",
          }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "ROLE_FORBIDDEN",
      );
      const valHelper = await auditorBridge.addHelper({
        name: "sub-auditor",
        role: "validator",
        brief: "Read-only sub-audit",
      });
      assert.equal(valHelper[0]!.role, "validator");
      assert.equal(valHelper[0]!.parentName, "auditor");
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // Human-stop sovereignty: peer @mention does NOT revive human-stopped worker,
      // while explicit orchestrator/human post DOES revive it!
      await engine.stopMember("sibling", { humanStopped: true, reason: "User paused" });
      assert.equal(engine.getSnapshot().run?.members.sibling?.humanStopped, true);

      const wakesBefore = transport.handles.get("sibling")!.wakePrompts.length;
      const spawnsBefore = transport.spawns.length;
      await leadBridge.postMessage({ text: "@sibling hey wake up from peer" });
      await delay(40);
      assert.equal(transport.handles.get("sibling")!.wakePrompts.length, wakesBefore);
      assert.equal(transport.spawns.length, spawnsBefore);

      // Orchestrator explicitly messaging @sibling revives it!
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@sibling resume work now",
      });
      await waitUntil(() => transport.spawns.length > spawnsBefore);
      assert.equal(engine.getSnapshot().run?.members.sibling?.humanStopped, false);
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 5. Channels (create/join/leave/archive, @#channel wakeup, reject @#main)
// ============================================================================

describe("SwarmEngine — Channels & Cross-Channel Wakeups", () => {
  it("supports create, join, leave, archive, @#channel wakeups, and rejects @#main & archived channels", async () => {
    const { engine, transport } = await createTestHarness();
    const wakeEvents: SwarmEngineEvent[] = [];
    engine.subscribe((e) => {
      if (e.type === "wakeup_needed") wakeEvents.push(e);
    });

    try {
      const created = await engine.manageChannel({
        action: "create",
        name: "backend",
        topic: "API & DB coordination",
      });
      assert.equal(created.channel?.name, "backend");

      await engine.addMembers({
        name: "api-dev",
        channels: ["backend"],
        brief: "Own API endpoints",
      });
      await engine.addMembers({
        name: "ui-dev",
        channels: ["main"],
        brief: "Own UI components",
      });
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // Reject @#main broadcast!
      await assert.rejects(
        () =>
          engine.postMessage({
            from: ORCHESTRATOR_NAME,
            fromRole: "orchestrator",
            text: "@#main hello everyone",
          }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "INVALID_CHANNEL",
      );

      // @#backend wakes api-dev (and notifies orchestrator), NOT ui-dev!
      const uiBridge = transport.handles.get("ui-dev")!.request.engineApi!;
      await uiBridge.postMessage({ text: "@#backend need new /v2/status schema" });
      await waitUntil(() => transport.handles.get("api-dev")!.wakePrompts.length === 1);
      assert.equal(transport.handles.get("ui-dev")!.wakePrompts.length, 0);
      assert.ok(wakeEvents.length >= 1, "@#channel should also notify orchestrator");

      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // Worker can join & leave a channel for itself, but CANNOT archive!
      await uiBridge.manageChannel({ action: "join", name: "backend" });
      assert.ok(engine.getSnapshot().run?.members["ui-dev"]?.channels.includes("backend"));
      await uiBridge.manageChannel({ action: "leave", name: "backend" });
      assert.equal(engine.getSnapshot().run?.members["ui-dev"]?.channels.includes("backend"), false);

      await assert.rejects(
        () => uiBridge.manageChannel({ action: "archive", name: "backend" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );

      // Orchestrator archives #backend -> posting, mentioning, or joining fails with CHANNEL_ARCHIVED
      await engine.manageChannel({ action: "archive", name: "backend" });
      await assert.rejects(
        () =>
          engine.postMessage({
            from: ORCHESTRATOR_NAME,
            fromRole: "orchestrator",
            channel: "backend",
            text: "post to archived",
          }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "CHANNEL_ARCHIVED",
      );
      await assert.rejects(
        () =>
          engine.postMessage({
            from: ORCHESTRATOR_NAME,
            fromRole: "orchestrator",
            text: "@#backend ping archived",
          }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "CHANNEL_ARCHIVED",
      );
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 6. Blocking swarm_wait (message, all_idle anti-deadlock, AbortSignal, timeout)
// ============================================================================

describe("SwarmEngine — Blocking waitForBoard (swarm_wait)", () => {
  it("resolves on @orchestrator post, resolves all_idle anti-deadlock, and cancels cleanly on AbortSignal", async () => {
    const { engine, transport } = await createTestHarness();
    try {
      // Case A: 0 members -> immediate all_idle anti-deadlock
      const emptyWait = await engine.waitForBoard({ since: 0 });
      assert.equal(emptyWait.wokeBy, "all_idle");

      // Case B: Worker posts @orchestrator while waitForBoard is blocked + receives progress updates
      const progressUpdates: string[] = [];
      transport.onMember("slow-worker", async ({ request }) => {
        await delay(60);
        await request.engineApi!.postMessage({
          text: "@orchestrator [done] finished slow task",
        });
      });
      await engine.addMembers({ name: "slow-worker", brief: "Do slow work" });
      const sinceSeq = engine.getSnapshot().boardHead;
      const msgWait = await engine.waitForBoard({
        since: sinceSeq,
        onProgress: (s) => progressUpdates.push(s),
        timeoutMs: 2000,
      });
      assert.equal(msgWait.wokeBy, "message");
      assert.ok(progressUpdates.length >= 1);
      assert.ok(msgWait.messages.some((m) => m.from === "slow-worker"));

      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // Case C: Worker finishes WITHOUT mentioning @orchestrator -> wakes with all_idle (anti-deadlock!)
      transport.onMember("silent-worker", async () => {
        await delay(50);
        // finishes silently without posting @orchestrator
      });
      await engine.addMembers({ name: "silent-worker", brief: "Work silently" });
      const silentSince = engine.getSnapshot().boardHead;
      const idleWait = await engine.waitForBoard({ since: silentSince, timeoutMs: 2000 });
      assert.equal(idleWait.wokeBy, "all_idle");

      // Case D: AbortSignal cancels wait immediately!
      let releaseBlocked!: () => void;
      const blockedPromise = new Promise<void>((r) => {
        releaseBlocked = r;
      });
      transport.onMember("long-worker", async () => {
        await blockedPromise;
      });
      await engine.addMembers({ name: "long-worker", brief: "Run until aborted" });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 40);
      const abortWait = await engine.waitForBoard({
        since: engine.getSnapshot().boardHead,
        signal: ac.signal,
        timeoutMs: 5000,
      });
      assert.equal(abortWait.wokeBy, "aborted");
      releaseBlocked();
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 7. Simultaneous @mention Coalescing & SWARM_MAX_BOARD_HOPS Ping-Pong Cap
// ============================================================================

describe("SwarmEngine — Wakeup Coalescing & Hop Cap", () => {
  it("coalesces simultaneous @mentions with 0 dropped messages", async () => {
    const { engine, transport } = await createTestHarness();
    const receivedPrompts: string[] = [];

    try {
      transport.onMember("receiver", async ({ prompt, turnIndex }) => {
        if (turnIndex > 1) {
          receivedPrompts.push(prompt);
          await delay(30);
        }
      });

      await engine.addMembers({ name: "receiver", brief: "Wait for bursts" });
      await waitUntil(() => engine.getSnapshot().run?.members.receiver?.state === "waiting");

      // Fire 5 simultaneous @receiver posts concurrently!
      await Promise.all([
        engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "@receiver msg-1" }),
        engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "@receiver msg-2" }),
        engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "@receiver msg-3" }),
        engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "@receiver msg-4" }),
        engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "@receiver msg-5" }),
      ]);

      await waitUntil(() => {
        const joined = receivedPrompts.join("\n");
        return (
          joined.includes("msg-1") &&
          joined.includes("msg-2") &&
          joined.includes("msg-3") &&
          joined.includes("msg-4") &&
          joined.includes("msg-5") &&
          engine.getSnapshot().workingMemberNames.length === 0
        );
      });

      const allDelivered = receivedPrompts.join("\n");
      for (let i = 1; i <= 5; i++) {
        assert.ok(allDelivered.includes(`msg-${i}`), `msg-${i} must not be dropped`);
      }
    } finally {
      await engine.dispose();
    }
  });

  it("caps infinite peer-to-peer ping-pong at SWARM_MAX_BOARD_HOPS and alerts @orchestrator", async () => {
    const { engine, transport, store } = await createTestHarness();
    try {
      let pingCount = 0;
      transport.onMember("ping", async ({ request, turnIndex }) => {
        if (turnIndex === 1) return;
        pingCount += 1;
        await request.engineApi!.postMessage({ text: `@pong bounce ${pingCount}` });
      });
      transport.onMember("pong", async ({ request, turnIndex }) => {
        if (turnIndex === 1) return;
        await request.engineApi!.postMessage({ text: `@ping return ${turnIndex}` });
      });

      await engine.addMembers({ name: "ping", brief: "Ready" });
      await engine.addMembers({ name: "pong", brief: "Ready" });
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // Kick off infinite peer ping-pong
      const pingBridge = transport.handles.get("ping")!.request.engineApi!;
      await pingBridge.postMessage({ text: "@pong start" });

      await waitUntil(() => {
        const snap = engine.getSnapshot();
        return (
          snap.workingMemberNames.length === 0 &&
          snap.recentBoard.some((m) => m.text.includes("[hop-cap]"))
        );
      }, 4000);

      const board = await store.readBoard("run-dyn", { limit: 100 });
      const peerMessages = board.messages.filter((m) => m.from === "ping" || m.from === "pong");
      assert.ok(
        peerMessages.length <= SWARM_MAX_BOARD_HOPS + 2,
        `Peer hops must be bounded near SWARM_MAX_BOARD_HOPS (${SWARM_MAX_BOARD_HOPS}), got ${peerMessages.length}`,
      );
      assert.ok(board.messages.some((m) => m.from === "monitor" && m.text.includes("[hop-cap]")));
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 8. Hot Model Switching & Quota Auto-Fallback via fallbackModels
// ============================================================================

describe("SwarmEngine — Hot switchModel & Quota Auto-Fallback", () => {
  it("hot-switches waiting members (rejecting working & killed) and auto-falls back on 429 preserving history", async () => {
    const { engine, transport, store } = await createTestHarness({
      workerModel: "anthropic/claude-sonnet-4-5",
      fallbackModels: ["google/gemini-2.5-pro"],
    });

    try {
      // Verify working member rejects switchModel
      let finishWorking!: () => void;
      const workingGate = new Promise<void>((r) => {
        finishWorking = r;
      });
      transport.onMember("busy", async () => {
        await workingGate;
      });
      await engine.addMembers({ name: "busy", brief: "Stay busy" });
      await waitUntil(() => transport.handles.has("busy"));

      await assert.rejects(
        () => engine.switchModel({ targetName: "busy", model: "google/gemini-2.5-pro" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "MEMBER_NOT_WAITING",
      );

      finishWorking();
      await waitUntil(() => engine.getSnapshot().run?.members.busy?.state === "waiting");

      // Hot-switch on waiting member succeeds, logs event, posts [model] notice, AND auto-resumes!
      const switched = await engine.switchModel({
        targetName: "busy",
        model: "anthropic/claude-opus-4-6",
        thinkingLevel: "high",
        reason: "Needs stronger reasoning",
      });
      assert.equal(switched.model, "anthropic/claude-opus-4-6");
      assert.equal(switched.thinkingLevel, "high");
      assert.equal(switched.resumed, true);
      assert.ok(store.events.some((e) => e.type === "member_model_switched" && e.memberName === "busy"));
      const board = await store.readBoard("run-dyn", { limit: 20 });
      assert.ok(board.messages.some((m) => m.kind === "model_switch" && m.text.includes("[model]")));
      await waitUntil(() => transport.handles.get("busy")!.wakePrompts.length >= 1);
      await waitUntil(() => engine.getSnapshot().run?.members.busy?.state === "waiting");
      assert.match(transport.handles.get("busy")!.wakePrompts[0]!, /hot-switched to "anthropic\/claude-opus-4-6"/);

      // Killed member rejects switchModel
      await engine.killMember("busy");
      await assert.rejects(
        () => engine.switchModel({ targetName: "busy", model: "google/gemini-2.5-pro" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "MEMBER_KILLED",
      );

      // Auto-fallback on 429: first turn returns rate_limited -> engine hot-switches to gemini-2.5-pro & re-wakes!
      const seenModels: Array<string | undefined> = [];
      transport.onMember("quota-hit", async ({ model, turnIndex, request }) => {
        seenModels.push(model);
        if (turnIndex === 1) {
          return {
            outcome: "rate_limited",
            error: "HTTP 429 quota exceeded",
            retryAfterMs: 5000,
          };
        }
        await request.engineApi!.postMessage({
          text: `@orchestrator [done] Finished after fallback on ${model}`,
        });
        return { outcome: "waiting" };
      });

      const since = engine.getSnapshot().boardHead;
      await engine.addMembers({ name: "quota-hit", brief: "Work with quota fallback" });
      const res = await engine.waitForBoard({ since, timeoutMs: 2000 });
      assert.equal(res.wokeBy, "message");
      assert.deepEqual(seenModels, ["anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro"]);
      assert.equal(
        engine.getSnapshot().run?.members["quota-hit"]?.model,
        "google/gemini-2.5-pro",
      );
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 9. Zero-Token Stall Watchdog
// ============================================================================

describe("SwarmEngine — Zero-Token Stall Watchdog", () => {
  it("posts [stall] from monitor when swarm goes silent without @orchestrator, and stays quiet after completeRun", async () => {
    const { engine, store } = await createTestHarness({
      stallWatchdogEnabled: true,
      stallMonitorMode: "deterministic",
      stallTimeoutMs: 60,
    });
    const stallEvents: SwarmEngineEvent[] = [];
    const wakeEvents: SwarmEngineEvent[] = [];
    engine.subscribe((e) => {
      if (e.type === "stall_detected") stallEvents.push(e);
      if (e.type === "wakeup_needed") wakeEvents.push(e);
    });

    try {
      await engine.addMembers({ name: "quiet", brief: "Finish silently" });
      // Wait for worker to park + stall timer (60ms) to fire
      await waitUntil(() => stallEvents.length >= 1, 1500);

      assert.equal(stallEvents.length, 1);
      assert.ok(wakeEvents.length >= 1);
      const board = await store.readBoard("run-dyn", { limit: 20 });
      const stallMsg = board.messages.find((m) => m.kind === "stall");
      assert.ok(stallMsg, "Expected [stall] message on board");
      assert.equal(stallMsg!.from, "monitor");
      assert.ok(stallMsg!.text.includes("@orchestrator [stall]"));
      assert.ok(store.events.some((e) => e.type === "stall_detected"));

      // Complete run -> stall watchdog MUST stay completely quiet afterward!
      const countBeforeDone = stallEvents.length;
      await engine.completeRun({ summary: "Completed after watchdog alert." });
      await delay(140);
      assert.equal(stallEvents.length, countBeforeDone);
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 10. 3-Role Models, Share Worktree Merge & Dirty-Worktree Guard, and 4 Tools
// ============================================================================

describe("SwarmEngine — 3-Role Models, Worktree Merge/Kill Guards & 4 Core Tools", () => {
  it("routes workerModel vs validatorModel and enforces share worktree merge & dirty-kill guards", async () => {
    const { engine, worktree } = await createTestHarness({
      workerModel: "anthropic/claude-sonnet-4-5",
      workerThinkingLevel: "medium",
      validatorModel: "anthropic/claude-opus-4-6",
      validatorThinkingLevel: "high",
    });

    try {
      const [w] = await engine.addMembers({
        name: "coder",
        role: "worker",
        workspace: "share",
        brief: "Edit isolated worktree",
      });
      const [v] = await engine.addMembers({
        name: "reviewer",
        role: "validator",
        brief: "Audit isolated worktree",
      });
      assert.equal(w!.model, "anthropic/claude-sonnet-4-5");
      assert.equal(w!.thinkingLevel, "medium");
      assert.equal(v!.model, "anthropic/claude-opus-4-6");
      assert.equal(v!.thinkingLevel, "high");
      assert.equal(worktree.createdWorktrees.length, 1);
      assert.ok(w!.branch?.startsWith("swarm/"));

      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // Dirty worktree blocks both mergeMember AND killMember (unless force: true)!
      worktree.dirtyPaths.add(w!.cwd);
      await assert.rejects(
        () => engine.mergeMember("coder"),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "DIRTY_WORKTREE",
      );
      await assert.rejects(
        () => engine.killMember("coder"),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "DIRTY_WORKTREE",
      );

      // Clean worktree -> test WRONG_BRANCH, DIRTY_BASE, REBASE_CONFLICT, then clean merge!
      worktree.dirtyPaths.delete(w!.cwd);
      worktree.baseBranchCheck = { ok: false, currentBranch: "other", dirty: false };
      await assert.rejects(
        () => engine.mergeMember("coder"),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "WRONG_BRANCH",
      );

      worktree.baseBranchCheck = { ok: false, currentBranch: "main", dirty: true };
      await assert.rejects(
        () => engine.mergeMember("coder"),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "DIRTY_BASE",
      );

      worktree.baseBranchCheck = { ok: true, currentBranch: "main", dirty: false };
      worktree.rebaseResult = { status: "conflict", conflictFiles: ["src/a.ts"] };
      await assert.rejects(
        () => engine.mergeMember("coder"),
        (err: unknown) =>
          err instanceof SwarmProtocolError &&
          err.code === "REBASE_CONFLICT" &&
          Array.isArray(err.details?.conflictFiles),
      );

      // Clean rebase & merge succeeds and records mergedCommitSha!
      worktree.rebaseResult = { status: "rebased", newHeadSha: "2222222" };
      const merged = await engine.mergeMember("coder");
      assert.ok(merged);
      assert.equal(merged!.mergedCommitSha, worktree.nextMergeSha);
      assert.equal(engine.getSnapshot().run?.members.coder?.mergedCommitSha, worktree.nextMergeSha);

      // inherit workspace returns null on mergeMember
      assert.equal(await engine.mergeMember("reviewer"), null);

      // Force kill removes even dirty worktree
      worktree.dirtyPaths.add(w!.cwd);
      await engine.killMember("coder", { force: true, reason: "Force cleanup" });
      assert.equal(engine.getSnapshot().run?.members.coder?.state, "killed");
      assert.equal(worktree.removedWorktrees.length, 1);
      assert.equal(worktree.removedWorktrees[0]!.force, true);
    } finally {
      await engine.dispose();
    }
  });

  it("wires all 4 core orchestrator tools and 4 member-scoped tools cleanly", async () => {
    const { engine, transport } = await createTestHarness();
    const dummyCtx = {} as ExtensionToolContext;
    const findTool = (tools: ToolDefinition[], name: string): ToolDefinition => {
      const found = tools.find((t) => t.name === name);
      assert.ok(found, `Missing tool ${name}`);
      return found;
    };

    try {
      const orchTools = createSwarmTools({ engine });
      assert.deepEqual(
        orchTools.map((t) => t.name),
        [...SWARM_CORE_TOOLS],
      );

      const swarmTool = findTool(orchTools, SWARM_TOOL);
      const postTool = findTool(orchTools, POST_MESSAGE_TOOL);
      const readTool = findTool(orchTools, READ_BOARD_TOOL);
      const waitTool = findTool(orchTools, SWARM_WAIT_TOOL);

      // title
      const titleRes = await swarmTool.execute("tc1", { action: "title", title: "Refactored Engine" }, undefined, undefined, dummyCtx);
      assert.equal(titleRes.isError, undefined);
      assert.equal(engine.getSnapshot().run?.title, "Refactored Engine");

      // models
      const modelsRes = await swarmTool.execute("tc2", { action: "models", all: true }, undefined, undefined, dummyCtx);
      assert.equal(modelsRes.isError, undefined);
      assert.ok((modelsRes.content[0] as { text: string }).text.includes("anthropic/claude-opus-4-6"));

      // add
      transport.onMember("tool-worker", async ({ request }) => {
        await request.engineApi!.postMessage({ text: "@orchestrator [done] tool check ok" });
      });
      const addRes = await swarmTool.execute(
        "tc3",
        { action: "add", name: "tool-worker", brief: "Verify tools" },
        undefined,
        undefined,
        dummyCtx,
      );
      assert.equal(addRes.isError, undefined);

      // swarm_wait
      const waitRes = await waitTool.execute("tc4", { since: 1, timeout_ms: 2000 }, undefined, undefined, dummyCtx);
      assert.equal(waitRes.isError, undefined);
      assert.ok((waitRes.content[0] as { text: string }).text.includes("tool check ok"));

      // post_message + read_board (messages & status:true)
      const postRes = await postTool.execute("tc5", { text: "Orchestrator note #2" }, undefined, undefined, dummyCtx);
      assert.equal(postRes.isError, undefined);
      const readRes = await readTool.execute("tc6", { search: "Orchestrator note" }, undefined, undefined, dummyCtx);
      assert.ok((readRes.content[0] as { text: string }).text.includes("Orchestrator note #2"));
      const statusReadRes = await readTool.execute("tc7", { status: true }, undefined, undefined, dummyCtx);
      assert.ok((statusReadRes.content[0] as { text: string }).text.includes("@tool-worker"));

      // Scoped member tools: swarm_wait terminates turn, title/merge/done return PERMISSION_DENIED!
      let recordedWait: { since: number; mentionsOnly: boolean } | undefined;
      const memberTools = createMemberScopedTools(
        transport.handles.get("tool-worker")!.request.engineApi!,
        {
          name: "tool-worker",
          role: "worker",
          runId: "run-dyn",
          onWaitRecorded: (w) => {
            recordedWait = w;
          },
        },
      );
      const memberSwarm = findTool(memberTools, SWARM_TOOL);
      const memberWait = findTool(memberTools, SWARM_WAIT_TOOL);

      const denied = await memberSwarm.execute("tc8", { action: "done", summary: "nope" }, undefined, undefined, dummyCtx);
      assert.equal(denied.isError, true);
      assert.ok((denied.content[0] as { text: string }).text.includes("[SwarmProtocolError:PERMISSION_DENIED]"));

      const waitOut = (await memberWait.execute(
        "tc9",
        { since: 3, mentions_only: false },
        undefined,
        undefined,
        dummyCtx,
      )) as unknown as { terminate?: boolean };
      assert.equal(waitOut.terminate, true);
      assert.deepEqual(recordedWait, { since: 3, mentionsOnly: false });

      // done via orchestrator tool
      const doneRes = await swarmTool.execute("tc10", { action: "done", summary: "All verified" }, undefined, undefined, dummyCtx);
      assert.equal(doneRes.isError, undefined);
      assert.equal(engine.getSnapshot().run?.status, "completed");
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 11. Role Prompts, Path/Bash Guards & Rate-Limit Primitives
// ============================================================================

describe("Runtime Helpers — Role Prompts, Guards & Rate-Limit Utilities", () => {
  it("renders Antigravity Swarm playbook and distinct worker vs read-only validator system prompts", async () => {
    const { engine } = await createTestHarness({
      workerModel: "anthropic/claude-sonnet-4-5",
      validatorModel: "anthropic/claude-opus-4-6",
    });
    try {
      const [w] = await engine.addMembers({ name: "impl", workspace: "share", brief: "Implement feature" });
      const [v] = await engine.addMembers({ name: "audit", role: "validator", brief: "Audit feature" });
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      const snap = engine.getSnapshot();
      const playbook = buildOrchestratorPlaybookSection(snap);
      assert.ok(playbook.includes("Do Not Do the Technical Work Yourself"));
      assert.ok(playbook.includes("Zero-Copy `#seq`"));
      assert.ok(playbook.includes("swarm_wait"));
      assert.ok(playbook.includes("@impl"));
      assert.ok(playbook.includes("@audit"));

      const workerPrompt = buildMemberSystemPrompt(snap.run!, w!);
      assert.ok(workerPrompt.includes("@impl"));
      assert.ok(workerPrompt.includes("Isolated Worktree Commits"));
      assert.ok(workerPrompt.includes(".pi/swarm/"));

      const validatorPrompt = buildMemberSystemPrompt(snap.run!, v!);
      assert.ok(validatorPrompt.includes("STRICTLY READ-ONLY"));
      assert.ok(validatorPrompt.includes("Peer-to-Peer Fix Loop"));
    } finally {
      await engine.dispose();
    }
  });

  it("validates guards, resolveRoleModel, sanitizeForkSeedMessages, and rate-limit utilities", async () => {
    // Guards
    assert.equal(isProtectedSwarmPath(".pi/swarm/runs/1/state.json"), true);
    assert.equal(isProtectedSwarmPath(".git/HEAD"), true);
    assert.equal(isProtectedSwarmPath("src/runtime/engine.ts"), false);

    assert.equal(isReadOnlyValidationCommand("git diff main...HEAD && npm test").allowed, true);
    assert.equal(isReadOnlyValidationCommand("rm -rf src/foo.ts").allowed, false);
    assert.equal(isReadOnlyValidationCommand("echo hi > file.txt").allowed, false);
    assert.equal(isReadOnlyValidationCommand("git commit -m test").allowed, false);

    assert.equal(isForbiddenWorkerBashCommand("npm test", "main").allowed, true);
    assert.equal(isForbiddenWorkerBashCommand("git merge feat/x", "main").allowed, false);
    assert.equal(isForbiddenWorkerBashCommand("git checkout main", "main").allowed, false);
    assert.equal(isForbiddenWorkerBashCommand("rm .pi/swarm/state.json", "main").allowed, false);

    // 3-role resolution
    const settings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      orchestratorModel: "anthropic/claude-opus-4-6",
      workerModel: "anthropic/claude-sonnet-4-5",
      validatorModel: "google/gemini-2.5-pro",
    };
    assert.equal(resolveRoleModel("orchestrator", settings).model, "anthropic/claude-opus-4-6");
    assert.equal(resolveRoleModel("worker", settings).model, "anthropic/claude-sonnet-4-5");
    assert.equal(resolveRoleModel("validator", settings).model, "google/gemini-2.5-pro");
    assert.equal(resolveRoleModel("worker", settings, "openai/gpt-5").model, "openai/gpt-5");

    // Sanitizer preserves paired toolCall/toolResult and strips unpaired toolCall
    const paired = sanitizeForkSeedMessages([
      makeUserMessage("Run tool"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "ok-1", name: "read", arguments: {} }],
        timestamp: Date.now(),
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "ok-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
    ]);
    assert.equal(paired.length, 3);

    // Rate-limit helpers
    assert.equal(isRateLimitOrTransientError(new Error("HTTP 429 Too Many Requests")), true);
    assert.equal(isRateLimitOrTransientError(new Error("Syntax error")), false);
    assert.equal(parseRetryAfterMs("Retry-After: 3s"), 3000);
    assert.equal(
      selectFallbackModel("a/1", ["a/1", "b/2", "c/3"], new Set(["b/2"])),
      "c/3",
    );

    const breaker = new RateLimitBreaker({ baseBackoffMs: 20, maxBackoffMs: 100, jitterRatio: 0 });
    const gate = new ConcurrencyGate(2, breaker);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    assert.equal(gate.getActiveCount(), 2);
    assert.equal(gate.tryAcquire(), null);
    r1();
    r2();
    assert.equal(gate.getActiveCount(), 0);
  });

  it("InProcessPiTransport handles early kill() leak-free and classifies stopReason=error 429 while keeping session warm", async () => {
    // 1. Early kill during pending createSession disposes created session cleanly (once)
    let resolveCreate!: () => void;
    const createGate = new Promise<void>((r) => {
      resolveCreate = r;
    });
    let lateDisposed = 0;

    const slowCreateSession = (async (options: Record<string, unknown>) => {
      await createGate;
      const fakeSession = {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        sessionManager: options.sessionManager,
        extensionRunner: { hasHandlers: () => false, emit: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {
          lateDisposed += 1;
        },
        getSessionStats: () => ({
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        }),
      } as unknown as AgentSession;
      return { session: fakeSession, extensionsResult: { extensions: [], errors: [], runtime: {} } };
    }) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession;

    const earlyTransport = new InProcessPiTransport({ createSession: slowCreateSession });
    const earlyHandle = await earlyTransport.spawnMember({
      agentId: "early-1",
      name: "early",
      role: "worker",
      runId: "run-1",
      cwd: process.cwd(),
      workspace: "inherit",
      parentName: ORCHESTRATOR_NAME,
      brief: "Test early kill",
      systemPrompt: "Worker",
      initialPrompt: "Start",
      keepWarm: true,
    });
    await earlyHandle.kill("Killed mid-init");
    resolveCreate();
    const earlyTurn = await earlyHandle.currentTurn;
    assert.equal(earlyTurn.outcome, "killed");
    assert.equal(earlyHandle.getState(), "killed");
    assert.ok(lateDisposed <= 1, "Late session must be disposed at most once");

    // 2. stopReason === "error" with HTTP 429 keeps warm session in `waiting` with outcome="rate_limited"
    const rateLimitCreateSession = (async (options: Record<string, unknown>) => {
      const listeners = new Set<(e: unknown) => void>();
      const fakeSession = {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        sessionManager: options.sessionManager,
        extensionRunner: { hasHandlers: () => false, emit: async () => {} },
        bindExtensions: async () => {},
        subscribe: (fn: (e: unknown) => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        prompt: async () => {
          const errMsg = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "HTTP 429 rate limit exceeded, retry-after: 4s",
            timestamp: Date.now(),
          };
          for (const l of listeners) {
            l({ type: "message_end", message: errMsg });
          }
        },
        abort: async () => {},
        dispose: () => {},
        getSessionStats: () => ({
          tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
          cost: 0,
        }),
      } as unknown as AgentSession;
      return { session: fakeSession, extensionsResult: { extensions: [], errors: [], runtime: {} } };
    }) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession;

    const rlTransport = new InProcessPiTransport({ createSession: rateLimitCreateSession });
    const rlHandle = await rlTransport.spawnMember({
      agentId: "rl-1",
      name: "rl",
      role: "worker",
      runId: "run-1",
      cwd: process.cwd(),
      workspace: "inherit",
      parentName: ORCHESTRATOR_NAME,
      brief: "Hit 429",
      systemPrompt: "Worker",
      initialPrompt: "Start",
      keepWarm: true,
    });
    const rlTurn = await rlHandle.currentTurn;
    assert.equal(rlTurn.outcome, "rate_limited");
    assert.equal(rlTurn.retryAfterMs, 4000);
    assert.equal(rlHandle.getState(), "waiting", "Warm handle stays waiting for hot model switch");
    await rlHandle.kill("cleanup");
  });

  it("parks failed turns in waiting with error recorded and engages RateLimitBreaker when no fallback exists", async () => {
    const { engine, transport, store } = await createTestHarness({
      fallbackModels: [],
      rateLimitBaseBackoffMs: 50,
      rateLimitMaxBackoffMs: 200,
    });
    try {
      transport.onMember("crasher", async () => ({
        outcome: "failed",
        error: "Unexpected tool schema failure",
      }));
      transport.onMember("throttled", async () => ({
        outcome: "rate_limited",
        error: "HTTP 429 quota exhausted",
        retryAfterMs: 80,
      }));

      await engine.addMembers({ name: "crasher", brief: "Trigger failure" });
      await waitUntil(() => engine.getSnapshot().run?.members.crasher?.state === "waiting");
      assert.equal(
        engine.getSnapshot().run?.members.crasher?.error,
        "Unexpected tool schema failure",
      );
      assert.ok(store.events.some((e) => e.type === "member_error" && e.memberName === "crasher"));

      await engine.addMembers({ name: "throttled", brief: "Trigger 429 without fallback" });
      await waitUntil(() => store.events.some((e) => e.type === "rate_limit_backoff"));
      assert.ok(
        (engine.getSnapshot().rateLimitUntil ?? 0) > Date.now(),
        "RateLimitBreaker should populate snapshot.rateLimitUntil",
      );
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 12. Verifier Regression Suite (6 Hardened Race & Concurrency Fixes)
// ============================================================================

describe("SwarmEngine — Verifier Regression Fixes", () => {
  it("Regression #1: preserves full sanitized runId in share/branch names to avoid same-day branch collisions", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const transport = new ScriptedTransport();
    const engine = new SwarmEngine({
      store,
      worktree,
      transport,
      settings: { stallWatchdogEnabled: false },
    });

    try {
      const runA = await store.createRun({
        id: "run_20261121010101_aaaaaa",
        title: "Run A",
        objective: "First same-day run",
        baseBranch: "main",
        ownerSessionId: "s1",
      });
      await engine.startRun(runA.id);
      const [authorA] = await engine.addMembers({
        name: "author",
        workspace: "share",
        brief: "Work A",
      });

      const runB = await store.createRun({
        id: "run_20261121010202_bbbbbb",
        title: "Run B",
        objective: "Second same-day run",
        baseBranch: "main",
        ownerSessionId: "s1",
      });
      await engine.startRun(runB.id);
      const [authorB] = await engine.addMembers({
        name: "author",
        workspace: "share",
        brief: "Work B",
      });

      assert.notEqual(authorA!.branch, authorB!.branch);
      assert.equal(authorA!.branch, "swarm/run_20261121010101_aaaaaa/author");
      assert.equal(authorB!.branch, "swarm/run_20261121010202_bbbbbb/author");
    } finally {
      await engine.dispose();
    }
  });

  it("Regression #2: switchModel holds switchingModel lock so concurrent @mentions queue safely and drain onto new model", async () => {
    const { engine, transport } = await createTestHarness({
      workerModel: "anthropic/claude-sonnet-4-5",
    });

    try {
      const wokenWithModels: Array<{ model: string | undefined; prompt: string }> = [];
      transport.onMember("sw", async ({ model, prompt, turnIndex }) => {
        if (turnIndex > 1) {
          wokenWithModels.push({ model, prompt });
        }
      });

      await engine.addMembers({ name: "sw", brief: "Initial work" });
      await waitUntil(() => engine.getSnapshot().run?.members.sw?.state === "waiting");

      // Wrap handle.switchModel with a deferred gate to simulate async model switching
      const rec = transport.handles.get("sw")!;
      const origSwitch = rec.handle.switchModel.bind(rec.handle);
      let releaseSwitch!: () => void;
      const switchGate = new Promise<void>((r) => {
        releaseSwitch = r;
      });
      rec.handle.switchModel = async (m, t) => {
        await switchGate;
        return origSwitch(m, t);
      };

      const switchPromise = engine.switchModel({
        targetName: "sw",
        model: "google/gemini-2.5-pro",
        thinkingLevel: "high",
      });

      // Concurrent switchModel rejects cleanly with MEMBER_NOT_WAITING
      await assert.rejects(
        () => engine.switchModel({ targetName: "sw", model: "anthropic/claude-opus-4-6" }),
        (err: unknown) => err instanceof SwarmProtocolError && err.code === "MEMBER_NOT_WAITING",
      );

      // Concurrent @sw post during switch queues safely instead of throwing MEMBER_NOT_WAITING!
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@sw message arrived mid-switch",
      });
      assert.equal(wokenWithModels.length, 0, "Must not wake while switchModel is in flight");

      // Release switchModel -> queued wake drains automatically onto the NEW model!
      releaseSwitch();
      const switched = await switchPromise;
      assert.equal(switched.model, "google/gemini-2.5-pro");

      await waitUntil(() => wokenWithModels.length === 1);
      assert.equal(wokenWithModels[0]!.model, "google/gemini-2.5-pro");
      assert.ok(wokenWithModels[0]!.prompt.includes("message arrived mid-switch"));
      assert.equal(engine.getSnapshot().run?.members.sw?.error, undefined);
    } finally {
      await engine.dispose();
    }
  });

  it("Regression #3: mid-await stopMember during launch and revive kills late handles and never resurrects stopped state", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const baseTransport = new ScriptedTransport();

    let blockNextSpawn = false;
    let releaseSpawn!: () => void;
    let spawnStarted!: () => void;
    let spawnStartedPromise = new Promise<void>((r) => {
      spawnStarted = r;
    });

    const delayedTransport: ISwarmTransport = {
      async spawnMember(req) {
        if (blockNextSpawn) {
          blockNextSpawn = false;
          spawnStarted();
          await new Promise<void>((r) => {
            releaseSpawn = r;
          });
        }
        return baseTransport.spawnMember(req);
      },
    };

    const engine = new SwarmEngine({
      store,
      worktree,
      transport: delayedTransport,
      settings: { stallWatchdogEnabled: false },
    });

    try {
      const run = await store.createRun({
        id: "run-cancel",
        title: "Cancel Race Test",
        objective: "Verify mid-spawn stop/kill cleanup",
        baseBranch: "main",
        ownerSessionId: "s1",
      });
      await engine.startRun(run.id);

      // Part A: stopMember during initial launchMemberInitialTurn spawnMember
      blockNextSpawn = true;
      await engine.addMembers({ name: "init-race", brief: "Launch blocked" });
      await spawnStartedPromise;

      await engine.stopMember("init-race", { humanStopped: true, reason: "User stopped mid-launch" });
      releaseSpawn();
      await delay(40);

      assert.equal(engine.getSnapshot().run?.members["init-race"]?.state, "stopped");
      assert.equal(baseTransport.handles.get("init-race")?.killed, true, "Late handle must be killed");

      // Part B: stopMember during reviveMemberWithPendingWakes spawnMember
      spawnStartedPromise = new Promise<void>((r) => {
        spawnStarted = r;
      });
      blockNextSpawn = true;
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@init-race revive now",
      });
      await spawnStartedPromise;

      await engine.stopMember("init-race", { humanStopped: true, reason: "User stopped mid-revive" });
      releaseSpawn();
      await delay(40);

      assert.equal(engine.getSnapshot().run?.members["init-race"]?.state, "stopped");
      assert.equal(baseTransport.handles.get("init-race")?.killed, true, "Late revived handle must be killed");
    } finally {
      await engine.dispose();
    }
  });

  it("Regression #4: waitForBoard handles mid-read AbortSignal, mid-read matching post, and mid-read pause without hanging", async () => {
    const { engine, transport, store } = await createTestHarness();
    let releaseWorker!: () => void;
    const workerBlock = new Promise<void>((r) => {
      releaseWorker = r;
    });

    try {
      transport.onMember("busy-w", async () => {
        await workerBlock;
      });
      await engine.addMembers({ name: "busy-w", brief: "Stay active" });
      await waitUntil(() => transport.handles.has("busy-w"));

      const origReadBoard = store.readBoard.bind(store);

      // (a) AbortSignal fires while store.readBoard is pending
      let releaseReadA!: () => void;
      let readAEntered!: () => void;
      const readAEnteredP = new Promise<void>((r) => {
        readAEntered = r;
      });
      store.readBoard = async (id, opts) => {
        readAEntered();
        await new Promise<void>((r) => {
          releaseReadA = r;
        });
        return origReadBoard(id, opts);
      };

      const ac = new AbortController();
      const waitA = engine.waitForBoard({
        since: engine.getSnapshot().boardHead,
        signal: ac.signal,
        timeoutMs: 3000,
      });
      await readAEnteredP;
      ac.abort();
      releaseReadA();
      const resA = await waitA;
      assert.equal(resA.wokeBy, "aborted");

      // (b) Matching @orchestrator message arrives while store.readBoard is pending
      let releaseReadB!: () => void;
      let readBEntered!: () => void;
      const readBEnteredP = new Promise<void>((r) => {
        readBEntered = r;
      });
      store.readBoard = async (id, opts) => {
        readBEntered();
        const result = await origReadBoard(id, opts);
        await new Promise<void>((r) => {
          releaseReadB = r;
        });
        return result;
      };

      const sinceB = engine.getSnapshot().boardHead;
      const waitB = engine.waitForBoard({ since: sinceB, timeoutMs: 3000 });
      await readBEnteredP;
      // Restore readBoard before posting so postMessage runs cleanly while waitB's readBoard is still suspended
      store.readBoard = origReadBoard;
      await engine.postMessage({
        from: "busy-w",
        fromRole: "worker",
        text: "@orchestrator mid-read wakeup!",
      });
      releaseReadB();
      const resB = await waitB;
      assert.equal(resB.wokeBy, "message");
      assert.ok(resB.messages.some((m) => m.text.includes("mid-read wakeup!")));

      // (c) pause() runs while store.readBoard is pending -> returns run_ended instead of hanging
      let releaseReadC!: () => void;
      let readCEntered!: () => void;
      const readCEnteredP = new Promise<void>((r) => {
        readCEntered = r;
      });
      store.readBoard = async (id, opts) => {
        readCEntered();
        const result = await origReadBoard(id, opts);
        await new Promise<void>((r) => {
          releaseReadC = r;
        });
        return result;
      };

      const waitC = engine.waitForBoard({
        since: engine.getSnapshot().boardHead,
        timeoutMs: 3000,
      });
      await readCEnteredP;
      store.readBoard = origReadBoard;
      await engine.pause("run-dyn", "Paused mid-read");
      releaseReadC();
      const resC = await waitC;
      assert.equal(resC.wokeBy, "run_ended");

      releaseWorker();
    } finally {
      releaseWorker?.();
      await engine.dispose();
    }
  });

  it("Regression #5: same-run attachRun preserves hop-cap counter and live telemetry logTail/lastTool survives cache refreshes", async () => {
    const { engine, transport, store } = await createTestHarness();
    let finishTurn!: () => void;
    const turnGate = new Promise<void>((r) => {
      finishTurn = r;
    });

    try {
      transport.onMember("tel-w", async ({ request }) => {
        request.onTelemetry?.({
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          runId: request.runId,
          type: "tool_start",
          timestamp: new Date().toISOString(),
          toolName: "bash",
          activity: "bash: npm test",
          logLine: "> bash: npm test",
        });
        await turnGate;
      });

      await engine.addMembers({ name: "tel-w", brief: "Emit telemetry" });
      await waitUntil(() =>
        (engine.getSnapshot().run?.members["tel-w"]?.logTail.length ?? 0) > 0,
      );

      // Trigger cache refreshes (same-run attachRun + setTitle) while member is working
      await engine.attachRun("run-dyn");
      await engine.setTitle("Title Refresh");

      const midMember = engine.getSnapshot().run?.members["tel-w"];
      assert.ok(midMember?.logTail.includes("> bash: npm test"), "logTail must survive cache refresh");
      assert.equal(midMember?.lastTool, "bash", "lastTool must survive cache refresh");

      finishTurn();
      await waitUntil(() => engine.getSnapshot().run?.members["tel-w"]?.state === "waiting");

      // Verify logTail was durably persisted to store on turn completion!
      const persisted = await store.loadRun("run-dyn");
      assert.ok(persisted.members["tel-w"]?.logTail.includes("> bash: npm test"));

      // Verify same-run attachRun does NOT reset boardHopCount!
      let bounces = 0;
      transport.onMember("hop-a", async ({ request, turnIndex }) => {
        if (turnIndex === 1) return;
        bounces += 1;
        await engine.attachRun("run-dyn"); // same-run re-attach mid-ping-pong!
        await request.engineApi!.postMessage({ text: `@hop-b hop ${bounces}` });
      });
      transport.onMember("hop-b", async ({ request, turnIndex }) => {
        if (turnIndex === 1) return;
        await request.engineApi!.postMessage({ text: `@hop-a back ${turnIndex}` });
      });

      await engine.addMembers({ name: "hop-a", brief: "Ready" });
      await engine.addMembers({ name: "hop-b", brief: "Ready" });
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      await transport.handles.get("hop-a")!.request.engineApi!.postMessage({ text: "@hop-b go" });
      await waitUntil(
        () =>
          engine.getSnapshot().workingMemberNames.length === 0 &&
          engine.getSnapshot().recentBoard.some((m) => m.text.includes("[hop-cap]")),
        4000,
      );
      assert.ok(bounces <= SWARM_MAX_BOARD_HOPS, "Same-run attachRun must not defeat hop-cap");
    } finally {
      finishTurn?.();
      await engine.dispose();
    }
  });

  it("Regression #6: swarm_wait{mentions_only:false} wakes parked member on subsequent unmentioned posts in subscribed channels", async () => {
    const { engine, transport } = await createTestHarness();
    try {
      await engine.manageChannel({ action: "create", name: "ops", topic: "Ops channel" });

      transport.onMember("hunter", async ({ request, turnIndex }) => {
        const head = engine.getSnapshot().boardHead;
        if (turnIndex === 1) {
          // Park with mentions_only=false (hunting for any work on #main or #ops!)
          request.onTelemetry?.({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            runId: request.runId,
            type: "waiting",
            timestamp: new Date().toISOString(),
            activity: `waiting (since #${head})`,
            logLine: `swarm_wait since=#${head} mentions_only=false`,
          });
        } else {
          // On second turn, park with mentions_only=true (default)
          request.onTelemetry?.({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            runId: request.runId,
            type: "waiting",
            timestamp: new Date().toISOString(),
            activity: `waiting (since #${head})`,
            logLine: `swarm_wait since=#${head} mentions_only=true`,
          });
        }
      });

      await engine.addMembers({
        name: "hunter",
        channels: ["ops"],
        brief: "Wait with mentions_only=false",
      });
      await waitUntil(() => engine.getSnapshot().run?.members.hunter?.state === "waiting");

      // Post unmentioned message on #ops AFTER hunter has already parked -> MUST wake hunter!
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        channel: "ops",
        text: "Unassigned task dropped in #ops without any mention",
      });
      await waitUntil(() => transport.handles.get("hunter")!.wakePrompts.length === 1);
      await waitUntil(() => engine.getSnapshot().run?.members.hunter?.state === "waiting");

      // Now hunter parked with mentions_only=true -> next unmentioned post must NOT wake it!
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        channel: "ops",
        text: "Routine chatter without mentions",
      });
      await delay(50);
      assert.equal(transport.handles.get("hunter")!.wakePrompts.length, 1);
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 13. v0.3.0 Parity Fixes: Non-Blocking swarm_wait, Self-Switch, Disk Sessions,
//     Smart LLM Monitor, and Mid-Flight Steering
// ============================================================================

describe("SwarmEngine — v0.3.0 Antigravity Swarm Parity & Steering", () => {
  it("parkOrchestratorWait ends turn non-blockingly, wakes once on matching post or all_idle, and clears on user input", async () => {
    const { engine } = await createTestHarness({ stallWatchdogEnabled: false });
    const wakeups: SwarmEngineEvent[] = [];
    engine.subscribe((ev) => {
      if (ev.type === "wakeup_needed") wakeups.push(ev);
    });

    try {
      // Zero active members -> returns immediately parked=false (all_idle)
      const idleRes = await engine.parkOrchestratorWait({ since: 0 });
      assert.equal(idleRes.parked, false);
      assert.equal(idleRes.wokeBy, "all_idle");

      // Active member -> parks non-blockingly and wakes ONCE on @orchestrator with unread messages
      const { transport } = await createTestHarness({ stallWatchdogEnabled: false });
      const { engine: eng2, transport: tr2 } = await (async () => {
        const res = await createTestHarness({ stallWatchdogEnabled: false });
        return res;
      })();
      void transport;
      const wakeups2: SwarmEngineEvent[] = [];
      eng2.subscribe((ev) => {
        if (ev.type === "wakeup_needed") wakeups2.push(ev);
      });

      let releaseW!: () => void;
      const wGate = new Promise<void>((r) => {
        releaseW = r;
      });
      tr2.onMember("alpha", async ({ turnIndex }) => {
        if (turnIndex === 1) await wGate;
      });

      await eng2.addMembers({ name: "alpha", brief: "Work slowly" });
      await waitUntil(() => tr2.handles.has("alpha"));

      const parkRes = await eng2.parkOrchestratorWait({ since: 0, mentionsOnly: true });
      assert.equal(parkRes.parked, true);
      assert.deepEqual(parkRes.activeMembers, ["alpha"]);

      // Non-mention post does not trigger mentionsOnly wakeup yet
      await eng2.postMessage({ from: "alpha", fromRole: "worker", text: "progress note" });
      assert.equal(wakeups2.length, 0);

      // @orchestrator wakes ONCE and attaches all unread messages since #0!
      await eng2.postMessage({
        from: "alpha",
        fromRole: "worker",
        text: "@orchestrator [done] finished task",
      });
      assert.equal(wakeups2.length, 1);
      assert.equal(wakeups2[0]!.messages?.length, 3); // #1 brief + #2 progress + #3 done

      // clearOrchestratorWait suppresses stale all_idle wakeups after user interrupts
      const park2 = await eng2.parkOrchestratorWait({ since: eng2.getSnapshot().boardHead });
      assert.equal(park2.parked, true);
      eng2.clearOrchestratorWait("User sent message");
      releaseW();
      await waitUntil(() => eng2.getSnapshot().workingMemberNames.length === 0);
      assert.equal(wakeups2.length, 1, "clearOrchestratorWait must suppress subsequent all_idle wakeup");

      await eng2.dispose();
    } finally {
      await engine.dispose();
    }
  });

  it("supports deferred self model switch from a working member and auto-resumes on the new model", async () => {
    const { engine, transport } = await createTestHarness({
      workerModel: "anthropic/claude-sonnet-4-5",
      fallbackModels: [],
    });

    try {
      const modelsSeen: Array<{ turn: number; model: string | undefined; prompt: string }> = [];
      let selfSwitchRes: unknown;
      let badSwitchErr: unknown;

      transport.onMember("selfie", async ({ request, prompt, turnIndex, model }) => {
        modelsSeen.push({ turn: turnIndex, model, prompt });
        if (turnIndex === 1) {
          // Invalid model fails synchronously with MODEL_NOT_FOUND
          try {
            await request.engineApi!.switchModel("selfie", "nonexistent/model-xyz");
          } catch (err) {
            badSwitchErr = err;
          }
          // Self-switch while working schedules deferred switch -> terminates turn -> resumes on gemini-2.5-pro!
          const scopedTools = createMemberScopedTools(request.engineApi!, {
            name: "selfie",
            role: "worker",
            runId: request.runId,
          });
          const swarmTool = scopedTools.find((t) => t.name === SWARM_TOOL)!;
          selfSwitchRes = await swarmTool.execute(
            "tc-self",
            {
              action: "model",
              model: "google/gemini-2.5-pro",
              thinking_level: "high",
              reason: "Need larger context window",
            },
            undefined,
            undefined,
            {} as ExtensionToolContext,
          );
          return { outcome: "waiting", summary: "switching model" };
        }
        await request.engineApi!.postMessage({
          text: `@orchestrator [done] Resumed cleanly on ${model}`,
        });
        return { outcome: "waiting", summary: "completed after switch" };
      });

      const since = engine.getSnapshot().boardHead;
      await engine.addMembers({ name: "selfie", brief: "Self-switch to larger model" });
      const waitRes = await engine.waitForBoard({ since, timeoutMs: 3000 });

      assert.equal(waitRes.wokeBy, "message");
      assert.ok(badSwitchErr instanceof SwarmProtocolError && badSwitchErr.code === "MODEL_NOT_FOUND");
      assert.equal((selfSwitchRes as { terminate?: boolean }).terminate, true);
      assert.equal((selfSwitchRes as { details?: { deferred?: boolean } }).details?.deferred, true);
      assert.equal(modelsSeen.length, 2);
      assert.equal(modelsSeen[0]!.model, "anthropic/claude-sonnet-4-5");
      assert.equal(modelsSeen[1]!.model, "google/gemini-2.5-pro");
      assert.match(modelsSeen[1]!.prompt, /Self model hot-switch to "google\/gemini-2\.5-pro"/);
    } finally {
      await engine.dispose();
    }
  });

  it("runs Smart LLM Monitor in 'llm' mode (surgical wake, [noop], and deterministic fallback) & supports steerMember", async () => {
    // 1. Surgical wake of @stuck + steerMember working vs waiting
    const { engine, transport, store } = await createTestHarness({
      stallWatchdogEnabled: true,
      stallMonitorMode: "llm",
      stallTimeoutMs: 50,
    });
    const orchWakeups: SwarmEngineEvent[] = [];
    const stallEvents: SwarmEngineEvent[] = [];
    engine.subscribe((ev) => {
      if (ev.type === "wakeup_needed") orchWakeups.push(ev);
      if (ev.type === "stall_detected") stallEvents.push(ev);
    });

    try {
      let releaseWorker!: () => void;
      const workerGate = new Promise<void>((r) => {
        releaseWorker = r;
      });
      transport.onMember("stuck", async ({ request, turnIndex }) => {
        if (turnIndex === 1) {
          return { outcome: "waiting", summary: "Forgot to ping orchestrator" };
        }
        if (turnIndex === 2) {
          // Monitor woke stuck!
          await request.engineApi!.postMessage({
            text: "@orchestrator [done] Unstuck by monitor nudge",
          });
          return { outcome: "waiting", summary: "done after nudge" };
        }
        await workerGate;
        return { outcome: "waiting", summary: "steered turn done" };
      });

      transport.onMember("monitor", async ({ request }) => {
        assert.equal(request.isMonitor, true);
        await request.engineApi!.postMessage({
          text: "@stuck [stall] Please finish and post @orchestrator [done]",
        });
        return { outcome: "stopped", summary: "nudged @stuck" };
      });

      await engine.addMembers({ name: "stuck", brief: "Complete task" });

      // Wait for LLM monitor to run, nudge @stuck, and @stuck to post @orchestrator [done]
      await waitUntil(
        () =>
          stallEvents.length >= 1 &&
          orchWakeups.some((e) => e.summary.includes("stuck") || e.messages?.some((m) => m.text.includes("[done]"))),
        3000,
      );

      assert.equal(stallEvents.length, 1);
      assert.equal(stallEvents[0]!.memberName, "stuck");
      // The [stall] itself was NOT addressed to @orchestrator; only @stuck's [done] woke orchestrator
      assert.ok(store.events.some((e) => e.type === "stall_detected"));

      // Test steerMember on waiting member -> wakes via board post (delivery="woken")
      const waitTurnPromise = engine.steerMember("stuck", "Now do extra pass", "steer");
      const steerWaitRes = await waitTurnPromise;
      assert.equal(steerWaitRes.delivery, "woken");
      await waitUntil(() => engine.getSnapshot().workingMemberNames.includes("stuck"));
      await waitUntil(() => (transport.handles.get("stuck")!.steers.length === 0));

      // Test steerMember while working -> delivers live handle.steer (delivery="steered")
      const workingSteer = await engine.steerMember("stuck", "Redirect to v2", "steer");
      assert.equal(workingSteer.delivery, "steered");
      assert.deepEqual(transport.handles.get("stuck")!.steers, ["Redirect to v2"]);
      releaseWorker();
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);
    } finally {
      await engine.dispose();
    }

    // 2. Smart Monitor [noop] stays quiet, and error falls back deterministically
    const { engine: eng2, transport: tr2, store: store2 } = await createTestHarness({
      stallWatchdogEnabled: true,
      stallMonitorMode: "llm",
      stallTimeoutMs: 50,
    });
    try {
      let monitorCall = 0;
      tr2.onMember("monitor", async () => {
        monitorCall += 1;
        if (monitorCall === 1) {
          return { outcome: "stopped", summary: "[noop]" };
        }
        throw new Error("Monitor LLM unavailable");
      });
      await eng2.addMembers({ name: "quiet2", brief: "Finish" });
      await waitUntil(() => monitorCall >= 1, 1500);
      await delay(80);
      assert.equal(
        (await store2.readBoard("run-dyn")).messages.filter((m) => m.kind === "stall").length,
        0,
        "[noop] from LLM monitor must suppress stall post",
      );

      // Advance boardHead to re-arm watchdog; second monitor call throws -> deterministic fallback posts @orchestrator [stall]!
      await eng2.postMessage({ from: "quiet2", fromRole: "worker", text: "status ping without mention" });
      await delay(20);
      await waitUntil(
        () => store2.events.some((e) => e.type === "stall_detected"),
        2000,
      );
      const boardMsgs = (await store2.readBoard("run-dyn", { limit: 20 })).messages;
      const fallbackStall = boardMsgs.find((m) => m.kind === "stall");
      assert.ok(fallbackStall && fallbackStall.text.includes("@orchestrator [stall]"));
    } finally {
      await eng2.dispose();
    }
  });

  it("persists member sessions to disk (SessionManager.create/open) across transport restarts and normalizes stale working state", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-session-persist-"));
    const sessionDir = path.join(tmpRoot, "sessions");
    try {
      let capturedSessionFile: string | undefined;
      const transport = new InProcessPiTransport({
        agentDir: tmpRoot,
        createSession: async (opts) => {
          const fakeSession = {
            model: opts?.model,
            sessionManager: opts?.sessionManager,
            extensionRunner: { hasHandlers: () => false, emit: async () => {} },
            bindExtensions: async () => {},
            subscribe: () => () => {},
            prompt: async (text: string) => {
              opts?.sessionManager?.appendMessage({
                role: "user",
                content: text,
                timestamp: Date.now(),
              });
              opts?.sessionManager?.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: `ack: ${text.slice(0, 30)}` }],
                api: "anthropic-messages",
                provider: "anthropic",
                model: "mock",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              });
            },
            steer: async () => {},
            followUp: async () => {},
            setModel: async () => {},
            setThinkingLevel: () => {},
            abort: async () => {},
            getSessionStats: () => ({
              tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
              cost: 0,
            }),
            dispose: () => {},
          } as unknown as AgentSession;
          return {
            session: fakeSession,
            extensionsResult: {} as never,
          };
        },
      });

      const handle1 = await transport.spawnMember({
        agentId: "persisted-1",
        name: "persisted",
        role: "worker",
        runId: "run-p",
        cwd: tmpRoot,
        workspace: "inherit",
        parentName: "orchestrator",
        brief: "First turn",
        systemPrompt: "Sys",
        initialPrompt: "First persisted prompt",
        keepWarm: true,
        sessionDir,
      });

      const res1 = await handle1.currentTurn;
      assert.equal(res1.outcome, "waiting");
      capturedSessionFile = handle1.getSessionFile?.();
      assert.ok(capturedSessionFile, "SessionManager.create must produce a disk sessionFile");
      await handle1.kill("Simulated Pi process exit");

      // Reopen in a fresh handle using sessionFile (simulating Pi process restart!)
      const handle2 = await transport.spawnMember({
        agentId: "persisted-1",
        name: "persisted",
        role: "worker",
        runId: "run-p",
        cwd: tmpRoot,
        workspace: "inherit",
        parentName: "orchestrator",
        brief: "First turn",
        systemPrompt: "Sys",
        initialPrompt: "Resumed after restart",
        keepWarm: true,
        sessionDir,
        sessionFile: capturedSessionFile,
      });
      await handle2.currentTurn;
      const restored = handle2.getConversationMessages();
      assert.ok(
        restored.some(
          (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("First persisted prompt"),
        ),
        "Reopened SessionManager must retain messages from before process exit",
      );
      assert.ok(
        restored.some(
          (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Resumed after restart"),
        ),
      );
      await handle2.kill("cleanup");

      // Also verify attachRun normalizes stale persisted 'working' members after process restart!
      const { store, engine } = await createTestHarness();
      await engine.attachRun(null);
      await store.addMember("run-dyn", {
        name: "crashed",
        agentId: "crashed-1",
        role: "worker",
        parentName: "orchestrator",
        brief: "Was working before crash",
        workspace: "inherit",
        cwd: tmpRoot,
        state: "working",
        sessionFile: capturedSessionFile,
      });
      const attached = await engine.attachRun("run-dyn");
      assert.equal(attached.run?.members.crashed?.state, "stopped");
      await engine.dispose();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ============================================================================
// 14. v0.3.1 Optimizations (Full read_board, baseBranch guard, maxRetries, Rollback, Monitor)
// ============================================================================

describe("SwarmEngine — v0.3.1 Hardening & Optimizations", () => {
  it("preserves full multiline content in read_board{seqs:[...]} and formatBoardEntryFull", async () => {
    const { engine } = await createTestHarness({ stallWatchdogEnabled: false });
    try {
      const longBody = [
        "## Root Cause Analysis",
        "Line 1",
        "```ts",
        "export function check(): boolean {",
        "  return true;",
        "}",
        "```",
        "Padding: " + "x".repeat(900),
        "END_MARKER_VISIBLE",
      ].join("\n");

      const msg = await engine.postMessage({
        from: "researcher",
        fromRole: "worker",
        text: `@orchestrator ${longBody}`,
        kind: "done",
      });

      const formattedFull = formatBoardEntryFull(msg);
      assert.ok(formattedFull.includes("## Root Cause Analysis\nLine 1\n"));
      assert.ok(
        formattedFull.includes("```ts\nexport function check(): boolean {\n  return true;\n}\n```"),
      );
      assert.ok(formattedFull.includes("END_MARKER_VISIBLE"));

      const tools = createSwarmTools({ engine });
      const readBoardTool = tools.find((t) => t.name === READ_BOARD_TOOL)!;

      // read_board with explicit seqs returns FULL untruncated multiline content (> 600 chars)
      const seqResult = await readBoardTool.execute(
        "tc-seq",
        { seqs: [msg.seq] },
        undefined,
        undefined,
        {} as ExtensionToolContext,
      );
      const seqText = String((seqResult.content[0] as { text: string }).text);
      assert.ok(seqText.includes("```ts\nexport function check()"));
      assert.ok(seqText.includes("END_MARKER_VISIBLE"), "read_board{seqs:[...]} must not truncate at 600 chars");

      // Also verify member-scoped read_board{seqs:[...]}
      const memberTools = createMemberScopedTools(
        {
          postMessage: (input) =>
            engine.postMessage({ ...input, from: "w1", fromRole: "worker" }),
          readBoard: (opts) => engine.readBoard(opts),
          getStatus: async () => ({
            runId: "run-dyn",
            title: "Test",
            status: "active",
            baseBranch: "main",
            boardHead: msg.seq,
            members: [],
            channels: [],
          }),
          listModels: (opts) => engine.listModels(opts),
          addHelper: async () => [],
          killHelper: async () => {},
          switchModel: async () => ({ targetName: "w1", model: "openai/gpt-5.4" }),
          manageChannel: async () => ({ action: "list", summary: "" }),
        },
        { name: "w1", role: "worker", runId: "run-dyn" },
      );
      const memberRead = memberTools.find((t) => t.name === READ_BOARD_TOOL)!;
      const memberRes = await memberRead.execute(
        "tc-mseq",
        { seqs: [msg.seq] },
        undefined,
        undefined,
        {} as ExtensionToolContext,
      );
      const memberText = String((memberRes.content[0] as { text: string }).text);
      assert.ok(memberText.includes("END_MARKER_VISIBLE"));
    } finally {
      await engine.dispose();
    }
  });

  it("propagates run.baseBranch to SpawnMemberRequest and blocks checkout/switch <baseBranch> in worker guard", async () => {
    const seenRequests: SpawnMemberRequest[] = [];
    const { engine, transport } = await createTestHarness({ stallWatchdogEnabled: false });
    const origSpawn = transport.spawnMember.bind(transport);
    transport.spawnMember = async (req: SpawnMemberRequest) => {
      seenRequests.push(req);
      return origSpawn(req);
    };

    try {
      await engine.addMembers({
        name: "author",
        workspace: "share",
        brief: "Edit inside isolated worktree",
      });
      await waitUntil(() => engine.getSnapshot().run?.members.author?.state === "waiting");

      assert.equal(seenRequests.length, 1);
      assert.equal(seenRequests[0]!.baseBranch, "main");

      // Exercise createWorkerGuardExtensionFactory directly with baseBranch="main"
      let toolCallHandler: ((event: any) => any) | undefined;
      const fakePi = {
        on(ev: string, handler: (event: any) => any) {
          if (ev === "tool_call") toolCallHandler = handler;
        },
      };
      createWorkerGuardExtensionFactory(seenRequests[0]!, seenRequests[0]!.baseBranch)(fakePi as any);
      assert.ok(toolCallHandler);

      const blocked = toolCallHandler!({
        toolName: "bash",
        input: { command: "git checkout main" },
      });
      assert.equal(blocked?.block, true);
      assert.match(String(blocked?.reason ?? ""), /main/);

      const allowed = toolCallHandler!({
        toolName: "bash",
        input: { command: "git status --short" },
      });
      assert.equal(allowed, undefined);
    } finally {
      await engine.dispose();
    }
  });

  it("automatically retries rate_limited turns up to settings.maxRetries and alerts @orchestrator when exhausted", async () => {
    // Case A: 2 transient 429s then success on attempt #3 (with maxRetries = 2)
    {
      let calls = 0;
      const { engine, transport } = await createTestHarness({
        fallbackModels: [],
        maxRetries: 2,
        rateLimitBaseBackoffMs: 25,
        rateLimitMaxBackoffMs: 50,
        stallWatchdogEnabled: false,
      });
      try {
        transport.onMember("retrier", async () => {
          calls += 1;
          if (calls <= 2) {
            return {
              outcome: "rate_limited",
              error: `HTTP 429 attempt ${calls}`,
              retryAfterMs: 25,
            };
          }
          return {
            outcome: "waiting",
            summary: "Recovered on retry #2",
          };
        });

        await engine.addMembers({ name: "retrier", brief: "Survive transient 429s" });
        await waitUntil(() => calls === 3 && engine.getSnapshot().run?.members.retrier?.state === "waiting", 3000);
        assert.equal(calls, 3);
        assert.equal(engine.getSnapshot().run?.members.retrier?.error, undefined);
        // No @orchestrator [rate-limit] alert emitted because recovery succeeded within maxRetries
        assert.ok(
          !engine.getSnapshot().recentBoard.some((m) => m.text.includes("[rate-limit]")),
          "Should not escalate @orchestrator [rate-limit] while automatic retries succeed",
        );
      } finally {
        await engine.dispose();
      }
    }

    // Case B: exhausts maxRetries = 1 (1 initial + 1 retry = 2 calls), then alerts @orchestrator
    {
      let calls = 0;
      const { engine, transport } = await createTestHarness({
        fallbackModels: [],
        maxRetries: 1,
        rateLimitBaseBackoffMs: 20,
        rateLimitMaxBackoffMs: 40,
        stallWatchdogEnabled: false,
      });
      try {
        transport.onMember("exhausted", async () => {
          calls += 1;
          return {
            outcome: "rate_limited",
            error: "HTTP 429 persistent quota",
            retryAfterMs: 20,
          };
        });

        await engine.addMembers({ name: "exhausted", brief: "Exhaust retry budget" });
        await waitUntil(
          () =>
            calls === 2 &&
            engine.getSnapshot().recentBoard.some((m) => m.text.includes("[rate-limit]") && m.text.includes("exhausted")),
          3000,
        );
        assert.equal(calls, 2);
      } finally {
        await engine.dispose();
      }
    }
  });

  it("rolls back all already-provisioned worktrees cleanly if batch addMembers fails mid-way", async () => {
    const { engine, worktree } = await createTestHarness({ stallWatchdogEnabled: false });
    try {
      worktree.failCreateWorktreeFor = "shard-2";

      await assert.rejects(
        () =>
          engine.addMembers({
            name: "shard",
            n: 3,
            workspace: "share",
            brief: "Parallel isolated shards",
          }),
        /Simulated worktree failure/,
      );

      // shard-1 was created before shard-2 failed -> must be rolled back!
      assert.equal(worktree.createdWorktrees.length, 1);
      assert.equal(worktree.removedWorktrees.length, 1);
      assert.equal(
        worktree.removedWorktrees[0]!.worktreePath,
        worktree.createdWorktrees[0]!.worktreePath,
      );
      assert.equal(worktree.removedWorktrees[0]!.force, true);

      // Store and board remain completely unpolluted
      const snap = engine.getSnapshot();
      assert.equal(snap.run?.memberOrder.length, 0);
      assert.equal(snap.boardHead, 0);
    } finally {
      await engine.dispose();
    }
  });

  it("accumulates @monitor tokens/cost into snapshot AND cancels in-flight @monitor on pause()", async () => {
    let monitorRelease!: () => void;
    let monitorKilled = false;
    let monitorMode: "fast" | "hang" = "fast";

    const { engine, transport } = await createTestHarness({
      stallWatchdogEnabled: true,
      stallMonitorMode: "llm",
      stallTimeoutMs: 20,
    });

    const origSpawn = transport.spawnMember.bind(transport);
    transport.spawnMember = async (req: SpawnMemberRequest) => {
      if (req.isMonitor) {
        if (monitorMode === "fast") {
          return {
            agentId: req.agentId,
            name: req.name,
            role: req.role,
            getState: () => "waiting",
            getModel: () => req.modelOverride,
            getThinkingLevel: () => req.thinkingLevel,
            getConversationMessages: () => [],
            wake: async () => ({
              agentId: req.agentId,
              name: req.name,
              role: req.role,
              outcome: "waiting",
              summary: "[noop]",
              tokens: 0,
              cost: 0,
            }),
            steer: async () => {},
            followUp: async () => {},
            switchModel: async (m, t) => ({ model: m, thinkingLevel: t }),
            abort: async () => {},
            kill: async () => {},
            currentTurn: Promise.resolve({
              agentId: req.agentId,
              name: req.name,
              role: req.role,
              outcome: "waiting",
              summary: "[noop]",
              tokens: 450,
              cost: 0.0125,
            }),
          };
        }

        // Hanging monitor handle to test cancellation on pause()
        const blocked = new Promise<AgentTurnResult>((resolve) => {
          monitorRelease = () =>
            resolve({
              agentId: req.agentId,
              name: req.name,
              role: req.role,
              outcome: "killed",
              summary: "cancelled",
              tokens: 0,
              cost: 0,
            });
        });
        return {
          agentId: req.agentId,
          name: req.name,
          role: req.role,
          getState: () => (monitorKilled ? "killed" : "working"),
          getModel: () => req.modelOverride,
          getThinkingLevel: () => req.thinkingLevel,
          getConversationMessages: () => [],
          wake: async () => blocked,
          steer: async () => {},
          followUp: async () => {},
          switchModel: async (m, t) => ({ model: m, thinkingLevel: t }),
          abort: async () => {
            monitorKilled = true;
            monitorRelease?.();
          },
          kill: async () => {
            monitorKilled = true;
            monitorRelease?.();
          },
          currentTurn: blocked,
        };
      }
      return origSpawn(req);
    };

    try {
      await engine.addMembers({ name: "idle-worker", brief: "Park cleanly" });
      await waitUntil(() => engine.getSnapshot().run?.members["idle-worker"]?.state === "waiting");

      // Wait for fast @monitor check to finish and record usage
      await waitUntil(() => engine.getSnapshot().totalTokens >= 450, 2000);
      const snapAfterFast = engine.getSnapshot();
      assert.ok(snapAfterFast.totalCost >= 0.0125);

      // Now trigger a second stall check that hangs, and cancel it via engine.pause()
      monitorMode = "hang";
      await engine.postMessage({
        from: "orchestrator",
        fromRole: "orchestrator",
        text: "Note without mention to advance board head and re-arm watchdog",
        kind: "update",
      });
      await waitUntil(() => Boolean(monitorRelease), 2000);

      await engine.pause("run-dyn", "User paused during monitor");
      assert.equal(monitorKilled, true, "pause() must abort & kill active @monitor handle immediately");
    } finally {
      await engine.dispose();
    }
  });
});

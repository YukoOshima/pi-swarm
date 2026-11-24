import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  findSafetySensitiveMemberSegment,
  ORCHESTRATOR_NAME,
  POST_MESSAGE_TOOL,
  READ_BOARD_TOOL,
  SWARM_CORE_TOOLS,
  SWARM_MAX_BOARD_HOPS,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../src/constants.js";
import {
  buildMemberInitialPrompt,
  buildMemberSystemPrompt,
  buildOrchestratorLiveStateSection,
  buildOrchestratorPlaybookSection,
  buildOrchestratorStaticSection,
  ConcurrencyGate,
  createMemberScopedTools,
  createSwarmTools,
  createValidatorGuardExtensionFactory,
  createWorkerGuardExtensionFactory,
  extractSessionMessages,
  formatBoardEntryFull,
  getRunValidatorScratchRoot,
  getValidatorScratchDir,
  InProcessPiTransport,
  isForbiddenWorkerBashCommand,
  isProtectedSwarmPath,
  isRateLimitOrTransientError,
  isReadOnlyValidationCommand,
  parseRetryAfterMs,
  RateLimitBreaker,
  resolveRoleModel,
  resolveValidatorScratchPath,
  resolveWorktreeRelativePath,
  sanitizeForkSeedMessages,
  selectFallbackModel,
  SwarmEngine,
} from "../src/runtime/index.js";
import { SwarmStore } from "../src/store/index.js";
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
  type WaitForBoardResult,
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
  readonly postedBoardInputs: PostBoardMessageInput[] = [];
  private seqCounter = 0;
  assertOwnerSession?: ISwarmStore["assertOwnerSession"];

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
      ...(input.milestones ? { milestones: cloneState(input.milestones) } : {}),
      ...(input.assertions ? { assertions: cloneState(input.assertions) } : {}),
      ...(input.features ? { features: cloneState(input.features) } : {}),
      ...(input.handoffItems ? { handoffItems: cloneState(input.handoffItems) } : {}),
      ...(input.commands ? { commands: cloneState(input.commands) } : {}),
      ...(input.services ? { services: cloneState(input.services) } : {}),
      ...(input.boundaries ? { boundaries: cloneState(input.boundaries) } : {}),
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
    if (patch.phase !== undefined) {
      if (patch.phase === null) {
        delete run.phase;
      } else {
        run.phase = patch.phase;
      }
    }
    if (patch.milestones !== undefined) {
      if (patch.milestones === null) {
        delete run.milestones;
      } else {
        run.milestones = cloneState(patch.milestones);
      }
    }
    if (patch.assertions !== undefined) {
      if (patch.assertions === null) {
        delete run.assertions;
      } else {
        run.assertions = cloneState(patch.assertions);
      }
    }
    if (patch.features !== undefined) {
      if (patch.features === null) {
        delete run.features;
      } else {
        run.features = cloneState(patch.features);
      }
    }
    if (patch.handoffItems !== undefined) {
      if (patch.handoffItems === null) {
        delete run.handoffItems;
      } else {
        run.handoffItems = cloneState(patch.handoffItems);
      }
    }
    if (patch.commands !== undefined) {
      if (patch.commands === null) {
        delete run.commands;
      } else {
        run.commands = cloneState(patch.commands);
      }
    }
    if (patch.services !== undefined) {
      if (patch.services === null) {
        delete run.services;
      } else {
        run.services = cloneState(patch.services);
      }
    }
    if (patch.boundaries !== undefined) {
      if (patch.boundaries === null) {
        delete run.boundaries;
      } else {
        run.boundaries = cloneState(patch.boundaries);
      }
    }
    if (patch.lastAudit !== undefined) {
      if (patch.lastAudit === null) {
        delete run.lastAudit;
      } else {
        run.lastAudit = cloneState(patch.lastAudit);
      }
    }
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
      sessionFile: member.sessionFile,
      forkedFrom: member.forkedFrom,
      channels,
      model: member.model,
      thinkingLevel: member.thinkingLevel,
      ...(member.modelExplicit !== undefined ? { modelExplicit: member.modelExplicit } : {}),
      lastReadSeq: member.lastReadSeq ?? 0,
      turns: 0,
      ...(member.llmTurns !== undefined ? { llmTurns: member.llmTurns } : {}),
      ...(member.turnStartedAt !== undefined ? { turnStartedAt: member.turnStartedAt } : {}),
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
    if (patch.sessionFile !== undefined) {
      m.sessionFile = patch.sessionFile === null ? undefined : patch.sessionFile;
    }
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
    if (patch.llmTurns !== undefined) m.llmTurns = patch.llmTurns;
    if (patch.turnStartedAt !== undefined) {
      if (patch.turnStartedAt === null) {
        delete m.turnStartedAt;
      } else {
        m.turnStartedAt = patch.turnStartedAt;
      }
    }
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
    this.postedBoardInputs.push(input);
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
      ...(input.featureId ? { featureId: input.featureId } : {}),
      ...(input.discoveredIssues && input.discoveredIssues.length > 0
        ? { discoveredIssues: [...input.discoveredIssues] }
        : {}),
      ...(input.leftUndone && input.leftUndone.length > 0
        ? { leftUndone: [...input.leftUndone] }
        : {}),
      ...(input.verificationEvidence
        ? { verificationEvidence: input.verificationEvidence }
        : {}),
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
  readonly createdWorktrees: Array<{
    branch: string;
    baseBranch: string;
    worktreePath: string;
    reuseExistingBranch?: boolean;
    mode?: "share" | "branch";
  }> = [];
  readonly removedWorktrees: Array<{ worktreePath: string; force?: boolean }> = [];
  readonly deletedBranches: string[] = [];
  readonly mergedBranches: Array<{
    baseBranch: string;
    branch: string;
    sourceWorktreePath?: string;
  }> = [];
  readonly fetchedClones: Array<{ sourceWorktreePath: string; branch: string }> = [];
  readonly dirtyPaths = new Set<string>();
  readonly commitsAheadByBranch = new Map<string, number>();
  defaultCommitsAhead = 1;
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
    reuseExistingBranch?: boolean;
    mode?: "share" | "branch";
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

  async deleteBranch(branch: string): Promise<boolean> {
    this.deletedBranches.push(branch);
    return true;
  }

  async getHeadSha(): Promise<string> {
    return this.nextMergeSha;
  }

  async getCommitCountAhead(_baseRef?: string, targetRef?: string): Promise<number> {
    if (targetRef && this.commitsAheadByBranch.has(targetRef)) {
      return this.commitsAheadByBranch.get(targetRef)!;
    }
    return this.defaultCommitsAhead;
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

  async fetchBranchFromClone(sourceWorktreePath: string, branch: string): Promise<boolean> {
    this.fetchedClones.push({ sourceWorktreePath, branch });
    return true;
  }

  async mergeBranch(options: {
    baseBranch: string;
    branch: string;
    sourceWorktreePath?: string;
  }): Promise<MergeBranchResult> {
    this.mergedBranches.push({
      baseBranch: options.baseBranch,
      branch: options.branch,
      sourceWorktreePath: options.sourceWorktreePath,
    });
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

    let resolveAbortRace: ((res: AgentTurnResult) => void) | undefined;
    const runTurn = async (prompt: string): Promise<AgentTurnResult> => {
      turnIndex += 1;
      messages.push(makeUserMessage(prompt));
      const handler = this.resolveHandler(request.name);
      const abortRace = new Promise<AgentTurnResult>((resolve) => {
        resolveAbortRace = resolve;
      });
      const turnExecution = (async (): Promise<AgentTurnResult> => {
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
          tokenBreakdown: partial.tokenBreakdown,
          cost: partial.cost ?? turnIndex * 0.002,
          error: partial.error,
          stopReason: partial.stopReason,
          retryAfterMs: partial.retryAfterMs,
        };
      })();

      return Promise.race([turnExecution, abortRace]);
    };

    let currentTurnPromise = runTurn(request.initialPrompt);

    const handle: PersistentAgentHandle = {
      agentId: request.agentId,
      name: request.name,
      role: request.role,
      getState: () => state,
      getModel: () => model,
      getThinkingLevel: () => thinkingLevel,
      getSessionFile: () => request.sessionFile,
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
          resolveAbortRace?.({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "stopped",
            summary: "aborted",
            model,
            thinkingLevel,
            tokens: 0,
            cost: 0,
          });
        }
      },
      kill: async () => {
        record.killed = true;
        state = "killed";
        resolveAbortRace?.({
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          outcome: "killed",
          summary: "killed",
          model,
          thinkingLevel,
          tokens: 0,
          cost: 0,
        });
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
      await waitUntil(
        () =>
          transport.spawns.length > spawnsBefore &&
          engine.getSnapshot().run?.members.sibling?.state === "waiting",
      );
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
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(monitorKilled, true, "pause() must abort & kill active @monitor handle immediately");
      assert.equal(
        engine.getSnapshot().recentBoard.some((m) => m.kind === "stall"),
        false,
        "Cancelling @monitor on pause() must NOT fall back to deterministic [stall] alert",
      );
    } finally {
      await engine.dispose();
    }
  });

  it("v0.3.2: preserves workspace:'branch' clone branch via fetchBranchFromClone on kill, rolls back on store.addMember failure, and blocks steerMember when paused", async () => {
    // A. killMember preserves unmerged branch clone before removing worktree directory
    {
      const { engine, worktree } = await createTestHarness({ stallWatchdogEnabled: false });
      try {
        await engine.addMembers({
          name: "isolated",
          workspace: "branch",
          brief: "Commit work in isolated branch clone",
        });
        await waitUntil(() => engine.getSnapshot().run?.members.isolated?.state === "waiting");

        const memberBeforeKill = engine.getSnapshot().run!.members.isolated!;
        await engine.killMember("isolated", { reason: "Done committing; keep branch for later merge" });

        assert.equal(worktree.fetchedClones.length, 1);
        assert.equal(worktree.fetchedClones[0]!.sourceWorktreePath, memberBeforeKill.cwd);
        assert.equal(worktree.fetchedClones[0]!.branch, memberBeforeKill.branch);
        assert.equal(worktree.removedWorktrees.length, 1);
      } finally {
        await engine.dispose();
      }
    }

    // B. store.addMember throwing on shard-2 rolls back shard-2 & shard-3 worktrees without deleting registered shard-1
    {
      const { engine, store, worktree } = await createTestHarness({ stallWatchdogEnabled: false });
      const origAddMember = store.addMember.bind(store);
      store.addMember = async (runId, input) => {
        if (input.name === "pack-2") {
          throw new SwarmProtocolError("INVALID_INPUT", "Simulated store write failure on pack-2");
        }
        return origAddMember(runId, input);
      };
      try {
        await assert.rejects(
          () =>
            engine.addMembers({
              name: "pack",
              n: 3,
              workspace: "share",
              brief: "Test mid-registration rollback",
            }),
          /Simulated store write failure on pack-2/,
        );

        assert.equal(worktree.createdWorktrees.length, 3);
        const removedPaths = worktree.removedWorktrees.map((r) => r.worktreePath);
        assert.equal(removedPaths.length, 2);
        assert.ok(removedPaths.some((p) => p.endsWith("pack-2")));
        assert.ok(removedPaths.some((p) => p.endsWith("pack-3")));
        assert.ok(!removedPaths.some((p) => p.endsWith("pack-1")));
      } finally {
        await engine.dispose();
      }
    }

    // C. steerMember rejects when run is paused
    {
      const { engine } = await createTestHarness({ stallWatchdogEnabled: false });
      try {
        await engine.addMembers({ name: "paused-w", brief: "Wait" });
        await waitUntil(() => engine.getSnapshot().run?.members["paused-w"]?.state === "waiting");
        await engine.pause("run-dyn", "Pause run");
        await assert.rejects(
          () => engine.steerMember("paused-w", "Should fail while paused"),
          (err) => err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
        );
      } finally {
        await engine.dispose();
      }
    }
  });

  it("v0.3.3: honors autoTeardownOnComplete, allows switchModel on stopped members (preserving humanStopped), and logs orchestrator switch", async () => {
    // A. completeRun honors settings.autoTeardownOnComplete when options.teardown is omitted
    {
      const { engine, worktree, store } = await createTestHarness({
        stallWatchdogEnabled: false,
        autoTeardownOnComplete: true,
      });
      try {
        await engine.addMembers({
          name: "sharer",
          workspace: "share",
          brief: "Create worktree then park",
        });
        await waitUntil(() => engine.getSnapshot().run?.members.sharer?.state === "waiting");
        assert.equal(worktree.createdWorktrees.length, 1);

        await engine.mergeMember("sharer");
        await engine.completeRun({ summary: "Shipped with autoTeardownOnComplete" });
        const tdEvent = store.events.find((e) => e.type === "teardown_completed");
        assert.ok(tdEvent, "completeRun must trigger teardown when autoTeardownOnComplete=true");
        assert.deepEqual((tdEvent.data as any)?.removed, ["sharer"]);
      } finally {
        await engine.dispose();
      }
    }

    // B. switchModel on stopped members: works cleanly, respects humanStopped sovereignty, and auto-revives non-human-stopped
    {
      const { engine, transport, store } = await createTestHarness({
        stallWatchdogEnabled: false,
        workerModel: "openai/gpt-5.4",
      });
      try {
        // Human-stopped member -> switchModel updates model + logs event WITHOUT auto-reviving
        await engine.addMembers({ name: "h-stopped", brief: "Work then human stop" });
        await waitUntil(() => engine.getSnapshot().run?.members["h-stopped"]?.state === "waiting");
        await engine.stopMember("h-stopped", { humanStopped: true, callerRole: "human" });
        assert.equal(engine.getSnapshot().run?.members["h-stopped"]?.state, "stopped");

        const swHuman = await engine.switchModel({
          targetName: "h-stopped",
          model: "anthropic/claude-opus-4-6",
          thinkingLevel: "high",
          reason: "Upgrade stopped member",
        });
        assert.equal(swHuman.model, "anthropic/claude-opus-4-6");
        assert.equal(swHuman.resumed, undefined);
        assert.equal(
          engine.getSnapshot().run?.members["h-stopped"]?.state,
          "stopped",
          "humanStopped member must remain stopped after model switch",
        );

        // Non-human-stopped member -> switchModel updates model AND revives cleanly on new model
        await engine.addMembers({ name: "n-stopped", brief: "Work then orchestrator stop" });
        await waitUntil(() => engine.getSnapshot().run?.members["n-stopped"]?.state === "waiting");
        await engine.stopMember("n-stopped", { humanStopped: false, callerRole: "orchestrator" });
        const spawnsBefore = transport.spawns.filter((r) => r.name === "n-stopped").length;

        const swAuto = await engine.switchModel({
          targetName: "n-stopped",
          model: "google/gemini-2.5-pro",
        });
        assert.equal(swAuto.model, "google/gemini-2.5-pro");
        assert.equal(swAuto.resumed, true);
        await waitUntil(
          () =>
            transport.spawns.filter((r) => r.name === "n-stopped").length === spawnsBefore + 1 &&
            engine.getSnapshot().run?.members["n-stopped"]?.state === "waiting",
        );
        const revivedReq = transport.spawns
          .filter((r) => r.name === "n-stopped")
          .pop()!;
        assert.equal(revivedReq.modelOverride, "google/gemini-2.5-pro");

        // C. Orchestrator model switch logs event & [model] board notice
        await engine.switchModel({
          targetName: "orchestrator",
          model: "anthropic/claude-opus-4-6",
          thinkingLevel: "high",
          reason: "Audit synthesis",
        });
        assert.ok(
          store.events.some(
            (e) => e.type === "member_model_switched" && e.memberName === ORCHESTRATOR_NAME,
          ),
        );
        const board = await store.readBoard("run-dyn", { limit: 20 });
        assert.ok(
          board.messages.some(
            (m) => m.kind === "model_switch" && m.text.includes("orchestrator switched to anthropic/claude-opus-4-6"),
          ),
        );
      } finally {
        await engine.dispose();
      }
    }
  });

  it("v0.3.4: enforces owner session on engine.teardown and accumulates tokens/cost across stopped->revived handles", async () => {
    // A. Cross-session teardown ownership protection
    {
      const { engine } = await createTestHarness({ stallWatchdogEnabled: false });
      try {
        const ownerSess = engine.getSnapshot().run!.ownerSessionId;
        await assert.rejects(
          () => engine.teardown({ sessionId: "foreign-session-999" }),
          (err) => err instanceof SwarmProtocolError && err.code === "OWNERSHIP_CONFLICT",
        );
        const okRes = await engine.teardown({ sessionId: ownerSess });
        assert.equal(okRes.errors.length, 0);
      } finally {
        await engine.dispose();
      }
    }

    // B. Exact cross-handle token & cost accumulation across handle #1 (stop) -> handle #2 (revive)
    {
      const { engine, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        keepWorkersWarm: false,
      });
      let spawnCount = 0;
      transport.onMember("ledger", async () => {
        spawnCount += 1;
        if (spawnCount === 1) {
          return {
            outcome: "stopped",
            summary: "Handle 1 finished initial phase",
            tokens: 900,
            cost: 0.009,
          };
        }
        return {
          outcome: "stopped",
          summary: "Handle 2 finished follow-up phase",
          tokens: 300,
          cost: 0.003,
        };
      });

      try {
        await engine.addMembers({ name: "ledger", brief: "Initial pass" });
        await waitUntil(() => engine.getSnapshot().run?.members.ledger?.state === "stopped");
        assert.equal(engine.getSnapshot().run?.members.ledger?.tokens, 900);
        assert.equal(engine.getSnapshot().totalTokens, 900);

        await engine.postMessage({
          from: "orchestrator",
          fromRole: "orchestrator",
          text: "@ledger Follow-up pass on fresh revived handle",
        });
        await waitUntil(
          () => spawnCount === 2 && engine.getSnapshot().run?.members.ledger?.state === "stopped",
        );

        const snapAfterRevive = engine.getSnapshot();
        assert.equal(
          snapAfterRevive.run?.members.ledger?.tokens,
          1200,
          "Revived handle usage must add cleanly onto prior handle total (900 + 300 = 1200)",
        );
        assert.ok(Math.abs((snapAfterRevive.run?.members.ledger?.cost ?? 0) - 0.012) < 1e-6);
        assert.equal(snapAfterRevive.totalTokens, 1200);
      } finally {
        await engine.dispose();
      }
    }
  });

  it("v0.3.5: delegates teardown ownership check to store.assertOwnerSession when provided", async () => {
    const { engine, store, worktree } = await createTestHarness({ stallWatchdogEnabled: false });
    try {
      const calls: Array<{ runId: string; sessionId: string }> = [];
      let shouldReject = false;

      store.assertOwnerSession = async (runIdOrState, currentSessionId) => {
        const runId = typeof runIdOrState === "string" ? runIdOrState : runIdOrState.id;
        calls.push({ runId, sessionId: currentSessionId });
        if (shouldReject) {
          throw new SwarmProtocolError("OWNERSHIP_CONFLICT", "Denied by custom store.assertOwnerSession");
        }
      };

      // Omitted or whitespace-only sessionId skips ownership check
      await engine.teardown();
      await engine.teardown({ sessionId: "   " });
      assert.equal(calls.length, 0);

      // Allows teardown when store.assertOwnerSession resolves (even for a non-owner sessionId)
      const okRes = await engine.teardown({ sessionId: "  delegated-sess  " });
      assert.equal(okRes.errors.length, 0);
      assert.deepEqual(calls, [{ runId: "run-dyn", sessionId: "delegated-sess" }]);

      // Rejects teardown when store.assertOwnerSession throws, without invoking safeTeardown
      shouldReject = true;
      let safeTeardownCalls = 0;
      const origSafeTeardown = worktree.safeTeardown.bind(worktree);
      worktree.safeTeardown = async (targets) => {
        safeTeardownCalls += 1;
        return origSafeTeardown(targets);
      };
      const eventsBefore = store.events.filter((e) => e.type === "teardown_completed").length;
      await assert.rejects(
        () => engine.teardown({ sessionId: "rejected-sess" }),
        (err) => err instanceof SwarmProtocolError && err.code === "OWNERSHIP_CONFLICT",
      );
      assert.deepEqual(calls, [
        { runId: "run-dyn", sessionId: "delegated-sess" },
        { runId: "run-dyn", sessionId: "rejected-sess" },
      ]);
      assert.equal(safeTeardownCalls, 0);
      assert.equal(
        store.events.filter((e) => e.type === "teardown_completed").length,
        eventsBefore,
      );
    } finally {
      await engine.dispose();
    }
  });

  it("v0.3.5: attachRun(null) disposes handles, pause() normalizes queued members, and handleTurnFinished cannot clobber stopMember", async () => {
    // A. attachRun(null) disposes live handles and frees concurrency slots
    {
      const { engine, transport } = await createTestHarness({ maxConcurrency: 1 });
      let releaseWorker!: () => void;
      const gate = new Promise<void>((r) => {
        releaseWorker = r;
      });
      transport.onMember("holder", async () => {
        await gate;
        return { outcome: "waiting", summary: "done" };
      });
      try {
        await engine.addMembers({ name: "holder", brief: "Hold slot" });
        await waitUntil(() => transport.handles.get("holder") !== undefined);
        await engine.attachRun(null);
        assert.equal(transport.handles.get("holder")?.killed, true, "attachRun(null) must kill live handles");
        assert.equal(engine.getSnapshot().activeRunId, null);
      } finally {
        releaseWorker();
        await engine.dispose();
      }
    }

    // B. pause() cleans queued/spawning members to stopped & attachRun normalizes paused stale working members
    {
      const { engine, store, transport } = await createTestHarness({ maxConcurrency: 1 });
      let releaseFirst!: () => void;
      const gate = new Promise<void>((r) => {
        releaseFirst = r;
      });
      transport.onMember("busy", async () => {
        await gate;
        return { outcome: "waiting", summary: "finished" };
      });
      try {
        await engine.addMembers({ name: "busy", brief: "Occupy slot 1" });
        await engine.addMembers({ name: "queued", brief: "Wait in concurrency queue" });
        await waitUntil(() => transport.handles.get("busy") !== undefined);
        const paused = await engine.pause(undefined, "User paused");
        assert.equal(paused.status, "paused");
        assert.equal(
          paused.members.queued?.state,
          "stopped",
          "Queued member without running handle must transition to stopped on pause()",
        );

        // Simulate stale working member on a paused run across fresh engine attachRun
        await store.updateMember(paused.id, "queued", { state: "working" });
        const freshEngine = new SwarmEngine({
          store,
          worktree: new MockWorktreeManager(),
          transport: new ScriptedTransport(),
          settings: { stallWatchdogEnabled: false },
        });
        try {
          const reattached = await freshEngine.attachRun(paused.id);
          assert.equal(
            reattached.run?.members.queued?.state,
            "stopped",
            "attachRun must normalize stale working members for paused runs too",
          );
        } finally {
          await freshEngine.dispose();
        }
      } finally {
        releaseFirst();
        await engine.dispose();
      }
    }

    // C. handleTurnFinished stale-read race vs stopMember during store.loadRun
    {
      const { engine, store, transport } = await createTestHarness();
      let resolveTurn!: () => void;
      const gate = new Promise<void>((r) => {
        resolveTurn = r;
      });
      transport.onMember("racer", async () => {
        await gate;
        return { outcome: "waiting", summary: "Turn completed right before stop" };
      });
      try {
        await engine.addMembers({ name: "racer", brief: "Race stopMember during loadRun" });
        await waitUntil(() => transport.handles.get("racer") !== undefined);

        let holdLoadResolve!: () => void;
        let loadStarted!: () => void;
        const loadStartedP = new Promise<void>((r) => {
          loadStarted = r;
        });
        const origLoadRun = store.loadRun.bind(store);
        let interceptOnce = true;
        store.loadRun = async (runId: string) => {
          const snap = await origLoadRun(runId);
          if (interceptOnce && snap.members.racer?.state === "working") {
            interceptOnce = false;
            loadStarted();
            await new Promise<void>((r) => {
              holdLoadResolve = r;
            });
          }
          return snap;
        };

        resolveTurn();
        await loadStartedP;
        // Stop member while handleTurnFinished is paused inside store.loadRun
        await engine.stopMember("racer", { humanStopped: true, reason: "User stopped" });
        holdLoadResolve();
        await delay(30);

        const after = engine.getSnapshot().run?.members.racer;
        assert.equal(after?.state, "stopped", "handleTurnFinished must not overwrite stopped back to waiting");
        assert.equal(after?.humanStopped, true);
      } finally {
        await engine.dispose();
      }
    }
  });

  it("v0.3.5: executes deferred self-switch when keepWorkersWarm=false and handles kill() during bindExtensions", async () => {
    // A. Deferred self-switch with keepWorkersWarm=false
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      const transport = new ScriptedTransport();
      const engine = new SwarmEngine({
        store,
        worktree,
        transport,
        settings: { stallWatchdogEnabled: false, keepWorkersWarm: false },
      });
      const run = await store.createRun({
        id: "run-cold-switch",
        title: "Cold self switch",
        objective: "Switch model even with keepWorkersWarm=false",
        baseBranch: "main",
        ownerSessionId: "sess-1",
        keepWorkersWarm: false,
      });
      await engine.startRun(run.id);

      let turnNum = 0;
      transport.onMember("coldworker", async () => {
        turnNum += 1;
        if (turnNum === 1) {
          await engine.switchModel({
            targetName: "coldworker",
            model: "google/gemini-2.5-pro",
            callerName: "coldworker",
            callerRole: "worker",
            reason: "Need larger context",
          });
          return { outcome: "stopped", summary: "Ending turn 1 for deferred switch" };
        }
        return { outcome: "stopped", summary: "Finished turn 2 on new model" };
      });

      try {
        await engine.addMembers({ name: "coldworker", brief: "Self-switch on cold pool" });
        await waitUntil(() => turnNum === 2 && engine.getSnapshot().run?.members.coldworker?.state === "stopped");
        assert.equal(engine.getSnapshot().run?.members.coldworker?.model, "google/gemini-2.5-pro");
        assert.equal(transport.spawns.length, 2);
        assert.equal(transport.spawns[1]?.modelOverride, "google/gemini-2.5-pro");
      } finally {
        await engine.dispose();
      }
    }

    // B. InProcessPiTransport kill() during bindExtensions does not throw TypeError
    {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-bind-kill-"));
      try {
        let triggerKill!: () => void;
        let releaseBind!: () => void;
        const bindStarted = new Promise<void>((r) => {
          triggerKill = r;
        });
        const bindGate = new Promise<void>((r) => {
          releaseBind = r;
        });

        const transport = new InProcessPiTransport({
          agentDir: tmpRoot,
          createSession: async (opts) => {
            const fakeSession = {
              model: opts?.model,
              sessionManager: opts?.sessionManager,
              extensionRunner: { hasHandlers: () => false, emit: async () => {} },
              bindExtensions: async () => {
                triggerKill();
                await bindGate;
              },
              subscribe: () => () => {},
              prompt: async () => {},
              steer: async () => {},
              followUp: async () => {},
              setModel: async () => {},
              setThinkingLevel: () => {},
              abort: async () => {},
              dispose: () => {},
              getSessionStats: () => ({
                tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: 0,
              }),
            };
            return {
              session: fakeSession as unknown as AgentSession,
              extensionsResult: {} as never,
            };
          },
        });

        const handle = await transport.spawnMember({
          agentId: "killbind-1",
          name: "killbind",
          role: "worker",
          runId: "run-bind",
          cwd: tmpRoot,
          baseBranch: "main",
          workspace: "inherit",
          parentName: "orchestrator",
          brief: "Test bind kill",
          systemPrompt: "sys",
          initialPrompt: "go",
          keepWarm: true,
        });

        await bindStarted;
        await handle.kill("Killed during bindExtensions");
        releaseBind();
        const res = await handle.currentTurn;
        assert.equal(res.outcome, "killed");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    }
  });
});

// ============================================================================
// 15. v0.3.6 Runtime, Transport, Tools & Stall Monitor Fixes
// ============================================================================

describe("SwarmEngine & Runtime — v0.3.6 Fixes", () => {
  it("1. persists member.sessionFile eagerly in InProcessPiTransport and across handleTurnFinished / revive", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v036-sess-"));
    try {
      const sessionDir = path.join(tmpRoot, "sessions");
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((r) => {
        releaseTurn = r;
      });
      const seenSessionFiles: Array<string | undefined> = [];

      const transport = new InProcessPiTransport({
        agentDir: tmpRoot,
        createSession: async (opts) => {
          seenSessionFiles.push(opts?.sessionManager?.getSessionFile?.());
          const fakeSession = {
            model: opts?.model,
            sessionManager: opts?.sessionManager,
            extensionRunner: { hasHandlers: () => false, emit: async () => {} },
            bindExtensions: async () => {},
            subscribe: () => () => {},
            prompt: async () => {
              await turnGate;
            },
            steer: async () => {},
            followUp: async () => {},
            setModel: async () => {},
            setThinkingLevel: () => {},
            abort: async () => {},
            dispose: () => {},
            getSessionStats: () => ({
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              cost: 0,
            }),
          };
          return {
            session: fakeSession as unknown as AgentSession,
            extensionsResult: {} as never,
          };
        },
      });

      const handle = await transport.spawnMember({
        agentId: "eager-1",
        name: "eager",
        role: "worker",
        runId: "run-eager",
        cwd: tmpRoot,
        baseBranch: "main",
        workspace: "inherit",
        parentName: "orchestrator",
        brief: "Check eager sessionFile",
        systemPrompt: "sys",
        initialPrompt: "go",
        keepWarm: true,
        sessionDir,
      });

      const eagerFile = handle.getSessionFile?.();
      assert.ok(eagerFile && eagerFile.startsWith(sessionDir), "spawnMember must expose sessionFile eagerly before turn finishes");
      releaseTurn();
      await handle.currentTurn;
      assert.equal(seenSessionFiles.length, 1);
      assert.equal(seenSessionFiles[0], eagerFile);
      assert.equal(handle.getSessionFile?.(), eagerFile);
      await handle.kill("done");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }

    // Engine persists sessionFile in handleTurnFinished (waiting/stopped) & reviveMemberWithPendingWakes
    const { engine, transport, store } = await createTestHarness({ stallWatchdogEnabled: false });
    const origSpawn = transport.spawnMember.bind(transport);
    let spawnIdx = 0;
    transport.spawnMember = async (req) => {
      spawnIdx += 1;
      const sf = req.sessionFile ?? `/tmp/sess-${req.name}-${spawnIdx}.jsonl`;
      const h = await origSpawn({ ...req, sessionFile: sf });
      return {
        ...h,
        getSessionFile: () => sf,
        get currentTurn() {
          return h.currentTurn;
        },
      };
    };

    try {
      await engine.addMembers({ name: "persist-w", brief: "Persist sessionFile" });
      await waitUntil(() => engine.getSnapshot().run?.members["persist-w"]?.state === "waiting");
      assert.equal(
        engine.getSnapshot().run?.members["persist-w"]?.sessionFile,
        "/tmp/sess-persist-w-1.jsonl",
      );

      // Force cold stop and revive -> sessionFile stays persisted
      await engine.stopMember("persist-w", { humanStopped: false, reason: "restart" });
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@persist-w revive and report",
      });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["persist-w"]?.turns === 2 &&
          engine.getSnapshot().run?.members["persist-w"]?.state === "waiting",
      );
      const loaded = await store.loadRun("run-dyn");
      assert.equal(loaded.members["persist-w"]?.sessionFile, "/tmp/sess-persist-w-1.jsonl");
    } finally {
      await engine.dispose();
    }
  });

  it("2. rejects terminal runs in pause/resume/completeRun, isolates non-focused pause(), disposes working handles on pause(), and revives stopped in drainMemberPendingWakes", async () => {
    const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => {
      releaseWorker = r;
    });

    try {
      // A. Non-focused run pause() does not mutate active run's liveMembers/cachedRun
      const otherRun = await store.createRun({
        id: "run-other",
        title: "Other Run",
        objective: "Background run",
        baseBranch: "main",
        ownerSessionId: "sess-2",
      });
      await store.addMember(otherRun.id, {
        name: "other-w",
        agentId: "other-w-1",
        role: "worker",
        parentName: ORCHESTRATOR_NAME,
        brief: "Work in other run",
        workspace: "inherit",
        cwd: "/repo",
        state: "working",
      });

      let activeWCalls = 0;
      transport.onMember("active-w", async () => {
        activeWCalls += 1;
        if (activeWCalls === 1) {
          await workerGate;
        }
        return { outcome: "waiting", summary: "done" };
      });
      await engine.addMembers({ name: "active-w", brief: "Keep working in focused run" });
      await waitUntil(() => transport.handles.get("active-w") !== undefined);

      const pausedOther = await engine.pause("run-other", "Pause background run");
      assert.equal(pausedOther.status, "paused");
      assert.equal(pausedOther.members["other-w"]?.state, "stopped");
      assert.equal(engine.getSnapshot().activeRunId, "run-dyn");
      assert.equal(engine.getSnapshot().run?.status, "active");
      assert.equal(transport.handles.get("active-w")?.aborted, false);

      // B. Focused pause() aborts and kills working handle so handle is never left waiting
      const pausedActive = await engine.pause(undefined, "Pause focused run");
      assert.equal(pausedActive.status, "paused");
      assert.equal(pausedActive.members["active-w"]?.state, "stopped");
      assert.equal(transport.handles.get("active-w")?.aborted, true);
      assert.equal(transport.handles.get("active-w")?.killed, true);

      // C. Resume -> cold stopped (non-humanStopped) member wakes cleanly even if drainMemberPendingWakes is entered
      await engine.resume();
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@active-w continue after pause",
      });
      await waitUntil(() => engine.getSnapshot().run?.members["active-w"]?.state === "waiting");

      // D. Terminal runs reject pause(), resume(), and completeRun()
      await engine.completeRun({ summary: "All finished" });
      await assert.rejects(
        () => engine.pause("run-dyn", "Cannot pause completed"),
        (err) => err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );
      await assert.rejects(
        () => engine.resume("run-dyn"),
        (err) => err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );
      await assert.rejects(
        () => engine.completeRun({ summary: "Double complete" }),
        (err) => err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );
    } finally {
      releaseWorker?.();
      await engine.dispose();
    }
  });

  it("3. auto-revives cold-parked 'waiting' members on switchModel after detach/reattach", async () => {
    const { engine, transport } = await createTestHarness({ stallWatchdogEnabled: false });
    try {
      await engine.addMembers({ name: "cold-waiter", brief: "Park warm then detach" });
      await waitUntil(() => engine.getSnapshot().run?.members["cold-waiter"]?.state === "waiting");
      const spawnsBeforeDetach = transport.spawns.length;

      // Detach and reattach -> orphan 'waiting' member without a live handle is normalized to 'stopped' and auto-revives on switchModel
      await engine.attachRun(null);
      const snap = await engine.attachRun("run-dyn");
      assert.equal(snap.run?.members["cold-waiter"]?.state, "stopped");

      const sw = await engine.switchModel({
        targetName: "cold-waiter",
        model: "google/gemini-2.5-pro",
        reason: "Cold waiter upgrade",
      });
      assert.equal(sw.model, "google/gemini-2.5-pro");
      assert.equal(sw.resumed, true);

      await waitUntil(
        () =>
          transport.spawns.length === spawnsBeforeDetach + 1 &&
          engine.getSnapshot().run?.members["cold-waiter"]?.state === "waiting",
      );
      const revived = transport.spawns[transport.spawns.length - 1]!;
      assert.equal(revived.name, "cold-waiter");
      assert.equal(revived.modelOverride, "google/gemini-2.5-pro");
    } finally {
      await engine.dispose();
    }
  });

  it("4. guards handleTurnFinished against pause/stop during mentions_only:false scan, internal switch, and 429 retry scheduling", async () => {
    // A. Stop during mentions_only:false board scan does not wake stopped member
    {
      const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
      transport.onMember("scanner", async ({ request }) => {
        request.onTelemetry?.({
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          runId: request.runId,
          type: "waiting",
          timestamp: new Date().toISOString(),
          logLine: "swarm_wait since=#0 mentions_only=false",
        });
        return { outcome: "waiting", summary: "waiting" };
      });
      try {
        const origReadBoard = store.readBoard.bind(store);
        let readEntered!: () => void;
        let releaseRead!: () => void;
        const readEnteredP = new Promise<void>((r) => {
          readEntered = r;
        });
        let intercept = false;
        store.readBoard = async (id, opts) => {
          if (intercept && opts?.since !== undefined && opts.since >= 1 && opts?.memberChannels) {
            intercept = false;
            readEntered();
            await new Promise<void>((r) => {
              releaseRead = r;
            });
          }
          return origReadBoard(id, opts);
        };

        intercept = true;
        await engine.addMembers({ name: "scanner", brief: "Scan board" });
        await readEnteredP;
        await engine.stopMember("scanner", { humanStopped: true, reason: "Stopped mid-scan" });
        releaseRead();
        await delay(30);
        assert.equal(engine.getSnapshot().run?.members.scanner?.state, "stopped");
        assert.equal(transport.handles.get("scanner")?.wakePrompts.length, 0);
      } finally {
        await engine.dispose();
      }
    }

    // B. Pause during 429 retry scheduling prevents arming retryTimer
    {
      const { engine, store, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        fallbackModels: [],
        maxRetries: 2,
        rateLimitBaseBackoffMs: 30,
        rateLimitMaxBackoffMs: 50,
      });
      let turns = 0;
      transport.onMember("rl-racer", async () => {
        turns += 1;
        return { outcome: "rate_limited", error: "HTTP 429" };
      });
      try {
        const origUpdateMember = store.updateMember.bind(store);
        let parkedUpdateEntered!: () => void;
        let releaseParkedUpdate!: () => void;
        const enteredP = new Promise<void>((r) => {
          parkedUpdateEntered = r;
        });
        store.updateMember = async (runId, name, patch) => {
          if (name === "rl-racer" && typeof patch.parkedOn === "string" && patch.parkedOn.includes("auto-retry")) {
            parkedUpdateEntered();
            await new Promise<void>((r) => {
              releaseParkedUpdate = r;
            });
          }
          return origUpdateMember(runId, name, patch);
        };

        await engine.addMembers({ name: "rl-racer", brief: "Hit 429" });
        await enteredP;
        await engine.pause("run-dyn", "Pause during retry scheduling");
        releaseParkedUpdate();
        await delay(80);
        assert.equal(turns, 1, "Paused member must not execute scheduled 429 retry");
        assert.equal(engine.getSnapshot().run?.status, "paused");
      } finally {
        await engine.dispose();
      }
    }
  });

  it("5. ConcurrencyGate.acquire wakes next waiter on abort during backoff and parseRetryAfterMs handles retry-after-ms", async () => {
    assert.equal(
      parseRetryAfterMs({ headers: { "retry-after-ms": "250" } }),
      250,
    );
    assert.equal(
      parseRetryAfterMs({ response: { headers: { "Retry-After-Ms": 150 } } }),
      150,
    );
    assert.equal(
      parseRetryAfterMs({ headers: { "retry-after": "2" } }),
      2000,
    );

    const breaker = new RateLimitBreaker({ baseBackoffMs: 200, maxBackoffMs: 500, jitterRatio: 0 });
    const gate = new ConcurrencyGate(1, breaker);
    const r1 = await gate.acquire();

    const ac1 = new AbortController();
    const w1 = gate.acquire(ac1.signal);
    const w2 = gate.acquire();

    // Put breaker into backoff, then release r1 so w1 wakes, enters waitIfBackedOff, and aborts!
    breaker.recordRateLimit(150, "429");
    r1();
    await delay(10);
    ac1.abort();
    await assert.rejects(() => w1, /aborted/i);

    // Wait for backoff to expire; w2 must be woken and acquire the slot instead of starving!
    const r2 = await w2;
    assert.equal(gate.getActiveCount(), 1);
    r2();
    assert.equal(gate.getActiveCount(), 0);
  });

  it("6. Smart LLM Monitor cancels on activity, rewrites invalid targets to @orchestrator, and escalates unadvanced worker nudges", async () => {
    let monitorTurnMode: "ghost" | "nudge_worker" | "slow_stale" = "ghost";
    let releaseSlowMonitor!: () => void;
    let slowMonitorPostedResult: unknown;

    const { engine, transport } = await createTestHarness({
      stallWatchdogEnabled: true,
      stallMonitorMode: "llm",
      stallTimeoutMs: 25,
    });

    const origSpawn = transport.spawnMember.bind(transport);
    transport.spawnMember = async (req: SpawnMemberRequest) => {
      if (req.isMonitor) {
        const turnPromise = (async (): Promise<AgentTurnResult> => {
          if (monitorTurnMode === "ghost") {
            await req.engineApi!.postMessage({
              text: "@nonexistent [stall] Please check status.",
            });
            return { agentId: req.agentId, name: req.name, role: req.role, outcome: "waiting", summary: "nudged", tokens: 10, cost: 0 };
          }
          if (monitorTurnMode === "nudge_worker") {
            await req.engineApi!.postMessage({
              text: "@worker-a [stall] You parked without posting [done].",
            });
            return { agentId: req.agentId, name: req.name, role: req.role, outcome: "waiting", summary: "nudged worker-a", tokens: 10, cost: 0 };
          }
          // slow_stale: wait for activity to resume, then attempt stale post
          await new Promise<void>((r) => {
            releaseSlowMonitor = r;
          });
          try {
            await req.engineApi!.postMessage({
              text: "@orchestrator [stall] Stale alert",
            });
            slowMonitorPostedResult = "posted";
          } catch (err) {
            slowMonitorPostedResult = err;
          }
          return { agentId: req.agentId, name: req.name, role: req.role, outcome: "waiting", summary: "done", tokens: 10, cost: 0 };
        })();

        return {
          agentId: req.agentId,
          name: req.name,
          role: req.role,
          getState: () => "waiting",
          getModel: () => req.modelOverride,
          getThinkingLevel: () => req.thinkingLevel,
          getConversationMessages: () => [],
          wake: async () => turnPromise,
          steer: async () => {},
          followUp: async () => {},
          switchModel: async (m, t) => ({ model: m, thinkingLevel: t }),
          abort: async () => {},
          kill: async () => {
            releaseSlowMonitor?.();
          },
          currentTurn: turnPromise,
        };
      }
      return origSpawn(req);
    };

    try {
      // worker-a parks without posting anything on either initial turn or nudge wakeup
      await engine.addMembers({ name: "worker-a", brief: "Stay quiet" });
      await waitUntil(() => engine.getSnapshot().run?.members["worker-a"]?.state === "waiting");

      // Part A: @monitor names @nonexistent -> rewritten & routed to @orchestrator!
      await waitUntil(() =>
        engine.getSnapshot().recentBoard.some((m) => m.kind === "stall" && m.mentions.includes(ORCHESTRATOR_NAME)),
      );

      // Part B: Nudge worker-a; worker-a wakes and parks again without advancing board -> next stall tick escalates to @orchestrator!
      monitorTurnMode = "nudge_worker";
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "Advance board head",
        kind: "update",
      });
      await waitUntil(
        () =>
          engine.getSnapshot().recentBoard.some(
            (m) => m.kind === "stall" && m.mentions.includes("worker-a"),
          ),
        2000,
      );
      await waitUntil(
        () =>
          engine.getSnapshot().recentBoard.some(
            (m) => m.kind === "stall" && m.text.includes("Nudged worker parked again"),
          ),
        2000,
      );

      // Part C: Activity resuming cancels active monitor and rejects stale [stall] post
      monitorTurnMode = "slow_stale";
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "Trigger slow monitor",
        kind: "update",
      });
      await waitUntil(() => Boolean(releaseSlowMonitor), 2000);
      const stallCountBefore = engine.getSnapshot().recentBoard.filter((m) => m.kind === "stall").length;
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "Resumed activity",
      });
      await delay(30);
      const stallCountAfter = engine.getSnapshot().recentBoard.filter((m) => m.kind === "stall").length;
      assert.equal(stallCountAfter, stallCountBefore, "Superseded monitor must not post [stall] or fall back deterministically");
      assert.ok(slowMonitorPostedResult instanceof Error);
    } finally {
      releaseSlowMonitor?.();
      await engine.dispose();
    }
  });

  it("7. validates v0.3.6 tool/guard/sanitizer/bridge/playbook/roleModels P2 & P3 fixes", async () => {
    // A. Validator bash guard catches \n, \r, (, `, $(
    assert.equal(isReadOnlyValidationCommand("echo ok\nrm -rf /tmp/x").allowed, false);
    assert.equal(isReadOnlyValidationCommand("echo ok\rrm -rf /tmp/x").allowed, false);
    assert.equal(isReadOnlyValidationCommand("(rm -rf /tmp/x)").allowed, false);
    assert.equal(isReadOnlyValidationCommand("echo `rm -rf /tmp/x`").allowed, false);
    assert.equal(isReadOnlyValidationCommand("echo $(rm -rf /tmp/x)").allowed, false);

    // B. Worker guard enforces write/edit containment even for inherit AND checkout guard when isIsolatedWorktree/branch
    {
      let handler!: (ev: any) => any;
      const fakePi = { on: (_: string, fn: (ev: any) => any) => { handler = fn; } };
      createWorkerGuardExtensionFactory(
        {
          agentId: "a-1",
          name: "a",
          role: "worker",
          runId: "r-1",
          cwd: "/repo/wt",
          workspace: "inherit",
          isIsolatedWorktree: true,
          parentName: "parent",
          brief: "help",
          systemPrompt: "s",
          initialPrompt: "p",
          keepWarm: true,
        },
        "main",
      )(fakePi as any);

      assert.equal(handler({ toolName: "write", input: { path: "../outside.ts" } })?.block, true);
      assert.equal(handler({ toolName: "bash", input: { command: "git checkout main" } })?.block, true);
    }

    // C. sanitizeForkSeedMessages strips thinking & sets stopReason="stop" on dangling toolCall and drops empty assistant msgs
    {
      const sanitized = sanitizeForkSeedMessages([
        makeUserMessage("Go"),
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret thought" },
            { type: "toolCall", id: "dangling-1", name: "bash", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "partial" },
            { type: "text", text: "Kept text" },
            { type: "toolCall", id: "dangling-2", name: "bash", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: Date.now(),
        } as unknown as AgentMessage,
      ]);
      assert.equal(sanitized.length, 2, "Assistant message with no kept text or toolCall must be skipped");
      const kept = sanitized[1] as unknown as { content: Array<{ type: string }>; stopReason: string };
      assert.equal(kept.stopReason, "stop");
      assert.deepEqual(kept.content.map((p) => p.type), ["text"]);
    }

    // D. Tool schemas: swarm_wait sequential in both orchestrator & member tools, force in scopedSwarmTool, zero anyOf/oneOf
    {
      const { engine } = await createTestHarness({ stallWatchdogEnabled: false });
      try {
        const orchTools = createSwarmTools({ engine });
        const orchWait = orchTools.find((t) => t.name === SWARM_WAIT_TOOL)!;
        assert.equal((orchWait as unknown as { executionMode?: string }).executionMode, "sequential");

        let killedArgs: Array<{ name: string; force?: boolean }> = [];
        const memberTools = createMemberScopedTools(
          {
            postMessage: async () => { throw new Error("unused"); },
            readBoard: async () => ({ messages: [], head: 0 }),
            getStatus: async () => ({ runId: "r", title: "t", status: "active", baseBranch: "main", boardHead: 0, members: [], channels: [] }),
            listModels: async () => [],
            addHelper: async () => [],
            killHelper: async (name, _reason, force) => {
              killedArgs.push({ name, force });
            },
            switchModel: async () => ({ targetName: "x", model: "m" }),
            manageChannel: async () => ({ action: "list", summary: "ok" }),
          },
          { name: "lead", role: "worker", runId: "run-dyn" },
        );
        const memberWait = memberTools.find((t) => t.name === SWARM_WAIT_TOOL)!;
        assert.equal((memberWait as unknown as { executionMode?: string }).executionMode, "sequential");

        const scopedSwarm = memberTools.find((t) => t.name === SWARM_TOOL)!;
        for (const t of [...orchTools, ...memberTools]) {
          const schemaText = JSON.stringify(t.parameters);
          assert.ok(!schemaText.includes("anyOf") && !schemaText.includes("oneOf"), `${t.name} must not use anyOf/oneOf`);
        }

        await scopedSwarm.execute("tc-1", { action: "kill", name: "@helper", force: true }, undefined, undefined, {} as ExtensionToolContext);
        assert.deepEqual(killedArgs, [{ name: "helper", force: true }]);
      } finally {
        await engine.dispose();
      }
    }

    // E. Prototype keys rejected, validatorEnabled=false hides validator playbook steps, orchestrator switchModel not shadowed, completeRun checks sessionId, bridge rejects after kill
    {
      const { engine, store, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        orchestratorModel: "openai/gpt-5",
      });
      try {
        await assert.rejects(
          () => engine.addMembers({ name: "constructor", brief: "Invalid proto key" }),
          (err) => err instanceof SwarmProtocolError && err.code === "INVALID_NAME",
        );

        await engine.switchModel({
          targetName: "orchestrator",
          model: "anthropic/claude-opus-4-6",
        });
        assert.equal(
          engine.getSnapshot().roleModels.orchestrator?.model,
          "anthropic/claude-opus-4-6",
          "Run-scoped orchestrator switchModel must not be shadowed by settings.orchestratorModel",
        );

        const noValRun = await store.createRun({
          id: "run-noval",
          title: "No Validator",
          objective: "Fast path",
          baseBranch: "main",
          ownerSessionId: "sess-1",
          validatorEnabled: false,
        });
        await engine.startRun(noValRun.id);
        const playbook = buildOrchestratorPlaybookSection(engine.getSnapshot());
        assert.ok(!playbook.includes("Independent Read-Only Validation"));
        assert.ok(playbook.includes("4. **Land & Complete**"));

        // Member bridge guards after kill & leading @ stripping in kill/merge/model
        let capturedBridge: SpawnMemberRequest["engineApi"] | undefined;
        transport.onMember("bridged", async ({ request }) => {
          capturedBridge = request.engineApi;
        });
        await engine.addMembers({ name: "bridged", brief: "Capture bridge" });
        await waitUntil(() => engine.getSnapshot().run?.members.bridged?.state === "waiting");
        await engine.killMember("@bridged");
        await assert.rejects(
          () => capturedBridge!.postMessage({ text: "late post" }),
          (err) => err instanceof SwarmProtocolError && err.code === "MEMBER_KILLED",
        );

        // completeRun enforces sessionId ownership
        await assert.rejects(
          () => engine.completeRun({ summary: "Foreign complete", sessionId: "foreign-sess" }),
          (err) => err instanceof SwarmProtocolError && err.code === "OWNERSHIP_CONFLICT",
        );
      } finally {
        await engine.dispose();
      }
    }

    // F. steerMember when handle.getState()==='waiting' during post-turn turnActive delivers via board post ("woken"), NOT handle.steer()
    {
      const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
      const origLoadRun = store.loadRun.bind(store);
      let enteredPostTurnLoad!: () => void;
      let releasePostTurnLoad!: () => void;
      const enteredP = new Promise<void>((r) => {
        enteredPostTurnLoad = r;
      });
      let interceptPostTurn = false;
      store.loadRun = async (runId) => {
        const res = await origLoadRun(runId);
        if (interceptPostTurn && res.members["steerable"]?.state === "working") {
          interceptPostTurn = false;
          enteredPostTurnLoad();
          await new Promise<void>((r) => {
            releasePostTurnLoad = r;
          });
        }
        return res;
      };
      try {
        await engine.addMembers({ name: "steerable", brief: "Finish turn 1" });
        await waitUntil(() => engine.getSnapshot().run?.members.steerable?.state === "waiting");

        // Trigger a wake whose turn completes while handle.getState()==='waiting' and pauses inside handleTurnFinished's loadRun
        interceptPostTurn = true;
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@steerable Turn 2",
        });
        await enteredP;
        // Now handle.getState() === 'waiting' while live.turnActive === true
        const steerRes = await engine.steerMember("steerable", "Post-turn redirect");
        assert.equal(steerRes.delivery, "woken");
        assert.equal(transport.handles.get("steerable")?.steers.length, 0);
        releasePostTurnLoad();
        await waitUntil(() => transport.handles.get("steerable")!.wakePrompts.length === 2);
      } finally {
        releasePostTurnLoad?.();
        await engine.dispose();
      }
    }
  });
});

// ============================================================================
// 16. v0.3.7 Runtime, Transport, Tools & Prompt Fixes
// ============================================================================

describe("SwarmEngine & Runtime — v0.3.7 Fixes", () => {
  it("1. revives keepWorkersWarm:false members on mid-turn pendingWakes, guards failed alerts on runDonePosted, and prevents pendingWakes wedge", async () => {
    // A. keepWorkersWarm: false revives member with queued mid-turn @mention (unless aborted)
    {
      const store = new MockSwarmStore();
      const worktree = new MockWorktreeManager();
      const transport = new ScriptedTransport();
      const engine = new SwarmEngine({
        store,
        worktree,
        transport,
        settings: { stallWatchdogEnabled: false, keepWorkersWarm: false },
      });
      const run = await store.createRun({
        id: "run-cold-wake",
        title: "Cold Pending Wake",
        objective: "Test cold pending wake revive",
        baseBranch: "main",
        ownerSessionId: "s1",
        keepWorkersWarm: false,
      });
      await engine.startRun(run.id);

      let releaseFirstTurn!: () => void;
      const firstTurnGate = new Promise<void>((r) => {
        releaseFirstTurn = r;
      });
      let firstTurnEntered!: () => void;
      const firstTurnEnteredP = new Promise<void>((r) => {
        firstTurnEntered = r;
      });
      const seenPrompts: string[] = [];

      transport.onMember("cold-w", async ({ turnIndex, prompt }) => {
        seenPrompts.push(prompt);
        if (turnIndex === 1 && seenPrompts.length === 1) {
          firstTurnEntered();
          await firstTurnGate;
          return { outcome: "stopped", summary: "finished initial turn" };
        }
        return { outcome: "stopped", summary: "finished revived turn" };
      });

      try {
        await engine.addMembers({ name: "cold-w", brief: "Do work" });
        await firstTurnEnteredP;

        // Post a mid-turn @mention while turn 1 is active
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@cold-w follow-up task while working",
        });

        releaseFirstTurn();
        await waitUntil(
          () =>
            transport.spawns.filter((r) => r.name === "cold-w").length === 2 &&
            engine.getSnapshot().workingMemberNames.length === 0,
        );
        assert.equal(seenPrompts.length, 2);
        assert.ok(seenPrompts[1]!.includes("follow-up task while working"));
        assert.equal(engine.getSnapshot().run?.members["cold-w"]?.state, "stopped");
      } finally {
        releaseFirstTurn?.();
        await engine.dispose();
      }
    }

    // B. runDonePosted suppresses late failed alert & failed/stopped/rate_limited with stale pendingWakes do not wedge all_idle
    {
      const { engine, store, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        maxRetries: 0,
      });
      let releaseFailTurn!: () => void;
      const failGate = new Promise<void>((r) => {
        releaseFailTurn = r;
      });
      let enteredFailTurn!: () => void;
      const enteredFailP = new Promise<void>((r) => {
        enteredFailTurn = r;
      });
      transport.onMember("failer", async () => {
        enteredFailTurn();
        await failGate;
        return { outcome: "failed", error: "late error after done" };
      });

      try {
        await engine.addMembers({ name: "failer", brief: "Fail late" });
        await enteredFailP;

        // Complete run while handleTurnFinished will resolve shortly after
        await engine.completeRun({ summary: "Completed early" });
        releaseFailTurn();
        await delay(30);

        const board = await store.readBoard("run-dyn", { limit: 50 });
        const lateErrorAlerts = board.messages.filter(
          (m) => m.from === "monitor" && m.text.includes("late error after done"),
        );
        assert.equal(
          lateErrorAlerts.length,
          0,
          "runDonePosted must suppress postMonitorOrchestratorAlert in failed fallthrough",
        );
      } finally {
        releaseFailTurn?.();
        await engine.dispose();
      }
    }

    // C. Exhausted rate_limited member with pendingWakes does NOT wedge all_idle
    {
      const { engine, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        maxRetries: 0,
        fallbackModels: [],
      });
      let releaseRl!: () => void;
      const rlGate = new Promise<void>((r) => {
        releaseRl = r;
      });
      let enteredRl!: () => void;
      const enteredRlP = new Promise<void>((r) => {
        enteredRl = r;
      });
      transport.onMember("rl-wedger", async () => {
        enteredRl();
        await rlGate;
        return { outcome: "rate_limited", error: "HTTP 429 quota exhausted" };
      });
      try {
        await engine.addMembers({ name: "rl-wedger", brief: "Hit 429" });
        await enteredRlP;
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@rl-wedger queued wake before 429",
        });
        releaseRl();
        await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);
        const waitRes = await engine.waitForBoard({
          since: engine.getSnapshot().boardHead,
          timeoutMs: 200,
        });
        assert.equal(waitRes.wokeBy, "all_idle");
      } finally {
        releaseRl?.();
        await engine.dispose();
      }
    }
  });

  it("2. arms watchdog in resume()/attachRun(), cleans same-run terminal attachRun(), avoids deliveredSeqs poisoning, cleans stopMember handle, and parallelizes pause()", async () => {
    // A. resume() and attachRun() arm stall watchdog; same-run terminal attachRun() disposes handles/waiters
    {
      const { engine, store, transport } = await createTestHarness({
        stallWatchdogEnabled: true,
        stallMonitorMode: "deterministic",
        stallTimeoutMs: 50,
      });
      try {
        await engine.addMembers({ name: "watch-w", brief: "Park waiting" });
        await waitUntil(() => engine.getSnapshot().run?.members["watch-w"]?.state === "waiting");

        await engine.pause("run-dyn", "Pause before resume test");
        await engine.resume("run-dyn");
        await waitUntil(
          () => engine.getSnapshot().recentBoard.some((m) => m.kind === "stall"),
          1500,
        );

        // Detach and reattach active run -> arms watchdog again at new head
        await engine.attachRun(null);
        await engine.attachRun("run-dyn");
        await waitUntil(
          () =>
            engine.getSnapshot().recentBoard.filter((m) => m.kind === "stall").length >= 2,
          1500,
        );

        // Same-run terminal attachRun() must dispose live handles and resolve waiters
        const spawnsBeforeWake = transport.spawns.filter((s) => s.name === "watch-w").length;
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@watch-w wake up",
        });
        await waitUntil(
          () =>
            transport.spawns.filter((s) => s.name === "watch-w").length === spawnsBeforeWake + 1 &&
            engine.getSnapshot().workingMemberNames.length === 0 &&
            engine.getSnapshot().run?.members["watch-w"]?.state === "waiting",
        );
        const handleRec = transport.handles.get("watch-w")!;

        let holdWaitResolve: WaitForBoardResult | undefined;
        let enteredWatchTurn!: () => void;
        const enteredWatchTurnP = new Promise<void>((r) => {
          enteredWatchTurn = r;
        });
        let releaseWatchTurn!: () => void;
        const watchTurnGate = new Promise<void>((r) => {
          releaseWatchTurn = r;
        });
        transport.onMember("watch-w", async () => {
          enteredWatchTurn();
          await watchTurnGate;
          return { outcome: "waiting", summary: "done" };
        });
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@watch-w hold turn",
        });
        await enteredWatchTurnP;
        const waiterPromise = engine.waitForBoard({ since: 999, timeoutMs: 2000 }).then((r) => {
          holdWaitResolve = r;
        });
        await store.updateRun("run-dyn", { status: "completed" });
        await engine.attachRun("run-dyn");
        await waiterPromise;
        assert.equal(holdWaitResolve?.wokeBy, "run_ended");
        assert.equal(handleRec.killed, true, "Same-run terminal attachRun must dispose live handles");
        releaseWatchTurn();
      } finally {
        await engine.dispose();
      }
    }

    // B. deliveredSeqs is NOT poisoned when queued message is cancelled before dispatch
    {
      const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((r) => {
        releaseTurn = r;
      });
      let turnStarted!: () => void;
      const turnStartedP = new Promise<void>((r) => {
        turnStarted = r;
      });
      transport.onMember("poison-w", async ({ turnIndex }) => {
        if (turnIndex === 1) {
          turnStarted();
          await turnGate;
        }
        return { outcome: "waiting", summary: "ok" };
      });
      try {
        await engine.addMembers({ name: "poison-w", brief: "Start" });
        await turnStartedP;

        // Post msg #2 while poison-w is working -> queued in pendingWakes, NOT dispatched yet
        const queuedMsg = await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@poison-w important message",
        });

        // stopMember discards pendingWakes before #2 is ever dispatched
        await engine.stopMember("poison-w", { humanStopped: false, reason: "Temp stop" });
        releaseTurn();
        await delay(20);

        // Revive poison-w with mentions_only:false and since before queuedMsg -> #2 must NOT be dropped!
        const liveMap = (engine as unknown as {
          liveMembers: Map<string, { deliveredSeqs: Set<number> }>;
        }).liveMembers;
        assert.equal(
          liveMap.get("poison-w")?.deliveredSeqs.has(queuedMsg.seq),
          false,
          "Cancelled queued message seq must NOT be marked in deliveredSeqs",
        );

        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@poison-w resume",
        });
        await waitUntil(() => engine.getSnapshot().run?.members["poison-w"]?.state === "waiting");

        // Also ensure store still has queuedMsg and re-delivering via new post works cleanly
        const board = await store.readBoard("run-dyn", { seqs: [queuedMsg.seq] });
        assert.equal(board.messages.length, 1);
      } finally {
        releaseTurn?.();
        await engine.dispose();
      }
    }

    // C. stopMember() kills handle + persists sessionFile, and pause() aborts/kills handles in parallel
    {
      const { engine, transport } = await createTestHarness({ stallWatchdogEnabled: false });
      // Spawn two workers whose turns ignore abort() so pause() hits the 250ms race per handle
      let slowTurns = 0;
      const neverResolves = new Promise<Partial<AgentTurnResult>>(() => {});
      const origSpawn = transport.spawnMember.bind(transport);
      transport.spawnMember = async (req) => {
        const h = await origSpawn({
          ...req,
          sessionFile: req.sessionFile ?? `/tmp/sess-${req.name}.jsonl`,
        });
        if (req.name.startsWith("par-")) {
          slowTurns += 1;
          // Override abort so currentTurn does not resolve immediately, forcing 250ms race
          h.abort = async () => {};
        }
        return h;
      };
      transport.onMember("par-*", () => neverResolves);
      transport.onMember("stopper", () => neverResolves);

      try {
        await engine.addMembers({ name: "stopper", brief: "Slow turn" });
        await waitUntil(() => transport.handles.get("stopper") !== undefined);
        const stopperHandle = transport.handles.get("stopper")!;
        await engine.stopMember("stopper", { humanStopped: true, reason: "Stop check" });
        assert.equal(stopperHandle.aborted, true);
        assert.equal(stopperHandle.killed, true, "stopMember must kill live handle");
        assert.equal(
          engine.getSnapshot().run?.members.stopper?.sessionFile,
          "/tmp/sess-stopper.jsonl",
        );

        await engine.addMembers({ name: "par-1", brief: "Parallel 1" });
        await engine.addMembers({ name: "par-2", brief: "Parallel 2" });
        await engine.addMembers({ name: "par-3", brief: "Parallel 3" });
        await waitUntil(() => slowTurns === 3);

        const startedAt = Date.now();
        await engine.pause("run-dyn", "Parallel pause");
        const elapsedMs = Date.now() - startedAt;
        assert.ok(
          elapsedMs < 550,
          `Parallel pause across 3 250ms handles took ${elapsedMs}ms (expected < 550ms, not >= 750ms serial)`,
        );
        for (const name of ["par-1", "par-2", "par-3"]) {
          assert.equal(transport.handles.get(name)?.killed, true);
          assert.equal(engine.getSnapshot().run?.members[name]?.state, "stopped");
        }
      } finally {
        await engine.dispose();
      }
    }
  });

  it("3. pre-registers LiveMember in addMembers(), deletes branch on worktree rollback, and sanitizes secondary @mentions in @monitor stalls", async () => {
    // A. Pre-registration prevents duplicate spawn when @all arrives during store.addMember / postBoardMessage
    {
      const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
      const origAddMember = store.addMember.bind(store);
      let memberAdded!: () => void;
      let releasePostBrief!: () => void;
      const memberAddedP = new Promise<void>((r) => {
        memberAdded = r;
      });
      const origPostBoard = store.postBoardMessage.bind(store);
      let interceptBrief = true;
      store.postBoardMessage = async (runId, input) => {
        if (interceptBrief && input.kind === "brief" && input.text.includes("@race-w")) {
          interceptBrief = false;
          memberAdded();
          await new Promise<void>((r) => {
            releasePostBrief = r;
          });
        }
        return origPostBoard(runId, input);
      };

      try {
        const addPromise = engine.addMembers({ name: "race-w", brief: "Initial work" });
        await memberAddedP;

        // Concurrent @all post while addMembers is awaiting postBoardMessage
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@all concurrent announcement",
        });

        releasePostBrief();
        await addPromise;
        await waitUntil(
          () =>
            transport.handles.get("race-w") !== undefined &&
            engine.getSnapshot().workingMemberNames.length === 0,
        );

        assert.equal(
          transport.spawns.filter((s) => s.name === "race-w").length,
          1,
          "Pre-registered spawning LiveMember must prevent duplicate handle spawn",
        );
        assert.ok(
          transport.handles
            .get("race-w")!
            .wakePrompts.some((p) => p.includes("concurrent announcement")),
          "Concurrent @all post must queue into pendingWakes and drain on warm turn finish",
        );
      } finally {
        store.addMember = origAddMember;
        releasePostBrief?.();
        await engine.dispose();
      }
    }

    // B. Worktree rollback calls deleteBranch after removeWorktree & addMembers rollback clears pre-registered LiveMember
    {
      const { engine, store, worktree } = await createTestHarness({ stallWatchdogEnabled: false });
      try {
        worktree.failCreateWorktreeFor = "shard-2";
        await assert.rejects(
          () =>
            engine.addMembers({
              name: "shard",
              brief: "Sharded work",
              tasks: ["part 1", "part 2"],
              workspace: "share",
            }),
          /Simulated worktree failure/,
        );
        assert.equal(worktree.removedWorktrees.length, 1);
        assert.equal(worktree.deletedBranches.length, 1);
        assert.ok(worktree.deletedBranches[0]!.endsWith("/shard-1"));

        // Retry with failing store.addMember -> LiveMember is rolled back so retry succeeds
        worktree.failCreateWorktreeFor = undefined;
        const origAddMember = store.addMember.bind(store);
        let failOnce = true;
        store.addMember = async (runId, input) => {
          if (failOnce && input.name === "retryable") {
            failOnce = false;
            throw new Error("Transient store failure");
          }
          return origAddMember(runId, input);
        };
        await assert.rejects(
          () => engine.addMembers({ name: "retryable", brief: "Fail once", workspace: "share" }),
          /Transient store failure/,
        );
        assert.ok(
          worktree.deletedBranches.some((b) => b.endsWith("/retryable")),
          "Second-phase rollback must also delete provisioned worktree branch",
        );
        const retried = await engine.addMembers({
          name: "retryable",
          brief: "Retry succeeds",
          workspace: "share",
        });
        assert.equal(retried.length, 1);
      } finally {
        await engine.dispose();
      }
    }

    // C. Secondary @mentions in @monitor stall post do NOT wake @orchestrator
    {
      const { engine, transport } = await createTestHarness({
        stallWatchdogEnabled: true,
        stallMonitorMode: "llm",
        stallTimeoutMs: 40,
      });
      const events: SwarmEngineEvent[] = [];
      engine.subscribe((e) => events.push(e));

      let nudgedCount = 0;
      transport.onMember("worker-a", async ({ turnIndex }) => {
        if (turnIndex === 2) {
          nudgedCount += 1;
        }
        return { outcome: "waiting", summary: "waiting" };
      });
      transport.onMember("monitor", async ({ request }) => {
        await request.engineApi!.postMessage({
          text: "@worker-a [stall] Finish the patch and report to @orchestrator",
        });
        return { outcome: "stopped", summary: "nudged worker-a" };
      });

      try {
        await engine.addMembers({ name: "worker-a", brief: "Do work without reporting" });
        await waitUntil(() => nudgedCount === 1, 1500);

        const stallPost = engine
          .getSnapshot()
          .recentBoard.find((m) => m.kind === "stall");
        assert.ok(stallPost, "Stall message must be posted");
        assert.deepEqual(stallPost!.mentions, ["worker-a"]);
        assert.ok(!stallPost!.text.includes("@orchestrator"));
        const orchWakeups = events.filter(
          (e) => e.type === "wakeup_needed" && e.seq === stallPost!.seq,
        );
        assert.equal(
          orchWakeups.length,
          0,
          "Secondary @orchestrator prose in worker-targeted stall must NOT wake orchestrator",
        );
      } finally {
        await engine.dispose();
      }
    }
  });

  it("4. cold sessionFile cachedMessages, custom seed entries, tokenBreakdown baseline subtraction, and bash guard precision", async () => {
    // A. Bash guard precision
    assert.equal(isReadOnlyValidationCommand(`rg "(install|patch)" src/`).allowed, true);
    assert.equal(isReadOnlyValidationCommand(`python3 -c "print(ln)"`).allowed, true);
    assert.equal(isReadOnlyValidationCommand("git merge-base main HEAD").allowed, true);
    assert.equal(isReadOnlyValidationCommand("(rm -rf foo)").allowed, false);
    assert.equal(isReadOnlyValidationCommand("pwd\nrm -rf foo").allowed, false);
    assert.equal(isReadOnlyValidationCommand("git merge feat").allowed, false);

    assert.equal(isForbiddenWorkerBashCommand("git merge-base main HEAD").allowed, true);
    assert.equal(isForbiddenWorkerBashCommand("git merge feat").allowed, false);
    assert.equal(isForbiddenWorkerBashCommand("git push origin main").allowed, false);

    // B. Cold sessionFile revival initializes cachedMessages, seeds custom role entries, and subtracts sessionBaselineBreakdown
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v037-trans-"));
    try {
      const sessionDir = path.join(tmpRoot, "sessions");
      const seededSm = SessionManager.create(tmpRoot, sessionDir);
      seededSm.appendMessage(makeUserMessage("Prior cold question") as Parameters<SessionManager["appendMessage"]>[0]);
      seededSm.appendMessage(makeAssistantTextMessage("Prior cold answer") as Parameters<SessionManager["appendMessage"]>[0]);
      const sessionFile = seededSm.getSessionFile()!;

      const customSeed: AgentMessage[] = [
        makeUserMessage("Fork user"),
        {
          role: "custom",
          customType: "swarm-note",
          content: "Custom context entry",
          display: false,
          details: { seq: 1 },
          timestamp: Date.now(),
        } as unknown as AgentMessage,
      ];

      let capturedSessionManager: SessionManager | undefined;
      const transport = new InProcessPiTransport({
        agentDir: tmpRoot,
        createSession: (async (opts?: { model?: unknown; sessionManager?: SessionManager }) => {
          capturedSessionManager = opts?.sessionManager;
          let calls = 0;
          const fakeSession = {
            model: opts?.model,
            sessionManager: opts?.sessionManager,
            extensionRunner: { hasHandlers: () => false, emit: async () => {} },
            bindExtensions: async () => {},
            subscribe: () => () => {},
            prompt: async () => {
              calls += 1;
            },
            abort: async () => {},
            dispose: () => {},
            getSessionStats: () =>
              calls === 0
                ? {
                    tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 50, total: 850 },
                    cost: 0.05,
                  }
                : {
                    tokens: { input: 540, output: 215, cacheRead: 120, cacheWrite: 55, total: 930 },
                    cost: 0.06,
                  },
          } as unknown as AgentSession;
          return { session: fakeSession, extensionsResult: { extensions: [], errors: [], runtime: {} } };
        }) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
      });

      // Cold sessionFile handle: getConversationMessages() immediately has disk history before prompt finishes
      let releaseColdPrompt!: () => void;
      const coldPromptGate = new Promise<void>((r) => {
        releaseColdPrompt = r;
      });
      const coldTransport = new InProcessPiTransport({
        agentDir: tmpRoot,
        createSession: (async (opts?: { model?: unknown; sessionManager?: SessionManager }) => {
          const fakeSession = {
            model: opts?.model,
            sessionManager: opts?.sessionManager,
            extensionRunner: { hasHandlers: () => false, emit: async () => {} },
            bindExtensions: async () => {},
            subscribe: () => () => {},
            prompt: async () => {
              await coldPromptGate;
            },
            abort: async () => {},
            dispose: () => {},
            getSessionStats: () => ({
              tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
              cost: 0.001,
            }),
          } as unknown as AgentSession;
          return { session: fakeSession, extensionsResult: { extensions: [], errors: [], runtime: {} } };
        }) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
      });

      const coldHandle = await coldTransport.spawnMember({
        agentId: "cold-1",
        name: "cold",
        role: "worker",
        runId: "r1",
        cwd: tmpRoot,
        workspace: "inherit",
        parentName: ORCHESTRATOR_NAME,
        brief: "Cold revive",
        systemPrompt: "Worker",
        initialPrompt: "Continue",
        keepWarm: true,
        sessionDir,
        sessionFile,
      });
      const coldMsgs = coldHandle.getConversationMessages();
      assert.equal(coldMsgs.length, 2, "Cold sessionFile revival must populate cachedMessages immediately");
      releaseColdPrompt?.();
      await coldHandle.currentTurn;
      await coldHandle.kill();

      // Forked handle: custom entry seeded + baseline subtracted from tokenBreakdown
      const forkHandle = await transport.spawnMember({
        agentId: "fork-1",
        name: "forked",
        role: "worker",
        runId: "r1",
        cwd: tmpRoot,
        workspace: "inherit",
        parentName: ORCHESTRATOR_NAME,
        brief: "Forked work",
        systemPrompt: "Worker",
        initialPrompt: "Go",
        keepWarm: true,
        seedMessages: customSeed,
      });
      const forkTurn = await forkHandle.currentTurn;
      assert.equal(forkTurn.tokens, 80);
      assert.deepEqual(forkTurn.tokenBreakdown, {
        input: 40,
        output: 15,
        cacheRead: 20,
        cacheWrite: 5,
        total: 80,
      });
      const extracted = extractSessionMessages(capturedSessionManager);
      assert.ok(
        extracted.some((m) => (m as unknown as Record<string, unknown>).role === "custom"),
        "role: 'custom' seed entry must be appended via appendCustomMessageEntry",
      );
      await forkHandle.kill();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }

    // C. Engine accumulates priorHandlesBreakdown across stopped -> revived handles
    {
      const { engine, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        keepWorkersWarm: false,
      });
      let turn = 0;
      transport.onMember("bd-w", async () => {
        turn += 1;
        return {
          outcome: "stopped",
          summary: `turn ${turn}`,
          tokens: turn === 1 ? 100 : 60,
          tokenBreakdown:
            turn === 1
              ? { input: 70, output: 30, cacheRead: 0, cacheWrite: 0, total: 100 }
              : { input: 40, output: 10, cacheRead: 10, cacheWrite: 0, total: 60 },
          cost: 0.01,
        };
      });
      try {
        await engine.addMembers({ name: "bd-w", brief: "Turn 1" });
        await waitUntil(() => engine.getSnapshot().run?.members["bd-w"]?.turns === 1);
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@bd-w turn 2",
        });
        await waitUntil(() => engine.getSnapshot().run?.members["bd-w"]?.turns === 2);
        const m = engine.getSnapshot().run?.members["bd-w"];
        assert.equal(m?.tokens, 160);
        assert.deepEqual(m?.tokenBreakdown, {
          input: 110,
          output: 40,
          cacheRead: 10,
          cacheWrite: 0,
          total: 160,
        });
      } finally {
        await engine.dispose();
      }
    }
  });

  it("5. lastReadSeq precision, briefSeq clamp, zero-I/O cloned telemetry getStatus, concrete briefSeq prompt, auto-routed [done] & all_idle digest", async () => {
    const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
    try {
      // Seed 3 messages BEFORE spawning worker so briefSeq > 1
      await engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "Pre-spawn #1" });
      await engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "Pre-spawn #2" });
      await engine.manageChannel({ action: "create", name: "ops" });

      let workerBridge!: SpawnMemberRequest["engineApi"];
      let capturedReq!: SpawnMemberRequest;
      transport.onMember("smart-w", async ({ request, turnIndex }) => {
        capturedReq = request;
        workerBridge = request.engineApi!;
        request.onTelemetry?.({
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          runId: request.runId,
          type: "tool_start",
          toolName: "read",
          activity: "reading code",
          timestamp: new Date().toISOString(),
        });
        if (turnIndex === 1) {
          // Simulate worker calling swarm_wait{since: 0, mentions_only: false} despite briefSeq === 3
          request.onTelemetry?.({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            runId: request.runId,
            type: "waiting",
            activity: "waiting (since #0)",
            logLine: "swarm_wait since=#0 mentions_only=false",
            timestamp: new Date().toISOString(),
          });
        }
        return { outcome: "waiting", summary: "waiting" };
      });

      const orchBeforeRef = engine.getSnapshot().run?.members["smart-w"];
      assert.equal(orchBeforeRef, undefined);

      await engine.addMembers({ name: "smart-w", brief: "Work", channels: ["main", "ops"] });
      await waitUntil(() => engine.getSnapshot().run?.members["smart-w"]?.state === "waiting");

      // buildMemberInitialPrompt uses concrete briefSeq instead of <highest-seq-read>
      const mRecord = engine.getSnapshot().run!.members["smart-w"]!;
      const initialPrompt = buildMemberInitialPrompt(engine.getSnapshot().run!, mRecord, mRecord.briefSeq!);
      assert.ok(initialPrompt.includes(`swarm_wait{since: ${mRecord.briefSeq!}}`));
      assert.ok(!initialPrompt.includes("<highest-seq-read>"));

      // Pre-spawn messages #1/#2 must NOT have been replayed by mentions_only:false clamp
      assert.equal(
        transport.handles.get("smart-w")!.wakePrompts.length,
        0,
        "mentions_only:false must clamp since to briefSeq so pre-spawn history is never replayed",
      );

      // Snapshot cloning in handleTelemetry: capture ref before telemetry, emit telemetry, verify previous ref untouched
      const snapBeforeTelemetry = engine.getSnapshot().run!.members["smart-w"]!;
      capturedReq.onTelemetry?.({
        agentId: capturedReq.agentId,
        name: capturedReq.name,
        role: capturedReq.role,
        runId: capturedReq.runId,
        type: "tool_start",
        toolName: "bash",
        activity: "running npm test",
        timestamp: new Date().toISOString(),
      });
      const snapAfterTelemetry = engine.getSnapshot().run!.members["smart-w"]!;
      assert.notEqual(snapBeforeTelemetry, snapAfterTelemetry, "handleTelemetry must clone member record");
      assert.equal(snapAfterTelemetry.currentActivity, "running npm test");

      // Zero disk loadRun in bridge.getStatus
      const origLoadRun = store.loadRun.bind(store);
      let loadRunCalls = 0;
      store.loadRun = async (id) => {
        loadRunCalls += 1;
        return origLoadRun(id);
      };
      const liveStatus = await workerBridge!.getStatus();
      assert.equal(loadRunCalls, 0, "bridge.getStatus must read from cachedRun without disk loadRun");
      assert.equal(
        liveStatus.members.find((m) => m.name === "smart-w")?.currentActivity,
        "running npm test",
      );
      store.loadRun = origLoadRun;

      // Trigger turn 2 so smart-w parks with default mentions_only=true before testing filtered readBoard
      const p4 = await engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "Msg 4", channel: "ops" });
      await waitUntil(() => engine.getSnapshot().run?.members["smart-w"]?.turns === 2);
      const p5 = await engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "Msg 5" });
      const p6 = await engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "Msg 6" });
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      const baseSeq = engine.getSnapshot().run!.members["smart-w"]!.lastReadSeq;
      await workerBridge!.readBoard({ seqs: [p6.seq] });
      await workerBridge!.readBoard({ search: "Msg 6" });
      await workerBridge!.readBoard({ channel: "ops" });
      await workerBridge!.readBoard({ limit: 0 });
      await delay(20);
      assert.equal(engine.getSnapshot().run!.members["smart-w"]!.lastReadSeq, baseSeq);

      await workerBridge!.readBoard({ since: baseSeq, limit: 1 });
      await waitUntil(() => engine.getSnapshot().run!.members["smart-w"]!.lastReadSeq === p5.seq);

      await workerBridge!.readBoard({ since: p6.seq });
      await waitUntil(() => engine.getSnapshot().run!.members["smart-w"]!.lastReadSeq === p6.seq);

      // Auto-route forgotten @mention on member [done] post + swarm-tools no-mention suffix
      const memberTools = createMemberScopedTools(workerBridge!, {
        name: "smart-w",
        role: "worker",
        runId: "run-dyn",
      });
      const postTool = memberTools.find((t) => t.name === POST_MESSAGE_TOOL)!;
      const chatRes = await postTool.execute(
        "tc-chat",
        { text: "just a status update without mention" },
        undefined,
        undefined,
        {} as ExtensionToolContext,
      );
      assert.ok(
        (chatRes.content[0] as { text: string }).text.includes("(no @mention included — no peer was woken)"),
      );

      const events: SwarmEngineEvent[] = [];
      const unsub = engine.subscribe((e) => events.push(e));
      const donePost = await workerBridge!.postMessage({ text: "[done] Completed without explicit mention" });
      assert.ok(donePost.mentions.includes(ORCHESTRATOR_NAME));
      assert.ok(
        events.some((e) => e.type === "wakeup_needed" && e.seq === donePost.seq),
        "Auto-routed [done] post must wake parent @orchestrator",
      );
      unsub();

      // all_idle digest includes member state, lastPost=#N, and parkedOn
      const idleRes = await engine.parkOrchestratorWait({ since: donePost.seq });
      assert.equal(idleRes.wokeBy, "all_idle");
      assert.ok(idleRes.summary.includes(`@smart-w [waiting, lastPost=#${donePost.seq}`));
    } finally {
      await engine.dispose();
    }
  });

  it("v0.4.0: propagateRoleModel silently switches waiting/working role-tracking members while leaving custom overrides and Inherit clears untouched", async () => {
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    const transport = new ScriptedTransport();
    transport.availableModels.push(
      { id: "claude-opus-5-5", provider: "magpie/bp", fullId: "magpie/bp/claude-opus-5-5", reasoning: true },
      { id: "gpt-6.2-astra", provider: "magpie/bp", fullId: "magpie/bp/gpt-6.2-astra", reasoning: true },
      { id: "gpt-5.4", provider: "openai", fullId: "openai/gpt-5.4", reasoning: true },
      { id: "gemini-4-neon", provider: "google", fullId: "google/gemini-4-neon", reasoning: true },
    );
    const currentSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      stallWatchdogEnabled: false,
      validatorModel: "magpie/bp/claude-opus-5-5",
      validatorThinkingLevel: "xhigh",
    };

    let releaseBusyTurn1!: () => void;
    const busyGate1 = new Promise<void>((r) => {
      releaseBusyTurn1 = r;
    });
    let releaseBusyTurn2!: () => void;
    const busyGate2 = new Promise<void>((r) => {
      releaseBusyTurn2 = r;
    });
    const busyTurnModels: string[] = [];

    transport.onMember("val-busy", async (ctx) => {
      busyTurnModels.push(ctx.model ?? "");
      if (ctx.turnIndex === 1) {
        await busyGate1;
      } else {
        await busyGate2;
      }
      return { outcome: "waiting", summary: "ok" };
    });

    const engine = new SwarmEngine({
      store,
      worktree,
      transport,
      getSettings: () => currentSettings,
    });

    try {
      const run = await store.createRun({
        id: "run-v040-prop",
        title: "Role Model Propagation",
        objective: "Verify Droid missionSettings behavior",
        baseBranch: "main",
        ownerSessionId: "s1",
        roleModels: {
          validator: {
            model: "magpie/bp/claude-opus-5-5",
            thinkingLevel: "xhigh",
          },
        },
      });
      await engine.startRun(run.id);

      await engine.addMembers({
        name: "val-wait",
        role: "validator",
        brief: "Audit waiting",
      });
      await engine.addMembers({
        name: "val-custom",
        role: "validator",
        model: "openai/gpt-5.4",
        thinkingLevel: "medium",
        brief: "Custom model override",
      });
      await engine.addMembers({
        name: "val-busy",
        role: "validator",
        brief: "Audit busy",
      });

      await waitUntil(
        () =>
          transport.handles.get("val-wait")?.handle.getState() === "waiting" &&
          transport.handles.get("val-custom")?.handle.getState() === "waiting" &&
          transport.handles.has("val-busy"),
      );

      // Update validator role default: opus-5-5:xhigh -> gpt-6.2-astra:high
      currentSettings.validatorModel = "magpie/bp/gpt-6.2-astra";
      currentSettings.validatorThinkingLevel = "high";
      const propRes = await engine.propagateRoleModel({
        role: "validator",
        model: "magpie/bp/gpt-6.2-astra",
        thinkingLevel: "high",
        previousModel: "magpie/bp/claude-opus-5-5",
      });

      assert.deepEqual(propRes.switched, ["val-wait"]);
      assert.deepEqual(propRes.deferred, ["val-busy"]);
      assert.equal(transport.handles.get("val-wait")?.handle.getModel(), "magpie/bp/gpt-6.2-astra");
      assert.equal(transport.handles.get("val-wait")?.handle.getThinkingLevel(), "high");
      assert.equal(
        transport.handles.get("val-wait")?.wakePrompts.length,
        0,
        "Waiting member switched via role propagation must NOT receive an extra wake turn",
      );
      assert.equal(
        transport.handles.get("val-custom")?.handle.getModel(),
        "openai/gpt-5.4",
        "Explicit per-member override must NOT be clobbered by role propagation",
      );

      // Finish val-busy turn with no pending wakes -> switches silently and parks (turns === 1)
      releaseBusyTurn1();
      await waitUntil(() => transport.handles.get("val-busy")?.handle.getState() === "waiting");
      assert.equal(transport.handles.get("val-busy")?.handle.getModel(), "magpie/bp/gpt-6.2-astra");
      assert.equal(transport.handles.get("val-busy")?.handle.getThinkingLevel(), "high");
      assert.equal(engine.getSnapshot().run?.members["val-busy"]?.turns, 1);

      // Clear validator role to Inherit -> leaves existing members untouched
      currentSettings.validatorModel = undefined;
      currentSettings.validatorThinkingLevel = undefined;
      const clearRes = await engine.propagateRoleModel({
        role: "validator",
        model: undefined,
        thinkingLevel: undefined,
        previousModel: "magpie/bp/gpt-6.2-astra",
      });
      assert.deepEqual(clearRes.switched, []);
      assert.deepEqual(clearRes.deferred, []);
      assert.equal(transport.handles.get("val-wait")?.handle.getModel(), "magpie/bp/gpt-6.2-astra");

      // Deferred human switch with pending wakes queued mid-turn drains wake on the NEW model
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@val-busy check phase 2",
      });
      await waitUntil(() => engine.getSnapshot().run?.members["val-busy"]?.state === "working");
      const deferredSwitch = await engine.switchModel({
        targetName: "val-busy",
        model: "google/gemini-4-neon",
        thinkingLevel: "high",
        autoResume: false,
        deferIfWorking: true,
        callerName: "human",
        callerRole: "human",
      });
      assert.equal(deferredSwitch.deferred, true);

      // Queue wake BEFORE val-busy finishes its working turn
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@val-busy new review while finishing",
      });
      releaseBusyTurn2();
      await waitUntil(() => busyTurnModels.length === 3);
      assert.equal(busyTurnModels[2], "google/gemini-4-neon");
    } finally {
      await engine.dispose();
    }
  });

  it("v0.5.0: fixes worker guard absolute worktree paths & quotes, hardens validator bash checks, resets Zombie Effort, deduplicates :thinking 429 fallbacks on cold/warm members, and keeps host-inherited propagation silent", async () => {
    // 1. Worker guard allows absolute paths inside .pi/swarm/worktrees/... while protecting runs/state.json & outside root
    {
      const repoDir = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v050-guard-"));
      try {
        const wtPath = path.join(repoDir, ".pi", "swarm", "worktrees", "run-1", "wt-author");
        const req: SpawnMemberRequest = {
          agentId: "author-1",
          name: "author",
          role: "worker",
          runId: "run-1",
          cwd: wtPath,
          baseBranch: "main",
          workspace: "share",
          parentName: ORCHESTRATOR_NAME,
          brief: "Implement src/app.ts inside share worktree",
          systemPrompt: "worker",
          initialPrompt: "go",
          keepWarm: true,
        };
        let toolCallHandler: ((ev: any) => any) | undefined;
        createWorkerGuardExtensionFactory(req, "main")({
          on(ev: string, fn: (event: any) => any) {
            if (ev === "tool_call") toolCallHandler = fn;
          },
        } as any);
        assert.ok(toolCallHandler);

        assert.equal(
          toolCallHandler!({
            toolName: "write",
            input: { path: path.join(wtPath, "src", "app.ts") },
          }),
          undefined,
          "Worker write inside own .pi/swarm/worktrees/<run>/wt-author must succeed",
        );
        assert.equal(
          toolCallHandler!({
            toolName: "edit",
            input: { path: path.join(wtPath, "nested", "mod.ts") },
          }),
          undefined,
          "Worker edit inside own worktree must succeed",
        );
        assert.equal(
          toolCallHandler!({
            toolName: "write",
            input: { path: path.join(repoDir, ".pi", "swarm", "runs", "run-1", "state.json") },
          })?.block,
          true,
        );
        assert.equal(
          toolCallHandler!({
            toolName: "write",
            input: { path: path.join(repoDir, "src", "app.ts") },
          })?.block,
          true,
        );

        // Quoted shell strings containing "git merge" and benign /dev/null redirects are allowed; actual git merge/checkout main are blocked
        assert.equal(
          isForbiddenWorkerBashCommand('git commit -m "avoid git merge regression" && npm test 2>/dev/null', "main").allowed,
          true,
        );
        assert.equal(isForbiddenWorkerBashCommand("git merge main", "main").allowed, false);
        assert.equal(isForbiddenWorkerBashCommand("git checkout main", "main").allowed, false);

        // Validator guard blocks indirect destructors while allowing filenames like src/tee.test.ts
        assert.equal(isReadOnlyValidationCommand('bash -c "rm -rf src"').allowed, false);
        assert.equal(isReadOnlyValidationCommand("find . -delete").allowed, false);
        assert.equal(isReadOnlyValidationCommand("xargs rm").allowed, false);
        assert.equal(isReadOnlyValidationCommand("echo hi | tee out.txt").allowed, false);
        assert.equal(isReadOnlyValidationCommand("npx vitest run src/tee.test.ts").allowed, true);
        assert.equal(isReadOnlyValidationCommand("git diff --stat").allowed, true);
      } finally {
        await rm(repoDir, { recursive: true, force: true });
      }
    }

    // 2. InProcessPiTransport switchModel resets Zombie Effort back to model/settings default when thinkingLevel is cleared
    {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v050-effort-"));
      try {
        const thinkingCalls: ThinkingLevel[] = [];
        const modelA = {
          id: "gpt-5",
          provider: "openai",
          name: "GPT-5",
          reasoning: true,
        } as unknown as import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;

        const transport = new InProcessPiTransport({
          agentDir: tmpRoot,
          createSession: (async (opts?: { model?: unknown; sessionManager?: SessionManager }) => {
            let currentThinking: ThinkingLevel =
              (opts as { thinkingLevel?: ThinkingLevel } | undefined)?.thinkingLevel ??
              "medium";
            const fakeSession = {
              model: opts?.model ?? modelA,
              get thinkingLevel() {
                return currentThinking;
              },
              settingsManager: {
                getDefaultThinkingLevel: () => "medium" as ThinkingLevel,
              },
              sessionManager: opts?.sessionManager,
              extensionRunner: { hasHandlers: () => false, emit: async () => {} },
              bindExtensions: async () => {},
              subscribe: () => () => {},
              prompt: async () => {},
              steer: async () => {},
              followUp: async () => {},
              setModel: async () => true,
              setThinkingLevel: (lvl: ThinkingLevel) => {
                currentThinking = lvl;
                thinkingCalls.push(lvl);
              },
              abort: async () => {},
              dispose: () => {},
              getSessionStats: () => ({
                tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10 },
                cost: 0.001,
              }),
            } as unknown as AgentSession;
            return { session: fakeSession, extensionsResult: { extensions: [], errors: [], runtime: {} } };
          }) as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
        });

        const handle = await transport.spawnMember({
          agentId: "eff-1",
          name: "eff",
          role: "worker",
          runId: "run-eff",
          cwd: tmpRoot,
          workspace: "inherit",
          parentName: ORCHESTRATOR_NAME,
          brief: "Test effort reset",
          systemPrompt: "sys",
          initialPrompt: "go",
          modelOverride: "openai/gpt-5",
          thinkingLevel: "high",
          keepWarm: true,
          hostContext: {
            modelRegistry: {
              runtime: {
                getModels: () => [modelA],
                hasConfiguredAuth: () => true,
              },
            },
          } as unknown as ExtensionContext,
        });
        await waitUntil(() => handle.getState() === "waiting");
        assert.equal(handle.getThinkingLevel(), "high");

        const switched = await handle.switchModel("openai/gpt-5", undefined);
        assert.equal(switched.thinkingLevel, undefined);
        assert.equal(handle.getThinkingLevel(), undefined);
        assert.equal(thinkingCalls[thinkingCalls.length - 1], "medium");
        await handle.kill("cleanup");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    }

    // 3. :thinking 429 fallback skips same failing base model & recovers cold `stopped` (`keepWorkersWarm: false`) member cleanly
    {
      const { engine, transport, store } = await createTestHarness({
        stallWatchdogEnabled: false,
        keepWorkersWarm: false,
        workerModel: "openai/gpt-5",
        fallbackModels: ["openai/gpt-5:low", "google/gemini-2.5-pro:high"],
        maxRetries: 0,
        rateLimitBaseBackoffMs: 10,
        rateLimitMaxBackoffMs: 25,
      });
      await store.updateRun("run-dyn", { keepWorkersWarm: false });
      try {
        transport.onMember("cold429", async ({ model, thinkingLevel }) => {
          if (model === "openai/gpt-5") {
            return {
              outcome: "rate_limited",
              error: "HTTP 429 quota exceeded on gpt-5",
              retryAfterMs: 10,
            };
          }
          return {
            outcome: "stopped",
            summary: `Recovered cold turn on ${model}:${thinkingLevel}`,
          };
        });

        await engine.addMembers({ name: "cold429", brief: "Survive 429 in cold mode" });
        await waitUntil(
          () => engine.getSnapshot().run?.members.cold429?.state === "stopped",
          3000,
        );

        const member = engine.getSnapshot().run?.members.cold429;
        assert.equal(member?.model, "google/gemini-2.5-pro");
        assert.equal(member?.thinkingLevel, "high");
        assert.ok(
          !transport.spawns.some(
            (s) => s.name === "cold429" && s.modelOverride === "openai/gpt-5" && s.thinkingLevel === "low",
          ),
          "429 fallback must skip same base model openai/gpt-5:low and move straight to google/gemini-2.5-pro:high",
        );
      } finally {
        await engine.dispose();
      }
    }

    // 4. propagateRoleModel updates members spawned with host-inherited default & stays silent on message board
    {
      const { engine, store, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        workerModel: undefined,
      });
      try {
        transport.onMember("host-tracked", async () => ({
          outcome: "waiting",
          summary: "Parked cleanly",
        }));
        await engine.addMembers({
          name: "host-tracked",
          brief: "Spawned while workerModel was host-inherited",
        });
        await waitUntil(
          () => engine.getSnapshot().run?.members["host-tracked"]?.state === "waiting",
        );
        assert.notEqual(engine.getSnapshot().run?.members["host-tracked"]?.modelExplicit, true);

        const prop = await engine.propagateRoleModel({
          role: "worker",
          model: "anthropic/claude-sonnet-4-5",
          thinkingLevel: "high",
          previousModel: undefined,
        });
        assert.deepEqual(prop.switched, ["host-tracked"]);
        assert.equal(
          transport.handles.get("host-tracked")?.handle.getModel(),
          "anthropic/claude-sonnet-4-5",
        );
        assert.equal(
          transport.handles.get("host-tracked")?.handle.getThinkingLevel(),
          "high",
        );

        const board = await store.readBoard("run-dyn", { limit: 20 });
        assert.equal(
          board.messages.some((m) => m.kind === "model_switch"),
          false,
          "propagateRoleModel must not spam [model] messages onto the shared board",
        );
      } finally {
        await engine.dispose();
      }
    }
  });

  it("v0.5.1: fixes deferred role propagation flags, cold-worker breaker reset, telemetry/readSeq monotonic cache, attachRun normalization, completeRun/monitor races, guards, breaker wake, schemas & prompt cache", async () => {
    // 1. Deferred propagateRoleModel preserves silentBoardNotice & fromRolePropagation (modelExplicit stays false, no [model] spam)
    {
      const { engine, store, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        workerModel: "openai/gpt-5",
      });
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((r) => {
        releaseTurn = r;
      });
      let enteredTurn!: () => void;
      const enteredTurnP = new Promise<void>((r) => {
        enteredTurn = r;
      });
      transport.onMember("def-role", async ({ turnIndex }) => {
        if (turnIndex === 1) {
          enteredTurn();
          await turnGate;
        }
        return { outcome: "waiting", summary: "parked" };
      });
      try {
        await engine.addMembers({ name: "def-role", brief: "Work while role model changes" });
        await enteredTurnP;

        const prop1 = await engine.propagateRoleModel({
          role: "worker",
          model: "anthropic/claude-sonnet-4-5",
          thinkingLevel: "high",
        });
        assert.deepEqual(prop1.deferred, ["def-role"]);

        releaseTurn();
        await waitUntil(
          () =>
            engine.getSnapshot().run?.members["def-role"]?.state === "waiting" &&
            engine.getSnapshot().run?.members["def-role"]?.model === "anthropic/claude-sonnet-4-5",
        );

        const after1 = engine.getSnapshot().run?.members["def-role"];
        assert.equal(after1?.modelExplicit, false, "Deferred role propagation must keep modelExplicit=false");
        const boardAfter1 = await store.readBoard("run-dyn", { limit: 20 });
        assert.equal(
          boardAfter1.messages.some((m) => m.kind === "model_switch"),
          false,
          "Deferred role propagation must preserve silentBoardNotice",
        );

        // Subsequent role propagation must STILL track and switch this member!
        const prop2 = await engine.propagateRoleModel({
          role: "worker",
          model: "google/gemini-2.5-pro",
          thinkingLevel: "medium",
        });
        assert.deepEqual(prop2.switched, ["def-role"]);
      } finally {
        releaseTurn?.();
        await engine.dispose();
      }
    }

    // 2. Cold worker (`keepWorkersWarm: false`) normal completions reset RateLimitBreaker and live.retryCount
    {
      const { engine, store, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        keepWorkersWarm: false,
        maxRetries: 1,
        rateLimitBaseBackoffMs: 25,
        rateLimitMaxBackoffMs: 100,
      });
      await store.updateRun("run-dyn", { keepWorkersWarm: false });
      try {
        let count = 0;
        transport.onMember("cold-rl", async () => {
          count += 1;
          // Attempt 1 (turn 1): 429; Attempt 2 (retry 1): ok; Attempt 3 (turn 2): 429; Attempt 4 (retry 1): ok
          if (count === 1 || count === 3) {
            return { outcome: "rate_limited", error: "429 transient", retryAfterMs: 10 };
          }
          return { outcome: "stopped", stopReason: "end_turn", summary: "ok" };
        });

        await engine.addMembers({ name: "cold-rl", brief: "Cold worker retry reset" });
        await waitUntil(
          () => count >= 2 && engine.getSnapshot().run?.members["cold-rl"]?.state === "stopped",
          3000,
        );
        assert.equal(count, 2);

        // Second turn hitting 429 would fail retry budget if retryCount wasn't reset by cold completion!
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@cold-rl second turn",
        });
        await waitUntil(
          () => count >= 4 && engine.getSnapshot().run?.members["cold-rl"]?.state === "stopped",
          3000,
        );
        assert.equal(count, 4);
      } finally {
        await engine.dispose();
      }
    }

    // 3. Monotonic live tokens/cost/lastReadSeq survive setCachedRun & floor waitForBoard(mentions_only:false)
    {
      const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
      let releaseTurn!: () => void;
      const gate = new Promise<void>((r) => {
        releaseTurn = r;
      });
      let entered!: () => void;
      const enteredP = new Promise<void>((r) => {
        entered = r;
      });
      let capturedBridge: NonNullable<SpawnMemberRequest["engineApi"]> | undefined;
      transport.onMember("mono-w", async ({ request, turnIndex }) => {
        capturedBridge = request.engineApi;
        if (turnIndex === 1) {
          request.onTelemetry?.({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            runId: request.runId,
            type: "turn_end",
            timestamp: new Date().toISOString(),
            tokens: 420,
            tokenBreakdown: { input: 300, output: 120, cacheRead: 0, cacheWrite: 0, total: 420 },
            cost: 0.042,
          });
          entered();
          await gate;
        }
        return { outcome: "waiting", summary: "parked", tokens: 420, cost: 0.042 };
      });
      try {
        await engine.addMembers({ name: "mono-w", brief: "Check monotonic live stats" });
        await enteredP;

        // Post an unrelated message and have mono-w read it via bridge
        const p2 = await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "FYI board post",
        });
        await capturedBridge!.readBoard({ since: 0 });

        // Trigger concurrent setCachedRun via another postMessage
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "Second FYI post",
        });

        const mid = engine.getSnapshot().run?.members["mono-w"];
        assert.ok((mid?.tokens ?? 0) >= 420, "live tokens must survive setCachedRun");
        assert.ok((mid?.cost ?? 0) >= 0.042, "live cost must survive setCachedRun");
        assert.ok((mid?.lastReadSeq ?? 0) >= p2.seq, "live lastReadSeq must survive setCachedRun");

        releaseTurn();
        await waitUntil(() => engine.getSnapshot().run?.members["mono-w"]?.state === "waiting");
        assert.ok((engine.getSnapshot().run?.members["mono-w"]?.lastReadSeq ?? 0) >= p2.seq);

        // Detach & reattach -> orphan waiting becomes stopped; revived member calling swarm_wait{since:0, mentions_only:false}
        // must NOT re-receive messages <= member.lastReadSeq!
        await engine.attachRun(null);
        const reattached = await engine.attachRun("run-dyn");
        assert.equal(reattached.run?.members["mono-w"]?.state, "stopped");
        const savedReadSeq = reattached.run?.members["mono-w"]?.lastReadSeq ?? 0;
        assert.ok(savedReadSeq >= p2.seq);

        let secondReviveTurns = 0;
        transport.onMember("mono-w", async ({ request }) => {
          secondReviveTurns += 1;
          request.onTelemetry?.({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            runId: request.runId,
            type: "waiting",
            timestamp: new Date().toISOString(),
            logLine: "swarm_wait since=#0 mentions_only=false",
          });
          return { outcome: "waiting", summary: "parked after revive" };
        });
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@mono-w revive and wait with since=0",
        });
        await waitUntil(
          () =>
            secondReviveTurns === 1 &&
            engine.getSnapshot().run?.members["mono-w"]?.state === "waiting",
        );
        // Wait briefly to confirm no spurious re-wakeup from old messages
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(secondReviveTurns, 1, "Flooring waitForBoard with member.lastReadSeq prevents re-delivering old messages");
      } finally {
        releaseTurn?.();
        await engine.dispose();
      }
    }

    // 4. Working members persisted as stopped on detach/dispose; completeRun blocks postMessage/addMembers; concurrent propagateRoleModel serializes roleModels
    {
      const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
      let releaseTurn!: () => void;
      const gate = new Promise<void>((r) => {
        releaseTurn = r;
      });
      let entered!: () => void;
      const enteredP = new Promise<void>((r) => {
        entered = r;
      });
      transport.onMember("busy-detach", async () => {
        entered();
        await gate;
        return { outcome: "waiting", summary: "done" };
      });
      try {
        await engine.addMembers({ name: "busy-detach", brief: "Stay working during detach" });
        await enteredP;

        await engine.attachRun(null);
        const persisted = await store.loadRun("run-dyn");
        assert.equal(
          persisted.members["busy-detach"]?.state,
          "stopped",
          "attachRun(null) must persist live working members as stopped before disposing handles",
        );

        await engine.attachRun("run-dyn");
        await Promise.all([
          engine.propagateRoleModel({ role: "worker", model: "openai/gpt-5", thinkingLevel: "medium" }),
          engine.propagateRoleModel({ role: "validator", model: "anthropic/claude-opus-4-6", thinkingLevel: "high" }),
        ]);
        const afterRoleRace = await store.loadRun("run-dyn");
        assert.equal(afterRoleRace.roleModels.worker?.model, "openai/gpt-5");
        assert.equal(afterRoleRace.roleModels.validator?.model, "anthropic/claude-opus-4-6");

        // completeRun sets runDonePosted and blocks concurrent postMessage/addMembers
        const origPost = store.postBoardMessage.bind(store);
        let postEntered!: () => void;
        let releasePost!: () => void;
        const postEnteredP = new Promise<void>((r) => {
          postEntered = r;
        });
        const releasePostP = new Promise<void>((r) => {
          releasePost = r;
        });
        store.postBoardMessage = async (rId, msg) => {
          if (msg.kind === "done") {
            postEntered();
            await releasePostP;
          }
          return origPost(rId, msg);
        };
        const doneP = engine.completeRun({ summary: "Closing run" });
        await postEnteredP;
        await assert.rejects(
          () => engine.postMessage({ from: ORCHESTRATOR_NAME, fromRole: "orchestrator", text: "late" }),
          (err) => err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
        );
        await assert.rejects(
          () => engine.addMembers({ name: "late-worker", brief: "too late" }),
          (err) => err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
        );
        releasePost();
        await doneP;
      } finally {
        releaseTurn?.();
        await engine.dispose();
      }
    }

    // 5. Transport symlink containment, case-insensitive protected paths, shell mask & guard precision, thinking clamp
    {
      const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "swarm-v051-guard-"));
      try {
        const outsideDir = path.join(tmpRoot, "outside");
        const wtDir = path.join(tmpRoot, "wt");
        await mkdir(outsideDir, { recursive: true });
        await mkdir(path.join(wtDir, ".git"), { recursive: true });
        await writeFile(path.join(outsideDir, "secret.txt"), "secret");
        await symlink(outsideDir, path.join(wtDir, "escape-dir"));
        await symlink(path.join(outsideDir, "missing.txt"), path.join(wtDir, "dangling-escape"));
        await symlink(path.join(wtDir, ".git"), path.join(wtDir, "git-link"));

        assert.equal(resolveWorktreeRelativePath(wtDir, "escape-dir/secret.txt"), null);
        assert.equal(resolveWorktreeRelativePath(wtDir, "escape-dir/new-file.txt"), null);
        assert.equal(resolveWorktreeRelativePath(wtDir, "dangling-escape"), null);
        assert.equal(resolveWorktreeRelativePath(wtDir, "git-link/config"), ".git/config");
        assert.equal(isProtectedSwarmPath(".git/config"), true);
        if (process.platform === "darwin" || process.platform === "win32") {
          assert.equal(isProtectedSwarmPath(".GIT/config"), true);
          assert.equal(isProtectedSwarmPath(".Pi/Swarm/runs/1/state.json"), true);
        }
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }

      // Nested quotes/escapes in $(...) and backticks + single-token quoted/escaped commands
      assert.equal(isReadOnlyValidationCommand(`echo "$(echo ')'; rm -rf /)"`).allowed, false);
      assert.equal(isForbiddenWorkerBashCommand(`echo "$(echo ')'; git push)"`, "main").allowed, false);
      assert.equal(isReadOnlyValidationCommand('echo "`echo \'`\' ; rm -rf /`"').allowed, false);
      assert.equal(isReadOnlyValidationCommand("'rm' -rf /tmp/x").allowed, false);
      assert.equal(isReadOnlyValidationCommand("r\\m -rf /tmp/x").allowed, false);
      assert.equal(isReadOnlyValidationCommand("$'rm' -rf /tmp/x").allowed, false);
      assert.equal(isReadOnlyValidationCommand("'sh' -c \"rm -rf /tmp/x\"").allowed, false);
      assert.equal(isForbiddenWorkerBashCommand('"git" push', "main").allowed, false);
      assert.equal(isForbiddenWorkerBashCommand("git 'merge' feat", "main").allowed, false);

      // Wrapper & flag expansions
      assert.equal(isReadOnlyValidationCommand("timeout 5 rm -rf /tmp/x").allowed, false);
      assert.equal(isReadOnlyValidationCommand("time rm -rf /tmp/x").allowed, false);
      assert.equal(isReadOnlyValidationCommand("nice -n 10 rm -rf /tmp/x").allowed, false);
      assert.equal(isReadOnlyValidationCommand("{ rm -rf /tmp/x; }").allowed, false);
      assert.equal(isReadOnlyValidationCommand("env -i rm -rf /tmp/x").allowed, false);
      assert.equal(isReadOnlyValidationCommand("cat files | xargs -0 rm").allowed, false);
      assert.equal(isReadOnlyValidationCommand("git branch --delete feat").allowed, false);
      assert.equal(isReadOnlyValidationCommand("npm --prefix . install").allowed, false);

      // False-positive fixes: file paths containing eval/bash and git inspection flags
      assert.equal(isReadOnlyValidationCommand('grep -n "rm -rf" src/eval.ts').allowed, true);
      assert.equal(isReadOnlyValidationCommand("npx vitest run tests/bash/guard.test.ts").allowed, true);
      assert.equal(isReadOnlyValidationCommand("git grep -n push").allowed, true);
      assert.equal(isReadOnlyValidationCommand("git diff -U3 add").allowed, true);
      assert.equal(isReadOnlyValidationCommand("git show --stat merge").allowed, true);
      assert.equal(isReadOnlyValidationCommand("git diff feature-branch -M").allowed, true);

      // Worker checkoutBaseRe flags
      assert.equal(isForbiddenWorkerBashCommand("git checkout -b main", "main").allowed, false);
      assert.equal(isForbiddenWorkerBashCommand("git checkout -B main", "main").allowed, false);
      assert.equal(isForbiddenWorkerBashCommand("git switch -c main", "main").allowed, false);
      assert.equal(isForbiddenWorkerBashCommand("git switch -C main", "main").allowed, false);
      assert.equal(isForbiddenWorkerBashCommand("git checkout --force main", "main").allowed, false);

      // RateLimitBreaker.recordSuccess wakes waitIfBackedOff sleepers promptly
      const breaker = new RateLimitBreaker({ baseBackoffMs: 5000, maxBackoffMs: 5000 });
      breaker.recordRateLimit(5000, "429");
      const started = Date.now();
      const waitP = breaker.waitIfBackedOff();
      setTimeout(() => breaker.recordSuccess(), 15);
      await waitP;
      assert.ok(Date.now() - started < 500, "recordSuccess() must wake waitIfBackedOff promptly");

      // swarm-tools: effort-only orchestrator fallback, validator role enum, integer schemas, zero Type.Union/anyOf/oneOf
      const { engine } = await createTestHarness({ stallWatchdogEnabled: false });
      try {
        let capturedModelArg = "";
        const orchTools = createSwarmTools({
          engine,
          onOrchestratorModelSwitch: async (model, thinkingLevel) => {
            capturedModelArg = model;
            return { targetName: ORCHESTRATOR_NAME, model: model || "", thinkingLevel };
          },
        });
        const orchSwarm = orchTools.find((t) => t.name === SWARM_TOOL)!;
        const switchRes = await orchSwarm.execute(
          "tc-effort",
          { action: "model", thinking_level: "high" },
          undefined,
          undefined,
          { model: { provider: "openai", id: "gpt-5.4" } } as unknown as ExtensionToolContext,
        );
        assert.equal(capturedModelArg, "openai/gpt-5.4");
        assert.ok((switchRes.content[0] as { text: string }).text.includes("openai/gpt-5.4 (high)"));

        // Without ctx.model -> falls back to "host-default" in message
        const fallbackRes = await orchSwarm.execute(
          "tc-effort-2",
          { action: "model", thinking_level: "medium" },
          undefined,
          undefined,
          {} as ExtensionToolContext,
        );
        assert.ok((fallbackRes.content[0] as { text: string }).text.includes("host-default (medium)"));

        const valTools = createMemberScopedTools(
          {
            postMessage: async () => {
              throw new Error("unused");
            },
            readBoard: async () => ({ messages: [], head: 0 }),
            getStatus: async () => ({
              runId: "run-dyn",
              title: "t",
              status: "active",
              baseBranch: "main",
              boardHead: 0,
              members: [],
              channels: [],
            }),
            listModels: async () => [],
            addHelper: async () => [],
            killHelper: async () => {},
            switchModel: async () => ({ targetName: "v1", model: "m" }),
            manageChannel: async () => ({ action: "list", summary: "" }),
          },
          { name: "v1", role: "validator", runId: "run-dyn" },
        );
        const valSwarm = valTools.find((t) => t.name === SWARM_TOOL)!;
        const roleSchema = (valSwarm.parameters as unknown as { properties: Record<string, { enum?: string[] }> }).properties.role;
        assert.deepEqual(roleSchema?.enum, ["validator"]);
        for (const tool of [...orchTools, ...valTools]) {
          const schemaJson = JSON.stringify(tool.parameters);
          assert.equal(schemaJson.includes('"anyOf"'), false);
          assert.equal(schemaJson.includes('"oneOf"'), false);
        }

        // role-prompts: static section unchanged when roleModels change, live state includes 3-Role Models
        const snap1 = engine.getSnapshot();
        const static1 = buildOrchestratorStaticSection(snap1);
        const live1 = buildOrchestratorLiveStateSection(snap1);
        assert.equal(static1.includes("3-Role Models**: orchestrator="), false);
        assert.equal(live1.includes("3-Role Models**: orchestrator="), true);
        await engine.propagateRoleModel({ role: "worker", model: "google/gemini-2.5-pro" });
        const static2 = buildOrchestratorStaticSection(engine.getSnapshot());
        assert.equal(static2, static1, "Static section must stay cache-identical when roleModels update");
      } finally {
        await engine.dispose();
      }
    }

    // 6. resolveModel clamps thinkingLevel when model.reasoning === false; attachRun serializes concurrent calls; monitorRunning is not clobbered by old monitor finally
    {
      const nonReasoningTransport = new InProcessPiTransport();
      const nonReasoningCtx = {
        modelRegistry: {
          getAll: () => [
            { id: "gpt-4o-mini", provider: "openai", name: "GPT-4o Mini", reasoning: false },
            { id: "claude-sonnet-4-5", provider: "anthropic", name: "Sonnet", reasoning: true },
          ],
          getAvailable: () => [
            { id: "gpt-4o-mini", provider: "openai", name: "GPT-4o Mini", reasoning: false },
            { id: "claude-sonnet-4-5", provider: "anthropic", name: "Sonnet", reasoning: true },
          ],
          hasConfiguredAuth: () => true,
        },
      } as unknown as ExtensionContext;
      const clamped = await nonReasoningTransport.resolveModel("openai/gpt-4o-mini", "high", nonReasoningCtx);
      assert.equal(clamped.model, "openai/gpt-4o-mini");
      assert.equal(clamped.thinkingLevel, "off");
      const unclamped = await nonReasoningTransport.resolveModel("anthropic/claude-sonnet-4-5", "high", nonReasoningCtx);
      assert.equal(unclamped.thinkingLevel, "high");

      // Concurrent attachRun calls serialize without interleaving
      const { engine, store } = await createTestHarness({ stallWatchdogEnabled: false });
      try {
        await store.createRun({
          id: "run-second",
          title: "Second",
          objective: "Second run",
          baseBranch: "main",
          ownerSessionId: "sess-1",
        });
        const events: string[] = [];
        const origLoad = store.loadRun.bind(store);
        store.loadRun = async (id) => {
          events.push(`load-start:${id}`);
          await new Promise((r) => setTimeout(r, id === "run-dyn" ? 25 : 5));
          events.push(`load-end:${id}`);
          return origLoad(id);
        };
        await Promise.all([engine.attachRun("run-dyn"), engine.attachRun("run-second")]);
        assert.ok(events.length >= 4 && events.length % 2 === 0);
        for (let i = 0; i < events.length; i += 2) {
          const startId = events[i]!.replace(/^load-start:/, "");
          assert.equal(events[i], `load-start:${startId}`);
          assert.equal(events[i + 1], `load-end:${startId}`, "Concurrent attachRun calls must never interleave");
        }
        assert.equal(events[0], "load-start:run-dyn");
        assert.equal(events[events.length - 1], "load-end:run-second");
        assert.equal(engine.getSnapshot().activeRunId, "run-second");
      } finally {
        await engine.dispose();
      }

      // Cancelled monitor's late finally does not clear monitorRunning for a newer active monitor
      const { engine: monEngine, transport: monTransport } = await createTestHarness({
        stallWatchdogEnabled: true,
        stallMonitorMode: "llm",
        stallTimeoutMs: 20,
      });
      let mon1Entered!: () => void;
      let releaseMon1!: () => void;
      const mon1EnteredP = new Promise<void>((r) => {
        mon1Entered = r;
      });
      const releaseMon1P = new Promise<void>((r) => {
        releaseMon1 = r;
      });
      let mon2Entered!: () => void;
      let releaseMon2!: () => void;
      const mon2EnteredP = new Promise<void>((r) => {
        mon2Entered = r;
      });
      const releaseMon2P = new Promise<void>((r) => {
        releaseMon2 = r;
      });
      let monSpawnCount = 0;
      const origSpawn = monTransport.spawnMember.bind(monTransport);
      monTransport.spawnMember = async (req) => {
        if (req.isMonitor) {
          monSpawnCount += 1;
          if (monSpawnCount === 1) {
            mon1Entered();
            await releaseMon1P;
          } else if (monSpawnCount === 2) {
            mon2Entered();
            await releaseMon2P;
          }
        }
        return origSpawn(req);
      };
      try {
        await monEngine.addMembers({ name: "mon-w", brief: "Park to trigger monitor" });
        await waitUntil(() => monEngine.getSnapshot().run?.members["mon-w"]?.state === "waiting");
        await mon1EnteredP;
        // Activity cancels monitor #1 while its spawnMember is still awaiting releaseMon1P
        await monEngine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "Reset watchdog for monitor #2",
        });
        await mon2EnteredP;
        // Now let monitor #1 finish unwinding while monitor #2 is active
        releaseMon1();
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(
          (monEngine as unknown as { monitorRunning: boolean }).monitorRunning,
          true,
          "Old cancelled monitor's finally must not clear monitorRunning while a newer monitor is active",
        );
        releaseMon2();
        await waitUntil(() => !(monEngine as unknown as { monitorRunning: boolean }).monitorRunning);
      } finally {
        releaseMon1?.();
        releaseMon2?.();
        await monEngine.dispose();
      }
    }
  });
});

// ============================================================================
// v0.6.0 Silent-Turn Digest, Merge Conflict/Noop Diagnostics & Worker Guards
// ============================================================================

describe("SwarmEngine & Runtime — v0.6.0 Diagnostics & Self-Correcting Guards", () => {
  it("delivers silent-turn summaries once in all_idle wakeups (parked, immediate, multi-turn & stopped) without extra board posts and widens parkedOn to 240 chars", async () => {
    const { engine, store, transport } = await createTestHarness({ stallWatchdogEnabled: false });
    const wakeEvents: SwarmEngineEvent[] = [];
    engine.subscribe((ev) => {
      if (ev.type === "wakeup_needed") wakeEvents.push(ev);
    });

    try {
      let releaseSilent!: () => void;
      const silentGate = new Promise<void>((r) => {
        releaseSilent = r;
      });
      const longSilentText =
        `Implemented parser\n   and verified 14 edge cases — ` + "x".repeat(290) + " TAIL_CUTOFF";

      transport.onMember("worker-a", async () => {
        await silentGate;
        return { outcome: "waiting", summary: longSilentText };
      });

      transport.onMember("worker-b", async ({ request, turnIndex }) => {
        if (turnIndex === 1) {
          await request.engineApi!.postMessage({
            text: "Progress update on worker-b without mentioning orchestrator",
          });
          return { outcome: "waiting", summary: "Posted progress note" };
        }
        // Turn 2: forgets post_message even though lastPostSeq > 0 from Turn 1!
        return { outcome: "waiting", summary: "Turn 2 silent fix completed" };
      });

      transport.onMember("waiter-c", async ({ request }) => {
        request.onTelemetry?.({
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          runId: request.runId,
          type: "waiting",
          activity: "waiting (since #3)",
          logLine: "swarm_wait since=#3 mentions_only=true",
          timestamp: new Date().toISOString(),
        });
        return { outcome: "waiting", summary: "Parked intentionally via swarm_wait" };
      });

      await engine.addMembers({ name: "worker-a", brief: "Implement parser" });
      await engine.addMembers({ name: "worker-b", brief: "Implement formatter" });
      await engine.addMembers({ name: "waiter-c", brief: "Stand by on swarm_wait" });

      // Wait until worker-b and waiter-c park while worker-a is still working
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["worker-b"]?.state === "waiting" &&
          engine.getSnapshot().run?.members["waiter-c"]?.state === "waiting",
      );
      const headBeforeIdle = engine.getSnapshot().boardHead;

      const parkRes = await engine.parkOrchestratorWait({ since: headBeforeIdle });
      assert.equal(parkRes.parked, true);

      // Finish worker-a silently -> triggers checkAllIdleAndNotifyWaiters wakeup_needed
      releaseSilent();
      await waitUntil(() => wakeEvents.length === 1);

      // Exact #seq determinism: ZERO extra board.jsonl messages posted!
      assert.equal(engine.getSnapshot().boardHead, headBeforeIdle);
      assert.equal((await store.readBoard("run-dyn", { limit: 50 })).head, headBeforeIdle);

      // parkedOn widened from 120 to 240 chars
      const memberA = engine.getSnapshot().run!.members["worker-a"]!;
      assert.equal(memberA.parkedOn!.length, 240);

      // Wakeup summary includes normalized 300-char silent summary for worker-a, NOT worker-b or waiter-c
      const wakeupSummary = wakeEvents[0]!.summary;
      const expectedNormalized300 = longSilentText.replace(/\s+/g, " ").trim().slice(0, 300);
      assert.ok(wakeupSummary.includes("Unposted turn summaries:"));
      assert.ok(wakeupSummary.includes(`@worker-a: "${expectedNormalized300}"`));
      assert.ok(!wakeupSummary.includes("TAIL_CUTOFF"));
      assert.ok(!wakeupSummary.includes('@worker-b: "'));
      assert.ok(!wakeupSummary.includes('@waiter-c: "'));

      // Cleared once delivered: subsequent immediate parkOrchestratorWait does NOT repeat stale summary
      const secondIdle = await engine.parkOrchestratorWait({ since: headBeforeIdle });
      assert.equal(secondIdle.parked, false);
      assert.equal(secondIdle.wokeBy, "all_idle");
      assert.ok(!secondIdle.summary.includes("Unposted turn summaries:"));

      // Multi-turn turnStartPostSeq + immediate parkOrchestratorWait/waitForBoard return:
      // Wake worker-b (which had lastPostSeq > 0 from Turn 1); it finishes Turn 2 silently BEFORE orchestrator waits!
      const wakeMsg = await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@worker-b run turn 2",
      });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["worker-b"]?.turns === 2 &&
          engine.getSnapshot().workingMemberNames.length === 0,
      );

      // Nobody was waiting when Turn 2 finished, so immediate parkOrchestratorWait delivers Turn 2 silent summary!
      const immediateIdle = await engine.parkOrchestratorWait({ since: wakeMsg.seq });
      assert.equal(immediateIdle.parked, false);
      assert.equal(immediateIdle.wokeBy, "all_idle");
      assert.ok(
        immediateIdle.summary.includes('Unposted turn summaries: @worker-b: "Turn 2 silent fix completed"'),
      );

      // Consumed once -> subsequent waitForBoard does NOT repeat it
      const postConsumeWait = await engine.waitForBoard({ since: wakeMsg.seq });
      assert.equal(postConsumeWait.wokeBy, "all_idle");
      assert.ok(!postConsumeWait.summary.includes("Unposted turn summaries:"));
    } finally {
      await engine.dispose();
    }

    // Also verify keepWorkersWarm: false ("stopped" normal non-aborted vs aborted branches)
    const coldStore = new MockSwarmStore();
    const coldWorktree = new MockWorktreeManager();
    const coldTransport = new ScriptedTransport();
    const coldEngine = new SwarmEngine({
      store: coldStore,
      worktree: coldWorktree,
      transport: coldTransport,
      settings: { stallWatchdogEnabled: false, keepWorkersWarm: false },
    });
    try {
      const coldRun = await coldStore.createRun({
        id: "run-cold-silent",
        title: "Cold Silent Test",
        objective: "Verify stopped outcome silent summary & 240-char parkedOn",
        baseBranch: "main",
        ownerSessionId: "sess-cold",
        keepWorkersWarm: false,
      });
      await coldEngine.startRun(coldRun.id);

      const coldLong = "Cold worker finished analysis — " + "y".repeat(230);
      coldTransport.onMember("cold-ok", async () => ({
        outcome: "stopped",
        summary: coldLong,
      }));
      coldTransport.onMember("cold-aborted", async () => ({
        outcome: "stopped",
        stopReason: "aborted",
        summary: "Aborted mid-flight",
      }));

      await coldEngine.addMembers({ name: "cold-ok", brief: "Analyze cold" });
      await coldEngine.addMembers({ name: "cold-aborted", brief: "Abort cold" });
      await waitUntil(() => coldEngine.getSnapshot().workingMemberNames.length === 0);

      assert.equal(coldEngine.getSnapshot().run!.members["cold-ok"]!.parkedOn!.length, 240);
      const coldWait = await coldEngine.waitForBoard({
        since: coldEngine.getSnapshot().boardHead,
      });
      assert.equal(coldWait.wokeBy, "all_idle");
      assert.ok(coldWait.summary.includes('@cold-ok: "Cold worker finished analysis'));
      assert.ok(
        !coldWait.summary.includes("@cold-aborted:"),
        "Aborted stopped turns must not be reported as unposted turn summaries",
      );
    } finally {
      await coldEngine.dispose();
    }
  });

  it("includes conflictFiles and post_message recovery instructions on REBASE_CONFLICT and skips mergedCommitSha on noop merges", async () => {
    const { engine, store, transport, worktree } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    const engineEvents: SwarmEngineEvent[] = [];
    engine.subscribe((ev) => engineEvents.push(ev));

    try {
      const [coder] = await engine.addMembers({
        name: "coder",
        role: "worker",
        workspace: "share",
        brief: "Implement isolated change",
      });
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // 1. REBASE_CONFLICT lists exact conflictFiles + @member post_message + worktree cwd recovery instructions
      worktree.rebaseResult = {
        status: "conflict",
        conflictFiles: ["src/runtime/engine.ts", "src/runtime/transport.ts"],
      };
      await assert.rejects(
        () => engine.mergeMember("coder"),
        (err: unknown) => {
          assert.ok(err instanceof SwarmProtocolError);
          assert.equal(err.code, "REBASE_CONFLICT");
          assert.ok(err.message.includes("src/runtime/engine.ts, src/runtime/transport.ts"));
          assert.ok(err.message.includes("@coder"));
          assert.ok(err.message.includes("post_message"));
          assert.ok(err.message.includes(coder!.cwd));
          assert.match(err.message, /re-commit/i);
          assert.deepEqual(err.details?.conflictFiles, [
            "src/runtime/engine.ts",
            "src/runtime/transport.ts",
          ]);
          assert.equal(err.details?.worktreePath, coder!.cwd);
          return true;
        },
      );

      // 2. noop merge (0 commits ahead) does NOT set mergedCommitSha and records 0 commits ahead in event summary
      worktree.rebaseResult = { status: "up-to-date" };
      const origMergeBranch = worktree.mergeBranch.bind(worktree);
      worktree.mergeBranch = async () => ({
        mergedCommitSha: "1111111111111111111111111111111111111111",
        strategy: "noop",
        changedFiles: [],
      });

      const noopRes = await engine.mergeMember("coder");
      assert.ok(noopRes);
      assert.equal(noopRes!.strategy, "noop");
      assert.equal(
        engine.getSnapshot().run?.members.coder?.mergedCommitSha,
        undefined,
        "noop merge must NOT set mergedCommitSha on member record",
      );
      assert.ok(
        store.events.some(
          (e) =>
            e.type === "member_merged" &&
            e.memberName === "coder" &&
            e.summary.includes("@coder") &&
            e.summary.includes("0 commits ahead of main"),
        ),
        "Ledger event summary must note @coder had 0 commits ahead of main",
      );
      assert.ok(
        engineEvents.some(
          (e) =>
            e.memberName === "coder" &&
            e.summary.includes("@coder") &&
            e.summary.includes("0 commits ahead of main"),
        ),
        "Engine event summary must note @coder had 0 commits ahead of main",
      );

      // Verify member bridge.getStatus() exposes cwd and omits mergedCommitSha after noop merge
      const coderBridge = transport.handles.get("coder")!.request.engineApi!;
      const statusBeforeRealMerge = await coderBridge.getStatus();
      const coderEntryBefore = statusBeforeRealMerge.members.find(
        (m) => m.name === "coder",
      ) as (typeof statusBeforeRealMerge.members)[number] & {
        cwd?: string;
        mergedCommitSha?: string;
      };
      assert.equal(coderEntryBefore?.cwd, coder!.cwd);
      assert.equal(coderEntryBefore?.mergedCommitSha, undefined);

      // Restore normal mergeBranch and verify real merge still sets mergedCommitSha
      worktree.mergeBranch = origMergeBranch;
      const realMerge = await engine.mergeMember("coder");
      assert.equal(realMerge?.strategy, "merge");
      assert.equal(
        engine.getSnapshot().run?.members.coder?.mergedCommitSha,
        worktree.nextMergeSha,
      );

      // Verify member bridge.getStatus() exposes both cwd and mergedCommitSha after real merge
      const statusAfterRealMerge = await coderBridge.getStatus();
      const coderEntryAfter = statusAfterRealMerge.members.find(
        (m) => m.name === "coder",
      ) as (typeof statusAfterRealMerge.members)[number] & {
        cwd?: string;
        mergedCommitSha?: string;
      };
      assert.equal(coderEntryAfter?.cwd, coder!.cwd);
      assert.equal(coderEntryAfter?.mergedCommitSha, worktree.nextMergeSha);
    } finally {
      await engine.dispose();
    }
  });

  it("includes worker exact cwd and isolated branch in blocked write, edit, and bash guard error reasons", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v060-guard-"));
    try {
      const wtPath = path.join(repoDir, ".pi", "swarm", "worktrees", "run-v060", "wt-worker-1");
      const branchName = "swarm/run-v060/worker-1";
      const shareReq: SpawnMemberRequest = {
        agentId: "worker-1-id",
        name: "worker-1",
        role: "worker",
        runId: "run-v060",
        cwd: wtPath,
        branch: branchName,
        baseBranch: "main",
        workspace: "share",
        isIsolatedWorktree: true,
        parentName: ORCHESTRATOR_NAME,
        brief: "Edit files inside isolated worktree",
        systemPrompt: "sys",
        initialPrompt: "go",
        keepWarm: true,
      };

      let shareGuard!: (ev: any) => any;
      createWorkerGuardExtensionFactory(shareReq, "main")({
        on(ev: string, fn: (event: any) => any) {
          if (ev === "tool_call") shareGuard = fn;
        },
      } as any);

      // 1. Accidental repoRoot write -> blocked with exact wtPath + branchName
      const blockedWrite = shareGuard({
        toolName: "write",
        input: { path: path.join(repoDir, "src", "engine.ts") },
      });
      assert.equal(blockedWrite?.block, true);
      assert.ok(String(blockedWrite?.reason).includes(wtPath));
      assert.ok(String(blockedWrite?.reason).includes(branchName));

      // 2. Protected path edit inside worktree (.git/config) -> blocked with exact wtPath + branchName
      const blockedEdit = shareGuard({
        toolName: "edit",
        input: { path: ".git/config" },
      });
      assert.equal(blockedEdit?.block, true);
      assert.ok(String(blockedEdit?.reason).includes(wtPath));
      assert.ok(String(blockedEdit?.reason).includes(branchName));

      // 3. Forbidden bash command -> blocked with exact wtPath + branchName
      const blockedBash = shareGuard({
        toolName: "bash",
        input: { command: "git checkout main" },
      });
      assert.equal(blockedBash?.block, true);
      assert.ok(String(blockedBash?.reason).includes(wtPath));
      assert.ok(String(blockedBash?.reason).includes(branchName));

      // 4. inherit workspace includes exact cwd without branch label
      const inheritReq: SpawnMemberRequest = {
        ...shareReq,
        cwd: repoDir,
        branch: "should-not-appear",
        workspace: "inherit",
        isIsolatedWorktree: false,
      };
      let inheritGuard!: (ev: any) => any;
      createWorkerGuardExtensionFactory(inheritReq, "main")({
        on(ev: string, fn: (event: any) => any) {
          if (ev === "tool_call") inheritGuard = fn;
        },
      } as any);

      const inheritBlockedWrite = inheritGuard({
        toolName: "write",
        input: { path: path.join(path.dirname(repoDir), "outside.ts") },
      });
      assert.equal(inheritBlockedWrite?.block, true);
      assert.ok(String(inheritBlockedWrite?.reason).includes(repoDir));
      assert.ok(!String(inheritBlockedWrite?.reason).includes("should-not-appear"));

      const inheritBlockedBash = inheritGuard({
        toolName: "bash",
        input: { command: "git push origin main" },
      });
      assert.equal(inheritBlockedBash?.block, true);
      assert.ok(String(inheritBlockedBash?.reason).includes(repoDir));
      assert.ok(!String(inheritBlockedBash?.reason).includes("should-not-appear"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Suite 18: v0.7.0 Live Telemetry, Token Flush, Recovery & Safety Fixes
// ============================================================================

describe("SwarmEngine & Runtime — v0.7.0 Live Telemetry, Recovery & Safety Fixes", () => {
  it("1. flushes live tokens, cost, tokenBreakdown, llmTurns & logTail when stopping working members on dispose/detach/stop", async () => {
    const { engine, store, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => {
      releaseWorker = r;
    });
    let emitWorkerTelemetry!: (evt: {
      type: "tool_start" | "turn_end";
      toolName?: string;
      activity?: string;
      logLine?: string;
      tokens?: number;
      tokenBreakdown?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
      cost?: number;
    }) => void;

    transport.onMember("flusher", async ({ request }) => {
      emitWorkerTelemetry = (partial) => {
        request.onTelemetry?.({
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          runId: request.runId,
          timestamp: new Date().toISOString(),
          ...partial,
        });
      };
      await workerGate;
    });

    await engine.addMembers({ name: "flusher", brief: "Long running turn" });
    await waitUntil(() => Boolean(emitWorkerTelemetry));

    // Emit live telemetry while working (before turn finishes)
    emitWorkerTelemetry({
      type: "tool_start",
      toolName: "bash",
      activity: "bash: npm test",
      logLine: "> bash: npm test",
    });
    emitWorkerTelemetry({
      type: "turn_end",
      tokens: 14500,
      tokenBreakdown: {
        input: 9000,
        output: 3500,
        cacheRead: 1500,
        cacheWrite: 500,
        total: 14500,
      },
      cost: 0.0875,
    });

    // Dispose engine mid-turn (simulates SIGTERM / process abort)
    await engine.dispose();
    releaseWorker();

    const persisted = await store.loadRun("run-dyn");
    const m = persisted.members.flusher!;
    assert.equal(m.state, "stopped");
    assert.equal(m.tokens, 14500, "dispose must flush live tokens into store");
    assert.equal(m.cost, 0.0875, "dispose must flush live cost into store");
    assert.deepEqual(m.tokenBreakdown, {
      input: 9000,
      output: 3500,
      cacheRead: 1500,
      cacheWrite: 500,
      total: 14500,
    });
    assert.equal(m.llmTurns, 1, "dispose must flush accumulated llmTurns");
    assert.ok(m.logTail.includes("> bash: npm test"), "dispose must flush live logTail");
    assert.equal(m.currentActivity, undefined);
    assert.equal(m.turnStartedAt, undefined, "turnStartedAt must be cleared on stop");
  });

  it("2. tracks turnStartedAt across working/waiting/wakeup/stopped and increments llmTurns on turn_end", async () => {
    const { engine, store, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let releaseTurn1!: () => void;
    let releaseTurn2!: () => void;
    const turn1Gate = new Promise<void>((r) => {
      releaseTurn1 = r;
    });
    const turn2Gate = new Promise<void>((r) => {
      releaseTurn2 = r;
    });
    let turnCount = 0;
    let triggerTelemetry!: (type: "turn_end" | "text_delta", extra?: { activity?: string; tokens?: number; cost?: number }) => void;

    transport.onMember("tracker", async ({ request }) => {
      turnCount += 1;
      triggerTelemetry = (type, extra) => {
        request.onTelemetry?.({
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          runId: request.runId,
          timestamp: new Date().toISOString(),
          type,
          ...extra,
        });
      };
      if (turnCount === 1) {
        await turn1Gate;
      } else {
        await turn2Gate;
      }
      return { summary: `turn ${turnCount} done`, tokens: 500 * turnCount, cost: 0.01 * turnCount };
    });

    try {
      await engine.addMembers({ name: "tracker", brief: "Track turns" });
      await waitUntil(() => Boolean(triggerTelemetry));

      const workingSnap = engine.getSnapshot().run!.members.tracker!;
      assert.equal(workingSnap.state, "working");
      assert.ok(typeof workingSnap.turnStartedAt === "string" && workingSnap.turnStartedAt.length > 0);

      // Fire two LLM turn_end events within a single wakeup turn
      triggerTelemetry("turn_end", { tokens: 200, cost: 0.004 });
      triggerTelemetry("turn_end", { tokens: 400, cost: 0.008 });
      assert.equal(engine.getSnapshot().run!.members.tracker!.llmTurns, 2);

      // Also verify compaction clear (empty activity clears currentActivity)
      triggerTelemetry("text_delta", { activity: "compacting context…" });
      assert.equal(engine.getSnapshot().run!.members.tracker!.currentActivity, "compacting context…");
      triggerTelemetry("text_delta", { activity: "" });
      assert.equal(engine.getSnapshot().run!.members.tracker!.currentActivity, undefined);

      // Finish turn 1 -> parks in waiting, clears turnStartedAt, persists llmTurns=2
      releaseTurn1();
      await waitUntil(() => engine.getSnapshot().run?.members.tracker?.state === "waiting");
      const waitingPersisted = (await store.loadRun("run-dyn")).members.tracker!;
      assert.equal(waitingPersisted.turnStartedAt, undefined);
      assert.equal(waitingPersisted.llmTurns, 2);
      assert.equal(waitingPersisted.turns, 1);

      // Wake member -> sets fresh turnStartedAt and increments llmTurns further
      await engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text: "@tracker please run second pass",
      });
      await waitUntil(() => turnCount === 2 && engine.getSnapshot().run?.members.tracker?.state === "working");
      assert.ok(engine.getSnapshot().run!.members.tracker!.turnStartedAt);
      triggerTelemetry("turn_end", { tokens: 900, cost: 0.02 });
      assert.equal(engine.getSnapshot().run!.members.tracker!.llmTurns, 3);

      releaseTurn2();
      await waitUntil(() => engine.getSnapshot().run?.members.tracker?.state === "waiting");
      const finalPersisted = (await store.loadRun("run-dyn")).members.tracker!;
      assert.equal(finalPersisted.llmTurns, 3);
      assert.equal(finalPersisted.turns, 2);
      assert.equal(finalPersisted.turnStartedAt, undefined);
    } finally {
      releaseTurn1();
      releaseTurn2();
      await engine.dispose();
    }
  });

  it("3. InProcessPiTransport streams thinking_delta, toolcall_start, tool_execution_update, compaction_start/end, and turn_end", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v070-stream-"));
    try {
      const listeners: Array<(event: any) => void> = [];
      let totalTokens = 0;

      const fakeSession = {
        model: { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true },
        thinkingLevel: "medium" as ThinkingLevel,
        sessionManager: SessionManager.inMemory(tmpDir),
        settingsManager: {},
        async bindExtensions() {},
        subscribe(fn: (ev: any) => void) {
          listeners.push(fn);
          return () => {
            const idx = listeners.indexOf(fn);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
        getSessionStats() {
          return {
            tokens: {
              input: totalTokens,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: totalTokens,
            },
            cost: totalTokens * 0.00001,
          };
        },
        async prompt() {
          const emit = (ev: any) => {
            for (const fn of [...listeners]) fn(ev);
          };
          // 1. thinking_delta (first emits immediately, rapid second is throttled)
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: { content: [] } },
          });
          emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 0,
              delta: "Checking worktree layout",
              partial: { content: [] },
            },
          });
          emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              contentIndex: 0,
              delta: " should be throttled within 1.5s",
              partial: { content: [] },
            },
          });

          // 2. toolcall_start -> "preparing bash…"
          emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_start",
              contentIndex: 1,
              partial: {
                content: [
                  { type: "thinking", thinking: "Checking" },
                  { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
                ],
              },
            },
          });

          // 3. tool_execution_start + tool_execution_update -> "bash: <tail>"
          emit({
            type: "tool_execution_start",
            toolCallId: "tc-1",
            toolName: "bash",
            args: { command: "npm test" },
          });
          emit({
            type: "tool_execution_update",
            toolCallId: "tc-1",
            toolName: "bash",
            args: { command: "npm test" },
            partialResult: {
              content: [{ type: "text", text: "line 1\n\x1b[32mPASS tests/engine.test.ts\x1b[0m\n   \n" }],
            },
          });
          emit({
            type: "tool_execution_end",
            toolCallId: "tc-1",
            toolName: "bash",
            result: {},
            isError: false,
          });

          // 4. compaction_start / compaction_end
          emit({ type: "compaction_start", reason: "threshold" });
          emit({
            type: "compaction_end",
            reason: "threshold",
            result: undefined,
            aborted: false,
            willRetry: false,
          });

          // 5. turn_end -> reports tokens & triggers llmTurns increment
          totalTokens = 1234;
          emit({ type: "turn_end" });
        },
        async steer() {},
        async followUp() {},
        async abort() {},
        dispose() {},
      };

      const transport = new InProcessPiTransport({
        agentDir: tmpDir,
        createSession: (async () => ({ session: fakeSession as unknown as AgentSession })) as any,
      });

      const telemetry: Array<{ type: string; activity?: string; toolName?: string; tokens?: number }> = [];
      const handle = await transport.spawnMember({
        agentId: "stream-1",
        name: "streamer",
        role: "worker",
        runId: "run-stream",
        cwd: tmpDir,
        workspace: "inherit",
        parentName: ORCHESTRATOR_NAME,
        brief: "Stream telemetry",
        systemPrompt: "sys",
        initialPrompt: "go",
        keepWarm: true,
        onTelemetry: (evt) => {
          telemetry.push({
            type: evt.type,
            activity: evt.activity,
            toolName: evt.toolName,
            tokens: evt.tokens,
          });
        },
      });
      await handle.currentTurn;
      await handle.kill("done");

      const thinkingEvents = telemetry.filter((e) => e.activity?.startsWith("thinking…"));
      assert.equal(thinkingEvents.length, 1, "thinking_delta must emit once and throttle bursts within 1.5s");
      assert.ok(thinkingEvents[0]!.activity!.includes("Checking worktree layout"));

      assert.ok(
        telemetry.some((e) => e.activity === "preparing bash…" && e.toolName === "bash"),
        "toolcall_start must emit preparing <toolName>…",
      );
      assert.ok(
        telemetry.some((e) => e.activity === "bash: PASS tests/engine.test.ts"),
        "tool_execution_update must emit stripped last non-empty stdout line",
      );
      assert.ok(
        telemetry.some((e) => e.activity === "compacting context…"),
        "compaction_start must emit compacting context…",
      );
      assert.ok(
        telemetry.some((e) => e.type === "usage_update" && e.activity === ""),
        "compaction_end must clear compaction activity",
      );
      assert.ok(
        telemetry.some((e) => e.type === "turn_end" && e.tokens === 1234),
        "turn_end must emit telemetry with session tokens",
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("4. protects active/paused & unmerged worktrees on non-force teardown, auto-recovers missing worktrees on revive, and falls back cleanly on missing_worktree merge", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v070-wt-"));
    try {
      const { engine, store, worktree, transport } = await createTestHarness({
        stallWatchdogEnabled: false,
        autoRebase: true,
      });

      // Override getWorktreePath to use a real temp path we can delete to test existsSync recovery
      const origGetWorktreePath = store.getWorktreePath.bind(store);
      store.getWorktreePath = (runId, memberName) =>
        path.join(tmpDir, `${runId}-${memberName}`);

      const origCreate = worktree.createWorktree.bind(worktree);
      worktree.createWorktree = async (opts) => {
        await mkdir(opts.worktreePath, { recursive: true });
        return origCreate(opts);
      };

      try {
        await engine.addMembers({
          name: "alpha",
          workspace: "share",
          brief: "Alpha slice",
        });
        await waitUntil(() => engine.getSnapshot().run?.members.alpha?.state === "waiting");

        // A. Non-force teardown while run is active skips non-killed (waiting) member
        const activeTd = await engine.teardown();
        assert.equal(activeTd.removed.length, 0);
        assert.equal(activeTd.skipped.length, 1);
        assert.equal(activeTd.skipped[0]!.memberName, "alpha");
        assert.equal(activeTd.skipped[0]!.action, "skipped_active");
        assert.ok(activeTd.skipped[0]!.reason?.includes("active"));

        // Non-force teardown while run is paused also skips non-killed (stopped) member
        await engine.pause();
        const pausedTd = await engine.teardown();
        assert.equal(pausedTd.removed.length, 0);
        assert.equal(pausedTd.skipped.length, 1);
        assert.equal(pausedTd.skipped[0]!.memberName, "alpha");
        assert.equal(pausedTd.skipped[0]!.action, "skipped_active");

        // Force teardown DOES allow removing non-active (stopped) worktree
        await engine.resume();
        const alphaWtPath = engine.getSnapshot().run!.members.alpha!.cwd;
        await rm(alphaWtPath, { recursive: true, force: true });

        // Stop alpha so next mention triggers reviveMemberWithPendingWakes
        await engine.stopMember("alpha", { humanStopped: false, reason: "simulate restart" });

        // B. Revive when isolated worktree dir is missing -> auto-reprovisions with reuseExistingBranch: true
        const createdBeforeRevive = worktree.createdWorktrees.length;
        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          text: "@alpha please continue after worktree recovery",
        });
        await waitUntil(() => engine.getSnapshot().run?.members.alpha?.state === "waiting");
        assert.equal(worktree.createdWorktrees.length, createdBeforeRevive + 1);
        const reprovision = worktree.createdWorktrees[worktree.createdWorktrees.length - 1]!;
        assert.equal(reprovision.reuseExistingBranch, true);
        assert.equal(reprovision.mode, "share");
        assert.equal(reprovision.worktreePath, alphaWtPath);

        // C. Merge fallback when autoRebase returns status="missing_worktree"
        worktree.rebaseResult = {
          status: "missing_worktree",
          message: "Worktree does not exist; skipping auto-rebase.",
        };
        const mergeRes = await engine.mergeMember("alpha");
        assert.ok(mergeRes, "mergeMember should succeed on missing_worktree fallback");
        assert.equal(mergeRes.strategy, "merge");
        const lastMergeCall = worktree.mergedBranches[worktree.mergedBranches.length - 1]!;
        assert.equal(
          lastMergeCall.sourceWorktreePath,
          undefined,
          "missing_worktree merge must omit sourceWorktreePath and merge branch ref directly",
        );

        // D. Non-force teardown on completed run skips unmerged member with commits ahead
        await engine.addMembers({
          name: "beta",
          workspace: "share",
          brief: "Unmerged slice",
        });
        await waitUntil(() => engine.getSnapshot().run?.members.beta?.state === "waiting");
        await engine.completeRun({ summary: "Done with unmerged beta", teardown: false });

        const completedTd = await engine.teardown({ runId: "run-dyn" });
        assert.ok(
          completedTd.removed.some((r) => r.memberName === "alpha"),
          "merged alpha worktree should be removed after completion",
        );
        assert.ok(
          completedTd.skipped.some(
            (s) => s.memberName === "beta" && s.reason?.includes("unmerged commit"),
          ),
          "unmerged beta worktree with commits ahead must be skipped on non-force teardown",
        );

        // Force teardown removes unmerged beta too
        const forcedTd = await engine.teardown({ runId: "run-dyn", force: true });
        assert.ok(forcedTd.removed.some((r) => r.memberName === "beta"));
      } finally {
        store.getWorktreePath = origGetWorktreePath;
        await engine.dispose();
        void transport;
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("5. supports phase & milestones on swarm{action:'title'} with zero Type.Union/anyOf/oneOf in schema", async () => {
    const { engine } = await createTestHarness({ stallWatchdogEnabled: false });
    try {
      const tools = createSwarmTools({ engine });
      const swarmTool = tools.find((t) => t.name === SWARM_TOOL)!;

      // Verify schema contains zero anyOf/oneOf
      const schemaJson = JSON.stringify(swarmTool.parameters);
      assert.ok(!schemaJson.includes('"anyOf"'), "SwarmToolParamsSchema must not contain anyOf");
      assert.ok(!schemaJson.includes('"oneOf"'), "SwarmToolParamsSchema must not contain oneOf");

      // Update phase & milestones WITHOUT passing title
      const res1 = await swarmTool.execute(
        "tc-title-1",
        {
          action: "title",
          phase: "implementation",
          milestones: [
            { label: "Core runtime fixes", status: "in_progress", owner: "@runtime" },
            { label: "Unit test verification", status: "pending" },
          ],
        } as any,
        undefined,
        undefined,
        {} as unknown as ExtensionToolContext,
      );
      assert.ok(!res1.isError);
      const run1 = engine.getSnapshot().run!;
      assert.equal(run1.title, "Dynamic Swarm Test");
      assert.equal(run1.phase, "implementation");
      assert.deepEqual(run1.milestones, [
        { label: "Core runtime fixes", status: "in_progress", owner: "runtime" },
        { label: "Unit test verification", status: "pending" },
      ]);

      // Backward compatibility: passing only title preserves phase & milestones
      const res2 = await swarmTool.execute(
        "tc-title-2",
        {
          action: "title",
          title: "v0.7.0 Release Swarm",
        } as any,
        undefined,
        undefined,
        {} as unknown as ExtensionToolContext,
      );
      assert.ok(!res2.isError);
      const run2 = engine.getSnapshot().run!;
      assert.equal(run2.title, "v0.7.0 Release Swarm");
      assert.equal(run2.phase, "implementation");
      assert.equal(run2.milestones?.length, 2);
    } finally {
      await engine.dispose();
    }
  });

  it("6. sanitizes channel null/'null'/'undefined'/'' and filters @mentions against active roster via knownMembers", async () => {
    const { engine, store, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let workerBridge: SpawnMemberRequest["engineApi"] | undefined;
    transport.onMember("alice", async ({ request }) => {
      workerBridge = request.engineApi;
    });

    try {
      await engine.addMembers({
        name: "alice",
        brief: "Fix @mention parsing and @param docs without waking @nonexistent",
      });
      await waitUntil(() => engine.getSnapshot().run?.members.alice?.state === "waiting");
      assert.ok(workerBridge);

      // Brief post passed knownMembers to store.postBoardMessage
      const briefInput = store.postedBoardInputs.find((i) => i.kind === "brief")!;
      assert.ok(briefInput.knownMembers, "brief post must pass knownMembers to store");
      const briefKnown = new Set(Array.from(briefInput.knownMembers!).map((s) => s.toLowerCase()));
      assert.ok(briefKnown.has("alice"));
      assert.ok(!briefKnown.has("mention"));

      const tools = createSwarmTools({ engine });
      const postTool = tools.find((t) => t.name === POST_MESSAGE_TOOL)!;
      const readTool = tools.find((t) => t.name === READ_BOARD_TOOL)!;
      const memberTools = createMemberScopedTools(workerBridge, {
        name: "alice",
        role: "worker",
        runId: "run-dyn",
      });
      const memberPostTool = memberTools.find((t) => t.name === POST_MESSAGE_TOOL)!;
      const memberReadTool = memberTools.find((t) => t.name === READ_BOARD_TOOL)!;

      // Test channel: null, "null", "undefined", "", and non-string across orchestrator & member tools
      for (const badChannel of [null, "null", "NULL", "undefined", "", "#null", 42]) {
        const pRes = await postTool.execute(
          "tc-post",
          { text: "Hello @alice and fake @mention / @param", channel: badChannel } as any,
          undefined,
          undefined,
          {} as unknown as ExtensionToolContext,
        );
        assert.ok(!pRes.isError, `post_message must accept channel=${String(badChannel)}`);
        const posted = pRes.details as BoardMessage;
        assert.equal(posted.channel, DEFAULT_CHANNEL);
        assert.deepEqual(posted.mentions, ["alice"], "prose tokens @mention/@param must be filtered out");

        const rRes = await readTool.execute(
          "tc-read",
          { channel: badChannel } as any,
          undefined,
          undefined,
          {} as unknown as ExtensionToolContext,
        );
        assert.ok(!rRes.isError, `read_board must accept channel=${String(badChannel)}`);

        const mpRes = await memberPostTool.execute(
          "tc-mpost",
          { text: "Worker update citing @type only", channel: badChannel } as any,
          undefined,
          undefined,
          {} as unknown as ExtensionToolContext,
        );
        assert.ok(!mpRes.isError, `member post_message must accept channel=${String(badChannel)}`);
        assert.deepEqual((mpRes.details as BoardMessage).mentions, []);

        const mrRes = await memberReadTool.execute(
          "tc-mread",
          { channel: badChannel } as any,
          undefined,
          undefined,
          {} as unknown as ExtensionToolContext,
        );
        assert.ok(!mrRes.isError, `member read_board must accept channel=${String(badChannel)}`);
      }

      // Auto-routed [done] with fake prose @mention must still auto-prepend @orchestrator!
      const doneRes = await workerBridge.postMessage({
        text: "[done] Fixed @mention parsing bug cleanly",
        channel: "null",
      });
      assert.equal(doneRes.channel, DEFAULT_CHANNEL);
      assert.deepEqual(doneRes.mentions, [ORCHESTRATOR_NAME]);
    } finally {
      await engine.dispose();
    }
  });

  it("7. prefers dynamic keyHint in tool renderers and includes batching & @validator prose guidance in role-prompts", async () => {
    const { engine } = await createTestHarness({ stallWatchdogEnabled: false });
    try {
      const tools = createSwarmTools({ engine });
      const swarmTool = tools.find((t) => t.name === SWARM_TOOL)!;
      const postTool = tools.find((t) => t.name === POST_MESSAGE_TOOL)!;
      const readTool = tools.find((t) => t.name === READ_BOARD_TOOL)!;

      const stubTheme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as any;

      // A. Prefer options.keyHint("app.tools.expand", "to expand")
      const multiLineResult = {
        content: [{ type: "text" as const, text: "Line 1 summary\nLine 2 detail" }],
        details: {},
      };
      const renderedFromOptions = swarmTool.renderResult!(
        multiLineResult,
        {
          expanded: false,
          isPartial: false,
          keyHint: (kb: string, desc: string) => `${kb}:${desc}`,
        } as any,
        stubTheme,
        {} as any,
      );
      assert.ok(
        renderedFromOptions.render(200).join("\n").includes("app.tools.expand:to expand"),
        "renderSwarmResult must prefer options.keyHint when provided",
      );

      // B. Also supports Pi 1.6 context.keyHint("app.tools.expand", "to expand")
      const warningResult = {
        content: [{ type: "text" as const, text: "Completed\nLine 2\n⚠ Warning detail" }],
        details: {},
      };
      const renderedFromContext = swarmTool.renderResult!(
        warningResult,
        { expanded: false, isPartial: false },
        stubTheme,
        { keyHint: (_kb: string, desc: string) => `alt+e ${desc}` } as any,
      );
      assert.ok(
        renderedFromContext.render(200).join("\n").includes("alt+e to expand"),
        "renderSwarmResult must use context.keyHint when provided",
      );

      // C. Fallback when keyHint is absent
      const fallbackRendered = postTool.renderResult!(
        {
          content: [{ type: "text" as const, text: "Posted" }],
          details: {
            seq: 1,
            channel: "main",
            text: "Line 1\nLine 2",
            mentions: [],
            channelMentions: [],
          },
        },
        { expanded: false, isPartial: false },
        stubTheme,
        {} as any,
      );
      assert.ok(fallbackRendered.render(200).join("\n").includes("(Ctrl+O to expand)"));

      const readRendered = readTool.renderResult!(
        {
          content: [{ type: "text" as const, text: "Board" }],
          details: { messages: [{ seq: 1 }], head: 1 },
        },
        { expanded: false, isPartial: false },
        stubTheme,
        { keyHint: () => "ctrl+e to expand" } as any,
      );
      assert.ok(readRendered.render(200).join("\n").includes("ctrl+e to expand"));

      // D. Role prompts include batching guidance for workers and @validator prose discipline for orchestrator
      await engine.addMembers({ name: "builder", brief: "Build feature" });
      await waitUntil(() => engine.getSnapshot().run?.members.builder?.state === "waiting");
      const snap = engine.getSnapshot();
      const playbook = buildOrchestratorPlaybookSection(snap);
      assert.ok(
        playbook.includes("Avoid writing `@validator`") && playbook.includes("in prose"),
        "orchestrator playbook must warn against mentioning @validator in prose",
      );
      const workerPrompt = buildMemberSystemPrompt(snap.run!, snap.run!.members.builder!);
      assert.ok(
        workerPrompt.includes("Batch independent read, inspection, or verification shell commands"),
        "worker prompt must instruct batching independent shell commands",
      );
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// 19. v0.8.0 Dynamic Mission Goal Engine, Structured Handoffs & Hard Gates
// ============================================================================

describe("SwarmEngine & Runtime — v0.8.0 Dynamic Mission Goal Engine", () => {
  it("1. supports all 8 SWARM_MISSION_OPS, role permissions, auto-sealing, sealed milestone guard, and modified assertion re-verification reset", async () => {
    const { engine, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let workerBridge: SpawnMemberRequest["engineApi"] | undefined;
    let validatorBridge: SpawnMemberRequest["engineApi"] | undefined;

    transport.onMember("worker-a", async ({ request }) => {
      workerBridge = request.engineApi;
    });
    transport.onMember("validator", async ({ request }) => {
      validatorBridge = request.engineApi;
    });

    try {
      await engine.addMembers({ name: "worker-a", brief: "Implement auth slice" });
      await engine.addMembers({
        name: "validator",
        role: "validator",
        brief: "Audit VAL-* contract",
      });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["worker-a"]?.state === "waiting" &&
          engine.getSnapshot().run?.members.validator?.state === "waiting",
      );
      assert.ok(workerBridge);
      assert.ok(validatorBridge);

      const tools = createSwarmTools({ engine });
      const swarmTool = tools.find((t) => t.name === SWARM_TOOL)!;
      const workerTools = createMemberScopedTools(workerBridge, {
        name: "worker-a",
        role: "worker",
        runId: "run-dyn",
      });
      const workerSwarmTool = workerTools.find((t) => t.name === SWARM_TOOL)!;
      const validatorTools = createMemberScopedTools(validatorBridge, {
        name: "validator",
        role: "validator",
        runId: "run-dyn",
      });
      const validatorSwarmTool = validatorTools.find((t) => t.name === SWARM_TOOL)!;
      const toolCtx = {} as unknown as ExtensionToolContext;

      // (h) set_manifest: orchestrator sets commands + boundaries; worker/validator rejected
      const manifestRes = await swarmTool.execute(
        "tc-manifest",
        {
          action: "mission",
          mission_op: "set_manifest",
          commands: [
            { name: "typecheck", command: "npm run typecheck" },
            { name: "test", command: "npm test" },
          ],
          boundaries: ["Never touch auth.json", "No external network calls"],
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!manifestRes.isError);
      assert.equal(engine.getSnapshot().run?.commands?.length, 2);
      assert.equal(engine.getSnapshot().run?.boundaries?.length, 2);

      const badManifestWorker = await workerSwarmTool.execute(
        "tc-manifest-worker",
        {
          action: "mission",
          mission_op: "set_manifest",
          boundaries: ["hacked"],
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.equal(badManifestWorker.isError, true);
      assert.equal((badManifestWorker.details as any)?.errorCode, "PERMISSION_DENIED");

      // (b) upsert_assertions: orchestrator adds VAL-* assertions; worker rejected
      const upsertAssertionsRes = await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          {
            id: "VAL-AUTH-001",
            title: "JWT signature validation",
            description: "Rejects unsigned or tampered JWTs with 401.",
            evidenceRequired: "Unit test output for invalid signature",
          },
          {
            id: "VAL-AUTH-002",
            title: "Session expiry enforcement",
            description: "Rejects expired tokens beyond 30s clock skew.",
            evidenceRequired: "Unit test output for expired token",
          },
          {
            id: "VAL-DROP-003",
            title: "Dropped legacy BasicAuth",
            description: "Temporary scope item to remove later.",
            evidenceRequired: "BasicAuth test",
          },
        ],
      });
      assert.equal(upsertAssertionsRes.assertions!.length, 3);

      await assert.rejects(
        () =>
          workerBridge!.manageMission!({
            op: "upsert_assertions",
            assertions: [{ id: "VAL-HACK-1", title: "x", description: "y" }],
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );

      // (e) upsert_features: DAG cycle validation, milestone auto-creation, coverage warnings
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "upsert_features",
            features: [
              {
                id: "feat-self",
                title: "Self",
                description: "Self dep",
                milestone: "m1",
                dependsOn: ["feat-self"],
              },
            ],
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "upsert_features",
            features: [
              {
                id: "feat-a",
                title: "A",
                description: "Feature A",
                milestone: "m1",
                dependsOn: ["feat-b"],
              },
              {
                id: "feat-b",
                title: "B",
                description: "Feature B",
                milestone: "m1",
                dependsOn: ["feat-a"],
              },
            ],
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );

      const upsertFeaturesRes = await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-jwt",
            title: "JWT signature verifier",
            description: "Verify JWT RS256/HS256 signatures",
            milestone: "m1-auth",
            fulfills: ["VAL-AUTH-001", "VAL-DROP-003"],
          },
          {
            id: "feat-expiry",
            title: "Token expiry check",
            description: "Check exp claim with 30s skew",
            milestone: "m1-auth",
            dependsOn: ["feat-jwt"],
            fulfills: ["VAL-AUTH-001"], // intentionally leaves VAL-AUTH-002 unclaimed + duplicates VAL-AUTH-001
          },
        ],
      });
      assert.ok(
        upsertFeaturesRes.summary.includes("VAL-AUTH-002") &&
          upsertFeaturesRes.summary.includes("Duplicate fulfills"),
        "summary must report unclaimedAssertions and duplicate fulfills",
      );
      assert.ok(
        upsertFeaturesRes.milestones!.some((m) => m.label === "m1-auth"),
        "upsert_features must auto-ensure milestone exists in run.milestones",
      );

      // Fix feat-expiry fulfills -> VAL-AUTH-002
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-expiry",
            title: "Token expiry check",
            description: "Check exp claim with 30s skew",
            milestone: "m1-auth",
            dependsOn: ["feat-jwt"],
            fulfills: ["VAL-AUTH-002"],
          },
        ],
      });

      // (c) remove_assertion: drops VAL-DROP-003 and strips orphaned reference from feat-jwt.fulfills
      const removeRes = await engine.manageMission({
        op: "remove_assertion",
        assertionId: "VAL-DROP-003",
      });
      assert.equal(removeRes.assertions!.length, 2);
      const jwtFeatAfterRemove = removeRes.features!.find((f) => f.id === "feat-jwt")!;
      assert.deepEqual(jwtFeatAfterRemove.fulfills, ["VAL-AUTH-001"]);

      // (f) update_feature: worker claims unassigned feature -> in_progress; validator rejected; hijacking other worker's feature rejected
      await workerSwarmTool.execute(
        "tc-claim",
        {
          action: "mission",
          mission_op: "update_feature",
          feature_id: "feat-jwt",
          feature_status: "in_progress",
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.equal(
        engine.getSnapshot().run?.features?.find((f) => f.id === "feat-jwt")?.assignedMember,
        "worker-a",
      );

      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-expiry",
        assignedMember: "other-worker",
      });
      await assert.rejects(
        () =>
          workerBridge!.manageMission!({
            op: "update_feature",
            featureId: "feat-expiry",
            featureStatus: "completed",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );
      await assert.rejects(
        () =>
          validatorBridge!.manageMission!({
            op: "update_feature",
            featureId: "feat-jwt",
            featureStatus: "completed",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );

      // Queue ordering: failed moves to top; completed/cancelled sink to bottom; prepend:true inserts at top of pending
      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-jwt",
        featureStatus: "completed",
      });
      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-expiry",
        featureStatus: "failed",
      });
      const prependRes = await engine.manageMission({
        op: "upsert_features",
        prepend: true,
        features: [
          {
            id: "feat-urgent",
            title: "Urgent clock skew helper",
            description: "Add clock skew helper before expiry",
            milestone: "m1-auth",
            fulfills: ["VAL-AUTH-002"],
          },
        ],
      });
      assert.deepEqual(
        prependRes.features!.map((f) => f.id),
        ["feat-urgent", "feat-expiry", "feat-jwt"],
        "prepend:true must insert at top of active queue while completed feat-jwt stays at bottom",
      );

      // Cancel feat-urgent and complete feat-expiry so all non-cancelled m1-auth features are completed
      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-urgent",
        featureStatus: "cancelled",
      });
      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-expiry",
        featureStatus: "completed",
      });

      // (d) verify_assertion:
      // 1) Worker MUST be rejected with PERMISSION_DENIED (never self-grade!)
      const badWorkerVerify = await workerSwarmTool.execute(
        "tc-worker-verify",
        {
          action: "mission",
          mission_op: "verify_assertion",
          assertion_id: "VAL-AUTH-001",
          assertion_status: "passed",
          evidence: "trust me bro",
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.equal(badWorkerVerify.isError, true);
      assert.equal((badWorkerVerify.details as any)?.errorCode, "PERMISSION_DENIED");

      // 2) Orchestrator marking "passed" when validatorEnabled=true without force=true MUST be rejected!
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "verify_assertion",
            assertionId: "VAL-AUTH-001",
            assertionStatus: "passed",
            evidence: "Orchestrator self-check",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );

      // 3) Empty evidence when setting "passed" or "failed" MUST be rejected!
      await assert.rejects(
        () =>
          validatorBridge!.manageMission!({
            op: "verify_assertion",
            assertionId: "VAL-AUTH-001",
            assertionStatus: "passed",
            evidence: "   ",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );

      // 4) Independent validator verifies VAL-AUTH-001 & VAL-AUTH-002 -> milestone m1-auth AUTO-SEALS!
      await validatorSwarmTool.execute(
        "tc-val-1",
        {
          action: "mission",
          mission_op: "verify_assertion",
          assertion_id: "VAL-AUTH-001",
          assertion_status: "passed",
          evidence: "npm test -- jwt.test.ts: 6/6 passed",
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      const sealRes = await validatorSwarmTool.execute(
        "tc-val-2",
        {
          action: "mission",
          mission_op: "verify_assertion",
          assertion_id: "VAL-AUTH-002",
          assertion_status: "passed",
          evidence: "npm test -- expiry.test.ts: 4/4 passed",
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!sealRes.isError);
      const sealedMilestone = engine
        .getSnapshot()
        .run?.milestones?.find((m) => m.label === "m1-auth");
      assert.equal(sealedMilestone?.status, "done");
      assert.equal(sealedMilestone?.sealed, true);
      assert.ok(sealedMilestone?.sealedAt);

      // (e) Sealed Milestone Guard: reject adding new feature or re-opening completed feature in sealed m1-auth!
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "upsert_features",
            features: [
              {
                id: "feat-sneaky",
                title: "Sneaky unvalidated edit",
                description: "Bypass validation",
                milestone: "m1-auth",
              },
            ],
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError &&
          err.code === "INVALID_INPUT" &&
          err.message.includes("sealed") &&
          err.message.includes("followup"),
      );
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "update_feature",
            featureId: "feat-jwt",
            featureStatus: "in_progress",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );

      // Adding follow-up work in a new milestone "m1-auth-followup" succeeds cleanly!
      const followupRes = await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-refresh-token",
            title: "Refresh token rotation",
            description: "Rotate refresh tokens on use",
            milestone: "m1-auth-followup",
            fulfills: ["VAL-AUTH-002"],
          },
        ],
      });
      assert.ok(followupRes.milestones!.some((m) => m.label === "m1-auth-followup"));

      // (b) Droid modified-assertion rule: changing description of a "passed" assertion resets status->"pending", clears evidence/verifiedBy, and unseals m1-auth!
      const modifiedAssertionRes = await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          {
            id: "VAL-AUTH-001",
            title: "JWT signature + key-id validation",
            description: "Rejects unsigned JWTs AND unknown kid headers with 401.",
            evidenceRequired: "Unit tests for signature + kid header",
          },
        ],
      });
      const resetVal1 = modifiedAssertionRes.assertions!.find(
        (a) => a.id === "VAL-AUTH-001",
      )!;
      assert.equal(resetVal1.status, "pending");
      assert.equal(resetVal1.evidence, undefined);
      assert.equal(resetVal1.verifiedBy, undefined);
      const unsealedM1 = modifiedAssertionRes.milestones!.find(
        (m) => m.label === "m1-auth",
      )!;
      assert.equal(unsealedM1.sealed, false);
      assert.equal(unsealedM1.status, "in_progress");

      // Also verify marking an assertion "failed" keeps milestone unsealed and includes actionable failure info
      const failedVerifyRes = await validatorBridge!.manageMission!({
        op: "verify_assertion",
        assertionId: "VAL-AUTH-001",
        assertionStatus: "failed",
        evidence: "src/auth/jwt.ts:44 accepts missing kid header",
      });
      assert.ok(failedVerifyRes.summary.includes("Action needed"));

      // (a) status: readable by worker, validator, orchestrator, and human
      for (const caller of [
        () => workerBridge!.manageMission!({ op: "status" }),
        () => validatorBridge!.manageMission!({ op: "status" }),
        () => engine.manageMission({ op: "status" }),
        () => engine.manageMission({ op: "status", callerRole: "human" }),
      ]) {
        const st = await caller();
        assert.equal(st.op, "status");
        assert.ok(st.summary.includes("Milestones"));
        assert.ok(st.summary.includes("Feature Queue"));
        assert.ok(st.summary.includes("Validation Contract"));
        assert.ok(st.summary.includes("npm run typecheck"));
        assert.ok(st.summary.includes("Never touch auth.json"));
      }
    } finally {
      await engine.dispose();
    }
  });

  it("2. enforces resolve_handoff tracking & anti-laziness justification rules (>=20 chars, no lazy excuses)", async () => {
    const { engine, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let workerBridge: SpawnMemberRequest["engineApi"] | undefined;
    transport.onMember("author", async ({ request }) => {
      workerBridge = request.engineApi;
    });

    try {
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-1",
            title: "Base feature",
            description: "Implement base feature",
            milestone: "m1",
          },
        ],
      });
      await engine.addMembers({ name: "author", brief: "Build feat-1" });
      await waitUntil(() => engine.getSnapshot().run?.members.author?.state === "waiting");
      assert.ok(workerBridge);

      await workerBridge.postMessage({
        text: "@orchestrator [done] Implemented feat-1",
        featureId: "feat-1",
        verificationEvidence: "npm test -> 8/8 passed",
        discoveredIssues: [
          "Race condition when refresh endpoint receives concurrent requests",
          "Duplicate CSS utility in legacy header",
        ],
      });

      const handoffs = engine.getSnapshot().run?.handoffItems ?? [];
      assert.equal(handoffs.length, 2);
      const [ho1, ho2] = handoffs;
      assert.equal(ho1!.resolution, "open");
      assert.equal(ho2!.resolution, "open");

      // "tracked" requires an existing trackedFeatureId
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "resolve_handoff",
            handoffId: ho1!.id,
            resolution: "tracked",
            trackedFeatureId: "feat-nonexistent",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );

      await engine.manageMission({
        op: "upsert_features",
        prepend: true,
        features: [
          {
            id: "feat-refresh-lock",
            title: "Serialize concurrent token refresh requests",
            description: "Prevent concurrent token refresh race",
            milestone: "m1",
          },
        ],
      });
      const trackedRes = await engine.manageMission({
        op: "resolve_handoff",
        handoffId: ho1!.id,
        resolution: "tracked",
        trackedFeatureId: "feat-refresh-lock",
      });
      const updatedHo1 = trackedRes.handoffItems!.find((h) => h.id === ho1!.id)!;
      assert.equal(updatedHo1.resolution, "tracked");
      assert.equal(updatedHo1.trackedFeatureId, "feat-refresh-lock");

      // "dismissed" rejects < 20 chars AND all lazy justifications
      const lazyExcuses = [
        "Too short",
        "This is low priority for the current release cycle.",
        "Confirmed non-blocking for the main happy path.",
        "We will handle later in a follow-up ticket.",
        "Team agreed to fix later after shipping v1.",
        "Tracked via inline TODO comment in header.css.",
        "Only a minor issue affecting legacy styles.",
      ];
      for (const badJustification of lazyExcuses) {
        await assert.rejects(
          () =>
            engine.manageMission({
              op: "resolve_handoff",
              handoffId: ho2!.id,
              resolution: "dismissed",
              justification: badJustification,
            }),
          (err: unknown) =>
            err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
          `Expected lazy justification to be rejected: "${badJustification}"`,
        );
      }

      // Concrete >= 20 char technical justification succeeds
      const dismissedRes = await engine.manageMission({
        op: "resolve_handoff",
        handoffId: ho2!.id,
        resolution: "dismissed",
        justification:
          "Verified in src/ui/header.css:18 that legacy-header selector was removed by commit 5065d6e and is dead CSS.",
      });
      const updatedHo2 = dismissedRes.handoffItems!.find((h) => h.id === ho2!.id)!;
      assert.equal(updatedHo2.resolution, "dismissed");
      assert.ok(updatedHo2.resolvedAt);
    } finally {
      await engine.dispose();
    }
  });

  it("3. persists structured post_message handoffs, auto-completes on mergeMember, and auto-wakes idle @validator with [milestone-review]", async () => {
    const { engine, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });

    let shareWorkerBridge: SpawnMemberRequest["engineApi"] | undefined;
    const validatorWakePrompts: string[] = [];

    transport.onMember("share-dev", async ({ request }) => {
      shareWorkerBridge = request.engineApi;
    });
    transport.onMember("validator", async ({ request, prompt, turnIndex }) => {
      if (turnIndex > 1) {
        validatorWakePrompts.push(prompt);
        // Validator verifies VAL-CORE-001 right inside its auto-triggered [milestone-review] turn!
        await request.engineApi!.manageMission!({
          op: "verify_assertion",
          assertionId: "VAL-CORE-001",
          assertionStatus: "passed",
          evidence: "Ran npm test && npm run typecheck on main: all 24 assertions green.",
        });
      }
    });

    try {
      await engine.manageMission({
        op: "set_manifest",
        commands: [{ name: "test", command: "npm test" }],
      });
      await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          {
            id: "VAL-CORE-001",
            title: "Core pipeline passes end-to-end",
            description: "All pipeline stages execute cleanly.",
          },
        ],
      });
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-core",
            title: "Core pipeline implementation",
            description: "Implement end-to-end core pipeline",
            milestone: "m-core",
            fulfills: ["VAL-CORE-001"],
          },
        ],
      });

      await engine.addMembers({
        name: "share-dev",
        workspace: "share",
        brief: "Implement feat-core in isolated worktree",
      });
      await waitUntil(
        () => engine.getSnapshot().run?.members["share-dev"]?.state === "waiting",
      );
      assert.ok(shareWorkerBridge);

      // Worker posts [done] via member post_message tool with structured handoff fields
      const memberTools = createMemberScopedTools(shareWorkerBridge, {
        name: "share-dev",
        role: "worker",
        runId: "run-dyn",
      });
      const memberPostTool = memberTools.find((t) => t.name === POST_MESSAGE_TOOL)!;
      const postRes = await memberPostTool.execute(
        "tc-worker-done",
        {
          text: "@orchestrator [done] commit=abcdef1 Implemented feat-core",
          feature_id: "feat-core",
          discovered_issues: ["Unrelated CLI help typo in --verbose description"],
          left_undone: [],
          verification_evidence: "npm test -> 12/12 passed",
        } as any,
        undefined,
        undefined,
        {} as unknown as ExtensionToolContext,
      );
      assert.ok(!postRes.isError);
      const postedMsg = postRes.details as BoardMessage;
      assert.equal(postedMsg.featureId, "feat-core");
      assert.deepEqual(postedMsg.discoveredIssues, [
        "Unrelated CLI help typo in --verbose description",
      ]);
      assert.equal(postedMsg.verificationEvidence, "npm test -> 12/12 passed");

      // Because share-dev is on an unmerged "share" worktree, feat-core is auto-linked & "in_progress" (not prematurely "completed" before merge!)
      const featBeforeMerge = engine
        .getSnapshot()
        .run?.features?.find((f) => f.id === "feat-core")!;
      assert.equal(featBeforeMerge.assignedMember, "share-dev");
      assert.equal(featBeforeMerge.status, "in_progress");
      assert.equal(engine.getSnapshot().run?.handoffItems?.length, 1);

      // Spawn an idle read-only validator on inherit workspace BEFORE merging
      await engine.addMembers({
        name: "validator",
        role: "validator",
        workspace: "inherit",
        brief: "Stand by to validate milestones",
      });
      await waitUntil(
        () => engine.getSnapshot().run?.members.validator?.state === "waiting",
      );

      // Merge share-dev -> auto-completes feat-core + stamps mergedCommitSha + posts [milestone-review] @validator -> wakes validator -> validator seals m-core!
      const mergeRes = await engine.mergeMember("share-dev");
      assert.ok(mergeRes);
      assert.deepEqual((mergeRes as any).completedFeatureIds, ["feat-core"]);
      assert.equal(
        (mergeRes as any).milestoneValidationCues?.[0]?.validatorWoken,
        "validator",
      );

      await waitUntil(
        () =>
          validatorWakePrompts.length === 1 &&
          engine.getSnapshot().run?.members.validator?.state === "waiting",
      );
      assert.ok(
        validatorWakePrompts[0]!.includes("[milestone-review]") &&
          validatorWakePrompts[0]!.includes("VAL-CORE-001") &&
          validatorWakePrompts[0]!.includes("npm test"),
        "auto-injected [milestone-review] must list operational commands and milestone VAL-* IDs",
      );

      const finalRun = engine.getSnapshot().run!;
      const mergedFeat = finalRun.features?.find((f) => f.id === "feat-core")!;
      assert.equal(mergedFeat.status, "completed");
      assert.equal(mergedFeat.mergedCommitSha, mergeRes.mergedCommitSha);
      const sealedMCore = finalRun.milestones?.find((m) => m.label === "m-core")!;
      assert.equal(sealedMCore.sealed, true);

      // Also verify: open left_undone prevents premature auto-completion on mergeMember, and missing validator auto-spawns @validator-2!
      await engine.killMember("validator", { reason: "retire first validator" });
      await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          {
            id: "VAL-CORE-002",
            title: "Follow-up edge cases pass",
            description: "All edge cases pass.",
          },
        ],
      });
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-partial",
            title: "Partial edge-case work",
            description: "Partial work with left_undone",
            milestone: "m-partial",
            assignedMember: "partial-dev",
            status: "in_progress",
            fulfills: ["VAL-CORE-002"],
          },
          {
            id: "feat-m2",
            title: "Complete m2 feature without validator spawned yet",
            description: "Complete m2 feature",
            milestone: "m2-noval",
            assignedMember: "m2-dev",
            status: "in_progress",
            fulfills: ["VAL-CORE-002"],
          },
        ],
      });
      await engine.addMembers({
        name: "partial-dev",
        workspace: "share",
        brief: "Work on feat-partial",
      });
      await engine.addMembers({
        name: "m2-dev",
        workspace: "share",
        brief: "Work on feat-m2",
      });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["partial-dev"]?.state === "waiting" &&
          engine.getSnapshot().run?.members["m2-dev"]?.state === "waiting",
      );
      await engine.postMessage({
        from: "partial-dev",
        fromRole: "worker",
        text: "@orchestrator [done] Partial progress",
        featureId: "feat-partial",
        leftUndone: ["Retry jitter backoff not wired yet"],
      });
      await engine.mergeMember("partial-dev");
      const partialAfterMerge = engine
        .getSnapshot()
        .run!.features!.find((f) => f.id === "feat-partial")!;
      assert.equal(
        partialAfterMerge.status,
        "in_progress",
        "open incomplete_work handoff must prevent premature auto-completion on mergeMember",
      );
      assert.ok(partialAfterMerge.mergedCommitSha);

      const tools = createSwarmTools({ engine });
      const swarmTool = tools.find((t) => t.name === SWARM_TOOL)!;
      const m2MergeToolRes = await swarmTool.execute(
        "tc-merge-m2",
        { action: "merge", name: "m2-dev" } as any,
        undefined,
        undefined,
        {} as unknown as ExtensionToolContext,
      );
      assert.ok(!m2MergeToolRes.isError);
      const m2MergeText = (m2MergeToolRes.content[0] as any)?.text ?? "";
      assert.ok(
        m2MergeText.includes("m2-noval") &&
          m2MergeText.includes("auto-spawned @validator-2"),
        "merge output must report auto-spawned @validator-2 when prior validator was killed",
      );
      await waitUntil(
        () => engine.getSnapshot().run?.members["validator-2"]?.state === "waiting",
      );
    } finally {
      await engine.dispose();
    }
  });

  it("4. enforces all 5 End-of-Mission Hard Gates (A..E) on swarm{action:'done'} and honors force:true", async () => {
    const { engine, worktree, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let releaseSlowWorker: (() => void) | undefined;
    transport.onMember("slow-worker", async () => {
      await new Promise<void>((resolve) => {
        releaseSlowWorker = resolve;
      });
    });

    try {
      const tools = createSwarmTools({ engine });
      const swarmTool = tools.find((t) => t.name === SWARM_TOOL)!;
      const toolCtx = {} as unknown as ExtensionToolContext;

      await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          { id: "VAL-GATE-001", title: "Gate assertion 1", description: "Must pass" },
          { id: "VAL-GATE-002", title: "Gate assertion 2", description: "Must be claimed & pass" },
        ],
      });
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-gate-1",
            title: "Gate feature 1",
            description: "Implement gate feature 1",
            milestone: "m-gate",
            fulfills: ["VAL-GATE-001"],
          },
        ],
      });

      const expectDoneBlocked = async (
        callId: string,
        summary: string,
        expectedSubstring: string,
      ): Promise<void> => {
        const res = await swarmTool.execute(
          callId,
          { action: "done", summary } as any,
          undefined,
          undefined,
          toolCtx,
        );
        assert.equal(res.isError, true, `Expected done (${callId}) to be blocked`);
        assert.equal((res.details as any)?.errorCode, "INVALID_INPUT");
        const errText = (res.content[0] as any)?.text ?? "";
        assert.ok(
          errText.includes(expectedSubstring),
          `Expected done error (${callId}) to mention "${expectedSubstring}", got: ${errText}`,
        );
      };

      // Gate A: Working member blocks done
      const addPromise = engine.addMembers({
        name: "slow-worker",
        workspace: "share",
        brief: "Work slowly",
      });
      await waitUntil(() => Boolean(releaseSlowWorker));
      await expectDoneBlocked("tc-done-a", "Premature done", "slow-worker");
      releaseSlowWorker!();
      await addPromise;
      await waitUntil(
        () => engine.getSnapshot().run?.members["slow-worker"]?.state === "waiting",
      );

      const workerBranch = engine.getSnapshot().run!.members["slow-worker"]!.branch!;

      // Gate B: Unmerged share branch with commitsAhead > 0 blocks done
      worktree.commitsAheadByBranch.set(workerBranch, 2);
      await expectDoneBlocked("tc-done-b", "Unmerged commits ahead", "commits ahead");

      // When commitsAhead === 0, Gate B does NOT block -> reaches Gate C (incomplete feature feat-gate-1)
      worktree.commitsAheadByBranch.set(workerBranch, 0);
      await expectDoneBlocked("tc-done-c", "Incomplete feature", "feat-gate-1");

      // Complete feat-gate-1 and inject an open discovered_issue -> Gate D blocks done!
      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-gate-1",
        featureStatus: "completed",
      });
      await engine.postMessage({
        from: "slow-worker",
        fromRole: "worker",
        text: "@orchestrator [done] Finished work",
        discoveredIssues: ["Unhandled edge case on empty payload"],
      });
      const openHandoffId = engine.getSnapshot().run!.handoffItems![0]!.id;

      await expectDoneBlocked("tc-done-d", "Open handoff debt", openHandoffId);

      // Resolve handoff by tracking it in feat-gate-2 (fulfilling VAL-GATE-002) and completing feat-gate-2
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-gate-2",
            title: "Handle empty payload & fulfill VAL-GATE-002",
            description: "Handle empty payload cleanly",
            milestone: "m-gate",
            fulfills: [], // intentionally leave VAL-GATE-002 unclaimed first!
          },
        ],
      });
      await engine.manageMission({
        op: "resolve_handoff",
        handoffId: openHandoffId,
        resolution: "tracked",
        trackedFeatureId: "feat-gate-2",
      });
      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-gate-2",
        featureStatus: "completed",
      });

      // Gate E (part 1): unpassed VAL-* assertions block done!
      await expectDoneBlocked("tc-done-e1", "Unverified assertions", "VAL-GATE-001");

      // Verify both assertions as human/validator, while VAL-GATE-002 is still NOT claimed by any completed feature -> Gate E (part 2) blocks!
      await engine.manageMission({
        op: "verify_assertion",
        callerRole: "human",
        assertionId: "VAL-GATE-001",
        assertionStatus: "passed",
        evidence: "Verified gate 1",
      });
      await engine.manageMission({
        op: "verify_assertion",
        callerRole: "human",
        assertionId: "VAL-GATE-002",
        assertionStatus: "passed",
        evidence: "Verified gate 2",
      });
      await expectDoneBlocked("tc-done-e2", "Unclaimed assertion", "VAL-GATE-002");

      // Claim VAL-GATE-002 on completed feat-gate-2 -> all 5 gates pass and done succeeds!
      await engine.manageMission({
        op: "upsert_features",
        force: true,
        features: [
          {
            id: "feat-gate-2",
            title: "Handle empty payload & fulfill VAL-GATE-002",
            description: "Handle empty payload cleanly",
            milestone: "m-gate",
            status: "completed",
            fulfills: ["VAL-GATE-002"],
          },
        ],
      });
      const doneRes = await swarmTool.execute(
        "tc-done-ok",
        { action: "done", summary: "All 5 mission gates satisfied!" } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!doneRes.isError);
      assert.equal(engine.getSnapshot().run?.status, "completed");

      // Also verify LLM orchestrator force:true is rejected with PERMISSION_DENIED, while human force:true bypasses gates cleanly
      const { engine: forceEngine } = await createTestHarness({
        stallWatchdogEnabled: false,
      });
      try {
        await forceEngine.manageMission({
          op: "upsert_assertions",
          assertions: [{ id: "VAL-FORCE-001", title: "Pending", description: "Pending" }],
        });
        await forceEngine.manageMission({
          op: "upsert_features",
          features: [
            {
              id: "feat-force-1",
              title: "Pending feature",
              description: "Pending",
              milestone: "m1",
              fulfills: ["VAL-FORCE-001"],
            },
          ],
        });
        const orchForceTool = createSwarmTools({ engine: forceEngine }).find(
          (t) => t.name === SWARM_TOOL,
        )!;
        const blockedLlmForce = await orchForceTool.execute(
          "tc-done-force-llm",
          { action: "done", summary: "LLM tried force close", force: true } as any,
          undefined,
          undefined,
          toolCtx,
        );
        assert.equal(blockedLlmForce.isError, true);
        assert.equal((blockedLlmForce.details as any)?.errorCode, "PERMISSION_DENIED");
        assert.equal(forceEngine.getSnapshot().run?.status, "active");

        const humanForceTool = createSwarmTools({
          engine: forceEngine,
          getCallerRole: () => "human",
          getCallerName: () => "human",
        }).find((t) => t.name === SWARM_TOOL)!;
        const forcedDone = await humanForceTool.execute(
          "tc-done-force",
          { action: "done", summary: "Emergency force close", force: true } as any,
          undefined,
          undefined,
          toolCtx,
        );
        assert.ok(!forcedDone.isError);
        assert.equal(forceEngine.getSnapshot().run?.status, "completed");
      } finally {
        await forceEngine.dispose();
      }
    } finally {
      releaseSlowWorker?.();
      await engine.dispose();
    }
  });

  it("5. injects Mission Goal Engine context into all 3 role prompts, renders mission/handoff cards, and keeps tool schemas 100% free of Union/Record", async () => {
    const { engine, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let workerBridge: SpawnMemberRequest["engineApi"] | undefined;
    transport.onMember("dev-1", async ({ request }) => {
      workerBridge = request.engineApi;
    });

    try {
      await engine.manageMission({
        op: "set_manifest",
        commands: [{ name: "verify", command: "npm run typecheck && npm test" }],
        boundaries: ["Do not modify auth.json"],
      });
      await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          {
            id: "VAL-UI-001",
            title: "Mission card renders",
            description: "Renders mission summary cleanly",
          },
        ],
      });
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-ui",
            title: "Render mission cards",
            description: "Render mission cards in TUI",
            milestone: "m-ui",
            assignedMember: "dev-1",
            fulfills: ["VAL-UI-001"],
          },
        ],
      });

      await engine.addMembers({ name: "dev-1", brief: "Implement feat-ui" });
      await engine.addMembers({
        name: "val-1",
        role: "validator",
        brief: "Audit VAL-UI-001",
      });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["dev-1"]?.state === "waiting" &&
          engine.getSnapshot().run?.members["val-1"]?.state === "waiting",
      );
      assert.ok(workerBridge);

      const snapBefore = engine.getSnapshot();
      const staticBefore = buildOrchestratorStaticSection(snapBefore);
      const liveBefore = buildOrchestratorLiveStateSection(snapBefore);
      const playbook = buildOrchestratorPlaybookSection(snapBefore);
      const workerPrompt = buildMemberSystemPrompt(
        snapBefore.run!,
        snapBefore.run!.members["dev-1"]!,
      );
      const validatorPrompt = buildMemberSystemPrompt(
        snapBefore.run!,
        snapBefore.run!.members["val-1"]!,
      );

      // Artifact paths & manifest injected into Orchestrator, Worker, and Validator prompts
      for (const promptText of [staticBefore, playbook, workerPrompt, validatorPrompt]) {
        assert.ok(promptText.includes("mission.md"));
        assert.ok(promptText.includes("validation-contract.md"));
        assert.ok(promptText.includes("features.json"));
        assert.ok(promptText.includes("npm run typecheck && npm test"));
        assert.ok(promptText.includes("Do not modify auth.json"));
      }
      assert.ok(liveBefore.includes("VAL-UI-001") && liveBefore.includes("feat-ui"));
      assert.ok(
        workerPrompt.includes("YOUR FEATURE") &&
          workerPrompt.includes("discovered_issues") &&
          workerPrompt.includes("left_undone") &&
          workerPrompt.includes("verification_evidence") &&
          workerPrompt.includes("npx -y"),
      );
      assert.ok(
        validatorPrompt.includes("verify_assertion") &&
          validatorPrompt.includes("VAL-UI-001"),
      );
      assert.ok(
        playbook.includes("upsert_assertions") &&
          playbook.includes("Sealed Milestones"),
      );

      // Prompt-cache invariant: mutating feature/assertion progress does NOT alter buildOrchestratorStaticSection!
      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-ui",
        featureStatus: "completed",
      });
      const staticAfter = buildOrchestratorStaticSection(engine.getSnapshot());
      assert.equal(staticAfter, staticBefore);

      // Custom tool cards for action="mission" and post_message handoff badges
      const tools = createSwarmTools({ engine });
      const swarmTool = tools.find((t) => t.name === SWARM_TOOL)!;
      const postTool = tools.find((t) => t.name === POST_MESSAGE_TOOL)!;
      const stubTheme = {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
      } as any;

      const missionCallCard = swarmTool.renderCall!(
        {
          action: "mission",
          mission_op: "verify_assertion",
          assertion_id: "VAL-UI-001",
          assertion_status: "passed",
        } as any,
        stubTheme,
        {} as any,
      );
      assert.ok(
        missionCallCard.render(200).join("\n").includes("swarm mission verify_assertion") &&
          missionCallCard.render(200).join("\n").includes("VAL-UI-001"),
      );

      const statusExec = await swarmTool.execute(
        "tc-mission-card",
        { action: "mission", mission_op: "status" } as any,
        undefined,
        undefined,
        {} as unknown as ExtensionToolContext,
      );
      const missionResultCard = swarmTool.renderResult!(
        statusExec as any,
        { expanded: false, isPartial: false },
        stubTheme,
        {} as any,
      );
      const renderedMissionResult = missionResultCard.render(200).join("\n");
      assert.ok(
        renderedMissionResult.includes("Feat 1/1") &&
          renderedMissionResult.includes("VAL 0/1"),
      );

      const postCallCard = postTool.renderCall!(
        {
          text: "@validator [done] Ready for audit",
          feature_id: "feat-ui",
          discovered_issues: ["issue-1"],
          left_undone: ["todo-1"],
          verification_evidence: "npm test passed",
        } as any,
        stubTheme,
        {} as any,
      );
      const renderedPostCall = postCallCard.render(200).join("\n");
      assert.ok(
        renderedPostCall.includes("feat:feat-ui") &&
          renderedPostCall.includes("+1 issue") &&
          renderedPostCall.includes("!1 undone") &&
          renderedPostCall.includes("✓evidence"),
      );

      // Strict schema invariant: ZERO anyOf / oneOf / patternProperties / non-boolean additionalProperties across all orchestrator & member tools!
      const memberTools = createMemberScopedTools(workerBridge, {
        name: "dev-1",
        role: "worker",
        runId: "run-dyn",
      });
      const checkFlatSchema = (node: unknown, pathStr: string): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          node.forEach((child, idx) => checkFlatSchema(child, `${pathStr}[${idx}]`));
          return;
        }
        const rec = node as Record<string, unknown>;
        for (const forbidden of ["anyOf", "oneOf", "allOf", "patternProperties"]) {
          assert.equal(
            forbidden in rec,
            false,
            `Forbidden JSON Schema keyword "${forbidden}" at ${pathStr}`,
          );
        }
        if ("additionalProperties" in rec && typeof rec.additionalProperties !== "boolean") {
          assert.fail(`Type.Record / object additionalProperties found at ${pathStr}`);
        }
        for (const [k, v] of Object.entries(rec)) {
          checkFlatSchema(v, `${pathStr}.${k}`);
        }
      };

      for (const tool of [...tools, ...memberTools]) {
        checkFlatSchema(tool.parameters, tool.name);
      }
    } finally {
      await engine.dispose();
    }
  });
});

// ============================================================================
// Suite 20. v0.9.0 Runtime Gap Closure (Gaps 1, 2, 3, 4, 6)
// ============================================================================

describe("SwarmEngine & Runtime — v0.9.0 Gap Closure", () => {
  it("1. [Gap 1] blocks LLM force:true on swarm{action:'done'} with PERMISSION_DENIED, allows human force:true, and supports audited override_assertion (>=30 chars + [OVERRIDE] event + milestone auto-sealing)", async () => {
    const { engine, store, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let workerBridge: SpawnMemberRequest["engineApi"] | undefined;
    let validatorBridge: SpawnMemberRequest["engineApi"] | undefined;

    transport.onMember("worker-ovr", async ({ request }) => {
      workerBridge = request.engineApi;
    });
    transport.onMember("val-ovr", async ({ request }) => {
      validatorBridge = request.engineApi;
    });

    try {
      const toolCtx = {} as unknown as ExtensionToolContext;
      const orchSwarmTool = createSwarmTools({ engine }).find(
        (t) => t.name === SWARM_TOOL,
      )!;
      const humanSwarmTool = createSwarmTools({
        engine,
        getCallerRole: () => "human",
        getCallerName: () => "human",
      }).find((t) => t.name === SWARM_TOOL)!;

      await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          {
            id: "VAL-OVR-001",
            title: "Live Stripe webhook signature verification",
            description: "Verifies Stripe webhook against live sandbox endpoint.",
          },
          {
            id: "VAL-OVR-002",
            title: "Local unit verification",
            description: "Passes local unit suite.",
          },
        ],
      });
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-ovr-1",
            title: "Webhook handler",
            description: "Implement Stripe webhook handler",
            milestone: "m-ovr",
            status: "completed",
            fulfills: ["VAL-OVR-001", "VAL-OVR-002"],
          },
        ],
      });

      await engine.addMembers({ name: "worker-ovr", brief: "Check webhook" });
      await engine.addMembers({
        name: "val-ovr",
        role: "validator",
        brief: "Audit VAL-OVR-002",
      });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["worker-ovr"]?.state === "waiting" &&
          engine.getSnapshot().run?.members["val-ovr"]?.state === "waiting",
      );
      assert.ok(workerBridge);
      assert.ok(validatorBridge);

      // Validator verifies VAL-OVR-002 normally, leaving VAL-OVR-001 pending
      await validatorBridge.manageMission!({
        op: "verify_assertion",
        assertionId: "VAL-OVR-002",
        assertionStatus: "passed",
        evidence: "npm test -- webhook.test.ts: 9/9 passed",
      });

      // LLM orchestrator attempting force:true on done MUST fail with PERMISSION_DENIED!
      const llmForceRes = await orchSwarmTool.execute(
        "tc-llm-force-ban",
        {
          action: "done",
          summary: "Trying to sneak past unpassed VAL-OVR-001",
          force: true,
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.equal(llmForceRes.isError, true);
      assert.equal((llmForceRes.details as any)?.errorCode, "PERMISSION_DENIED");
      const llmForceText = (llmForceRes.content[0] as any)?.text ?? "";
      assert.ok(
        llmForceText.includes("LLM orchestrator cannot pass force:true") &&
          llmForceText.includes("override_assertion"),
      );
      assert.equal(engine.getSnapshot().run?.status, "active");

      // Worker & validator MUST be rejected with PERMISSION_DENIED on override_assertion
      await assert.rejects(
        () =>
          workerBridge!.manageMission!({
            op: "override_assertion",
            assertionId: "VAL-OVR-001",
            justification:
              "Worker trying to override an assertion with a 55-char note.",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );
      await assert.rejects(
        () =>
          validatorBridge!.manageMission!({
            op: "override_assertion",
            assertionId: "VAL-OVR-001",
            justification:
              "Validator trying to override instead of verifying with evidence.",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );

      // Reject short (<30 chars) and lazy override excuses
      const badOverrideJustifications = [
        "Too short (<30 chars)",
        "low priority item that does not affect core checkout flow today",
        "non-blocking check for local dev environment without credentials",
        "will fix later once CI secrets are provisioned in staging repo",
        "later in wave 3 when external sandbox credentials become ready",
        "todo: wire live stripe cli listener in follow-up milestone soon",
        "n/a because local offline environment cannot reach external api",
        "minor edge case that only triggers on live stripe webhook calls",
        "ignore for now because sandbox api key is unavailable locally!!",
        "skip live webhook check because network egress is restricted here",
        "force passing this assertion to unblock mission completion gate",
      ];
      for (const badExcuse of badOverrideJustifications) {
        await assert.rejects(
          () =>
            engine.manageMission({
              op: "override_assertion",
              assertionId: "VAL-OVR-001",
              justification: badExcuse,
            }),
          (err: unknown) =>
            err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
          `Expected override excuse to be rejected: "${badExcuse}"`,
        );
      }

      // Audited override_assertion (>= 30 chars concrete justification) succeeds, stamps [OVERRIDE], logs audit_completed, and auto-seals m-ovr!
      const validJustification =
        "Air-gapped CI runner blocks outbound api.stripe.com egress; HMAC-SHA256 signature verification proved deterministically via signed fixture vectors in tests/webhook.test.ts.";
      const ovrToolRes = await orchSwarmTool.execute(
        "tc-ovr-ok",
        {
          action: "mission",
          mission_op: "override_assertion",
          assertion_id: "VAL-OVR-001",
          justification: validJustification,
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!ovrToolRes.isError);

      const updatedVal = engine
        .getSnapshot()
        .run?.assertions?.find((a) => a.id === "VAL-OVR-001")!;
      assert.equal(updatedVal.status, "passed");
      assert.equal(updatedVal.overridden, true);
      assert.equal(updatedVal.overrideJustification, validJustification);
      assert.equal(updatedVal.evidence, `[OVERRIDE] ${validJustification}`);
      assert.equal(updatedVal.verifiedBy, ORCHESTRATOR_NAME);
      assert.equal(updatedVal.verifiedByRole, "orchestrator");

      const sealedMs = engine
        .getSnapshot()
        .run?.milestones?.find((m) => m.label === "m-ovr")!;
      assert.equal(sealedMs.status, "done");
      assert.equal(sealedMs.sealed, true);

      const auditEvents = store.events.filter(
        (e) =>
          e.type === "audit_completed" &&
          (e.data as any)?.op === "override_assertion" &&
          (e.data as any)?.assertionId === "VAL-OVR-001",
      );
      assert.equal(auditEvents.length, 1);
      assert.equal((auditEvents[0]!.data as any)?.overridden, true);

      // Now normal orchestrator done (without force) passes all 5 Goal Gates cleanly!
      const cleanDone = await orchSwarmTool.execute(
        "tc-done-after-ovr",
        {
          action: "done",
          summary: "Completed with 1 verified + 1 audited override assertion.",
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!cleanDone.isError);
      assert.equal(engine.getSnapshot().run?.status, "completed");

      // Separate run: verify human callerRole CAN still force-close via /swarm done --force when gates are unmet
      const { engine: humanEngine } = await createTestHarness({
        stallWatchdogEnabled: false,
      });
      try {
        await humanEngine.manageMission({
          op: "upsert_assertions",
          assertions: [
            { id: "VAL-HUMAN-1", title: "Unfinished", description: "Unfinished" },
          ],
        });
        const humanTool2 = createSwarmTools({
          engine: humanEngine,
          getCallerRole: () => "human",
          getCallerName: () => "human",
        }).find((t) => t.name === SWARM_TOOL)!;
        const humanForced = await humanTool2.execute(
          "tc-human-force",
          {
            action: "done",
            summary: "Human CLI /swarm done --force",
            force: true,
          } as any,
          undefined,
          undefined,
          toolCtx,
        );
        assert.ok(!humanForced.isError);
        assert.equal(humanEngine.getSnapshot().run?.status, "completed");
        void humanSwarmTool;
      } finally {
        await humanEngine.dispose();
      }
    } finally {
      await engine.dispose();
    }
  });

  it("2. [Gap 2] dispatches DAG-ready & filesOwned-disjoint features onto fresh share worktrees via dispatch_ready and runs worktree init commands before worker turn 1", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v090-dispatch-"));
    const store = new MockSwarmStore();
    const worktree = new MockWorktreeManager();
    // Point worktrees at real directories under tmpRoot so the shell `init` command executes inside each isolated cwd!
    store.getWorktreePath = (runId: string, memberName: string) =>
      path.join(tmpRoot, runId, `wt-${memberName}`);
    const origCreateWt = worktree.createWorktree.bind(worktree);
    worktree.createWorktree = async (opts) => {
      await mkdir(opts.worktreePath, { recursive: true });
      return origCreateWt(opts);
    };

    const transport = new ScriptedTransport();
    const initMarkersObservedOnFirstTurn = new Map<string, string>();
    const holdTurn = new Map<string, () => void>();

    transport.setDefaultHandler(async ({ request, turnIndex }) => {
      if (turnIndex === 1 && request.workspace === "share") {
        const markerFile = path.join(request.cwd, ".init-marker");
        const content = await readFile(markerFile, "utf8").catch(() => "MISSING");
        initMarkersObservedOnFirstTurn.set(request.name, content.trim());
      }
      if (request.name === "feat-auth" || request.name === "feat-billing") {
        await new Promise<void>((resolve) => {
          holdTurn.set(request.name, resolve);
        });
      }
      return { outcome: "waiting", summary: `${request.name} ready` };
    });

    const engine = new SwarmEngine({
      store,
      worktree,
      transport,
      settings: { stallWatchdogEnabled: false, maxConcurrency: 4 },
    });

    try {
      const run = await store.createRun({
        id: "run-q",
        title: "Queue Runner & Init Hook Test",
        objective: "Dispatch DAG-ready features safely",
        baseBranch: "main",
        ownerSessionId: "sess-q",
        maxConcurrency: 4,
        commands: [
          { name: "init", command: "printf 'init-ok:%s' \"$(basename \"$PWD\")\" > .init-marker" },
          { name: "test", command: "npm test" },
        ],
      });
      await engine.startRun(run.id);

      await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          { id: "VAL-Q-1", title: "Auth slice", description: "Auth works" },
          { id: "VAL-Q-2", title: "Billing slice", description: "Billing works" },
          { id: "VAL-Q-3", title: "Auth session overlap", description: "Session works" },
          { id: "VAL-Q-4", title: "Downstream route", description: "Route works" },
        ],
      });

      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-auth",
            title: "Auth JWT core",
            description: "Implement src/auth/jwt.ts",
            milestone: "m1",
            filesOwned: ["src/auth/jwt.ts"],
            fulfills: ["VAL-Q-1"],
          },
          {
            id: "feat-billing",
            title: "Stripe billing",
            description: "Implement src/billing/stripe.ts",
            milestone: "m1",
            filesOwned: ["src/billing/stripe.ts"],
            fulfills: ["VAL-Q-2"],
          },
          {
            id: "feat-auth-overlap",
            title: "Auth directory refactor",
            description: "Touches parent directory src/auth (collides with feat-auth!)",
            milestone: "m1",
            filesOwned: ["src/auth"],
            fulfills: ["VAL-Q-3"],
          },
          {
            id: "feat-routes",
            title: "Protected routes depending on feat-auth",
            description: "Depends on feat-auth completing first",
            milestone: "m1",
            dependsOn: ["feat-auth"],
            filesOwned: ["src/routes/protected.ts"],
            fulfills: ["VAL-Q-4"],
          },
        ],
      });

      // Non-orchestrator cannot call dispatch_ready
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "dispatch_ready",
            callerRole: "worker",
            callerName: "rogue",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "PERMISSION_DENIED",
      );

      // Wave 1 dispatch_ready: dispatches ONLY feat-auth & feat-billing (skips feat-auth-overlap due to parent/child path prefix collision, and skips feat-routes due to unmet dependsOn!)
      const swarmTool = createSwarmTools({ engine }).find((t) => t.name === SWARM_TOOL)!;
      const wave1ToolRes = await swarmTool.execute(
        "tc-dispatch-1",
        { action: "mission", mission_op: "dispatch_ready" } as any,
        undefined,
        undefined,
        {} as unknown as ExtensionToolContext,
      );
      assert.ok(!wave1ToolRes.isError);
      const wave1 = wave1ToolRes.details as any;
      assert.deepEqual(wave1.dispatchedFeatures, ["feat-auth", "feat-billing"]);
      assert.deepEqual(wave1.spawnedMembers, ["feat-auth", "feat-billing"]);

      await waitUntil(
        () => holdTurn.has("feat-auth") && holdTurn.has("feat-billing"),
      );

      // Verify `init` shell command executed in BOTH isolated share worktrees BEFORE worker turn 1!
      assert.equal(
        initMarkersObservedOnFirstTurn.get("feat-auth"),
        "init-ok:wt-feat-auth",
      );
      assert.equal(
        initMarkersObservedOnFirstTurn.get("feat-billing"),
        "init-ok:wt-feat-billing",
      );

      // Verify both spawned workers are fresh, clean-context, isolated `share` workers and features are `in_progress`
      const snapWave1 = engine.getSnapshot().run!;
      assert.equal(snapWave1.members["feat-auth"]?.workspace, "share");
      assert.equal(snapWave1.members["feat-auth"]?.forkedFrom, undefined);
      assert.equal(
        snapWave1.features?.find((f) => f.id === "feat-auth")?.status,
        "in_progress",
      );
      assert.equal(
        snapWave1.features?.find((f) => f.id === "feat-auth")?.assignedMember,
        "feat-auth",
      );
      assert.equal(
        snapWave1.features?.find((f) => f.id === "feat-auth-overlap")?.status,
        "pending",
      );
      assert.equal(
        snapWave1.features?.find((f) => f.id === "feat-routes")?.status,
        "pending",
      );

      // Calling dispatch_ready again while feat-auth is still in_progress dispatches 0 features
      const midWave = await engine.manageMission({ op: "dispatch_ready" });
      assert.deepEqual(midWave.dispatchedFeatures, []);

      // Finish & merge feat-auth & feat-billing -> unblocks BOTH feat-auth-overlap AND feat-routes!
      holdTurn.get("feat-auth")!();
      holdTurn.get("feat-billing")!();
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["feat-auth"]?.state === "waiting" &&
          engine.getSnapshot().run?.members["feat-billing"]?.state === "waiting",
      );
      await engine.postMessage({
        from: "feat-auth",
        fromRole: "worker",
        text: "@orchestrator [done] Auth JWT complete",
        featureId: "feat-auth",
        verificationEvidence: "npm test -- jwt.test.ts -> 7/7 passed",
      });
      await engine.postMessage({
        from: "feat-billing",
        fromRole: "worker",
        text: "@orchestrator [done] Billing complete",
        featureId: "feat-billing",
        verificationEvidence: "npm test -- stripe.test.ts -> 5/5 passed",
      });
      await engine.mergeMember("feat-auth");
      await engine.mergeMember("feat-billing");

      // Wave 2 with maxDispatch: 1 caps batch size to 1, then next call dispatches the remaining ready feature!
      const wave2a = await engine.manageMission({
        op: "dispatch_ready",
        maxDispatch: 1,
      });
      assert.deepEqual(wave2a.dispatchedFeatures, ["feat-auth-overlap"]);
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["feat-auth-overlap"]?.state === "waiting",
      );

      const wave2b = await engine.manageMission({ op: "dispatch_ready" });
      assert.deepEqual(wave2b.dispatchedFeatures, ["feat-routes"]);
      await waitUntil(
        () => engine.getSnapshot().run?.members["feat-routes"]?.state === "waiting",
      );

      // Verify failing `init` command records warning in logTail WITHOUT crashing addMembers!
      await engine.manageMission({
        op: "set_manifest",
        force: true,
        commands: [{ name: "init", command: "echo 'missing-Optional-Bin' >&2 && exit 7" }],
      });
      await engine.addMembers({
        name: "warn-worker",
        workspace: "share",
        brief: "Check non-fatal init warning",
      });
      await waitUntil(
        () => engine.getSnapshot().run?.members["warn-worker"]?.state === "waiting",
      );
      const warnMember = engine.getSnapshot().run!.members["warn-worker"]!;
      assert.ok(
        warnMember.logTail.some(
          (line) => line.includes("[init]") && line.includes("code 7"),
        ),
        `Expected non-zero init warning in logTail, got: ${JSON.stringify(warnMember.logTail)}`,
      );
    } finally {
      for (const release of holdTurn.values()) {
        release();
      }
      await engine.dispose();
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("3. [Gap 3] auto-spawns @validator on mergeMember with Dual-Layer brief, revives stopped validator with Incremental Re-Validation after fixes, and spawns @validator-2 if prior validator was killed", async () => {
    const { engine, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    const validatorPrompts: Array<{ name: string; call: number; prompt: string }> = [];

    transport.onMember("validator*", async ({ request, prompt }) => {
      const call =
        validatorPrompts.filter((p) => p.name === request.name).length + 1;
      validatorPrompts.push({ name: request.name, call, prompt });
      if (request.name === "validator" && call === 1) {
        // Initial milestone review: VAL-DL-001 passes, VAL-DL-002 fails; validator parks as `stopped` to test revival!
        await request.engineApi!.manageMission!({
          op: "verify_assertion",
          assertionId: "VAL-DL-001",
          assertionStatus: "passed",
          evidence: "npm test -- login.test.ts: 5/5 passed",
        });
        await request.engineApi!.manageMission!({
          op: "verify_assertion",
          assertionId: "VAL-DL-002",
          assertionStatus: "failed",
          evidence: "Rate limiter returned 200 instead of 429 on 6th burst request",
        });
        return { outcome: "stopped", summary: "parked cold after initial audit" };
      }
      if (request.name === "validator" && call === 2) {
        // Incremental re-validation after fix: verify VAL-DL-002 passes -> seals m-dl-1!
        await request.engineApi!.manageMission!({
          op: "verify_assertion",
          assertionId: "VAL-DL-002",
          assertionStatus: "passed",
          evidence: "Re-tested burst endpoint: 6th request returns 429 Retry-After",
        });
      }
      return { outcome: "waiting", summary: "audit complete" };
    });

    try {
      await engine.manageMission({
        op: "set_manifest",
        commands: [
          { name: "typecheck", command: "npm run typecheck" },
          { name: "test", command: "npm test" },
        ],
        services: [
          {
            name: "api",
            start: "npm run start:api",
            port: 4100,
            healthcheck: "http://127.0.0.1:4100/healthz",
          },
        ],
      });
      await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          {
            id: "VAL-DL-001",
            title: "Login endpoint issues token",
            description: "POST /login returns 200 + JWT.",
          },
          {
            id: "VAL-DL-002",
            title: "Login burst rate limiter",
            description: "6th request within 10s returns 429.",
          },
          {
            id: "VAL-DL-003",
            title: "Milestone 2 health endpoint",
            description: "GET /healthz returns 200.",
          },
        ],
      });
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-login",
            title: "Login & rate limit",
            description: "Implement login & limiter",
            milestone: "m-dl-1",
            fulfills: ["VAL-DL-001", "VAL-DL-002"],
          },
        ],
      });

      // Dispatch & finish feat-login WITHOUT any validator spawned yet
      await engine.manageMission({ op: "dispatch_ready" });
      await waitUntil(
        () => engine.getSnapshot().run?.members["feat-login"]?.state === "waiting",
      );
      await engine.postMessage({
        from: "feat-login",
        fromRole: "worker",
        text: "@orchestrator [done] Implemented login",
        featureId: "feat-login",
        verificationEvidence: "npm run typecheck && npm test -> 10/10 passed",
      });

      // Merging feat-login MUST auto-spawn @validator (role:"validator", workspace:"inherit") with Dual-Layer brief!
      const merge1 = (await engine.mergeMember("feat-login")) as any;
      assert.ok(merge1);
      assert.equal(merge1.milestoneValidationCues?.[0]?.validatorSpawned, "validator");
      assert.equal(
        engine.getSnapshot().run?.members.validator?.role,
        "validator",
      );
      assert.equal(
        engine.getSnapshot().run?.members.validator?.workspace,
        "inherit",
      );

      // Wait for @validator turn 1 to finish and park in `stopped`
      await waitUntil(
        () =>
          validatorPrompts.length === 1 &&
          engine.getSnapshot().run?.members.validator?.state === "stopped",
      );
      assert.ok(
        validatorPrompts[0]!.prompt.includes("[milestone-review]") &&
          validatorPrompts[0]!.prompt.includes("Layer 1 (Scrutiny)") &&
          validatorPrompts[0]!.prompt.includes("Layer 2 (Behavioral") &&
          validatorPrompts[0]!.prompt.includes("write_library") &&
          validatorPrompts[0]!.prompt.includes("api:4100"),
      );

      // Now add fix feature feat-login-fix in m-dl-1, complete & merge it -> revives `stopped` @validator with Incremental Re-Validation!
      await engine.manageMission({
        op: "upsert_features",
        prepend: true,
        features: [
          {
            id: "feat-login-fix",
            title: "Fix burst limiter threshold",
            description: "Return 429 on 6th request",
            milestone: "m-dl-1",
            fulfills: ["VAL-DL-002"],
          },
        ],
      });
      await engine.manageMission({ op: "dispatch_ready" });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["feat-login-fix"]?.state === "waiting",
      );
      await engine.postMessage({
        from: "feat-login-fix",
        fromRole: "worker",
        text: "@orchestrator [done] Fixed burst threshold",
        featureId: "feat-login-fix",
        verificationEvidence: "npm test -- limiter.test.ts -> 6/6 passed",
      });

      const mergeFix = (await engine.mergeMember("feat-login-fix")) as any;
      assert.equal(mergeFix.milestoneValidationCues?.[0]?.validatorWoken, "validator");

      await waitUntil(
        () =>
          validatorPrompts.length === 2 &&
          engine.getSnapshot().run?.members.validator?.state === "waiting",
      );
      assert.ok(
        validatorPrompts[1]!.prompt.includes("Incremental Re-Validation") &&
          validatorPrompts[1]!.prompt.includes("VAL-DL-001") &&
          validatorPrompts[1]!.prompt.includes("VAL-DL-002 [failed]"),
        "revived validator prompt must instruct Incremental Re-Validation focusing on unpassed VAL-DL-002 while noting passed VAL-DL-001",
      );
      assert.equal(
        engine.getSnapshot().run?.milestones?.find((m) => m.label === "m-dl-1")?.sealed,
        true,
      );

      // Retire @validator (`killed`) and complete milestone 2 -> auto-spawns @validator-2!
      await engine.killMember("validator", { reason: "retire m1 validator" });
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-m2-health",
            title: "Healthcheck endpoint",
            description: "Add /healthz",
            milestone: "m-dl-2",
            fulfills: ["VAL-DL-003"],
          },
        ],
      });
      await engine.manageMission({ op: "dispatch_ready" });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["feat-m2-health"]?.state === "waiting",
      );
      await engine.postMessage({
        from: "feat-m2-health",
        fromRole: "worker",
        text: "@orchestrator [done] Added /healthz",
        featureId: "feat-m2-health",
        verificationEvidence: "npm test -- health.test.ts -> 3/3 passed",
      });

      const mergeM2 = (await engine.mergeMember("feat-m2-health")) as any;
      assert.equal(
        mergeM2.milestoneValidationCues?.[0]?.validatorSpawned,
        "validator-2",
      );
      await waitUntil(
        () => engine.getSnapshot().run?.members["validator-2"]?.state === "waiting",
      );
    } finally {
      await engine.dispose();
    }
  });

  it("4. [Gap 4] enforces mandatory structured worker handoff (verification_evidence >= 10 chars & explicit feature_id on multi-feature assignment) when reporting [done]", async () => {
    const { engine, transport } = await createTestHarness({
      stallWatchdogEnabled: false,
    });
    let workerBridge: SpawnMemberRequest["engineApi"] | undefined;
    transport.onMember("author-ho", async ({ request }) => {
      workerBridge = request.engineApi;
    });

    try {
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "feat-ho-1",
            title: "Feature 1",
            description: "Implement feature 1",
            milestone: "m-ho",
            assignedMember: "author-ho",
            status: "in_progress",
          },
          {
            id: "feat-ho-2",
            title: "Feature 2",
            description: "Implement feature 2",
            milestone: "m-ho",
          },
        ],
      });

      await engine.addMembers({
        name: "author-ho",
        workspace: "share",
        brief: "Implement feat-ho-1",
      });
      await waitUntil(
        () => engine.getSnapshot().run?.members["author-ho"]?.state === "waiting",
      );
      assert.ok(workerBridge);

      const memberPostTool = createMemberScopedTools(workerBridge, {
        name: "author-ho",
        role: "worker",
        runId: "run-dyn",
      }).find((t) => t.name === POST_MESSAGE_TOOL)!;
      assert.ok(memberPostTool.description.includes("verification_evidence"));

      // 1) Missing verification_evidence when uniquely assigned to feat-ho-1 (even with feature_id omitted!) -> INVALID_INPUT
      const missingEvRes = await memberPostTool.execute(
        "tc-ho-missing",
        {
          text: "@orchestrator [done] Finished feat-ho-1",
        } as any,
        undefined,
        undefined,
        {} as unknown as ExtensionToolContext,
      );
      assert.equal(missingEvRes.isError, true);
      assert.equal((missingEvRes.details as any)?.errorCode, "INVALID_INPUT");
      assert.ok(
        ((missingEvRes.content[0] as any)?.text ?? "").includes("feat-ho-1") &&
          ((missingEvRes.content[0] as any)?.text ?? "").includes("verification_evidence"),
      );

      // 2) Too-short (< 10 chars) verification_evidence -> INVALID_INPUT
      await assert.rejects(
        () =>
          workerBridge!.postMessage({
            text: "@orchestrator [done] Finished feat-ho-1",
            featureId: "feat-ho-1",
            verificationEvidence: "ok pass",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );

      // 3) Multiple active features assigned to same worker without explicit feature_id -> INVALID_INPUT
      await engine.manageMission({
        op: "update_feature",
        featureId: "feat-ho-2",
        assignedMember: "author-ho",
        featureStatus: "in_progress",
      });
      await assert.rejects(
        () =>
          workerBridge!.postMessage({
            text: "@orchestrator [done] Finished one of my features",
            verificationEvidence: "npm test -> 14/14 passed",
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError &&
          err.code === "INVALID_INPUT" &&
          err.message.includes("Multiple Mission features are assigned to you"),
      );

      // 4) Non-empty left_undone allows reporting [done] without verification_evidence (explaining why work stopped incomplete)
      const partialMsg = await workerBridge.postMessage({
        text: "@orchestrator [done] Stopped on blocker in feat-ho-2",
        featureId: "feat-ho-2",
        leftUndone: ["Waiting on upstream schema migration in billing table"],
      });
      assert.equal(partialMsg.featureId, "feat-ho-2");
      assert.equal(engine.getSnapshot().run?.handoffItems?.length, 1);

      // 5) Valid verification_evidence (>= 10 chars) + explicit feature_id succeeds cleanly!
      const okDoneRes = await memberPostTool.execute(
        "tc-ho-ok",
        {
          text: "@orchestrator [done] commit=1234567 Completed feat-ho-1",
          feature_id: "feat-ho-1",
          verification_evidence: "npm run typecheck && npm test -> 22/22 passed",
          discovered_issues: ["Minor log formatting nit in cli.ts"],
        } as any,
        undefined,
        undefined,
        {} as unknown as ExtensionToolContext,
      );
      assert.ok(!okDoneRes.isError);
      assert.equal(
        (okDoneRes.details as BoardMessage).verificationEvidence,
        "npm run typecheck && npm test -> 22/22 passed",
      );
    } finally {
      await engine.dispose();
    }
  });

  it("5. [Gap 6] validates services port/name uniqueness, shares persistent library/ topics across orchestrator/worker/validator, and injects v0.9.0 prompts with flat schemas", async () => {
    const tmpProject = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-v090-lib-"));
    const realStore = new SwarmStore(tmpProject);
    const worktree = new MockWorktreeManager();
    const transport = new ScriptedTransport();

    let workerBridge: SpawnMemberRequest["engineApi"] | undefined;
    let validatorBridge: SpawnMemberRequest["engineApi"] | undefined;
    transport.onMember("lib-worker", async ({ request }) => {
      workerBridge = request.engineApi;
    });
    transport.onMember("lib-val", async ({ request }) => {
      validatorBridge = request.engineApi;
    });

    const engine = new SwarmEngine({
      store: realStore,
      worktree,
      transport,
      settings: { stallWatchdogEnabled: false },
    });

    try {
      const run = await realStore.createRun({
        id: "run-lib",
        title: "Services & Library Test",
        objective: "Share knowledge & enforce port boundaries",
        baseBranch: "main",
        ownerSessionId: "sess-lib",
      });
      await engine.startRun(run.id);

      const orchTools = createSwarmTools({ engine });
      const orchSwarmTool = orchTools.find((t) => t.name === SWARM_TOOL)!;
      const toolCtx = {} as unknown as ExtensionToolContext;

      // 1) Duplicate service names & duplicate ports across services MUST fail with INVALID_INPUT
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "set_manifest",
            services: [
              { name: "api", start: "npm run api", port: 3000 },
              { name: "API", start: "npm run api2", port: 3001 },
            ],
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "set_manifest",
            services: [
              { name: "api", start: "npm run api", port: 4500 },
              { name: "worker-svc", start: "npm run worker", port: 4500 },
            ],
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError &&
          err.code === "INVALID_INPUT" &&
          err.message.includes("4500"),
      );

      // Valid services manifest via swarmTool
      const setSvcRes = await orchSwarmTool.execute(
        "tc-set-svc",
        {
          action: "mission",
          mission_op: "set_manifest",
          commands: [{ name: "test", command: "npm test" }],
          services: [
            {
              name: "api",
              start: "npm run dev:api",
              stop: "pkill -f dev:api",
              healthcheck: "http://127.0.0.1:4500/health",
              port: 4500,
            },
            {
              name: "web",
              start: "npm run dev:web",
              healthcheck: "http://127.0.0.1:5173",
              port: 5173,
              depends_on: ["api"],
            },
          ],
          boundaries: ["Never bind ports outside services.json"],
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!setSvcRes.isError);
      assert.equal(engine.getSnapshot().run?.services?.length, 2);

      // Adding a third service colliding with existing port 4500 (without force replace) MUST also fail!
      await assert.rejects(
        () =>
          engine.manageMission({
            op: "set_manifest",
            services: [{ name: "metrics", start: "npm run metrics", port: 4500 }],
          }),
        (err: unknown) =>
          err instanceof SwarmProtocolError && err.code === "INVALID_INPUT",
      );

      await engine.addMembers({ name: "lib-worker", brief: "Explore & write library" });
      await engine.addMembers({
        name: "lib-val",
        role: "validator",
        brief: "Validate & record testing notes",
      });
      await waitUntil(
        () =>
          engine.getSnapshot().run?.members["lib-worker"]?.state === "waiting" &&
          engine.getSnapshot().run?.members["lib-val"]?.state === "waiting",
      );
      assert.ok(workerBridge);
      assert.ok(validatorBridge);

      const workerSwarmTool = createMemberScopedTools(workerBridge, {
        name: "lib-worker",
        role: "worker",
        runId: run.id,
      }).find((t) => t.name === SWARM_TOOL)!;
      const validatorSwarmTool = createMemberScopedTools(validatorBridge, {
        name: "lib-val",
        role: "validator",
        runId: run.id,
      }).find((t) => t.name === SWARM_TOOL)!;

      // 2) read_library without topic lists default initialized topics (architecture, environment, testing)
      const listRes = await workerSwarmTool.execute(
        "tc-lib-list",
        { action: "mission", mission_op: "read_library" } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!listRes.isError);
      assert.deepEqual((listRes.details as any).libraryTopics, [
        "architecture",
        "environment",
        "testing",
      ]);

      // 3) Worker writes/appends environment discoveries; Validator appends testing notes; Orchestrator reads both!
      const workerWrite = await workerSwarmTool.execute(
        "tc-lib-worker-write",
        {
          action: "mission",
          mission_op: "write_library",
          library_topic: "environment",
          library_content: "- API requires PORT=4500 and NODE_ENV=test",
          library_append: true,
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!workerWrite.isError);

      const valWrite = await validatorSwarmTool.execute(
        "tc-lib-val-write",
        {
          action: "mission",
          mission_op: "write_library",
          library_topic: "testing",
          library_content: "- Run healthcheck curl -sf http://127.0.0.1:4500/health before E2E suite",
          library_append: true,
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!valWrite.isError);

      const orchReadEnv = await orchSwarmTool.execute(
        "tc-lib-orch-read-env",
        {
          action: "mission",
          mission_op: "read_library",
          library_topic: "environment",
        } as any,
        undefined,
        undefined,
        toolCtx,
      );
      assert.ok(!orchReadEnv.isError);
      assert.ok(
        ((orchReadEnv.details as any).libraryContent as string).includes(
          "PORT=4500 and NODE_ENV=test",
        ),
      );

      const onDiskTesting = await readFile(
        path.join(tmpProject, ".pi/swarm/runs", run.id, "library/testing.md"),
        "utf8",
      );
      assert.ok(onDiskTesting.includes("http://127.0.0.1:4500/health"));

      // 4) Role prompts inject services, ports, healthchecks, library/, mission-worker-base startup discipline, and dual-layer incremental validator guidance
      const snap = engine.getSnapshot();
      const staticSec = buildOrchestratorStaticSection(snap);
      const playbookSec = buildOrchestratorPlaybookSection(snap);
      const workerSys = buildMemberSystemPrompt(
        snap.run!,
        snap.run!.members["lib-worker"]!,
      );
      const valSys = buildMemberSystemPrompt(
        snap.run!,
        snap.run!.members["lib-val"]!,
      );

      for (const p of [staticSec, playbookSec, workerSys, valSys]) {
        assert.ok(p.includes("port 4500") && p.includes("port 5173"));
        assert.ok(p.includes("http://127.0.0.1:4500/health"));
        assert.ok(p.includes(`.pi/swarm/runs/${run.id}/library/`));
        assert.ok(p.includes("read_library") && p.includes("write_library"));
      }
      assert.ok(
        workerSys.includes("mission-worker-base") &&
          workerSys.includes("verification_evidence"),
      );
      assert.ok(
        valSys.includes("scrutiny") &&
          valSys.includes("Incremental Re-Validation"),
      );
      assert.ok(
        playbookSec.includes("dispatch_ready") &&
          playbookSec.includes("override_assertion"),
      );
    } finally {
      await engine.dispose();
      await rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ============================================================================
// Validator Isolated Scratch Sandbox & Safety-Filter-Safe Member Naming
// ============================================================================

describe("Validator Isolated Scratch Sandbox & Safety-Filter-Safe Member Naming", () => {
  it("allows write/edit and temporary build/fixture/mutation bash commands inside validator scratchDir while blocking repo, worktree, symlink & non-&& escapes", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-swarm-val-scratch-test-"));
    const repoRoot = path.join(tmpRoot, "repo");
    const scratchDir = getValidatorScratchDir("run_scratch_1", "validator", tmpRoot);
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await mkdir(scratchDir, { recursive: true });
    await writeFile(path.join(repoRoot, "src/index.ts"), "export const x = 1;\n", "utf8");

    try {
      // 1. Symlink escape inside scratchDir pointing to repo is blocked!
      const outsideLink = path.join(scratchDir, "repo-link");
      await symlink(path.join(repoRoot, "src"), outsideLink);
      assert.equal(
        resolveValidatorScratchPath(path.join(outsideLink, "index.ts"), scratchDir),
        null,
      );
      assert.ok(
        resolveValidatorScratchPath(path.join(scratchDir, "probe/fixture.ts"), scratchDir),
      );
      assert.equal(
        resolveValidatorScratchPath(scratchDir, scratchDir, { allowRoot: false }),
        null,
      );
      assert.equal(
        resolveValidatorScratchPath(scratchDir, scratchDir, { allowRoot: true }),
        path.resolve(scratchDir),
      );

      // 2. Validator tool_call guard allows write/edit inside scratchDir and blocks repo / outside / symlink targets
      let toolHandler: ((event: Record<string, unknown>) => unknown) | undefined;
      const factory = createValidatorGuardExtensionFactory(
        "validator",
        true,
        repoRoot,
        scratchDir,
      );
      factory({
        on(eventName: string, cb: (event: Record<string, unknown>) => unknown) {
          if (eventName === "tool_call") {
            toolHandler = cb;
          }
        },
      } as unknown as Parameters<typeof factory>[0]);
      assert.ok(toolHandler);

      assert.equal(
        toolHandler!({
          toolName: "write",
          input: { path: path.join(scratchDir, "probe/test.rs"), content: "fn main() {}" },
        }),
        undefined,
      );
      assert.equal(
        toolHandler!({
          toolName: "edit",
          input: { path: path.join(scratchDir, "probe/test.rs") },
        }),
        undefined,
      );
      const blockedRepoWrite = toolHandler!({
        toolName: "write",
        input: { path: "src/index.ts", content: "mutated" },
      }) as { block?: boolean; reason?: string };
      assert.equal(blockedRepoWrite?.block, true);
      assert.match(blockedRepoWrite?.reason ?? "", /isolated scratch directory/);

      const blockedSymlinkEdit = toolHandler!({
        toolName: "edit",
        input: { path: path.join(outsideLink, "index.ts") },
      }) as { block?: boolean };
      assert.equal(blockedSymlinkEdit?.block, true);

      // 3. Bash guard with scratchDir allows safe build/fixture/mutation workflows inside scratchDir
      assert.equal(
        isReadOnlyValidationCommand(
          `mkdir -p "${scratchDir}/work" && cp -r "${repoRoot}/src" "${scratchDir}/work/src" && cd "${scratchDir}/work" && sed -i '' 's/1/2/' src/index.ts && cargo test --target-dir "${scratchDir}/target" > "${scratchDir}/test.log" 2>&1`,
          scratchDir,
        ).allowed,
        true,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `cd "${scratchDir}" && mkdir -p sub && touch sub/a.txt && mv sub/a.txt sub/b.txt && chmod +x sub/b.txt && rm -rf sub`,
          scratchDir,
        ).allowed,
        true,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `git diff | tee "${scratchDir}/diff.patch"`,
          scratchDir,
        ).allowed,
        true,
      );

      // 4. Bash guard still strictly blocks outside /tmp, scratch root deletion, symlink creation, repo copies, and non-&& cwd escapes
      assert.equal(isReadOnlyValidationCommand("rm -rf /tmp/other", scratchDir).allowed, false);
      assert.equal(isReadOnlyValidationCommand(`rm -rf "${scratchDir}"`, scratchDir).allowed, false);
      assert.equal(
        isReadOnlyValidationCommand(
          `cp "${scratchDir}/bad.ts" "${repoRoot}/src/index.ts"`,
          scratchDir,
        ).allowed,
        false,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `cp -s "${repoRoot}/src/index.ts" "${scratchDir}/sym.ts"`,
          scratchDir,
        ).allowed,
        false,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `ln -s "${repoRoot}/src" "${scratchDir}/new-link"`,
          scratchDir,
        ).allowed,
        false,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `mv "${repoRoot}/src/index.ts" "${scratchDir}/stolen.ts"`,
          scratchDir,
        ).allowed,
        false,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `cd "${scratchDir}/nonexistent" || rm -rf src`,
          scratchDir,
        ).allowed,
        false,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `cd "${scratchDir}/nonexistent"; rm -rf src`,
          scratchDir,
        ).allowed,
        false,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `rm -rf "${outsideLink}/index.ts"`,
          scratchDir,
        ).allowed,
        false,
      );
      assert.equal(
        isReadOnlyValidationCommand(
          `sh -c 'rm -rf "${scratchDir}/work"'`,
          scratchDir,
        ).allowed,
        false,
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("provisions & cleans validator scratchDir in SwarmEngine, rejects safety-sensitive handles (attack/exploit/hack), and sanitizes dispatch_ready handles", async () => {
    assert.equal(findSafetySensitiveMemberSegment("attack"), "attack");
    assert.equal(findSafetySensitiveMemberSegment("attack-2"), "attack");
    assert.equal(findSafetySensitiveMemberSegment("attack2"), "attack");
    assert.equal(findSafetySensitiveMemberSegment("db-exploit"), "exploit");
    assert.equal(findSafetySensitiveMemberSegment("hack-1"), "hack");
    assert.equal(findSafetySensitiveMemberSegment("probe-2"), undefined);
    assert.equal(findSafetySensitiveMemberSegment("hackathon"), undefined);

    const { engine, transport, run } = await createTestHarness();
    try {
      // 1. Safety-sensitive handles rejected with actionable suggestion
      for (const badName of ["attack", "attack-1", "db-exploit", "hack2"]) {
        await assert.rejects(
          () => engine.addMembers({ name: badName, brief: "Negative-case checks" }),
          (err: unknown) =>
            err instanceof SwarmProtocolError &&
            err.code === "INVALID_NAME" &&
            /probe|audit|verify/i.test(err.message),
        );
      }

      // 2. Validator spawned by SwarmEngine receives live scratchDir on disk & in systemPrompt, cleaned on killMember
      await engine.addMembers({
        name: "probe-val",
        role: "validator",
        brief: "Audit with isolated scratch sandbox",
      });
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      const valSpawn = transport.spawns.find((s) => s.name === "probe-val");
      assert.ok(valSpawn?.scratchDir, "Validator SpawnMemberRequest must include scratchDir");
      assert.equal(valSpawn!.scratchDir, getValidatorScratchDir(run.id, "probe-val"));
      assert.equal(existsSync(valSpawn!.scratchDir!), true);
      assert.ok(valSpawn!.systemPrompt.includes(valSpawn!.scratchDir!));
      assert.ok(valSpawn!.systemPrompt.includes("STRICTLY READ-ONLY"));

      await writeFile(path.join(valSpawn!.scratchDir!, "temp.txt"), "scratch artifact", "utf8");
      await engine.killMember("probe-val", { reason: "audit finished" });
      assert.equal(existsSync(valSpawn!.scratchDir!), false, "killMember must clean validator scratchDir");

      // 3. dispatch_ready strips safety-sensitive words when deriving worker handle from feature.id
      await engine.manageMission({
        op: "upsert_assertions",
        assertions: [
          {
            id: "VAL-CSRF-001",
            title: "CSRF token check",
            description: "Rejects missing CSRF token.",
          },
        ],
        callerRole: "orchestrator",
        callerName: ORCHESTRATOR_NAME,
      });
      await engine.manageMission({
        op: "upsert_features",
        features: [
          {
            id: "mitigate-csrf-attack",
            title: "Mitigate CSRF",
            description: "Add CSRF token check.",
            milestone: "M1",
            filesOwned: ["src/csrf.ts"],
            fulfills: ["VAL-CSRF-001"],
          },
        ],
        callerRole: "orchestrator",
        callerName: ORCHESTRATOR_NAME,
      });

      const dispatched = await engine.manageMission({
        op: "dispatch_ready",
        callerRole: "orchestrator",
        callerName: ORCHESTRATOR_NAME,
      });
      assert.deepEqual(dispatched.dispatchedFeatures, ["mitigate-csrf-attack"]);
      assert.equal(
        engine.getSnapshot().run?.features?.find((f) => f.id === "mitigate-csrf-attack")
          ?.assignedMember,
        "mitigate-csrf",
      );
      await waitUntil(() => engine.getSnapshot().workingMemberNames.length === 0);

      // Verify run scratch root is also cleaned on completeRun
      const runScratchRoot = getRunValidatorScratchRoot(run.id);
      await mkdir(path.join(runScratchRoot, "leftover"), { recursive: true });
      await engine.killMember("mitigate-csrf", { force: true, reason: "cleanup test" });
      await engine.manageMission({
        op: "update_feature",
        featureId: "mitigate-csrf-attack",
        featureStatus: "completed",
        mergedCommitSha: "deadbeef",
        callerRole: "orchestrator",
        callerName: ORCHESTRATOR_NAME,
      });
      await engine.manageMission({
        op: "verify_assertion",
        assertionId: "VAL-CSRF-001",
        assertionStatus: "passed",
        evidence: "Verified CSRF guard",
        force: true,
        callerRole: "human",
        callerName: "human",
      });
      await engine.completeRun({ summary: "Completed", callerRole: "orchestrator" });
      assert.equal(existsSync(runScratchRoot), false, "completeRun must clean run scratch root");
    } finally {
      await engine.dispose();
    }
  });
});


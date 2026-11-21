import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// 3-Role Model Configuration & Settings
// ============================================================================

export type SwarmModelRole = "orchestrator" | "worker" | "validator";

export type StallMonitorMode = "llm" | "deterministic";

export interface SwarmRoleModelConfig {
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

export interface SwarmRoleModels {
  orchestrator?: SwarmRoleModelConfig;
  worker?: SwarmRoleModelConfig;
  validator?: SwarmRoleModelConfig;
  fallbackModels?: string[];
}

export interface SwarmSettings {
  orchestratorModel?: string | undefined;
  orchestratorThinkingLevel?: ThinkingLevel | undefined;
  workerModel?: string | undefined;
  workerThinkingLevel?: ThinkingLevel | undefined;
  validatorModel?: string | undefined;
  validatorThinkingLevel?: ThinkingLevel | undefined;
  fallbackModels: string[];
  maxConcurrency: number;
  validatorEnabled: boolean;
  keepWorkersWarm: boolean;
  stallWatchdogEnabled: boolean;
  stallMonitorMode: StallMonitorMode;
  stallTimeoutMs: number;
  maxRetries: number;
  rateLimitBaseBackoffMs: number;
  rateLimitMaxBackoffMs: number;
  gitTimeoutMs: number;
  autoRebase: boolean;
  autoTeardownOnComplete: boolean;
}

export interface AvailableModelInfo {
  id: string;
  provider: string;
  /** Canonical provider/model identifier (e.g. `anthropic/claude-sonnet-4-5`). */
  fullId: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  suggested?: boolean;
  activeRoles?: SwarmModelRole[];
}

export interface ModelSwitchResult {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

// ============================================================================
// Dynamic Swarm Member, Channel & Workspace Types
// ============================================================================

export type SwarmMemberRole = "worker" | "validator";

export type CallerRole =
  | "orchestrator"
  | "worker"
  | "validator"
  | "monitor"
  | "human";

export type SwarmMemberState = "working" | "waiting" | "stopped" | "killed";

export type SwarmWorkspaceMode = "inherit" | "share" | "branch";

export type SwarmRunStatus = "active" | "paused" | "completed" | "abandoned";

export type SwarmAction =
  | "title"
  | "add"
  | "status"
  | "models"
  | "model"
  | "steer"
  | "stop"
  | "kill"
  | "merge"
  | "channel"
  | "done";

export type SwarmChannelAction =
  | "create"
  | "list"
  | "join"
  | "leave"
  | "archive";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SwarmChannelRecord {
  name: string;
  topic?: string;
  createdBy: string;
  createdAt: string;
  archived: boolean;
  archivedAt?: string;
  subscribers: string[];
}

export interface SwarmMemberRecord {
  /** Unique short lowercase handle (e.g. `researcher`, `parser`, `verifier`, `worker-1`). */
  name: string;
  agentId: string;
  role: SwarmMemberRole;
  state: SwarmMemberState;
  /** `"orchestrator"` or the worker name that spawned this helper. */
  parentName: string;
  /** Shared prefix when spawned via `n > 1` or `tasks[]` (e.g. `"worker"` for `worker-1..k`). */
  groupPrefix?: string;
  brief: string;
  briefSeq?: number;
  workspace: SwarmWorkspaceMode;
  /** Repo root for `"inherit"`, isolated worktree path for `"share"` / `"branch"`. */
  cwd: string;
  /** Git branch (`swarm/<run-short>/<name>`) for `"share"` / `"branch"`. */
  branch?: string;
  /** Disk-persisted Pi SessionManager JSONL path for crash/restart recovery. */
  sessionFile?: string;
  mergedCommitSha?: string;
  forkedFrom?: string;
  /** Subscribed channels; `"main"` is always implicitly included, and `channels[0]` is default. */
  channels: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  lastReadSeq: number;
  lastPostSeq?: number;
  lastPostTime?: string;
  /** Brief hint of what the member is waiting on or its last completion summary. */
  parkedOn?: string;
  turns: number;
  tokens: number;
  tokenBreakdown?: TokenUsage;
  cost: number;
  humanStopped: boolean;
  currentActivity?: string;
  lastTool?: string;
  logTail: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

// ============================================================================
// Shared Message Board Types (board.jsonl)
// ============================================================================

export type BoardMessageKind =
  | "brief"
  | "done"
  | "update"
  | "review"
  | "decision"
  | "model_switch"
  | "stall"
  | "chat";

export interface BoardMessage {
  seq: number;
  runId: string;
  channel: string;
  from: string;
  fromRole: CallerRole;
  text: string;
  mentions: string[];
  channelMentions: string[];
  kind: BoardMessageKind;
  timestamp: string;
}

export interface PostBoardMessageInput {
  from: string;
  fromRole: CallerRole;
  text: string;
  channel?: string;
  kind?: BoardMessageKind;
  mentions?: string[];
  channelMentions?: string[];
}

export interface ReadBoardOptions {
  since?: number;
  seqs?: number[];
  limit?: number;
  channel?: string;
  memberChannels?: readonly string[];
  search?: string;
}

export interface ReadBoardResult {
  messages: BoardMessage[];
  head: number;
}

export interface ISwarmBoard {
  post(runId: string, input: PostBoardMessageInput): Promise<BoardMessage>;
  read(runId: string, options?: ReadBoardOptions): Promise<ReadBoardResult>;
  getHead(runId: string): Promise<number>;
}

// ============================================================================
// Event Ledger Types (events.jsonl)
// ============================================================================

export type SwarmEventType =
  | "run_created"
  | "run_titled"
  | "run_paused"
  | "run_resumed"
  | "run_completed"
  | "run_abandoned"
  | "member_added"
  | "member_woken"
  | "member_waiting"
  | "member_stopped"
  | "member_killed"
  | "member_model_switched"
  | "member_merged"
  | "member_error"
  | "board_posted"
  | "channel_created"
  | "channel_updated"
  | "channel_archived"
  | "stall_detected"
  | "rate_limit_backoff"
  | "teardown_completed";

export interface SwarmEvent {
  id: string;
  seq?: number;
  runId: string;
  type: SwarmEventType;
  timestamp: string;
  actor?: string;
  memberName?: string;
  agentId?: string;
  channel?: string;
  summary: string;
  data?: Record<string, unknown>;
}

export interface SwarmEventInput {
  runId: string;
  type: SwarmEventType;
  actor?: string;
  memberName?: string;
  agentId?: string;
  channel?: string;
  summary: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
}

// ============================================================================
// Run State
// ============================================================================

export interface SwarmRunState {
  version: 2;
  id: string;
  title: string;
  objective: string;
  strategy: string;
  acceptanceCriteria: string;
  baseBranch: string;
  ownerSessionId: string;
  ownerPid: number;
  status: SwarmRunStatus;
  maxConcurrency: number;
  validatorEnabled: boolean;
  keepWorkersWarm: boolean;
  roleModels: SwarmRoleModels;
  revision: number;
  members: Record<string, SwarmMemberRecord>;
  memberOrder: string[];
  channels: Record<string, SwarmChannelRecord>;
  boardHead: number;
  completionSummary?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Flexible Drafting & Interactive Questionnaire Types (pi-goal-x style)
// ============================================================================

export interface InitialMemberProposal {
  name: string;
  role: SwarmMemberRole;
  brief: string;
  workspace?: SwarmWorkspaceMode;
  channels?: string[];
}

export interface ProposedSwarmPlan {
  title: string;
  objective: string;
  strategy: string;
  acceptanceCriteria: string;
  baseBranch: string;
  maxConcurrency: number;
  validatorEnabled: boolean;
  initialMembers?: InitialMemberProposal[];
  roleModels?: SwarmRoleModels;
}

export type SwarmDraftMode = "swarm" | "tweak";

export interface ActiveSwarmDraft {
  version: 2;
  mode: SwarmDraftMode;
  seed: string;
  targetRunId?: string;
  startedAt: string;
  validatorEnabled: boolean;
  maxConcurrency: number;
  baseBranch?: string;
  autoConfirm?: boolean;
  questionnaireEcho?: Record<string, string>;
  clearedAt?: string;
}

export interface SwarmFocusEntry {
  version: 2;
  runId: string | null;
  sessionId: string;
  reason?: string;
}

export interface QuestionOption {
  label: string;
  value?: string;
  description?: string;
}

export interface QuestionSpec {
  id: string;
  question: string;
  context?: string;
  options: QuestionOption[];
  recommended?: string;
  allowCustom?: boolean;
}

export interface QuestionAnswer {
  id: string;
  question: string;
  answer: string;
  isCustom: boolean;
}

export interface QuestionnaireResult {
  cancelled: boolean;
  answers: Record<string, string>;
  items: QuestionAnswer[];
}

export type ProposalDialogAction = "confirm" | "continue" | "cancel";

export interface ProposalDialogOutcome {
  action: ProposalDialogAction;
  validatorEnabled: boolean;
  maxConcurrency: number;
  feedback?: string;
}

export interface IQuestionnaireUI {
  askQuestion(
    ctx: ExtensionContext,
    spec: QuestionSpec,
    signal?: AbortSignal,
  ): Promise<{ cancelled: boolean; answer?: string; isCustom: boolean }>;
  askQuestionnaire(
    ctx: ExtensionContext,
    questions: QuestionSpec[],
    signal?: AbortSignal,
  ): Promise<QuestionnaireResult>;
  confirmProposal(
    ctx: ExtensionContext,
    plan: ProposedSwarmPlan,
    options?: {
      mode?: SwarmDraftMode;
      signal?: AbortSignal;
    },
  ): Promise<ProposalDialogOutcome>;
}

// ============================================================================
// Protocol Errors
// ============================================================================

export type SwarmErrorCode =
  | "INVALID_NAME"
  | "DUPLICATE_MEMBER"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_KILLED"
  | "MEMBER_NOT_WAITING"
  | "ROLE_FORBIDDEN"
  | "PERMISSION_DENIED"
  | "INVALID_CHANNEL"
  | "CHANNEL_ARCHIVED"
  | "MODEL_NOT_FOUND"
  | "DIRTY_WORKTREE"
  | "DIRTY_BASE"
  | "WRONG_BRANCH"
  | "REBASE_CONFLICT"
  | "OWNERSHIP_CONFLICT"
  | "REVISION_CONFLICT"
  | "NOT_FOUND"
  | "GIT_ERROR"
  | "INVALID_INPUT";

export class SwarmProtocolError extends Error {
  readonly code: SwarmErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SwarmErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SwarmProtocolError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSwarmProtocolError(err: unknown): err is SwarmProtocolError {
  return err instanceof SwarmProtocolError;
}

// ============================================================================
// Store Contract (src/store/)
// ============================================================================

export interface CreateRunInput {
  id?: string;
  title: string;
  objective: string;
  strategy?: string;
  acceptanceCriteria?: string;
  baseBranch: string;
  ownerSessionId: string;
  ownerPid?: number;
  maxConcurrency?: number;
  validatorEnabled?: boolean;
  keepWorkersWarm?: boolean;
  roleModels?: SwarmRoleModels;
}

export interface RunSummary {
  id: string;
  title: string;
  objective: string;
  baseBranch: string;
  status: SwarmRunStatus;
  memberCount: number;
  workingCount: number;
  waitingCount: number;
  boardHead: number;
  ownerSessionId: string;
  ownerPid: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunUpdateInput {
  title?: string;
  objective?: string;
  strategy?: string;
  acceptanceCriteria?: string;
  baseBranch?: string;
  status?: SwarmRunStatus;
  maxConcurrency?: number;
  validatorEnabled?: boolean;
  keepWorkersWarm?: boolean;
  roleModels?: SwarmRoleModels;
  ownerSessionId?: string;
  ownerPid?: number;
  completionSummary?: string;
  expectedRevision?: number;
  actor?: string;
}

export interface RegisterMemberInput {
  name: string;
  agentId: string;
  role: SwarmMemberRole;
  parentName: string;
  groupPrefix?: string;
  brief: string;
  briefSeq?: number;
  workspace: SwarmWorkspaceMode;
  cwd: string;
  branch?: string;
  sessionFile?: string;
  forkedFrom?: string;
  channels?: string[];
  state?: SwarmMemberState;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  lastReadSeq?: number;
  createdAt?: string;
}

export interface MemberUpdateInput {
  state?: SwarmMemberState;
  briefSeq?: number;
  branch?: string;
  sessionFile?: string | null;
  mergedCommitSha?: string;
  channels?: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel | null;
  lastReadSeq?: number;
  lastPostSeq?: number;
  lastPostTime?: string;
  parkedOn?: string | null;
  turns?: number;
  tokens?: number;
  tokenBreakdown?: TokenUsage;
  cost?: number;
  humanStopped?: boolean;
  currentActivity?: string | null;
  lastTool?: string | null;
  logLine?: string;
  logTail?: string[];
  error?: string | null;
  endedAt?: string | null;
  expectedRevision?: number;
  actor?: string;
}

export interface CreateChannelInput {
  name: string;
  topic?: string;
  createdBy: string;
  subscribers?: string[];
}

export interface ISwarmStore {
  readonly projectRoot: string;
  createRun(input: CreateRunInput): Promise<SwarmRunState>;
  loadRun(runId: string): Promise<SwarmRunState>;
  listRuns(): Promise<RunSummary[]>;
  getActiveRunId(): Promise<string | null>;
  updateRun(runId: string, patch: RunUpdateInput): Promise<SwarmRunState>;
  addMember(
    runId: string,
    member: RegisterMemberInput,
    options?: { expectedRevision?: number; actor?: string },
  ): Promise<SwarmRunState>;
  updateMember(
    runId: string,
    memberName: string,
    patch: MemberUpdateInput,
  ): Promise<SwarmRunState>;
  createChannel(
    runId: string,
    input: CreateChannelInput,
  ): Promise<SwarmChannelRecord>;
  subscribeChannel(
    runId: string,
    channelName: string,
    memberName: string,
  ): Promise<SwarmChannelRecord>;
  unsubscribeChannel(
    runId: string,
    channelName: string,
    memberName: string,
  ): Promise<SwarmChannelRecord>;
  archiveChannel(
    runId: string,
    channelName: string,
    actor?: string,
  ): Promise<SwarmChannelRecord>;
  postBoardMessage(
    runId: string,
    input: PostBoardMessageInput,
  ): Promise<BoardMessage>;
  readBoard(
    runId: string,
    options?: ReadBoardOptions,
  ): Promise<ReadBoardResult>;
  getBoardHead(runId: string): Promise<number>;
  appendEvent(event: SwarmEventInput): Promise<SwarmEvent>;
  getRecentEvents(runId: string, limit?: number): Promise<SwarmEvent[]>;
  renderRosterMarkdown(state: SwarmRunState): string;
  getRunDir(runId: string): string;
  getMemberSessionDir?(runId: string): string;
  getWorktreePath(runId: string, memberName: string): string;
}

// ============================================================================
// Git Worktree Manager Contract (src/store/)
// ============================================================================

export interface RepoReadyResult {
  repoRoot: string;
  baseBranch: string;
  headSha: string;
  initializedRepo: boolean;
  createdInitialCommit: boolean;
}

export interface CreateWorktreeResult {
  branch: string;
  worktreePath: string;
  baseSha: string;
}

export interface BaseBranchCleanCheck {
  ok: boolean;
  currentBranch: string;
  dirty: boolean;
  reason?: string;
}

export interface AutoRebaseResult {
  status: "up-to-date" | "rebased" | "conflict" | "skipped_dirty";
  newHeadSha?: string;
  conflictFiles?: string[];
  message?: string;
}

export interface MergeBranchResult {
  mergedCommitSha: string;
  strategy: "merge" | "fast-forward" | "noop";
  changedFiles: string[];
}

export interface DiffSummary {
  baseBranch: string;
  branch: string;
  headSha: string;
  commitsAhead: number;
  changedFiles: string[];
  stat: string;
  diff: string;
}

export interface SafeTeardownTarget {
  memberName: string;
  worktreePath: string;
  branch: string;
  hasActiveAgent: boolean;
}

export interface TeardownEntryResult {
  memberName: string;
  worktreePath: string;
  branch: string;
  action: "removed" | "skipped_dirty" | "skipped_active" | "missing" | "error";
  reason?: string;
}

export interface SafeTeardownResult {
  removed: TeardownEntryResult[];
  skipped: TeardownEntryResult[];
  errors: TeardownEntryResult[];
}

export interface IWorktreeManager {
  readonly repoRoot: string;
  ensureRepoReady(preferredBaseBranch?: string): Promise<RepoReadyResult>;
  getCurrentBranch(cwd?: string): Promise<string>;
  listLocalBranches(): Promise<string[]>;
  createWorktree(options: {
    branch: string;
    baseBranch: string;
    worktreePath: string;
    reuseExistingBranch?: boolean;
    mode?: "share" | "branch";
  }): Promise<CreateWorktreeResult>;
  removeWorktree(
    worktreePath: string,
    options?: { force?: boolean },
  ): Promise<void>;
  getHeadSha(cwd?: string): Promise<string>;
  getCommitCountAhead(
    baseBranch: string,
    targetRef: string,
    cwd?: string,
  ): Promise<number>;
  getChangedFiles(
    baseBranch: string,
    targetRef: string,
    cwd?: string,
  ): Promise<string[]>;
  isWorktreeDirty(worktreePath: string): Promise<boolean>;
  isBaseCleanOnBranch(expectedBranch: string): Promise<BaseBranchCleanCheck>;
  autoRebase(
    worktreePath: string,
    baseBranch: string,
  ): Promise<AutoRebaseResult>;
  mergeBranch(options: {
    baseBranch: string;
    branch: string;
    commitMessage?: string;
    noFf?: boolean;
    sourceWorktreePath?: string;
  }): Promise<MergeBranchResult>;
  getDiffSummary(
    baseBranch: string,
    targetRef: string,
    options?: { maxDiffBytes?: number; cwd?: string },
  ): Promise<DiffSummary>;
  safeTeardown(
    targets: SafeTeardownTarget[],
    options?: { deleteBranches?: boolean },
  ): Promise<SafeTeardownResult>;
}

// ============================================================================
// Warm Persistent Transport & Forking Contract (src/runtime/)
// ============================================================================

export type AgentTelemetryEventType =
  | "started"
  | "woken"
  | "waiting"
  | "tool_start"
  | "tool_end"
  | "text_delta"
  | "turn_end"
  | "usage_update"
  | "rate_limit"
  | "model_switched"
  | "stopped"
  | "killed"
  | "error";

export interface AgentTelemetryEvent {
  agentId: string;
  name: string;
  role: SwarmMemberRole;
  runId: string;
  type: AgentTelemetryEventType;
  timestamp: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  toolName?: string;
  activity?: string;
  logLine?: string;
  tokens?: number;
  tokenBreakdown?: TokenUsage;
  cost?: number;
  error?: string;
}

export type AgentTurnOutcome =
  | "waiting"
  | "stopped"
  | "killed"
  | "rate_limited"
  | "failed";

export interface AgentTurnResult {
  agentId: string;
  name: string;
  role: SwarmMemberRole;
  outcome: AgentTurnOutcome;
  summary: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tokens: number;
  tokenBreakdown?: TokenUsage;
  cost: number;
  error?: string;
  stopReason?: string;
  retryAfterMs?: number;
}

export interface SwarmMemberStatusEntry {
  name: string;
  role: SwarmMemberRole;
  state: SwarmMemberState;
  parentName: string;
  groupPrefix?: string;
  workspace: SwarmWorkspaceMode;
  branch?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  channels: string[];
  parkedOn?: string;
  currentActivity?: string;
  lastPostSeq?: number;
  lastPostTime?: string;
  turns: number;
  tokens: number;
  cost: number;
}

export interface SwarmRosterStatus {
  runId: string;
  title: string;
  status: SwarmRunStatus;
  baseBranch: string;
  boardHead: number;
  members: SwarmMemberStatusEntry[];
  channels: SwarmChannelRecord[];
}

export interface AddHelperInput {
  name: string;
  role?: SwarmMemberRole;
  brief: string;
  workspace?: SwarmWorkspaceMode;
  fork?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  channels?: string[];
  n?: number;
  tasks?: string[];
}

export interface ManageChannelInput {
  action: SwarmChannelAction;
  name?: string;
  topic?: string;
  member?: string;
  callerName?: string;
  callerRole?: CallerRole;
}

export interface ManageChannelResult {
  action: SwarmChannelAction;
  channel?: SwarmChannelRecord;
  channels?: SwarmChannelRecord[];
  summary: string;
}

export interface SwitchModelResult {
  targetName: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  member?: SwarmMemberRecord;
  deferred?: boolean;
  resumed?: boolean;
}

export interface ParkOrchestratorWaitOptions {
  since: number;
  mentionsOnly?: boolean;
  timeoutMs?: number;
}

export interface ParkOrchestratorWaitResult {
  parked: boolean;
  wokeBy?: WaitForBoardResult["wokeBy"];
  messages: BoardMessage[];
  head: number;
  activeMembers: string[];
  summary: string;
}

export interface WaitForBoardOptions {
  since: number;
  mentionsOnly?: boolean;
  targetName?: string;
  targetChannels?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (summary: string) => void;
  timeoutMs?: number;
}

export interface WaitForBoardResult {
  wokeBy: "message" | "all_idle" | "timeout" | "aborted" | "run_ended";
  messages: BoardMessage[];
  head: number;
  summary: string;
}

/**
 * Direct in-process bridge injected into Worker/Validator sessions so their
 * scoped Swarm tools can interact with the engine without circular imports.
 */
export interface MemberEngineBridge {
  postMessage(input: {
    text: string;
    channel?: string;
    kind?: BoardMessageKind;
  }): Promise<BoardMessage>;
  readBoard(options?: ReadBoardOptions): Promise<ReadBoardResult>;
  getStatus(): Promise<SwarmRosterStatus>;
  listModels(options?: { all?: boolean }): Promise<AvailableModelInfo[]>;
  addHelper(input: AddHelperInput): Promise<SwarmMemberRecord[]>;
  killHelper(name: string, reason?: string): Promise<void>;
  stopHelper?(name: string, reason?: string): Promise<void>;
  steerHelper?(
    name: string,
    message: string,
    mode?: "steer" | "followUp",
  ): Promise<{ delivery: "steered" | "followUp" | "woken" }>;
  switchModel(
    targetName: string | undefined,
    model: string,
    thinkingLevel?: ThinkingLevel,
    reason?: string,
  ): Promise<SwitchModelResult>;
  manageChannel(input: ManageChannelInput): Promise<ManageChannelResult>;
  waitForBoard?(options: WaitForBoardOptions): Promise<WaitForBoardResult>;
}

export interface SpawnMemberRequest {
  agentId: string;
  name: string;
  role: SwarmMemberRole;
  runId: string;
  cwd: string;
  branch?: string;
  workspace: SwarmWorkspaceMode;
  parentName: string;
  brief: string;
  systemPrompt: string;
  initialPrompt: string;
  keepWarm: boolean;
  modelOverride?: string;
  thinkingLevel?: ThinkingLevel;
  seedMessages?: AgentMessage[];
  sessionDir?: string;
  sessionFile?: string;
  isMonitor?: boolean;
  hostContext?: ExtensionContext;
  onTelemetry?: (event: AgentTelemetryEvent) => void;
  engineApi?: MemberEngineBridge;
}

export interface PersistentAgentHandle {
  readonly agentId: string;
  readonly name: string;
  readonly role: SwarmMemberRole;
  getState(): SwarmMemberState;
  getModel(): string | undefined;
  getThinkingLevel(): ThinkingLevel | undefined;
  getSessionFile?(): string | undefined;
  getConversationMessages(): AgentMessage[];
  /** Wakes a `waiting` session with new board messages, preserving full conversation history. */
  wake(prompt: string): Promise<AgentTurnResult>;
  /** Steers a `working` session mid-turn. */
  steer(message: string): Promise<void>;
  /** Queues a follow-up message on a `working` session. */
  followUp(message: string): Promise<void>;
  /** Hot-switches model on a `waiting` session, keeping full conversation history. */
  switchModel(
    modelOverride: string,
    thinkingLevel?: ThinkingLevel,
  ): Promise<ModelSwitchResult>;
  /** Aborts the active turn cleanly (transitions to `stopped`). */
  abort(reason?: string): Promise<void>;
  /** Permanently disposes the underlying `AgentSession` (`killed` state). */
  kill(reason?: string): Promise<void>;
  /** Resolves when the initial or most recently woken turn completes. */
  readonly currentTurn: Promise<AgentTurnResult>;
}

export interface ISwarmTransport {
  spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle>;
  resolveModel?(
    modelOverride: string,
    thinkingLevel?: ThinkingLevel,
    hostContext?: ExtensionContext,
  ): Promise<ModelSwitchResult>;
  listAvailableModels?(
    hostContext?: ExtensionContext,
  ): Promise<AvailableModelInfo[]>;
}

// ============================================================================
// Dynamic Engine Contract (src/runtime/ -> consumed by src/ui/ & src/index.ts)
// ============================================================================

export interface AddMemberInput {
  name: string;
  role?: SwarmMemberRole;
  brief: string;
  workspace?: SwarmWorkspaceMode;
  fork?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  channels?: string[];
  n?: number;
  tasks?: string[];
  callerName?: string;
  callerRole?: CallerRole;
  hostContext?: ExtensionContext;
}

export interface SwitchModelOptions {
  targetName?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  reason?: string;
  autoResume?: boolean;
  callerName?: string;
  callerRole?: CallerRole;
  hostContext?: ExtensionContext;
}

export interface StopMemberOptions {
  humanStopped?: boolean;
  reason?: string;
  callerName?: string;
  callerRole?: CallerRole;
}

export interface KillMemberOptions {
  reason?: string;
  force?: boolean;
  callerName?: string;
  callerRole?: CallerRole;
}

export interface MergeMemberOptions {
  commitMessage?: string;
  noFf?: boolean;
  callerName?: string;
  callerRole?: CallerRole;
}

export interface CompleteRunOptions {
  summary: string;
  teardown?: boolean;
  deleteBranches?: boolean;
  callerRole?: CallerRole;
  actor?: string;
}

export interface TeardownOptions {
  runId?: string;
  deleteBranches?: boolean;
  sessionId?: string;
}

export interface SwarmSnapshot {
  run: SwarmRunState | null;
  activeRunId: string | null;
  workingMemberNames: string[];
  waitingMemberNames: string[];
  boardHead: number;
  recentBoard: BoardMessage[];
  recentEvents: SwarmEvent[];
  roleModels: SwarmRoleModels;
  totalTokens: number;
  totalCost: number;
  rateLimitUntil?: number;
  rateLimitReason?: string;
  updatedAt: string;
}

export type SwarmEngineEventType =
  | "snapshot_changed"
  | "board_posted"
  | "wakeup_needed"
  | "stall_detected"
  | "run_finished"
  | "error";

export interface SwarmEngineEvent {
  type: SwarmEngineEventType;
  runId: string | null;
  memberName?: string;
  seq?: number;
  messages?: BoardMessage[];
  summary: string;
  snapshot: SwarmSnapshot;
}

export interface ISwarmEngine {
  startRun(runId: string, hostContext?: ExtensionContext): Promise<SwarmRunState>;
  attachRun(
    runId: string | null,
    hostContext?: ExtensionContext,
  ): Promise<SwarmSnapshot>;
  setTitle(
    title: string,
    options?: { callerRole?: CallerRole; actor?: string },
  ): Promise<SwarmRunState>;
  updateDirection(
    patch: {
      title?: string;
      objective?: string;
      strategy?: string;
      acceptanceCriteria?: string;
    },
    options?: { callerRole?: CallerRole; actor?: string },
  ): Promise<SwarmRunState>;
  addMembers(input: AddMemberInput): Promise<SwarmMemberRecord[]>;
  postMessage(input: PostBoardMessageInput): Promise<BoardMessage>;
  readBoard(options?: ReadBoardOptions): Promise<ReadBoardResult>;
  waitForBoard(options: WaitForBoardOptions): Promise<WaitForBoardResult>;
  parkOrchestratorWait(
    options: ParkOrchestratorWaitOptions,
  ): Promise<ParkOrchestratorWaitResult>;
  clearOrchestratorWait(reason?: string): void;
  switchModel(options: SwitchModelOptions): Promise<SwitchModelResult>;
  steerMember(
    memberName: string,
    message: string,
    mode?: "steer" | "followUp",
    options?: { callerName?: string; callerRole?: CallerRole },
  ): Promise<{ delivery: "steered" | "followUp" | "woken" }>;
  stopMember(memberName: string, options?: StopMemberOptions): Promise<void>;
  killMember(memberName: string, options?: KillMemberOptions): Promise<void>;
  mergeMember(
    memberName: string,
    options?: MergeMemberOptions,
  ): Promise<MergeBranchResult | null>;
  manageChannel(input: ManageChannelInput): Promise<ManageChannelResult>;
  completeRun(options: CompleteRunOptions): Promise<SwarmRunState>;
  pause(runId?: string, reason?: string): Promise<SwarmRunState>;
  resume(runId?: string, hostContext?: ExtensionContext): Promise<SwarmRunState>;
  teardown(options?: TeardownOptions): Promise<SafeTeardownResult>;
  listModels(options?: {
    all?: boolean;
    hostContext?: ExtensionContext;
  }): Promise<AvailableModelInfo[]>;
  getSnapshot(): SwarmSnapshot;
  subscribe(listener: (event: SwarmEngineEvent) => void): () => void;
  dispose(): Promise<void>;
}

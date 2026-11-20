import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// 3-Role Model Configuration Types
// ============================================================================

export type SwarmModelRole = "orchestrator" | "worker" | "validator";

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

// ============================================================================
// Core Mission, Run & Validation Domain Types
// ============================================================================

export type MissionKind = "build" | "artifact" | "survey";

export type MissionStatus =
  | "planned"
  | "active"
  | "completed"
  | "merged"
  | "abandoned"
  | "failed"
  | "stopped";

export type RunStatus =
  | "active"
  | "verifying"
  | "paused"
  | "completed"
  | "abandoned"
  | "failed";

export type CallerRole = "orchestrator" | "worker" | "validator" | "human";

export type ReviewSeverityStatus = "clean" | `p1-${number}items` | `p2-${number}items`;

export type ReviewMergeDecision = "merge" | "fix-then-merge" | "hold";

export type ReviewFindingSeverity = "p1" | "p2" | "note";

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface ReviewCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface MissionReviewVerdict {
  commitSha: string;
  missionId: string;
  branch: string;
  reviewedAt: string;
  reviewerAgentId: string;
  status: ReviewSeverityStatus;
  merge: ReviewMergeDecision;
  findings: ReviewFinding[];
  checks: ReviewCheck[];
  decision: string;
  round?: number;
}

const REVIEW_SEVERITY_STATUS_RE = /^(clean|p[12]-[1-9]\d*items)$/;

export function isValidReviewSeverityStatus(value: string): value is ReviewSeverityStatus {
  return REVIEW_SEVERITY_STATUS_RE.test(value);
}

export function computeReviewSeverityStatus(
  findings: readonly ReviewFinding[],
): ReviewSeverityStatus {
  const p1Count = findings.filter((f) => f.severity === "p1").length;
  if (p1Count > 0) {
    return `p1-${p1Count}items`;
  }
  const p2Count = findings.filter((f) => f.severity === "p2").length;
  if (p2Count > 0) {
    return `p2-${p2Count}items`;
  }
  return "clean";
}

// ============================================================================
// Mission & Task Records
// ============================================================================

export interface MissionTaskItem {
  id: string;
  title: string;
  done: boolean;
  completedAt?: string;
}

export type MissionTaskInput =
  | string
  | {
      id?: string;
      title: string;
      done?: boolean;
    };

export interface MissionPlanInput {
  id: string;
  title: string;
  kind: MissionKind;
  description: string;
  scope: string[];
  deps: string[];
  verification: string;
  tasks?: MissionTaskInput[];
}

export interface MissionRecord {
  id: string;
  title: string;
  kind: MissionKind;
  description: string;
  scope: string[];
  deps: string[];
  verification: string;
  tasks: MissionTaskItem[];
  branch: string;
  worktreePath: string;
  status: MissionStatus;
  progressSummary?: string;
  reviewRound: number;
  retryCount: number;
  lastReviewedSha?: string;
  latestReview?: MissionReviewVerdict;
  humanApprovedSha?: string;
  humanApprovedAt?: string;
  mergedCommitSha?: string;
  mergedAt?: string;
  humanStopped: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Final Audit Domain Types
// ============================================================================

export type FinalAuditStatus =
  | "idle"
  | "pending"
  | "running"
  | "approved"
  | "disapproved"
  | "skipped";

export type FinalAuditDecision = "approved" | "disapproved";

export interface SuggestedFixMission {
  title: string;
  description: string;
  scope: string[];
  verification: string;
  kind?: "build" | "artifact";
  tasks?: MissionTaskInput[];
}

export interface FinalAuditVerdict {
  commitSha: string;
  baseBranch: string;
  auditedAt: string;
  verifierAgentId: string;
  verdict: FinalAuditDecision;
  summary: string;
  checks: ReviewCheck[];
  findings: ReviewFinding[];
  recommendedMissions?: SuggestedFixMission[];
  round: number;
}

// ============================================================================
// Shared Message Board Contract (board.jsonl)
// ============================================================================

export type BoardMessageKind =
  | "brief"
  | "done"
  | "review"
  | "fix"
  | "handoff"
  | "decision"
  | "model_switch"
  | "stall"
  | "chat";

export interface BoardMessage {
  seq: number;
  runId: string;
  from: string;
  fromRole: CallerRole;
  text: string;
  mentions: string[];
  kind: BoardMessageKind;
  missionId?: string;
  timestamp: string;
}

export interface PostBoardMessageInput {
  from: string;
  fromRole: CallerRole;
  text: string;
  kind?: BoardMessageKind;
  missionId?: string;
  mentions?: string[];
}

export interface ReadBoardOptions {
  since?: number;
  seqs?: number[];
  limit?: number;
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
// Roster, Comms, Findings & Event Ledger
// ============================================================================

export type RosterAgentRole = "worker" | "validator" | "final-validator";

export type RosterAgentStatus =
  | "working"
  | "waiting"
  | "stopped"
  | "killed"
  | "failed"
  | "died";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface RosterEntry {
  agentId: string;
  /** Short unique board handle per run (e.g. "M1", "validator-M1", "final-validator"). */
  name: string;
  role: RosterAgentRole;
  missionId: string;
  worktreePath: string;
  branch: string;
  status: RosterAgentStatus;
  /** Actual resolved model ID currently running on this agent. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Highest board sequence number already delivered to / read by this agent. */
  lastReadBoardSeq: number;
  /** Most recent board sequence number posted by this agent. */
  lastPostBoardSeq?: number;
  /** Total turns completed by this persistent session. */
  turns: number;
  startedAt: string;
  endedAt?: string;
  humanStopped: boolean;
  currentActivity?: string;
  lastTool?: string;
  /** Total tokens consumed by this agent (matches SessionStats.tokens.total). */
  tokens: number;
  tokenBreakdown?: TokenUsage;
  cost: number;
  logTail: string[];
  error?: string;
}

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  missionId?: string;
  text: string;
  createdAt: string;
  readAt?: string;
}

export interface SwarmFindingRecord {
  id: string;
  missionId: string;
  author: string;
  title: string;
  summary: string;
  details: string;
  files?: string[];
  createdAt: string;
}

export type SwarmEventType =
  | "run_created"
  | "run_paused"
  | "run_resumed"
  | "run_completed"
  | "run_abandoned"
  | "mission_planned"
  | "mission_started"
  | "mission_progress"
  | "mission_scope_patched"
  | "mission_completed"
  | "mission_abandoned"
  | "mission_failed"
  | "worker_spawned"
  | "worker_exited"
  | "worker_stopped"
  | "worker_steered"
  | "validator_spawned"
  | "validation_submitted"
  | "board_posted"
  | "agent_woken"
  | "agent_model_switched"
  | "agent_killed"
  | "artifact_approved"
  | "merge_started"
  | "merge_rebased"
  | "merge_conflict"
  | "merge_succeeded"
  | "merge_rejected"
  | "finding_recorded"
  | "rate_limit_backoff"
  | "teardown_completed"
  | "final_audit_started"
  | "final_audit_result"
  | "final_audit_skipped"
  | "final_audit_autofix_planned";

export interface SwarmEvent {
  id: string;
  seq?: number;
  runId: string;
  type: SwarmEventType;
  timestamp: string;
  actor?: string;
  missionId?: string;
  agentId?: string;
  summary: string;
  data?: Record<string, unknown>;
}

export interface SwarmEventInput {
  runId: string;
  type: SwarmEventType;
  actor?: string;
  missionId?: string;
  agentId?: string;
  summary: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
}

// ============================================================================
// Run State, Settings, Drafting & Session Entries
// ============================================================================

export interface SwarmRunState {
  version: 1;
  id: string;
  objective: string;
  verificationContract: string;
  baseBranch: string;
  ownerSessionId: string;
  ownerPid: number;
  status: RunStatus;
  maxConcurrency: number;
  validatorEnabled: boolean;
  maxValidationRounds: number;
  finalValidatorEnabled: boolean;
  maxFinalAuditRounds: number;
  autoFixOnAuditFail: boolean;
  keepWorkersWarm: boolean;
  finalAuditStatus: FinalAuditStatus;
  finalAuditRound: number;
  lastAuditedSha?: string;
  latestFinalAudit?: FinalAuditVerdict;
  finalAuditSkippedBy?: string;
  finalAuditSkippedAt?: string;
  finalAuditSkipReason?: string;
  roleModels?: SwarmRoleModels;
  revision: number;
  missions: Record<string, MissionRecord>;
  missionOrder: string[];
  roster: Record<string, RosterEntry>;
  findings: SwarmFindingRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface SwarmSettings {
  maxConcurrency: number;
  validatorEnabled: boolean;
  finalValidatorEnabled: boolean;
  maxValidationRounds: number;
  maxFinalAuditRounds: number;
  autoFixOnAuditFail: boolean;
  keepWorkersWarm: boolean;
  maxRetries: number;
  rateLimitBaseBackoffMs: number;
  rateLimitMaxBackoffMs: number;
  gitTimeoutMs: number;
  autoMergeClean: boolean;
  autoRebase: boolean;
  autoTeardownOnComplete: boolean;
  orchestratorModel?: string | undefined;
  orchestratorThinkingLevel?: ThinkingLevel | undefined;
  workerModel?: string | undefined;
  workerThinkingLevel?: ThinkingLevel | undefined;
  validatorModel?: string | undefined;
  validatorThinkingLevel?: ThinkingLevel | undefined;
  fallbackModels: string[];
}

export type SwarmDraftMode = "swarm" | "tweak";

export interface ActiveSwarmDraft {
  version: 1;
  mode: SwarmDraftMode;
  seed: string;
  targetRunId?: string;
  startedAt: string;
  validatorEnabled: boolean;
  finalValidatorEnabled?: boolean;
  maxConcurrency: number;
  baseBranch?: string;
  questionnaireEcho?: Record<string, string>;
  clearedAt?: string;
}

export interface SwarmFocusEntry {
  version: 1;
  runId: string | null;
  sessionId: string;
  reason?: string;
}

export interface ProposedSwarmPlan {
  objective: string;
  baseBranch: string;
  maxConcurrency: number;
  validatorEnabled: boolean;
  finalValidatorEnabled?: boolean;
  verificationContract: string;
  roleModels?: SwarmRoleModels;
  missions: MissionPlanInput[];
}

// ============================================================================
// Protocol Errors
// ============================================================================

export type SwarmErrorCode =
  | "INVALID_DAG"
  | "CYCLE_DETECTED"
  | "MISSING_DEP"
  | "SCOPE_OVERLAP"
  | "SCOPE_VIOLATION"
  | "INVALID_TITLE"
  | "DUPLICATE_BRANCH"
  | "DUPLICATE_MISSION"
  | "REVIEW_REQUIRED"
  | "STALE_REVIEW"
  | "AUDIT_REQUIRED"
  | "STALE_AUDIT"
  | "ARTIFACT_UNAPPROVED"
  | "SURVEY_HAS_DIFF"
  | "DIRTY_WORKTREE"
  | "DIRTY_BASE"
  | "WRONG_BRANCH"
  | "REBASE_CONFLICT"
  | "OWNERSHIP_CONFLICT"
  | "REVISION_CONFLICT"
  | "INVALID_TRANSITION"
  | "ROLE_FORBIDDEN"
  | "AGENT_NOT_WAITING"
  | "AGENT_KILLED"
  | "MODEL_NOT_FOUND"
  | "NOT_FOUND"
  | "GIT_ERROR";

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
  objective: string;
  verificationContract: string;
  baseBranch: string;
  ownerSessionId: string;
  ownerPid?: number;
  maxConcurrency?: number;
  validatorEnabled?: boolean;
  maxValidationRounds?: number;
  finalValidatorEnabled?: boolean;
  maxFinalAuditRounds?: number;
  autoFixOnAuditFail?: boolean;
  keepWorkersWarm?: boolean;
  roleModels?: SwarmRoleModels;
  missions: MissionPlanInput[];
  existingBranches?: readonly string[];
}

export interface RunSummary {
  id: string;
  objective: string;
  baseBranch: string;
  status: RunStatus;
  missionCount: number;
  mergedCount: number;
  activeCount: number;
  ownerSessionId: string;
  ownerPid: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunUpdateInput {
  status?: RunStatus;
  objective?: string;
  verificationContract?: string;
  baseBranch?: string;
  maxConcurrency?: number;
  validatorEnabled?: boolean;
  maxValidationRounds?: number;
  finalValidatorEnabled?: boolean;
  maxFinalAuditRounds?: number;
  autoFixOnAuditFail?: boolean;
  keepWorkersWarm?: boolean;
  roleModels?: SwarmRoleModels;
  finalAuditStatus?: FinalAuditStatus;
  ownerSessionId?: string;
  ownerPid?: number;
  expectedRevision?: number;
  actor?: string;
}

export interface MissionUpdateInput {
  status?: MissionStatus;
  progressSummary?: string;
  taskDoneIds?: string[];
  tasks?: MissionTaskItem[];
  worktreePath?: string;
  reviewRound?: number;
  retryCount?: number;
  humanStopped?: boolean;
  error?: string | null;
  expectedRevision?: number;
  callerRole?: CallerRole;
  actor?: string;
}

export interface RegisterRosterInput {
  agentId: string;
  name: string;
  role: RosterAgentRole;
  missionId: string;
  worktreePath: string;
  branch: string;
  status?: RosterAgentStatus;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  lastReadBoardSeq?: number;
  turns?: number;
  startedAt?: string;
}

export interface RosterUpdateInput {
  status?: RosterAgentStatus;
  model?: string;
  thinkingLevel?: ThinkingLevel | null;
  lastReadBoardSeq?: number;
  lastPostBoardSeq?: number;
  turns?: number;
  endedAt?: string | null;
  humanStopped?: boolean;
  currentActivity?: string | null;
  lastTool?: string;
  tokens?: number;
  tokenBreakdown?: TokenUsage;
  cost?: number;
  logLine?: string;
  logTail?: string[];
  error?: string | null;
}

export interface SendMessageInput {
  from: string;
  to: string;
  missionId?: string;
  text: string;
}

export interface ReadInboxOptions {
  unreadOnly?: boolean;
  markRead?: boolean;
  limit?: number;
}

export interface RecordFindingInput {
  missionId: string;
  author: string;
  title: string;
  summary: string;
  details: string;
  files?: string[];
}

export interface PlanValidationOptions {
  existingMissions?: Record<string, MissionRecord>;
  existingBranches?: readonly string[];
  baseBranch?: string;
}

export interface PlanValidationIssue {
  code: SwarmErrorCode;
  message: string;
  missionId?: string;
  details?: Record<string, unknown>;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationIssue[];
  /** Topologically sorted execution waves of mission IDs when valid. */
  waves: string[][];
  /** Derived unique branch names keyed by mission ID (`feat/<slug>`). */
  branches: Record<string, string>;
}

export interface ISwarmStore {
  readonly projectRoot: string;
  createRun(input: CreateRunInput): Promise<SwarmRunState>;
  loadRun(runId: string): Promise<SwarmRunState>;
  listRuns(): Promise<RunSummary[]>;
  getActiveRunId(): Promise<string | null>;
  updateRun(runId: string, patch: RunUpdateInput): Promise<SwarmRunState>;
  addMissions(
    runId: string,
    missions: MissionPlanInput[],
    options?: {
      existingBranches?: readonly string[];
      expectedRevision?: number;
      actor?: string;
    },
  ): Promise<SwarmRunState>;
  updateMission(
    runId: string,
    missionId: string,
    patch: MissionUpdateInput,
  ): Promise<SwarmRunState>;
  patchMissionScope(
    runId: string,
    missionId: string,
    scope: string[],
    options?: {
      expectedRevision?: number;
      callerRole?: CallerRole;
      actor?: string;
    },
  ): Promise<SwarmRunState>;
  recordReview(
    runId: string,
    missionId: string,
    verdict: MissionReviewVerdict,
  ): Promise<SwarmRunState>;
  recordFinalAudit(
    runId: string,
    verdict: FinalAuditVerdict,
  ): Promise<SwarmRunState>;
  skipFinalAudit(
    runId: string,
    options?: {
      skippedBy?: string;
      reason?: string;
      expectedRevision?: number;
      callerRole?: CallerRole;
    },
  ): Promise<SwarmRunState>;
  approveArtifact(
    runId: string,
    missionId: string,
    commitSha: string,
    options?: { approvedBy?: string; expectedRevision?: number },
  ): Promise<SwarmRunState>;
  markMerged(
    runId: string,
    missionId: string,
    mergedCommitSha: string | null,
    options?: {
      expectedRevision?: number;
      callerRole?: CallerRole;
      actor?: string;
    },
  ): Promise<SwarmRunState>;
  registerRoster(
    runId: string,
    entry: RegisterRosterInput,
  ): Promise<SwarmRunState>;
  updateRoster(
    runId: string,
    agentId: string,
    patch: RosterUpdateInput,
  ): Promise<SwarmRunState>;
  postBoardMessage(
    runId: string,
    input: PostBoardMessageInput,
  ): Promise<BoardMessage>;
  readBoard(
    runId: string,
    options?: ReadBoardOptions,
  ): Promise<ReadBoardResult>;
  getBoardHead(runId: string): Promise<number>;
  sendMessage(runId: string, message: SendMessageInput): Promise<InboxMessage>;
  readInbox(
    runId: string,
    recipient: string,
    options?: ReadInboxOptions,
  ): Promise<InboxMessage[]>;
  recordFinding(
    runId: string,
    finding: RecordFindingInput,
  ): Promise<SwarmFindingRecord>;
  appendEvent(event: SwarmEventInput): Promise<SwarmEvent>;
  getRecentEvents(runId: string, limit?: number): Promise<SwarmEvent[]>;
  renderMissionsMarkdown(state: SwarmRunState): string;
  validatePlan(
    missions: MissionPlanInput[],
    options?: PlanValidationOptions,
  ): PlanValidationResult;
  getRunDir(runId: string): string;
  getWorktreePath(runId: string, slot: string): string;
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
  missionId: string;
  worktreePath: string;
  branch: string;
  hasActiveAgent: boolean;
}

export interface TeardownEntryResult {
  missionId: string;
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
// Drafting & Interactive Questionnaire UI Contract (src/drafting/)
// ============================================================================

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
  finalValidatorEnabled?: boolean;
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
      validation?: PlanValidationResult;
      signal?: AbortSignal;
    },
  ): Promise<ProposalDialogOutcome>;
}

// ============================================================================
// Warm Persistent Agent & Transport Contract (src/runtime/)
// ============================================================================

export interface WorkerDonePayload {
  missionId: string;
  summary: string;
  verificationRan?: string;
  notes?: string;
}

export type WorkerTelemetryEventType =
  | "started"
  | "woken"
  | "waiting"
  | "model_switched"
  | "killed"
  | "tool_start"
  | "tool_end"
  | "text_delta"
  | "turn_end"
  | "usage_update"
  | "rate_limit"
  | "completed"
  | "aborted"
  | "error";

export interface WorkerTelemetryEvent {
  agentId: string;
  name?: string;
  missionId: string;
  role: RosterAgentRole;
  type: WorkerTelemetryEventType;
  timestamp: string;
  model?: string;
  toolName?: string;
  activity?: string;
  logLine?: string;
  tokens?: number;
  tokenBreakdown?: TokenUsage;
  cost?: number;
  error?: string;
}

export type WorkerRunOutcome =
  | "completed"
  | "failed"
  | "aborted"
  | "rate_limited";

export interface AgentSpawnRequest {
  agentId: string;
  /** Short unique board handle (e.g. "M1", "validator-M1"). */
  name: string;
  role: RosterAgentRole;
  runId: string;
  mission: MissionRecord;
  objective: string;
  verificationContract: string;
  baseBranch: string;
  worktreePath: string;
  branch: string;
  prompt: string;
  systemPromptAppendix?: string;
  /** Board sequence cursor at spawn time. */
  boardCursor: number;
  /** Keep session alive in `waiting` state after turn completes instead of disposing. */
  keepWarm: boolean;
  /** Optional summary context carried over when spawning a replacement or forked agent. */
  forkContextSummary?: string;
  /** Exact branch tip commit SHA being audited (populated for validators). */
  targetCommitSha?: string;
  /** Pre-computed diff summary for validators. */
  diffSummary?: DiffSummary;
  /** Prior review feedback, board posts, or unread inbox messages injected at start. */
  contextMessages?: string[];
  modelOverride?: string;
  thinkingLevel?: ThinkingLevel;
  hostContext?: ExtensionContext;
  onTelemetry?: (event: WorkerTelemetryEvent) => void;
  onWorkerDone?: (payload: WorkerDonePayload) => Promise<void> | void;
  onReviewVerdict?: (verdict: MissionReviewVerdict) => Promise<void> | void;
  onBoardPost?: (msg: BoardMessage) => Promise<void> | void;
  board?: ISwarmBoard;
  store?: ISwarmStore;
}

export type WorkerSpawnRequest = AgentSpawnRequest;
export type ValidatorSpawnRequest = AgentSpawnRequest;

export interface FinalValidatorSpawnRequest {
  agentId: string;
  /** Short unique board handle (typically "final-validator"). */
  name: string;
  runId: string;
  objective: string;
  verificationContract: string;
  baseBranch: string;
  repoRoot: string;
  targetCommitSha: string;
  round: number;
  maxRounds: number;
  mergedMissions: MissionRecord[];
  findings: SwarmFindingRecord[];
  priorAudits?: FinalAuditVerdict[];
  prompt: string;
  systemPromptAppendix?: string;
  /** Board sequence cursor at spawn time. */
  boardCursor: number;
  /** Keep session alive in `waiting` state after turn completes instead of disposing. */
  keepWarm: boolean;
  /** Optional summary context carried over when spawning a replacement or forked agent. */
  forkContextSummary?: string;
  modelOverride?: string;
  thinkingLevel?: ThinkingLevel;
  hostContext?: ExtensionContext;
  onTelemetry?: (event: WorkerTelemetryEvent) => void;
  onFinalVerdict?: (verdict: FinalAuditVerdict) => Promise<void> | void;
  onBoardPost?: (msg: BoardMessage) => Promise<void> | void;
  board?: ISwarmBoard;
  store?: ISwarmStore;
}

export interface AgentTurnResult {
  agentId: string;
  name: string;
  missionId: string;
  role: RosterAgentRole;
  outcome: WorkerRunOutcome;
  summary: string;
  workerDone?: WorkerDonePayload;
  reviewVerdict?: MissionReviewVerdict;
  finalAuditVerdict?: FinalAuditVerdict;
  model?: string;
  tokens: number;
  tokenBreakdown?: TokenUsage;
  cost: number;
  error?: string;
  stopReason?: string;
  retryAfterMs?: number;
}

export interface ModelSwitchResult {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export interface PersistentAgentHandle {
  readonly agentId: string;
  readonly name: string;
  readonly missionId: string;
  readonly role: RosterAgentRole;
  getState(): RosterAgentStatus;
  getModel(): string | undefined;
  /** Wakes a `waiting` session with new board messages, preserving full conversation history. */
  wake(prompt: string): Promise<AgentTurnResult>;
  /** Steers a `working` session mid-turn. */
  steer(message: string): Promise<void>;
  /** Queues a follow-up message on a `working` session. */
  followUp(message: string): Promise<void>;
  /** Hot-switches model on a `waiting` session via `session.setModel`, keeping full history. */
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
  spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle>;
  spawnValidator(request: ValidatorSpawnRequest): Promise<PersistentAgentHandle>;
  spawnFinalValidator?(
    request: FinalValidatorSpawnRequest,
  ): Promise<PersistentAgentHandle>;
}

// ============================================================================
// Orchestrator Contract (src/runtime/ -> consumed by src/ui/ & src/index.ts)
// ============================================================================

export interface SwarmSnapshot {
  run: SwarmRunState | null;
  activeRunId: string | null;
  runningAgentIds: string[];
  workingAgentIds: string[];
  waitingAgentIds: string[];
  runningCount: number;
  maxConcurrency: number;
  rateLimitUntil?: number;
  rateLimitReason?: string;
  boardHead: number;
  recentBoard: BoardMessage[];
  recentEvents: SwarmEvent[];
  unreadOrchestratorMessages: number;
  roleModels: SwarmRoleModels;
  totalTokens: number;
  totalCost: number;
  pendingReviews: string[];
  pendingArtifactApprovals: string[];
  readyToMerge: string[];
  finalAuditStatus?: FinalAuditStatus;
  latestFinalAudit?: FinalAuditVerdict;
  finalAuditRunningAgentId?: string;
  updatedAt: string;
}

export type SwarmOrchestratorEventType =
  | "snapshot_changed"
  | "wakeup_needed"
  | "run_finished"
  | "error";

export interface SwarmOrchestratorEvent {
  type: SwarmOrchestratorEventType;
  runId: string | null;
  missionId?: string;
  agentId?: string;
  summary: string;
  snapshot: SwarmSnapshot;
}

export interface SpawnMissionOptions {
  missionId: string;
  role?: RosterAgentRole;
  promptOverride?: string;
  modelOverride?: string;
  thinkingLevel?: ThinkingLevel;
  force?: boolean;
  hostContext?: ExtensionContext;
}

export interface ISwarmOrchestrator {
  startRun(runId: string, hostContext?: ExtensionContext): Promise<SwarmRunState>;
  attachRun(
    runId: string | null,
    hostContext?: ExtensionContext,
  ): Promise<SwarmSnapshot>;
  pause(runId?: string, reason?: string): Promise<SwarmRunState>;
  resume(runId?: string, hostContext?: ExtensionContext): Promise<SwarmRunState>;
  tick(hostContext?: ExtensionContext): Promise<void>;
  spawnForMission(options: SpawnMissionOptions): Promise<PersistentAgentHandle>;
  postToBoard(input: PostBoardMessageInput): Promise<BoardMessage>;
  readBoard(options?: ReadBoardOptions): Promise<ReadBoardResult>;
  switchAgentModel(
    agentNameOrId: string,
    modelOverride: string,
    thinkingLevel?: ThinkingLevel,
  ): Promise<RosterEntry>;
  steerAgent(
    agentNameOrId: string,
    message: string,
    mode?: "steer" | "followUp",
  ): Promise<void>;
  stopAgent(
    agentNameOrId: string,
    options?: { humanStopped?: boolean; reason?: string },
  ): Promise<void>;
  killAgent(agentNameOrId: string, reason?: string): Promise<void>;
  retryMission(
    missionId: string,
    options?: { reason?: string; hostContext?: ExtensionContext },
  ): Promise<SwarmRunState>;
  approveArtifact(
    missionId: string,
    options?: {
      commitSha?: string;
      approvedBy?: string;
      autoMerge?: boolean;
    },
  ): Promise<SwarmRunState>;
  mergeMission(
    missionId: string,
    options?: { callerRole?: CallerRole; actor?: string },
  ): Promise<MergeBranchResult | null>;
  runFinalAudit(options?: {
    runId?: string;
    force?: boolean;
    hostContext?: ExtensionContext;
  }): Promise<SwarmRunState>;
  skipFinalAudit(options?: {
    runId?: string;
    reason?: string;
    skippedBy?: string;
  }): Promise<SwarmRunState>;
  teardown(options?: {
    runId?: string;
    deleteBranches?: boolean;
    sessionId?: string;
  }): Promise<SafeTeardownResult>;
  getSnapshot(): SwarmSnapshot;
  subscribe(listener: (event: SwarmOrchestratorEvent) => void): () => void;
  dispose(): Promise<void>;
}

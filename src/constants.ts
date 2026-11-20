import type { SwarmSettings } from "./types.js";

// ============================================================================
// Tool Names
// ============================================================================

export const SWARM_QUESTION_TOOL = "swarm_question" as const;
export const SWARM_QUESTIONNAIRE_TOOL = "swarm_questionnaire" as const;
export const PROPOSE_SWARM_PLAN_TOOL = "propose_swarm_plan" as const;

export const DRAFTING_TOOLS = [
  SWARM_QUESTION_TOOL,
  SWARM_QUESTIONNAIRE_TOOL,
  PROPOSE_SWARM_PLAN_TOOL,
] as const;

export const SWARM_STATUS_TOOL = "swarm_status" as const;
export const SWARM_BOARD_POST_TOOL = "swarm_board_post" as const;
export const SWARM_BOARD_READ_TOOL = "swarm_board_read" as const;
export const SWARM_MISSION_TOOL = "swarm_mission" as const;
export const SWARM_SPAWN_TOOL = "swarm_spawn" as const;
export const SWARM_MODEL_TOOL = "swarm_model" as const;
export const SWARM_KILL_TOOL = "swarm_kill" as const;
export const SWARM_FINDING_TOOL = "swarm_finding" as const;
export const SWARM_MERGE_TOOL = "swarm_merge" as const;
export const SWARM_VERIFY_TOOL = "swarm_verify" as const;
export const SWARM_PLAN_ADD_TOOL = "swarm_plan_add" as const;
export const SWARM_TEARDOWN_TOOL = "swarm_teardown" as const;

export const ORCHESTRATOR_TOOLS = [
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
] as const;

/** Worker-only custom tool (never registered on the main orchestrator extension). */
export const SWARM_WORKER_DONE_TOOL = "swarm_worker_done" as const;

/** Per-mission Validator-only custom tool (never registered on the main orchestrator extension). */
export const SWARM_REVIEW_VERDICT_TOOL = "swarm_review_verdict" as const;

/** Run-level Final Validator-only custom tool (never registered on the main orchestrator extension). */
export const SWARM_FINAL_VERDICT_TOOL = "swarm_final_verdict" as const;

export const WORKER_ONLY_TOOLS = [SWARM_WORKER_DONE_TOOL] as const;
export const VALIDATOR_ONLY_TOOLS = [
  SWARM_REVIEW_VERDICT_TOOL,
  SWARM_FINAL_VERDICT_TOOL,
] as const;

/** Union of orchestrator + drafting tools registered on the main Pi extension (15 tools). */
export const ALL_SWARM_EXTENSION_TOOLS = [
  ...ORCHESTRATOR_TOOLS,
  ...DRAFTING_TOOLS,
] as const;

/** Built-in Pi tools granted to coding/artifact/survey workers. */
export const WORKER_BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** Swarm protocol tools exposed inside worker sessions. */
export const WORKER_SWARM_TOOLS = [
  SWARM_STATUS_TOOL,
  SWARM_BOARD_POST_TOOL,
  SWARM_BOARD_READ_TOOL,
  SWARM_MISSION_TOOL,
  SWARM_FINDING_TOOL,
  SWARM_WORKER_DONE_TOOL,
] as const;

/** Read-only built-in Pi tools granted to independent Validator & Final Validator sessions. */
export const VALIDATOR_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Shared board & status tools exposed inside Validator & Final Validator sessions. */
export const VALIDATOR_BOARD_TOOLS = [
  SWARM_STATUS_TOOL,
  SWARM_BOARD_POST_TOOL,
  SWARM_BOARD_READ_TOOL,
] as const;

export type DraftingToolName = (typeof DRAFTING_TOOLS)[number];
export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOLS)[number];
export type SwarmExtensionToolName = (typeof ALL_SWARM_EXTENSION_TOOLS)[number];
export type WorkerOnlyToolName = (typeof WORKER_ONLY_TOOLS)[number];
export type ValidatorOnlyToolName = (typeof VALIDATOR_ONLY_TOOLS)[number];
export type WorkerSwarmToolName = (typeof WORKER_SWARM_TOOLS)[number];
export type ValidatorBoardToolName = (typeof VALIDATOR_BOARD_TOOLS)[number];

// ============================================================================
// Session Entry, Custom Message, Board Handles & UI Keys
// ============================================================================

export const SWARM_DRAFT_ENTRY = "pi-swarm-draft" as const;
export const SWARM_FOCUS_ENTRY = "pi-swarm-focus" as const;
export const SWARM_CONTRACT_CUSTOM_TYPE = "pi-swarm-contract" as const;
export const SWARM_WAKEUP_CUSTOM_TYPE = "pi-swarm-wakeup" as const;
export const SWARM_STATUS_CUSTOM_TYPE = "pi-swarm-status" as const;
export const SWARM_WIDGET_KEY = "swarm" as const;
export const SWARM_STATUS_KEY = "swarm" as const;

/** Board handle used by the main Orchestrator session. */
export const ORCHESTRATOR_BOARD_NAME = "orchestrator" as const;

/** Board handle used by the run-level Final Validator session. */
export const FINAL_VALIDATOR_BOARD_NAME = "final-validator" as const;

/** Sentinel missionId used on RosterEntry for run-level Final Validator agents. */
export const FINAL_AUDIT_MISSION_ID = "__run__" as const;

export const SWARM_STATE_VERSION = 1 as const;
export const SWARM_DRAFT_VERSION = 1 as const;
export const SWARM_FOCUS_VERSION = 1 as const;

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_SWARM_SETTINGS: Readonly<SwarmSettings> = Object.freeze({
  maxConcurrency: 3,
  validatorEnabled: true,
  finalValidatorEnabled: true,
  maxValidationRounds: 3,
  maxFinalAuditRounds: 2,
  autoFixOnAuditFail: true,
  keepWorkersWarm: true,
  maxRetries: 2,
  rateLimitBaseBackoffMs: 5000,
  rateLimitMaxBackoffMs: 60000,
  gitTimeoutMs: 30000,
  autoMergeClean: true,
  autoRebase: true,
  autoTeardownOnComplete: false,
  orchestratorModel: undefined,
  orchestratorThinkingLevel: undefined,
  workerModel: undefined,
  workerThinkingLevel: undefined,
  validatorModel: undefined,
  validatorThinkingLevel: undefined,
  fallbackModels: [],
});

// ============================================================================
// Persistence Directory & File Constants
// ============================================================================

export const SWARM_DIR = ".pi/swarm" as const;
export const SWARM_RUNS_DIR = "runs" as const;
export const SWARM_WORKTREES_DIR = "worktrees" as const;
export const SWARM_MISSIONS_FILE = "MISSIONS.md" as const;
export const SWARM_STATE_FILE = "state.json" as const;
export const SWARM_BOARD_FILE = "board.jsonl" as const;
export const SWARM_EVENTS_FILE = "events.jsonl" as const;
export const SWARM_INBOX_DIR = "inbox" as const;
export const SWARM_REVIEWS_DIR = "reviews" as const;
export const SWARM_AUDITS_DIR = "audits" as const;
export const SWARM_FINDINGS_DIR = "findings" as const;
export const SWARM_LOCKS_DIR = ".locks" as const;
export const SWARM_SETTINGS_FILE = "pi-swarm-settings.json" as const;

export const SWARM_PATHS = Object.freeze({
  root: SWARM_DIR,
  runs: SWARM_RUNS_DIR,
  worktrees: SWARM_WORKTREES_DIR,
  missionsFile: SWARM_MISSIONS_FILE,
  stateFile: SWARM_STATE_FILE,
  boardFile: SWARM_BOARD_FILE,
  eventsFile: SWARM_EVENTS_FILE,
  inbox: SWARM_INBOX_DIR,
  reviews: SWARM_REVIEWS_DIR,
  audits: SWARM_AUDITS_DIR,
  findings: SWARM_FINDINGS_DIR,
  locks: SWARM_LOCKS_DIR,
  settingsFile: SWARM_SETTINGS_FILE,
});

// ============================================================================
// Protocol & Runtime Limits
// ============================================================================

export const SWARM_BRANCH_PREFIX = "feat/" as const;
export const SWARM_WORKTREE_PREFIX = "wt-" as const;
export const SWARM_LOG_TAIL_LIMIT = 50;
export const SWARM_MAX_DIFF_BYTES = 128 * 1024;
/** Safety cap on peer-to-peer @mention wakeup cascades within a run. */
export const SWARM_MAX_BOARD_HOPS = 12;
export const REVIEW_STATUS_PATTERN = /^(clean|p[12]-[1-9]\d*items)$/;

import type { SwarmSettings } from "./types.js";

// ============================================================================
// Tool Names
// ============================================================================

export const SWARM_QUESTION_TOOL = "swarm_question" as const;
export const SWARM_QUESTIONNAIRE_TOOL = "swarm_questionnaire" as const;
export const PROPOSE_SWARM_PLAN_TOOL = "propose_swarm_plan" as const;

/** Upfront pi-goal-x style Q&A and plan confirmation tools (3 tools). */
export const DRAFTING_TOOLS = [
  SWARM_QUESTION_TOOL,
  SWARM_QUESTIONNAIRE_TOOL,
  PROPOSE_SWARM_PLAN_TOOL,
] as const;

/** Core Antigravity Swarm coordination tool (`title`, `add`, `status`, `models`, `model`, `steer`, `stop`, `kill`, `merge`, `channel`, `mission`, `done`). */
export const SWARM_TOOL = "swarm" as const;
export const POST_MESSAGE_TOOL = "post_message" as const;
export const READ_BOARD_TOOL = "read_board" as const;
export const SWARM_WAIT_TOOL = "swarm_wait" as const;

/** Core Antigravity Swarm tools (4 tools — exposed to Orchestrator and scoped inside Workers/Validators). */
export const SWARM_CORE_TOOLS = [
  SWARM_TOOL,
  POST_MESSAGE_TOOL,
  READ_BOARD_TOOL,
  SWARM_WAIT_TOOL,
] as const;

/** Union of core Swarm + drafting tools registered on the main Pi extension (7 tools). */
export const ALL_SWARM_EXTENSION_TOOLS = [
  ...SWARM_CORE_TOOLS,
  ...DRAFTING_TOOLS,
] as const;

/** Tools active when no Swarm run or draft is in progress (`swarm{action:"status"}` stays accessible). */
export const IDLE_SWARM_TOOLS = [SWARM_TOOL] as const;

/** Supported actions on the unified `swarm` tool. */
export const SWARM_ACTIONS = [
  "title",
  "add",
  "status",
  "models",
  "model",
  "steer",
  "stop",
  "kill",
  "merge",
  "channel",
  "mission",
  "done",
] as const;

/** Supported sub-operations on `swarm{action:"mission"}`. */
export const SWARM_MISSION_OPS = [
  "status",
  "upsert_assertions",
  "remove_assertion",
  "verify_assertion",
  "override_assertion",
  "upsert_features",
  "update_feature",
  "dispatch_ready",
  "resolve_handoff",
  "set_manifest",
  "read_library",
  "write_library",
] as const;

/** Validation contract assertion lifecycle statuses. */
export const ASSERTION_STATUSES = [
  "pending",
  "passed",
  "failed",
  "blocked",
] as const;

/** Mission feature execution lifecycle statuses. */
export const FEATURE_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;

/** Structured worker handoff follow-up item categories. */
export const HANDOFF_ITEM_TYPES = [
  "discovered_issue",
  "incomplete_work",
  "critical_context",
] as const;

/** Resolution states for structured worker handoff items. */
export const HANDOFF_RESOLUTIONS = [
  "open",
  "tracked",
  "dismissed",
] as const;

/** Supported sub-actions on `swarm{action:"channel"}`. */
export const SWARM_CHANNEL_ACTIONS = [
  "create",
  "list",
  "join",
  "leave",
  "archive",
] as const;

/** Built-in Pi tools granted to Worker sessions. */
export const WORKER_BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** Read-only built-in Pi tools granted to Validator sessions (transport also adds read-only guarded `bash`). */
export const VALIDATOR_BUILTIN_TOOLS = ["read", "grep", "find", "ls"] as const;

export type DraftingToolName = (typeof DRAFTING_TOOLS)[number];
export type SwarmCoreToolName = (typeof SWARM_CORE_TOOLS)[number];
export type SwarmExtensionToolName = (typeof ALL_SWARM_EXTENSION_TOOLS)[number];
export type IdleSwarmToolName = (typeof IDLE_SWARM_TOOLS)[number];
export type WorkerBuiltinToolName = (typeof WORKER_BUILTIN_TOOLS)[number];
export type ValidatorBuiltinToolName = (typeof VALIDATOR_BUILTIN_TOOLS)[number];

// ============================================================================
// Reserved Names, Channels & Naming Rules
// ============================================================================

export const ORCHESTRATOR_NAME = "orchestrator" as const;
export const MONITOR_NAME = "monitor" as const;
export const ALL_MENTION_NAME = "all" as const;
export const DEFAULT_CHANNEL = "main" as const;

export const RESERVED_MEMBER_NAMES = [
  "orchestrator",
  "coordinator",
  "all",
  "monitor",
] as const;

export type ReservedMemberName = (typeof RESERVED_MEMBER_NAMES)[number];

/**
 * Red-team / offensive security terms forbidden in Swarm member handles because
 * they frequently trigger false-positive upstream provider cybersecurity filters
 * when echoed in `@mentions`, scratch paths, and tool calls.
 */
export const SAFETY_SENSITIVE_MEMBER_SEGMENTS = [
  "attack",
  "attacks",
  "attacker",
  "exploit",
  "exploits",
  "exploiter",
  "hack",
  "hacker",
  "malware",
  "backdoor",
  "phish",
  "phishing",
  "ransomware",
  "weapon",
] as const;

export type SafetySensitiveMemberSegment =
  (typeof SAFETY_SENSITIVE_MEMBER_SEGMENTS)[number];

const SAFETY_SENSITIVE_SEGMENT_SET: ReadonlySet<string> = new Set<string>(
  SAFETY_SENSITIVE_MEMBER_SEGMENTS,
);

/**
 * Returns the offending segment if `name` contains a safety-sensitive red-team
 * token (matching hyphen-delimited segments with optional trailing digits, e.g.
 * `"attack"`, `"attack-2"`, `"attack2"`, `"db-exploit"`), or `undefined` if clean.
 */
export function findSafetySensitiveMemberSegment(
  name: string,
): string | undefined {
  const cleaned = name.trim().toLowerCase();
  if (!cleaned) {
    return undefined;
  }
  for (const rawSeg of cleaned.split("-")) {
    if (!rawSeg) continue;
    const baseSeg = rawSeg.replace(/\d+$/, "");
    if (SAFETY_SENSITIVE_SEGMENT_SET.has(rawSeg)) {
      return rawSeg;
    }
    if (baseSeg && SAFETY_SENSITIVE_SEGMENT_SET.has(baseSeg)) {
      return baseSeg;
    }
  }
  return undefined;
}

export const MEMBER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const CHANNEL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// ============================================================================
// Session Entry, Custom Message & UI Keys
// ============================================================================

export const SWARM_DRAFT_ENTRY = "pi-swarm-draft" as const;
export const SWARM_FOCUS_ENTRY = "pi-swarm-focus" as const;
export const SWARM_CONTRACT_CUSTOM_TYPE = "pi-swarm-contract" as const;
export const SWARM_WAKEUP_CUSTOM_TYPE = "pi-swarm-wakeup" as const;
export const SWARM_STATUS_CUSTOM_TYPE = "pi-swarm-status" as const;
export const SWARM_WIDGET_KEY = "swarm" as const;
export const SWARM_STATUS_KEY = "swarm" as const;

export const SWARM_STATE_VERSION = 2 as const;
export const SWARM_DRAFT_VERSION = 2 as const;
export const SWARM_FOCUS_VERSION = 2 as const;

// ============================================================================
// Persistence Directory & File Constants
// ============================================================================

export const SWARM_DIR = ".pi/swarm" as const;
export const SWARM_RUNS_DIR = "runs" as const;
export const SWARM_WORKTREES_DIR = "worktrees" as const;
export const SWARM_SESSIONS_DIR = "sessions" as const;
export const SWARM_ROSTER_FILE = "ROSTER.md" as const;
export const SWARM_MISSION_FILE = "mission.md" as const;
export const SWARM_VALIDATION_CONTRACT_FILE = "validation-contract.md" as const;
export const SWARM_VALIDATION_STATE_FILE = "validation-state.json" as const;
export const SWARM_FEATURES_FILE = "features.json" as const;
export const SWARM_SERVICES_FILE = "services.json" as const;
export const SWARM_LIBRARY_DIR = "library" as const;
export const DEFAULT_LIBRARY_TOPICS = [
  "architecture",
  "environment",
  "testing",
] as const;
export const SWARM_STATE_FILE = "state.json" as const;
export const SWARM_BOARD_FILE = "board.jsonl" as const;
export const SWARM_EVENTS_FILE = "events.jsonl" as const;
export const SWARM_LOCKS_DIR = ".locks" as const;
export const SWARM_SETTINGS_FILE = "pi-swarm-settings.json" as const;

export const SWARM_PATHS = Object.freeze({
  root: SWARM_DIR,
  runs: SWARM_RUNS_DIR,
  worktrees: SWARM_WORKTREES_DIR,
  sessions: SWARM_SESSIONS_DIR,
  rosterFile: SWARM_ROSTER_FILE,
  missionFile: SWARM_MISSION_FILE,
  validationContractFile: SWARM_VALIDATION_CONTRACT_FILE,
  validationStateFile: SWARM_VALIDATION_STATE_FILE,
  featuresFile: SWARM_FEATURES_FILE,
  servicesFile: SWARM_SERVICES_FILE,
  libraryDir: SWARM_LIBRARY_DIR,
  stateFile: SWARM_STATE_FILE,
  boardFile: SWARM_BOARD_FILE,
  eventsFile: SWARM_EVENTS_FILE,
  locks: SWARM_LOCKS_DIR,
  settingsFile: SWARM_SETTINGS_FILE,
});

// ============================================================================
// Protocol & Runtime Limits
// ============================================================================

export const SWARM_BRANCH_PREFIX = "swarm/" as const;
export const SWARM_WORKTREE_PREFIX = "wt-" as const;
export const SWARM_LOG_TAIL_LIMIT = 50;
export const SWARM_MAX_DIFF_BYTES = 128 * 1024;
/** Safety cap on peer-to-peer @mention wakeup cascades within a run. */
export const SWARM_MAX_BOARD_HOPS = 24;
export const SWARM_DEFAULT_STALL_TIMEOUT_MS = 45000;

// ============================================================================
// Default Settings (100% compatible with ~/.pi/agent/pi-swarm-settings.json)
// ============================================================================

export const DEFAULT_SWARM_SETTINGS: Readonly<SwarmSettings> = Object.freeze({
  orchestratorModel: undefined,
  orchestratorThinkingLevel: undefined,
  workerModel: undefined,
  workerThinkingLevel: undefined,
  validatorModel: undefined,
  validatorThinkingLevel: undefined,
  fallbackModels: [],
  maxConcurrency: 6,
  validatorEnabled: true,
  keepWorkersWarm: true,
  stallWatchdogEnabled: true,
  stallMonitorMode: "llm",
  stallTimeoutMs: SWARM_DEFAULT_STALL_TIMEOUT_MS,
  maxRetries: 2,
  rateLimitBaseBackoffMs: 5000,
  rateLimitMaxBackoffMs: 60000,
  gitTimeoutMs: 30000,
  autoRebase: true,
  autoTeardownOnComplete: false,
});

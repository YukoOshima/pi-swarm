import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type CustomMessageEntryDraft,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  type MessageRenderOptions,
  type SessionStartEvent,
  type Theme,
  type ThemeColor,
  ModelRuntime,
  getAgentDir,
  getMarkdownTheme,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Markdown,
  Text,
  type AutocompleteItem,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_CHANNEL,
  DEFAULT_SWARM_SETTINGS,
  MEMBER_NAME_PATTERN,
  ORCHESTRATOR_NAME,
  SWARM_CONTRACT_CUSTOM_TYPE,
  SWARM_DIR,
  SWARM_FOCUS_ENTRY,
  SWARM_FOCUS_VERSION,
  SWARM_LIBRARY_DIR,
  SWARM_RUNS_DIR,
  SWARM_STATUS_CUSTOM_TYPE,
  SWARM_STATUS_KEY,
  SWARM_WAKEUP_CUSTOM_TYPE,
  SWARM_WIDGET_KEY,
} from "./constants.js";
import {
  DraftStateController,
  type StartDraftOptions,
  type SwarmDraftState,
  type SwarmToolProfileMode,
  applySwarmToolProfile,
  buildDirectPlanPrompt,
  buildDraftingKickoffPrompt,
  buildDraftingSystemOverlay,
  buildRoleModelsFromSettings,
  escapeXml,
  isDraftActive,
  mergeTweakedMissionContract,
  registerDraftingTools,
} from "./drafting/index.js";
import {
  buildOrchestratorLiveStateSection,
  buildOrchestratorPlaybookSection,
  buildOrchestratorStandbySection,
  buildOrchestratorStaticSection,
  formatBoardEntryFull,
  InProcessPiTransport,
  isReadOnlyValidationCommand,
  registerSwarmTools,
  SwarmEngine,
} from "./runtime/index.js";
import {
  SWARM_SETTINGS_BOUNDS,
  SwarmStore,
  VALID_THINKING_LEVELS,
  WorktreeManager,
  assertOwnerSession,
  deleteProjectSettingsKeys,
  getRoleModelOrigin,
  isProcessAlive,
  loadLayeredSwarmSettings,
  parseModelSpec,
  saveSwarmSettings,
  type LayeredSettingsResult,
  type SettingsPathOptions,
} from "./store/index.js";
import {
  type AgentTurnResult,
  type AvailableModelInfo,
  type BoardMessage,
  type ContractReviewFinding,
  type ContractReviewResult,
  type IQuestionnaireUI,
  type ISwarmEngine,
  type ISwarmStore,
  type ISwarmTransport,
  type IWorktreeManager,
  type ManageMissionInput,
  type MemberEngineBridge,
  type MissionAssertion,
  type MissionFeature,
  type MissionHandoffItem,
  type PersistentAgentHandle,
  type ProposedSwarmPlan,
  type RoleModelOrigin,
  type RunSummary,
  type SafeTeardownResult,
  type SwarmEngineEvent,
  type SwarmFocusEntry,
  type SwarmMemberRecord,
  type SwarmMilestone,
  type SwarmModelRole,
  type SwarmRunState,
  type SwarmRunStatus,
  type SwarmSettings,
  type SwarmSnapshot,
  SwarmProtocolError,
  isSwarmProtocolError,
} from "./types.js";
import {
  SwarmModelPickerView,
  type ModelPickerSettingsState,
  type ModelPickerTab,
  type ModelSaveScope,
  type SwarmOverlayGraphView,
  type SwarmOverlayTab,
  type SwarmWidgetOptions,
  type SwarmWidgetState,
  bindSwarmShortcuts,
  buildRoleModelsFromPickerState,
  createQuestionnaireUI,
  createSwarmWidget,
  createSwarmWidgetState,
  formatStatusLine,
  formatZeroTurnBoardView,
  formatZeroTurnGraphView,
  formatZeroTurnModelsView,
  formatZeroTurnStatusDashboard,
  getOrderedMembers,
  isModalOpen,
  openSwarmHub,
  openSwarmModelPicker,
  openSwarmOverlay,
  sanitizePlainText,
} from "./ui/index.js";

// ============================================================================
// Public Extension Options & Constants
// ============================================================================

export { SWARM_STATUS_CUSTOM_TYPE };

export interface PiSwarmExtensionOverrides {
  /** Override worker/validator transport (e.g. mock transport in integration tests). */
  transportFactory?: (ctx: ExtensionContext, settings: SwarmSettings) => ISwarmTransport;
  /** Override settings loader for tests or custom config sources. */
  settingsLoader?: (projectRoot: string) => Promise<SwarmSettings>;
  /** Override settings saver for tests or custom config sinks. */
  settingsSaver?: (
    scope: "global" | "project",
    patch: Partial<SwarmSettings>,
    projectRoot: string,
  ) => Promise<SwarmSettings>;
  /** Optional settings path overrides (used by tests to isolate global/project files). */
  settingsPathOptions?: SettingsPathOptions;
  /** Override store construction (defaults to real SwarmStore). */
  storeFactory?: (projectRoot: string) => ISwarmStore;
  /** Override git worktree manager construction (defaults to real WorktreeManager). */
  worktreeFactory?: (projectRoot: string, settings: SwarmSettings) => IWorktreeManager;
  /** Override questionnaire/proposal UI (defaults to createQuestionnaireUI). */
  questionnaireUI?: IQuestionnaireUI;
  /** Optional pre-confirmation adversarial contract reviewer override (for deterministic tests or custom hooks). */
  contractReviewer?: (
    plan: ProposedSwarmPlan,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => Promise<ContractReviewResult | undefined>;
  /** Optional dashboard widget configuration overrides. */
  widgetOptions?: SwarmWidgetOptions;
  /** Optional deterministic clock override. */
  now?: () => number;
}

export type SwarmExtensionOptions = PiSwarmExtensionOverrides;

export const SWARM_SUBCOMMANDS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: "direct", description: "Fast-path plan & launch Dynamic Swarm without Q&A" },
  { name: "tweak", description: "Revise the focused Swarm plan, strategy, or add members interactively" },
  { name: "status", description: "Zero-turn Swarm status dashboard" },
  {
    name: "board",
    description: "Zero-turn shared Message Board [limit] [--channel <ch>] [--search <q>]",
  },
  { name: "graph", description: "Zero-turn Spawn Tree & Peer @mention interaction graph" },
  { name: "tasks", description: "Open 4-tab Swarm UI overlay (Board / Members / Graph / Search)" },
  { name: "ui", description: "Open 4-tab Swarm UI overlay (alias for /swarm tasks)" },
  {
    name: "models",
    description: "Open interactive Mission Model Picker or print 3-role overview (--print)",
  },
  {
    name: "model",
    description: "Set role default or switch member (<target> <model[:thinking]|default> [--global])",
  },
  {
    name: "steer",
    description: "Send dynamic direction/steering to a working or parked member (<member> <message>)",
  },
  { name: "merge", description: "Merge a member's share/branch worktree into baseBranch" },
  { name: "kill", description: "Permanently kill a member (<member> [--force] [reason])" },
  { name: "done", description: "Complete the active Swarm run and restore idle tools [summary]" },
  { name: "pause", description: "Pause member launches & board wakeups [reason]" },
  {
    name: "resume",
    description:
      "Resume paused or cross-session Swarm Mission ([run-id] [--continue|-c] [--quiet|-q] [guidance])",
  },
  { name: "cancel", description: "Cancel active draft or abandon focused run" },
  {
    name: "teardown",
    description: "Safely remove clean idle worktrees [--force] [--delete-branches]",
  },
  { name: "runs", description: "List Swarm runs stored in .pi/swarm/runs/" },
  { name: "focus", description: "Switch session-local focus to a run [run-id|none]" },
  { name: "settings", description: "View or adjust 3-role models, warm pool, watchdog & git settings" },
  { name: "help", description: "Show /swarm command reference (zero LLM turn)" },
];

const SINGLE_WORD_SUBCOMMANDS = new Set([
  "status",
  "graph",
  "cancel",
  "runs",
  "settings",
  "help",
]);

const SINGLE_WORD_ALIASES = new Map<string, "runs" | "settings" | "status">([
  ["ls", "runs"],
  ["list", "runs"],
  ["config", "settings"],
  ["mission", "status"],
  ["contract", "status"],
  ["goal", "status"],
]);

const ARG_SUBCOMMANDS = new Set([
  "direct",
  "tweak",
  "board",
  "tasks",
  "ui",
  "models",
  "model",
  "steer",
  "stop",
  "merge",
  "kill",
  "done",
  "pause",
  "resume",
  "teardown",
  "focus",
]);

const ORCHESTRATOR_BLOCKED_EDIT_TOOLS = new Set([
  "write",
  "edit",
  "powershell",
]);

const DRAFTING_WRITE_GUARD_REASON =
  "Swarm Drafting Mode is read-only reconnaissance. Clarify via swarm_questionnaire or call propose_swarm_plan to launch the Swarm.";

const ORCHESTRATOR_WRITE_GUARD_REASON =
  'Orchestrator must not edit repository files directly in Persistent Orchestrator Mode (doing so dirties baseBranch and breaks worktree merges). Delegate code/file changes to an isolated worker via swarm{action:"add", workspace:"share"} (or propose_swarm_plan when in standby/drafting, or steer @member via post_message / swarm{action:"steer"}). For operations no Swarm member is allowed to perform (workers cannot run git push or git merge), ask the user to run `!<command>` themselves or leave Persistent Orchestrator Mode with `/swarm exit`.';

function buildOrchestratorBashGuardReason(detail?: string): string {
  const cleanDetail = detail
    ? detail.replace(/\s+in read-only validator sessions\.?$/i, ".")
    : "Mutating shell command pattern matched.";
  return `Orchestrator must not edit repository files directly or run mutating bash commands in Persistent Orchestrator Mode (best-effort pattern matching blocked this command: ${cleanDetail}) Read-only inspection/test commands (e.g. git status, git diff, rg, ls, npm test) stay allowed. Delegate file edits, builds, and branch commits to an isolated worker via swarm{action:"add", workspace:"share"} (or propose_swarm_plan when in standby/drafting; land worker branches via swarm{action:"merge"}). For operations no Swarm member is allowed to perform (workers cannot run git push or git merge), ask the user to run \`!<command>\` themselves or leave Persistent Orchestrator Mode with \`/swarm exit\`.`;
}

const MODEL_ROLES: ReadonlyArray<SwarmModelRole> = [
  "orchestrator",
  "worker",
  "validator",
];

const OVERLAY_TABS: ReadonlySet<SwarmOverlayTab> = new Set<SwarmOverlayTab>([
  "board",
  "members",
  "graph",
  "search",
]);

const CLEAR_MODEL_TOKENS = new Set(["clear", "default", "reset", "none"]);

export interface ParsedSwarmInvocation {
  kind:
    | "bare"
    | "goal"
    | "direct"
    | "tweak"
    | "status"
    | "board"
    | "graph"
    | "tasks"
    | "ui"
    | "models"
    | "model"
    | "steer"
    | "stop"
    | "merge"
    | "kill"
    | "done"
    | "pause"
    | "resume"
    | "cancel"
    | "exit"
    | "teardown"
    | "runs"
    | "focus"
    | "settings"
    | "help";
  rest: string;
}

interface ParsedModelCommandShape {
  explicitScope?: "project" | "global";
  clearFlag: boolean;
  words: string[];
}

function parseModelCommandShape(rawArgs: string): ParsedModelCommandShape {
  const tokens = tokenizeCommandArgs(rawArgs.trim());
  let explicitScope: "project" | "global" | undefined;
  let clearFlag = false;
  const words: string[] = [];
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (lower === "--global" || lower === "-g") {
      explicitScope = "global";
    } else if (lower === "--project") {
      explicitScope = "project";
    } else if (lower === "--clear") {
      clearFlag = true;
    } else {
      words.push(tok);
    }
  }
  return {
    ...(explicitScope ? { explicitScope } : {}),
    clearFlag,
    words,
  };
}

function isValidModelSubcommandRest(rest: string): boolean {
  if (!rest) {
    return true;
  }
  const { clearFlag, words } = parseModelCommandShape(rest);
  if (words.length === 0) {
    return true;
  }
  const firstWord = words[0]!;
  if (words.length === 1 && !clearFlag && firstWord.toLowerCase() === "--print") {
    return true;
  }
  const cleanTarget = firstWord.replace(/^@/, "").trim().toLowerCase();
  const validTarget =
    isSwarmModelRole(cleanTarget) ||
    (words.length === 1 && !clearFlag && cleanTarget === "fallbacks") ||
    MEMBER_NAME_PATTERN.test(cleanTarget);
  if (!validTarget) {
    return false;
  }
  if (words.length === 1 || clearFlag) {
    // Matches handleModelCommand: single target opens picker/usage, and `--clear`
    // always sets model=default regardless of any extra positional tokens.
    return true;
  }
  const rawModelAndThinking = words.slice(1).join(" ").trim();
  if (!rawModelAndThinking) {
    return false;
  }
  if (CLEAR_MODEL_TOKENS.has(rawModelAndThinking.toLowerCase())) {
    return true;
  }
  const spaceParts = rawModelAndThinking.split(/\s+/).filter(Boolean);
  if (spaceParts.length >= 2) {
    const tail = spaceParts[spaceParts.length - 1]!;
    return isThinkingLevel(tail.toLowerCase());
  }
  return true;
}

export function parseSwarmCommand(rawArgs: string): ParsedSwarmInvocation {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { kind: "bare", rest: "" };
  }

  // Leading `--` escape forces literal goal routing regardless of first word
  if (trimmed === "--" || /^--\s/.test(trimmed)) {
    return { kind: "goal", rest: trimmed.slice(2).trim() };
  }

  const spaceIdx = trimmed.search(/\s/);
  const head = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();

  if (ARG_SUBCOMMANDS.has(head)) {
    // Disambiguate prose goals starting with `merge`, `focus`, or `model`
    if (head === "merge" && rest && /\s/.test(rest)) {
      return { kind: "goal", rest: trimmed };
    }
    if (head === "focus" && rest && /\s/.test(rest)) {
      return { kind: "goal", rest: trimmed };
    }
    if (head === "model" && !isValidModelSubcommandRest(rest)) {
      return { kind: "goal", rest: trimmed };
    }
    return {
      kind: head as
        | "direct"
        | "tweak"
        | "board"
        | "tasks"
        | "ui"
        | "models"
        | "model"
        | "steer"
        | "stop"
        | "merge"
        | "kill"
        | "done"
        | "pause"
        | "resume"
        | "teardown"
        | "focus",
      rest,
    };
  }

  if (head === "mc" || ((head === "open" || head === "panel") && (!rest || !/\s/.test(rest)))) {
    return { kind: "ui", rest };
  }

  if (
    (head === "exit" || head === "leave") &&
    (!rest || rest.toLowerCase() === "--force")
  ) {
    return { kind: "exit", rest };
  }

  if (SINGLE_WORD_SUBCOMMANDS.has(head) && !rest) {
    return {
      kind: head as
        | "status"
        | "graph"
        | "cancel"
        | "runs"
        | "settings"
        | "help",
      rest,
    };
  }

  const singleAlias = SINGLE_WORD_ALIASES.get(head);
  if (singleAlias && !rest) {
    return { kind: singleAlias, rest: "" };
  }

  return { kind: "goal", rest: trimmed };
}

export const MAX_SPEC_FILE_BYTES = 64 * 1024; // 64 KiB per spec file
export const MAX_TOTAL_SPEC_BYTES = 128 * 1024; // 128 KiB combined across spec files

const LAUNCH_FLAGS_USAGE =
  "Usage: /swarm [--no-validator|--validator] [--concurrency|-c <1..64>] [--branch|-b <name>] [--fast|--no-review] [--file|-f <path>] [--] <goal>. Use `--` to pass literal goal text starting with `-` or a subcommand name.";

export interface ParsedSwarmGoalLaunchOptions {
  goal: string;
  validatorEnabled?: boolean;
  maxConcurrency?: number;
  baseBranch?: string;
  skipContractReview?: boolean;
  files?: string[];
  error?: string;
}

interface ScannedArgToken {
  value: string;
  start: number;
  end: number;
  startsWithQuote: boolean;
  unterminatedQuote: boolean;
}

function scanNextArgToken(input: string, fromIndex: number): ScannedArgToken | null {
  let i = fromIndex;
  while (i < input.length && /\s/.test(input[i]!)) {
    i++;
  }
  if (i >= input.length) {
    return null;
  }
  const start = i;
  const startsWithQuote = input[start] === '"' || input[start] === "'";
  let value = "";
  let quote: '"' | "'" | null = null;
  while (i < input.length) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        value += input[++i]!;
      } else {
        value += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      break;
    }
    value += ch;
    i++;
  }
  return {
    value,
    start,
    end: i,
    startsWithQuote,
    unterminatedQuote: quote !== null,
  };
}

function isValidGitBranchName(name: string): boolean {
  if (!name || name === "HEAD") {
    return false;
  }
  if (
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.startsWith(".") ||
    name.endsWith(".")
  ) {
    return false;
  }
  if (
    /[\x00-\x20\x7f~^:?*[\\]/.test(name) ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{")
  ) {
    return false;
  }
  for (const component of name.split("/")) {
    if (
      !component ||
      component.startsWith(".") ||
      component.endsWith(".lock")
    ) {
      return false;
    }
  }
  return true;
}

function isKnownLaunchFlagToken(rawToken: string): boolean {
  if (rawToken === "--" || rawToken.startsWith("--")) {
    return true;
  }
  const eqIdx = rawToken.indexOf("=");
  const flagPart = (eqIdx >= 0 ? rawToken.slice(0, eqIdx) : rawToken).toLowerCase();
  return flagPart === "-c" || flagPart === "-b" || flagPart === "-f";
}

/**
 * Pure parser for leading one-shot launch flags on `/swarm <goal>`, `/swarm direct <goal>`,
 * and `/swarm-direct <goal>`. Only leading flags are parsed; bare `--` stops flag parsing
 * and preserves the remaining text verbatim.
 */
export function parseSwarmGoalLaunchOptions(
  rawInput: string,
): ParsedSwarmGoalLaunchOptions {
  let pos = 0;
  let validatorEnabled: boolean | undefined;
  let maxConcurrency: number | undefined;
  let baseBranch: string | undefined;
  let skipContractReview: boolean | undefined;
  const files: string[] = [];

  const makeError = (message: string): ParsedSwarmGoalLaunchOptions => ({
    goal: "",
    error: `${message} ${LAUNCH_FLAGS_USAGE}`,
  });

  const parseConcurrencyValue = (
    rawVal: string,
    flagLabel: string,
  ): { ok: true; value: number } | { ok: false; error: string } => {
    const trimmedVal = rawVal.trim();
    if (!/^[+-]?\d+$/.test(trimmedVal)) {
      return {
        ok: false,
        error: `Invalid ${flagLabel} value "${rawVal}" (must be an integer between ${SWARM_SETTINGS_BOUNDS.maxConcurrency.min} and ${SWARM_SETTINGS_BOUNDS.maxConcurrency.max}).`,
      };
    }
    const parsed = Number.parseInt(trimmedVal, 10);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < SWARM_SETTINGS_BOUNDS.maxConcurrency.min ||
      parsed > SWARM_SETTINGS_BOUNDS.maxConcurrency.max
    ) {
      return {
        ok: false,
        error: `Out-of-range ${flagLabel} value "${rawVal}" (must be between ${SWARM_SETTINGS_BOUNDS.maxConcurrency.min} and ${SWARM_SETTINGS_BOUNDS.maxConcurrency.max}).`,
      };
    }
    return { ok: true, value: parsed };
  };

  const parseBranchValue = (
    rawVal: string,
    flagLabel: string,
  ): { ok: true; value: string } | { ok: false; error: string } => {
    if (!isValidGitBranchName(rawVal)) {
      return {
        ok: false,
        error: `Invalid ${flagLabel} value "${rawVal}" (must be a valid Git branch name).`,
      };
    }
    return { ok: true, value: rawVal };
  };

  while (pos < rawInput.length) {
    const tok = scanNextArgToken(rawInput, pos);
    if (!tok) {
      break;
    }

    if (tok.startsWithQuote) {
      break;
    }

    if (tok.value === "--") {
      pos = tok.end;
      break;
    }

    if (!tok.value.startsWith("-") || tok.value === "-") {
      break;
    }

    if (tok.unterminatedQuote) {
      return makeError("Unterminated quote in launch flag arguments.");
    }

    const eqIdx = tok.value.indexOf("=");
    const flagPart = (eqIdx >= 0 ? tok.value.slice(0, eqIdx) : tok.value).toLowerCase();
    const inlineVal = eqIdx >= 0 ? tok.value.slice(eqIdx + 1) : undefined;

    if (flagPart === "--no-validator") {
      if (inlineVal !== undefined) {
        return makeError(`Flag "--no-validator" does not take a value.`);
      }
      validatorEnabled = false;
      pos = tok.end;
      continue;
    }

    if (flagPart === "--validator") {
      if (inlineVal !== undefined) {
        return makeError(`Flag "--validator" does not take a value.`);
      }
      validatorEnabled = true;
      pos = tok.end;
      continue;
    }

    if (flagPart === "--fast" || flagPart === "--no-review") {
      if (inlineVal !== undefined) {
        return makeError(`Flag "${flagPart}" does not take a value.`);
      }
      skipContractReview = true;
      pos = tok.end;
      continue;
    }

    if (flagPart === "--concurrency" || flagPart === "-c") {
      let rawVal = inlineVal;
      let nextPos = tok.end;
      if (rawVal === undefined) {
        const valTok = scanNextArgToken(rawInput, tok.end);
        if (!valTok) {
          return makeError(`Missing value after ${flagPart}.`);
        }
        if (valTok.unterminatedQuote) {
          return makeError(`Unterminated quote after ${flagPart}.`);
        }
        rawVal = valTok.value;
        nextPos = valTok.end;
      } else if (!rawVal.trim()) {
        return makeError(`Missing value after ${flagPart}=.`);
      }
      const checked = parseConcurrencyValue(rawVal, flagPart);
      if (!checked.ok) {
        return makeError(checked.error);
      }
      maxConcurrency = checked.value;
      pos = nextPos;
      continue;
    }

    if (flagPart === "--branch" || flagPart === "-b") {
      let rawVal = inlineVal;
      let nextPos = tok.end;
      if (rawVal === undefined) {
        const valTok = scanNextArgToken(rawInput, tok.end);
        if (!valTok) {
          return makeError(`Missing branch name after ${flagPart}.`);
        }
        if (valTok.unterminatedQuote) {
          return makeError(`Unterminated quote after ${flagPart}.`);
        }
        rawVal = valTok.value;
        nextPos = valTok.end;
      } else if (rawVal.length === 0) {
        return makeError(`Missing branch name after ${flagPart}=.`);
      }
      const checked = parseBranchValue(rawVal, flagPart);
      if (!checked.ok) {
        return makeError(checked.error);
      }
      baseBranch = checked.value;
      pos = nextPos;
      continue;
    }

    if (flagPart === "--file" || flagPart === "-f") {
      let rawVal = inlineVal;
      let nextPos = tok.end;
      if (rawVal === undefined) {
        const valTok = scanNextArgToken(rawInput, tok.end);
        if (!valTok) {
          return makeError(`Missing file path after ${flagPart}.`);
        }
        if (valTok.unterminatedQuote) {
          return makeError(`Unterminated quote after ${flagPart}.`);
        }
        if (!valTok.startsWithQuote && isKnownLaunchFlagToken(valTok.value)) {
          return makeError(`Missing file path after ${flagPart}.`);
        }
        rawVal = valTok.value;
        nextPos = valTok.end;
      } else if (!rawVal.trim()) {
        return makeError(`Missing file path after ${flagPart}=.`);
      }
      const trimmedPath = rawVal.trim();
      if (!trimmedPath) {
        return makeError(`Missing file path after ${flagPart}.`);
      }
      files.push(trimmedPath);
      pos = nextPos;
      continue;
    }

    if (tok.value.startsWith("--")) {
      return makeError(`Unknown launch flag "${tok.value}".`);
    }

    break;
  }

  const goal = rawInput.slice(pos).trim();
  return {
    goal,
    ...(validatorEnabled !== undefined ? { validatorEnabled } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(skipContractReview !== undefined ? { skipContractReview } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

interface ReadSpecFileResult {
  content?: string;
  bytesRead?: number;
  notRegularFile?: boolean;
  error?: string;
}

async function readSpecFileBounded(
  cwd: string,
  rawPath: string,
  remainingTotalBytes: number,
): Promise<ReadSpecFileResult> {
  const resolved = path.resolve(cwd, rawPath);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Check regularity before opening so FIFOs/named pipes or special devices never block.
    const preStat = await stat(resolved);
    if (!preStat.isFile()) {
      return {
        notRegularFile: true,
        error: `Spec path "${rawPath}" is not a regular file.`,
      };
    }
    const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
    fh = await open(resolved, openFlags);
    const st = await fh.stat();
    if (!st.isFile()) {
      return {
        notRegularFile: true,
        error: `Spec path "${rawPath}" is not a regular file.`,
      };
    }
    if (st.size > MAX_SPEC_FILE_BYTES) {
      return {
        error: `Spec file "${rawPath}" exceeds the ${Math.floor(MAX_SPEC_FILE_BYTES / 1024)} KiB limit (${st.size} bytes).`,
      };
    }
    const effectiveCap = Math.min(MAX_SPEC_FILE_BYTES, remainingTotalBytes);
    if (st.size > effectiveCap) {
      return {
        error: `Combined spec files exceed the ${Math.floor(MAX_TOTAL_SPEC_BYTES / 1024)} KiB total limit while reading "${rawPath}".`,
      };
    }
    const buf = Buffer.allocUnsafe(effectiveCap + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_SPEC_FILE_BYTES) {
      return {
        error: `Spec file "${rawPath}" exceeds the ${Math.floor(MAX_SPEC_FILE_BYTES / 1024)} KiB limit.`,
      };
    }
    if (total > effectiveCap) {
      return {
        error: `Combined spec files exceed the ${Math.floor(MAX_TOTAL_SPEC_BYTES / 1024)} KiB total limit while reading "${rawPath}".`,
      };
    }
    return {
      content: buf.subarray(0, total).toString("utf8"),
      bytesRead: total,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "EISDIR" ||
      code === "ENXIO" ||
      code === "EINVAL" ||
      code === "ENAMETOOLONG" ||
      code === "ELOOP"
    ) {
      return {
        notRegularFile: true,
        error: `Spec file "${rawPath}" could not be read (${code}).`,
      };
    }
    return {
      error: `Failed to read spec file "${rawPath}": ${formatError(err)}`,
    };
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function resolveGoalSpecFiles(
  cwd: string,
  goalText: string,
  explicitFiles?: readonly string[],
): Promise<{ seed: string; error?: string }> {
  let remainingBudget = MAX_TOTAL_SPEC_BYTES;
  const prependedBlocks: string[] = [];

  if (explicitFiles && explicitFiles.length > 0) {
    for (const filePath of explicitFiles) {
      const readRes = await readSpecFileBounded(cwd, filePath, remainingBudget);
      if (readRes.error || readRes.content === undefined) {
        return {
          seed: "",
          error: readRes.error ?? `Failed to read spec file "${filePath}".`,
        };
      }
      remainingBudget -= readRes.bytesRead ?? 0;
      const trimmedContent = readRes.content.trim();
      if (trimmedContent) {
        prependedBlocks.push(trimmedContent);
      }
    }
  }

  let expandedGoal = goalText.trim();
  if (expandedGoal) {
    const tokenPattern = /(^|\s)(@(\S+))(?=\s|$)/g;
    const matches = Array.from(expandedGoal.matchAll(tokenPattern));
    if (matches.length > 0) {
      const cache = new Map<string, { label: string; content: string } | null>();
      const appendedBlocks: Array<{ label: string; content: string }> = [];
      const appendedResolved = new Set<string>();
      const replacements: Array<{ start: number; end: number; replacement: string }> = [];

      for (const m of matches) {
        const leadingWs = m[1] ?? "";
        const candidatePath = m[3] ?? "";
        if (!candidatePath) continue;
        const tokenStart = (m.index ?? 0) + leadingWs.length;
        const tokenEnd = tokenStart + (m[2]?.length ?? 0);
        const resolvedKey = path.resolve(cwd, candidatePath);

        let entry = cache.get(resolvedKey);
        if (entry === undefined) {
          const readRes = await readSpecFileBounded(cwd, candidatePath, remainingBudget);
          if (readRes.notRegularFile) {
            cache.set(resolvedKey, null);
            continue;
          }
          if (readRes.error || readRes.content === undefined) {
            return {
              seed: "",
              error: readRes.error ?? `Failed to read spec file "@${candidatePath}".`,
            };
          }
          remainingBudget -= readRes.bytesRead ?? 0;
          entry = {
            label: candidatePath,
            content: readRes.content.trim(),
          };
          cache.set(resolvedKey, entry);
        }

        if (!entry) {
          continue;
        }

        replacements.push({
          start: tokenStart,
          end: tokenEnd,
          replacement: entry.label,
        });
        if (!appendedResolved.has(resolvedKey) && entry.content) {
          appendedResolved.add(resolvedKey);
          appendedBlocks.push(entry);
        }
      }

      if (replacements.length > 0) {
        const soleToken =
          replacements.length === 1 &&
          replacements[0]!.start === 0 &&
          replacements[0]!.end === expandedGoal.length;
        if (soleToken) {
          expandedGoal = appendedBlocks[0]?.content ?? "";
        } else {
          let rebuilt = "";
          let cursor = 0;
          for (const rep of replacements) {
            rebuilt += expandedGoal.slice(cursor, rep.start) + rep.replacement;
            cursor = rep.end;
          }
          rebuilt += expandedGoal.slice(cursor);
          if (appendedBlocks.length > 0) {
            const specSections = appendedBlocks
              .map((b) => `[Spec: ${b.label}]\n${b.content}`)
              .join("\n\n");
            expandedGoal = `${rebuilt.trim()}\n\n${specSections}`;
          } else {
            expandedGoal = rebuilt.trim();
          }
        }
      }
    }
  }

  const sections = [...prependedBlocks, ...(expandedGoal ? [expandedGoal] : [])];
  return { seed: sections.join("\n\n").trim() };
}

function tokenizeCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[++i]!;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

interface ParsedBoardArgs {
  limit: number;
  channel?: string;
  search?: string;
  error?: string;
}

function parseBoardArgs(rawArgs: string): ParsedBoardArgs {
  const tokens = tokenizeCommandArgs(rawArgs.trim());
  let limit = 25;
  let channel: string | undefined;
  let search: string | undefined;
  let sawLimit = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const lower = token.toLowerCase();

    if (lower === "--channel" || lower === "-c") {
      const next = tokens[i + 1];
      if (!next) {
        return { limit, error: "Missing channel name after --channel." };
      }
      i += 1;
      channel = next.replace(/^@#?/, "").trim().toLowerCase() || undefined;
      continue;
    }
    if (lower.startsWith("--channel=")) {
      const val = token.slice("--channel=".length).replace(/^@#?/, "").trim().toLowerCase();
      if (!val) {
        return { limit, error: "Missing channel name after --channel=." };
      }
      channel = val;
      continue;
    }

    if (lower === "--search" || lower === "-s") {
      const next = tokens[i + 1];
      if (!next) {
        return { limit, error: "Missing query string after --search." };
      }
      i += 1;
      search = next.trim() || undefined;
      continue;
    }
    if (lower.startsWith("--search=")) {
      const val = token.slice("--search=".length).trim();
      if (!val) {
        return { limit, error: "Missing query string after --search=." };
      }
      search = val;
      continue;
    }

    if (token.startsWith("#") && token.length > 1) {
      channel = token.slice(1).trim().toLowerCase();
      continue;
    }

    if (!sawLimit && /^\d+$/.test(token)) {
      const parsed = Number.parseInt(token, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(200, Math.max(1, parsed));
        sawLimit = true;
        continue;
      }
    }

    return {
      limit,
      error: `Unrecognized /swarm board argument "${token}". Usage: /swarm board [limit] [--channel <ch>] [--search <q>].`,
    };
  }

  return {
    limit,
    ...(channel ? { channel } : {}),
    ...(search ? { search } : {}),
  };
}

interface ParsedKillArgs {
  target: string;
  force: boolean;
  reason?: string;
}

function parseKillArgs(rawArgs: string): ParsedKillArgs {
  const tokens = tokenizeCommandArgs(rawArgs.trim());
  let target = "";
  let force = false;
  const reasonParts: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "--force" || lower === "-f") {
      force = true;
      continue;
    }
    if (!target) {
      target = token.replace(/^@/, "").trim();
      continue;
    }
    reasonParts.push(token);
  }

  const reason = reasonParts.join(" ").trim();
  return {
    target,
    force,
    ...(reason ? { reason } : {}),
  };
}

interface ParsedDoneArgs {
  force: boolean;
  summary: string;
}

function parseDoneArgs(rawArgs: string): ParsedDoneArgs {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { force: false, summary: "" };
  }
  const tokens = tokenizeCommandArgs(trimmed);
  let force = false;
  const summaryParts: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "--force" || lower === "-f") {
      force = true;
      continue;
    }
    summaryParts.push(token);
  }
  if (!force) {
    return { force: false, summary: trimmed };
  }
  return {
    force: true,
    summary: summaryParts.join(" ").trim(),
  };
}

const CONTRACT_REVIEW_TIMEOUT_MS = 35_000;
const CONTRACT_REVIEW_WORKING_MESSAGE =
  "🐝 Adversarial Contract Review (checking VAL-* coverage & commands)…";

const VALID_CONTRACT_FINDING_CATEGORIES = new Set<ContractReviewFinding["category"]>([
  "missing_assertion",
  "ambiguous_criteria",
  "invalid_command",
  "file_collision",
  "other",
]);

function normalizeContractFindingCategory(
  raw: unknown,
): ContractReviewFinding["category"] {
  if (typeof raw !== "string") {
    return "other";
  }
  const clean = raw.trim().toLowerCase() as ContractReviewFinding["category"];
  return VALID_CONTRACT_FINDING_CATEGORIES.has(clean) ? clean : "other";
}

function normalizeContractFindings(
  rawFindings: unknown,
  defaultSeverity: "blocking" | "warning" = "blocking",
): ContractReviewFinding[] {
  if (!Array.isArray(rawFindings)) {
    return [];
  }
  const findings: ContractReviewFinding[] = [];
  for (const item of rawFindings) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const message =
      typeof rec.message === "string"
        ? rec.message.trim()
        : typeof rec.description === "string"
          ? rec.description.trim()
          : "";
    if (!message) {
      continue;
    }
    const severity: "blocking" | "warning" =
      rec.severity === "warning"
        ? "warning"
        : rec.severity === "blocking"
          ? "blocking"
          : defaultSeverity;
    const category = normalizeContractFindingCategory(rec.category);
    const suggestion =
      typeof rec.suggestion === "string" && rec.suggestion.trim()
        ? rec.suggestion.trim()
        : undefined;
    findings.push({
      severity,
      category,
      message,
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return findings;
}

function tryParseContractReviewJson(
  candidate: string,
  defaultSeverity: "blocking" | "warning",
): ContractReviewResult | undefined {
  const stripped = candidate
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stripped.slice(firstBrace, lastBrace + 1)) as Record<
      string,
      unknown
    >;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const hasReviewShape =
      "approved" in parsed || "findings" in parsed || "gaps" in parsed;
    if (!hasReviewShape) {
      return undefined;
    }
    const findings = normalizeContractFindings(
      parsed.findings ?? parsed.gaps,
      defaultSeverity,
    );
    const hasBlocking = findings.some((f) => f.severity === "blocking");
    const explicitApproved =
      typeof parsed.approved === "boolean" ? parsed.approved : !hasBlocking;
    const approved = explicitApproved && !hasBlocking;
    const rawSummary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : approved
          ? "Adversarial contract review passed with no blocking gaps."
          : `Adversarial contract review identified ${findings.length || 1} gap(s).`;
    return {
      approved,
      summary: rawSummary,
      findings,
    };
  } catch {
    return undefined;
  }
}

export function parseContractReviewOutput(
  rawText: string,
): ContractReviewResult | undefined {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return undefined;
  }

  const gapsMatch = trimmed.match(/<gaps_found>([\s\S]*?)<\/gaps_found>/i);
  if (gapsMatch) {
    const inner = gapsMatch[1]!.trim();
    const fromJson = tryParseContractReviewJson(inner, "blocking");
    if (fromJson) {
      const ensuredFindings =
        fromJson.findings.length > 0
          ? fromJson.findings
          : [
              {
                severity: "blocking" as const,
                category: "other" as const,
                message: fromJson.summary || "Contract review identified blocking gaps.",
              },
            ];
      return {
        approved: false,
        summary: fromJson.summary,
        findings: ensuredFindings,
      };
    }

    const lineFindings: ContractReviewFinding[] = [];
    for (const rawLine of inner.split(/\r?\n/)) {
      const line = rawLine.replace(/^[-*•\d.)]+\s*/, "").trim();
      if (!line || /^```/.test(line)) {
        continue;
      }
      const sevMatch = line.match(/^\[(blocking|warning)\]\s*(.*)$/i);
      const severity: "blocking" | "warning" =
        sevMatch && sevMatch[1]!.toLowerCase() === "warning" ? "warning" : "blocking";
      let remainder = sevMatch ? sevMatch[2]!.trim() : line;
      let category: ContractReviewFinding["category"] = "other";
      const catMatch = remainder.match(/^\(([a-z_]+)\):?\s*(.*)$/i);
      if (catMatch) {
        category = normalizeContractFindingCategory(catMatch[1]);
        remainder = catMatch[2]!.trim();
      }
      let suggestion: string | undefined;
      const sugIdx = remainder.search(/\s*\|\s*suggestion:\s*/i);
      if (sugIdx >= 0) {
        const parts = remainder.split(/\s*\|\s*suggestion:\s*/i);
        remainder = parts[0]!.trim();
        suggestion = parts.slice(1).join(" ").trim() || undefined;
      }
      if (remainder) {
        lineFindings.push({
          severity,
          category,
          message: remainder,
          ...(suggestion ? { suggestion } : {}),
        });
      }
    }

    if (lineFindings.length === 0 && inner) {
      lineFindings.push({
        severity: "blocking",
        category: "other",
        message: inner.slice(0, 400),
      });
    }

    const hasBlocking = lineFindings.some((f) => f.severity === "blocking");
    return {
      approved: !hasBlocking && lineFindings.length === 0,
      summary:
        lineFindings[0]?.message ??
        "Adversarial contract review requested updates before launch.",
      findings: lineFindings,
    };
  }

  const approvedSelfClosing = /<approved\s*\/>/i.test(trimmed);
  const approvedBlockMatch = trimmed.match(/<approved>([\s\S]*?)<\/approved>/i);
  if (approvedSelfClosing || approvedBlockMatch) {
    const inner = approvedBlockMatch?.[1]?.trim() ?? "";
    const fromJson =
      tryParseContractReviewJson(inner, "warning") ??
      tryParseContractReviewJson(trimmed, "warning");
    if (fromJson) {
      return fromJson;
    }
    return {
      approved: true,
      summary: inner || "Adversarial contract review passed with no blocking gaps.",
      findings: [],
    };
  }

  return tryParseContractReviewJson(trimmed, "blocking");
}

function buildAdversarialContractReviewPrompts(plan: ProposedSwarmPlan): {
  systemPrompt: string;
  initialPrompt: string;
} {
  const systemPrompt = [
    "# Skeptical Adversarial Contract Reviewer (`@contract-reviewer` — Ephemeral Read-Only Audit)",
    "You perform a fast, skeptical pre-launch audit of a proposed Pi Swarm Mission Contract against actual repository files (`package.json`, `tsconfig.json`, source paths).",
    "Rules:",
    "1. Strictly read-only: use `read`, `grep`, `find`, or `ls` only when needed (e.g. verifying `package.json` scripts or owned paths). NEVER edit files, NEVER run mutating commands, and NEVER invoke `swarm`, `post_message`, `read_board`, or `swarm_wait`.",
    "2. Report ONLY genuine high-impact gaps (do NOT nitpick wording or invent hypothetical scope):",
    "   - `missing_assertion`: Critical user requirements in `<objective>` / `<acceptance_criteria>` missing from `assertions` (`VAL-*`) or unclaimed by `features[].fulfills`.",
    "   - `invalid_command`: Non-existent scripts in `commands` or `services` vs `package.json`/repo files, or speculative `npx -y` network downloads.",
    "   - `file_collision`: Overlapping `filesOwned` between parallel features in the same milestone that lack `dependsOn` ordering.",
    "   - `ambiguous_criteria` / `other`: Untestable acceptance criteria or `services` port/boundary violations.",
    "3. Output your final verdict concisely using EXACTLY ONE of:",
    "   - `<approved/>` (when the contract has zero high-impact gaps), OR",
    '   - `<gaps_found>{"approved":false,"summary":"...","findings":[{"severity":"blocking","category":"missing_assertion|ambiguous_criteria|invalid_command|file_collision|other","message":"...","suggestion":"..."}]}</gaps_found>`.',
  ].join("\n");

  const payload = {
    title: plan.title,
    baseBranch: plan.baseBranch,
    assertions: (plan.assertions ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      ...(a.evidenceRequired ? { evidenceRequired: a.evidenceRequired } : {}),
    })),
    features: (plan.features ?? []).map((f) => ({
      id: f.id,
      title: f.title,
      milestone: f.milestone,
      ...(f.dependsOn?.length ? { dependsOn: f.dependsOn } : {}),
      ...(f.filesOwned?.length ? { filesOwned: f.filesOwned } : {}),
      fulfills: f.fulfills,
    })),
    commands: plan.commands ?? [],
    services: plan.services ?? [],
    boundaries: plan.boundaries ?? [],
  };

  const initialPrompt = [
    `<objective>\n${plan.objective}\n</objective>`,
    `<strategy>\n${plan.strategy}\n</strategy>`,
    `<acceptance_criteria>\n${plan.acceptanceCriteria}\n</acceptance_criteria>`,
    `<proposed_contract>\n${JSON.stringify(payload, null, 2)}\n</proposed_contract>`,
    "",
    "Verify `commands`, `services`, `assertions` (`VAL-*`), and `features` (`filesOwned`, `fulfills`) against `package.json` / repo layout now, then emit `<approved/>` or `<gaps_found>...</gaps_found>`.",
  ].join("\n\n");

  return { systemPrompt, initialPrompt };
}

function isSwarmModelRole(value: string): value is SwarmModelRole {
  return value === "orchestrator" || value === "worker" || value === "validator";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return VALID_THINKING_LEVELS.has(value as ThinkingLevel);
}

function formatHostModelId(
  model: { provider?: string; id?: string } | undefined,
): string | undefined {
  if (!model?.id) {
    return undefined;
  }
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

// ============================================================================
// Orchestrator Host Model Application Helper
// ============================================================================

export interface ApplyOrchestratorModelResult {
  applied: boolean;
  changed?: boolean;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  warning?: string;
}

interface PreSwarmHostModelSnapshot {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

function doesHostModelMatchTarget(
  hostModel: { provider?: string; id?: string } | undefined,
  targetModelSpec: string,
): boolean {
  if (!hostModel?.id) {
    return false;
  }
  const target = targetModelSpec.trim().toLowerCase();
  if (!target) {
    return false;
  }
  const hostId = hostModel.id.trim().toLowerCase();
  const hostFull = formatHostModelId(hostModel)?.trim().toLowerCase();
  if (hostFull && target === hostFull) {
    return true;
  }
  if (!target.includes("/") && target === hostId) {
    return true;
  }
  return false;
}

/**
 * Resolves and applies `settings.orchestratorModel` (+ optional thinking level)
 * onto the host Pi session via `resolveCliModel` + `pi.setModel` / `pi.setThinkingLevel`.
 * Idempotently short-circuits when `ctx.model` and active thinking level already match target.
 * Never throws when credentials or model catalog entries are unavailable — emits a clean warning.
 */
async function applyOrchestratorModel(
  pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel"> &
    Partial<Pick<ExtensionAPI, "getThinkingLevel">>,
  ctx: ExtensionContext | undefined,
  settings: SwarmSettings,
  getFallbackRuntime: () => Promise<ModelRuntime>,
  options: { clearThinking?: boolean } = {},
): Promise<ApplyOrchestratorModelResult> {
  const configuredModel = settings.orchestratorModel?.trim();
  const resolveHostDefaultThinking = (): ThinkingLevel => {
    const raw = (
      ctx as
        | { settingsManager?: { getDefaultThinkingLevel?: () => ThinkingLevel | undefined } }
        | undefined
    )?.settingsManager?.getDefaultThinkingLevel?.();
    return raw && VALID_THINKING_LEVELS.has(raw) ? raw : "medium";
  };
  const getActiveThinkingLevel = (): ThinkingLevel | undefined => {
    try {
      const fromPi =
        typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
      if (fromPi && VALID_THINKING_LEVELS.has(fromPi)) {
        return fromPi;
      }
    } catch {
      // ignore if host harness does not expose active thinking level
    }
    const fromCtx = ctx?.thinkingLevel;
    return fromCtx && VALID_THINKING_LEVELS.has(fromCtx) ? fromCtx : undefined;
  };

  if (!configuredModel) {
    let changed = false;
    const currentThinking = getActiveThinkingLevel();
    let appliedThinking: ThinkingLevel | undefined;
    if (typeof pi.setThinkingLevel === "function") {
      try {
        if (settings.orchestratorThinkingLevel) {
          appliedThinking = settings.orchestratorThinkingLevel;
          if (currentThinking !== settings.orchestratorThinkingLevel) {
            pi.setThinkingLevel(settings.orchestratorThinkingLevel);
            changed = true;
          }
        } else if (options.clearThinking) {
          const defaultThinking = resolveHostDefaultThinking();
          appliedThinking = defaultThinking;
          if (currentThinking !== defaultThinking) {
            pi.setThinkingLevel(defaultThinking);
            changed = true;
          }
        }
      } catch {
        // ignore thinking-level error when no model change requested
      }
    }
    return {
      applied: false,
      changed,
      ...(appliedThinking !== undefined ? { thinkingLevel: appliedThinking } : {}),
    };
  }

  const parsedConfigured = parseModelSpec(configuredModel);
  const targetModelSpec = parsedConfigured.model || configuredModel;
  const targetThinking =
    settings.orchestratorThinkingLevel ?? parsedConfigured.thinkingLevel;
  const desiredThinking =
    targetThinking ?? (options.clearThinking ? resolveHostDefaultThinking() : undefined);
  const activeThinkingBefore = getActiveThinkingLevel();

  // Fast-path idempotency: if host ctx.model already matches targetModelSpec,
  // avoid redundant resolveCliModel custom-model warnings, pi.setModel calls, and thinking flaps.
  if (doesHostModelMatchTarget(ctx?.model, targetModelSpec)) {
    let thinkingChanged = false;
    if (
      desiredThinking !== undefined &&
      activeThinkingBefore !== desiredThinking &&
      typeof pi.setThinkingLevel === "function"
    ) {
      try {
        pi.setThinkingLevel(desiredThinking);
        thinkingChanged = true;
      } catch {
        // ignore thinking-level update error when model already matches
      }
    }
    return {
      applied: true,
      changed: thinkingChanged,
      model: formatHostModelId(ctx?.model) ?? targetModelSpec,
      thinkingLevel: desiredThinking ?? activeThinkingBefore,
    };
  }

  const warn = (message: string): ApplyOrchestratorModelResult => {
    if (ctx?.hasUI) {
      ctx.ui.notify(message, "warning");
    }
    return { applied: false, changed: false, warning: message };
  };

  try {
    const hostRegistry = ctx?.modelRegistry as
      | { runtime?: ModelRuntime }
      | undefined;
    const modelRuntime = hostRegistry?.runtime ?? (await getFallbackRuntime());

    const resolved = resolveCliModel({
      cliModel: configuredModel,
      cliThinking: settings.orchestratorThinkingLevel,
      modelRuntime,
    });

    if (resolved.error || !resolved.model) {
      return warn(
        `Orchestrator model "${configuredModel}" could not be resolved: ${resolved.error ?? "model not found"}. Keeping current host model.`,
      );
    }

    const effectiveThinking =
      settings.orchestratorThinkingLevel ?? resolved.thinkingLevel;
    const resolvedDesiredThinking =
      effectiveThinking ?? (options.clearThinking ? resolveHostDefaultThinking() : undefined);
    const alreadyOnResolvedModel =
      Boolean(ctx?.model?.id) &&
      ctx?.model?.id === resolved.model.id &&
      ctx?.model?.provider === resolved.model.provider;

    if (alreadyOnResolvedModel) {
      let thinkingChanged = false;
      if (
        resolvedDesiredThinking !== undefined &&
        activeThinkingBefore !== resolvedDesiredThinking &&
        typeof pi.setThinkingLevel === "function"
      ) {
        pi.setThinkingLevel(resolvedDesiredThinking);
        thinkingChanged = true;
      }
      return {
        applied: true,
        changed: thinkingChanged,
        model: formatHostModelId(resolved.model) ?? configuredModel,
        thinkingLevel: resolvedDesiredThinking ?? activeThinkingBefore,
      };
    }

    if (resolved.warning && ctx?.hasUI) {
      ctx.ui.notify(resolved.warning, "warning");
    }

    if (typeof pi.setModel !== "function") {
      return warn(
        `Host session does not support pi.setModel(); keeping current host model instead of "${configuredModel}".`,
      );
    }

    const ok = await pi.setModel(resolved.model);
    if (!ok) {
      return warn(
        `Could not activate Orchestrator model "${configuredModel}" (missing credentials or unavailable provider). Keeping current host model.`,
      );
    }

    if (typeof pi.setThinkingLevel === "function" && resolvedDesiredThinking !== undefined) {
      const thinkingAfterModelSet = getActiveThinkingLevel();
      if (thinkingAfterModelSet !== resolvedDesiredThinking) {
        pi.setThinkingLevel(resolvedDesiredThinking);
      }
    }

    return {
      applied: true,
      changed: true,
      model: formatHostModelId(resolved.model) ?? configuredModel,
      thinkingLevel: effectiveThinking,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return warn(
      `Failed to apply Orchestrator model "${configuredModel}": ${detail}. Keeping current host model.`,
    );
  }
}

// ============================================================================
// Helpers: Focus Persistence, Empty Snapshot, Proxy Delegation & Formatting
// ============================================================================

function createEmptySnapshot(
  settings: SwarmSettings = DEFAULT_SWARM_SETTINGS,
): SwarmSnapshot {
  return {
    run: null,
    activeRunId: null,
    workingMemberNames: [],
    waitingMemberNames: [],
    boardHead: 0,
    recentBoard: [],
    recentEvents: [],
    roleModels: buildRoleModelsFromSettings(settings),
    totalTokens: 0,
    totalCost: 0,
    updatedAt: new Date().toISOString(),
  };
}

interface RehydratedFocusState {
  hasEntry: boolean;
  runId: string | null;
  sessionId?: string;
  reason?: string;
  orchestratorMode?: boolean;
  autoConfirmDefault?: boolean;
}

function rehydrateFocusState(
  ctx: Pick<ExtensionContext, "sessionManager">,
): RehydratedFocusState {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "custom" || entry.customType !== SWARM_FOCUS_ENTRY) {
      continue;
    }
    const data = entry.data as Partial<SwarmFocusEntry> | undefined;
    if (!data || typeof data !== "object" || data.version !== SWARM_FOCUS_VERSION) {
      return { hasEntry: false, runId: null };
    }
    const runId =
      typeof data.runId === "string" && data.runId.trim().length > 0
        ? data.runId.trim()
        : null;
    const sessionId =
      typeof data.sessionId === "string" && data.sessionId.trim().length > 0
        ? data.sessionId.trim()
        : undefined;
    const reason =
      typeof data.reason === "string" && data.reason.trim().length > 0
        ? data.reason.trim()
        : undefined;
    return {
      hasEntry: true,
      runId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(typeof data.orchestratorMode === "boolean"
        ? { orchestratorMode: data.orchestratorMode }
        : {}),
      ...(typeof data.autoConfirmDefault === "boolean"
        ? { autoConfirmDefault: data.autoConfirmDefault }
        : {}),
    };
  }
  return { hasEntry: false, runId: null };
}

function persistFocusEntry(
  pi: Pick<ExtensionAPI, "appendEntry">,
  runId: string | null,
  sessionId: string,
  reason: string,
  options?: {
    orchestratorMode?: boolean;
    autoConfirmDefault?: boolean;
  },
): void {
  const payload: SwarmFocusEntry = {
    version: SWARM_FOCUS_VERSION,
    runId,
    sessionId,
    reason,
    ...(options?.orchestratorMode !== undefined
      ? { orchestratorMode: options.orchestratorMode }
      : {}),
    ...(options?.autoConfirmDefault !== undefined
      ? { autoConfirmDefault: options.autoConfirmDefault }
      : {}),
  };
  pi.appendEntry(SWARM_FOCUS_ENTRY, payload);
}

function getSessionIdSafe(ctx: ExtensionContext | undefined): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.trim().length > 0) {
      return id.trim();
    }
  } catch {
    // ignore
  }
  return "session-unknown";
}

function isTerminalRunStatus(status: SwarmRunStatus | undefined): boolean {
  return status === "completed" || status === "abandoned";
}

async function assertFocusedRunOwner(
  store: ISwarmStore,
  runId: string,
  ctx: ExtensionContext,
): Promise<void> {
  const sid = getSessionIdSafe(ctx);
  if (store.assertOwnerSession) {
    await store.assertOwnerSession(runId, sid);
  } else {
    assertOwnerSession(await store.loadRun(runId), sid);
  }
}

function formatError(err: unknown): string {
  if (isSwarmProtocolError(err)) {
    return `[${err.code}] ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function createDelegatingProxy<T extends object>(getTarget: () => T): T {
  return new Proxy({} as T, {
    get(_obj, prop, receiver) {
      const target = getTarget();
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(_obj, prop) {
      return prop in getTarget();
    },
    ownKeys() {
      return Reflect.ownKeys(getTarget());
    },
    getOwnPropertyDescriptor(_obj, prop) {
      return Object.getOwnPropertyDescriptor(getTarget(), prop);
    },
  });
}

function derivePlanMilestones(
  explicitMilestones: readonly SwarmMilestone[] | undefined,
  features: readonly MissionFeature[] | undefined,
  assertions: readonly MissionAssertion[] | undefined,
  priorMilestones?: readonly SwarmMilestone[],
  resetAssertionIds?: ReadonlySet<string>,
): SwarmMilestone[] | undefined {
  const hasExplicit = Boolean(explicitMilestones && explicitMilestones.length > 0);
  const hasFeatures = Boolean(features && features.length > 0);
  const hasPrior = Boolean(priorMilestones && priorMilestones.length > 0);
  if (!hasExplicit && !hasFeatures && !hasPrior) {
    return explicitMilestones ? [...explicitMilestones] : undefined;
  }

  const priorByLabel = new Map<string, SwarmMilestone>();
  for (const pm of priorMilestones ?? []) {
    if (pm.label.trim()) {
      priorByLabel.set(pm.label.trim(), pm);
    }
  }
  const explicitByLabel = new Map<string, SwarmMilestone>();
  const orderedLabels: string[] = [];
  const pushLabel = (rawLabel: string): void => {
    const clean = rawLabel.trim();
    if (clean && !orderedLabels.includes(clean)) {
      orderedLabels.push(clean);
    }
  };

  for (const m of explicitMilestones ?? []) {
    const clean = m.label.trim();
    if (clean) {
      explicitByLabel.set(clean, m);
      pushLabel(clean);
    }
  }
  for (const pm of priorMilestones ?? []) {
    const clean = pm.label.trim();
    if (!clean) continue;
    const stillHasFeatures = (features ?? []).some((f) => f.milestone.trim() === clean);
    if (pm.sealed || stillHasFeatures || !hasExplicit) {
      pushLabel(clean);
    }
  }
  for (const f of features ?? []) {
    pushLabel(f.milestone);
  }

  const assertionMap = new Map<string, MissionAssertion>();
  for (const a of assertions ?? []) {
    assertionMap.set(a.id, a);
  }

  return orderedLabels.map((label): SwarmMilestone => {
    const exp = explicitByLabel.get(label);
    const prev = priorByLabel.get(label);
    const milestoneFeatures = (features ?? []).filter((f) => f.milestone.trim() === label);
    const activeFeatures = milestoneFeatures.filter((f) => f.status !== "cancelled");

    const claimedIds = new Set<string>();
    for (const f of activeFeatures) {
      for (const aid of f.fulfills ?? []) {
        claimedIds.add(aid);
      }
    }
    const hadResetAssertion = Array.from(claimedIds).some((aid) =>
      resetAssertionIds?.has(aid),
    );
    const allClaimedPassed = Array.from(claimedIds).every(
      (aid) => assertionMap.get(aid)?.status === "passed",
    );
    const allFeaturesCompleted =
      activeFeatures.length > 0 &&
      activeFeatures.every((f) => f.status === "completed");
    const anyProgress = activeFeatures.some(
      (f) => f.status === "in_progress" || f.status === "completed",
    );

    if (hadResetAssertion) {
      return {
        label,
        status: "in_progress",
        ...(exp?.owner ?? prev?.owner ? { owner: exp?.owner ?? prev?.owner } : {}),
        sealed: false,
      };
    }

    const wasSealed = Boolean(prev?.sealed ?? exp?.sealed);
    if (
      wasSealed &&
      (activeFeatures.length === 0 || (allFeaturesCompleted && allClaimedPassed))
    ) {
      return {
        label,
        status: "done",
        ...(exp?.owner ?? prev?.owner ? { owner: exp?.owner ?? prev?.owner } : {}),
        sealed: true,
        ...(prev?.sealedAt ?? exp?.sealedAt
          ? { sealedAt: prev?.sealedAt ?? exp?.sealedAt }
          : {}),
      };
    }

    let status: SwarmMilestone["status"] =
      exp?.status ?? prev?.status ?? "pending";
    if (activeFeatures.length > 0) {
      if (allFeaturesCompleted && allClaimedPassed) {
        status = "done";
      } else if (exp?.status === "blocked") {
        status = "blocked";
      } else if (anyProgress || status === "done") {
        status = "in_progress";
      } else {
        status = exp?.status ?? "pending";
      }
    }

    return {
      label,
      status,
      ...(exp?.owner ?? prev?.owner ? { owner: exp?.owner ?? prev?.owner } : {}),
      ...(exp?.sealed !== undefined ? { sealed: exp.sealed } : {}),
      ...(exp?.sealedAt ? { sealedAt: exp.sealedAt } : {}),
    };
  });
}

export function buildLaunchKickoffPrompt(
  run: SwarmRunState,
  spawnedInitial: readonly SwarmMemberRecord[],
  failedInitial?: ReadonlyArray<{ name: string; error: string }>,
  feedback?: string,
): string {
  const lines: string[] = [
    `🐝 Dynamic Swarm "${run.title}" (\`${run.id}\`) is live on \`${run.baseBranch}\` (max concurrency: ${run.maxConcurrency}, Validator policy: ${run.validatorEnabled ? "ON" : "OFF"}).`,
    "",
    `- **Objective:** ${run.objective}`,
  ];
  if (run.strategy.trim()) {
    lines.push(`- **Strategy:** ${run.strategy.trim()}`);
  }
  if (run.acceptanceCriteria.trim()) {
    lines.push(`- **Acceptance Criteria:** ${run.acceptanceCriteria.trim()}`);
  }
  if (feedback && feedback.trim()) {
    lines.push(`- **User Confirmation Notes:** ${feedback.trim()}`);
  }

  const activeFeatures = (run.features ?? []).filter(
    (f) => f.status !== "cancelled",
  );
  const totalFeatures =
    activeFeatures.length > 0 ? activeFeatures.length : (run.features?.length ?? 0);
  const completedFeatures = activeFeatures.filter(
    (f) => f.status === "completed",
  ).length;
  const totalAssertions = run.assertions?.length ?? 0;
  const passedAssertions = (run.assertions ?? []).filter(
    (a) => a.status === "passed",
  ).length;
  const milestoneCount = run.milestones?.length ?? 0;

  if (totalFeatures > 0 || totalAssertions > 0) {
    const goalParts: string[] = [];
    if (totalFeatures > 0) {
      const doneTag =
        completedFeatures > 0 ? ` (${completedFeatures}/${totalFeatures} completed)` : "";
      const msTag =
        milestoneCount > 0 ? ` across ${milestoneCount} milestone(s)` : "";
      goalParts.push(`Features: ${totalFeatures}${doneTag}${msTag}`);
    }
    if (totalAssertions > 0) {
      const passTag =
        passedAssertions > 0 ? ` (${passedAssertions}/${totalAssertions} passed)` : "";
      goalParts.push(`Contract: ${totalAssertions} VAL-* assertions${passTag}`);
    }
    lines.push(`- **Mission Goal:** ${goalParts.join(" · ")}`);
  }
  if (run.commands && run.commands.length > 0) {
    const cmdSummary = run.commands
      .map((c) => `\`${c.name}\`: \`${c.command}\``)
      .join(" · ");
    lines.push(`- **Commands:** ${cmdSummary}`);
  }
  if (run.services && run.services.length > 0) {
    const svcSummary = run.services
      .map((s) => {
        const portTag = s.port !== undefined ? ` (:${s.port})` : "";
        const hcTag = s.healthcheck ? ` [health: \`${s.healthcheck}\`]` : "";
        return `\`${s.name}\`${portTag}: \`${s.start}\`${hcTag}`;
      })
      .join(" · ");
    lines.push(`- **Services:** ${svcSummary}`);
  }
  if (run.boundaries && run.boundaries.length > 0) {
    lines.push(`- **Boundaries:** ${run.boundaries.join("; ")}`);
  }

  lines.push("");
  if (spawnedInitial.length > 0) {
    lines.push("Initial members already spawned and working:");
    for (const m of spawnedInitial) {
      const seqPart = m.briefSeq ? ` (brief #${m.briefSeq})` : "";
      const wsPart = m.branch ? `${m.workspace}:${m.branch}` : m.workspace;
      lines.push(`- \`@${m.name}\` (${m.role}, \`${wsPart}\`)${seqPart}`);
    }
    if (failedInitial && failedInitial.length > 0) {
      lines.push("", "Warning: the following initial member(s) failed to spawn during startup:");
      for (const f of failedInitial) {
        lines.push(`- \`@${f.name}\`: ${f.error}`);
      }
      lines.push('Inspect and re-add or adjust failed members via `swarm{action:"add"}`.');
    }
    const validatorStep =
      run.validatorEnabled !== false ? "validate independently, " : "";
    lines.push(
      "",
      `Coordinate dynamically via \`swarm\`, \`post_message\`, \`read_board\`, and \`swarm_wait\`. Call \`swarm_wait{since: ${run.boardHead}}\` to end your turn cleanly and sleep (non-blocking) while waiting — you'll wake automatically on board messages, \`all_idle\`, or any user redirection. Adjust members mid-flight via \`swarm{action:"steer"|"stop"|"model"|"add"|"mission"}\`, ${validatorStep}merge worktrees/clones, kill finished helpers, and call \`swarm{action:"done", summary}\` when complete.`,
    );
  } else {
    const workflowHint =
      run.validatorEnabled !== false
        ? "researchers/scouts -> scaffold -> parallel `share` authors -> independent read-only `validator`"
        : "researchers/scouts -> scaffold -> parallel `share` authors";
    lines.push(
      `You now have the 4 core Swarm tools (\`swarm\`, \`post_message\`, \`read_board\`, \`swarm_wait\`). Begin Phase 1 by delegating technical work via \`swarm{action:"add"}\` (${workflowHint}), wait via \`swarm_wait\`, merge & kill finished members, and call \`swarm{action:"done", summary}\` when complete.`,
    );
  }

  return lines.join("\n");
}

const buildRunKickoffMessage = buildLaunchKickoffPrompt;

function buildMissionResumePrompt(
  run: SwarmRunState,
  guidance?: string,
  recentBoard?: readonly BoardMessage[],
): string {
  const members = getOrderedMembers(run).filter((m) => m.state !== "killed");
  const lines: string[] = [
    `<swarm_mission_resumed run_id="${escapeXml(run.id)}" status="${escapeXml(run.status)}" base_branch="${escapeXml(run.baseBranch)}" board_head="${run.boardHead}">`,
    `🐝 **Swarm Mission Resumed:** "${run.title}" (\`${run.id}\`) on \`${run.baseBranch}\` (Validator policy: ${run.validatorEnabled ? "ON" : "OFF"}).`,
    "",
    `- **Objective:** ${run.objective}`,
  ];
  if (run.strategy.trim()) {
    lines.push(`- **Strategy:** ${run.strategy.trim()}`);
  }
  if (run.acceptanceCriteria.trim()) {
    lines.push(`- **Acceptance Criteria:** ${run.acceptanceCriteria.trim()}`);
  }
  if (run.features?.length || run.assertions?.length) {
    const activeFeats = (run.features ?? []).filter((f) => f.status !== "cancelled");
    const doneFeats = activeFeats.filter((f) => f.status === "completed").length;
    const passedVals = (run.assertions ?? []).filter((a) => a.status === "passed").length;
    const parts: string[] = [];
    if (run.features?.length) {
      parts.push(`Features: ${doneFeats}/${activeFeats.length || run.features.length} completed`);
    }
    if (run.assertions?.length) {
      parts.push(`Contract: ${passedVals}/${run.assertions.length} VAL-* assertions passed`);
    }
    lines.push(`- **Mission Goal:** ${parts.join(" · ")}`);
  }
  if (guidance?.trim()) {
    lines.push(`- **User Resume Guidance:** ${guidance.trim()}`);
  }
  if (members.length > 0) {
    lines.push("", "**Active / Resumable Members:**");
    for (const m of members.slice(0, 16)) {
      const wsPart = m.branch ? `${m.workspace}:${m.branch}` : m.workspace;
      const modelPart = m.model ? ` model=${m.model}${m.thinkingLevel ? `:${m.thinkingLevel}` : ""}` : "";
      lines.push(`- \`@${m.name}\` (${m.role}, \`${wsPart}\`, state=${m.state}${modelPart})`);
    }
    if (members.length > 16) {
      lines.push(`- … +${members.length - 16} more member(s)`);
    }
  } else {
    lines.push("", "**Members:** none currently active (`0` non-killed members).");
  }
  if (recentBoard && recentBoard.length > 0) {
    lines.push("", "**Recent Message Board Tail:**");
    for (const msg of recentBoard.slice(-8)) {
      const targets = [
        ...msg.mentions.map((m) => `@${m}`),
        ...msg.channelMentions.map((c) => `#${c}`),
      ];
      const targetStr = targets.length > 0 ? ` -> ${targets.join(", ")}` : "";
      const preview = sanitizePlainText(msg.text).replace(/\s+/g, " ").trim().slice(0, 220);
      lines.push(`- \`#${msg.seq}\` [${msg.channel}] \`@${msg.from}\`${targetStr}: ${preview}`);
    }
  }
  lines.push(
    "",
    "Resume Mission coordination from the persisted board & git state:",
    `1. Inspect recent board context via \`read_board{since: ${Math.max(0, run.boardHead - 20)}}\` (or inspect \`#tasks\` / \`git status\`) to see what is completed, parked, or unmerged.`,
    '2. Wake parked/stopped members with `post_message` (mention `@<name>` in `text`), spawn any remaining work via `swarm{action:"add"}`, merge verified `share`/`branch` worktrees, and call `swarm{action:"done", summary}` once verified.',
    "</swarm_mission_resumed>",
  );
  return lines.join("\n");
}

function buildHelpMarkdown(): string {
  return [
    "### 🐝 Pi Swarm v0.9.0 (`/swarm`) — Dynamic Mission Goal Engine & Antigravity Swarm Commands",
    "",
    "| Command | Description |",
    "| --- | --- |",
    "| `/swarm` | Open Droid-style Mission Hub (with `🔄 Resume Mission` when unfinished, quick policy toggles `Alt+V`/`Alt++`/`Alt+-`, or active-run goal composer) or status menu |",
    "| `/swarm [flags] [--] <goal>` | Interactive upfront Q&A → Mission-Level TDD (`VAL-*` contract + feature queue) confirmation (`[m]` models, `[c]` comment). Flags: `--no-validator`, `--validator`, `--concurrency\\|-c <1..64>`, `--branch\\|-b <name>`, `--fast\\|--no-review`, `--file\\|-f <path>`, `@<path>` spec tokens, `--` literal escape |",
    "| `/swarm direct [flags] [--] <goal>` · `/swarm-direct [flags] [--] <goal>` | Fast-path: skip Q&A, propose plan with auto-confirm, and launch Dynamic Swarm immediately (supports the same launch flags & `@<path>` spec files) |",
    "| `/swarm tweak [guidance]` | Dynamically revise the focused Mission plan, `VAL-*` assertions, features, or add members in place |",
    "| `/swarm status` · `/swarm contract` · `/swarm mission` | Zero-LLM-turn dashboard: Mission Features, `VAL-*` Validation Contract, handoffs, 3-role models & roster (also `/swarm goal`) |",
    "| `/swarm board [limit] [--channel <ch>] [--search <q>]` | Zero-LLM-turn shared `#seq` Message Board feed (filterable by channel or substring) |",
    "| `/swarm graph` | Zero-LLM-turn ASCII/Unicode Spawn Tree & Peer `@mention` / `#channel` interaction graph |",
    "| `/swarm tasks [tab\\|member\\|#ch]` · `/swarm ui` · `/swarm mc` | Open interactive 4-tab Mission Control (`[M]` models, `[P]` pause/resume, `[v]` contract/graph, `[?]` help; aliases: `mc`, `open`, `panel`) |",
    "| `/swarm models [role\\|--print]` | Open interactive Mission Model Picker (`Orchestrator` / `Worker` / `Validator` / `Fallbacks`), or `--print` overview |",
    "| `/swarm model <target> <model[:thinking]\\|default> [thinking] [--global]` | Set role default (propagates to live members) OR hot-switch a live member (`@name`) |",
    "| `/swarm steer <member> <message>` | Redirect a working member immediately or wake a parked member with new direction |",
    "| `/swarm stop <member> [reason]` | Stop a working member cleanly without deleting its worktree or conversation history |",
    "| `/swarm merge <member>` | Merge a member's `share` worktree or `branch` clone onto `baseBranch` (`autoRebase` + `--no-ff`) |",
    "| `/swarm kill <member> [--force] [reason]` | Permanently kill a member and remove its clean worktree (`--force` overrides dirty worktree guard) |",
    "| `/swarm done [--force] [summary]` | Complete the active Swarm run, retire ephemeral workers/validators, and keep `@orchestrator` on standby (`--force` force-closes unfinished Mission gates) |",
    "| `/swarm exit [--force]` · `/swarm leave [--force]` | Exit Persistent Swarm Orchestrator Mode, restoring `idle` tools, pre-swarm host model & direct editing (`--force` pauses & detaches a live run cleanly so it stays resumable) |",
    "| `/swarm pause [reason]` | Pause member launches & board wakeups |",
    "| `/swarm resume [run-id] [--continue\\|-c] [--quiet\\|-q] [guidance]` | Zero-turn unpause (focused same-session) OR Droid-style cross-session Mission resume |",
    "| `/swarm cancel` | Cancel active draft (restores underlying running/standby/idle state) or abandon focused live run (exits Orchestrator Mode) |",
    "| `/swarm teardown [--force] [--delete-branches]` | Safely remove clean idle worktrees while preserving `.pi/swarm/runs/` audit & board history |",
    "| `/swarm runs` · `/swarm ls` · `/swarm list` | List all runs stored in `.pi/swarm/runs/` |",
    "| `/swarm focus [run-id\\|none]` | Switch session-local run focus (`none` detaches focus & exits Orchestrator Mode) |",
    "| `/swarm settings` · `/swarm config` | Configure Mission Models, warm pool, smart LLM monitor, concurrency & git settings |",
    "| `/swarm help` | Print this command reference (zero LLM turn) |",
    "",
    "**Persistent Orchestrator Mode & Manual Git Commands:** Launching a Swarm run as owner (`/swarm <goal>`, `/swarm direct <goal>`, `/swarm-direct <goal>`) or resuming one (`/swarm resume`) keeps `@orchestrator` on duty in `standby` across subsequent coding tasks until you run `/swarm exit` (or Hub `Exit Swarm Orchestrator Mode`). While active, `write`, `edit`, and `powershell` are blocked and mutating `bash` commands are filtered by best-effort pattern matching (to prevent habitual direct edits, not as a sandbox); run manual git operations (`git push`, manual `git commit`) via `!<command>` (e.g. `!git push`) or exit first with `/swarm exit`.",
    "**Mid-Flight Redirection & Goal Continuation:** Type any message directly to the Orchestrator while workers run to adjust scope (`swarm{action:\"mission\"}`), or run `/swarm steer <member> <msg>`. Active Goal runs auto-continue until all features & `VAL-*` assertions pass (or `[NEEDS_HUMAN]` is raised).",
    "**TUI Shortcuts:** `Alt+S` / `Ctrl+Shift+S` opens Mission Control / Hub · `Alt+M` / `Ctrl+Shift+M` opens Mission Model Picker · `Alt+W` / `Ctrl+Shift+T` toggles expanded above-editor dashboard · `Esc` collapses expanded dashboard.",
  ].join("\n");
}

function extractCustomMessageText(
  content: CustomMessageEntryDraft["content"] | unknown,
): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
              typeof part === "object" &&
              (part as { type?: string }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string",
          ),
      )
      .map((part) => part.text)
      .join("\n");
  }
  return String(content ?? "");
}

function stripSwarmWakeupXml(raw: string): string {
  return raw
    .replace(/^\s*<swarm_mission_resumed\b[^>]*>\r?\n?/gim, "")
    .replace(/\r?\n?\s*<\/swarm_mission_resumed>\s*$/gim, "")
    .replace(/<\/?swarm_mission_resumed\b[^>]*>/gi, "")
    .trim();
}

function stripInlineMarkdownSyntax(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

function styleInlineMarkdownLine(
  text: string,
  fg: (color: ThemeColor, value: string) => string,
  bold: (value: string) => string,
): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => bold(inner))
    .replace(/`([^`\n]+)`/g, (_m, code: string) => fg("accent", code));
}

function clampPreviewText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const normalized = sanitizePlainText(stripInlineMarkdownSyntax(text));
  if (normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`,
    truncated: true,
  };
}

const execFileAsync = promisify(execFile);

function resolveSwarmMarkdownTheme(
  theme: Partial<Theme> | undefined,
): MarkdownTheme | undefined {
  try {
    if (typeof getMarkdownTheme === "function") {
      const nativeTheme = getMarkdownTheme();
      if (nativeTheme && typeof nativeTheme.heading === "function") {
        // Probe lazily-bound global Pi theme so headless mocks without initTheme() fall back cleanly.
        nativeTheme.heading("x");
        return nativeTheme;
      }
    }
  } catch {
    // Fall through to theme adapter below.
  }

  if (!theme) {
    return undefined;
  }

  const fg = (color: ThemeColor, value: string): string =>
    typeof theme.fg === "function" ? theme.fg(color, value) : value;
  const bold = (value: string): string =>
    typeof theme.bold === "function" ? theme.bold(value) : value;
  const italic = (value: string): string =>
    typeof theme.italic === "function" ? theme.italic(value) : value;
  const underline = (value: string): string =>
    typeof theme.underline === "function" ? theme.underline(value) : value;
  const strikethrough = (value: string): string =>
    typeof theme.strikethrough === "function" ? theme.strikethrough(value) : value;

  return {
    heading: (t) => fg("mdHeading", bold(t)),
    link: (t) => fg("mdLink", t),
    linkUrl: (t) => fg("mdLinkUrl", t),
    code: (t) => fg("mdCode", t),
    codeBlock: (t) => fg("mdCodeBlock", t),
    codeBlockBorder: (t) => fg("mdCodeBlockBorder", t),
    quote: (t) => fg("mdQuote", t),
    quoteBorder: (t) => fg("mdQuoteBorder", t),
    hr: (t) => fg("mdHr", t),
    listBullet: (t) => fg("mdListBullet", t),
    bold,
    italic,
    underline,
    strikethrough,
  };
}

function createSwarmMarkdownComponent(
  markdownText: string,
  padX: number,
  theme: Partial<Theme> | undefined,
  bgFn: ((line: string) => string) | undefined,
  headerLine?: string,
): Component | undefined {
  if (typeof Markdown !== "function") {
    return undefined;
  }
  const mdTheme = resolveSwarmMarkdownTheme(theme);
  if (!mdTheme) {
    return undefined;
  }
  try {
    const defaultTextStyle =
      typeof theme?.fg === "function"
        ? { color: (t: string) => theme.fg!("customMessageText", t) }
        : undefined;
    if (typeof Box === "function") {
      const box = new Box(padX, 0, bgFn);
      if (headerLine) {
        box.addChild(new Text(headerLine, 0, 0));
      }
      if (markdownText.trim().length > 0) {
        box.addChild(new Markdown(markdownText, 0, 0, mdTheme, defaultTextStyle));
      }
      return box;
    }
    const combined = headerLine ? `${headerLine}\n${markdownText}` : markdownText;
    return new Markdown(combined, padX, 0, mdTheme, defaultTextStyle);
  } catch {
    return undefined;
  }
}

function renderSwarmWakeupMessage(
  message: { content: unknown; details?: unknown },
  options: Partial<MessageRenderOptions> | undefined,
  theme: Partial<Theme> | undefined,
): Component {
  const fg = (color: ThemeColor, value: string): string =>
    typeof theme?.fg === "function" ? theme.fg(color, value) : value;
  const bold = (value: string): string =>
    typeof theme?.bold === "function" ? theme.bold(value) : value;
  const bgFn =
    typeof theme?.bg === "function"
      ? (line: string) => theme.bg!("customMessageBg", line)
      : undefined;
  const padX = typeof options?.outputPad === "number" ? options.outputPad : 1;

  const cleaned = stripSwarmWakeupXml(extractCustomMessageText(message.content));
  const rawLines = cleaned.split(/\r?\n/);
  const nonEmptyLines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  const firstRaw = nonEmptyLines[0] ?? "Pi Swarm Mission Event";
  const details = (message.details ?? {}) as {
    kickoff?: boolean;
    stallDetected?: boolean;
    goalCheckpoint?: boolean;
  };

  const isStall = Boolean(details.stallDetected) || /stall alert/i.test(firstRaw);
  const isResumed = /mission resumed/i.test(firstRaw);
  const isGoalCheckpoint =
    Boolean(details.goalCheckpoint) || /goal checkpoint/i.test(firstRaw);
  const isLiveKickoff = Boolean(details.kickoff) || /\bis live on\b/i.test(firstRaw);

  const badgeLabel = isStall
    ? "🐝 [SWARM STALL]"
    : isResumed
      ? "🐝 [MISSION RESUMED]"
      : isGoalCheckpoint
        ? "🎯 [GOAL CHECKPOINT]"
        : isLiveKickoff
          ? "🐝 [MISSION LIVE]"
          : "🐝 [MISSION EVENT]";
  const badgeColor: ThemeColor = isStall
    ? "warning"
    : isLiveKickoff
      ? "success"
      : "accent";
  const badge = fg(badgeColor, bold(badgeLabel));

  const cleanTitleSource = firstRaw
    .replace(/^(?:🐝|🎯)\s*/, "")
    .replace(/^\*\*Swarm Mission Resumed:\*\*\s*/i, "")
    .replace(/^Swarm Mission Resumed:\s*/i, "")
    .trim();

  if (options?.expanded) {
    const headerLine = `${badge} ${styleInlineMarkdownLine(cleanTitleSource, fg, bold)}`;
    const firstIdx = rawLines.findIndex((l) => l.trim().length > 0);
    const bodyRawLines = firstIdx >= 0 ? rawLines.slice(firstIdx + 1) : [];
    const bodyMarkdown = bodyRawLines.join("\n").trim();
    const mdComp = createSwarmMarkdownComponent(
      bodyMarkdown,
      padX,
      theme,
      bgFn,
      headerLine,
    );
    if (mdComp) {
      return mdComp;
    }

    const expandedLines: string[] = [headerLine];
    for (const line of bodyRawLines) {
      if (!line.trim()) {
        expandedLines.push("");
        continue;
      }
      expandedLines.push(
        fg("customMessageText", styleInlineMarkdownLine(line, fg, bold)),
      );
    }
    return new Text(expandedLines.join("\n"), padX, 0, bgFn);
  }

  const titleClamped = clampPreviewText(cleanTitleSource, 50);
  const tailLines = nonEmptyLines.slice(1);
  const bulletCandidates = tailLines.filter((l) => /^[-*•]\s+/.test(l));
  const statusLine = tailLines.find((l) => /^Run status:/i.test(l));
  const rawHighlights: string[] = [];

  for (const b of bulletCandidates) {
    rawHighlights.push(b.replace(/^[-*•]\s+/, ""));
  }
  if (rawHighlights.length < 2 && statusLine) {
    rawHighlights.push(statusLine);
  }
  if (rawHighlights.length === 0) {
    for (const line of tailLines) {
      if (/^(Board messages:|Resume Mission coordination|Initial members)/i.test(line)) {
        continue;
      }
      rawHighlights.push(line);
      if (rawHighlights.length >= 2) break;
    }
  }

  const hasExtraContent =
    titleClamped.truncated ||
    tailLines.length > rawHighlights.length ||
    rawHighlights.length > 3;

  const maxHighlights = hasExtraContent ? 2 : 3;
  const chosen = rawHighlights.slice(0, maxHighlights);
  let anyHighlightClamped = false;
  const formattedHighlights = chosen.map((item) => {
    const clamped = clampPreviewText(item, 66);
    if (clamped.truncated) {
      anyHighlightClamped = true;
    }
    return `  ${fg(badgeColor, "•")} ${fg("customMessageText", clamped.text)}`;
  });

  const isTruncated =
    hasExtraContent ||
    anyHighlightClamped ||
    rawHighlights.length > chosen.length;

  const cardLines: string[] = [
    `${badge} ${bold(fg("customMessageText", titleClamped.text))}`,
  ];
  if (formattedHighlights.length > 0) {
    cardLines.push(...formattedHighlights);
  } else if (!isTruncated) {
    cardLines.push(`  ${fg("dim", "• Mission event synced")}`);
  }
  if (isTruncated) {
    // Guarantee 2–4 total lines: 1 title + (1..2 highlights) + 1 expand hint <= 4 lines
    while (cardLines.length > 3) {
      cardLines.pop();
    }
    const rawKeyHint =
      typeof options?.keyHint === "function"
        ? options.keyHint("app.tools.expand", "to expand")
        : undefined;
    const expandHint = rawKeyHint?.trim()
      ? rawKeyHint
      : fg("dim", "(Ctrl+O to expand)");
    cardLines.push(`  ${expandHint}`);
  }

  return new Text(cardLines.join("\n"), padX, 0, bgFn);
}

function renderSwarmStatusMessage(
  message: { content: unknown },
  options: Partial<MessageRenderOptions> | undefined,
  theme: Partial<Theme> | undefined,
): Component {
  const fg = (color: ThemeColor, value: string): string =>
    typeof theme?.fg === "function" ? theme.fg(color, value) : value;
  const bold = (value: string): string =>
    typeof theme?.bold === "function" ? theme.bold(value) : value;
  const bgFn =
    typeof theme?.bg === "function"
      ? (line: string) => theme.bg!("customMessageBg", line)
      : undefined;
  const padX = typeof options?.outputPad === "number" ? options.outputPad : 1;

  const raw = stripSwarmWakeupXml(extractCustomMessageText(message.content));
  const lines = raw.split(/\r?\n/);
  if (lines.length <= 1) {
    const single = lines[0]?.trim() ?? "";
    const prefix = single.startsWith("🐝") ? "" : `${fg("accent", bold("🐝"))} `;
    const styled = `${prefix}${fg("customMessageText", styleInlineMarkdownLine(single, fg, bold))}`;
    return new Text(styled, padX, 0, bgFn);
  }

  const mdComp = createSwarmMarkdownComponent(raw, padX, theme, bgFn);
  if (mdComp) {
    return mdComp;
  }

  const styledLines = lines.map((line) => {
    if (/^#{1,4}\s+/.test(line)) {
      const heading = line.replace(/^#{1,4}\s+/, "");
      return fg("accent", bold(stripInlineMarkdownSyntax(heading)));
    }
    return fg("customMessageText", styleInlineMarkdownLine(line, fg, bold));
  });
  return new Text(styledLines.join("\n"), padX, 0, bgFn);
}

interface RemainingWorktreeInfo {
  memberName: string;
  branch: string;
  worktreePath: string;
  merged: boolean;
  dirty: boolean;
}

function formatMissionDuration(startIso: string, endMs: number): string {
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs) || endMs <= startMs) {
    return "<1s";
  }
  const totalSec = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) {
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function formatMissionTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(tokens));
}

function formatMissionCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) {
    return "$0.00";
  }
  if (cost >= 0.01) {
    return `$${cost.toFixed(2)}`;
  }
  return `$${cost.toFixed(4)}`;
}

async function inspectRemainingWorktrees(
  run: SwarmRunState,
  store: ISwarmStore | undefined,
  worktree: IWorktreeManager | undefined,
): Promise<{
  remaining: RemainingWorktreeInfo[];
  cleanMerged: RemainingWorktreeInfo[];
}> {
  const remaining: RemainingWorktreeInfo[] = [];
  const cleanMerged: RemainingWorktreeInfo[] = [];
  for (const member of getOrderedMembers(run)) {
    if (member.workspace === "inherit" || !member.branch) {
      continue;
    }
    const wtPath =
      member.cwd || (store ? store.getWorktreePath(run.id, member.name) : "");
    if (!wtPath) {
      continue;
    }
    let exists = false;
    try {
      await access(wtPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      continue;
    }
    const merged = Boolean(member.mergedCommitSha);
    let dirty = false;
    if (worktree) {
      dirty = await worktree.isWorktreeDirty(wtPath).catch(() => true);
    }
    const info: RemainingWorktreeInfo = {
      memberName: member.name,
      branch: member.branch,
      worktreePath: wtPath,
      merged,
      dirty,
    };
    remaining.push(info);
    if (merged && !dirty) {
      cleanMerged.push(info);
    }
  }
  return { remaining, cleanMerged };
}

async function computeMergedGitDiffStat(
  cwd: string | undefined,
  run: SwarmRunState,
): Promise<string | undefined> {
  if (!cwd) {
    return undefined;
  }
  const mergedMembers = getOrderedMembers(run).filter(
    (m) => Boolean(m.mergedCommitSha),
  );
  if (mergedMembers.length === 0) {
    return undefined;
  }

  const runGit = async (args: string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 4_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
      });
      const trimmed = stdout.trim();
      return trimmed || undefined;
    } catch {
      return undefined;
    }
  };

  const shas = Array.from(
    new Set(
      mergedMembers
        .map((m) => m.mergedCommitSha?.trim())
        .filter((s): s is string => Boolean(s)),
    ),
  );
  if (shas.length === 0) {
    return undefined;
  }

  let stat: string | undefined;
  if (shas.length === 1) {
    stat = await runGit(["diff", "--stat", `${shas[0]!}~1`, shas[0]!]);
  } else {
    stat = await runGit([
      "diff",
      "--stat",
      `${shas[0]!}~1`,
      shas[shas.length - 1]!,
    ]);
    if (!stat) {
      const chunks: string[] = [];
      for (const sha of shas.slice(0, 6)) {
        const part = await runGit(["diff", "--stat", `${sha}~1`, sha]);
        if (part) {
          chunks.push(part);
        }
      }
      stat = chunks.join("\n");
    }
  }
  if (!stat) {
    return undefined;
  }
  const lines = stat.split(/\r?\n/);
  if (lines.length <= 12) {
    return stat;
  }
  const summaryLine = lines[lines.length - 1]!;
  const headLines = lines.slice(0, 10);
  const omitted = lines.length - 11;
  return [...headLines, `… (+${omitted} more file line(s))`, summaryLine].join("\n");
}

function extractValidatorVerdict(
  run: SwarmRunState,
  boardMessages: readonly BoardMessage[],
): string {
  const validators = getOrderedMembers(run).filter((m) => m.role === "validator");
  if (validators.length === 0) {
    return run.validatorEnabled
      ? "Enabled (no validator spawned)"
      : "Disabled";
  }

  const validatorNames = new Set(validators.map((v) => v.name.toLowerCase()));
  const validatorPosts = boardMessages.filter(
    (msg) =>
      msg.fromRole === "validator" ||
      validatorNames.has(msg.from.toLowerCase()),
  );
  const donePosts = validatorPosts.filter((m) => m.kind === "done");
  const latestPost =
    donePosts[donePosts.length - 1] ?? validatorPosts[validatorPosts.length - 1];

  if (!latestPost) {
    const states = validators.map((v) => `\`@${v.name}\` (${v.state})`).join(", ");
    return `No verdict posted (${states})`;
  }

  const preview = sanitizePlainText(latestPost.text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const isPass = /\b(pass|passed|approved|lgtm|verified)\b/i.test(preview);
  const isFail = /\b(fail|failed|rejected|blocked|changes requested)\b/i.test(preview);
  const icon = isFail && !isPass ? "❌ FAIL" : isPass ? "✅ PASS" : "ℹ️ Reported";
  return `${icon} — \`@${latestPost.from}\` (#${latestPost.seq}): ${preview}`;
}

function buildMissionCompletionCard(
  run: SwarmRunState,
  options: {
    summary: string;
    nowMs: number;
    boardMessages: readonly BoardMessage[];
    diffStat?: string;
    remainingWorktrees: readonly RemainingWorktreeInfo[];
    teardownResult?: SafeTeardownResult;
    libraryTopics?: readonly string[];
    initiatedBy: "tool" | "command" | "event";
  },
): string {
  const title = sanitizePlainText(run.title || run.objective || run.id);
  const objective = sanitizePlainText(run.objective || title);
  const summary = sanitizePlainText(
    options.summary || run.completionSummary || "Mission completed",
  );
  const parsedEnd = Date.parse(run.updatedAt);
  const endMs =
    Number.isFinite(parsedEnd) && parsedEnd >= Date.parse(run.createdAt)
      ? Math.max(parsedEnd, options.nowMs)
      : options.nowMs;
  const duration = formatMissionDuration(run.createdAt, endMs);

  const members = getOrderedMembers(run);
  const totalTokens = members.reduce((sum, m) => sum + (m.tokens || 0), 0);
  const totalCost = members.reduce((sum, m) => sum + (m.cost || 0), 0);

  const mergedMembers = members.filter((m) => Boolean(m.mergedCommitSha));
  const unmergedIsolated = members.filter(
    (m) => m.workspace !== "inherit" && Boolean(m.branch) && !m.mergedCommitSha,
  );
  const validatorVerdict = extractValidatorVerdict(run, options.boardMessages);

  const lines: string[] = [
    `### 🐝 Mission Complete — ${title} (\`${run.id}\`)`,
    "",
    `- **Objective:** ${objective}`,
    `- **Summary:** ${summary}`,
    `- **Duration:** ${duration} · **Members:** ${members.length} · **Usage:** ${formatMissionTokens(totalTokens)} tok (${formatMissionCost(totalCost)})`,
    `- **Validator:** ${validatorVerdict}`,
  ];

  if (run.assertions && run.assertions.length > 0) {
    const totalVal = run.assertions.length;
    const passedVal = run.assertions.filter((a) => a.status === "passed").length;
    const failedVal = run.assertions.filter((a) => a.status === "failed").length;
    const blockedVal = run.assertions.filter((a) => a.status === "blocked").length;
    const pendingVal = totalVal - passedVal - failedVal - blockedVal;
    const overriddenAssertions = run.assertions.filter(
      (a) => a.overridden === true,
    );
    const overriddenVal = overriddenAssertions.length;
    const valIcon =
      passedVal === totalVal ? "✅" : failedVal > 0 ? "⚠️" : "ℹ️";
    const extraParts: string[] = [];
    if (overriddenVal > 0) extraParts.push(`${overriddenVal} overridden`);
    if (failedVal > 0) extraParts.push(`${failedVal} failed`);
    if (blockedVal > 0) extraParts.push(`${blockedVal} blocked`);
    if (pendingVal > 0) extraParts.push(`${pendingVal} pending`);
    const extraSuffix =
      extraParts.length > 0 ? ` (${extraParts.join(", ")})` : "";
    const idPreview = run.assertions
      .slice(0, 6)
      .map((a) =>
        a.overridden
          ? `\`${sanitizePlainText(a.id)}\` [OVERRIDE]`
          : `\`${sanitizePlainText(a.id)}\``,
      )
      .join(", ");
    const idMore =
      run.assertions.length > 6 ? `, … +${run.assertions.length - 6} more` : "";
    lines.push(
      `- **Validation Contract:** ${valIcon} ${passedVal}/${totalVal} VAL-* passed${extraSuffix} (${idPreview}${idMore})`,
    );
    if (overriddenVal > 0) {
      const overrideDetails = overriddenAssertions
        .slice(0, 4)
        .map((a) => {
          const just = sanitizePlainText(
            a.overrideJustification || a.evidence || "audited exception",
          )
            .replace(/^\[OVERRIDE\]\s*/i, "")
            .slice(0, 96);
          return `\`${sanitizePlainText(a.id)}\` [OVERRIDE] (${just})`;
        })
        .join("; ");
      const overrideMore =
        overriddenAssertions.length > 4
          ? `; … +${overriddenAssertions.length - 4} more`
          : "";
      lines.push(
        `- **⚠️ Audited Overrides:** ${overriddenVal} overridden — ${overrideDetails}${overrideMore}`,
      );
    }
  }

  if (run.features && run.features.length > 0) {
    const nonCancelled = run.features.filter((f) => f.status !== "cancelled");
    const cancelledCount = run.features.length - nonCancelled.length;
    const denom = nonCancelled.length > 0 ? nonCancelled.length : run.features.length;
    const completedCount = nonCancelled.filter(
      (f) => f.status === "completed",
    ).length;
    const featIcon = completedCount === denom && denom > 0 ? "✅" : "ℹ️";
    const cancelledSuffix =
      cancelledCount > 0 ? ` (${cancelledCount} cancelled)` : "";
    const featPreview = run.features
      .slice(0, 6)
      .map((f) => `\`${sanitizePlainText(f.id)}\``)
      .join(", ");
    const featMore =
      run.features.length > 6 ? `, … +${run.features.length - 6} more` : "";
    lines.push(
      `- **Features:** ${featIcon} ${completedCount}/${denom} completed${cancelledSuffix} (${featPreview}${featMore})`,
    );
  }

  if (run.milestones && run.milestones.length > 0) {
    const totalMs = run.milestones.length;
    const doneMs = run.milestones.filter((m) => m.status === "done").length;
    const sealedMs = run.milestones.filter((m) => m.sealed === true).length;
    const msBadges = run.milestones
      .map((m) => {
        const safeLabel = sanitizePlainText(m.label);
        return m.sealed ? `\`${safeLabel}\` [sealed]` : `\`${safeLabel}\` [${m.status}]`;
      })
      .join(", ");
    lines.push(
      `- **Sealed Milestones:** ${sealedMs}/${totalMs} sealed (${doneMs}/${totalMs} done) — ${msBadges}`,
    );
  }

  if (run.handoffItems && run.handoffItems.length > 0) {
    const totalHandoffs = run.handoffItems.length;
    const trackedCount = run.handoffItems.filter(
      (h) => h.resolution === "tracked",
    ).length;
    const dismissedCount = run.handoffItems.filter(
      (h) => h.resolution === "dismissed",
    ).length;
    const openCount = run.handoffItems.filter(
      (h) => h.resolution === "open",
    ).length;
    const resolvedCount = trackedCount + dismissedCount;
    const openSuffix = openCount > 0 ? `, ⚠️ ${openCount} open` : "";
    lines.push(
      `- **Tech-Debt Handoffs:** ${resolvedCount}/${totalHandoffs} resolved (${trackedCount} tracked, ${dismissedCount} dismissed${openSuffix})`,
    );
  }

  if (run.services && run.services.length > 0) {
    const svcPreview = run.services
      .slice(0, 6)
      .map((s) =>
        s.port !== undefined
          ? `\`${sanitizePlainText(s.name)}\` (:${s.port})`
          : `\`${sanitizePlainText(s.name)}\``,
      )
      .join(", ");
    const svcMore =
      run.services.length > 6 ? `, … +${run.services.length - 6} more` : "";
    lines.push(
      `- **Services:** ${run.services.length} configured (${svcPreview}${svcMore})`,
    );
  }

  if (options.libraryTopics && options.libraryTopics.length > 0) {
    const libraryRelPath = `${SWARM_DIR}/${SWARM_RUNS_DIR}/${run.id}/${SWARM_LIBRARY_DIR}/`;
    const topicPreview = options.libraryTopics
      .slice(0, 6)
      .map((t) => `\`${sanitizePlainText(t)}.md\``)
      .join(", ");
    const topicMore =
      options.libraryTopics.length > 6
        ? `, … +${options.libraryTopics.length - 6} more`
        : "";
    lines.push(
      `- **Shared Library:** \`${libraryRelPath}\` (${options.libraryTopics.length} topic(s): ${topicPreview}${topicMore})`,
    );
  }

  if (mergedMembers.length > 0) {
    const mergedList = mergedMembers
      .map((m) => {
        const shortSha = (m.mergedCommitSha ?? "").slice(0, 8);
        const branchPart = m.branch ? `\`${m.branch}\` → ` : "";
        return `\`@${m.name}\` (${branchPart}\`${shortSha}\`)`;
      })
      .join(", ");
    lines.push(`- **Merged into \`${run.baseBranch}\`:** ${mergedList}`);
  } else {
    lines.push(`- **Merged into \`${run.baseBranch}\`:** none`);
  }

  if (unmergedIsolated.length > 0) {
    const unmergedList = unmergedIsolated
      .map((m) => `\`@${m.name}\` (\`${m.branch}\`)`)
      .join(", ");
    lines.push(`- **⚠️ Unmerged branches:** ${unmergedList}`);
  }

  if (options.teardownResult && options.teardownResult.removed.length > 0) {
    const remCount = options.remainingWorktrees.length;
    lines.push(
      `- **Worktrees:** ${remCount} remaining (removed ${options.teardownResult.removed.length} merged worktree(s)).`,
    );
  } else if (options.remainingWorktrees.length > 0) {
    const wtList = options.remainingWorktrees
      .map((w) => `\`@${w.memberName}\`${w.dirty ? " (dirty)" : ""}`)
      .join(", ");
    const teardownCmd =
      options.initiatedBy === "tool"
        ? "Run `/swarm teardown` to clean up."
        : "Run `/swarm teardown` (or `/swarm teardown --delete-branches`) to clean up.";
    lines.push(
      `- **Worktrees:** ${options.remainingWorktrees.length} remaining (${wtList}) — ${teardownCmd}`,
    );
  } else {
    lines.push("- **Worktrees:** 0 remaining");
  }

  if (options.diffStat) {
    lines.push("", "**Diff Summary (`git diff --stat`):**", "```text", options.diffStat, "```");
  }

  return lines.join("\n");
}

function enrichLiveStateWithMissionSync(
  sectionText: string,
  run: SwarmRunState | null | undefined,
  humanSteeringText: string | undefined,
): string {
  if (
    !run ||
    run.status !== "active" ||
    !humanSteeringText ||
    humanSteeringText.trim().length === 0
  ) {
    return sectionText;
  }

  const syncRule =
    '- **Droid Shared-Truth Rule**: Before resuming or steering workers on changed requirements, sync shared Mission truth FIRST via `swarm{action:"mission"}` (`upsert_assertions` / `remove_assertion` for `assertions`, `upsert_features` / `update_feature` for `features`, `set_manifest` for `commands` / `boundaries`) and `swarm{action:"title"}` if the objective or strategy changed!';

  const steerHeading = "### ⚡ Live User Direction Update";
  const steerIdx = sectionText.indexOf(steerHeading);
  if (steerIdx === -1) {
    return `${sectionText}\n\n${steerHeading}\n${syncRule}`;
  }

  const tailAfterSteer = sectionText.slice(steerIdx);
  if (tailAfterSteer.includes("Shared-Truth Rule")) {
    return sectionText;
  }

  const nextHeadingMatch = tailAfterSteer
    .slice(steerHeading.length)
    .search(/\n#{2,3}\s+/);
  if (nextHeadingMatch === -1) {
    return `${sectionText}\n${syncRule}`;
  }
  const insertPos = steerIdx + steerHeading.length + nextHeadingMatch;
  return `${sectionText.slice(0, insertPos)}\n${syncRule}${sectionText.slice(insertPos)}`;
}

function extractAgentMessagePlainText(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") {
    return undefined;
  }
  const candidate = msg as {
    role?: unknown;
    content?: unknown;
    text?: unknown;
  };
  if (typeof candidate.text === "string") {
    return candidate.text;
  }
  if (typeof candidate.content === "string") {
    return candidate.content;
  }
  if (Array.isArray(candidate.content)) {
    const parts: string[] = [];
    for (const part of candidate.content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.join("\n");
  }
  return undefined;
}

function inspectGoalRemainingWork(run: SwarmRunState): {
  hasStructuredGoal: boolean;
  unfinishedFeatures: MissionFeature[];
  unpassedAssertions: MissionAssertion[];
  openHandoffs: MissionHandoffItem[];
  unfinishedMilestones: SwarmMilestone[];
  unmergedMembers: SwarmMemberRecord[];
} {
  const unfinishedFeatures = (run.features ?? []).filter(
    (f) =>
      f.status === "pending" ||
      f.status === "in_progress" ||
      f.status === "failed",
  );
  const unpassedAssertions = (run.assertions ?? []).filter(
    (a) => a.status !== "passed",
  );
  const openHandoffs = (run.handoffItems ?? []).filter(
    (h) => h.resolution === "open",
  );
  const unfinishedMilestones = (run.milestones ?? []).filter(
    (m) => m.status !== "done",
  );
  const unmergedMembers = getOrderedMembers(run).filter(
    (m) =>
      m.state !== "killed" &&
      (m.workspace === "share" || m.workspace === "branch") &&
      Boolean(m.branch) &&
      !m.mergedCommitSha,
  );

  const hasStructuredGoal = Boolean(
    unfinishedFeatures.length > 0 ||
      unpassedAssertions.length > 0 ||
      openHandoffs.length > 0 ||
      unfinishedMilestones.length > 0 ||
      (run.features && run.features.length > 0) ||
      (run.assertions && run.assertions.length > 0),
  );

  return {
    hasStructuredGoal,
    unfinishedFeatures,
    unpassedAssertions,
    openHandoffs,
    unfinishedMilestones,
    unmergedMembers,
  };
}

function buildGoalCheckpointMessage(
  run: SwarmRunState,
  snapshot: SwarmSnapshot,
  goalState: ReturnType<typeof inspectGoalRemainingWork>,
): string {
  const lines: string[] = [
    `🎯 Pi Swarm Goal Checkpoint (${run.id})`,
    "",
    `Mission "${sanitizePlainText(run.title || run.objective || run.id)}" is still \`active\` with 0 working members:`,
  ];

  const totalFeatures =
    (run.features ?? []).filter((f) => f.status !== "cancelled").length ||
    (run.features?.length ?? 0);
  const totalAssertions = run.assertions?.length ?? 0;

  if (goalState.unfinishedFeatures.length > 0) {
    const featSummary = goalState.unfinishedFeatures
      .slice(0, 8)
      .map(
        (f) =>
          `\`${sanitizePlainText(f.id)}\` [${f.status}, milestone: ${sanitizePlainText(f.milestone)}]`,
      )
      .join(", ");
    const featMore =
      goalState.unfinishedFeatures.length > 8
        ? `, … +${goalState.unfinishedFeatures.length - 8} more`
        : "";
    lines.push(
      `- **Remaining Features (${goalState.unfinishedFeatures.length}/${totalFeatures}):** ${featSummary}${featMore}`,
    );
  }

  if (goalState.unpassedAssertions.length > 0) {
    const valSummary = goalState.unpassedAssertions
      .slice(0, 8)
      .map(
        (a) =>
          `\`${sanitizePlainText(a.id)}\` [${a.status}] — ${sanitizePlainText(a.title).slice(0, 64)}`,
      )
      .join("; ");
    const valMore =
      goalState.unpassedAssertions.length > 8
        ? `; … +${goalState.unpassedAssertions.length - 8} more`
        : "";
    lines.push(
      `- **Unpassed Validation Assertions (${goalState.unpassedAssertions.length}/${totalAssertions}):** ${valSummary}${valMore}`,
    );
  }

  if (goalState.openHandoffs.length > 0) {
    const handoffSummary = goalState.openHandoffs
      .slice(0, 6)
      .map(
        (h) =>
          `\`${sanitizePlainText(h.id)}\` (${h.type} from @${sanitizePlainText(h.sourceMember)}): ${sanitizePlainText(h.summary).slice(0, 72)}`,
      )
      .join("; ");
    const handoffMore =
      goalState.openHandoffs.length > 6
        ? `; … +${goalState.openHandoffs.length - 6} more`
        : "";
    lines.push(
      `- **Open Tech-Debt Handoffs (${goalState.openHandoffs.length}):** ${handoffSummary}${handoffMore}`,
    );
  }

  if (
    goalState.unfinishedMilestones.length > 0 &&
    goalState.unfinishedFeatures.length === 0
  ) {
    const msSummary = goalState.unfinishedMilestones
      .slice(0, 6)
      .map((m) => `\`${sanitizePlainText(m.label)}\` [${m.status}]`)
      .join(", ");
    lines.push(
      `- **Pending Milestones (${goalState.unfinishedMilestones.length}/${run.milestones?.length ?? goalState.unfinishedMilestones.length}):** ${msSummary}`,
    );
  }

  if (goalState.unmergedMembers.length > 0) {
    const unmergedSummary = goalState.unmergedMembers
      .map((m) => `\`@${m.name}\` (\`${m.branch}\`)`)
      .join(", ");
    lines.push(
      `- **Unmerged Branches (${goalState.unmergedMembers.length}):** ${unmergedSummary}`,
    );
  }

  if (
    goalState.unfinishedFeatures.length === 0 &&
    goalState.unpassedAssertions.length === 0 &&
    goalState.openHandoffs.length === 0 &&
    goalState.unfinishedMilestones.length === 0
  ) {
    lines.push(
      `- **Goal Contract Satisfied:** All features (${totalFeatures}/${totalFeatures}) and VAL-* assertions (${totalAssertions}/${totalAssertions}) are complete — merge any remaining worktrees and call \`swarm{action:"done", summary}\` now to close the Mission.`,
    );
  }

  const validatorGuidance =
    run.validatorEnabled !== false
      ? 'verify unpassed `VAL-*` assertions via `@validator` (`swarm{action:"mission", mission_op:"verify_assertion"}`), '
      : 'verify unpassed `VAL-*` assertions (`swarm{action:"mission", mission_op:"verify_assertion"}`), ';

  lines.push(
    "",
    "Do NOT stop with plain text while the Mission is active:",
    `- Advance the next wave via \`swarm{action:"add"}\` or wake/steer parked members via \`post_message\` / \`swarm{action:"steer"}\` (and call \`swarm_wait{since: ${snapshot.boardHead}}\` while members work).`,
    `- Resolve any open handoff items via \`swarm{action:"mission", mission_op:"upsert_features"}\` + \`swarm{action:"mission", mission_op:"resolve_handoff"}\`, ${validatorGuidance}merge verified branches (\`swarm{action:"merge"}\`), or call \`swarm{action:"done", summary}\` once 100% complete.`,
    "- Only if genuinely blocked on external credentials or a human product decision, explain the blocker clearly and output `[NEEDS_HUMAN]` to pause auto-continuation.",
  );

  return lines.join("\n");
}

function formatTeardownReport(
  runId: string,
  result: SafeTeardownResult,
  force: boolean,
): string {
  const lines: string[] = [
    `### 🐝 Teardown — \`${runId}\`${force ? " (force)" : ""}`,
    "",
    `- **Removed:** ${result.removed.length} · **Skipped:** ${result.skipped.length} · **Errors:** ${result.errors.length}`,
    `- **Audit & Board History:** \`${SWARM_DIR}/runs/${runId}/\` preserved.`,
  ];

  if (result.removed.length > 0) {
    lines.push(
      `- **Removed worktrees:** ${result.removed.map((r) => `\`@${r.memberName}\` (\`${r.branch}\`)`).join(", ")}`,
    );
  }
  if (result.skipped.length > 0) {
    lines.push(
      `- **Skipped worktrees:** ${result.skipped
        .map((s) => `\`@${s.memberName}\` [${s.action}${s.reason ? `: ${s.reason}` : ""}]`)
        .join(", ")}`,
    );
  }
  if (result.errors.length > 0) {
    lines.push(
      `- **Errors:** ${result.errors.map((e) => `\`@${e.memberName}\`: ${e.reason ?? "unknown error"}`).join(", ")}`,
    );
  }

  return lines.join("\n");
}

function formatModelSettingCell(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
): string {
  const m = model?.trim() || "(inherit host)";
  return thinking ? `${m} (${thinking})` : m;
}

function formatSettingsMarkdown(
  settings: SwarmSettings,
  paths?: { globalPath: string; projectPath: string },
): string {
  const lines: string[] = [
    "### 🐝 Pi Swarm Settings",
    "",
    "| Setting | Effective Value |",
    "| --- | --- |",
    `| \`orchestratorModel\` | ${formatModelSettingCell(settings.orchestratorModel, settings.orchestratorThinkingLevel)} |`,
    `| \`workerModel\` | ${formatModelSettingCell(settings.workerModel, settings.workerThinkingLevel)} |`,
    `| \`validatorModel\` | ${formatModelSettingCell(settings.validatorModel, settings.validatorThinkingLevel)} |`,
    `| \`fallbackModels\` | ${settings.fallbackModels.length > 0 ? settings.fallbackModels.join(", ") : "(none)"} |`,
    `| \`keepWorkersWarm\` | ${settings.keepWorkersWarm ? "ON" : "OFF"} |`,
    `| \`validatorEnabled\` | ${settings.validatorEnabled ? "ON" : "OFF"} |`,
    `| \`stallWatchdogEnabled\` | ${settings.stallWatchdogEnabled ? "ON" : "OFF"} |`,
    `| \`stallMonitorMode\` | \`${settings.stallMonitorMode}\` |`,
    `| \`stallTimeoutMs\` | ${settings.stallTimeoutMs}ms |`,
    `| \`maxConcurrency\` | ${settings.maxConcurrency} |`,
    `| \`maxRetries\` | ${settings.maxRetries} |`,
    `| \`rateLimitBaseBackoffMs\` | ${settings.rateLimitBaseBackoffMs}ms |`,
    `| \`rateLimitMaxBackoffMs\` | ${settings.rateLimitMaxBackoffMs}ms |`,
    `| \`gitTimeoutMs\` | ${settings.gitTimeoutMs}ms |`,
    `| \`autoRebase\` | ${settings.autoRebase ? "ON" : "OFF"} |`,
    `| \`autoTeardownOnComplete\` | ${settings.autoTeardownOnComplete ? "ON" : "OFF"} |`,
  ];
  if (paths) {
    lines.push(
      "",
      `- **Project file:** \`${paths.projectPath}\``,
      `- **Global file:** \`${paths.globalPath}\``,
    );
  }
  return lines.join("\n");
}

// ============================================================================
// Extension Factory (`createPiSwarmExtension`)
// ============================================================================

interface PendingWakeupItem {
  type: "kickoff" | "wakeup_needed" | "stall_detected";
  runId: string | null;
  memberName?: string;
  seq?: number;
  messages?: BoardMessage[];
  summary: string;
  kickoffBody?: string;
}

export function createPiSwarmExtension(
  overrides: PiSwarmExtensionOverrides = {},
): ExtensionFactory {
  return function piSwarmExtension(pi: ExtensionAPI): void {
    // ------------------------------------------------------------------------
    // Deferred Runtime State (NEVER start timers/watchers/subprocesses here!)
    // ------------------------------------------------------------------------
    let currentSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      fallbackModels: [...DEFAULT_SWARM_SETTINGS.fallbackModels],
    };
    let lastLayeredSettings: LayeredSettingsResult | undefined;
    let cachedAvailableModels: AvailableModelInfo[] = [];
    let lastStatusText: string | undefined | null = null;
    let lastWorkingMessage: string | undefined;
    let lastTerminalTitle: string | undefined;
    let unfinishedFooterCue: string | undefined;
    let preSwarmHostModel: PreSwarmHostModelSnapshot | undefined;
    let orchestratorMode = false;
    let autoConfirmDefault = false;
    let lastCompletedRunId: string | null = null;
    const completedCardEmittedRunIds = new Set<string>();
    const activeDoneFlowRunIds = new Set<string>();
    let runsCache:
      | { cwd: string; runs: RunSummary[]; fetchedAt: number }
      | undefined;
    let boundCwd: string | undefined;
    let lastCtx: ExtensionContext | undefined;
    let fallbackModelRuntimePromise: Promise<ModelRuntime> | undefined;

    let activeStore: ISwarmStore | undefined;
    let activeWorktree: IWorktreeManager | undefined;
    let activeTransport: ISwarmTransport | undefined;
    let activeEngine: ISwarmEngine | undefined;
    let unsubEngine: (() => void) | undefined;
    let unbindShortcuts: (() => void) | undefined;
    let activeWidgetTui: TUI | undefined;
    let isShutDown = false;
    let latestHumanDirection: { text: string; timestamp: string } | undefined;
    let activeSessionId: string | undefined;
    let sessionStartReason: SessionStartEvent["reason"] | undefined;
    let activeRunSections: Record<string, string> | undefined;
    let currentTurnIndex = 0;
    let waitArmedTurnIndex: number | null = null;
    let lastObservedAssistantText: string | undefined;
    const activatedRunIds = new Set<string>();
    const readOnlyAttachRunIds = new Set<string>();
    const goalContinuationByRunId = new Map<
      string,
      {
        count: number;
        lastProgressKey?: string;
        stagnantTurns: number;
        tripped?: boolean;
      }
    >();

    function notifyEngineHumanInputAwaited(
      waiting: boolean,
      engineOverride?: ISwarmEngine,
    ): void {
      const eng = (engineOverride ?? activeEngine) as
        | { setHumanInputAwaited?: (v: boolean) => void }
        | undefined;
      eng?.setHumanInputAwaited?.(waiting);
    }

    function resetGoalContinuation(runId?: string | null): void {
      notifyEngineHumanInputAwaited(false);
      if (!runId) {
        goalContinuationByRunId.clear();
        return;
      }
      goalContinuationByRunId.delete(runId);
    }

    const widgetState: SwarmWidgetState = createSwarmWidgetState();

    const onModalEnter = (): void => {
      widgetState.modalDepth += 1;
    };
    const onModalExit = (): void => {
      widgetState.modalDepth = Math.max(0, widgetState.modalDepth - 1);
    };

    async function withModalGuard<T>(fn: () => Promise<T>): Promise<T> {
      onModalEnter();
      try {
        return await fn();
      } finally {
        onModalExit();
      }
    }

    function getLazyFallbackModelRuntime(): Promise<ModelRuntime> {
      if (!fallbackModelRuntimePromise) {
        const agentDir = getAgentDir();
        fallbackModelRuntimePromise = ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"),
          modelsPath: path.join(agentDir, "models.json"),
        });
      }
      return fallbackModelRuntimePromise;
    }

    // Wakeup queue & single-flight coalescing state
    const pendingWakeups: PendingWakeupItem[] = [];
    let wakeupFlushScheduled = false;
    let wakeupInFlight = false;
    let wakeupSafetyTimer: ReturnType<typeof setTimeout> | undefined;
    let userPromptPreflight = false;
    let userPromptPreflightTimer: ReturnType<typeof setTimeout> | undefined;

    function clearWakeupInFlight(): void {
      wakeupInFlight = false;
      if (wakeupSafetyTimer) {
        clearTimeout(wakeupSafetyTimer);
        wakeupSafetyTimer = undefined;
      }
    }

    function clearUserPromptPreflight(): void {
      userPromptPreflight = false;
      if (userPromptPreflightTimer) {
        clearTimeout(userPromptPreflightTimer);
        userPromptPreflightTimer = undefined;
      }
    }

    // Shared draft controller (pure in-memory + appendEntry, no timers/I/O)
    const draftController = new DraftStateController(
      pi,
      {
        onModalEnter,
        onModalExit,
      },
      () => currentSettings,
    );

    const questionnaireUI: IQuestionnaireUI =
      overrides.questionnaireUI ??
      createQuestionnaireUI({
        onModalEnter,
        onModalExit,
      });

    // ------------------------------------------------------------------------
    // Runtime Binding, Settings & UI Sync Helpers
    // ------------------------------------------------------------------------

    function getSnapshotSafe(): SwarmSnapshot {
      return activeEngine?.getSnapshot() ?? createEmptySnapshot(currentSettings);
    }

    function getCurrentSessionId(ctx?: ExtensionContext): string {
      const raw = ctx?.sessionManager?.getSessionId?.()?.trim();
      if (raw) {
        return raw;
      }
      const fromLast = lastCtx?.sessionManager?.getSessionId?.()?.trim();
      if (fromLast) {
        return fromLast;
      }
      return activeSessionId || "session-unknown";
    }

    function isCurrentSessionOwner(
      run: SwarmRunState | null | undefined,
      ctx?: ExtensionContext,
    ): boolean {
      if (!run) {
        return false;
      }
      const sid = getCurrentSessionId(ctx);
      if (!run.ownerSessionId || run.ownerSessionId === sid) {
        return true;
      }
      return !(run.ownerPid > 0 && isProcessAlive(run.ownerPid));
    }

    function isRunResumableBySession(
      summary: Pick<RunSummary, "status" | "ownerSessionId" | "ownerPid">,
      sid: string,
    ): boolean {
      if (isTerminalRunStatus(summary.status)) {
        return false;
      }
      if (
        summary.ownerSessionId &&
        summary.ownerSessionId !== sid &&
        summary.ownerPid > 0 &&
        isProcessAlive(summary.ownerPid)
      ) {
        return false;
      }
      return true;
    }

    async function attachRunWithOwnershipGuard(
      engine: ISwarmEngine,
      runId: string,
      ctx: ExtensionContext,
      readOnly: boolean,
    ): Promise<SwarmSnapshot> {
      if (!readOnly) {
        return engine.attachRun(runId, ctx);
      }
      readOnlyAttachRunIds.add(runId);
      try {
        return await engine.attachRun(runId, ctx);
      } finally {
        readOnlyAttachRunIds.delete(runId);
      }
    }

    async function releaseRunOwnershipIfHeld(
      store: ISwarmStore,
      runId: string | null | undefined,
      sessionId: string,
    ): Promise<void> {
      if (!runId) {
        return;
      }
      try {
        const run = await store.loadRun(runId);
        if (run.ownerSessionId === sessionId && run.ownerPid === process.pid) {
          await store.updateRun(runId, {
            ownerPid: 0,
            actor: ORCHESTRATOR_NAME,
          });
        }
      } catch {
        // best-effort ownership release
      }
    }

    async function claimRunOwnershipIfAvailable(
      store: ISwarmStore,
      engine: ISwarmEngine,
      run: SwarmRunState | null | undefined,
      sessionId: string,
      ctx: ExtensionContext,
      allowSamePidFork: boolean,
    ): Promise<SwarmRunState | null> {
      if (!run || !isRunningProfileRun(run) || !sessionId) {
        return run ?? null;
      }
      const canClaim =
        run.ownerPid === 0 ||
        !isProcessAlive(run.ownerPid) ||
        (allowSamePidFork && run.ownerPid === process.pid);
      if (!canClaim) {
        return run;
      }
      if (run.ownerSessionId === sessionId && run.ownerPid === process.pid) {
        return run;
      }
      try {
        const updated = await store.updateRun(run.id, {
          ownerSessionId: sessionId,
          ownerPid: process.pid,
          actor: ORCHESTRATOR_NAME,
        });
        if (engine.getSnapshot().activeRunId === run.id) {
          await engine.attachRun(run.id, ctx);
          return engine.getSnapshot().run;
        }
        return updated;
      } catch {
        return run;
      }
    }

    function disarmOrchestratorWait(reason: string): void {
      waitArmedTurnIndex = null;
      activeEngine?.clearOrchestratorWait(reason);
    }

    function shouldSkipInputPreflight(text: string): boolean {
      if (text.startsWith("!")) {
        return true;
      }
      if (!text.startsWith("/")) {
        return false;
      }
      const body = text.slice(1).trim();
      if (!body) {
        return true;
      }
      const spaceIdx = body.search(/\s/);
      const cmdName = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
      if (cmdName === "swarm" || cmdName === "swarm-direct") {
        return true;
      }
      const cmds = typeof pi.getCommands === "function" ? pi.getCommands() : undefined;
      if (Array.isArray(cmds)) {
        const match = cmds.find((c) => c.name.toLowerCase() === cmdName);
        if (match) {
          return match.source !== "skill" && match.source !== "prompt";
        }
      }
      // Skill commands expand into prompts and trigger `before_agent_start`; built-in `/` commands do not.
      return !cmdName.startsWith("skill:");
    }

    function isRunningProfileRun(run: SwarmRunState | null | undefined): boolean {
      return Boolean(run && (run.status === "active" || run.status === "paused"));
    }

    function isOwnedLiveRun(
      run: SwarmRunState | null | undefined,
      ctx?: ExtensionContext,
    ): boolean {
      if (!run || !isRunningProfileRun(run)) {
        return false;
      }
      const sid = getCurrentSessionId(ctx);
      if (!sid || !run.ownerSessionId) {
        return false;
      }
      return run.ownerSessionId === sid;
    }

    function persistCurrentFocus(
      runId: string | null,
      sessionId: string,
      reason: string,
    ): void {
      persistFocusEntry(pi, runId, sessionId, reason, {
        orchestratorMode,
        autoConfirmDefault,
      });
    }

    function computeDesiredToolProfile(
      ctx?: ExtensionContext,
      snapshotOverride?: SwarmSnapshot,
    ): SwarmToolProfileMode {
      if (draftController.isActive()) {
        return "drafting";
      }
      const run = (snapshotOverride ?? getSnapshotSafe()).run;
      if (isOwnedLiveRun(run, ctx)) {
        return "running";
      }
      if (orchestratorMode) {
        return "standby";
      }
      return "idle";
    }

    function isOrchestratorStandby(
      ctx?: ExtensionContext,
      snapshotOverride?: SwarmSnapshot,
    ): boolean {
      return computeDesiredToolProfile(ctx, snapshotOverride) === "standby";
    }

    function buildCurrentStandbySection(
      snapshot: SwarmSnapshot,
      ctx?: ExtensionContext,
    ): string {
      const attachedRun = snapshot.run;
      const currentSid = getCurrentSessionId(ctx ?? lastCtx);
      const priorRun =
        attachedRun &&
        attachedRun.status === "completed" &&
        (!attachedRun.ownerSessionId || attachedRun.ownerSessionId === currentSid)
          ? attachedRun
          : null;
      return buildOrchestratorStandbySection(snapshot, {
        priorRun,
        autoConfirmDefault,
        roleModels: buildRoleModelsFromSettings(currentSettings),
      });
    }

    function syncActiveRunSections(options?: {
      ctx?: ExtensionContext;
      includeRecentBoard?: boolean;
      humanSteeringText?: string;
      ignoreDraft?: boolean;
    }): void {
      if (!activeRunSections) {
        return;
      }
      const draft = options?.ignoreDraft ? null : draftController.getDraft();
      if (isDraftActive(draft)) {
        activeRunSections.swarm = buildDraftingSystemOverlay(draft);
        delete activeRunSections.swarm_state;
        return;
      }
      const snapshot = getSnapshotSafe();
      if (isOwnedLiveRun(snapshot.run, options?.ctx)) {
        activeRunSections.swarm = buildOrchestratorStaticSection(snapshot);
        activeRunSections.swarm_state = enrichLiveStateWithMissionSync(
          buildOrchestratorLiveStateSection(snapshot, {
            includeRecentBoard: options?.includeRecentBoard ?? false,
            ...(options?.humanSteeringText
              ? { humanSteeringText: options.humanSteeringText }
              : {}),
          }),
          snapshot.run,
          options?.humanSteeringText,
        );
        return;
      }
      if (orchestratorMode) {
        activeRunSections.swarm = buildCurrentStandbySection(snapshot, options?.ctx);
        delete activeRunSections.swarm_state;
        return;
      }
      delete activeRunSections.swarm;
      delete activeRunSections.swarm_state;
    }

    function syncDraftWidgetState(draft: SwarmDraftState | null): void {
      widgetState.draftActive = isDraftActive(draft);
      widgetState.draftMode = draft?.mode;
      widgetState.draftSeed = draft?.seed;
      widgetState.orchestratorStandby = isOrchestratorStandby(lastCtx);
    }

    function invalidateRunsCache(): void {
      runsCache = undefined;
    }

    async function listRunsCached(
      store: ISwarmStore,
      forceRefresh = false,
    ): Promise<RunSummary[]> {
      const cwd = boundCwd ?? "";
      const nowMs = (overrides.now ?? Date.now)();
      if (
        !forceRefresh &&
        runsCache &&
        runsCache.cwd === cwd &&
        nowMs - runsCache.fetchedAt < 1500
      ) {
        return runsCache.runs;
      }
      const runs = await store.listRuns();
      runsCache = { cwd, runs, fetchedAt: nowMs };
      return runs;
    }

    function syncSessionNameForRun(
      run: Pick<SwarmRunState, "title" | "objective" | "id">,
    ): void {
      if (typeof pi.setSessionName !== "function") {
        return;
      }
      if (pi.getSessionName?.()?.trim()) {
        return;
      }
      const runTitle = sanitizePlainText(run.title || run.objective || run.id).trim();
      if (!runTitle) {
        return;
      }
      try {
        pi.setSessionName(`🐝 ${runTitle}`);
      } catch {
        // ignore if host session does not support session naming in current mode
      }
    }

    function computeSwarmWorkingMessage(
      snapshot: SwarmSnapshot,
      draftActive: boolean,
    ): string | undefined {
      const run = snapshot.run;
      if (run && isRunningProfileRun(run)) {
        const workingSet = new Set(snapshot.workingMemberNames);
        const workingCount = workingSet.size;
        const waitingCount = snapshot.waitingMemberNames.filter(
          (name) => !workingSet.has(name),
        ).length;
        if (run.status === "paused") {
          const shortTitle = sanitizePlainText(run.title || run.objective || run.id).slice(0, 36);
          return `🐝 Swarm (paused) · ${shortTitle}`;
        }
        const boardTag = snapshot.boardHead > 0 ? ` · #${snapshot.boardHead}` : "";
        return `🐝 Swarm · ${workingCount}w/${waitingCount}wait${boardTag}`;
      }
      if (draftActive) {
        return "🐝 Drafting Swarm Plan…";
      }
      return undefined;
    }

    function computeSwarmTerminalTitle(
      snapshot: SwarmSnapshot,
      draftActive: boolean,
    ): string | undefined {
      const run = snapshot.run;
      if (run && isRunningProfileRun(run)) {
        const workingSet = new Set(snapshot.workingMemberNames);
        const workingCount = workingSet.size;
        const waitingCount = snapshot.waitingMemberNames.filter(
          (name) => !workingSet.has(name),
        ).length;
        const shortTitle = sanitizePlainText(run.title || run.objective || run.id).slice(0, 48);
        const stateTag =
          run.status === "paused" ? "Paused" : `${workingCount}w/${waitingCount}wait`;
        return `🐝 Swarm · ${shortTitle} (${stateTag})`;
      }
      if (draftActive) {
        return "🐝 Swarm · Drafting Plan";
      }
      return undefined;
    }

    function clearWorkingMessageAndTitle(ctxOverride?: ExtensionContext): void {
      const targetCtx = ctxOverride ?? lastCtx;
      if (targetCtx?.hasUI) {
        if (typeof targetCtx.ui.setWorkingMessage === "function") {
          try {
            targetCtx.ui.setWorkingMessage(undefined);
          } catch {
            // ignore UI cleanup errors
          }
        }
        if (
          typeof targetCtx.ui.setTitle === "function" &&
          lastTerminalTitle !== undefined
        ) {
          try {
            targetCtx.ui.setTitle("");
          } catch {
            // ignore UI cleanup errors
          }
        }
      }
      lastWorkingMessage = undefined;
      lastTerminalTitle = undefined;
    }

    function snapshotCurrentHostModel(
      ctx?: ExtensionContext,
    ): PreSwarmHostModelSnapshot | undefined {
      const targetCtx = ctx ?? lastCtx;
      const model = targetCtx?.model;
      if (!model?.id) {
        return undefined;
      }
      let thinkingLevel: ThinkingLevel | undefined;
      try {
        const fromPi =
          typeof pi.getThinkingLevel === "function"
            ? pi.getThinkingLevel()
            : undefined;
        if (fromPi && VALID_THINKING_LEVELS.has(fromPi)) {
          thinkingLevel = fromPi;
        }
      } catch {
        // ignore if unavailable
      }
      if (!thinkingLevel && targetCtx?.thinkingLevel && VALID_THINKING_LEVELS.has(targetCtx.thinkingLevel)) {
        thinkingLevel = targetCtx.thinkingLevel;
      }
      return {
        provider: model.provider ?? "",
        modelId: model.id,
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      };
    }

    async function applyOrchestratorModelWithSnapshot(
      ctx: ExtensionContext | undefined,
      settings: SwarmSettings,
      options: { clearThinking?: boolean } = {},
    ): Promise<ApplyOrchestratorModelResult> {
      const beforeSnap = !preSwarmHostModel
        ? snapshotCurrentHostModel(ctx)
        : undefined;
      const res = await applyOrchestratorModel(
        pi,
        ctx,
        settings,
        getLazyFallbackModelRuntime,
        options,
      );
      if (!preSwarmHostModel && beforeSnap && res.changed) {
        preSwarmHostModel = beforeSnap;
      }
      return res;
    }

    async function restorePreSwarmHostModel(
      ctxOverride?: ExtensionContext,
    ): Promise<void> {
      const snap = preSwarmHostModel;
      if (!snap) {
        return;
      }
      preSwarmHostModel = undefined;
      const targetCtx = ctxOverride ?? lastCtx;
      const fullId = snap.provider ? `${snap.provider}/${snap.modelId}` : snap.modelId;
      await applyOrchestratorModel(
        pi,
        targetCtx,
        {
          ...currentSettings,
          orchestratorModel: fullId,
          orchestratorThinkingLevel: snap.thinkingLevel,
        },
        getLazyFallbackModelRuntime,
        { clearThinking: snap.thinkingLevel === undefined },
      );
    }

    async function emitMissionCompleteCardForRun(
      run: SwarmRunState,
      options: {
        summary: string;
        initiatedBy: "tool" | "command" | "event";
        ctx?: ExtensionContext;
        remainingWorktrees?: readonly RemainingWorktreeInfo[];
        teardownResult?: SafeTeardownResult;
      },
    ): Promise<void> {
      if (completedCardEmittedRunIds.has(run.id)) {
        return;
      }
      completedCardEmittedRunIds.add(run.id);

      const effectiveRun = activeStore
        ? await activeStore.loadRun(run.id).catch(() => run)
        : run;

      const targetCtx = options.ctx ?? lastCtx;
      const boardMessages = activeStore
        ? (
            await activeStore
              .readBoard(effectiveRun.id, { channel: "*", limit: 200 })
              .catch(() => ({ messages: [] as BoardMessage[] }))
          ).messages
        : (activeEngine?.getSnapshot().recentBoard ?? []);

      const remainingWorktrees =
        options.remainingWorktrees ??
        (await inspectRemainingWorktrees(effectiveRun, activeStore, activeWorktree)).remaining;
      const diffStat = await computeMergedGitDiffStat(
        boundCwd ?? targetCtx?.cwd,
        effectiveRun,
      );
      const libraryTopics: string[] = [];
      if (activeStore?.listLibraryTopics) {
        const rawTopics = await activeStore
          .listLibraryTopics(effectiveRun.id)
          .catch(() => [] as Array<{ topic: string; path: string; bytes: number }>);
        for (const entry of rawTopics) {
          if (entry.bytes <= 0) {
            continue;
          }
          const starterHeading = `# ${entry.topic.charAt(0).toUpperCase()}${entry.topic.slice(1)}`;
          if (entry.bytes <= starterHeading.length + 4 && activeStore.readLibraryTopic) {
            const body = await activeStore
              .readLibraryTopic(effectiveRun.id, entry.topic)
              .catch(() => null);
            if (!body || body.trim() === starterHeading) {
              continue;
            }
          }
          libraryTopics.push(entry.topic);
        }
      }
      const card = buildMissionCompletionCard(effectiveRun, {
        summary: options.summary,
        nowMs: (overrides.now ?? Date.now)(),
        boardMessages,
        diffStat,
        remainingWorktrees,
        teardownResult: options.teardownResult,
        libraryTopics,
        initiatedBy: options.initiatedBy,
      });

      const nonCancelledFeatures = (effectiveRun.features ?? []).filter(
        (f) => f.status !== "cancelled",
      );
      const overriddenCount = (effectiveRun.assertions ?? []).filter(
        (a) => a.overridden === true,
      ).length;
      const libraryPath = `${SWARM_DIR}/${SWARM_RUNS_DIR}/${effectiveRun.id}/${SWARM_LIBRARY_DIR}/`;
      pi.sendMessage(
        {
          customType: SWARM_STATUS_CUSTOM_TYPE,
          content: card,
          display: true,
          details: {
            runId: effectiveRun.id,
            status: effectiveRun.status,
            summary: options.summary,
            missionCompleteCard: true,
            remainingWorktrees: remainingWorktrees.length,
            ...(effectiveRun.assertions
              ? {
                  assertionsPassed: effectiveRun.assertions.filter(
                    (a) => a.status === "passed",
                  ).length,
                  assertionsOverridden: overriddenCount,
                  assertionsTotal: effectiveRun.assertions.length,
                }
              : {}),
            ...(effectiveRun.features
              ? {
                  featuresCompleted: nonCancelledFeatures.filter(
                    (f) => f.status === "completed",
                  ).length,
                  featuresTotal:
                    nonCancelledFeatures.length || effectiveRun.features.length,
                }
              : {}),
            ...(effectiveRun.milestones
              ? {
                  milestonesSealed: effectiveRun.milestones.filter(
                    (m) => m.sealed === true,
                  ).length,
                  milestonesTotal: effectiveRun.milestones.length,
                }
              : {}),
            ...(effectiveRun.handoffItems
              ? {
                  handoffsResolved: effectiveRun.handoffItems.filter(
                    (h) => h.resolution !== "open",
                  ).length,
                  handoffsTotal: effectiveRun.handoffItems.length,
                }
              : {}),
            ...(effectiveRun.services && effectiveRun.services.length > 0
              ? {
                  servicesCount: effectiveRun.services.length,
                }
              : {}),
            ...(libraryTopics.length > 0
              ? {
                  libraryTopics,
                  libraryPath,
                }
              : {}),
          },
        },
        { triggerTurn: false },
      );
      refreshUI(targetCtx);
    }

    function refreshUI(
      ctxOverride?: ExtensionContext,
      snapshotOverride?: SwarmSnapshot,
    ): void {
      const ctx = ctxOverride ?? lastCtx;
      const snapshot = snapshotOverride ?? getSnapshotSafe();
      const draftActive = draftController.isActive();
      const orchestratorStandby = isOrchestratorStandby(ctx, snapshot);
      widgetState.orchestratorStandby = orchestratorStandby;
      activeWidgetTui?.requestRender();
      if (ctx?.hasUI) {
        if (snapshot.run || draftActive || orchestratorStandby) {
          unfinishedFooterCue = undefined;
        }
        const line =
          formatStatusLine(snapshot, draftActive, orchestratorStandby) ??
          unfinishedFooterCue;
        if (line !== lastStatusText) {
          lastStatusText = line;
          ctx.ui.setStatus(SWARM_STATUS_KEY, line);
        }

        if (typeof ctx.ui.setWorkingMessage === "function") {
          const nextWorkingMsg = computeSwarmWorkingMessage(snapshot, draftActive);
          if (nextWorkingMsg !== lastWorkingMessage) {
            lastWorkingMessage = nextWorkingMsg;
            try {
              ctx.ui.setWorkingMessage(nextWorkingMsg);
            } catch {
              // ignore UI sync errors
            }
          }
        }

        if (typeof ctx.ui.setTitle === "function") {
          const nextTitle = computeSwarmTerminalTitle(snapshot, draftActive);
          if (nextTitle !== lastTerminalTitle) {
            lastTerminalTitle = nextTitle;
            try {
              ctx.ui.setTitle(nextTitle ?? "");
            } catch {
              // ignore UI sync errors
            }
          }
        }
      }
    }

    function emitZeroTurnMessage(
      ctx: ExtensionContext,
      content: string,
      details?: Record<string, unknown>,
    ): void {
      pi.sendMessage(
        {
          customType: SWARM_STATUS_CUSTOM_TYPE,
          content,
          display: true,
          details,
        },
        { triggerTurn: false },
      );
      refreshUI(ctx);
    }

    function canUseCustomTui(ctx?: ExtensionContext): boolean {
      return Boolean(
        ctx?.hasUI &&
          ctx.mode === "tui" &&
          typeof ctx.ui.custom === "function",
      );
    }

    function getModelSettingsState(ctx?: ExtensionContext): ModelPickerSettingsState {
      const targetCtx = ctx ?? lastCtx;
      const hostModel = formatHostModelId(targetCtx?.model);
      const origins: Partial<Record<SwarmModelRole, RoleModelOrigin>> = {
        orchestrator: getRoleModelOrigin("orchestrator", lastLayeredSettings),
        worker: getRoleModelOrigin("worker", lastLayeredSettings),
        validator: getRoleModelOrigin("validator", lastLayeredSettings),
      };
      return {
        settings: currentSettings,
        origins,
        hostModel,
      };
    }

    function getPreferredSaveScope(): ModelSaveScope {
      if (
        lastLayeredSettings &&
        Object.keys(lastLayeredSettings.projectOverrides).length > 0
      ) {
        return "project";
      }
      return "global";
    }

    async function refreshAvailableModels(
      ctx?: ExtensionContext,
      all = true,
    ): Promise<AvailableModelInfo[]> {
      try {
        const engine = activeEngine;
        if (!engine) return cachedAvailableModels;
        const models = await engine.listModels({
          all,
          hostContext: ctx ?? lastCtx,
        });
        cachedAvailableModels = models;
        return models;
      } catch {
        return cachedAvailableModels;
      }
    }

    async function reloadSettings(cwd: string): Promise<SwarmSettings> {
      try {
        if (overrides.settingsLoader) {
          lastLayeredSettings = undefined;
          currentSettings = await overrides.settingsLoader(cwd);
        } else {
          lastLayeredSettings = await loadLayeredSwarmSettings(
            cwd,
            overrides.settingsPathOptions,
          );
          currentSettings = lastLayeredSettings.settings;
        }
      } catch {
        lastLayeredSettings = undefined;
        currentSettings = {
          ...DEFAULT_SWARM_SETTINGS,
          fallbackModels: [...DEFAULT_SWARM_SETTINGS.fallbackModels],
        };
      }
      activeWorktree?.setGitTimeoutMs?.(currentSettings.gitTimeoutMs);
      return currentSettings;
    }

    async function persistSettingsPatch(
      scope: "global" | "project",
      patch: Partial<SwarmSettings>,
      cwd: string,
    ): Promise<SwarmSettings> {
      if (overrides.settingsSaver) {
        currentSettings = await overrides.settingsSaver(scope, patch, cwd);
      } else {
        currentSettings = await saveSwarmSettings(scope, patch, {
          projectRoot: cwd,
          ...overrides.settingsPathOptions,
        });
        lastLayeredSettings = await loadLayeredSwarmSettings(
          cwd,
          overrides.settingsPathOptions,
        ).catch(() => lastLayeredSettings);
      }
      activeWorktree?.setGitTimeoutMs?.(currentSettings.gitTimeoutMs);
      return currentSettings;
    }

    async function syncActiveRunRoleModels(ctx?: ExtensionContext): Promise<void> {
      const activeRunId = activeEngine?.getSnapshot().activeRunId;
      if (!activeRunId || !activeStore) {
        return;
      }
      try {
        await activeStore.updateRun(activeRunId, {
          roleModels: buildRoleModelsFromSettings(currentSettings),
          actor: ORCHESTRATOR_NAME,
        });
        await activeEngine?.attachRun(activeRunId, ctx);
      } catch {
        // best-effort sync with active run state
      }
    }

    function getRoleSettingsKeys(role: SwarmModelRole): Array<keyof SwarmSettings> {
      if (role === "orchestrator") {
        return ["orchestratorModel", "orchestratorThinkingLevel"];
      }
      if (role === "worker") {
        return ["workerModel", "workerThinkingLevel"];
      }
      return ["validatorModel", "validatorThinkingLevel"];
    }

    async function applyRoleModelChange(
      role: SwarmModelRole,
      modelValue: string | undefined,
      thinkingLevel: ThinkingLevel | undefined,
      ctx: ExtensionContext | undefined,
      options: {
        scope?: "project" | "global";
        updateRun?: boolean;
        clearThinking?: boolean;
      } = {},
    ): Promise<{
      settings: SwarmSettings;
      orchestratorApply?: ApplyOrchestratorModelResult;
      propagated?: { switched: string[]; deferred: string[] };
    }> {
      const targetCtx = ctx ?? lastCtx;
      const cwd = targetCtx?.cwd ?? boundCwd ?? process.cwd();
      const scope = options.scope ?? "project";
      const trimmed = modelValue?.trim();
      const isClearing = !trimmed || CLEAR_MODEL_TOKENS.has(trimmed.toLowerCase());
      const previousModel =
        role === "orchestrator"
          ? currentSettings.orchestratorModel
          : role === "worker"
            ? currentSettings.workerModel
            : currentSettings.validatorModel;

      let resolvedModelValue = trimmed;
      let resolvedThinking = thinkingLevel;
      if (!isClearing && resolvedModelValue && activeTransport?.resolveModel) {
        const res = await activeTransport.resolveModel(
          resolvedModelValue,
          thinkingLevel,
          targetCtx,
        );
        resolvedModelValue = res.model;
        if (resolvedThinking === undefined && res.thinkingLevel !== undefined) {
          resolvedThinking = res.thinkingLevel;
        }
      }

      // In real saveSwarmSettings("project", ...), explicit `null` writes `null` to JSON
      // so global overrides are cleanly cleared at the project layer.
      const clearModelVal = overrides.settingsSaver
        ? undefined
        : (null as unknown as string);
      const clearThinkingVal = overrides.settingsSaver
        ? undefined
        : (null as unknown as ThinkingLevel);
      const nextModelPatchVal = isClearing ? clearModelVal : resolvedModelValue;
      const shouldClearThinking =
        resolvedThinking === undefined && (isClearing || Boolean(options.clearThinking));

      const patch: Partial<SwarmSettings> = {};
      if (role === "orchestrator") {
        patch.orchestratorModel = nextModelPatchVal;
        if (resolvedThinking !== undefined) {
          patch.orchestratorThinkingLevel = resolvedThinking;
        } else if (shouldClearThinking) {
          patch.orchestratorThinkingLevel = clearThinkingVal;
        }
      } else if (role === "worker") {
        patch.workerModel = nextModelPatchVal;
        if (resolvedThinking !== undefined) {
          patch.workerThinkingLevel = resolvedThinking;
        } else if (shouldClearThinking) {
          patch.workerThinkingLevel = clearThinkingVal;
        }
      } else {
        patch.validatorModel = nextModelPatchVal;
        if (resolvedThinking !== undefined) {
          patch.validatorThinkingLevel = resolvedThinking;
        } else if (shouldClearThinking) {
          patch.validatorThinkingLevel = clearThinkingVal;
        }
      }

      await persistSettingsPatch(scope, patch, cwd);

      // If user explicitly saves to global scope while `.pi/pi-swarm-settings.json` has shadowing
      // keys for this role, unmask global by deleting those project keys.
      if (scope === "global" && !overrides.settingsSaver && lastLayeredSettings) {
        const roleKeys = getRoleSettingsKeys(role);
        const hasProjectShadow = roleKeys.some(
          (k) => k in lastLayeredSettings!.projectOverrides,
        );
        if (hasProjectShadow) {
          currentSettings = await deleteProjectSettingsKeys(
            cwd,
            roleKeys,
            overrides.settingsPathOptions,
          );
          lastLayeredSettings = await loadLayeredSwarmSettings(
            cwd,
            overrides.settingsPathOptions,
          ).catch(() => lastLayeredSettings);
        }
      }

      let propagated: { switched: string[]; deferred: string[] } | undefined;
      if (options.updateRun !== false) {
        if ((role === "worker" || role === "validator") && activeEngine?.propagateRoleModel) {
          const propRes = await activeEngine.propagateRoleModel({
            role,
            model: isClearing ? undefined : resolvedModelValue,
            thinkingLevel: resolvedThinking,
            previousModel,
            clearToInherit: isClearing,
            hostContext: targetCtx,
          });
          propagated = {
            switched: propRes.switched,
            deferred: propRes.deferred,
          };
        } else {
          await syncActiveRunRoleModels(targetCtx);
        }
      }

      let orchestratorApply: ApplyOrchestratorModelResult | undefined;
      if (role === "orchestrator" && (!isClearing || shouldClearThinking)) {
        orchestratorApply = await applyOrchestratorModel(
          pi,
          targetCtx,
          currentSettings,
          getLazyFallbackModelRuntime,
          { clearThinking: shouldClearThinking },
        );
      }

      refreshUI(targetCtx);
      return { settings: currentSettings, orchestratorApply, propagated };
    }

    async function applyFallbackModelsChange(
      scope: "project" | "global",
      fallbackModels: string[],
      ctx?: ExtensionContext,
    ): Promise<SwarmSettings> {
      const targetCtx = ctx ?? lastCtx;
      const cwd = targetCtx?.cwd ?? boundCwd ?? process.cwd();
      await persistSettingsPatch(scope, { fallbackModels }, cwd);
      if (
        scope === "global" &&
        !overrides.settingsSaver &&
        lastLayeredSettings &&
        "fallbackModels" in lastLayeredSettings.projectOverrides
      ) {
        currentSettings = await deleteProjectSettingsKeys(
          cwd,
          ["fallbackModels"],
          overrides.settingsPathOptions,
        );
        lastLayeredSettings = await loadLayeredSwarmSettings(
          cwd,
          overrides.settingsPathOptions,
        ).catch(() => lastLayeredSettings);
      }
      await syncActiveRunRoleModels(targetCtx);
      refreshUI(targetCtx);
      return currentSettings;
    }

    function makeModelPickerCallbacks(ctx?: ExtensionContext) {
      return {
        onApplyRole: async (sel: {
          scope: ModelSaveScope;
          role: SwarmModelRole;
          model?: string;
          thinkingLevel?: ThinkingLevel;
        }) => {
          const { propagated, orchestratorApply } = await applyRoleModelChange(
            sel.role,
            sel.model ?? "default",
            sel.thinkingLevel,
            ctx ?? lastCtx,
            {
              scope: sel.scope,
              updateRun: true,
              clearThinking: sel.thinkingLevel === undefined,
            },
          );
          const parts: string[] = [];
          if (!sel.model) {
            parts.push(`Reset ${sel.role} -> host default [${sel.scope}]`);
          } else {
            parts.push(
              `Saved ${sel.role} -> ${sel.model}${sel.thinkingLevel ? ` (${sel.thinkingLevel})` : ""} [${sel.scope}]`,
            );
          }
          if (propagated && propagated.switched.length > 0) {
            parts.push(`switched: ${propagated.switched.map((n) => `@${n}`).join(", ")}`);
          }
          if (propagated && propagated.deferred.length > 0) {
            parts.push(`queued at turn end: ${propagated.deferred.map((n) => `@${n}`).join(", ")}`);
          }
          if (orchestratorApply?.warning) {
            parts.push(`⚠ ${orchestratorApply.warning}`);
          }
          return {
            ...getModelSettingsState(ctx ?? lastCtx),
            notice: parts.join(" · "),
          };
        },
        onApplyFallbacks: async (sel: {
          scope: ModelSaveScope;
          fallbackModels: string[];
        }) => {
          await applyFallbackModelsChange(
            sel.scope,
            sel.fallbackModels,
            ctx ?? lastCtx,
          );
          return {
            ...getModelSettingsState(ctx ?? lastCtx),
            notice:
              sel.fallbackModels.length > 0
                ? `Saved ${sel.fallbackModels.length} fallback(s) [${sel.scope}]`
                : `Cleared fallbacks [${sel.scope}]`,
          };
        },
      };
    }

    function purgePendingWakeupsForRun(runId?: string | null): void {
      clearWakeupInFlight();
      if (runId === undefined || runId === null) {
        pendingWakeups.length = 0;
        return;
      }
      for (let i = pendingWakeups.length - 1; i >= 0; i--) {
        const item = pendingWakeups[i]!;
        if (item.runId === runId || item.runId === null) {
          pendingWakeups.splice(i, 1);
        }
      }
    }

    function enqueueWakeupItem(item: PendingWakeupItem): void {
      if (item.type === "kickoff") {
        const existingIdx = pendingWakeups.findIndex(
          (w) => w.type === "kickoff" && w.runId === item.runId,
        );
        if (existingIdx >= 0) {
          pendingWakeups[existingIdx] = item;
        } else {
          pendingWakeups.unshift(item);
        }
        scheduleWakeupFlush();
        return;
      }

      // Coalesce stall_detected + wakeup_needed sharing the same board #seq
      if (item.seq !== undefined) {
        const existingIdx = pendingWakeups.findIndex(
          (w) => w.runId === item.runId && w.seq === item.seq,
        );
        if (existingIdx >= 0) {
          const existing = pendingWakeups[existingIdx]!;
          const mergedBySeq = new Map<number, BoardMessage>();
          for (const m of existing.messages ?? []) {
            mergedBySeq.set(m.seq, m);
          }
          for (const m of item.messages ?? []) {
            mergedBySeq.set(m.seq, m);
          }
          const mergedMessages =
            mergedBySeq.size > 0
              ? Array.from(mergedBySeq.values()).sort((a, b) => a.seq - b.seq)
              : undefined;
          const keepStall =
            item.type === "stall_detected" || existing.type === "stall_detected";
          pendingWakeups[existingIdx] = {
            ...(item.type === "stall_detected" ? item : existing),
            type: keepStall ? "stall_detected" : existing.type,
            ...(mergedMessages ? { messages: mergedMessages } : {}),
          };
          scheduleWakeupFlush();
          return;
        }
      }

      const duplicate = pendingWakeups.some(
        (w) =>
          w.type === item.type &&
          w.runId === item.runId &&
          w.memberName === item.memberName &&
          w.summary === item.summary,
      );
      if (!duplicate) {
        pendingWakeups.push(item);
      }
      scheduleWakeupFlush();
    }

    function scheduleWakeupFlush(ctxOverride?: ExtensionContext): void {
      if (isShutDown || wakeupFlushScheduled || pendingWakeups.length === 0) {
        return;
      }
      wakeupFlushScheduled = true;
      queueMicrotask(() => {
        wakeupFlushScheduled = false;
        flushPendingWakeups(ctxOverride);
      });
    }

    function flushPendingWakeups(ctxOverride?: ExtensionContext): void {
      if (isShutDown || wakeupInFlight || userPromptPreflight || pendingWakeups.length === 0) {
        return;
      }
      // Do not interrupt an interactive planning draft with a background wakeup turn.
      if (draftController.isActive()) {
        return;
      }
      const ctx = ctxOverride ?? lastCtx;
      if (!ctx) {
        return;
      }
      // Strictly dispatch only at idle / settled boundary when no messages are queued.
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return;
      }

      const snapshot = getSnapshotSafe();
      // Never emit ghost wakeups once a run is paused, completed, abandoned, detached, or not owned by this session.
      if (
        !snapshot.run ||
        snapshot.run.status !== "active" ||
        !isCurrentSessionOwner(snapshot.run, ctx)
      ) {
        pendingWakeups.length = 0;
        return;
      }

      const batch = pendingWakeups
        .splice(0, pendingWakeups.length)
        .filter((item) => !item.runId || item.runId === snapshot.activeRunId);
      if (batch.length === 0) {
        return;
      }

      wakeupInFlight = true;
      try {
        const kickoffItem = batch.find((b) => b.type === "kickoff");
        const stallDetected = batch.some((b) => b.type === "stall_detected");

        const lines: string[] = [];
        const runTag = snapshot.activeRunId ? ` (${snapshot.activeRunId})` : "";

        if (kickoffItem?.kickoffBody) {
          lines.push(kickoffItem.kickoffBody);
          const extraEvents = batch.filter((b) => b.type !== "kickoff");
          if (extraEvents.length > 0) {
            lines.push("", "Recent swarm events:");
            for (const item of extraEvents) {
              const seqTag = item.seq !== undefined ? `[#${item.seq}] ` : "";
              lines.push(`- ${seqTag}${item.summary}`);
            }
          }
        } else {
          if (stallDetected) {
            lines.push(`🐝 Pi Swarm Stall Alert${runTag}`);
          } else {
            lines.push(`🐝 Pi Swarm Board Wakeup${runTag}`);
          }

          const seenKeys = new Set<string>();
          const formattedBoardMsgs = new Map<number, BoardMessage>();
          for (const item of batch) {
            if (item.messages) {
              for (const m of item.messages) {
                formattedBoardMsgs.set(m.seq, m);
              }
            }
            const key =
              item.seq !== undefined
                ? `seq:${item.seq}`
                : `${item.type}:${item.memberName ?? ""}:${item.summary}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            const seqTag = item.seq !== undefined ? `[#${item.seq}] ` : "";
            const memberTag = item.memberName ? `@${item.memberName}: ` : "";
            lines.push(`- ${seqTag}${memberTag}${item.summary}`);
          }

          if (formattedBoardMsgs.size > 0) {
            const ordered = Array.from(formattedBoardMsgs.values()).sort((a, b) => a.seq - b.seq);
            lines.push("", "Board messages:");
            for (const msg of ordered) {
              lines.push(formatBoardEntryFull(msg, 2500), "");
            }
          }

          const total = snapshot.run.memberOrder.length;
          const working = snapshot.workingMemberNames.length;
          const waiting = snapshot.waitingMemberNames.length;
          lines.push(
            "",
            `Run status: ${snapshot.run.status} (${working} working, ${waiting} warm waiting / ${total} members, board #${snapshot.boardHead}).`,
          );
          if (stallDetected) {
            lines.push(
              'Inspect recent board posts with `read_board`, wake or add the next phase with `post_message` / `swarm{action:"add"}`, or finish via `swarm{action:"done", summary}`.',
            );
          }
        }

        disarmOrchestratorWait("Flushing orchestrator wakeup");
        pi.sendMessage(
          {
            customType: SWARM_WAKEUP_CUSTOM_TYPE,
            content: lines.join("\n"),
            display: true,
            details: {
              runId: snapshot.activeRunId,
              kickoff: Boolean(kickoffItem),
              stallDetected,
              events: batch.map(({ kickoffBody: _kb, ...rest }) => rest),
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        if (wakeupInFlight) {
          if (wakeupSafetyTimer) {
            clearTimeout(wakeupSafetyTimer);
          }
          wakeupSafetyTimer = setTimeout(() => {
            wakeupInFlight = false;
            wakeupSafetyTimer = undefined;
            scheduleWakeupFlush();
          }, 300);
          wakeupSafetyTimer.unref?.();
        }
      } catch (err) {
        clearWakeupInFlight();
        throw err;
      }
    }

    function handleEngineEvent(ev: SwarmEngineEvent): void {
      if (isShutDown) {
        return;
      }

      if (ev.type === "run_finished") {
        // `completeRun` is initiated explicitly by orchestrator or human; never fire an extra LLM turn.
        invalidateRunsCache();
        if (ev.runId) {
          activatedRunIds.delete(ev.runId);
          resetGoalContinuation(ev.runId);
        }
        if (ev.snapshot.run && isCurrentSessionOwner(ev.snapshot.run, lastCtx)) {
          lastCompletedRunId = ev.snapshot.run.id;
          if (!orchestratorMode) {
            orchestratorMode = true;
          }
          if (lastCtx?.sessionManager && rehydrateFocusState(lastCtx).orchestratorMode !== true) {
            persistCurrentFocus(
              ev.snapshot.run.id,
              getCurrentSessionId(lastCtx),
              "run_finished",
            );
          }
        }
        latestHumanDirection = undefined;
        waitArmedTurnIndex = null;
        purgePendingWakeupsForRun(ev.runId);
        applySwarmToolProfile(pi, computeDesiredToolProfile(lastCtx, ev.snapshot));
        syncActiveRunSections({ ctx: lastCtx });
        clearWorkingMessageAndTitle(lastCtx);
        refreshUI(undefined, ev.snapshot);
        if (
          ev.snapshot.run &&
          !activeDoneFlowRunIds.has(ev.snapshot.run.id) &&
          !completedCardEmittedRunIds.has(ev.snapshot.run.id)
        ) {
          void emitMissionCompleteCardForRun(ev.snapshot.run, {
            summary: ev.snapshot.run.completionSummary ?? ev.summary,
            initiatedBy: "event",
            ctx: lastCtx,
          });
        }
        return;
      }

      if (ev.type === "snapshot_changed") {
        invalidateRunsCache();
      }

      if (ev.snapshot.run === null || isTerminalRunStatus(ev.snapshot.run.status)) {
        applySwarmToolProfile(pi, computeDesiredToolProfile(lastCtx, ev.snapshot));
      }

      refreshUI(undefined, ev.snapshot);

      if (ev.type === "wakeup_needed" || ev.type === "stall_detected") {
        // Only wake while the run is actively executing and owned by this session.
        if (
          ev.snapshot.run?.status !== "active" ||
          !isCurrentSessionOwner(ev.snapshot.run, lastCtx)
        ) {
          return;
        }
        // Smart monitor surgically targeted a specific member -> do NOT wake Orchestrator.
        if (
          ev.type === "stall_detected" &&
          ev.memberName &&
          ev.memberName.toLowerCase() !== ORCHESTRATOR_NAME
        ) {
          return;
        }
        enqueueWakeupItem({
          type: ev.type,
          runId: ev.runId,
          memberName: ev.memberName,
          seq: ev.seq,
          messages: ev.messages,
          summary: ev.summary,
        });
      }
    }

    function ensureBoundSync(ctx?: ExtensionContext): {
      store: ISwarmStore;
      worktree: IWorktreeManager;
      transport: ISwarmTransport;
      engine: ISwarmEngine;
    } {
      if (ctx) {
        lastCtx = ctx;
      }
      const targetCwd = ctx?.cwd ?? lastCtx?.cwd ?? process.cwd();
      if (
        !activeStore ||
        !activeWorktree ||
        !activeTransport ||
        !activeEngine ||
        boundCwd !== targetCwd
      ) {
        if (unsubEngine) {
          unsubEngine();
          unsubEngine = undefined;
        }
        if (activeEngine) {
          const prev = activeEngine;
          activeEngine = undefined;
          void prev.dispose().catch(() => {});
        }

        isShutDown = false;
        boundCwd = targetCwd;
        activeStore = overrides.storeFactory
          ? overrides.storeFactory(targetCwd)
          : new SwarmStore(targetCwd);
        activeWorktree = overrides.worktreeFactory
          ? overrides.worktreeFactory(targetCwd, currentSettings)
          : new WorktreeManager(targetCwd, {
              gitTimeoutMs: currentSettings.gitTimeoutMs,
            });
        activeWorktree?.setGitTimeoutMs?.(currentSettings.gitTimeoutMs);
        activeTransport = overrides.transportFactory
          ? overrides.transportFactory(ctx ?? (lastCtx as ExtensionContext), currentSettings)
          : new InProcessPiTransport();
        const rawStore = activeStore;
        const engineStore = new Proxy(rawStore, {
          get(target, prop) {
            if (prop === "updateMember") {
              return async (runId: string, memberName: string, patch: unknown) => {
                if (readOnlyAttachRunIds.has(runId)) {
                  return target.loadRun(runId);
                }
                return target.updateMember(runId, memberName, patch as never);
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        activeEngine = new SwarmEngine({
          store: engineStore,
          worktree: activeWorktree,
          transport: activeTransport,
          getSettings: () => currentSettings,
          now: overrides.now,
        });
        unsubEngine = activeEngine.subscribe(handleEngineEvent);
      }

      return {
        store: activeStore,
        worktree: activeWorktree,
        transport: activeTransport,
        engine: activeEngine,
      };
    }

    async function ensureBound(ctx: ExtensionContext): Promise<{
      store: ISwarmStore;
      worktree: IWorktreeManager;
      transport: ISwarmTransport;
      engine: ISwarmEngine;
    }> {
      lastCtx = ctx;
      const cwdChanged = boundCwd !== ctx.cwd;
      if (cwdChanged || !activeEngine) {
        await reloadSettings(ctx.cwd);
      }
      return ensureBoundSync(ctx);
    }

    async function mountUI(ctx: ExtensionContext): Promise<void> {
      unbindShortcuts?.();
      unbindShortcuts = undefined;

      if (!ctx.hasUI) {
        return;
      }

      const hostModel = formatHostModelId(ctx.model);
      const baseWidgetFactory = createSwarmWidget(
        () => getSnapshotSafe(),
        widgetState,
        {
          ...(hostModel ? { hostModel } : {}),
          getHostModel: () => formatHostModelId(lastCtx?.model),
          ...overrides.widgetOptions,
        },
      );

      ctx.ui.setWidget(
        SWARM_WIDGET_KEY,
        (tui, theme): Component & { dispose(): void } => {
          activeWidgetTui = tui;
          const inner = baseWidgetFactory(tui, theme);
          return {
            render: (width: number) => inner.render(width),
            invalidate: () => inner.invalidate(),
            dispose: () => {
              if (activeWidgetTui === tui) {
                activeWidgetTui = undefined;
              }
              inner.dispose();
            },
          };
        },
        { placement: "aboveEditor" },
      );

      unbindShortcuts = bindSwarmShortcuts(ctx, {
        isModalOpen: () => isModalOpen(widgetState),
        isExpanded: () => widgetState.expanded,
        isHostStreaming: () => Boolean(lastCtx && !lastCtx.isIdle()),
        onToggleExpand: () => {
          widgetState.expanded = !widgetState.expanded;
          refreshUI(ctx);
        },
        onCollapse: () => {
          if (widgetState.expanded) {
            widgetState.expanded = false;
            refreshUI(ctx);
          }
        },
        onOpenModelPicker: () => {
          void handleModelsCommand("", ctx);
        },
        onOpenMissionControl: () => {
          if (getSnapshotSafe().run) {
            void handleOverlayCommand("", ctx);
          } else {
            void handleBareCommand(ctx);
          }
        },
      });

      refreshUI(ctx);
    }

    async function rehydrateSessionState(ctx: ExtensionContext): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      invalidateRunsCache();
      const prevFocused = engine.getSnapshot().activeRunId;
      const currentSessionId = ctx.sessionManager?.getSessionId?.()?.trim() || "";

      latestHumanDirection = undefined;
      const focusState = rehydrateFocusState(ctx);
      const focusedRunId = focusState.runId;
      if (prevFocused && prevFocused !== focusedRunId) {
        activatedRunIds.delete(prevFocused);
        await releaseRunOwnershipIfHeld(
          store,
          prevFocused,
          currentSessionId || getCurrentSessionId(ctx),
        );
        purgePendingWakeupsForRun(null);
      } else if (focusedRunId !== prevFocused) {
        purgePendingWakeupsForRun(null);
      }
      const startReason = sessionStartReason;
      const allowSamePidFork = startReason === "fork";
      let priorLiveMemberNames = new Set<string>();
      if (focusedRunId) {
        try {
          const loadedRun = await store.loadRun(focusedRunId);
          priorLiveMemberNames = new Set(
            Object.values(loadedRun.members)
              .filter((m) => m.state === "working" || m.state === "waiting")
              .map((m) => m.name),
          );
          const canOwn =
            isCurrentSessionOwner(loadedRun, ctx) ||
            (allowSamePidFork && loadedRun.ownerPid === process.pid);
          const shouldClaimOnRehydrate =
            canOwn &&
            (allowSamePidFork ||
              (Boolean(loadedRun.ownerSessionId) &&
                loadedRun.ownerSessionId === currentSessionId) ||
              (loadedRun.status === "active" &&
                focusState.orchestratorMode !== false) ||
              (loadedRun.status === "paused" &&
                startReason === "resume" &&
                focusState.orchestratorMode !== false &&
                focusState.reason !== "user_focus"));
          if (shouldClaimOnRehydrate) {
            await claimRunOwnershipIfAvailable(
              store,
              engine,
              loadedRun,
              currentSessionId,
              ctx,
              allowSamePidFork,
            );
            await attachRunWithOwnershipGuard(engine, focusedRunId, ctx, false);
          } else {
            await attachRunWithOwnershipGuard(engine, focusedRunId, ctx, true);
          }
        } catch {
          await engine.attachRun(null, ctx);
        }
      } else {
        await engine.attachRun(null, ctx);
      }

      sessionStartReason = undefined;
      const snapshot = engine.getSnapshot();

      const hasFocusedRun = isOwnedLiveRun(snapshot.run, ctx);
      const isOwnFocusEntry = Boolean(
        focusState.hasEntry &&
          focusState.sessionId &&
          focusState.sessionId === currentSessionId,
      );

      if (isOwnFocusEntry && focusState.orchestratorMode !== undefined) {
        orchestratorMode = focusState.orchestratorMode;
        autoConfirmDefault = focusState.orchestratorMode
          ? Boolean(focusState.autoConfirmDefault)
          : false;
      } else if (hasFocusedRun) {
        orchestratorMode = true;
        autoConfirmDefault =
          allowSamePidFork && focusState.orchestratorMode
            ? Boolean(focusState.autoConfirmDefault)
            : false;
      } else {
        orchestratorMode = false;
        autoConfirmDefault = false;
      }

      if (
        snapshot.run?.status === "completed" &&
        (!snapshot.run.ownerSessionId ||
          snapshot.run.ownerSessionId === currentSessionId)
      ) {
        lastCompletedRunId = snapshot.run.id;
      } else if (!orchestratorMode) {
        lastCompletedRunId = null;
      }

      if ((hasFocusedRun && snapshot.run) || orchestratorMode) {
        const runOrch =
          snapshot.run &&
          (hasFocusedRun ||
            (snapshot.run.status === "completed" &&
              snapshot.run.ownerSessionId === currentSessionId))
            ? snapshot.run.roleModels?.orchestrator
            : undefined;
        const hasRunOrchModel = Boolean(runOrch?.model?.trim());
        const effectiveOrchModel =
          runOrch?.model?.trim() || currentSettings.orchestratorModel;
        const effectiveOrchThinking = hasRunOrchModel
          ? runOrch?.thinkingLevel
          : (runOrch?.thinkingLevel ?? currentSettings.orchestratorThinkingLevel);
        if (effectiveOrchModel || effectiveOrchThinking) {
          await applyOrchestratorModelWithSnapshot(
            ctx,
            {
              ...currentSettings,
              orchestratorModel: effectiveOrchModel,
              orchestratorThinkingLevel: effectiveOrchThinking,
            },
            { clearThinking: effectiveOrchThinking === undefined },
          );
        }
      }

      if (hasFocusedRun && snapshot.run) {
        const normalizedStopped = Object.values(snapshot.run.members).filter((m) => {
          if (m.state !== "stopped") {
            return false;
          }
          if (priorLiveMemberNames.has(m.name)) {
            return true;
          }
          return (
            Boolean(startReason) &&
            prevFocused !== snapshot.run!.id &&
            !m.humanStopped &&
            /reloaded|disposed|detached|switched/i.test(m.parkedOn ?? "")
          );
        });
        if (normalizedStopped.length > 0 && ctx.hasUI) {
          const preview = normalizedStopped
            .slice(0, 6)
            .map((m) => `@${m.name}`)
            .join(", ");
          const extra =
            normalizedStopped.length > 6
              ? ` +${normalizedStopped.length - 6} more`
              : "";
          ctx.ui.notify(
            `Rehydrated Swarm Mission "${snapshot.run.title}" (${snapshot.run.id}): ${normalizedStopped.length} worker(s) normalized to stopped (${preview}${extra}) — @mention on board or run /swarm resume to continue.`,
            "info",
          );
        }
      }

      const draft = draftController.rehydrate(ctx, {
        syncToolProfile: true,
        hasActiveRun: hasFocusedRun,
        hasPersistentOrchestrator: orchestratorMode,
      });
      syncDraftWidgetState(draft);
      syncActiveRunSections({ ctx });
      refreshUI(ctx);
    }

    async function disposeRuntime(ctx?: ExtensionContext): Promise<void> {
      isShutDown = true;
      latestHumanDirection = undefined;
      activeRunSections = undefined;
      currentTurnIndex = 0;
      waitArmedTurnIndex = null;
      lastObservedAssistantText = undefined;
      activatedRunIds.clear();
      readOnlyAttachRunIds.clear();
      lastCompletedRunId = null;
      resetGoalContinuation();
      pendingWakeups.length = 0;
      wakeupFlushScheduled = false;
      clearWakeupInFlight();
      clearUserPromptPreflight();

      if (unsubEngine) {
        unsubEngine();
        unsubEngine = undefined;
      }
      if (unbindShortcuts) {
        unbindShortcuts();
        unbindShortcuts = undefined;
      }

      const targetCtx = ctx ?? lastCtx;
      clearWorkingMessageAndTitle(targetCtx);
      if (targetCtx?.hasUI) {
        try {
          targetCtx.ui.setWidget(SWARM_WIDGET_KEY, undefined);
          targetCtx.ui.setStatus(SWARM_STATUS_KEY, undefined);
        } catch {
          // ignore UI teardown errors during shutdown
        }
      }

      activeWidgetTui = undefined;
      lastStatusText = null;
      unfinishedFooterCue = undefined;
      preSwarmHostModel = undefined;
      orchestratorMode = false;
      autoConfirmDefault = false;
      completedCardEmittedRunIds.clear();
      activeDoneFlowRunIds.clear();
      cachedAvailableModels = [];
      runsCache = undefined;
      widgetState.expanded = false;
      widgetState.draftActive = false;
      widgetState.draftMode = undefined;
      widgetState.draftSeed = undefined;
      widgetState.orchestratorStandby = false;
      widgetState.modalDepth = 0;

      const engine = activeEngine;
      activeEngine = undefined;
      activeStore = undefined;
      activeWorktree = undefined;
      activeTransport = undefined;
      boundCwd = undefined;
      fallbackModelRuntimePromise = undefined;

      if (engine) {
        await engine.dispose();
      }
    }

    // ------------------------------------------------------------------------
    // Delegating Proxies for Tool Registrations (Zero Work in Factory Body!)
    // ------------------------------------------------------------------------
    const storeProxy = createDelegatingProxy<ISwarmStore>(
      () => ensureBoundSync().store,
    );
    const worktreeProxy = createDelegatingProxy<IWorktreeManager>(
      () => ensureBoundSync().worktree,
    );

    const MUTATING_ENGINE_METHODS = new Set<string | symbol>([
      "setTitle",
      "updateDirection",
      "addMembers",
      "postMessage",
      "switchModel",
      "steerMember",
      "stopMember",
      "killMember",
      "mergeMember",
      "manageChannel",
      "completeRun",
      "pause",
      "resume",
      "teardown",
    ]);

    async function assertToolEngineOwner(target: ISwarmEngine): Promise<void> {
      const run = target.getSnapshot().run;
      if (run && activeStore) {
        await assertFocusedRunOwner(
          activeStore,
          run.id,
          lastCtx ?? ({ sessionManager: { getSessionId: () => getCurrentSessionId() } } as unknown as ExtensionContext),
        );
      }
    }

    /**
     * Engine proxy passed into the 4 core Swarm tools:
     * - Preserves `orchestratorWait` across `[..., swarm_wait]` multi-tool batches.
     * - Enforces live-session ownership on mutating tool calls.
     * - Deduplicates `readBoard` wakeups precisely and transitions to `"standby"` profile after `completeRun`.
     */
    const toolEngineProxy: ISwarmEngine = new Proxy({} as ISwarmEngine, {
      get(_obj, prop, receiver) {
        const target = ensureBoundSync().engine;
        if (prop === "clearOrchestratorWait") {
          return (reason?: string) => {
            waitArmedTurnIndex = null;
            target.clearOrchestratorWait(reason);
          };
        }
        if (prop === "resume") {
          return async (...args: Parameters<ISwarmEngine["resume"]>) => {
            const resumed = await target.resume(...args);
            notifyEngineHumanInputAwaited(false, target);
            return resumed;
          };
        }
        if (prop === "completeRun") {
          return async (options: Parameters<ISwarmEngine["completeRun"]>[0]) => {
            if (waitArmedTurnIndex !== null && currentTurnIndex > waitArmedTurnIndex) {
              disarmOrchestratorWait("Tool completeRun invoked after swarm_wait turn");
            }
            await assertToolEngineOwner(target);
            const activeRunId = target.getSnapshot().activeRunId;
            if (activeRunId) {
              activeDoneFlowRunIds.add(activeRunId);
            }
            let completed: SwarmRunState;
            try {
              completed = await target.completeRun({
                ...options,
                sessionId: options.sessionId ?? getCurrentSessionId(lastCtx),
              });
            } finally {
              if (activeRunId) {
                activeDoneFlowRunIds.delete(activeRunId);
              }
            }
            if (!orchestratorMode) {
              orchestratorMode = true;
            }
            lastCompletedRunId = completed.id;
            if (
              lastCtx?.sessionManager &&
              rehydrateFocusState(lastCtx).orchestratorMode !== true
            ) {
              persistCurrentFocus(
                completed.id,
                options.sessionId ?? getCurrentSessionId(lastCtx),
                "run_completed",
              );
            }
            waitArmedTurnIndex = null;
            purgePendingWakeupsForRun(completed.id);
            applySwarmToolProfile(pi, computeDesiredToolProfile(lastCtx));
            syncActiveRunSections({ ctx: lastCtx });
            clearWorkingMessageAndTitle(lastCtx);
            await emitMissionCompleteCardForRun(completed, {
              summary: options.summary,
              initiatedBy: "tool",
              ctx: lastCtx,
            });
            refreshUI();
            return completed;
          };
        }
        if (prop === "parkOrchestratorWait") {
          return async (
            options: Parameters<ISwarmEngine["parkOrchestratorWait"]>[0],
          ) => {
            const res = await target.parkOrchestratorWait(options);
            waitArmedTurnIndex = res.parked ? currentTurnIndex : null;
            const activeRunId = target.getSnapshot().activeRunId;
            const seenSeq = res.parked ? options.since : Math.max(options.since, res.head);
            if (activeRunId && Number.isFinite(seenSeq)) {
              for (let i = pendingWakeups.length - 1; i >= 0; i--) {
                const item = pendingWakeups[i]!;
                if (
                  item.type !== "kickoff" &&
                  item.runId === activeRunId &&
                  item.seq !== undefined &&
                  item.seq <= seenSeq
                ) {
                  pendingWakeups.splice(i, 1);
                }
              }
            }
            return res;
          };
        }
        if (prop === "readBoard") {
          return async (options?: Parameters<ISwarmEngine["readBoard"]>[0]) => {
            if (waitArmedTurnIndex !== null && currentTurnIndex > waitArmedTurnIndex) {
              disarmOrchestratorWait("Tool readBoard invoked after swarm_wait turn");
            }
            const res = await target.readBoard(options);
            const activeRunId = target.getSnapshot().activeRunId;
            if (!activeRunId) {
              return res;
            }
            const returnedSeqs = new Set(res.messages.map((m) => m.seq));
            const isEmptyCatchUpSince =
              options?.since !== undefined &&
              (options.limit === undefined || options.limit > 0) &&
              (!options.channel || options.channel.trim() === "*") &&
              !options.search &&
              !options.seqs &&
              res.messages.length === 0 &&
              options.since >= res.head;

            for (let i = pendingWakeups.length - 1; i >= 0; i--) {
              const item = pendingWakeups[i]!;
              if (item.type !== "wakeup_needed" || item.runId !== activeRunId) {
                continue;
              }
              if (
                isEmptyCatchUpSince &&
                item.seq !== undefined &&
                item.seq <= options!.since!
              ) {
                pendingWakeups.splice(i, 1);
                continue;
              }
              if (returnedSeqs.size > 0) {
                if (item.messages && item.messages.length > 0) {
                  item.messages = item.messages.filter(
                    (m) => !returnedSeqs.has(m.seq),
                  );
                }
                if (
                  item.seq !== undefined &&
                  returnedSeqs.has(item.seq) &&
                  (!item.messages || item.messages.length === 0)
                ) {
                  pendingWakeups.splice(i, 1);
                }
              }
            }
            return res;
          };
        }
        if (prop === "manageMission") {
          if (typeof target.manageMission !== "function") {
            return undefined;
          }
          return async (input: ManageMissionInput) => {
            if (waitArmedTurnIndex !== null && currentTurnIndex > waitArmedTurnIndex) {
              disarmOrchestratorWait(
                'Tool "manageMission" invoked after swarm_wait turn',
              );
            }
            if (input?.op !== "status" && input?.op !== "read_library") {
              await assertToolEngineOwner(target);
            }
            return target.manageMission!(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        if (prop === "getSnapshot" || prop === "subscribe") {
          return value.bind(target);
        }
        return async (...args: unknown[]) => {
          if (waitArmedTurnIndex !== null && currentTurnIndex > waitArmedTurnIndex) {
            disarmOrchestratorWait(
              `Tool "${String(prop)}" invoked after swarm_wait turn`,
            );
          }
          if (MUTATING_ENGINE_METHODS.has(prop)) {
            await assertToolEngineOwner(target);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
      has(_obj, prop) {
        return prop in ensureBoundSync().engine;
      },
      ownKeys() {
        return Reflect.ownKeys(ensureBoundSync().engine);
      },
      getOwnPropertyDescriptor(_obj, prop) {
        return Object.getOwnPropertyDescriptor(ensureBoundSync().engine, prop);
      },
    });

    // ------------------------------------------------------------------------
    // Plan Confirmation Callback (`propose_swarm_plan` -> real store/git/engine)
    // ------------------------------------------------------------------------
    async function spawnInitialMembersForRun(
      engine: ISwarmEngine,
      plan: ProposedSwarmPlan,
      toolCtx: ExtensionContext,
      existingMembers?: Record<string, SwarmMemberRecord>,
    ): Promise<{
      spawnedInitial: SwarmMemberRecord[];
      failedInitial: Array<{ name: string; error: string }>;
      firstInitialErr: unknown;
      attemptedCount: number;
    }> {
      const spawnedInitial: SwarmMemberRecord[] = [];
      const failedInitial: Array<{ name: string; error: string }> = [];
      let firstInitialErr: unknown;
      let attemptedCount = 0;

      if (!plan.initialMembers || plan.initialMembers.length === 0) {
        return { spawnedInitial, failedInitial, firstInitialErr, attemptedCount };
      }

      const candidates = existingMembers
        ? plan.initialMembers.filter(
            (m) => !Object.hasOwn(existingMembers, m.name),
          )
        : plan.initialMembers;

      if (candidates.length === 0) {
        return { spawnedInitial, failedInitial, firstInitialErr, attemptedCount };
      }

      const customChannels = new Set<string>();
      for (const memberSpec of candidates) {
        for (const rawCh of memberSpec.channels ?? []) {
          const clean = rawCh.trim().replace(/^[@#]+/, "").toLowerCase();
          if (clean && clean !== DEFAULT_CHANNEL) {
            customChannels.add(clean);
          }
        }
      }
      for (const ch of customChannels) {
        try {
          await engine.manageChannel({
            action: "create",
            name: ch,
            callerName: ORCHESTRATOR_NAME,
            callerRole: "orchestrator",
          });
        } catch {
          // ignore if channel already exists
        }
      }

      for (const memberSpec of candidates) {
        attemptedCount += 1;
        try {
          const added = await engine.addMembers({
            name: memberSpec.name,
            role: memberSpec.role,
            brief: memberSpec.brief,
            workspace: memberSpec.workspace ?? "inherit",
            channels: memberSpec.channels,
            callerName: ORCHESTRATOR_NAME,
            callerRole: "orchestrator",
            hostContext: toolCtx,
          });
          spawnedInitial.push(...added);
        } catch (err) {
          if (firstInitialErr === undefined) {
            firstInitialErr = err;
          }
          failedInitial.push({
            name: memberSpec.name,
            error: formatError(err),
          });
        }
      }

      return { spawnedInitial, failedInitial, firstInitialErr, attemptedCount };
    }

    async function handlePlanConfirmed(
      plan: ProposedSwarmPlan,
      toolCtx: ExtensionContext,
    ): Promise<SwarmRunState> {
      const { store, worktree, engine } = await ensureBound(toolCtx);
      await reloadSettings(toolCtx.cwd);

      // 1. Apply configured Orchestrator model cleanly before launching/revising the run
      await applyOrchestratorModelWithSnapshot(
        toolCtx,
        currentSettings,
      );

      const ownerSessionId = getSessionIdSafe(toolCtx);
      const activeDraft = draftController.getDraft();

      // Tweak mode: revise targetRunId in place
      if (activeDraft?.mode === "tweak" && activeDraft.targetRunId) {
        const targetRunId = activeDraft.targetRunId;
        const existingRun = await store.loadRun(targetRunId);
        if (isTerminalRunStatus(existingRun.status)) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            `Cannot tweak Swarm run "${existingRun.id}" because it is ${existingRun.status}.`,
          );
        }
        await assertFocusedRunOwner(store, existingRun.id, toolCtx);

        const prevFocusedRunId = engine.getSnapshot().activeRunId;
        if (prevFocusedRunId && prevFocusedRunId !== existingRun.id) {
          await releaseRunOwnershipIfHeld(store, prevFocusedRunId, ownerSessionId);
        }

        const nowIso = new Date((overrides.now ?? Date.now)()).toISOString();
        const mergedArtifacts = mergeTweakedMissionContract(
          existingRun,
          plan,
          nowIso,
        );

        let revisedRun = await store.updateRun(existingRun.id, {
          title: plan.title,
          objective: plan.objective,
          strategy: plan.strategy,
          acceptanceCriteria: plan.acceptanceCriteria,
          maxConcurrency: plan.maxConcurrency,
          validatorEnabled: plan.validatorEnabled,
          roleModels: plan.roleModels ?? buildRoleModelsFromSettings(currentSettings),
          ...mergedArtifacts,
          ...(plan.lastAudit !== undefined ? { lastAudit: plan.lastAudit } : {}),
          ownerSessionId,
          ownerPid: process.pid,
          actor: ORCHESTRATOR_NAME,
        });

        await engine.attachRun(revisedRun.id, toolCtx);
        if (revisedRun.status === "paused") {
          revisedRun = await engine.resume(revisedRun.id, toolCtx);
        }

        const { spawnedInitial, failedInitial, firstInitialErr, attemptedCount } =
          await spawnInitialMembersForRun(
            engine,
            plan,
            toolCtx,
            revisedRun.members,
          );

        if (
          attemptedCount > 0 &&
          spawnedInitial.length === 0 &&
          firstInitialErr !== undefined
        ) {
          throw firstInitialErr;
        }

        await engine.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          channel: DEFAULT_CHANNEL,
          kind: "decision",
          text: `@all [decision] Revised Swarm plan: "${revisedRun.title}" — ${revisedRun.objective}`,
        });

        if (!orchestratorMode) {
          orchestratorMode = true;
          autoConfirmDefault = false;
        }
        if (
          prevFocusedRunId !== revisedRun.id ||
          rehydrateFocusState(toolCtx).orchestratorMode !== true
        ) {
          persistCurrentFocus(revisedRun.id, ownerSessionId, "plan_tweaked");
        }

        const finalRun = engine.getSnapshot().run ?? revisedRun;
        activatedRunIds.add(finalRun.id);
        resetGoalContinuation(finalRun.id);
        invalidateRunsCache();
        syncSessionNameForRun(finalRun);
        applySwarmToolProfile(pi, "running");
        syncActiveRunSections({ ctx: toolCtx, ignoreDraft: true });
        refreshUI(toolCtx);

        enqueueWakeupItem({
          type: "kickoff",
          runId: finalRun.id,
          summary: `Revised Dynamic Swarm "${finalRun.title}" (${finalRun.id})`,
          kickoffBody: buildRunKickoffMessage(
            finalRun,
            spawnedInitial,
            failedInitial,
            plan.feedback,
          ),
        });

        return finalRun;
      }

      // 2. Ensure git repo is ready and `.pi/swarm/` is excluded via `.git/info/exclude`
      const ready = await worktree.ensureRepoReady(plan.baseBranch);
      const effectiveBaseBranch = ready.baseBranch || plan.baseBranch;

      // Release previously focused run ownership if switching runs (restored on rollback)
      const prevFocusedRunId = engine.getSnapshot().activeRunId;
      let prevRunBefore: SwarmRunState | null = null;
      let releasedPrevOwnership = false;
      if (prevFocusedRunId) {
        prevRunBefore = await store.loadRun(prevFocusedRunId).catch(() => null);
        if (
          prevRunBefore &&
          prevRunBefore.ownerSessionId === ownerSessionId &&
          prevRunBefore.ownerPid === process.pid
        ) {
          await releaseRunOwnershipIfHeld(store, prevFocusedRunId, ownerSessionId);
          releasedPrevOwnership = true;
        }
      }

      let priorCompletedRunId: string | null = null;
      if (
        prevRunBefore?.status === "completed" &&
        (!prevRunBefore.ownerSessionId ||
          prevRunBefore.ownerSessionId === ownerSessionId)
      ) {
        priorCompletedRunId = prevRunBefore.id;
      } else if (orchestratorMode && lastCompletedRunId) {
        const candidate = await store.loadRun(lastCompletedRunId).catch(() => null);
        if (
          candidate?.status === "completed" &&
          (!candidate.ownerSessionId || candidate.ownerSessionId === ownerSessionId)
        ) {
          priorCompletedRunId = candidate.id;
        }
      } else if (orchestratorMode && ownerSessionId) {
        const recentCompleted = (await listRunsCached(store, true).catch(() => []))
          .slice()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .find(
            (r) =>
              r.status === "completed" && r.ownerSessionId === ownerSessionId,
          );
        if (recentCompleted) {
          priorCompletedRunId = recentCompleted.id;
        }
      }

      // 3. Create v2 Swarm run in store (including Mission-Level TDD artifacts when present)
      const initialMilestones =
        plan.milestones !== undefined || (plan.features && plan.features.length > 0)
          ? derivePlanMilestones(plan.milestones, plan.features, plan.assertions)
          : undefined;
      const createdRun = await store.createRun({
        title: plan.title,
        objective: plan.objective,
        strategy: plan.strategy,
        acceptanceCriteria: plan.acceptanceCriteria,
        baseBranch: effectiveBaseBranch,
        ownerSessionId,
        ownerPid: process.pid,
        maxConcurrency: plan.maxConcurrency,
        validatorEnabled: plan.validatorEnabled,
        keepWorkersWarm: currentSettings.keepWorkersWarm,
        roleModels: plan.roleModels ?? buildRoleModelsFromSettings(currentSettings),
        ...(initialMilestones !== undefined ? { milestones: initialMilestones } : {}),
        ...(plan.assertions !== undefined ? { assertions: plan.assertions } : {}),
        ...(plan.features !== undefined ? { features: plan.features } : {}),
        ...(plan.handoffItems !== undefined ? { handoffItems: plan.handoffItems } : {}),
        ...(plan.commands !== undefined ? { commands: plan.commands } : {}),
        ...(plan.services !== undefined ? { services: plan.services } : {}),
        ...(plan.boundaries !== undefined ? { boundaries: plan.boundaries } : {}),
        ...(plan.lastAudit !== undefined ? { lastAudit: plan.lastAudit } : {}),
      });

      // 3b. Droid Standby Library Carry-Over: copy non-starter library/*.md discoveries from prior completed session run
      if (
        priorCompletedRunId &&
        priorCompletedRunId !== createdRun.id &&
        typeof store.listLibraryTopics === "function" &&
        typeof store.readLibraryTopic === "function" &&
        typeof store.writeLibraryTopic === "function"
      ) {
        try {
          const priorTopics = await store.listLibraryTopics(priorCompletedRunId);
          for (const entry of priorTopics) {
            const topic = entry?.topic;
            if (!topic) continue;
            try {
              const priorContent = await store.readLibraryTopic(
                priorCompletedRunId,
                topic,
              );
              if (
                typeof priorContent !== "string" ||
                priorContent.trim().length === 0
              ) {
                continue;
              }
              const starterContent = await store.readLibraryTopic(
                createdRun.id,
                topic,
              );
              if (
                typeof starterContent === "string" &&
                (priorContent === starterContent ||
                  priorContent.trim() === starterContent.trim())
              ) {
                continue;
              }
              await store.writeLibraryTopic(createdRun.id, topic, priorContent, {
                append: false,
                actor: ORCHESTRATOR_NAME,
              });
            } catch {
              // Best-effort per topic: corrupt/unreadable topic never blocks Run 2 launch
            }
          }
        } catch {
          // Best-effort carryover: missing/corrupt prior library never blocks launching Run 2
        }
      }

      // 4. Attach & start the run in SwarmEngine (defer focus entry until initialMembers settle)
      await engine.startRun(createdRun.id, toolCtx);

      // 5. Pre-create any custom channels referenced by initialMembers, then spawn them immediately
      const { spawnedInitial, failedInitial, firstInitialErr, attemptedCount } =
        await spawnInitialMembersForRun(engine, plan, toolCtx);

      // If ALL initialMembers failed before any started, roll back run cleanly so draft remains intact
      if (
        attemptedCount > 0 &&
        spawnedInitial.length === 0 &&
        firstInitialErr !== undefined
      ) {
        await engine.attachRun(null, toolCtx).catch(() => {});
        await store
          .updateRun(createdRun.id, {
            status: "abandoned",
            actor: ORCHESTRATOR_NAME,
          })
          .catch(() => {});
        if (prevFocusedRunId) {
          if (releasedPrevOwnership) {
            await store
              .updateRun(prevFocusedRunId, {
                ownerPid: process.pid,
                actor: ORCHESTRATOR_NAME,
              })
              .catch(() => {});
          }
          await engine.attachRun(prevFocusedRunId, toolCtx).catch(() => {});
        }
        applySwarmToolProfile(pi, computeDesiredToolProfile(toolCtx));
        syncActiveRunSections({ ctx: toolCtx });
        refreshUI(toolCtx);
        throw firstInitialErr;
      }

      // 6. Activate sticky Persistent Orchestrator Mode & persist session-local focus entry (version: 2)
      if (!orchestratorMode) {
        orchestratorMode = true;
        autoConfirmDefault = Boolean(activeDraft?.autoConfirm);
      }
      persistCurrentFocus(createdRun.id, ownerSessionId, "plan_confirmed");

      const finalRun = engine.getSnapshot().run ?? createdRun;
      activatedRunIds.add(finalRun.id);
      resetGoalContinuation(finalRun.id);
      invalidateRunsCache();
      syncSessionNameForRun(finalRun);

      // 7. Swap tool profile to `"running"` (4 core tools) & refresh UI
      applySwarmToolProfile(pi, "running");
      syncActiveRunSections({ ctx: toolCtx, ignoreDraft: true });
      refreshUI(toolCtx);

      // 8. Schedule a single clean settled-boundary kickoff so Orchestrator immediately coordinates
      enqueueWakeupItem({
        type: "kickoff",
        runId: finalRun.id,
        summary: `Dynamic Swarm "${finalRun.title}" (${finalRun.id}) launched`,
        kickoffBody: buildRunKickoffMessage(
          finalRun,
          spawnedInitial,
          failedInitial,
          plan.feedback,
        ),
      });

      return finalRun;
    }

    // ------------------------------------------------------------------------
    // Ephemeral Read-Only Adversarial Contract Reviewer (`runAdversarialContractReview`)
    // ------------------------------------------------------------------------
    function hasLivePiModelRuntime(ctx: ExtensionContext | undefined): boolean {
      if (!ctx || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
        return false;
      }
      const rawRuntime = (
        ctx.modelRegistry as unknown as { runtime?: unknown } | undefined
      )?.runtime;
      if (!rawRuntime || typeof rawRuntime !== "object") {
        return false;
      }
      return (
        rawRuntime instanceof ModelRuntime ||
        typeof (rawRuntime as { stream?: unknown }).stream === "function"
      );
    }

    async function runAdversarialContractReview(
      plan: ProposedSwarmPlan,
      ctx: ExtensionContext,
      signal?: AbortSignal,
    ): Promise<ContractReviewResult | undefined> {
      if (signal?.aborted) {
        return undefined;
      }
      const customReviewer = overrides.contractReviewer;
      if (!customReviewer) {
        const isLightweightSingleFeaturePlan =
          (plan.features?.length ?? 0) <= 1 &&
          (plan.assertions?.length ?? 0) <= 2 &&
          (plan.services?.length ?? 0) === 0 &&
          (plan.commands?.length ?? 0) === 0;
        if (isLightweightSingleFeaturePlan || !hasLivePiModelRuntime(ctx)) {
          return undefined;
        }
      }

      const prevWorkingMsg =
        lastWorkingMessage ??
        computeSwarmWorkingMessage(getSnapshotSafe(), draftController.isActive());
      const canShowWorkingMsg = Boolean(
        ctx?.hasUI &&
          ctx.mode === "tui" &&
          typeof ctx.ui.setWorkingMessage === "function",
      );
      if (canShowWorkingMsg) {
        try {
          ctx.ui.setWorkingMessage(CONTRACT_REVIEW_WORKING_MESSAGE);
        } catch {
          // ignore UI working message errors
        }
      }

      let handle: PersistentAgentHandle | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      try {
        if (customReviewer) {
          const customOutcome = await Promise.race([
            customReviewer(plan, ctx, signal),
            new Promise<undefined>((resolve) => {
              timeoutTimer = setTimeout(
                () => resolve(undefined),
                CONTRACT_REVIEW_TIMEOUT_MS,
              );
              timeoutTimer.unref?.();
              if (signal) {
                onAbort = () => resolve(undefined);
                signal.addEventListener("abort", onAbort, { once: true });
              }
            }),
          ]);
          return signal?.aborted ? undefined : customOutcome;
        }

        const { transport } = await ensureBound(ctx);
        await reloadSettings(ctx.cwd);

        const rawValidatorModel =
          plan.roleModels?.validator?.model?.trim() ||
          currentSettings.validatorModel?.trim() ||
          undefined;
        const parsedValidatorSpec = rawValidatorModel
          ? parseModelSpec(rawValidatorModel)
          : undefined;
        const reviewerModel =
          parsedValidatorSpec?.model || rawValidatorModel || undefined;
        const reviewerThinking =
          plan.roleModels?.validator?.thinkingLevel ??
          currentSettings.validatorThinkingLevel ??
          parsedValidatorSpec?.thinkingLevel;

        const { systemPrompt, initialPrompt } =
          buildAdversarialContractReviewPrompts(plan);

        const readOnlyReviewBridge: MemberEngineBridge = {
          async postMessage() {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              "Contract reviewer is an ephemeral read-only audit; output <approved/> or <gaps_found>...</gaps_found> directly.",
            );
          },
          async readBoard() {
            return { messages: [], head: 0 };
          },
          async getStatus() {
            return {
              runId: "draft-contract-review",
              title: plan.title,
              status: "active",
              baseBranch: plan.baseBranch,
              boardHead: 0,
              members: [],
              channels: [],
            };
          },
          async listModels() {
            return [];
          },
          async addHelper() {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              "Contract reviewer cannot spawn helpers.",
            );
          },
          async killHelper() {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              "Contract reviewer cannot kill members.",
            );
          },
          async switchModel() {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              "Contract reviewer cannot switch models.",
            );
          },
          async manageChannel() {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              "Contract reviewer cannot manage channels.",
            );
          },
          async manageMission() {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              "Contract reviewer cannot mutate Mission state.",
            );
          },
          async waitForBoard() {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              "Contract reviewer cannot wait on board.",
            );
          },
        };

        const nowMs = (overrides.now ?? Date.now)();
        handle = await transport.spawnMember({
          agentId: `contract-review-${nowMs.toString(36)}`,
          name: "contract-reviewer",
          role: "validator",
          runId: "draft-contract-review",
          cwd: ctx.cwd,
          baseBranch: plan.baseBranch,
          workspace: "inherit",
          parentName: ORCHESTRATOR_NAME,
          brief: "Read-only adversarial contract review",
          systemPrompt,
          initialPrompt,
          keepWarm: false,
          ...(reviewerModel ? { modelOverride: reviewerModel } : {}),
          ...(reviewerThinking ? { thinkingLevel: reviewerThinking } : {}),
          hostContext: ctx,
          engineApi: readOnlyReviewBridge,
        });

        if (signal?.aborted || isShutDown) {
          return undefined;
        }

        const turnResult = await Promise.race([
          handle.currentTurn,
          new Promise<AgentTurnResult | null>((resolve) => {
            timeoutTimer = setTimeout(
              () => resolve(null),
              CONTRACT_REVIEW_TIMEOUT_MS,
            );
            timeoutTimer.unref?.();
            if (signal) {
              onAbort = () => resolve(null);
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }),
        ]);

        if (!turnResult || signal?.aborted) {
          return undefined;
        }
        if (
          turnResult.outcome === "failed" ||
          turnResult.outcome === "rate_limited"
        ) {
          return undefined;
        }

        let candidateText = turnResult.summary?.trim() ?? "";
        const parsedFromSummary = candidateText
          ? parseContractReviewOutput(candidateText)
          : undefined;
        if (parsedFromSummary) {
          return parsedFromSummary;
        }

        const convMsgs = handle.getConversationMessages();
        for (let i = convMsgs.length - 1; i >= 0; i--) {
          const msg = convMsgs[i] as { role?: unknown } | undefined;
          if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
            continue;
          }
          const assistantTxt = extractAgentMessagePlainText(msg)?.trim();
          if (assistantTxt) {
            candidateText = assistantTxt;
            const parsedFromAssistant = parseContractReviewOutput(assistantTxt);
            if (parsedFromAssistant) {
              return parsedFromAssistant;
            }
            break;
          }
        }

        return undefined;
      } catch {
        return undefined;
      } finally {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (onAbort && signal) {
          signal.removeEventListener("abort", onAbort);
        }
        if (handle) {
          await handle
            .kill("Adversarial contract review complete")
            .catch(() => {});
        }
        if (canShowWorkingMsg) {
          try {
            const restoreMsg =
              computeSwarmWorkingMessage(
                getSnapshotSafe(),
                draftController.isActive(),
              ) ?? prevWorkingMsg;
            lastWorkingMessage = restoreMsg;
            ctx.ui.setWorkingMessage(restoreMsg);
          } catch {
            // ignore UI restore errors
          }
        }
      }
    }

    // ------------------------------------------------------------------------
    // Tool Registrations (3 Drafting Tools + 4 Core Swarm Tools = 7 Tools)
    // ------------------------------------------------------------------------
    registerDraftingTools(pi, {
      store: storeProxy,
      worktree: worktreeProxy,
      ui: questionnaireUI,
      getSettings: () => currentSettings,
      onPlanConfirmed: handlePlanConfirmed,
      onModalEnter,
      onModalExit,
      draftController,
      reviewProposedContract: runAdversarialContractReview,
      getDefaultAutoConfirm: () => orchestratorMode && autoConfirmDefault,
      confirmProposalOptions: (toolCtx) => {
        if (!canUseCustomTui(toolCtx)) {
          return {};
        }
        const origins: Partial<Record<SwarmModelRole, RoleModelOrigin>> = {
          orchestrator: getRoleModelOrigin("orchestrator", lastLayeredSettings),
          worker: getRoleModelOrigin("worker", lastLayeredSettings),
          validator: getRoleModelOrigin("validator", lastLayeredSettings),
        };
        const callbacks = makeModelPickerCallbacks(toolCtx);
        return {
          roleModelOrigins: origins,
          onOpenModelPicker: (tui, theme, _initial, onDone) => {
            return new SwarmModelPickerView(tui as TUI, theme as Theme, {
              mode: "roles",
              initialScope: getPreferredSaveScope(),
              state: getModelSettingsState(toolCtx),
              availableModels: cachedAvailableModels,
              ...callbacks,
              onClose: (res) => {
                onDone(
                  res?.changed
                    ? buildRoleModelsFromPickerState(res.state)
                    : undefined,
                );
              },
            });
          },
        };
      },
      onDraftChanged: (draft, toolCtx) => {
        syncDraftWidgetState(draft);
        if (!draft) {
          const nextMode = computeDesiredToolProfile(toolCtx);
          applySwarmToolProfile(pi, nextMode);
          if (nextMode === "idle") {
            clearWorkingMessageAndTitle(toolCtx);
            void restorePreSwarmHostModel(toolCtx);
          } else if (nextMode === "standby") {
            clearWorkingMessageAndTitle(toolCtx);
          }
          scheduleWakeupFlush(toolCtx);
        }
        syncActiveRunSections({ ctx: toolCtx });
        refreshUI(toolCtx);
      },
    });

    registerSwarmTools(pi, {
      engine: toolEngineProxy,
      getCallerRole: () => "orchestrator",
      getCallerName: () => ORCHESTRATOR_NAME,
      onOrchestratorModelSwitch: async (model, thinkingLevel, reason) => {
        const trimmedModel = model.trim();
        const runtimeSettings: SwarmSettings = {
          ...currentSettings,
          orchestratorModel: trimmedModel,
          ...(thinkingLevel !== undefined
            ? { orchestratorThinkingLevel: thinkingLevel }
            : {}),
        };
        const orchestratorApply = await applyOrchestratorModel(
          pi,
          lastCtx,
          runtimeSettings,
          getLazyFallbackModelRuntime,
        );
        if (!orchestratorApply.applied && orchestratorApply.warning) {
          throw new SwarmProtocolError("MODEL_NOT_FOUND", orchestratorApply.warning, {
            model: trimmedModel,
          });
        }
        const hostModelId = formatHostModelId(lastCtx?.model);
        const effectiveModel =
          orchestratorApply.model?.trim() || trimmedModel || hostModelId || "";
        const appliedThinking = orchestratorApply.thinkingLevel ?? thinkingLevel;
        const engine = activeEngine;
        const snapRun = engine?.getSnapshot().run;
        if (engine && snapRun) {
          if (effectiveModel) {
            await engine.switchModel({
              targetName: ORCHESTRATOR_NAME,
              model: effectiveModel,
              thinkingLevel: appliedThinking,
              reason,
              callerName: ORCHESTRATOR_NAME,
              callerRole: "orchestrator",
              hostContext: lastCtx,
            });
          } else if (appliedThinking !== undefined && activeStore) {
            await activeStore.updateRun(snapRun.id, {
              roleModels: {
                ...snapRun.roleModels,
                orchestrator: {
                  ...snapRun.roleModels.orchestrator,
                  thinkingLevel: appliedThinking,
                },
              },
              actor: ORCHESTRATOR_NAME,
            });
            await engine.attachRun(snapRun.id, lastCtx);
          }
        }
        refreshUI(lastCtx);
        return {
          targetName: ORCHESTRATOR_NAME,
          model: effectiveModel || "host-default",
          thinkingLevel: appliedThinking,
        };
      },
    });

    // ------------------------------------------------------------------------
    // Command Sub-Handlers
    // ------------------------------------------------------------------------

    async function resolveBaseBranchSafe(
      worktree: IWorktreeManager,
      cwd: string,
    ): Promise<string> {
      try {
        const branch = (await worktree.getCurrentBranch(cwd)).trim();
        if (branch && branch !== "HEAD") {
          return branch;
        }
      } catch {
        // Repo might not exist yet; default to main until ensureRepoReady runs.
      }
      return "main";
    }

    interface ExplicitDraftOverrides {
      validatorEnabled?: boolean;
      maxConcurrency?: number;
      baseBranch?: string;
      skipContractReview?: boolean;
    }

    interface LaunchStartOptions extends ExplicitDraftOverrides {
      /** True for CLI invocations (`/swarm <goal>`, `/swarm direct`, `/swarm-direct`). */
      fromCli?: boolean;
      /** Skip leading flag parsing when user already escaped via `/swarm -- ...`. */
      skipFlagParsing?: boolean;
    }

    async function prepareGoalLaunchInput(
      rawInput: string,
      ctx: ExtensionContext,
      options?: LaunchStartOptions,
    ): Promise<
      | { ok: false }
      | { ok: true; seed: string; overrides: ExplicitDraftOverrides }
    > {
      let goalText = rawInput;
      let files: string[] | undefined;
      const resolvedOverrides: ExplicitDraftOverrides = {
        ...(options?.validatorEnabled !== undefined
          ? { validatorEnabled: options.validatorEnabled }
          : {}),
        ...(options?.maxConcurrency !== undefined
          ? { maxConcurrency: options.maxConcurrency }
          : {}),
        ...(options?.baseBranch !== undefined
          ? { baseBranch: options.baseBranch }
          : {}),
        ...(options?.skipContractReview !== undefined
          ? { skipContractReview: options.skipContractReview }
          : {}),
      };

      if (options?.fromCli && !options.skipFlagParsing) {
        const parsedFlags = parseSwarmGoalLaunchOptions(rawInput);
        if (parsedFlags.error) {
          if (ctx.hasUI) {
            ctx.ui.notify(parsedFlags.error, "warning");
          } else {
            emitZeroTurnMessage(ctx, parsedFlags.error);
          }
          return { ok: false };
        }
        goalText = parsedFlags.goal;
        files = parsedFlags.files;
        if (parsedFlags.validatorEnabled !== undefined) {
          resolvedOverrides.validatorEnabled = parsedFlags.validatorEnabled;
        }
        if (parsedFlags.maxConcurrency !== undefined) {
          resolvedOverrides.maxConcurrency = parsedFlags.maxConcurrency;
        }
        if (parsedFlags.baseBranch !== undefined) {
          resolvedOverrides.baseBranch = parsedFlags.baseBranch;
        }
        if (parsedFlags.skipContractReview !== undefined) {
          resolvedOverrides.skipContractReview = parsedFlags.skipContractReview;
        }
      }

      if (options?.fromCli) {
        const specRes = await resolveGoalSpecFiles(ctx.cwd, goalText, files);
        if (specRes.error) {
          if (ctx.hasUI) {
            ctx.ui.notify(specRes.error, "error");
          } else {
            emitZeroTurnMessage(ctx, specRes.error);
          }
          return { ok: false };
        }
        return { ok: true, seed: specRes.seed, overrides: resolvedOverrides };
      }

      return { ok: true, seed: goalText.trim(), overrides: resolvedOverrides };
    }

    async function promptActiveRunGoalConflict(
      ctx: ExtensionContext,
      resolvedSeed: string,
      explicitOverrides: ExplicitDraftOverrides,
    ): Promise<"proceed" | "handled"> {
      if (!ctx.hasUI) {
        return "proceed";
      }
      const focusedRun = getSnapshotSafe().run;
      if (
        !focusedRun ||
        (focusedRun.status !== "active" && focusedRun.status !== "paused")
      ) {
        return "proceed";
      }

      const tweakChoice =
        "Tweak current run — add this goal to the focused Swarm";
      const newSwarmChoice =
        "Start new Swarm — launch a separate Swarm run";
      const cancelChoice = "Cancel — keep current Swarm unchanged";
      const runSnippet = (focusedRun.title || focusedRun.objective).slice(0, 48);
      const title = `Swarm "${runSnippet}" (${focusedRun.id} · ${focusedRun.status}) is ${focusedRun.status}. How do you want to proceed?`;

      const picked = await withModalGuard(() =>
        ctx.ui.select(title, [tweakChoice, newSwarmChoice, cancelChoice]),
      );

      if (picked === tweakChoice) {
        await handleTweakCommand(resolvedSeed, ctx, explicitOverrides);
        return "handled";
      }
      if (picked === newSwarmChoice) {
        return "proceed";
      }
      ctx.ui.notify("Kept active Swarm run unchanged.", "info");
      return "handled";
    }

    async function startInteractiveDrafting(
      rawSeed: string,
      ctx: ExtensionContext,
      options?: LaunchStartOptions,
    ): Promise<void> {
      const { worktree } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);

      const prepared = await prepareGoalLaunchInput(rawSeed, ctx, options);
      if (!prepared.ok) {
        return;
      }

      if (options?.fromCli) {
        const conflictDecision = await promptActiveRunGoalConflict(
          ctx,
          prepared.seed,
          prepared.overrides,
        );
        if (conflictDecision === "handled") {
          return;
        }
      }

      void refreshAvailableModels(ctx);
      await applyOrchestratorModelWithSnapshot(
        ctx,
        currentSettings,
      );

      const defaultBaseBranch = await resolveBaseBranchSafe(worktree, ctx.cwd);
      const startOptions: StartDraftOptions = {
        mode: "swarm",
        seed: prepared.seed,
        ...(prepared.overrides.validatorEnabled !== undefined
          ? { validatorEnabled: prepared.overrides.validatorEnabled }
          : {}),
        ...(prepared.overrides.maxConcurrency !== undefined
          ? { maxConcurrency: prepared.overrides.maxConcurrency }
          : {}),
        ...(prepared.overrides.baseBranch !== undefined
          ? { baseBranch: prepared.overrides.baseBranch }
          : {}),
        ...(prepared.overrides.skipContractReview !== undefined
          ? { skipContractReview: prepared.overrides.skipContractReview }
          : {}),
      };

      const res = await draftController.startOrResolve(ctx, startOptions, {
        defaultBaseBranch,
      });

      if (res.action === "cancelled" || !res.draft) {
        if (ctx.hasUI) {
          ctx.ui.notify("Kept current Swarm draft state unchanged.", "info");
        }
        return;
      }

      if (res.action === "appended" && ctx.hasUI) {
        ctx.ui.notify("Appended new goal details to active Swarm draft.", "info");
      }

      syncDraftWidgetState(res.draft);
      if (!ctx.isIdle()) {
        syncActiveRunSections({ ctx });
      }
      refreshUI(ctx);

      const focusedRun = getSnapshotSafe().run;
      const targetRun =
        res.draft.mode === "tweak" &&
        focusedRun &&
        focusedRun.id === res.draft.targetRunId
          ? {
              id: focusedRun.id,
              title: focusedRun.title,
              objective: focusedRun.objective,
              baseBranch: focusedRun.baseBranch,
              memberCount: focusedRun.memberOrder.length,
            }
          : undefined;

      const kickoffPrompt = buildDraftingKickoffPrompt(res.draft.seed, res.draft.mode, {
        baseBranch: res.draft.baseBranch ?? defaultBaseBranch,
        maxConcurrency: res.draft.maxConcurrency,
        validatorEnabled: res.draft.validatorEnabled,
        skipContractReview: res.draft.skipContractReview,
        roleModels: buildRoleModelsFromSettings(currentSettings),
        ...(targetRun ? { targetRun } : {}),
        existingEcho: res.draft.questionnaireEcho,
      });

      pi.sendUserMessage(kickoffPrompt, {
        deliverAs: ctx.isIdle() ? "followUp" : "steer",
        expandPromptTemplates: false,
      });
    }

    async function startDirectSwarm(
      rawGoal: string,
      ctx: ExtensionContext,
      options?: LaunchStartOptions,
    ): Promise<void> {
      const { worktree } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);

      const prepared = await prepareGoalLaunchInput(rawGoal, ctx, options);
      if (!prepared.ok) {
        return;
      }

      if (options?.fromCli) {
        const conflictDecision = await promptActiveRunGoalConflict(
          ctx,
          prepared.seed,
          prepared.overrides,
        );
        if (conflictDecision === "handled") {
          return;
        }
      }

      void refreshAvailableModels(ctx);

      let goal = prepared.seed.trim();
      if (!goal && ctx.hasUI) {
        const entered = await withModalGuard(() =>
          ctx.ui.input("🐝 Swarm Direct Objective", "Describe what the swarm should build…"),
        );
        goal = entered?.trim() ?? "";
      }
      if (!goal) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /swarm direct [flags] [--] <goal>", "warning");
        } else {
          emitZeroTurnMessage(ctx, "Usage: `/swarm direct [flags] [--] <goal>`");
        }
        return;
      }

      await applyOrchestratorModelWithSnapshot(
        ctx,
        currentSettings,
      );

      const defaultBaseBranch = await resolveBaseBranchSafe(worktree, ctx.cwd);
      const startOptions: StartDraftOptions = {
        mode: "swarm",
        seed: goal,
        autoConfirm: true,
        ...(prepared.overrides.validatorEnabled !== undefined
          ? { validatorEnabled: prepared.overrides.validatorEnabled }
          : {}),
        ...(prepared.overrides.maxConcurrency !== undefined
          ? { maxConcurrency: prepared.overrides.maxConcurrency }
          : {}),
        ...(prepared.overrides.baseBranch !== undefined
          ? { baseBranch: prepared.overrides.baseBranch }
          : {}),
        ...(prepared.overrides.skipContractReview !== undefined
          ? { skipContractReview: prepared.overrides.skipContractReview }
          : {}),
      };

      const res = await draftController.startOrResolve(ctx, startOptions, {
        defaultBaseBranch,
      });

      if (res.action === "cancelled" || !res.draft) {
        if (ctx.hasUI) {
          ctx.ui.notify("Cancelled /swarm direct launch.", "info");
        }
        return;
      }

      if (res.action === "appended" && ctx.hasUI) {
        ctx.ui.notify("Appended new goal details to active Swarm draft.", "info");
      }

      let activeDraft = res.draft;
      if (!activeDraft.autoConfirm) {
        activeDraft =
          draftController.update({
            autoConfirm: true,
            ...(prepared.overrides.validatorEnabled !== undefined
              ? { validatorEnabled: prepared.overrides.validatorEnabled }
              : {}),
            ...(prepared.overrides.maxConcurrency !== undefined
              ? { maxConcurrency: prepared.overrides.maxConcurrency }
              : {}),
            ...(prepared.overrides.baseBranch !== undefined
              ? { baseBranch: prepared.overrides.baseBranch }
              : {}),
            ...(prepared.overrides.skipContractReview !== undefined
              ? { skipContractReview: prepared.overrides.skipContractReview }
              : {}),
          }) ?? activeDraft;
      }

      syncDraftWidgetState(activeDraft);
      if (!ctx.isIdle()) {
        syncActiveRunSections({ ctx });
      }
      refreshUI(ctx);

      const directPrompt = buildDirectPlanPrompt(
        activeDraft.seed,
        activeDraft.baseBranch ?? defaultBaseBranch,
        {
          maxConcurrency: activeDraft.maxConcurrency,
          validatorEnabled: activeDraft.validatorEnabled,
        },
        { skipContractReview: activeDraft.skipContractReview },
      );
      pi.sendUserMessage(directPrompt, {
        deliverAs: ctx.isIdle() ? "followUp" : "steer",
        expandPromptTemplates: false,
      });
    }

    async function handleTweakCommand(
      rawSeed: string,
      ctx: ExtensionContext,
      explicitOverrides?: ExplicitDraftOverrides,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);
      void refreshAvailableModels(ctx);

      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to tweak. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }
      if (isTerminalRunStatus(snapshot.run.status)) {
        const msg = `Cannot tweak Swarm run \`${snapshot.run.id}\` because it is already ${snapshot.run.status}.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        await assertFocusedRunOwner(store, snapshot.run.id, ctx);
      } catch (err) {
        const msg = `Tweak failed: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const run = snapshot.run;
      await applyOrchestratorModelWithSnapshot(
        ctx,
        currentSettings,
      );

      const seed = rawSeed.trim() || run.objective;
      const tweakStartOptions: StartDraftOptions = {
        mode: "tweak",
        seed,
        targetRunId: run.id,
        ...(explicitOverrides?.validatorEnabled !== undefined
          ? { validatorEnabled: explicitOverrides.validatorEnabled }
          : {}),
        ...(explicitOverrides?.maxConcurrency !== undefined
          ? { maxConcurrency: explicitOverrides.maxConcurrency }
          : {}),
        ...(explicitOverrides?.baseBranch !== undefined
          ? { baseBranch: explicitOverrides.baseBranch }
          : {}),
        ...(explicitOverrides?.skipContractReview !== undefined
          ? { skipContractReview: explicitOverrides.skipContractReview }
          : {}),
      };
      const res = await draftController.startOrResolve(ctx, tweakStartOptions, {
        settings: {
          validatorEnabled: run.validatorEnabled,
          maxConcurrency: run.maxConcurrency,
        },
        defaultBaseBranch: run.baseBranch,
      });

      if (res.action === "cancelled" || !res.draft) {
        if (ctx.hasUI) {
          ctx.ui.notify("Kept current Swarm draft state unchanged.", "info");
        }
        return;
      }

      if (res.action === "appended" && ctx.hasUI) {
        ctx.ui.notify("Appended new goal details to active Swarm draft.", "info");
      }

      syncDraftWidgetState(res.draft);
      if (!ctx.isIdle()) {
        syncActiveRunSections({ ctx });
      }
      refreshUI(ctx);

      const effectiveMode = res.draft.mode;
      const kickoffPrompt =
        effectiveMode === "tweak"
          ? buildDraftingKickoffPrompt(res.draft.seed, "tweak", {
              baseBranch: res.draft.baseBranch ?? run.baseBranch,
              maxConcurrency: res.draft.maxConcurrency,
              validatorEnabled: res.draft.validatorEnabled,
              skipContractReview: res.draft.skipContractReview,
              roleModels: buildRoleModelsFromSettings(currentSettings),
              targetRun: {
                id: run.id,
                title: run.title,
                objective: run.objective,
                baseBranch: run.baseBranch,
                memberCount: run.memberOrder.length,
              },
              existingEcho: res.draft.questionnaireEcho,
            })
          : buildDraftingKickoffPrompt(res.draft.seed, effectiveMode, {
              baseBranch: res.draft.baseBranch ?? run.baseBranch,
              maxConcurrency: res.draft.maxConcurrency,
              validatorEnabled: res.draft.validatorEnabled,
              skipContractReview: res.draft.skipContractReview,
              roleModels: buildRoleModelsFromSettings(currentSettings),
              existingEcho: res.draft.questionnaireEcho,
            });

      pi.sendUserMessage(kickoffPrompt, {
        deliverAs: ctx.isIdle() ? "followUp" : "steer",
        expandPromptTemplates: false,
      });
    }

    async function handleStatusCommand(ctx: ExtensionContext): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const current = engine.getSnapshot();
      const snapshot = current.activeRunId
        ? await engine.attachRun(current.activeRunId, ctx).catch(() => current)
        : current;
      const draft = draftController.getDraft();
      const orchestratorStandby = isOrchestratorStandby(ctx, snapshot);
      const markdown = formatZeroTurnStatusDashboard(snapshot, {
        draftActive: isDraftActive(draft),
        draftSeed: draft?.seed,
        orchestratorStandby,
        hostModel: formatHostModelId(ctx.model),
        now: overrides.now,
      });
      emitZeroTurnMessage(ctx, markdown, {
        runId: snapshot.activeRunId,
        draftActive: isDraftActive(draft),
        orchestratorStandby,
      });
    }

    async function handleBoardCommand(
      rawArgs: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run || !snapshot.activeRunId) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const parsed = parseBoardArgs(rawArgs);
      if (parsed.error) {
        if (ctx.hasUI) ctx.ui.notify(parsed.error, "warning");
        else emitZeroTurnMessage(ctx, parsed.error);
        return;
      }

      try {
        const { messages, head } = await engine.readBoard({
          limit: parsed.limit,
          channel: parsed.channel ?? "*",
          ...(parsed.search ? { search: parsed.search } : {}),
        });
        const markdown = formatZeroTurnBoardView(messages, head, {
          runId: snapshot.activeRunId,
          ...(parsed.channel ? { channel: parsed.channel } : {}),
        });
        emitZeroTurnMessage(ctx, markdown, {
          runId: snapshot.activeRunId,
          head,
          count: messages.length,
          ...(parsed.channel ? { channel: parsed.channel } : {}),
          ...(parsed.search ? { search: parsed.search } : {}),
        });
      } catch (err) {
        const msg = `Failed to read Swarm board: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleGraphCommand(ctx: ExtensionContext): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const current = engine.getSnapshot();
      const snapshot = current.activeRunId
        ? await engine.attachRun(current.activeRunId, ctx).catch(() => current)
        : current;

      if (!snapshot.run || !snapshot.activeRunId) {
        emitZeroTurnMessage(ctx, formatZeroTurnGraphView(snapshot));
        return;
      }

      const boardRes = await engine
        .readBoard({ channel: "*", limit: 200 })
        .catch(() => ({ messages: snapshot.recentBoard, head: snapshot.boardHead }));

      const width = Math.max(40, Math.min(88, (process.stdout.columns ?? 88) - 4));
      const markdown = formatZeroTurnGraphView(snapshot, {
        board: boardRes.messages,
        width,
      });
      emitZeroTurnMessage(ctx, markdown, {
        runId: snapshot.activeRunId,
        boardHead: boardRes.head,
        memberCount: snapshot.run.memberOrder.length,
      });
    }

    async function handleOverlayCommand(
      rawArg: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { store, engine, worktree } = await ensureBound(ctx);
      if (!ctx.hasUI) {
        await handleStatusCommand(ctx);
        return;
      }

      const current = engine.getSnapshot();
      if (current.activeRunId) {
        await engine.attachRun(current.activeRunId, ctx).catch(() => {});
      }

      const arg = rawArg.trim();
      const lower = arg.toLowerCase();
      let initialTab: SwarmOverlayTab | undefined;
      let initialGraphView: SwarmOverlayGraphView | undefined;
      let initialMemberName: string | undefined;
      let initialChannel: string | undefined;

      if (arg) {
        if (OVERLAY_TABS.has(lower as SwarmOverlayTab)) {
          initialTab = lower as SwarmOverlayTab;
        } else if (
          lower === "contract" ||
          lower === "mission" ||
          lower === "features"
        ) {
          initialTab = "graph";
          initialGraphView = "contract";
        } else if (arg.startsWith("#") && arg.length > 1) {
          initialTab = "board";
          initialChannel = arg.slice(1).toLowerCase();
        } else {
          const cleanName = arg.replace(/^@/, "");
          const run = engine.getSnapshot().run;
          const match = run
            ? Object.values(run.members).find(
                (m) => m.name.toLowerCase() === cleanName.toLowerCase(),
              )
            : undefined;
          if (match) {
            initialTab = "members";
            initialMemberName = match.name;
          }
        }
      }

      const overlayEngine: ISwarmEngine = new Proxy(engine, {
        get(target, prop) {
          if (prop === "manageMission") {
            if (typeof target.manageMission !== "function") {
              return undefined;
            }
            return async (input: ManageMissionInput) => {
              if (input?.op !== "status" && input?.op !== "read_library") {
                const snap = target.getSnapshot();
                if (snap.run) {
                  await assertFocusedRunOwner(store, snap.run.id, ctx);
                }
              }
              return target.manageMission!(input);
            };
          }
          const value = Reflect.get(target, prop, target);
          if (typeof value !== "function") {
            return value;
          }
          if (MUTATING_ENGINE_METHODS.has(prop)) {
            return async (...args: unknown[]) => {
              const snap = target.getSnapshot();
              if (snap.run) {
                await assertFocusedRunOwner(store, snap.run.id, ctx);
              }
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value.bind(target);
        },
      });

      const availableModels = canUseCustomTui(ctx)
        ? await refreshAvailableModels(ctx, true)
        : cachedAvailableModels;
      const modelCallbacks = makeModelPickerCallbacks(ctx);

      await openSwarmOverlay(ctx, overlayEngine, worktree, {
        onModalEnter,
        onModalExit,
        initialScope: getPreferredSaveScope(),
        ...(initialTab ? { initialTab } : {}),
        ...(initialGraphView ? { initialGraphView } : {}),
        ...(initialMemberName ? { initialMemberName } : {}),
        ...(initialChannel ? { initialChannel } : {}),
        hostModel: formatHostModelId(ctx.model),
        availableModels,
        getModelSettingsState: () => getModelSettingsState(ctx),
        onApplyRoleModel: modelCallbacks.onApplyRole,
        onApplyFallbacks: modelCallbacks.onApplyFallbacks,
        now: overrides.now,
      });
      refreshUI(ctx);
    }

    async function handleModelsCommand(
      rawArgs: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { engine } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);

      const tokens = tokenizeCommandArgs(rawArgs.trim());
      let printOnly = false;
      const positional: string[] = [];
      let hasClear = false;
      for (const tok of tokens) {
        const lower = tok.toLowerCase();
        if (lower === "--print" || lower === "-p") {
          printOnly = true;
        } else if (lower === "--clear") {
          hasClear = true;
        } else if (
          lower === "--global" ||
          lower === "-g" ||
          lower === "--project"
        ) {
          // passed through when delegating to handleModelCommand
        } else {
          positional.push(tok);
        }
      }

      if (positional.length >= 2 || (positional.length >= 1 && hasClear)) {
        await handleModelCommand(rawArgs, ctx);
        return;
      }

      if (printOnly || !canUseCustomTui(ctx)) {
        const current = engine.getSnapshot();
        const snapshot = current.activeRunId
          ? await engine.attachRun(current.activeRunId, ctx).catch(() => current)
          : current;
        const hostModel = formatHostModelId(ctx.model);
        const markdown = formatZeroTurnModelsView(currentSettings, snapshot, hostModel);
        emitZeroTurnMessage(ctx, markdown, {
          runId: snapshot.activeRunId,
          hostModel,
          roleModels: buildRoleModelsFromSettings(currentSettings),
        });
        return;
      }

      const availableModels = await refreshAvailableModels(ctx, true);
      const callbacks = makeModelPickerCallbacks(ctx);
      const arg = positional[0]?.replace(/^@/, "").trim();
      const argLower = arg?.toLowerCase();

      const run = engine.getSnapshot().run;
      const matchedMember =
        arg && run
          ? Object.values(run.members).find(
              (m) => m.name.toLowerCase() === argLower && m.state !== "killed",
            )
          : undefined;

      if (matchedMember && (!isSwarmModelRole(argLower ?? "") || positional[0]?.startsWith("@"))) {
        await withModalGuard(() =>
          openSwarmModelPicker(ctx, {
            mode: "member",
            member: matchedMember,
            state: getModelSettingsState(ctx),
            availableModels,
            onApplyMember: async (sel) => {
              const res = await engine.switchModel({
                targetName: sel.memberName,
                model: sel.model,
                thinkingLevel: sel.thinkingLevel,
                callerName: "human",
                callerRole: "human",
                autoResume: false,
                deferIfWorking: true,
                hostContext: ctx,
              });
              refreshUI(ctx);
              return {
                notice: res.deferred
                  ? `Queued @${res.targetName} -> ${res.model} at turn end`
                  : `Switched @${res.targetName} -> ${res.model}`,
              };
            },
          }),
        );
        return;
      }

      const initialTab: ModelPickerTab =
        argLower === "worker" ||
        argLower === "validator" ||
        argLower === "fallbacks" ||
        argLower === "orchestrator"
          ? argLower
          : "orchestrator";

      await withModalGuard(() =>
        openSwarmModelPicker(ctx, {
          mode: "roles",
          initialTab,
          initialScope: getPreferredSaveScope(),
          state: getModelSettingsState(ctx),
          availableModels,
          ...callbacks,
        }),
      );
      refreshUI(ctx);
    }

    async function handleModelCommand(
      rawArgs: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);
      const { explicitScope, clearFlag, words } = parseModelCommandShape(rawArgs);

      if (words.length === 0) {
        await handleModelsCommand("", ctx);
        return;
      }

      if (words.length === 1 && !clearFlag) {
        if (canUseCustomTui(ctx)) {
          await handleModelsCommand(words[0]!, ctx);
          return;
        }
        const usage =
          "Usage: `/swarm model <orchestrator|worker|validator|@member> <model[:thinking]|default> [thinking] [--global]`";
        if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        emitZeroTurnMessage(ctx, usage);
        return;
      }

      const rawTarget = words[0]!;
      const hasExplicitAt = rawTarget.startsWith("@");
      const target = rawTarget.replace(/^@/, "").trim();
      const rawModelAndThinking = clearFlag ? "default" : words.slice(1).join(" ").trim();
      if (!target || !rawModelAndThinking) {
        const usage =
          "Usage: `/swarm model <orchestrator|worker|validator|@member> <model[:thinking]|default> [thinking] [--global]`";
        if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        emitZeroTurnMessage(ctx, usage);
        return;
      }

      let modelArg = rawModelAndThinking;
      let thinkingLevel: ThinkingLevel | undefined;
      const isClearing = CLEAR_MODEL_TOKENS.has(rawModelAndThinking.toLowerCase());

      if (!isClearing) {
        const spaceParts = rawModelAndThinking.split(/\s+/).filter(Boolean);
        if (spaceParts.length >= 2) {
          const tail = spaceParts[spaceParts.length - 1]!;
          if (!isThinkingLevel(tail.toLowerCase())) {
            const msg = `Invalid thinking level "${tail}". Valid values: off, minimal, low, medium, high, xhigh, max.`;
            if (ctx.hasUI) ctx.ui.notify(msg, "error");
            else emitZeroTurnMessage(ctx, msg);
            return;
          }
        }
        const parsedSpec = parseModelSpec(rawModelAndThinking);
        modelArg = parsedSpec.model;
        thinkingLevel = parsedSpec.thinkingLevel;
      }

      const targetLower = target.toLowerCase();
      const snapshot = engine.getSnapshot();
      const runMemberMatch = snapshot.run
        ? Object.values(snapshot.run.members).find(
            (m) => m.name.toLowerCase() === targetLower && m.state !== "killed",
          )
        : undefined;
      const treatAsRole =
        isSwarmModelRole(targetLower) && !(hasExplicitAt && runMemberMatch);

      if (treatAsRole) {
        const scope = explicitScope ?? "project";
        try {
          const { settings: updatedSettings, orchestratorApply, propagated } =
            await applyRoleModelChange(
              targetLower,
              isClearing ? undefined : modelArg,
              thinkingLevel,
              ctx,
              { scope, updateRun: true },
            );

          const appliedModelId =
            targetLower === "orchestrator"
              ? updatedSettings.orchestratorModel
              : targetLower === "worker"
                ? updatedSettings.workerModel
                : updatedSettings.validatorModel;
          const appliedThinking =
            targetLower === "orchestrator"
              ? updatedSettings.orchestratorThinkingLevel
              : targetLower === "worker"
                ? updatedSettings.workerThinkingLevel
                : updatedSettings.validatorThinkingLevel;

          const modelDesc = isClearing
            ? "host default"
            : `\`${appliedModelId ?? modelArg}\`${appliedThinking ? ` (thinking: \`${appliedThinking}\`)` : ""}`;
          const applySuffix =
            targetLower === "orchestrator" && orchestratorApply?.warning
              ? `\n- ⚠ ${orchestratorApply.warning}`
              : "";
          const propParts: string[] = [];
          if (propagated && propagated.switched.length > 0) {
            propParts.push(
              `Switched ${propagated.switched.map((n) => `\`@${n}\``).join(", ")}.`,
            );
          }
          if (propagated && propagated.deferred.length > 0) {
            propParts.push(
              `Queued turn-end switch for ${propagated.deferred.map((n) => `\`@${n}\``).join(", ")}.`,
            );
          }
          const propSuffix = propParts.length > 0 ? ` ${propParts.join(" ")}` : "";
          const msg = isClearing
            ? `Cleared \`${targetLower}\` role model back to **host default** (saved to ${scope} settings).`
            : `Updated \`${targetLower}\` role default model to ${modelDesc} (saved to ${scope} settings).${propSuffix}${applySuffix}`;

          if (ctx.hasUI) {
            ctx.ui.notify(
              isClearing
                ? `Cleared ${targetLower} model to host default (${scope}).`
                : `Set ${targetLower} model -> ${appliedModelId ?? modelArg}${appliedThinking ? ` (${appliedThinking})` : ""} (${scope}).`,
              "info",
            );
          }
          emitZeroTurnMessage(ctx, `✓ ${msg}`, {
            target: targetLower,
            scope: "role_default",
            saveScope: scope,
            model: isClearing ? null : (appliedModelId ?? modelArg),
            thinkingLevel: appliedThinking,
            appliedToHost: orchestratorApply?.applied,
            propagated,
          });
        } catch (err) {
          const msg = `Failed to update ${targetLower} model: ${formatError(err)}`;
          if (ctx.hasUI) ctx.ui.notify(msg, "error");
          else emitZeroTurnMessage(ctx, msg);
        }
        return;
      }

      // Live member hot model switch (preserves warm session conversation history)
      if (!snapshot.run) {
        const msg = `No focused Swarm run to switch live member "${target}". To set a role default, use \`/swarm model <orchestrator|worker|validator> <model[:thinking]>\`.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        await assertFocusedRunOwner(store, snapshot.run.id, ctx);
        const switched = await engine.switchModel({
          targetName: target,
          model: modelArg,
          thinkingLevel,
          callerName: "human",
          callerRole: "human",
          autoResume: false,
          deferIfWorking: true,
          hostContext: ctx,
        });
        refreshUI(ctx);
        const appliedModel = switched.model;
        const thinkPart = switched.thinkingLevel
          ? ` (thinking: \`${switched.thinkingLevel}\`)`
          : "";
        const msg = switched.deferred
          ? `Queued hot-switch for working member \`@${switched.targetName}\` to \`${appliedModel}\`${thinkPart} at turn end.`
          : `Hot-switched live member \`@${switched.targetName}\` to \`${appliedModel}\`${thinkPart} — conversation history preserved.`;
        if (ctx.hasUI) {
          ctx.ui.notify(
            switched.deferred
              ? `Queued @${switched.targetName} -> ${appliedModel} at turn end.`
              : `Switched @${switched.targetName} -> ${appliedModel} (history preserved).`,
            "info",
          );
        }
        emitZeroTurnMessage(ctx, `✓ ${msg}`, {
          target: switched.targetName,
          scope: "live_member",
          model: appliedModel,
          thinkingLevel: switched.thinkingLevel,
          deferred: switched.deferred,
        });
      } catch (err) {
        const msg = `Failed to switch model for "${target}": ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleSteerCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        await assertFocusedRunOwner(store, snapshot.run.id, ctx);
      } catch (err) {
        const msg = `Failed to steer: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const trimmed = rawArgs.trim();
      const spaceIdx = trimmed.search(/\s/);
      const target = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).replace(/^@/, "").trim();
      const message = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();

      if (!target || !message) {
        const usage = "Usage: `/swarm steer <member-name> <message>`";
        if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        emitZeroTurnMessage(ctx, usage);
        return;
      }

      try {
        const res = await engine.steerMember(target, message, "steer", {
          callerName: "human",
          callerRole: "human",
        });
        refreshUI(ctx);
        const msg = `Sent dynamic direction to \`@${target}\` (${res.delivery}): ${message}`;
        if (ctx.hasUI) ctx.ui.notify(`Steered @${target} (${res.delivery}).`, "info");
        emitZeroTurnMessage(ctx, `⚡ ${msg}`, { target, delivery: res.delivery });
      } catch (err) {
        const msg = `Failed to steer @${target}: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleStopCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        await assertFocusedRunOwner(store, snapshot.run.id, ctx);
      } catch (err) {
        const msg = `Failed to stop member: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const tokens = tokenizeCommandArgs(rawArgs.trim());
      let target = tokens[0]?.replace(/^@/, "").trim() ?? "";
      const reason = tokens.slice(1).join(" ").trim() || undefined;

      if (!target) {
        const candidates = getOrderedMembers(snapshot.run).filter(
          (entry) => entry.state !== "killed" && entry.state !== "stopped",
        );
        if (candidates.length > 0 && ctx.hasUI) {
          const choiceMap = new Map<string, string>();
          const choices: string[] = [];
          for (const entry of candidates) {
            const label = `@${entry.name} (${entry.role} · ${entry.state} · ${entry.workspace} · ${entry.model ?? "default"})`;
            choiceMap.set(label, entry.name);
            choices.push(label);
          }
          const picked = await withModalGuard(() =>
            ctx.ui.select("Select member to stop:", choices),
          );
          if (!picked) {
            return;
          }
          target = choiceMap.get(picked) ?? "";
        } else {
          const hint =
            candidates.length > 0
              ? `Usage: /swarm stop <member-name> [reason] (live: ${candidates.map((c) => c.name).join(", ")})`
              : "Usage: /swarm stop <member-name> [reason] (no working or waiting members to stop).";
          if (ctx.hasUI) ctx.ui.notify(hint, "info");
          else emitZeroTurnMessage(ctx, hint);
          return;
        }
      }

      if (!target) return;

      try {
        await engine.stopMember(target, {
          humanStopped: true,
          callerRole: "human",
          callerName: "human",
          reason,
        });
        refreshUI(ctx);
        const reasonPart = reason ? ` (${reason})` : "";
        const msg = `Stopped member \`@${target}\`${reasonPart} — worktree & conversation history preserved.`;
        if (ctx.hasUI) ctx.ui.notify(`Stopped @${target}.`, "info");
        emitZeroTurnMessage(ctx, `⏹ ${msg}`, {
          target,
          reason: reason ?? "stopped by user",
        });
      } catch (err) {
        const msg = `Failed to stop member "${target}": ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleMergeCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        await assertFocusedRunOwner(store, snapshot.run.id, ctx);
      } catch (err) {
        const msg = `Failed to merge: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const tokens = tokenizeCommandArgs(rawArgs.trim());
      let target = tokens[0]?.replace(/^@/, "").trim() ?? "";

      if (!target) {
        const ordered = getOrderedMembers(snapshot.run).filter(
          (m) => (m.workspace === "share" || m.workspace === "branch") && Boolean(m.branch),
        );
        const orderIdx = new Map<string, number>();
        ordered.forEach((m, idx) => orderIdx.set(m.name, idx));
        const mergeRank = (m: SwarmMemberRecord): number => {
          if (!m.mergedCommitSha) {
            return m.state === "waiting" || m.state === "stopped" ? 0 : 1;
          }
          return 2;
        };
        const candidates = [...ordered].sort((a, b) => {
          const rDiff = mergeRank(a) - mergeRank(b);
          if (rDiff !== 0) return rDiff;
          return (orderIdx.get(a.name) ?? 0) - (orderIdx.get(b.name) ?? 0);
        });
        if (candidates.length > 0 && ctx.hasUI) {
          const choiceMap = new Map<string, string>();
          const choices: string[] = [];
          for (const entry of candidates) {
            const mergedTag = entry.mergedCommitSha
              ? ` [merged:${entry.mergedCommitSha.slice(0, 7)}]`
              : "";
            const label = `@${entry.name} [${entry.state}] (${entry.branch})${mergedTag}`;
            choiceMap.set(label, entry.name);
            choices.push(label);
          }
          const picked = await withModalGuard(() =>
            ctx.ui.select(
              `Select member worktree to merge into ${snapshot.run!.baseBranch}:`,
              choices,
            ),
          );
          if (!picked) {
            return;
          }
          target = choiceMap.get(picked) ?? "";
        } else {
          const hint =
            candidates.length > 0
              ? `Usage: /swarm merge <member-name> (candidates: ${candidates.map((c) => c.name).join(", ")})`
              : "Usage: /swarm merge <member-name> (no share/branch members in this run).";
          if (ctx.hasUI) ctx.ui.notify(hint, "info");
          else emitZeroTurnMessage(ctx, hint);
          return;
        }
      }

      if (!target) return;

      try {
        const merged = await engine.mergeMember(target, {
          callerName: "human",
          callerRole: "human",
        });
        refreshUI(ctx);
        if (!merged) {
          const msg = `Member \`@${target}\` uses \`inherit\` workspace (no separate branch to merge).`;
          if (ctx.hasUI) ctx.ui.notify(`@${target} uses inherit workspace.`, "info");
          emitZeroTurnMessage(ctx, msg, { memberName: target, merged: false });
          return;
        }
        const shaShort = merged.mergedCommitSha.slice(0, 12);
        const msg = `Merged \`@${target}\` into \`${snapshot.run.baseBranch}\` (${merged.strategy}) → \`${shaShort}\` (${merged.changedFiles.length} file(s)).`;
        if (ctx.hasUI) {
          ctx.ui.notify(`Merged @${target} -> ${shaShort}.`, "info");
        }
        emitZeroTurnMessage(ctx, `✓ ${msg}`, {
          memberName: target,
          merged: true,
          strategy: merged.strategy,
          mergedCommitSha: merged.mergedCommitSha,
          changedFiles: merged.changedFiles,
        });
      } catch (err) {
        const msg = `Failed to merge @${target}: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleKillCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        await assertFocusedRunOwner(store, snapshot.run.id, ctx);
      } catch (err) {
        const msg = `Failed to kill member: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const parsed = parseKillArgs(rawArgs);
      let target = parsed.target;

      if (!target) {
        const candidates = getOrderedMembers(snapshot.run).filter(
          (entry) => entry.state !== "killed",
        );
        if (candidates.length > 0 && ctx.hasUI) {
          const choiceMap = new Map<string, string>();
          const choices: string[] = [];
          for (const entry of candidates) {
            const label = `@${entry.name} (${entry.role} · ${entry.state} · ${entry.workspace} · ${entry.model ?? "default"})`;
            choiceMap.set(label, entry.name);
            choices.push(label);
          }
          const picked = await withModalGuard(() =>
            ctx.ui.select("Select member to permanently kill:", choices),
          );
          if (!picked) {
            return;
          }
          target = choiceMap.get(picked) ?? "";
        } else {
          const hint =
            candidates.length > 0
              ? `Usage: /swarm kill <member-name> [--force] [reason] (live: ${candidates.map((c) => c.name).join(", ")})`
              : "Usage: /swarm kill <member-name> [--force] [reason] (no active or warm members to kill).";
          if (ctx.hasUI) ctx.ui.notify(hint, "info");
          else emitZeroTurnMessage(ctx, hint);
          return;
        }
      }

      if (!target) return;

      try {
        const effectiveReason = parsed.reason ?? "Killed by user via /swarm kill";
        await engine.killMember(target, {
          force: parsed.force,
          reason: effectiveReason,
          callerName: "human",
          callerRole: "human",
        });
        refreshUI(ctx);
        const forcePart = parsed.force ? " [force]" : "";
        const msg = `Permanently killed member \`@${target}\`${forcePart} (${effectiveReason}).`;
        if (ctx.hasUI) ctx.ui.notify(`Killed @${target}.`, "warning");
        emitZeroTurnMessage(ctx, `⊘ ${msg}`, {
          target,
          force: parsed.force,
          reason: effectiveReason,
        });
      } catch (err) {
        const msg = `Failed to kill member "${target}": ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleDoneCommand(
      rawSummary: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to complete.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }
      if (isTerminalRunStatus(snapshot.run.status)) {
        const msg = `Swarm run \`${snapshot.run.id}\` is already ${snapshot.run.status}.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        await assertFocusedRunOwner(store, snapshot.run.id, ctx);
      } catch (err) {
        const msg = `Failed to complete Swarm run: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const parsedDone = parseDoneArgs(rawSummary);
      if (!parsedDone.force) {
        const runToCheck = await store
          .loadRun(snapshot.run.id)
          .catch(() => snapshot.run!);
        const engineWithUnmerged = engine as ISwarmEngine & {
          getUnmergedMembersWithCommits?: () => Promise<
            Array<{ member: SwarmMemberRecord; commitsAhead: number }>
          >;
        };
        const unmergedAhead =
          (await engineWithUnmerged.getUnmergedMembersWithCommits?.().catch(() => [])) ??
          [];
        const incompleteFeatures = (runToCheck.features ?? []).filter(
          (f) =>
            f.status === "pending" ||
            f.status === "in_progress" ||
            f.status === "failed",
        );
        const openTechDebt = (runToCheck.handoffItems ?? []).filter(
          (h) =>
            h.resolution === "open" &&
            (h.type === "discovered_issue" || h.type === "incomplete_work"),
        );
        const unpassedAssertions = (runToCheck.assertions ?? []).filter(
          (a) => a.status !== "passed",
        );

        const gateIssues: string[] = [];
        if (unmergedAhead.length > 0) {
          gateIssues.push(
            `${unmergedAhead.length} unmerged branch(es) (${unmergedAhead.map((u) => `@${u.member.name}`).join(", ")})`,
          );
        }
        if (incompleteFeatures.length > 0) {
          gateIssues.push(
            `${incompleteFeatures.length} incomplete feature(s) (${incompleteFeatures.map((f) => f.id).join(", ")})`,
          );
        }
        if (openTechDebt.length > 0) {
          gateIssues.push(`${openTechDebt.length} open tech-debt handoff(s)`);
        }
        if (unpassedAssertions.length > 0) {
          gateIssues.push(
            `${unpassedAssertions.length} unpassed VAL-* assertion(s) (${unpassedAssertions.map((a) => a.id).join(", ")})`,
          );
        }

        if (gateIssues.length > 0) {
          const msg = `Cannot complete Mission while Goal Gates remain unfinished: ${gateIssues.join("; ")}. Complete remaining items or run \`/swarm done --force [summary]\` to force-close.`;
          if (ctx.hasUI) ctx.ui.notify(msg, "warning");
          emitZeroTurnMessage(ctx, `⚠ ${msg}`, {
            runId: runToCheck.id,
            blockedByGoalGates: true,
            gateIssues,
          });
          return;
        }
      }

      let summary = parsedDone.summary;
      if (!summary && !parsedDone.force && ctx.hasUI) {
        const entered = await withModalGuard(() =>
          ctx.ui.input(
            `Complete Swarm "${snapshot.run!.title}" — summary`,
            "Completed via /swarm done",
          ),
        );
        if (entered === undefined) {
          return;
        }
        const latestSnap = engine.getSnapshot();
        if (
          latestSnap.run?.id !== snapshot.run.id ||
          isTerminalRunStatus(latestSnap.run.status)
        ) {
          const msg = latestSnap.run
            ? `Swarm run \`${latestSnap.run.id}\` is already ${latestSnap.run.status}.`
            : "Focused Swarm run is no longer attached.";
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          else emitZeroTurnMessage(ctx, msg);
          return;
        }
        summary = entered.trim() || "Completed by user via /swarm done";
      }
      if (!summary) {
        summary = parsedDone.force
          ? "Force-completed by user via /swarm done --force"
          : "Completed by user via /swarm done";
      }

      try {
        const sessionId = getSessionIdSafe(ctx);
        const runId = snapshot.run.id;
        activeDoneFlowRunIds.add(runId);
        let completed: SwarmRunState;
        try {
          completed = await engine.completeRun({
            summary,
            teardown: currentSettings.autoTeardownOnComplete,
            callerRole: "human",
            actor: "human",
            sessionId,
          });
        } finally {
          activeDoneFlowRunIds.delete(runId);
        }
        if (!orchestratorMode) {
          orchestratorMode = true;
        }
        lastCompletedRunId = completed.id;
        if (rehydrateFocusState(ctx).orchestratorMode !== true) {
          persistCurrentFocus(completed.id, sessionId, "run_completed");
        }
        purgePendingWakeupsForRun(completed.id);
        applySwarmToolProfile(pi, computeDesiredToolProfile(ctx));
        syncActiveRunSections({ ctx });
        clearWorkingMessageAndTitle(ctx);

        let inspected = await inspectRemainingWorktrees(
          completed,
          activeStore,
          activeWorktree,
        );
        let teardownResult: SafeTeardownResult | undefined;
        if (
          !currentSettings.autoTeardownOnComplete &&
          inspected.cleanMerged.length > 0 &&
          ctx.hasUI &&
          ctx.mode === "tui" &&
          typeof ctx.ui.confirm === "function"
        ) {
          const cleanCount = inspected.cleanMerged.length;
          const names = inspected.cleanMerged
            .map((w) => `@${w.memberName}`)
            .join(", ");
          const confirmed = await withModalGuard(() =>
            ctx.ui.confirm(
              `Remove ${cleanCount} merged worktree(s) now?`,
              `Clean up ${cleanCount} clean merged worktree(s) (${names}) for "${completed.title}". Audit logs and board history in ${SWARM_DIR}/runs/${completed.id}/ are preserved.`,
            ),
          );
          if (confirmed) {
            teardownResult = await engine
              .teardown({
                runId: completed.id,
                deleteBranches: false,
                sessionId,
              })
              .catch(() => undefined);
            if (teardownResult) {
              const refreshedRun =
                (await activeStore?.loadRun(completed.id).catch(() => completed)) ??
                completed;
              inspected = await inspectRemainingWorktrees(
                refreshedRun,
                activeStore,
                activeWorktree,
              );
            }
          }
        }

        refreshUI(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(`Completed Swarm run ${completed.id}.`, "info");
        }
        await emitMissionCompleteCardForRun(completed, {
          summary,
          initiatedBy: "command",
          ctx,
          remainingWorktrees: inspected.remaining,
          teardownResult,
        });
      } catch (err) {
        const msg = `Failed to complete Swarm run: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handlePauseCommand(
      reason: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to pause.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }
      if (isTerminalRunStatus(snapshot.run.status)) {
        const msg = `Cannot pause Swarm run \`${snapshot.run.id}\` because it is already ${snapshot.run.status}.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }
      try {
        await assertFocusedRunOwner(store, snapshot.run.id, ctx);
        const updated = await engine.pause(
          snapshot.run.id,
          reason || "Paused by user",
        );
        latestHumanDirection = undefined;
        purgePendingWakeupsForRun(updated.id);
        refreshUI(ctx);
        const msg = `Paused Swarm run \`${updated.id}\`.`;
        if (ctx.hasUI) ctx.ui.notify(`Paused Swarm run ${updated.id}.`, "info");
        emitZeroTurnMessage(ctx, `⏸ ${msg}`, { runId: updated.id, status: updated.status });
      } catch (err) {
        const msg = `Pause failed: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleResumeCommand(
      rawArg: string,
      ctx: ExtensionContext,
      options: { kickoff?: boolean } = {},
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);
      const snapshot = engine.getSnapshot();

      const tokens = tokenizeCommandArgs(rawArg.trim());
      let continueFlag = false;
      let quietFlag = false;
      const positional: string[] = [];
      for (const tok of tokens) {
        const lower = tok.toLowerCase();
        if (lower === "--continue" || lower === "-c") {
          continueFlag = true;
        } else if (lower === "--quiet" || lower === "-q") {
          quietFlag = true;
        } else {
          positional.push(tok);
        }
      }

      const isActivatedInProcess =
        snapshot.run !== null && activatedRunIds.has(snapshot.run.id);
      const plainFocusedResume =
        positional.length === 0 &&
        !continueFlag &&
        !options.kickoff &&
        snapshot.run !== null &&
        (isActivatedInProcess || isTerminalRunStatus(snapshot.run.status)) &&
        isCurrentSessionOwner(snapshot.run, ctx);

      if (plainFocusedResume && snapshot.run) {
        if (isTerminalRunStatus(snapshot.run.status)) {
          const msg = `Cannot resume Swarm run \`${snapshot.run.id}\` because it is already ${snapshot.run.status}.`;
          if (ctx.hasUI) ctx.ui.notify(msg, "warning");
          else emitZeroTurnMessage(ctx, msg);
          return;
        }
        try {
          await assertFocusedRunOwner(store, snapshot.run.id, ctx);
          const updated = await engine.resume(snapshot.run.id, ctx);
          notifyEngineHumanInputAwaited(false, engine);
          if (!orchestratorMode) {
            orchestratorMode = true;
            autoConfirmDefault = false;
            persistCurrentFocus(updated.id, getSessionIdSafe(ctx), "resume_mission");
          }
          resetGoalContinuation(updated.id);
          invalidateRunsCache();
          syncSessionNameForRun(updated);
          if (draftController.isActive()) {
            draftController.clear("running");
            syncDraftWidgetState(null);
          }
          applySwarmToolProfile(pi, computeDesiredToolProfile(ctx));
          syncActiveRunSections({ ctx });
          refreshUI(ctx);
          const members = getOrderedMembers(updated);
          const workingCount = members.filter((m) => m.state === "working").length;
          const parked = members.filter(
            (m) => m.state === "waiting" || m.state === "stopped",
          );
          let parkedNote = "";
          if (workingCount === 0 && parked.length > 0) {
            const preview = parked
              .slice(0, 8)
              .map((m) => `\`@${m.name}\` (${m.state})`)
              .join(", ");
            const extra = parked.length > 8 ? `, … +${parked.length - 8} more` : "";
            parkedNote = ` Parked (0 working): ${preview}${extra} — wake via \`post_message\` or \`/swarm steer\`.`;
          }
          const msg = `Resumed Swarm run \`${updated.id}\`.${parkedNote}`;
          if (ctx.hasUI) ctx.ui.notify(`Resumed Swarm run ${updated.id}.`, "info");
          emitZeroTurnMessage(ctx, `▶ ${msg}`, { runId: updated.id, status: updated.status });
        } catch (err) {
          const msg = `Resume failed: ${formatError(err)}`;
          if (ctx.hasUI) ctx.ui.notify(msg, "error");
          else emitZeroTurnMessage(ctx, msg);
        }
        return;
      }

      const allRuns = (await listRunsCached(store, true)).slice().sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );

      let requestedRunId: string | undefined;
      let guidance = "";
      if (positional.length > 0) {
        const firstTok = positional[0]!;
        const matched = allRuns.find(
          (r) => r.id === firstTok || r.id.toLowerCase() === firstTok.toLowerCase(),
        );
        if (matched) {
          requestedRunId = matched.id;
          guidance = positional.slice(1).join(" ").trim();
        } else if (/^run[_-]/i.test(firstTok)) {
          const msg = `Swarm run \`${firstTok}\` not found.`;
          if (ctx.hasUI) ctx.ui.notify(msg, "error");
          else emitZeroTurnMessage(ctx, msg);
          return;
        } else {
          guidance = positional.join(" ").trim();
        }
      }

      let chosenSummary: RunSummary | undefined;
      if (requestedRunId) {
        chosenSummary = allRuns.find((r) => r.id === requestedRunId);
      } else if (snapshot.run && !isTerminalRunStatus(snapshot.run.status)) {
        chosenSummary = undefined;
      } else {
        const currentSid = getCurrentSessionId(ctx);
        const resumable = allRuns.filter((r) => isRunResumableBySession(r, currentSid));
        if (resumable.length === 0) {
          const msg =
            allRuns.length > 0
              ? "No unfinished Swarm Mission to resume. Use `/swarm runs` to inspect past runs or `/swarm <goal>` to start a new Mission."
              : "No focused Swarm run to resume.";
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          else emitZeroTurnMessage(ctx, msg);
          return;
        }
        if (resumable.length === 1 || !ctx.hasUI || typeof ctx.ui.select !== "function") {
          chosenSummary = resumable[0]!;
        } else {
          const labels = resumable.map(
            (r) =>
              `${r.id} [${r.status}] — ${(r.title || r.objective).slice(0, 52)} (board #${r.boardHead})`,
          );
          const choice = await withModalGuard(() =>
            ctx.ui.select("Select an unfinished Swarm Mission to resume", labels),
          );
          if (!choice) {
            return;
          }
          const idx = labels.indexOf(choice);
          chosenSummary = idx >= 0 ? resumable[idx] : undefined;
          if (!chosenSummary) {
            return;
          }
        }
      }

      const targetRun: SwarmRunState | undefined = chosenSummary
        ? await store.loadRun(chosenSummary.id).catch(() => undefined)
        : snapshot.run ?? undefined;

      if (!targetRun) {
        const msg = "No focused Swarm run to resume.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      if (isTerminalRunStatus(targetRun.status)) {
        const msg = `Cannot resume Swarm run \`${targetRun.id}\` because it is already ${targetRun.status}.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        const currentSid = getCurrentSessionId(ctx);
        assertOwnerSession(targetRun, currentSid);
        const wasAlreadyFocusedAndOwned =
          snapshot.activeRunId === targetRun.id &&
          isOwnedLiveRun(targetRun, ctx) &&
          targetRun.ownerPid === process.pid;
        const wasActivatedInProcess = activatedRunIds.has(targetRun.id);

        if (targetRun.ownerSessionId !== currentSid || targetRun.ownerPid !== process.pid) {
          await store.updateRun(targetRun.id, {
            ownerSessionId: currentSid,
            ownerPid: process.pid,
            actor: ORCHESTRATOR_NAME,
          });
        }

        if (engine.getSnapshot().activeRunId !== targetRun.id || !wasAlreadyFocusedAndOwned) {
          await engine.attachRun(targetRun.id, ctx);
        }

        const updated = await engine.resume(targetRun.id, ctx);
        notifyEngineHumanInputAwaited(false, engine);
        if (!orchestratorMode) {
          orchestratorMode = true;
          autoConfirmDefault = false;
        }
        resetGoalContinuation(updated.id);
        invalidateRunsCache();
        syncSessionNameForRun(updated);
        persistCurrentFocus(updated.id, currentSid, "resume_mission");

        if (draftController.isActive()) {
          draftController.clear("running");
          syncDraftWidgetState(null);
        }

        const runOrch = updated.roleModels?.orchestrator;
        const hasRunOrchModel = Boolean(runOrch?.model?.trim());
        const effectiveOrchModel =
          runOrch?.model?.trim() || currentSettings.orchestratorModel;
        const effectiveOrchThinking = hasRunOrchModel
          ? runOrch?.thinkingLevel
          : (runOrch?.thinkingLevel ?? currentSettings.orchestratorThinkingLevel);
        if (
          (!wasAlreadyFocusedAndOwned || !wasActivatedInProcess) &&
          (effectiveOrchModel || effectiveOrchThinking || runOrch)
        ) {
          await applyOrchestratorModelWithSnapshot(
            ctx,
            {
              ...currentSettings,
              orchestratorModel: effectiveOrchModel,
              orchestratorThinkingLevel: effectiveOrchThinking,
            },
            { clearThinking: effectiveOrchThinking === undefined },
          );
        }

        applySwarmToolProfile(pi, computeDesiredToolProfile(ctx));
        syncActiveRunSections({ ctx });
        refreshUI(ctx);

        const shouldWakeOrchestrator =
          !quietFlag &&
          (continueFlag ||
            Boolean(guidance) ||
            Boolean(options.kickoff) ||
            !wasAlreadyFocusedAndOwned ||
            !wasActivatedInProcess);

        if (shouldWakeOrchestrator) {
          activatedRunIds.add(updated.id);
        }

        if (!shouldWakeOrchestrator) {
          const msg = `Resumed Swarm run \`${updated.id}\`.`;
          if (ctx.hasUI) ctx.ui.notify(`Resumed Swarm run ${updated.id}.`, "info");
          emitZeroTurnMessage(ctx, `▶ ${msg}`, { runId: updated.id, status: updated.status });
          return;
        }

        const boardRes = await store
          .readBoard(updated.id, { limit: 8 })
          .catch(() => ({ messages: [] as BoardMessage[] }));
        if (ctx.hasUI) {
          ctx.ui.notify(`Resumed Swarm Mission ${updated.id} — waking Orchestrator…`, "info");
        } else {
          emitZeroTurnMessage(ctx, `▶ Resumed Swarm Mission \`${updated.id}\`.`, {
            runId: updated.id,
            status: updated.status,
          });
        }

        enqueueWakeupItem({
          type: "kickoff",
          runId: updated.id,
          summary: `Resumed Swarm Mission "${updated.title}" (${updated.id})`,
          kickoffBody: buildMissionResumePrompt(updated, guidance, boardRes.messages),
        });
      } catch (err) {
        const msg = `Resume failed: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleCancelCommand(ctx: ExtensionCommandContext): Promise<void> {
      const { store, engine } = await ensureBound(ctx);

      // 1. If a planning draft is active, cancel the draft and restore the underlying tool profile
      if (draftController.isActive()) {
        const snapshot = engine.getSnapshot();
        const nextProfile: SwarmToolProfileMode = isOwnedLiveRun(snapshot.run, ctx)
          ? "running"
          : orchestratorMode
            ? "standby"
            : "idle";
        draftController.clear(nextProfile);
        syncDraftWidgetState(null);
        syncActiveRunSections({ ctx });
        if (nextProfile === "idle") {
          clearWorkingMessageAndTitle(ctx);
          await restorePreSwarmHostModel(ctx);
        } else if (nextProfile === "standby") {
          clearWorkingMessageAndTitle(ctx);
        }
        refreshUI(ctx);
        const msg = `Cancelled active Swarm draft and restored \`${nextProfile}\` tools.`;
        if (ctx.hasUI) ctx.ui.notify("Cancelled active Swarm draft.", "info");
        emitZeroTurnMessage(ctx, msg, { cancelledDraft: true, nextProfile });
        scheduleWakeupFlush(ctx);
        return;
      }

      // 2. Otherwise, confirm and safely stop/abandon the focused run
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = orchestratorMode
          ? "Nothing to cancel (no active Swarm draft or focused run). Persistent Orchestrator Mode remains in standby — run `/swarm exit` to leave Orchestrator Mode."
          : "Nothing to cancel (no active Swarm draft or focused run).";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const run = snapshot.run;
      if (isTerminalRunStatus(run.status)) {
        const msg = orchestratorMode
          ? `Swarm run \`${run.id}\` is already ${run.status}. Persistent Orchestrator Mode remains in standby — run \`/swarm exit\` to leave Orchestrator Mode.`
          : `Swarm run \`${run.id}\` is already ${run.status}.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        await assertFocusedRunOwner(store, run.id, ctx);
      } catch (err) {
        const msg = `Cancel failed: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      if (ctx.hasUI) {
        const workingCount = snapshot.workingMemberNames.length;
        const waitingCount = snapshot.waitingMemberNames.length;
        const liveCount = workingCount + waitingCount;
        const confirmed = await withModalGuard(() =>
          ctx.ui.confirm(
            `Cancel Swarm run ${run.id}?`,
            `This will stop ${liveCount} live member(s) (${workingCount} working, ${waitingCount} warm waiting) and mark "${run.title}" as abandoned. Worktrees and ${SWARM_DIR}/runs/ audit & board logs are preserved.`,
          ),
        );
        if (!confirmed) {
          return;
        }
      }

      const latestSnap = engine.getSnapshot();
      if (
        latestSnap.run?.id !== run.id ||
        isTerminalRunStatus(latestSnap.run.status)
      ) {
        const msg = latestSnap.run
          ? `Swarm run \`${latestSnap.run.id}\` is already ${latestSnap.run.status}.`
          : "Focused Swarm run is no longer attached.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const cancelReason = "Cancelled by user via /swarm cancel";
      await engine.pause(run.id, cancelReason).catch(() => {});
      const postPauseSnap = engine.getSnapshot();
      const latestRun = postPauseSnap.run ?? latestSnap.run ?? run;
      for (const member of getOrderedMembers(latestRun)) {
        if (member.state === "killed") continue;
        try {
          if (member.workspace === "inherit") {
            await engine.killMember(member.name, {
              reason: cancelReason,
              callerName: "human",
              callerRole: "human",
            });
          } else {
            // Preserve share/branch worktrees untouched; user can inspect or run /swarm teardown later
            await engine.stopMember(member.name, {
              humanStopped: true,
              reason: cancelReason,
              callerName: "human",
              callerRole: "human",
            });
          }
        } catch {
          // best-effort stop/kill for each member
        }
      }

      const refreshedRun = await store.loadRun(run.id).catch(() => latestRun);
      if (!isTerminalRunStatus(refreshedRun.status)) {
        await store.updateRun(run.id, {
          status: "abandoned",
          actor: "human",
        });
      }

      orchestratorMode = false;
      autoConfirmDefault = false;
      lastCompletedRunId = null;
      latestHumanDirection = undefined;
      waitArmedTurnIndex = null;
      activatedRunIds.delete(run.id);
      resetGoalContinuation(run.id);
      invalidateRunsCache();
      purgePendingWakeupsForRun(run.id);
      await engine.attachRun(null, ctx);
      await engine.attachRun(run.id, ctx);
      persistCurrentFocus(run.id, getSessionIdSafe(ctx), "user_cancel_run");
      applySwarmToolProfile(pi, computeDesiredToolProfile(ctx));
      syncActiveRunSections({ ctx });
      clearWorkingMessageAndTitle(ctx);
      await restorePreSwarmHostModel(ctx);
      refreshUI(ctx);

      const msg = `Stopped active members and marked Swarm run \`${run.id}\` as abandoned (audit trail, board & worktrees preserved).`;
      if (ctx.hasUI) ctx.ui.notify(`Cancelled Swarm run ${run.id}.`, "warning");
      emitZeroTurnMessage(ctx, msg, { runId: run.id, status: "abandoned" });
    }

    async function handleTeardownCommand(
      rawArgs: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { engine, store } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to tear down.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const tokens = rawArgs.split(/\s+/).filter(Boolean);
      const allowedTokens = new Set([
        "--force",
        "-f",
        "--delete-branches",
        "--branches",
      ]);
      const unknownTokens = tokens.filter((t) => !allowedTokens.has(t.toLowerCase()));
      if (unknownTokens.length > 0) {
        const msg = `Unknown teardown option(s): ${unknownTokens.join(", ")}. Usage: /swarm teardown [--force] [--delete-branches]`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const force = tokens.some(
        (t) => t.toLowerCase() === "--force" || t.toLowerCase() === "-f",
      );
      const deleteBranches = tokens.some(
        (t) => t.toLowerCase() === "--delete-branches" || t.toLowerCase() === "--branches",
      );
      const runId = snapshot.run.id;
      const sessionId = getSessionIdSafe(ctx);

      try {
        await assertFocusedRunOwner(store, runId, ctx);

        if (force) {
          const forceReason = "Force teardown via /swarm teardown --force";
          for (const memberName of [...snapshot.workingMemberNames]) {
            try {
              await engine.stopMember(memberName, {
                humanStopped: true,
                reason: forceReason,
                callerName: "human",
                callerRole: "human",
              });
            } catch {
              // continue stopping remaining working members
            }
          }
        }

        const result = await engine.teardown({
          runId,
          deleteBranches,
          sessionId,
          force,
        });

        const report = formatTeardownReport(runId, result, force);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Teardown ${runId}: ${result.removed.length} removed, ${result.skipped.length} skipped, ${result.errors.length} error(s).`,
            result.errors.length > 0 ? "warning" : "info",
          );
        }
        emitZeroTurnMessage(ctx, report, {
          runId,
          removed: result.removed.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
        });
      } catch (err) {
        const msg = `Teardown failed: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleRunsCommand(ctx: ExtensionContext): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const runs = await store.listRuns();
      const focusedId = engine.getSnapshot().activeRunId;

      if (runs.length === 0) {
        emitZeroTurnMessage(
          ctx,
          `No Swarm runs found in \`${SWARM_DIR}/runs/\`. Start one with \`/swarm <goal>\`.`,
        );
        return;
      }

      const lines: string[] = [
        `### 🐝 Swarm Runs (${runs.length})`,
        "",
        "| Focus | Run ID | Status | Members | Board | Base | Title / Objective |",
        "| :---: | --- | --- | --- | ---: | --- | --- |",
      ];

      for (const r of runs) {
        const star = r.id === focusedId ? "★" : "";
        const label = sanitizePlainText(r.title || r.objective).slice(0, 60).replace(/\|/g, "\\|");
        const safeBase = sanitizePlainText(r.baseBranch).replace(/\|/g, "\\|");
        lines.push(
          `| ${star} | \`${r.id}\` | ${r.status} | ${r.workingCount}w/${r.waitingCount}wait (${r.memberCount}) | #${r.boardHead} | \`${safeBase}\` | ${label} |`,
        );
      }
      lines.push("", "Switch focus with `/swarm focus <run-id>` or `/swarm focus none`.");

      emitZeroTurnMessage(ctx, lines.join("\n"), { count: runs.length, focusedId });
    }

    async function detachFocusedRun(
      store: ISwarmStore,
      engine: ISwarmEngine,
      ctx: ExtensionContext,
      sessionId: string,
    ): Promise<void> {
      orchestratorMode = false;
      autoConfirmDefault = false;
      lastCompletedRunId = null;
      const prevFocused = engine.getSnapshot().activeRunId;
      if (prevFocused) {
        activatedRunIds.delete(prevFocused);
        resetGoalContinuation(prevFocused);
      }
      await releaseRunOwnershipIfHeld(store, prevFocused, sessionId);
      purgePendingWakeupsForRun(null);
      await engine.attachRun(null, ctx);
      if (draftController.isActive()) {
        draftController.clear("idle");
        syncDraftWidgetState(null);
      }
      persistCurrentFocus(null, sessionId, "user_unfocus");
      applySwarmToolProfile(pi, computeDesiredToolProfile(ctx));
      syncActiveRunSections({ ctx });
      clearWorkingMessageAndTitle(ctx);
      await restorePreSwarmHostModel(ctx);
      refreshUI(ctx);
    }

    async function handleExitCommand(
      rawArgs: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const force = rawArgs.trim().toLowerCase() === "--force";
      const snapshot = engine.getSnapshot();
      const sessionId = getSessionIdSafe(ctx);
      const run = snapshot.run;
      const hasLiveOwnedRun = isOwnedLiveRun(run, ctx);

      if (hasLiveOwnedRun && run && !force) {
        const msg = `Cannot exit Persistent Orchestrator Mode while Swarm run \`${run.id}\` ("${run.title}") is ${run.status}. Complete it with \`/swarm done\`, abandon it with \`/swarm cancel\`, or run \`/swarm exit --force\` to pause and detach it cleanly for later \`/swarm resume\`.`;
        if (ctx.hasUI) {
          ctx.ui.notify(msg, "warning");
        }
        emitZeroTurnMessage(ctx, `⚠ ${msg}`, {
          runId: run.id,
          status: run.status,
          blockedLiveRun: true,
        });
        return;
      }

      let pausedRunId: string | undefined;
      if (hasLiveOwnedRun && run && force) {
        try {
          await assertFocusedRunOwner(store, run.id, ctx);
        } catch (err) {
          const msg = `Exit failed: ${formatError(err)}`;
          if (ctx.hasUI) ctx.ui.notify(msg, "error");
          else emitZeroTurnMessage(ctx, msg);
          return;
        }
        await engine.pause(
          run.id,
          "Paused and detached by user via /swarm exit --force",
        );
        await store.updateRun(run.id, {
          ownerSessionId: "",
          ownerPid: 0,
          actor: "human",
        });
        pausedRunId = run.id;
      } else if (snapshot.activeRunId) {
        await releaseRunOwnershipIfHeld(store, snapshot.activeRunId, sessionId);
      }

      const wasOrchestratorActive =
        orchestratorMode ||
        hasLiveOwnedRun ||
        draftController.isActive() ||
        rehydrateFocusState(ctx).orchestratorMode === true;

      orchestratorMode = false;
      autoConfirmDefault = false;
      lastCompletedRunId = null;
      latestHumanDirection = undefined;
      waitArmedTurnIndex = null;
      unfinishedFooterCue = undefined;
      if (snapshot.activeRunId) {
        activatedRunIds.delete(snapshot.activeRunId);
        resetGoalContinuation(snapshot.activeRunId);
      }
      purgePendingWakeupsForRun(null);
      invalidateRunsCache();

      if (draftController.isActive()) {
        draftController.clear("idle");
        syncDraftWidgetState(null);
      }

      await engine.attachRun(null, ctx);
      persistCurrentFocus(
        null,
        sessionId,
        pausedRunId ? "user_exit_force" : "user_exit",
      );
      applySwarmToolProfile(pi, "idle");
      syncActiveRunSections({ ctx });
      clearWorkingMessageAndTitle(ctx);
      await restorePreSwarmHostModel(ctx);
      refreshUI(ctx);

      if (pausedRunId) {
        const msg = `Paused and detached Swarm run \`${pausedRunId}\` (worktrees & branches preserved; resumable via \`/swarm resume\`) and exited Persistent Swarm Orchestrator Mode.`;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Paused & detached ${pausedRunId} and exited Swarm Orchestrator Mode.`,
            "info",
          );
        }
        emitZeroTurnMessage(ctx, `✓ ${msg}`, {
          exitedOrchestratorMode: true,
          pausedRunId,
          force: true,
        });
        return;
      }

      const msg = wasOrchestratorActive
        ? "Exited Persistent Swarm Orchestrator Mode — restored `idle` tools, host model, and direct file editing."
        : "Persistent Swarm Orchestrator Mode is already inactive (`idle` tools active).";
      if (ctx.hasUI) {
        ctx.ui.notify(
          wasOrchestratorActive
            ? "Exited Persistent Swarm Orchestrator Mode."
            : "Persistent Swarm Orchestrator Mode is already inactive.",
          "info",
        );
      }
      emitZeroTurnMessage(ctx, msg, {
        exitedOrchestratorMode: wasOrchestratorActive,
      });
    }

    async function handleFocusCommand(
      rawTarget: string,
      ctx: ExtensionContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const target = rawTarget.trim();
      const sessionId = getSessionIdSafe(ctx);

      if (target === "none" || target === "--clear" || target === "off") {
        unfinishedFooterCue = undefined;
        await detachFocusedRun(store, engine, ctx, sessionId);
        const msg = "Detached session focus from Swarm run.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg, { runId: null });
        return;
      }

      let chosenRunId = target;
      if (!chosenRunId) {
        const runs = await store.listRuns();
        if (runs.length === 0) {
          const msg = `No Swarm runs found in \`${SWARM_DIR}/runs/\`.`;
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          else emitZeroTurnMessage(ctx, msg);
          return;
        }
        if (!ctx.hasUI) {
          await handleRunsCommand(ctx);
          return;
        }

        const currentFocused = engine.getSnapshot().activeRunId;
        const choiceMap = new Map<string, string | null>();
        const options: string[] = [];
        for (const r of runs) {
          const prefix = r.id === currentFocused ? "★ " : "  ";
          const label = `${prefix}${r.id} [${r.status}] ${r.memberCount} members (#${r.boardHead}) — ${(r.title || r.objective).slice(0, 48)}`;
          choiceMap.set(label, r.id);
          options.push(label);
        }
        const detachLabel = "Detach (unfocus current run)";
        choiceMap.set(detachLabel, null);
        options.push(detachLabel);

        const picked = await withModalGuard(() =>
          ctx.ui.select("Select Swarm run to focus (session-local):", options),
        );
        if (picked === undefined) {
          return;
        }
        const mapped = choiceMap.get(picked);
        if (mapped === null) {
          await detachFocusedRun(store, engine, ctx, sessionId);
          ctx.ui.notify("Detached session focus.", "info");
          return;
        }
        chosenRunId = mapped ?? "";
      }

      if (!chosenRunId) return;

      try {
        const targetRun = await store.loadRun(chosenRunId);
        const canOwn = isCurrentSessionOwner(targetRun, ctx);
        const shouldClaimOnFocus =
          canOwn &&
          (targetRun.status === "active" ||
            (targetRun.status === "paused" &&
              Boolean(targetRun.ownerSessionId) &&
              targetRun.ownerSessionId === sessionId));
        const prevFocused = engine.getSnapshot().activeRunId;
        if (prevFocused && prevFocused !== chosenRunId) {
          activatedRunIds.delete(prevFocused);
          await releaseRunOwnershipIfHeld(store, prevFocused, sessionId);
          purgePendingWakeupsForRun(null);
        }
        let snapshot: SwarmSnapshot;
        if (shouldClaimOnFocus) {
          await claimRunOwnershipIfAvailable(
            store,
            engine,
            targetRun,
            sessionId,
            ctx,
            false,
          );
          snapshot = await attachRunWithOwnershipGuard(engine, chosenRunId, ctx, false);
        } else {
          snapshot = await attachRunWithOwnershipGuard(
            engine,
            chosenRunId,
            ctx,
            !canOwn || isRunningProfileRun(targetRun),
          );
        }
        persistCurrentFocus(chosenRunId, sessionId, "user_focus");
        applySwarmToolProfile(pi, computeDesiredToolProfile(ctx));
        syncActiveRunSections({ ctx });
        refreshUI(ctx);

        const readOnlyNote = !canOwn
          ? ` (read-only observer; owned by ${targetRun.ownerSessionId || "another session"} PID ${targetRun.ownerPid})`
          : !shouldClaimOnFocus && targetRun.status === "paused"
            ? " (paused · unowned — run /swarm resume to take over)"
            : "";
        const statusLabel = snapshot.run?.status ?? "unknown";
        const msg = `Focused Swarm run \`${chosenRunId}\` (${statusLabel})${readOnlyNote}.`;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Focused Swarm run ${chosenRunId} (${statusLabel})${readOnlyNote}.`,
            "info",
          );
        } else {
          emitZeroTurnMessage(ctx, msg, { runId: chosenRunId });
        }
      } catch (err) {
        const msg = `Unable to focus run "${chosenRunId}": ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleSettingsCommand(ctx: ExtensionContext): Promise<void> {
      await ensureBound(ctx);
      let layeredPaths: { globalPath: string; projectPath: string } | undefined;
      if (overrides.settingsLoader) {
        lastLayeredSettings = undefined;
        currentSettings = await overrides.settingsLoader(ctx.cwd);
      } else {
        const layered = await loadLayeredSwarmSettings(
          ctx.cwd,
          overrides.settingsPathOptions,
        );
        lastLayeredSettings = layered;
        currentSettings = layered.settings;
        layeredPaths = {
          globalPath: layered.globalPath,
          projectPath: layered.projectPath,
        };
      }
      activeWorktree?.setGitTimeoutMs?.(currentSettings.gitTimeoutMs);

      if (!ctx.hasUI) {
        emitZeroTurnMessage(ctx, formatSettingsMarkdown(currentSettings, layeredPaths));
        return;
      }

      let saveScope: "project" | "global" = getPreferredSaveScope();
      const useModelPicker = canUseCustomTui(ctx);

      const persistPatch = async (patch: Partial<SwarmSettings>): Promise<void> => {
        await persistSettingsPatch(saveScope, patch, ctx.cwd);
        refreshUI(ctx);
      };

      const openSettingsModelPicker = async (initialTab: ModelPickerTab): Promise<void> => {
        const availableModels = await refreshAvailableModels(ctx, true);
        const callbacks = makeModelPickerCallbacks(ctx);
        await withModalGuard(() =>
          openSwarmModelPicker(ctx, {
            mode: "roles",
            initialTab,
            initialScope: saveScope,
            state: getModelSettingsState(ctx),
            availableModels,
            ...callbacks,
          }),
        );
        saveScope = getPreferredSaveScope();
        refreshUI(ctx);
      };

      const promptRoleModel = async (
        role: SwarmModelRole,
        label: string,
        currentValue: string | undefined,
        currentThinking: ThinkingLevel | undefined,
      ): Promise<void> => {
        if (useModelPicker) {
          await openSettingsModelPicker(role);
          return;
        }
        const defaultInput = currentValue
          ? currentThinking
            ? `${currentValue}:${currentThinking}`
            : currentValue
          : "";
        const raw = await withModalGuard(() =>
          ctx.ui.input(
            `Set ${label} (model ID[:thinking], or "default" / empty to inherit host)`,
            defaultInput,
          ),
        );
        if (raw === undefined) {
          return;
        }
        const trimmed = raw.trim();
        const isClear = !trimmed || CLEAR_MODEL_TOKENS.has(trimmed.toLowerCase());
        let modelValue: string | undefined;
        let thinkingLevel: ThinkingLevel | undefined;
        if (!isClear) {
          const parts = trimmed.split(/\s+/).filter(Boolean);
          if (parts.length >= 2) {
            const lastRaw = parts[parts.length - 1]!;
            const lastLower = lastRaw.toLowerCase();
            if (!isThinkingLevel(lastLower)) {
              ctx.ui.notify(
                `Invalid thinking level "${lastRaw}". Valid values: off, minimal, low, medium, high, xhigh, max.`,
                "error",
              );
              return;
            }
          }
          const parsedSpec = parseModelSpec(trimmed);
          modelValue = parsedSpec.model;
          thinkingLevel = parsedSpec.thinkingLevel;
        }
        await applyRoleModelChange(
          role,
          modelValue,
          thinkingLevel,
          ctx,
          { scope: saveScope, updateRun: true },
        );
        ctx.ui.notify(
          isClear
            ? `Cleared ${label} to host default (${saveScope}).`
            : `Saved ${label} = ${modelValue}${thinkingLevel ? ` (${thinkingLevel})` : ""} (${saveScope}).`,
          "info",
        );
      };

      const interactiveModelsItem = "🎛 Configure Mission Models & Effort (Interactive Picker)…";

      while (true) {
        const items = [
          ...(useModelPicker ? [interactiveModelsItem] : []),
          `orchestratorModel: ${formatModelSettingCell(currentSettings.orchestratorModel, currentSettings.orchestratorThinkingLevel)}`,
          `workerModel: ${formatModelSettingCell(currentSettings.workerModel, currentSettings.workerThinkingLevel)}`,
          `validatorModel: ${formatModelSettingCell(currentSettings.validatorModel, currentSettings.validatorThinkingLevel)}`,
          `fallbackModels: ${currentSettings.fallbackModels.length > 0 ? currentSettings.fallbackModels.join(", ") : "(none)"}`,
          `keepWorkersWarm: ${currentSettings.keepWorkersWarm ? "ON" : "OFF"}`,
          `validatorEnabled: ${currentSettings.validatorEnabled ? "ON" : "OFF"}`,
          `stallWatchdogEnabled: ${currentSettings.stallWatchdogEnabled ? "ON" : "OFF"}`,
          `stallMonitorMode: ${currentSettings.stallMonitorMode}`,
          `stallTimeoutMs: ${currentSettings.stallTimeoutMs}`,
          `maxConcurrency: ${currentSettings.maxConcurrency}`,
          `maxRetries: ${currentSettings.maxRetries}`,
          `rateLimitBaseBackoffMs: ${currentSettings.rateLimitBaseBackoffMs}`,
          `rateLimitMaxBackoffMs: ${currentSettings.rateLimitMaxBackoffMs}`,
          `gitTimeoutMs: ${currentSettings.gitTimeoutMs}`,
          `autoRebase: ${currentSettings.autoRebase ? "ON" : "OFF"}`,
          `autoTeardownOnComplete: ${currentSettings.autoTeardownOnComplete ? "ON" : "OFF"}`,
          `Save target: ${saveScope === "project" ? "project (.pi/pi-swarm-settings.json)" : "global (~/.pi/agent/pi-swarm-settings.json)"}`,
          "Done",
        ];

        const picked = await withModalGuard(() =>
          ctx.ui.select("🐝 Pi Swarm Settings", items),
        );
        if (!picked || picked === "Done") {
          break;
        }

        try {
          if (picked === interactiveModelsItem) {
            await openSettingsModelPicker("orchestrator");
          } else if (picked.startsWith("orchestratorModel:")) {
            await promptRoleModel(
              "orchestrator",
              "orchestratorModel",
              currentSettings.orchestratorModel,
              currentSettings.orchestratorThinkingLevel,
            );
          } else if (picked.startsWith("workerModel:")) {
            await promptRoleModel(
              "worker",
              "workerModel",
              currentSettings.workerModel,
              currentSettings.workerThinkingLevel,
            );
          } else if (picked.startsWith("validatorModel:")) {
            await promptRoleModel(
              "validator",
              "validatorModel",
              currentSettings.validatorModel,
              currentSettings.validatorThinkingLevel,
            );
          } else if (picked.startsWith("fallbackModels:")) {
            if (useModelPicker) {
              await openSettingsModelPicker("fallbacks");
              continue;
            }
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                'Set fallbackModels (comma/space-separated model IDs, or "clear" for none)',
                currentSettings.fallbackModels.join(", "),
              ),
            );
            if (raw !== undefined) {
              const trimmed = raw.trim();
              const nextFallbacks =
                !trimmed || CLEAR_MODEL_TOKENS.has(trimmed.toLowerCase())
                  ? []
                  : Array.from(
                      new Set(
                        trimmed
                          .split(",")
                          .map((s) => s.trim())
                          .filter(
                            (s) =>
                              s.length > 0 &&
                              !CLEAR_MODEL_TOKENS.has(s.toLowerCase()),
                          )
                          .map((s) => {
                            const p = parseModelSpec(s);
                            return p.thinkingLevel ? `${p.model}:${p.thinkingLevel}` : p.model;
                          })
                          .filter(Boolean),
                      ),
                    );
              await persistPatch({ fallbackModels: nextFallbacks });
              await syncActiveRunRoleModels(ctx);
              ctx.ui.notify(
                nextFallbacks.length > 0
                  ? `Saved fallbackModels = [${nextFallbacks.join(", ")}] (${saveScope}).`
                  : `Cleared fallbackModels (${saveScope}).`,
                "info",
              );
            }
          } else if (picked.startsWith("keepWorkersWarm:")) {
            await persistPatch({ keepWorkersWarm: !currentSettings.keepWorkersWarm });
            ctx.ui.notify(
              `Saved keepWorkersWarm = ${currentSettings.keepWorkersWarm ? "ON" : "OFF"} (${saveScope}).`,
              "info",
            );
          } else if (picked.startsWith("validatorEnabled:")) {
            await persistPatch({ validatorEnabled: !currentSettings.validatorEnabled });
            ctx.ui.notify(
              `Saved validatorEnabled = ${currentSettings.validatorEnabled ? "ON" : "OFF"} (${saveScope}).`,
              "info",
            );
          } else if (picked.startsWith("stallWatchdogEnabled:")) {
            await persistPatch({
              stallWatchdogEnabled: !currentSettings.stallWatchdogEnabled,
            });
            ctx.ui.notify(
              `Saved stallWatchdogEnabled = ${currentSettings.stallWatchdogEnabled ? "ON" : "OFF"} (${saveScope}).`,
              "info",
            );
          } else if (picked.startsWith("stallMonitorMode:")) {
            const nextMode =
              currentSettings.stallMonitorMode === "llm" ? "deterministic" : "llm";
            await persistPatch({ stallMonitorMode: nextMode });
            ctx.ui.notify(
              `Saved stallMonitorMode = ${currentSettings.stallMonitorMode} (${saveScope}).`,
              "info",
            );
          } else if (picked.startsWith("stallTimeoutMs:")) {
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                `Set stallTimeoutMs (${SWARM_SETTINGS_BOUNDS.stallTimeoutMs.min}-${SWARM_SETTINGS_BOUNDS.stallTimeoutMs.max})`,
                String(currentSettings.stallTimeoutMs),
              ),
            );
            if (raw !== undefined && raw.trim()) {
              const num = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(num)) {
                await persistPatch({ stallTimeoutMs: num });
                ctx.ui.notify(
                  `Saved stallTimeoutMs = ${currentSettings.stallTimeoutMs} (${saveScope}).`,
                  "info",
                );
              }
            }
          } else if (picked.startsWith("maxConcurrency:")) {
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                `Set maxConcurrency (${SWARM_SETTINGS_BOUNDS.maxConcurrency.min}-${SWARM_SETTINGS_BOUNDS.maxConcurrency.max})`,
                String(currentSettings.maxConcurrency),
              ),
            );
            if (raw !== undefined && raw.trim()) {
              const num = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(num)) {
                await persistPatch({ maxConcurrency: num });
                ctx.ui.notify(
                  `Saved maxConcurrency = ${currentSettings.maxConcurrency} (${saveScope}).`,
                  "info",
                );
              }
            }
          } else if (picked.startsWith("maxRetries:")) {
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                `Set maxRetries (${SWARM_SETTINGS_BOUNDS.maxRetries.min}-${SWARM_SETTINGS_BOUNDS.maxRetries.max})`,
                String(currentSettings.maxRetries),
              ),
            );
            if (raw !== undefined && raw.trim()) {
              const num = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(num)) {
                await persistPatch({ maxRetries: num });
                ctx.ui.notify(
                  `Saved maxRetries = ${currentSettings.maxRetries} (${saveScope}).`,
                  "info",
                );
              }
            }
          } else if (picked.startsWith("rateLimitBaseBackoffMs:")) {
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                `Set rateLimitBaseBackoffMs (${SWARM_SETTINGS_BOUNDS.rateLimitBaseBackoffMs.min}-${SWARM_SETTINGS_BOUNDS.rateLimitBaseBackoffMs.max})`,
                String(currentSettings.rateLimitBaseBackoffMs),
              ),
            );
            if (raw !== undefined && raw.trim()) {
              const num = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(num)) {
                await persistPatch({ rateLimitBaseBackoffMs: num });
                ctx.ui.notify(
                  `Saved rateLimitBaseBackoffMs = ${currentSettings.rateLimitBaseBackoffMs} (${saveScope}).`,
                  "info",
                );
              }
            }
          } else if (picked.startsWith("rateLimitMaxBackoffMs:")) {
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                `Set rateLimitMaxBackoffMs (${SWARM_SETTINGS_BOUNDS.rateLimitMaxBackoffMs.min}-${SWARM_SETTINGS_BOUNDS.rateLimitMaxBackoffMs.max})`,
                String(currentSettings.rateLimitMaxBackoffMs),
              ),
            );
            if (raw !== undefined && raw.trim()) {
              const num = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(num)) {
                await persistPatch({ rateLimitMaxBackoffMs: num });
                ctx.ui.notify(
                  `Saved rateLimitMaxBackoffMs = ${currentSettings.rateLimitMaxBackoffMs} (${saveScope}).`,
                  "info",
                );
              }
            }
          } else if (picked.startsWith("gitTimeoutMs:")) {
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                `Set gitTimeoutMs (${SWARM_SETTINGS_BOUNDS.gitTimeoutMs.min}-${SWARM_SETTINGS_BOUNDS.gitTimeoutMs.max})`,
                String(currentSettings.gitTimeoutMs),
              ),
            );
            if (raw !== undefined && raw.trim()) {
              const num = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(num)) {
                await persistPatch({ gitTimeoutMs: num });
                ctx.ui.notify(
                  `Saved gitTimeoutMs = ${currentSettings.gitTimeoutMs} (${saveScope}).`,
                  "info",
                );
              }
            }
          } else if (picked.startsWith("autoRebase:")) {
            await persistPatch({ autoRebase: !currentSettings.autoRebase });
            ctx.ui.notify(
              `Saved autoRebase = ${currentSettings.autoRebase ? "ON" : "OFF"} (${saveScope}).`,
              "info",
            );
          } else if (picked.startsWith("autoTeardownOnComplete:")) {
            await persistPatch({
              autoTeardownOnComplete: !currentSettings.autoTeardownOnComplete,
            });
            ctx.ui.notify(
              `Saved autoTeardownOnComplete = ${currentSettings.autoTeardownOnComplete ? "ON" : "OFF"} (${saveScope}).`,
              "info",
            );
          } else if (picked.startsWith("Save target:")) {
            saveScope = saveScope === "project" ? "global" : "project";
          }
        } catch (err) {
          ctx.ui.notify(`Failed to save setting: ${formatError(err)}`, "error");
        }
      }
    }

    async function handleBareCommand(ctx: ExtensionContext): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);
      const snapshot = engine.getSnapshot();

      if (canUseCustomTui(ctx)) {
        const [availableModels, runs] = await Promise.all([
          refreshAvailableModels(ctx, true),
          listRunsCached(store, true).catch(() => []),
        ]);
        const callbacks = makeModelPickerCallbacks(ctx);
        const action = await withModalGuard(() =>
          openSwarmHub(ctx, {
            state: getModelSettingsState(ctx),
            snapshot,
            runs,
            availableModels,
            initialScope: getPreferredSaveScope(),
            currentSessionId: getCurrentSessionId(ctx),
            activatedRun:
              snapshot.run !== null && activatedRunIds.has(snapshot.run.id),
            orchestratorModeActive: orchestratorMode,
            ...callbacks,
          }),
        );
        switch (action.kind) {
          case "draft":
            await startInteractiveDrafting(action.goal, ctx, {
              ...(action.validatorEnabled !== undefined
                ? { validatorEnabled: action.validatorEnabled }
                : {}),
              ...(action.maxConcurrency !== undefined
                ? { maxConcurrency: action.maxConcurrency }
                : {}),
            });
            return;
          case "direct":
            await startDirectSwarm(action.goal, ctx, {
              ...(action.validatorEnabled !== undefined
                ? { validatorEnabled: action.validatorEnabled }
                : {}),
              ...(action.maxConcurrency !== undefined
                ? { maxConcurrency: action.maxConcurrency }
                : {}),
            });
            return;
          case "ui":
            await handleOverlayCommand("", ctx);
            return;
          case "tweak":
            await handleTweakCommand("", ctx);
            return;
          case "pause":
            await handlePauseCommand("", ctx);
            return;
          case "resume":
            await handleResumeCommand(action.runId ?? "", ctx, {
              kickoff: action.kickoff ?? true,
            });
            return;
          case "done":
            await handleDoneCommand("", ctx);
            return;
          case "exit":
            await handleExitCommand("", ctx);
            return;
          case "focus":
            await handleFocusCommand(action.runId, ctx);
            return;
          case "settings":
            await handleSettingsCommand(ctx);
            return;
          case "teardown":
            await handleTeardownCommand("", ctx);
            return;
          case "cancel":
            refreshUI(ctx);
            return;
        }
      }

      if (!snapshot.run) {
        await startInteractiveDrafting("", ctx);
        return;
      }

      if (!ctx.hasUI) {
        await handleStatusCommand(ctx);
        return;
      }

      const run = snapshot.run;
      const pauseOrResumeLabel =
        run.status === "paused"
          ? "Resume — continue member launches & board wakeups"
          : "Pause — halt new launches & board wakeups";

      const uiLabel = "Open Swarm UI / Tasks (4-Tab) — Board, Members, Graph & Search";
      const statusLabel = "Show Status — zero-turn dashboard, channels & roster";
      const boardLabel = `Show Board — shared #seq Message Board (#${snapshot.boardHead})`;
      const graphLabel = "Show Graph — Spawn Tree & Peer @mention interaction graph";
      const modelsLabel = "Manage Models — 3-role defaults & live member models";
      const tweakLabel = "Tweak — revise plan, strategy, or add members interactively";
      const doneLabel = "Complete Swarm (/swarm done) — finish run & enter standby";
      const exitLabel =
        "Exit Swarm Orchestrator Mode (/swarm exit) — restore idle tools & host model";
      const newSwarmLabel = "Start New Swarm — interactive planning interview";
      const focusLabel = "Switch Focused Run — list / attach / detach";
      const settingsLabel = "Settings — 3-role models, warm pool, watchdog & git options";
      const teardownLabel = "Teardown — safely remove clean idle worktrees";

      const showDone = run.status === "active" || run.status === "paused";
      const menuChoices: string[] = [
        uiLabel,
        statusLabel,
        boardLabel,
        graphLabel,
        modelsLabel,
        ...(showDone ? [tweakLabel, pauseOrResumeLabel, doneLabel] : []),
        newSwarmLabel,
        focusLabel,
        settingsLabel,
        teardownLabel,
        ...(orchestratorMode && !showDone ? [exitLabel] : []),
      ];

      const choice = await withModalGuard(() =>
        ctx.ui.select(
          `🐝 Swarm (${run.id} · ${run.status}) — ${(run.title || run.objective).slice(0, 56)}`,
          menuChoices,
        ),
      );

      if (!choice) return;

      if (choice === uiLabel) {
        await handleOverlayCommand("", ctx);
      } else if (choice === statusLabel) {
        await handleStatusCommand(ctx);
      } else if (choice === boardLabel) {
        await handleBoardCommand("", ctx);
      } else if (choice === graphLabel) {
        await handleGraphCommand(ctx);
      } else if (choice === modelsLabel) {
        await handleModelsCommand("", ctx);
      } else if (choice === tweakLabel) {
        await handleTweakCommand("", ctx);
      } else if (choice === pauseOrResumeLabel) {
        if (run.status === "paused") {
          await handleResumeCommand("", ctx);
        } else {
          await handlePauseCommand("", ctx);
        }
      } else if (choice === doneLabel) {
        await handleDoneCommand("", ctx);
      } else if (choice === exitLabel) {
        await handleExitCommand("", ctx);
      } else if (choice === newSwarmLabel) {
        const seed = await withModalGuard(() =>
          ctx.ui.input("New Swarm Goal", "Describe what you want to build (optional)…"),
        );
        if (seed !== undefined) {
          await startInteractiveDrafting(seed, ctx);
        }
      } else if (choice === focusLabel) {
        await handleFocusCommand("", ctx);
      } else if (choice === settingsLabel) {
        await handleSettingsCommand(ctx);
      } else if (choice === teardownLabel) {
        await handleTeardownCommand("", ctx);
      }
    }

    async function handleSwarmCommand(
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const parsed = parseSwarmCommand(args);

      switch (parsed.kind) {
        case "bare":
          await handleBareCommand(ctx);
          return;
        case "goal":
          await startInteractiveDrafting(parsed.rest, ctx, {
            fromCli: true,
            skipFlagParsing: /^--(?:\s|$)/.test(args.trim()),
          });
          return;
        case "direct":
          await startDirectSwarm(parsed.rest, ctx, {
            fromCli: true,
          });
          return;
        case "tweak":
          await handleTweakCommand(parsed.rest, ctx);
          return;
        case "status":
          await handleStatusCommand(ctx);
          return;
        case "board":
          await handleBoardCommand(parsed.rest, ctx);
          return;
        case "graph":
          await handleGraphCommand(ctx);
          return;
        case "tasks":
        case "ui":
          await handleOverlayCommand(parsed.rest, ctx);
          return;
        case "models":
          await handleModelsCommand(parsed.rest, ctx);
          return;
        case "model":
          await handleModelCommand(parsed.rest, ctx);
          return;
        case "steer":
          await handleSteerCommand(parsed.rest, ctx);
          return;
        case "stop":
          await handleStopCommand(parsed.rest, ctx);
          return;
        case "merge":
          await handleMergeCommand(parsed.rest, ctx);
          return;
        case "kill":
          await handleKillCommand(parsed.rest, ctx);
          return;
        case "done":
          await handleDoneCommand(parsed.rest, ctx);
          return;
        case "pause":
          await handlePauseCommand(parsed.rest, ctx);
          return;
        case "resume":
          await handleResumeCommand(parsed.rest, ctx);
          return;
        case "cancel":
          await handleCancelCommand(ctx);
          return;
        case "exit":
          await handleExitCommand(parsed.rest, ctx);
          return;
        case "teardown":
          await handleTeardownCommand(parsed.rest, ctx);
          return;
        case "runs":
          await handleRunsCommand(ctx);
          return;
        case "focus":
          await handleFocusCommand(parsed.rest, ctx);
          return;
        case "settings":
          await handleSettingsCommand(ctx);
          return;
        case "help":
          emitZeroTurnMessage(ctx, buildHelpMarkdown());
          return;
      }
    }

    async function getSwarmCompletions(
      prefix: string,
    ): Promise<AutocompleteItem[] | null> {
      const items = await computeSwarmCompletions(prefix);
      if (!items || items.length === 0) {
        return null;
      }
      const trimmedPrefix = prefix.trimStart();
      const normalizedPrefix = /\s$/.test(prefix)
        ? trimmedPrefix.toLowerCase()
        : trimmedPrefix.trimEnd().replace(/\s+/g, " ").toLowerCase();
      if (
        items.length === 1 &&
        items[0]!.value.toLowerCase() === normalizedPrefix
      ) {
        return null;
      }
      return items;
    }

    const GOAL_LAUNCH_FLAG_CANDIDATES: ReadonlyArray<{
      label: string;
      description: string;
      takesValue?: boolean;
      group?: "validator" | "concurrency" | "branch" | "fast";
    }> = [
      { label: "--no-validator", description: "Disable independent validator for this run", group: "validator" },
      { label: "--validator", description: "Enable independent validator for this run", group: "validator" },
      { label: "--concurrency", description: "Max parallel workers (1..64; alias -c)", takesValue: true, group: "concurrency" },
      { label: "--branch", description: "Explicit base branch name (alias -b)", takesValue: true, group: "branch" },
      { label: "--fast", description: "Skip pre-modal adversarial contract review (alias --no-review)", group: "fast" },
      { label: "--no-review", description: "Skip pre-modal adversarial contract review (alias --fast)", group: "fast" },
      { label: "--file", description: "Read spec file into goal seed (alias -f)", takesValue: true },
      { label: "--", description: "End launch flags; pass remaining text literally as goal" },
    ];

    function computeGoalLaunchFlagCompletions(
      rawPrefix: string,
      commandPrefix: string,
    ): AutocompleteItem[] | null {
      const hasTrailingSpace = /\s$/.test(rawPrefix);
      const trimmed = rawPrefix.trimStart();
      const rawTokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
      const priorTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
      const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
      const lowerActive = activeToken.toLowerCase();

      // Stop completing flags once bare `--` or non-flag goal prose has started
      const usedGroups = new Set<string>();
      let expectingValueFor: string | null = null;
      for (const tok of priorTokens) {
        if (expectingValueFor) {
          expectingValueFor = null;
          continue;
        }
        const lower = tok.toLowerCase();
        if (lower === "--") {
          return null;
        }
        if (!lower.startsWith("-")) {
          return null;
        }
        const flagName = lower.includes("=") ? lower.slice(0, lower.indexOf("=")) : lower;
        const hasInline = lower.includes("=");
        if (flagName === "--no-validator" || flagName === "--validator") {
          usedGroups.add("validator");
        } else if (flagName === "--fast" || flagName === "--no-review") {
          usedGroups.add("fast");
        } else if (flagName === "--concurrency" || flagName === "-c") {
          usedGroups.add("concurrency");
          if (!hasInline) expectingValueFor = "concurrency";
        } else if (flagName === "--branch" || flagName === "-b") {
          usedGroups.add("branch");
          if (!hasInline) expectingValueFor = "branch";
        } else if (flagName === "--file" || flagName === "-f") {
          if (!hasInline) expectingValueFor = "file";
        } else {
          return null;
        }
      }

      if (expectingValueFor) {
        return null;
      }
      if (activeToken && !activeToken.startsWith("-")) {
        return null;
      }

      const prefixParts = [commandPrefix, ...priorTokens].filter(Boolean);
      const valuePrefix = prefixParts.length > 0 ? `${prefixParts.join(" ")} ` : "";
      const items = GOAL_LAUNCH_FLAG_CANDIDATES.filter(
        (c) =>
          (!c.group || !usedGroups.has(c.group)) &&
          c.label.startsWith(lowerActive),
      ).map(
        (c): AutocompleteItem => ({
          value: `${valuePrefix}${c.label}`,
          label: c.label,
          description: c.description,
        }),
      );
      return items.length > 0 ? items : null;
    }

    async function computeSwarmCompletions(
      prefix: string,
    ): Promise<AutocompleteItem[] | null> {
      const trimmedStart = prefix.trimStart();
      if (!trimmedStart.includes(" ")) {
        if (trimmedStart.startsWith("-")) {
          return computeGoalLaunchFlagCompletions(prefix, "");
        }
        const lower = trimmedStart.toLowerCase();
        const matches = SWARM_SUBCOMMANDS.filter((c) => c.name.startsWith(lower)).map(
          (c): AutocompleteItem => ({
            value: c.name,
            label: c.name,
            description: c.description,
          }),
        );
        if ((lower.length > 0 || orchestratorMode) && "exit".startsWith(lower)) {
          matches.push({
            value: "exit",
            label: "exit",
            description:
              "Exit Persistent Swarm Orchestrator Mode and restore idle tools [--force]",
          });
        }
        return matches.length > 0 ? matches : null;
      }

      const spaceIdx = trimmedStart.search(/\s/);
      const sub = trimmedStart.slice(0, spaceIdx).toLowerCase();
      const argPrefix = trimmedStart.slice(spaceIdx).trimStart();

      if (sub.startsWith("-")) {
        return computeGoalLaunchFlagCompletions(prefix, "");
      }

      if (sub === "direct") {
        const directArgWithTrailing = trimmedStart.slice(spaceIdx).replace(/^\s+/, "");
        return computeGoalLaunchFlagCompletions(directArgWithTrailing, "direct");
      }

      if (sub === "board") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const priorTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
        const prevToken = priorTokens[priorTokens.length - 1]?.toLowerCase();
        const valuePrefix = priorTokens.length > 0 ? `board ${priorTokens.join(" ")} ` : "board ";

        if (prevToken === "--channel" || prevToken === "-c") {
          const run = getSnapshotSafe().run;
          const channels = run ? Object.keys(run.channels) : [DEFAULT_CHANNEL];
          const items = channels
            .filter((ch) => ch.toLowerCase().startsWith(activeToken.toLowerCase()))
            .map((ch): AutocompleteItem => ({
              value: `${valuePrefix}${ch}`,
              label: ch,
              description: `Filter board by #${ch}`,
            }));
          return items.length > 0 ? items : null;
        }

        const candidates: Array<{ label: string; description: string }> = [
          { label: "10", description: "Show last 10 board messages" },
          { label: "25", description: "Show last 25 board messages" },
          { label: "50", description: "Show last 50 board messages" },
          { label: "100", description: "Show last 100 board messages" },
          { label: "--channel", description: "Filter by channel name (--channel <ch>)" },
          { label: "--search", description: "Filter by substring (--search <query>)" },
        ];
        const items = candidates
          .filter((c) => c.label.startsWith(activeToken.toLowerCase()))
          .map((c): AutocompleteItem => ({
            value: `${valuePrefix}${c.label}`,
            label: c.label,
            description: c.description,
          }));
        return items.length > 0 ? items : null;
      }

      if (sub === "tasks" || sub === "ui" || sub === "mc" || sub === "open" || sub === "panel") {
        const lowerActive = argPrefix.toLowerCase();
        const items: AutocompleteItem[] = [];
        for (const tab of ["board", "members", "graph", "search"] as const) {
          if (tab.startsWith(lowerActive)) {
            items.push({
              value: `${sub} ${tab}`,
              label: tab,
              description: `Open Swarm overlay on the ${tab} tab`,
            });
          }
        }
        const run = getSnapshotSafe().run;
        if (run) {
          for (const ch of Object.keys(run.channels)) {
            const hashCh = `#${ch}`;
            if (hashCh.toLowerCase().startsWith(lowerActive) || ch.toLowerCase().startsWith(lowerActive)) {
              items.push({
                value: `${sub} ${hashCh}`,
                label: hashCh,
                description: `Open Board tab filtered to #${ch}`,
              });
            }
          }
          for (const member of getOrderedMembers(run)) {
            if (member.name.toLowerCase().startsWith(lowerActive)) {
              items.push({
                value: `${sub} ${member.name}`,
                label: member.name,
                description: `${member.role} [${member.state}]`,
              });
            }
          }
        }
        return items.length > 0 ? items : null;
      }

      if (sub === "model" || sub === "models") {
        const cmdWord = sub;
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const SCOPE_FLAGS = new Set(["--global", "-g", "--project"]);
        const priorRawTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
        const priorPositional = priorRawTokens.filter(
          (t) => !SCOPE_FLAGS.has(t.toLowerCase()),
        );
        const positionalCount = priorPositional.length;
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
        const lowerActive = activeToken.toLowerCase();
        const valuePrefix =
          priorRawTokens.length > 0 ? `${cmdWord} ${priorRawTokens.join(" ")}` : cmdWord;
        const hasScopeFlag = priorRawTokens.some((t) =>
          SCOPE_FLAGS.has(t.toLowerCase()),
        );

        if (activeToken.startsWith("-") && positionalCount <= 2) {
          const items: AutocompleteItem[] = [];
          if (sub === "models" && positionalCount === 0 && "--print".startsWith(lowerActive)) {
            items.push({
              value: `${valuePrefix} --print`,
              label: "--print",
              description: "Print zero-turn Markdown overview",
            });
          }
          if (sub === "model" && !hasScopeFlag) {
            for (const flag of ["--global", "--project"]) {
              if (flag.startsWith(lowerActive)) {
                items.push({
                  value: `${valuePrefix} ${flag}`,
                  label: flag,
                  description:
                    flag === "--global"
                      ? "Save to ~/.pi/agent/pi-swarm-settings.json"
                      : "Save to .pi/pi-swarm-settings.json",
                });
              }
            }
          }
          if (items.length > 0) return items;
        }

        if (positionalCount === 0) {
          const items: AutocompleteItem[] = [];
          for (const role of MODEL_ROLES) {
            if (role.startsWith(lowerActive)) {
              items.push({
                value: `${valuePrefix} ${role}`,
                label: role,
                description: `Configure ${role} role default model`,
              });
            }
          }
          if (sub === "models" && "fallbacks".startsWith(lowerActive)) {
            items.push({
              value: `${valuePrefix} fallbacks`,
              label: "fallbacks",
              description: "Open Model Picker on Fallbacks tab",
            });
          }
          if (sub === "models" && "--print".startsWith(lowerActive)) {
            items.push({
              value: `${valuePrefix} --print`,
              label: "--print",
              description: "Print zero-turn Markdown overview",
            });
          }
          const run = getSnapshotSafe().run;
          if (run) {
            for (const entry of getOrderedMembers(run)) {
              if (entry.state === "killed") continue;
              const atName = `@${entry.name}`;
              if (
                entry.name.toLowerCase().startsWith(lowerActive) ||
                atName.toLowerCase().startsWith(lowerActive)
              ) {
                items.push({
                  value: `${valuePrefix} ${atName}`,
                  label: atName,
                  description: `${entry.role} [${entry.state}] ${entry.model ?? "default"}`,
                });
              }
            }
          }
          return items.length > 0 ? items : null;
        }

        if (positionalCount === 1) {
          const target = priorPositional[0]!;
          const targetClean = target.replace(/^@/, "").toLowerCase();
          const items: AutocompleteItem[] = [];

          // Colon thinking suffix completion when user typed `<model>:`
          const colonIdx = activeToken.lastIndexOf(":");
          if (colonIdx > 0) {
            const modelPrefix = activeToken.slice(0, colonIdx);
            const effortPrefix = activeToken.slice(colonIdx + 1).toLowerCase();
            for (const lvl of VALID_THINKING_LEVELS) {
              if (lvl.startsWith(effortPrefix)) {
                items.push({
                  value: `${valuePrefix} ${modelPrefix}:${lvl}`,
                  label: `${modelPrefix}:${lvl}`,
                  description: `Set reasoning effort to ${lvl}`,
                });
              }
            }
            if (items.length > 0) return items;
          }

          if (isSwarmModelRole(targetClean) && "default".startsWith(lowerActive)) {
            items.push({
              value: `${valuePrefix} default`,
              label: "default",
              description: "Clear override and inherit host model",
            });
          }

          const seenModels = new Set<string>();
          const pushCandidate = (id: string, desc: string) => {
            if (!id || seenModels.has(id.toLowerCase())) return;
            if (!id.toLowerCase().includes(lowerActive)) return;
            seenModels.add(id.toLowerCase());
            items.push({
              value: `${valuePrefix} ${id}`,
              label: id,
              description: desc,
            });
          };

          for (const fb of currentSettings.fallbackModels) {
            pushCandidate(fb, "Configured fallback model");
          }
          for (const m of [
            currentSettings.orchestratorModel,
            currentSettings.workerModel,
            currentSettings.validatorModel,
          ]) {
            if (m) pushCandidate(m, "Configured role model");
          }
          for (const avail of cachedAvailableModels) {
            pushCandidate(
              avail.fullId,
              avail.name && avail.name !== avail.id
                ? `${avail.name} (${avail.provider})`
                : avail.provider,
            );
            if (items.length >= 25) break;
          }
          return items.length > 0 ? items : null;
        }

        if (positionalCount === 2) {
          const items: AutocompleteItem[] = [];
          for (const lvl of VALID_THINKING_LEVELS) {
            if (lvl.startsWith(lowerActive)) {
              items.push({
                value: `${valuePrefix} ${lvl}`,
                label: lvl,
                description: `Set thinking level to ${lvl}`,
              });
            }
          }
          if ("default".startsWith(lowerActive)) {
            items.push({
              value: `${valuePrefix} default`,
              label: "default",
              description: "Reset thinking level to role/model default",
            });
          }
          if (!hasScopeFlag) {
            for (const flag of ["--global", "--project"]) {
              if (flag.startsWith(lowerActive)) {
                items.push({
                  value: `${valuePrefix} ${flag}`,
                  label: flag,
                  description:
                    flag === "--global"
                      ? "Save to ~/.pi/agent/pi-swarm-settings.json"
                      : "Save to .pi/pi-swarm-settings.json",
                });
              }
            }
          }
          return items.length > 0 ? items : null;
        }

        if (positionalCount === 3 && !hasScopeFlag) {
          const items: AutocompleteItem[] = [];
          for (const flag of ["--global", "--project"]) {
            if (flag.startsWith(lowerActive)) {
              items.push({
                value: `${valuePrefix} ${flag}`,
                label: flag,
                description:
                  flag === "--global"
                    ? "Save to ~/.pi/agent/pi-swarm-settings.json"
                    : "Save to .pi/pi-swarm-settings.json",
              });
            }
          }
          return items.length > 0 ? items : null;
        }

        return null;
      }

      if (sub === "steer") {
        const run = getSnapshotSafe().run;
        if (!run) return null;
        const lowerActive = argPrefix.toLowerCase();
        const items = getOrderedMembers(run)
          .filter((entry) => entry.state !== "killed" && entry.name.toLowerCase().startsWith(lowerActive))
          .map((entry): AutocompleteItem => ({
            value: `steer ${entry.name} `,
            label: entry.name,
            description: `${entry.role} [${entry.state}]`,
          }));
        return items.length > 0 ? items : null;
      }

      if (sub === "stop") {
        const run = getSnapshotSafe().run;
        if (!run) return null;
        const lowerActive = argPrefix.toLowerCase();
        const items = getOrderedMembers(run)
          .filter(
            (entry) =>
              entry.state !== "killed" &&
              entry.state !== "stopped" &&
              entry.name.toLowerCase().startsWith(lowerActive),
          )
          .map((entry): AutocompleteItem => ({
            value: `stop ${entry.name}`,
            label: entry.name,
            description: `${entry.role} [${entry.state}]`,
          }));
        return items.length > 0 ? items : null;
      }

      if (sub === "merge") {
        const run = getSnapshotSafe().run;
        if (!run) return null;
        const lowerActive = argPrefix.toLowerCase();
        const items: AutocompleteItem[] = [];
        for (const entry of getOrderedMembers(run)) {
          if (entry.workspace === "inherit" || !entry.branch) continue;
          if (entry.name.toLowerCase().startsWith(lowerActive)) {
            items.push({
              value: `merge ${entry.name}`,
              label: entry.name,
              description: `${entry.workspace}:${entry.branch} [${entry.state}]`,
            });
          }
        }
        return items.length > 0 ? items : null;
      }

      if (sub === "kill") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const priorTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
        const valuePrefix = priorTokens.length > 0 ? `kill ${priorTokens.join(" ")} ` : "kill ";
        const lowerActive = activeToken.toLowerCase();
        const usedTokens = new Set(priorTokens.map((t) => t.toLowerCase()));
        const run = getSnapshotSafe().run;
        const items: AutocompleteItem[] = [];
        if (run && !priorTokens.some((t) => !t.startsWith("-"))) {
          for (const entry of getOrderedMembers(run)) {
            if (entry.state === "killed") continue;
            if (entry.name.toLowerCase().startsWith(lowerActive)) {
              items.push({
                value: `${valuePrefix}${entry.name}`,
                label: entry.name,
                description: `${entry.role} [${entry.state}]`,
              });
            }
          }
        }
        if ("--force".startsWith(lowerActive) && !usedTokens.has("--force")) {
          items.push({
            value: `${valuePrefix}--force`,
            label: "--force",
            description: "Force-kill even if member worktree has uncommitted changes",
          });
        }
        return items.length > 0 ? items : null;
      }

      if (sub === "done") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const priorTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
        const valuePrefix =
          priorTokens.length > 0 ? `done ${priorTokens.join(" ")} ` : "done ";
        const usedTokens = new Set(priorTokens.map((t) => t.toLowerCase()));
        if (
          !usedTokens.has("--force") &&
          !usedTokens.has("-f") &&
          "--force".startsWith(activeToken.toLowerCase())
        ) {
          return [
            {
              value: `${valuePrefix}--force`,
              label: "--force",
              description:
                "Force-close Mission even if features, VAL-* assertions, or branches are unfinished",
            },
          ];
        }
        return null;
      }

      if (sub === "exit" || sub === "leave") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const priorTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
        if (priorTokens.length === 0 && "--force".startsWith(activeToken.toLowerCase())) {
          return [
            {
              value: `${sub} --force`,
              label: "--force",
              description:
                "Pause & detach active Swarm run and exit Persistent Orchestrator Mode",
            },
          ];
        }
        return null;
      }

      if (sub === "teardown") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const priorTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
        const valuePrefix =
          priorTokens.length > 0 ? `teardown ${priorTokens.join(" ")} ` : "teardown ";
        const usedTokens = new Set(priorTokens.map((t) => t.toLowerCase()));
        const flags = [
          {
            label: "--force",
            description: "Stop active members and force-remove dirty worktrees",
          },
          {
            label: "--delete-branches",
            description: "Also delete local member branches for removed worktrees",
          },
        ];
        const items = flags
          .filter(
            (f) =>
              !usedTokens.has(f.label) &&
              f.label.startsWith(activeToken.toLowerCase()),
          )
          .map((f): AutocompleteItem => ({
            value: `${valuePrefix}${f.label}`,
            label: f.label,
            description: f.description,
          }));
        return items.length > 0 ? items : null;
      }

      if (sub === "resume") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const priorTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
        const valuePrefix =
          priorTokens.length > 0 ? `resume ${priorTokens.join(" ")} ` : "resume ";
        const lowerActive = activeToken.toLowerCase();
        const usedTokens = new Set(priorTokens.map((t) => t.toLowerCase()));
        const items: AutocompleteItem[] = [];
        for (const flag of [
          { label: "--continue", description: "Always trigger an Orchestrator continuation turn" },
          { label: "--quiet", description: "Attach & unpause without waking the Orchestrator" },
        ]) {
          if (!usedTokens.has(flag.label) && flag.label.startsWith(lowerActive)) {
            items.push({
              value: `${valuePrefix}${flag.label}`,
              label: flag.label,
              description: flag.description,
            });
          }
        }
        if (activeStore && !priorTokens.some((t) => !t.startsWith("-"))) {
          try {
            const runs = await listRunsCached(activeStore);
            const currentSid = getCurrentSessionId();
            for (const r of runs) {
              if (!isRunResumableBySession(r, currentSid)) continue;
              if (r.id.toLowerCase().startsWith(lowerActive)) {
                items.push({
                  value: `${valuePrefix}${r.id}`,
                  label: r.id,
                  description: `[${r.status}] ${(r.title || r.objective).slice(0, 48)}`,
                });
              }
            }
          } catch {
            // ignore autocomplete store errors
          }
        }
        return items.length > 0 ? items : null;
      }

      if (sub === "focus" && activeStore) {
        try {
          const runs = await listRunsCached(activeStore);
          const items: AutocompleteItem[] = runs
            .filter((r) => r.id.toLowerCase().startsWith(argPrefix.toLowerCase()))
            .map((r) => ({
              value: `focus ${r.id}`,
              label: r.id,
              description: `[${r.status}] ${(r.title || r.objective).slice(0, 48)}`,
            }));
          if ("none".startsWith(argPrefix.toLowerCase())) {
            items.push({
              value: "focus none",
              label: "none",
              description: "Detach session focus",
            });
          }
          return items.length > 0 ? items : null;
        } catch {
          return null;
        }
      }

      return null;
    }

    // ------------------------------------------------------------------------
    // Register Commands, Custom Message Renderers & SSH/Tmux Shortcuts
    // ------------------------------------------------------------------------
    pi.registerCommand("swarm", {
      description:
        "Pi Swarm v0.9.0 — Dynamic Mission Goal Engine & Antigravity Swarm orchestrator (VAL-* contracts, Sisyphus auto-continuation, Droid Mission model/effort picker & cross-session resume, shared #seq board, non-blocking swarm_wait, warm sessions & worktrees)",
      getArgumentCompletions: getSwarmCompletions,
      handler: handleSwarmCommand,
    });

    pi.registerCommand("swarm-direct", {
      description:
        "Fast-path /swarm direct [flags] [--] <goal> — skip Q&A and launch Dynamic Swarm immediately",
      getArgumentCompletions: async (prefix: string) => {
        const items = computeGoalLaunchFlagCompletions(prefix, "");
        if (!items || items.length === 0) return null;
        const normalizedPrefix = /\s$/.test(prefix)
          ? prefix.trimStart().toLowerCase()
          : prefix.trim().replace(/\s+/g, " ").toLowerCase();
        if (items.length === 1 && items[0]!.value.toLowerCase() === normalizedPrefix) {
          return null;
        }
        return items;
      },
      handler: async (args, ctx) => {
        await startDirectSwarm(args, ctx, { fromCli: true });
      },
    });

    if (typeof pi.registerMessageRenderer === "function") {
      pi.registerMessageRenderer(SWARM_WAKEUP_CUSTOM_TYPE, (message, options, theme) =>
        renderSwarmWakeupMessage(message, options, theme),
      );
      pi.registerMessageRenderer(SWARM_STATUS_CUSTOM_TYPE, (message, options, theme) =>
        renderSwarmStatusMessage(message, options, theme),
      );
    }

    if (typeof pi.registerShortcut === "function") {
      const registerSafeShortcut = (
        shortcut: "alt+s" | "alt+m" | "alt+w",
        description: string,
        handler: (ctx: ExtensionContext) => Promise<void> | void,
      ): void => {
        try {
          pi.registerShortcut(shortcut, { description, handler });
        } catch {
          // Ignore shortcut conflicts or unsupported host environments
        }
      };

      registerSafeShortcut(
        "alt+s",
        "Open Swarm Mission Control (or Swarm Hub when idle)",
        async (ctx) => {
          if (isModalOpen(widgetState)) return;
          lastCtx = ctx;
          if (getSnapshotSafe().run) {
            await handleOverlayCommand("", ctx);
          } else {
            await handleBareCommand(ctx);
          }
        },
      );

      registerSafeShortcut(
        "alt+m",
        "Open Swarm Mission Model Picker",
        async (ctx) => {
          if (isModalOpen(widgetState)) return;
          lastCtx = ctx;
          await handleModelsCommand("", ctx);
        },
      );

      registerSafeShortcut(
        "alt+w",
        "Toggle expanded Swarm Dashboard above editor",
        (ctx) => {
          if (isModalOpen(widgetState)) return;
          lastCtx = ctx;
          widgetState.expanded = !widgetState.expanded;
          refreshUI(ctx);
        },
      );
    }

    // ------------------------------------------------------------------------
    // Lifecycle Hooks (`tool_call`, `session_start`, `session_tree`,
    // `session_compact`, `session_compact_failed`, `turn_start`, `input`,
    // `before_agent_start`, `agent_settled`, `session_shutdown`)
    // ------------------------------------------------------------------------

    pi.on("tool_call", (event, ctx) => {
      if (ctx) {
        lastCtx = ctx;
      }
      const toolLower = event.toolName.toLowerCase();
      const isEditTool = ORCHESTRATOR_BLOCKED_EDIT_TOOLS.has(toolLower);
      const isBashTool = toolLower === "bash";
      if (!isEditTool && !isBashTool) {
        return undefined;
      }

      const snapshot = getSnapshotSafe();
      const hasOwnedLiveRun = isOwnedLiveRun(snapshot.run, ctx);
      const isPersistentOrchestratorOwner = orchestratorMode || hasOwnedLiveRun;

      if (!isPersistentOrchestratorOwner) {
        if (draftController.isActive() && isEditTool) {
          return {
            block: true,
            reason: DRAFTING_WRITE_GUARD_REASON,
          };
        }
        return undefined;
      }

      // Exact block on write/edit/powershell; best-effort pattern-matching guard on bash
      // (stops habitual orchestrator mutations rather than acting as an OS sandbox).
      if (isEditTool) {
        return {
          block: true,
          reason: ORCHESTRATOR_WRITE_GUARD_REASON,
        };
      }

      const rawCommand =
        typeof (event.input as { command?: unknown } | undefined)?.command ===
        "string"
          ? (event.input as { command: string }).command
          : "";
      const guard = isReadOnlyValidationCommand(rawCommand);
      if (!guard.allowed) {
        return {
          block: true,
          reason: buildOrchestratorBashGuardReason(guard.reason),
        };
      }
      return undefined;
    });

    pi.on("session_start", async (event, ctx) => {
      if (
        event.reason !== "reload" &&
        activeStore &&
        activeEngine?.getSnapshot().activeRunId &&
        activeSessionId
      ) {
        await releaseRunOwnershipIfHeld(
          activeStore,
          activeEngine.getSnapshot().activeRunId,
          activeSessionId,
        );
      }
      if (activeEngine || unbindShortcuts) {
        await disposeRuntime(ctx);
      }
      isShutDown = false;
      lastCtx = ctx;
      activeSessionId =
        ctx.sessionManager?.getSessionId?.()?.trim() || getSessionIdSafe(ctx);
      sessionStartReason = event.reason;

      await ensureBound(ctx);
      await rehydrateSessionState(ctx);
      await mountUI(ctx);
      void refreshAvailableModels(ctx, true);

      if (
        !activeEngine?.getSnapshot().activeRunId &&
        !draftController.isActive() &&
        !orchestratorMode &&
        activeStore &&
        ctx.hasUI
      ) {
        try {
          const allRuns = await listRunsCached(activeStore);
          const currentSid = activeSessionId || getCurrentSessionId(ctx);
          const unfinished = allRuns.filter((r) => isRunResumableBySession(r, currentSid));
          if (unfinished.length === 1) {
            const r = unfinished[0]!;
            ctx.ui.notify(
              `Unfinished Swarm Mission "${r.title}" (${r.id}, ${r.status}) — run /swarm or /swarm resume to continue.`,
              "info",
            );
            unfinishedFooterCue = "🐝 1 unfinished mission · /swarm resume";
            lastStatusText = unfinishedFooterCue;
            ctx.ui.setStatus(SWARM_STATUS_KEY, unfinishedFooterCue);
          } else if (unfinished.length > 1) {
            ctx.ui.notify(
              `${unfinished.length} unfinished Swarm Missions found — run /swarm or /swarm resume to continue.`,
              "info",
            );
            unfinishedFooterCue = `🐝 ${unfinished.length} unfinished missions · /swarm resume`;
            lastStatusText = unfinishedFooterCue;
            ctx.ui.setStatus(SWARM_STATUS_KEY, unfinishedFooterCue);
          }
        } catch {
          // best-effort startup hint
        }
      }
    });

    pi.on("session_tree", async (_event, ctx) => {
      lastCtx = ctx;
      await rehydrateSessionState(ctx);
    });

    pi.on("session_compact", (event, ctx) => {
      lastCtx = ctx;
      if (!event.willRetry) {
        const currentSid = getCurrentSessionId(ctx);
        const focusState = rehydrateFocusState(ctx);
        if (
          focusState.hasEntry &&
          focusState.sessionId === currentSid &&
          focusState.orchestratorMode !== undefined
        ) {
          orchestratorMode = focusState.orchestratorMode;
          autoConfirmDefault = focusState.orchestratorMode
            ? Boolean(focusState.autoConfirmDefault)
            : false;
        }
        const snapAfterFocus = getSnapshotSafe();
        draftController.rehydrate(ctx, {
          syncToolProfile: true,
          hasActiveRun: isOwnedLiveRun(snapAfterFocus.run, ctx),
          hasPersistentOrchestrator: orchestratorMode,
        });
        syncDraftWidgetState(draftController.getDraft());
        syncActiveRunSections({ ctx });
        refreshUI(ctx);
        scheduleWakeupFlush(ctx);
      }
    });

    pi.on("session_compact_failed", (event, ctx) => {
      lastCtx = ctx;
      if (!event.willRetry) {
        scheduleWakeupFlush(ctx);
      }
    });

    pi.on("turn_start", (event) => {
      currentTurnIndex = event.turnIndex;
      if (event.turnIndex > 0) {
        const activeRunId = activeEngine?.getSnapshot().activeRunId;
        if (activeRunId) {
          for (let i = pendingWakeups.length - 1; i >= 0; i--) {
            const item = pendingWakeups[i]!;
            if (item.type === "kickoff" && item.runId === activeRunId) {
              pendingWakeups.splice(i, 1);
            }
          }
        }
        if (
          waitArmedTurnIndex !== null &&
          event.turnIndex > waitArmedTurnIndex + 1
        ) {
          disarmOrchestratorWait("Turn continued past swarm_wait batch");
        }
      }
    });

    function extractLastAssistantText(
      event: unknown,
      ctx?: ExtensionContext,
    ): string | undefined {
      if (event && typeof event === "object") {
        const ev = event as Record<string, unknown>;
        if (typeof ev.lastAssistantText === "string") {
          return ev.lastAssistantText;
        }
        if (typeof ev.text === "string") {
          return ev.text;
        }
        if (ev.message && typeof ev.message === "object") {
          const role = (ev.message as { role?: unknown }).role;
          if (role === undefined || role === "assistant") {
            const fromMsg = extractAgentMessagePlainText(ev.message);
            if (fromMsg !== undefined) {
              return fromMsg;
            }
          }
        }
        if (Array.isArray(ev.messages)) {
          for (let i = ev.messages.length - 1; i >= 0; i--) {
            const m = ev.messages[i] as { role?: unknown } | undefined;
            if (!m || typeof m !== "object") continue;
            if (m.role === "user") break;
            if (m.role === "assistant") {
              const fromArr = extractAgentMessagePlainText(m);
              if (fromArr !== undefined) {
                return fromArr;
              }
            }
          }
        }
      }

      if (lastObservedAssistantText !== undefined) {
        return lastObservedAssistantText;
      }

      const targetCtx = ctx ?? lastCtx;
      try {
        const sm = targetCtx?.sessionManager as
          | {
              buildSessionContext?: () => { messages?: unknown[] };
              buildSessionProjection?: () => { messages?: unknown[] };
            }
          | undefined;
        const messages =
          typeof sm?.buildSessionContext === "function"
            ? sm.buildSessionContext()?.messages
            : typeof sm?.buildSessionProjection === "function"
              ? sm.buildSessionProjection()?.messages
              : undefined;
        if (Array.isArray(messages)) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i] as { role?: unknown } | undefined;
            if (!m || typeof m !== "object") continue;
            if (m.role === "user") break;
            if (m.role === "assistant") {
              const txt = extractAgentMessagePlainText(m);
              if (txt !== undefined) {
                return txt;
              }
            }
          }
        }
      } catch {
        // ignore sessionManager read errors in mock/headless harnesses
      }

      try {
        const branch = targetCtx?.sessionManager?.getBranch?.();
        if (Array.isArray(branch)) {
          for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i] as
              | { type?: unknown; message?: { role?: unknown } }
              | undefined;
            if (!entry || typeof entry !== "object") continue;
            if (entry.type === "message" && entry.message) {
              if (entry.message.role === "user") break;
              if (entry.message.role === "assistant") {
                const txt = extractAgentMessagePlainText(entry.message);
                if (txt !== undefined) {
                  return txt;
                }
              }
            }
          }
        }
      } catch {
        // ignore branch inspection errors
      }

      return undefined;
    }

    pi.on("turn_end", (event) => {
      const msg = (event as { message?: { role?: unknown } } | undefined)?.message;
      if (msg && (msg.role === undefined || msg.role === "assistant")) {
        const txt = extractAgentMessagePlainText(msg);
        if (txt !== undefined) {
          lastObservedAssistantText = txt;
        }
      }
    });

    pi.on("message_end", (event) => {
      const msg = (event as { message?: { role?: unknown } } | undefined)?.message;
      if (msg && msg.role === "assistant") {
        const txt = extractAgentMessagePlainText(msg);
        if (txt !== undefined) {
          lastObservedAssistantText = txt;
        }
      }
    });

    pi.on("agent_end", (event) => {
      const msgs = (event as { messages?: unknown[] } | undefined)?.messages;
      if (Array.isArray(msgs)) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i] as { role?: unknown } | undefined;
          if (!m || typeof m !== "object") continue;
          if (m.role === "user") break;
          if (m.role === "assistant") {
            const txt = extractAgentMessagePlainText(m);
            if (txt !== undefined) {
              lastObservedAssistantText = txt;
              break;
            }
          }
        }
      }
    });

    pi.on("message_start", (event) => {
      if ((event.message as { role?: string } | undefined)?.role === "user") {
        disarmOrchestratorWait("User message started");
      }
    });

    pi.on("input", (event, ctx) => {
      if (ctx) {
        lastCtx = ctx;
      }
      const isUserSource =
        event.source === "interactive" || event.source === "rpc";
      const trimmedText = event.text.trim();
      if (
        isUserSource &&
        trimmedText.length > 0 &&
        !shouldSkipInputPreflight(trimmedText)
      ) {
        notifyEngineHumanInputAwaited(false);
        resetGoalContinuation(activeEngine?.getSnapshot().activeRunId);
        if ((ctx ?? lastCtx)?.isIdle()) {
          userPromptPreflight = true;
          if (userPromptPreflightTimer) {
            clearTimeout(userPromptPreflightTimer);
          }
          userPromptPreflightTimer = setTimeout(() => {
            userPromptPreflight = false;
            userPromptPreflightTimer = undefined;
            scheduleWakeupFlush();
          }, 5_000);
          userPromptPreflightTimer.unref?.();
        }
        if (!draftController.isActive() && activeEngine) {
          const snap = activeEngine.getSnapshot();
          if (
            snap.run &&
            snap.run.status === "active" &&
            isCurrentSessionOwner(snap.run, ctx ?? lastCtx)
          ) {
            disarmOrchestratorWait("User sent interactive direction");
            latestHumanDirection = {
              text: trimmedText,
              timestamp: new Date().toISOString(),
            };
          }
        }
      }
      return { action: "continue" };
    });

    pi.on("before_agent_start", async (event, ctx) => {
      lastCtx = ctx;
      currentTurnIndex = 0;
      lastObservedAssistantText = undefined;
      disarmOrchestratorWait("New agent run started");
      clearWakeupInFlight();
      clearUserPromptPreflight();
      activeRunSections = event.systemPromptOptions?.sections;

      const draft = draftController.getDraft() ?? draftController.rehydrate(ctx);

      if (event.systemPromptOptions?.sections) {
        if (isDraftActive(draft)) {
          event.systemPromptOptions.sections.swarm =
            buildDraftingSystemOverlay(draft);
          delete event.systemPromptOptions.sections.swarm_state;
        } else {
          const snapshot = getSnapshotSafe();
          if (isOwnedLiveRun(snapshot.run, ctx)) {
            if (snapshot.run?.status === "active") {
              activatedRunIds.add(snapshot.run.id);
            }
            const steerText =
              event.messageType === "user" ? latestHumanDirection?.text : undefined;
            if (event.messageType === "user") {
              latestHumanDirection = undefined;
            }
            event.systemPromptOptions.sections.swarm =
              buildOrchestratorStaticSection(snapshot);
            event.systemPromptOptions.sections.swarm_state =
              enrichLiveStateWithMissionSync(
                buildOrchestratorLiveStateSection(snapshot, {
                  includeRecentBoard: event.messageType === "user",
                  ...(steerText ? { humanSteeringText: steerText } : {}),
                }),
                snapshot.run,
                steerText,
              );
          } else if (orchestratorMode) {
            event.systemPromptOptions.sections.swarm = buildCurrentStandbySection(
              snapshot,
              ctx,
            );
            delete event.systemPromptOptions.sections.swarm_state;
          } else {
            delete event.systemPromptOptions.sections.swarm;
            delete event.systemPromptOptions.sections.swarm_state;
          }
        }
        return undefined;
      }

      // Fallback for non-standard harnesses without systemPromptOptions.sections
      let sectionContent: string | undefined;
      if (isDraftActive(draft)) {
        sectionContent = buildDraftingSystemOverlay(draft);
      } else {
        const snapshot = getSnapshotSafe();
        if (isOwnedLiveRun(snapshot.run, ctx)) {
          if (snapshot.run?.status === "active") {
            activatedRunIds.add(snapshot.run.id);
          }
          const steerText =
            event.messageType === "user" ? latestHumanDirection?.text : undefined;
          if (event.messageType === "user") {
            latestHumanDirection = undefined;
          }
          sectionContent = enrichLiveStateWithMissionSync(
            buildOrchestratorPlaybookSection(snapshot, {
              ...(steerText ? { humanSteeringText: steerText } : {}),
            }),
            snapshot.run,
            steerText,
          );
        } else if (orchestratorMode) {
          sectionContent = buildCurrentStandbySection(snapshot, ctx);
        }
      }

      if (sectionContent) {
        return {
          message: {
            customType: SWARM_CONTRACT_CUSTOM_TYPE,
            content: sectionContent,
            display: false,
          },
        };
      }
      return undefined;
    });

    pi.on("agent_settled", (event, ctx) => {
      lastCtx = ctx;
      activeRunSections = undefined;
      clearUserPromptPreflight();
      latestHumanDirection = undefined;
      refreshUI(ctx);
      // Do not fight the user immediately after an explicit abort (Esc)
      if (event.aborted) {
        return;
      }
      if (pendingWakeups.length > 0 && ctx.isIdle() && !ctx.hasPendingMessages()) {
        flushPendingWakeups(ctx);
        return;
      }

      // Sisyphus Anti-Premature-Stop Auto-Continuation Guard:
      // Relentlessly advance structured Goal Missions when Orchestrator ends a turn
      // with plain text (without swarm_wait and without swarm{action:"done"}).
      if (
        isShutDown ||
        wakeupInFlight ||
        userPromptPreflight ||
        draftController.isActive() ||
        pendingWakeups.length > 0 ||
        !ctx.isIdle() ||
        ctx.hasPendingMessages()
      ) {
        return;
      }

      const snapshot = getSnapshotSafe();
      const run = snapshot.run;
      if (
        !run ||
        run.status !== "active" ||
        !activatedRunIds.has(run.id) ||
        !isCurrentSessionOwner(run, ctx) ||
        snapshot.workingMemberNames.length > 0 ||
        waitArmedTurnIndex !== null
      ) {
        return;
      }

      const goalState = inspectGoalRemainingWork(run);
      if (!goalState.hasStructuredGoal) {
        return;
      }

      const assistantText = extractLastAssistantText(event, ctx);
      if (assistantText && /\[NEEDS_HUMAN\]/i.test(assistantText)) {
        notifyEngineHumanInputAwaited(true);
        const needsHumanMsg = "🐝 Mission awaiting human input";
        if (ctx.hasUI) {
          ctx.ui.notify(needsHumanMsg, "info");
          lastStatusText = needsHumanMsg;
          ctx.ui.setStatus(SWARM_STATUS_KEY, needsHumanMsg);
        } else {
          emitZeroTurnMessage(ctx, needsHumanMsg, {
            runId: run.id,
            needsHuman: true,
          });
        }
        return;
      }

      const progressKey = `${run.revision}:${snapshot.boardHead}`;
      let contState = goalContinuationByRunId.get(run.id);
      if (!contState) {
        contState = { count: 0, stagnantTurns: 0 };
        goalContinuationByRunId.set(run.id, contState);
      }

      if (contState.tripped && contState.lastProgressKey === progressKey) {
        return;
      }

      if (contState.lastProgressKey === undefined) {
        contState.lastProgressKey = progressKey;
        contState.stagnantTurns = 0;
      } else if (contState.lastProgressKey === progressKey) {
        contState.stagnantTurns += 1;
      } else {
        contState.lastProgressKey = progressKey;
        contState.stagnantTurns = 0;
        contState.tripped = false;
      }

      if (contState.stagnantTurns >= 2 || contState.count >= 12) {
        contState.tripped = true;
        const pauseMsg =
          "🐝 Auto-continue paused (no state progress) — send guidance or /swarm resume";
        if (ctx.hasUI) {
          ctx.ui.notify(pauseMsg, "warning");
          lastStatusText = pauseMsg;
          ctx.ui.setStatus(SWARM_STATUS_KEY, pauseMsg);
        } else {
          emitZeroTurnMessage(ctx, pauseMsg, {
            runId: run.id,
            autoContinuePaused: true,
            stagnantTurns: contState.stagnantTurns,
            count: contState.count,
          });
        }
        return;
      }

      contState.count += 1;
      wakeupInFlight = true;
      try {
        const checkpointBody = buildGoalCheckpointMessage(
          run,
          snapshot,
          goalState,
        );
        pi.sendMessage(
          {
            customType: SWARM_WAKEUP_CUSTOM_TYPE,
            content: checkpointBody,
            display: true,
            details: {
              runId: run.id,
              goalCheckpoint: true,
              continuationCount: contState.count,
              stagnantTurns: contState.stagnantTurns,
              progressKey,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        if (wakeupSafetyTimer) {
          clearTimeout(wakeupSafetyTimer);
        }
        wakeupSafetyTimer = setTimeout(() => {
          wakeupInFlight = false;
          wakeupSafetyTimer = undefined;
          scheduleWakeupFlush();
        }, 300);
        wakeupSafetyTimer.unref?.();
      } catch (err) {
        clearWakeupInFlight();
        throw err;
      }
    });

    pi.on("session_shutdown", async (event, ctx) => {
      const runId = activeEngine?.getSnapshot().activeRunId;
      if (event.reason !== "reload" && activeStore && runId) {
        const rawSid = ctx?.sessionManager?.getSessionId?.()?.trim();
        const currentSid = rawSid || activeSessionId || getSessionIdSafe(ctx);
        await releaseRunOwnershipIfHeld(activeStore, runId, currentSid);
      }
      await disposeRuntime(ctx);
    });
  };
}

export default function piSwarmExtension(pi: ExtensionAPI): void {
  createPiSwarmExtension()(pi);
}

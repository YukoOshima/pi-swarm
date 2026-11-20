import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRuntime,
  getAgentDir,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TUI } from "@earendil-works/pi-tui";
import {
  DEFAULT_CHANNEL,
  DEFAULT_SWARM_SETTINGS,
  ORCHESTRATOR_NAME,
  SWARM_CONTRACT_CUSTOM_TYPE,
  SWARM_DIR,
  SWARM_FOCUS_ENTRY,
  SWARM_FOCUS_VERSION,
  SWARM_STATUS_CUSTOM_TYPE,
  SWARM_STATUS_KEY,
  SWARM_WAKEUP_CUSTOM_TYPE,
  SWARM_WIDGET_KEY,
} from "./constants.js";
import {
  DraftStateController,
  type SwarmDraftState,
  type SwarmToolProfileMode,
  applySwarmToolProfile,
  buildDirectPlanPrompt,
  buildDraftingKickoffPrompt,
  buildDraftingSystemOverlay,
  buildRoleModelsFromSettings,
  isDraftActive,
  registerDraftingTools,
} from "./drafting/index.js";
import {
  InProcessPiTransport,
  SwarmEngine,
  buildOrchestratorPlaybookSection,
  registerSwarmTools,
} from "./runtime/index.js";
import {
  SWARM_SETTINGS_BOUNDS,
  SwarmStore,
  WorktreeManager,
  loadLayeredSwarmSettings,
  loadSwarmSettings,
  saveSwarmSettings,
} from "./store/index.js";
import {
  type IQuestionnaireUI,
  type ISwarmEngine,
  type ISwarmStore,
  type ISwarmTransport,
  type IWorktreeManager,
  type ProposedSwarmPlan,
  type SafeTeardownResult,
  type SwarmEngineEvent,
  type SwarmFocusEntry,
  type SwarmMemberRecord,
  type SwarmModelRole,
  type SwarmRunState,
  type SwarmSettings,
  type SwarmSnapshot,
  type TeardownEntryResult,
  type WaitForBoardOptions,
  isSwarmProtocolError,
} from "./types.js";
import {
  type SwarmOverlayTab,
  type SwarmWidgetOptions,
  type SwarmWidgetState,
  bindSwarmShortcuts,
  createQuestionnaireUI,
  createSwarmWidget,
  createSwarmWidgetState,
  formatStatusLine,
  formatZeroTurnBoardView,
  formatZeroTurnGraphView,
  formatZeroTurnModelsView,
  formatZeroTurnStatusDashboard,
  isModalOpen,
  openSwarmOverlay,
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
  /** Override store construction (defaults to real SwarmStore). */
  storeFactory?: (projectRoot: string) => ISwarmStore;
  /** Override git worktree manager construction (defaults to real WorktreeManager). */
  worktreeFactory?: (projectRoot: string, settings: SwarmSettings) => IWorktreeManager;
  /** Override questionnaire/proposal UI (defaults to createQuestionnaireUI). */
  questionnaireUI?: IQuestionnaireUI;
  /** Optional dashboard widget configuration overrides. */
  widgetOptions?: SwarmWidgetOptions;
  /** Optional deterministic clock override. */
  now?: () => number;
}

export const SWARM_SUBCOMMANDS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: "direct", description: "Fast-path plan & launch Dynamic Swarm without Q&A" },
  { name: "status", description: "Zero-turn Swarm status dashboard" },
  {
    name: "board",
    description: "Zero-turn shared Message Board [limit] [--channel <ch>] [--search <q>]",
  },
  { name: "graph", description: "Zero-turn Spawn Tree & Peer @mention interaction graph" },
  { name: "tasks", description: "Open 4-tab Swarm UI overlay (Board / Members / Graph / Search)" },
  { name: "ui", description: "Open 4-tab Swarm UI overlay (alias for /swarm tasks)" },
  { name: "models", description: "Zero-turn 3-role defaults & live member models overview" },
  {
    name: "model",
    description: "Set role default or hot-switch waiting member (<target> <model|default> [thinking])",
  },
  { name: "merge", description: "Merge a member's share/branch worktree into baseBranch" },
  { name: "kill", description: "Permanently kill a member (<member> [--force] [reason])" },
  { name: "done", description: "Complete the active Swarm run and restore idle tools [summary]" },
  { name: "pause", description: "Pause member launches & board wakeups [reason]" },
  { name: "resume", description: "Resume a paused Swarm run" },
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
  "models",
  "resume",
  "cancel",
  "runs",
  "settings",
  "help",
]);

const ARG_SUBCOMMANDS = new Set([
  "direct",
  "board",
  "tasks",
  "ui",
  "model",
  "merge",
  "kill",
  "done",
  "pause",
  "teardown",
  "focus",
]);

const VALID_THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
    | "status"
    | "board"
    | "graph"
    | "tasks"
    | "ui"
    | "models"
    | "model"
    | "merge"
    | "kill"
    | "done"
    | "pause"
    | "resume"
    | "cancel"
    | "teardown"
    | "runs"
    | "focus"
    | "settings"
    | "help";
  rest: string;
}

export function parseSwarmCommand(rawArgs: string): ParsedSwarmInvocation {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { kind: "bare", rest: "" };
  }

  const spaceIdx = trimmed.search(/\s/);
  const head = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();

  if (ARG_SUBCOMMANDS.has(head)) {
    return {
      kind: head as
        | "direct"
        | "board"
        | "tasks"
        | "ui"
        | "model"
        | "merge"
        | "kill"
        | "done"
        | "pause"
        | "teardown"
        | "focus",
      rest,
    };
  }

  if (SINGLE_WORD_SUBCOMMANDS.has(head) && !rest) {
    return {
      kind: head as
        | "status"
        | "graph"
        | "models"
        | "resume"
        | "cancel"
        | "runs"
        | "settings"
        | "help",
      rest,
    };
  }

  return { kind: "goal", rest: trimmed };
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
  model?: string;
  thinkingLevel?: ThinkingLevel;
  warning?: string;
}

/**
 * Resolves and applies `settings.orchestratorModel` (+ optional thinking level)
 * onto the host Pi session via `resolveCliModel` + `pi.setModel` / `pi.setThinkingLevel`.
 * Never throws when credentials or model catalog entries are unavailable — emits a clean warning.
 */
async function applyOrchestratorModel(
  pi: Pick<ExtensionAPI, "setModel" | "setThinkingLevel">,
  ctx: ExtensionContext | undefined,
  settings: SwarmSettings,
  getFallbackRuntime: () => Promise<ModelRuntime>,
): Promise<ApplyOrchestratorModelResult> {
  const configuredModel = settings.orchestratorModel?.trim();
  if (!configuredModel) {
    if (
      settings.orchestratorThinkingLevel &&
      typeof pi.setThinkingLevel === "function"
    ) {
      try {
        pi.setThinkingLevel(settings.orchestratorThinkingLevel);
      } catch {
        // ignore thinking-level error when no model change requested
      }
    }
    return { applied: false };
  }

  const warn = (message: string): ApplyOrchestratorModelResult => {
    if (ctx?.hasUI) {
      ctx.ui.notify(message, "warning");
    }
    return { applied: false, warning: message };
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

    const effectiveThinking =
      settings.orchestratorThinkingLevel ?? resolved.thinkingLevel;
    if (effectiveThinking && typeof pi.setThinkingLevel === "function") {
      pi.setThinkingLevel(effectiveThinking);
    }

    return {
      applied: true,
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

function rehydrateFocusRunId(
  ctx: Pick<ExtensionContext, "sessionManager">,
): string | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "custom" || entry.customType !== SWARM_FOCUS_ENTRY) {
      continue;
    }
    const data = entry.data as Partial<SwarmFocusEntry> | undefined;
    if (!data || typeof data !== "object" || data.version !== SWARM_FOCUS_VERSION) {
      return null;
    }
    if (data.runId === null) {
      return null;
    }
    if (typeof data.runId === "string" && data.runId.trim().length > 0) {
      return data.runId.trim();
    }
    return null;
  }
  return null;
}

function persistFocusEntry(
  pi: Pick<ExtensionAPI, "appendEntry">,
  runId: string | null,
  sessionId: string,
  reason: string,
): void {
  const payload: SwarmFocusEntry = {
    version: SWARM_FOCUS_VERSION,
    runId,
    sessionId,
    reason,
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

function getOrderedMembers(run: SwarmRunState): SwarmMemberRecord[] {
  const seen = new Set<string>();
  const out: SwarmMemberRecord[] = [];
  for (const name of run.memberOrder) {
    const member = run.members[name];
    if (member) {
      seen.add(name);
      out.push(member);
    }
  }
  for (const member of Object.values(run.members)) {
    if (!seen.has(member.name)) {
      out.push(member);
    }
  }
  return out;
}

function buildRunKickoffMessage(
  run: SwarmRunState,
  spawnedInitial: readonly SwarmMemberRecord[],
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

  lines.push("");
  if (spawnedInitial.length > 0) {
    lines.push("Initial members already spawned and working:");
    for (const m of spawnedInitial) {
      const seqPart = m.briefSeq ? ` (brief #${m.briefSeq})` : "";
      const wsPart = m.branch ? `${m.workspace}:${m.branch}` : m.workspace;
      lines.push(`- \`@${m.name}\` (${m.role}, \`${wsPart}\`)${seqPart}`);
    }
    lines.push(
      "",
      `Coordinate dynamically via \`swarm\`, \`post_message\`, \`read_board\`, and \`swarm_wait\`. Call \`swarm_wait{since: ${run.boardHead}}\` to wait for initial reports (or spawn additional members right away), then adapt wave-by-wave, validate independently, merge \`share\`/\`branch\` worktrees, kill finished helpers, and call \`swarm{action:"done", summary}\` when complete.`,
    );
  } else {
    lines.push(
      'You now have the 4 core Swarm tools (`swarm`, `post_message`, `read_board`, `swarm_wait`). Begin Phase 1 by delegating technical work via `swarm{action:"add"}` (researchers/scouts -> scaffold -> parallel `share` authors -> independent read-only `validator`), wait via `swarm_wait`, merge & kill finished members, and call `swarm{action:"done", summary}` when complete.',
    );
  }

  return lines.join("\n");
}

function buildHelpMarkdown(): string {
  return [
    "### 🐝 Pi Swarm v0.2.0 (`/swarm`) — Dynamic Antigravity Swarm Commands",
    "",
    "| Command | Description |",
    "| --- | --- |",
    "| `/swarm [goal]` | Interactive upfront Q&A → Flexible Dynamic Swarm Plan confirmation (or 0-turn action menu when a run is focused) |",
    "| `/swarm direct <goal>` · `/swarm-direct <goal>` | Fast-path: skip Q&A, propose plan with auto-confirm, and launch Dynamic Swarm immediately |",
    "| `/swarm status` | Zero-LLM-turn dashboard: 3-role models, channels, member roster, recent board & events |",
    "| `/swarm board [limit] [--channel <ch>] [--search <q>]` | Zero-LLM-turn shared `#seq` Message Board feed (filterable by channel or substring) |",
    "| `/swarm graph` | Zero-LLM-turn ASCII/Unicode Spawn Tree & Peer `@mention` / `#channel` interaction graph |",
    "| `/swarm tasks [tab\\|member\\|#ch]` · `/swarm ui` | Open interactive 4-tab Swarm Overlay (**Board** / **Members** / **Graph** / **Search**) |",
    "| `/swarm models` | Zero-LLM-turn 3-role defaults (`orchestrator` / `worker` / `validator`) + live member models |",
    "| `/swarm model <target> <model\\|default> [thinking]` | Set a role default (`orchestrator` / `worker` / `validator`) OR hot-switch a warm `waiting` member keeping full history |",
    "| `/swarm merge <member>` | Merge a member's `share`/`branch` worktree onto `baseBranch` (`autoRebase` + `--no-ff`) |",
    "| `/swarm kill <member> [--force] [reason]` | Permanently kill a member and remove its clean worktree (`--force` overrides dirty worktree guard) |",
    "| `/swarm done [summary]` | Complete the active Swarm run, dispose warm handles, and restore `idle` tools |",
    "| `/swarm pause [reason]` / `/swarm resume` | Pause or resume member launches and board wakeups |",
    "| `/swarm cancel` | Cancel active draft (restores tools) or abandon focused run (preserves worktrees & `.pi/swarm/runs/`) |",
    "| `/swarm teardown [--force] [--delete-branches]` | Safely remove clean idle worktrees while preserving `.pi/swarm/runs/` audit & board history |",
    "| `/swarm runs` | List all runs stored in `.pi/swarm/runs/` |",
    "| `/swarm focus [run-id\\|none]` | Switch or detach session-local run focus |",
    "| `/swarm settings` | Inspect or adjust 3-role models, warm sessions, validator policy, stall watchdog & git settings |",
    "| `/swarm help` | Print this command reference (zero LLM turn) |",
    "",
    "**TUI Shortcuts:** `Ctrl+Shift+T` toggles expanded above-editor dashboard · `Esc` collapses expanded dashboard.",
  ].join("\n");
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
    `| \`stallTimeoutMs\` | ${settings.stallTimeoutMs}ms |`,
    `| \`maxConcurrency\` | ${settings.maxConcurrency} |`,
    `| \`maxRetries\` | ${settings.maxRetries} |`,
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

    /** Tracks active blocking `swarm_wait` tool calls so we never double-wake the Orchestrator. */
    let activeSwarmWaitCount = 0;

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

    function isRunningProfileRun(run: SwarmRunState | null | undefined): boolean {
      return Boolean(run && (run.status === "active" || run.status === "paused"));
    }

    function computeDesiredToolProfile(): SwarmToolProfileMode {
      if (draftController.isActive()) {
        return "drafting";
      }
      const run = getSnapshotSafe().run;
      if (isRunningProfileRun(run)) {
        return "running";
      }
      return "idle";
    }

    function syncDraftWidgetState(draft: SwarmDraftState | null): void {
      widgetState.draftActive = isDraftActive(draft);
      widgetState.draftMode = draft?.mode;
      widgetState.draftSeed = draft?.seed;
    }

    function refreshUI(ctxOverride?: ExtensionContext): void {
      const ctx = ctxOverride ?? lastCtx;
      activeWidgetTui?.requestRender();
      if (ctx?.hasUI) {
        const line = formatStatusLine(getSnapshotSafe(), draftController.isActive());
        ctx.ui.setStatus(SWARM_STATUS_KEY, line);
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

    async function reloadSettings(cwd: string): Promise<SwarmSettings> {
      try {
        currentSettings = overrides.settingsLoader
          ? await overrides.settingsLoader(cwd)
          : await loadSwarmSettings(cwd);
      } catch {
        currentSettings = {
          ...DEFAULT_SWARM_SETTINGS,
          fallbackModels: [...DEFAULT_SWARM_SETTINGS.fallbackModels],
        };
      }
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
        });
      }
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

    async function applyRoleModelChange(
      role: SwarmModelRole,
      modelValue: string | undefined,
      thinkingLevel: ThinkingLevel | undefined,
      ctx: ExtensionContext | undefined,
      options: { scope?: "project" | "global"; updateRun?: boolean } = {},
    ): Promise<{
      settings: SwarmSettings;
      orchestratorApply?: ApplyOrchestratorModelResult;
    }> {
      const targetCtx = ctx ?? lastCtx;
      const cwd = targetCtx?.cwd ?? boundCwd ?? process.cwd();
      const scope = options.scope ?? "project";
      const trimmed = modelValue?.trim();
      const isClearing = !trimmed || CLEAR_MODEL_TOKENS.has(trimmed.toLowerCase());

      // In real saveSwarmSettings("project", ...), explicit `null` writes `null` to JSON
      // so global overrides are cleanly cleared at the project layer.
      const clearModelVal = overrides.settingsSaver
        ? undefined
        : (null as unknown as string);
      const clearThinkingVal = overrides.settingsSaver
        ? undefined
        : (null as unknown as ThinkingLevel);
      const nextModelPatchVal = isClearing ? clearModelVal : trimmed;

      const patch: Partial<SwarmSettings> = {};
      if (role === "orchestrator") {
        patch.orchestratorModel = nextModelPatchVal;
        if (thinkingLevel !== undefined) {
          patch.orchestratorThinkingLevel = thinkingLevel;
        } else if (isClearing) {
          patch.orchestratorThinkingLevel = clearThinkingVal;
        }
      } else if (role === "worker") {
        patch.workerModel = nextModelPatchVal;
        if (thinkingLevel !== undefined) {
          patch.workerThinkingLevel = thinkingLevel;
        } else if (isClearing) {
          patch.workerThinkingLevel = clearThinkingVal;
        }
      } else {
        patch.validatorModel = nextModelPatchVal;
        if (thinkingLevel !== undefined) {
          patch.validatorThinkingLevel = thinkingLevel;
        } else if (isClearing) {
          patch.validatorThinkingLevel = clearThinkingVal;
        }
      }

      await persistSettingsPatch(scope, patch, cwd);

      if (options.updateRun !== false) {
        await syncActiveRunRoleModels(targetCtx);
      }

      let orchestratorApply: ApplyOrchestratorModelResult | undefined;
      if (role === "orchestrator" && !isClearing) {
        orchestratorApply = await applyOrchestratorModel(
          pi,
          targetCtx,
          currentSettings,
          getLazyFallbackModelRuntime,
        );
      }

      refreshUI(targetCtx);
      return { settings: currentSettings, orchestratorApply };
    }

    function purgePendingWakeupsForRun(runId?: string | null): void {
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
          if (
            item.type === "stall_detected" &&
            pendingWakeups[existingIdx]!.type !== "stall_detected"
          ) {
            pendingWakeups[existingIdx] = item;
          }
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
      if (isShutDown || wakeupInFlight || pendingWakeups.length === 0) {
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
      // Never emit ghost wakeups once a run is paused, completed, abandoned, or detached.
      if (!snapshot.run || snapshot.run.status !== "active") {
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
          for (const item of batch) {
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
      } finally {
        wakeupInFlight = false;
      }
    }

    function handleEngineEvent(ev: SwarmEngineEvent): void {
      if (isShutDown) {
        return;
      }

      if (ev.type === "run_finished") {
        // `completeRun` is initiated explicitly by orchestrator or human; never fire an extra LLM turn.
        purgePendingWakeupsForRun(ev.runId);
        applySwarmToolProfile(pi, computeDesiredToolProfile());
        refreshUI();
        return;
      }

      refreshUI();

      if (ev.type === "wakeup_needed" || ev.type === "stall_detected") {
        // Only wake while the run is actively executing.
        if (ev.snapshot.run?.status !== "active") {
          return;
        }
        // Skip waking the Orchestrator if a `swarm_wait` tool call is actively awaiting the board,
        // because `swarm_wait` already delivers those exact messages directly!
        if (activeSwarmWaitCount > 0) {
          return;
        }
        enqueueWakeupItem({
          type: ev.type,
          runId: ev.runId,
          memberName: ev.memberName,
          seq: ev.seq,
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
        activeTransport = overrides.transportFactory
          ? overrides.transportFactory(ctx ?? (lastCtx as ExtensionContext), currentSettings)
          : new InProcessPiTransport();
        activeEngine = new SwarmEngine({
          store: activeStore,
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
      });

      refreshUI(ctx);
    }

    async function rehydrateSessionState(ctx: ExtensionContext): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const prevFocused = engine.getSnapshot().activeRunId;

      const focusedRunId = rehydrateFocusRunId(ctx);
      if (focusedRunId !== prevFocused) {
        purgePendingWakeupsForRun(null);
      }
      if (focusedRunId) {
        try {
          await engine.attachRun(focusedRunId, ctx);
        } catch {
          await engine.attachRun(null, ctx);
        }
      } else {
        await engine.attachRun(null, ctx);
      }

      const snapshot = engine.getSnapshot();
      const hasFocusedRun = isRunningProfileRun(snapshot.run);
      const draft = draftController.rehydrate(ctx, {
        syncToolProfile: true,
        hasActiveRun: hasFocusedRun,
      });
      syncDraftWidgetState(draft);
      refreshUI(ctx);
    }

    async function disposeRuntime(ctx?: ExtensionContext): Promise<void> {
      isShutDown = true;
      pendingWakeups.length = 0;
      wakeupFlushScheduled = false;
      wakeupInFlight = false;
      activeSwarmWaitCount = 0;

      if (unsubEngine) {
        unsubEngine();
        unsubEngine = undefined;
      }
      if (unbindShortcuts) {
        unbindShortcuts();
        unbindShortcuts = undefined;
      }

      const targetCtx = ctx ?? lastCtx;
      if (targetCtx?.hasUI) {
        try {
          targetCtx.ui.setWidget(SWARM_WIDGET_KEY, undefined);
          targetCtx.ui.setStatus(SWARM_STATUS_KEY, undefined);
        } catch {
          // ignore UI teardown errors during shutdown
        }
      }

      activeWidgetTui = undefined;
      widgetState.expanded = false;
      widgetState.draftActive = false;
      widgetState.draftMode = undefined;
      widgetState.draftSeed = undefined;
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

    /**
     * Engine proxy passed into the 4 core Swarm tools:
     * - Tracks active `waitForBoard` calls so `handleEngineEvent` skips duplicate wakeups
     *   while `swarm_wait` is already blocked awaiting those messages.
     * - Restores `"idle"` tool profile immediately after `completeRun` (`swarm{action:"done"}`).
     */
    const toolEngineProxy: ISwarmEngine = new Proxy({} as ISwarmEngine, {
      get(_obj, prop, receiver) {
        const target = ensureBoundSync().engine;
        if (prop === "waitForBoard") {
          return async (options: WaitForBoardOptions) => {
            activeSwarmWaitCount += 1;
            try {
              return await target.waitForBoard(options);
            } finally {
              activeSwarmWaitCount = Math.max(0, activeSwarmWaitCount - 1);
            }
          };
        }
        if (prop === "completeRun") {
          return async (options: Parameters<ISwarmEngine["completeRun"]>[0]) => {
            const completed = await target.completeRun(options);
            purgePendingWakeupsForRun(completed.id);
            applySwarmToolProfile(pi, computeDesiredToolProfile());
            refreshUI();
            return completed;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
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
    async function handlePlanConfirmed(
      plan: ProposedSwarmPlan,
      toolCtx: ExtensionContext,
    ): Promise<SwarmRunState> {
      const { store, worktree, engine } = await ensureBound(toolCtx);
      await reloadSettings(toolCtx.cwd);

      // 1. Apply configured Orchestrator model cleanly before launching the run
      await applyOrchestratorModel(
        pi,
        toolCtx,
        currentSettings,
        getLazyFallbackModelRuntime,
      );

      // 2. Ensure git repo is ready and `.pi/swarm/` is excluded via `.git/info/exclude`
      const ready = await worktree.ensureRepoReady(plan.baseBranch);
      const effectiveBaseBranch = ready.baseBranch || plan.baseBranch;
      const ownerSessionId = getSessionIdSafe(toolCtx);

      // 3. Create v2 Swarm run in store
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
        roleModels: buildRoleModelsFromSettings(currentSettings),
      });

      // 4. Persist session-local focus entry (version: 2)
      persistFocusEntry(pi, createdRun.id, ownerSessionId, "plan_confirmed");

      // 5. Attach & start the run in SwarmEngine
      await engine.startRun(createdRun.id, toolCtx);

      // 6. Pre-create any custom channels referenced by initialMembers, then spawn them immediately
      const spawnedInitial: SwarmMemberRecord[] = [];
      if (plan.initialMembers && plan.initialMembers.length > 0) {
        const customChannels = new Set<string>();
        for (const memberSpec of plan.initialMembers) {
          for (const rawCh of memberSpec.channels ?? []) {
            const clean = rawCh.trim().replace(/^@#?/, "").toLowerCase();
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

        for (const memberSpec of plan.initialMembers) {
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
        }
      }

      const finalRun = engine.getSnapshot().run ?? createdRun;

      // 7. Swap tool profile to `"running"` (4 core tools) & refresh UI
      applySwarmToolProfile(pi, "running");
      refreshUI(toolCtx);

      // 8. Schedule a single clean settled-boundary kickoff so Orchestrator immediately coordinates
      enqueueWakeupItem({
        type: "kickoff",
        runId: finalRun.id,
        summary: `Dynamic Swarm "${finalRun.title}" (${finalRun.id}) launched`,
        kickoffBody: buildRunKickoffMessage(finalRun, spawnedInitial),
      });

      return finalRun;
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
      onDraftChanged: (draft, toolCtx) => {
        syncDraftWidgetState(draft);
        if (!draft) {
          applySwarmToolProfile(pi, computeDesiredToolProfile());
          scheduleWakeupFlush(toolCtx);
        }
        refreshUI(toolCtx);
      },
    });

    registerSwarmTools(pi, {
      engine: toolEngineProxy,
      getCallerRole: () => "orchestrator",
      getCallerName: () => ORCHESTRATOR_NAME,
      onOrchestratorModelSwitch: async (model, thinkingLevel) => {
        const { settings, orchestratorApply } = await applyRoleModelChange(
          "orchestrator",
          model,
          thinkingLevel,
          lastCtx,
          { scope: "project", updateRun: true },
        );
        return {
          targetName: ORCHESTRATOR_NAME,
          model: orchestratorApply?.model ?? settings.orchestratorModel ?? model,
          thinkingLevel: orchestratorApply?.thinkingLevel ?? thinkingLevel,
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
        const branch = await worktree.getCurrentBranch(cwd);
        if (branch.trim()) {
          return branch.trim();
        }
      } catch {
        // Repo might not exist yet; default to main until ensureRepoReady runs.
      }
      return "main";
    }

    async function startInteractiveDrafting(
      seed: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { worktree } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);
      await applyOrchestratorModel(
        pi,
        ctx,
        currentSettings,
        getLazyFallbackModelRuntime,
      );

      const baseBranch = await resolveBaseBranchSafe(worktree, ctx.cwd);

      const res = await draftController.startOrResolve(ctx, {
        mode: "swarm",
        seed,
        validatorEnabled: currentSettings.validatorEnabled,
        maxConcurrency: currentSettings.maxConcurrency,
        baseBranch,
      });

      if (res.action === "cancelled" || !res.draft) {
        if (ctx.hasUI) {
          ctx.ui.notify("Kept current Swarm draft state unchanged.", "info");
        }
        return;
      }

      syncDraftWidgetState(res.draft);
      refreshUI(ctx);

      const kickoffPrompt = buildDraftingKickoffPrompt(res.draft.seed, res.draft.mode, {
        baseBranch: res.draft.baseBranch ?? baseBranch,
        maxConcurrency: res.draft.maxConcurrency,
        validatorEnabled: res.draft.validatorEnabled,
        roleModels: buildRoleModelsFromSettings(currentSettings),
        existingEcho: res.draft.questionnaireEcho,
      });

      pi.sendUserMessage(kickoffPrompt, {
        deliverAs: ctx.isIdle() ? "followUp" : "steer",
        expandPromptTemplates: false,
      });
    }

    async function startDirectSwarm(
      rawGoal: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { worktree } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);

      let goal = rawGoal.trim();
      if (!goal && ctx.hasUI) {
        const entered = await withModalGuard(() =>
          ctx.ui.input("🐝 Swarm Direct Objective", "Describe what the swarm should build…"),
        );
        goal = entered?.trim() ?? "";
      }
      if (!goal) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /swarm direct <goal>", "warning");
        } else {
          emitZeroTurnMessage(ctx, "Usage: `/swarm direct <goal>`");
        }
        return;
      }

      await applyOrchestratorModel(
        pi,
        ctx,
        currentSettings,
        getLazyFallbackModelRuntime,
      );

      const baseBranch = await resolveBaseBranchSafe(worktree, ctx.cwd);
      const res = await draftController.startOrResolve(ctx, {
        mode: "swarm",
        seed: goal,
        validatorEnabled: currentSettings.validatorEnabled,
        maxConcurrency: currentSettings.maxConcurrency,
        baseBranch,
        autoConfirm: true,
      });

      if (res.action === "cancelled" || !res.draft) {
        if (ctx.hasUI) {
          ctx.ui.notify("Cancelled /swarm direct launch.", "info");
        }
        return;
      }

      let activeDraft = res.draft;
      if (!activeDraft.autoConfirm) {
        activeDraft =
          draftController.update({
            seed: goal,
            baseBranch,
            autoConfirm: true,
          }) ?? activeDraft;
      }

      syncDraftWidgetState(activeDraft);
      refreshUI(ctx);

      const directPrompt = buildDirectPlanPrompt(goal, baseBranch, currentSettings);
      pi.sendUserMessage(directPrompt, {
        deliverAs: ctx.isIdle() ? "followUp" : "steer",
        expandPromptTemplates: false,
      });
    }

    async function handleStatusCommand(ctx: ExtensionCommandContext): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const current = engine.getSnapshot();
      const snapshot = current.activeRunId
        ? await engine.attachRun(current.activeRunId, ctx).catch(() => current)
        : current;
      const draft = draftController.getDraft();
      const markdown = formatZeroTurnStatusDashboard(snapshot, {
        draftActive: isDraftActive(draft),
        draftSeed: draft?.seed,
        hostModel: formatHostModelId(ctx.model),
        now: overrides.now,
      });
      emitZeroTurnMessage(ctx, markdown, {
        runId: snapshot.activeRunId,
        draftActive: isDraftActive(draft),
      });
    }

    async function handleBoardCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
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

    async function handleGraphCommand(ctx: ExtensionCommandContext): Promise<void> {
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

      const markdown = formatZeroTurnGraphView(snapshot, {
        board: boardRes.messages,
      });
      emitZeroTurnMessage(ctx, markdown, {
        runId: snapshot.activeRunId,
        boardHead: boardRes.head,
        memberCount: snapshot.run.memberOrder.length,
      });
    }

    async function handleOverlayCommand(
      rawArg: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { engine, worktree } = await ensureBound(ctx);
      if (!ctx.hasUI) {
        await handleStatusCommand(ctx);
        return;
      }

      const arg = rawArg.trim();
      const lower = arg.toLowerCase();
      let initialTab: SwarmOverlayTab | undefined;
      let initialMemberName: string | undefined;
      let initialChannel: string | undefined;

      if (arg) {
        if (OVERLAY_TABS.has(lower as SwarmOverlayTab)) {
          initialTab = lower as SwarmOverlayTab;
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

      await openSwarmOverlay(ctx, engine, worktree, {
        onModalEnter,
        onModalExit,
        ...(initialTab ? { initialTab } : {}),
        ...(initialMemberName ? { initialMemberName } : {}),
        ...(initialChannel ? { initialChannel } : {}),
        hostModel: formatHostModelId(ctx.model),
        now: overrides.now,
      });
      refreshUI(ctx);
    }

    async function handleModelsCommand(ctx: ExtensionCommandContext): Promise<void> {
      const { engine } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);
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
    }

    async function handleModelCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const tokens = tokenizeCommandArgs(rawArgs.trim());

      if (tokens.length === 0) {
        await handleModelsCommand(ctx);
        return;
      }

      const [rawTarget, modelArg, thinkingArg] = tokens;
      const target = rawTarget?.replace(/^@/, "").trim();
      if (!target || !modelArg) {
        const usage =
          "Usage: `/swarm model <orchestrator|worker|validator|member-name> <model-id|default> [thinking]`";
        if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        emitZeroTurnMessage(ctx, usage);
        return;
      }

      let thinkingLevel: ThinkingLevel | undefined;
      if (thinkingArg !== undefined) {
        const lowerThinking = thinkingArg.toLowerCase();
        if (!isThinkingLevel(lowerThinking)) {
          const msg = `Invalid thinking level "${thinkingArg}". Valid values: off, minimal, low, medium, high, xhigh, max.`;
          if (ctx.hasUI) ctx.ui.notify(msg, "error");
          else emitZeroTurnMessage(ctx, msg);
          return;
        }
        thinkingLevel = lowerThinking;
      }

      const targetLower = target.toLowerCase();
      if (isSwarmModelRole(targetLower)) {
        try {
          const isClearing = CLEAR_MODEL_TOKENS.has(modelArg.toLowerCase());
          const { orchestratorApply } = await applyRoleModelChange(
            targetLower,
            isClearing ? undefined : modelArg,
            thinkingLevel,
            ctx,
            { scope: "project", updateRun: true },
          );

          const modelDesc = isClearing
            ? "host default"
            : `\`${modelArg}\`${thinkingLevel ? ` (thinking: \`${thinkingLevel}\`)` : ""}`;
          const applySuffix =
            targetLower === "orchestrator" && orchestratorApply?.warning
              ? `\n- ⚠ ${orchestratorApply.warning}`
              : "";
          const msg = isClearing
            ? `Cleared \`${targetLower}\` role model back to **host default** (saved to project settings).`
            : `Updated \`${targetLower}\` role default model to ${modelDesc} (saved to project settings).${applySuffix}`;

          if (ctx.hasUI) {
            ctx.ui.notify(
              isClearing
                ? `Cleared ${targetLower} model to host default.`
                : `Set ${targetLower} model -> ${modelArg}${thinkingLevel ? ` (${thinkingLevel})` : ""}.`,
              "info",
            );
          }
          emitZeroTurnMessage(ctx, `✓ ${msg}`, {
            target: targetLower,
            scope: "role_default",
            model: isClearing ? null : modelArg,
            thinkingLevel,
            appliedToHost: orchestratorApply?.applied,
          });
        } catch (err) {
          const msg = `Failed to update ${targetLower} model: ${formatError(err)}`;
          if (ctx.hasUI) ctx.ui.notify(msg, "error");
          else emitZeroTurnMessage(ctx, msg);
        }
        return;
      }

      // Live member hot model switch (preserves warm session conversation history)
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = `No focused Swarm run to switch live member "${target}". To set a role default, use \`/swarm model <orchestrator|worker|validator> <model-id>\`.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        const switched = await engine.switchModel({
          targetName: target,
          model: modelArg,
          thinkingLevel,
          callerName: "human",
          callerRole: "human",
          hostContext: ctx,
        });
        refreshUI(ctx);
        const appliedModel = switched.model;
        const thinkPart = switched.thinkingLevel
          ? ` (thinking: \`${switched.thinkingLevel}\`)`
          : "";
        const msg = `Hot-switched live member \`@${switched.targetName}\` to \`${appliedModel}\`${thinkPart} — conversation history preserved.`;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Switched @${switched.targetName} -> ${appliedModel} (history preserved).`,
            "info",
          );
        }
        emitZeroTurnMessage(ctx, `✓ ${msg}`, {
          target: switched.targetName,
          scope: "live_member",
          model: appliedModel,
          thinkingLevel: switched.thinkingLevel,
        });
      } catch (err) {
        const msg = `Failed to switch model for "${target}": ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleMergeCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const tokens = tokenizeCommandArgs(rawArgs.trim());
      let target = tokens[0]?.replace(/^@/, "").trim() ?? "";

      if (!target) {
        const candidates = getOrderedMembers(snapshot.run).filter(
          (m) => (m.workspace === "share" || m.workspace === "branch") && Boolean(m.branch),
        );
        if (candidates.length > 0 && ctx.hasUI) {
          const choiceMap = new Map<string, string>();
          const choices: string[] = [];
          for (const entry of candidates) {
            const label = `@${entry.name} [${entry.state}] (${entry.branch})`;
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
      const { engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
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
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to complete.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      let summary = rawSummary.trim();
      if (!summary && ctx.hasUI) {
        const entered = await withModalGuard(() =>
          ctx.ui.input(
            `Complete Swarm "${snapshot.run!.title}" — summary`,
            "Completed via /swarm done",
          ),
        );
        if (entered === undefined) {
          return;
        }
        summary = entered.trim() || "Completed by user via /swarm done";
      }
      if (!summary) {
        summary = "Completed by user via /swarm done";
      }

      try {
        const completed = await engine.completeRun({
          summary,
          teardown: currentSettings.autoTeardownOnComplete,
          callerRole: "human",
          actor: "human",
        });
        purgePendingWakeupsForRun(completed.id);
        applySwarmToolProfile(pi, computeDesiredToolProfile());
        refreshUI(ctx);
        const msg = `Completed Swarm run "${completed.title}" (\`${completed.id}\`): ${summary} — restored \`idle\` tool profile.`;
        if (ctx.hasUI) {
          ctx.ui.notify(`Completed Swarm run ${completed.id}.`, "info");
        }
        emitZeroTurnMessage(ctx, `✓ ${msg}`, {
          runId: completed.id,
          status: completed.status,
          summary,
        });
      } catch (err) {
        const msg = `Failed to complete Swarm run: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handlePauseCommand(
      reason: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to pause.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }
      try {
        const updated = await engine.pause(
          snapshot.run.id,
          reason || "Paused by user",
        );
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

    async function handleResumeCommand(ctx: ExtensionCommandContext): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to resume.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }
      try {
        const updated = await engine.resume(snapshot.run.id, ctx);
        applySwarmToolProfile(pi, computeDesiredToolProfile());
        refreshUI(ctx);
        const msg = `Resumed Swarm run \`${updated.id}\`.`;
        if (ctx.hasUI) ctx.ui.notify(`Resumed Swarm run ${updated.id}.`, "info");
        emitZeroTurnMessage(ctx, `▶ ${msg}`, { runId: updated.id, status: updated.status });
      } catch (err) {
        const msg = `Resume failed: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleCancelCommand(ctx: ExtensionCommandContext): Promise<void> {
      const { store, engine } = await ensureBound(ctx);

      // 1. If a planning draft is active, cancel the draft and restore normal tool profile
      if (draftController.isActive()) {
        const snapshot = engine.getSnapshot();
        const nextProfile: SwarmToolProfileMode = isRunningProfileRun(snapshot.run)
          ? "running"
          : "idle";
        draftController.clear(nextProfile);
        syncDraftWidgetState(null);
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
        const msg = "Nothing to cancel (no active Swarm draft or focused run).";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const run = snapshot.run;
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

      const cancelReason = "Cancelled by user via /swarm cancel";
      const latestSnap = engine.getSnapshot();
      const latestRun = latestSnap.run ?? run;
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

      if (run.status !== "completed" && run.status !== "abandoned") {
        await store.updateRun(run.id, {
          status: "abandoned",
          actor: "human",
        });
      }

      purgePendingWakeupsForRun(run.id);
      await engine.attachRun(run.id, ctx);
      applySwarmToolProfile(pi, computeDesiredToolProfile());
      refreshUI(ctx);

      const msg = `Stopped active members and marked Swarm run \`${run.id}\` as abandoned (audit trail, board & worktrees preserved).`;
      if (ctx.hasUI) ctx.ui.notify(`Cancelled Swarm run ${run.id}.`, "warning");
      emitZeroTurnMessage(ctx, msg, { runId: run.id, status: "abandoned" });
    }

    async function handleTeardownCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { engine, worktree } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to tear down.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const tokens = rawArgs.split(/\s+/).filter(Boolean);
      const force = tokens.includes("--force") || tokens.includes("-f");
      const deleteBranches =
        tokens.includes("--delete-branches") || tokens.includes("--branches");
      const runId = snapshot.run.id;
      const sessionId = getSessionIdSafe(ctx);

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

      try {
        const result = await engine.teardown({
          runId,
          deleteBranches,
          sessionId,
        });

        // With explicit --force, remove skipped_dirty worktrees too (still preserving .pi/swarm/runs/)
        if (force && result.skipped.some((s) => s.action === "skipped_dirty")) {
          const remainingSkipped: TeardownEntryResult[] = [];
          for (const entry of result.skipped) {
            if (entry.action !== "skipped_dirty") {
              remainingSkipped.push(entry);
              continue;
            }
            try {
              await worktree.removeWorktree(entry.worktreePath, { force: true });
              result.removed.push({
                memberName: entry.memberName,
                worktreePath: entry.worktreePath,
                branch: entry.branch,
                action: "removed",
                reason: "Force-removed dirty worktree",
              });
            } catch (err) {
              result.errors.push({
                memberName: entry.memberName,
                worktreePath: entry.worktreePath,
                branch: entry.branch,
                action: "error",
                reason: formatError(err),
              });
            }
          }
          result.skipped = remainingSkipped;
        }

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

    async function handleRunsCommand(ctx: ExtensionCommandContext): Promise<void> {
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
        const label = (r.title || r.objective).replace(/\|/g, "\\|").slice(0, 60);
        lines.push(
          `| ${star} | \`${r.id}\` | ${r.status} | ${r.workingCount}w/${r.waitingCount}wait (${r.memberCount}) | #${r.boardHead} | \`${r.baseBranch}\` | ${label} |`,
        );
      }
      lines.push("", "Switch focus with `/swarm focus <run-id>` or `/swarm focus none`.");

      emitZeroTurnMessage(ctx, lines.join("\n"), { count: runs.length, focusedId });
    }

    async function handleFocusCommand(
      rawTarget: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { store, engine } = await ensureBound(ctx);
      const target = rawTarget.trim();
      const sessionId = getSessionIdSafe(ctx);

      if (target === "none" || target === "--clear" || target === "off") {
        purgePendingWakeupsForRun(null);
        await engine.attachRun(null, ctx);
        persistFocusEntry(pi, null, sessionId, "user_unfocus");
        applySwarmToolProfile(pi, computeDesiredToolProfile());
        refreshUI(ctx);
        const msg = "Detached session focus from Swarm run.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        emitZeroTurnMessage(ctx, msg, { runId: null });
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
          purgePendingWakeupsForRun(null);
          await engine.attachRun(null, ctx);
          persistFocusEntry(pi, null, sessionId, "user_unfocus");
          applySwarmToolProfile(pi, computeDesiredToolProfile());
          refreshUI(ctx);
          ctx.ui.notify("Detached session focus.", "info");
          return;
        }
        chosenRunId = mapped ?? "";
      }

      if (!chosenRunId) return;

      try {
        await store.loadRun(chosenRunId);
        const prevFocused = engine.getSnapshot().activeRunId;
        if (prevFocused !== chosenRunId) {
          purgePendingWakeupsForRun(null);
        }
        const snapshot = await engine.attachRun(chosenRunId, ctx);
        persistFocusEntry(pi, chosenRunId, sessionId, "user_focus");
        applySwarmToolProfile(pi, computeDesiredToolProfile());
        refreshUI(ctx);

        const msg = `Focused Swarm run \`${chosenRunId}\` (${snapshot.run?.status ?? "unknown"}).`;
        if (ctx.hasUI) ctx.ui.notify(`Focused Swarm run ${chosenRunId}.`, "info");
        emitZeroTurnMessage(ctx, msg, { runId: chosenRunId });
      } catch (err) {
        const msg = `Unable to focus run "${chosenRunId}": ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleSettingsCommand(ctx: ExtensionCommandContext): Promise<void> {
      await ensureBound(ctx);
      let layeredPaths: { globalPath: string; projectPath: string } | undefined;
      if (overrides.settingsLoader) {
        currentSettings = await overrides.settingsLoader(ctx.cwd);
      } else {
        const layered = await loadLayeredSwarmSettings(ctx.cwd);
        currentSettings = layered.settings;
        layeredPaths = {
          globalPath: layered.globalPath,
          projectPath: layered.projectPath,
        };
      }

      if (!ctx.hasUI) {
        emitZeroTurnMessage(ctx, formatSettingsMarkdown(currentSettings, layeredPaths));
        return;
      }

      let saveScope: "project" | "global" = "project";

      const persistPatch = async (patch: Partial<SwarmSettings>): Promise<void> => {
        await persistSettingsPatch(saveScope, patch, ctx.cwd);
        refreshUI(ctx);
      };

      const promptRoleModel = async (
        role: SwarmModelRole,
        label: string,
        currentValue: string | undefined,
      ): Promise<void> => {
        const raw = await withModalGuard(() =>
          ctx.ui.input(
            `Set ${label} (model ID, or "default" / empty to inherit host)`,
            currentValue ?? "",
          ),
        );
        if (raw === undefined) {
          return;
        }
        const trimmed = raw.trim();
        const isClear = !trimmed || CLEAR_MODEL_TOKENS.has(trimmed.toLowerCase());
        await applyRoleModelChange(
          role,
          isClear ? undefined : trimmed,
          undefined,
          ctx,
          { scope: saveScope, updateRun: true },
        );
        ctx.ui.notify(
          isClear
            ? `Cleared ${label} to host default (${saveScope}).`
            : `Saved ${label} = ${trimmed} (${saveScope}).`,
          "info",
        );
      };

      while (true) {
        const items = [
          `orchestratorModel: ${currentSettings.orchestratorModel ?? "(inherit host)"}`,
          `workerModel: ${currentSettings.workerModel ?? "(inherit host)"}`,
          `validatorModel: ${currentSettings.validatorModel ?? "(inherit host)"}`,
          `keepWorkersWarm: ${currentSettings.keepWorkersWarm ? "ON" : "OFF"}`,
          `validatorEnabled: ${currentSettings.validatorEnabled ? "ON" : "OFF"}`,
          `stallWatchdogEnabled: ${currentSettings.stallWatchdogEnabled ? "ON" : "OFF"}`,
          `stallTimeoutMs: ${currentSettings.stallTimeoutMs}`,
          `maxConcurrency: ${currentSettings.maxConcurrency}`,
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
          if (picked.startsWith("orchestratorModel:")) {
            await promptRoleModel(
              "orchestrator",
              "orchestratorModel",
              currentSettings.orchestratorModel,
            );
          } else if (picked.startsWith("workerModel:")) {
            await promptRoleModel("worker", "workerModel", currentSettings.workerModel);
          } else if (picked.startsWith("validatorModel:")) {
            await promptRoleModel(
              "validator",
              "validatorModel",
              currentSettings.validatorModel,
            );
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

    async function handleBareCommand(ctx: ExtensionCommandContext): Promise<void> {
      const { engine } = await ensureBound(ctx);
      const snapshot = engine.getSnapshot();

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
      const doneLabel = "Complete Swarm (/swarm done) — finish run & restore idle tools";
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
        pauseOrResumeLabel,
        ...(showDone ? [doneLabel] : []),
        newSwarmLabel,
        focusLabel,
        settingsLabel,
        teardownLabel,
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
        await handleModelsCommand(ctx);
      } else if (choice === pauseOrResumeLabel) {
        if (run.status === "paused") {
          await handleResumeCommand(ctx);
        } else {
          await handlePauseCommand("", ctx);
        }
      } else if (choice === doneLabel) {
        await handleDoneCommand("", ctx);
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
          await startInteractiveDrafting(parsed.rest, ctx);
          return;
        case "direct":
          await startDirectSwarm(parsed.rest, ctx);
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
          await handleModelsCommand(ctx);
          return;
        case "model":
          await handleModelCommand(parsed.rest, ctx);
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
          await handleResumeCommand(ctx);
          return;
        case "cancel":
          await handleCancelCommand(ctx);
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
      const trimmedStart = prefix.trimStart();
      if (!trimmedStart.includes(" ")) {
        const lower = trimmedStart.toLowerCase();
        const matches = SWARM_SUBCOMMANDS.filter((c) => c.name.startsWith(lower)).map(
          (c): AutocompleteItem => ({
            value: c.name,
            label: c.name,
            description: c.description,
          }),
        );
        return matches.length > 0 ? matches : null;
      }

      const spaceIdx = trimmedStart.search(/\s/);
      const sub = trimmedStart.slice(0, spaceIdx).toLowerCase();
      const argPrefix = trimmedStart.slice(spaceIdx).trimStart();

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

      if (sub === "tasks" || sub === "ui") {
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

      if (sub === "model") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const completedCount = hasTrailingSpace
          ? rawTokens.length
          : Math.max(0, rawTokens.length - 1);
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");

        if (completedCount === 0) {
          const items: AutocompleteItem[] = [];
          const lowerActive = activeToken.toLowerCase();
          for (const role of MODEL_ROLES) {
            if (role.startsWith(lowerActive)) {
              items.push({
                value: `model ${role}`,
                label: role,
                description: `Configure ${role} role default model`,
              });
            }
          }
          const run = getSnapshotSafe().run;
          if (run) {
            for (const entry of getOrderedMembers(run)) {
              if (entry.state === "killed") continue;
              if (entry.name.toLowerCase().startsWith(lowerActive)) {
                items.push({
                  value: `model ${entry.name}`,
                  label: entry.name,
                  description: `${entry.role} [${entry.state}] ${entry.model ?? "default"}`,
                });
              }
            }
          }
          return items.length > 0 ? items : null;
        }

        if (completedCount === 1) {
          const target = rawTokens[0]!;
          const lowerActive = activeToken.toLowerCase();
          const items: AutocompleteItem[] = [];
          if (isSwarmModelRole(target.toLowerCase()) && "default".startsWith(lowerActive)) {
            items.push({
              value: `model ${target} default`,
              label: "default",
              description: "Clear override and inherit host model",
            });
          }
          for (const fb of currentSettings.fallbackModels) {
            if (fb.toLowerCase().startsWith(lowerActive)) {
              items.push({
                value: `model ${target} ${fb}`,
                label: fb,
                description: "Configured fallback model",
              });
            }
          }
          return items.length > 0 ? items : null;
        }

        if (completedCount === 2) {
          const target = rawTokens[0]!;
          const modelId = rawTokens[1]!;
          const lowerActive = activeToken.toLowerCase();
          const items = Array.from(VALID_THINKING_LEVELS)
            .filter((lvl) => lvl.startsWith(lowerActive))
            .map((lvl): AutocompleteItem => ({
              value: `model ${target} ${modelId} ${lvl}`,
              label: lvl,
              description: `Set thinking level to ${lvl}`,
            }));
          return items.length > 0 ? items : null;
        }

        return null;
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
        const run = getSnapshotSafe().run;
        const lowerActive = argPrefix.toLowerCase();
        const items: AutocompleteItem[] = [];
        if (run) {
          for (const entry of getOrderedMembers(run)) {
            if (entry.state === "killed") continue;
            if (entry.name.toLowerCase().startsWith(lowerActive)) {
              items.push({
                value: `kill ${entry.name}`,
                label: entry.name,
                description: `${entry.role} [${entry.state}]`,
              });
            }
          }
        }
        if ("--force".startsWith(lowerActive)) {
          items.push({
            value: "kill --force",
            label: "--force",
            description: "Force-kill even if member worktree has uncommitted changes",
          });
        }
        return items.length > 0 ? items : null;
      }

      if (sub === "teardown") {
        const flags = [
          {
            value: "teardown --force",
            label: "--force",
            description: "Stop active members and force-remove dirty worktrees",
          },
          {
            value: "teardown --delete-branches",
            label: "--delete-branches",
            description: "Also delete local member branches for removed worktrees",
          },
        ];
        const items = flags.filter((f) =>
          f.label.startsWith(argPrefix.toLowerCase()),
        );
        return items.length > 0 ? items : null;
      }

      if (sub === "focus" && activeStore) {
        try {
          const runs = await activeStore.listRuns();
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
    // Register Commands: ONLY `/swarm` and `/swarm-direct`
    // ------------------------------------------------------------------------
    pi.registerCommand("swarm", {
      description:
        "Pi Swarm v0.2.0 — Dynamic Antigravity Swarm orchestrator (shared #seq board, warm sessions, fork, 3-role models & git worktrees)",
      getArgumentCompletions: getSwarmCompletions,
      handler: handleSwarmCommand,
    });

    pi.registerCommand("swarm-direct", {
      description:
        "Fast-path /swarm direct <goal> — skip Q&A and launch Dynamic Swarm immediately",
      handler: async (args, ctx) => {
        await startDirectSwarm(args, ctx);
      },
    });

    // ------------------------------------------------------------------------
    // Lifecycle Hooks (`session_start`, `session_tree`, `before_agent_start`,
    // `agent_settled`, `session_shutdown`)
    // ------------------------------------------------------------------------

    pi.on("session_start", async (_event, ctx) => {
      if (activeEngine || unbindShortcuts) {
        await disposeRuntime(ctx);
      }
      isShutDown = false;
      lastCtx = ctx;

      await ensureBound(ctx);
      await rehydrateSessionState(ctx);
      await mountUI(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
      lastCtx = ctx;
      await rehydrateSessionState(ctx);
    });

    pi.on("before_agent_start", async (event, ctx) => {
      lastCtx = ctx;
      const draft = draftController.getDraft() ?? draftController.rehydrate(ctx);
      let sectionContent: string | undefined;

      if (isDraftActive(draft)) {
        sectionContent = buildDraftingSystemOverlay(draft);
      } else {
        const snapshot = getSnapshotSafe();
        if (isRunningProfileRun(snapshot.run)) {
          sectionContent = buildOrchestratorPlaybookSection(snapshot);
        }
      }

      // Prompt-cache-safe tail section injection: NEVER return { systemPrompt }!
      if (event.systemPromptOptions?.sections) {
        if (sectionContent) {
          event.systemPromptOptions.sections.swarm = sectionContent;
        } else {
          delete event.systemPromptOptions.sections.swarm;
        }
        return undefined;
      }

      // Fallback for non-standard harnesses without systemPromptOptions.sections
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
      refreshUI(ctx);
      // Do not fight the user immediately after an explicit abort (Esc)
      if (event.aborted) {
        return;
      }
      if (pendingWakeups.length > 0 && ctx.isIdle() && !ctx.hasPendingMessages()) {
        flushPendingWakeups(ctx);
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      await disposeRuntime(ctx);
    });
  };
}

export default function piSwarmExtension(pi: ExtensionAPI): void {
  createPiSwarmExtension()(pi);
}

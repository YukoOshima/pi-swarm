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
  DEFAULT_SWARM_SETTINGS,
  ORCHESTRATOR_BOARD_NAME,
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
  SwarmOrchestrator,
  buildOrchestratorContextSummary,
  registerOrchestratorTools,
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
  type ISwarmOrchestrator,
  type ISwarmStore,
  type ISwarmTransport,
  type IWorktreeManager,
  type ProposedSwarmPlan,
  type SafeTeardownResult,
  type SwarmFocusEntry,
  type SwarmModelRole,
  type SwarmOrchestratorEvent,
  type SwarmRunState,
  type SwarmSettings,
  type SwarmSnapshot,
  type TeardownEntryResult,
  isSwarmProtocolError,
} from "./types.js";
import {
  type SwarmWidgetOptions,
  type SwarmWidgetState,
  bindSwarmShortcuts,
  createQuestionnaireUI,
  createSwarmWidget,
  createSwarmWidgetState,
  formatStatusLine,
  formatZeroTurnBoardView,
  formatZeroTurnModelsView,
  formatZeroTurnStatusDashboard,
  isModalOpen,
  openTasksOverlay,
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
  { name: "direct", description: "Fast-path plan & launch without interactive Q&A" },
  { name: "status", description: "Zero-turn Swarm status dashboard" },
  { name: "board", description: "Zero-turn shared Message Board feed [limit]" },
  { name: "models", description: "Zero-turn 3-role & live fleet models overview" },
  {
    name: "model",
    description: "Set role default or hot-switch waiting agent model (<target> <model> [thinking])",
  },
  { name: "tasks", description: "Open interactive missions, logs, diffs & board overlay" },
  { name: "approve", description: "Sign off an artifact mission (<mission-id>)" },
  {
    name: "verify",
    description: "Run or skip run-level Final Validator [--force] [--skip [reason]]",
  },
  { name: "kill", description: "Permanently kill an agent (<agent-name-or-id> [reason])" },
  { name: "pause", description: "Pause scheduling of new workers/validators" },
  { name: "resume", description: "Resume a paused Swarm run" },
  { name: "cancel", description: "Cancel active draft or abandon focused run" },
  {
    name: "teardown",
    description: "Safely remove clean idle worktrees [--force] [--delete-branches]",
  },
  { name: "runs", description: "List Swarm runs in .pi/swarm/runs/" },
  { name: "focus", description: "Switch session-local focus to a run [run-id|none]" },
  { name: "settings", description: "View or adjust 3-role models & Swarm settings" },
  { name: "help", description: "Show /swarm command reference" },
];

const SINGLE_WORD_SUBCOMMANDS = new Set([
  "status",
  "models",
  "pause",
  "resume",
  "cancel",
  "runs",
  "settings",
  "help",
]);

const ARG_SUBCOMMANDS = new Set([
  "direct",
  "board",
  "model",
  "tasks",
  "approve",
  "verify",
  "kill",
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

const CLEAR_MODEL_TOKENS = new Set(["clear", "default", "reset", "none"]);

export interface ParsedSwarmInvocation {
  kind:
    | "bare"
    | "goal"
    | "direct"
    | "status"
    | "board"
    | "models"
    | "model"
    | "tasks"
    | "approve"
    | "verify"
    | "kill"
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
        | "model"
        | "tasks"
        | "approve"
        | "verify"
        | "kill"
        | "teardown"
        | "focus",
      rest,
    };
  }

  if (SINGLE_WORD_SUBCOMMANDS.has(head)) {
    // Allow `/swarm pause <reason>` or single-word subcommands (no free-form goal sentence).
    if (!rest || head === "pause") {
      return {
        kind: head as
          | "status"
          | "models"
          | "pause"
          | "resume"
          | "cancel"
          | "runs"
          | "settings"
          | "help",
        rest,
      };
    }
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

interface ParsedVerifyArgs {
  skip: boolean;
  force: boolean;
  reason?: string;
}

function parseVerifyArgs(rawArgs: string): ParsedVerifyArgs {
  const tokens = tokenizeCommandArgs(rawArgs.trim());
  let skip = false;
  let force = false;
  const reasonParts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const lower = token.toLowerCase();
    if (lower === "--skip") {
      skip = true;
      continue;
    }
    if (lower === "--force" || lower === "-f") {
      force = true;
      continue;
    }
    if (lower === "--reason") {
      if (i + 1 < tokens.length) {
        reasonParts.push(tokens[++i]!);
      }
      continue;
    }
    if (lower.startsWith("--reason=")) {
      const value = token.slice("--reason=".length).trim();
      if (value) {
        reasonParts.push(value);
      }
      continue;
    }
    reasonParts.push(token);
  }

  const reason = reasonParts.join(" ").trim();
  return {
    skip,
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
  maxConcurrency: number,
  settings: SwarmSettings = DEFAULT_SWARM_SETTINGS,
): SwarmSnapshot {
  return {
    run: null,
    activeRunId: null,
    runningAgentIds: [],
    workingAgentIds: [],
    waitingAgentIds: [],
    runningCount: 0,
    maxConcurrency,
    boardHead: 0,
    recentBoard: [],
    recentEvents: [],
    unreadOrchestratorMessages: 0,
    roleModels: buildRoleModelsFromSettings(settings),
    totalTokens: 0,
    totalCost: 0,
    pendingReviews: [],
    pendingArtifactApprovals: [],
    readyToMerge: [],
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

function buildHelpMarkdown(): string {
  return [
    "### 🐝 Pi Swarm (`/swarm`) Commands",
    "",
    "| Command | Description |",
    "| --- | --- |",
    "| `/swarm [goal]` | Interactive upfront clarification → Mission DAG plan confirmation (or action menu when a run is focused) |",
    "| `/swarm direct <goal>` · `/swarm-direct <goal>` | Fast-path: inspect repo, propose validated Mission DAG, and launch immediately |",
    "| `/swarm status` | Zero-LLM-turn dashboard: 3-role models, waves, missions, warm roster, board preview & validation gates |",
    "| `/swarm board [limit]` | Zero-LLM-turn shared `#seq` Message Board feed (`@mention` warm wakeups & handoffs) |",
    "| `/swarm models` | Zero-LLM-turn 3-role models (`orchestrator` / `worker` / `validator`) + live roster models |",
    "| `/swarm model <target> <model-id\\|default> [thinking]` | Set a role default (`orchestrator` / `worker` / `validator`) OR hot-switch a warm `waiting` agent keeping full history |",
    "| `/swarm tasks [mission-id]` | Interactive Fleet & Board overlay (`[b]` Board, `[m]` Switch Model, `[k]` Kill, `[s]` Steer/Wake, `[x]` Stop, `[a]` Approve, `[r]` Retry, `[g]` Merge, `[d]` Diff) |",
    "| `/swarm approve <mission-id>` | Sign off a completed `artifact` mission for merge |",
    "| `/swarm verify [--force]` | Trigger or re-run the read-only Run-Level Final Validator on `baseBranch` |",
    "| `/swarm verify --skip [reason]` | Explicit human override: skip Final Validator and complete the run |",
    "| `/swarm kill <agent-name-or-id> [reason]` | Permanently kill an agent and dispose its warm persistent session |",
    "| `/swarm pause [reason]` / `/swarm resume` | Pause or resume scheduling of new workers/validators |",
    "| `/swarm cancel` | Cancel active draft (restores tools) or confirm abandoning focused run |",
    "| `/swarm teardown [--force] [--delete-branches]` | Safely remove clean idle worktrees while preserving `.pi/swarm/runs/` audit & board history |",
    "| `/swarm runs` | List all runs stored in `.pi/swarm/runs/` |",
    "| `/swarm focus [run-id\\|none]` | Switch or detach session-local run focus |",
    "| `/swarm settings` | Inspect or adjust 3-role models, warm sessions, validator & merge settings |",
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
      `- **Removed worktrees:** ${result.removed.map((r) => `\`${r.missionId}\` (\`${r.branch}\`)`).join(", ")}`,
    );
  }
  if (result.skipped.length > 0) {
    lines.push(
      `- **Skipped worktrees:** ${result.skipped
        .map((s) => `\`${s.missionId}\` [${s.action}${s.reason ? `: ${s.reason}` : ""}]`)
        .join(", ")}`,
    );
  }
  if (result.errors.length > 0) {
    lines.push(
      `- **Errors:** ${result.errors.map((e) => `\`${e.missionId}\`: ${e.reason ?? "unknown error"}`).join(", ")}`,
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
    `| \`maxConcurrency\` | ${settings.maxConcurrency} |`,
    `| \`validatorEnabled\` | ${settings.validatorEnabled ? "ON" : "OFF"} |`,
    `| \`maxValidationRounds\` | ${settings.maxValidationRounds} |`,
    `| \`finalValidatorEnabled\` | ${settings.finalValidatorEnabled ? "ON" : "OFF"} |`,
    `| \`maxFinalAuditRounds\` | ${settings.maxFinalAuditRounds} |`,
    `| \`autoFixOnAuditFail\` | ${settings.autoFixOnAuditFail ? "ON" : "OFF"} |`,
    `| \`maxRetries\` | ${settings.maxRetries} |`,
    `| \`autoMergeClean\` | ${settings.autoMergeClean ? "ON" : "OFF"} |`,
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
  type: "wakeup_needed" | "run_finished";
  runId: string | null;
  missionId?: string;
  summary: string;
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
    let activeOrchestrator: ISwarmOrchestrator | undefined;
    let unsubOrchestrator: (() => void) | undefined;
    let unbindShortcuts: (() => void) | undefined;
    let activeWidgetTui: TUI | undefined;
    let isShutDown = false;

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
      return (
        activeOrchestrator?.getSnapshot() ??
        createEmptySnapshot(currentSettings.maxConcurrency, currentSettings)
      );
    }

    function isRunningProfileRun(run: SwarmRunState | null | undefined): boolean {
      // Treat "verifying" identically to "active" (and paused/completed/failed)
      // so the Orchestrator retains the full 12-tool "running" profile.
      return Boolean(run && run.status !== "abandoned");
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
      const activeRunId = activeOrchestrator?.getSnapshot().activeRunId;
      if (!activeRunId || !activeStore) {
        return;
      }
      try {
        await activeStore.updateRun(activeRunId, {
          roleModels: buildRoleModelsFromSettings(currentSettings),
          actor: ORCHESTRATOR_BOARD_NAME,
        });
        await activeOrchestrator?.attachRun(activeRunId, ctx);
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

      // In real saveSwarmSettings("project", ...), passing "" writes `null` to clear a global override.
      // For test overrides.settingsSaver, pass `undefined` cleanly.
      const clearVal = overrides.settingsSaver ? undefined : ("" as unknown as string);
      const nextModelPatchVal = isClearing ? clearVal : trimmed;

      const patch: Partial<SwarmSettings> = {};
      if (role === "orchestrator") {
        patch.orchestratorModel = nextModelPatchVal;
        if (thinkingLevel !== undefined) {
          patch.orchestratorThinkingLevel = thinkingLevel;
        } else if (isClearing) {
          patch.orchestratorThinkingLevel = overrides.settingsSaver
            ? undefined
            : ("" as unknown as ThinkingLevel);
        }
      } else if (role === "worker") {
        patch.workerModel = nextModelPatchVal;
        if (thinkingLevel !== undefined) {
          patch.workerThinkingLevel = thinkingLevel;
        } else if (isClearing) {
          patch.workerThinkingLevel = overrides.settingsSaver
            ? undefined
            : ("" as unknown as ThinkingLevel);
        }
      } else {
        patch.validatorModel = nextModelPatchVal;
        if (thinkingLevel !== undefined) {
          patch.validatorThinkingLevel = thinkingLevel;
        } else if (isClearing) {
          patch.validatorThinkingLevel = overrides.settingsSaver
            ? undefined
            : ("" as unknown as ThinkingLevel);
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

    function enqueueWakeup(ev: SwarmOrchestratorEvent): void {
      if (ev.type !== "wakeup_needed" && ev.type !== "run_finished") {
        return;
      }
      const duplicate = pendingWakeups.some(
        (item) =>
          item.runId === ev.runId &&
          item.missionId === ev.missionId &&
          item.summary === ev.summary,
      );
      if (!duplicate) {
        pendingWakeups.push({
          type: ev.type,
          runId: ev.runId,
          missionId: ev.missionId,
          summary: ev.summary,
        });
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

      const batch = pendingWakeups.splice(0, pendingWakeups.length);
      if (batch.length === 0) {
        return;
      }

      wakeupInFlight = true;
      try {
        const snapshot = getSnapshotSafe();
        const runFinished = batch.some((b) => b.type === "run_finished");
        // Coalesce back-to-back run_finished + wakeup_needed into concise lines.
        const lines: string[] = [];
        const runTag = snapshot.activeRunId ? ` (${snapshot.activeRunId})` : "";
        lines.push(
          runFinished
            ? `🐝 Pi Swarm Run Finished${runTag}`
            : `🐝 Pi Swarm Event Wakeup${runTag}`,
        );

        const seenSummaries = new Set<string>();
        for (const item of batch) {
          const key = `${item.missionId ?? ""}:${item.summary}`;
          if (seenSummaries.has(key)) continue;
          seenSummaries.add(key);
          const tag = item.missionId ? `[${item.missionId}] ` : "";
          lines.push(`- ${tag}${item.summary}`);
        }

        if (snapshot.run) {
          const total = snapshot.run.missionOrder.length;
          const merged = snapshot.run.missionOrder.filter(
            (id) => snapshot.run?.missions[id]?.status === "merged",
          ).length;
          const waitingPart =
            snapshot.waitingAgentIds.length > 0
              ? `, ${snapshot.waitingAgentIds.length} warm waiting`
              : "";
          const boardPart = snapshot.boardHead > 0 ? `, board #${snapshot.boardHead}` : "";
          lines.push(
            "",
            `Run status: ${snapshot.run.status} (${merged}/${total} merged, ${snapshot.runningCount}/${snapshot.maxConcurrency} working${waitingPart}${boardPart}).`,
          );
          if (snapshot.pendingArtifactApprovals.length > 0) {
            lines.push(
              `Pending human artifact approvals: ${snapshot.pendingArtifactApprovals.join(", ")} (user can run \`/swarm approve <id>\`).`,
            );
          }
          if (snapshot.run.finalAuditStatus === "disapproved") {
            lines.push(
              `Final Validation: disapproved (round ${snapshot.run.finalAuditRound}/${snapshot.run.maxFinalAuditRounds}) — inspect via \`swarm_verify(action="status")\`, add fix mission(s) via \`swarm_plan_add\`, re-verify via \`/swarm verify\`, or human override via \`/swarm verify --skip\`.`,
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
              runFinished,
              events: batch,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } finally {
        wakeupInFlight = false;
      }
    }

    function handleOrchestratorEvent(ev: SwarmOrchestratorEvent): void {
      if (isShutDown) {
        return;
      }
      refreshUI();
      if (ev.type === "wakeup_needed" || ev.type === "run_finished") {
        enqueueWakeup(ev);
      }
    }

    function ensureBoundSync(ctx?: ExtensionContext): {
      store: ISwarmStore;
      worktree: IWorktreeManager;
      transport: ISwarmTransport;
      orchestrator: ISwarmOrchestrator;
    } {
      if (ctx) {
        lastCtx = ctx;
      }
      const targetCwd = ctx?.cwd ?? lastCtx?.cwd ?? process.cwd();
      if (
        !activeStore ||
        !activeWorktree ||
        !activeTransport ||
        !activeOrchestrator ||
        boundCwd !== targetCwd
      ) {
        // Dispose stale orchestrator/subscription if rebinding to a different cwd
        if (unsubOrchestrator) {
          unsubOrchestrator();
          unsubOrchestrator = undefined;
        }
        if (activeOrchestrator) {
          const prev = activeOrchestrator;
          activeOrchestrator = undefined;
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
        activeOrchestrator = new SwarmOrchestrator({
          store: activeStore,
          worktree: activeWorktree,
          transport: activeTransport,
          getSettings: () => currentSettings,
          getHostContext: () => lastCtx,
          now: overrides.now,
        });
        unsubOrchestrator = activeOrchestrator.subscribe(handleOrchestratorEvent);
      }

      return {
        store: activeStore,
        worktree: activeWorktree,
        transport: activeTransport,
        orchestrator: activeOrchestrator,
      };
    }

    async function ensureBound(ctx: ExtensionContext): Promise<{
      store: ISwarmStore;
      worktree: IWorktreeManager;
      transport: ISwarmTransport;
      orchestrator: ISwarmOrchestrator;
    }> {
      lastCtx = ctx;
      const cwdChanged = boundCwd !== ctx.cwd;
      if (cwdChanged || !activeOrchestrator) {
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
      const { orchestrator } = await ensureBound(ctx);

      const focusedRunId = rehydrateFocusRunId(ctx);
      if (focusedRunId) {
        try {
          await orchestrator.attachRun(focusedRunId, ctx);
        } catch {
          await orchestrator.attachRun(null, ctx);
        }
      } else {
        await orchestrator.attachRun(null, ctx);
      }

      const snapshot = orchestrator.getSnapshot();
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

      if (unsubOrchestrator) {
        unsubOrchestrator();
        unsubOrchestrator = undefined;
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

      const orch = activeOrchestrator;
      activeOrchestrator = undefined;
      activeStore = undefined;
      activeWorktree = undefined;
      activeTransport = undefined;
      boundCwd = undefined;
      fallbackModelRuntimePromise = undefined;

      if (orch) {
        await orch.dispose();
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
    const orchestratorProxy = createDelegatingProxy<ISwarmOrchestrator>(
      () => ensureBoundSync().orchestrator,
    );

    // ------------------------------------------------------------------------
    // Plan Confirmation Callback (`propose_swarm_plan` -> real store/git/fleet)
    // ------------------------------------------------------------------------
    async function handlePlanConfirmed(
      plan: ProposedSwarmPlan,
      toolCtx: ExtensionContext,
    ): Promise<SwarmRunState> {
      const { store, worktree, orchestrator } = await ensureBound(toolCtx);
      await reloadSettings(toolCtx.cwd);

      // Apply configured Orchestrator model cleanly before launching the run
      await applyOrchestratorModel(
        pi,
        toolCtx,
        currentSettings,
        getLazyFallbackModelRuntime,
      );

      // 1. Ensure git repo is initialized with >=1 commit and .pi/swarm/ excluded
      const ready = await worktree.ensureRepoReady(plan.baseBranch);
      const effectiveBaseBranch = ready.baseBranch || plan.baseBranch;
      const existingBranches = await worktree.listLocalBranches().catch(() => []);
      const ownerSessionId = getSessionIdSafe(toolCtx);

      // 2. Atomically create the run in SwarmStore (validates DAG, scopes, branches)
      const createdRun = await store.createRun({
        objective: plan.objective,
        verificationContract: plan.verificationContract,
        baseBranch: effectiveBaseBranch,
        ownerSessionId,
        ownerPid: process.pid,
        maxConcurrency: plan.maxConcurrency,
        validatorEnabled: plan.validatorEnabled,
        maxValidationRounds: currentSettings.maxValidationRounds,
        finalValidatorEnabled:
          plan.finalValidatorEnabled ?? currentSettings.finalValidatorEnabled,
        maxFinalAuditRounds: currentSettings.maxFinalAuditRounds,
        autoFixOnAuditFail: currentSettings.autoFixOnAuditFail,
        keepWorkersWarm: currentSettings.keepWorkersWarm,
        roleModels: buildRoleModelsFromSettings(currentSettings),
        missions: plan.missions,
        existingBranches,
      });

      // 3. Persist session-local focus entry
      persistFocusEntry(pi, createdRun.id, ownerSessionId, "plan_confirmed");

      // 4. Attach and launch fleet via orchestrator
      const startedRun = await orchestrator.startRun(createdRun.id, toolCtx);

      // 5. Refresh widget & statusline immediately
      refreshUI(toolCtx);
      return startedRun;
    }

    // ------------------------------------------------------------------------
    // Tool Registrations (3 Drafting Tools + 12 Orchestrator Tools = 15 Tools)
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

    registerOrchestratorTools(pi, {
      store: storeProxy,
      worktree: worktreeProxy,
      orchestrator: orchestratorProxy,
      getActiveRunId: () => getSnapshotSafe().activeRunId,
      getSessionId: () => getSessionIdSafe(lastCtx),
      getCallerRole: () => "orchestrator",
      onRoleModelChanged: async (role, model, thinkingLevel) => {
        await applyRoleModelChange(role, model, thinkingLevel, lastCtx, {
          scope: "project",
          updateRun: true,
        });
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
        finalValidatorEnabled: currentSettings.finalValidatorEnabled,
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
        finalValidatorEnabled:
          res.draft.finalValidatorEnabled ?? currentSettings.finalValidatorEnabled,
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
        finalValidatorEnabled: currentSettings.finalValidatorEnabled,
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
      const { orchestrator } = await ensureBound(ctx);
      const current = orchestrator.getSnapshot();
      const snapshot = current.activeRunId
        ? await orchestrator.attachRun(current.activeRunId, ctx).catch(() => current)
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
      const { orchestrator } = await ensureBound(ctx);
      const snapshot = orchestrator.getSnapshot();
      if (!snapshot.run || !snapshot.activeRunId) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      let limit = 25;
      const trimmed = rawArgs.trim();
      if (trimmed) {
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(200, Math.max(1, parsed));
        } else {
          const hint = "Usage: /swarm board [limit] (positive integer, default 25).";
          if (ctx.hasUI) ctx.ui.notify(hint, "warning");
          else emitZeroTurnMessage(ctx, hint);
          return;
        }
      }

      try {
        const { messages, head } = await orchestrator.readBoard({ limit });
        const markdown = formatZeroTurnBoardView(messages, head, {
          runId: snapshot.activeRunId,
        });
        emitZeroTurnMessage(ctx, markdown, {
          runId: snapshot.activeRunId,
          head,
          count: messages.length,
        });
      } catch (err) {
        const msg = `Failed to read Swarm board: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleModelsCommand(ctx: ExtensionCommandContext): Promise<void> {
      const { orchestrator } = await ensureBound(ctx);
      await reloadSettings(ctx.cwd);
      const current = orchestrator.getSnapshot();
      const snapshot = current.activeRunId
        ? await orchestrator.attachRun(current.activeRunId, ctx).catch(() => current)
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
      const { orchestrator } = await ensureBound(ctx);
      const tokens = tokenizeCommandArgs(rawArgs.trim());

      if (tokens.length === 0) {
        await handleModelsCommand(ctx);
        return;
      }

      const [target, modelArg, thinkingArg] = tokens;
      if (!target || !modelArg) {
        const usage =
          "Usage: `/swarm model <orchestrator|worker|validator|agent-name> <model-id|default> [thinking]`";
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

      // Live agent hot model switch (preserves warm session conversation history)
      const snapshot = orchestrator.getSnapshot();
      if (!snapshot.run) {
        const msg = `No focused Swarm run to switch live agent "${target}". To set a role default, use \`/swarm model <orchestrator|worker|validator> <model-id>\`.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      try {
        const updatedRoster = await orchestrator.switchAgentModel(
          target,
          modelArg,
          thinkingLevel,
        );
        refreshUI(ctx);
        const appliedModel = updatedRoster.model ?? modelArg;
        const thinkPart = updatedRoster.thinkingLevel
          ? ` (thinking: \`${updatedRoster.thinkingLevel}\`)`
          : "";
        const msg = `Hot-switched live agent \`${updatedRoster.name}\` (\`${updatedRoster.agentId}\`) to \`${appliedModel}\`${thinkPart} — conversation history preserved.`;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Switched ${updatedRoster.name} -> ${appliedModel} (history preserved).`,
            "info",
          );
        }
        emitZeroTurnMessage(ctx, `✓ ${msg}`, {
          target: updatedRoster.name,
          agentId: updatedRoster.agentId,
          scope: "live_agent",
          model: appliedModel,
          thinkingLevel: updatedRoster.thinkingLevel,
        });
      } catch (err) {
        const msg = `Failed to switch model for "${target}": ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleKillCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { orchestrator } = await ensureBound(ctx);
      const snapshot = orchestrator.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const tokens = tokenizeCommandArgs(rawArgs.trim());
      let target = tokens[0]?.trim() ?? "";
      const reason = tokens.slice(1).join(" ").trim() || undefined;

      if (!target) {
        const candidates = Object.values(snapshot.run.roster).filter(
          (entry) => entry.status !== "killed",
        );
        if (candidates.length > 0 && ctx.hasUI) {
          const choiceMap = new Map<string, string>();
          const choices: string[] = [];
          for (const entry of candidates) {
            const label = `${entry.name} (${entry.role} · ${entry.status} · ${entry.model ?? "default"})`;
            choiceMap.set(label, entry.name);
            choices.push(label);
          }
          const picked = await withModalGuard(() =>
            ctx.ui.select("Select agent to permanently kill:", choices),
          );
          if (!picked) {
            return;
          }
          target = choiceMap.get(picked) ?? "";
        } else {
          const hint =
            candidates.length > 0
              ? `Usage: /swarm kill <agent-name-or-id> [reason] (live: ${candidates.map((c) => c.name).join(", ")})`
              : "Usage: /swarm kill <agent-name-or-id> [reason] (no active or warm agents to kill).";
          if (ctx.hasUI) ctx.ui.notify(hint, "info");
          else emitZeroTurnMessage(ctx, hint);
          return;
        }
      }

      if (!target) return;

      try {
        const effectiveReason = reason ?? "Killed by user via /swarm kill";
        await orchestrator.killAgent(target, effectiveReason);
        refreshUI(ctx);
        const msg = `Permanently killed agent \`${target}\` (${effectiveReason}).`;
        if (ctx.hasUI) ctx.ui.notify(`Killed agent ${target}.`, "warning");
        emitZeroTurnMessage(ctx, `⊘ ${msg}`, {
          target,
          reason: effectiveReason,
        });
      } catch (err) {
        const msg = `Failed to kill agent "${target}": ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleTasksCommand(
      missionArg: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { orchestrator, worktree } = await ensureBound(ctx);
      if (!ctx.hasUI) {
        await handleStatusCommand(ctx);
        return;
      }
      await openTasksOverlay(ctx, orchestrator, worktree, {
        onModalEnter,
        onModalExit,
        initialMissionId: missionArg.trim() || undefined,
        now: overrides.now,
      });
      refreshUI(ctx);
    }

    async function handleApproveCommand(
      rawMissionId: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { orchestrator } = await ensureBound(ctx);
      const snapshot = orchestrator.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      let missionId = rawMissionId.trim();
      if (!missionId) {
        const pending = snapshot.pendingArtifactApprovals;
        if (pending.length === 1 && ctx.hasUI) {
          const ok = await withModalGuard(() =>
            ctx.ui.confirm(
              `Approve artifact ${pending[0]}?`,
              `Sign off completed artifact mission ${pending[0]} for merge into ${snapshot.run?.baseBranch}.`,
            ),
          );
          if (!ok) return;
          missionId = pending[0]!;
        } else if (pending.length > 1 && ctx.hasUI) {
          const picked = await withModalGuard(() =>
            ctx.ui.select("Select artifact mission to approve:", pending),
          );
          if (!picked) return;
          missionId = picked;
        } else {
          const hint =
            pending.length > 0
              ? `Usage: /swarm approve <mission-id> (pending: ${pending.join(", ")})`
              : "Usage: /swarm approve <mission-id> (no artifact missions awaiting approval).";
          if (ctx.hasUI) ctx.ui.notify(hint, "info");
          else emitZeroTurnMessage(ctx, hint);
          return;
        }
      }

      try {
        await orchestrator.approveArtifact(missionId, { approvedBy: "human" });
        const msg = `Approved artifact mission \`${missionId}\`.`;
        if (ctx.hasUI) ctx.ui.notify(`Approved artifact mission ${missionId}.`, "info");
        emitZeroTurnMessage(ctx, `✓ ${msg}`, { missionId });
      } catch (err) {
        const msg = `Failed to approve ${missionId}: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function executeRunFinalAudit(
      runId: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { orchestrator } = await ensureBound(ctx);
      try {
        const updated = await orchestrator.runFinalAudit({
          runId,
          force: true,
          hostContext: ctx,
        });
        applySwarmToolProfile(pi, computeDesiredToolProfile());
        refreshUI(ctx);
        const latestSnapshot = orchestrator.getSnapshot();
        const agentPart = latestSnapshot.finalAuditRunningAgentId
          ? ` (agent \`${latestSnapshot.finalAuditRunningAgentId}\`)`
          : "";
        const displayRound =
          updated.finalAuditStatus === "running"
            ? updated.finalAuditRound + 1
            : updated.finalAuditRound;
        const msg = `Triggered Final Validator for run \`${updated.id}\`${agentPart} — status: \`${updated.status}\`, audit: \`${updated.finalAuditStatus}\` (round ${displayRound}/${updated.maxFinalAuditRounds}).`;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Triggered Final Validator for ${updated.id} (${updated.finalAuditStatus}).`,
            "info",
          );
        }
        emitZeroTurnMessage(ctx, `🔍 ${msg}`, {
          runId: updated.id,
          status: updated.status,
          finalAuditStatus: updated.finalAuditStatus,
          round: displayRound,
          maxRounds: updated.maxFinalAuditRounds,
          runningAgentId: latestSnapshot.finalAuditRunningAgentId,
        });
      } catch (err) {
        const msg = `Failed to run Final Validator: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function executeSkipFinalAudit(
      runId: string,
      reason: string | undefined,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { orchestrator } = await ensureBound(ctx);
      try {
        const updated = await orchestrator.skipFinalAudit({
          runId,
          skippedBy: "human",
          ...(reason ? { reason } : {}),
        });
        applySwarmToolProfile(pi, computeDesiredToolProfile());
        refreshUI(ctx);
        const reasonPart = reason ? ` — reason: ${reason}` : "";
        const msg = `Skipped Final Validator for run \`${updated.id}\`${reasonPart} (status: \`${updated.status}\`).`;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Skipped Final Validator for ${updated.id} (${updated.status}).`,
            "warning",
          );
        }
        emitZeroTurnMessage(ctx, `⏭ ${msg}`, {
          runId: updated.id,
          status: updated.status,
          finalAuditStatus: updated.finalAuditStatus,
          skippedBy: "human",
          ...(reason ? { reason } : {}),
        });
      } catch (err) {
        const msg = `Failed to skip Final Validator: ${formatError(err)}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else emitZeroTurnMessage(ctx, msg);
      }
    }

    async function handleVerifyCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { orchestrator } = await ensureBound(ctx);
      const snapshot = orchestrator.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run. Start one with `/swarm <goal>` first.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const parsed = parseVerifyArgs(rawArgs);
      if (parsed.skip) {
        await executeSkipFinalAudit(snapshot.run.id, parsed.reason, ctx);
        return;
      }

      await executeRunFinalAudit(snapshot.run.id, ctx);
    }

    async function handlePauseCommand(
      reason: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { orchestrator } = await ensureBound(ctx);
      const snapshot = orchestrator.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to pause.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }
      try {
        const updated = await orchestrator.pause(
          snapshot.run.id,
          reason || "Paused by user",
        );
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
      const { orchestrator } = await ensureBound(ctx);
      const snapshot = orchestrator.getSnapshot();
      if (!snapshot.run) {
        const msg = "No focused Swarm run to resume.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }
      try {
        const updated = await orchestrator.resume(snapshot.run.id, ctx);
        applySwarmToolProfile(pi, computeDesiredToolProfile());
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
      const { store, orchestrator } = await ensureBound(ctx);

      // 1. If a planning draft is active, cancel the draft and restore normal tool profile
      if (draftController.isActive()) {
        const snapshot = orchestrator.getSnapshot();
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
      const snapshot = orchestrator.getSnapshot();
      if (!snapshot.run) {
        const msg = "Nothing to cancel (no active Swarm draft or focused run).";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else emitZeroTurnMessage(ctx, msg);
        return;
      }

      const run = snapshot.run;
      if (ctx.hasUI) {
        const liveCount = snapshot.runningCount + snapshot.waitingAgentIds.length;
        const confirmed = await withModalGuard(() =>
          ctx.ui.confirm(
            `Cancel Swarm run ${run.id}?`,
            `This will stop/kill ${liveCount} live agent(s) (${snapshot.runningCount} working, ${snapshot.waitingAgentIds.length} waiting warm) and mark run "${run.objective}" as abandoned. Worktrees and ${SWARM_DIR}/runs/ audit & board logs are preserved.`,
          ),
        );
        if (!confirmed) {
          return;
        }
      }

      const cancelReason = "Cancelled by user via /swarm cancel";
      const postConfirmSnapshot = orchestrator.getSnapshot();
      const agentsToKill = new Set<string>([
        ...snapshot.runningAgentIds,
        ...snapshot.waitingAgentIds,
        ...postConfirmSnapshot.runningAgentIds,
        ...postConfirmSnapshot.waitingAgentIds,
      ]);

      for (const agentId of [...postConfirmSnapshot.runningAgentIds]) {
        try {
          await orchestrator.stopAgent(agentId, {
            humanStopped: true,
            reason: cancelReason,
          });
        } catch {
          // best-effort stop for each working agent
        }
      }

      // Re-check snapshot in case any working agent parked in waiting while stopping others
      const afterStopSnapshot = orchestrator.getSnapshot();
      for (const agentId of [
        ...afterStopSnapshot.runningAgentIds,
        ...afterStopSnapshot.waitingAgentIds,
      ]) {
        agentsToKill.add(agentId);
      }

      // Dispose ALL warm AgentSessions (both aborted running agents and waiting warm agents)
      for (const agentId of agentsToKill) {
        try {
          await orchestrator.killAgent(agentId, cancelReason);
        } catch {
          // best-effort kill for every live/warm handle
        }
      }

      if (run.status !== "completed" && run.status !== "abandoned") {
        // SwarmStore.updateRun automatically appends the `run_abandoned` ledger event.
        await store.updateRun(run.id, {
          status: "abandoned",
          actor: "human",
        });
      }

      await orchestrator.attachRun(run.id, ctx);
      applySwarmToolProfile(pi, computeDesiredToolProfile());
      refreshUI(ctx);

      const msg = `Stopped active agents and marked Swarm run \`${run.id}\` as abandoned (audit trail, board & worktrees preserved).`;
      if (ctx.hasUI) ctx.ui.notify(`Cancelled Swarm run ${run.id}.`, "warning");
      emitZeroTurnMessage(ctx, msg, { runId: run.id, status: "abandoned" });
    }

    async function handleTeardownCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { orchestrator, worktree } = await ensureBound(ctx);
      const snapshot = orchestrator.getSnapshot();
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
        const forceKillIds = new Set<string>([
          ...snapshot.runningAgentIds,
          ...snapshot.waitingAgentIds,
        ]);
        for (const agentId of [...snapshot.runningAgentIds]) {
          try {
            await orchestrator.stopAgent(agentId, {
              humanStopped: true,
              reason: forceReason,
            });
          } catch {
            // continue stopping remaining agents
          }
        }
        const afterStop = orchestrator.getSnapshot();
        for (const agentId of [...afterStop.runningAgentIds, ...afterStop.waitingAgentIds]) {
          forceKillIds.add(agentId);
        }
        for (const agentId of forceKillIds) {
          try {
            await orchestrator.killAgent(agentId, forceReason);
          } catch {
            // continue killing warm agents
          }
        }
      }

      try {
        const result = await orchestrator.teardown({
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
                missionId: entry.missionId,
                worktreePath: entry.worktreePath,
                branch: entry.branch,
                action: "removed",
                reason: "Force-removed dirty worktree",
              });
            } catch (err) {
              result.errors.push({
                missionId: entry.missionId,
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
      const { store, orchestrator } = await ensureBound(ctx);
      const runs = await store.listRuns();
      const focusedId = orchestrator.getSnapshot().activeRunId;

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
        "| Focus | Run ID | Status | Progress | Base | Objective |",
        "| :---: | --- | --- | --- | --- | --- |",
      ];

      for (const r of runs) {
        const star = r.id === focusedId ? "★" : "";
        const obj = r.objective.replace(/\|/g, "\\|").slice(0, 60);
        lines.push(
          `| ${star} | \`${r.id}\` | ${r.status} | ${r.mergedCount}/${r.missionCount} merged | \`${r.baseBranch}\` | ${obj} |`,
        );
      }
      lines.push("", "Switch focus with `/swarm focus <run-id>` or `/swarm focus none`.");

      emitZeroTurnMessage(ctx, lines.join("\n"), { count: runs.length, focusedId });
    }

    async function handleFocusCommand(
      rawTarget: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const { store, orchestrator } = await ensureBound(ctx);
      const target = rawTarget.trim();
      const sessionId = getSessionIdSafe(ctx);

      if (target === "none" || target === "--clear" || target === "off") {
        await orchestrator.attachRun(null, ctx);
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

        const currentFocused = orchestrator.getSnapshot().activeRunId;
        const choiceMap = new Map<string, string | null>();
        const options: string[] = [];
        for (const r of runs) {
          const prefix = r.id === currentFocused ? "★ " : "  ";
          const label = `${prefix}${r.id} [${r.status}] ${r.mergedCount}/${r.missionCount} merged — ${r.objective.slice(0, 50)}`;
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
          await orchestrator.attachRun(null, ctx);
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
        const snapshot = await orchestrator.attachRun(chosenRunId, ctx);
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
          `finalValidatorEnabled: ${currentSettings.finalValidatorEnabled ? "ON" : "OFF"}`,
          `autoFixOnAuditFail: ${currentSettings.autoFixOnAuditFail ? "ON" : "OFF"}`,
          `maxConcurrency: ${currentSettings.maxConcurrency}`,
          `maxValidationRounds: ${currentSettings.maxValidationRounds}`,
          `maxFinalAuditRounds: ${currentSettings.maxFinalAuditRounds}`,
          `autoMergeClean: ${currentSettings.autoMergeClean ? "ON" : "OFF"}`,
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
          } else if (picked.startsWith("finalValidatorEnabled:")) {
            await persistPatch({
              finalValidatorEnabled: !currentSettings.finalValidatorEnabled,
            });
            ctx.ui.notify(
              `Saved finalValidatorEnabled = ${currentSettings.finalValidatorEnabled ? "ON" : "OFF"} (${saveScope}).`,
              "info",
            );
          } else if (picked.startsWith("autoFixOnAuditFail:")) {
            await persistPatch({
              autoFixOnAuditFail: !currentSettings.autoFixOnAuditFail,
            });
            ctx.ui.notify(
              `Saved autoFixOnAuditFail = ${currentSettings.autoFixOnAuditFail ? "ON" : "OFF"} (${saveScope}).`,
              "info",
            );
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
          } else if (picked.startsWith("maxValidationRounds:")) {
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                `Set maxValidationRounds (${SWARM_SETTINGS_BOUNDS.maxValidationRounds.min}-${SWARM_SETTINGS_BOUNDS.maxValidationRounds.max})`,
                String(currentSettings.maxValidationRounds),
              ),
            );
            if (raw !== undefined && raw.trim()) {
              const num = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(num)) {
                await persistPatch({ maxValidationRounds: num });
                ctx.ui.notify(
                  `Saved maxValidationRounds = ${currentSettings.maxValidationRounds} (${saveScope}).`,
                  "info",
                );
              }
            }
          } else if (picked.startsWith("maxFinalAuditRounds:")) {
            const raw = await withModalGuard(() =>
              ctx.ui.input(
                `Set maxFinalAuditRounds (${SWARM_SETTINGS_BOUNDS.maxFinalAuditRounds.min}-${SWARM_SETTINGS_BOUNDS.maxFinalAuditRounds.max})`,
                String(currentSettings.maxFinalAuditRounds),
              ),
            );
            if (raw !== undefined && raw.trim()) {
              const num = Number.parseInt(raw.trim(), 10);
              if (Number.isFinite(num)) {
                await persistPatch({ maxFinalAuditRounds: num });
                ctx.ui.notify(
                  `Saved maxFinalAuditRounds = ${currentSettings.maxFinalAuditRounds} (${saveScope}).`,
                  "info",
                );
              }
            }
          } else if (picked.startsWith("autoMergeClean:")) {
            await persistPatch({ autoMergeClean: !currentSettings.autoMergeClean });
            ctx.ui.notify(
              `Saved autoMergeClean = ${currentSettings.autoMergeClean ? "ON" : "OFF"} (${saveScope}).`,
              "info",
            );
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
      const { orchestrator } = await ensureBound(ctx);
      const snapshot = orchestrator.getSnapshot();

      if (!snapshot.run) {
        await startInteractiveDrafting("", ctx);
        return;
      }

      if (!ctx.hasUI) {
        await handleStatusCommand(ctx);
        return;
      }

      const run = snapshot.run;
      const missions = run.missionOrder
        .map((id) => run.missions[id])
        .filter((m) => Boolean(m));
      const allMissionsTerminal =
        missions.length > 0 &&
        missions.every((m) => m!.status === "merged" || m!.status === "abandoned");
      const showVerifyRun =
        allMissionsTerminal || run.finalAuditStatus === "disapproved";
      const showVerifySkip =
        run.finalAuditStatus === "disapproved" ||
        (allMissionsTerminal &&
          run.status !== "completed" &&
          run.status !== "abandoned" &&
          run.finalAuditStatus !== "approved" &&
          run.finalAuditStatus !== "skipped");

      const pauseOrResumeLabel =
        run.status === "paused"
          ? "Resume — continue scheduling missions"
          : "Pause — halt new spawns (active agents continue)";

      const tasksLabel = "Open Tasks & Board Overlay — fleet, logs, diffs, board & actions";
      const boardLabel = `View Board (/swarm board) — shared message board (#${snapshot.boardHead})`;
      const modelsLabel = "Manage Models (/swarm models) — 3-role & live agent models";
      const statusLabel = "Status dashboard — zero-turn wave, board & roster report";
      const verifyRunLabel = "Run Final Validator (/swarm verify)";
      const verifySkipLabel = "Skip Final Validator (/swarm verify --skip)";
      const newSwarmLabel = "Start new swarm — interactive planning interview";
      const focusLabel = "Switch focused run — list / attach / detach";
      const settingsLabel = "Settings — 3-role models, warm sessions, validator & merge options";
      const teardownLabel = "Teardown — safely remove clean idle worktrees";

      const menuChoices: string[] = [
        tasksLabel,
        boardLabel,
        modelsLabel,
        statusLabel,
        ...(showVerifyRun ? [verifyRunLabel] : []),
        ...(showVerifySkip ? [verifySkipLabel] : []),
        pauseOrResumeLabel,
        newSwarmLabel,
        focusLabel,
        settingsLabel,
        teardownLabel,
      ];

      const choice = await withModalGuard(() =>
        ctx.ui.select(
          `🐝 Swarm (${run.id} · ${run.status}) — ${run.objective.slice(0, 56)}`,
          menuChoices,
        ),
      );

      if (!choice) return;

      if (choice === tasksLabel) {
        await handleTasksCommand("", ctx);
      } else if (choice === boardLabel) {
        await handleBoardCommand("", ctx);
      } else if (choice === modelsLabel) {
        await handleModelsCommand(ctx);
      } else if (choice === statusLabel) {
        await handleStatusCommand(ctx);
      } else if (choice === verifyRunLabel) {
        await executeRunFinalAudit(run.id, ctx);
      } else if (choice === verifySkipLabel) {
        const reasonInput = await withModalGuard(() =>
          ctx.ui.input("Skip Final Validator — optional reason", ""),
        );
        if (reasonInput === undefined) {
          return;
        }
        await executeSkipFinalAudit(run.id, reasonInput.trim() || undefined, ctx);
      } else if (choice === pauseOrResumeLabel) {
        if (run.status === "paused") {
          await handleResumeCommand(ctx);
        } else {
          await handlePauseCommand("", ctx);
        }
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
        case "models":
          await handleModelsCommand(ctx);
          return;
        case "model":
          await handleModelCommand(parsed.rest, ctx);
          return;
        case "tasks":
          await handleTasksCommand(parsed.rest, ctx);
          return;
        case "approve":
          await handleApproveCommand(parsed.rest, ctx);
          return;
        case "verify":
          await handleVerifyCommand(parsed.rest, ctx);
          return;
        case "kill":
          await handleKillCommand(parsed.rest, ctx);
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
        const presets = ["10", "25", "50", "100"];
        const items = presets
          .filter((n) => n.startsWith(argPrefix))
          .map((n): AutocompleteItem => ({
            value: `board ${n}`,
            label: n,
            description: `Show last ${n} shared board messages`,
          }));
        return items.length > 0 ? items : null;
      }

      if (sub === "model") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const completedCount = hasTrailingSpace ? rawTokens.length : Math.max(0, rawTokens.length - 1);
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
            const seenNames = new Set<string>();
            for (const entry of Object.values(run.roster)) {
              if (entry.status === "killed") continue;
              const name = entry.name || entry.agentId;
              if (seenNames.has(name.toLowerCase())) continue;
              seenNames.add(name.toLowerCase());
              if (name.toLowerCase().startsWith(lowerActive)) {
                items.push({
                  value: `model ${name}`,
                  label: name,
                  description: `${entry.role} [${entry.status}] ${entry.model ?? "default"}`,
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

      if (sub === "kill") {
        const run = getSnapshotSafe().run;
        if (!run) return null;
        const lowerActive = argPrefix.toLowerCase();
        const seenNames = new Set<string>();
        const items: AutocompleteItem[] = [];
        for (const entry of Object.values(run.roster)) {
          if (entry.status === "killed") continue;
          const name = entry.name || entry.agentId;
          if (seenNames.has(name.toLowerCase())) continue;
          seenNames.add(name.toLowerCase());
          if (name.toLowerCase().startsWith(lowerActive)) {
            items.push({
              value: `kill ${name}`,
              label: name,
              description: `${entry.role} [${entry.status}]`,
            });
          }
        }
        return items.length > 0 ? items : null;
      }

      if (sub === "tasks") {
        const run = getSnapshotSafe().run;
        if (!run) return null;
        const items = run.missionOrder
          .filter((id) => id.toLowerCase().startsWith(argPrefix.toLowerCase()))
          .map((id): AutocompleteItem => ({
            value: `tasks ${id}`,
            label: id,
            description: run.missions[id]?.title ?? "Mission",
          }));
        return items.length > 0 ? items : null;
      }

      if (sub === "approve") {
        const pending = getSnapshotSafe().pendingArtifactApprovals;
        const items = pending
          .filter((id) => id.toLowerCase().startsWith(argPrefix.toLowerCase()))
          .map((id): AutocompleteItem => ({
            value: `approve ${id}`,
            label: id,
            description: "Artifact mission awaiting sign-off",
          }));
        return items.length > 0 ? items : null;
      }

      if (sub === "verify") {
        const hasTrailingSpace = /\s$/.test(prefix);
        const rawTokens = argPrefix ? argPrefix.split(/\s+/).filter(Boolean) : [];
        const priorTokens = hasTrailingSpace ? rawTokens : rawTokens.slice(0, -1);
        const activeToken = hasTrailingSpace ? "" : (rawTokens[rawTokens.length - 1] ?? "");
        const usedFlags = new Set(priorTokens.map((t) => t.toLowerCase()));
        const valuePrefix = priorTokens.length > 0 ? `verify ${priorTokens.join(" ")} ` : "verify ";

        const flags = [
          {
            label: "--force",
            description: "Force trigger/re-run Final Validator on baseBranch",
          },
          {
            label: "--skip",
            description: "Human override: skip Final Validator and complete run [reason]",
          },
          {
            label: "--reason",
            description: "Optional skip reason (--skip --reason <text>)",
          },
        ];

        const items = flags
          .filter((f) => {
            if (usedFlags.has(f.label)) return false;
            if (usedFlags.has("--skip") && f.label === "--force") return false;
            if (usedFlags.has("--force") && (f.label === "--skip" || f.label === "--reason")) {
              return false;
            }
            return f.label.startsWith(activeToken.toLowerCase());
          })
          .map((f): AutocompleteItem => ({
            value: `${valuePrefix}${f.label}`,
            label: f.label,
            description: f.description,
          }));
        return items.length > 0 ? items : null;
      }

      if (sub === "teardown") {
        const flags = [
          {
            value: "teardown --force",
            label: "--force",
            description: "Stop/kill active agents and force-remove dirty worktrees",
          },
          {
            value: "teardown --delete-branches",
            label: "--delete-branches",
            description: "Also delete local mission branches for removed worktrees",
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
              description: `[${r.status}] ${r.objective.slice(0, 48)}`,
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
        "Pi Swarm multi-agent orchestrator (3-role models, shared Message Board, warm sessions, git worktrees & 4-layer validation gates)",
      getArgumentCompletions: getSwarmCompletions,
      handler: handleSwarmCommand,
    });

    pi.registerCommand("swarm-direct", {
      description:
        "Fast-path /swarm direct <goal> — inspect repo and launch Mission DAG immediately",
      handler: async (args, ctx) => {
        await startDirectSwarm(args, ctx);
      },
    });

    // ------------------------------------------------------------------------
    // Lifecycle Hooks (`session_start`, `session_tree`, `before_agent_start`,
    // `agent_settled`, `session_shutdown`)
    // ------------------------------------------------------------------------

    pi.on("session_start", async (_event, ctx) => {
      // Clean up any previous session bindings in case of /new, /resume, /fork, /reload
      if (activeOrchestrator || unbindShortcuts) {
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
          sectionContent = buildOrchestratorContextSummary(snapshot);
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

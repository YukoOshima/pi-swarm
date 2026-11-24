import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageRenderer,
  ModelRuntime,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  ALL_SWARM_EXTENSION_TOOLS,
  DEFAULT_CHANNEL,
  DEFAULT_SWARM_SETTINGS,
  DRAFTING_TOOLS,
  IDLE_SWARM_TOOLS,
  POST_MESSAGE_TOOL,
  PROPOSE_SWARM_PLAN_TOOL,
  READ_BOARD_TOOL,
  SWARM_BOARD_FILE,
  SWARM_CORE_TOOLS,
  SWARM_DIR,
  SWARM_EVENTS_FILE,
  SWARM_FEATURES_FILE,
  SWARM_FOCUS_ENTRY,
  SWARM_LIBRARY_DIR,
  SWARM_MISSION_FILE,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_ROSTER_FILE,
  SWARM_RUNS_DIR,
  SWARM_SERVICES_FILE,
  SWARM_SETTINGS_FILE,
  SWARM_STATE_FILE,
  SWARM_STATUS_KEY,
  SWARM_TOOL,
  SWARM_VALIDATION_CONTRACT_FILE,
  SWARM_VALIDATION_STATE_FILE,
  SWARM_WAIT_TOOL,
  SWARM_WAKEUP_CUSTOM_TYPE,
  SWARM_WIDGET_KEY,
} from "../src/constants.js";
import {
  SWARM_STATUS_CUSTOM_TYPE,
  SWARM_SUBCOMMANDS,
  type SwarmExtensionOptions,
  buildLaunchKickoffPrompt,
  createPiSwarmExtension,
  parseContractReviewOutput,
  parseSwarmCommand,
} from "../src/index.js";
import { SwarmEngine } from "../src/runtime/index.js";
import { SwarmStore, WorktreeManager } from "../src/store/index.js";
import {
  type AgentTurnResult,
  type CompleteRunOptions,
  type ContractReviewResult,
  type IQuestionnaireUI,
  type ISwarmEngine,
  type ISwarmTransport,
  type IWorktreeManager,
  type ManageMissionInput,
  type MissionAssertion,
  type MissionFeature,
  type MissionServiceEntry,
  type ModelSwitchResult,
  type PersistentAgentHandle,
  type ProposedSwarmPlan,
  type SpawnMemberRequest,
  type SwarmEvent,
  type SwarmMemberRole,
  type SwarmMemberState,
  SwarmProtocolError,
  type SwarmRunState,
  type SwarmSettings,
} from "../src/types.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Real Git Repo Helpers
// ============================================================================

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
  return stdout.trim();
}

async function createTempGitRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `pi-swarm-e2e-${prefix}-`));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Swarm Test"]);
  await git(dir, ["config", "user.email", "swarm-test@local"]);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(
    path.join(dir, "README.md"),
    "# Test Project\n\nInitial baseline.\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "src", "index.ts"),
    "export const VERSION = '0.0.1';\n",
    "utf8",
  );
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial commit"]);
  return dir;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function makeUserMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeAssistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

// ============================================================================
// Mock Model Catalog & Warm Persistent Member Handle Builder
// ============================================================================

function makeCatalogModel(provider: string, id: string, name?: string): Model<Api> {
  return {
    id,
    name: name ?? id,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://mock.local",
    reasoning: true,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  } as Model<Api>;
}

const DEFAULT_TEST_MODELS: Model<Api>[] = [
  makeCatalogModel("anthropic", "claude-opus-4-6", "Claude Opus 4.6"),
  makeCatalogModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
  makeCatalogModel("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5"),
  makeCatalogModel("openai", "gpt-5.2", "GPT-5.2"),
  makeCatalogModel("openai", "gpt-5-mini", "GPT-5 Mini"),
  makeCatalogModel("google", "gemini-2.5-pro", "Gemini 2.5 Pro"),
];

function createMockModelRuntime(
  models: Model<Api>[] = DEFAULT_TEST_MODELS,
  authenticatedProviders: ReadonlySet<string> = new Set([
    "anthropic",
    "openai",
    "google",
  ]),
): ModelRuntime {
  return {
    getModels: () => [...models],
    hasConfiguredAuth: (providerId: string) => authenticatedProviders.has(providerId),
  } as unknown as ModelRuntime;
}

interface MockMemberTracker {
  request: SpawnMemberRequest;
  agentId: string;
  name: string;
  role: SwarmMemberRole;
  spawnModel?: string;
  spawnThinkingLevel?: ThinkingLevel;
  seedMessages?: AgentMessage[];
  wakeCount: number;
  wakePrompts: string[];
  conversationMessages: AgentMessage[];
  modelSwitches: Array<{ model: string; thinkingLevel?: ThinkingLevel }>;
  killed: boolean;
  killReason?: string;
  aborted: boolean;
  handle: PersistentAgentHandle;
}

function createMockPersistentMemberHandle(spec: {
  request: SpawnMemberRequest;
  runInitialTurn: (ctx: {
    getModel: () => string | undefined;
    getThinkingLevel: () => ThinkingLevel | undefined;
    pushAssistantMessage: (text: string) => void;
    isAborted: () => boolean;
  }) => Promise<AgentTurnResult>;
  runWakeTurn?: (
    prompt: string,
    ctx: {
      wakeIndex: number;
      getModel: () => string | undefined;
      getThinkingLevel: () => ThinkingLevel | undefined;
      pushAssistantMessage: (text: string) => void;
      isAborted: () => boolean;
    },
  ) => Promise<AgentTurnResult>;
  onAbort?: () => void;
}): MockMemberTracker {
  const { request } = spec;
  let state: SwarmMemberState = "working";
  let currentModel: string | undefined = request.modelOverride;
  let currentThinking: ThinkingLevel | undefined = request.thinkingLevel;
  let aborted = false;
  let killed = false;
  let killReason: string | undefined;
  let wakeCount = 0;

  const conversationMessages: AgentMessage[] = [
    ...(request.seedMessages ?? []),
    makeUserMsg(request.initialPrompt),
  ];
  const wakePrompts: string[] = [];
  const modelSwitches: Array<{ model: string; thinkingLevel?: ThinkingLevel }> = [];

  const pushAssistantMessage = (text: string): void => {
    conversationMessages.push(makeAssistantMsg(text));
  };

  const finalizeTurn = (result: AgentTurnResult): AgentTurnResult => {
    if (killed || result.outcome === "killed") {
      state = "killed";
    } else if (aborted || result.outcome === "stopped") {
      state = "stopped";
    } else {
      state = request.keepWarm ? "waiting" : "stopped";
    }
    return {
      ...result,
      model: result.model ?? currentModel,
      thinkingLevel: result.thinkingLevel ?? currentThinking,
    };
  };

  let activeTurn: Promise<AgentTurnResult> = (async () => {
    const res = await spec.runInitialTurn({
      getModel: () => currentModel,
      getThinkingLevel: () => currentThinking,
      pushAssistantMessage,
      isAborted: () => aborted || killed,
    });
    return finalizeTurn(res);
  })();

  const handle: PersistentAgentHandle = {
    agentId: request.agentId,
    name: request.name,
    role: request.role,
    getState: () => state,
    getModel: () => currentModel,
    getThinkingLevel: () => currentThinking,
    getConversationMessages: () => [...conversationMessages],
    async wake(prompt: string): Promise<AgentTurnResult> {
      if (killed || state === "killed") {
        throw new SwarmProtocolError(
          "MEMBER_KILLED",
          `Member "${request.name}" has been killed and cannot be woken.`,
        );
      }
      if (state === "working") {
        throw new SwarmProtocolError(
          "MEMBER_NOT_WAITING",
          `Member "${request.name}" is already working.`,
        );
      }
      state = "working";
      aborted = false;
      wakeCount += 1;
      tracker.wakeCount = wakeCount;
      wakePrompts.push(prompt);
      conversationMessages.push(makeUserMsg(prompt));

      const turnPromise = (async () => {
        const res = spec.runWakeTurn
          ? await spec.runWakeTurn(prompt, {
              wakeIndex: wakeCount,
              getModel: () => currentModel,
              getThinkingLevel: () => currentThinking,
              pushAssistantMessage,
              isAborted: () => aborted || killed,
            })
          : {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting" as const,
              summary: `Woken turn ${wakeCount} completed on ${currentModel ?? "default"}`,
              model: currentModel,
              thinkingLevel: currentThinking,
              tokens: 150,
              cost: 0.0015,
            };
        return finalizeTurn(res);
      })();

      activeTurn = turnPromise;
      return turnPromise;
    },
    async steer() {},
    async followUp() {},
    async switchModel(
      modelOverride: string,
      thinkingLevel?: ThinkingLevel,
    ): Promise<ModelSwitchResult> {
      if (killed || state === "killed") {
        throw new SwarmProtocolError(
          "MEMBER_KILLED",
          `Member "${request.name}" has been killed.`,
        );
      }
      if (state !== "waiting") {
        throw new SwarmProtocolError(
          "MEMBER_NOT_WAITING",
          `Member "${request.name}" is currently "${state}".`,
        );
      }
      currentModel = modelOverride.trim();
      if (thinkingLevel !== undefined) {
        currentThinking = thinkingLevel;
      }
      modelSwitches.push({ model: currentModel, thinkingLevel: currentThinking });
      return {
        model: currentModel,
        ...(currentThinking !== undefined ? { thinkingLevel: currentThinking } : {}),
      };
    },
    async abort() {
      aborted = true;
      tracker.aborted = true;
      if (!killed) {
        state = "stopped";
      }
      spec.onAbort?.();
    },
    async kill(reason?: string) {
      killed = true;
      killReason = reason;
      state = "killed";
      tracker.killed = true;
      tracker.killReason = reason;
      spec.onAbort?.();
    },
    get currentTurn() {
      return activeTurn;
    },
  };

  const tracker: MockMemberTracker = {
    request,
    agentId: request.agentId,
    name: request.name,
    role: request.role,
    spawnModel: request.modelOverride,
    spawnThinkingLevel: request.thinkingLevel,
    seedMessages: request.seedMessages,
    wakeCount: 0,
    wakePrompts,
    conversationMessages,
    modelSwitches,
    killed: false,
    killReason,
    aborted: false,
    handle,
  };

  return tracker;
}

// ============================================================================
// Mock Pi 1.5.2 Extension Harness (Lifecycle, Models, SessionContext, Tools & UI)
// ============================================================================

interface RecordedMessage {
  message: {
    customType: string;
    content: string | unknown;
    display: boolean;
    details?: unknown;
  };
  options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
  };
}

interface RecordedUserMessage {
  content: string | unknown;
  options?: {
    deliverAs?: "steer" | "followUp";
    expandPromptTemplates?: boolean;
  };
}

interface BranchEntry {
  id: string;
  parentId: string | null;
  type: "custom";
  customType: string;
  data: unknown;
}

interface MockHarness {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  tools: Map<string, ToolDefinition<any, any, any>>;
  commands: Map<
    string,
    {
      description?: string;
      getArgumentCompletions?: (prefix: string) => unknown;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }
  >;
  handlers: Map<string, Array<(event: any, ctx: ExtensionContext) => any>>;
  branch: BranchEntry[];
  sentMessages: RecordedMessage[];
  sentUserMessages: RecordedUserMessage[];
  notifications: Array<{ message: string; level?: string }>;
  selectCalls: Array<{ title: string; choices: string[] }>;
  confirmCalls: Array<{ title: string; body: string }>;
  widgetHistory: Array<{ key: string; value: unknown }>;
  statusHistory: Array<{ key: string; text: string | undefined }>;
  workingMessageHistory: Array<string | undefined>;
  titleHistory: string[];
  terminalInputHandlers: Set<(data: string) => unknown>;
  setModelCalls: Array<{ provider: string; id: string }>;
  thinkingLevelCalls: ThinkingLevel[];
  messageRenderers: Map<string, MessageRenderer<any>>;
  shortcuts: Map<
    string,
    { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
  >;
  sessionNameCalls: string[];
  getSessionName: () => string | undefined;
  setIdle: (idle: boolean) => void;
  setPendingMessages: (hasPending: boolean) => void;
  setSessionMessages: (messages: AgentMessage[]) => void;
  setSelectHandler: (
    fn: (title: string, choices: string[]) => string | undefined,
  ) => void;
  setConfirmHandler: (fn: (title: string, body: string) => boolean) => void;
  setInputHandler: (
    fn: (title: string, placeholder?: string) => string | undefined,
  ) => void;
  emit: (eventName: string, event: any) => Promise<any[]>;
  runCommand: (name: string, args?: string) => Promise<void>;
  executeTool: (name: string, params: any, signal?: AbortSignal) => Promise<any>;
}

function createMockPiHarness(
  cwd: string,
  options?: {
    sessionId?: string;
    mode?: "tui" | "rpc";
    initialHostModel?: Model<Api>;
    modelRuntime?: ModelRuntime;
    initialSessionMessages?: AgentMessage[];
    initialSessionName?: string;
    omitNativeWorkingUi?: boolean;
  },
): MockHarness {
  const sessionId = options?.sessionId ?? "sess-e2e-1";
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const commands = new Map<
    string,
    {
      description?: string;
      getArgumentCompletions?: (prefix: string) => unknown;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }
  >();
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const branch: BranchEntry[] = [];
  const sentMessages: RecordedMessage[] = [];
  const sentUserMessages: RecordedUserMessage[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const selectCalls: Array<{ title: string; choices: string[] }> = [];
  const confirmCalls: Array<{ title: string; body: string }> = [];
  const widgetHistory: Array<{ key: string; value: unknown }> = [];
  const statusHistory: Array<{ key: string; text: string | undefined }> = [];
  const workingMessageHistory: Array<string | undefined> = [];
  const titleHistory: string[] = [];
  const terminalInputHandlers = new Set<(data: string) => unknown>();
  const setModelCalls: Array<{ provider: string; id: string }> = [];
  const thinkingLevelCalls: ThinkingLevel[] = [];
  const messageRenderers = new Map<string, MessageRenderer<any>>();
  const shortcuts = new Map<
    string,
    { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
  >();
  const sessionNameCalls: string[] = [];

  let activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  let idle = true;
  let hasPending = false;
  let entrySeq = 0;
  let currentHostModel: Model<Api> | undefined =
    options?.initialHostModel ?? DEFAULT_TEST_MODELS[1];
  let currentThinkingLevel: ThinkingLevel = "medium";
  let currentSessionName: string | undefined = options?.initialSessionName;
  let sessionMessages: AgentMessage[] = [...(options?.initialSessionMessages ?? [])];

  const modelRuntime = options?.modelRuntime ?? createMockModelRuntime();

  let selectHandler: (title: string, choices: string[]) => string | undefined = (
    _title,
    choices,
  ) => choices[0];
  let confirmHandler: (title: string, body: string) => boolean = () => true;
  let inputHandler: (title: string, placeholder?: string) => string | undefined = (
    _title,
    placeholder,
  ) => placeholder ?? "";

  const pi = {
    on(event: string, handler: (ev: any, ctx: ExtensionContext) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event);
        if (!current) return;
        const idx = current.indexOf(handler);
        if (idx >= 0) current.splice(idx, 1);
      };
    },
    registerTool(tool: ToolDefinition<any, any, any>) {
      tools.set(tool.name, tool);
      if (tool.defaultActive !== false && !activeTools.includes(tool.name)) {
        activeTools.push(tool.name);
      }
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    registerShortcut(
      shortcut: string,
      def: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void },
    ) {
      shortcuts.set(shortcut, def);
    },
    registerMessageRenderer(customType: string, renderer: MessageRenderer<any>) {
      messageRenderers.set(customType, renderer);
    },
    setSessionName(name: string) {
      currentSessionName = name;
      sessionNameCalls.push(name);
    },
    getSessionName() {
      return currentSessionName;
    },
    appendEntry(customType: string, data?: unknown) {
      const prev = branch[branch.length - 1];
      branch.push({
        id: `e-${++entrySeq}`,
        parentId: prev?.id ?? null,
        type: "custom",
        customType,
        data,
      });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next: string[]) {
      activeTools = [...next];
    },
    async setModel(model: Model<Api>) {
      setModelCalls.push({ provider: model.provider, id: model.id });
      currentHostModel = model;
      return true;
    },
    getThinkingLevel() {
      return currentThinkingLevel;
    },
    setThinkingLevel(level: ThinkingLevel) {
      currentThinkingLevel = level;
      thinkingLevelCalls.push(level);
    },
    sendMessage(message: any, opts?: any) {
      sentMessages.push({ message, options: opts });
    },
    sendUserMessage(content: any, opts?: any) {
      sentUserMessages.push({ content, options: opts });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    mode: options?.mode ?? "tui",
    hasUI: true,
    get model() {
      return currentHostModel;
    },
    modelRegistry: {
      runtime: modelRuntime,
    },
    isIdle: () => idle,
    hasPendingMessages: () => hasPending,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [...branch],
      getEntries: () => [...branch],
      getCwd: () => cwd,
      buildSessionContext: () => ({
        messages: [...sessionMessages],
        thinkingLevel: currentThinkingLevel,
        model: currentHostModel
          ? { provider: currentHostModel.provider, modelId: currentHostModel.id }
          : null,
      }),
    },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      async select(title: string, choices: string[]) {
        selectCalls.push({ title, choices: [...choices] });
        return selectHandler(title, choices);
      },
      async confirm(title: string, body: string) {
        confirmCalls.push({ title, body });
        return confirmHandler(title, body);
      },
      async input(title: string, placeholder?: string) {
        return inputHandler(title, placeholder);
      },
      setWidget(key: string, value: unknown) {
        widgetHistory.push({ key, value });
      },
      setStatus(key: string, text: string | undefined) {
        statusHistory.push({ key, text });
      },
      ...(options?.omitNativeWorkingUi
        ? {}
        : {
            setWorkingMessage(message?: string) {
              workingMessageHistory.push(message);
            },
            setTitle(title: string) {
              titleHistory.push(title);
            },
          }),
      onTerminalInput(fn: (data: string) => unknown) {
        terminalInputHandlers.add(fn);
        return () => {
          terminalInputHandlers.delete(fn);
        };
      },
    },
  } as unknown as ExtensionCommandContext;

  async function emit(eventName: string, event: any): Promise<any[]> {
    const list = handlers.get(eventName) ?? [];
    const results: any[] = [];
    for (const fn of list) {
      results.push(await fn(event, ctx));
    }
    return results;
  }

  async function runCommand(name: string, args = ""): Promise<void> {
    const cmd = commands.get(name);
    if (!cmd) {
      throw new Error(`Command "/${name}" is not registered`);
    }
    await cmd.handler(args, ctx);
  }

  async function executeTool(
    name: string,
    params: any,
    signal?: AbortSignal,
  ): Promise<any> {
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" is not registered`);
    }
    const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
    return tool.execute(`tc-${Date.now()}`, prepared, signal, undefined, ctx as any);
  }

  return {
    pi,
    ctx,
    tools,
    commands,
    handlers,
    branch,
    sentMessages,
    sentUserMessages,
    notifications,
    selectCalls,
    confirmCalls,
    widgetHistory,
    statusHistory,
    workingMessageHistory,
    titleHistory,
    terminalInputHandlers,
    setModelCalls,
    thinkingLevelCalls,
    messageRenderers,
    shortcuts,
    sessionNameCalls,
    getSessionName: () => currentSessionName,
    setIdle: (val) => {
      idle = val;
    },
    setPendingMessages: (val) => {
      hasPending = val;
    },
    setSessionMessages: (msgs) => {
      sessionMessages = [...msgs];
    },
    setSelectHandler: (fn) => {
      selectHandler = fn;
    },
    setConfirmHandler: (fn) => {
      confirmHandler = fn;
    },
    setInputHandler: (fn) => {
      inputHandler = fn;
    },
    emit,
    runCommand,
    executeTool,
  };
}

// ============================================================================
// Integration Test Suite (Dynamic Antigravity Swarm v0.2.0)
// ============================================================================

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("pi-swarm v0.2.0 cross-module E2E integration", () => {
  it("1. runs full Dynamic Antigravity Swarm E2E (Q&A -> Plan -> Phase 1 Research + swarm_wait -> Phase 2 share worktree Author + Read-Only Validator warm fix-loop -> Merge/Kill/Done + zero-turn views & disk verification)", async () => {
    const repoDir = await createTempGitRepo("full-dynamic");
    tempDirs.push(repoDir);

    const ORCH_MODEL = "anthropic/claude-opus-4-6";
    const WORKER_MODEL = "anthropic/claude-sonnet-4-5";
    const VALIDATOR_MODEL = "openai/gpt-5.2";

    const testSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      orchestratorModel: ORCH_MODEL,
      orchestratorThinkingLevel: "high",
      workerModel: WORKER_MODEL,
      workerThinkingLevel: "medium",
      validatorModel: VALIDATOR_MODEL,
      validatorThinkingLevel: "high",
      maxConcurrency: 4,
      validatorEnabled: true,
      keepWorkersWarm: true,
      stallWatchdogEnabled: false,
      autoRebase: true,
    };

    const trackers = new Map<string, MockMemberTracker[]>();
    let releaseResearcher!: () => void;
    const researcherGate = new Promise<void>((resolve) => {
      releaseResearcher = resolve;
    });
    let authorWorktreePath = "";
    let validatorAuditCount = 0;

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async ({ pushAssistantMessage }) => {
            if (request.name === "researcher") {
              await researcherGate;
              assert.equal(request.workspace, "inherit");
              assert.equal(request.modelOverride, WORKER_MODEL);
              assert.equal(request.thinkingLevel, "medium");
              pushAssistantMessage("Inspected src/index.ts; contract is compute(x) = x * 2.");
              await request.engineApi!.postMessage({
                text: "@orchestrator [done] Contract verified: src/compute.ts must export compute(x) = x * 2.",
                kind: "done",
              });
              return {
                agentId: request.agentId,
                name: request.name,
                role: request.role,
                outcome: "waiting",
                summary: "Research done",
                tokens: 500,
                cost: 0.005,
              };
            }

            if (request.name === "author") {
              assert.equal(request.workspace, "share");
              assert.ok(request.branch?.startsWith("swarm/"));
              assert.notEqual(request.cwd, repoDir);
              authorWorktreePath = request.cwd;

              // Commit buggy implementation (`x * 3`) so independent validator catches it!
              const targetFile = path.join(request.cwd, "src", "compute.ts");
              await mkdir(path.dirname(targetFile), { recursive: true });
              await writeFile(
                targetFile,
                "export function compute(x: number): number {\n  return x * 3;\n}\n",
                "utf8",
              );
              await git(request.cwd, ["add", "src/compute.ts"]);
              await git(request.cwd, ["commit", "-m", "feat: initial compute implementation"]);

              pushAssistantMessage("Committed initial src/compute.ts in isolated share worktree.");
              await request.engineApi!.postMessage({
                text: "@validator [done] Implemented src/compute.ts in share worktree — ready for independent audit.",
                kind: "done",
              });
              return {
                agentId: request.agentId,
                name: request.name,
                role: request.role,
                outcome: "waiting",
                summary: "Waiting for validator feedback",
                tokens: 900,
                cost: 0.009,
              };
            }

            if (request.name === "validator") {
              assert.equal(request.role, "validator");
              assert.equal(request.modelOverride, VALIDATOR_MODEL);
              assert.equal(request.thinkingLevel, "high");
              pushAssistantMessage("Validator ready and standing by for author handoff.");
              return {
                agentId: request.agentId,
                name: request.name,
                role: request.role,
                outcome: "waiting",
                summary: "Standing by for @author handoff",
                tokens: 200,
                cost: 0.002,
              };
            }

            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: "Done",
              tokens: 100,
              cost: 0.001,
            };
          },
          runWakeTurn: async (prompt, { wakeIndex, pushAssistantMessage }) => {
            if (request.name === "validator") {
              validatorAuditCount += 1;
              const code = await readFile(
                path.join(authorWorktreePath, "src", "compute.ts"),
                "utf8",
              );
              if (code.includes("x * 3")) {
                pushAssistantMessage("Found bug: compute returns x * 3 instead of x * 2.");
                await request.engineApi!.postMessage({
                  text: "@author Fix edge case in src/compute.ts: return x * 2 instead of x * 3.",
                  kind: "review",
                });
                return {
                  agentId: request.agentId,
                  name: request.name,
                  role: request.role,
                  outcome: "waiting",
                  summary: "Requested fix from @author",
                  tokens: 400,
                  cost: 0.004,
                };
              }
              assert.ok(code.includes("x * 2"), "Validator should observe author's committed fix");
              pushAssistantMessage("Verified compute(x) = x * 2 cleanly.");
              await request.engineApi!.postMessage({
                text: "@orchestrator [done] approved — compute(x) = x * 2 verified cleanly!",
                kind: "done",
              });
              return {
                agentId: request.agentId,
                name: request.name,
                role: request.role,
                outcome: "waiting",
                summary: "Approved",
                tokens: 450,
                cost: 0.0045,
              };
            }

            if (request.name === "author") {
              assert.equal(wakeIndex, 1, "Exact same warm author handle should wake for fix");
              assert.match(prompt, /x \* 2/);
              const targetFile = path.join(request.cwd, "src", "compute.ts");
              await writeFile(
                targetFile,
                "export function compute(x: number): number {\n  return x * 2;\n}\n",
                "utf8",
              );
              await git(request.cwd, ["add", "src/compute.ts"]);
              await git(request.cwd, ["commit", "-m", "fix: compute returns x * 2"]);
              pushAssistantMessage("Committed fix compute(x) = x * 2.");
              await request.engineApi!.postMessage({
                text: "@validator [done] Fixed compute(x) = x * 2 and committed cleanly.",
                kind: "done",
              });
              return {
                agentId: request.agentId,
                name: request.name,
                role: request.role,
                outcome: "waiting",
                summary: "Fix committed",
                tokens: 1300,
                cost: 0.013,
              };
            }

            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: "Wake completed",
              tokens: 200,
              cost: 0.002,
            };
          },
        });

        const list = trackers.get(request.name) ?? [];
        list.push(tracker);
        trackers.set(request.name, list);
        return tracker.handle;
      },
      async listAvailableModels() {
        return DEFAULT_TEST_MODELS.map((m) => ({
          id: m.id,
          provider: m.provider,
          fullId: `${m.provider}/${m.id}`,
          name: m.name,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
        }));
      },
    };

    const mockUI: IQuestionnaireUI = {
      async askQuestion() {
        return { cancelled: false, answer: "TypeScript ESM", isCustom: false };
      },
      async askQuestionnaire(_ctx, questions) {
        const answers: Record<string, string> = {};
        const items = questions.map((q) => {
          const ans = q.recommended ?? q.options[0]?.label ?? "Yes";
          answers[q.id] = ans;
          return { id: q.id, question: q.question, answer: ans, isCustom: false };
        });
        return { cancelled: false, answers, items };
      },
      async confirmProposal(_ctx, plan) {
        return {
          action: "confirm",
          validatorEnabled: plan.validatorEnabled,
          maxConcurrency: plan.maxConcurrency,
        };
      },
    };

    const harness = createMockPiHarness(repoDir, { mode: "tui" });
    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({
        ...testSettings,
        fallbackModels: [...testSettings.fallbackModels],
      }),
      questionnaireUI: mockUI,
    });
    ext(harness.pi);

    // Zero factory side effects before session_start
    assert.deepEqual(Array.from(harness.commands.keys()).sort(), [
      "swarm",
      "swarm-direct",
    ]);
    assert.equal(harness.tools.size, 7);
    assert.deepEqual(
      Array.from(harness.tools.keys()).sort(),
      [...ALL_SWARM_EXTENSION_TOOLS].sort(),
    );
    assert.equal(harness.widgetHistory.length, 0);
    assert.equal(harness.statusHistory.length, 0);

    await harness.emit("session_start", {});
    assert.ok(harness.widgetHistory.some((w) => w.key === SWARM_WIDGET_KEY));
    assert.ok(harness.statusHistory.some((s) => s.key === SWARM_STATUS_KEY));

    // 1. `/swarm "Build feature"` applies orchestratorModel & enters drafting (3 tools)
    await harness.runCommand("swarm", "Build compute feature");
    assert.ok(
      harness.setModelCalls.some(
        (c) => `${c.provider}/${c.id}` === ORCH_MODEL,
      ),
      "orchestratorModel must be applied via pi.setModel",
    );
    assert.ok(harness.thinkingLevelCalls.includes("high"));

    const draftingActiveTools = harness.pi.getActiveTools();
    for (const t of DRAFTING_TOOLS) {
      assert.ok(draftingActiveTools.includes(t), `Expected drafting tool ${t}`);
    }
    for (const t of SWARM_CORE_TOOLS) {
      assert.ok(!draftingActiveTools.includes(t), `Core tool ${t} should be inactive in drafting`);
    }

    // Prompt-cache-safe drafting tail injection
    const draftStartEv = { systemPromptOptions: { sections: {} as Record<string, string> } };
    const draftRes = await harness.emit("before_agent_start", draftStartEv);
    assert.equal(draftRes[0], undefined);
    assert.match(draftStartEv.systemPromptOptions.sections.swarm ?? "", /swarm_drafting_active/);

    // 2. Upfront Q&A + Plan Confirmation -> swaps to 4 core tools
    const qRes = await harness.executeTool(SWARM_QUESTIONNAIRE_TOOL, {
      questions: [
        {
          id: "api",
          question: "Export signature?",
          options: [{ label: "compute(x)" }],
          recommended: "compute(x)",
        },
      ],
    });
    assert.equal(qRes.isError, undefined);

    const planRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Compute Feature",
      objective: "Add compute(x) = x * 2 module",
      strategy: "Phase 1 researcher -> Phase 2 isolated share author + independent validator",
      acceptance_criteria: "src/compute.ts exports compute(x) = x * 2 merged onto main",
      base_branch: "main",
      max_concurrency: 4,
      validator_enabled: true,
    });
    assert.equal(planRes.isError, undefined);
    assert.equal(planRes.details.outcome, "confirmed");
    const runId: string = planRes.details.runId;
    assert.ok(runId);

    // Core 4 tools active, drafting tools inactive
    const runningTools = harness.pi.getActiveTools();
    for (const t of SWARM_CORE_TOOLS) {
      assert.ok(runningTools.includes(t), `Expected core tool ${t}`);
    }
    for (const t of DRAFTING_TOOLS) {
      assert.ok(!runningTools.includes(t), `Drafting tool ${t} should be inactive while running`);
    }

    // Focus entry persisted (version: 2)
    const focusEntry = harness.branch.find((e) => e.customType === SWARM_FOCUS_ENTRY);
    assert.ok(focusEntry);
    assert.deepEqual((focusEntry.data as any).version, 2);
    assert.equal((focusEntry.data as any).runId, runId);

    // Prompt-cache-safe orchestrator playbook injection
    const runStartEv = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await harness.emit("before_agent_start", runStartEv);
    assert.match(
      runStartEv.systemPromptOptions.sections.swarm ?? "",
      /Pi Swarm Orchestrator Playbook/,
    );

    // Settled-boundary kickoff message dispatched cleanly once
    await waitFor(() =>
      harness.sentMessages.some(
        (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE && (m.message.details as any)?.kickoff,
      ),
    );
    const kickoffWakeups = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    );
    assert.equal(kickoffWakeups.length, 1);
    assert.equal(kickoffWakeups[0]!.options?.triggerTurn, true);
    assert.equal(kickoffWakeups[0]!.options?.deliverAs, "followUp");

    // 3. Phase 1: spawn researcher -> call NON-BLOCKING swarm_wait (terminate: true, parked: true) -> release researcher -> async wakeup arrives cleanly!
    const addResearcherRes = await harness.executeTool(SWARM_TOOL, {
      action: "add",
      name: "researcher",
      role: "worker",
      workspace: "inherit",
      brief: "Inspect src/index.ts and report compute(x) contract.",
    });
    assert.equal(addResearcherRes.isError, undefined);

    const wakeupsBeforeWait = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;

    const waitRes = await harness.executeTool(SWARM_WAIT_TOOL, {
      since: 1,
      mentions_only: true,
    });
    assert.equal(waitRes.isError, undefined);
    assert.equal((waitRes as { terminate?: boolean }).terminate, true);
    assert.equal(waitRes.details.parked, true);

    releaseResearcher();

    // Wait for researcher to post @orchestrator and emit wakeup turn!
    await waitFor(
      () =>
        harness.sentMessages.filter(
          (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
        ).length > wakeupsBeforeWait,
    );
    const researcherWakeup = harness.sentMessages
      .filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE)
      .pop()!;
    assert.match(String(researcherWakeup.message.content), /compute\(x\) = x \* 2/);

    // 4. Phase 2: spawn independent validator + share-worktree author -> peer-to-peer warm fix loop!
    const addValidatorRes = await harness.executeTool(SWARM_TOOL, {
      action: "add",
      name: "validator",
      role: "validator",
      workspace: "inherit",
      brief: "Audit author's src/compute.ts implementation and verify compute(x) = x * 2.",
    });
    assert.equal(addValidatorRes.isError, undefined);

    // Wait for validator to park in waiting before author hands off to @validator
    await waitFor(() => trackers.get("validator")?.[0]?.handle.getState() === "waiting");

    const addAuthorRes = await harness.executeTool(SWARM_TOOL, {
      action: "add",
      name: "author",
      role: "worker",
      workspace: "share",
      brief: "Implement src/compute.ts per #2 and post @validator [done] when ready.",
    });
    assert.equal(addAuthorRes.isError, undefined);

    // Wait for full peer-to-peer bounce: author(bug) -> validator(review) -> author(warm wake #1 fix) -> validator(approved -> @orchestrator)
    await waitFor(async () => {
      const board = await harness.executeTool(READ_BOARD_TOOL, { since: 0, limit: 50 });
      return String(board.content[0].text).includes("approved");
    });

    // Verify exact SAME warm author handle was woken (not respawned!)
    const authorTrackers = trackers.get("author") ?? [];
    assert.equal(authorTrackers.length, 1, "Author must stay warm with 1 single handle spawn");
    assert.equal(authorTrackers[0]!.wakeCount, 1, "Warm author handle must be woken exactly once");
    assert.equal(validatorAuditCount, 2, "Validator should audit twice (reject then approve)");
    await waitFor(() => authorTrackers[0]!.handle.getState() === "waiting");
    await waitFor(() => trackers.get("validator")?.[0]?.handle.getState() === "waiting");

    // 5. Verify zero-turn commands (`/swarm status`, `/swarm board`, `/swarm graph`, `/swarm models`)
    const zeroTurnStartCount = harness.sentMessages.length;
    await harness.runCommand("swarm", "status");
    await harness.runCommand("swarm", "board");
    await harness.runCommand("swarm", "graph");
    await harness.runCommand("swarm", "models");

    const zeroTurnSlice = harness.sentMessages.slice(zeroTurnStartCount);
    const statusMsgs = zeroTurnSlice.filter(
      (m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE,
    );
    assert.equal(statusMsgs.length, 4);
    for (const msg of statusMsgs) {
      assert.equal(msg.options?.triggerTurn, false, "All 4 views must be zero-LLM-turn");
    }
    assert.match(String(statusMsgs[0]!.message.content), /Compute Feature/);
    assert.match(String(statusMsgs[1]!.message.content), /Swarm Board/);
    assert.match(String(statusMsgs[2]!.message.content), /Swarm Graph/);
    assert.match(String(statusMsgs[2]!.message.content), /author ⇄ validator/);
    assert.match(String(statusMsgs[3]!.message.content), /Swarm 3-Role Models/);
    assert.match(String(statusMsgs[3]!.message.content), /claude-opus-4-6/);
    assert.match(String(statusMsgs[3]!.message.content), /gpt-5\.2/);

    // 6. Merge author's share worktree into main (real git merge --no-ff), kill members, complete run!
    const mergeRes = await harness.executeTool(SWARM_TOOL, {
      action: "merge",
      name: "author",
    });
    assert.equal(mergeRes.isError, undefined, `Merge failed: ${JSON.stringify(mergeRes)}`);
    assert.equal(mergeRes.details.strategy, "merge");

    // Verify committed fix landed on `main`!
    const mainCompute = await readFile(path.join(repoDir, "src", "compute.ts"), "utf8");
    assert.match(mainCompute, /return x \* 2;/);

    // Kill all 3 members -> worktree for author cleanly removed
    for (const name of ["researcher", "author", "validator"]) {
      const killRes = await harness.executeTool(SWARM_TOOL, {
        action: "kill",
        name,
        reason: "Integrated cleanly",
      });
      assert.equal(killRes.isError, undefined);
    }
    assert.equal(await pathExists(authorWorktreePath), false, "Killed share worktree should be removed");

    // Complete run via swarm{action:"done"} -> restores "idle" tool profile & emits ZERO extra wakeup turns!
    const wakeupsBeforeDone = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    harness.setIdle(false);
    const doneRes = await harness.executeTool(SWARM_TOOL, {
      action: "done",
      summary: "Delivered compute(x) = x * 2 verified by independent validator.",
    });
    assert.equal(doneRes.isError, undefined);
    assert.equal(doneRes.details.status, "completed");

    // Flush microtasks + simulate agent_settled after Orchestrator's final reply: 0 extra LLM turns!
    harness.setIdle(true);
    await new Promise((r) => setTimeout(r, 30));
    await harness.emit("agent_settled", { aborted: false });
    await new Promise((r) => setTimeout(r, 30));
    const wakeupsAfterDone = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    assert.equal(
      wakeupsAfterDone,
      wakeupsBeforeDone,
      'swarm{action:"done"} must emit 0 SWARM_WAKEUP_CUSTOM_TYPE follow-up turns',
    );

    const idleTools = harness.pi.getActiveTools();
    assert.ok(idleTools.includes(IDLE_SWARM_TOOLS[0]));
    assert.ok(!idleTools.includes(POST_MESSAGE_TOOL));
    assert.ok(!idleTools.includes(READ_BOARD_TOOL));
    assert.ok(!idleTools.includes(SWARM_WAIT_TOOL));

    // 7. Verify disk artifacts (`board.jsonl`, `ROSTER.md`, `state.json`, `events.jsonl` zero duplicates, clean git status)
    const runDir = path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, runId);
    const boardRaw = await readFile(path.join(runDir, SWARM_BOARD_FILE), "utf8");
    assert.match(boardRaw, /\[done\] Delivered compute\(x\)/);
    assert.match(boardRaw, /approved/);

    const rosterMd = await readFile(path.join(runDir, SWARM_ROSTER_FILE), "utf8");
    assert.match(rosterMd, /researcher/);
    assert.match(rosterMd, /author/);
    assert.match(rosterMd, /validator/);

    const stateJson = JSON.parse(
      await readFile(path.join(runDir, SWARM_STATE_FILE), "utf8"),
    ) as SwarmRunState;
    assert.equal(stateJson.version, 2);
    assert.equal(stateJson.status, "completed");

    const eventsRaw = await readFile(path.join(runDir, SWARM_EVENTS_FILE), "utf8");
    const events = eventsRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SwarmEvent);
    const runCreatedEvents = events.filter((e) => e.type === "run_created");
    const runCompletedEvents = events.filter((e) => e.type === "run_completed");
    const authorAddedEvents = events.filter(
      (e) => e.type === "member_added" && e.memberName === "author",
    );
    const authorMergedEvents = events.filter(
      (e) => e.type === "member_merged" && e.memberName === "author",
    );
    const authorKilledEvents = events.filter(
      (e) => e.type === "member_killed" && e.memberName === "author",
    );
    assert.equal(runCreatedEvents.length, 1, "Zero duplicate run_created events");
    assert.equal(runCompletedEvents.length, 1, "Zero duplicate run_completed events");
    assert.equal(authorAddedEvents.length, 1, "Zero duplicate member_added events");
    assert.equal(authorMergedEvents.length, 1, "Zero duplicate member_merged events");
    assert.equal(authorKilledEvents.length, 1, "Zero duplicate member_killed events");

    const gitStatus = await git(repoDir, ["status", "--porcelain"]);
    assert.equal(gitStatus, "", ".pi/swarm/ must be excluded so git status stays clean");

    await harness.emit("session_shutdown", {});
  });

  it("2. supports True Conversation fork (orchestrator & member), Sharded tasks[], Channels (@#area), and Hot Model Switching (/swarm model & swarm{action:'model'})", async () => {
    const repoDir = await createTempGitRepo("fork-channels-models");
    tempDirs.push(repoDir);

    const spawnedByName = new Map<string, MockMemberTracker>();

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async ({ pushAssistantMessage }) => {
            pushAssistantMessage(`Initial turn by ${request.name} completed.`);
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: `${request.name} ready`,
              tokens: 300,
              cost: 0.003,
            };
          },
          runWakeTurn: async (prompt, { pushAssistantMessage }) => {
            pushAssistantMessage(`Woken by: ${prompt.slice(0, 60)}`);
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: `${request.name} handled wake`,
              tokens: 500,
              cost: 0.005,
            };
          },
        });
        spawnedByName.set(request.name, tracker);
        return tracker.handle;
      },
      async listAvailableModels() {
        return DEFAULT_TEST_MODELS.map((m) => ({
          id: m.id,
          provider: m.provider,
          fullId: `${m.provider}/${m.id}`,
          name: m.name,
        }));
      },
    };

    // Host session history including a dangling unresolved toolCall that fork sanitization must strip!
    const hostMessages: AgentMessage[] = [
      makeUserMsg("Design a modular backend API."),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Spawning architect now." },
          { type: "toolCall", id: "dangling-tc-1", name: "swarm", arguments: { action: "add" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      } as unknown as AgentMessage,
    ];

    const harness = createMockPiHarness(repoDir, {
      initialSessionMessages: hostMessages,
    });
    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      // Use real project settings persistence on repoDir!
    });
    ext(harness.pi);
    await harness.emit("session_start", {});

    // Launch via /swarm direct
    await harness.runCommand("swarm", "direct Build backend endpoints");
    const planRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Backend API Swarm",
      objective: "Build modular auth and billing endpoints",
      strategy: "Fork architect -> channel #backend -> sharded workers -> hot model switch",
      acceptance_criteria: "All endpoints tested and verified",
      base_branch: "main",
      max_concurrency: 6,
      validator_enabled: true,
    });
    assert.equal(planRes.isError, undefined);
    assert.equal(planRes.details.autoConfirmed, true);

    // A. True conversation fork from "orchestrator" (with dangling toolCall stripped!)
    const addArchRes = await harness.executeTool(SWARM_TOOL, {
      action: "add",
      name: "architect",
      role: "worker",
      workspace: "inherit",
      fork: "orchestrator",
      brief: "Draft API spec based on our host session discussion.",
    });
    assert.equal(addArchRes.isError, undefined);
    await waitFor(() => spawnedByName.get("architect")?.handle.getState() === "waiting");

    const archTracker = spawnedByName.get("architect")!;
    assert.ok(archTracker.seedMessages && archTracker.seedMessages.length === 2);
    const secondSeed = archTracker.seedMessages![1] as any;
    assert.equal(
      secondSeed.content.some((p: any) => p.type === "toolCall"),
      false,
      "Dangling unresolved toolCall must be stripped from orchestrator fork seed",
    );

    // B. True conversation fork from a warm member ("architect" -> "verifier")
    const addVerRes = await harness.executeTool(SWARM_TOOL, {
      action: "add",
      name: "verifier",
      role: "validator",
      workspace: "inherit",
      fork: "architect",
      brief: "Audit API spec derived from architect's conversation.",
    });
    assert.equal(addVerRes.isError, undefined);
    await waitFor(() => spawnedByName.get("verifier")?.handle.getState() === "waiting");

    const verTracker = spawnedByName.get("verifier")!;
    assert.ok(
      verTracker.seedMessages!.some((m: any) =>
        JSON.stringify(m.content).includes("Initial turn by architect completed"),
      ),
      "Forking from warm member must seed that member's conversation messages",
    );

    // C. Channels + Sharded `tasks[]` + `@#backend` wakeup + rejecting `@#main`
    const chRes = await harness.executeTool(SWARM_TOOL, {
      action: "channel",
      op: "create",
      channel: "backend",
      topic: "Backend endpoints",
    });
    assert.equal(chRes.isError, undefined);

    const shardRes = await harness.executeTool(SWARM_TOOL, {
      action: "add",
      name: "api",
      role: "worker",
      workspace: "inherit",
      channels: ["backend"],
      tasks: ["auth endpoint", "billing endpoint"],
      brief: "Implement assigned endpoint slice",
    });
    assert.equal(shardRes.isError, undefined);
    assert.equal(shardRes.details.members.length, 2);

    await waitFor(
      () =>
        spawnedByName.get("api-1")?.handle.getState() === "waiting" &&
        spawnedByName.get("api-2")?.handle.getState() === "waiting",
    );

    // Broadcast to @#backend wakes BOTH api-1 and api-2 (NOT architect)
    const chPost = await harness.executeTool(POST_MESSAGE_TOOL, {
      channel: "backend",
      text: "@#backend Align on shared error envelope schema.",
    });
    assert.equal(chPost.isError, undefined);

    await waitFor(
      () =>
        (spawnedByName.get("api-1")?.wakeCount ?? 0) === 1 &&
        (spawnedByName.get("api-2")?.wakeCount ?? 0) === 1,
    );
    await waitFor(
      () =>
        spawnedByName.get("api-1")?.handle.getState() === "waiting" &&
        spawnedByName.get("api-2")?.handle.getState() === "waiting",
    );
    assert.equal(spawnedByName.get("architect")?.wakeCount, 0);

    // `@#main` mention must be rejected cleanly
    const badMainPost = await harness.executeTool(POST_MESSAGE_TOOL, {
      text: "@#main should be rejected",
    });
    assert.equal(badMainPost.isError, true);
    assert.match(badMainPost.content[0].text, /INVALID_CHANNEL/);

    // Verify `/swarm board --channel backend --search envelope` zero-turn filter
    const beforeBoardIdx = harness.sentMessages.length;
    await harness.runCommand("swarm", "board 10 --channel backend --search envelope");
    const boardView = harness.sentMessages[beforeBoardIdx]!;
    assert.equal(boardView.options?.triggerTurn, false);
    assert.match(String(boardView.message.content), /\[#backend\]/);
    assert.match(String(boardView.message.content), /error envelope schema/);

    // D. Hot Model Switch & Role Propagation via `/swarm model` & `swarm{action:"model"}`
    // 1) Set role default persisted to project `.pi/pi-swarm-settings.json` (also silently switches role-tracking waiting workers!)
    const api1Tracker = spawnedByName.get("api-1")!;
    const msgCountBeforeSwitch = api1Tracker.conversationMessages.length;
    await harness.runCommand("swarm", "model worker google/gemini-2.5-pro high");
    const projSettingsPath = path.join(repoDir, ".pi", SWARM_SETTINGS_FILE);
    const saved1 = JSON.parse(await readFile(projSettingsPath, "utf8"));
    assert.equal(saved1.workerModel, "google/gemini-2.5-pro");
    assert.equal(saved1.workerThinkingLevel, "high");
    assert.equal(api1Tracker.modelSwitches.length, 1);
    assert.deepEqual(api1Tracker.modelSwitches[0], {
      model: "google/gemini-2.5-pro",
      thinkingLevel: "high",
    });

    // 2) Clear role default with `default` -> writes explicit `null` in project JSON and leaves running agents untouched!
    await harness.runCommand("swarm", "model worker default");
    const saved2 = JSON.parse(await readFile(projSettingsPath, "utf8"));
    assert.equal(saved2.workerModel, null, "Clearing role default must persist null in project settings");
    assert.equal(api1Tracker.modelSwitches.length, 1, "Inherit clear must apply only to new agents");

    // 3) Hot-switch live waiting member via `/swarm model api-1 openai/gpt-5.2 high`
    await harness.runCommand("swarm", "model api-1 openai/gpt-5.2 high");
    assert.equal(api1Tracker.modelSwitches.length, 2);
    assert.deepEqual(api1Tracker.modelSwitches[1], {
      model: "openai/gpt-5.2",
      thinkingLevel: "high",
    });
    assert.equal(
      api1Tracker.conversationMessages.length,
      msgCountBeforeSwitch,
      "Hot model switch must preserve full conversation history",
    );

    // 4) Orchestrator self-switch via `swarm{action:"model"}` (omitted name -> orchestrator!)
    const orchSwitchRes = await harness.executeTool(SWARM_TOOL, {
      action: "model",
      model: "anthropic/claude-opus-4-6",
      thinking_level: "high",
      reason: "Complex synthesis phase",
    });
    assert.equal(orchSwitchRes.isError, undefined);
    assert.ok(
      harness.setModelCalls.some(
        (c) => c.provider === "anthropic" && c.id === "claude-opus-4-6",
      ),
      "swarm{action:'model'} targeting orchestrator must call pi.setModel()",
    );
    assert.equal(harness.ctx.model?.id, "claude-opus-4-6");
    const savedAfterOrch = JSON.parse(await readFile(projSettingsPath, "utf8"));
    assert.equal(
      savedAfterOrch.orchestratorModel,
      undefined,
      "swarm{action:'model'} on orchestrator must stay run-scoped without overwriting project settings",
    );

    // Complete cleanly via `/swarm done` -> zero-turn (0 SWARM_WAKEUP_CUSTOM_TYPE messages!)
    const wakeupsBeforeSlashDone = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    await harness.runCommand("swarm", "done Backend API shipped");
    assert.ok(!harness.pi.getActiveTools().includes(POST_MESSAGE_TOOL));
    assert.ok(harness.pi.getActiveTools().includes(SWARM_TOOL));

    await new Promise((r) => setTimeout(r, 30));
    await harness.emit("agent_settled", { aborted: false });
    await new Promise((r) => setTimeout(r, 30));
    const wakeupsAfterSlashDone = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    assert.equal(
      wakeupsAfterSlashDone,
      wakeupsBeforeSlashDone,
      "/swarm done must stay zero-turn (0 SWARM_WAKEUP_CUSTOM_TYPE messages)",
    );

    await harness.emit("session_shutdown", {});
  });

  it("3. covers /swarm-direct, /swarm pause/resume, Stall Watchdog [stall] wakeup, /swarm settings, /swarm cancel, completions, and clean session_shutdown disposal", async () => {
    const repoDir = await createTempGitRepo("lifecycle-stall");
    tempDirs.push(repoDir);

    // Verify all 19 SWARM_SUBCOMMANDS & parser routing
    const expectedSubcommands = [
      "direct",
      "tweak",
      "status",
      "board",
      "graph",
      "tasks",
      "ui",
      "models",
      "model",
      "steer",
      "merge",
      "kill",
      "done",
      "pause",
      "resume",
      "cancel",
      "teardown",
      "runs",
      "focus",
      "settings",
      "help",
    ];
    assert.deepEqual(
      SWARM_SUBCOMMANDS.map((c) => c.name),
      expectedSubcommands,
    );
    assert.deepEqual(parseSwarmCommand("graph"), { kind: "graph", rest: "" });
    assert.deepEqual(parseSwarmCommand("ui members"), { kind: "ui", rest: "members" });
    assert.deepEqual(parseSwarmCommand("merge author"), { kind: "merge", rest: "author" });
    assert.deepEqual(parseSwarmCommand("done All verified"), {
      kind: "done",
      rest: "All verified",
    });
    assert.deepEqual(parseSwarmCommand("status of parser module"), {
      kind: "goal",
      rest: "status of parser module",
    });

    let mutableSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      stallWatchdogEnabled: true,
      stallMonitorMode: "deterministic",
      stallTimeoutMs: 60,
      keepWorkersWarm: true,
    };

    const spawned: MockMemberTracker[] = [];
    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async ({ pushAssistantMessage }) => {
            pushAssistantMessage(`${request.name} finished quietly without pinging orchestrator.`);
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: "Parked silently",
              tokens: 120,
              cost: 0.001,
            };
          },
        });
        spawned.push(tracker);
        return tracker.handle;
      },
    };

    let confirmModalCalled = false;
    const guardUI: IQuestionnaireUI = {
      async askQuestion() {
        return { cancelled: false, answer: "ok", isCustom: false };
      },
      async askQuestionnaire() {
        return { cancelled: false, answers: {}, items: [] };
      },
      async confirmProposal() {
        confirmModalCalled = true;
        return { action: "confirm", validatorEnabled: true, maxConcurrency: 6 };
      },
    };

    const harness = createMockPiHarness(repoDir, { mode: "tui" });
    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({
        ...mutableSettings,
        fallbackModels: [...mutableSettings.fallbackModels],
      }),
      settingsSaver: async (_scope, patch) => {
        mutableSettings = { ...mutableSettings, ...patch };
        return { ...mutableSettings, fallbackModels: [...mutableSettings.fallbackModels] };
      },
      questionnaireUI: guardUI,
    });
    ext(harness.pi);
    await harness.emit("session_start", {});

    // Verify exact registered commands (`["swarm", "swarm-direct"]`) and 7 tools
    assert.deepEqual(Array.from(harness.commands.keys()).sort(), [
      "swarm",
      "swarm-direct",
    ]);
    assert.equal(harness.tools.size, 7);

    // Completions include all 19 subcommands
    const swarmCmd = harness.commands.get("swarm")!;
    const allCompletions = (await swarmCmd.getArgumentCompletions?.("")) as Array<{
      label: string;
    }>;
    assert.equal(allCompletions.length, expectedSubcommands.length);

    // A. `/swarm-direct` with initial_members spawns immediately without modal!
    await harness.runCommand("swarm-direct", "Quick audit of repo layout");
    assert.equal(harness.sentUserMessages.length, 1);
    assert.match(String(harness.sentUserMessages[0]!.content), /swarm_direct_plan/);

    // Hold idle=false during proposal confirm so we also verify settled-boundary kickoff on agent_settled!
    harness.setIdle(false);
    const planRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Quick Audit",
      objective: "Audit repository files quickly",
      strategy: "Single initial scout then synthesize",
      acceptance_criteria: "Summary delivered",
      base_branch: "main",
      initial_members: [
        {
          name: "scout",
          role: "worker",
          workspace: "inherit",
          brief: "Inspect project files and stand by.",
        },
      ],
    });
    assert.equal(planRes.isError, undefined);
    assert.equal(confirmModalCalled, false, "/swarm-direct must autoConfirm without modal");
    await waitFor(() => spawned.length === 1);
    assert.equal(spawned.length, 1, "initial_members must spawn immediately on confirmation");
    assert.equal(spawned[0]!.name, "scout");

    // While busy (idle=false), no wakeup should fire yet
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      0,
    );

    // Transition to idle and emit `agent_settled` -> single kickoff wakeup fires!
    harness.setIdle(true);
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      1,
    );

    // Clear idle flag until after scout completes its post-wakeup test in real timing:
    // Here scout immediately parks cleanly, so monitor fires at 60ms.
    // Wait for Zero-Token Deterministic Stall Watchdog `[stall]` alert + coalesced wakeup!
    // `scout` parked silently in `waiting` and no `swarm_wait` is active -> watchdog fires after 60ms!
    await waitFor(() =>
      harness.sentMessages.some(
        (m) =>
          m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE &&
          (m.message.details as any)?.stallDetected === true,
      ),
    );
    const stallWakeups = harness.sentMessages.filter(
      (m) =>
        m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE &&
        (m.message.details as any)?.stallDetected === true,
    );
    assert.equal(
      stallWakeups.length,
      1,
      "Stall watchdog stall_detected + wakeup_needed must coalesce into 1 wakeup message",
    );
    assert.match(String(stallWakeups[0]!.message.content), /Stall Alert|stalled/i);

    // Verify `[stall]` message was posted by `monitor` on the board
    const boardAfterStall = await harness.executeTool(READ_BOARD_TOOL, { since: 0, limit: 20 });
    assert.match(String(boardAfterStall.content[0].text), /\[stall\]/);

    // C. `/swarm pause` purges stale queued wakeups (0 ghost wakeup turns), then `/swarm resume`
    const wakeupsBeforePause = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    harness.setIdle(false);
    await spawned[0]!.request.engineApi!.postMessage({
      text: "@orchestrator queued update right before pause",
      kind: "update",
    });
    await harness.runCommand("swarm", "pause taking a short break");
    harness.setIdle(true);
    await new Promise((r) => setTimeout(r, 30));
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      wakeupsBeforePause,
      "/swarm pause must purge stale queued wakeups",
    );
    const statusPaused = await harness.executeTool(SWARM_TOOL, { action: "status" });
    assert.match(String(statusPaused.content[0].text), /status=paused/);

    await harness.runCommand("swarm", "resume");
    const statusActive = await harness.executeTool(SWARM_TOOL, { action: "status" });
    assert.match(String(statusActive.content[0].text), /status=active/);

    // D. `/swarm settings` interactive toggle
    let settingsStep = 0;
    harness.setSelectHandler((_title, choices) => {
      settingsStep += 1;
      if (settingsStep === 1) {
        return choices.find((c) => c.startsWith("stallWatchdogEnabled:"));
      }
      return "Done";
    });
    await harness.runCommand("swarm", "settings");
    assert.equal(mutableSettings.stallWatchdogEnabled, false);

    // E. `/swarm runs`, `/swarm focus none` (purges queued wakeups), `/swarm focus <id>`, `/swarm help`
    await harness.runCommand("swarm", "runs");
    await harness.runCommand("swarm", "help");
    const wakeupsBeforeUnfocus = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    harness.setIdle(false);
    await spawned[0]!.request.engineApi!.postMessage({
      text: "@orchestrator queued update right before focus none",
      kind: "update",
    });
    await harness.runCommand("swarm", "focus none");
    harness.setIdle(true);
    await new Promise((r) => setTimeout(r, 30));
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      wakeupsBeforeUnfocus,
      "/swarm focus none must purge stale queued wakeups",
    );
    assert.ok(!harness.pi.getActiveTools().includes(POST_MESSAGE_TOOL));

    const runId: string = planRes.details.runId;
    await harness.runCommand("swarm", `focus ${runId}`);
    assert.ok(harness.pi.getActiveTools().includes(POST_MESSAGE_TOOL));

    // F. `/swarm cancel` on focused run -> purges queued wakeups, stops/kills members, marks abandoned, restores idle tools
    const wakeupsBeforeCancel = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    harness.setIdle(false);
    await spawned[0]!.request.engineApi!.postMessage({
      text: "@orchestrator queued update right before cancel",
      kind: "update",
    });
    harness.setConfirmHandler(() => true);
    await harness.runCommand("swarm", "cancel");
    harness.setIdle(true);
    await new Promise((r) => setTimeout(r, 30));
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      wakeupsBeforeCancel,
      "/swarm cancel must purge stale queued wakeups",
    );
    assert.ok(!harness.pi.getActiveTools().includes(POST_MESSAGE_TOOL));
    assert.equal(spawned[0]!.killed, true);

    // G. Clean idempotent `session_shutdown` disposal
    assert.equal(harness.terminalInputHandlers.size, 0);
    await harness.emit("session_shutdown", {});
    await harness.emit("session_shutdown", {}); // idempotent second call
    assert.equal(harness.terminalInputHandlers.size, 0);
    assert.equal(harness.widgetHistory[harness.widgetHistory.length - 1]?.value, undefined);
    assert.equal(harness.statusHistory[harness.statusHistory.length - 1]?.text, undefined);
  });

  it("4. supports non-blocking swarm_wait + live mid-flight human redirection (input hook, swarm{action:'steer'}, swarm{action:'stop'}, /swarm steer) and surgical Smart Monitor", async () => {
    const repoDir = await createTempGitRepo("e2e-steer");
    tempDirs.push(repoDir);

    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => {
      releaseWorker = r;
    });
    const workerSteers: string[] = [];
    const trackers: MockMemberTracker[] = [];
    let workerTurnCounter = 0;

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => {
            if (request.name === "worker") {
              workerTurnCounter += 1;
              await workerGate;
              await request.engineApi!.postMessage({
                text: `@orchestrator [done] Adapted direction (steers=${workerSteers.length}): ${workerSteers.join(" | ")}`,
                kind: "done",
              });
              return {
                agentId: request.agentId,
                name: request.name,
                role: request.role,
                outcome: "waiting",
                summary: "Completed redirected work",
                tokens: 200,
                cost: 0.002,
              };
            }
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: "Ready",
              tokens: 50,
              cost: 0.001,
            };
          },
        });
        const origSteer = tracker.handle.steer;
        tracker.handle.steer = async (msg: string) => {
          if (request.name === "worker") {
            workerSteers.push(msg);
          }
          await origSteer(msg);
        };
        trackers.push(tracker);
        return tracker.handle;
      },
    };

    const harness = createMockPiHarness(repoDir, { mode: "tui" });
    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    });
    ext(harness.pi);
    await harness.emit("session_start", {});

    // 1. Launch Swarm directly
    await harness.runCommand("swarm-direct", "Build API v1");
    await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "API Launch",
      objective: "Build API v1",
      strategy: "Single worker then validate",
      acceptance_criteria: "Tests green",
      base_branch: "main",
      initial_members: [
        {
          name: "worker",
          role: "worker",
          workspace: "inherit",
          brief: "Implement API v1",
        },
      ],
    });
    await waitFor(async () => {
      if (trackers.length < 1 || workerTurnCounter !== 1) return false;
      const statusRes = await harness.executeTool(SWARM_TOOL, { action: "status" });
      const members =
        (statusRes.details?.members as
          | Array<{ name: string; state: string; currentActivity?: string }>
          | undefined) ?? [];
      return members.some(
        (m) =>
          m.name === "worker" &&
          m.state === "working" &&
          m.currentActivity === "working on assignment",
      );
    });

    // 2. Orchestrator parks non-blockingly via swarm_wait -> returns terminate: true immediately!
    const headBeforeWait = Number(
      (await harness.executeTool(READ_BOARD_TOOL, { since: 0 })).details?.head ?? 1,
    );
    const parkRes = await harness.executeTool(SWARM_WAIT_TOOL, {
      since: headBeforeWait,
      mentions_only: true,
    });
    assert.equal(parkRes.isError, undefined);
    assert.equal((parkRes as { terminate?: boolean }).terminate, true);
    assert.equal(parkRes.details?.parked, true);

    // 3. Human sends interactive / RPC redirection while Orchestrator is idle!
    // Source "extension" must be ignored, while "interactive" and "rpc" both capture direction cleanly.
    await harness.emit("input", {
      source: "extension",
      text: "Internal extension echo must not set direction",
    });
    const inputRes = await harness.emit("input", {
      source: "rpc",
      text: "Change direction: switch API to v2 with streaming support",
    });
    assert.equal((inputRes as Array<{ action?: string }>)?.[0]?.action, "continue");

    // Background custom wakeup `before_agent_start` must NOT consume `latestHumanDirection`
    const customWakeupSections: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      messageType: "custom",
      systemPromptOptions: { sections: customWakeupSections },
    });
    assert.ok(!(customWakeupSections.swarm_state ?? "").includes("Live User Direction Update"));
    const staticSectionBefore = customWakeupSections.swarm ?? "";
    assert.match(staticSectionBefore, /Pi Swarm Orchestrator Playbook/);

    // User `before_agent_start` injects live user direction highlight into `sections.swarm_state` once,
    // while `sections.swarm` stays identical/static across wakeups for prompt caching.
    const sectionsObj: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      messageType: "user",
      prompt: "Change direction: switch API to v2 with streaming support",
      systemPromptOptions: { sections: sectionsObj },
    });
    assert.equal(sectionsObj.swarm, staticSectionBefore);
    assert.match(sectionsObj.swarm_state ?? "", /Live User Direction Update/);
    assert.match(sectionsObj.swarm_state ?? "", /switch API to v2/);

    // Subsequent turn does not repeat stale humanSteeringText notice, and static section stays unchanged
    const sectionsObj2: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      messageType: "user",
      prompt: "Continue",
      systemPromptOptions: { sections: sectionsObj2 },
    });
    assert.equal(sectionsObj2.swarm, staticSectionBefore);
    assert.ok(!(sectionsObj2.swarm_state ?? "").includes("Live User Direction Update"));

    // 4. Orchestrator updates objective + steers working worker directly + `/swarm steer` slash command
    const updTitle = await harness.executeTool(SWARM_TOOL, {
      action: "title",
      objective: "Build API v2 with streaming support",
    });
    assert.equal(updTitle.isError, undefined);

    const steerRes = await harness.executeTool(SWARM_TOOL, {
      action: "steer",
      name: "worker",
      message: "Switch endpoint contract to v2 streaming",
    });
    assert.equal(steerRes.isError, undefined);
    assert.equal(steerRes.details?.delivery, "steered");

    await harness.runCommand("swarm", "steer worker Also add healthcheck route");
    assert.deepEqual(workerSteers, [
      "Switch endpoint contract to v2 streaming",
      "Also add healthcheck route",
    ]);

    // 5. Release worker -> posts @orchestrator [done] -> Orchestrator receives wakeup turn cleanly!
    const wakeupsBeforeDone = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    releaseWorker();
    await waitFor(
      () =>
        harness.sentMessages.filter(
          (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
        ).length > wakeupsBeforeDone,
    );
    const finalWakeup = harness.sentMessages
      .filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE)
      .pop()!;
    assert.match(String(finalWakeup.message.content), /Adapted direction \(steers=2\)/);

    // 6. Stop parked worker via swarm{action:"stop"} & finish cleanly
    const stopRes = await harness.executeTool(SWARM_TOOL, {
      action: "stop",
      name: "worker",
      reason: "Paused after handoff",
    });
    assert.equal(stopRes.isError, undefined);
    assert.equal(stopRes.details?.stopped, true);

    // Verify `/swarm pause` -> `/swarm resume` clears unconsumed `latestHumanDirection` so stale direction doesn't leak
    await harness.emit("input", {
      source: "interactive",
      text: "Stale direction sent right before pause",
    });
    await harness.runCommand("swarm", "pause");
    await harness.runCommand("swarm", "resume");
    const sectionsAfterPause: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      messageType: "user",
      prompt: "After resume",
      systemPromptOptions: { sections: sectionsAfterPause },
    });
    assert.ok(
      !(sectionsAfterPause.swarm_state ?? "").includes("Stale direction sent right before pause"),
      "latestHumanDirection must be cleared on /swarm pause",
    );

    await harness.executeTool(SWARM_TOOL, { action: "done", summary: "API v2 shipped" });
    await harness.emit("session_shutdown", {});
  });

  it("5. keeps tool profile & focus consistent on partial/full initial_members launch failure in propose_swarm_plan", async () => {
    const repoDir = await createTempGitRepo("initial-members-resilience");
    tempDirs.push(repoDir);

    const spawnFailures = new Set<string>(["broken"]);
    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: `${request.name} ready`,
            tokens: 100,
            cost: 0.001,
          }),
        });
        return tracker.handle;
      },
    };

    const wtMgr = new WorktreeManager(repoDir);
    const origCreateWt = wtMgr.createWorktree.bind(wtMgr);
    wtMgr.createWorktree = async (opts) => {
      for (const bad of spawnFailures) {
        if (opts.branch.includes(`/${bad}`)) {
          throw new SwarmProtocolError("GIT_ERROR", `Simulated failure creating worktree for ${bad}`);
        }
      }
      return origCreateWt(opts);
    };

    const harness = createMockPiHarness(repoDir, { mode: "tui" });
    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      worktreeFactory: () => wtMgr,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    });
    ext(harness.pi);
    await harness.emit("session_start", {});

    // Case A: SOLE initial_member fails -> full rollback, draft preserved, zero dangling focus entry!
    await harness.runCommand("swarm-direct", "Run where sole initial member fails");
    const failAllRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Fail All Initial",
      objective: "Verify rollback when all initial_members fail",
      strategy: "Single share worker",
      acceptance_criteria: "Clean rollback",
      base_branch: "main",
      initial_members: [
        { name: "broken", role: "worker", workspace: "share", brief: "Will fail" },
      ],
    });
    assert.equal(failAllRes.isError, true);
    assert.equal(
      harness.branch.some((e) => e.customType === SWARM_FOCUS_ENTRY),
      false,
      "Full initial_members failure must NOT leave a dangling focus entry",
    );
    assert.equal(
      harness.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL),
      true,
      "Drafting tools must remain active when all initial_members fail",
    );

    // Case B: Partial success (worker ok, broken fails) -> transitions cleanly to `running` tools and warns in kickoff!
    const partialRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Partial Initial",
      objective: "Survive partial initial_members failure",
      strategy: "One succeeds, one fails",
      acceptance_criteria: "Running tools unlocked + failure surfaced in kickoff",
      base_branch: "main",
      initial_members: [
        { name: "healthy", role: "worker", workspace: "inherit", brief: "Do useful work" },
        { name: "broken", role: "worker", workspace: "share", brief: "Fail worktree provisioning" },
      ],
    });
    assert.equal(partialRes.isError, undefined);
    const activeTools = harness.pi.getActiveTools();
    assert.ok(activeTools.includes(SWARM_TOOL));
    assert.ok(activeTools.includes(POST_MESSAGE_TOOL));
    assert.ok(!activeTools.includes(PROPOSE_SWARM_PLAN_TOOL));

    await waitFor(() =>
      harness.sentMessages.some((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE),
    );
    const kickoff = harness.sentMessages
      .filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE)
      .pop()!;
    assert.match(String(kickoff.message.content), /healthy/);
    assert.match(String(kickoff.message.content), /@broken.*Simulated failure/);

    await harness.executeTool(SWARM_TOOL, { action: "done", summary: "Recovered cleanly" });
    await harness.emit("session_shutdown", {});
  });

  it("6. /swarm teardown --force rejects foreign session ownership BEFORE stopping working members", async () => {
    const repoDir = await createTempGitRepo("teardown-force-owner");
    tempDirs.push(repoDir);

    let stopCount = 0;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => {
      releaseWorker = r;
    });

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => {
            await workerGate;
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: "Done",
              tokens: 10,
              cost: 0.0001,
            };
          },
          onAbort: () => {
            stopCount += 1;
          },
        });
        return tracker.handle;
      },
    };

    const ownerHarness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "owner-sess-1",
    });
    const extOwner = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    });
    extOwner(ownerHarness.pi);
    await ownerHarness.emit("session_start", {});

    await ownerHarness.runCommand("swarm-direct", "Long running work");
    await ownerHarness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Force Teardown Guard",
      objective: "Ensure foreign /swarm teardown --force cannot stop owner's workers",
      strategy: "Single worker",
      acceptance_criteria: "Ownership checked before stop",
      base_branch: "main",
      initial_members: [
        { name: "worker", role: "worker", workspace: "inherit", brief: "Keep running" },
      ],
    });

    await waitFor(async () => {
      const statusRes = await ownerHarness.executeTool(SWARM_TOOL, { action: "status" });
      const members =
        (statusRes.details?.members as Array<{ name: string; currentActivity?: string }> | undefined) ??
        [];
      return members.some((m) => m.name === "worker" && m.currentActivity === "working on assignment");
    });

    // Foreign live session attempts `/swarm teardown --force`
    const foreignHarness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "foreign-sess-2",
    });
    const extForeign = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    });
    extForeign(foreignHarness.pi);
    await foreignHarness.emit("session_start", {});
    const statusOwner = await ownerHarness.executeTool(SWARM_TOOL, { action: "status" });
    const runId = String(statusOwner.details?.runId ?? "");
    await foreignHarness.runCommand("swarm", `focus ${runId}`);
    await foreignHarness.runCommand("swarm", "teardown --force");

    assert.equal(stopCount, 0, "Foreign /swarm teardown --force must NOT stop owner's active workers");
    assert.ok(
      foreignHarness.notifications.some(
        (n) => n.level === "error" && /Teardown failed:.*owned by active session/i.test(n.message),
      ),
    );

    releaseWorker();
    await ownerHarness.executeTool(SWARM_TOOL, { action: "done", summary: "Owner completed cleanly" });
    await foreignHarness.emit("session_shutdown", {});
    await ownerHarness.emit("session_shutdown", {});
  });

  it("7. enforces ownership across /fork /resume /shutdown, rejects unknown teardown flags & terminal run actions, syncs gitTimeoutMs, and sanitizes /swarm runs", async () => {
    const repoDir = await createTempGitRepo("v036-ownership-terminal");
    tempDirs.push(repoDir);

    let workerGateResolve!: () => void;
    const workerGate = new Promise<void>((r) => {
      workerGateResolve = r;
    });

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => {
            await workerGate;
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: "Finished",
              tokens: 5,
              cost: 0.0001,
            };
          },
        });
        return tracker.handle;
      },
    };

    const gitTimeoutsSeen: number[] = [];
    const wtMgr: IWorktreeManager = new WorktreeManager(repoDir);
    wtMgr.setGitTimeoutMs = (ms: number) => {
      gitTimeoutsSeen.push(ms);
    };

    let currentSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      stallWatchdogEnabled: false,
      gitTimeoutMs: 42_000,
    };

    const ownerHarness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "owner-v036",
    });
    const extOwner = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      worktreeFactory: () => wtMgr,
      settingsLoader: async () => currentSettings,
      settingsSaver: async (_scope, patch) => {
        currentSettings = { ...currentSettings, ...patch };
        return currentSettings;
      },
    });
    extOwner(ownerHarness.pi);
    await ownerHarness.emit("session_start", { reason: "startup" });
    assert.ok(gitTimeoutsSeen.includes(42_000), "reloadSettings must sync gitTimeoutMs");

    // Launch run with validatorEnabled: false and special chars in title for /swarm runs sanitization
    await ownerHarness.runCommand("swarm-direct", "Run with validator off");
    await ownerHarness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Pipe | Title \x1b[31mRed\x1b[0m\nLine2",
      objective: "Verify v0.3.6 ownership & terminal guards",
      strategy: "Single worker",
      acceptance_criteria: "All guards hold",
      base_branch: "main",
      validator_enabled: false,
      initial_members: [
        { name: "worker", role: "worker", workspace: "inherit", brief: "Work" },
      ],
    });
    await waitFor(() =>
      ownerHarness.sentMessages.some((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE),
    );
    const kickoffMsg = ownerHarness.sentMessages
      .filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE)
      .pop()!;
    assert.ok(
      !String(kickoffMsg.message.content).includes("validate independently"),
      "Kickoff must omit validator prompt when validatorEnabled=false",
    );

    const statusRes = await ownerHarness.executeTool(SWARM_TOOL, { action: "status" });
    const runId = String(statusRes.details?.runId ?? "");
    assert.ok(runId);

    // Foreign session tries destructive commands + unknown teardown flag
    const foreignHarness = createMockPiHarness(repoDir, {
      mode: "rpc",
      sessionId: "foreign-v036",
    });
    const extForeign = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    });
    extForeign(foreignHarness.pi);
    await foreignHarness.emit("session_start", { reason: "startup" });
    await foreignHarness.runCommand("swarm", `focus ${runId}`);

    await foreignHarness.runCommand("swarm", "teardown --bogus");
    assert.ok(
      foreignHarness.notifications.some((n) =>
        /Usage: \/swarm teardown \[--force\] \[--delete-branches\]/.test(n.message),
      ),
    );

    for (const cmd of [
      "pause",
      "resume",
      "done summary",
      "cancel",
      "kill worker",
      "merge worker",
      "teardown",
    ]) {
      const notifBefore = foreignHarness.notifications.length;
      await foreignHarness.runCommand("swarm", cmd);
      const newNotifs = foreignHarness.notifications.slice(notifBefore);
      assert.ok(
        newNotifs.some((n) => n.level === "error" && /OWNERSHIP_CONFLICT|owned by active session/i.test(n.message)),
        `Foreign /swarm ${cmd} must fail with OWNERSHIP_CONFLICT`,
      );
    }

    // Reload shutdown keeps ownerPid = process.pid; quit shutdown sets ownerPid = 0
    const store = new SwarmStore(repoDir);
    await ownerHarness.emit("session_shutdown", { reason: "reload" });
    assert.equal((await store.loadRun(runId)).ownerPid, process.pid);

    await ownerHarness.emit("session_start", { reason: "reload" });
    await ownerHarness.emit("session_shutdown", { reason: "quit" });
    assert.equal((await store.loadRun(runId)).ownerPid, 0);

    // Resuming in a new session claims ownership cleanly because ownerPid === 0
    const resumedHarness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "resumed-v036",
    });
    resumedHarness.branch.push(...ownerHarness.branch);
    const extResumed = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => currentSettings,
    });
    extResumed(resumedHarness.pi);
    await resumedHarness.emit("session_start", { reason: "resume" });
    const afterResume = await store.loadRun(runId);
    assert.equal(afterResume.ownerSessionId, "resumed-v036");
    assert.equal(afterResume.ownerPid, process.pid);

    // Forking in-process claims ownership cleanly without self-lockout
    const forkedHarness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "forked-v036",
    });
    forkedHarness.branch.push(...resumedHarness.branch);
    const extForked = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => currentSettings,
    });
    extForked(forkedHarness.pi);
    await forkedHarness.emit("session_start", { reason: "fork" });
    const afterFork = await store.loadRun(runId);
    assert.equal(afterFork.ownerSessionId, "forked-v036");
    assert.equal(afterFork.ownerPid, process.pid);

    // Verify /swarm runs sanitizes pipe and ANSI escapes in table
    await forkedHarness.runCommand("swarm", "runs");
    const runsMsg = forkedHarness.sentMessages
      .filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
      .pop()!;
    assert.ok(!String(runsMsg.message.content).includes("\x1b[31m"));
    assert.match(String(runsMsg.message.content), /Pipe \\\| Title Red Line2/);

    // Verify headless /swarm settings surfaces gitTimeoutMs & rateLimit* bounds
    const headlessHarness = createMockPiHarness(repoDir, {
      mode: "rpc",
      sessionId: "headless-v036",
    });
    (headlessHarness.ctx as { hasUI: boolean }).hasUI = false;
    const extHeadless = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => currentSettings,
    });
    extHeadless(headlessHarness.pi);
    await headlessHarness.emit("session_start", { reason: "startup" });
    await headlessHarness.runCommand("swarm", "settings");
    const settingsMsg = headlessHarness.sentMessages
      .filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
      .pop()!;
    assert.match(String(settingsMsg.message.content), /gitTimeoutMs/);
    assert.match(String(settingsMsg.message.content), /rateLimitBaseBackoffMs/);
    assert.match(String(settingsMsg.message.content), /rateLimitMaxBackoffMs/);

    // Complete run & verify terminal run guards + bare menu hiding pause/resume/done
    workerGateResolve();
    await forkedHarness.runCommand("swarm", "done All finished");
    assert.equal((await store.loadRun(runId)).status, "completed");

    for (const cmd of ["pause", "resume", "done extra", "cancel"]) {
      const before = forkedHarness.notifications.length;
      await forkedHarness.runCommand("swarm", cmd);
      const after = forkedHarness.notifications.slice(before);
      assert.ok(
        after.some((n) => /already completed/i.test(n.message)),
        `/swarm ${cmd} must reject terminal run cleanly`,
      );
    }

    let bareChoices: string[] = [];
    forkedHarness.setSelectHandler((_title, choices) => {
      bareChoices = choices;
      return undefined;
    });
    await forkedHarness.runCommand("swarm", "");
    assert.ok(!bareChoices.some((c) => c.startsWith("Pause") || c.startsWith("Resume")));
    assert.ok(!bareChoices.some((c) => c.startsWith("Complete Swarm")));

    await headlessHarness.emit("session_shutdown", { reason: "quit" });
    await foreignHarness.emit("session_shutdown", { reason: "quit" });
    await resumedHarness.emit("session_shutdown", { reason: "quit" });
    await forkedHarness.emit("session_shutdown", { reason: "quit" });
  });

  it("8. deduplicates read_board/swarm_wait wakeups, prevents double wakeupInFlight, handles session_compact & turn_start multi-tool batches, and respects userPromptPreflight", async () => {
    const repoDir = await createTempGitRepo("v036-wakeup-dedup");
    tempDirs.push(repoDir);

    let spawnedRequest: SpawnMemberRequest | undefined;
    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        spawnedRequest = request;
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: "Standing by",
            tokens: 5,
            cost: 0.0001,
          }),
        });
        return tracker.handle;
      },
    };

    const harness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "wakeup-sess-1",
    });
    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    });
    ext(harness.pi);
    await harness.emit("session_start", { reason: "startup" });

    // 1. Multi-tool batch [propose_swarm_plan, ...] -> activeRunSections updated + turn_start(turnIndex > 0) drops kickoff!
    await harness.runCommand("swarm-direct", "Multi-tool batch test");
    const draftSections: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      messageType: "user",
      prompt: "Plan",
      systemPromptOptions: { sections: draftSections },
    });
    assert.match(draftSections.swarm ?? "", /swarm_drafting_active/);

    harness.setIdle(false);
    const planRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Dedup Run",
      objective: "Verify wakeup dedup and multi-tool turn handling",
      strategy: "Single worker",
      acceptance_criteria: "No duplicate wakeups",
      base_branch: "main",
      initial_members: [
        { name: "worker", role: "worker", workspace: "inherit", brief: "Stand by" },
      ],
    });
    assert.equal(planRes.isError, undefined);
    assert.match(
      draftSections.swarm ?? "",
      /Pi Swarm Orchestrator Playbook/,
      "handlePlanConfirmed must update activeRunSections.swarm for multi-tool Turn 2",
    );

    // Simulate Turn 2 inside the same agent run -> drops pending kickoff wakeup
    await harness.emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
    harness.setIdle(true);
    await harness.emit("agent_settled", { aborted: false });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      0,
      "turn_start(turnIndex > 0) must drop queued kickoff wakeup",
    );

    // 2. read_board & parkOrchestratorWait deduplicate pending wakeups already read in-turn
    await waitFor(() => Boolean(spawnedRequest));
    harness.setIdle(false);
    await spawnedRequest!.engineApi!.postMessage({
      text: "@orchestrator report A",
      kind: "update",
    });
    await spawnedRequest!.engineApi!.postMessage({
      text: "@orchestrator report B",
      kind: "update",
    });
    await harness.executeTool(READ_BOARD_TOOL, { since: 1 });
    harness.setIdle(true);
    await harness.emit("agent_settled", { aborted: false });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      0,
      "read_board must prune already-read wakeup_needed items",
    );

    // Same for swarm_wait (parkOrchestratorWait) returning immediately with unread messages
    harness.setIdle(false);
    await spawnedRequest!.engineApi!.postMessage({
      text: "@orchestrator report C",
      kind: "update",
    });
    const waitRes = await harness.executeTool(SWARM_WAIT_TOOL, { since: 2 });
    assert.equal(waitRes.details?.parked, false);
    harness.setIdle(true);
    await harness.emit("agent_settled", { aborted: false });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      0,
      "parkOrchestratorWait must prune wakeups up to seenSeq",
    );

    // 3. wakeupInFlight prevents double-dispatch across overlapping agent_settled before before_agent_start
    harness.setIdle(false);
    await spawnedRequest!.engineApi!.postMessage({
      text: "@orchestrator first batch",
      kind: "update",
    });
    harness.setIdle(true);
    await harness.emit("agent_settled", { aborted: false });
    const sentCountAfterFirst = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    assert.equal(sentCountAfterFirst, 1);

    // Enqueue another message immediately while wakeupInFlight=true -> second agent_settled must NOT double-send!
    await spawnedRequest!.engineApi!.postMessage({
      text: "@orchestrator second batch during in-flight",
      kind: "update",
    });
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      1,
      "wakeupInFlight must prevent duplicate sendMessage before before_agent_start",
    );
    // Once before_agent_start + agent_settled complete, the queued wakeup flushes cleanly
    await harness.emit("before_agent_start", {
      messageType: "custom",
      systemPromptOptions: { sections: {} },
    });
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      2,
    );

    // 4. session_compact / session_compact_failed respect willRetry
    harness.setIdle(false);
    await spawnedRequest!.engineApi!.postMessage({
      text: "@orchestrator queued across compact",
      kind: "update",
    });
    harness.setIdle(true);
    await harness.emit("session_compact_failed", { willRetry: true, aborted: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      2,
      "willRetry: true must NOT flush wakeups",
    );
    await harness.emit("session_compact", { willRetry: false });
    await waitFor(
      () =>
        harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE)
          .length === 3,
    );

    // Wait for safety timer or clear via before_agent_start
    await harness.emit("before_agent_start", {
      messageType: "custom",
      systemPromptOptions: { sections: {} },
    });
    await harness.emit("agent_settled", { aborted: false });

    // 5. userPromptPreflight blocks flushPendingWakeups between idle `input` and `before_agent_start`
    harness.setIdle(false);
    await spawnedRequest!.engineApi!.postMessage({
      text: "@orchestrator arrives during preflight",
      kind: "update",
    });
    harness.setIdle(true);
    await harness.emit("input", {
      source: "interactive",
      text: "Hold on, let me redirect first",
    });
    await harness.emit("session_compact", { willRetry: false });
    await Promise.resolve();
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      3,
      "userPromptPreflight must prevent wakeup from racing ahead of idle user prompt",
    );
    await harness.emit("before_agent_start", {
      messageType: "user",
      prompt: "Hold on, let me redirect first",
      systemPromptOptions: { sections: {} },
    });
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      4,
    );

    await harness.executeTool(SWARM_TOOL, { action: "done", summary: "Dedup verified" });
    await harness.emit("session_shutdown", { reason: "quit" });
  });

  it("9. v0.3.7: preserves orchestratorWait across [add, swarm_wait] turn_start(1), protects unread wakeups on read_board{limit:5/0}, supports /swarm tweak in-place, claims dead-PID crash ownership, and guards foreign observers", async () => {
    const repoDir = await createTempGitRepo("v037-host-ui");
    tempDirs.push(repoDir);

    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => {
      releaseWorker = r;
    });
    const spawnedNames: string[] = [];

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        spawnedNames.push(request.name);
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => {
            if (request.name === "worker-batch") {
              await workerGate;
              await request.engineApi!.postMessage({
                text: "@orchestrator [done] batch worker finished after turn_start(1)",
                kind: "done",
              });
            }
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: `${request.name} ready`,
              tokens: 20,
              cost: 0.0002,
            };
          },
        });
        return tracker.handle;
      },
    };

    const harness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "owner-v037",
    });
    (harness.pi as unknown as { getCommands?: () => unknown[] }).getCommands = () => [
      { name: "swarm", source: "extension" },
      { name: "swarm-direct", source: "extension" },
      { name: "ext-helper", source: "extension" },
      { name: "skill:review", source: "skill" },
      { name: "plan-template", source: "prompt" },
    ];

    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: true,
        stallMonitorMode: "deterministic",
        stallTimeoutMs: 60,
      }),
      questionnaireUI: {
        async askQuestion() {
          return { cancelled: false, answer: "ok", isCustom: false };
        },
        async askQuestionnaire() {
          return { cancelled: false, answers: {}, items: [] };
        },
        async confirmProposal(_ctx, plan) {
          return {
            action: "confirm",
            validatorEnabled: plan.validatorEnabled,
            maxConcurrency: plan.maxConcurrency,
          };
        },
      },
    });
    ext(harness.pi);
    await harness.emit("session_start", { reason: "startup" });

    // Launch run via /swarm direct
    await harness.runCommand("swarm-direct", "Initial objective");
    const planRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "v0.3.7 Run",
      objective: "Initial objective",
      strategy: "Initial strategy",
      acceptance_criteria: "All tests pass",
      base_branch: "main",
    });
    assert.equal(planRes.isError, undefined);
    const runId: string = planRes.details.runId;

    // Wait for kickoff & settle
    await waitFor(() =>
      harness.sentMessages.some((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE),
    );
    await harness.emit("before_agent_start", {
      messageType: "custom",
      systemPromptOptions: { sections: {} },
    });

    // 1. Multi-tool batch [swarm{action:"add"}, swarm_wait] at turnIndex=0 -> turn_start(1) MUST preserve orchestratorWait!
    harness.setIdle(false);
    await harness.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    const addRes = await harness.executeTool(SWARM_TOOL, {
      action: "add",
      name: "worker-batch",
      role: "worker",
      workspace: "inherit",
      brief: "Complete batch task",
    });
    assert.equal(addRes.isError, undefined);

    const waitRes = await harness.executeTool(SWARM_WAIT_TOOL, {
      since: 0,
      mentions_only: true,
    });
    assert.equal(waitRes.details?.parked, true);

    // Immediate post-batch observation turn (turnIndex === waitArmedTurnIndex + 1)
    await harness.emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
    // Status-only read_board{status:true} must NOT disarm orchestratorWait either
    const statusBoardRes = await harness.executeTool(READ_BOARD_TOOL, { status: true });
    assert.equal(statusBoardRes.isError, undefined);

    harness.setIdle(true);
    await harness.emit("agent_settled", { aborted: false });

    // Wait > stallTimeoutMs (60ms) while worker-batch is working + wait is armed -> zero stall alert!
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(
      harness.sentMessages.filter(
        (m) =>
          m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE &&
          (m.message.details as any)?.stallDetected === true,
      ).length,
      0,
      "Stall watchdog must NOT fire while orchestratorWait remains armed across turn_start(1)",
    );

    // Release worker-batch -> wakes orchestrator cleanly
    const wakeupsBeforeBatchDone = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    releaseWorker();
    await waitFor(
      () =>
        harness.sentMessages.filter(
          (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
        ).length > wakeupsBeforeBatchDone,
    );
    await harness.emit("before_agent_start", {
      messageType: "custom",
      systemPromptOptions: { sections: {} },
    });

    // 2. Precise read_board{limit: 5} & read_board{limit: 0} wakeup deduplication
    harness.setIdle(false);
    const store = new SwarmStore(repoDir);
    const seqsPosted: number[] = [];
    for (let i = 1; i <= 7; i++) {
      const m = await store.postBoardMessage(runId, {
        from: "worker-batch",
        fromRole: "worker",
        text: `@orchestrator item ${i}`,
        kind: "update",
      });
      await harness.executeTool(SWARM_TOOL, { action: "status" }); // ensure engine doesn't error
      // Emit via worker bridge so pendingWakeups gets all 7 wakeups
      void m;
      seqsPosted.push(m.seq);
    }
    // Use post_message / bridge directly via a second worker so handleEngineEvent enqueues pendingWakeups
    const addHelperRes = await harness.executeTool(SWARM_TOOL, {
      action: "add",
      name: "helper-dup",
      role: "worker",
      workspace: "inherit",
      brief: "Post board items",
    });
    assert.equal(addHelperRes.isError, undefined);
    await waitFor(() => spawnedNames.includes("helper-dup"));

    // Reset wakeups count after helper-dup finishes, then post 7 messages through engine.postMessage
    // Note: in integration, toolEngineProxy.postMessage posts as orchestrator; let's post 7 via store+engine or steer/add:
    // Actually we can post 7 messages with @orchestrator via SWARM_TOOL? Let's spawn a tiny worker or check `pendingWakeups` via read_board:
    // Wait: `POST_MESSAGE_TOOL` uses orchestrator, which doesn't emit wakeup_needed for orchestrator itself.
    // Let's check: when `worker-batch` is waiting, we can wake it? Better yet, `POST_MESSAGE_TOOL` from a member or `swarm{action:"steer"}` — actually `createMockPersistentMemberHandle` gives `request.engineApi`!
    // Let's keep it simple: we already tested `read_board{since}` in Test #8; let's verify `read_board{limit: 5}` & `limit: 0` with a worker that posts 7 updates!
    assert.ok(seqsPosted.length === 7);

    // 3. `/skill:review` in `input` gets latestHumanDirection & preflight, while `/ext-helper` does not
    harness.setIdle(true);
    await harness.emit("input", { source: "interactive", text: "/ext-helper foo" });
    const extSec: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      messageType: "user",
      prompt: "/ext-helper foo",
      systemPromptOptions: { sections: extSec },
    });
    assert.ok(!(extSec.swarm_state ?? "").includes("Live User Direction Update"));

    await harness.emit("input", { source: "interactive", text: "/skill:review focus on security" });
    const skillSec: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      messageType: "user",
      prompt: "/skill:review focus on security",
      systemPromptOptions: { sections: skillSec },
    });
    assert.match(skillSec.swarm_state ?? "", /Live User Direction Update/);
    assert.match(skillSec.swarm_state ?? "", /\/skill:review focus on security/);

    // 4. `/swarm tweak` revises the active run in place without creating a second run
    await harness.runCommand("swarm", "tweak Add security validator");
    assert.equal(
      harness.sentUserMessages.some((m) => String(m.content).includes('mode="tweak"')),
      true,
    );
    assert.ok(harness.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL));

    const tweakSections: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      messageType: "user",
      prompt: "Tweak",
      systemPromptOptions: { sections: tweakSections },
    });
    assert.match(tweakSections.swarm ?? "", /swarm_drafting_active mode="tweak"/);
    assert.equal(tweakSections.swarm_state, undefined);

    const tweakRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "v0.3.7 Run Revised",
      objective: "Revised objective with security audit",
      strategy: "Revised dynamic strategy",
      acceptance_criteria: "All tests and security checks pass",
      base_branch: "main",
      max_concurrency: 5,
      validator_enabled: true,
      initial_members: [
        // Existing member should NOT be re-spawned; new validator should be spawned!
        { name: "worker-batch", role: "worker", workspace: "inherit", brief: "Existing" },
        { name: "sec-validator", role: "validator", workspace: "inherit", brief: "Audit security" },
      ],
    });
    assert.equal(tweakRes.isError, undefined);
    assert.equal(tweakRes.details.runId, runId, "/swarm tweak must revise same runId in place");
    assert.ok(spawnedNames.includes("sec-validator"));
    assert.equal(
      spawnedNames.filter((n) => n === "worker-batch").length,
      1,
      "Existing member must not be spawned twice during tweak",
    );
    const revisedRun = await store.loadRun(runId);
    assert.equal(revisedRun.title, "v0.3.7 Run Revised");
    assert.equal(revisedRun.maxConcurrency, 5);
    assert.match(tweakSections.swarm ?? "", /v0\.3\.7 Run Revised/);
    assert.match(tweakSections.swarm_state ?? "", /Active Swarm State/);

    const boardAfterTweak = await store.readBoard(runId, { channel: "*", limit: 20 });
    assert.ok(
      boardAfterTweak.messages.some(
        (m) => m.kind === "decision" && m.text.includes("Revised Swarm plan"),
      ),
    );

    // 5. Foreign live observer stays in "idle" tool profile & cannot mutate via /swarm steer / /swarm model / toolEngineProxy
    const foreignHarness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "foreign-observer-v037",
    });
    const extForeign = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    });
    extForeign(foreignHarness.pi);
    await foreignHarness.emit("session_start", { reason: "startup" });
    await foreignHarness.runCommand("swarm", `focus ${runId}`);

    assert.ok(
      !foreignHarness.pi.getActiveTools().includes(POST_MESSAGE_TOOL),
      "Foreign observer must stay in idle tool profile",
    );
    await foreignHarness.runCommand("swarm", "steer worker-batch hijack");
    assert.ok(
      foreignHarness.notifications.some(
        (n) => n.level === "error" && /OWNERSHIP_CONFLICT|owned by active session/i.test(n.message),
      ),
    );
    await foreignHarness.runCommand("swarm", "model worker-batch openai/gpt-5.2");
    assert.ok(
      foreignHarness.notifications.some(
        (n) => n.level === "error" && /Failed to switch model.*owned by active session/i.test(n.message),
      ),
    );
    const foreignToolRes = await foreignHarness.executeTool(SWARM_TOOL, {
      action: "steer",
      name: "worker-batch",
      message: "hijack via tool",
    });
    assert.equal(foreignToolRes.isError, true);
    assert.match(foreignToolRes.content[0].text, /OWNERSHIP_CONFLICT/);

    // Foreign observer CAN open overlay and browse read-only, while mutating actions fail cleanly
    let overlayChecked = false;
    (foreignHarness.ctx.ui as any).custom = async (factory: any) => {
      return new Promise((resolve) => {
        const comp = factory(
          {
            terminal: { rows: 30, columns: 100 },
            requestRender() {},
            getShowHardwareCursor: () => false,
            setShowHardwareCursor() {},
          },
          {
            fg: (_c: string, t: string) => t,
            bold: (t: string) => t,
          },
          {},
          resolve,
        );
        comp.focused = true;
        void (async () => {
          await new Promise((r) => setTimeout(r, 20));
          comp.handleInput?.("p");
          for (const ch of "unauthorized post") comp.handleInput?.(ch);
          comp.handleInput?.("\r");
          await new Promise((r) => setTimeout(r, 20));
          const rendered = comp.render(100).join("\n");
          assert.match(rendered, /owned by active session|OWNERSHIP_CONFLICT/i);
          overlayChecked = true;
          comp.handleInput?.("q");
        })();
      });
    };
    await foreignHarness.runCommand("swarm", "tasks");
    assert.equal(overlayChecked, true);
    await foreignHarness.emit("session_shutdown", { reason: "quit" });

    // 6. Dead-PID crash recovery claims ownership cleanly in rehydrateSessionState
    await store.updateRun(runId, {
      ownerSessionId: "crashed-sess-old",
      ownerPid: 999999,
    });
    const recoveredHarness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "recovered-v037",
    });
    recoveredHarness.branch.push(...harness.branch);
    const extRecovered = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    });
    extRecovered(recoveredHarness.pi);
    await recoveredHarness.emit("session_start", { reason: "resume" });
    const afterCrashRecover = await store.loadRun(runId);
    assert.equal(afterCrashRecover.ownerSessionId, "recovered-v037");
    assert.equal(afterCrashRecover.ownerPid, process.pid);
    assert.ok(recoveredHarness.pi.getActiveTools().includes(POST_MESSAGE_TOOL));

    await recoveredHarness.executeTool(SWARM_TOOL, {
      action: "done",
      summary: "v0.3.7 verified",
    });
    await recoveredHarness.emit("session_shutdown", { reason: "quit" });
    await harness.emit("session_shutdown", { reason: "quit" });
  });

  it("10. v0.3.7: read_board{limit: 5} and read_board{limit: 0} preserve earlier unread #seq wakeups", async () => {
    const repoDir = await createTempGitRepo("v037-readboard-limit");
    tempDirs.push(repoDir);

    let workerApi: SpawnMemberRequest["engineApi"] | undefined;
    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        workerApi = request.engineApi;
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: "Ready",
            tokens: 10,
            cost: 0.0001,
          }),
        });
        return tracker.handle;
      },
    };

    const harness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "limit-dedup-v037",
    });
    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    });
    ext(harness.pi);
    await harness.emit("session_start", { reason: "startup" });
    await harness.runCommand("swarm-direct", "Test read_board limit dedup");
    await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Limit Dedup",
      objective: "Preserve earlier unread wakeups",
      strategy: "Single worker",
      acceptance_criteria: "Earlier wakeups preserved",
      base_branch: "main",
      initial_members: [
        { name: "poster", role: "worker", workspace: "inherit", brief: "Stand by" },
      ],
    });
    await waitFor(() => Boolean(workerApi));
    await waitFor(() =>
      harness.sentMessages.some((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE),
    );
    await harness.emit("before_agent_start", {
      messageType: "custom",
      systemPromptOptions: { sections: {} },
    });

    // Post 7 @orchestrator updates while orchestrator is busy -> 7 pendingWakeups queued
    harness.setIdle(false);
    const postedSeqs: number[] = [];
    for (let i = 1; i <= 7; i++) {
      const m = await workerApi!.postMessage({
        text: `@orchestrator update #${i}`,
        kind: "update",
      });
      postedSeqs.push(m.seq);
    }

    // read_board{limit: 0} must NOT wipe any pending wakeups
    await harness.executeTool(READ_BOARD_TOOL, { limit: 0 });

    // read_board{limit: 5} returns ONLY the last 5 messages -> earlier 2 (#postedSeqs[0], #postedSeqs[1]) MUST survive!
    await harness.executeTool(READ_BOARD_TOOL, { limit: 5 });

    const wakeupsBeforeSettle = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    ).length;
    harness.setIdle(true);
    await harness.emit("agent_settled", { aborted: false });
    await new Promise((r) => setTimeout(r, 30));

    const wakeupsAfterSettle = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    );
    assert.equal(
      wakeupsAfterSettle.length,
      wakeupsBeforeSettle + 1,
      "Earlier unread #seqs must still trigger wakeup after read_board{limit:5}",
    );
    const lastWakeup = wakeupsAfterSettle[wakeupsAfterSettle.length - 1]!;
    const lastText = String(lastWakeup.message.content);
    assert.match(lastText, new RegExp(`\\[#${postedSeqs[0]}\\]`));
    assert.match(lastText, new RegExp(`\\[#${postedSeqs[1]}\\]`));
    assert.ok(!lastText.includes(`[#${postedSeqs[6]}]`), "Already-returned #seq must be pruned");
    assert.ok(!lastText.includes("update #7"), "Already-returned message body must be pruned");

    await harness.executeTool(SWARM_TOOL, { action: "done", summary: "Done" });
    await harness.emit("session_shutdown", { reason: "quit" });
  });

  it("11. v0.4.0: /swarm models role:thinking --global unmasks project shadow, propagates to live validator, and disambiguates @validator", async () => {
    const repoDir = await createTempGitRepo("v040-mission-models");
    tempDirs.push(repoDir);
    const isolatedGlobalPath = path.join(repoDir, ".tmp-global-pi-swarm-settings.json");
    const isolatedProjectPath = path.join(repoDir, ".pi", SWARM_SETTINGS_FILE);

    // Seed global + shadowing project override (`xhigh` Opus validator in project)
    await mkdir(path.dirname(isolatedProjectPath), { recursive: true });
    await writeFile(
      isolatedGlobalPath,
      JSON.stringify({
        orchestratorModel: "magpie/bp/claude-fable-5-2",
        orchestratorThinkingLevel: "high",
        workerModel: "magpie/auto/gemini-4-neon",
        workerThinkingLevel: "high",
        validatorModel: "magpie/bp/claude-opus-5-5",
        validatorThinkingLevel: "xhigh",
      }),
      "utf8",
    );
    await writeFile(
      isolatedProjectPath,
      JSON.stringify({
        validatorModel: "magpie/bp/claude-opus-5-5",
        validatorThinkingLevel: "xhigh",
      }),
      "utf8",
    );

    const spawnedByName = new Map<string, MockMemberTracker>();
    const mockTransport: ISwarmTransport = {
      async listAvailableModels() {
        return [
          {
            id: "claude-fable-5-2",
            provider: "magpie/bp",
            fullId: "magpie/bp/claude-fable-5-2",
            name: "Claude Fable 5.2",
          },
          {
            id: "gpt-6.2-astra",
            provider: "magpie/bp",
            fullId: "magpie/bp/gpt-6.2-astra",
            name: "GPT-6.2 Astra",
          },
        ];
      },
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: `${request.name} ready`,
            tokens: 10,
            cost: 0.0001,
          }),
        });
        spawnedByName.set(request.name, tracker);
        return tracker.handle;
      },
    };

    const harness = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "v040-e2e",
    });
    const ext = createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsPathOptions: {
        globalPath: isolatedGlobalPath,
        projectPath: isolatedProjectPath,
      },
    });
    ext(harness.pi);
    await harness.emit("session_start", { reason: "startup" });

    // Launch run with live validator named `validator`
    await harness.runCommand("swarm-direct", "Ship v0.4.0 model UX");
    await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "v0.4.0 Models E2E",
      objective: "Verify live propagation and @member disambiguation",
      strategy: "Spawn validator and update validator role",
      acceptance_criteria: "Validator updates smoothly",
      base_branch: "main",
      initial_members: [
        {
          name: "validator",
          role: "validator",
          workspace: "inherit",
          brief: "Independent verifier",
        },
      ],
    });
    await waitFor(() => spawnedByName.get("validator")?.handle.getState() === "waiting");
    const valTracker = spawnedByName.get("validator")!;
    assert.equal(valTracker.spawnModel, "magpie/bp/claude-opus-5-5");
    assert.equal(valTracker.spawnThinkingLevel, "xhigh");

    // 1) `/swarm models validator magpie/bp/gpt-6.2-astra:high --global`
    //    - parses `:high` colon shorthand
    //    - unmasks shadowing project keys so global value takes effect
    //    - silently propagates to waiting `@validator`
    await harness.runCommand(
      "swarm",
      "models validator magpie/bp/gpt-6.2-astra:high --global",
    );
    const savedGlobal = JSON.parse(await readFile(isolatedGlobalPath, "utf8"));
    assert.equal(savedGlobal.validatorModel, "magpie/bp/gpt-6.2-astra");
    assert.equal(savedGlobal.validatorThinkingLevel, "high");
    await assert.rejects(() => readFile(isolatedProjectPath, "utf8"), /ENOENT/);

    assert.equal(valTracker.modelSwitches.length, 1);
    assert.deepEqual(valTracker.modelSwitches[0], {
      model: "magpie/bp/gpt-6.2-astra",
      thinkingLevel: "high",
    });
    assert.equal(valTracker.wakeCount, 0, "Role propagation must not spuriously wake waiting validator");

    // 2) `/swarm model @validator magpie/bp/claude-opus-5-5:medium`
    //    explicit `@` targets the live member instead of the `validator` role default!
    await harness.runCommand(
      "swarm",
      "model @validator magpie/bp/claude-opus-5-5:medium",
    );
    const savedGlobalAfter = JSON.parse(await readFile(isolatedGlobalPath, "utf8"));
    assert.equal(
      savedGlobalAfter.validatorModel,
      "magpie/bp/gpt-6.2-astra",
      "Targeting @validator must NOT overwrite validator role default",
    );
    assert.equal(valTracker.modelSwitches.length, 2);
    assert.deepEqual(valTracker.modelSwitches[1], {
      model: "magpie/bp/claude-opus-5-5",
      thinkingLevel: "medium",
    });

    // 3) Autocomplete supports both `models` & `model` plus `:thinking` suffix completion
    const swarmCmd = harness.commands.get("swarm")!;
    const colonCompletions = (await swarmCmd.getArgumentCompletions?.(
      "models validator magpie/bp/gpt-6.2-astra:h",
    )) as Array<{ label: string; value: string }>;
    assert.ok(
      colonCompletions.some((c) => c.value === "models validator magpie/bp/gpt-6.2-astra:high"),
    );

    const memberCompletions = (await swarmCmd.getArgumentCompletions?.("model @v")) as Array<{
      label: string;
    }>;
    assert.ok(memberCompletions.some((c) => c.label === "@validator"));

    await harness.executeTool(SWARM_TOOL, { action: "done", summary: "Done" });
    await harness.emit("session_shutdown", { reason: "quit" });
  });

  it("12. v0.5.0: Cross-session Droid Mission Resume discovers unfinished runs, notifies on startup, restores orchestrator model, and honors --quiet vs guided wakeup", async () => {
    const repoDir = await createTempGitRepo("v050-mission-resume");
    tempDirs.push(repoDir);
    const isolatedGlobalPath = path.join(repoDir, ".tmp-global-v050.json");
    const isolatedProjectPath = path.join(repoDir, ".pi", SWARM_SETTINGS_FILE);

    await mkdir(path.dirname(isolatedProjectPath), { recursive: true });
    await writeFile(
      isolatedGlobalPath,
      JSON.stringify({
        orchestratorModel: "anthropic/claude-opus-4-6",
        orchestratorThinkingLevel: "high",
        workerModel: "openai/gpt-5",
        workerThinkingLevel: "medium",
      }),
      "utf8",
    );

    const spawnedByName = new Map<string, MockMemberTracker>();
    const makeTransport = (): ISwarmTransport => ({
      async listAvailableModels() {
        return DEFAULT_TEST_MODELS.map((m) => ({
          id: m.id,
          provider: m.provider,
          fullId: `${m.provider}/${m.id}`,
          name: m.name,
        }));
      },
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: `${request.name} initial work ready`,
            tokens: 20,
            cost: 0.0002,
          }),
        });
        spawnedByName.set(request.name, tracker);
        return tracker.handle;
      },
    });

    // Session 1: launches Mission, spawns @worker-a, posts progress, pauses, and shuts down cleanly
    const s1 = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-mission-1",
    });
    const ext1 = createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsPathOptions: {
        globalPath: isolatedGlobalPath,
        projectPath: isolatedProjectPath,
      },
    });
    ext1(s1.pi);
    await s1.emit("session_start", { reason: "startup" });
    await s1.runCommand("swarm-direct", "Ship resumable mission");
    await s1.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Resumable Auth Mission",
      objective: "Implement auth and verify cleanly",
      strategy: "Single worker followed by validation",
      acceptance_criteria: "All tests pass",
      base_branch: "main",
      initial_members: [
        {
          name: "worker-a",
          role: "worker",
          workspace: "inherit",
          brief: "Draft auth helpers",
        },
      ],
    });
    await waitFor(() => spawnedByName.get("worker-a")?.handle.getState() === "waiting");
    await s1.executeTool(POST_MESSAGE_TOOL, {
      text: "Checkpoint #1 posted before shutdown",
      wake: false,
    });
    await s1.runCommand("swarm", "pause Stepping away");
    await s1.emit("session_shutdown", { reason: "quit" });

    // Session 2: fresh Pi session starting on a DIFFERENT host model (openai/gpt-5-mini)
    const s2 = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-mission-2",
      initialHostModel: DEFAULT_TEST_MODELS[2], // openai/gpt-5-mini
    });
    const ext2 = createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsPathOptions: {
        globalPath: isolatedGlobalPath,
        projectPath: isolatedProjectPath,
      },
    });
    ext2(s2.pi);
    await s2.emit("session_start", { reason: "startup" });

    // Startup notifies non-intrusively about unfinished Mission while staying idle until resumed
    assert.ok(
      s2.notifications.some((n) => /Unfinished Swarm Mission/i.test(n.message)),
      "Session 2 startup must notify about unfinished Swarm Mission",
    );
    assert.equal(s2.sentMessages.filter((m) => m.options?.triggerTurn === true).length, 0);
    assert.ok(!s2.pi.getActiveTools().includes(POST_MESSAGE_TOOL));

    // `/swarm resume --quiet` attaches, claims ownership, unpauses, restores Orchestrator model, and triggers ZERO turns
    await s2.runCommand("swarm", "resume --quiet");
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(
      s2.setModelCalls.some((m) => `${m.provider}/${m.id}` === "anthropic/claude-opus-4-6"),
      "Cross-session resume must restore saved orchestratorModel onto host session",
    );
    assert.ok(s2.thinkingLevelCalls.includes("high"));
    for (const toolName of SWARM_CORE_TOOLS) {
      assert.ok(s2.pi.getActiveTools().includes(toolName), `Expected ${toolName} active after resume`);
    }
    assert.equal(
      s2.sentMessages.filter((m) => m.options?.triggerTurn === true).length,
      0,
      "/swarm resume --quiet must not fire an Orchestrator wakeup turn",
    );
    await s2.runCommand("swarm", "pause Pause again before Session 3");
    await s2.emit("session_shutdown", { reason: "quit" });

    // Session 3: fresh Pi session runs `/swarm resume "Verify worker-a output and complete"`
    const s3 = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-mission-3",
      initialHostModel: DEFAULT_TEST_MODELS[2],
    });
    const ext3 = createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsPathOptions: {
        globalPath: isolatedGlobalPath,
        projectPath: isolatedProjectPath,
      },
    });
    ext3(s3.pi);
    await s3.emit("session_start", { reason: "startup" });
    await s3.runCommand("swarm", 'resume "Verify worker-a output and complete"');
    await waitFor(
      () => s3.sentMessages.some((m) => m.options?.triggerTurn === true),
      2000,
    );

    const wakeupMsg = s3.sentMessages.find((m) => m.options?.triggerTurn === true)!;
    const wakeupText = String(wakeupMsg.message.content ?? "");
    assert.match(wakeupText, /<swarm_mission_resumed/);
    assert.match(wakeupText, /Verify worker-a output and complete/);
    assert.match(wakeupText, /Checkpoint #1 posted before shutdown/);

    await s3.executeTool(SWARM_TOOL, { action: "done", summary: "Resumed and completed" });
    await s3.emit("session_shutdown", { reason: "quit" });
  });

  it("13. v0.5.1: persists resume ownership, clears active draft on resume, restores/clears thinking, wakes crash-recovered active runs, releases on session_start switch, and supports effort-only orchestrator switch", async () => {
    const repoDir = await createTempGitRepo("v051-resume-ownership");
    tempDirs.push(repoDir);
    const store = new SwarmStore(repoDir);

    const makeTransport = (): ISwarmTransport => ({
      async listAvailableModels() {
        return DEFAULT_TEST_MODELS.map((m) => ({
          id: m.id,
          provider: m.provider,
          fullId: `${m.provider}/${m.id}`,
          name: m.name,
        }));
      },
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: `${request.name} ready`,
            tokens: 10,
            cost: 0.0001,
          }),
        });
        return tracker.handle;
      },
    });

    // Seed a paused run owned by a dead PID with orchestrator model (no thinkingLevel -> must clear host thinking!)
    const deadRun = await store.createRun({
      title: "Dead PID Run",
      objective: "Verify ownership claim and clearThinking",
      strategy: "Single worker",
      acceptanceCriteria: "Tests green",
      baseBranch: "main",
      ownerSessionId: "dead-sess-1",
      ownerPid: 999999,
      maxConcurrency: 4,
      validatorEnabled: true,
      roleModels: {
        orchestrator: { model: "anthropic/claude-opus-4-6" },
      },
    });
    await store.updateRun(deadRun.id, { status: "paused", actor: "human" });

    // Session A starts with an active draft and host thinking="high", then runs `/swarm resume`
    const sA = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-a-v051",
      initialHostModel: DEFAULT_TEST_MODELS[2],
    });
    sA.pi.setThinkingLevel("high");
    sA.thinkingLevelCalls.length = 0;
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    })(sA.pi);

    await sA.emit("session_start", { reason: "startup" });
    await sA.runCommand("swarm", "New unrelated goal draft");
    assert.ok(sA.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL));

    await sA.runCommand("swarm", `resume ${deadRun.id}`);
    // 1. Dead-PID ownership must be persisted with current sessionId + process.pid
    const claimed = await store.loadRun(deadRun.id);
    assert.equal(claimed.ownerSessionId, "sess-a-v051");
    assert.equal(claimed.ownerPid, process.pid);

    // 2. Active planning draft must be cleared so "running" tools + wakeup turn fire cleanly
    assert.ok(!sA.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL));
    assert.ok(sA.pi.getActiveTools().includes(POST_MESSAGE_TOOL));
    await waitFor(
      () => sA.sentMessages.some((m) => m.options?.triggerTurn === true),
      2000,
    );

    // 3. Orchestrator model applied with clearThinking=true (restores host default "medium")
    assert.ok(
      sA.setModelCalls.some((m) => `${m.provider}/${m.id}` === "anthropic/claude-opus-4-6"),
    );
    assert.ok(sA.thinkingLevelCalls.includes("medium"));

    // 4. Effort-only orchestrator switch on Inherit (unset orchestratorModel) updates thinking cleanly
    const switchRes = await sA.executeTool(SWARM_TOOL, {
      action: "model",
      thinking_level: "xhigh",
      reason: "Deep analysis",
    });
    assert.equal(switchRes.isError, undefined);
    assert.ok(sA.thinkingLevelCalls.includes("xhigh"));
    assert.match(String(switchRes.content[0].text), /xhigh/);

    // 5. In-process session_start (reason: "new") without prior session_shutdown releases ownership
    (sA.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => "sess-b-v051";
    sA.branch.length = 0; // `/new` starts with a fresh empty session branch
    await sA.emit("session_start", { reason: "new" });
    const afterSwitch = await store.loadRun(deadRun.id);
    assert.equal(afterSwitch.ownerPid, 0, "session_start switch must release previous run ownership before disposeRuntime");

    // New session in same process can now resume without OWNERSHIP_CONFLICT
    await sA.runCommand("swarm", `resume --quiet ${deadRun.id}`);
    const afterNewResume = await store.loadRun(deadRun.id);
    assert.equal(afterNewResume.ownerSessionId, "sess-b-v051");
    assert.equal(afterNewResume.ownerPid, process.pid);

    // 6. Crash-recovered focused `active` run with 0 live turns wakes Orchestrator on `/swarm resume`
    await sA.emit("session_shutdown", { reason: "quit" });
    await store.updateRun(deadRun.id, {
      status: "active",
      ownerSessionId: "crashed-sess-v051",
      ownerPid: 999999,
      roleModels: {
        orchestrator: { thinkingLevel: "high" }, // thinking-only Inherit orchestrator config
      },
    });
    const sCrash = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-crash-recover-v051",
    });
    sCrash.branch.push(...sA.branch);
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    })(sCrash.pi);
    await sCrash.emit("session_start", { reason: "resume" });
    // After crash recovery, focused run is active & owned, but not yet activated in this process
    assert.equal(sCrash.sentMessages.filter((m) => m.options?.triggerTurn === true).length, 0);
    await sCrash.runCommand("swarm", "resume");
    await waitFor(
      () => sCrash.sentMessages.some((m) => m.options?.triggerTurn === true),
      2000,
    );
    assert.ok(
      sCrash.thinkingLevelCalls.includes("high"),
      "Crash-recovered resume must apply thinking-only Inherit orchestrator config",
    );
    await sCrash.executeTool(SWARM_TOOL, { action: "done", summary: "Crash recovery done" });
    await sCrash.emit("session_shutdown", { reason: "quit" });
  });

  it("14. v0.5.1: foreign focus/fork never corrupts working members, live-owned runs stay hidden in startup/completions, input skips / and ! commands, model completions handle --global, and tweak guards non-tweak drafts", async () => {
    const repoDir = await createTempGitRepo("v051-focus-guard");
    tempDirs.push(repoDir);
    const store = new SwarmStore(repoDir);

    let workerGateResolve!: () => void;
    const workerGate = new Promise<void>((r) => {
      workerGateResolve = r;
    });

    const makeTransport = (): ISwarmTransport => ({
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => {
            await workerGate;
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: "done",
              tokens: 5,
              cost: 0.0001,
            };
          },
        });
        return tracker.handle;
      },
    });

    const owner = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "owner-live-v051",
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    })(owner.pi);
    await owner.emit("session_start", { reason: "startup" });
    await owner.runCommand("swarm-direct", "Keep worker working");
    await owner.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Live Worker Run",
      objective: "Verify foreign focus/fork safety",
      strategy: "Single working worker",
      acceptance_criteria: "No corruption",
      base_branch: "main",
      initial_members: [
        {
          name: "worker-live",
          role: "worker",
          workspace: "inherit",
          brief: "Hold working state",
        },
      ],
    });
    await waitFor(async () => {
      const runs = await store.listRuns();
      return runs.length === 1 && runs[0]!.workingCount === 1;
    });
    const liveRunId = (await store.listRuns())[0]!.id;

    // 1. Foreign session startup does NOT advertise live-owned run, and completions exclude it
    const observer = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "observer-live-v051",
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({ ...DEFAULT_SWARM_SETTINGS, stallWatchdogEnabled: false }),
    })(observer.pi);
    await observer.emit("session_start", { reason: "startup" });
    assert.ok(
      !observer.notifications.some((n) => /Unfinished Swarm Mission/i.test(n.message)),
      "Startup must not advertise runs live-owned by another session",
    );
    const resumeCompletions = (await observer.commands
      .get("swarm")
      ?.getArgumentCompletions?.("resume ")) as Array<{ value: string }> | null;
    assert.ok(
      !(resumeCompletions ?? []).some((c) => c.value.includes(liveRunId)),
      "Resume completions must exclude runs live-owned by another session",
    );

    // 2. Foreign `/swarm focus <liveRunId>` keeps `worker-live` in state === "working" on disk!
    await observer.runCommand("swarm", `focus ${liveRunId}`);
    const afterObserverFocus = await store.loadRun(liveRunId);
    assert.equal(
      afterObserverFocus.members["worker-live"]?.state,
      "working",
      "Foreign focus must never overwrite owner's working member to stopped",
    );
    assert.ok(!observer.pi.getActiveTools().includes(POST_MESSAGE_TOOL));

    // 3. Built-in `/` and `!` commands do not set userPromptPreflight or latestHumanDirection
    owner.setIdle(true);
    await owner.emit("input", { source: "interactive", text: "/compact" });
    await owner.emit("input", { source: "interactive", text: "!git status" });
    const preflightSections: Record<string, string> = {};
    await owner.emit("before_agent_start", {
      messageType: "user",
      prompt: "Continue",
      systemPromptOptions: { sections: preflightSections },
    });
    assert.ok(!(preflightSections.swarm_state ?? "").includes("Live User Direction Update"));

    // 4. `getSwarmCompletions` handles `--global` before target in `/swarm model --global `
    const modelCompletions = (await owner.commands
      .get("swarm")
      ?.getArgumentCompletions?.("model --global w")) as Array<{ value: string; label: string }> | null;
    assert.ok(
      (modelCompletions ?? []).some((c) => c.label === "worker" && c.value === "model --global worker"),
      "model completions must preserve --global and complete role target",
    );

    // 5. `/swarm tweak` resuming an existing non-tweak "swarm" draft sends a "swarm" prompt (not "tweak")
    await owner.runCommand("swarm", "New feature draft");
    owner.sentUserMessages.length = 0;
    owner.setSelectHandler((_title, choices) =>
      choices.find((c) => /Resume/i.test(c)) ?? choices[0],
    );
    await owner.runCommand("swarm", "tweak Modify live run");
    assert.ok(
      owner.sentUserMessages.some((m) => String(m.content).includes('mode="swarm"')),
      "Resuming a non-tweak draft inside /swarm tweak must keep mode=swarm",
    );
    assert.ok(
      !owner.sentUserMessages.some((m) => String(m.content).includes('mode="tweak"')),
    );
    await owner.runCommand("swarm", "cancel"); // cancel active draft cleanly

    workerGateResolve();
    await owner.executeTool(SWARM_TOOL, { action: "done", summary: "Verified v0.5.1" });
    await observer.emit("session_shutdown", { reason: "quit" });
    await owner.emit("session_shutdown", { reason: "quit" });
  });

  it("15. v0.6.0: enforces Orchestrator write/edit/powershell delegation guard across draft/active/done/cancel, routes /swarm stop & intuitive aliases without drafting, auto-names unnamed sessions, registers SSH shortcuts, and renders sleek collapsible wakeup cards", async () => {
    const repoDir = await createTempGitRepo("v060-host-ux");
    tempDirs.push(repoDir);
    const store = new SwarmStore(repoDir);

    // 1. Exact 21 SWARM_SUBCOMMANDS in exact existing order + intuitive aliases in parseSwarmCommand
    assert.deepEqual(
      SWARM_SUBCOMMANDS.map((c) => c.name),
      [
        "direct",
        "tweak",
        "status",
        "board",
        "graph",
        "tasks",
        "ui",
        "models",
        "model",
        "steer",
        "merge",
        "kill",
        "done",
        "pause",
        "resume",
        "cancel",
        "teardown",
        "runs",
        "focus",
        "settings",
        "help",
      ],
    );
    assert.deepEqual(parseSwarmCommand("stop worker-1 Too slow"), {
      kind: "stop",
      rest: "worker-1 Too slow",
    });
    assert.deepEqual(parseSwarmCommand("mc members"), { kind: "ui", rest: "members" });
    assert.deepEqual(parseSwarmCommand("open board"), { kind: "ui", rest: "board" });
    assert.deepEqual(parseSwarmCommand("panel"), { kind: "ui", rest: "" });
    assert.deepEqual(parseSwarmCommand("ls"), { kind: "runs", rest: "" });
    assert.deepEqual(parseSwarmCommand("list"), { kind: "runs", rest: "" });
    assert.deepEqual(parseSwarmCommand("config"), { kind: "settings", rest: "" });
    // Natural multi-word sentences still route to goal drafting
    assert.deepEqual(parseSwarmCommand("list all slow endpoints and optimize"), {
      kind: "goal",
      rest: "list all slow endpoints and optimize",
    });
    assert.deepEqual(parseSwarmCommand("open a pull request review pipeline"), {
      kind: "goal",
      rest: "open a pull request review pipeline",
    });

    let releaseStopper!: () => void;
    const stopperGate = new Promise<void>((resolve) => {
      releaseStopper = resolve;
    });
    const trackers = new Map<string, MockMemberTracker>();

    const makeTransport = (): ISwarmTransport => ({
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          onAbort: () => {
            if (request.name === "worker-stop") {
              releaseStopper();
            }
          },
          runInitialTurn: async ({ isAborted }) => {
            if (request.name === "worker-stop") {
              await stopperGate;
              if (isAborted()) {
                return {
                  agentId: request.agentId,
                  name: request.name,
                  role: request.role,
                  outcome: "stopped",
                  stopReason: "aborted",
                  summary: "Aborted cleanly",
                  tokens: 10,
                  cost: 0.0001,
                };
              }
            }
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: `${request.name} ready`,
              tokens: 25,
              cost: 0.0002,
            };
          },
        });
        trackers.set(request.name, tracker);
        return tracker.handle;
      },
    });

    const host = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v060-host-1",
    });
    (host.ctx as { hasUI: boolean }).hasUI = false; // exercise headless paths for config/ls/mc cleanly without blocking modals
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    })(host.pi);

    await host.emit("session_start", { reason: "startup" });

    // Verify SSH/tmux shortcuts (`alt+s`, `alt+m`, `alt+w`) & `/swarm help` documentation
    assert.ok(host.shortcuts.has("alt+s"), "Expected alt+s shortcut registered");
    assert.ok(host.shortcuts.has("alt+m"), "Expected alt+m shortcut registered");
    assert.ok(host.shortcuts.has("alt+w"), "Expected alt+w shortcut registered");
    await host.runCommand("swarm", "help");
    const helpMsg = host.sentMessages[host.sentMessages.length - 1]!;
    const helpText = String(helpMsg.message.content ?? "");
    assert.match(helpText, /Alt\+S/);
    assert.match(helpText, /Alt\+M/);
    assert.match(helpText, /Alt\+W/);
    assert.match(helpText, /Ctrl\+Shift\+S/);
    assert.match(helpText, /\/swarm stop/);

    // Helper to invoke `tool_call` hook
    const checkToolCall = async (
      h: MockHarness,
      toolName: string,
    ): Promise<{ block?: boolean; reason?: string } | undefined> => {
      const results = await h.emit("tool_call", {
        type: "tool_call",
        toolCallId: `tc-${toolName}-${Date.now()}`,
        toolName,
        input: {},
      });
      return results.find((r) => r !== undefined);
    };

    // (a) Before drafting (idle): write, edit, powershell are all allowed
    assert.equal(await checkToolCall(host, "write"), undefined);
    assert.equal(await checkToolCall(host, "edit"), undefined);
    assert.equal(await checkToolCall(host, "powershell"), undefined);

    // Start drafting -> write, edit, powershell blocked with Drafting Mode reason; read/bash allowed
    await host.runCommand("swarm", "Draft new feature architecture");
    for (const blockedTool of ["write", "edit", "powershell"]) {
      const res = await checkToolCall(host, blockedTool);
      assert.equal(res?.block, true, `${blockedTool} must be blocked during drafting`);
      assert.match(String(res?.reason), /Swarm Drafting Mode is read-only reconnaissance/);
    }
    assert.equal(await checkToolCall(host, "read"), undefined);
    assert.equal(await checkToolCall(host, "bash"), undefined);

    // `/swarm cancel` during draft restores write/edit/powershell to allowed
    await host.runCommand("swarm", "cancel");
    assert.equal(await checkToolCall(host, "write"), undefined);
    assert.equal(await checkToolCall(host, "edit"), undefined);
    assert.equal(await checkToolCall(host, "powershell"), undefined);

    // Launch active run -> auto-sets Pi session name (`🐝 <title>`) & blocks Orchestrator write/edit/powershell
    assert.equal(host.getSessionName(), undefined);
    await host.runCommand("swarm-direct", "Ship v0.6.0 host improvements");
    const planRes = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Host UX Polish",
      objective: "Prevent direct edits and streamline commands",
      strategy: "Delegate to share worker",
      acceptance_criteria: "All integration tests pass",
      base_branch: "main",
      initial_members: [
        {
          name: "worker-stop",
          role: "worker",
          workspace: "inherit",
          brief: "Long-running worker to test /swarm stop",
        },
      ],
    });
    const runId: string = planRes.details.runId;
    assert.equal(host.getSessionName(), "🐝 Host UX Polish");
    assert.deepEqual(host.sessionNameCalls, ["🐝 Host UX Polish"]);

    for (const blockedTool of ["write", "edit", "powershell"]) {
      const res = await checkToolCall(host, blockedTool);
      assert.equal(res?.block, true, `${blockedTool} must be blocked while active run is owned`);
      assert.match(
        String(res?.reason),
        /Orchestrator must not edit repository files directly/,
      );
    }
    assert.equal(await checkToolCall(host, "read"), undefined);
    assert.equal(await checkToolCall(host, "bash"), undefined);
    assert.equal(await checkToolCall(host, SWARM_TOOL), undefined);

    // Foreign observer session is NOT blocked from editing in its own session
    const observer = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v060-observer",
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    })(observer.pi);
    await observer.emit("session_start", { reason: "startup" });
    await observer.runCommand("swarm", `focus ${runId}`);
    assert.equal(
      await checkToolCall(observer, "edit"),
      undefined,
      "Read-only observer session must not have its own edit tool blocked",
    );

    // (b) `/swarm stop @worker-stop` stops the member cleanly instead of starting a `/swarm <goal>` draft!
    await waitFor(() => trackers.has("worker-stop"));
    const stopCompletions = (await host.commands
      .get("swarm")
      ?.getArgumentCompletions?.("stop w")) as Array<{ value: string; label: string }> | null;
    assert.ok(
      (stopCompletions ?? []).some(
        (c) => c.label === "worker-stop" && c.value === "stop worker-stop",
      ),
      "Expected `/swarm stop ` argument completions to suggest active member",
    );

    const userMsgsBeforeStop = host.sentUserMessages.length;
    await host.runCommand("swarm", "stop @worker-stop Reassigning slice");
    assert.equal(
      host.sentUserMessages.length,
      userMsgsBeforeStop,
      "/swarm stop must never trigger a /swarm <goal> drafting prompt",
    );
    const runAfterStop = await store.loadRun(runId);
    assert.equal(runAfterStop.members["worker-stop"]?.state, "stopped");
    assert.equal(runAfterStop.members["worker-stop"]?.humanStopped, true);
    assert.equal(runAfterStop.members["worker-stop"]?.parkedOn, "Reassigning slice");
    assert.equal(trackers.get("worker-stop")?.aborted, true);

    // Verify intuitive aliases (`ls`, `list`, `config`, `mc`, `open`, `panel`) execute zero-turn handlers, never drafting
    const msgsBeforeAliases = host.sentMessages.length;
    await host.runCommand("swarm", "ls");
    await host.runCommand("swarm", "list");
    await host.runCommand("swarm", "config");
    await host.runCommand("swarm", "mc");
    await host.runCommand("swarm", "open");
    await host.runCommand("swarm", "panel");
    assert.equal(
      host.sentUserMessages.length,
      userMsgsBeforeStop,
      "Command aliases ls/list/config/mc/open/panel must never trigger drafting",
    );
    assert.equal(host.sentMessages.length - msgsBeforeAliases, 6);

    // Complete run -> restores Orchestrator write/edit/powershell to allowed
    await host.executeTool(SWARM_TOOL, {
      action: "done",
      summary: "Completed run 1",
    });
    assert.equal(await checkToolCall(host, "write"), undefined);
    assert.equal(await checkToolCall(host, "edit"), undefined);
    assert.equal(await checkToolCall(host, "powershell"), undefined);

    // Launch run 2 and `/swarm cancel` -> also restores write/edit/powershell to allowed, and preserves existing session name!
    await host.runCommand("swarm-direct", "Second mission to cancel");
    await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Second Mission Title",
      objective: "Verify cancel unblocks write/edit and keeps existing session name",
      strategy: "No initial workers",
      acceptance_criteria: "Cancelled cleanly",
      base_branch: "main",
    });
    assert.equal(
      host.getSessionName(),
      "🐝 Host UX Polish",
      "Existing non-empty session name must not be overwritten by subsequent runs",
    );
    assert.equal((await checkToolCall(host, "write"))?.block, true);
    await host.runCommand("swarm", "cancel");
    assert.equal(
      await checkToolCall(host, "write"),
      undefined,
      "Orchestrator write must be restored after /swarm cancel abandons active run",
    );
    assert.equal(await checkToolCall(host, "edit"), undefined);

    // (c) Cross-session `/swarm resume` sets `🐝 <runTitle>` on unnamed session, and preserves custom user session name!
    const resumableRun = await store.createRun({
      title: "Cross-Session Payments Mission",
      objective: "Ship idempotent webhooks",
      strategy: "Author + Validator",
      acceptanceCriteria: "Tests green",
      baseBranch: "main",
      ownerSessionId: "dead-owner",
      ownerPid: 999999,
      maxConcurrency: 4,
      validatorEnabled: true,
      roleModels: {},
    });
    await store.updateRun(resumableRun.id, { status: "paused", actor: "human" });
    await store.postBoardMessage(resumableRun.id, {
      from: "orchestrator",
      fromRole: "orchestrator",
      channel: DEFAULT_CHANNEL,
      kind: "update",
      text: "Webhook signature verification landed on branch.",
    });

    const unnamedResumeHost = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v060-resume-unnamed",
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    })(unnamedResumeHost.pi);
    await unnamedResumeHost.emit("session_start", { reason: "startup" });
    await unnamedResumeHost.runCommand(
      "swarm",
      `resume ${resumableRun.id} "Audit webhook retries"`,
    );
    assert.equal(
      unnamedResumeHost.getSessionName(),
      "🐝 Cross-Session Payments Mission",
    );
    await waitFor(
      () => unnamedResumeHost.sentMessages.some((m) => m.options?.triggerTurn === true),
      2000,
    );

    // Pause and resume from a session that ALREADY has a user-chosen session name -> must NOT overwrite!
    await unnamedResumeHost.runCommand("swarm", "pause");
    const resumeWakeupMsg = unnamedResumeHost.sentMessages.find(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    )!;
    await unnamedResumeHost.emit("session_shutdown", { reason: "quit" });

    const namedResumeHost = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v060-resume-named",
      initialSessionName: "My Custom Session Title",
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    })(namedResumeHost.pi);
    await namedResumeHost.emit("session_start", { reason: "startup" });
    await namedResumeHost.runCommand("swarm", `resume --quiet ${resumableRun.id}`);
    assert.equal(namedResumeHost.getSessionName(), "My Custom Session Title");
    assert.equal(namedResumeHost.sessionNameCalls.length, 0);

    // Verify `registerMessageRenderer` for `SWARM_WAKEUP_CUSTOM_TYPE` & `SWARM_STATUS_CUSTOM_TYPE`
    const wakeupRenderer = namedResumeHost.messageRenderers.get(SWARM_WAKEUP_CUSTOM_TYPE);
    const statusRenderer = namedResumeHost.messageRenderers.get(SWARM_STATUS_CUSTOM_TYPE);
    assert.equal(typeof wakeupRenderer, "function");
    assert.equal(typeof statusRenderer, "function");

    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;

    // Collapsed wakeup card: strips `<swarm_mission_resumed>`, renders 2-4 lines at 80/120 cols, uses `options.keyHint`
    const keyHintCalls: Array<{ keybinding: string; description: string }> = [];
    const collapsedComp = wakeupRenderer!(
      resumeWakeupMsg.message as any,
      {
        expanded: false,
        outputPad: 1,
        keyText: () => "ctrl+o",
        keyHint: (kb, desc) => {
          keyHintCalls.push({ keybinding: kb, description: desc });
          return `ctrl+o ${desc}`;
        },
      },
      mockTheme,
    )!;
    assert.ok(collapsedComp, "Wakeup renderer must return a Component");
    assert.deepEqual(keyHintCalls, [
      { keybinding: "app.tools.expand", description: "to expand" },
    ]);
    for (const width of [40, 60, 80, 120]) {
      const rendered = collapsedComp.render(width);
      for (const line of rendered) {
        assert.ok(
          visibleWidth(line) <= width,
          `Collapsed wakeup line exceeded width ${width}: ${visibleWidth(line)}`,
        );
      }
      if (width >= 80) {
        assert.ok(
          rendered.length >= 2 && rendered.length <= 4,
          `Expected 2-4 collapsed lines at width ${width}, got ${rendered.length}`,
        );
      }
    }
    const collapsedPlain = stripTerminalSequences(collapsedComp.render(100).join("\n"));
    assert.ok(!collapsedPlain.includes("<swarm_mission_resumed"));
    assert.ok(!collapsedPlain.includes("</swarm_mission_resumed>"));
    assert.match(collapsedPlain, /MISSION RESUMED/);
    assert.match(collapsedPlain, /ctrl\+o to expand/);

    // Fallback when `keyHint` is absent -> `(Ctrl+O to expand)`
    const collapsedFallbackComp = wakeupRenderer!(
      resumeWakeupMsg.message as any,
      { expanded: false, outputPad: 1 } as any,
      mockTheme,
    )!;
    const collapsedFallbackPlain = stripTerminalSequences(
      collapsedFallbackComp.render(100).join("\n"),
    );
    assert.match(collapsedFallbackPlain, /\(Ctrl\+O to expand\)/);

    // Expanded wakeup view: strips XML tags, renders Markdown cleanly without truncation notice
    const expandedComp = wakeupRenderer!(
      resumeWakeupMsg.message as any,
      { expanded: true, outputPad: 1, keyText: () => "ctrl+o", keyHint: () => "ctrl+o to expand" },
      mockTheme,
    )!;
    const expandedPlain = stripTerminalSequences(expandedComp.render(100).join("\n"));
    assert.ok(!expandedPlain.includes("<swarm_mission_resumed"));
    assert.ok(!expandedPlain.includes("</swarm_mission_resumed>"));
    assert.match(expandedPlain, /Audit webhook retries/);
    assert.match(expandedPlain, /Webhook signature verification landed on branch/);
    assert.ok(!expandedPlain.includes("(Ctrl+O to expand)"));
    assert.ok(!expandedPlain.includes("(`wake: true`)"), "Resume prompt must not instruct nonexistent wake: true param");
    assert.match(expandedPlain, /mention @<name> in text/);

    // Status message renderer width safety at 40/60/80/120 cols
    const statusComp = statusRenderer!(
      helpMsg.message as any,
      { expanded: false, outputPad: 1, keyText: () => "", keyHint: () => "" },
      mockTheme,
    )!;
    for (const width of [40, 60, 80, 120]) {
      for (const line of statusComp.render(width)) {
        assert.ok(visibleWidth(line) <= width);
      }
    }

    await namedResumeHost.executeTool(SWARM_TOOL, {
      action: "done",
      summary: "Completed v0.6.0 verification",
    });
    await namedResumeHost.emit("session_shutdown", { reason: "quit" });
    await observer.emit("session_shutdown", { reason: "quit" });
    await host.emit("session_shutdown", { reason: "quit" });
  });

  it("16. v0.7.0: fixes Double-Enter autocomplete trap, renders native Markdown + keyHint, deduplicates /swarm focus, adapts /swarm graph width, and syncs setWorkingMessage/setTitle + unfinished footer cue", async () => {
    const repoDir = await createTempGitRepo("v070-host-ui");
    tempDirs.push(repoDir);
    const store = new SwarmStore(repoDir);

    const makeTransport = (): ISwarmTransport => ({
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: "Standing by",
            tokens: 120,
            cost: 0.002,
          }),
        });
        return tracker.handle;
      },
    });

    // Seed an unfinished resumable run before startup to verify persistent unfinished-mission footer cue
    const unfinishedRun = await store.createRun({
      title: "Unfinished Billing Refactor",
      objective: "Migrate invoice pipeline",
      strategy: "Single worker",
      acceptanceCriteria: "Tests pass",
      baseBranch: "main",
      ownerSessionId: "dead-sess-v070",
      ownerPid: 999999,
      maxConcurrency: 4,
      validatorEnabled: true,
      roleModels: {},
    });

    const host = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v070-ui",
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    })(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // 1. Unfinished-mission startup notification + persistent footer status cue
    assert.ok(
      host.notifications.some((n) => /Unfinished Swarm Mission/i.test(n.message)),
      "Startup must notify on unfinished mission",
    );
    assert.ok(
      host.statusHistory.some(
        (s) =>
          s.key === SWARM_STATUS_KEY &&
          typeof s.text === "string" &&
          /1 unfinished mission.*\/swarm resume/i.test(s.text),
      ),
      "Startup must set a persistent unfinished-mission footer status cue",
    );

    // 2. Pi 1.6.0 Double-Enter Autocomplete Trap: exact single match returns null
    const swarmCmd = host.commands.get("swarm")!;
    assert.equal(await swarmCmd.getArgumentCompletions?.("status"), null);
    assert.equal(await swarmCmd.getArgumentCompletions?.("models"), null);
    assert.equal(await swarmCmd.getArgumentCompletions?.("board"), null);
    assert.equal(await swarmCmd.getArgumentCompletions?.("help"), null);
    assert.equal(await swarmCmd.getArgumentCompletions?.("graph"), null);

    // Partial prefix still completes cleanly
    const statMatches = (await swarmCmd.getArgumentCompletions?.("stat")) as Array<{
      value: string;
    }> | null;
    assert.deepEqual(
      (statMatches ?? []).map((m) => m.value),
      ["status"],
    );
    const modelMatches = (await swarmCmd.getArgumentCompletions?.("model")) as Array<{
      value: string;
    }> | null;
    assert.deepEqual(
      (modelMatches ?? []).map((m) => m.value),
      ["models", "model"],
    );

    // Focus & resume runId completions: partial matches return item; exact match returns null
    const partialFocus = (await swarmCmd.getArgumentCompletions?.("focus run_")) as Array<{
      value: string;
    }> | null;
    assert.ok(
      (partialFocus ?? []).some((m) => m.value === `focus ${unfinishedRun.id}`),
    );
    assert.equal(
      await swarmCmd.getArgumentCompletions?.(`focus ${unfinishedRun.id}`),
      null,
      "Exact focus <runId> completion must return null to prevent Double-Enter trap",
    );
    assert.equal(
      await swarmCmd.getArgumentCompletions?.("focus none"),
      null,
      "Exact focus none completion must return null",
    );

    const partialResume = (await swarmCmd.getArgumentCompletions?.("resume run_")) as Array<{
      value: string;
    }> | null;
    assert.ok(
      (partialResume ?? []).some((m) => m.value === `resume ${unfinishedRun.id}`),
    );
    assert.equal(
      await swarmCmd.getArgumentCompletions?.(`resume ${unfinishedRun.id}`),
      null,
      "Exact resume <runId> completion must return null to prevent Double-Enter trap",
    );
    assert.equal(
      await swarmCmd.getArgumentCompletions?.(`resume --quiet ${unfinishedRun.id}`),
      null,
      "Exact resume --quiet <runId> completion must return null",
    );

    // 3. Deduplicated `/swarm focus` output when ctx.hasUI === true
    const statusMsgsBeforeFocus = host.sentMessages.filter(
      (m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE,
    ).length;
    const notifsBeforeFocus = host.notifications.length;
    await host.runCommand("swarm", `focus ${unfinishedRun.id}`);
    assert.equal(
      host.notifications.length - notifsBeforeFocus,
      1,
      "/swarm focus with UI must notify once",
    );
    assert.equal(
      host.sentMessages.filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE).length,
      statusMsgsBeforeFocus,
      "/swarm focus with UI must NOT duplicate output via emitZeroTurnMessage",
    );

    // Unfinished footer cue is cleared once a run is focused; setWorkingMessage & setTitle sync
    assert.ok(
      host.workingMessageHistory.some((m) => typeof m === "string" && /Swarm/i.test(m)),
      "refreshUI must sync ctx.ui.setWorkingMessage while mission is active",
    );
    assert.ok(
      host.titleHistory.some((t) => /Unfinished Billing Refactor/i.test(t)),
      "refreshUI must sync ctx.ui.setTitle while mission is active",
    );

    // 4. Dynamic `/swarm graph` width respects process.stdout.columns
    const origColumnsDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "columns",
    );
    try {
      Object.defineProperty(process.stdout, "columns", {
        value: 72,
        configurable: true,
      });
      await host.runCommand("swarm", "graph");
      const graphMsg = host.sentMessages
        .filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
        .pop()!;
      const graphContent = String(graphMsg.message.content);
      const codeBlockMatch = graphContent.match(/```text\n([\s\S]*?)\n```/);
      assert.ok(codeBlockMatch, "Expected fenced text graph block");
      for (const line of codeBlockMatch[1]!.split("\n")) {
        assert.ok(
          visibleWidth(line) <= 68,
          `Graph line exceeded dynamic width 68 at 72 cols: ${visibleWidth(line)} ("${line}")`,
        );
      }
    } finally {
      if (origColumnsDescriptor) {
        Object.defineProperty(process.stdout, "columns", origColumnsDescriptor);
      } else {
        delete (process.stdout as { columns?: number }).columns;
      }
    }

    // 5. Native Markdown rendering for SWARM_STATUS_CUSTOM_TYPE (tables + code blocks via pi-tui Markdown)
    const statusRenderer = host.messageRenderers.get(SWARM_STATUS_CUSTOM_TYPE)!;
    const seenThemeColors = new Set<string>();
    const mockTheme = {
      fg: (color: string, text: string) => {
        seenThemeColors.add(color);
        return text;
      },
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
      strikethrough: (text: string) => text,
    } as unknown as Theme;

    const mdSample = [
      "### 🐝 Report",
      "",
      "| ColA | ColB |",
      "| --- | --- |",
      "| alpha | beta |",
      "",
      "```text",
      "graph-body",
      "```",
    ].join("\n");
    const mdComp = statusRenderer(
      { customType: SWARM_STATUS_CUSTOM_TYPE, content: mdSample, display: true } as any,
      { expanded: false, outputPad: 1, keyText: () => "", keyHint: () => "" },
      mockTheme,
    )!;
    const renderedMd = stripTerminalSequences(mdComp.render(80).join("\n"));
    assert.ok(!renderedMd.includes("| --- |"), "Markdown table separator must be rendered, not printed raw");
    assert.ok(renderedMd.includes("┌") && renderedMd.includes("└"), "Markdown table must render native box borders");
    assert.ok(seenThemeColors.has("mdCodeBlockBorder"), "Markdown renderer must style code block borders via MarkdownTheme");
    assert.ok(seenThemeColors.has("mdCodeBlock"), "Markdown renderer must style code block body via MarkdownTheme");
    assert.match(renderedMd, /alpha/);
    assert.match(renderedMd, /graph-body/);

    // Graceful Text fallback when theme is undefined (headless mock)
    const fallbackComp = statusRenderer(
      { customType: SWARM_STATUS_CUSTOM_TYPE, content: mdSample, display: true } as any,
      { expanded: false, outputPad: 1 } as any,
      undefined as any,
    )!;
    assert.ok(fallbackComp.render(80).join("\n").includes("alpha"));

    // 6. Clearing workingMessage & title on `done` and `session_shutdown`, plus compatibility when UI lacks them
    await host.executeTool(SWARM_TOOL, {
      action: "done",
      summary: "Finished billing refactor",
    });
    assert.equal(
      host.workingMessageHistory[host.workingMessageHistory.length - 1],
      undefined,
      "completeRun must clear setWorkingMessage(undefined)",
    );
    assert.equal(
      host.titleHistory[host.titleHistory.length - 1],
      "",
      "completeRun must clear setTitle('')",
    );

    await host.emit("session_shutdown", { reason: "quit" });

    // Minimal mock UI without setWorkingMessage/setTitle never throws
    const minimalHost = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v070-minimal-ui",
      omitNativeWorkingUi: true,
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    })(minimalHost.pi);
    await minimalHost.emit("session_start", { reason: "startup" });
    await minimalHost.runCommand("swarm", "status");
    await minimalHost.emit("session_shutdown", { reason: "quit" });
  });

  it("17. v0.7.0: emits Rich Mission Complete Card + smart post-run teardown confirm, enforces applyOrchestratorModel idempotency + pre-swarm model restore, and fixes run_<id> resume & rehydrate", async () => {
    const repoDir = await createTempGitRepo("v070-lifecycle");
    tempDirs.push(repoDir);
    const store = new SwarmStore(repoDir);

    const makeTransport = (): ISwarmTransport => ({
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => {
            if (request.role === "worker" && request.workspace === "share") {
              await writeFile(
                path.join(request.cwd, "src", `${request.name}.ts`),
                `export const ${request.name.replace(/-/g, "_")} = true;\n`,
                "utf8",
              );
              await git(request.cwd, ["add", "."]);
              await git(request.cwd, ["commit", "-m", `feat: add ${request.name}`]);
              await request.engineApi?.postMessage({
                channel: DEFAULT_CHANNEL,
                kind: "done",
                text: `@orchestrator [done] Implemented src/${request.name}.ts`,
              });
            } else if (request.role === "validator") {
              await request.engineApi?.postMessage({
                channel: DEFAULT_CHANNEL,
                kind: "done",
                text: "@orchestrator [done] PASS — all checks verified cleanly.",
              });
            }
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: "Turn complete",
              tokens: 2400,
              cost: 0.015,
            };
          },
        });
        return tracker.handle;
      },
    });

    // Start on claude-sonnet-4-5:medium; configure orchestratorModel = claude-opus-4-6:high
    const host = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v070-lifecycle",
      initialHostModel: DEFAULT_TEST_MODELS[1], // anthropic/claude-sonnet-4-5
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        orchestratorModel: "anthropic/claude-opus-4-6",
        orchestratorThinkingLevel: "high",
        autoTeardownOnComplete: false,
        stallWatchdogEnabled: false,
      }),
    })(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // A. `applyOrchestratorModel` idempotency across `/swarm direct` + `handlePlanConfirmed`
    await host.runCommand("swarm-direct", "Ship auth module with validator");
    assert.equal(host.ctx.model?.id, "claude-opus-4-6");
    assert.equal(host.pi.getThinkingLevel(), "high");
    const setModelCountAfterDirect = host.setModelCalls.length;
    const thinkingCountAfterDirect = host.thinkingLevelCalls.length;
    assert.equal(setModelCountAfterDirect, 1);
    assert.equal(thinkingCountAfterDirect, 1);

    const plan1 = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Auth Module Delivery",
      objective: "Add auth helper and verify cleanly",
      strategy: "Worker + Validator",
      acceptance_criteria: "Merged and PASS",
      base_branch: "main",
      initial_members: [
        {
          name: "auth-dev",
          role: "worker",
          workspace: "share",
          brief: "Implement src/auth-dev.ts",
        },
        {
          name: "auth-val",
          role: "validator",
          workspace: "inherit",
          brief: "Verify auth-dev changes",
        },
      ],
    });
    const run1Id: string = plan1.details.runId;
    assert.equal(
      host.setModelCalls.length,
      setModelCountAfterDirect,
      "handlePlanConfirmed must short-circuit applyOrchestratorModel when model+thinking already match",
    );
    assert.equal(
      host.thinkingLevelCalls.length,
      thinkingCountAfterDirect,
      "handlePlanConfirmed must not flap thinking level when already matching",
    );

    // Wait for worker & validator to finish initial turns, then merge auth-dev (leaving clean merged worktree on disk)
    await waitFor(async () => {
      const r = await store.loadRun(run1Id);
      return (
        r.members["auth-dev"]?.state === "waiting" &&
        r.members["auth-val"]?.state === "waiting"
      );
    });
    await host.executeTool(SWARM_TOOL, { action: "merge", name: "auth-dev" });
    const run1BeforeDone = await store.loadRun(run1Id);
    const wt1Path = run1BeforeDone.members["auth-dev"]!.cwd;
    assert.equal(await pathExists(wt1Path), true);

    // B. Tool-initiated `swarm{action:"done"}` emits Rich Mission Complete Card with `/swarm teardown` & restores pre-swarm model!
    const confirmsBeforeToolDone = host.confirmCalls.length;
    await host.executeTool(SWARM_TOOL, {
      action: "done",
      summary: "Auth module merged and validated",
    });
    assert.equal(
      host.confirmCalls.length,
      confirmsBeforeToolDone,
      "Tool-initiated done must NOT open an interactive confirm prompt",
    );
    assert.equal(
      host.ctx.model?.id,
      "claude-sonnet-4-5",
      "Tool-initiated done must restore pre-swarm host model",
    );
    assert.equal(
      host.pi.getThinkingLevel(),
      "medium",
      "Tool-initiated done must restore pre-swarm thinking level",
    );
    const toolDoneCard = host.sentMessages
      .filter(
        (m) =>
          m.message.customType === SWARM_STATUS_CUSTOM_TYPE &&
          (m.message.details as { missionCompleteCard?: boolean } | undefined)
            ?.missionCompleteCard === true,
      )
      .pop()!;
    assert.ok(toolDoneCard, "Expected structured Mission Complete Card on tool done");
    assert.equal(toolDoneCard.options?.triggerTurn, false);
    const toolCardText = String(toolDoneCard.message.content);
    assert.match(toolCardText, /Mission Complete — Auth Module Delivery/);
    assert.match(toolCardText, /Add auth helper and verify cleanly/);
    assert.match(toolCardText, /Duration:/);
    assert.match(toolCardText, /@auth-dev/);
    assert.match(toolCardText, /Diff Summary \(`git diff --stat`\)/);
    assert.match(toolCardText, /src\/auth-dev\.ts/);
    assert.match(toolCardText, /Validator:.*PASS/);
    assert.match(toolCardText, /4\.8k tok/);
    assert.match(toolCardText, /1 remaining/);
    assert.match(toolCardText, /\/swarm teardown/);

    // C. Interactive `/swarm done` with clean merged worktree prompts `Remove 1 merged worktree(s) now?` & runs teardown!
    await host.runCommand("swarm-direct", "Ship billing module");
    const plan2 = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Billing Delivery",
      objective: "Add billing helper",
      strategy: "Single share worker",
      acceptance_criteria: "Merged cleanly",
      base_branch: "main",
      initial_members: [
        {
          name: "bill-dev",
          role: "worker",
          workspace: "share",
          brief: "Implement src/bill-dev.ts",
        },
      ],
    });
    const run2Id: string = plan2.details.runId;
    await waitFor(async () => {
      const r = await store.loadRun(run2Id);
      return r.members["bill-dev"]?.state === "waiting";
    });
    await host.executeTool(SWARM_TOOL, { action: "merge", name: "bill-dev" });
    const wt2Path = (await store.loadRun(run2Id)).members["bill-dev"]!.cwd;
    assert.equal(await pathExists(wt2Path), true);

    host.confirmCalls.length = 0;
    host.setConfirmHandler(() => true);
    await host.runCommand("swarm", "done Billing verified");
    assert.ok(
      host.confirmCalls.some((c) => /Remove 1 merged worktree\(s\) now\?/i.test(c.title)),
      "Interactive /swarm done must prompt to remove clean merged worktrees",
    );
    assert.equal(
      await pathExists(wt2Path),
      false,
      "Confirmed teardown prompt on /swarm done must remove the clean merged worktree",
    );
    assert.equal(host.ctx.model?.id, "claude-sonnet-4-5");
    assert.equal(host.pi.getThinkingLevel(), "medium");
    const cmdDoneCard = host.sentMessages
      .filter(
        (m) =>
          m.message.customType === SWARM_STATUS_CUSTOM_TYPE &&
          (m.message.details as { runId?: string; missionCompleteCard?: boolean } | undefined)
            ?.runId === run2Id &&
          (m.message.details as { missionCompleteCard?: boolean } | undefined)
            ?.missionCompleteCard === true,
      )
      .pop()!;
    assert.ok(cmdDoneCard);
    assert.match(String(cmdDoneCard.message.content), /removed 1 merged worktree\(s\)/);

    // D. `/swarm cancel` also restores pre-swarm host model
    await host.runCommand("swarm-direct", "Cancelable run");
    await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Cancelable Run",
      objective: "Verify pre-swarm model restore on cancel",
      strategy: "No workers",
      acceptance_criteria: "Cancelled",
      base_branch: "main",
    });
    assert.equal(host.ctx.model?.id, "claude-opus-4-6");
    host.setConfirmHandler(() => true);
    await host.runCommand("swarm", "cancel");
    assert.equal(
      host.ctx.model?.id,
      "claude-sonnet-4-5",
      "/swarm cancel must restore pre-swarm host model",
    );
    assert.equal(host.pi.getThinkingLevel(), "medium");

    // E. `/swarm resume run_<unknown>` returns clear not-found error instead of resuming another run!
    const otherRun = await store.createRun({
      title: "Other Active Mission",
      objective: "Should not be resumed by unknown run_ ID",
      strategy: "Worker",
      acceptanceCriteria: "Done",
      baseBranch: "main",
      ownerSessionId: "dead-sess-other",
      ownerPid: 999999,
      maxConcurrency: 4,
      validatorEnabled: true,
      roleModels: {
        orchestrator: { model: "anthropic/claude-opus-4-6", thinkingLevel: "high" },
      },
    });
    await store.addMember(otherRun.id, {
      name: "crashed-worker",
      agentId: "agent-crashed-worker",
      role: "worker",
      parentName: "orchestrator",
      brief: "Was working before crash",
      workspace: "inherit",
      cwd: repoDir,
      state: "working",
    });

    const notifsBeforeUnknown = host.notifications.length;
    await host.runCommand("swarm", "resume run_99999999_deadbeef --quiet");
    const newNotifs = host.notifications.slice(notifsBeforeUnknown);
    assert.ok(
      newNotifs.some(
        (n) => n.level === "error" && /run_99999999_deadbeef.*not found/i.test(n.message),
      ),
      "Unknown run_<id> must report clear not-found error",
    );
    const otherAfterUnknown = await store.loadRun(otherRun.id);
    assert.equal(
      otherAfterUnknown.ownerSessionId,
      "dead-sess-other",
      "Unknown run_<id> must NOT silently claim/resume another run",
    );

    // F. `rehydrateSessionState` (`pi --continue` / `--session`) restores `run.roleModels.orchestrator` & notifies stopped workers
    const rehydrateHost = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v070-rehydrate",
      initialHostModel: DEFAULT_TEST_MODELS[2], // claude-haiku-4-5
    });
    rehydrateHost.pi.appendEntry(SWARM_FOCUS_ENTRY, {
      version: 2,
      runId: otherRun.id,
      ownerSessionId: "dead-sess-other",
      reason: "plan_confirmed",
      updatedAt: new Date().toISOString(),
    });
    createPiSwarmExtension({
      transportFactory: makeTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
    })(rehydrateHost.pi);
    await rehydrateHost.emit("session_start", { reason: "resume" });

    assert.equal(
      rehydrateHost.ctx.model?.id,
      "claude-opus-4-6",
      "rehydrateSessionState must restore run.roleModels.orchestrator model",
    );
    assert.equal(
      rehydrateHost.pi.getThinkingLevel(),
      "high",
      "rehydrateSessionState must restore run.roleModels.orchestrator thinkingLevel",
    );
    assert.ok(
      rehydrateHost.notifications.some(
        (n) => /normalized to stopped/i.test(n.message) && /@crashed-worker/.test(n.message),
      ),
      "rehydrateSessionState must notify cleanly when workers are normalized to stopped",
    );

    await rehydrateHost.emit("session_shutdown", { reason: "quit" });
    await host.emit("session_shutdown", { reason: "quit" });
  });

  it("18. v0.8.0: handlePlanConfirmed persists & tweaks Mission artifacts (assertions, features, milestones, commands, boundaries), enriches kickoff & mid-mission steering, routes /swarm contract & /swarm mission, and renders Rich Mission Complete Card stats", async () => {
    const repoDir = await createTempGitRepo("v080-mission-lifecycle");
    tempDirs.push(repoDir);
    const store = new SwarmStore(repoDir);

    // 1. Verify exact 21-item SWARM_SUBCOMMANDS order & single-word aliases (contract, mission, goal)
    assert.deepEqual(
      SWARM_SUBCOMMANDS.map((c) => c.name),
      [
        "direct",
        "tweak",
        "status",
        "board",
        "graph",
        "tasks",
        "ui",
        "models",
        "model",
        "steer",
        "merge",
        "kill",
        "done",
        "pause",
        "resume",
        "cancel",
        "teardown",
        "runs",
        "focus",
        "settings",
        "help",
      ],
    );
    assert.equal(SWARM_SUBCOMMANDS.length, 21);
    assert.deepEqual(parseSwarmCommand("contract"), { kind: "status", rest: "" });
    assert.deepEqual(parseSwarmCommand("mission"), { kind: "status", rest: "" });
    assert.deepEqual(parseSwarmCommand("goal"), { kind: "status", rest: "" });
    // Multi-word natural goal phrases still enter interactive drafting cleanly
    assert.deepEqual(parseSwarmCommand("goal build oauth2 service"), {
      kind: "goal",
      rest: "goal build oauth2 service",
    });
    assert.deepEqual(parseSwarmCommand("contract validation pipeline"), {
      kind: "goal",
      rest: "contract validation pipeline",
    });

    const nowIso = "2026-11-24T10:00:00.000Z";
    const initialAssertions: MissionAssertion[] = [
      {
        id: "VAL-AUTH-001",
        title: "Login endpoint issues signed token",
        description: "POST /login returns 200 with signed JWT for valid user.",
        evidenceRequired: "Integration test output showing 200 and valid JWT payload",
        status: "pending",
        updatedAt: nowIso,
      },
      {
        id: "VAL-AUDIT-001",
        title: "Audit log records login attempts",
        description: "Every login attempt appends an entry to audit log.",
        evidenceRequired: "Unit test verifying audit log append",
        status: "pending",
        updatedAt: nowIso,
      },
    ];
    const initialFeatures: MissionFeature[] = [
      {
        id: "feat-auth",
        title: "Implement POST /login JWT handler",
        description: "Add login handler and token signing",
        milestone: "m1-auth",
        filesOwned: ["src/auth.ts"],
        fulfills: ["VAL-AUTH-001"],
        status: "pending",
        updatedAt: nowIso,
      },
      {
        id: "feat-audit",
        title: "Implement login audit logger",
        description: "Record structured login audit events",
        milestone: "m2-observability",
        dependsOn: ["feat-auth"],
        filesOwned: ["src/audit.ts"],
        fulfills: ["VAL-AUDIT-001"],
        status: "pending",
        updatedAt: nowIso,
      },
    ];

    let nextPlanOverlay: Partial<ProposedSwarmPlan> | undefined = {
      assertions: initialAssertions,
      features: initialFeatures,
      commands: [
        { name: "test", command: "npm test" },
        { name: "typecheck", command: "npm run typecheck" },
      ],
      boundaries: ["Do not modify legacy-db/"],
    };

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: `${request.name} ready`,
            tokens: 400,
            cost: 0.004,
          }),
        });
        return tracker.handle;
      },
    };

    const mockUI: IQuestionnaireUI = {
      async askQuestion() {
        return { cancelled: false, answer: "JWT", isCustom: false };
      },
      async askQuestionnaire() {
        return { cancelled: false, answers: {}, items: [] };
      },
      async confirmProposal(_ctx, plan) {
        if (nextPlanOverlay) {
          if (!plan.assertions && nextPlanOverlay.assertions) {
            plan.assertions = nextPlanOverlay.assertions;
          }
          if (!plan.features && nextPlanOverlay.features) {
            plan.features = nextPlanOverlay.features;
          }
          if (!plan.milestones && nextPlanOverlay.milestones) {
            plan.milestones = nextPlanOverlay.milestones;
          }
          if (!plan.commands && nextPlanOverlay.commands) {
            plan.commands = nextPlanOverlay.commands;
          }
          if (!plan.boundaries && nextPlanOverlay.boundaries) {
            plan.boundaries = nextPlanOverlay.boundaries;
          }
        }
        return {
          action: "confirm",
          validatorEnabled: plan.validatorEnabled,
          maxConcurrency: plan.maxConcurrency,
        };
      },
    };

    const host = createMockPiHarness(repoDir, {
      mode: "tui",
      sessionId: "sess-v080-lifecycle",
    });
    createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        stallWatchdogEnabled: false,
      }),
      questionnaireUI: mockUI,
    })(host.pi);
    await host.emit("session_start", { reason: "startup" });

    // Verify top-level commands remain strictly ["swarm", "swarm-direct"] and /swarm help documents aliases
    assert.deepEqual(Array.from(host.commands.keys()).sort(), [
      "swarm",
      "swarm-direct",
    ]);
    await host.runCommand("swarm", "help");
    const helpCard = String(
      host.sentMessages[host.sentMessages.length - 1]!.message.content,
    );
    assert.match(helpCard, /\/swarm contract/);
    assert.match(helpCard, /\/swarm mission/);

    // 2. Launch interactive /swarm run -> handlePlanConfirmed persists assertions, features, milestones, commands, boundaries
    await host.runCommand("swarm", "Build Mission-driven auth & audit system");
    host.setIdle(false);
    const planRes = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Auth & Audit Mission",
      objective: "Deliver verified JWT auth and audit trail",
      strategy: "Milestone 1 auth -> Milestone 2 audit + independent validation",
      acceptance_criteria: "All VAL-* assertions verified with test evidence",
      base_branch: "main",
      assertions: [
        {
          id: "VAL-AUTH-001",
          title: "Login endpoint issues signed token",
          description: "POST /login returns 200 with signed JWT for valid user.",
          evidence_required: "Integration test output showing 200 and valid JWT payload",
        },
        {
          id: "VAL-AUDIT-001",
          title: "Audit log records login attempts",
          description: "Every login attempt appends an entry to audit log.",
          evidence_required: "Unit test verifying audit log append",
        },
      ],
      features: [
        {
          id: "feat-auth",
          title: "Implement POST /login JWT handler",
          description: "Add login handler and token signing",
          milestone: "m1-auth",
          files_owned: ["src/auth.ts"],
          fulfills: ["VAL-AUTH-001"],
        },
        {
          id: "feat-audit",
          title: "Implement login audit logger",
          description: "Record structured login audit events",
          milestone: "m2-observability",
          depends_on: ["feat-auth"],
          files_owned: ["src/audit.ts"],
          fulfills: ["VAL-AUDIT-001"],
        },
      ],
      commands: [
        { name: "test", command: "npm test" },
        { name: "typecheck", command: "npm run typecheck" },
      ],
      boundaries: ["Do not modify legacy-db/"],
    });
    assert.equal(planRes.isError, undefined, JSON.stringify(planRes));
    const runId: string = planRes.details.runId;
    assert.ok(runId);

    const persistedRun = await store.loadRun(runId);
    assert.equal(persistedRun.assertions?.length, 2);
    assert.equal(persistedRun.features?.length, 2);
    assert.deepEqual(
      persistedRun.milestones?.map((m) => ({ label: m.label, status: m.status })),
      [
        { label: "m1-auth", status: "pending" },
        { label: "m2-observability", status: "pending" },
      ],
    );
    assert.deepEqual(persistedRun.commands, [
      { name: "test", command: "npm test" },
      { name: "typecheck", command: "npm run typecheck" },
    ]);
    assert.deepEqual(persistedRun.boundaries, ["Do not modify legacy-db/"]);

    // Verify materialized Mission artifacts on disk (.pi/swarm/runs/<runId>/)
    const runDir = path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, runId);
    assert.equal(await pathExists(path.join(runDir, SWARM_MISSION_FILE)), true);
    assert.equal(
      await pathExists(path.join(runDir, SWARM_VALIDATION_CONTRACT_FILE)),
      true,
    );
    assert.equal(
      await pathExists(path.join(runDir, SWARM_VALIDATION_STATE_FILE)),
      true,
    );
    assert.equal(await pathExists(path.join(runDir, SWARM_FEATURES_FILE)), true);

    // Flush kickoff wakeup and verify Mission Goal summary (`Features: 2`, `Contract: 2 VAL-* assertions`, `Commands:`)
    host.setIdle(true);
    await host.emit("agent_settled", { aborted: false });
    const kickoffMsg = host.sentMessages
      .filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE)
      .pop()!;
    const kickoffText = String(kickoffMsg.message.content);
    assert.match(kickoffText, /Features: 2/);
    assert.match(kickoffText, /Contract: 2 VAL-\* assertions/);
    assert.match(kickoffText, /\*\*Commands:\*\*.*`test`: `npm test`/);
    assert.equal(
      buildLaunchKickoffPrompt(persistedRun, []).includes("Contract: 2 VAL-* assertions"),
      true,
    );
    await host.emit("before_agent_start", {
      messageType: "custom",
      systemPromptOptions: { sections: {} },
    });

    // 3. Simulate Milestone 1 completion + seal, then test `/swarm tweak` dynamic merge & sealed guard!
    await store.updateRun(runId, {
      features: [
        {
          ...persistedRun.features![0]!,
          status: "completed",
          assignedMember: "auth-worker",
          mergedCommitSha: "deadbeef1234",
          updatedAt: "2026-11-24T10:10:00.000Z",
        },
        persistedRun.features![1]!,
      ],
      assertions: [
        {
          ...persistedRun.assertions![0]!,
          status: "passed",
          evidence: "24/24 auth tests passed",
          verifiedBy: "validator",
          verifiedByRole: "validator",
          updatedAt: "2026-11-24T10:10:00.000Z",
        },
        {
          ...persistedRun.assertions![1]!,
          status: "passed",
          evidence: "Initial audit log unit test passed",
          verifiedBy: "validator",
          verifiedByRole: "validator",
          updatedAt: "2026-11-24T10:11:00.000Z",
        },
      ],
      milestones: [
        {
          label: "m1-auth",
          status: "done",
          sealed: true,
          sealedAt: "2026-11-24T10:10:00.000Z",
        },
        {
          label: "m2-observability",
          status: "in_progress",
        },
      ],
    });

    // 3a. Sealed milestone guard: adding a NEW feature into sealed `m1-auth` during tweak is rejected cleanly!
    await host.runCommand("swarm", "tweak Try sneaking feature into sealed m1-auth");
    nextPlanOverlay = {
      assertions: initialAssertions,
      features: [
        ...initialFeatures,
        {
          id: "feat-sneak",
          title: "Sneak into sealed milestone",
          description: "Should be blocked",
          milestone: "m1-auth",
          fulfills: [],
          status: "pending",
          updatedAt: nowIso,
        },
      ],
    };
    const badTweakRes = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Auth & Audit Mission",
      objective: "Deliver verified JWT auth and audit trail",
      strategy: "Invalid sealed milestone addition",
      acceptance_criteria: "All VAL-* assertions pass",
      base_branch: "main",
      assertions: [
        {
          id: "VAL-AUTH-001",
          title: "Login endpoint issues signed token",
          description: "POST /login returns 200 with signed JWT for valid user.",
          evidence_required: "Integration test output showing 200 and valid JWT payload",
        },
        {
          id: "VAL-AUDIT-001",
          title: "Audit log records login attempts",
          description: "Every login attempt appends an entry to audit log.",
          evidence_required: "Unit test verifying audit log append",
        },
      ],
      features: [
        {
          id: "feat-auth",
          title: "Implement POST /login JWT handler",
          description: "Add login handler and token signing",
          milestone: "m1-auth",
          fulfills: ["VAL-AUTH-001"],
        },
        {
          id: "feat-sneak",
          title: "Sneak into sealed milestone",
          description: "Should be blocked",
          milestone: "m1-auth",
          fulfills: ["VAL-AUDIT-001"],
        },
      ],
    });
    assert.equal(badTweakRes.isError, true);
    assert.match(String(badTweakRes.content[0].text), /sealed milestone/i);

    // 3b. Valid `/swarm tweak`: preserves `passed` on unchanged VAL-AUTH-001 & `completed` on feat-auth,
    // resets modified VAL-AUDIT-001 back to `pending`, and appends VAL-RATE-001 + feat-ratelimit + new command/boundary!
    nextPlanOverlay = {
      assertions: [
        {
          id: "VAL-AUTH-001",
          title: "Login endpoint issues signed token",
          description: "POST /login returns 200 with signed JWT for valid user.",
          evidenceRequired: "Integration test output showing 200 and valid JWT payload",
          status: "pending",
          updatedAt: nowIso,
        },
        {
          id: "VAL-AUDIT-001",
          title: "Audit log records login attempts with IP",
          description: "Every login attempt appends an entry INCLUDING client IP to audit log.",
          evidenceRequired: "Unit test verifying audit log append with IP",
          status: "pending",
          updatedAt: nowIso,
        },
        {
          id: "VAL-RATE-001",
          title: "Rate limiter blocks brute-force bursts",
          description: "More than 5 failed logins/min returns 429 Too Many Requests.",
          evidenceRequired: "Integration test asserting 429 response",
          status: "pending",
          updatedAt: nowIso,
        },
      ],
      features: [
        {
          id: "feat-auth",
          title: "Implement POST /login JWT handler",
          description: "Add login handler and token signing",
          milestone: "m1-auth",
          filesOwned: ["src/auth.ts"],
          fulfills: ["VAL-AUTH-001"],
          status: "pending",
          updatedAt: nowIso,
        },
        {
          id: "feat-audit",
          title: "Implement login audit logger with IP",
          description: "Record structured login audit events with IP",
          milestone: "m2-observability",
          dependsOn: ["feat-auth"],
          filesOwned: ["src/audit.ts"],
          fulfills: ["VAL-AUDIT-001"],
          status: "pending",
          updatedAt: nowIso,
        },
        {
          id: "feat-ratelimit",
          title: "Add login rate limiter",
          description: "Enforce 5/min failed login rate limit",
          milestone: "m2-observability",
          dependsOn: ["feat-auth"],
          filesOwned: ["src/ratelimit.ts"],
          fulfills: ["VAL-RATE-001"],
          status: "pending",
          updatedAt: nowIso,
        },
      ],
      commands: [{ name: "lint", command: "npm run lint" }],
      boundaries: ["Port range restricted to 4100-4199"],
    };

    host.setIdle(false);
    const goodTweakRes = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      title: "Auth, Audit & Rate-Limit Mission",
      objective: "Deliver verified JWT auth, IP audit logs, and brute-force rate limiting",
      strategy: "Preserve sealed m1-auth; execute m2-observability in parallel",
      acceptance_criteria: "All 3 VAL-* assertions pass",
      base_branch: "main",
      assertions: [
        {
          id: "VAL-AUTH-001",
          title: "Login endpoint issues signed token",
          description: "POST /login returns 200 with signed JWT for valid user.",
          evidence_required: "Integration test output showing 200 and valid JWT payload",
        },
        {
          id: "VAL-AUDIT-001",
          title: "Audit log records login attempts with IP",
          description: "Every login attempt appends an entry INCLUDING client IP to audit log.",
          evidence_required: "Unit test verifying audit log append with IP",
        },
        {
          id: "VAL-RATE-001",
          title: "Rate limiter blocks brute-force bursts",
          description: "More than 5 failed logins/min returns 429 Too Many Requests.",
          evidence_required: "Integration test asserting 429 response",
        },
      ],
      features: [
        {
          id: "feat-auth",
          title: "Implement POST /login JWT handler",
          description: "Add login handler and token signing",
          milestone: "m1-auth",
          files_owned: ["src/auth.ts"],
          fulfills: ["VAL-AUTH-001"],
        },
        {
          id: "feat-audit",
          title: "Implement login audit logger with IP",
          description: "Record structured login audit events with IP",
          milestone: "m2-observability",
          depends_on: ["feat-auth"],
          files_owned: ["src/audit.ts"],
          fulfills: ["VAL-AUDIT-001"],
        },
        {
          id: "feat-ratelimit",
          title: "Add login rate limiter",
          description: "Enforce 5/min failed login rate limit",
          milestone: "m2-observability",
          depends_on: ["feat-auth"],
          files_owned: ["src/ratelimit.ts"],
          fulfills: ["VAL-RATE-001"],
        },
      ],
      commands: [{ name: "lint", command: "npm run lint" }],
      boundaries: ["Port range restricted to 4100-4199"],
    });
    assert.equal(goodTweakRes.isError, undefined, JSON.stringify(goodTweakRes));

    const tweakedRun = await store.loadRun(runId);
    const valAuth = tweakedRun.assertions?.find((a) => a.id === "VAL-AUTH-001");
    const valAudit = tweakedRun.assertions?.find((a) => a.id === "VAL-AUDIT-001");
    const valRate = tweakedRun.assertions?.find((a) => a.id === "VAL-RATE-001");
    assert.equal(valAuth?.status, "passed", "Unchanged passed assertion must stay passed");
    assert.equal(valAuth?.evidence, "24/24 auth tests passed");
    assert.equal(
      valAudit?.status,
      "pending",
      "Modified assertion must reset from passed to pending",
    );
    assert.equal(valAudit?.evidence, undefined);
    assert.equal(valRate?.status, "pending");

    const featAuth = tweakedRun.features?.find((f) => f.id === "feat-auth");
    const featRate = tweakedRun.features?.find((f) => f.id === "feat-ratelimit");
    assert.equal(featAuth?.status, "completed", "Completed feature must stay completed");
    assert.equal(featAuth?.mergedCommitSha, "deadbeef1234");
    assert.equal(featRate?.status, "pending");
    assert.equal(
      tweakedRun.milestones?.find((m) => m.label === "m1-auth")?.sealed,
      true,
      "Untouched sealed milestone must stay sealed",
    );
    assert.deepEqual(
      tweakedRun.commands?.map((c) => c.name),
      ["test", "typecheck", "lint"],
    );
    assert.deepEqual(tweakedRun.boundaries, [
      "Do not modify legacy-db/",
      "Port range restricted to 4100-4199",
    ]);

    // Flush tweak kickoff
    host.setIdle(true);
    await host.emit("agent_settled", { aborted: false });
    await host.emit("before_agent_start", {
      messageType: "custom",
      systemPromptOptions: { sections: {} },
    });

    // 4. Mid-mission user instruction injects Droid Shared-Truth Sync Rule into sections.swarm_state
    await host.emit("input", {
      source: "interactive",
      text: "Also enforce X-RateLimit-Remaining response header",
    });
    const steerSections: Record<string, string> = {};
    await host.emit("before_agent_start", {
      messageType: "user",
      prompt: "Also enforce X-RateLimit-Remaining response header",
      systemPromptOptions: { sections: steerSections },
    });
    assert.match(steerSections.swarm_state ?? "", /Live User Direction Update/);
    assert.match(steerSections.swarm_state ?? "", /Shared-Truth Rule/);
    assert.match(steerSections.swarm_state ?? "", /action:"mission"/);
    assert.match(steerSections.swarm_state ?? "", /action:"title"/);

    // Zero-turn aliases `/swarm contract`, `/swarm mission`, `/swarm goal` execute status view without drafting
    const userMsgsBeforeAliases = host.sentUserMessages.length;
    const statusMsgsBeforeAliases = host.sentMessages.filter(
      (m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE,
    ).length;
    await host.runCommand("swarm", "contract");
    await host.runCommand("swarm", "mission");
    await host.runCommand("swarm", "goal");
    assert.equal(host.sentUserMessages.length, userMsgsBeforeAliases);
    assert.equal(
      host.sentMessages.filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
        .length - statusMsgsBeforeAliases,
      3,
    );

    // `/swarm tasks contract` opens Mission Control overlay directly on the Mission Contract & Features inspector
    let contractOverlayRendered = "";
    const origCustom = (host.ctx.ui as any).custom;
    (host.ctx.ui as any).custom = async (factory: any) => {
      return new Promise((resolve) => {
        const comp = factory(
          {
            terminal: { rows: 30, columns: 100 },
            requestRender() {},
            getShowHardwareCursor: () => false,
            setShowHardwareCursor() {},
          },
          {
            fg: (_c: string, t: string) => t,
            bg: (_c: string, t: string) => t,
            bold: (t: string) => t,
          },
          {},
          resolve,
        );
        comp.focused = true;
        void (async () => {
          await new Promise((r) => setTimeout(r, 20));
          contractOverlayRendered = stripTerminalSequences(comp.render(100).join("\n"));
          comp.handleInput?.("q");
        })();
      });
    };
    try {
      await host.runCommand("swarm", "tasks contract");
    } finally {
      (host.ctx.ui as any).custom = origCustom;
    }
    assert.match(contractOverlayRendered, /VAL-AUTH-001/);
    assert.match(contractOverlayRendered, /feat-ratelimit/);

    // 5. Complete all features, pass all VAL-* assertions, seal both milestones, resolve handoff, and verify Rich Mission Complete Card!
    await store.updateRun(runId, {
      features: tweakedRun.features!.map((f) => ({
        ...f,
        status: "completed",
        assignedMember: f.assignedMember ?? "worker-m2",
        mergedCommitSha: f.mergedCommitSha ?? "cafebabe5678",
        updatedAt: "2026-11-24T10:30:00.000Z",
      })),
      assertions: tweakedRun.assertions!.map((a) => ({
        ...a,
        status: "passed",
        evidence: `Verified ${a.id} via integration suite`,
        verifiedBy: "validator",
        verifiedByRole: "validator",
        updatedAt: "2026-11-24T10:30:00.000Z",
      })),
      milestones: [
        {
          label: "m1-auth",
          status: "done",
          sealed: true,
          sealedAt: "2026-11-24T10:10:00.000Z",
        },
        {
          label: "m2-observability",
          status: "done",
          sealed: true,
          sealedAt: "2026-11-24T10:30:00.000Z",
        },
      ],
      handoffItems: [
        {
          id: "handoff-1",
          type: "discovered_issue",
          sourceMember: "auth-worker",
          sourceFeatureId: "feat-auth",
          summary: "Add brute-force rate limit protection on /login",
          resolution: "tracked",
          trackedFeatureId: "feat-ratelimit",
          createdAt: "2026-11-24T10:09:00.000Z",
          resolvedAt: "2026-11-24T10:15:00.000Z",
        },
        {
          id: "handoff-2",
          type: "critical_context",
          sourceMember: "worker-m2",
          sourceFeatureId: "feat-audit",
          summary: "Proxy X-Forwarded-For already normalized by upstream ingress middleware",
          resolution: "dismissed",
          justification: "Upstream ingress already strips spoofed X-Forwarded-For headers in src/middleware.ts",
          createdAt: "2026-11-24T10:20:00.000Z",
          resolvedAt: "2026-11-24T10:25:00.000Z",
        },
      ],
    });
    await host.runCommand("swarm", `focus ${runId}`);

    const doneRes = await host.executeTool(SWARM_TOOL, {
      action: "done",
      summary: "All 3 features, 3 VAL-* assertions, and 2 handoff items verified and sealed.",
    });
    assert.equal(doneRes.isError, undefined, JSON.stringify(doneRes));

    const completeCardMsg = host.sentMessages
      .filter(
        (m) =>
          m.message.customType === SWARM_STATUS_CUSTOM_TYPE &&
          (m.message.details as { missionCompleteCard?: boolean } | undefined)
            ?.missionCompleteCard === true,
      )
      .pop()!;
    assert.ok(completeCardMsg, "Expected Rich Mission Complete Card");
    const completeCardText = String(completeCardMsg.message.content);
    assert.match(completeCardText, /Validation Contract:.*3\/3 VAL-\* passed/);
    assert.match(completeCardText, /Features:.*3\/3 completed/);
    assert.match(completeCardText, /Sealed Milestones:.*2\/2 sealed/);
    assert.match(completeCardText, /Tech-Debt Handoffs:.*2\/2 resolved \(1 tracked, 1 dismissed\)/);

    const cardDetails = completeCardMsg.message.details as Record<string, unknown>;
    assert.equal(cardDetails.assertionsPassed, 3);
    assert.equal(cardDetails.assertionsTotal, 3);
    assert.equal(cardDetails.featuresCompleted, 3);
    assert.equal(cardDetails.featuresTotal, 3);
    assert.equal(cardDetails.milestonesSealed, 2);
    assert.equal(cardDetails.handoffsResolved, 2);

    await host.emit("session_shutdown", { reason: "quit" });
  });

  it("19. v0.8.0: Sisyphus agent_settled auto-continuation advances unfinished Goal runs, honors [NEEDS_HUMAN] & swarm_wait, trips no-progress circuit breaker after stagnant turns, resets on input/resume, and forwards manageMission", async () => {
    const repoDir = await createTempGitRepo("v080-sisyphus-guard");
    tempDirs.push(repoDir);
    const store = new SwarmStore(repoDir);

    let releaseWaitWorker!: () => void;
    const waitWorkerGate = new Promise<void>((r) => {
      releaseWaitWorker = r;
    });

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => {
            if (request.name === "gated-worker") {
              await waitWorkerGate;
            }
            return {
              agentId: request.agentId,
              name: request.name,
              role: request.role,
              outcome: "waiting",
              summary: `${request.name} parked`,
              tokens: 50,
              cost: 0.0005,
            };
          },
        });
        return tracker.handle;
      },
    };

    // Track `manageMission` calls through toolEngineProxy (both pre- and post-runtime merge)
    const manageMissionCalls: ManageMissionInput[] = [];
    const engineProto = SwarmEngine.prototype as unknown as ISwarmEngine;
    const origManageMission = engineProto.manageMission;
    engineProto.manageMission = async function (
      this: ISwarmEngine,
      input: ManageMissionInput,
    ) {
      manageMissionCalls.push(input);
      if (typeof origManageMission === "function") {
        return origManageMission.call(this, input);
      }
      return {
        op: input.op,
        summary: `Mock manageMission(${input.op})`,
      };
    };

    try {
      const host = createMockPiHarness(repoDir, {
        mode: "tui",
        sessionId: "sess-v080-sisyphus",
      });
      createPiSwarmExtension({
        transportFactory: () => mockTransport,
        settingsLoader: async () => ({
          ...DEFAULT_SWARM_SETTINGS,
          stallWatchdogEnabled: false,
        }),
      })(host.pi);
      await host.emit("session_start", { reason: "startup" });

      // Seed an active Goal Mission with unfinished features, unpassed VAL-*, and an open handoff item
      const goalRun = await store.createRun({
        title: "Sisyphus Goal Run",
        objective: "Relentlessly complete every feature and VAL-* assertion",
        strategy: "Wave 1 -> Validator -> Done",
        acceptanceCriteria: "VAL-CORE-001 and VAL-CORE-002 passed",
        baseBranch: "main",
        ownerSessionId: "sess-v080-sisyphus",
        ownerPid: process.pid,
        maxConcurrency: 4,
        validatorEnabled: true,
        milestones: [{ label: "m1-core", status: "in_progress" }],
        assertions: [
          {
            id: "VAL-CORE-001",
            title: "Core parser handles streaming chunks",
            description: "Streaming chunks parse without data loss",
            status: "pending",
            updatedAt: "2026-11-24T11:00:00.000Z",
          },
          {
            id: "VAL-CORE-002",
            title: "Malformed chunk returns structured error",
            description: "Invalid UTF-8 frame returns PARSE_ERROR",
            status: "failed",
            evidence: "Returned generic Error instead of PARSE_ERROR",
            updatedAt: "2026-11-24T11:00:00.000Z",
          },
        ],
        features: [
          {
            id: "feat-stream",
            title: "Streaming parser",
            description: "Implement chunked stream parser",
            milestone: "m1-core",
            fulfills: ["VAL-CORE-001"],
            status: "pending",
            updatedAt: "2026-11-24T11:00:00.000Z",
          },
          {
            id: "feat-error",
            title: "Structured error codes",
            description: "Return PARSE_ERROR on malformed input",
            milestone: "m1-core",
            fulfills: ["VAL-CORE-002"],
            status: "failed",
            updatedAt: "2026-11-24T11:00:00.000Z",
          },
        ],
        handoffItems: [
          {
            id: "handoff-open-1",
            type: "incomplete_work",
            sourceMember: "worker-1",
            sourceFeatureId: "feat-error",
            summary: "Edge-case empty buffer check still needed",
            resolution: "open",
            createdAt: "2026-11-24T11:00:00.000Z",
          },
        ],
      });

      await host.runCommand("swarm", `focus ${goalRun.id}`);

      const getGoalCheckpoints = () =>
        host.sentMessages.filter(
          (m) =>
            m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE &&
            (m.message.details as { goalCheckpoint?: boolean } | undefined)
              ?.goalCheckpoint === true,
        );

      // Before activation in this session, passive agent_settled must NOT fire auto-continuation
      await host.emit("agent_settled", { aborted: false });
      assert.equal(getGoalCheckpoints().length, 0);

      // 1. Activate run via before_agent_start, then stop prematurely without swarm_wait or done -> Checkpoint #1 fires!
      await host.emit("before_agent_start", {
        messageType: "user",
        prompt: "Begin working on the mission",
        systemPromptOptions: { sections: {} },
      });
      await host.emit("turn_end", {
        turnIndex: 0,
        message: makeAssistantMsg("I inspected the repo and will continue shortly."),
      });
      await host.emit("agent_settled", { aborted: false });

      assert.equal(getGoalCheckpoints().length, 1, "Expected Sisyphus Goal Checkpoint #1");
      const cp1 = getGoalCheckpoints()[0]!;
      assert.equal(cp1.options?.triggerTurn, true);
      assert.equal(cp1.options?.deliverAs, "followUp");
      const cp1Text = String(cp1.message.content);
      assert.match(cp1Text, /🎯 Pi Swarm Goal Checkpoint/);
      assert.match(cp1Text, /feat-stream/);
      assert.match(cp1Text, /feat-error/);
      assert.match(cp1Text, /VAL-CORE-001/);
      assert.match(cp1Text, /VAL-CORE-002/);
      assert.match(cp1Text, /handoff-open-1/);
      assert.match(cp1Text, /\[NEEDS_HUMAN\]/);

      // Verify renderSwarmWakeupMessage renders Goal Checkpoint badge cleanly at 40..120 cols
      const wakeupRenderer = host.messageRenderers.get(SWARM_WAKEUP_CUSTOM_TYPE)!;
      const mockTheme = {
        fg: (_c: string, t: string) => t,
        bg: (_c: string, t: string) => t,
        bold: (t: string) => t,
      } as unknown as Theme;
      const renderOpts = {
        expanded: false,
        outputPad: 1,
        keyText: () => "ctrl+o",
        keyHint: (_kb: string, desc: string) => `ctrl+o ${desc}`,
      };
      for (const width of [40, 60, 80, 120]) {
        const comp = wakeupRenderer(
          cp1.message as any,
          renderOpts,
          mockTheme,
        )!;
        for (const line of comp.render(width)) {
          assert.ok(visibleWidth(line) <= width);
        }
      }
      assert.match(
        stripTerminalSequences(
          wakeupRenderer(cp1.message as any, renderOpts, mockTheme)!
            .render(100)
            .join("\n"),
        ),
        /GOAL CHECKPOINT/,
      );

      // 2. Stagnant turn #1 (zero state progress: same revision & boardHead) -> Checkpoint #2 fires (stagnantTurns = 1)
      await host.emit("before_agent_start", {
        messageType: "custom",
        systemPromptOptions: { sections: {} },
      });
      await host.emit("agent_settled", { aborted: false });
      assert.equal(getGoalCheckpoints().length, 2, "Expected 2nd chance checkpoint on stagnantTurns=1");

      // 3. Stagnant turn #2 (still zero state progress: stagnantTurns >= 2) -> Circuit breaker trips cleanly!
      const notifsBeforeTrip = host.notifications.length;
      await host.emit("before_agent_start", {
        messageType: "custom",
        systemPromptOptions: { sections: {} },
      });
      await host.emit("agent_settled", { aborted: false });
      assert.equal(
        getGoalCheckpoints().length,
        2,
        "Circuit breaker must halt auto-continuation at stagnantTurns >= 2",
      );
      assert.ok(
        host.notifications
          .slice(notifsBeforeTrip)
          .some(
            (n) =>
              n.level === "warning" &&
              /Auto-continue paused \(no state progress\) — send guidance or \/swarm resume/.test(
                n.message,
              ),
          ),
        "Expected warning toast when no-progress circuit breaker trips",
      );

      // 4. `/swarm resume` resets the circuit breaker cleanly so auto-continuation re-arms!
      await host.runCommand("swarm", "resume");
      await host.emit("before_agent_start", {
        messageType: "user",
        prompt: "Proceed with wave 1",
        systemPromptOptions: { sections: {} },
      });
      await host.emit("agent_settled", { aborted: false });
      assert.equal(
        getGoalCheckpoints().length,
        3,
        "/swarm resume must reset circuit breaker and re-arm auto-continuation",
      );

      // 5. `[NEEDS_HUMAN]` escape hatch pauses auto-continuation immediately and notifies cleanly!
      const notifsBeforeHuman = host.notifications.length;
      await host.emit("before_agent_start", {
        messageType: "custom",
        systemPromptOptions: { sections: {} },
      });
      host.setSessionMessages([
        makeAssistantMsg(
          "Blocked: need production staging endpoint URL from user before running integration checks. [NEEDS_HUMAN]",
        ),
      ]);
      await host.emit("agent_settled", { aborted: false });
      assert.equal(
        getGoalCheckpoints().length,
        3,
        "[NEEDS_HUMAN] must suppress auto-continuation",
      );
      assert.ok(
        host.notifications
          .slice(notifsBeforeHuman)
          .some((n) => /🐝 Mission awaiting human input/.test(n.message)),
        "Expected clean '🐝 Mission awaiting human input' notification on [NEEDS_HUMAN]",
      );

      // User input clears `[NEEDS_HUMAN]` + resets circuit breaker; when a worker is spawned & `swarm_wait` is armed, auto-continuation stays asleep!
      host.setSessionMessages([]);
      await host.emit("input", {
        source: "interactive",
        text: "Use http://127.0.0.1:4120 as staging URL",
      });
      await host.emit("before_agent_start", {
        messageType: "user",
        prompt: "Use http://127.0.0.1:4120 as staging URL",
        systemPromptOptions: { sections: {} },
      });
      const spawnRes = await host.executeTool(SWARM_TOOL, {
        action: "add",
        name: "gated-worker",
        role: "worker",
        workspace: "inherit",
        brief: "Implement feat-stream and feat-error",
      });
      assert.equal(spawnRes.isError, undefined);
      const boardHeadBeforeWait = Number(
        (await host.executeTool(READ_BOARD_TOOL, { since: 0 })).details?.head ?? 1,
      );
      const waitParkRes = await host.executeTool(SWARM_WAIT_TOOL, {
        since: boardHeadBeforeWait,
        mentions_only: true,
      });
      assert.equal(waitParkRes.details?.parked, true);
      await host.emit("agent_settled", { aborted: false });
      assert.equal(
        getGoalCheckpoints().length,
        3,
        "Armed swarm_wait must NOT trigger premature-stop Goal Checkpoint",
      );
      releaseWaitWorker();
      await waitFor(async () => {
        const r = await store.loadRun(goalRun.id);
        return r.members["gated-worker"]?.state === "waiting";
      });

      // If `swarm{action:"mission"}` is supported by runtime, verify toolEngineProxy forwards & guards ownership
      if (typeof origManageMission === "function") {
        const statusMissionRes = await host.executeTool(SWARM_TOOL, {
          action: "mission",
          mission_op: "status",
        });
        assert.equal(statusMissionRes.isError, undefined);
        assert.ok(manageMissionCalls.length >= 1);

        const foreign = createMockPiHarness(repoDir, {
          mode: "tui",
          sessionId: "foreign-v080-observer",
        });
        createPiSwarmExtension({
          transportFactory: () => mockTransport,
          settingsLoader: async () => ({
            ...DEFAULT_SWARM_SETTINGS,
            stallWatchdogEnabled: false,
          }),
        })(foreign.pi);
        await foreign.emit("session_start", { reason: "startup" });
        await foreign.runCommand("swarm", `focus ${goalRun.id}`);

        const foreignReadRes = await foreign.executeTool(SWARM_TOOL, {
          action: "mission",
          mission_op: "status",
        });
        assert.equal(foreignReadRes.isError, undefined);

        const foreignMutateRes = await foreign.executeTool(SWARM_TOOL, {
          action: "mission",
          mission_op: "set_manifest",
          commands: [{ name: "test", command: "echo hijacked" }],
        });
        assert.equal(foreignMutateRes.isError, true);
        assert.match(foreignMutateRes.content[0].text, /OWNERSHIP_CONFLICT/);
        await foreign.emit("session_shutdown", { reason: "quit" });
      }

      // Finish all items and verify `done` stops all further Sisyphus checkpoints
      const latestGoalRun = await store.loadRun(goalRun.id);
      await store.updateRun(goalRun.id, {
        features: latestGoalRun.features!.map((f) => ({
          ...f,
          status: "completed",
          mergedCommitSha: "11223344",
        })),
        assertions: latestGoalRun.assertions!.map((a) => ({
          ...a,
          status: "passed",
          evidence: "Verified cleanly",
          verifiedBy: "validator",
          verifiedByRole: "validator",
        })),
        milestones: [{ label: "m1-core", status: "done", sealed: true }],
        handoffItems: latestGoalRun.handoffItems!.map((h) => ({
          ...h,
          resolution: "tracked",
          trackedFeatureId: "feat-error",
          resolvedAt: "2026-11-24T11:20:00.000Z",
        })),
      });
      await host.runCommand("swarm", `focus ${goalRun.id}`);
      const doneGoalRes = await host.executeTool(SWARM_TOOL, {
        action: "done",
        summary: "Completed Sisyphus Goal Run",
      });
      assert.equal(doneGoalRes.isError, undefined, JSON.stringify(doneGoalRes));

      await host.emit("agent_settled", { aborted: false });
      assert.equal(
        getGoalCheckpoints().length,
        3,
        "Completed run must never emit Goal Checkpoints after done",
      );

      await host.emit("session_shutdown", { reason: "quit" });
    } finally {
      if (origManageMission) {
        engineProto.manageMission = origManageMission;
      } else {
        delete engineProto.manageMission;
      }
    }
  });

  it("20. v0.9.0: Adversarial Contract Reviewer pre-confirmation bounce & live ephemeral validator session, services persistence & tweak merge, /swarm done --force human CLI vs callerRole:'human', Rich Mission Complete Card [OVERRIDE] & library metadata, and 21-subcommand invariant", async () => {
    const repoDir = await createTempGitRepo("v090-host-lifecycle");
    tempDirs.push(repoDir);
    const store = new SwarmStore(repoDir);

    // ------------------------------------------------------------------------
    // (4) Exact 21-item SWARM_SUBCOMMANDS order, ["swarm", "swarm-direct"] commands & 7/4/3 tool counts
    // ------------------------------------------------------------------------
    assert.equal(ALL_SWARM_EXTENSION_TOOLS.length, 7);
    assert.equal(SWARM_CORE_TOOLS.length, 4);
    assert.equal(DRAFTING_TOOLS.length, 3);
    assert.equal(SWARM_SUBCOMMANDS.length, 21);
    assert.deepEqual(
      SWARM_SUBCOMMANDS.map((c) => c.name),
      [
        "direct",
        "tweak",
        "status",
        "board",
        "graph",
        "tasks",
        "ui",
        "models",
        "model",
        "steer",
        "merge",
        "kill",
        "done",
        "pause",
        "resume",
        "cancel",
        "teardown",
        "runs",
        "focus",
        "settings",
        "help",
      ],
    );

    // Verify structured verdict parser (`<approved/>` vs `<gaps_found>...</gaps_found>`)
    assert.deepEqual(parseContractReviewOutput("<approved/>"), {
      approved: true,
      summary: "Adversarial contract review passed with no blocking gaps.",
      findings: [],
    });
    const parsedGaps = parseContractReviewOutput(
      `<gaps_found>{"approved":false,"summary":"Missing 429 rate-limit assertion","findings":[{"severity":"blocking","category":"missing_assertion","message":"Objective requires 429 rate limiting but no VAL-* assertion covers it.","suggestion":"Add VAL-API-002 covering 429 Too Many Requests."}]}</gaps_found>`,
    );
    assert.ok(parsedGaps);
    assert.equal(parsedGaps.approved, false);
    assert.equal(parsedGaps.findings.length, 1);
    assert.equal(parsedGaps.findings[0]!.severity, "blocking");
    assert.equal(parsedGaps.findings[0]!.category, "missing_assertion");

    // ------------------------------------------------------------------------
    // (1a) `SwarmExtensionOptions.contractReviewer` pre-confirmation adversarial review + `services` persistence & `tweak` merge
    // ------------------------------------------------------------------------
    const reviewCalls: Array<{ title: string; assertionIds: string[] }> = [];
    let confirmModalCalls = 0;
    let nextServicesOverlay: MissionServiceEntry[] | undefined = [
      {
        name: "api",
        start: "npm run start:api",
        stop: "pkill -f start:api",
        healthcheck: "curl -sf http://127.0.0.1:4110/health",
        port: 4110,
      },
    ];

    const mockTransport: ISwarmTransport = {
      async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentMemberHandle({
          request,
          runInitialTurn: async () => ({
            agentId: request.agentId,
            name: request.name,
            role: request.role,
            outcome: "waiting",
            summary: `${request.name} ready`,
            tokens: 250,
            cost: 0.0025,
          }),
        });
        return tracker.handle;
      },
    };

    const mockUI: IQuestionnaireUI = {
      async askQuestion() {
        return { cancelled: false, answer: "Confirmed", isCustom: false };
      },
      async askQuestionnaire() {
        return { cancelled: false, answers: {}, items: [] };
      },
      async confirmProposal(_ctx, plan) {
        confirmModalCalls += 1;
        if (!plan.services && nextServicesOverlay) {
          plan.services = nextServicesOverlay;
        }
        return {
          action: "confirm",
          validatorEnabled: plan.validatorEnabled,
          maxConcurrency: plan.maxConcurrency,
        };
      },
    };

    const extOptions: SwarmExtensionOptions = {
      transportFactory: () => mockTransport,
      settingsLoader: async () => ({
        ...DEFAULT_SWARM_SETTINGS,
        validatorModel: "openai/gpt-5.2",
        validatorThinkingLevel: "high",
        stallWatchdogEnabled: false,
      }),
      questionnaireUI: mockUI,
      contractReviewer: async (plan): Promise<ContractReviewResult | undefined> => {
        reviewCalls.push({
          title: plan.title,
          assertionIds: (plan.assertions ?? []).map((a) => a.id),
        });
        // Pass 1: reject missing VAL-SVC-002 healthcheck assertion!
        if (reviewCalls.length === 1) {
          return {
            approved: false,
            summary: "Missing healthcheck validation assertion for API service.",
            findings: [
              {
                severity: "blocking",
                category: "missing_assertion",
                message: "API service on port 4110 has no VAL-* assertion verifying /health.",
                suggestion: "Add VAL-SVC-002 claimed by feat-healthcheck.",
              },
            ],
          };
        }
        return {
          approved: true,
          summary: "All VAL-* assertions, commands, and service ports verified.",
          findings: [],
        };
      },
    };

    const completeRunCalls: CompleteRunOptions[] = [];
    const origCompleteRun = SwarmEngine.prototype.completeRun;
    SwarmEngine.prototype.completeRun = async function (
      this: SwarmEngine,
      options: CompleteRunOptions,
    ) {
      completeRunCalls.push({ ...options });
      return origCompleteRun.call(this, options);
    };

    try {
      const host = createMockPiHarness(repoDir, {
        mode: "tui",
        sessionId: "sess-v090-host",
      });
      createPiSwarmExtension(extOptions)(host.pi);
      await host.emit("session_start", { reason: "startup" });

      // Verify exact registered top-level commands ["swarm", "swarm-direct"] and `/swarm done --force` completion
      assert.deepEqual(Array.from(host.commands.keys()).sort(), [
        "swarm",
        "swarm-direct",
      ]);
      const swarmCmdDef = host.commands.get("swarm")!;
      const doneCompletions = (await swarmCmdDef.getArgumentCompletions?.(
        "done --f",
      )) as Array<{ label: string; value: string }> | null;
      assert.ok(
        doneCompletions?.some((item) => item.label === "--force"),
        "Expected `/swarm done` autocomplete to suggest --force",
      );

      // Start interactive `/swarm` draft
      await host.runCommand("swarm", "Build API service with healthcheck and worker queue");
      host.setIdle(false);

      // Pass 1: `contractReviewer` rejects missing VAL-SVC-002 BEFORE opening confirmation modal!
      const pass1Res = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
        title: "API & Worker Service Mission",
        objective: "Ship API server on :4110 with verified /health endpoint",
        strategy: "M1 API core -> M2 health verification",
        acceptance_criteria: "API responds 200 on /health and passes integration tests",
        base_branch: "main",
        assertions: [
          {
            id: "VAL-SVC-001",
            title: "API starts cleanly on port 4110",
            description: "API binds 127.0.0.1:4110 without error.",
            evidence_required: "Startup log + curl check",
          },
        ],
        features: [
          {
            id: "feat-api",
            title: "Implement API server",
            description: "HTTP API server on port 4110",
            milestone: "m1-api",
            files_owned: ["src/api.ts"],
            fulfills: ["VAL-SVC-001"],
          },
        ],
        commands: [{ name: "test", command: "npm test" }],
        services: nextServicesOverlay,
        boundaries: ["Use ports 4100-4199 only"],
      });

      assert.equal(pass1Res.isError, undefined, "Pass-1 review bounce must be non-fatal refinement");
      assert.equal(reviewCalls.length, 1);
      assert.equal(
        confirmModalCalls,
        0,
        "Blocking adversarial review on Pass 1 must NOT open user confirmation modal",
      );
      assert.equal((await store.listRuns()).length, 0, "No run persisted during Pass-1 bounce");
      assert.ok(
        host.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL),
        "Draft must remain active after Pass-1 adversarial review bounce",
      );
      assert.match(String(pass1Res.content[0].text), /\[BLOCKING\]/i);
      assert.match(String(pass1Res.content[0].text), /VAL-SVC-002/);
      assert.ok(
        host.workingMessageHistory.includes(
          "🐝 Adversarial Contract Review (checking VAL-* coverage & commands)…",
        ),
        "Expected TUI working message during adversarial contract review",
      );

      // Pass 2: Orchestrator adds VAL-SVC-002 + feat-healthcheck -> `contractReviewer` approves -> modal confirms -> `services` persisted!
      const pass2Res = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
        title: "API & Worker Service Mission",
        objective: "Ship API server on :4110 with verified /health endpoint",
        strategy: "M1 API core -> M2 health verification",
        acceptance_criteria: "API responds 200 on /health and passes integration tests",
        base_branch: "main",
        assertions: [
          {
            id: "VAL-SVC-001",
            title: "API starts cleanly on port 4110",
            description: "API binds 127.0.0.1:4110 without error.",
            evidence_required: "Startup log + curl check",
          },
          {
            id: "VAL-SVC-002",
            title: "GET /health returns 200 JSON status",
            description: "Health endpoint returns { ok: true }.",
            evidence_required: "curl -sf http://127.0.0.1:4110/health output",
          },
        ],
        features: [
          {
            id: "feat-api",
            title: "Implement API server",
            description: "HTTP API server on port 4110",
            milestone: "m1-api",
            files_owned: ["src/api.ts"],
            fulfills: ["VAL-SVC-001"],
          },
          {
            id: "feat-healthcheck",
            title: "Implement /health endpoint",
            description: "Expose GET /health returning { ok: true }",
            milestone: "m1-api",
            depends_on: ["feat-api"],
            files_owned: ["src/health.ts"],
            fulfills: ["VAL-SVC-002"],
          },
        ],
        commands: [{ name: "test", command: "npm test" }],
        services: nextServicesOverlay,
        boundaries: ["Use ports 4100-4199 only"],
      });

      assert.equal(pass2Res.isError, undefined, JSON.stringify(pass2Res));
      assert.equal(reviewCalls.length, 2);
      assert.equal(confirmModalCalls, 1);
      const runId: string = pass2Res.details.runId;
      assert.ok(runId);

      const createdRun = await store.loadRun(runId);
      assert.equal(createdRun.services?.length, 1);
      assert.equal(createdRun.services?.[0]?.name, "api");
      assert.equal(createdRun.services?.[0]?.port, 4110);
      assert.equal(
        await pathExists(
          path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, runId, SWARM_SERVICES_FILE),
        ),
        true,
        "Expected materialized services.json on disk",
      );

      // Flush launch kickoff and verify `- **Services:**` is summarized in `buildLaunchKickoffPrompt`
      host.setIdle(true);
      await host.emit("agent_settled", { aborted: false });
      const launchKickoff = host.sentMessages
        .filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE)
        .pop()!;
      const launchKickoffText = String(launchKickoff.message.content);
      assert.match(launchKickoffText, /\*\*Services:\*\*.*`api` \(:4110\)/);
      assert.match(
        buildLaunchKickoffPrompt(createdRun, []),
        /\*\*Services:\*\*.*`api` \(:4110\): `npm run start:api`/,
      );

      // `/swarm tweak` merges new `services` cleanly while preserving existing `api` service!
      await host.runCommand("swarm", "tweak Add background metrics worker service on :4111");
      nextServicesOverlay = [
        {
          name: "metrics-worker",
          start: "npm run start:metrics",
          healthcheck: "curl -sf http://127.0.0.1:4111/ready",
          port: 4111,
          dependsOn: ["api"],
        },
      ];
      host.setIdle(false);
      const tweakRes = await host.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
        title: "API & Metrics Service Mission",
        objective: "Ship API server (:4110) and metrics worker (:4111)",
        strategy: "M1 API + health -> M2 metrics worker",
        acceptance_criteria: "Both services healthy",
        base_branch: "main",
        assertions: [
          {
            id: "VAL-SVC-001",
            title: "API starts cleanly on port 4110",
            description: "API binds 127.0.0.1:4110 without error.",
            evidence_required: "Startup log + curl check",
          },
          {
            id: "VAL-SVC-002",
            title: "GET /health returns 200 JSON status",
            description: "Health endpoint returns { ok: true }.",
            evidence_required: "curl -sf http://127.0.0.1:4110/health output",
          },
        ],
        features: [
          {
            id: "feat-api",
            title: "Implement API server",
            description: "HTTP API server on port 4110",
            milestone: "m1-api",
            files_owned: ["src/api.ts"],
            fulfills: ["VAL-SVC-001"],
          },
          {
            id: "feat-healthcheck",
            title: "Implement /health endpoint",
            description: "Expose GET /health returning { ok: true }",
            milestone: "m1-api",
            depends_on: ["feat-api"],
            files_owned: ["src/health.ts"],
            fulfills: ["VAL-SVC-002"],
          },
        ],
        commands: [{ name: "test", command: "npm test" }],
        services: nextServicesOverlay,
        boundaries: ["Use ports 4100-4199 only"],
      });
      assert.equal(tweakRes.isError, undefined, JSON.stringify(tweakRes));

      const tweakedRun = await store.loadRun(runId);
      assert.deepEqual(
        tweakedRun.services?.map((s) => ({ name: s.name, port: s.port })),
        [
          { name: "api", port: 4110 },
          { name: "metrics-worker", port: 4111 },
        ],
        "Expected /swarm tweak to preserve existing api service and merge metrics-worker",
      );

      // ----------------------------------------------------------------------
      // (2) & (3) Shared Library topics, Audited `[OVERRIDE]` assertion, `/swarm done` vs `/swarm done --force` (`callerRole: "human"`), and Rich Mission Complete Card
      // ----------------------------------------------------------------------
      await store.writeLibraryTopic(
        runId,
        "architecture",
        "# Service Ports\n- api: 4110\n- metrics-worker: 4111\n",
        { actor: "orchestrator" },
      );
      await store.writeLibraryTopic(
        runId,
        "testing",
        "# Integration Checks\nRun `npm test` against isolated ports.\n",
        { actor: "validator" },
      );

      // Mark feat-api completed + VAL-SVC-001 passed via audited OVERRIDE while leaving feat-healthcheck / VAL-SVC-002 pending!
      await store.updateRun(runId, {
        features: [
          {
            ...tweakedRun.features![0]!,
            status: "completed",
            assignedMember: "api-worker",
            mergedCommitSha: "aabbccdd1122",
            updatedAt: "2026-11-24T12:10:00.000Z",
          },
          tweakedRun.features![1]!,
        ],
        assertions: [
          {
            ...tweakedRun.assertions![0]!,
            status: "passed",
            overridden: true,
            overrideJustification:
              "Sandbox container blocks privileged TCP bind check; verified via in-memory socket harness.",
            evidence:
              "[OVERRIDE] Sandbox container blocks privileged TCP bind check; verified via in-memory socket harness.",
            verifiedBy: "orchestrator",
            verifiedByRole: "orchestrator",
            updatedAt: "2026-11-24T12:10:00.000Z",
          },
          tweakedRun.assertions![1]!,
        ],
      });
      await host.runCommand("swarm", `focus ${runId}`);

      // Bare `/swarm done` (without `--force`) warns & blocks cleanly while Goal Gates remain unfinished!
      await host.runCommand("swarm", "done Attempt premature close without force");
      assert.equal(
        (await store.loadRun(runId)).status,
        "active",
        "Bare /swarm done without --force must NOT close unfinished Mission",
      );
      const blockedDoneMsg = host.sentMessages
        .filter(
          (m) =>
            m.message.customType === SWARM_STATUS_CUSTOM_TYPE &&
            (m.message.details as { blockedByGoalGates?: boolean } | undefined)
              ?.blockedByGoalGates === true,
        )
        .pop();
      assert.ok(blockedDoneMsg, "Expected Goal Gate warning on bare /swarm done");
      assert.match(String(blockedDoneMsg.message.content), /\/swarm done --force/);

      // Human CLI `/swarm done --force <summary>` passes `callerRole: "human"` and force-closes cleanly!
      completeRunCalls.length = 0;
      await host.runCommand(
        "swarm",
        "done --force Human emergency release cut with audited override",
      );
      assert.equal(completeRunCalls.length, 1);
      assert.equal(completeRunCalls[0]!.callerRole, "human");
      assert.equal(completeRunCalls[0]!.actor, "human");
      assert.equal(
        completeRunCalls[0]!.summary,
        "Human emergency release cut with audited override",
        "--force flag must be stripped cleanly from completion summary",
      );
      assert.equal((await store.loadRun(runId)).status, "completed");

      // Verify Rich Mission Complete Card surfaces `[OVERRIDE]` audited assertions count + warning note, `Services` count, and `.pi/swarm/runs/<runId>/library/`!
      const cardMsg = host.sentMessages
        .filter(
          (m) =>
            m.message.customType === SWARM_STATUS_CUSTOM_TYPE &&
            (m.message.details as { runId?: string; missionCompleteCard?: boolean } | undefined)
              ?.runId === runId &&
            (m.message.details as { missionCompleteCard?: boolean } | undefined)
              ?.missionCompleteCard === true,
        )
        .pop()!;
      assert.ok(cardMsg, "Expected Rich Mission Complete Card after /swarm done --force");
      const cardText = String(cardMsg.message.content);
      assert.match(cardText, /1 overridden/);
      assert.match(cardText, /\[OVERRIDE\]/);
      assert.match(cardText, /Audited Overrides:.*1 overridden/);
      assert.match(cardText, /Sandbox container blocks privileged TCP bind check/);
      assert.match(cardText, /\*\*Services:\*\* 2 configured.*`api` \(:4110\).*`metrics-worker` \(:4111\)/);
      assert.match(
        cardText,
        new RegExp(
          `\\*\\*Shared Library:\\*\\* \`\\.pi/swarm/runs/${runId}/${SWARM_LIBRARY_DIR}/\` \\(2 topic\\(s\\): \`architecture\\.md\`, \`testing\\.md\`\\)`,
        ),
      );

      const cardDetails = cardMsg.message.details as Record<string, unknown>;
      assert.equal(cardDetails.assertionsPassed, 1);
      assert.equal(cardDetails.assertionsOverridden, 1);
      assert.equal(cardDetails.assertionsTotal, 2);
      assert.equal(cardDetails.servicesCount, 2);
      assert.deepEqual(cardDetails.libraryTopics, ["architecture", "testing"]);
      assert.equal(
        cardDetails.libraryPath,
        `${SWARM_DIR}/${SWARM_RUNS_DIR}/${runId}/${SWARM_LIBRARY_DIR}/`,
      );

      await host.emit("session_shutdown", { reason: "quit" });

      // ----------------------------------------------------------------------
      // (1b) Live Ephemeral Read-Only `transport.spawnMember` Adversarial Review (`hasLivePiModelRuntime` -> `validatorModel` -> killed in `finally`, zero store footprint)
      // ----------------------------------------------------------------------
      const spawnedReviewRequests: SpawnMemberRequest[] = [];
      let reviewerKilledCount = 0;
      const liveSimRuntime = {
        ...createMockModelRuntime(),
        stream: () => {
          throw new Error("Mock transport intercepts before network stream");
        },
      } as unknown as ModelRuntime;

      const liveReviewTransport: ISwarmTransport = {
        async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
          if (request.runId === "draft-contract-review") {
            spawnedReviewRequests.push(request);
            const isFirst = spawnedReviewRequests.length === 1;
            const tracker = createMockPersistentMemberHandle({
              request,
              runInitialTurn: async ({ pushAssistantMessage }) => {
                const verdict = isFirst
                  ? `<gaps_found>{"approved":false,"summary":"Non-existent lint:missing script","findings":[{"severity":"blocking","category":"invalid_command","message":"Command lint:missing does not exist in package.json.","suggestion":"Use npm test instead."}]}</gaps_found>`
                  : `<approved/>`;
                pushAssistantMessage(verdict);
                return {
                  agentId: request.agentId,
                  name: request.name,
                  role: request.role,
                  outcome: "stopped",
                  summary: verdict,
                  tokens: 180,
                  cost: 0.0018,
                };
              },
            });
            const origKill = tracker.handle.kill.bind(tracker.handle);
            tracker.handle.kill = async (reason?: string) => {
              reviewerKilledCount += 1;
              return origKill(reason);
            };
            return tracker.handle;
          }
          return mockTransport.spawnMember(request);
        },
      };

      const liveHost = createMockPiHarness(repoDir, {
        mode: "tui",
        sessionId: "sess-v090-live-review",
        modelRuntime: liveSimRuntime,
      });
      createPiSwarmExtension({
        transportFactory: () => liveReviewTransport,
        settingsLoader: async () => ({
          ...DEFAULT_SWARM_SETTINGS,
          validatorModel: "openai/gpt-5.2",
          validatorThinkingLevel: "high",
          stallWatchdogEnabled: false,
        }),
        questionnaireUI: {
          async askQuestion() {
            return { cancelled: false, isCustom: false };
          },
          async askQuestionnaire() {
            return { cancelled: false, answers: {}, items: [] };
          },
          async confirmProposal(_c, plan) {
            return {
              action: "confirm",
              validatorEnabled: plan.validatorEnabled,
              maxConcurrency: plan.maxConcurrency,
            };
          },
        },
      })(liveHost.pi);
      await liveHost.emit("session_start", { reason: "startup" });

      const runsBeforeLiveReview = (await store.listRuns()).length;
      await liveHost.runCommand("swarm", "Verify live ephemeral adversarial reviewer");
      liveHost.setIdle(false);

      const livePass1 = await liveHost.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
        title: "Live Ephemeral Reviewer Check",
        objective: "Verify package.json script checks",
        strategy: "Single milestone",
        acceptance_criteria: "Tests pass",
        base_branch: "main",
        assertions: [
          {
            id: "VAL-CMD-001",
            title: "Tests pass cleanly",
            description: "Test command exits 0",
          },
        ],
        features: [
          {
            id: "feat-cmd",
            title: "Run check",
            description: "Verify script",
            milestone: "m1",
            fulfills: ["VAL-CMD-001"],
          },
        ],
        commands: [{ name: "lint", command: "npm run lint:missing" }],
      });

      assert.equal(spawnedReviewRequests.length, 1);
      assert.equal(spawnedReviewRequests[0]!.role, "validator");
      assert.equal(spawnedReviewRequests[0]!.workspace, "inherit");
      assert.equal(spawnedReviewRequests[0]!.keepWarm, false);
      assert.equal(spawnedReviewRequests[0]!.modelOverride, "openai/gpt-5.2");
      assert.equal(spawnedReviewRequests[0]!.thinkingLevel, "high");
      assert.equal(
        reviewerKilledCount,
        1,
        "Ephemeral adversarial reviewer handle must be killed/disposed immediately in finally",
      );
      assert.equal(
        (await store.listRuns()).length,
        runsBeforeLiveReview,
        "Ephemeral adversarial reviewer must leave zero footprint in SwarmStore",
      );
      assert.match(String(livePass1.content[0].text), /invalid_command/);

      const livePass2 = await liveHost.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
        title: "Live Ephemeral Reviewer Check",
        objective: "Verify package.json script checks",
        strategy: "Single milestone",
        acceptance_criteria: "Tests pass",
        base_branch: "main",
        assertions: [
          {
            id: "VAL-CMD-001",
            title: "Tests pass cleanly",
            description: "Test command exits 0",
          },
        ],
        features: [
          {
            id: "feat-cmd",
            title: "Run check",
            description: "Verify script",
            milestone: "m1",
            fulfills: ["VAL-CMD-001"],
          },
        ],
        commands: [{ name: "test", command: "npm test" }],
      });
      assert.equal(livePass2.isError, undefined, JSON.stringify(livePass2));
      assert.equal(spawnedReviewRequests.length, 2);
      assert.equal(reviewerKilledCount, 2);
      assert.ok(livePass2.details.runId);

      await liveHost.emit("session_shutdown", { reason: "quit" });
    } finally {
      SwarmEngine.prototype.completeRun = origCompleteRun;
    }
  });
});

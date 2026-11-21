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
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ALL_SWARM_EXTENSION_TOOLS,
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
  SWARM_FOCUS_ENTRY,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_ROSTER_FILE,
  SWARM_RUNS_DIR,
  SWARM_SETTINGS_FILE,
  SWARM_STATE_FILE,
  SWARM_STATUS_KEY,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
  SWARM_WAKEUP_CUSTOM_TYPE,
  SWARM_WIDGET_KEY,
} from "../src/constants.js";
import {
  SWARM_STATUS_CUSTOM_TYPE,
  SWARM_SUBCOMMANDS,
  createPiSwarmExtension,
  parseSwarmCommand,
} from "../src/index.js";
import {
  type AgentTurnResult,
  type IQuestionnaireUI,
  type ISwarmTransport,
  type ModelSwitchResult,
  type PersistentAgentHandle,
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
  terminalInputHandlers: Set<(data: string) => unknown>;
  setModelCalls: Array<{ provider: string; id: string }>;
  thinkingLevelCalls: ThinkingLevel[];
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
  const terminalInputHandlers = new Set<(data: string) => unknown>();
  const setModelCalls: Array<{ provider: string; id: string }> = [];
  const thinkingLevelCalls: ThinkingLevel[] = [];

  let activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  let idle = true;
  let hasPending = false;
  let entrySeq = 0;
  let currentHostModel: Model<Api> | undefined =
    options?.initialHostModel ?? DEFAULT_TEST_MODELS[1];
  let currentThinkingLevel: ThinkingLevel = "medium";
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
    terminalInputHandlers,
    setModelCalls,
    thinkingLevelCalls,
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

    // D. Hot Model Switch via `/swarm model` (role default + null clear + live waiting member) & `swarm{action:"model"}`
    // 1) Set role default persisted to project `.pi/pi-swarm-settings.json`
    await harness.runCommand("swarm", "model worker google/gemini-2.5-pro high");
    const projSettingsPath = path.join(repoDir, ".pi", SWARM_SETTINGS_FILE);
    const saved1 = JSON.parse(await readFile(projSettingsPath, "utf8"));
    assert.equal(saved1.workerModel, "google/gemini-2.5-pro");
    assert.equal(saved1.workerThinkingLevel, "high");

    // 2) Clear role default with `default` -> writes explicit `null` in project JSON!
    await harness.runCommand("swarm", "model worker default");
    const saved2 = JSON.parse(await readFile(projSettingsPath, "utf8"));
    assert.equal(saved2.workerModel, null, "Clearing role default must persist null in project settings");

    // 3) Hot-switch live waiting member via `/swarm model api-1 openai/gpt-5.2 high`
    const api1Tracker = spawnedByName.get("api-1")!;
    const msgCountBeforeSwitch = api1Tracker.conversationMessages.length;
    await harness.runCommand("swarm", "model api-1 openai/gpt-5.2 high");
    assert.equal(api1Tracker.modelSwitches.length, 1);
    assert.deepEqual(api1Tracker.modelSwitches[0], {
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
    assert.ok(harness.terminalInputHandlers.size > 0);
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
    await waitFor(() => trackers.length >= 1 && workerTurnCounter === 1);

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

    // `before_agent_start` injects live user direction highlight into `sections.swarm` once
    const sectionsObj: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      systemPromptOptions: { sections: sectionsObj },
    });
    assert.match(sectionsObj.swarm ?? "", /Live User Direction Update/);
    assert.match(sectionsObj.swarm ?? "", /switch API to v2/);

    // Subsequent turn does not repeat stale humanSteeringText notice
    const sectionsObj2: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      systemPromptOptions: { sections: sectionsObj2 },
    });
    assert.ok(!(sectionsObj2.swarm ?? "").includes("Live User Direction Update"));

    // Verify `/swarm pause` -> `/swarm resume` clears unconsumed `latestHumanDirection` so stale direction doesn't leak
    await harness.emit("input", {
      source: "interactive",
      text: "Stale direction sent right before pause",
    });
    await harness.runCommand("swarm", "pause");
    await harness.runCommand("swarm", "resume");
    const sectionsAfterPause: Record<string, string> = {};
    await harness.emit("before_agent_start", {
      systemPromptOptions: { sections: sectionsAfterPause },
    });
    assert.ok(
      !(sectionsAfterPause.swarm ?? "").includes("Stale direction sent right before pause"),
      "latestHumanDirection must be cleared on /swarm pause",
    );

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

    await harness.executeTool(SWARM_TOOL, { action: "done", summary: "API v2 shipped" });
    await harness.emit("session_shutdown", {});
  });
});

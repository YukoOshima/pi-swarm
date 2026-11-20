import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SWARM_SETTINGS,
  DRAFTING_TOOLS,
  FINAL_AUDIT_MISSION_ID,
  ORCHESTRATOR_TOOLS,
  PROPOSE_SWARM_PLAN_TOOL,
  SWARM_AUDITS_DIR,
  SWARM_BOARD_FILE,
  SWARM_BOARD_POST_TOOL,
  SWARM_DIR,
  SWARM_EVENTS_FILE,
  SWARM_FOCUS_ENTRY,
  SWARM_MISSIONS_FILE,
  SWARM_MODEL_TOOL,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_RUNS_DIR,
  SWARM_STATE_FILE,
  SWARM_STATUS_KEY,
  SWARM_STATUS_TOOL,
  SWARM_VERIFY_TOOL,
  SWARM_WAKEUP_CUSTOM_TYPE,
  SWARM_WIDGET_KEY,
} from "../src/constants.js";
import {
  SWARM_STATUS_CUSTOM_TYPE,
  SWARM_SUBCOMMANDS,
  createPiSwarmExtension,
} from "../src/index.js";
import {
  type AgentTurnResult,
  type BoardMessage,
  type FinalAuditVerdict,
  type FinalValidatorSpawnRequest,
  type ISwarmTransport,
  type MissionReviewVerdict,
  type ModelSwitchResult,
  type PersistentAgentHandle,
  type RosterAgentRole,
  type RosterAgentStatus,
  SwarmProtocolError,
  type SwarmRunState,
  type SwarmSettings,
  type ValidatorSpawnRequest,
  type WorkerSpawnRequest,
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
  intervalMs = 25,
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

// ============================================================================
// Mock Model Catalog & Warm Persistent Handle Builder
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

interface MockWarmHandleTracker {
  agentId: string;
  name: string;
  missionId: string;
  role: RosterAgentRole;
  spawnModel?: string;
  spawnThinkingLevel?: ThinkingLevel;
  wakeCount: number;
  conversationHistory: string[];
  modelSwitches: Array<{ model: string; thinkingLevel?: ThinkingLevel }>;
  killed: boolean;
  killReason?: string;
  aborted: boolean;
  handle: PersistentAgentHandle;
}

function createMockPersistentHandle(spec: {
  agentId: string;
  name: string;
  missionId: string;
  role: RosterAgentRole;
  keepWarm: boolean;
  initialPrompt: string;
  modelOverride?: string;
  thinkingLevel?: ThinkingLevel;
  runInitialTurn: (ctx: {
    getModel: () => string | undefined;
    getThinkingLevel: () => ThinkingLevel | undefined;
    history: readonly string[];
    isAborted: () => boolean;
  }) => Promise<AgentTurnResult>;
  runWakeTurn?: (
    prompt: string,
    ctx: {
      wakeIndex: number;
      getModel: () => string | undefined;
      getThinkingLevel: () => ThinkingLevel | undefined;
      history: readonly string[];
      isAborted: () => boolean;
    },
  ) => Promise<AgentTurnResult>;
  onAbort?: () => void;
}): MockWarmHandleTracker {
  let state: RosterAgentStatus = "working";
  let currentModel: string | undefined = spec.modelOverride;
  let currentThinking: ThinkingLevel | undefined = spec.thinkingLevel;
  let aborted = false;
  let killed = false;
  let killReason: string | undefined;
  let wakeCount = 0;
  const conversationHistory: string[] = [spec.initialPrompt];
  const modelSwitches: Array<{ model: string; thinkingLevel?: ThinkingLevel }> = [];

  const finalizeTurn = (result: AgentTurnResult): AgentTurnResult => {
    if (killed) {
      state = "killed";
    } else if (aborted || result.outcome === "aborted") {
      state = "stopped";
    } else if (result.outcome === "failed" || result.outcome === "rate_limited") {
      state = spec.keepWarm ? "waiting" : "failed";
    } else {
      state = spec.keepWarm ? "waiting" : "stopped";
    }
    return {
      ...result,
      model: result.model ?? currentModel,
    };
  };

  let activeTurn: Promise<AgentTurnResult> = (async () => {
    const res = await spec.runInitialTurn({
      getModel: () => currentModel,
      getThinkingLevel: () => currentThinking,
      history: conversationHistory,
      isAborted: () => aborted || killed,
    });
    return finalizeTurn(res);
  })();

  const handle: PersistentAgentHandle = {
    agentId: spec.agentId,
    name: spec.name,
    missionId: spec.missionId,
    role: spec.role,
    getState: () => state,
    getModel: () => currentModel,
    async wake(prompt: string): Promise<AgentTurnResult> {
      if (killed || state === "killed") {
        throw new SwarmProtocolError(
          "AGENT_KILLED",
          `Agent "${spec.name}" has been killed and cannot be woken.`,
        );
      }
      if (state === "working") {
        throw new SwarmProtocolError(
          "AGENT_NOT_WAITING",
          `Agent "${spec.name}" is already working.`,
        );
      }
      state = "working";
      aborted = false;
      wakeCount += 1;
      tracker.wakeCount = wakeCount;
      conversationHistory.push(prompt);

      const turnPromise = (async () => {
        const res = spec.runWakeTurn
          ? await spec.runWakeTurn(prompt, {
              wakeIndex: wakeCount,
              getModel: () => currentModel,
              getThinkingLevel: () => currentThinking,
              history: conversationHistory,
              isAborted: () => aborted || killed,
            })
          : {
              agentId: spec.agentId,
              name: spec.name,
              missionId: spec.missionId,
              role: spec.role,
              outcome: "completed" as const,
              summary: `Woken turn ${wakeCount} completed on ${currentModel ?? "default"}`,
              model: currentModel,
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
          "AGENT_KILLED",
          `Agent "${spec.name}" has been killed.`,
        );
      }
      if (state === "working") {
        throw new SwarmProtocolError(
          "AGENT_NOT_WAITING",
          `Agent "${spec.name}" is currently working.`,
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

  const tracker: MockWarmHandleTracker = {
    agentId: spec.agentId,
    name: spec.name,
    missionId: spec.missionId,
    role: spec.role,
    spawnModel: spec.modelOverride,
    spawnThinkingLevel: spec.thinkingLevel,
    wakeCount: 0,
    conversationHistory,
    modelSwitches,
    killed: false,
    killReason,
    aborted: false,
    handle,
  };

  return tracker;
}

// ============================================================================
// Mock Pi 1.5.2 Extension Harness (Lifecycle, Models, Branch, Tools & UI)
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
  setSetModelResult: (ok: boolean) => void;
  setSelectHandler: (
    fn: (title: string, choices: string[]) => string | undefined,
  ) => void;
  setConfirmHandler: (fn: (title: string, body: string) => boolean) => void;
  setInputHandler: (fn: (title: string, placeholder?: string) => string | undefined) => void;
  emit: (eventName: string, event: any) => Promise<any[]>;
  runCommand: (name: string, args?: string) => Promise<void>;
  executeTool: (name: string, params: any) => Promise<any>;
}

function createMockPiHarness(
  cwd: string,
  options?: {
    sessionId?: string;
    initialHostModel?: Model<Api>;
    modelRuntime?: ModelRuntime;
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
  let setModelResult = true;

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
      if (!setModelResult) {
        return false;
      }
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
    mode: "rpc",
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

  async function executeTool(name: string, params: any): Promise<any> {
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" is not registered`);
    }
    const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
    return tool.execute(`tc-${Date.now()}`, prepared, undefined, undefined, ctx as any);
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
    setSetModelResult: (ok) => {
      setModelResult = ok;
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
// Integration Test Suite
// ============================================================================

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("pi-swarm full cross-module E2E integration", () => {
  it("runs complete /swarm E2E with 3-Role Models + Warm Board Collaboration + Per-Mission Validator Reject/Wake Fix-Loop + Auto-Kill + Final Validator + Zero-Turn Commands + Teardown", async () => {
    const repoDir = await createTempGitRepo("full-e2e");
    tempDirs.push(repoDir);

    const ORCH_MODEL = "anthropic/claude-opus-4-6";
    const WORKER_MODEL = "anthropic/claude-sonnet-4-5";
    const VALIDATOR_MODEL = "openai/gpt-5.2";

    const testSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      maxConcurrency: 3,
      validatorEnabled: true,
      maxValidationRounds: 3,
      finalValidatorEnabled: true,
      maxFinalAuditRounds: 2,
      autoFixOnAuditFail: true,
      keepWorkersWarm: true,
      autoMergeClean: true,
      autoRebase: true,
      orchestratorModel: ORCH_MODEL,
      orchestratorThinkingLevel: "high",
      workerModel: WORKER_MODEL,
      workerThinkingLevel: "medium",
      validatorModel: VALIDATOR_MODEL,
      validatorThinkingLevel: "high",
    };

    // Track execution facts for assertions
    let activeWorkers = 0;
    let maxParallelWorkers = 0;
    const spawnedWorkersByMission = new Map<string, MockWarmHandleTracker[]>();
    const spawnedWorkerRequests: WorkerSpawnRequest[] = [];
    const spawnedValidatorRequests: ValidatorSpawnRequest[] = [];
    const spawnedFinalValidatorRequests: FinalValidatorSpawnRequest[] = [];
    const m2ReviewedShas: string[] = [];
    let m2ValidatorRounds = 0;
    let m2SawWarmReviewPrompt = false;
    const m3SawM2File = { value: false };
    const m3ReceivedM1Finding = { value: false };

    // Deterministic Wave 1 rendezvous proving M1 & M2 run concurrently
    let notifyM2Spawned!: () => void;
    const m2SpawnedPromise = new Promise<void>((resolve) => {
      notifyM2Spawned = resolve;
    });

    const mockTransport: ISwarmTransport = {
      async spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle> {
        spawnedWorkerRequests.push(request);
        if (request.mission.id === "M2") {
          notifyM2Spawned();
        }

        const tracker = createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: request.mission.id,
          role: "worker",
          keepWarm: request.keepWarm,
          initialPrompt: request.prompt,
          modelOverride: request.modelOverride,
          thinkingLevel: request.thinkingLevel,
          runInitialTurn: async () => {
            activeWorkers += 1;
            maxParallelWorkers = Math.max(maxParallelWorkers, activeWorkers);
            try {
              if (request.mission.id === "M1") {
                await Promise.race([
                  m2SpawnedPromise,
                  new Promise((r) => setTimeout(r, 5_000)),
                ]);
                assert.ok(request.store, "Worker request should carry real SwarmStore");
                await request.store.recordFinding(request.runId, {
                  missionId: "M1",
                  author: request.agentId,
                  title: "Architecture Survey",
                  summary: "Use Engine.compute() contract for integration wiring",
                  details: "Verified src/index.ts baseline; core module should export compute(x) = x * 2.",
                  files: ["src/index.ts"],
                });
                return {
                  agentId: request.agentId,
                  name: request.name,
                  missionId: "M1",
                  role: "worker",
                  outcome: "completed",
                  summary: "Completed read-only survey and recorded Architecture Survey finding.",
                  workerDone: {
                    missionId: "M1",
                    summary: "Survey findings recorded cleanly.",
                  },
                  model: request.modelOverride,
                  tokens: 1200,
                  cost: 0.012,
                };
              }

              if (request.mission.id === "M2") {
                // Wave 1 build: deliberately commit bug (`x * 3`) so Validator Round 1 catches it!
                const targetFile = path.join(request.worktreePath, "src", "core", "engine.ts");
                await mkdir(path.dirname(targetFile), { recursive: true });
                await writeFile(
                  targetFile,
                  "export function compute(x: number): number {\n  return x * 3;\n}\n",
                  "utf8",
                );
                await git(request.worktreePath, ["add", "src/core/engine.ts"]);
                await git(request.worktreePath, [
                  "-c",
                  "user.name=Worker M2",
                  "-c",
                  "user.email=m2@local",
                  "commit",
                  "-m",
                  "feat(core): initial compute engine",
                ]);
                return {
                  agentId: request.agentId,
                  name: request.name,
                  missionId: "M2",
                  role: "worker",
                  outcome: "completed",
                  summary: "Initial src/core/engine.ts committed.",
                  workerDone: {
                    missionId: "M2",
                    summary: "Committed initial core engine",
                    verificationRan: "tsc --noEmit passed",
                  },
                  model: request.modelOverride,
                  tokens: 1800,
                  cost: 0.018,
                };
              }

              if (request.mission.id === "M3") {
                // Wave 2 build: verify M1 survey finding injected & M2 fixed merged file present!
                m3ReceivedM1Finding.value = Boolean(
                  request.systemPromptAppendix?.includes("Architecture Survey") &&
                    request.systemPromptAppendix?.includes("Engine.compute()"),
                );
                const enginePath = path.join(request.worktreePath, "src", "core", "engine.ts");
                if (await pathExists(enginePath)) {
                  const content = await readFile(enginePath, "utf8");
                  m3SawM2File.value = content.includes("return x * 2;");
                }

                const targetFile = path.join(
                  request.worktreePath,
                  "src",
                  "integration",
                  "wiring.ts",
                );
                await mkdir(path.dirname(targetFile), { recursive: true });
                await writeFile(
                  targetFile,
                  'import { compute } from "../core/engine.js";\nexport const RESULT = compute(21);\n',
                  "utf8",
                );
                await git(request.worktreePath, ["add", "src/integration/wiring.ts"]);
                await git(request.worktreePath, [
                  "-c",
                  "user.name=Worker M3",
                  "-c",
                  "user.email=m3@local",
                  "commit",
                  "-m",
                  "feat(integration): wire compute engine",
                ]);
                return {
                  agentId: request.agentId,
                  name: request.name,
                  missionId: "M3",
                  role: "worker",
                  outcome: "completed",
                  summary: "Wired integration layer using M2 engine & M1 survey findings.",
                  workerDone: {
                    missionId: "M3",
                    summary: "Integration complete",
                    verificationRan: "tests passed",
                  },
                  model: request.modelOverride,
                  tokens: 1600,
                  cost: 0.016,
                };
              }

              throw new Error(`Unexpected mission ${request.mission.id}`);
            } finally {
              activeWorkers -= 1;
            }
          },
          runWakeTurn: async (wakePrompt) => {
            if (request.mission.id === "M2") {
              m2SawWarmReviewPrompt =
                wakePrompt.includes("compute multiplies by 3 instead of 2") ||
                wakePrompt.includes("review");
              const targetFile = path.join(request.worktreePath, "src", "core", "engine.ts");
              await writeFile(
                targetFile,
                "export function compute(x: number): number {\n  return x * 2;\n}\n",
                "utf8",
              );
              await git(request.worktreePath, ["add", "src/core/engine.ts"]);
              await git(request.worktreePath, [
                "-c",
                "user.name=Worker M2",
                "-c",
                "user.email=m2@local",
                "commit",
                "-m",
                "fix(core): multiply by 2 per validation finding",
              ]);
              return {
                agentId: request.agentId,
                name: request.name,
                missionId: "M2",
                role: "worker",
                outcome: "completed",
                summary: "Fixed compute() multiplier bug in warm M2 session.",
                workerDone: {
                  missionId: "M2",
                  summary: "Fixed multiplier bug cleanly",
                  verificationRan: "compute(21) === 42",
                },
                model: request.modelOverride,
                tokens: 900,
                cost: 0.009,
              };
            }
            throw new Error(`Unexpected warm wake for ${request.mission.id}`);
          },
        });

        const list = spawnedWorkersByMission.get(request.mission.id) ?? [];
        list.push(tracker);
        spawnedWorkersByMission.set(request.mission.id, list);
        return tracker.handle;
      },

      async spawnValidator(request: ValidatorSpawnRequest): Promise<PersistentAgentHandle> {
        spawnedValidatorRequests.push(request);
        const tracker = createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: request.mission.id,
          role: "validator",
          keepWarm: false,
          initialPrompt: request.prompt,
          modelOverride: request.modelOverride,
          thinkingLevel: request.thinkingLevel,
          runInitialTurn: async () => {
            assert.ok(request.targetCommitSha, "Validator must be pinned to exact tip SHA");
            const actualTip = await git(request.worktreePath, ["rev-parse", "HEAD"]);
            assert.equal(request.targetCommitSha, actualTip);

            if (request.mission.id === "M2") {
              m2ValidatorRounds += 1;
              m2ReviewedShas.push(actualTip);

              if (m2ValidatorRounds === 1) {
                const verdict: MissionReviewVerdict = {
                  commitSha: actualTip,
                  missionId: "M2",
                  branch: request.branch,
                  reviewedAt: new Date().toISOString(),
                  reviewerAgentId: request.agentId,
                  status: "p1-1items",
                  merge: "fix-then-merge",
                  findings: [
                    {
                      severity: "p1",
                      title: "Wrong multiplier",
                      detail: "compute multiplies by 3 instead of 2",
                      file: "src/core/engine.ts",
                      line: 2,
                    },
                  ],
                  checks: [{ name: "compute-contract", passed: false }],
                  decision: "Fix P1 multiplier bug before merge",
                  round: 1,
                };
                return {
                  agentId: request.agentId,
                  name: request.name,
                  missionId: "M2",
                  role: "validator",
                  outcome: "completed",
                  summary: verdict.decision,
                  reviewVerdict: verdict,
                  model: request.modelOverride,
                  tokens: 500,
                  cost: 0.005,
                };
              }
            }

            const verdict: MissionReviewVerdict = {
              commitSha: actualTip,
              missionId: request.mission.id,
              branch: request.branch,
              reviewedAt: new Date().toISOString(),
              reviewerAgentId: request.agentId,
              status: "clean",
              merge: "merge",
              findings: [],
              checks: [{ name: "scope-and-diff", passed: true }],
              decision: `Approved ${request.mission.id} at ${actualTip.slice(0, 7)}`,
              round: request.mission.id === "M2" ? m2ValidatorRounds : 1,
            };

            return {
              agentId: request.agentId,
              name: request.name,
              missionId: request.mission.id,
              role: "validator",
              outcome: "completed",
              summary: verdict.decision,
              reviewVerdict: verdict,
              model: request.modelOverride,
              tokens: 550,
              cost: 0.0055,
            };
          },
        });
        return tracker.handle;
      },

      async spawnFinalValidator(
        request: FinalValidatorSpawnRequest,
      ): Promise<PersistentAgentHandle> {
        spawnedFinalValidatorRequests.push(request);
        const tracker = createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          keepWarm: false,
          initialPrompt: request.prompt,
          modelOverride: request.modelOverride,
          thinkingLevel: request.thinkingLevel,
          runInitialTurn: async () => {
            const actualMainHead = await git(repoDir, ["rev-parse", "HEAD"]);
            assert.equal(request.targetCommitSha, actualMainHead);
            assert.equal(await pathExists(path.join(repoDir, "src", "core", "engine.ts")), true);
            assert.equal(
              await pathExists(path.join(repoDir, "src", "integration", "wiring.ts")),
              true,
            );

            const verdict: FinalAuditVerdict = {
              commitSha: actualMainHead,
              baseBranch: "main",
              auditedAt: new Date().toISOString(),
              verifierAgentId: request.agentId,
              verdict: "approved",
              summary: "Verified integrated engine.ts and wiring.ts on main.",
              checks: [
                { name: "engine-compute", passed: true },
                { name: "integration-wiring", passed: true },
              ],
              findings: [],
              round: request.round,
            };
            return {
              agentId: request.agentId,
              name: request.name,
              missionId: FINAL_AUDIT_MISSION_ID,
              role: "final-validator",
              outcome: "completed",
              summary: verdict.summary,
              finalAuditVerdict: verdict,
              model: request.modelOverride,
              tokens: 600,
              cost: 0.006,
            };
          },
        });
        return tracker.handle;
      },
    };

    const harness = createMockPiHarness(repoDir);
    let transportCreatedCount = 0;

    const ext = createPiSwarmExtension({
      transportFactory: () => {
        transportCreatedCount += 1;
        return mockTransport;
      },
      settingsLoader: async () => testSettings,
    });

    // 1. Factory body must NOT start timers/subprocesses/transport or touch filesystem
    ext(harness.pi);
    assert.equal(transportCreatedCount, 0, "Factory body must defer transport creation");
    assert.equal(await pathExists(path.join(repoDir, SWARM_DIR)), false);
    assert.equal(harness.tools.size, DRAFTING_TOOLS.length + ORCHESTRATOR_TOOLS.length);
    assert.equal(harness.tools.size, 15, "Must register exactly 15 extension tools");
    assert.deepEqual(
      Array.from(harness.commands.keys()).sort(),
      ["swarm", "swarm-direct"],
      "Must register ONLY /swarm and /swarm-direct commands",
    );

    // 2. session_start binds authoritative ctx.cwd, syncs idle profile, mounts widget
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(transportCreatedCount, 1);
    assert.ok(harness.pi.getActiveTools().includes(SWARM_STATUS_TOOL));
    assert.equal(harness.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL), false);
    assert.equal(harness.pi.getActiveTools().includes("swarm_merge"), false);
    assert.ok(
      harness.widgetHistory.some((w) => w.key === SWARM_WIDGET_KEY && typeof w.value === "function"),
    );

    // 3. `/swarm Build feature X` -> applies orchestratorModel via pi.setModel & swaps to 3 DRAFTING_TOOLS
    await harness.runCommand("swarm", "Build feature X with core and integration layers");
    assert.ok(
      harness.setModelCalls.some(
        (m) => m.provider === "anthropic" && m.id === "claude-opus-4-6",
      ),
      "Orchestrator model must be applied via pi.setModel on /swarm <goal>",
    );
    assert.ok(
      harness.thinkingLevelCalls.includes("high"),
      "Orchestrator thinking level must be applied via pi.setThinkingLevel",
    );
    for (const draftTool of DRAFTING_TOOLS) {
      assert.ok(harness.pi.getActiveTools().includes(draftTool), `Expected ${draftTool} active`);
    }
    assert.equal(harness.pi.getActiveTools().includes("swarm_merge"), false);
    assert.ok(harness.pi.getActiveTools().includes("read"), "Host tools must be preserved");
    assert.equal(harness.sentUserMessages.length, 1);
    assert.match(String(harness.sentUserMessages[0]!.content), /swarm_drafting_kickoff/);

    // Verify before_agent_start injects drafting addendum into `sections.swarm` (never rewrites systemPrompt!)
    const draftPromptEvent = {
      type: "before_agent_start",
      messageType: "user",
      prompt: "kickoff",
      systemPrompt: "BASE SYSTEM PROMPT",
      systemPromptOptions: { sections: {} as Record<string, string> },
    };
    const draftHookResults = await harness.emit("before_agent_start", draftPromptEvent);
    assert.equal(draftHookResults[0], undefined, "Must NOT return systemPrompt replacement");
    assert.match(draftPromptEvent.systemPromptOptions.sections.swarm ?? "", /swarm_drafting_active/);

    // 4. `swarm_questionnaire` -> answers cleanly via RPC select
    harness.setSelectHandler((_title, choices) => choices[0]);
    const qRes = await harness.executeTool(SWARM_QUESTIONNAIRE_TOOL, {
      questions: [
        {
          id: "api_style",
          question: "Preferred export style?",
          options: [
            { label: "Named ESM exports", value: "esm_named" },
            { label: "Default export", value: "default" },
          ],
          recommended: "esm_named",
        },
      ],
    });
    assert.equal(qRes.isError, undefined);
    assert.equal(qRes.details.answers.api_style, "esm_named");

    // 5. `propose_swarm_plan` -> Confirm -> swaps to 12 ORCHESTRATOR_TOOLS & launches fleet!
    harness.setSelectHandler((_title, choices) => {
      const confirm = choices.find((c) => c.startsWith("Confirm"));
      return confirm ?? choices[0];
    });
    const proposeRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      objective: "Build feature X with core and integration layers",
      base_branch: "main",
      max_concurrency: 3,
      validator_enabled: true,
      final_validator_enabled: true,
      verification_contract: "src/core/engine.ts compute(x)=x*2 and src/integration/wiring.ts RESULT=42",
      missions: [
        {
          id: "M1",
          title: "Survey existing architecture",
          kind: "survey",
          description: "Inspect repository baseline and record integration contract.",
          scope: ["src/"],
          deps: [],
          verification: "Record Architecture Survey finding with zero diff.",
        },
        {
          id: "M2",
          title: "Implement core engine",
          kind: "build",
          description: "Create src/core/engine.ts exporting compute(x) = x * 2.",
          scope: ["src/core/"],
          deps: [],
          verification: "Unit checks pass for src/core/engine.ts.",
        },
        {
          id: "M3",
          title: "Wire integration layer",
          kind: "build",
          description: "Create src/integration/wiring.ts consuming compute().",
          scope: ["src/integration/"],
          deps: ["M1", "M2"],
          verification: "Integration module imports engine cleanly.",
        },
      ],
    });

    assert.equal(proposeRes.isError, undefined);
    assert.equal(proposeRes.terminate, true);
    assert.equal(proposeRes.details.outcome, "confirmed");
    const runId: string = proposeRes.details.runId;
    assert.ok(runId);

    // Tool profile swapped cleanly to all 12 orchestrator tools
    for (const orchTool of ORCHESTRATOR_TOOLS) {
      assert.ok(harness.pi.getActiveTools().includes(orchTool), `Expected ${orchTool} active`);
    }
    assert.equal(harness.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL), false);

    // Focus entry recorded on session branch
    const focusEntries = harness.branch.filter((e) => e.customType === SWARM_FOCUS_ENTRY);
    assert.ok(focusEntries.length >= 1);
    assert.equal((focusEntries[focusEntries.length - 1]!.data as { runId: string }).runId, runId);

    // .git/info/exclude protects .pi/swarm/
    const excludeText = await readFile(path.join(repoDir, ".git", "info", "exclude"), "utf8");
    assert.match(excludeText, /\.pi\/swarm\//);

    // 6. Wait for full Wave 1 -> Warm Fix-Loop -> Merge -> Wave 2 -> Final Validator -> Completed!
    const runDir = path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, runId);
    const statePath = path.join(runDir, SWARM_STATE_FILE);
    let finalState!: SwarmRunState;
    await waitFor(async () => {
      if (!(await pathExists(statePath))) return false;
      finalState = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
      return finalState.status === "completed";
    });

    // Verify 3-Role Models routed cleanly to every role!
    assert.equal(spawnedWorkerRequests.length, 3, "M1, M2, M3 each spawned ONCE (M2 woken warm!)");
    for (const req of spawnedWorkerRequests) {
      assert.equal(req.modelOverride, WORKER_MODEL, `Worker ${req.mission.id} must receive workerModel`);
      assert.equal(req.thinkingLevel, "medium");
    }
    assert.equal(spawnedValidatorRequests.length, 3, "M2 validated twice (R1 reject, R2 pass) + M3 once");
    for (const req of spawnedValidatorRequests) {
      assert.equal(
        req.modelOverride,
        VALIDATOR_MODEL,
        `Validator for ${req.mission.id} must receive validatorModel`,
      );
      assert.equal(req.thinkingLevel, "high");
    }
    assert.equal(spawnedFinalValidatorRequests.length, 1);
    assert.equal(
      spawnedFinalValidatorRequests[0]!.modelOverride,
      VALIDATOR_MODEL,
      "Final Validator must receive validatorModel",
    );
    assert.equal(spawnedFinalValidatorRequests[0]!.thinkingLevel, "high");

    // Verify Wave 1 parallel execution & M2 warm board wake (spawnCount === 1, wakeCount === 1!)
    assert.ok(maxParallelWorkers >= 2, `Expected Wave 1 parallel execution, got max=${maxParallelWorkers}`);
    const m2Trackers = spawnedWorkersByMission.get("M2") ?? [];
    assert.equal(m2Trackers.length, 1, "M2 must spawn ONCE and reuse warm session on fix round");
    assert.equal(m2Trackers[0]!.wakeCount, 1, "M2 warm handle must be woken ONCE by Validator reject");
    assert.equal(m2Trackers[0]!.conversationHistory.length, 2, "M2 warm session preserves full history");
    assert.equal(m2SawWarmReviewPrompt, true, "M2 warm wake prompt must include P1 review feedback");
    assert.notEqual(m2ReviewedShas[0], m2ReviewedShas[1], "Validator R2 must pin new fixed tip SHA");

    // Verify M2 warm handle was auto-killed upon merge!
    assert.equal(m2Trackers[0]!.handle.getState(), "killed", "M2 warm handle must auto-kill on merge");
    assert.equal(finalState.roster[m2Trackers[0]!.agentId]?.status, "killed");

    // Verify M3 received M1 findings and M2 fixed code!
    assert.equal(m3ReceivedM1Finding.value, true, "Wave 2 M3 must receive M1 survey findings");
    assert.equal(m3SawM2File.value, true, "Wave 2 M3 worktree must contain M2 fixed merged code");

    // Verify all 3 missions merged + Final Validator approved
    assert.equal(finalState.missions.M1!.status, "merged");
    assert.equal(finalState.missions.M2!.status, "merged");
    assert.equal(finalState.missions.M3!.status, "merged");
    assert.equal(finalState.finalAuditStatus, "approved");
    assert.equal(finalState.roleModels?.orchestrator?.model, ORCH_MODEL);
    assert.equal(finalState.roleModels?.worker?.model, WORKER_MODEL);
    assert.equal(finalState.roleModels?.validator?.model, VALIDATOR_MODEL);

    // Verify real files & real --no-ff merge commits exist on `main`!
    const mergedEngine = await readFile(path.join(repoDir, "src", "core", "engine.ts"), "utf8");
    assert.match(mergedEngine, /return x \* 2;/);
    assert.equal(await pathExists(path.join(repoDir, "src", "integration", "wiring.ts")), true);
    const mergeLog = await git(repoDir, ["log", "--merges", "--oneline"]);
    assert.match(mergeLog, /swarm\(M2\):/);
    assert.match(mergeLog, /swarm\(M3\):/);

    // Verify coalesced wakeup message was emitted ONCE with triggerTurn: true
    await waitFor(() =>
      harness.sentMessages.some((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE),
    );
    const wakeups = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    );
    assert.equal(wakeups.length, 1, "run_finished + wakeup_needed must coalesce into 1 wakeup");
    assert.equal(wakeups[0]!.options?.triggerTurn, true);
    assert.equal(wakeups[0]!.options?.deliverAs, "followUp");

    // Verify before_agent_start injects Orchestrator summary into `sections.swarm`
    const orchPromptEvent = {
      type: "before_agent_start",
      messageType: "custom",
      systemPrompt: "BASE SYSTEM PROMPT",
      systemPromptOptions: { sections: {} as Record<string, string> },
    };
    await harness.emit("before_agent_start", orchPromptEvent);
    assert.match(orchPromptEvent.systemPromptOptions.sections.swarm ?? "", new RegExp(runId));

    // 7. Zero-LLM-turn `/swarm board`, `/swarm models`, `/swarm status`!
    const userMsgCountBeforeZeroTurn = harness.sentUserMessages.length;

    await harness.runCommand("swarm", "board");
    const boardMsg = harness.sentMessages
      .filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
      .at(-1)!;
    assert.equal(boardMsg.options?.triggerTurn, false);
    assert.match(String(boardMsg.message.content), /Swarm Board/);
    assert.match(String(boardMsg.message.content), /@M2/);

    await harness.runCommand("swarm", "models");
    const modelsMsg = harness.sentMessages
      .filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
      .at(-1)!;
    assert.equal(modelsMsg.options?.triggerTurn, false);
    const modelsText = String(modelsMsg.message.content);
    assert.match(modelsText, /Swarm 3-Role Models/);
    assert.match(modelsText, new RegExp(ORCH_MODEL));
    assert.match(modelsText, new RegExp(WORKER_MODEL));
    assert.match(modelsText, new RegExp(VALIDATOR_MODEL));

    await harness.runCommand("swarm", "status");
    const statusMsg = harness.sentMessages
      .filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
      .at(-1)!;
    assert.equal(statusMsg.options?.triggerTurn, false);
    const statusText = String(statusMsg.message.content);
    assert.match(statusText, new RegExp(runId));
    assert.match(statusText, /3\/3 merged/);
    assert.match(statusText, /### Final Verification/);

    assert.equal(
      harness.sentUserMessages.length,
      userMsgCountBeforeZeroTurn,
      "/swarm board, /swarm models, /swarm status must trigger ZERO LLM turns",
    );

    // 8. Verify board.jsonl, MISSIONS.md, and ZERO duplicate ledger events on disk!
    const boardLines = (await readFile(path.join(runDir, SWARM_BOARD_FILE), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as BoardMessage);
    assert.ok(boardLines.length >= 2, "board.jsonl should record review & board activity");
    assert.ok(boardLines.some((m) => m.text.includes("@M2") && m.kind === "review"));
    for (let i = 0; i < boardLines.length; i++) {
      assert.equal(boardLines[i]!.seq, i + 1, "board.jsonl seq must be strictly monotonic 1..N");
    }

    const missionsMd = await readFile(path.join(runDir, SWARM_MISSIONS_FILE), "utf8");
    assert.match(missionsMd, /# Swarm Missions/);
    assert.match(missionsMd, /## Final Verification/);
    assert.match(missionsMd, new RegExp(WORKER_MODEL));

    const rawEvents = (await readFile(path.join(runDir, SWARM_EVENTS_FILE), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    const countType = (type: string) => rawEvents.filter((e) => e.type === type).length;
    assert.equal(countType("run_created"), 1);
    assert.equal(countType("worker_spawned"), 3);
    assert.equal(countType("agent_woken"), 1);
    assert.equal(countType("validator_spawned"), 3);
    assert.equal(countType("validation_submitted"), 3);
    assert.equal(countType("merge_succeeded"), 3);
    assert.equal(countType("final_audit_started"), 1);
    assert.equal(countType("final_audit_result"), 1);
    assert.equal(countType("run_completed"), 1);

    // 9. `/swarm teardown` cleanly removes worktrees while preserving audit/board trail & main commits!
    const wtM1 = finalState.missions.M1!.worktreePath;
    const wtM2 = finalState.missions.M2!.worktreePath;
    const wtM3 = finalState.missions.M3!.worktreePath;
    assert.equal(await pathExists(wtM2), true);

    await harness.runCommand("swarm", "teardown");
    assert.equal(await pathExists(wtM1), false, "wt-M1 should be removed");
    assert.equal(await pathExists(wtM2), false, "wt-M2 should be removed");
    assert.equal(await pathExists(wtM3), false, "wt-M3 should be removed");

    assert.equal(await pathExists(path.join(runDir, SWARM_STATE_FILE)), true);
    assert.equal(await pathExists(path.join(runDir, SWARM_BOARD_FILE)), true);
    assert.equal(await pathExists(path.join(runDir, SWARM_MISSIONS_FILE)), true);
    assert.equal(await pathExists(path.join(runDir, SWARM_EVENTS_FILE)), true);
    assert.equal(await pathExists(path.join(repoDir, "src", "core", "engine.ts")), true);
    assert.equal(await pathExists(path.join(repoDir, "src", "integration", "wiring.ts")), true);

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("supports /swarm model role default updates (orchestrator/worker/validator + persistence), graceful auth warning, and hot-switching a warm waiting agent preserving full conversation history", async () => {
    const repoDir = await createTempGitRepo("hot-model-switch");
    tempDirs.push(repoDir);

    let effectiveSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      maxConcurrency: 2,
      validatorEnabled: false,
      finalValidatorEnabled: false,
      keepWorkersWarm: true,
      autoMergeClean: true,
      workerModel: "anthropic/claude-sonnet-4-5",
    };
    const savedPatches: Array<{ scope: "global" | "project"; patch: Partial<SwarmSettings> }> = [];
    let m1Tracker: MockWarmHandleTracker | undefined;
    let m1WakeObservedModel: string | undefined;

    const mockTransport: ISwarmTransport = {
      async spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: request.mission.id,
          role: "worker",
          keepWarm: request.keepWarm,
          initialPrompt: request.prompt,
          modelOverride: request.modelOverride,
          thinkingLevel: request.thinkingLevel,
          runInitialTurn: async () => {
            const target = path.join(request.worktreePath, "docs", "spec.md");
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, "# Architecture Spec\n\nReady for sign-off.\n", "utf8");
            await git(request.worktreePath, ["add", "docs/spec.md"]);
            await git(request.worktreePath, [
              "-c",
              "user.name=Worker M1",
              "-c",
              "user.email=m1@local",
              "commit",
              "-m",
              "docs(spec): draft architecture spec",
            ]);
            return {
              agentId: request.agentId,
              name: request.name,
              missionId: request.mission.id,
              role: "worker",
              outcome: "completed",
              summary: "Drafted docs/spec.md; parked waiting warm for sign-off or edits.",
              workerDone: {
                missionId: request.mission.id,
                summary: "Spec drafted",
              },
              model: request.modelOverride,
              tokens: 500,
              cost: 0.005,
            };
          },
          runWakeTurn: async (_prompt, ctx) => {
            m1WakeObservedModel = ctx.getModel();
            return {
              agentId: request.agentId,
              name: request.name,
              missionId: request.mission.id,
              role: "worker",
              outcome: "completed",
              summary: `Confirmed spec exports on switched model ${ctx.getModel()}`,
              model: ctx.getModel(),
              tokens: 200,
              cost: 0.002,
            };
          },
        });
        m1Tracker = tracker;
        return tracker.handle;
      },
      async spawnValidator(): Promise<PersistentAgentHandle> {
        throw new Error("Validator should not spawn when validatorEnabled=false");
      },
    };

    const harness = createMockPiHarness(repoDir, { sessionId: "sess-models" });
    createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => effectiveSettings,
      settingsSaver: async (scope, patch) => {
        savedPatches.push({ scope, patch });
        effectiveSettings = { ...effectiveSettings, ...patch };
        return effectiveSettings;
      },
    })(harness.pi);

    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    // Launch an `artifact` mission so M1 completes its commit and parks in `waiting` warm state
    await harness.runCommand("swarm-direct", "Draft architecture spec artifact");
    const proposeRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      objective: "Draft architecture spec artifact",
      base_branch: "main",
      validator_enabled: false,
      final_validator_enabled: false,
      verification_contract: "docs/spec.md approved by human",
      missions: [
        {
          id: "M1",
          title: "Draft architecture spec",
          kind: "artifact",
          description: "Write docs/spec.md for human sign-off.",
          scope: ["docs/"],
          deps: [],
          verification: "docs/spec.md exists",
        },
      ],
    });
    const runId: string = proposeRes.details.runId;
    const runDir = path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, runId);
    const statePath = path.join(runDir, SWARM_STATE_FILE);

    // Wait until M1 completes and parks in `waiting` warm state!
    await waitFor(async () => {
      if (!m1Tracker || m1Tracker.handle.getState() !== "waiting") return false;
      const st = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
      return st.missions.M1?.status === "completed" && st.roster[m1Tracker.agentId]?.status === "waiting";
    });

    // 1. Update role defaults via `/swarm model <role> <model> [thinking]`
    const userMsgsBefore = harness.sentUserMessages.length;

    await harness.runCommand("swarm", "model worker google/gemini-2.5-pro low");
    assert.equal(effectiveSettings.workerModel, "google/gemini-2.5-pro");
    assert.equal(effectiveSettings.workerThinkingLevel, "low");

    await harness.runCommand("swarm", "model validator anthropic/claude-opus-4-6 high");
    assert.equal(effectiveSettings.validatorModel, "anthropic/claude-opus-4-6");
    assert.equal(effectiveSettings.validatorThinkingLevel, "high");

    await harness.runCommand("swarm", "model orchestrator openai/gpt-5.2 medium");
    assert.equal(effectiveSettings.orchestratorModel, "openai/gpt-5.2");
    assert.equal(effectiveSettings.orchestratorThinkingLevel, "medium");
    assert.ok(
      harness.setModelCalls.some((m) => m.provider === "openai" && m.id === "gpt-5.2"),
      "/swarm model orchestrator must call pi.setModel",
    );
    assert.equal(harness.thinkingLevelCalls.at(-1), "medium");

    // Verify run's persisted `roleModels` synced cleanly
    let st = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
    assert.equal(st.roleModels?.worker?.model, "google/gemini-2.5-pro");
    assert.equal(st.roleModels?.validator?.model, "anthropic/claude-opus-4-6");
    assert.equal(st.roleModels?.orchestrator?.model, "openai/gpt-5.2");

    // 2. Test graceful warning (no crash!) when `pi.setModel` returns false (unconfigured auth)
    harness.setSetModelResult(false);
    const warningsBefore = harness.notifications.filter((n) => n.level === "warning").length;
    await harness.runCommand("swarm", "model orchestrator anthropic/claude-opus-4-6 high");
    const warningsAfter = harness.notifications.filter((n) => n.level === "warning").length;
    assert.ok(warningsAfter > warningsBefore, "Must emit warning when pi.setModel returns false");
    harness.setSetModelResult(true);

    // 3. Test clearing a role default back to host default via `default`
    await harness.runCommand("swarm", "model orchestrator default");
    assert.equal(effectiveSettings.orchestratorModel, undefined);

    // 4. Test `swarm_model` tool callback `onRoleModelChanged("orchestrator", ...)`
    const toolRes = await harness.executeTool(SWARM_MODEL_TOOL, {
      target: "orchestrator",
      model: "anthropic/claude-opus-4-6",
      thinking_level: "high",
      reason: "complex architecture decision",
    });
    assert.equal(toolRes.isError, undefined);
    assert.equal(effectiveSettings.orchestratorModel, "anthropic/claude-opus-4-6");
    assert.ok(
      harness.setModelCalls.some((m) => m.provider === "anthropic" && m.id === "claude-opus-4-6"),
    );

    // 5. Hot-switch live warm `waiting` agent M1 via `/swarm model M1 google/gemini-2.5-pro high`!
    assert.equal(m1Tracker!.conversationHistory.length, 1);
    await harness.runCommand("swarm", "model M1 google/gemini-2.5-pro high");
    assert.equal(m1Tracker!.handle.getModel(), "google/gemini-2.5-pro");
    assert.equal(m1Tracker!.modelSwitches.length, 1);
    assert.equal(m1Tracker!.handle.getState(), "waiting", "Agent must remain parked warm after switch");
    assert.equal(
      m1Tracker!.conversationHistory.length,
      1,
      "Hot model switch must preserve prior conversation history",
    );

    // Verify `/swarm models` zero-turn view reflects M1's new live model
    await harness.runCommand("swarm", "models");
    const modelsView = String(
      harness.sentMessages
        .filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
        .at(-1)!.message.content,
    );
    assert.match(modelsView, /google\/gemini-2\.5-pro/);
    assert.equal(harness.sentUserMessages.length, userMsgsBefore, "All /swarm model(s) commands are zero-turn");

    // 6. Wake M1 via `swarm_board_post("@M1 ...")` and verify it runs turn 2 on the NEW model with full history!
    const postRes = await harness.executeTool(SWARM_BOARD_POST_TOOL, {
      text: "@M1 double-check spec headings before sign-off",
      kind: "chat",
    });
    assert.equal(postRes.isError, undefined);

    await waitFor(async () => {
      if (m1Tracker!.wakeCount !== 1 || m1Tracker!.handle.getState() !== "waiting") {
        return false;
      }
      const latest = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
      return latest.roster[m1Tracker!.agentId]?.status === "waiting";
    });
    assert.equal(m1WakeObservedModel, "google/gemini-2.5-pro");
    assert.equal(
      m1Tracker!.conversationHistory.length,
      2,
      "Warm M1 retained initial prompt + board wake prompt across hot model switch",
    );

    // Verify ledger & board recorded the model switch
    const events = (await readFile(path.join(runDir, SWARM_EVENTS_FILE), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });
    assert.equal(events.filter((e) => e.type === "agent_model_switched").length, 1);

    // 7. Human signs off artifact via `/swarm approve M1` -> merges & completes run!
    await harness.runCommand("swarm", "approve M1");
    await waitFor(async () => {
      st = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
      return st.status === "completed";
    });
    assert.equal(await pathExists(path.join(repoDir, "docs", "spec.md")), true);
    assert.ok(savedPatches.length >= 4);

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("runs full Post-Merge Final Validator + Auto-Remediation E2E (M1 -> merge -> verifying R1 disapproved -> auto-plan F1 -> merge -> R2 approved -> completed)", async () => {
    const repoDir = await createTempGitRepo("final-validator-autofix");
    tempDirs.push(repoDir);

    const testSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      maxConcurrency: 2,
      validatorEnabled: true,
      maxValidationRounds: 2,
      finalValidatorEnabled: true,
      maxFinalAuditRounds: 2,
      autoFixOnAuditFail: true,
      keepWorkersWarm: true,
      autoMergeClean: true,
      autoRebase: true,
      validatorModel: "openai/gpt-5.2",
    };

    const spawnedWorkerMissions: string[] = [];
    const validatedMissions: string[] = [];
    const finalValidatorRequests: FinalValidatorSpawnRequest[] = [];
    let f1SawM1MergedFile = false;
    let round1SawVerifyingOnDisk = false;
    let round2SawFixFileOnMain = false;

    let notifyRound1Started!: () => void;
    const round1StartedPromise = new Promise<void>((resolve) => {
      notifyRound1Started = resolve;
    });
    let releaseRound1!: () => void;
    const round1ReleasePromise = new Promise<void>((resolve) => {
      releaseRound1 = resolve;
    });

    const mockTransport: ISwarmTransport = {
      async spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle> {
        spawnedWorkerMissions.push(request.mission.id);
        return createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: request.mission.id,
          role: "worker",
          keepWarm: request.keepWarm,
          initialPrompt: request.prompt,
          modelOverride: request.modelOverride,
          runInitialTurn: async () => {
            if (request.mission.id === "M1") {
              const coreFile = path.join(request.worktreePath, "src", "core", "calc.ts");
              await mkdir(path.dirname(coreFile), { recursive: true });
              await writeFile(
                coreFile,
                "export const double = (n: number): number => n * 2;\n",
                "utf8",
              );
              await git(request.worktreePath, ["add", "src/core/calc.ts"]);
              await git(request.worktreePath, [
                "-c",
                "user.name=Worker M1",
                "-c",
                "user.email=m1@local",
                "commit",
                "-m",
                "feat(core): add double helper",
              ]);
              return {
                agentId: request.agentId,
                name: request.name,
                missionId: "M1",
                role: "worker",
                outcome: "completed",
                summary: "Implemented src/core/calc.ts.",
                workerDone: {
                  missionId: "M1",
                  summary: "Added double helper",
                  verificationRan: "tsc --noEmit passed",
                },
                tokens: 900,
                cost: 0.009,
              };
            }

            if (request.mission.id === "F1") {
              f1SawM1MergedFile = await pathExists(
                path.join(request.worktreePath, "src", "core", "calc.ts"),
              );
              const exportFile = path.join(request.worktreePath, "src", "index-export.ts");
              await writeFile(
                exportFile,
                'export { double } from "./core/calc.js";\n',
                "utf8",
              );
              await git(request.worktreePath, ["add", "src/index-export.ts"]);
              await git(request.worktreePath, [
                "-c",
                "user.name=Worker F1",
                "-c",
                "user.email=f1@local",
                "commit",
                "-m",
                "fix(export): add public integration export",
              ]);
              return {
                agentId: request.agentId,
                name: request.name,
                missionId: "F1",
                role: "worker",
                outcome: "completed",
                summary: "Added src/index-export.ts re-exporting double().",
                workerDone: {
                  missionId: "F1",
                  summary: "Wired public integration export",
                  verificationRan: "tsc --noEmit passed",
                },
                tokens: 700,
                cost: 0.007,
              };
            }

            throw new Error(`Unexpected worker mission: ${request.mission.id}`);
          },
        }).handle;
      },

      async spawnValidator(request: ValidatorSpawnRequest): Promise<PersistentAgentHandle> {
        validatedMissions.push(request.mission.id);
        return createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: request.mission.id,
          role: "validator",
          keepWarm: false,
          initialPrompt: request.prompt,
          modelOverride: request.modelOverride,
          runInitialTurn: async () => {
            assert.ok(request.targetCommitSha, "Validator must be pinned to tip SHA");
            const actualTip = await git(request.worktreePath, ["rev-parse", "HEAD"]);
            assert.equal(request.targetCommitSha, actualTip);

            const verdict: MissionReviewVerdict = {
              commitSha: actualTip,
              missionId: request.mission.id,
              branch: request.branch,
              reviewedAt: new Date().toISOString(),
              reviewerAgentId: request.agentId,
              status: "clean",
              merge: "merge",
              findings: [],
              checks: [{ name: "scope-and-diff", passed: true }],
              decision: `Approved ${request.mission.id} at ${actualTip.slice(0, 7)}`,
            };
            return {
              agentId: request.agentId,
              name: request.name,
              missionId: request.mission.id,
              role: "validator",
              outcome: "completed",
              summary: verdict.decision,
              reviewVerdict: verdict,
              tokens: 400,
              cost: 0.004,
            };
          },
        }).handle;
      },

      async spawnFinalValidator(
        request: FinalValidatorSpawnRequest,
      ): Promise<PersistentAgentHandle> {
        finalValidatorRequests.push(request);
        return createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          keepWarm: false,
          initialPrompt: request.prompt,
          modelOverride: request.modelOverride,
          runInitialTurn: async () => {
            assert.equal(path.resolve(request.repoRoot), path.resolve(repoDir));
            assert.equal(request.baseBranch, "main");
            assert.equal(request.modelOverride, "openai/gpt-5.2");
            const actualMainHead = await git(repoDir, ["rev-parse", "HEAD"]);
            assert.equal(
              request.targetCommitSha,
              actualMainHead,
              "Final Validator must audit exact baseHeadSha on main",
            );

            if (request.round === 1) {
              const diskState = JSON.parse(
                await readFile(
                  path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, request.runId, SWARM_STATE_FILE),
                  "utf8",
                ),
              ) as SwarmRunState;
              round1SawVerifyingOnDisk =
                diskState.status === "verifying" && diskState.finalAuditStatus === "running";
              notifyRound1Started();
              await round1ReleasePromise;

              const verdict: FinalAuditVerdict = {
                commitSha: actualMainHead,
                baseBranch: "main",
                auditedAt: new Date().toISOString(),
                verifierAgentId: request.agentId,
                verdict: "disapproved",
                summary: "Public integration export src/index-export.ts is missing on main.",
                checks: [
                  { name: "core-calc", passed: true },
                  {
                    name: "public-export",
                    passed: false,
                    detail: "src/index-export.ts not found on main",
                  },
                ],
                findings: [
                  {
                    severity: "p1",
                    title: "Missing public integration export",
                    detail: "Goal requires src/index-export.ts re-exporting double().",
                    file: "src/index-export.ts",
                  },
                ],
                recommendedMissions: [
                  {
                    title: "Fix integration export",
                    description:
                      "Create src/index-export.ts re-exporting double from ./core/calc.js.",
                    scope: ["src/index-export.ts"],
                    verification: "src/index-export.ts exports double()",
                    kind: "build",
                  },
                ],
                round: 1,
              };

              return {
                agentId: request.agentId,
                name: request.name,
                missionId: FINAL_AUDIT_MISSION_ID,
                role: "final-validator",
                outcome: "completed",
                summary: verdict.summary,
                finalAuditVerdict: verdict,
                tokens: 550,
                cost: 0.0055,
              };
            }

            if (request.round === 2) {
              round2SawFixFileOnMain = await pathExists(
                path.join(repoDir, "src", "index-export.ts"),
              );
              assert.notEqual(
                actualMainHead,
                finalValidatorRequests[0]!.targetCommitSha,
                "Round 2 Final Validator must audit the new main tip SHA after F1 merged",
              );
              assert.equal(request.priorAudits?.length, 1);

              const verdict: FinalAuditVerdict = {
                commitSha: actualMainHead,
                baseBranch: "main",
                auditedAt: new Date().toISOString(),
                verifierAgentId: request.agentId,
                verdict: "approved",
                summary: "Verified core module and src/index-export.ts on integrated main.",
                checks: [
                  { name: "core-calc", passed: true },
                  { name: "public-export", passed: true },
                ],
                findings: [],
                round: 2,
              };

              return {
                agentId: request.agentId,
                name: request.name,
                missionId: FINAL_AUDIT_MISSION_ID,
                role: "final-validator",
                outcome: "completed",
                summary: verdict.summary,
                finalAuditVerdict: verdict,
                tokens: 480,
                cost: 0.0048,
              };
            }

            throw new Error(`Unexpected Final Validator round: ${request.round}`);
          },
        }).handle;
      },
    };

    const harness = createMockPiHarness(repoDir, { sessionId: "sess-final-autofix" });
    createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => testSettings,
    })(harness.pi);

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("swarm-direct", "Build calc core and public export");

    const proposeRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      objective: "Build calc core and public export",
      base_branch: "main",
      max_concurrency: 2,
      validator_enabled: true,
      final_validator_enabled: true,
      verification_contract: "src/core/calc.ts and src/index-export.ts export double() cleanly",
      missions: [
        {
          id: "M1",
          title: "Implement core calc helper",
          kind: "build",
          description: "Create src/core/calc.ts exporting double().",
          scope: ["src/core/"],
          deps: [],
          verification: "src/core/calc.ts compiles cleanly",
        },
      ],
    });
    assert.equal(proposeRes.details.outcome, "confirmed");
    const runId: string = proposeRes.details.runId;
    const runDir = path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, runId);
    const statePath = path.join(runDir, SWARM_STATE_FILE);

    // Wait for Round 1 Final Validator to enter `status === "verifying"`
    await round1StartedPromise;
    assert.equal(round1SawVerifyingOnDisk, true, "Run must persist status=verifying while auditing");

    // Verify `session_tree` treats `status === "verifying"` identically to `"active"` (keeps all 12 running tools!)
    await harness.emit("session_tree", { type: "session_tree" });
    for (const orchTool of ORCHESTRATOR_TOOLS) {
      assert.ok(
        harness.pi.getActiveTools().includes(orchTool),
        `Expected ${orchTool} active during status=verifying`,
      );
    }

    // Release Round 1 -> auto-remediation F1 -> validate -> merge -> Round 2 -> completed!
    releaseRound1();

    let finalState!: SwarmRunState;
    await waitFor(async () => {
      if (!(await pathExists(statePath))) return false;
      finalState = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
      return finalState.status === "completed";
    });

    assert.deepEqual(spawnedWorkerMissions, ["M1", "F1"]);
    assert.deepEqual(validatedMissions, ["M1", "F1"]);
    assert.equal(finalValidatorRequests.length, 2);
    assert.equal(f1SawM1MergedFile, true, "Fix mission F1 worktree must contain M1 merged code");
    assert.equal(round2SawFixFileOnMain, true, "Round 2 audit must see F1 merged src/index-export.ts");

    assert.equal(finalState.status, "completed");
    assert.equal(finalState.finalValidatorEnabled, true);
    assert.equal(finalState.maxFinalAuditRounds, 2);
    assert.equal(finalState.autoFixOnAuditFail, true);
    assert.equal(finalState.finalAuditStatus, "approved");
    assert.equal(finalState.finalAuditRound, 2);
    assert.equal(finalState.missions.M1?.status, "merged");
    assert.equal(finalState.missions.F1?.status, "merged");

    // Verify persisted audit-r1.json & audit-r2.json on disk
    const auditR1Path = path.join(runDir, SWARM_AUDITS_DIR, "audit-r1.json");
    const auditR2Path = path.join(runDir, SWARM_AUDITS_DIR, "audit-r2.json");
    assert.equal(await pathExists(auditR1Path), true);
    assert.equal(await pathExists(auditR2Path), true);
    const auditR1 = JSON.parse(await readFile(auditR1Path, "utf8")) as FinalAuditVerdict;
    const auditR2 = JSON.parse(await readFile(auditR2Path, "utf8")) as FinalAuditVerdict;
    assert.equal(auditR1.verdict, "disapproved");
    assert.equal(auditR1.round, 1);
    assert.equal(auditR2.verdict, "approved");
    assert.equal(auditR2.round, 2);
    assert.notEqual(auditR1.commitSha, auditR2.commitSha);
    assert.equal(auditR2.commitSha, await git(repoDir, ["rev-parse", "HEAD"]));

    // Verify zero duplicate Final Validator events
    const rawEvents = (await readFile(path.join(runDir, SWARM_EVENTS_FILE), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    const countType = (type: string) => rawEvents.filter((e) => e.type === type).length;
    assert.equal(countType("final_audit_started"), 2);
    assert.equal(countType("final_audit_result"), 2);
    assert.equal(countType("final_audit_autofix_planned"), 1);
    assert.equal(countType("run_completed"), 1);

    // Verify clean git status and real merge commits on `main`
    assert.equal(await git(repoDir, ["status", "--porcelain"]), "");
    const mergeLog = await git(repoDir, ["log", "--merges", "--oneline"]);
    assert.match(mergeLog, /swarm\(M1\):/);
    assert.match(mergeLog, /swarm\(F1\):/);

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("parks cleanly when Final Validator disapproves with no recommendedMissions, enforces ROLE_FORBIDDEN on swarm_verify(skip), supports bare menu + human /swarm verify --skip + completions & settings", async () => {
    const repoDir = await createTempGitRepo("final-validator-parked-skip");
    tempDirs.push(repoDir);

    let effectiveSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      maxConcurrency: 2,
      validatorEnabled: false,
      finalValidatorEnabled: true,
      maxFinalAuditRounds: 2,
      autoFixOnAuditFail: true,
      autoMergeClean: true,
    };
    const savedPatches: Array<{ scope: "global" | "project"; patch: Partial<SwarmSettings> }> = [];

    let validatorSpawnCount = 0;
    let releaseRound2Validator!: () => void;
    const round2ValidatorGate = new Promise<void>((resolve) => {
      releaseRound2Validator = resolve;
    });

    const mockTransport: ISwarmTransport = {
      async spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle> {
        return createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: request.mission.id,
          role: "worker",
          keepWarm: request.keepWarm,
          initialPrompt: request.prompt,
          runInitialTurn: async () => {
            const target = path.join(request.worktreePath, "src", "feature.ts");
            await writeFile(target, "export const FEATURE_READY = true;\n", "utf8");
            await git(request.worktreePath, ["add", "src/feature.ts"]);
            await git(request.worktreePath, [
              "-c",
              "user.name=Worker M1",
              "-c",
              "user.email=m1@local",
              "commit",
              "-m",
              "feat(feature): add feature flag",
            ]);
            return {
              agentId: request.agentId,
              name: request.name,
              missionId: request.mission.id,
              role: "worker",
              outcome: "completed",
              summary: "Added src/feature.ts.",
              workerDone: { missionId: request.mission.id, summary: "Committed feature flag" },
              tokens: 450,
              cost: 0.0045,
            };
          },
        }).handle;
      },

      async spawnValidator(): Promise<PersistentAgentHandle> {
        throw new Error("Per-mission Validator should not spawn when validatorEnabled=false");
      },

      async spawnFinalValidator(
        request: FinalValidatorSpawnRequest,
      ): Promise<PersistentAgentHandle> {
        validatorSpawnCount += 1;
        const spawnNum = validatorSpawnCount;
        return createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: FINAL_AUDIT_MISSION_ID,
          role: "final-validator",
          keepWarm: false,
          initialPrompt: request.prompt,
          runInitialTurn: async () => {
            if (spawnNum === 2) {
              await round2ValidatorGate;
            }
            const actualHead = await git(repoDir, ["rev-parse", "HEAD"]);
            assert.equal(request.targetCommitSha, actualHead);

            const verdict: FinalAuditVerdict = {
              commitSha: actualHead,
              baseBranch: "main",
              auditedAt: new Date().toISOString(),
              verifierAgentId: request.agentId,
              verdict: "disapproved",
              summary: "Known documentation gap in CLI help output.",
              checks: [
                { name: "feature-flag-exported", passed: true },
                { name: "cli-docs-check", passed: false, detail: "CLI docs not updated" },
              ],
              findings: [
                {
                  severity: "p2",
                  title: "CLI documentation gap",
                  detail: "README does not document FEATURE_READY flag yet.",
                  file: "README.md",
                },
              ],
              round: request.round,
            };

            return {
              agentId: request.agentId,
              name: request.name,
              missionId: FINAL_AUDIT_MISSION_ID,
              role: "final-validator",
              outcome: "completed",
              summary: verdict.summary,
              finalAuditVerdict: verdict,
              tokens: 320,
              cost: 0.0032,
            };
          },
        }).handle;
      },
    };

    const harness = createMockPiHarness(repoDir, { sessionId: "sess-final-skip" });
    createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => effectiveSettings,
      settingsSaver: async (scope, patch) => {
        savedPatches.push({ scope, patch });
        effectiveSettings = { ...effectiveSettings, ...patch };
        return effectiveSettings;
      },
    })(harness.pi);

    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    // 1. Verify `/swarm` completions cover all 17 subcommands + `verify` & `model` sub-completions
    const swarmCmd = harness.commands.get("swarm")!;
    const allCompletions = (await swarmCmd.getArgumentCompletions?.("")) as Array<{
      value: string;
    }>;
    assert.equal(allCompletions.length, SWARM_SUBCOMMANDS.length);
    assert.ok(SWARM_SUBCOMMANDS.some((c) => c.name === "board"));
    assert.ok(SWARM_SUBCOMMANDS.some((c) => c.name === "models"));
    assert.ok(SWARM_SUBCOMMANDS.some((c) => c.name === "model"));
    assert.ok(SWARM_SUBCOMMANDS.some((c) => c.name === "kill"));
    assert.ok(SWARM_SUBCOMMANDS.some((c) => c.name === "verify"));

    const verifyCompletions = (await swarmCmd.getArgumentCompletions?.("verify ")) as Array<{
      value: string;
      label: string;
    }>;
    assert.deepEqual(
      verifyCompletions.map((c) => c.label),
      ["--force", "--skip", "--reason"],
    );
    const modelRoleCompletions = (await swarmCmd.getArgumentCompletions?.("model ")) as Array<{
      label: string;
    }>;
    assert.deepEqual(
      modelRoleCompletions.map((c) => c.label),
      ["orchestrator", "worker", "validator"],
    );

    await harness.runCommand("swarm", "help");
    const helpMsg = harness.sentMessages.find(
      (m) =>
        m.message.customType === SWARM_STATUS_CUSTOM_TYPE &&
        String(m.message.content).includes("/swarm verify --skip"),
    );
    assert.ok(helpMsg, "/swarm help must document /swarm verify --skip");
    assert.match(String(helpMsg.message.content), /\/swarm board/);
    assert.match(String(helpMsg.message.content), /\/swarm models/);
    assert.match(String(helpMsg.message.content), /\/swarm kill/);

    // 2. Verify `/swarm settings` exposes 3-role models, warm sessions & Final Validator settings
    let settingsStep = 0;
    harness.setSelectHandler((_title, choices) => {
      assert.ok(choices.some((c) => c.startsWith("orchestratorModel:")));
      assert.ok(choices.some((c) => c.startsWith("workerModel:")));
      assert.ok(choices.some((c) => c.startsWith("validatorModel:")));
      assert.ok(choices.some((c) => c.startsWith("keepWorkersWarm:")));
      assert.ok(choices.some((c) => c.startsWith("validatorEnabled:")));
      assert.ok(choices.some((c) => c.startsWith("finalValidatorEnabled:")));
      assert.ok(choices.some((c) => c.startsWith("autoFixOnAuditFail:")));
      assert.ok(choices.some((c) => c.startsWith("maxValidationRounds:")));
      assert.ok(choices.some((c) => c.startsWith("maxFinalAuditRounds:")));
      settingsStep += 1;
      if (settingsStep === 1) return choices.find((c) => c.startsWith("autoFixOnAuditFail:"));
      if (settingsStep === 2) return choices.find((c) => c.startsWith("autoFixOnAuditFail:"));
      return "Done";
    });
    await harness.runCommand("swarm", "settings");
    assert.equal(savedPatches.length, 2);
    assert.equal(savedPatches[0]!.patch.autoFixOnAuditFail, false);
    assert.equal(savedPatches[1]!.patch.autoFixOnAuditFail, true);

    // 3. Launch run -> M1 merges -> Final Validator disapproves with NO recommendedMissions
    await harness.runCommand("swarm-direct", "Add feature flag");
    const proposeRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      objective: "Add feature flag",
      base_branch: "main",
      validator_enabled: false,
      final_validator_enabled: true,
      verification_contract: "src/feature.ts exports FEATURE_READY and docs updated",
      missions: [
        {
          id: "M1",
          title: "Add feature flag module",
          kind: "build",
          description: "Create src/feature.ts exporting FEATURE_READY.",
          scope: ["src/feature.ts"],
          deps: [],
          verification: "file committed cleanly",
        },
      ],
    });
    const runId: string = proposeRes.details.runId;
    const runDir = path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, runId);
    const statePath = path.join(runDir, SWARM_STATE_FILE);

    let parkedState!: SwarmRunState;
    await waitFor(async () => {
      if (!(await pathExists(statePath))) return false;
      parkedState = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
      return (
        parkedState.status === "active" &&
        parkedState.finalAuditStatus === "disapproved" &&
        parkedState.finalAuditRound === 1
      );
    });

    // Zero tight loop
    await new Promise((r) => setTimeout(r, 80));
    parkedState = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
    assert.equal(validatorSpawnCount, 1, "Parked disapproved run must NOT tight-loop validator");
    assert.equal(parkedState.status, "active");
    assert.equal(parkedState.finalAuditStatus, "disapproved");

    // 4. `swarm_verify(status)` works, while `action="skip"` returns ROLE_FORBIDDEN!
    const verifyStatusRes = await harness.executeTool(SWARM_VERIFY_TOOL, {
      action: "status",
    });
    assert.equal(verifyStatusRes.isError, undefined);
    assert.equal(verifyStatusRes.details.finalAuditStatus, "disapproved");
    assert.equal(verifyStatusRes.details.findings.length, 1);

    const forbiddenSkipRes = await harness.executeTool(SWARM_VERIFY_TOOL, {
      action: "skip",
    });
    assert.equal(forbiddenSkipRes.isError, true);
    assert.equal(forbiddenSkipRes.details.errorCode, "ROLE_FORBIDDEN");

    // 5. Bare `/swarm` menu includes Board, Models, Tasks Overlay, Run & Skip Final Validator
    let capturedMenuChoices: string[] = [];
    harness.setSelectHandler((_title, choices) => {
      capturedMenuChoices = [...choices];
      return undefined;
    });
    await harness.runCommand("swarm", "");
    assert.ok(capturedMenuChoices.some((c) => c.includes("View Board")));
    assert.ok(capturedMenuChoices.some((c) => c.includes("Manage Models")));
    assert.ok(capturedMenuChoices.some((c) => c.includes("Open Tasks & Board Overlay")));
    assert.ok(capturedMenuChoices.includes("Run Final Validator (/swarm verify)"));
    assert.ok(capturedMenuChoices.includes("Skip Final Validator (/swarm verify --skip)"));

    // 6. Human `/swarm verify --skip "accepted known gap"` overrides & completes run!
    await harness.runCommand("swarm", 'verify --skip "accepted known gap"');
    const completedState = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
    assert.equal(completedState.status, "completed");
    assert.equal(completedState.finalAuditStatus, "skipped");
    assert.equal(completedState.finalAuditSkippedBy, "human");
    assert.equal(completedState.finalAuditSkipReason, "accepted known gap");

    // 7. `/swarm verify --force` re-triggers Round 2 and displays active round (round 2/2, NOT 1/2!)
    await harness.runCommand("swarm", "verify --force");
    const verifyTriggerMsg = harness.sentMessages
      .filter((m) => m.message.customType === SWARM_STATUS_CUSTOM_TYPE)
      .at(-1);
    assert.ok(verifyTriggerMsg);
    assert.match(
      String(verifyTriggerMsg.message.content),
      /\(round 2\/2\)/,
      "Running Round 2 must display (round 2/2) while finalAuditStatus === 'running'",
    );
    assert.equal(
      (verifyTriggerMsg.message.details as { round?: number; finalAuditStatus?: string })
        ?.finalAuditStatus,
      "running",
    );
    assert.equal(
      (verifyTriggerMsg.message.details as { round?: number })?.round,
      2,
    );

    releaseRound2Validator();
    await waitFor(async () => {
      const latest = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
      return (
        latest.status === "active" &&
        latest.finalAuditRound === 2 &&
        latest.finalAuditStatus === "disapproved"
      );
    });
    assert.equal(validatorSpawnCount, 2);

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("verifies /swarm direct, /swarm cancel (draft & run), /swarm pause/resume, /swarm kill, settled-boundary wakeup, idempotent session_shutdown, and exact registered commands", async () => {
    const repoDir = await createTempGitRepo("controls-lifecycle");
    tempDirs.push(repoDir);

    const testSettings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      maxConcurrency: 2,
      validatorEnabled: false,
      finalValidatorEnabled: false,
      keepWorkersWarm: true,
      autoMergeClean: true,
    };

    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const trackersByRun: MockWarmHandleTracker[] = [];

    const mockTransport: ISwarmTransport = {
      async spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle> {
        const tracker = createMockPersistentHandle({
          agentId: request.agentId,
          name: request.name,
          missionId: request.mission.id,
          role: "worker",
          keepWarm: request.keepWarm,
          initialPrompt: request.prompt,
          onAbort: () => {
            releaseWorker();
          },
          runInitialTurn: async (ctx) => {
            await workerGate;
            if (ctx.isAborted()) {
              return {
                agentId: request.agentId,
                name: request.name,
                missionId: request.mission.id,
                role: "worker",
                outcome: "aborted",
                summary: "Aborted",
                tokens: 50,
                cost: 0.0005,
              };
            }
            const filePath = path.join(request.worktreePath, "src", "ctrl.ts");
            await writeFile(filePath, "export const OK = true;\n", "utf8");
            await git(request.worktreePath, ["add", "src/ctrl.ts"]);
            await git(request.worktreePath, [
              "-c",
              "user.name=Ctrl Worker",
              "-c",
              "user.email=ctrl@local",
              "commit",
              "-m",
              "feat(ctrl): add ctrl flag",
            ]);
            return {
              agentId: request.agentId,
              name: request.name,
              missionId: request.mission.id,
              role: "worker",
              outcome: "completed",
              summary: "Added ctrl flag",
              workerDone: { missionId: request.mission.id, summary: "Added ctrl flag" },
              tokens: 300,
              cost: 0.003,
            };
          },
        });
        trackersByRun.push(tracker);
        return tracker.handle;
      },
      async spawnValidator(): Promise<PersistentAgentHandle> {
        throw new Error("Unexpected validator spawn");
      },
    };

    const harness = createMockPiHarness(repoDir, { sessionId: "sess-ctrl" });
    createPiSwarmExtension({
      transportFactory: () => mockTransport,
      settingsLoader: async () => testSettings,
    })(harness.pi);

    // Strictly verify ONLY `/swarm` and `/swarm-direct` are registered
    assert.deepEqual(Array.from(harness.commands.keys()).sort(), ["swarm", "swarm-direct"]);

    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    // 1. `/swarm <goal>` starts draft -> `/swarm cancel` cancels draft & restores idle profile
    await harness.runCommand("swarm", "Draft something temporary");
    assert.ok(harness.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL));

    await harness.runCommand("swarm", "cancel");
    assert.equal(harness.pi.getActiveTools().includes(PROPOSE_SWARM_PLAN_TOOL), false);
    assert.equal(harness.pi.getActiveTools().includes("swarm_merge"), false);
    assert.ok(harness.pi.getActiveTools().includes(SWARM_STATUS_TOOL));

    // 2. `/swarm direct <goal>` auto-confirms WITHOUT opening modal
    await harness.runCommand("swarm", "direct Add ctrl flag");
    assert.match(String(harness.sentUserMessages.at(-1)!.content), /swarm_direct_plan/);
    const selectCountBeforeDirect = harness.selectCalls.length;
    const proposeRes = await harness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      objective: "Add ctrl flag",
      base_branch: "main",
      validator_enabled: false,
      final_validator_enabled: false,
      verification_contract: "tsc passes",
      missions: [
        {
          id: "M1",
          title: "Add ctrl flag",
          kind: "build",
          description: "Write src/ctrl.ts",
          scope: ["src/ctrl.ts"],
          deps: [],
          verification: "file exists",
        },
      ],
    });
    assert.equal(harness.selectCalls.length, selectCountBeforeDirect, "autoConfirm skips modal");
    assert.equal(proposeRes.details.autoConfirmed, true);
    const runId: string = proposeRes.details.runId;
    const statePath = path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, runId, SWARM_STATE_FILE);

    // 3. `/swarm pause` & `/swarm resume`
    await harness.runCommand("swarm", "pause Waiting on human review");
    let st = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
    assert.equal(st.status, "paused");

    await harness.runCommand("swarm", "resume");
    st = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
    assert.equal(st.status, "active");

    // 4. Settled-boundary wakeup coalescing (queued while streaming, ignores aborted, fires once!)
    harness.setIdle(false);
    releaseWorker();

    await waitFor(async () => {
      const latest = JSON.parse(await readFile(statePath, "utf8")) as SwarmRunState;
      return latest.status === "completed";
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      0,
      "Wakeup must NOT dispatch while ctx.isIdle() === false",
    );

    harness.setIdle(true);
    await harness.emit("agent_settled", { type: "agent_settled", aborted: true });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      0,
    );

    await harness.emit("agent_settled", { type: "agent_settled", aborted: false });
    const wakeups = harness.sentMessages.filter(
      (m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE,
    );
    assert.equal(wakeups.length, 1);
    assert.equal(wakeups[0]!.options?.triggerTurn, true);

    await harness.emit("agent_settled", { type: "agent_settled", aborted: false });
    assert.equal(
      harness.sentMessages.filter((m) => m.message.customType === SWARM_WAKEUP_CUSTOM_TYPE).length,
      1,
    );

    // 5. `/swarm kill` & `/swarm cancel` on a live run (disposes BOTH working & waiting warm handles and writes exactly ONE `run_abandoned` event!)
    let releaseM1Gate!: () => void;
    const m1Gate = new Promise<void>((resolve) => {
      releaseM1Gate = resolve;
    });
    let releaseM3Gate!: () => void;
    const m3Gate = new Promise<void>((resolve) => {
      releaseM3Gate = resolve;
    });
    const cancelTrackers = new Map<string, MockWarmHandleTracker>();

    const killHarness = createMockPiHarness(repoDir, { sessionId: "sess-kill-cancel" });
    createPiSwarmExtension({
      transportFactory: () => ({
        async spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle> {
          const t = createMockPersistentHandle({
            agentId: request.agentId,
            name: request.name,
            missionId: request.mission.id,
            role: "worker",
            keepWarm: true,
            initialPrompt: request.prompt,
            onAbort: () => {
              if (request.mission.id === "M1") releaseM1Gate();
              if (request.mission.id === "M3") releaseM3Gate();
            },
            runInitialTurn: async () => {
              if (request.mission.id === "M2") {
                // Artifact completes quickly and parks in warm `waiting` state awaiting human sign-off
                const docPath = path.join(request.worktreePath, "docs", "cancel-artifact.md");
                await mkdir(path.dirname(docPath), { recursive: true });
                await writeFile(docPath, "# Pending artifact\n", "utf8");
                await git(request.worktreePath, ["add", "docs/cancel-artifact.md"]);
                await git(request.worktreePath, [
                  "-c",
                  "user.name=Worker M2",
                  "-c",
                  "user.email=m2@local",
                  "commit",
                  "-m",
                  "docs: add pending artifact",
                ]);
                return {
                  agentId: request.agentId,
                  name: request.name,
                  missionId: "M2",
                  role: "worker",
                  outcome: "completed",
                  summary: "Artifact ready and parked warm",
                  workerDone: { missionId: "M2", summary: "Artifact ready" },
                  tokens: 50,
                  cost: 0,
                };
              }
              if (request.mission.id === "M1") {
                await m1Gate;
              } else {
                await m3Gate;
              }
              return {
                agentId: request.agentId,
                name: request.name,
                missionId: request.mission.id,
                role: "worker",
                outcome: "aborted",
                summary: "Terminated",
                tokens: 20,
                cost: 0,
              };
            },
          });
          cancelTrackers.set(request.mission.id, t);
          return t.handle;
        },
        async spawnValidator(): Promise<PersistentAgentHandle> {
          throw new Error("Unexpected validator");
        },
      }),
      settingsLoader: async () => ({
        ...testSettings,
        maxConcurrency: 3,
      }),
    })(killHarness.pi);

    await killHarness.emit("session_start", { type: "session_start", reason: "startup" });
    await killHarness.runCommand("swarm-direct", "Killable and cancellable fleet");
    const cancelPropose = await killHarness.executeTool(PROPOSE_SWARM_PLAN_TOOL, {
      objective: "Killable and cancellable fleet",
      base_branch: "main",
      max_concurrency: 3,
      validator_enabled: false,
      final_validator_enabled: false,
      verification_contract: "none",
      missions: [
        {
          id: "M1",
          title: "Working build mission",
          kind: "build",
          description: "Remains actively working until /swarm cancel.",
          scope: ["src/cancel-m1.ts"],
          deps: [],
          verification: "n/a",
        },
        {
          id: "M2",
          title: "Warm waiting artifact",
          kind: "artifact",
          description: "Completes and parks in waiting warm state until /swarm cancel.",
          scope: ["docs/"],
          deps: [],
          verification: "n/a",
        },
        {
          id: "M3",
          title: "Killable work item",
          kind: "build",
          description: "Killed explicitly via /swarm kill.",
          scope: ["src/kill-m3.ts"],
          deps: [],
          verification: "n/a",
        },
      ],
    });
    const cancelRunId: string = cancelPropose.details.runId;
    const cancelStatePath = path.join(
      repoDir,
      SWARM_DIR,
      SWARM_RUNS_DIR,
      cancelRunId,
      SWARM_STATE_FILE,
    );

    await waitFor(async () => {
      const m1 = cancelTrackers.get("M1");
      const m2 = cancelTrackers.get("M2");
      const m3 = cancelTrackers.get("M3");
      if (!m1 || !m2 || !m3) return false;
      if (m1.handle.getState() !== "working" || m2.handle.getState() !== "waiting" || m3.handle.getState() !== "working") {
        return false;
      }
      const latest = JSON.parse(await readFile(cancelStatePath, "utf8")) as SwarmRunState;
      return latest.roster[m2.agentId]?.status === "waiting";
    });

    const m1Tracker = cancelTrackers.get("M1")!;
    const m2Tracker = cancelTrackers.get("M2")!;
    const m3Tracker = cancelTrackers.get("M3")!;

    // Kill M3 explicitly via `/swarm kill M3 "stuck test"`
    await killHarness.runCommand("swarm", 'kill M3 "stuck test"');
    assert.equal(m3Tracker.killed, true);
    assert.equal(m3Tracker.handle.getState(), "killed");
    assert.equal(m1Tracker.handle.getState(), "working");
    assert.equal(m2Tracker.handle.getState(), "waiting");

    // Abandon run via `/swarm cancel` -> MUST dispose BOTH working (M1) AND waiting warm (M2) handles!
    killHarness.setConfirmHandler(() => true);
    await killHarness.runCommand("swarm", "cancel");

    assert.equal(
      m1Tracker.killed,
      true,
      "/swarm cancel must kill & dispose actively working warm handle (M1)",
    );
    assert.equal(m1Tracker.handle.getState(), "killed");
    assert.equal(
      m2Tracker.killed,
      true,
      "/swarm cancel must kill & dispose warm waiting handle (M2)",
    );
    assert.equal(m2Tracker.handle.getState(), "killed");

    const cancelledState = JSON.parse(await readFile(cancelStatePath, "utf8")) as SwarmRunState;
    assert.equal(cancelledState.status, "abandoned");
    assert.equal(cancelledState.roster[m1Tracker.agentId]?.status, "killed");
    assert.equal(cancelledState.roster[m2Tracker.agentId]?.status, "killed");
    assert.equal(cancelledState.roster[m3Tracker.agentId]?.status, "killed");

    const cancelEvents = (
      await readFile(
        path.join(repoDir, SWARM_DIR, SWARM_RUNS_DIR, cancelRunId, SWARM_EVENTS_FILE),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(
      cancelEvents.filter((e) => e.type === "agent_killed").length,
      3,
      "All 3 handles (M3 explicit kill + M1 working + M2 waiting on cancel) must record agent_killed",
    );
    assert.equal(
      cancelEvents.filter((e) => e.type === "run_abandoned").length,
      1,
      "/swarm cancel must write exactly ONE run_abandoned ledger event",
    );

    // 6. Idempotent `session_shutdown` cleans up widget, status, shortcuts & orchestrator cleanly
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await killHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    assert.equal(
      harness.widgetHistory[harness.widgetHistory.length - 1]?.key,
      SWARM_WIDGET_KEY,
    );
    assert.equal(
      harness.widgetHistory[harness.widgetHistory.length - 1]?.value,
      undefined,
    );
    assert.equal(
      harness.statusHistory[harness.statusHistory.length - 1]?.key,
      SWARM_STATUS_KEY,
    );
    assert.equal(
      harness.statusHistory[harness.statusHistory.length - 1]?.text,
      undefined,
    );
    assert.equal(harness.terminalInputHandlers.size, 0);
  });
});

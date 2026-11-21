import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  isFocusable,
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { DEFAULT_SWARM_SETTINGS, ORCHESTRATOR_NAME } from "../src/constants.js";
import type {
  BoardMessage,
  DiffSummary,
  ISwarmEngine,
  IWorktreeManager,
  KillMemberOptions,
  MergeMemberOptions,
  PostBoardMessageInput,
  ProposedSwarmPlan,
  QuestionSpec,
  ReadBoardOptions,
  StopMemberOptions,
  SwarmEngineEvent,
  SwarmMemberRecord,
  SwarmRoleModels,
  SwarmRunState,
  SwarmSettings,
  SwarmSnapshot,
  SwitchModelOptions,
} from "../src/types.js";
import {
  bindSwarmShortcuts,
  buildInitialMembersSummaryLines,
  buildSwarmGraphLines,
  createQuestionnaireUI,
  createSwarmWidget,
  createSwarmWidgetState,
  fitLine,
  fitLines,
  formatBoardKindBadge,
  formatCost,
  formatDuration,
  formatElapsedSince,
  formatMemberRoleBadge,
  formatMemberStateBadge,
  formatRoleModelsLine,
  formatRunStatusBadge,
  formatStatusLine,
  formatTokens,
  formatWorkspaceBadge,
  formatZeroTurnBoardView,
  formatZeroTurnGraphView,
  formatZeroTurnModelsView,
  formatZeroTurnStatusDashboard,
  isModalOpen,
  joinColumns,
  memberStateIcon,
  openSwarmOverlay,
  renderBox,
  renderHorizontalRule,
  renderTable,
  sanitizePlainText,
  shortenModelName,
  wrapLines,
} from "../src/ui/index.js";

// ============================================================================
// Test Helpers & Mocks
// ============================================================================

function createMockTheme(): Theme {
  const fgCodes: Record<string, string> = {
    accent: "\x1b[36m",
    success: "\x1b[32m",
    warning: "\x1b[33m",
    error: "\x1b[31m",
    muted: "\x1b[90m",
    dim: "\x1b[2m",
    border: "\x1b[34m",
    borderAccent: "\x1b[96m",
    borderMuted: "\x1b[90m",
    toolOutput: "\x1b[37m",
    toolDiffAdded: "\x1b[32m",
    toolDiffRemoved: "\x1b[31m",
    toolDiffContext: "\x1b[90m",
  };
  return {
    fg(color: string, text: string) {
      const code = fgCodes[color] ?? "\x1b[37m";
      return `${code}${text}\x1b[0m`;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return `\x1b[1m${text}\x1b[0m`;
    },
    italic(text: string) {
      return `\x1b[3m${text}\x1b[0m`;
    },
    underline(text: string) {
      return `\x1b[4m${text}\x1b[0m`;
    },
    inverse(text: string) {
      return `\x1b[7m${text}\x1b[0m`;
    },
    strikethrough(text: string) {
      return `\x1b[9m${text}\x1b[0m`;
    },
  } as unknown as Theme;
}

interface MockTUIHandle {
  tui: TUI;
  renderCount: () => number;
  hardwareCursorHistory: boolean[];
  getHardwareCursor: () => boolean;
}

function createMockTUI(rows = 32, columns = 120): MockTUIHandle {
  let renders = 0;
  let hardwareCursor = false;
  const hardwareCursorHistory: boolean[] = [];
  const tui = {
    terminal: { rows, columns },
    requestRender() {
      renders++;
    },
    renderNow() {
      renders++;
    },
    getShowHardwareCursor() {
      return hardwareCursor;
    },
    setShowHardwareCursor(enabled: boolean) {
      hardwareCursor = enabled;
      hardwareCursorHistory.push(enabled);
    },
  } as unknown as TUI;

  return {
    tui,
    renderCount: () => renders,
    hardwareCursorHistory,
    getHardwareCursor: () => hardwareCursor,
  };
}

function assertAllLinesFit(
  lines: readonly string[],
  width: number,
  label: string,
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const w = visibleWidth(line);
    assert.ok(
      w <= width,
      `${label}: line ${i} exceeded width ${width} (got ${w}): ${JSON.stringify(stripTerminalSequences(line))}`,
    );
  }
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function makeSampleBoard(runId = "run-20261120-dyn"): BoardMessage[] {
  return [
    {
      seq: 1,
      runId,
      channel: "main",
      from: "orchestrator",
      fromRole: "orchestrator",
      text: "@worker-1 Build the streaming parser module with full EOF guards",
      mentions: ["worker-1"],
      channelMentions: [],
      kind: "brief",
      timestamp: "2026-11-20T17:31:00.000Z",
    },
    {
      seq: 2,
      runId,
      channel: "backend",
      from: "worker-1",
      fromRole: "worker",
      text: "@validator [done] Implemented lexer + parser tests; ready for audit",
      mentions: ["validator"],
      channelMentions: [],
      kind: "done",
      timestamp: "2026-11-20T17:38:00.000Z",
    },
    {
      seq: 3,
      runId,
      channel: "backend",
      from: "validator",
      fromRole: "validator",
      text: "@worker-1 Found edge case on empty buffer in src/parser.ts:42",
      mentions: ["worker-1"],
      channelMentions: [],
      kind: "review",
      timestamp: "2026-11-20T17:40:00.000Z",
    },
    {
      seq: 4,
      runId,
      channel: "backend",
      from: "worker-1",
      fromRole: "worker",
      text: "@validator Fixed EOF edge case and re-ran tests",
      mentions: ["validator"],
      channelMentions: [],
      kind: "update",
      timestamp: "2026-11-20T17:42:00.000Z",
    },
    {
      seq: 5,
      runId,
      channel: "main",
      from: "worker-2",
      fromRole: "worker",
      text: "@worker-1 Sharing shared AST type definitions on @#backend",
      mentions: ["worker-1"],
      channelMentions: ["backend"],
      kind: "chat",
      timestamp: "2026-11-20T17:44:00.000Z",
    },
  ];
}

function makeSampleMember(
  overrides: Partial<SwarmMemberRecord> & { name: string },
): SwarmMemberRecord {
  const { name, ...rest } = overrides;
  return {
    name,
    agentId: `agent-${name}`,
    role: "worker",
    state: "working",
    parentName: ORCHESTRATOR_NAME,
    brief: `Own ${name} slice and verify tests pass`,
    workspace: "share",
    cwd: `/tmp/wt-${name}`,
    branch: `swarm/dyn/${name}`,
    channels: ["main"],
    model: "openai/gpt-5.4-codex",
    thinkingLevel: "medium",
    lastReadSeq: 5,
    lastPostSeq: 4,
    lastPostTime: "2026-11-20T17:42:00.000Z",
    parkedOn: undefined,
    turns: 3,
    tokens: 12_400,
    cost: 0.14,
    humanStopped: false,
    currentActivity: `Editing src/${name}.ts`,
    lastTool: "edit",
    logTail: [`Reading src/${name}.ts`, `Running unit tests for ${name}`],
    createdAt: "2026-11-20T17:35:00.000Z",
    updatedAt: "2026-11-20T17:44:00.000Z",
    ...rest,
  };
}

function makeSampleSnapshot(overrides?: {
  status?: SwarmRunState["status"];
  empty?: boolean;
  members?: SwarmMemberRecord[];
  roleModels?: SwarmRoleModels;
  boardHead?: number;
  recentBoard?: BoardMessage[];
  withRateLimit?: boolean;
}): SwarmSnapshot {
  const defaultRoleModels: SwarmRoleModels = overrides?.roleModels ?? {
    orchestrator: { model: "anthropic/claude-opus-4-6", thinkingLevel: "high" },
    worker: { model: "openai/gpt-5.4-codex", thinkingLevel: "medium" },
    validator: { model: "google/gemini-2.5-pro", thinkingLevel: "high" },
    fallbackModels: ["anthropic/claude-sonnet-4-5"],
  };

  if (overrides?.empty) {
    return {
      run: null,
      activeRunId: null,
      workingMemberNames: [],
      waitingMemberNames: [],
      boardHead: 0,
      recentBoard: [],
      recentEvents: [],
      roleModels: defaultRoleModels,
      totalTokens: 0,
      totalCost: 0,
      updatedAt: "2026-11-20T17:45:00.000Z",
    };
  }

  const runId = "run-20261120-dyn";
  const memberList: SwarmMemberRecord[] = overrides?.members ?? [
    makeSampleMember({
      name: "worker-1",
      role: "worker",
      state: "working",
      workspace: "share",
      branch: "swarm/dyn/worker-1",
      channels: ["main", "backend"],
      currentActivity: "Running npm test -- tests/parser.test.ts",
      turns: 4,
    }),
    makeSampleMember({
      name: "helper-lex",
      role: "worker",
      state: "waiting",
      parentName: "worker-1",
      workspace: "inherit",
      cwd: "/tmp/repo",
      branch: undefined,
      channels: ["main", "backend"],
      parkedOn: "Waiting on @worker-1 feedback",
      currentActivity: undefined,
      turns: 2,
    }),
    makeSampleMember({
      name: "validator",
      role: "validator",
      state: "waiting",
      workspace: "inherit",
      cwd: "/tmp/repo",
      branch: undefined,
      model: "google/gemini-2.5-pro",
      thinkingLevel: "high",
      channels: ["main", "backend"],
      parkedOn: "Parked after review #3",
      currentActivity: undefined,
      turns: 2,
    }),
    makeSampleMember({
      name: "worker-2",
      role: "worker",
      state: "working",
      workspace: "branch",
      branch: "swarm/dyn/worker-2",
      channels: ["main"],
      currentActivity: "Wiring CLI integration",
      turns: 1,
    }),
  ];

  const members: Record<string, SwarmMemberRecord> = {};
  const memberOrder: string[] = [];
  const workingMemberNames: string[] = [];
  const waitingMemberNames: string[] = [];

  for (const m of memberList) {
    members[m.name] = m;
    memberOrder.push(m.name);
    if (m.state === "working") workingMemberNames.push(m.name);
    if (m.state === "waiting") waitingMemberNames.push(m.name);
  }

  const recentBoard = overrides?.recentBoard ?? makeSampleBoard(runId);
  const boardHead =
    overrides?.boardHead ??
    (recentBoard.length > 0 ? recentBoard[recentBoard.length - 1]!.seq : 0);

  const run: SwarmRunState = {
    version: 2,
    id: runId,
    title: "Dynamic Parser Swarm",
    objective: "Build and verify streaming parser pipeline with peer review",
    strategy: "Parallel worktrees for parser + CLI, independent validator audit on board",
    acceptanceCriteria: "All unit tests pass and strict tsc reports 0 errors",
    baseBranch: "main",
    ownerSessionId: "sess-1",
    ownerPid: process.pid,
    status: overrides?.status ?? "active",
    maxConcurrency: 6,
    validatorEnabled: true,
    keepWorkersWarm: true,
    roleModels: defaultRoleModels,
    revision: 7,
    members,
    memberOrder,
    channels: {
      main: {
        name: "main",
        topic: "Swarm coordination",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: "2026-11-20T17:30:00.000Z",
        archived: false,
        subscribers: memberOrder,
      },
      backend: {
        name: "backend",
        topic: "Parser & validator handoffs",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: "2026-11-20T17:32:00.000Z",
        archived: false,
        subscribers: ["worker-1", "helper-lex", "validator"],
      },
    },
    boardHead,
    createdAt: "2026-11-20T17:30:00.000Z",
    updatedAt: "2026-11-20T17:45:00.000Z",
  };

  return {
    run,
    activeRunId: run.id,
    workingMemberNames,
    waitingMemberNames,
    boardHead,
    recentBoard,
    recentEvents: [
      {
        id: "ev-1",
        runId,
        type: "run_created",
        timestamp: "2026-11-20T17:30:00.000Z",
        summary: "Created Dynamic Parser Swarm",
      },
      {
        id: "ev-2",
        runId,
        type: "member_added",
        memberName: "worker-1",
        timestamp: "2026-11-20T17:31:00.000Z",
        summary: "Spawned worker-1 (share:swarm/dyn/worker-1)",
      },
      {
        id: "ev-3",
        runId,
        type: "board_posted",
        memberName: "validator",
        channel: "backend",
        timestamp: "2026-11-20T17:40:00.000Z",
        summary: "Posted review #3 to @worker-1",
      },
    ],
    roleModels: defaultRoleModels,
    totalTokens: 32_500,
    totalCost: 0.41,
    rateLimitUntil: overrides?.withRateLimit
      ? Date.parse("2026-11-20T17:45:30.000Z")
      : undefined,
    rateLimitReason: overrides?.withRateLimit ? "HTTP 429 rate limit" : undefined,
    updatedAt: "2026-11-20T17:45:00.000Z",
  };
}

// ============================================================================
// 0. Static Compatibility & Hygiene Audit
// ============================================================================

describe("src/ui compatibility & hygiene audit", () => {
  it("contains zero replaceControlCharacters imports/references and zero tower strings across src/ui/*", () => {
    const uiDir = path.resolve(process.cwd(), "src/ui");
    const files = readdirSync(uiDir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.includes("text-utils.ts"));
    assert.ok(files.includes("questionnaire.ts"));
    assert.ok(files.includes("dashboard-widget.ts"));
    assert.ok(files.includes("swarm-overlay.ts"));
    assert.ok(files.includes("index.ts"));
    assert.ok(
      !files.includes("tasks-overlay.ts"),
      "Obsolete tasks-overlay.ts must be deleted",
    );

    for (const file of files) {
      const content = readFileSync(path.join(uiDir, file), "utf8");
      assert.doesNotMatch(
        content,
        /replaceControlCharacters/,
        `${file} must not reference replaceControlCharacters`,
      );
      assert.doesNotMatch(
        content,
        /tower/i,
        `${file} must not contain any 'tower' strings`,
      );
    }
  });
});

// ============================================================================
// 1. text-utils & Collaboration Graph Tests
// ============================================================================

describe("text-utils", () => {
  it("fitLine, fitLines, wrapLines, joinColumns, renderBox, and renderTable obey strict width bounds (40/80/120)", () => {
    const theme = createMockTheme();
    const samples = [
      "Simple ASCII line that is moderately long for narrow viewports",
      "\x1b[36m\x1b[1m🐝 Dynamic Swarm [Live]\x1b[0m \x1b[32m中文并行多智能体协作测试\x1b[0m — extra detail",
      "Line with\nembedded\r\nnewlines\tand\u0007control chars",
      "漢字テスト漢字テスト漢字テスト漢字テスト",
      "🚀✨🔥🐝⚠️✓✗●◌■⊘⇄→",
    ];
    for (const sample of samples) {
      for (const w of [1, 2, 10, 40, 80, 120]) {
        const fitted = fitLine(sample, w);
        assert.ok(visibleWidth(fitted) <= w);
        assert.ok(!fitted.includes("\n") && !fitted.includes("\r"));
        const padded = fitLine(sample, w, { pad: true });
        assert.ok(visibleWidth(padded) <= w);
      }
    }
    assert.equal(fitLine("anything", 0), "");
    assert.equal(sanitizePlainText("\x1b[31mhi\u0007\tthere\n\x1b[0m"), "hi there");

    const longText =
      theme.fg("accent", "Dynamic Antigravity Swarm: ") +
      "中文字符宽度与ANSI颜色混合换行测试 ".repeat(3) +
      "verylongunbreakableidentifier_1234567890_abcdefghijklmnopqrstuvwxyz";

    for (const width of [40, 80, 120]) {
      const wrapped = wrapLines(longText, width, 4);
      assert.ok(wrapped.length <= 4);
      assertAllLinesFit(wrapped, width, `wrapLines@${width}`);

      const capped = fitLines(["a", "b", "c", "d", "e"], width, { maxLines: 3 });
      assert.equal(capped.length, 3);
      assertAllLinesFit(capped, width, `fitLines@${width}`);

      const joined = joinColumns(
        theme.bold("🐝 Dynamic Parser Swarm · Live"),
        theme.fg("success", "Board:#18 · 2w/3wait"),
        width,
      );
      assert.ok(visibleWidth(joined) <= width);

      const rule = renderHorizontalRule(width, "Section Header", theme);
      assert.ok(visibleWidth(rule) <= width);

      const boxed = renderBox(wrapped, width, {
        title: theme.fg("accent", "🐝 Swarm Box"),
        footer: theme.fg("dim", "[Esc] close"),
        borderColor: (s) => theme.fg("border", s),
      });
      assertAllLinesFit(boxed, width, `renderBox@${width}`);

      const rows = [
        { name: "worker-1", role: "worker", state: "working", ws: "share:swarm/r1/worker-1" },
        { name: "validator", role: "validator", state: "waiting", ws: "inherit" },
      ];
      const table = renderTable(
        rows,
        [
          { key: "name", header: "Name", minWidth: 8, priority: 100, render: (r) => r.name },
          { key: "role", header: "Role", minWidth: 6, priority: 90, render: (r) => r.role },
          { key: "state", header: "State", minWidth: 7, priority: 85, render: (r) => r.state },
          { key: "ws", header: "Workspace", minWidth: 12, flex: 2, priority: 60, render: (r) => r.ws },
        ],
        width,
        { theme },
      );
      assertAllLinesFit(table, width, `renderTable@${width}`);
    }
  });

  it("formats durations, elapsed time, tokens, costs, 3-role models, and clean v2 badges", () => {
    const theme = createMockTheme();

    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(450), "450ms");
    assert.equal(formatDuration(125_000), "2m05s");
    assert.equal(formatDuration(3_900_000), "1h05m");
    assert.equal(
      formatElapsedSince("2026-11-20T17:40:00.000Z", Date.parse("2026-11-20T17:42:05.000Z")),
      "2m05s",
    );
    assert.equal(formatTokens(1_500), "1.5k");
    assert.equal(formatTokens(1_250_000), "1.25M");
    assert.equal(formatCost(0.0025), "$0.0025");
    assert.equal(formatCost(1.5), "$1.50");

    // 3-role model pills
    const roleModels: SwarmRoleModels = {
      orchestrator: { model: "anthropic/claude-opus-4-6-20260201", thinkingLevel: "high" },
      worker: { model: "openai/gpt-5.4-codex", thinkingLevel: "medium" },
      validator: { model: "google/gemini-2.5-pro", thinkingLevel: "high" },
    };
    assert.equal(shortenModelName("anthropic/claude-opus-4-6"), "claude-opus-4-6");
    assert.ok(visibleWidth(shortenModelName("anthropic/claude-opus-4-6-20260201", 15)) <= 15);
    assert.match(
      formatRoleModelsLine(roleModels),
      /^O:anthropic\/claude-opus-4-6-20260201\(high\) · W:openai\/gpt-5\.4-codex\(medium\) · V:google\/gemini-2\.5-pro\(high\)$/,
    );
    for (const width of [20, 40, 80, 120]) {
      const fitted = formatRoleModelsLine(roleModels, "default", { maxWidth: width, theme });
      assert.ok(visibleWidth(fitted) <= width);
    }

    // Run status badges (active -> Live)
    assert.equal(formatRunStatusBadge("active"), "Live");
    assert.equal(stripTerminalSequences(formatRunStatusBadge("active", theme)), "Live");
    assert.equal(formatRunStatusBadge("paused"), "paused");
    assert.equal(formatRunStatusBadge("completed"), "completed");
    assert.equal(formatRunStatusBadge("abandoned"), "abandoned");

    // Member role badges
    for (const role of ["worker", "validator", "orchestrator", "monitor"] as const) {
      assert.equal(formatMemberRoleBadge(role), role);
      assert.equal(stripTerminalSequences(formatMemberRoleBadge(role, theme)), role);
    }

    // Member state badges & icons
    for (const state of ["working", "waiting", "stopped", "killed"] as const) {
      assert.equal(formatMemberStateBadge(state), state);
      assert.equal(stripTerminalSequences(formatMemberStateBadge(state, theme)), state);
      assert.ok(memberStateIcon(state).length > 0);
    }

    // Workspace badges
    assert.equal(formatWorkspaceBadge("inherit"), "inherit");
    assert.equal(formatWorkspaceBadge("share", "swarm/r1/parser"), "share:swarm/r1/parser");
    assert.equal(formatWorkspaceBadge("branch", "swarm/r1/cli"), "branch:swarm/r1/cli");
    assert.equal(
      stripTerminalSequences(formatWorkspaceBadge("share", "swarm/r1/parser", theme)),
      "share:swarm/r1/parser",
    );

    // Board kind badges
    for (const kind of [
      "brief",
      "done",
      "update",
      "review",
      "decision",
      "model_switch",
      "stall",
      "chat",
    ] as const) {
      assert.equal(formatBoardKindBadge(kind), `[${kind}]`);
      assert.equal(stripTerminalSequences(formatBoardKindBadge(kind, theme)), `[${kind}]`);
    }
  });

  it("buildSwarmGraphLines renders nested Spawn Tree + Peer @mention Interactions strictly within width 40/80/120", () => {
    const theme = createMockTheme();
    const snap = makeSampleSnapshot();
    const run = snap.run!;
    const board = snap.recentBoard;

    for (const width of [40, 80, 120]) {
      const plainLines = buildSwarmGraphLines(run, board, width);
      assertAllLinesFit(plainLines, width, `graph-plain@${width}`);
      const themedLines = buildSwarmGraphLines(run, board, width, { theme });
      assertAllLinesFit(themedLines, width, `graph-themed@${width}`);
    }

    const lines80 = buildSwarmGraphLines(run, board, 80);
    const joined = lines80.join("\n");
    assert.match(joined, /orchestrator \[Live\]/);
    assert.match(joined, /├── ● worker-1 \(worker\).*share:swarm\/dyn\/worker-1/);
    assert.match(joined, /│\s+└── ◌ helper-lex \(worker\).*inherit/);
    assert.match(joined, /├── ◌ validator \(validator\).*inherit/);
    assert.match(joined, /└── ● worker-2 \(worker\).*branch:swarm\/dyn\/worker-2/);
    // Bidirectional edge between worker-1 and validator (2 + 1 = 3 msgs)
    assert.match(joined, /worker-1 ⇄ validator \(3 msgs\)/);
    // Unidirectional edge worker-2 -> worker-1 (1 msg)
    assert.match(joined, /worker-2 → worker-1 \(1 msg\)/);
    // Channel mention edge worker-2 -> #backend (1 msg)
    assert.match(joined, /worker-2 → #backend \(1 msg\)/);

    // Defensive cycle safety in parentName
    const cyclicRun: SwarmRunState = {
      ...run,
      members: {
        a: makeSampleMember({ name: "a", parentName: "b" }),
        b: makeSampleMember({ name: "b", parentName: "a" }),
      },
      memberOrder: ["a", "b"],
    };
    const cyclicLines = buildSwarmGraphLines(cyclicRun, [], 80);
    assertAllLinesFit(cyclicLines, 80, "graph-cyclic@80");
    assert.match(cyclicLines.join("\n"), /\ba\b/);
    assert.match(cyclicLines.join("\n"), /\bb\b/);
    assert.match(cyclicLines.join("\n"), /no @mention interactions yet/);
  });
});

// ============================================================================
// 2. questionnaire Tests (Flexible Dynamic Swarm Plan + IME Focusable + RPC)
// ============================================================================

describe("questionnaire", () => {
  function createTuiCustomHarness(
    driver: (
      comp: Component & { dispose?(): void },
      tui: MockTUIHandle,
      theme: Theme,
    ) => void,
  ): { ctx: ExtensionContext; blockedArg: () => unknown } {
    const theme = createMockTheme();
    const mockTui = createMockTUI(28, 100);
    let lastBlocked: unknown;

    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme,
        async custom<T>(
          factory: (
            tui: TUI,
            th: Theme,
            kb: unknown,
            done: (res: T) => void,
          ) => Component & { dispose?(): void },
          opts?: { blocked?: unknown },
        ): Promise<T> {
          lastBlocked = opts?.blocked;
          return new Promise<T>((resolve) => {
            const comp = factory(mockTui.tui, theme, {}, (res) => {
              resolve(res);
            });
            if (isFocusable(comp)) {
              comp.focused = true;
            }
            driver(comp, mockTui, theme);
          });
        },
      },
    } as unknown as ExtensionContext;

    return { ctx, blockedArg: () => lastBlocked };
  }

  it("askQuestion & askQuestionnaire support IME custom Input, CURSOR_MARKER, hardware cursor restoration, and tabs", async () => {
    let modalDepth = 0;
    const ui = createQuestionnaireUI({
      onModalEnter: () => {
        modalDepth++;
      },
      onModalExit: () => {
        modalDepth--;
      },
    });

    const spec: QuestionSpec = {
      id: "runner",
      question: "Which test runner should workers use?",
      context: "Used by workers and independent validator",
      options: [
        { label: "Node test runner", value: "node:test", description: "Built-in" },
        { label: "Vitest", value: "vitest", description: "Fast TS runner" },
      ],
      recommended: "node:test",
      allowCustom: true,
    };

    let sawCursorMarker = false;
    let sawHardwareCursorOn = false;
    let hardwareCursorAfter = true;
    const { ctx } = createTuiCustomHarness((comp, mockTui) => {
      for (const w of [40, 80, 120]) {
        assertAllLinesFit(comp.render(w), w, `askQuestion@${w}`);
      }
      // Move down twice to "Custom answer…"
      comp.handleInput?.("\x1b[B");
      comp.handleInput?.("\x1b[B");
      comp.handleInput?.("\r");
      sawHardwareCursorOn = mockTui.getHardwareCursor();
      for (const ch of "bun test") {
        comp.handleInput?.(ch);
      }
      const rendered = comp.render(80);
      assertAllLinesFit(rendered, 80, "askQuestion-custom@80");
      sawCursorMarker = rendered.some((l) => l.includes(CURSOR_MARKER));
      comp.handleInput?.("\r");
      hardwareCursorAfter = mockTui.getHardwareCursor();
    });

    const res = await ui.askQuestion(ctx, spec);
    assert.deepEqual(res, { cancelled: false, answer: "bun test", isCustom: true });
    assert.equal(sawCursorMarker, true);
    assert.equal(sawHardwareCursorOn, true);
    assert.equal(hardwareCursorAfter, false);
    assert.equal(modalDepth, 0);

    // Multi-question questionnaire
    const questions: QuestionSpec[] = [
      {
        id: "workspace",
        question: "Default workspace mode?",
        options: [
          { label: "share", value: "share" },
          { label: "inherit", value: "inherit" },
        ],
        recommended: "share",
      },
      {
        id: "branch",
        question: "Base branch?",
        options: [{ label: "main", value: "main" }],
      },
    ];
    const { ctx: multiCtx } = createTuiCustomHarness((comp) => {
      for (const w of [40, 80, 120]) {
        assertAllLinesFit(comp.render(w), w, `askQuestionnaire@${w}`);
      }
      comp.handleInput?.("\r");
      comp.handleInput?.("\r");
      comp.handleInput?.("\r");
    });
    const multiRes = await ui.askQuestionnaire(multiCtx, questions);
    assert.equal(multiRes.cancelled, false);
    assert.deepEqual(multiRes.answers, { workspace: "share", branch: "main" });
  });

  it("confirmProposal TUI displays Flexible Dynamic Swarm Plan, [v] validator toggle, [+/-] concurrency, initialMembers, and Esc -> continue", async () => {
    const ui = createQuestionnaireUI();
    const plan: ProposedSwarmPlan = {
      title: "Dynamic Antigravity Swarm",
      objective: "Refactor orchestration to flexible shared board and warm sessions",
      strategy: "Spawn contract first, then parallel subsystem workers and verifier",
      acceptanceCriteria: "All tests pass and strict tsc reports 0 errors",
      baseBranch: "main",
      maxConcurrency: 6,
      validatorEnabled: true,
      initialMembers: [
        {
          name: "store-author",
          role: "worker",
          brief: "Implement v2 store & board channels",
          workspace: "share",
        },
        {
          name: "verifier",
          role: "validator",
          brief: "Independent code review and test verification",
          workspace: "inherit",
        },
      ],
      roleModels: {
        orchestrator: { model: "anthropic/claude-opus-4-6" },
        worker: { model: "openai/gpt-5.4-codex" },
        validator: { model: "google/gemini-2.5-pro" },
      },
    };

    const previewLines = buildInitialMembersSummaryLines(plan.initialMembers, 60);
    assert.equal(previewLines.length, 2);
    assertAllLinesFit(previewLines, 60, "initialMembersSummary@60");

    // Toggle [v] Validator Policy + [+] Max Concurrency -> Confirm
    {
      const { ctx } = createTuiCustomHarness((comp) => {
        for (const w of [40, 80, 120]) {
          assertAllLinesFit(comp.render(w), w, `confirmProposal@${w}`);
        }
        const initialPlain = stripTerminalSequences(comp.render(100).join("\n"));
        assert.match(initialPlain, /Swarm Plan Confirmation/);
        assert.match(initialPlain, /Dynamic Antigravity Swarm/);
        assert.match(initialPlain, /base:main/);
        assert.match(initialPlain, /2 initial members/);
        assert.match(initialPlain, /claude-opus-4-6/);
        assert.match(initialPlain, /gpt-5\.4-codex/);
        assert.match(initialPlain, /gemini-2\.5-pro/);
        assert.match(initialPlain, /\[v\] Independent Validator Policy: ON/);
        assert.match(initialPlain, /\[(\+\/-)\] Max Concurrency: 6/);
        assert.match(initialPlain, /Confirm — launch dynamic Swarm/);
        assert.match(initialPlain, /Continue refining/);
        assert.match(initialPlain, /Cancel — discard draft/);

        comp.handleInput?.("v");
        comp.handleInput?.("+");
        const afterPlain = stripTerminalSequences(comp.render(100).join("\n"));
        assert.match(afterPlain, /\[v\] Independent Validator Policy: OFF/);
        assert.match(afterPlain, /Max Concurrency: 7/);

        comp.handleInput?.("\r");
      });

      const out = await ui.confirmProposal(ctx, plan);
      assert.deepEqual(out, {
        action: "confirm",
        validatorEnabled: false,
        maxConcurrency: 7,
      });
    }

    // Esc maps to "continue" and decrements concurrency with "-"
    {
      const { ctx } = createTuiCustomHarness((comp) => {
        comp.handleInput?.("-");
        comp.handleInput?.("\x1b");
      });
      const out = await ui.confirmProposal(ctx, { ...plan, roleModels: undefined });
      assert.deepEqual(out, {
        action: "continue",
        validatorEnabled: true,
        maxConcurrency: 5,
      });
    }

    // Short terminal (16 rows) stays height-bounded and preserves all 3 choices
    {
      const theme = createMockTheme();
      const shortTui = createMockTUI(16, 60);
      const shortCtx = {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          async custom<T>(
            factory: (
              tui: TUI,
              th: Theme,
              kb: unknown,
              done: (res: T) => void,
            ) => Component,
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(shortTui.tui, theme, {}, resolve);
              const lines = comp.render(60);
              assertAllLinesFit(lines, 60, "confirmProposal-short@60");
              assert.ok(lines.length <= 16);
              const plain = stripTerminalSequences(lines.join("\n"));
              assert.match(plain, /Confirm — launch dynamic Swarm/);
              assert.match(plain, /Continue refining/);
              assert.match(plain, /Cancel — discard draft/);
              comp.handleInput?.("3");
              comp.handleInput?.("\r");
            });
          },
        },
      } as unknown as ExtensionContext;
      const out = await ui.confirmProposal(shortCtx, plan);
      assert.equal(out.action, "cancel");
    }
  });

  it("confirmProposal RPC fallback and non-UI mode handle [v] toggle, concurrency, dismissal, and headless cancel", async () => {
    const ui = createQuestionnaireUI();
    const seenTitles: string[] = [];
    const replies: (string | undefined)[] = [
      "Toggle Independent Validator Policy (currently ON)",
      "Increase Max Concurrency (currently 4)",
      "Confirm — launch dynamic Swarm (recommended)",
      undefined,
    ];

    const rpcCtx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        async select(title: string) {
          seenTitles.push(title);
          return replies.shift();
        },
        async input() {
          return undefined;
        },
      },
    } as unknown as ExtensionContext;

    const plan: ProposedSwarmPlan = {
      title: "RPC Swarm",
      objective: "Verify RPC fallback",
      strategy: "Dynamic",
      acceptanceCriteria: "Tests pass",
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
      roleModels: { orchestrator: { model: "anthropic/claude-opus-4-6" } },
    };

    const confirmed = await ui.confirmProposal(rpcCtx, plan);
    assert.deepEqual(confirmed, {
      action: "confirm",
      validatorEnabled: false,
      maxConcurrency: 5,
    });
    assert.ok(seenTitles[0]?.includes("Swarm Plan Confirmation"));
    assert.ok(seenTitles[0]?.includes("claude-opus-4-6"));

    const dismissed = await ui.confirmProposal(rpcCtx, plan);
    assert.deepEqual(dismissed, {
      action: "continue",
      validatorEnabled: true,
      maxConcurrency: 4,
    });

    const headlessCtx = { mode: "print", hasUI: false } as unknown as ExtensionContext;
    const headlessRes = await ui.confirmProposal(headlessCtx, plan);
    assert.equal(headlessRes.action, "cancel");
  });
});

// ============================================================================
// 3. dashboard-widget & Zero-Turn Formatter Tests
// ============================================================================

describe("dashboard-widget", () => {
  const fixedNow = () => Date.parse("2026-11-20T17:45:00.000Z");

  it("renders empty, drafting, compact (4 working + overflow + board preview + 3-role pills), and expanded modes within widths 40/80/120", () => {
    const theme = createMockTheme();
    const mockTui = createMockTUI(34, 120);

    // 1. Empty idle
    {
      const emptySnap = makeSampleSnapshot({ empty: true });
      const state = createSwarmWidgetState({ expanded: false, draftActive: false });
      const widget = createSwarmWidget(() => emptySnap, state, { now: fixedNow })(
        mockTui.tui,
        theme,
      );
      assert.deepEqual(widget.render(80), []);
      assert.equal(formatStatusLine(emptySnap, false), undefined);
      widget.dispose();
    }

    // 2. Drafting mode
    {
      const emptySnap = makeSampleSnapshot({ empty: true });
      const state = createSwarmWidgetState({ draftActive: true });
      const widget = createSwarmWidget(() => emptySnap, state, { now: fixedNow })(
        mockTui.tui,
        theme,
      );
      for (const width of [40, 80, 120]) {
        const lines = widget.render(width);
        assertAllLinesFit(lines, width, `widget-draft@${width}`);
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /Swarm Draft/);
        if (width >= 80) {
          assert.match(plain, /clarifying requirements & strategy/);
          assert.match(plain, /\/swarm cancel/);
        }
      }
      assert.equal(formatStatusLine(emptySnap, true), "🐝 swarm:draft");
      widget.dispose();
    }

    // 3. Compact mode with 5 working members -> shows up to 4 + "+1 more" + latest board post + 3-role pills
    {
      const manyWorking = [
        makeSampleMember({ name: "w1", role: "worker", state: "working", currentActivity: "Step 1" }),
        makeSampleMember({ name: "w2", role: "worker", state: "working", currentActivity: "Step 2" }),
        makeSampleMember({ name: "v1", role: "validator", state: "working", currentActivity: "Auditing" }),
        makeSampleMember({ name: "w3", role: "worker", state: "working", currentActivity: "Step 3" }),
        makeSampleMember({ name: "w4", role: "worker", state: "working", currentActivity: "Step 4" }),
        makeSampleMember({ name: "wait1", role: "worker", state: "waiting" }),
      ];
      const snap = makeSampleSnapshot({
        members: manyWorking,
        boardHead: 18,
        withRateLimit: true,
      });
      const state = createSwarmWidgetState({ expanded: false });
      const widget = createSwarmWidget(() => snap, state, { now: fixedNow })(
        mockTui.tui,
        theme,
      );

      for (const width of [40, 80, 120]) {
        const lines = widget.render(width);
        assertAllLinesFit(lines, width, `widget-compact@${width}`);
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /Live/);
        assert.match(plain, /Board:#18/);
        assert.match(plain, /5w\/1wait/);
        assert.match(plain, /\+1 more working/);
        assert.match(plain, /#5/);
      }

      const statusLine = formatStatusLine(snap, false) ?? "";
      assert.match(statusLine, /swarm:Live 5w\/1wait #18/);

      widget.dispose();
    }

    // 4. Expanded mode: 3-role models + channels + roster table + recent 5 board messages
    {
      const snap = makeSampleSnapshot();
      const state = createSwarmWidgetState({ expanded: true });
      const widget = createSwarmWidget(() => snap, state, { now: fixedNow })(
        mockTui.tui,
        theme,
      );

      for (const width of [40, 80, 120]) {
        const lines = widget.render(width);
        assertAllLinesFit(lines, width, `widget-expanded@${width}`);
      }
      const plain120 = stripTerminalSequences(widget.render(120).join("\n"));
      assert.match(plain120, /Models:/);
      assert.match(plain120, /Channels:/);
      assert.match(plain120, /#main/);
      assert.match(plain120, /#backend/);
      assert.match(plain120, /worker-1/);
      assert.match(plain120, /validator/);
      assert.match(plain120, /Recent Board \(#5\)/);
      assert.match(plain120, /#1/);
      assert.match(plain120, /#5/);

      widget.dispose();
    }
  });

  it("manages Braille spinner timer cleanly (starts while working, stops when idle and on dispose)", async () => {
    const theme = createMockTheme();
    const mockTui = createMockTUI();
    let activeSnap = makeSampleSnapshot();
    const state = createSwarmWidgetState({ expanded: false });
    const widget = createSwarmWidget(() => activeSnap, state, {
      spinnerIntervalMs: 40,
      now: fixedNow,
    })(mockTui.tui, theme);

    widget.render(80);
    await new Promise((r) => setTimeout(r, 110));
    const afterWorking = mockTui.renderCount();
    assert.ok(afterWorking >= 1, `Expected spinner ticks while working, got ${afterWorking}`);

    // Transition to idle (all waiting) -> spinner stops
    activeSnap = makeSampleSnapshot({
      members: [makeSampleMember({ name: "idle-1", state: "waiting" })],
    });
    widget.render(80);
    const countAfterIdle = mockTui.renderCount();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      mockTui.renderCount(),
      countAfterIdle,
      "Spinner timer must stop when no working members remain",
    );

    // Re-start working, then dispose -> timer must stop immediately
    activeSnap = makeSampleSnapshot();
    widget.render(80);
    widget.dispose();
    const countAfterDispose = mockTui.renderCount();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      mockTui.renderCount(),
      countAfterDispose,
      "Spinner timer must stop after dispose()",
    );
  });

  it("formats zero-turn /swarm status, /swarm board, /swarm models, and /swarm graph dashboards cleanly", () => {
    const snap = makeSampleSnapshot();
    const settings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      orchestratorModel: "anthropic/claude-opus-4-6",
      workerModel: "openai/gpt-5.4-codex",
      validatorModel: "google/gemini-2.5-pro",
      fallbackModels: ["anthropic/claude-sonnet-4-5"],
    };

    const statusMd = formatZeroTurnStatusDashboard(snap, {
      hostModel: "anthropic/claude-sonnet-4-5",
      now: fixedNow,
    });
    assert.match(statusMd, /Dynamic Parser Swarm/);
    assert.match(statusMd, /\(Live\)/);
    assert.match(statusMd, /#### 3-Role Models/);
    assert.match(statusMd, /#### Channels \(2\)/);
    assert.match(
      statusMd,
      /\| Name \| Role \| State \| Model \| Workspace \| Parent \| Turns \| Last Read\/Post \|/,
    );
    assert.match(statusMd, /worker-1/);
    assert.match(statusMd, /helper-lex/);
    assert.match(statusMd, /#### Recent Board \(#5\)/);
    assert.match(statusMd, /#### Recent Activity/);

    const boardMd = formatZeroTurnBoardView(snap.recentBoard, snap.boardHead, {
      runId: snap.run!.id,
    });
    assert.match(boardMd, /#1.*\[main\].*@orchestrator\*\* -> @worker-1/);
    assert.match(boardMd, /#3.*\[backend\].*@validator\*\* -> @worker-1/);
    assert.match(boardMd, /#5.*\[main\].*@worker-2\*\* -> @worker-1, @#backend/);

    const modelsMd = formatZeroTurnModelsView(
      settings,
      snap,
      "anthropic/claude-sonnet-4-5",
    );
    assert.match(modelsMd, /Swarm 3-Role Models/);
    assert.match(modelsMd, /anthropic\/claude-opus-4-6/);
    assert.match(modelsMd, /openai\/gpt-5\.4-codex/);
    assert.match(modelsMd, /google\/gemini-2\.5-pro/);
    assert.match(modelsMd, /anthropic\/claude-sonnet-4-5/);
    assert.match(modelsMd, /worker-1/);
    assert.match(modelsMd, /validator/);

    const graphMd = formatZeroTurnGraphView(snap, { width: 80 });
    assert.match(graphMd, /Swarm Graph — Dynamic Parser Swarm/);
    assert.match(graphMd, /```text/);
    assert.match(graphMd, /worker-1 ⇄ validator \(3 msgs\)/);
    assert.match(graphMd, /worker-2 → worker-1 \(1 msg\)/);

    // Empty snapshot handling
    const emptySnap = makeSampleSnapshot({ empty: true });
    assert.match(formatZeroTurnGraphView(emptySnap), /No active Swarm run/);
    assert.match(
      formatZeroTurnStatusDashboard(emptySnap, { draftActive: true }),
      /Swarm Draft Active/,
    );
  });

  it("bindSwarmShortcuts handles Ctrl+Shift+T & Esc and strictly respects isModalOpen()", () => {
    let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;
    const ctx = {
      mode: "tui",
      ui: {
        onTerminalInput(fn: (data: string) => { consume?: boolean } | undefined) {
          listener = fn;
          return () => {
            listener = undefined;
          };
        },
      },
    } as unknown as ExtensionContext;

    const state = createSwarmWidgetState({ expanded: false, modalDepth: 0 });
    let toggles = 0;
    let collapses = 0;

    const unbind = bindSwarmShortcuts(ctx, {
      isModalOpen: () => isModalOpen(state),
      isExpanded: () => state.expanded,
      onToggleExpand: () => {
        toggles++;
        state.expanded = !state.expanded;
      },
      onCollapse: () => {
        collapses++;
        state.expanded = false;
      },
    });

    assert.ok(listener);
    // Kitty Ctrl+Shift+T (\x1b[84;6u) toggles expand
    const r1 = listener!("\x1b[84;6u");
    assert.equal(r1?.consume, true);
    assert.equal(state.expanded, true);
    assert.equal(toggles, 1);

    // Modal open -> MUST NOT consume Esc or Ctrl+Shift+T
    state.modalDepth = 1;
    assert.equal(listener!("\x1b"), undefined);
    assert.equal(listener!("\x1b[84;6u"), undefined);
    assert.equal(state.expanded, true);
    assert.equal(collapses, 0);

    // Modal closed -> Esc collapses when expanded
    state.modalDepth = 0;
    const r2 = listener!("\x1b");
    assert.equal(r2?.consume, true);
    assert.equal(state.expanded, false);
    assert.equal(collapses, 1);

    // Already collapsed -> Esc not consumed
    assert.equal(listener!("\x1b"), undefined);

    unbind();
    assert.equal(listener, undefined);
  });
});

// ============================================================================
// 4. swarm-overlay Tests (All 4 Tabs + Actions + Live Subscribe + RPC)
// ============================================================================

describe("swarm-overlay", () => {
  interface MockEngineRecord {
    engine: ISwarmEngine;
    posted: PostBoardMessageInput[];
    switched: SwitchModelOptions[];
    stopped: { name: string; options?: StopMemberOptions }[];
    killed: { name: string; options?: KillMemberOptions }[];
    merged: { name: string; options?: MergeMemberOptions }[];
    subscriberCount: () => number;
    emit: (ev: SwarmEngineEvent) => void;
    setSnapshot: (snap: SwarmSnapshot) => void;
  }

  function createMockEngine(initialSnap: SwarmSnapshot): MockEngineRecord {
    let snap = initialSnap;
    let nextSeq =
      (initialSnap.recentBoard.length > 0
        ? initialSnap.recentBoard[initialSnap.recentBoard.length - 1]!.seq
        : 0) + 1;
    const allBoard: BoardMessage[] = [...initialSnap.recentBoard];
    const listeners = new Set<(ev: SwarmEngineEvent) => void>();

    const posted: PostBoardMessageInput[] = [];
    const switched: SwitchModelOptions[] = [];
    const stopped: { name: string; options?: StopMemberOptions }[] = [];
    const killed: { name: string; options?: KillMemberOptions }[] = [];
    const merged: { name: string; options?: MergeMemberOptions }[] = [];

    const engine = {
      getSnapshot: () => snap,
      subscribe(fn: (ev: SwarmEngineEvent) => void) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      async postMessage(input: PostBoardMessageInput): Promise<BoardMessage> {
        posted.push(input);
        const msg: BoardMessage = {
          seq: nextSeq++,
          runId: snap.run?.id ?? "run-1",
          channel: input.channel ?? "main",
          from: input.from,
          fromRole: input.fromRole,
          text: input.text,
          mentions: input.mentions ?? [],
          channelMentions: input.channelMentions ?? [],
          kind: input.kind ?? "chat",
          timestamp: "2026-11-20T17:46:00.000Z",
        };
        allBoard.push(msg);
        snap = {
          ...snap,
          boardHead: msg.seq,
          recentBoard: [...allBoard],
        };
        return msg;
      },
      async readBoard(options?: ReadBoardOptions) {
        let msgs = [...allBoard];
        if (options?.channel && options.channel !== "*") {
          msgs = msgs.filter((m) => m.channel === options.channel);
        }
        if (options?.search) {
          const needle = options.search.toLowerCase();
          msgs = msgs.filter(
            (m) =>
              m.text.toLowerCase().includes(needle) ||
              m.from.toLowerCase().includes(needle) ||
              m.channel.toLowerCase().includes(needle),
          );
        }
        return {
          messages: msgs,
          head: allBoard.length > 0 ? allBoard[allBoard.length - 1]!.seq : 0,
        };
      },
      async switchModel(options: SwitchModelOptions) {
        switched.push(options);
        if (snap.run && options.targetName && snap.run.members[options.targetName]) {
          snap.run.members[options.targetName] = {
            ...snap.run.members[options.targetName]!,
            model: options.model,
            thinkingLevel: options.thinkingLevel,
          };
        }
        return {
          targetName: options.targetName ?? ORCHESTRATOR_NAME,
          model: options.model ?? "openai/gpt-5.4",
          thinkingLevel: options.thinkingLevel,
        };
      },
      async stopMember(name: string, options?: StopMemberOptions) {
        stopped.push({ name, options });
        if (snap.run?.members[name]) {
          snap.run.members[name] = {
            ...snap.run.members[name]!,
            state: "stopped",
            humanStopped: options?.humanStopped ?? false,
          };
        }
      },
      async killMember(name: string, options?: KillMemberOptions) {
        killed.push({ name, options });
        if (snap.run?.members[name]) {
          snap.run.members[name] = {
            ...snap.run.members[name]!,
            state: "killed",
          };
        }
      },
      async mergeMember(name: string, options?: MergeMemberOptions) {
        merged.push({ name, options });
        return {
          mergedCommitSha: "deadbeef12345678",
          strategy: "merge" as const,
          changedFiles: ["src/parser.ts"],
        };
      },
    } as unknown as ISwarmEngine;

    return {
      engine,
      posted,
      switched,
      stopped,
      killed,
      merged,
      subscriberCount: () => listeners.size,
      emit(ev: SwarmEngineEvent) {
        snap = ev.snapshot;
        for (const fn of listeners) fn(ev);
      },
      setSnapshot(next: SwarmSnapshot) {
        snap = next;
      },
    };
  }

  function createMockWorktree(): {
    worktree: IWorktreeManager;
    diffCalls: { base: string; ref: string }[];
  } {
    const diffCalls: { base: string; ref: string }[] = [];
    const worktree = {
      async getDiffSummary(baseBranch: string, targetRef: string): Promise<DiffSummary> {
        diffCalls.push({ base: baseBranch, ref: targetRef });
        return {
          baseBranch,
          branch: targetRef,
          headSha: "abc123456789",
          commitsAhead: 2,
          changedFiles: ["src/parser.ts", "tests/parser.test.ts"],
          stat: " src/parser.ts | 18 ++++++++++++++++--",
          diff: "@@ -1,3 +1,5 @@\n+export function parse() {}\n-export function old() {}",
        };
      },
    } as unknown as IWorktreeManager;
    return { worktree, diffCalls };
  }

  it("exercises all 4 tabs (Board [p]/[c], Members [w]/[m]/[x]/[k]/[g]/[d], Graph, Search), live updates, width bounds (40/80/120), and clean unsubscribe", async () => {
    const snap = makeSampleSnapshot();
    const mockEngine = createMockEngine(snap);
    const { worktree, diffCalls } = createMockWorktree();
    const theme = createMockTheme();
    const mockTui = createMockTUI(32, 120);

    let modalDepth = 0;
    let overlayOptsSeen: unknown;

    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme,
        notify() {},
        async custom<T>(
          factory: (
            tui: TUI,
            th: Theme,
            kb: unknown,
            done: (res: T) => void,
          ) => Component & { dispose?(): void },
          opts?: { overlay?: boolean; overlayOptions?: unknown },
        ): Promise<T> {
          overlayOptsSeen = opts;
          return new Promise<T>((resolve) => {
            const comp = factory(mockTui.tui, theme, {}, resolve);
            if (isFocusable(comp)) comp.focused = true;

            void (async () => {
              await flushAsync();

              // Verify active subscription
              assert.equal(mockEngine.subscriberCount(), 1);

              // --- TAB 1: BOARD ---
              for (const w of [40, 80, 120]) {
                assertAllLinesFit(comp.render(w), w, `overlay-board@${w}`);
              }
              const boardPlain = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(boardPlain, /\[1\] Board \(#5\)/);
              assert.match(boardPlain, /\[2\] Members \(2\/4\)/);
              assert.match(boardPlain, /\[3\] Graph/);
              assert.match(boardPlain, /\[4\] Search/);
              assert.match(boardPlain, /Channel: \* \(all\)/);

              // Cycle channel filter [c]: * -> main -> backend
              comp.handleInput?.("c");
              assert.match(
                stripTerminalSequences(comp.render(100).join("\n")),
                /Channel: #main/,
              );
              comp.handleInput?.("c");
              assert.match(
                stripTerminalSequences(comp.render(100).join("\n")),
                /Channel: #backend/,
              );

              // Post message [p] to #backend as orchestrator with IME CURSOR_MARKER
              comp.handleInput?.("p");
              assert.equal(mockTui.getHardwareCursor(), true);
              for (const ch of "@worker-1 ship it") {
                comp.handleInput?.(ch);
              }
              const postRender = comp.render(100);
              assertAllLinesFit(postRender, 100, "overlay-board-post@100");
              assert.ok(
                postRender.some((l) => l.includes(CURSOR_MARKER)),
                "Inline board post input must include CURSOR_MARKER",
              );
              comp.handleInput?.("\r");
              await flushAsync();

              assert.equal(mockEngine.posted.length, 1);
              assert.equal(mockEngine.posted[0]!.from, ORCHESTRATOR_NAME);
              assert.equal(mockEngine.posted[0]!.fromRole, "orchestrator");
              assert.equal(mockEngine.posted[0]!.channel, "backend");
              assert.equal(mockEngine.posted[0]!.text, "@worker-1 ship it");

              // --- TAB 2: MEMBERS ---
              comp.handleInput?.("2");
              for (const w of [40, 80, 120]) {
                assertAllLinesFit(comp.render(w), w, `overlay-members@${w}`);
              }
              const membersPlain = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(membersPlain, /worker-1/);
              assert.match(membersPlain, /Brief:/);
              assert.match(membersPlain, /Channels:/);

              // [d] Git diff on worker-1 (share worktree)
              comp.handleInput?.("d");
              await flushAsync();
              assert.equal(diffCalls.length, 1);
              assert.equal(diffCalls[0]!.ref, "swarm/dyn/worker-1");
              const diffPlain = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(diffPlain, /2 commit\(s\) ahead/);
              assert.match(diffPlain, /export function parse/);
              assertAllLinesFit(comp.render(40), 40, "overlay-diff@40");
              // Toggle [d] back to info
              comp.handleInput?.("d");

              // [w] Wake/message worker-1
              comp.handleInput?.("w");
              for (const ch of "please check EOF") {
                comp.handleInput?.(ch);
              }
              comp.handleInput?.("\r");
              await flushAsync();
              assert.equal(mockEngine.posted.length, 2);
              assert.equal(mockEngine.posted[1]!.text, "@worker-1 please check EOF");

              // [m] on working member worker-1 -> warns (does not call switchModel)
              comp.handleInput?.("m");
              assert.match(
                stripTerminalSequences(comp.render(100).join("\n")),
                /must be waiting/,
              );
              assert.equal(mockEngine.switched.length, 0);

              // [g] Merge worktree on worker-1
              comp.handleInput?.("g");
              await flushAsync();
              assert.equal(mockEngine.merged.length, 1);
              assert.equal(mockEngine.merged[0]!.name, "worker-1");

              // [x] Stop worker-1 (humanStopped: true)
              comp.handleInput?.("x");
              await flushAsync();
              assert.equal(mockEngine.stopped.length, 1);
              assert.equal(mockEngine.stopped[0]!.name, "worker-1");
              assert.equal(mockEngine.stopped[0]!.options?.humanStopped, true);

              // Move Down to helper-lex (index 1, state: waiting)
              comp.handleInput?.("\x1b[B");
              const helperPlain = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(helperPlain, /Parked on: Waiting on @worker-1 feedback/);

              // [m] Hot-switch model on waiting helper-lex
              comp.handleInput?.("m");
              for (const ch of "anthropic/claude-opus-4-6 high") {
                comp.handleInput?.(ch);
              }
              comp.handleInput?.("\r");
              await flushAsync();
              assert.equal(mockEngine.switched.length, 1);
              assert.equal(mockEngine.switched[0]!.targetName, "helper-lex");
              assert.equal(mockEngine.switched[0]!.model, "anthropic/claude-opus-4-6");
              assert.equal(mockEngine.switched[0]!.thinkingLevel, "high");

              // [k] Kill helper-lex
              comp.handleInput?.("k");
              await flushAsync();
              assert.equal(mockEngine.killed.length, 1);
              assert.equal(mockEngine.killed[0]!.name, "helper-lex");
              assert.equal(mockEngine.killed[0]!.options?.reason, "Killed by user");

              // --- TAB 3: GRAPH (via Tab key from Members) ---
              comp.handleInput?.("\t");
              for (const w of [40, 80, 120]) {
                assertAllLinesFit(comp.render(w), w, `overlay-graph@${w}`);
              }
              const graphPlain = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(graphPlain, /Spawn Tree/);
              assert.match(graphPlain, /orchestrator/);
              assert.match(graphPlain, /worker-1 ⇄ validator \(3 msgs\)/);

              // --- TAB 4: SEARCH (via Tab key from Graph) ---
              comp.handleInput?.("\t");
              assert.equal(mockTui.getHardwareCursor(), true);
              for (const ch of "EOF") {
                comp.handleInput?.(ch);
              }
              for (const w of [40, 80, 120]) {
                assertAllLinesFit(comp.render(w), w, `overlay-search@${w}`);
              }
              const searchRender = comp.render(100);
              assert.ok(
                searchRender.some((l) => l.includes(CURSOR_MARKER)),
                "Search tab IME input must emit CURSOR_MARKER",
              );
              const searchPlain = stripTerminalSequences(searchRender.join("\n"));
              assert.match(searchPlain, /Matches: 3 \/ 7/);
              assert.match(searchPlain, /#1/);
              assert.match(searchPlain, /#4/);

              // Live engine subscription re-render check
              const rendersBeforeEvent = mockTui.renderCount();
              mockEngine.emit({
                type: "snapshot_changed",
                runId: snap.run!.id,
                summary: "Live tick",
                snapshot: mockEngine.engine.getSnapshot(),
              });
              assert.ok(mockTui.renderCount() > rendersBeforeEvent);

              // Exit search focus with Esc, then close overlay with q
              comp.handleInput?.("\x1b");
              assert.equal(mockTui.getHardwareCursor(), false);
              comp.handleInput?.("q");
            })();
          });
        },
      },
    } as unknown as ExtensionContext;

    await openSwarmOverlay(ctx, mockEngine.engine, worktree, {
      onModalEnter: () => {
        modalDepth++;
      },
      onModalExit: () => {
        modalDepth--;
      },
    });

    assert.equal(modalDepth, 0);
    assert.equal(mockEngine.subscriberCount(), 0, "Overlay must unsubscribe on close");
    assert.equal(mockTui.getHardwareCursor(), false);
    assert.equal((overlayOptsSeen as { overlay?: boolean })?.overlay, true);
  });

  it("supports RPC fallback menu via ctx.ui.select and ctx.ui.input", async () => {
    const snap = makeSampleSnapshot();
    const mockEngine = createMockEngine(snap);
    const { worktree } = createMockWorktree();
    const notifications: string[] = [];

    const selectQueue: (string | undefined)[] = [
      "Board (#5) — Post message",
      "● worker-1 (worker · working [gpt-5.4-codex] · share:swarm/dyn/worker-1)",
      "Stop worker-1 (human-stopped)",
      "Swarm Graph — Spawn tree & @mentions",
      "Close",
    ];
    const inputQueue: (string | undefined)[] = ["@validator please review #5"];

    const rpcCtx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        async select() {
          return selectQueue.shift();
        },
        async input() {
          return inputQueue.shift();
        },
        notify(msg: string) {
          notifications.push(msg);
        },
      },
    } as unknown as ExtensionContext;

    await openSwarmOverlay(rpcCtx, mockEngine.engine, worktree);
    assert.equal(mockEngine.posted.length, 1);
    assert.equal(mockEngine.posted[0]!.text, "@validator please review #5");
    assert.equal(mockEngine.stopped.length, 1);
    assert.equal(mockEngine.stopped[0]!.name, "worker-1");
    assert.equal(mockEngine.stopped[0]!.options?.humanStopped, true);
    assert.ok(notifications.some((n) => n.includes("Spawn Tree")));
  });

  it("parses 'max' thinkingLevel in [m] model switch and disposes component in finally on external custom() exit", async () => {
    // 1. Hot-switch with trailing 'max' thinking level
    {
      const snap = makeSampleSnapshot();
      const mockEngine = createMockEngine(snap);
      const theme = createMockTheme();
      const mockTui = createMockTUI(32, 100);

      const ctx = {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              tui: TUI,
              th: Theme,
              kb: unknown,
              done: (res: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(mockTui.tui, theme, {}, resolve);
              if (isFocusable(comp)) comp.focused = true;
              void (async () => {
                await flushAsync();
                comp.handleInput?.("m");
                for (const ch of "anthropic/claude-opus-4-6 max") {
                  comp.handleInput?.(ch);
                }
                comp.handleInput?.("\r");
                await flushAsync();
                comp.handleInput?.("q");
              })();
            });
          },
        },
      } as unknown as ExtensionContext;

      await openSwarmOverlay(ctx, mockEngine.engine, null, {
        initialTab: "members",
        initialMemberName: "helper-lex",
      });

      assert.equal(mockEngine.switched.length, 1);
      assert.equal(mockEngine.switched[0]!.targetName, "helper-lex");
      assert.equal(mockEngine.switched[0]!.model, "anthropic/claude-opus-4-6");
      assert.equal(mockEngine.switched[0]!.thinkingLevel, "max");
      assert.equal(mockEngine.subscriberCount(), 0);
    }

    // 2. External custom() exit (without calling component.close) still disposes & restores hardware cursor
    {
      const snap = makeSampleSnapshot();
      const mockEngine = createMockEngine(snap);
      const theme = createMockTheme();
      const mockTui = createMockTUI(32, 100);
      let modalDepth = 0;

      const ctx = {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              tui: TUI,
              th: Theme,
              kb: unknown,
              done: (res: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            const comp = factory(mockTui.tui, theme, {}, () => {});
            if (isFocusable(comp)) comp.focused = true;
            // Search tab activates hardware cursor & engine subscription
            assert.equal(mockEngine.subscriberCount(), 1);
            assert.equal(mockTui.getHardwareCursor(), true);
            // Resolve externally without sending Esc/q to component
            return undefined as T;
          },
        },
      } as unknown as ExtensionContext;

      await openSwarmOverlay(ctx, mockEngine.engine, null, {
        initialTab: "search",
        onModalEnter: () => {
          modalDepth++;
        },
        onModalExit: () => {
          modalDepth--;
        },
      });

      assert.equal(modalDepth, 0);
      assert.equal(
        mockEngine.subscriberCount(),
        0,
        "finally must unsubscribe engine listener on external custom() exit",
      );
      assert.equal(
        mockTui.getHardwareCursor(),
        false,
        "finally must restore hardware cursor on external custom() exit",
      );
    }
  });

  it("uses engine.steerMember for [w] so working members receive live mid-turn steering instead of board-only fallback", async () => {
    const snap = makeSampleSnapshot();
    const mockEngine = createMockEngine(snap);
    const steerCalls: Array<{
      name: string;
      message: string;
      mode?: "steer" | "followUp";
      callerRole?: string;
    }> = [];
    mockEngine.engine.steerMember = async (
      name: string,
      message: string,
      mode?: "steer" | "followUp",
      options?: { callerName?: string; callerRole?: any },
    ) => {
      steerCalls.push({ name, message, mode, callerRole: options?.callerRole });
      const target = snap.run?.members[name];
      return { delivery: target?.state === "working" ? "steered" : "woken" };
    };

    const theme = createMockTheme();
    const mockTui = createMockTUI(32, 100);
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme,
        notify() {},
        async custom<T>(
          factory: (
            tui: TUI,
            th: Theme,
            kb: unknown,
            done: (res: T) => void,
          ) => Component & { dispose?(): void },
        ): Promise<T> {
          return new Promise<T>((resolve) => {
            const comp = factory(mockTui.tui, theme, {}, resolve);
            if (isFocusable(comp)) comp.focused = true;
            void (async () => {
              await flushAsync();
              comp.handleInput?.("w");
              for (const ch of "Focus on parser edge case") {
                comp.handleInput?.(ch);
              }
              comp.handleInput?.("\r");
              await flushAsync();
              const plain = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(plain, /Steered @worker-1 mid-turn/);
              comp.handleInput?.("q");
            })();
          });
        },
      },
    } as unknown as ExtensionContext;

    await openSwarmOverlay(ctx, mockEngine.engine, null, {
      initialTab: "members",
      initialMemberName: "worker-1",
    });

    assert.equal(steerCalls.length, 1);
    assert.equal(steerCalls[0]!.name, "worker-1");
    assert.equal(steerCalls[0]!.message, "Focus on parser edge case");
    assert.equal(steerCalls[0]!.mode, "steer");
    assert.equal(steerCalls[0]!.callerRole, "human");
    assert.equal(mockEngine.posted.length, 0);
  });
});

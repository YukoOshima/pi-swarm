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
  ConfirmProposalComponent,
  HardwareCursorController,
  SwarmDashboardComponent,
  SwarmHubView,
  SwarmModelPickerView,
  SwarmOverlayComponent,
  type ModelPickerSettingsState,
  bindSwarmShortcuts,
  buildInitialMembersSummaryLines,
  buildSwarmGraphLines,
  createQuestionnaireUI,
  createSwarmWidget,
  createSwarmWidgetState,
  decodeModifyOtherKeysPrintable,
  fitLine,
  fitLines,
  formatBoardKindBadge,
  formatClock,
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
  formatZeroTurnStatusView,
  isModalOpen,
  joinColumns,
  memberStateIcon,
  openSwarmOverlay,
  renderBox,
  renderHorizontalRule,
  renderTable,
  sanitizeDiffLine,
  sanitizePlainText,
  shortenModelName,
  stripAllTerminalEscapes,
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
        if (width < 58) {
          assert.match(plain, /5w\/1wait/);
        } else {
          assert.match(plain, /5 working · 1 waiting/);
          assert.ok(!plain.includes("(5w/1wait)"), "Must not duplicate compact ratio next to human counts");
        }
        assert.match(plain, /\+1 more working/);
        assert.match(plain, /#5/);
      }

      const statusLine = formatStatusLine(snap, false) ?? "";
      assert.match(statusLine, /swarm:Live #18 · 5 working · 1 waiting/);
      assert.ok(!statusLine.includes("5w/1wait"), "Status line must not duplicate compact count");

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
    assert.match(boardMd, /#5.*\[main\].*@worker-2\*\* -> @worker-1, #backend/);

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

  it("bindSwarmShortcuts does not hook raw onTerminalInput so Pi native dialogs are never hijacked", () => {
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

    const unbind = bindSwarmShortcuts(ctx, {
      isModalOpen: () => isModalOpen(state),
      isExpanded: () => state.expanded,
      onToggleExpand: () => {
        state.expanded = !state.expanded;
      },
      onCollapse: () => {
        state.expanded = false;
      },
    });

    assert.equal(
      listener,
      undefined,
      "bindSwarmShortcuts must not attach global onTerminalInput (Pi registerShortcut handles Alt+S/M/W safely)",
    );
    assert.equal(typeof unbind, "function");
    unbind();
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

              // [K] (Shift+K) Kill helper-lex: Esc cancels, then K -> y confirms
              comp.handleInput?.("K");
              const killConfirmPlain = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(killConfirmPlain, /Kill @helper-lex permanently\?/);
              assert.match(killConfirmPlain, /force dirty: OFF/);
              comp.handleInput?.("f");
              assert.match(
                stripTerminalSequences(comp.render(100).join("\n")),
                /force dirty: ON/,
              );
              comp.handleInput?.("\x1b");
              await flushAsync();
              assert.equal(mockEngine.killed.length, 0, "Esc must cancel kill confirmation");

              comp.handleInput?.("K");
              comp.handleInput?.("y");
              await flushAsync();
              assert.equal(mockEngine.killed.length, 1);
              assert.equal(mockEngine.killed[0]!.name, "helper-lex");
              assert.equal(mockEngine.killed[0]!.options?.force, false);
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

  it("sanitizes ANSI escapes and control characters in overlay diff view while preserving indentation", async () => {
    const snap = makeSampleSnapshot();
    const mockEngine = createMockEngine(snap);
    const { worktree } = createMockWorktree();
    worktree.getDiffSummary = async () => ({
      baseBranch: "main\x07",
      branch: "swarm/run/wt\x1b[2J",
      headSha: "abc",
      commitsAhead: 1,
      changedFiles: ["a.ts"],
      stat: " a.ts\x1b[31m | 2 +-\x1b[0m",
      diff: "   context line\x08\n+  added\x1b]1337;bad\x07line\n-  removed\x1b[2Jline",
    });

    const theme = createMockTheme();
    const mockTui = createMockTUI(32, 100);
    let capturedLines: string[] = [];
    const customCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme,
        notify() {},
        async custom<T>(
          factory: (
            tui: TUI,
            t: Theme,
            kb: unknown,
            done: (result: T) => void,
          ) => Component & { dispose?(): void },
        ): Promise<T> {
          return new Promise<T>((resolve) => {
            const comp = factory(mockTui.tui, theme, {}, resolve);
            if (isFocusable(comp)) comp.focused = true;
            void (async () => {
              await flushAsync();
              comp.handleInput?.("2"); // Members tab
              comp.handleInput?.("d"); // Toggle diff view
              await flushAsync();
              capturedLines = comp.render(100);
              comp.handleInput?.("q");
            })();
          });
        },
      },
    } as unknown as ExtensionContext;

    await openSwarmOverlay(customCtx, mockEngine.engine, worktree);
    const rendered = capturedLines.join("\n");
    assert.ok(!rendered.includes("\x1b[2J"), "Raw clear-screen escape must be stripped");
    assert.ok(!rendered.includes("\x1b]1337"), "Raw OSC sequence must be stripped");
    assert.ok(!rendered.includes("\x07"), "Raw BEL control char must be stripped");
    assert.ok(!rendered.includes("\x08"), "Raw BS control char must be stripped");
    const plain = stripTerminalSequences(rendered);
    assert.match(plain, /   context line/);
    assert.match(plain, /\+  addedline/);
    assert.match(plain, /-  removedline/);
  });

  it("v0.3.6: sanitizes branch/baseBranch in overlay header & loading diff and clears stale state on run switch/null", async () => {
    const dirtySnap = makeSampleSnapshot();
    dirtySnap.run!.baseBranch = "main\x1b[?25l\x1b]0;evil\x07";
    dirtySnap.run!.members["worker-1"]!.branch = "swarm/dyn/wt\x1b[2J\x07";
    const mockEngine = createMockEngine(dirtySnap);
    const { worktree } = createMockWorktree();
    let resolveDiff!: (v: DiffSummary) => void;
    worktree.getDiffSummary = () =>
      new Promise<DiffSummary>((r) => {
        resolveDiff = r;
      });
    const mockTui = createMockTUI(32, 100);
    let overlayLines: string[] = [];
    const tuiCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme: createMockTheme(),
        notify() {},
        async custom<T>(
          factory: (
            tui: TUI,
            theme: Theme,
            kb: unknown,
            done: (r: T) => void,
          ) => Component & { dispose?(): void },
        ): Promise<T> {
          return new Promise<T>((resolve) => {
            const comp = factory(mockTui.tui, createMockTheme(), {}, resolve);
            if (isFocusable(comp)) comp.focused = true;
            void (async () => {
              await flushAsync();
              comp.handleInput?.("2"); // Members
              comp.handleInput?.("d"); // Trigger diff loading
              overlayLines = comp.render(100);
              comp.handleInput?.("q");
              resolveDiff({
                baseBranch: "main",
                branch: "swarm/dyn/wt",
                headSha: "abc",
                commitsAhead: 0,
                changedFiles: [],
                stat: "",
                diff: "",
              });
            })();
          });
        },
      },
    } as unknown as ExtensionContext;
    await openSwarmOverlay(tuiCtx, mockEngine.engine, worktree);
    const joined = overlayLines.join("\n");
    assert.ok(!joined.includes("\x1b[?25l"));
    assert.ok(!joined.includes("\x1b[2J"));
    assert.ok(!joined.includes("\x07"));

    // Run change / null run clears boardMessages, inlineMode, searchFocused, and discards stale refreshFullBoard
    const snap1 = makeSampleSnapshot();
    const mockEngine2 = createMockEngine(snap1);
    let resolveStaleBoard!: (res: { messages: BoardMessage[]; head: number }) => void;
    let boardCallCount = 0;
    mockEngine2.engine.readBoard = async () => {
      boardCallCount += 1;
      if (boardCallCount === 1) {
        return new Promise((resolve) => {
          resolveStaleBoard = resolve;
        });
      }
      return { messages: [], head: 0 };
    };
    const mockTui2 = createMockTUI(32, 100);
    let capturedWhenNull = "";
    const ctx2 = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme: createMockTheme(),
        notify() {},
        async custom<T>(
          factory: (
            tui: TUI,
            t: Theme,
            kb: unknown,
            done: (r: T) => void,
          ) => Component & { dispose?(): void },
        ): Promise<T> {
          return new Promise<T>((resolve) => {
            const comp = factory(mockTui2.tui, createMockTheme(), {}, resolve);
            if (isFocusable(comp)) comp.focused = true;
            void (async () => {
              await flushAsync();
              comp.handleInput?.("p");
              assert.equal(mockTui2.getHardwareCursor(), true);

              mockEngine2.emit({
                type: "snapshot_changed",
                runId: null,
                summary: "Detached",
                snapshot: makeSampleSnapshot({ empty: true }),
              });
              resolveStaleBoard({
                messages: [
                  {
                    seq: 99,
                    runId: snap1.run!.id,
                    timestamp: "2026-11-20T18:00:00.000Z",
                    from: "stale",
                    fromRole: "worker",
                    channel: "main",
                    kind: "chat",
                    mentions: [],
                    channelMentions: [],
                    text: "Stale message from old run",
                  },
                ],
                head: 99,
              });
              await flushAsync();
              assert.equal(mockTui2.getHardwareCursor(), false);
              capturedWhenNull = stripTerminalSequences(comp.render(100).join("\n"));

              const snap2 = makeSampleSnapshot({ boardHead: 0, recentBoard: [] });
              snap2.run!.id = "run-2";
              snap2.activeRunId = "run-2";
              mockEngine2.emit({
                type: "snapshot_changed",
                runId: "run-2",
                summary: "Switched to run-2",
                snapshot: snap2,
              });
              await flushAsync();
              const run2Rendered = stripTerminalSequences(comp.render(100).join("\n"));
              assert.ok(!run2Rendered.includes("Stale message from old run"));
              comp.handleInput?.("q");
            })();
          });
        },
      },
    } as unknown as ExtensionContext;

    await openSwarmOverlay(ctx2, mockEngine2.engine, null);
    assert.match(capturedWhenNull, /No active Swarm run/);
  });
});

describe("v0.3.6 UI hardening regressions", () => {
  it("strips all ECMA-48 escape sequences (CSI, OSC, DCS, SOS, PM, APC, C1, 2-byte ESC, lone ESC) without eating diff code", () => {
    assert.equal(
      sanitizeDiffLine("\x1b[?25l+  const message = 1"),
      "+  const message = 1",
    );
    assert.equal(
      sanitizeDiffLine("\x1bP1$r0m\x1b\\+  const x = \x1bXpayload\x1b\\\x1b^pm\x1b\\\x1b_apc\x1b\\42"),
      "+  const x = 42",
    );
    assert.equal(
      sanitizePlainText("\u0090dcs\u009c\u009b31mHello\u009dosc\u009c \x1bMWorld\x1b"),
      "Hello World",
    );
    assert.equal(
      stripAllTerminalEscapes("\x1b]0;bad title\x07ok\x1b[200~paste\x1b[201~"),
      "okpaste",
    );
  });

  it("sanitizes branch and baseBranch in dashboard-widget and questionnaire basic confirm", async () => {
    const dirtySnap = makeSampleSnapshot();
    dirtySnap.run!.baseBranch = "main\x1b[?25l\x1b]0;evil\x07";
    dirtySnap.run!.members["worker-1"]!.branch = "swarm/dyn/wt\x1b[2J\x07";

    const mockTui = createMockTUI(32, 100);
    const widgetState = createSwarmWidgetState({ expanded: true });
    const widget = createSwarmWidget(() => dirtySnap, widgetState)(
      mockTui.tui,
      createMockTheme(),
    );
    const expandedOut = widget.render(100).join("\n");
    assert.ok(!expandedOut.includes("\x1b[?25l"));
    assert.ok(!expandedOut.includes("\x1b]0;evil"));
    assert.match(stripTerminalSequences(expandedOut), /base:main/);
    widget.dispose();

    const statusMd = formatZeroTurnStatusDashboard(dirtySnap);
    assert.ok(!statusMd.includes("\x1b[?25l"));
    assert.ok(!statusMd.includes("\x1b]0;evil"));
    assert.match(statusMd, /\*\*Base Branch:\*\* `main`/);

    const qUi = createQuestionnaireUI();
    let capturedPrompt = "";
    const basicCtx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        async select(title: string) {
          capturedPrompt = title;
          return "Confirm — launch dynamic Swarm (recommended)";
        },
        async input() {
          return undefined;
        },
      },
    } as unknown as ExtensionContext;
    await qUi.confirmProposal(basicCtx, {
      title: "Test",
      objective: "Obj",
      strategy: "Strat",
      acceptanceCriteria: "Done",
      baseBranch: "main\x1b[?25l\x07",
      maxConcurrency: 4,
      validatorEnabled: true,
    });
    assert.ok(!capturedPrompt.includes("\x1b[?25l"));
    assert.ok(!capturedPrompt.includes("\x07"));
    assert.match(capturedPrompt, /base:main/);
  });

  it("questionnaire supports MAX_CONCURRENCY up to 64 and disposes TUI components in finally on external abort", async () => {
    const qUi = createQuestionnaireUI();
    const mockTui = createMockTUI(30, 100);
    const theme = createMockTheme();

    const selectCtx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        async select(_t: string, choices: string[]) {
          const inc = choices.find((c) => c.startsWith("Increase Max Concurrency"));
          assert.ok(inc, "Concurrency 24 < 64 should still allow incrementing");
          return "Confirm — launch dynamic Swarm (recommended)";
        },
        async input() {
          return undefined;
        },
      },
    } as unknown as ExtensionContext;
    const outcome = await qUi.confirmProposal(selectCtx, {
      title: "High Concurrency",
      objective: "Obj",
      strategy: "Strat",
      acceptanceCriteria: "Done",
      baseBranch: "main",
      maxConcurrency: 24,
      validatorEnabled: true,
    });
    assert.equal(outcome.maxConcurrency, 24);

    const runExternalThrow = async (
      fn: (ctx: ExtensionContext) => Promise<unknown>,
    ) => {
      mockTui.tui.setShowHardwareCursor(false);
      const ctx = {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          async custom<T>(
            factory: (
              tui: TUI,
              t: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            const comp = factory(mockTui.tui, theme, {}, () => {});
            comp.render(100);
            throw new Error("simulated external cancel");
          },
        },
      } as unknown as ExtensionContext;
      await assert.rejects(() => fn(ctx), /simulated external cancel/);
      assert.equal(mockTui.getHardwareCursor(), false);
    };

    await runExternalThrow((c) =>
      qUi.askQuestion(c, { id: "q1", question: "Q?", options: [] }),
    );
    await runExternalThrow((c) =>
      qUi.askQuestionnaire(c, [
        { id: "q1", question: "Q1?", options: [{ label: "A" }] },
      ]),
    );
    await runExternalThrow((c) =>
      qUi.confirmProposal(c, {
        title: "T",
        objective: "O",
        strategy: "S",
        acceptanceCriteria: "A",
        baseBranch: "main",
        maxConcurrency: 4,
        validatorEnabled: true,
      }),
    );
  });

  it("dashboard-widget uses dynamic getHostModel getter across renders", () => {
    let dynamicModel = "anthropic/claude-sonnet-4-5";
    const snap = makeSampleSnapshot({
      roleModels: {
        orchestrator: {},
        worker: {},
        validator: {},
        fallbackModels: [],
      },
    });
    const mockTui = createMockTUI(32, 120);
    const state = createSwarmWidgetState({ expanded: true });
    const widget = createSwarmWidget(() => snap, state, {
      hostModel: "static/ignored",
      getHostModel: () => dynamicModel,
    })(mockTui.tui, createMockTheme());

    const first = stripTerminalSequences(widget.render(120).join("\n"));
    assert.match(first, /claude-sonnet-4-5/);

    dynamicModel = "openai/gpt-5.4";
    const second = stripTerminalSequences(widget.render(120).join("\n"));
    assert.match(second, /gpt-5\.4/);
    widget.dispose();
  });
});

describe("v0.3.7 UI enhancements", () => {
  it("keeps subsequent lines intact on unterminated OSC/DCS escapes and strips residual C1 controls", () => {
    const input = "\x1b]0;unterminated title\nsecond line stays\n\u0085third line\x1b";
    const stripped = stripAllTerminalEscapes(input);
    assert.equal(stripped, "0;unterminated title\nsecond line stays\nthird line");
    assert.ok(stripped.includes("second line stays"));
    assert.ok(stripped.includes("third line"));
    assert.ok(!stripped.includes("\x1b"));
    assert.ok(!stripped.includes("\u0085"));
  });

  it("questionnaire falls back cleanly when option label contains only escape sequences", async () => {
    const qUi = createQuestionnaireUI();
    let capturedChoices: string[] = [];
    const ctx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        async select(_title: string, choices: string[]) {
          capturedChoices = choices;
          return choices[0];
        },
        async input() {
          return undefined;
        },
      },
    } as unknown as ExtensionContext;

    const res = await qUi.askQuestion(ctx, {
      id: "esc-opt",
      question: "Pick one",
      allowCustom: false,
      options: [
        { label: "\x1b[31m\x1b[0m", value: "\x1b]0;bad\x07" },
        { label: "\x1b[31m\x1b[0m", value: "safe-value" },
      ],
    });
    assert.equal(res.cancelled, false);
    assert.ok(
      capturedChoices.some((c) => c === "(option)"),
      "Escape-only label & value must fall back to '(option)'",
    );
    assert.ok(
      capturedChoices.some((c) => c === "safe-value"),
      "Escape-only label must fall back to sanitized value",
    );
  });

  it("buildSwarmGraphLines normalizes case, shows fork/merged badges, #lastSeq [kind], and custom #channels", () => {
    const snap = makeSampleSnapshot();
    const run = snap.run!;
    run.members["helper-lex"]!.forkedFrom = "worker-1";
    run.members["worker-1"]!.mergedCommitSha = "abcdef1234567";
    const board: BoardMessage[] = [
      ...snap.recentBoard,
      {
        seq: 6,
        runId: run.id,
        channel: "main",
        from: "WORKER-1",
        fromRole: "worker",
        text: "@VALIDATOR follow up",
        mentions: ["VALIDATOR"],
        channelMentions: [],
        kind: "decision",
        timestamp: "2026-11-20T17:46:00.000Z",
      },
    ];

    const lines = buildSwarmGraphLines(run, board, 100);
    const joined = lines.join("\n");
    assert.match(joined, /worker-1.*✓merged/);
    assert.match(joined, /helper-lex.*fork:@worker-1/);
    assert.match(joined, /worker-1 ⇄ validator \(4 msgs\) · #6 \[decision\]/);
    assert.match(joined, /Channels/);
    assert.match(joined, /#backend: @worker-1, @helper-lex, @validator/);
    assertAllLinesFit(lines, 100, "v037-graph@100");
  });

  it("supports [Enter] scrollable post reader on Board/Search, [l] logs+brief & diff scrolling, and [k] force kill", async () => {
    const snap = makeSampleSnapshot();
    const longLines = Array.from({ length: 30 }, (_, i) => `Detail line ${i + 1}: important output`).join("\n");
    snap.recentBoard.push({
      seq: 6,
      runId: snap.run!.id,
      channel: "main",
      from: "worker-1",
      fromRole: "worker",
      text: longLines,
      mentions: ["orchestrator"],
      channelMentions: [],
      kind: "done",
      timestamp: "2026-11-20T17:46:00.000Z",
    });
    snap.boardHead = 6;
    snap.run!.members["worker-1"]!.logTail = Array.from(
      { length: 50 },
      (_, i) => `Log entry #${i + 1}`,
    );

    const mockTui = createMockTUI(24, 100);
    const theme = createMockTheme();
    const killed: Array<{ name: string; force?: boolean }> = [];
    const engine = {
      getSnapshot: () => snap,
      subscribe: () => () => {},
      async readBoard() {
        return { messages: snap.recentBoard, head: snap.boardHead };
      },
      async killMember(name: string, options?: KillMemberOptions) {
        killed.push({ name, force: options?.force });
      },
    } as unknown as ISwarmEngine;

    const longDiffLines = Array.from(
      { length: 25 },
      (_, i) => `+export const line${i + 1} = ${i + 1};`,
    ).join("\n");
    const worktree = {
      async getDiffSummary(baseBranch: string, targetRef: string): Promise<DiffSummary> {
        return {
          baseBranch,
          branch: targetRef,
          headSha: "abc123",
          commitsAhead: 1,
          changedFiles: ["src/big.ts"],
          stat: " src/big.ts | 25 +++++++++++++++++++++++++",
          diff: longDiffLines,
        };
      },
    } as unknown as IWorktreeManager;

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
            done: (r: T) => void,
          ) => Component & { dispose?(): void },
        ): Promise<T> {
          return new Promise<T>((resolve) => {
            const comp = factory(mockTui.tui, theme, {}, resolve);
            if (isFocusable(comp)) comp.focused = true;
            void (async () => {
              await flushAsync();

              // 1. Board [Enter] full post reader + PgDn scroll + Esc back
              comp.handleInput?.("\r");
              const readerTop = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(readerTop, /Full Post #6/);
              assert.match(readerTop, /Detail line 1:/);

              comp.handleInput?.("\x1b[6~"); // PgDn
              comp.handleInput?.("\x1b[6~"); // PgDn
              comp.handleInput?.("j");
              const readerScrolled = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(readerScrolled, /Detail line 2[0-9]:|Detail line 30:/);

              comp.handleInput?.("\x1b"); // Esc returns to list, does not close overlay
              const backToList = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(backToList, /Channel: \* \(all\)/);

              // 2. Search [Enter] full post reader
              comp.handleInput?.("4");
              for (const ch of "Detail line") {
                comp.handleInput?.(ch);
              }
              comp.handleInput?.("\r"); // exit search input focus
              comp.handleInput?.("\r"); // open expanded post reader
              const searchReader = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(searchReader, /Full Post #6/);
              comp.handleInput?.("\r"); // Enter exits reader back to search list
              assert.match(
                stripTerminalSequences(comp.render(100).join("\n")),
                /Matches: 1/,
              );

              // 3. Members [l] full brief + logTail & ] / PgDn scrolling
              comp.handleInput?.("2");
              comp.handleInput?.("l");
              const logsTop = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(logsTop, /Brief & Logs/);
              assert.match(logsTop, /Log Tail \(50 line\(s\)\)/);
              for (let i = 0; i < 10; i++) {
                comp.handleInput?.("\x1b[6~"); // PgDn
              }
              const logsBottom = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(logsBottom, /Log entry #50/);

              // 4. Members [d] diff scrolling with ] / PgDn
              comp.handleInput?.("d");
              await flushAsync();
              for (let i = 0; i < 6; i++) {
                comp.handleInput?.("]");
              }
              const diffScrolled = stripTerminalSequences(comp.render(100).join("\n"));
              assert.match(diffScrolled, /export const line2[0-5]/);

              // 5. Members [K] (Shift+K) -> [f] force dirty toggle -> [Enter] confirm
              comp.handleInput?.("K");
              comp.handleInput?.("f");
              comp.handleInput?.("\r");
              await flushAsync();

              comp.handleInput?.("q");
            })();
          });
        },
      },
    } as unknown as ExtensionContext;

    await openSwarmOverlay(ctx, engine, worktree);
    assert.deepEqual(killed, [{ name: "worker-1", force: true }]);
  });
});

describe("v0.4.0 Droid Mission Model Picker, Hub & Overlay Upgrades", () => {
  const sampleModels = [
    {
      id: "claude-fable-5-2",
      provider: "magpie/bp",
      fullId: "magpie/bp/claude-fable-5-2",
      name: "Claude Fable 5.2",
      contextWindow: 1_000_000,
    },
    {
      id: "gemini-4-neon",
      provider: "magpie/auto",
      fullId: "magpie/auto/gemini-4-neon",
      name: "Gemini 4 Neon",
      contextWindow: 1_000_000,
    },
    {
      id: "gpt-6.2-astra",
      provider: "magpie/bp",
      fullId: "magpie/bp/gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      contextWindow: 400_000,
    },
    {
      id: "claude-opus-5-5",
      provider: "magpie/bp",
      fullId: "magpie/bp/claude-opus-5-5",
      name: "Claude Opus 5.5",
      contextWindow: 200_000,
    },
  ];

  it("SwarmModelPickerView supports Role Tabs, Search, 2-step Effort Selection, Fallbacks Reorder, Ctrl+S Scope, and strict 40/60/80/120 & 16-row bounds", async () => {
    const theme = createMockTheme();
    const { tui } = createMockTUI(16, 80);
    let state: ModelPickerSettingsState = {
      settings: {
        ...DEFAULT_SWARM_SETTINGS,
        orchestratorModel: "magpie/bp/claude-fable-5-2",
        orchestratorThinkingLevel: "high",
        workerModel: "magpie/auto/gemini-4-neon",
        workerThinkingLevel: "high",
        validatorModel: "magpie/bp/claude-opus-5-5",
        validatorThinkingLevel: "xhigh",
        fallbackModels: ["magpie/bp/claude-opus-5-5", "magpie/auto/gemini-4-neon"],
      },
      origins: { orchestrator: "global", worker: "global", validator: "global" },
      hostModel: "magpie/bp/claude-fable-5-2",
    };

    const appliedRoles: Array<{
      scope: string;
      role: string;
      model?: string;
      thinkingLevel?: string;
    }> = [];
    const appliedFallbacks: Array<{
      scope: string;
      fallbackModels: string[];
    }> = [];
    let closedResult: unknown;

    const picker = new SwarmModelPickerView(tui, theme, {
      mode: "roles",
      initialTab: "orchestrator",
      initialScope: "global",
      state,
      availableModels: sampleModels,
      onApplyRole: async (sel) => {
        appliedRoles.push(sel);
        const nextSettings = { ...state.settings };
        if (sel.role === "validator") {
          nextSettings.validatorModel = sel.model;
          nextSettings.validatorThinkingLevel = sel.thinkingLevel;
        } else if (sel.role === "worker") {
          nextSettings.workerModel = sel.model;
          nextSettings.workerThinkingLevel = sel.thinkingLevel;
        }
        state = {
          ...state,
          settings: nextSettings,
          origins: { ...state.origins, [sel.role]: sel.model ? sel.scope : "host" },
        };
        return { ...state, notice: `Updated ${sel.role}` };
      },
      onApplyFallbacks: async (sel) => {
        appliedFallbacks.push(sel);
        state = {
          ...state,
          settings: { ...state.settings, fallbackModels: sel.fallbackModels },
        };
        return { ...state, notice: "Updated fallbacks" };
      },
      onClose: (res) => {
        closedResult = res;
      },
    });

    for (const w of [40, 60, 80, 120]) {
      const lines = picker.render(w);
      assertAllLinesFit(lines, w, `picker-list@${w}`);
      assert.ok(lines.length <= 16, `16-row terminal bound exceeded at width ${w}: ${lines.length}`);
    }

    // Tab -> Worker -> Validator, Ctrl+S -> Project Scope
    picker.handleInput("\t");
    picker.handleInput("\t");
    picker.handleInput("\x13"); // Ctrl+S
    const validatorView = stripTerminalSequences(picker.render(90).join("\n"));
    assert.match(validatorView, /Scope: Project/);

    // Filter for "astra" -> Enter -> Effort Step -> select High -> Enter
    for (const ch of "astra") {
      picker.handleInput(ch);
    }
    picker.handleInput("\r"); // opens Step 2: Select Reasoning Effort
    const effortLines = picker.render(80);
    assertAllLinesFit(effortLines, 80, "picker-effort@80");
    assert.ok(effortLines.length <= 16, `Effort step exceeded 16 rows: ${effortLines.length}`);
    const effortPlain = stripTerminalSequences(effortLines.join("\n"));
    assert.match(effortPlain, /Select Reasoning Effort — magpie\/bp\/gpt-6\.2-astra/);

    picker.handleInput("6"); // explicitly pick '6' for High ★
    picker.handleInput("\r");
    // Wait: let's flush async & verify
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(appliedRoles.length, 1);
    assert.equal(appliedRoles[0]!.role, "validator");
    assert.equal(appliedRoles[0]!.scope, "project");
    assert.equal(appliedRoles[0]!.model, "magpie/bp/gpt-6.2-astra");
    assert.equal(appliedRoles[0]!.thinkingLevel, "high");

    // Ctrl+X clears role back to host Inherit
    picker.handleInput("\x18");
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(appliedRoles.length, 2);
    assert.equal(appliedRoles[1]!.model, undefined);

    // Tab -> Fallbacks tab: toggle & reorder `[` / `]`
    picker.handleInput("\t");
    picker.handleInput(" "); // toggles highlighted fallback (claude-fable-5-2) ON at #3
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(appliedFallbacks.length, 1);
    assert.deepEqual(appliedFallbacks[0]!.fallbackModels, [
      "magpie/bp/claude-opus-5-5",
      "magpie/auto/gemini-4-neon",
      "magpie/bp/claude-fable-5-2",
    ]);

    picker.handleInput("["); // move #3 -> #2
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(appliedFallbacks[1]!.fallbackModels, [
      "magpie/bp/claude-opus-5-5",
      "magpie/bp/claude-fable-5-2",
      "magpie/auto/gemini-4-neon",
    ]);

    picker.handleInput("\x1b"); // Esc closes picker
    assert.ok((closedResult as { changed?: boolean })?.changed);
  });

  it("SwarmHubView composes Mission Models card, inline Ctrl+M picker, Goal input, and Launch", async () => {
    const theme = createMockTheme();
    const { tui } = createMockTUI(28, 90);
    const snap = makeSampleSnapshot({ empty: true });
    let completed: unknown;

    const hub = new SwarmHubView(tui, theme, {
      state: {
        settings: {
          ...DEFAULT_SWARM_SETTINGS,
          orchestratorModel: "magpie/bp/claude-fable-5-2",
          orchestratorThinkingLevel: "high",
          workerModel: "magpie/auto/gemini-4-neon",
          workerThinkingLevel: "high",
          validatorModel: "magpie/bp/gpt-6.2-astra",
          validatorThinkingLevel: "high",
        },
        origins: { orchestrator: "global", worker: "global", validator: "global" },
      },
      snapshot: snap,
      runs: [],
      availableModels: sampleModels,
      onComplete: (act) => {
        completed = act;
      },
    });

    for (const w of [40, 80, 120]) {
      assertAllLinesFit(hub.render(w), w, `hub@${w}`);
    }

    // Type goal text, open Ctrl+M picker inline & Esc back, then select Direct Swarm
    for (const ch of "Ship Hub UI") {
      hub.handleInput(ch);
    }
    hub.handleInput("\x1b[109;5u"); // CSI-u Ctrl+M opens inline Model Picker
    assert.match(stripTerminalSequences(hub.render(90).join("\n")), /Swarm Mission Models/);
    hub.handleInput("\x1b"); // Esc returns to Hub
    assert.match(stripTerminalSequences(hub.render(90).join("\n")), /Pi Swarm Mission Hub/);

    hub.handleInput("\x1b[B"); // Down -> Start Direct Swarm
    hub.handleInput("\r"); // Enter launches direct
    assert.deepEqual(completed, { kind: "direct", goal: "Ship Hub UI" });
  });

  it("ConfirmProposalComponent [m] model picker + [c] comment, SwarmOverlay [M]/[m]/[P]/[?], and bindSwarmShortcuts Ctrl+Shift+M/S", async () => {
    const theme = createMockTheme();
    const { tui } = createMockTUI(30, 100);
    const ui = createQuestionnaireUI();
    const plan: ProposedSwarmPlan = {
      title: "v0.4.0 Proposal",
      objective: "Verify [m] and [c] inside proposal modal",
      strategy: "Parallel slices",
      acceptanceCriteria: "Tests green",
      baseBranch: "main",
      maxConcurrency: 4,
      validatorEnabled: true,
      roleModels: {
        orchestrator: { model: "magpie/bp/claude-fable-5-2", thinkingLevel: "high" },
        worker: { model: "magpie/auto/gemini-4-neon", thinkingLevel: "high" },
        validator: { model: "magpie/bp/gpt-6.2-astra", thinkingLevel: "high" },
      },
    };

    const updatedRoleModels: SwarmRoleModels = {
      ...plan.roleModels,
      validator: { model: "magpie/bp/gpt-6.2-astra", thinkingLevel: "medium" },
    };

    const propCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme,
        notify() {},
        async custom<T>(
          factory: (
            t: TUI,
            th: Theme,
            kb: unknown,
            done: (r: T) => void,
          ) => Component & { dispose?(): void },
        ): Promise<T> {
          return new Promise<T>((resolve) => {
            const comp = factory(tui, theme, {}, resolve);
            const initialPlain = stripTerminalSequences(comp.render(100).join("\n"));
            assert.match(initialPlain, /claude-fable-5-2\(high\)/);
            assert.match(initialPlain, /\[Enter\] Confirm & Launch/);
            assert.match(initialPlain, /\[m\] Models/);
            assert.match(initialPlain, /\[c\] Note/);

            comp.handleInput?.("m");
            assert.match(stripTerminalSequences(comp.render(100).join("\n")), /Inline Picker Mock/);
            comp.handleInput?.("\x1b"); // closes inline mock picker and applies updatedRoleModels

            comp.handleInput?.("c");
            for (const ch of "Focus on edge cases") {
              comp.handleInput?.(ch);
            }
            comp.handleInput?.("\r"); // save comment
            comp.handleInput?.("\r"); // confirm proposal
          });
        },
      },
    } as unknown as ExtensionContext;

    const outcome = await ui.confirmProposal(propCtx, plan, {
      onOpenModelPicker: (_t, _th, _init, onDone) => ({
        render: () => ["Inline Picker Mock"],
        invalidate: () => {},
        handleInput: (d: string) => {
          if (d === "\x1b") onDone(updatedRoleModels);
        },
      }),
    });
    assert.equal(outcome.action, "confirm");
    assert.equal(outcome.feedback, "Focus on edge cases");
    assert.deepEqual(outcome.roleModels, updatedRoleModels);

    // SwarmOverlay [?], [P] pause, [M] Mission Models, and [m] working member picker
    const snap = makeSampleSnapshot();
    const pausedCalls: Array<{ runId?: string; reason?: string }> = [];
    const switched: SwitchModelOptions[] = [];
    const overlayEngine: ISwarmEngine = {
      startRun: async () => snap.run!,
      attachRun: async () => snap,
      setTitle: async () => snap.run!,
      updateDirection: async () => snap.run!,
      addMembers: async () => [],
      postMessage: async () => ({
        seq: 1,
        runId: snap.run!.id,
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        channel: "main",
        kind: "chat",
        text: "ok",
        mentions: [],
        channelMentions: [],
        timestamp: new Date().toISOString(),
      }),
      readBoard: async () => ({ messages: snap.recentBoard, head: snap.boardHead }),
      waitForBoard: async () => ({ wokeBy: "timeout", messages: [], head: 0, summary: "" }),
      parkOrchestratorWait: async () => ({
        parked: false,
        messages: [],
        head: 0,
        activeMembers: [],
        summary: "",
      }),
      clearOrchestratorWait: () => {},
      steerMember: async () => ({ delivery: "steered" }),
      switchModel: async (opts) => {
        switched.push(opts);
        return {
          targetName: opts.targetName ?? "worker-1",
          model: opts.model ?? "",
          thinkingLevel: opts.thinkingLevel,
          deferred: true,
        };
      },
      stopMember: async () => {},
      killMember: async () => {},
      mergeMember: async () => null,
      manageChannel: async () => ({
        action: "create",
        name: "main",
        topic: "",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: new Date().toISOString(),
        subscribers: [],
        archived: false,
        summary: "ok",
      }),
      completeRun: async () => snap.run!,
      pause: async (runId, reason) => {
        pausedCalls.push({ runId, reason });
        return { ...snap.run!, status: "paused" };
      },
      resume: async () => snap.run!,
      teardown: async () => ({ removed: [], skipped: [], errors: [] }),
      listModels: async () => sampleModels,
      getSnapshot: () => snap,
      subscribe: () => () => {},
      dispose: async () => {},
    };

    const overlayCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        theme,
        notify() {},
        async custom<T>(
          factory: (
            t: TUI,
            th: Theme,
            kb: unknown,
            done: (r: T) => void,
          ) => Component & { dispose?(): void },
        ): Promise<T> {
          return new Promise<T>((resolve) => {
            const comp = factory(tui, theme, {}, resolve);
            if (isFocusable(comp)) comp.focused = true;
            void (async () => {
              await new Promise((r) => setTimeout(r, 10));
              comp.handleInput?.("?");
              assert.match(stripTerminalSequences(comp.render(100).join("\n")), /Mission Control Shortcuts/);
              comp.handleInput?.("\x1b");

              comp.handleInput?.("P");
              await new Promise((r) => setTimeout(r, 10));
              assert.equal(pausedCalls.length, 1);

              comp.handleInput?.("M");
              assert.match(stripTerminalSequences(comp.render(100).join("\n")), /Swarm Mission Models/);
              comp.handleInput?.("\x1b");

              // Tab 2 [Members] -> m opens interactive member picker even on working worker-1
              comp.handleInput?.("2");
              comp.handleInput?.("m");
              assert.match(stripTerminalSequences(comp.render(100).join("\n")), /Switch Model — @worker-1/);
              comp.handleInput?.("\r"); // select model -> step 2 effort
              comp.handleInput?.("\r"); // apply with deferIfWorking: true
              await new Promise((r) => setTimeout(r, 15));
              assert.equal(switched.length, 1);
              assert.equal(switched[0]!.deferIfWorking, true);

              comp.handleInput?.("q");
            })();
          });
        },
      },
    } as unknown as ExtensionContext;

    await openSwarmOverlay(overlayCtx, overlayEngine, undefined, {
      availableModels: sampleModels,
      onApplyRoleModel: async () => ({ settings: DEFAULT_SWARM_SETTINGS }),
    });

    // bindSwarmShortcuts is a safe no-op in v0.7.0 (Pi registerShortcut routes Alt+S/M/W without hijacking native dialogs)
    const listeners = new Set<(data: string) => unknown>();
    const unbind = bindSwarmShortcuts(
      {
        mode: "tui",
        ui: {
          onTerminalInput: (fn: (d: string) => unknown) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
      } as unknown as ExtensionContext,
      {
        isModalOpen: () => false,
        isExpanded: () => false,
        onToggleExpand: () => {},
        onCollapse: () => {},
        onOpenModelPicker: () => {},
        onOpenMissionControl: () => {},
      },
    );
    assert.equal(listeners.size, 0, "bindSwarmShortcuts must not attach global onTerminalInput");
    unbind();
  });
});

describe("v0.5.0 TUI Protocol, Responsive Bounds & Mission Hub Resume", () => {
  it("bindSwarmShortcuts never intercepts Esc or Alt keys via raw onTerminalInput", () => {
    const listeners: Array<(d: string) => unknown> = [];
    let toggles = 0;
    let collapses = 0;
    let modelOpened = 0;

    const fakeCtx = {
      mode: "tui",
      hasUI: true,
      ui: {
        onTerminalInput(fn: (d: string) => unknown) {
          listeners.push(fn);
          return () => {};
        },
      },
    } as unknown as ExtensionContext;

    const unbind = bindSwarmShortcuts(fakeCtx, {
      isModalOpen: () => false,
      isExpanded: () => true,
      isHostStreaming: () => false,
      onToggleExpand: () => {
        toggles += 1;
      },
      onCollapse: () => {
        collapses += 1;
      },
      onOpenModelPicker: () => {
        modelOpened += 1;
      },
    });

    assert.equal(listeners.length, 0);
    assert.equal(modelOpened, 0);
    assert.equal(toggles, 0);
    assert.equal(collapses, 0);
    unbind();
  });

  it("supports SwarmModelPickerView bracketed paste, fuzzy matching, [host] badge, and 85% height cap", () => {
    const theme = createMockTheme();
    const tuiHandle = createMockTUI(16, 60);
    const models = [
      {
        id: "claude-opus-4-6",
        provider: "anthropic",
        fullId: "anthropic/claude-opus-4-6",
        name: "Claude Opus 4.6",
      },
      {
        id: "gpt-5.4",
        provider: "openai",
        fullId: "openai/gpt-5.4",
        name: "GPT 5.4",
      },
    ];
    let selectedModel: string | undefined;
    const baseState: ModelPickerSettingsState = {
      settings: {
        ...DEFAULT_SWARM_SETTINGS,
        fallbackModels: [],
      },
      origins: {
        orchestrator: "host",
        worker: "host",
        validator: "host",
      },
      hostModel: "openai/gpt-5.4",
    };
    const picker = new SwarmModelPickerView(tuiHandle.tui, theme, {
      mode: "roles",
      initialTab: "orchestrator",
      availableModels: models,
      state: baseState,
      onClose: () => {},
      onApplyRole: async (sel) => {
        selectedModel = sel.model;
        return baseState;
      },
    });

    try {
      for (const [w, h] of [
        [40, 16],
        [60, 16],
        [80, 24],
        [120, 24],
      ] as const) {
        (tuiHandle.tui.terminal as unknown as { columns: number; rows: number }).columns = w;
        (tuiHandle.tui.terminal as unknown as { columns: number; rows: number }).rows = h;
        const lines = picker.render(w);
        const cap = Math.max(10, Math.floor(h * 0.85));
        assert.ok(
          lines.length <= cap,
          `Expected <= ${cap} rows at h=${h}, got ${lines.length}`,
        );
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= w, `Line exceeded width ${w}: ${visibleWidth(line)}`);
        }
      }

      const plainInitial = stripTerminalSequences(picker.render(80).join("\n"));
      assert.match(plainInitial, /\[host\]/);

      // Bracketed paste + fuzzy match (no separators) -> selects Claude Opus 4.6 -> Enter to effort -> Enter default
      picker.handleInput("\x1b[200~claudeopus46\x1b[201~");
      const afterFilter = stripTerminalSequences(picker.render(80).join("\n"));
      assert.match(afterFilter, /claude-opus-4-6/);
      picker.handleInput("\r"); // enter effort step
      picker.handleInput("\r"); // apply Default effort
      assert.equal(selectedModel, "anthropic/claude-opus-4-6");
    } finally {
      picker.dispose();
    }
  });

  it("places Resume Mission first in SwarmHubView when unfinished runs exist and keeps Enter vs Alt+M distinct", () => {
    const theme = createMockTheme();
    const tuiHandle = createMockTUI(24, 90);
    let hubResult: unknown;
    const snap = makeSampleSnapshot({ empty: true });
    const hubState: ModelPickerSettingsState = {
      settings: {
        ...DEFAULT_SWARM_SETTINGS,
        fallbackModels: [],
      },
      origins: { orchestrator: "host", worker: "host", validator: "host" },
      hostModel: "openai/gpt-5.4",
    };
    const hub = new SwarmHubView(tuiHandle.tui, theme, {
      snapshot: snap,
      runs: [
        {
          id: "run-paused-1",
          title: "Paused Feature",
          objective: "Finish Auth Refactor",
          baseBranch: "main",
          status: "paused",
          memberCount: 2,
          workingCount: 0,
          waitingCount: 2,
          boardHead: 9,
          ownerSessionId: "old-sess",
          ownerPid: 0,
          createdAt: "2026-11-22T00:00:00.000Z",
          updatedAt: "2026-11-22T01:00:00.000Z",
        },
      ],
      availableModels: [],
      state: hubState,
      onApplyRole: async () => hubState,
      onComplete: (action) => {
        hubResult = action;
      },
    });

    try {
      const rendered = stripTerminalSequences(hub.render(90).join("\n"));
      assert.match(rendered, /Resume Mission/);
      assert.match(rendered, /Alt\+M/);

      // Alt+M opens inline Model Picker rather than Enter launching
      hub.handleInput("\x1bm");
      const withPicker = stripTerminalSequences(hub.render(90).join("\n"));
      assert.match(withPicker, /Mission Models/);
      hub.handleInput("\x1b"); // close inline picker

      // Enter on #1 action immediately resumes the unfinished Mission
      hub.handleInput("\r");
      assert.deepEqual(hubResult, {
        kind: "resume",
        runId: "run-paused-1",
        kickoff: true,
      });
    } finally {
      hub.dispose();
    }
  });

  it("isolates expandedPost keys in SwarmOverlay and fits MultiQuestionComponent inside 16 rows", async () => {
    const theme = createMockTheme();
    const snap = makeSampleSnapshot();
    const tui = createMockTUI(24, 90).tui;
    let channelCycled = false;
    let posted = false;

    const fakeEngine: ISwarmEngine = {
      startRun: async () => snap.run!,
      attachRun: async () => snap,
      setTitle: async () => snap.run!,
      updateDirection: async () => snap.run!,
      addMembers: async () => [],
      postMessage: async () => {
        posted = true;
        return snap.recentBoard[0]!;
      },
      readBoard: async () => ({ messages: snap.recentBoard, head: snap.boardHead }),
      waitForBoard: async () => ({ wokeBy: "timeout", messages: [], head: 0, summary: "" }),
      parkOrchestratorWait: async () => ({
        parked: false,
        messages: [],
        head: 0,
        activeMembers: [],
        summary: "",
      }),
      clearOrchestratorWait: () => {},
      steerMember: async () => ({ delivery: "steered" }),
      switchModel: async (o) => ({ targetName: o.targetName ?? "", model: o.model ?? "" }),
      stopMember: async () => {},
      killMember: async () => {},
      mergeMember: async () => null,
      manageChannel: async () => ({
        action: "create",
        name: "main",
        topic: "",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: "",
        subscribers: [],
        archived: false,
        summary: "ok",
      }),
      completeRun: async () => snap.run!,
      pause: async () => snap.run!,
      resume: async () => snap.run!,
      teardown: async () => ({ removed: [], skipped: [], errors: [] }),
      listModels: async () => [],
      getSnapshot: () => snap,
      subscribe: () => () => {},
      dispose: async () => {},
    };

    const fakeWorktree = {
      getDiffSummary: async () => ({
        baseBranch: "main",
        branch: "swarm/b",
        commitsAhead: 0,
        changedFiles: [],
        stat: "",
      }),
    } as unknown as IWorktreeManager;

    await openSwarmOverlay(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(tui, theme, {}, resolve);
              comp.handleInput?.("\r"); // open expandedPost on Board
              comp.handleInput?.("p"); // must NOT open post composer while reading post
              comp.handleInput?.("c"); // must NOT cycle channel while reading post
              const outWhileOpen = stripTerminalSequences(comp.render(90).join("\n"));
              if (outWhileOpen.includes("Channel filter")) channelCycled = true;
              comp.handleInput?.("\x1b"); // exit expandedPost back to Board
              comp.handleInput?.("q"); // close overlay
            });
          },
        },
      } as unknown as ExtensionContext,
      fakeEngine,
      fakeWorktree,
    );
    assert.equal(posted, false);
    assert.equal(channelCycled, false);

    // MultiQuestionComponent tight 16-row viewport shows Custom answer mode cleanly
    const compactTui = createMockTUI(16, 72).tui;
    const qui = createQuestionnaireUI();
    const qOutcome = await qui.askQuestionnaire(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(compactTui, theme, {}, resolve);
              const lines = comp.render(72);
              assert.ok(lines.length <= 16, `Expected <= 16 lines, got ${lines.length}`);
              for (const line of lines) assert.ok(visibleWidth(line) <= 72);
              comp.handleInput?.("\r"); // select Q1 option 1 -> advance to Q2
              comp.handleInput?.("\r"); // select Q2 option 1 -> advance to Review
              comp.handleInput?.("\r"); // submit from review tab
            });
          },
        },
      } as unknown as ExtensionContext,
      [
        {
          id: "scope",
          question: "Scope of work?",
          options: [
            { label: "Full", value: "full", description: "Complete implementation" },
            { label: "Minimal", value: "minimal", description: "Small change" },
          ],
          allowCustom: true,
        },
        {
          id: "tests",
          question: "Include E2E tests?",
          options: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ],
          allowCustom: true,
        },
      ],
    );
    assert.equal(qOutcome.cancelled, false);
  });
});

describe("v0.5.1 UI protocol, cursor, responsive bounds & overlay hardening", () => {
  it("HardwareCursorController preserves prior true host cursor and Questionnaire handles blur/focus", async () => {
    const mockTui = createMockTUI(24, 90);
    mockTui.tui.setShowHardwareCursor(true);
    const ctrl = new HardwareCursorController();

    // Skipping no-op sync(false) when prev === null must not clobber pre-existing true state
    ctrl.sync(mockTui.tui, false);
    assert.equal(mockTui.getHardwareCursor(), true);

    // Transition to true captures prior true state, then sync(false) and restore() restore true
    ctrl.sync(mockTui.tui, true);
    assert.equal(mockTui.getHardwareCursor(), true);
    ctrl.sync(mockTui.tui, false);
    assert.equal(mockTui.getHardwareCursor(), true);
    ctrl.sync(mockTui.tui, true);
    ctrl.restore(mockTui.tui);
    assert.equal(mockTui.getHardwareCursor(), true);

    // SingleQuestionComponent freeform blur/focus preserves prior cursor state
    const theme = createMockTheme();
    const qUi = createQuestionnaireUI();
    mockTui.tui.setShowHardwareCursor(true);
    let blurCheckOk = false;
    await qUi.askQuestion(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(mockTui.tui, theme, {}, resolve);
              if (isFocusable(comp)) {
                comp.focused = true;
                assert.equal(mockTui.getHardwareCursor(), true);
                comp.focused = false;
                assert.equal(mockTui.getHardwareCursor(), true);
                comp.focused = true;
                blurCheckOk = true;
              }
              comp.handleInput?.("h");
              comp.handleInput?.("\r");
            });
          },
        },
      } as unknown as ExtensionContext,
      { id: "free", question: "Freeform?", options: [], allowCustom: true },
    );
    assert.equal(blurCheckOk, true);
    assert.equal(mockTui.getHardwareCursor(), true);
  });

  it("decodeModifyOtherKeysPrintable accepts CapsLock/NumLock modifier masks and rejects Ctrl/Alt", () => {
    assert.equal(decodeModifyOtherKeysPrintable("\x1b[27;1;97~"), "a");
    assert.equal(decodeModifyOtherKeysPrintable("\x1b[27;2;65~"), "A");
    assert.equal(decodeModifyOtherKeysPrintable("\x1b[27;65;97~"), "a"); // CapsLock (1+64)
    assert.equal(decodeModifyOtherKeysPrintable("\x1b[27;66;65~"), "A"); // Shift+CapsLock (2+64)
    assert.equal(decodeModifyOtherKeysPrintable("\x1b[27;129;98~"), "b"); // NumLock (1+128)
    assert.equal(decodeModifyOtherKeysPrintable("\x1b[27;193;99~"), "c"); // Caps+NumLock (1+64+128)
    assert.equal(decodeModifyOtherKeysPrintable("\x1b[27;5;97~"), undefined); // Ctrl+a
    assert.equal(decodeModifyOtherKeysPrintable("\x1b[27;3;97~"), undefined); // Alt+a
  });

  it("SwarmHubView gates unfinished runs by live PID, shows Resume CTA for crash-recovered active run, and fits tight rows", () => {
    const theme = createMockTheme();
    const { tui } = createMockTUI(12, 60);
    const completedSnap = makeSampleSnapshot();
    completedSnap.run!.status = "completed";

    const hub1 = new SwarmHubView(tui, theme, {
      snapshot: completedSnap,
      currentSessionId: "sess-b",
      runs: [
        {
          id: "run-live-other",
          title: "Other Live Session",
          objective: "Should be hidden",
          baseBranch: "main",
          status: "active",
          memberCount: 1,
          workingCount: 1,
          waitingCount: 0,
          boardHead: 3,
          ownerSessionId: "sess-a",
          ownerPid: process.pid,
          createdAt: "2026-11-22T00:00:00.000Z",
          updatedAt: "2026-11-22T02:00:00.000Z",
        },
        {
          id: "run-resumable-dead",
          title: "Dead PID Resumable",
          objective: "Should appear",
          baseBranch: "main",
          status: "paused",
          memberCount: 1,
          workingCount: 0,
          waitingCount: 1,
          boardHead: 5,
          ownerSessionId: "sess-old",
          ownerPid: 999999,
          createdAt: "2026-11-22T00:00:00.000Z",
          updatedAt: "2026-11-22T01:00:00.000Z",
        },
      ],
      availableModels: [],
      state: {
        settings: { ...DEFAULT_SWARM_SETTINGS },
        origins: { orchestrator: "host", worker: "host", validator: "host" },
      },
      onComplete: () => {},
    });

    try {
      const rendered1 = hub1.render(60);
      assert.ok(rendered1.length <= 12, `Hub height ${rendered1.length} must fit 12 rows`);
      const plain1 = stripTerminalSequences(rendered1.join("\n"));
      assert.match(plain1, /Dead PID Resumable/);
      assert.ok(!plain1.includes("run-live-other"));
      assert.match(plain1, /Alt\+Enter Direct/); // footer hint not clipped
    } finally {
      hub1.dispose();
    }

    // Crash-recovered active run with 0 working members and activatedRun=false shows Resume CTA
    const recoveredSnap = makeSampleSnapshot({
      members: [makeSampleMember({ name: "worker-1", state: "stopped" })],
    });
    recoveredSnap.run!.status = "active";
    let resumeAction: unknown;
    const { tui: tui24 } = createMockTUI(24, 80);
    const hub2 = new SwarmHubView(tui24, theme, {
      snapshot: recoveredSnap,
      activatedRun: false,
      currentSessionId: "sess-b",
      runs: [],
      availableModels: [],
      state: {
        settings: { ...DEFAULT_SWARM_SETTINGS },
        origins: { orchestrator: "host", worker: "host", validator: "host" },
      },
      onComplete: (a) => {
        resumeAction = a;
      },
    });
    try {
      const plain2 = stripTerminalSequences(hub2.render(80).join("\n"));
      assert.match(plain2, /Resume & Continue Mission/);
      hub2.handleInput("4"); // jump to item #4 (Resume & Continue Mission)
      hub2.handleInput("\r");
      assert.deepEqual(resumeAction, {
        kind: "resume",
        runId: recoveredSnap.run!.id,
        kickoff: true,
      });
    } finally {
      hub2.dispose();
    }
  });

  it("SwarmDashboardComponent.renderExpanded and MultiQuestionComponent Submit tab fit 16 rows cleanly", async () => {
    const theme = createMockTheme();
    const { tui } = createMockTUI(16, 76);
    const snap = makeSampleSnapshot();
    const widget = createSwarmWidget(() => snap, {
      expanded: true,
      modalDepth: 0,
      draftActive: false,
    })(tui, theme);
    try {
      const lines = widget.render(76);
      assert.ok(
        lines.length <= 14,
        `renderExpanded at 16 rows must leave margin (got ${lines.length})`,
      );
      assertAllLinesFit(lines, 76, "expanded@16x76");
    } finally {
      widget.dispose();
    }

    // MultiQuestionComponent Submit tab at 16 rows with > 2 questions preserves bottom hint line
    const qUi = createQuestionnaireUI();
    const questions: QuestionSpec[] = [
      { id: "q1", question: "Q1?", options: [{ label: "A" }] },
      { id: "q2", question: "Q2?", options: [{ label: "B" }] },
      { id: "q3", question: "Q3?", options: [{ label: "C" }] },
      { id: "q4", question: "Q4?", options: [{ label: "D" }] },
    ];
    let submitTabPlain = "";
    let submitTabLines = 0;
    await qUi.askQuestionnaire(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(tui, theme, {}, resolve);
              if (isFocusable(comp)) comp.focused = true;
              comp.handleInput?.("\x1b[Z"); // Shift+Tab directly to Submit tab
              const rendered = comp.render(72);
              submitTabLines = rendered.length;
              submitTabPlain = stripTerminalSequences(rendered.join("\n"));
              comp.handleInput?.("\x1b");
            });
          },
        },
      } as unknown as ExtensionContext,
      questions,
    );
    assert.ok(submitTabLines <= 12, `Submit tab height ${submitTabLines} must fit 16-row dialog`);
    assert.match(submitTabPlain, /… \+\d+ more/);
    assert.match(submitTabPlain, /\[Enter\] confirm · \[Esc\] cancel/);
  });

  it("SwarmOverlayComponent supports ultraCompact 40/60 cols tabs, isTabKey, bounded board refresh, deferIfWorking, and diffRequestId bump", async () => {
    const theme = createMockTheme();
    const { tui } = createMockTUI(24, 60);
    const snap = makeSampleSnapshot({ boardHead: 10 });
    let readBoardCalls = 0;
    const switchCalls: SwitchModelOptions[] = [];
    let resolveFirstDiff: ((d: DiffSummary) => void) | undefined;
    const listeners = new Set<(ev: SwarmEngineEvent) => void>();

    const fakeEngine: ISwarmEngine = {
      startRun: async () => snap.run!,
      attachRun: async () => snap,
      setTitle: async () => snap.run!,
      updateDirection: async () => snap.run!,
      addMembers: async () => [],
      postMessage: async () => snap.recentBoard[0]!,
      readBoard: async () => {
        readBoardCalls += 1;
        return { messages: [], head: 10 }; // empty read with boardHead=10
      },
      waitForBoard: async () => ({ wokeBy: "timeout", messages: [], head: 10, summary: "" }),
      parkOrchestratorWait: async () => ({
        parked: false,
        messages: [],
        head: 10,
        activeMembers: [],
        summary: "",
      }),
      clearOrchestratorWait: () => {},
      steerMember: async () => ({ delivery: "steered" }),
      switchModel: async (opts) => {
        switchCalls.push(opts);
        return {
          targetName: opts.targetName ?? "worker-1",
          model: opts.model ?? "",
          thinkingLevel: opts.thinkingLevel,
          deferred: true,
        };
      },
      stopMember: async () => {},
      killMember: async () => {},
      mergeMember: async () => null,
      manageChannel: async () => ({
        action: "create",
        name: "main",
        topic: "",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: "",
        subscribers: [],
        archived: false,
        summary: "ok",
      }),
      completeRun: async () => snap.run!,
      pause: async () => snap.run!,
      resume: async () => snap.run!,
      teardown: async () => ({ removed: [], skipped: [], errors: [] }),
      listModels: async () => [],
      getSnapshot: () => snap,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      dispose: async () => {},
    };

    const fakeWorktree = {
      getDiffSummary: (_base: string, ref: string) =>
        new Promise<DiffSummary>((resolve) => {
          if (ref === "swarm/dyn/worker-1") {
            resolveFirstDiff = resolve;
          } else {
            resolve({
              baseBranch: "main",
              branch: ref,
              headSha: "abc1234",
              commitsAhead: 0,
              changedFiles: [],
              stat: "",
              diff: "",
            });
          }
        }),
    } as unknown as IWorktreeManager;

    let closed = false;
    await openSwarmOverlay(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(tui, theme, {}, (val) => {
                closed = true;
                resolve(val);
              });
              if (isFocusable(comp)) comp.focused = true;
              void (async () => {
                await flushAsync();
                assert.equal(readBoardCalls, 1);

                // Subsequent subscribe ticks at same boardHead=10 must NOT trigger repeated refreshFullBoard loops
                for (const fn of listeners) {
                  fn({
                    type: "snapshot_changed",
                    runId: snap.run!.id,
                    summary: "tick",
                    snapshot: snap,
                  });
                }
                await flushAsync();
                assert.equal(
                  readBoardCalls,
                  1,
                  "Empty read must not cause infinite refreshFullBoard loop",
                );

                // Tab bar at 40 and 60 cols keeps all 4 tabs visible without clipping [4]Find
                const at40 = stripTerminalSequences(comp.render(40).join("\n"));
                assert.match(at40, /\[1\]Brd/);
                assert.match(at40, /\[4\]Find/);
                const at60 = stripTerminalSequences(comp.render(60).join("\n"));
                assert.match(at60, /\[4\]Find/);

                // modifyOtherKeys Tab sequence switches to Members tab via isTabKey
                comp.handleInput?.("\x1b[27;1;9~");
                const memView = stripTerminalSequences(comp.render(80).join("\n"));
                assert.match(memView, /\[2\] Members/);

                // Start diff load for worker-1, then switch to next member mid-load; resolving stale diff must not clobber
                comp.handleInput?.("d");
                comp.handleInput?.("\x1b[B"); // Down to next member -> bumps diffRequestId
                resolveFirstDiff?.({
                  baseBranch: "main",
                  branch: "swarm/dyn/worker-1",
                  headSha: "abc1234",
                  commitsAhead: 1,
                  changedFiles: ["stale.ts"],
                  stat: "",
                  diff: "+stale",
                });
                await flushAsync();
                const afterSwitch = stripTerminalSequences(comp.render(80).join("\n"));
                assert.ok(!afterSwitch.includes("stale.ts"));

                // Inline [m] on waiting member passes deferIfWorking: true
                comp.handleInput?.("\x1b[A"); // back to worker-1
                snap.run!.members["worker-1"]!.state = "waiting";
                comp.handleInput?.("m");
                for (const ch of "openai/gpt-5:high") comp.handleInput?.(ch);
                comp.handleInput?.("\r");
                await flushAsync();
                assert.equal(switchCalls.length, 1);
                assert.equal(switchCalls[0]!.deferIfWorking, true);
                const afterSwitchMsg = stripTerminalSequences(comp.render(80).join("\n"));
                assert.match(afterSwitchMsg, /Queued switch for worker-1/);

                comp.handleInput?.("q");
              })();
            });
          },
        },
      } as unknown as ExtensionContext,
      fakeEngine,
      fakeWorktree,
    );
    assert.equal(closed, true);
  });
});

describe("v0.6.0 Mission Control Overlay, 1-Keystroke Q&A & Plan Confirmation UX", () => {
  it("renders Mission Pipeline Strip (height >= 20), toggles member Brief & Logs on [Enter], and shows contextual member action bar within 40/60/80/120 & 16-row bounds", async () => {
    const theme = createMockTheme();
    const mockTui = createMockTUI(24, 90);
    const snap = makeSampleSnapshot({
      members: [
        makeSampleMember({
          name: "worker-live",
          role: "worker",
          state: "working",
          workspace: "share",
          branch: "swarm/dyn/worker-live",
          brief: "Implement streaming lexer and verify edge cases",
          logTail: ["Running lexer suite", "All 18 assertions green"],
        }),
        makeSampleMember({
          name: "worker-unmerged",
          role: "worker",
          state: "waiting",
          workspace: "share",
          branch: "swarm/dyn/worker-unmerged",
          parkedOn: "Ready for merge review",
        }),
        makeSampleMember({
          name: "worker-stopped-branch",
          role: "worker",
          state: "stopped",
          workspace: "branch",
          branch: "swarm/dyn/worker-stopped-branch",
        }),
        makeSampleMember({
          name: "worker-merged",
          role: "worker",
          state: "waiting",
          workspace: "share",
          branch: "swarm/dyn/worker-merged",
          mergedCommitSha: "abcdef1234567890",
        }),
        makeSampleMember({
          name: "validator",
          role: "validator",
          state: "waiting",
          workspace: "inherit",
          branch: undefined,
        }),
      ],
    });

    const steered: Array<{ name: string; message: string }> = [];
    const fakeEngine: ISwarmEngine = {
      startRun: async () => snap.run!,
      attachRun: async () => snap,
      setTitle: async () => snap.run!,
      updateDirection: async () => snap.run!,
      addMembers: async () => [],
      postMessage: async () => snap.recentBoard[0]!,
      readBoard: async () => ({ messages: snap.recentBoard, head: snap.boardHead }),
      waitForBoard: async () => ({ wokeBy: "timeout", messages: [], head: 0, summary: "" }),
      parkOrchestratorWait: async () => ({
        parked: false,
        messages: [],
        head: 0,
        activeMembers: [],
        summary: "",
      }),
      clearOrchestratorWait: () => {},
      steerMember: async (name, message) => {
        steered.push({ name, message });
        return { delivery: "steered" };
      },
      switchModel: async (o) => ({ targetName: o.targetName ?? "", model: o.model ?? "" }),
      stopMember: async () => {},
      killMember: async () => {},
      mergeMember: async () => null,
      manageChannel: async () => ({
        action: "create",
        name: "main",
        topic: "",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: "",
        subscribers: [],
        archived: false,
        summary: "ok",
      }),
      completeRun: async () => snap.run!,
      pause: async () => snap.run!,
      resume: async () => snap.run!,
      teardown: async () => ({ removed: [], skipped: [], errors: [] }),
      listModels: async () => [],
      getSnapshot: () => snap,
      subscribe: () => () => {},
      dispose: async () => {},
    };

    await openSwarmOverlay(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(mockTui.tui, theme, {}, resolve);
              if (isFocusable(comp)) comp.focused = true;
              void (async () => {
                await flushAsync();

                // 1. Mission Pipeline Strip visible when rows >= 20 (1 working, 3 waiting, 1 stopped, 1 merged)
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 20;
                const at20Rows = stripTerminalSequences(comp.render(100).join("\n"));
                assert.match(at20Rows, /Objective: Build and verify streaming parser/);
                assert.match(at20Rows, /Working: 1 · Waiting: 3 · Stopped: 1 · Merged: 1/);

                // 2. Switch to [2] Members tab -> selected worker-live (working)
                comp.handleInput?.("2");
                const workingView = stripTerminalSequences(comp.render(80).join("\n"));
                assert.match(
                  workingView,
                  /\[Enter\] Logs  \[w\] Steer Live  \[d\] Diff  \[m\] Queue Model  \[x\] Stop  \[K\] Kill/,
                );

                // [Enter] toggles full Brief & Logs inspector on and off (and toggles [Enter] Info)
                comp.handleInput?.("\r");
                const logsOpen = stripTerminalSequences(comp.render(90).join("\n"));
                assert.match(logsOpen, /Brief & Logs/);
                assert.match(logsOpen, /\[Enter\] Info/);
                assert.match(logsOpen, /Log Tail \(2 line\(s\)\)/);
                assert.match(logsOpen, /Implement streaming lexer and verify edge cases/);

                comp.handleInput?.("\r");
                const logsClosed = stripTerminalSequences(comp.render(90).join("\n"));
                assert.match(logsClosed, /Details & Logs/);
                assert.match(logsClosed, /\[Enter\] Logs/);
                assert.ok(!logsClosed.includes("Log Tail (2 line(s))"));

                // When inline [w] prompt is active, [Enter] submits prompt rather than toggling logs
                comp.handleInput?.("w");
                for (const ch of "keep going") comp.handleInput?.(ch);
                comp.handleInput?.("\r");
                await flushAsync();
                assert.deepEqual(steered, [{ name: "worker-live", message: "keep going" }]);
                assert.match(
                  stripTerminalSequences(comp.render(90).join("\n")),
                  /Details & Logs/,
                );

                // 3. Down -> worker-unmerged (waiting + unmerged share): highlights [g] Merge Branch
                comp.handleInput?.("\x1b[B");
                const unmergedWaitingBar = stripTerminalSequences(comp.render(80).join("\n"));
                assert.match(
                  unmergedWaitingBar,
                  /\[Enter\] Logs  \[g\] Merge Branch  \[d\] Diff  \[w\] Wake  \[m\] Model  \[K\] Kill/,
                );

                // 4. Down -> worker-stopped-branch (stopped + unmerged branch): highlights [r] Retry and [g] Merge Branch
                comp.handleInput?.("\x1b[B");
                const unmergedStoppedBar = stripTerminalSequences(comp.render(88).join("\n"));
                assert.match(
                  unmergedStoppedBar,
                  /\[Enter\] Logs  \[r\] Retry  \[g\] Merge Branch  \[d\] Diff  \[w\] Wake  \[m\] Model  \[K\] Kill/,
                );

                // 5. Down -> worker-merged (already merged share): omits [g] Merge Branch
                comp.handleInput?.("\x1b[B");
                const mergedBar = stripTerminalSequences(comp.render(80).join("\n"));
                assert.match(
                  mergedBar,
                  /\[Enter\] Logs  \[w\] Wake  \[m\] Model  \[K\] Kill/,
                );
                assert.ok(!mergedBar.includes("[g] Merge Branch"));

                // 6. Down -> validator (inherit): omits [g] Merge Branch
                comp.handleInput?.("\x1b[B");
                const inheritBar = stripTerminalSequences(comp.render(80).join("\n"));
                assert.match(
                  inheritBar,
                  /\[Enter\] Logs  \[w\] Wake  \[m\] Model  \[K\] Kill/,
                );
                assert.ok(!inheritBar.includes("[g] Merge Branch"));

                // 7. Strict 40/60/80/120 width + 16-row bounds (strip omitted at 16 rows < 20)
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 16;
                for (const tabKey of ["1", "2", "3", "4"] as const) {
                  comp.handleInput?.(tabKey);
                  if (tabKey === "4") comp.handleInput?.("\x1b"); // exit search input focus so next tab digit switches tab
                  for (const w of [40, 60, 80, 120] as const) {
                    const lines = comp.render(w);
                    assert.ok(
                      lines.length <= 16,
                      `Overlay tab ${tabKey} at 16x${w} exceeded 16 rows: ${lines.length}`,
                    );
                    assertAllLinesFit(lines, w, `v060-overlay-tab${tabKey}@16x${w}`);
                  }
                }
                const at16Plain = stripTerminalSequences(comp.render(100).join("\n"));
                assert.ok(
                  !at16Plain.includes("Working: 1 · Waiting: 3"),
                  "Mission Pipeline Strip must be hidden when terminal height < 20",
                );

                comp.handleInput?.("q");
              })();
            });
          },
        },
      } as unknown as ExtensionContext,
      fakeEngine,
      null,
    );
  });

  it("supports 1-keystroke 1-9 selection (including Custom answer slot) in SingleQuestionComponent & MultiQuestionComponent within 40/60/80/120 & 16-row bounds", async () => {
    const theme = createMockTheme();
    const ui = createQuestionnaireUI();

    const singleSpec: QuestionSpec = {
      id: "strategy",
      question: "How should we partition the refactor?",
      context: "Choose the slice granularity",
      options: [
        { label: "(Recommended) By subsystem", value: "subsystem" },
        { label: "Single worker", value: "single" },
      ],
      recommended: "subsystem",
      allowCustom: true,
    };

    // 1. SingleQuestionComponent: pressing '2' submits option #2 immediately in 1 keystroke
    {
      const shortTui = createMockTUI(16, 80);
      const res = await ui.askQuestion(
        {
          mode: "tui",
          hasUI: true,
          ui: {
            theme,
            notify() {},
            async custom<T>(
              factory: (
                t: TUI,
                th: Theme,
                kb: unknown,
                done: (r: T) => void,
              ) => Component & { dispose?(): void },
            ): Promise<T> {
              return new Promise<T>((resolve) => {
                const comp = factory(shortTui.tui, theme, {}, resolve);
                if (isFocusable(comp)) comp.focused = true;
                for (const w of [40, 60, 80, 120] as const) {
                  const lines = comp.render(w);
                  assert.ok(lines.length <= 16, `SingleQuestion 16x${w} got ${lines.length}`);
                  assertAllLinesFit(lines, w, `v060-single@16x${w}`);
                }
                comp.handleInput?.("9"); // out-of-range digit ignored
                comp.handleInput?.("2"); // 1-keystroke pick & submit
              });
            },
          },
        } as unknown as ExtensionContext,
        singleSpec,
      );
      assert.deepEqual(res, { cancelled: false, answer: "single", isCustom: false });
    }

    // 2. SingleQuestionComponent: pressing '3' ("Custom answer…") enters custom input mode where digits type normally
    {
      const mockTui = createMockTUI(20, 80);
      let sawCursorInCustom = false;
      const res = await ui.askQuestion(
        {
          mode: "tui",
          hasUI: true,
          ui: {
            theme,
            notify() {},
            async custom<T>(
              factory: (
                t: TUI,
                th: Theme,
                kb: unknown,
                done: (r: T) => void,
              ) => Component & { dispose?(): void },
            ): Promise<T> {
              return new Promise<T>((resolve) => {
                const comp = factory(mockTui.tui, theme, {}, resolve);
                if (isFocusable(comp)) comp.focused = true;
                comp.handleInput?.("3"); // slot #3 = Custom answer…
                sawCursorInCustom = mockTui.getHardwareCursor();
                for (const ch of "3 parallel waves") {
                  comp.handleInput?.(ch);
                }
                comp.handleInput?.("\r");
              });
            },
          },
        } as unknown as ExtensionContext,
        singleSpec,
      );
      assert.equal(sawCursorInCustom, true);
      assert.deepEqual(res, {
        cancelled: false,
        answer: "3 parallel waves",
        isCustom: true,
      });
    }

    // 3. MultiQuestionComponent: '2' records Q1 & advances to Q2; '3' on Q2 opens custom input; Submit tab ignores 1-9
    {
      const shortTui = createMockTUI(16, 80);
      const questions: QuestionSpec[] = [
        {
          id: "mode",
          question: "Workspace isolation?",
          options: [
            { label: "(Recommended) share", value: "share" },
            { label: "branch", value: "branch" },
          ],
          allowCustom: true,
        },
        {
          id: "checks",
          question: "Verification command?",
          options: [
            { label: "npm test", value: "npm test" },
            { label: "npm run typecheck", value: "npm run typecheck" },
          ],
          allowCustom: true,
        },
      ];

      let sawQ2AfterDigit = false;
      let sawReviewTabAfterCustom = false;
      const multiRes = await ui.askQuestionnaire(
        {
          mode: "tui",
          hasUI: true,
          ui: {
            theme,
            notify() {},
            async custom<T>(
              factory: (
                t: TUI,
                th: Theme,
                kb: unknown,
                done: (r: T) => void,
              ) => Component & { dispose?(): void },
            ): Promise<T> {
              return new Promise<T>((resolve) => {
                const comp = factory(shortTui.tui, theme, {}, resolve);
                if (isFocusable(comp)) comp.focused = true;
                for (const w of [40, 60, 80, 120] as const) {
                  const lines = comp.render(w);
                  assert.ok(lines.length <= 16, `MultiQuestion 16x${w} got ${lines.length}`);
                  assertAllLinesFit(lines, w, `v060-multi@16x${w}`);
                }

                // Press '2' on Q1 -> selects "branch" and advances immediately to Q2
                comp.handleInput?.("2");
                const q2Plain = stripTerminalSequences(comp.render(80).join("\n"));
                sawQ2AfterDigit = q2Plain.includes("Verification command?");

                // Press '3' on Q2 -> enters "Custom answer…" slot, digits '1'/'2' stay as text
                comp.handleInput?.("3");
                for (const ch of "vitest run 1 2") {
                  comp.handleInput?.(ch);
                }
                comp.handleInput?.("\r"); // saves custom answer & advances to Submit review tab

                const reviewPlain = stripTerminalSequences(comp.render(80).join("\n"));
                sawReviewTabAfterCustom = reviewPlain.includes("Review Answers (2/2 answered)");

                // Pressing '2' on Submit review tab must NOT submit or corrupt answers
                comp.handleInput?.("2");
                comp.handleInput?.("\r"); // confirm Submit all answers
              });
            },
          },
        } as unknown as ExtensionContext,
        questions,
      );

      assert.equal(sawQ2AfterDigit, true);
      assert.equal(sawReviewTabAfterCustom, true);
      assert.equal(multiRes.cancelled, false);
      assert.deepEqual(multiRes.answers, {
        mode: "branch",
        checks: "vitest run 1 2",
      });
    }
  });

  it("polishes ConfirmProposalComponent controls hint line and fits 40/60/80/120 cols and 16-row terminals", async () => {
    const theme = createMockTheme();
    const shortTui = createMockTUI(16, 80);
    const ui = createQuestionnaireUI();
    const plan: ProposedSwarmPlan = {
      title: "v0.6.0 Polished Confirmation",
      objective: "Launch cleanly with self-discoverable controls",
      strategy: "Wave 1 parallel worktrees; Wave 2 independent verification",
      acceptanceCriteria: "npm run typecheck && npm test",
      baseBranch: "main",
      maxConcurrency: 6,
      validatorEnabled: true,
      initialMembers: [
        { name: "author-a", role: "worker", brief: "Slice A", workspace: "share" },
        { name: "verifier", role: "validator", brief: "Audit A", workspace: "inherit" },
      ],
    };

    const outcome = await ui.confirmProposal(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(shortTui.tui, theme, {}, resolve);
              if (isFocusable(comp)) comp.focused = true;

              for (const w of [80, 120] as const) {
                const plain = stripTerminalSequences(comp.render(w).join("\n"));
                assert.match(plain, /\[Enter\] Confirm & Launch/);
                assert.match(plain, /\[m\] Models/);
                assert.match(plain, /\[v\] Validator/);
                assert.match(plain, /\[(\+\/-)\] Concurrency/);
                assert.match(plain, /\[c\] Note/);
              }

              for (const w of [40, 60, 80, 120] as const) {
                const lines = comp.render(w);
                assert.ok(
                  lines.length <= 16,
                  `ConfirmProposal at 16x${w} exceeded 16 rows: ${lines.length}`,
                );
                assertAllLinesFit(lines, w, `v060-confirm@16x${w}`);
              }

              // Open [c] Note at 16 rows -> verify still <= 16 rows across all widths
              comp.handleInput?.("c");
              for (const ch of "Ship cleanly") comp.handleInput?.(ch);
              for (const w of [40, 60, 80, 120] as const) {
                const linesEditing = comp.render(w);
                assert.ok(linesEditing.length <= 16);
                assertAllLinesFit(linesEditing, w, `v060-confirm-note@16x${w}`);
              }
              comp.handleInput?.("\r"); // save note
              for (const w of [40, 60, 80, 120] as const) {
                const linesSaved = comp.render(w);
                assert.ok(linesSaved.length <= 16);
                assertAllLinesFit(linesSaved, w, `v060-confirm-saved@16x${w}`);
              }

              comp.handleInput?.("\r"); // Confirm & Launch
            });
          },
        },
      } as unknown as ExtensionContext,
      plan,
    );

    assert.equal(outcome.action, "confirm");
    assert.equal(outcome.feedback, "Ship cleanly");
  });
});

describe("v0.7.0 UI Live Dashboard & Mission Control Overhaul", () => {
  const fixedNow = () => Date.parse("2026-11-20T17:45:00.000Z");

  it("exports SwarmDashboardComponent & SwarmOverlayComponent, excludes waking members from waiting (no 2w/1wait), shows N stopped, and suppresses · draft on active runs", () => {
    assert.equal(typeof SwarmDashboardComponent, "function");
    assert.equal(typeof SwarmOverlayComponent, "function");

    const theme = createMockTheme();
    const mockTui = createMockTUI(30, 100);

    // 2 members total: slugger is waking (in workingMemberNames while m.state is still "waiting") + checker is working
    const slugger = makeSampleMember({
      name: "slugger",
      role: "worker",
      state: "waiting",
      createdAt: "2026-11-20T17:30:00.000Z",
      turnStartedAt: "2026-11-20T17:44:48.000Z", // 12s ago (not 15m spawn lifetime!)
      currentActivity: "Running tests",
    });
    const checker = makeSampleMember({
      name: "checker",
      role: "validator",
      state: "working",
      createdAt: "2026-11-20T17:31:00.000Z",
      turnStartedAt: "2026-11-20T17:44:55.000Z", // 5s ago
      currentActivity: "Auditing diff",
    });
    const wakingSnap = makeSampleSnapshot({
      members: [slugger, checker],
      boardHead: 5,
    });
    wakingSnap.workingMemberNames = ["slugger", "checker"];
    wakingSnap.waitingMemberNames = ["slugger"]; // stale waiting entry during wakeup transition

    // Status line must report 2 working · 0 waiting (never 2w/1wait) and suppress · draft when active
    const activeStatusWithDraft = formatStatusLine(wakingSnap, true) ?? "";
    assert.match(activeStatusWithDraft, /2 working · 0 waiting/);
    assert.ok(!activeStatusWithDraft.includes("2w/1wait"));
    assert.ok(!activeStatusWithDraft.includes("1 waiting"));
    assert.ok(!activeStatusWithDraft.includes("· draft"), `Active run must suppress · draft: ${activeStatusWithDraft}`);

    // Compact widget must also report 2 working · 0 waiting and use turnStartedAt (12s, 5s) instead of createdAt (15m, 14m)
    const widget = createSwarmWidget(() => wakingSnap, createSwarmWidgetState(), {
      now: fixedNow,
    })(mockTui.tui, theme);
    try {
      const plain100 = stripTerminalSequences(widget.render(100).join("\n"));
      assert.match(plain100, /2 working · 0 waiting/);
      assert.ok(!plain100.includes("(2w/"));
      assert.match(plain100, /slugger Running tests\s+12s/);
      assert.match(plain100, /checker Auditing diff\s+5s/);
      assert.ok(!plain100.includes("15m"), "Must use turnStartedAt rather than spawn createdAt");

      const plain40 = stripTerminalSequences(widget.render(40).join("\n"));
      assert.match(plain40, /2w\/0wait/);
      assert.ok(!plain40.includes("2w/1wait"));
    } finally {
      widget.dispose();
    }

    // Stopped members: show N stopped across compact widget, expanded widget, and status line; paused run still allows · draft
    const stoppedSnap = makeSampleSnapshot({
      members: [
        makeSampleMember({ name: "s1", state: "stopped", error: "SIGTERM" }),
        makeSampleMember({ name: "s2", state: "stopped" }),
      ],
      boardHead: 3,
    });
    stoppedSnap.run!.status = "paused";
    const stoppedStatus = formatStatusLine(stoppedSnap, true) ?? "";
    assert.match(stoppedStatus, /0 working · 0 waiting · 2 stopped/);
    assert.match(stoppedStatus, /· draft$/);

    const stoppedWidget = createSwarmWidget(
      () => stoppedSnap,
      createSwarmWidgetState({ expanded: false }),
      { now: fixedNow },
    )(mockTui.tui, theme);
    try {
      const compactPlain = stripTerminalSequences(stoppedWidget.render(100).join("\n"));
      assert.match(compactPlain, /0 working · 0 waiting · 2 stopped/);
      const narrowPlain = stripTerminalSequences(stoppedWidget.render(48).join("\n"));
      assert.match(narrowPlain, /0w\/0wait\/2stop/);
    } finally {
      stoppedWidget.dispose();
    }
  });

  it("caps renderExpanded at Math.max(8, termRows - 7) for 72x20 without clipping bottom border or newest board post, avoids +1 more row, balances columns at 100x30, formats local clocks, shows Phase/Milestones, and collapses completed runs to 1 line", () => {
    const theme = createMockTheme();

    // 1. 72x20 with 2 members & 6 board messages: height <= 13, bottom border intact, newest post #6 visible, NO "+1 more row"
    {
      const { tui } = createMockTUI(20, 72);
      const snap = makeSampleSnapshot({
        members: [
          makeSampleMember({
            name: "impl-auth",
            role: "worker",
            state: "working",
            model: "anthropic/claude-sonnet-4-5",
            thinkingLevel: "high",
            workspace: "share",
            branch: "swarm/run-demo/impl-auth",
            currentActivity: "Implementing PKCE S256 flow",
          }),
          makeSampleMember({
            name: "verifier",
            role: "validator",
            state: "waiting",
            model: "openai/gpt-6.2-astra",
            thinkingLevel: "high",
            workspace: "inherit",
            branch: undefined,
            parkedOn: "Ready for audit",
          }),
        ],
        boardHead: 6,
      });
      snap.recentBoard.push({
        seq: 6,
        runId: snap.run!.id,
        channel: "main",
        from: "verifier",
        fromRole: "validator",
        text: "Newest board message #6 must never be clipped at 72x20",
        mentions: ["orchestrator"],
        channelMentions: [],
        kind: "done",
        timestamp: "2026-11-20T17:44:30.000Z",
      });

      const widget = createSwarmWidget(
        () => snap,
        createSwarmWidgetState({ expanded: true }),
        { now: fixedNow },
      )(tui, theme);
      try {
        const lines = widget.render(72);
        assert.ok(
          lines.length <= 13,
          `72x20 renderExpanded must be <= termRows - 7 (13), got ${lines.length}`,
        );
        assertAllLinesFit(lines, 72, "v070-expanded@72x20");
        const plainLines = lines.map((l) => stripTerminalSequences(l));
        assert.ok(plainLines[0]!.startsWith("╭─"), "Top border intact");
        assert.ok(plainLines[plainLines.length - 1]!.startsWith("╰─"), "Bottom border intact");
        const joined = plainLines.join("\n");
        assert.match(joined, /impl-auth/);
        assert.match(joined, /verifier/);
        assert.ok(!joined.includes("+1 more row"), "Must not show '+1 more row' when 2 members fit directly");
        assert.match(joined, /#6/);
      } finally {
        widget.dispose();
      }
    }

    // 2. 100x30 column balance (Workspace capped at 18 so Model:thinking & Activity fit cleanly) + Phase & Milestones
    {
      const { tui } = createMockTUI(30, 100);
      const snap = makeSampleSnapshot({
        members: [
          makeSampleMember({
            name: "impl-auth",
            role: "worker",
            state: "working",
            model: "anthropic/claude-sonnet-4-5",
            thinkingLevel: "high",
            workspace: "share",
            branch: "swarm/run-20261123-very-long/impl-auth",
            currentActivity: "Running PKCE verification tests",
          }),
        ],
      });
      snap.run!.phase = "Validation";
      snap.run!.milestones = [
        { label: "Design", status: "done" },
        { label: "Implement", status: "done" },
        { label: "Tests", status: "done" },
        { label: "Audit", status: "in_progress" },
      ];

      const compactWidget = createSwarmWidget(
        () => snap,
        createSwarmWidgetState({ expanded: false }),
        { now: fixedNow },
      )(tui, theme);
      try {
        const compactPlain = stripTerminalSequences(compactWidget.render(100).join("\n"));
        assert.match(compactPlain, /Phase: Validation \[3\/4\]/);
      } finally {
        compactWidget.dispose();
      }

      const expandedWidget = createSwarmWidget(
        () => snap,
        createSwarmWidgetState({ expanded: true }),
        { now: fixedNow },
      )(tui, theme);
      try {
        const lines100 = expandedWidget.render(100);
        assertAllLinesFit(lines100, 100, "v070-expanded@100x30");
        const plain100 = stripTerminalSequences(lines100.join("\n"));
        assert.match(plain100, /Phase: Validation \[3\/4\]/);
        assert.match(plain100, /claude-sonnet-4-5:high/, "Model + thinking level must not be starved at 100x30");
        assert.match(plain100, /Running PKCE verif/, "Activity must have >= 18 chars breathing room at 100x30");
      } finally {
        expandedWidget.dispose();
      }

      // Local HH:MM:SS clock consistency between zero-turn board/status and formatClock
      const ts = snap.recentBoard[0]!.timestamp;
      const expectedLocalClock = formatClock(ts);
      const boardMd = formatZeroTurnBoardView(snap.recentBoard, snap.boardHead);
      const statusMd = formatZeroTurnStatusDashboard(snap, { now: fixedNow });
      assert.ok(boardMd.includes(`\`${expectedLocalClock}\``), "Board clock must use local HH:MM:SS");
      assert.ok(statusMd.includes(`\`${expectedLocalClock}\``), "Status clock must use local HH:MM:SS");
      assert.match(statusMd, /Phase:\*\* Validation \[3\/4\]/);
    }

    // 3. Completed / cancelled / failed collapse to sleek 1-line summary unless manually expanded
    {
      const { tui } = createMockTUI(30, 100);
      for (const terminalStatus of ["completed", "abandoned", "cancelled", "failed"] as const) {
        const snap = makeSampleSnapshot();
        snap.run!.status = terminalStatus as SwarmRunState["status"];
        const state = createSwarmWidgetState({ expanded: false });
        const widget = createSwarmWidget(() => snap, state, { now: fixedNow })(tui, theme);
        try {
          for (const w of [40, 60, 72, 80, 100, 120] as const) {
            const collapsed = widget.render(w);
            assert.equal(
              collapsed.length,
              1,
              `Terminal run (${terminalStatus}) must collapse to 1 line at width ${w}, got ${collapsed.length}`,
            );
            assertAllLinesFit(collapsed, w, `v070-terminal-${terminalStatus}@${w}`);
          }
          // Manually expanded still renders full box
          state.expanded = true;
          const expanded = widget.render(100);
          assert.ok(expanded.length > 5, "Manually expanded terminal run must render full dashboard");
          assertAllLinesFit(expanded, 100, `v070-terminal-expanded-${terminalStatus}@100`);
        } finally {
          widget.dispose();
        }
      }
    }
  });

  it("SwarmOverlayComponent clamps height at termRows=12, runs live 120ms spinner, surfaces inline activity & ✗ error icon, supports j/k vs Shift+K kill, [r] Retry (direct + conflict prefill), Phase/Milestones, narrow 72x20 polish, and updated ? Help", async () => {
    const theme = createMockTheme();
    const mockTui = createMockTUI(24, 100);

    const workingMember = makeSampleMember({
      name: "worker-live",
      role: "worker",
      state: "working",
      workspace: "share",
      branch: "swarm/dyn/worker-live",
      createdAt: "2026-11-20T17:30:00.000Z",
      turnStartedAt: "2026-11-20T17:44:45.000Z", // 15s
      currentActivity: "Running vitest suite",
      brief:
        "Line 1 of a very detailed brief\nLine 2 explaining architecture\nLine 3 explaining invariants\nLine 4 explaining edge cases\nLine 5 explaining verification\nLine 6 explaining cleanup",
      logTail: [
        "This is a long log entry that definitely wraps across multiple terminal columns at 72 width so we can verify every wrapped continuation line keeps the vertical bar gutter intact",
        "Second log line",
      ],
    });
    const erroredMember = makeSampleMember({
      name: "worker-err",
      role: "worker",
      state: "stopped",
      workspace: "share",
      branch: "swarm/dyn/worker-err",
      error: "Process exited unexpectedly with code 1",
    });
    const conflictMember = makeSampleMember({
      name: "worker-conflict",
      role: "worker",
      state: "stopped",
      workspace: "share",
      branch: "swarm/dyn/worker-conflict",
      error: "REBASE_CONFLICT in src/index.ts",
    });

    const snap = makeSampleSnapshot({
      members: [workingMember, erroredMember, conflictMember],
      boardHead: 5,
    });
    snap.run!.phase = "Integration";
    snap.run!.milestones = [
      { label: "Core", status: "done" },
      { label: "UI", status: "done" },
      { label: "Verify", status: "in_progress" },
    ];

    const steered: Array<{ name: string; message: string }> = [];
    const killed: string[] = [];
    const engine: ISwarmEngine = {
      startRun: async () => snap.run!,
      attachRun: async () => snap,
      setTitle: async () => snap.run!,
      updateDirection: async () => snap.run!,
      addMembers: async () => [],
      postMessage: async () => snap.recentBoard[0]!,
      readBoard: async () => ({ messages: snap.recentBoard, head: snap.boardHead }),
      waitForBoard: async () => ({ wokeBy: "timeout", messages: [], head: 0, summary: "" }),
      parkOrchestratorWait: async () => ({
        parked: false,
        messages: [],
        head: 0,
        activeMembers: [],
        summary: "",
      }),
      clearOrchestratorWait: () => {},
      steerMember: async (name, message) => {
        steered.push({ name, message });
        return { delivery: "woken" };
      },
      switchModel: async (o) => ({ targetName: o.targetName ?? "", model: o.model ?? "" }),
      stopMember: async () => {},
      killMember: async (name) => {
        killed.push(name);
      },
      mergeMember: async () => null,
      manageChannel: async () => ({
        action: "create",
        name: "main",
        topic: "",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: "",
        subscribers: [],
        archived: false,
        summary: "ok",
      }),
      completeRun: async () => snap.run!,
      pause: async () => snap.run!,
      resume: async () => snap.run!,
      teardown: async () => ({ removed: [], skipped: [], errors: [] }),
      listModels: async () => [],
      getSnapshot: () => snap,
      subscribe: () => () => {},
      dispose: async () => {},
    };

    let overlayRef: (Component & { dispose?(): void }) | undefined;

    await openSwarmOverlay(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(mockTui.tui, theme, {}, resolve);
              overlayRef = comp;
              if (isFocusable(comp)) comp.focused = true;

              void (async () => {
                await flushAsync();

                // 1. Live spinner ticks while member is working
                const rendersBefore = mockTui.renderCount();
                await new Promise((r) => setTimeout(r, 120));
                assert.ok(
                  mockTui.renderCount() > rendersBefore,
                  "Overlay must tick spinner timer while members are working",
                );

                // 2. Row 2 omits duplicate run title so full 3-role models fit at 100x30; Pipeline Strip shows Phase [2/3] & Stopped: 2
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 30;
                const board100 = stripTerminalSequences(comp.render(100).join("\n"));
                assert.match(board100, /\[Live\] base:main/);
                assert.match(board100, /O:claude-opus-4-6\(high\)/);
                assert.match(board100, /W:gpt-5\.4-codex\(medium\)/);
                assert.match(board100, /V:gemini-2\.5-pro\(high\)/);
                assert.match(board100, /Phase: Integration \[2\/3\]/);
                assert.match(board100, /Working: 1 · Waiting: 0 · Stopped: 2 · Merged: 0/);
                assert.match(board100, /\[\?\] help · \[Esc\/q\] close/);

                // 3. Narrow 72x20 Board header keeps Channel: #main untruncated, and footer keeps [?] help · [Esc/q] close
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 20;
                comp.handleInput?.("c"); // * -> #main
                const board72 = stripTerminalSequences(comp.render(72).join("\n"));
                assert.match(board72, /Channel: #main \(\d+\)/);
                assert.match(board72, /\[\?\] help · \[Esc\/q\] close/);

                // 4. ? Help omits stale ^Shift+M/^Shift+S and lists Alt+S/M/W, j/k, K kill, r retry, Board/Search keys
                comp.handleInput?.("?");
                const help100 = stripTerminalSequences(comp.render(100).join("\n"));
                assert.ok(!help100.includes("^Shift+M"));
                assert.ok(!help100.includes("^Shift+S"));
                assert.match(help100, /Alt\+S \/ Alt\+M \/ Alt\+W/);
                assert.match(help100, /j \/ k/);
                assert.match(help100, /w \/ r \/ m \/ g \/ x \/ K/);
                assert.match(help100, /Board \[1\] & Search \[4\]/);
                comp.handleInput?.("?");

                // 5. Tab 2 (Members): inline activity, ✗ error icon, per-turn elapsed (15s), j/k nav, K kill (not k!)
                comp.handleInput?.("2");
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 24;
                const members100 = stripTerminalSequences(comp.render(100).join("\n"));
                assert.match(members100, /Running vitest suite/);
                assert.match(members100, /15s t:/);
                assert.match(members100, /✗ worker-err/);
                assert.match(members100, /✗ worker-conflict/);

                // Narrow 72x20 Members action bar fits compact labels including [x] Stop and [K] Kill
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 20;
                const members72 = stripTerminalSequences(comp.render(72).join("\n"));
                assert.match(members72, /\[Enter\] Logs \[w\] Steer \[d\] Diff \[m\] Model \[x\] Stop \[K\] Kill/);

                // Members Logs view at 72x20: Brief clips before logs -> shows ↓ scroll (]/PgDn) cue, and wrapped log lines preserve `  │ ` gutter!
                comp.handleInput?.("\r"); // Enter -> Logs mode
                const logsTop72 = stripTerminalSequences(comp.render(72).join("\n"));
                assert.match(logsTop72, /\[Enter\] Info/);
                assert.match(logsTop72, /↓ scroll \(\]\/PgDn\)/);
                // Scroll down to logs and verify every wrapped log line preserves `  │ `
                comp.handleInput?.("]");
                comp.handleInput?.("]");
                comp.handleInput?.("]");
                const logsScrolled72 = stripTerminalSequences(comp.render(72).join("\n"));
                const gutterLines = logsScrolled72
                  .split("\n")
                  .filter((l) => l.includes("log entry") || l.includes("gutter intact") || l.includes("wraps across"));
                assert.ok(gutterLines.length >= 2, "Expected wrapped log lines to be rendered");
                for (const gl of gutterLines) {
                  assert.match(gl, /│\s+/, `Wrapped log line lost left gutter: ${gl}`);
                }
                comp.handleInput?.("\r"); // back to Info

                // j moves Down (worker-live -> worker-err), k moves Up (NOT Kill!)
                comp.handleInput?.("j");
                assert.match(
                  stripTerminalSequences(comp.render(100).join("\n")),
                  /── worker-err — Details & Logs/,
                );
                comp.handleInput?.("k");
                const afterLowercaseK = stripTerminalSequences(comp.render(100).join("\n"));
                assert.match(afterLowercaseK, /── worker-live — Details & Logs/);
                assert.ok(!afterLowercaseK.includes("Kill @"), "Lowercase k must navigate Up, never trigger Kill");

                // Move down with j to worker-err (non-conflict stopped/errored) -> [r] directly revives via steerMember
                comp.handleInput?.("j");
                comp.handleInput?.("r");
                await flushAsync();
                assert.equal(steered.length, 1);
                assert.equal(steered[0]!.name, "worker-err");
                assert.match(steered[0]!.message, /Retry and continue/);

                // Move down with j to worker-conflict -> [r] opens conflict-aware prefilled steer input
                comp.handleInput?.("j");
                comp.handleInput?.("r");
                const conflictPrompt = stripTerminalSequences(comp.render(100).join("\n"));
                assert.match(conflictPrompt, /Conflict retry for @worker-conflict/);
                assert.match(conflictPrompt, /Rebase onto main and resolve conflicts/);
                comp.handleInput?.("\r"); // submit prefilled conflict steer
                await flushAsync();
                assert.equal(steered.length, 2);
                assert.equal(steered[1]!.name, "worker-conflict");
                assert.match(steered[1]!.message, /Rebase onto main and resolve conflicts/);

                // Shift+K triggers Kill confirmation on worker-conflict
                comp.handleInput?.("K");
                assert.match(
                  stripTerminalSequences(comp.render(100).join("\n")),
                  /Kill @worker-conflict permanently\?/,
                );
                comp.handleInput?.("y");
                await flushAsync();
                assert.deepEqual(killed, ["worker-conflict"]);

                // 6. Height clamp at termRows=12 (<= Math.floor(12 * 0.86) = 10) across all 4 tabs and widths 40/60/72/80/100/120
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 12;
                for (const tabKey of ["1", "2", "3", "4"] as const) {
                  comp.handleInput?.(tabKey);
                  if (tabKey === "4") comp.handleInput?.("\x1b");
                  for (const w of [40, 60, 72, 80, 100, 120] as const) {
                    const rendered = comp.render(w);
                    assert.ok(
                      rendered.length <= 10,
                      `Overlay tab ${tabKey} at 12x${w} must clamp to <= 10 rows (got ${rendered.length})`,
                    );
                    assertAllLinesFit(rendered, w, `v070-overlay-tab${tabKey}@12x${w}`);
                    const lastPlain = stripTerminalSequences(rendered[rendered.length - 1]!);
                    assert.ok(
                      lastPlain.startsWith("╰─"),
                      `Bottom border must remain intact at 12x${w}`,
                    );
                  }
                }

                // 7. Search tab narrow 72x20 header & footer fit cleanly
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 20;
                const search72 = stripTerminalSequences(comp.render(72).join("\n"));
                assert.match(search72, /\[\?\] help · \[Esc\/q\] close/);

                comp.handleInput?.("q");
              })();
            });
          },
        },
      } as unknown as ExtensionContext,
      engine,
      null,
      { now: fixedNow, spinnerIntervalMs: 40 },
    );

    // Confirm spinner timer stopped cleanly after overlay closed/disposed
    assert.ok(overlayRef);
    const rendersAfterClose = mockTui.renderCount();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      mockTui.renderCount(),
      rendersAfterClose,
      "Overlay spinner timer must be cleaned up on dispose()",
    );
  });
});

// ============================================================================
// v0.8.0 UI Goal Progress, Contract Inspector & Proposal Card
// ============================================================================

describe("v0.8.0 UI Goal Progress, Contract Inspector & Proposal Card", () => {
  const fixedNow = () => Date.parse("2026-11-24T10:30:00.000Z");
  const WIDTH_MATRIX = [40, 60, 72, 80, 100, 120] as const;
  const AMBIGUOUS_EMOJI_RE = /[\u23f0-\u23ff\u26a0\u{1f300}-\u{1f9ff}]\ufe0f?/u;

  function assertIntactBoxBorders(
    lines: readonly string[],
    width: number,
    label: string,
    checkNoAmbiguousInnerEmoji = true,
  ): void {
    assert.ok(lines.length >= 2, `${label}: expected >= 2 lines, got ${lines.length}`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const w = visibleWidth(line);
      const plain = stripTerminalSequences(line);
      assert.equal(
        w,
        width,
        `${label}: line ${i} visibleWidth expected ${width}, got ${w}: ${JSON.stringify(plain)}`,
      );
      if (i === 0) {
        assert.ok(
          plain.startsWith("╭") && plain.endsWith("╮"),
          `${label}: top border broken on row 0: ${plain}`,
        );
      } else if (i === lines.length - 1) {
        assert.ok(
          plain.startsWith("╰") && plain.endsWith("╯"),
          `${label}: bottom border broken on row ${i}: ${plain}`,
        );
      } else {
        assert.ok(
          plain.startsWith("│") && plain.endsWith("│"),
          `${label}: side borders broken on row ${i}: ${plain}`,
        );
        if (checkNoAmbiguousInnerEmoji) {
          assert.doesNotMatch(
            plain,
            AMBIGUOUS_EMOJI_RE,
            `${label}: inner row ${i} must not contain ambiguous-width emoji: ${plain}`,
          );
        }
      }
    }
  }

  function makeMissionGoalSnapshot(): SwarmSnapshot {
    const snap = makeSampleSnapshot();
    const run = snap.run!;
    run.phase = "Execution";
    run.milestones = [
      {
        label: "Contract",
        status: "done",
        owner: "worker-1",
        sealed: true,
        sealedAt: "2026-11-24T10:10:00.000Z",
      },
      {
        label: "Runtime",
        status: "in_progress",
        owner: "worker-2",
      },
      {
        label: "Verify",
        status: "pending",
      },
    ];
    run.features = [
      {
        id: "feat-store",
        title: "Persist validation state and features JSON",
        description: "Materialize mission artifacts atomically",
        milestone: "Contract",
        fulfills: ["VAL-STORE-01"],
        status: "completed",
        assignedMember: "worker-1",
        mergedCommitSha: "5065d6e070b3defe",
        updatedAt: "2026-11-24T10:10:00.000Z",
      },
      {
        id: "feat-done-2",
        title: "Board handoff metadata normalization",
        description: "Persist discoveredIssues and leftUndone",
        milestone: "Contract",
        dependsOn: ["feat-store"],
        fulfills: ["VAL-STORE-01"],
        status: "completed",
        assignedMember: "worker-1",
        mergedCommitSha: "6176e7f181c4ef0f",
        updatedAt: "2026-11-24T10:12:00.000Z",
      },
      {
        id: "feat-engine",
        title: "Implement manageMission and done gates",
        description: "Enforce 100% VAL pass and zero open debt",
        milestone: "Runtime",
        dependsOn: ["feat-store"],
        fulfills: ["VAL-ENG-01"],
        status: "in_progress",
        assignedMember: "worker-2",
        updatedAt: "2026-11-24T10:20:00.000Z",
      },
      {
        id: "feat-audit",
        title: "Run end-to-end validator check",
        description: "Verify all contract items",
        milestone: "Verify",
        dependsOn: ["feat-engine"],
        fulfills: ["VAL-UI-01"],
        status: "failed",
        assignedMember: "validator",
        updatedAt: "2026-11-24T10:25:00.000Z",
      },
      {
        id: "feat-legacy-drop",
        title: "Deprecated prototype spike",
        description: "Dropped by user scope update",
        milestone: "Verify",
        fulfills: [],
        status: "cancelled",
        updatedAt: "2026-11-24T10:15:00.000Z",
      },
    ];
    run.assertions = [
      {
        id: "VAL-STORE-01",
        title: "Artifacts materialized atomically",
        description: "mission.md, validation-contract.md, and features.json exist",
        evidenceRequired: "node --test tests/store.test.ts passes",
        status: "passed",
        evidence: "10/10 store tests passed; inode cache verified",
        verifiedBy: "validator",
        verifiedByRole: "validator",
        updatedAt: "2026-11-24T10:12:00.000Z",
      },
      {
        id: "VAL-ENG-01",
        title: "Workers cannot self-verify assertions",
        description: "verify_assertion rejects worker role with PERMISSION_DENIED",
        evidenceRequired: "Unit test in tests/engine.test.ts",
        status: "pending",
        updatedAt: "2026-11-24T10:20:00.000Z",
      },
      {
        id: "VAL-UI-01",
        title: "Narrow 72x20 borders remain intact",
        description: "Zero clipped borders across all overlays",
        evidenceRequired: "UI border width matrix check",
        status: "failed",
        evidence: "Pending final audit pass",
        verifiedBy: "validator",
        verifiedByRole: "validator",
        updatedAt: "2026-11-24T10:25:00.000Z",
      },
    ];
    run.handoffItems = [
      {
        id: "handoff-1",
        type: "discovered_issue",
        sourceMember: "worker-1",
        sourceFeatureId: "feat-done-2",
        summary: "Unclaimed assertion warning needs clearer formatting",
        resolution: "open",
        createdAt: "2026-11-24T10:13:00.000Z",
      },
      {
        id: "handoff-2",
        type: "critical_context",
        sourceMember: "worker-2",
        sourceFeatureId: "feat-engine",
        summary: "Sealed milestones reject non-forced feature inserts",
        resolution: "open",
        createdAt: "2026-11-24T10:21:00.000Z",
      },
      {
        id: "handoff-3",
        type: "incomplete_work",
        sourceMember: "worker-1",
        summary: "Add follow-up migration test",
        resolution: "tracked",
        trackedFeatureId: "feat-engine",
        createdAt: "2026-11-24T10:11:00.000Z",
        resolvedAt: "2026-11-24T10:14:00.000Z",
      },
    ];
    run.commands = [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "test", command: "npm run test:file tests/ui.test.ts" },
    ];
    run.boundaries = [
      "Never read or print auth.json",
      "Zero ambiguous-width emoji inside renderBox",
    ];
    run.lastAudit = {
      verdict: "disapproved",
      auditor: "validator",
      summary: "1 assertion failed and 1 tech-debt handoff still open",
      timestamp: "2026-11-24T10:26:00.000Z",
    };
    return snap;
  }

  it("(a) renders live Goal progress in compact widget, status line, and expanded dashboard (respecting 72x20 height cap & exact box borders across 40..120)", () => {
    const theme = createMockTheme();
    const snap = makeMissionGoalSnapshot();

    // 1. Footer status line includes Feat 2/4 · VAL 1/3 · !1 debt
    const statusLine = formatStatusLine(snap, false) ?? "";
    assert.match(statusLine, /Feat 2\/4 · VAL 1\/3 · !1 debt/);

    // 2. Compact widget above editor across 40, 60, 72, 80, 100, 120
    {
      const { tui } = createMockTUI(30, 100);
      const compactWidget = createSwarmWidget(
        () => snap,
        createSwarmWidgetState({ expanded: false }),
        { now: fixedNow },
      )(tui, theme);
      try {
        for (const w of WIDTH_MATRIX) {
          const lines = compactWidget.render(w);
          assertAllLinesFit(lines, w, `v080-compact@${w}`);
        }
        const plain100 = stripTerminalSequences(compactWidget.render(100).join("\n"));
        assert.match(plain100, /\[S\] 1/);
        assert.match(plain100, /Feat \[██░░\] 2\/4/);
        assert.match(plain100, /VAL 1\/3/);
        assert.match(plain100, /!1 debt/);
        assert.match(plain100, /▸ feat-engine/);

        const plain40 = stripTerminalSequences(compactWidget.render(40).join("\n"));
        assert.match(plain40, /Feat 2\/4 · VAL 1\/3 · !1 debt/);
      } finally {
        compactWidget.dispose();
      }
    }

    // 3. Expanded dashboard at 72x20: height <= Math.max(8, 20 - 7) = 13, unclipped bottom border, exact border widths across 40..120
    {
      const { tui } = createMockTUI(20, 72);
      const expanded72 = createSwarmWidget(
        () => snap,
        createSwarmWidgetState({ expanded: true }),
        { now: fixedNow },
      )(tui, theme);
      try {
        const lines72 = expanded72.render(72);
        assert.ok(
          lines72.length <= 13,
          `72x20 expanded dashboard must be <= 13 lines (termRows - 7), got ${lines72.length}`,
        );
        assertIntactBoxBorders(lines72, 72, "v080-expanded@72x20");
        const plain72 = stripTerminalSequences(lines72.join("\n"));
        assert.match(plain72, /Goal Progress/);
        assert.match(plain72, /Feat 2\/4/);
        assert.match(plain72, /VAL 1\/3/);
        assert.match(plain72, /\[S\] Contract/);
        assert.match(plain72, /!1 debt/);
        assert.match(plain72, /\[✓\]/);
        assert.match(plain72, /\[▸\]/);
        assert.match(plain72, /\[!\]/);
        assert.match(plain72, /Alt\+W collapse/);

        for (const w of WIDTH_MATRIX) {
          const linesW = expanded72.render(w);
          assert.ok(linesW.length <= 13, `20-row expanded@${w} exceeded 13 rows: ${linesW.length}`);
          assertIntactBoxBorders(linesW, w, `v080-expanded@20x${w}`);
        }
      } finally {
        expanded72.dispose();
      }
    }

    // 4. Expanded dashboard at 100x30: shows full multi-row Goal Progress + [██░░] bar + [S] sealed milestone + exact borders across 40..120
    {
      const { tui } = createMockTUI(30, 100);
      const expanded100 = createSwarmWidget(
        () => snap,
        createSwarmWidgetState({ expanded: true }),
        { now: fixedNow },
      )(tui, theme);
      try {
        for (const w of WIDTH_MATRIX) {
          const linesW = expanded100.render(w);
          assert.ok(linesW.length <= 23, `30-row expanded@${w} exceeded 23 rows: ${linesW.length}`);
          assertIntactBoxBorders(linesW, w, `v080-expanded@30x${w}`);
        }
        const plain100 = stripTerminalSequences(expanded100.render(100).join("\n"));
        assert.match(plain100, /── Goal Progress/);
        assert.match(plain100, /Feat \[██░░\] 2\/4 · VAL 1\/3 · !1 debt · \[S\] Contract/);
        assert.match(plain100, /\[✓\] feat-done-2/);
        assert.match(plain100, /\[▸\] feat-engine/);
        assert.match(plain100, /\[!\] feat-audit/);
      } finally {
        expanded100.dispose();
      }
    }
  });

  it("(b) formatZeroTurnStatusView renders Markdown tables for Mission Features, VAL-* Validation Contract, Open Handoffs, and Commands / Boundaries", () => {
    assert.equal(formatZeroTurnStatusView, formatZeroTurnStatusDashboard);
    const snap = makeMissionGoalSnapshot();
    const md = formatZeroTurnStatusView(snap, {
      hostModel: "anthropic/claude-sonnet-4-5",
      now: fixedNow,
    });

    assert.match(md, /- \*\*Goal Progress:\*\* Features 2\/4 completed · Validation Contract 1\/3 `VAL-\*` passed · Sealed: `Contract` `\[S\]` · Open Debt: !1/);
    assert.match(md, /- \*\*Last Audit:\*\* `disapproved` by `@validator`/);

    // Mission Features table
    assert.match(md, /#### Mission Features \(2\/4 completed\)/);
    assert.match(md, /\| ID \| Milestone \| Status \| Assigned \| Fulfills \|/);
    assert.match(md, /\| `feat-store` — Persist validation state and features JSON \| Contract `\[S\]` \| \[✓\] `completed` \(`5065d6e`\) \| `@worker-1` \| `VAL-STORE-01` \|/);
    assert.match(md, /\| `feat-engine` — Implement manageMission and done gates \| Runtime \| \[▸\] `in_progress` \| `@worker-2` \| `VAL-ENG-01` \|/);
    assert.match(md, /\| `feat-audit` — Run end-to-end validator check \| Verify \| \[!\] `failed` \| `@validator` \| `VAL-UI-01` \|/);
    assert.match(md, /\| `feat-legacy-drop` — Deprecated prototype spike \| Verify \| \[~\] `cancelled` \| — \| — \|/);

    // Validation Contract table
    assert.match(md, /#### Validation Contract \(1\/3 passed\)/);
    assert.match(md, /\| ID \| Status \| Verified By \| Title \/ Evidence \|/);
    assert.match(md, /\| `VAL-STORE-01` \| \[✓\] `passed` \| `@validator` \(validator\) \| Artifacts materialized atomically — _10\/10 store tests passed; inode cache verified_ \|/);
    assert.match(md, /\| `VAL-ENG-01` \| \[ \] `pending` \| — \| Workers cannot self-verify assertions _\(req: Unit test in tests\/engine\.test\.ts\)_ \|/);
    assert.match(md, /\| `VAL-UI-01` \| \[✗\] `failed` \| `@validator` \(validator\) \| Narrow 72x20 borders remain intact — _Pending final audit pass_ \|/);

    // Open Handoff Tech-Debt table
    assert.match(md, /#### Open Handoff Tech-Debt \(2 open \/ 3 total\)/);
    assert.match(md, /\| ID \| Type \| Source \| Resolution \| Summary \|/);
    assert.match(md, /\| `handoff-1` \| `discovered_issue` \| `@worker-1` \(`feat-done-2`\) \| `open` \| Unclaimed assertion warning needs clearer formatting \|/);
    assert.match(md, /\| `handoff-3` \| `incomplete_work` \| `@worker-1` \| `tracked` -> `feat-engine` \| Add follow-up migration test \|/);

    // Commands & Boundaries section
    assert.match(md, /#### Commands & Boundaries/);
    assert.match(md, /\| `typecheck` \| `npm run typecheck` \|/);
    assert.match(md, /\| `test` \| `npm run test:file tests\/ui\.test\.ts` \|/);
    assert.match(md, /- \*\*Boundary:\*\* Never read or print auth\.json/);
    assert.match(md, /- \*\*Boundary:\*\* Zero ambiguous-width emoji inside renderBox/);
  });

  it("(c) SwarmOverlayComponent surfaces Features, VAL, [S] sealed, and open debt in pipeline strip and toggles [v] Mission Contract & Features view on Graph tab", async () => {
    const theme = createMockTheme();
    const mockTui = createMockTUI(30, 100);
    const snap = makeMissionGoalSnapshot();
    // Add a pending feature so all 5 statuses ([✓], [▸], [ ], [!], [~]) are exercised in the inspector
    snap.run!.features!.splice(3, 0, {
      id: "feat-pending-docs",
      title: "Update CLI help notes",
      description: "Document /swarm contract",
      milestone: "Verify",
      dependsOn: ["feat-engine"],
      fulfills: ["VAL-UI-01"],
      status: "pending",
      updatedAt: "2026-11-24T10:22:00.000Z",
    });

    const engine: ISwarmEngine = {
      startRun: async () => snap.run!,
      attachRun: async () => snap,
      setTitle: async () => snap.run!,
      updateDirection: async () => snap.run!,
      addMembers: async () => [],
      postMessage: async () => snap.recentBoard[0]!,
      readBoard: async () => ({ messages: snap.recentBoard, head: snap.boardHead }),
      waitForBoard: async () => ({ wokeBy: "timeout", messages: [], head: 0, summary: "" }),
      parkOrchestratorWait: async () => ({
        parked: false,
        messages: [],
        head: 0,
        activeMembers: [],
        summary: "",
      }),
      clearOrchestratorWait: () => {},
      steerMember: async () => ({ delivery: "woken" }),
      switchModel: async (o) => ({ targetName: o.targetName ?? "", model: o.model ?? "" }),
      stopMember: async () => {},
      killMember: async () => {},
      mergeMember: async () => null,
      manageChannel: async () => ({
        action: "create",
        name: "main",
        topic: "",
        createdBy: ORCHESTRATOR_NAME,
        createdAt: "",
        subscribers: [],
        archived: false,
        summary: "ok",
      }),
      completeRun: async () => snap.run!,
      pause: async () => snap.run!,
      resume: async () => snap.run!,
      teardown: async () => ({ removed: [], skipped: [], errors: [] }),
      listModels: async () => [],
      getSnapshot: () => snap,
      subscribe: () => () => {},
      dispose: async () => {},
    };

    await openSwarmOverlay(
      {
        mode: "tui",
        hasUI: true,
        ui: {
          theme,
          notify() {},
          async custom<T>(
            factory: (
              t: TUI,
              th: Theme,
              kb: unknown,
              done: (r: T) => void,
            ) => Component & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(mockTui.tui, theme, {}, resolve);
              if (isFocusable(comp)) comp.focused = true;

              void (async () => {
                await flushAsync();

                // 1. Pipeline strip on Board [1] surfaces Features 2/5, VAL 1/3, [S] 1, and !1 debt
                const board100 = stripTerminalSequences(comp.render(100).join("\n"));
                assert.match(board100, /Features 2\/5/);
                assert.match(board100, /VAL 1\/3/);
                assert.match(board100, /\[S\] 1/);
                assert.match(board100, /!1 debt/);

                // 2. Switch to [3] Graph tab -> keeps 4 tabs intact, shows Mission summary banner at top + Spawn Tree + [v] Contract/Graph footer
                comp.handleInput?.("3");
                const graphView100 = stripTerminalSequences(comp.render(100).join("\n"));
                assert.match(graphView100, /\[1\] Board/);
                assert.match(graphView100, /\[2\] Members/);
                assert.match(graphView100, /\[3\] Graph/);
                assert.match(graphView100, /\[4\] Search/);
                assert.match(graphView100, /Mission Contract & Features \[v: inspect\]/);
                assert.match(graphView100, /Spawn Tree/);
                assert.match(graphView100, /\[v\] Contract\/Graph/);

                // Narrow 72x20 check on Graph tab: footer [v] Contract/Graph ... [?] help · [Esc/q] close stays unclipped
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 20;
                const graph72Lines = comp.render(72);
                assertIntactBoxBorders(graph72Lines, 72, "v080-overlay-graph@72x20");
                const graph72Plain = stripTerminalSequences(graph72Lines.join("\n"));
                assert.match(graph72Plain, /\[v\] Contract\/Graph · \[↑↓\/jk\] scroll · \[\?\] help · \[Esc\/q\] close/);

                // ? Help documents [v] Contract/Graph even at 72x20
                comp.handleInput?.("?");
                const help72Lines = comp.render(72);
                assertIntactBoxBorders(help72Lines, 72, "v080-overlay-help@72x20");
                assert.match(stripTerminalSequences(help72Lines.join("\n")), /\[v\] Contract\/Graph/);
                comp.handleInput?.("?");

                // 3. Press [v] on Graph tab -> switches to Mission Contract & Features view!
                (mockTui.tui.terminal as unknown as { rows: number; columns: number }).rows = 40;
                comp.handleInput?.("v");
                for (const w of WIDTH_MATRIX) {
                  const lines = comp.render(w);
                  assertIntactBoxBorders(lines, w, `v080-overlay-contract@40x${w}`);
                }

                // Collect full scrollable Mission Contract & Features content via render + scroll
                const topContract = stripTerminalSequences(comp.render(100).join("\n"));
                comp.handleInput?.("G"); // jump to bottom of contract inspector
                const bottomContract = stripTerminalSequences(comp.render(100).join("\n"));
                const combinedContract = `${topContract}\n${bottomContract}`;

                assert.match(combinedContract, /Mission Contract & Features \[v: Spawn Graph\]/);
                assert.match(combinedContract, /Milestones \(1\/3\)/);
                assert.match(combinedContract, /\[✓\] Contract \[S\]/);
                assert.match(combinedContract, /\[✓\] feat-store.*@worker-1/);
                assert.match(combinedContract, /\[▸\] feat-engine.*@worker-2/);
                assert.match(combinedContract, /\[ \] feat-pending-docs/);
                assert.match(combinedContract, /\[!\] feat-audit.*@validator/);
                assert.match(combinedContract, /\[~\] feat-legacy-drop/);
                assert.match(combinedContract, /fulfills: VAL-ENG-01/);
                assert.match(combinedContract, /Validation Assertions \(1\/3 passed\)/);
                assert.match(combinedContract, /\[✓\] VAL-STORE-01 \[passed\] \(@validator\)/);
                assert.match(combinedContract, /evidence: 10\/10 store tests passed/);
                assert.match(combinedContract, /\[✗\] VAL-UI-01 \[failed\] \(@validator\)/);
                assert.match(combinedContract, /Open Handoffs \(2\)/);
                assert.match(combinedContract, /\[!\] handoff-1 \[discovered_issue\] @worker-1/);
                assert.match(combinedContract, /\[\*\] handoff-2 \[critical_context\] @worker-2/);
                assert.match(combinedContract, /Commands & Boundaries/);

                // Press [v] again -> toggles cleanly back to Spawn & Mention Graph
                comp.handleInput?.("v");
                assert.match(stripTerminalSequences(comp.render(100).join("\n")), /Spawn Tree/);

                comp.handleInput?.("q");
              })();
            });
          },
        },
      } as unknown as ExtensionContext,
      engine,
      null,
      { now: fixedNow },
    );
  });

  it("(d) ConfirmProposalComponent renders Commands & Boundaries, Validation Contract (N VAL-* assertions), and Feature Queue (M features across K milestones) with 0 broken box borders across 40..120, 72x20, and 100x30", () => {
    const theme = createMockTheme();
    const proposal: ProposedSwarmPlan = {
      title: "v0.8.0 Dynamic Mission Goal Engine",
      objective: "Deliver shared validation contract, feature queue, and relentless completion gates",
      strategy: "Wave 1 shared contract & store; Wave 2 parallel runtime, drafting, UI & host slices",
      acceptanceCriteria: "100% VAL-* assertions passed and zero open tech-debt handoffs",
      baseBranch: "main",
      maxConcurrency: 6,
      validatorEnabled: true,
      commands: [
        { name: "typecheck", command: "npm run typecheck" },
        { name: "test", command: "npm test" },
      ],
      boundaries: [
        "Do not read auth.json or credentials",
        "Keep 4 core tools and 3 drafting tools unchanged",
      ],
      milestones: [
        { label: "m1-store", status: "done", sealed: true },
        { label: "m2-slices", status: "in_progress" },
      ],
      assertions: [
        {
          id: "VAL-CONTRACT-01",
          title: "Store persists mission.md and features.json",
          description: "Atomic write with diff cache",
          status: "passed",
          updatedAt: "2026-11-24T10:00:00.000Z",
        },
        {
          id: "VAL-RUNTIME-02",
          title: "Done gate blocks incomplete features and open debt",
          description: "Hard gate unless force=true",
          status: "pending",
          updatedAt: "2026-11-24T10:00:00.000Z",
        },
        {
          id: "VAL-UI-03",
          title: "Proposal card aligns borders across 40..120",
          description: "Strict 1-cell safe glyphs",
          status: "pending",
          updatedAt: "2026-11-24T10:00:00.000Z",
        },
      ],
      features: [
        {
          id: "feat-contract",
          title: "Shared types & store materialization",
          description: "Wave 1 store contract",
          milestone: "m1-store",
          fulfills: ["VAL-CONTRACT-01"],
          status: "completed",
          updatedAt: "2026-11-24T10:00:00.000Z",
        },
        {
          id: "feat-runtime",
          title: "Mission ops & verification gates",
          description: "Wave 2 runtime",
          milestone: "m2-slices",
          dependsOn: ["feat-contract"],
          fulfills: ["VAL-RUNTIME-02"],
          status: "in_progress",
          updatedAt: "2026-11-24T10:00:00.000Z",
        },
        {
          id: "feat-ui",
          title: "Goal dashboard, overlay & proposal card",
          description: "Wave 2 UI",
          milestone: "m2-slices",
          dependsOn: ["feat-contract"],
          fulfills: ["VAL-UI-03"],
          status: "pending",
          updatedAt: "2026-11-24T10:00:00.000Z",
        },
      ],
    };

    // 1. 100x30 viewport: verify all 3 Droid Mission sections + scroll + exact borders across 40..120
    {
      const { tui } = createMockTUI(30, 100);
      let settledOutcome: unknown;
      const comp = new ConfirmProposalComponent(
        tui,
        theme,
        proposal,
        undefined,
        (res) => {
          settledOutcome = res;
        },
      );
      try {
        for (const w of WIDTH_MATRIX) {
          const lines = comp.render(w);
          assert.ok(lines.length <= 26, `100x30 proposal@${w} exceeded 26 lines: ${lines.length}`);
          assertIntactBoxBorders(lines, w, `v080-proposal@30x${w}`);
        }

        const initialPlain = stripTerminalSequences(comp.render(100).join("\n"));
        assert.match(initialPlain, /Commands & Boundaries/);
        assert.match(initialPlain, /\$ typecheck: npm run typecheck/);
        assert.match(initialPlain, /\$ test: npm test/);
        assert.match(initialPlain, /! Do not read auth\.json or credentials/);
        assert.match(initialPlain, /Validation Contract \(3 VAL-\* assertions\)/);
        assert.match(initialPlain, /\[✓\] VAL-CONTRACT-01/);
        assert.match(initialPlain, /\[ \] VAL-RUNTIME-02/);
        assert.match(initialPlain, /\[ \] VAL-UI-03/);
        assert.match(initialPlain, /Feature Queue \(3 features across 2 milestones\)/);

        // Scroll down with ']' / PgDn to inspect feature dependsOn & fulfills + Strategy
        comp.handleInput("]");
        comp.handleInput("]");
        const scrolledPlain = stripTerminalSequences(comp.render(100).join("\n"));
        const combined = `${initialPlain}\n${scrolledPlain}`;
        assert.match(combined, /feat-runtime \[m2-slices\]/);
        assert.match(combined, /fulfills: VAL-RUNTIME-02/);
        assert.match(combined, /dependsOn: feat-contract/);
        assert.match(combined, /feat-contract \[m1-store \[S\]\]/);

        // Confirm & Launch still works seamlessly after scrolling
        comp.handleInput("\r");
        assert.deepEqual(settledOutcome, {
          action: "confirm",
          validatorEnabled: true,
          maxConcurrency: 6,
        });
      } finally {
        comp.dispose();
      }
    }

    // 2. Narrow 72x20 viewport: intact box borders, height <= 16, scrollable preview, all 3 choices visible
    {
      const { tui } = createMockTUI(20, 72);
      const comp72 = new ConfirmProposalComponent(
        tui,
        theme,
        proposal,
        undefined,
        () => {},
      );
      try {
        for (const w of WIDTH_MATRIX) {
          const lines = comp72.render(w);
          assert.ok(lines.length <= 16, `72x20 proposal@${w} exceeded 16 lines: ${lines.length}`);
          assertIntactBoxBorders(lines, w, `v080-proposal@20x${w}`);
        }
        const top72 = stripTerminalSequences(comp72.render(72).join("\n"));
        assert.match(top72, /Commands & Boundaries/);
        assert.match(top72, /Confirm — launch dynamic Swarm/);
        assert.match(top72, /Continue refining/);
        assert.match(top72, /Cancel — discard draft/);

        comp72.handleInput("\x1b[6~"); // PgDn scrolls into Validation Contract & Feature Queue
        const mid72Lines = comp72.render(72);
        assertIntactBoxBorders(mid72Lines, 72, "v080-proposal-scrolled@72x20");
        assert.match(stripTerminalSequences(mid72Lines.join("\n")), /Validation Contract/);
      } finally {
        comp72.dispose();
      }
    }
  });
});

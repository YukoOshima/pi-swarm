import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  isFocusable,
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_SWARM_SETTINGS,
  FINAL_AUDIT_MISSION_ID,
} from "../src/constants.js";
import type {
  BoardMessage,
  DiffSummary,
  FinalAuditStatus,
  FinalAuditVerdict,
  ISwarmOrchestrator,
  IWorktreeManager,
  MissionRecord,
  PostBoardMessageInput,
  ProposedSwarmPlan,
  QuestionSpec,
  RosterEntry,
  SwarmOrchestratorEvent,
  SwarmRoleModels,
  SwarmRunState,
  SwarmSettings,
  SwarmSnapshot,
} from "../src/types.js";
import {
  bindSwarmShortcuts,
  computeActiveFinalAuditRound,
  computeMissionWaves,
  createQuestionnaireUI,
  createSwarmWidget,
  createSwarmWidgetState,
  fitLine,
  formatBoardKindBadge,
  formatCost,
  formatDuration,
  formatFinalAuditBadge,
  formatRoleModelsLine,
  formatRosterRoleBadge,
  formatRosterStatusBadge,
  formatRunStatusBadge,
  formatStatusLine,
  formatTokens,
  formatZeroTurnBoardView,
  formatZeroTurnModelsView,
  formatZeroTurnStatusDashboard,
  isModalOpen,
  joinColumns,
  openTasksOverlay,
  renderBox,
  renderTable,
  resolveFinalAuditDisplayRound,
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

function makeSampleBoard(runId = "run-20261120-abc"): BoardMessage[] {
  return [
    {
      seq: 1,
      runId,
      from: "orchestrator",
      fromRole: "orchestrator",
      text: "@M1 Implement core parser & lexer with full EOF coverage",
      mentions: ["M1"],
      kind: "brief",
      missionId: "M1",
      timestamp: "2026-11-20T17:31:00.000Z",
    },
    {
      seq: 2,
      runId,
      from: "M1",
      fromRole: "worker",
      text: "@validator-M1 [done] Implemented lexer and parser tests; ready for validation",
      mentions: ["validator-M1"],
      kind: "done",
      missionId: "M1",
      timestamp: "2026-11-20T17:41:00.000Z",
    },
    {
      seq: 3,
      runId,
      from: "validator-M1",
      fromRole: "validator",
      text: "@M1 Found p2 EOF guard edge case in src/parser/lexer.ts:42",
      mentions: ["M1"],
      kind: "review",
      missionId: "M1",
      timestamp: "2026-11-20T17:42:00.000Z",
    },
  ];
}

function makeSampleSnapshot(overrides?: {
  status?: SwarmRunState["status"];
  workingAgents?: number;
  waitingAgents?: number;
  extraRoster?: RosterEntry[];
  withRateLimit?: boolean;
  empty?: boolean;
  roleModels?: SwarmRoleModels;
  boardHead?: number;
  recentBoard?: BoardMessage[];
  finalValidatorEnabled?: boolean;
  maxFinalAuditRounds?: number;
  autoFixOnAuditFail?: boolean;
  finalAuditStatus?: FinalAuditStatus;
  finalAuditRound?: number;
  lastAuditedSha?: string;
  latestFinalAudit?: FinalAuditVerdict;
  finalAuditSkippedBy?: string;
  finalAuditSkipReason?: string;
  finalValidatorRosterEntry?: RosterEntry;
  finalAuditRunningAgentId?: string;
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
      runningAgentIds: [],
      workingAgentIds: [],
      waitingAgentIds: [],
      runningCount: 0,
      maxConcurrency: 3,
      boardHead: 0,
      recentBoard: [],
      recentEvents: [],
      unreadOrchestratorMessages: 0,
      roleModels: defaultRoleModels,
      totalTokens: 0,
      totalCost: 0,
      pendingReviews: [],
      pendingArtifactApprovals: [],
      readyToMerge: [],
      updatedAt: "2026-11-20T17:45:00.000Z",
    };
  }

  const missions: Record<string, MissionRecord> = {
    M1: {
      id: "M1",
      title: "Build core parser & tokenizer",
      kind: "build",
      description: "Implement parser module",
      scope: ["src/parser/", "tests/parser.test.ts"],
      deps: [],
      verification: "npm test -- tests/parser.test.ts",
      tasks: [{ id: "t1", title: "Write lexer", done: true }],
      branch: "feat/build-core-parser",
      worktreePath: "/tmp/wt-M1",
      status: "active",
      reviewRound: 1,
      retryCount: 0,
      latestReview: {
        commitSha: "abcdef1234567890",
        missionId: "M1",
        branch: "feat/build-core-parser",
        reviewedAt: "2026-11-20T17:42:00.000Z",
        reviewerAgentId: "val-M1-1",
        status: "p2-1items",
        merge: "fix-then-merge",
        findings: [
          {
            severity: "p2",
            title: "Handle empty EOF cleanly",
            detail: "Guard against zero-length buffer",
            file: "src/parser/lexer.ts",
            line: 42,
          },
        ],
        checks: [{ name: "unit tests", passed: true }],
        decision: "Fix edge case then merge",
      },
      humanStopped: false,
      createdAt: "2026-11-20T17:30:00.000Z",
      updatedAt: "2026-11-20T17:44:00.000Z",
    },
    M2: {
      id: "M2",
      title: "Architecture design spec",
      kind: "artifact",
      description: "Produce architecture report",
      scope: ["docs/architecture.md"],
      deps: [],
      verification: "Human review of docs/architecture.md",
      tasks: [],
      branch: "feat/architecture-design-spec",
      worktreePath: "/tmp/wt-M2",
      status: "completed",
      reviewRound: 0,
      retryCount: 0,
      humanStopped: false,
      createdAt: "2026-11-20T17:30:00.000Z",
      updatedAt: "2026-11-20T17:44:00.000Z",
    },
    M3: {
      id: "M3",
      title: "Integration wiring",
      kind: "build",
      description: "Wire parser into CLI",
      scope: ["src/cli/"],
      deps: ["M1"],
      verification: "npm test",
      tasks: [],
      branch: "feat/integration-wiring",
      worktreePath: "/tmp/wt-M3",
      status: "failed",
      reviewRound: 0,
      retryCount: 2,
      humanStopped: false,
      error: "Test suite exited with code 1",
      createdAt: "2026-11-20T17:30:00.000Z",
      updatedAt: "2026-11-20T17:44:00.000Z",
    },
    M4: {
      id: "M4",
      title: "Dependency survey",
      kind: "survey",
      description: "Audit third-party deps",
      scope: ["package.json"],
      deps: [],
      verification: "Record findings",
      tasks: [],
      branch: "feat/dependency-survey",
      worktreePath: "/tmp/wt-M4",
      status: "merged",
      reviewRound: 0,
      retryCount: 0,
      mergedCommitSha: "11223344",
      mergedAt: "2026-11-20T17:35:00.000Z",
      humanStopped: false,
      createdAt: "2026-11-20T17:30:00.000Z",
      updatedAt: "2026-11-20T17:35:00.000Z",
    },
  };

  const workingCount = overrides?.workingAgents ?? 2;
  const waitingCount = overrides?.waitingAgents ?? 1;
  const roster: Record<string, RosterEntry> = {};
  const workingAgentIds: string[] = [];
  const waitingAgentIds: string[] = [];

  for (let i = 0; i < workingCount; i++) {
    const id = `worker-${i + 1}`;
    const missionId = i === 0 ? "M1" : i === 1 ? "M2" : "M3";
    const role = i === 1 ? "validator" : "worker";
    roster[id] = {
      agentId: id,
      name: role === "validator" ? `validator-${missionId}` : missionId,
      role,
      missionId,
      worktreePath: `/tmp/wt-${missionId}`,
      branch: missions[missionId]?.branch ?? "feat/extra",
      status: "working",
      model:
        role === "validator"
          ? "google/gemini-2.5-pro"
          : "openai/gpt-5.4-codex",
      thinkingLevel: role === "validator" ? "high" : "medium",
      lastReadBoardSeq: 3,
      lastPostBoardSeq: 2,
      turns: 2 + i,
      startedAt: "2026-11-20T17:40:00.000Z",
      humanStopped: false,
      currentActivity: `Running edit on src/${missionId.toLowerCase()}.ts`,
      lastTool: "edit",
      tokens: 12_400 + i * 3_100,
      cost: 0.145 + i * 0.04,
      logTail: [
        "Reading src/parser/lexer.ts",
        "Applying EOF guard patch",
        "Running npm test -- tests/parser.test.ts",
      ],
    };
    workingAgentIds.push(id);
  }

  for (let i = 0; i < waitingCount; i++) {
    const id = `warm-${i + 1}`;
    const missionId = i === 0 ? "M2" : "M4";
    roster[id] = {
      agentId: id,
      name: `warm-${missionId}`,
      role: "worker",
      missionId,
      worktreePath: `/tmp/wt-${missionId}`,
      branch: missions[missionId]?.branch ?? "feat/extra",
      status: "waiting",
      model: "openai/gpt-5.4-codex",
      thinkingLevel: "medium",
      lastReadBoardSeq: 3,
      turns: 4,
      startedAt: "2026-11-20T17:33:00.000Z",
      humanStopped: false,
      currentActivity: "Warm session parked on board #3",
      tokens: 5_200,
      cost: 0.06,
      logTail: ["Completed draft, parked waiting on board"],
    };
    waitingAgentIds.push(id);
  }

  if (overrides?.extraRoster) {
    for (const entry of overrides.extraRoster) {
      roster[entry.agentId] = entry;
      if (entry.status === "working" && !workingAgentIds.includes(entry.agentId)) {
        workingAgentIds.push(entry.agentId);
      } else if (
        entry.status === "waiting" &&
        !waitingAgentIds.includes(entry.agentId)
      ) {
        waitingAgentIds.push(entry.agentId);
      }
    }
  }

  if (overrides?.finalValidatorRosterEntry) {
    const v = overrides.finalValidatorRosterEntry;
    roster[v.agentId] = v;
    if (v.status === "working" && !workingAgentIds.includes(v.agentId)) {
      workingAgentIds.push(v.agentId);
    } else if (v.status === "waiting" && !waitingAgentIds.includes(v.agentId)) {
      waitingAgentIds.push(v.agentId);
    }
  }

  const finalAuditStatus: FinalAuditStatus =
    overrides?.finalAuditStatus ?? "idle";
  const recentBoard = overrides?.recentBoard ?? makeSampleBoard();
  const boardHead =
    overrides?.boardHead ??
    (recentBoard.length > 0 ? recentBoard[recentBoard.length - 1]!.seq : 0);

  const run: SwarmRunState = {
    version: 1,
    id: "run-20261120-abc",
    objective: "Implement parallel parser pipeline with independent validation",
    verificationContract: "All tests pass and tsc --noEmit reports 0 errors",
    baseBranch: "main",
    ownerSessionId: "sess-1",
    ownerPid: process.pid,
    status: overrides?.status ?? "active",
    maxConcurrency: 3,
    validatorEnabled: true,
    maxValidationRounds: 3,
    finalValidatorEnabled: overrides?.finalValidatorEnabled ?? true,
    maxFinalAuditRounds: overrides?.maxFinalAuditRounds ?? 2,
    autoFixOnAuditFail: overrides?.autoFixOnAuditFail ?? true,
    keepWorkersWarm: true,
    finalAuditStatus,
    finalAuditRound: overrides?.finalAuditRound ?? 0,
    lastAuditedSha:
      overrides?.lastAuditedSha ?? overrides?.latestFinalAudit?.commitSha,
    latestFinalAudit: overrides?.latestFinalAudit,
    finalAuditSkippedBy: overrides?.finalAuditSkippedBy,
    finalAuditSkipReason: overrides?.finalAuditSkipReason,
    roleModels: defaultRoleModels,
    revision: 5,
    missions,
    missionOrder: ["M1", "M2", "M3", "M4"],
    roster,
    findings: [],
    createdAt: "2026-11-20T17:30:00.000Z",
    updatedAt: "2026-11-20T17:45:00.000Z",
  };

  return {
    run,
    activeRunId: run.id,
    runningAgentIds: workingAgentIds,
    workingAgentIds,
    waitingAgentIds,
    runningCount: workingAgentIds.length,
    maxConcurrency: 3,
    rateLimitUntil: overrides?.withRateLimit
      ? Date.parse("2026-11-20T17:45:30.000Z")
      : undefined,
    rateLimitReason: overrides?.withRateLimit ? "HTTP 429 rate limit" : undefined,
    boardHead,
    recentBoard,
    recentEvents: [
      {
        id: "ev-1",
        runId: run.id,
        type: "run_created",
        timestamp: "2026-11-20T17:30:00.000Z",
        summary: "Created run with 4 missions",
      },
      {
        id: "ev-2",
        runId: run.id,
        type: "worker_spawned",
        timestamp: "2026-11-20T17:40:00.000Z",
        missionId: "M1",
        summary: "Spawned M1 on feat/build-core-parser",
      },
      {
        id: "ev-3",
        runId: run.id,
        type: "validation_submitted",
        timestamp: "2026-11-20T17:42:00.000Z",
        missionId: "M1",
        summary: "Validation p2-1items (fix-then-merge)",
      },
      {
        id: "ev-4",
        runId: run.id,
        type: "merge_succeeded",
        timestamp: "2026-11-20T17:43:00.000Z",
        missionId: "M4",
        summary: "Closed survey mission M4",
      },
      {
        id: "ev-5",
        runId: run.id,
        type: "mission_failed",
        timestamp: "2026-11-20T17:44:00.000Z",
        missionId: "M3",
        summary: "Worker failed verification",
      },
    ],
    unreadOrchestratorMessages: 1,
    roleModels: defaultRoleModels,
    totalTokens: 28_900,
    totalCost: 0.33,
    pendingReviews: [],
    pendingArtifactApprovals: ["M2"],
    readyToMerge: ["M2"],
    finalAuditStatus,
    latestFinalAudit: overrides?.latestFinalAudit,
    finalAuditRunningAgentId: overrides?.finalAuditRunningAgentId,
    updatedAt: "2026-11-20T17:45:00.000Z",
  };
}

// ============================================================================
// 1. text-utils Tests
// ============================================================================

describe("text-utils", () => {
  it("fitLine guarantees visibleWidth <= width for ANSI, CJK, emoji, and narrow widths", () => {
    const samples = [
      "Simple ASCII line that is moderately long for narrow viewports",
      "\x1b[36m\x1b[1m🐝 Swarm [active]\x1b[0m \x1b[32m中文并行任务编排测试字符串\x1b[0m — extra detail",
      "Line with\nembedded\r\nnewlines\tand tabs",
      "漢字テスト漢字テスト漢字テスト漢字テスト",
      "🚀✨🔥🐝⚠️✓✗●○◐■",
    ];
    const widths = [1, 2, 5, 10, 20, 40, 80, 120];

    for (const sample of samples) {
      for (const w of widths) {
        const fitted = fitLine(sample, w);
        assert.ok(
          visibleWidth(fitted) <= w,
          `fitLine width ${w} exceeded: got ${visibleWidth(fitted)} for ${JSON.stringify(sample)}`,
        );
        assert.ok(!fitted.includes("\n") && !fitted.includes("\r"));

        const padded = fitLine(sample, w, { pad: true });
        assert.ok(
          visibleWidth(padded) <= w,
          `fitLine(pad) width ${w} exceeded: got ${visibleWidth(padded)}`,
        );
      }
    }
    assert.equal(fitLine("anything", 0), "");
  });

  it("wrapLines, joinColumns, renderBox, and renderTable obey width bounds on 40/80/120", () => {
    const theme = createMockTheme();
    const longText =
      theme.fg("accent", "Parallel Swarm Orchestrator: ") +
      "中文字符宽度与ANSI颜色混合换行测试 ".repeat(4) +
      "plus verylongunbreakableidentifier_1234567890_abcdefghijklmnopqrstuvwxyz";

    for (const width of [40, 80, 120]) {
      const wrapped = wrapLines(longText, width, 4);
      assert.ok(wrapped.length <= 4);
      assertAllLinesFit(wrapped, width, `wrapLines@${width}`);

      const joined = joinColumns(
        theme.bold("🐝 Swarm [active] Very long objective title here"),
        theme.fg("success", "12/15 merged · 45.2k tok · $1.23"),
        width,
      );
      assert.ok(visibleWidth(joined) <= width);

      const boxed = renderBox(wrapped, width, {
        title: theme.fg("accent", "🐝 Swarm Box Title"),
        footer: theme.fg("dim", "[Esc] close"),
        borderColor: (s) => theme.fg("border", s),
      });
      assertAllLinesFit(boxed, width, `renderBox@${width}`);

      const rows = [
        {
          id: "M1",
          status: "● active",
          branch: "feat/very-long-branch-name-here",
          scope: "src/core/parser/",
        },
        {
          id: "M2",
          status: "✓ merged",
          branch: "feat/中文-branch",
          scope: "docs/spec.md",
        },
      ];
      const table = renderTable(
        rows,
        [
          { key: "id", header: "ID", minWidth: 4, priority: 100, render: (r) => r.id },
          {
            key: "status",
            header: "Status",
            minWidth: 10,
            priority: 90,
            render: (r) => r.status,
          },
          {
            key: "branch",
            header: "Branch",
            minWidth: 16,
            flex: 2,
            priority: 60,
            render: (r) => r.branch,
          },
          {
            key: "scope",
            header: "Scope",
            minWidth: 14,
            flex: 1,
            priority: 40,
            render: (r) => r.scope,
          },
        ],
        width,
        { theme },
      );
      assertAllLinesFit(table, width, `renderTable@${width}`);
    }
  });

  it("formatDuration, formatTokens, formatCost, and computeMissionWaves format cleanly", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(-5), "0s");
    assert.equal(formatDuration(450), "450ms");
    assert.equal(formatDuration(15_000), "15s");
    assert.equal(formatDuration(125_000), "2m05s");
    assert.equal(formatDuration(180_000), "3m");
    assert.equal(formatDuration(3_900_000), "1h05m");

    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(842), "842");
    assert.equal(formatTokens(1_500), "1.5k");
    assert.equal(formatTokens(12_000), "12k");
    assert.equal(formatTokens(145_600), "146k");
    assert.equal(formatTokens(1_250_000), "1.25M");

    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(0.0025), "$0.0025");
    assert.equal(formatCost(0.42), "$0.42");
    assert.equal(formatCost(12.5), "$12.50");

    const waves = computeMissionWaves([
      { id: "M1", deps: [] },
      { id: "M2", deps: ["M1"] },
      { id: "M3", deps: [] },
      { id: "M4", deps: ["M2", "M3"] },
    ]);
    assert.deepEqual(
      waves.map((w) => w.map((m) => m.id)),
      [["M1", "M3"], ["M2"], ["M4"]],
    );

    // Cycle safety for UI display
    const cyclic = computeMissionWaves([
      { id: "A", deps: ["B"] },
      { id: "B", deps: ["A"] },
    ]);
    assert.equal(cyclic.flat().length, 2);
  });

  it("formats 3-role model pills cleanly across unbounded and tight widths", () => {
    const theme = createMockTheme();
    const roleModels: SwarmRoleModels = {
      orchestrator: { model: "anthropic/claude-opus-4-6-20260201", thinkingLevel: "high" },
      worker: { model: "openai/gpt-5.4-codex", thinkingLevel: "medium" },
      validator: { model: "google/gemini-2.5-pro", thinkingLevel: "high" },
    };

    assert.equal(shortenModelName("anthropic/claude-opus-4-6"), "claude-opus-4-6");
    assert.ok(visibleWidth(shortenModelName("anthropic/claude-opus-4-6-20260201", 15)) <= 15);

    const plainFull = formatRoleModelsLine(roleModels);
    assert.match(plainFull, /^O:anthropic\/claude-opus-4-6-20260201\(high\) · W:openai\/gpt-5\.4-codex\(medium\) · V:google\/gemini-2\.5-pro\(high\)$/);

    const fallbackLine = formatRoleModelsLine(undefined, "host default");
    assert.equal(fallbackLine, "O:host default · W:host default · V:host default");

    for (const width of [20, 40, 60, 80, 120]) {
      const fitted = formatRoleModelsLine(roleModels, "default", {
        maxWidth: width,
        theme,
      });
      assert.ok(
        visibleWidth(fitted) <= width,
        `formatRoleModelsLine exceeded width ${width}: got ${visibleWidth(fitted)}`,
      );
      const stripped = stripTerminalSequences(fitted);
      if (width >= 40) {
        assert.match(stripped, /O:/);
        assert.match(stripped, /W:/);
        assert.match(stripped, /V:/);
      }
    }
  });

  it("formats verifying run status, final audit badges, roster roles/statuses, and board kind badges", () => {
    const theme = createMockTheme();

    assert.equal(formatRunStatusBadge("verifying"), "verifying");
    const themedVerifying = formatRunStatusBadge("verifying", theme);
    assert.equal(stripTerminalSequences(themedVerifying), "verifying");
    assert.ok(themedVerifying.includes("\x1b["));

    assert.equal(formatFinalAuditBadge(undefined), "idle");
    assert.equal(formatFinalAuditBadge("idle"), "idle");
    assert.match(formatFinalAuditBadge("pending"), /pending/);
    assert.match(formatFinalAuditBadge("running", 1, 2), /running \(1\/2\)/);
    assert.match(formatFinalAuditBadge("approved", 2, 2), /approved \(2\/2\)/);
    assert.match(formatFinalAuditBadge("disapproved", 1, 2), /disapproved \(1\/2\)/);
    assert.match(formatFinalAuditBadge("skipped"), /skipped/);

    for (const role of ["worker", "validator", "final-validator"] as const) {
      assert.equal(formatRosterRoleBadge(role), role);
      assert.equal(stripTerminalSequences(formatRosterRoleBadge(role, theme)), role);
    }

    for (const status of [
      "working",
      "waiting",
      "stopped",
      "killed",
      "failed",
      "died",
    ] as const) {
      assert.equal(formatRosterStatusBadge(status), status);
      assert.equal(
        stripTerminalSequences(formatRosterStatusBadge(status, theme)),
        status,
      );
    }

    for (const kind of [
      "brief",
      "done",
      "review",
      "fix",
      "handoff",
      "decision",
      "model_switch",
      "stall",
      "chat",
    ] as const) {
      assert.equal(formatBoardKindBadge(kind), `[${kind}]`);
      assert.equal(
        stripTerminalSequences(formatBoardKindBadge(kind, theme)),
        `[${kind}]`,
      );
    }

    assert.equal(computeActiveFinalAuditRound("running", 0, undefined, true), 1);
    assert.equal(resolveFinalAuditDisplayRound("running", 1, { round: 1 }, true), 2);
    assert.equal(computeActiveFinalAuditRound("disapproved", 1, { round: 1 }, false), 1);
  });
});

// ============================================================================
// 2. dashboard-widget Tests
// ============================================================================

describe("dashboard-widget", () => {
  it("renders empty, drafting, compact (warm waiting + board preview + 3-role pills), and expanded states within widths 40, 80, 120", () => {
    const theme = createMockTheme();
    const fixedNow = () => Date.parse("2026-11-20T17:45:00.000Z");

    // Empty state
    {
      const mock = createMockTUI();
      const state = createSwarmWidgetState();
      const factory = createSwarmWidget(
        () => makeSampleSnapshot({ empty: true }),
        state,
        { now: fixedNow },
      );
      const comp = factory(mock.tui, theme);
      assert.deepEqual(comp.render(80), []);
      comp.dispose();
    }

    // Drafting state (no run)
    {
      const mock = createMockTUI();
      const state = createSwarmWidgetState({
        draftActive: true,
        draftSeed: "Build a parallel web crawler with rate limiting",
      });
      const factory = createSwarmWidget(
        () => makeSampleSnapshot({ empty: true }),
        state,
        { now: fixedNow },
      );
      const comp = factory(mock.tui, theme);
      for (const width of [40, 80, 120]) {
        const lines = comp.render(width);
        assert.ok(lines.length >= 1);
        assertAllLinesFit(lines, width, `draft@${width}`);
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /Swarm Draft/);
        assert.doesNotMatch(plain, /tower/i);
      }
      comp.dispose();
    }

    // Compact mode (5 working, 2 waiting warm, board preview, 3-role pill, rate-limit)
    {
      const mock = createMockTUI();
      const state = createSwarmWidgetState({ expanded: false });
      const snap = makeSampleSnapshot({
        workingAgents: 5,
        waitingAgents: 2,
        boardHead: 12,
        withRateLimit: true,
      });
      const factory = createSwarmWidget(() => snap, state, {
        now: fixedNow,
        maxCompactWorkers: 3,
      });
      const comp = factory(mock.tui, theme);
      for (const width of [40, 80, 120]) {
        const lines = comp.render(width);
        assert.ok(lines.length >= 6);
        assertAllLinesFit(lines, width, `compact@${width}`);
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /Swarm/);
        assert.match(plain, /board:#12/);
        assert.match(plain, /O:/);
        assert.match(plain, /5 working · 2 waiting warm/);
        assert.match(plain, /\+2 more working agents/);
        assert.match(plain, /#3 validator-M1:/);
        assert.doesNotMatch(plain, /tower/i);
        if (width >= 100) {
          assert.match(plain, /\/swarm board/);
        }
      }
      comp.dispose();
    }

    // Expanded mode (3-role models bar + Missions + Live Roster + Final Validation + Recent Board + Recent Activity)
    {
      const mock = createMockTUI(36, 120);
      const state = createSwarmWidgetState({ expanded: true });
      const snap = makeSampleSnapshot({
        workingAgents: 1,
        waitingAgents: 1,
        extraRoster: [
          {
            agentId: "killed-1",
            name: "old-M3",
            role: "worker",
            missionId: "M3",
            worktreePath: "/tmp/wt-M3",
            branch: "feat/integration-wiring",
            status: "killed",
            model: "openai/gpt-5.4-codex",
            lastReadBoardSeq: 2,
            turns: 1,
            startedAt: "2026-11-20T17:32:00.000Z",
            endedAt: "2026-11-20T17:36:00.000Z",
            humanStopped: false,
            tokens: 1_200,
            cost: 0.01,
            logTail: [],
          },
        ],
      });
      const factory = createSwarmWidget(() => snap, state, { now: fixedNow });
      const comp = factory(mock.tui, theme);
      for (const width of [40, 80, 120]) {
        const lines = comp.render(width);
        assert.ok(lines.length >= 10);
        assertAllLinesFit(lines, width, `expanded@${width}`);
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /Swarm Dashboard/);
        assert.match(plain, /Models:/);
        assert.match(plain, /Final Validation:/);
        assert.match(plain, /Missions/);
        assert.match(plain, /M1/);
        assert.match(plain, /Roster/);
        assert.match(plain, /Recent Board/);
        assert.doesNotMatch(plain, /tower/i);
      }
      comp.dispose();
    }
  });

  it("animates spinner timer while working, stays idle when only warm-waiting, and clears timer on dispose()", async () => {
    const theme = createMockTheme();

    // Only warm waiting agents -> no spinner ticks!
    {
      const mock = createMockTUI();
      const state = createSwarmWidgetState();
      const waitingOnlySnap = makeSampleSnapshot({
        workingAgents: 0,
        waitingAgents: 2,
      });
      const comp = createSwarmWidget(() => waitingOnlySnap, state, {
        spinnerIntervalMs: 40,
      })(mock.tui, theme);
      comp.render(80);
      await new Promise((r) => setTimeout(r, 110));
      assert.equal(mock.renderCount(), 0, "Warm waiting-only swarm should not spin timer");
      comp.dispose();
    }

    // Working agents -> spinner ticks until dispose()
    {
      const mock = createMockTUI();
      const state = createSwarmWidgetState();
      const snap = makeSampleSnapshot({ workingAgents: 1, waitingAgents: 0 });
      const comp = createSwarmWidget(() => snap, state, {
        spinnerIntervalMs: 40,
      })(mock.tui, theme);

      comp.render(80);
      await new Promise((r) => setTimeout(r, 110));
      const countBeforeDispose = mock.renderCount();
      assert.ok(
        countBeforeDispose >= 1,
        `Expected spinner timer to trigger requestRender, got ${countBeforeDispose}`,
      );

      comp.dispose();
      await new Promise((r) => setTimeout(r, 110));
      assert.equal(
        mock.renderCount(),
        countBeforeDispose,
        "Spinner timer must not tick after dispose()",
      );
    }
  });

  it("bindSwarmShortcuts guards on isModalOpen and handles Ctrl+Shift+T and Esc", () => {
    let listener:
      | ((data: string) => { consume?: boolean; data?: string } | undefined)
      | undefined;
    let unsubscribed = false;

    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        onTerminalInput(fn: NonNullable<typeof listener>) {
          listener = fn;
          return () => {
            unsubscribed = true;
          };
        },
      },
    } as unknown as ExtensionContext;

    const state = createSwarmWidgetState();
    let toggleCalls = 0;
    let collapseCalls = 0;

    const unbind = bindSwarmShortcuts(ctx, {
      isModalOpen: () => isModalOpen(state),
      isExpanded: () => state.expanded,
      onToggleExpand: () => {
        toggleCalls++;
        state.expanded = !state.expanded;
      },
      onCollapse: () => {
        collapseCalls++;
        state.expanded = false;
      },
    });

    assert.ok(listener);
    assert.equal(listener("\x1b"), undefined);
    assert.equal(collapseCalls, 0);

    const toggleRes = listener("\x1b[116;6u");
    assert.deepEqual(toggleRes, { consume: true });
    assert.equal(state.expanded, true);
    assert.equal(toggleCalls, 1);

    // Modal open -> ignore both
    state.modalDepth = 1;
    assert.equal(listener("\x1b[116;6u"), undefined);
    assert.equal(listener("\x1b"), undefined);
    assert.equal(state.expanded, true);

    // Modal closed -> Esc collapses
    state.modalDepth = 0;
    const escRes = listener("\x1b");
    assert.deepEqual(escRes, { consume: true });
    assert.equal(state.expanded, false);
    assert.equal(collapseCalls, 1);

    unbind();
    assert.equal(unsubscribed, true);
  });

  it("formats status line, zero-turn status dashboard, board view, and 3-role models view cleanly", () => {
    const empty = makeSampleSnapshot({ empty: true });
    assert.equal(formatStatusLine(empty, false), undefined);
    assert.equal(formatStatusLine(empty, true), "🐝 swarm:draft");
    assert.match(formatZeroTurnStatusDashboard(empty), /No active Swarm run/);
    assert.match(
      formatZeroTurnStatusDashboard(empty, {
        draftActive: true,
        draftSeed: "Refactor auth",
      }),
      /Swarm Draft Active/,
    );

    const active = makeSampleSnapshot({
      workingAgents: 2,
      waitingAgents: 1,
      boardHead: 12,
      withRateLimit: true,
    });
    const statusLine = formatStatusLine(active, false);
    assert.ok(statusLine);
    assert.match(statusLine, /swarm:active 2w\/1wait #12/);
    assert.match(statusLine, /1\/4 merged/);
    assert.match(statusLine, /1 approval/);
    assert.doesNotMatch(statusLine, /tower/i);

    const md = formatZeroTurnStatusDashboard(active, {
      now: () => Date.parse("2026-11-20T17:45:00.000Z"),
    });
    assert.match(md, /Swarm Status/);
    assert.match(md, /run-20261120-abc/);
    assert.match(md, /#### 3-Role Models/);
    assert.match(md, /anthropic\/claude-opus-4-6/);
    assert.match(md, /openai\/gpt-5\.4-codex/);
    assert.match(md, /google\/gemini-2\.5-pro/);
    assert.match(md, /Base Branch.*`main`/);
    assert.match(md, /Missions by Wave/);
    assert.match(md, /\| W1 \| `M1`/);
    assert.match(md, /\| W2 \| `M3`/);
    assert.match(md, /### Final Verification/);
    assert.match(md, /Pending Artifact Sign-Off.*`M2`/);
    assert.match(md, /Rate-Limit Backoff/);
    assert.match(md, /#### Live Roster/);
    assert.match(md, /waiting/);
    assert.match(md, /#### Recent Board \(#12\)/);
    assert.match(md, /#3/);
    assert.match(md, /Recent Activity/);
    assert.doesNotMatch(md, /tower/i);

    // formatZeroTurnBoardView
    const emptyBoard = formatZeroTurnBoardView([], 0);
    assert.match(emptyBoard, /Swarm Board \(head: #0\)/);
    assert.match(emptyBoard, /No board messages posted yet/);

    const boardMd = formatZeroTurnBoardView(active.recentBoard, 12, {
      runId: active.activeRunId ?? undefined,
    });
    assert.match(boardMd, /Swarm Board — `run-20261120-abc` \(head: #12\)/);
    assert.match(boardMd, /\*\*#1\*\*.*`\[brief\]`.*\*\*orchestrator\*\* -> @M1/);
    assert.match(boardMd, /\*\*#2\*\*.*`\[done\]`.*\*\*M1\*\* -> @validator-M1/);
    assert.match(boardMd, /\*\*#3\*\*.*`\[review\]`.*\*\*validator-M1\*\* -> @M1/);
    assert.doesNotMatch(boardMd, /tower/i);

    // formatZeroTurnModelsView
    const settings: SwarmSettings = {
      ...DEFAULT_SWARM_SETTINGS,
      orchestratorModel: "anthropic/claude-opus-4-6",
      orchestratorThinkingLevel: "high",
      workerModel: "openai/gpt-5.4-codex",
      workerThinkingLevel: "medium",
      validatorModel: "google/gemini-2.5-pro",
      validatorThinkingLevel: "high",
      fallbackModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-4.1"],
    };
    const modelsMd = formatZeroTurnModelsView(
      settings,
      active,
      "anthropic/claude-sonnet-4-5",
    );
    assert.match(modelsMd, /### 🐝 Swarm 3-Role Models/);
    assert.match(modelsMd, /Host Default Model.*`anthropic\/claude-sonnet-4-5`/);
    assert.match(modelsMd, /\| orchestrator \| `anthropic\/claude-opus-4-6`/);
    assert.match(modelsMd, /\| worker \| `openai\/gpt-5\.4-codex`/);
    assert.match(modelsMd, /\| validator \| `google\/gemini-2\.5-pro`/);
    assert.match(modelsMd, /Fallback Models.*`anthropic\/claude-sonnet-4-5`, `openai\/gpt-4\.1`/);
    assert.match(modelsMd, /#### Live Roster Models/);
    assert.match(modelsMd, /`warm-M2`.*waiting.*`openai\/gpt-5\.4-codex`/);
    assert.match(modelsMd, /`validator-M2`.*working.*`google\/gemini-2\.5-pro`/);
    assert.doesNotMatch(modelsMd, /tower/i);
  });

  it("renders Final Validator verifying (round 1/2 & 2/2) and disapproved states within width bounds", () => {
    const theme = createMockTheme();
    const fixedNow = () => Date.parse("2026-11-20T17:45:00.000Z");

    const validatorEntry: RosterEntry = {
      agentId: "final-val-1",
      name: "final-validator",
      role: "final-validator",
      missionId: FINAL_AUDIT_MISSION_ID,
      worktreePath: "/tmp/repo",
      branch: "main",
      status: "working",
      model: "google/gemini-2.5-pro",
      lastReadBoardSeq: 5,
      turns: 1,
      startedAt: "2026-11-20T17:44:10.000Z",
      humanStopped: false,
      currentActivity: "Running full integration suite on main",
      lastTool: "read",
      tokens: 6_200,
      cost: 0.08,
      logTail: [
        "Inspecting merged diff against verification contract",
        "Checking src/cli/index.ts wiring",
      ],
    };

    const verifyingSnap = makeSampleSnapshot({
      status: "verifying",
      workingAgents: 0,
      waitingAgents: 1,
      finalValidatorEnabled: true,
      maxFinalAuditRounds: 2,
      finalAuditStatus: "running",
      finalAuditRound: 0,
      finalValidatorRosterEntry: validatorEntry,
      finalAuditRunningAgentId: validatorEntry.agentId,
    });

    // Compact widget during verifying round 1/2
    {
      const mock = createMockTUI();
      const state = createSwarmWidgetState({ expanded: false });
      const comp = createSwarmWidget(() => verifyingSnap, state, { now: fixedNow })(
        mock.tui,
        theme,
      );
      for (const width of [40, 80, 120]) {
        const lines = comp.render(width);
        assertAllLinesFit(lines, width, `compact-verifying@${width}`);
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /verifying/);
        assert.match(plain, /Final Validator \(round 1\/2\)/);
      }
      comp.dispose();
    }

    const verifyingLine = formatStatusLine(verifyingSnap, false);
    assert.ok(verifyingLine);
    assert.match(verifyingLine, /swarm:verifying r1\/2/);

    // Disapproved state + Round 2/2 verifying
    const disapprovedVerdict: FinalAuditVerdict = {
      commitSha: "deadbeef1234567890",
      baseBranch: "main",
      auditedAt: "2026-11-20T17:44:50.000Z",
      verifierAgentId: "final-val-1",
      verdict: "disapproved",
      summary: "CLI wiring misses error exit code on parser failure",
      checks: [
        { name: "typecheck", passed: true },
        { name: "integration tests", passed: false, detail: "1 failing test" },
      ],
      findings: [
        {
          severity: "p1",
          title: "Missing non-zero exit code",
          detail: "CLI exits 0 when parser throws",
          file: "src/cli/main.ts",
          line: 88,
        },
        {
          severity: "p2",
          title: "Missing README usage section",
          detail: "Document --strict flag",
        },
      ],
      recommendedMissions: [
        {
          title: "Fix CLI exit code propagation",
          description: "Return exit code 1 on parse failure",
          scope: ["src/cli/main.ts"],
          verification: "npm test",
          kind: "build",
        },
      ],
      round: 1,
    };

    const disapprovedSnap = makeSampleSnapshot({
      status: "active",
      workingAgents: 0,
      waitingAgents: 1,
      finalValidatorEnabled: true,
      maxFinalAuditRounds: 2,
      finalAuditStatus: "disapproved",
      finalAuditRound: 1,
      lastAuditedSha: disapprovedVerdict.commitSha,
      latestFinalAudit: disapprovedVerdict,
    });

    {
      const mock = createMockTUI();
      const state = createSwarmWidgetState({ expanded: false });
      const comp = createSwarmWidget(() => disapprovedSnap, state, { now: fixedNow })(
        mock.tui,
        theme,
      );
      for (const width of [40, 80, 120]) {
        const lines = comp.render(width);
        assertAllLinesFit(lines, width, `compact-disapproved@${width}`);
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /Final Validator disapproved/);
      }
      comp.dispose();
    }

    const round2Snap = makeSampleSnapshot({
      status: "verifying",
      workingAgents: 0,
      waitingAgents: 0,
      finalValidatorEnabled: true,
      maxFinalAuditRounds: 2,
      finalAuditStatus: "running",
      finalAuditRound: 1,
      latestFinalAudit: disapprovedVerdict,
      finalValidatorRosterEntry: validatorEntry,
      finalAuditRunningAgentId: validatorEntry.agentId,
    });
    assert.match(formatStatusLine(round2Snap, false) ?? "", /swarm:verifying r2\/2/);
    assert.match(
      formatZeroTurnStatusDashboard(round2Snap, { now: fixedNow }),
      /Round:\*\* 2\/2/,
    );
  });
});

// ============================================================================
// 3. questionnaire Tests (TUI + RPC + Non-Interactive)
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

  it("askQuestion & askQuestionnaire TUI navigate options, support IME custom Input, and use Swarm titles", async () => {
    let modalDepth = 0;
    let maxModalDepth = 0;
    const ui = createQuestionnaireUI({
      onModalEnter: () => {
        modalDepth++;
        maxModalDepth = Math.max(maxModalDepth, modalDepth);
      },
      onModalExit: () => {
        modalDepth--;
      },
    });

    const spec: QuestionSpec = {
      id: "scope",
      question: "Which test runner should workers use?",
      context: "Used in mission verification contracts",
      options: [
        { label: "Node test runner", value: "node:test", description: "Zero extra deps" },
        { label: "Vitest", value: "vitest", description: "Fast TS runner" },
      ],
      recommended: "node:test",
      allowCustom: true,
    };

    // Custom input with CURSOR_MARKER & hardware cursor restoration
    {
      let sawCursorMarker = false;
      let sawHardwareCursorEnabled = false;
      let hardwareCursorAfterSubmit = true;
      let sawSwarmTitle = false;
      const { ctx } = createTuiCustomHarness((comp, mockTui) => {
        for (const w of [40, 80, 120]) {
          assertAllLinesFit(comp.render(w), w, `askQuestion@${w}`);
        }
        const initialPlain = stripTerminalSequences(comp.render(80).join("\n"));
        sawSwarmTitle = initialPlain.includes("Swarm Question");
        assert.doesNotMatch(initialPlain, /tower/i);

        comp.handleInput?.("\x1b[B");
        comp.handleInput?.("\x1b[B");
        comp.handleInput?.("\r");
        sawHardwareCursorEnabled = mockTui.getHardwareCursor();
        for (const ch of "bun test") {
          comp.handleInput?.(ch);
        }
        const rendered = comp.render(80);
        assertAllLinesFit(rendered, 80, "askQuestion-custom@80");
        sawCursorMarker = rendered.some((line) => line.includes(CURSOR_MARKER));
        comp.handleInput?.("\r");
        hardwareCursorAfterSubmit = mockTui.getHardwareCursor();
      });

      const res = await ui.askQuestion(ctx, spec);
      assert.deepEqual(res, { cancelled: false, answer: "bun test", isCustom: true });
      assert.equal(sawSwarmTitle, true);
      assert.equal(sawCursorMarker, true);
      assert.equal(sawHardwareCursorEnabled, true);
      assert.equal(hardwareCursorAfterSubmit, false);
      assert.equal(modalDepth, 0);
      assert.equal(maxModalDepth, 1);
    }

    // Multi-question tabs
    {
      const questions: QuestionSpec[] = [
        {
          id: "arch",
          question: "Pick storage backend",
          options: [
            { label: "JSONL + state.json", value: "jsonl" },
            { label: "SQLite", value: "sqlite" },
          ],
          recommended: "jsonl",
        },
        {
          id: "branch",
          question: "Target base branch?",
          options: [{ label: "main", value: "main" }],
          allowCustom: true,
        },
      ];
      const { ctx } = createTuiCustomHarness((comp) => {
        const plain = stripTerminalSequences(comp.render(80).join("\n"));
        assert.match(plain, /Swarm Questionnaire/);
        assert.doesNotMatch(plain, /tower/i);
        comp.handleInput?.("\r"); // Tab 1 -> jsonl
        comp.handleInput?.("\r"); // Tab 2 -> main
        comp.handleInput?.("\r"); // Submit
      });
      const result = await ui.askQuestionnaire(ctx, questions);
      assert.equal(result.cancelled, false);
      assert.deepEqual(result.answers, { arch: "jsonl", branch: "main" });
    }
  });

  it("confirmProposal TUI shows Swarm Plan Confirmation, 3-role models, [r] Validator, [v] Final Validator, and returns updated outcome", async () => {
    const ui = createQuestionnaireUI();
    const plan: ProposedSwarmPlan = {
      objective: "Ship parallel Swarm UI and runtime with strict verification",
      baseBranch: "main",
      maxConcurrency: 3,
      validatorEnabled: true,
      finalValidatorEnabled: true,
      verificationContract: "npm test && npm run typecheck",
      roleModels: {
        orchestrator: { model: "anthropic/claude-opus-4-6" },
        worker: { model: "openai/gpt-5.4-codex" },
        validator: { model: "google/gemini-2.5-pro" },
      },
      missions: [
        {
          id: "M1",
          title: "Store layer",
          kind: "build",
          description: "State store",
          scope: ["src/store/"],
          deps: [],
          verification: "npm test",
        },
        {
          id: "M2",
          title: "UI layer",
          kind: "build",
          description: "TUI components",
          scope: ["src/ui/"],
          deps: ["M1"],
          verification: "npm test",
        },
      ],
    };

    // Toggle [r] Validator, [v] Final Validator, [+] Concurrency -> Confirm
    {
      const { ctx } = createTuiCustomHarness((comp) => {
        for (const w of [40, 80, 120]) {
          assertAllLinesFit(comp.render(w), w, `confirmProposal@${w}`);
        }
        const initialPlain = stripTerminalSequences(comp.render(100).join("\n"));
        assert.match(initialPlain, /Swarm Plan Confirmation/);
        assert.match(initialPlain, /Models:/);
        assert.match(initialPlain, /claude-opus-4-6/);
        assert.match(initialPlain, /gpt-5\.4-codex/);
        assert.match(initialPlain, /gemini-2\.5-pro/);
        assert.match(initialPlain, /\[r\] Validator: ON/);
        assert.match(initialPlain, /\[v\] Final Validator: ON/);
        assert.match(initialPlain, /Concurrency: 3/);
        assert.doesNotMatch(initialPlain, /tower/i);

        comp.handleInput?.("r");
        comp.handleInput?.("v");
        comp.handleInput?.("+");
        const afterPlain = stripTerminalSequences(comp.render(100).join("\n"));
        assert.match(afterPlain, /\[r\] Validator: OFF/);
        assert.match(afterPlain, /\[v\] Final Validator: OFF/);
        assert.match(afterPlain, /Concurrency: 4/);
        comp.handleInput?.("\r");
      });

      const out = await ui.confirmProposal(ctx, plan);
      assert.deepEqual(out, {
        action: "confirm",
        validatorEnabled: false,
        finalValidatorEnabled: false,
        maxConcurrency: 4,
      });
    }

    // Defaulting to "host default" when plan.roleModels is omitted + Esc -> continue
    {
      const { ctx } = createTuiCustomHarness((comp) => {
        const plain = stripTerminalSequences(comp.render(100).join("\n"));
        assert.match(plain, /host default/);
        comp.handleInput?.("r");
        comp.handleInput?.("\x1b");
      });
      const out = await ui.confirmProposal(ctx, {
        ...plan,
        roleModels: undefined,
      });
      assert.deepEqual(out, {
        action: "continue",
        validatorEnabled: false,
        finalValidatorEnabled: true,
        maxConcurrency: 3,
      });
    }

    // Short terminal (16 rows) stays height-bounded and shows all 3 choices
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
              assert.ok(lines.length <= 16, `Expected <= 16 lines, got ${lines.length}`);
              const plain = stripTerminalSequences(lines.join("\n"));
              assert.match(plain, /Confirm — launch Swarm fleet now/);
              assert.match(plain, /Continue refining/);
              assert.match(plain, /Cancel — discard/);
              comp.handleInput?.("\x1b");
            });
          },
        },
      } as unknown as ExtensionContext;
      const out = await ui.confirmProposal(shortCtx, plan);
      assert.equal(out.action, "continue");
    }
  });

  it("confirmProposal RPC fallback and non-UI mode display 3-role models and return validatorEnabled + finalValidatorEnabled", async () => {
    const ui = createQuestionnaireUI();
    const seenTitles: string[] = [];
    const selectReplies: (string | undefined)[] = [
      "Toggle Validator (currently ON)",
      "Toggle Final Validator (currently ON)",
      "Confirm — launch Swarm fleet now (recommended)",
      undefined,
    ];

    const rpcCtx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        async select(title: string, _opts: string[]) {
          seenTitles.push(title);
          return selectReplies.shift();
        },
        async input() {
          return undefined;
        },
      },
    } as unknown as ExtensionContext;

    const plan: ProposedSwarmPlan = {
      objective: "RPC test plan",
      baseBranch: "main",
      maxConcurrency: 2,
      validatorEnabled: true,
      finalValidatorEnabled: true,
      verificationContract: "npm test",
      roleModels: {
        orchestrator: { model: "anthropic/claude-opus-4-6" },
      },
      missions: [],
    };

    const confirmRes = await ui.confirmProposal(rpcCtx, plan);
    assert.deepEqual(confirmRes, {
      action: "confirm",
      validatorEnabled: false,
      finalValidatorEnabled: false,
      maxConcurrency: 2,
    });
    assert.ok(seenTitles[0]?.includes("Swarm Plan Confirmation"));
    assert.ok(seenTitles[0]?.includes("claude-opus-4-6"));
    assert.ok(seenTitles[0]?.includes("host default"));
    assert.doesNotMatch(seenTitles.join("\n"), /tower/i);

    const dismissedRes = await ui.confirmProposal(rpcCtx, plan);
    assert.deepEqual(dismissedRes, {
      action: "continue",
      validatorEnabled: true,
      finalValidatorEnabled: true,
      maxConcurrency: 2,
    });

    const headlessCtx = {
      mode: "print",
      hasUI: false,
    } as unknown as ExtensionContext;
    assert.deepEqual(await ui.confirmProposal(headlessCtx, plan), {
      action: "cancel",
      validatorEnabled: true,
      finalValidatorEnabled: true,
      maxConcurrency: 2,
    });
  });
});

// ============================================================================
// 4. tasks-overlay Tests
// ============================================================================

describe("tasks-overlay", () => {
  function createMockOrchestrator(initial: SwarmSnapshot) {
    let snap = initial;
    let nextSeq = initial.boardHead + 1;
    const listeners = new Set<(ev: SwarmOrchestratorEvent) => void>();
    const calls = {
      postToBoard: [] as PostBoardMessageInput[],
      switchAgentModel: [] as { agentNameOrId: string; modelOverride: string }[],
      steer: [] as { agentId: string; message: string; mode?: string }[],
      stop: [] as {
        agentId: string;
        options?: { humanStopped?: boolean; reason?: string };
      }[],
      kill: [] as { agentNameOrId: string; reason?: string }[],
      approve: [] as { missionId: string; options?: Record<string, unknown> }[],
      retry: [] as { missionId: string; options?: Record<string, unknown> }[],
      merge: [] as { missionId: string; options?: Record<string, unknown> }[],
      runFinalAudit: [] as {
        runId?: string;
        force?: boolean;
        hostContext?: unknown;
      }[],
      skipFinalAudit: [] as {
        runId?: string;
        reason?: string;
        skippedBy?: string;
      }[],
    };

    const orchestrator: ISwarmOrchestrator = {
      getSnapshot: () => snap,
      subscribe(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      async postToBoard(input) {
        calls.postToBoard.push(input);
        const msg: BoardMessage = {
          seq: nextSeq++,
          runId: snap.activeRunId ?? "run-1",
          from: input.from,
          fromRole: input.fromRole,
          text: input.text,
          mentions: input.mentions ?? [],
          kind: input.kind ?? "chat",
          missionId: input.missionId,
          timestamp: "2026-11-20T17:45:05.000Z",
        };
        snap = {
          ...snap,
          boardHead: msg.seq,
          recentBoard: [...snap.recentBoard, msg],
        };
        return msg;
      },
      async readBoard() {
        return { messages: snap.recentBoard, head: snap.boardHead };
      },
      async switchAgentModel(agentNameOrId, modelOverride) {
        calls.switchAgentModel.push({ agentNameOrId, modelOverride });
        const existing = Object.values(snap.run?.roster ?? {}).find(
          (e) => e.name === agentNameOrId || e.agentId === agentNameOrId,
        );
        const updated: RosterEntry = existing
          ? { ...existing, model: modelOverride }
          : {
              agentId: agentNameOrId,
              name: agentNameOrId,
              role: "worker",
              missionId: "M1",
              worktreePath: "/tmp/wt-M1",
              branch: "feat/m1",
              status: "waiting",
              model: modelOverride,
              lastReadBoardSeq: snap.boardHead,
              turns: 1,
              startedAt: "2026-11-20T17:40:00.000Z",
              humanStopped: false,
              tokens: 0,
              cost: 0,
              logTail: [],
            };
        if (snap.run) {
          snap = {
            ...snap,
            run: {
              ...snap.run,
              roster: {
                ...snap.run.roster,
                [updated.agentId]: updated,
              },
            },
          };
        }
        return updated;
      },
      async steerAgent(agentId, message, mode) {
        calls.steer.push({ agentId, message, mode });
      },
      async stopAgent(agentId, options) {
        calls.stop.push({ agentId, options });
      },
      async killAgent(agentNameOrId, reason) {
        calls.kill.push({ agentNameOrId, reason });
      },
      async approveArtifact(missionId, options) {
        calls.approve.push({
          missionId,
          options: options as Record<string, unknown>,
        });
        return snap.run!;
      },
      async retryMission(missionId, options) {
        calls.retry.push({
          missionId,
          options: options as Record<string, unknown>,
        });
        return snap.run!;
      },
      async mergeMission(missionId, options) {
        calls.merge.push({
          missionId,
          options: options as Record<string, unknown>,
        });
        return {
          mergedCommitSha: "deadbeef",
          strategy: "merge",
          changedFiles: [],
        };
      },
      async runFinalAudit(options) {
        calls.runFinalAudit.push({
          runId: options?.runId,
          force: options?.force,
          hostContext: options?.hostContext,
        });
        return snap.run!;
      },
      async skipFinalAudit(options) {
        calls.skipFinalAudit.push({
          runId: options?.runId,
          reason: options?.reason,
          skippedBy: options?.skippedBy,
        });
        return snap.run!;
      },
      startRun: async () => snap.run!,
      attachRun: async () => snap,
      pause: async () => snap.run!,
      resume: async () => snap.run!,
      tick: async () => {},
      spawnForMission: async () => {
        throw new Error("not implemented");
      },
      teardown: async () => ({ removed: [], skipped: [], errors: [] }),
      dispose: async () => {},
    };

    return {
      orchestrator,
      calls,
      listenerCount: () => listeners.size,
      emit(nextSnap: SwarmSnapshot) {
        snap = nextSnap;
        for (const l of listeners) {
          l({
            type: "snapshot_changed",
            runId: nextSnap.activeRunId,
            summary: "updated",
            snapshot: nextSnap,
          });
        }
      },
    };
  }

  it("supports Fleet actions ([s], [m] hot-switch model, [x] stop, [k] kill, [a], [r], [g] merge, [d] diff) AND [b] Board view toggle + posting within widths 40, 80, 120", async () => {
    // M1 has working worker-1; M2 has warm waiting warm-1 (no working agent on M2)
    const snap = makeSampleSnapshot({
      workingAgents: 1,
      waitingAgents: 1,
    });
    const mockOrch = createMockOrchestrator(snap);
    const diffCalls: { baseBranch: string; targetRef: string }[] = [];

    const mockWorktree = {
      async getDiffSummary(
        baseBranch: string,
        targetRef: string,
      ): Promise<DiffSummary> {
        diffCalls.push({ baseBranch, targetRef });
        return {
          baseBranch,
          branch: targetRef,
          headSha: "abcdef1234567890",
          commitsAhead: 2,
          changedFiles: ["src/parser/lexer.ts"],
          stat: " src/parser/lexer.ts | 12 +++++++++---\n 1 file changed, 9 insertions(+), 3 deletions(-)",
          diff: "@@ -10,2 +10,5 @@\n+if (buf.length === 0) return [];\n-return null;",
        };
      },
    } as unknown as IWorktreeManager;

    const theme = createMockTheme();
    const mockTui = createMockTUI(34, 110);
    let overlayOptUsed = false;
    let modalEnterCount = 0;
    let modalExitCount = 0;

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
          ) => Component & Focusable & { dispose?(): void },
          opts?: { overlay?: boolean },
        ): Promise<T> {
          overlayOptUsed = Boolean(opts?.overlay);
          return new Promise<T>((resolve) => {
            const comp = factory(mockTui.tui, theme, {}, (res) => {
              resolve(res);
            });
            comp.focused = true;

            void (async () => {
              assert.equal(mockOrch.listenerCount(), 1);

              // Width bounds across 40, 80, 120 in Fleet view
              for (const w of [40, 80, 120]) {
                const rendered = comp.render(w);
                assertAllLinesFit(rendered, w, `tasks-overlay-fleet@${w}`);
                assert.doesNotMatch(
                  stripTerminalSequences(rendered.join("\n")),
                  /tower/i,
                );
              }

              // Detail pane on M1 shows model, working state, turns, board cursor
              const m1Plain = stripTerminalSequences(comp.render(110).join("\n"));
              assert.match(m1Plain, /Swarm Tasks & Board/);
              assert.match(m1Plain, /model:openai\/gpt-5\.4-codex/);
              assert.match(m1Plain, /turns:2/);
              assert.match(m1Plain, /board:#3/);

              // [m] on working M1 warns cleanly instead of switching mid-turn
              comp.handleInput?.("m");
              assert.match(
                stripTerminalSequences(comp.render(110).join("\n")),
                /hot-switch requires waiting state/,
              );

              // [s] steer on working M1
              comp.handleInput?.("s");
              const steerLines = comp.render(90);
              assert.ok(steerLines.some((l) => l.includes(CURSOR_MARKER)));
              for (const ch of "Focus on EOF test") {
                comp.handleInput?.(ch);
              }
              comp.handleInput?.("\r");
              await Promise.resolve();

              // [x] stop M1's working agent
              comp.handleInput?.("x");
              await Promise.resolve();

              // [k] kill M1's agent permanently
              comp.handleInput?.("k");
              await Promise.resolve();

              // [d] diff on M1
              comp.handleInput?.("d");
              await new Promise((r) => setTimeout(r, 10));
              for (const w of [40, 80, 120]) {
                assertAllLinesFit(comp.render(w), w, `tasks-overlay-diff@${w}`);
              }
              assert.match(
                stripTerminalSequences(comp.render(100).join("\n")),
                /2 commit\(s\) ahead/,
              );

              // Down to M2 (warm waiting agent `warm-M2`, artifact mission)
              comp.handleInput?.("\x1b[B");

              // [s] on waiting warm-M2 wakes via shared board with @warm-M2 mention
              comp.handleInput?.("s");
              const wakeLines = comp.render(100);
              assert.ok(wakeLines.some((l) => l.includes(CURSOR_MARKER)));
              for (const ch of "Please refresh architecture spec") {
                comp.handleInput?.(ch);
              }
              comp.handleInput?.("\r");
              await Promise.resolve();

              // [m] hot-switch model on waiting agent warm-M2
              comp.handleInput?.("m");
              const modelInputLines = comp.render(100);
              assertAllLinesFit(modelInputLines, 100, "tasks-overlay-model-input@100");
              assert.ok(
                modelInputLines.some((l) => l.includes(CURSOR_MARKER)),
                "Model switch input must emit CURSOR_MARKER",
              );
              for (const ch of "anthropic/claude-opus-4-6") {
                comp.handleInput?.(ch);
              }
              comp.handleInput?.("\r");
              await Promise.resolve();

              // [a] approve artifact M2 and [g] manual merge M2
              comp.handleInput?.("a");
              comp.handleInput?.("g");
              await Promise.resolve();

              // Down to M3 (failed) -> [r] retry
              comp.handleInput?.("\x1b[B");
              comp.handleInput?.("r");
              await Promise.resolve();

              // [b] toggle to Shared Board view
              comp.handleInput?.("b");
              for (const w of [40, 80, 120]) {
                const boardLines = comp.render(w);
                assertAllLinesFit(boardLines, w, `tasks-overlay-board@${w}`);
              }
              const boardPlain = stripTerminalSequences(comp.render(110).join("\n"));
              assert.match(boardPlain, /\[BOARD\]/);
              assert.match(boardPlain, /#1.*\[orchestrator -> @M1\]/);
              assert.match(boardPlain, /#3.*\[validator-M1 -> @M1\]/);

              // Scroll board up/down cleanly
              comp.handleInput?.("\x1b[A");
              comp.handleInput?.("\x1b[B");

              // [s] in Board view posts directly to shared board
              comp.handleInput?.("s");
              const postInputLines = comp.render(100);
              assert.ok(postInputLines.some((l) => l.includes(CURSOR_MARKER)));
              for (const ch of "@warm-M2 please update architecture diagram") {
                comp.handleInput?.(ch);
              }
              comp.handleInput?.("\r");
              await Promise.resolve();

              // [b] toggle back to Fleet view
              comp.handleInput?.("b");
              assert.match(
                stripTerminalSequences(comp.render(110).join("\n")),
                /\[FLEET\]/,
              );

              // [Esc] closes overlay & unsubscribes
              comp.handleInput?.("\x1b");
            })();
          });
        },
      },
    } as unknown as ExtensionContext;

    await openTasksOverlay(ctx, mockOrch.orchestrator, mockWorktree, {
      onModalEnter: () => modalEnterCount++,
      onModalExit: () => modalExitCount++,
      now: () => Date.parse("2026-11-20T17:45:00.000Z"),
    });

    assert.equal(overlayOptUsed, true);
    assert.equal(modalEnterCount, 1);
    assert.equal(modalExitCount, 1);
    assert.equal(mockOrch.listenerCount(), 0);

    assert.deepEqual(mockOrch.calls.steer, [
      { agentId: "worker-1", message: "Focus on EOF test", mode: "steer" },
    ]);
    assert.equal(mockOrch.calls.stop.length, 1);
    assert.equal(mockOrch.calls.stop[0]?.agentId, "worker-1");
    assert.equal(mockOrch.calls.stop[0]?.options?.humanStopped, true);

    assert.deepEqual(mockOrch.calls.kill, [
      { agentNameOrId: "M1", reason: "Killed by user" },
    ]);

    assert.deepEqual(mockOrch.calls.switchAgentModel, [
      { agentNameOrId: "warm-M2", modelOverride: "anthropic/claude-opus-4-6" },
    ]);

    assert.equal(mockOrch.calls.approve.length, 1);
    assert.equal(mockOrch.calls.approve[0]?.missionId, "M2");

    assert.equal(mockOrch.calls.merge.length, 1);
    assert.equal(mockOrch.calls.merge[0]?.missionId, "M2");

    assert.equal(mockOrch.calls.retry.length, 1);
    assert.equal(mockOrch.calls.retry[0]?.missionId, "M3");

    assert.equal(mockOrch.calls.postToBoard.length, 2);
    assert.equal(mockOrch.calls.postToBoard[0]?.from, "human");
    assert.equal(mockOrch.calls.postToBoard[0]?.fromRole, "human");
    assert.equal(
      mockOrch.calls.postToBoard[0]?.text,
      "@warm-M2 Please refresh architecture spec",
    );
    assert.equal(mockOrch.calls.postToBoard[0]?.missionId, "M2");
    assert.equal(mockOrch.calls.postToBoard[1]?.from, "human");
    assert.equal(mockOrch.calls.postToBoard[1]?.fromRole, "human");
    assert.equal(
      mockOrch.calls.postToBoard[1]?.text,
      "@warm-M2 please update architecture diagram",
    );

    assert.equal(diffCalls.length, 1);
  });

  it("renders selectable [FINAL] Final Validator row, supports [x] stop, [r] re-verify, and exposes [FINAL] skip pane", async () => {
    const finalValidatorEntry: RosterEntry = {
      agentId: "final-val-r1",
      name: "final-validator",
      role: "final-validator",
      missionId: FINAL_AUDIT_MISSION_ID,
      worktreePath: "/tmp/repo",
      branch: "main",
      status: "working",
      model: "google/gemini-2.5-pro",
      lastReadBoardSeq: 6,
      turns: 2,
      startedAt: "2026-11-20T17:44:00.000Z",
      humanStopped: false,
      currentActivity: "Auditing merged commits on main",
      lastTool: "read",
      tokens: 8_400,
      cost: 0.11,
      logTail: [
        "Auditing commit deadbeef against verification contract",
        "Found missing error code check in src/cli/main.ts:88",
      ],
    };

    const latestFinalAudit: FinalAuditVerdict = {
      commitSha: "deadbeef1234567890",
      baseBranch: "main",
      auditedAt: "2026-11-20T17:44:45.000Z",
      verifierAgentId: "final-val-r1",
      verdict: "disapproved",
      summary: "CLI error handling does not exit non-zero on parse error",
      checks: [
        { name: "typecheck", passed: true },
        { name: "e2e cli", passed: false, detail: "exit code 0" },
      ],
      findings: [
        {
          severity: "p1",
          title: "CLI returns 0 on error",
          detail: "Must exit 1 when parser fails",
          file: "src/cli/main.ts",
          line: 88,
        },
      ],
      recommendedMissions: [
        {
          title: "Propagate CLI exit code on parse error",
          description: "Set process.exitCode = 1 on error",
          scope: ["src/cli/main.ts"],
          verification: "npm test",
          kind: "build",
        },
      ],
      round: 1,
    };

    // Part A: Active Final Validator with checks/findings/logTail + [x] stop + [r] re-verify
    {
      const snap = makeSampleSnapshot({
        status: "verifying",
        workingAgents: 1,
        waitingAgents: 0,
        finalValidatorEnabled: true,
        maxFinalAuditRounds: 2,
        finalAuditStatus: "disapproved",
        finalAuditRound: 1,
        latestFinalAudit,
        finalValidatorRosterEntry: finalValidatorEntry,
        finalAuditRunningAgentId: finalValidatorEntry.agentId,
      });
      const mockOrch = createMockOrchestrator(snap);
      const theme = createMockTheme();
      const mockTui = createMockTUI(34, 120);

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
            ) => Component & Focusable & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(mockTui.tui, theme, {}, resolve);
              comp.focused = true;
              void (async () => {
                // Up once wraps from M1 to [FINAL] Final Validator
                comp.handleInput?.("\x1b[A");
                for (const w of [40, 80, 120]) {
                  assertAllLinesFit(comp.render(w), w, `tasks-overlay-final@${w}`);
                }
                const plain = stripTerminalSequences(comp.render(110).join("\n"));
                assert.match(plain, /\[FINAL\] Final Validator \(base:main\)/);
                assert.match(plain, /Checks \(1\/2\):/);
                assert.match(plain, /CLI returns 0 on error/);
                assert.match(plain, /Propagate CLI exit code on parse error/);
                assert.match(plain, /Auditing commit deadbeef against verification contract/);
                assert.match(plain, /\[x\] stop/);
                assert.match(plain, /\[r\] re-verify/);

                comp.handleInput?.("x");
                await Promise.resolve();
                comp.handleInput?.("r");
                await Promise.resolve();
                comp.handleInput?.("\x1b");
              })();
            });
          },
        },
      } as unknown as ExtensionContext;

      await openTasksOverlay(ctx, mockOrch.orchestrator, undefined, {
        now: () => Date.parse("2026-11-20T17:45:00.000Z"),
      });

      assert.equal(mockOrch.calls.stop.length, 1);
      assert.equal(mockOrch.calls.stop[0]?.agentId, "final-val-r1");
      assert.equal(mockOrch.calls.stop[0]?.options?.humanStopped, true);
      assert.equal(mockOrch.calls.runFinalAudit.length, 1);
      assert.equal(mockOrch.calls.runFinalAudit[0]?.force, true);
    }

    // Part B: [FINAL] skipped pane before first audit
    {
      const skippedSnap = makeSampleSnapshot({
        status: "completed",
        workingAgents: 0,
        waitingAgents: 0,
        finalValidatorEnabled: true,
        maxFinalAuditRounds: 2,
        finalAuditStatus: "skipped",
        finalAuditRound: 0,
        finalAuditSkippedBy: "human",
        finalAuditSkipReason: "accepted known gap",
      });
      const mockOrch = createMockOrchestrator(skippedSnap);
      const theme = createMockTheme();
      const mockTui = createMockTUI(34, 120);

      let plain = "";
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
            ) => Component & Focusable & { dispose?(): void },
          ): Promise<T> {
            return new Promise<T>((resolve) => {
              const comp = factory(mockTui.tui, theme, {}, resolve);
              comp.focused = true;
              void (async () => {
                for (const w of [40, 80, 120]) {
                  assertAllLinesFit(comp.render(w), w, `tasks-overlay-skipped@${w}`);
                }
                plain = stripTerminalSequences(comp.render(110).join("\n"));
                comp.handleInput?.("r");
                await Promise.resolve();
                comp.handleInput?.("\x1b");
              })();
            });
          },
        },
      } as unknown as ExtensionContext;

      await openTasksOverlay(ctx, mockOrch.orchestrator, undefined, {
        initialMissionId: FINAL_AUDIT_MISSION_ID,
        now: () => Date.parse("2026-11-20T17:45:00.000Z"),
      });

      assert.match(plain, /\[FINAL\] Final Validator \(base:main\)/);
      assert.match(plain, /skipped/);
      assert.match(plain, /Skip reason: accepted known gap/);
      assert.match(plain, /\[r\] re-verify/);
      assert.equal(mockOrch.calls.runFinalAudit.length, 1);
      assert.equal(mockOrch.calls.runFinalAudit[0]?.force, true);
    }
  });

  it("RPC fallback supports hot-switching model, killing agent, and posting to board", async () => {
    const snap = makeSampleSnapshot({ workingAgents: 0, waitingAgents: 1 });
    const mockOrch = createMockOrchestrator(snap);
    const notifications: string[] = [];

    let step = 0;
    const rpcCtx = {
      mode: "rpc",
      hasUI: true,
      ui: {
        notify(msg: string) {
          notifications.push(msg);
        },
        async select(_title: string, opts: string[]) {
          step++;
          if (step === 1) return opts.find((o) => o.includes("M2"));
          if (step === 2) return opts.find((o) => o.startsWith("Hot-switch model on "));
          if (step === 3) return opts.find((o) => o.includes("M2"));
          if (step === 4) return opts.find((o) => o.startsWith("Kill "));
          return "Close";
        },
        async input() {
          return "google/gemini-2.5-pro";
        },
      },
    } as unknown as ExtensionContext;

    await openTasksOverlay(rpcCtx, mockOrch.orchestrator);

    assert.deepEqual(mockOrch.calls.switchAgentModel, [
      { agentNameOrId: "warm-M2", modelOverride: "google/gemini-2.5-pro" },
    ]);
    assert.deepEqual(mockOrch.calls.kill, [
      { agentNameOrId: "warm-M2", reason: "Killed by user" },
    ]);
    assert.ok(notifications.some((n) => n.includes("Switched warm-M2")));
    assert.ok(notifications.some((n) => n.includes("Killed warm-M2")));
  });
});

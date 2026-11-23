import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  BoardMessage,
  SwarmChannelRecord,
  SwarmDraftMode,
  SwarmEvent,
  SwarmMemberRecord,
  SwarmMemberRole,
  SwarmMemberState,
  SwarmModelRole,
  SwarmRoleModels,
  SwarmRunState,
  SwarmSettings,
  SwarmSnapshot,
} from "../types.js";
import {
  buildSwarmGraphLines,
  fitLine,
  formatBoardKindBadge,
  formatBoardTargets,
  formatCost,
  formatDuration,
  formatElapsedSince,
  formatMemberRoleBadge,
  formatMemberStateBadge,
  formatRoleModelsLine,
  formatRunStatusBadge,
  formatTokens,
  formatWorkspaceBadge,
  getOrderedMembers,
  isEscapeKey,
  isKeyReleaseSafe,
  joinColumns,
  memberStateIcon,
  renderBox,
  renderHorizontalRule,
  renderTable,
  sanitizePlainText,
  shortenModelName,
  type TableColumn,
  visibleWidth,
} from "./text-utils.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SwarmWidgetState {
  expanded: boolean;
  draftActive: boolean;
  draftMode?: SwarmDraftMode;
  draftSeed?: string;
  modalDepth: number;
}

export interface SwarmWidgetOptions {
  /** Spinner animation interval in milliseconds (default: 100ms). */
  spinnerIntervalMs?: number;
  /** Maximum working members shown in compact mode before "+N more" (default: 4). */
  maxCompactWorkers?: number;
  /** Maximum recent board messages shown in expanded mode (default: 5). */
  maxRecentBoard?: number;
  /** Optional host session model fallback for 3-role display. */
  hostModel?: string;
  /** Optional dynamic host session model getter (takes precedence over static hostModel). */
  getHostModel?: () => string | undefined;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

export interface SwarmShortcutCallbacks {
  isModalOpen: () => boolean;
  isExpanded: () => boolean;
  isHostStreaming?: () => boolean;
  onToggleExpand: () => void;
  onCollapse: () => void;
  onOpenMissionControl?: () => void;
  onOpenModelPicker?: () => void;
}

export interface StatusDashboardOptions {
  draftActive?: boolean;
  draftSeed?: string;
  hostModel?: string;
  now?: () => number;
}

export interface BoardViewOptions {
  runId?: string;
  channel?: string;
}

export interface GraphViewOptions {
  /** Render width for the ASCII/Unicode graph block (default: 88). */
  width?: number;
  /** Optional full board override (defaults to `snapshot.recentBoard`). */
  board?: readonly BoardMessage[];
}

export function createSwarmWidgetState(
  initial?: Partial<SwarmWidgetState>,
): SwarmWidgetState {
  return {
    expanded: initial?.expanded ?? false,
    draftActive: initial?.draftActive ?? false,
    draftMode: initial?.draftMode,
    draftSeed: initial?.draftSeed,
    modalDepth: initial?.modalDepth ?? 0,
  };
}

export function isModalOpen(state: Pick<SwarmWidgetState, "modalDepth">): boolean {
  return state.modalDepth > 0;
}

// ============================================================================
// Internal Snapshot & Formatting Helpers
// ============================================================================

function memberStateRank(state: SwarmMemberState): number {
  switch (state) {
    case "working":
      return 0;
    case "waiting":
      return 1;
    case "stopped":
      return 2;
    case "killed":
      return 3;
  }
}

function getSortedMembers(run: SwarmRunState): SwarmMemberRecord[] {
  const ordered = getOrderedMembers(run);
  const orderIdx = new Map<string, number>();
  ordered.forEach((m, idx) => orderIdx.set(m.name, idx));
  return [...ordered].sort((a, b) => {
    const rDiff = memberStateRank(a.state) - memberStateRank(b.state);
    if (rDiff !== 0) return rDiff;
    return (orderIdx.get(a.name) ?? 0) - (orderIdx.get(b.name) ?? 0);
  });
}

function getWorkingMembers(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
): SwarmMemberRecord[] {
  const workingNames = new Set(snapshot.workingMemberNames);
  return getOrderedMembers(run).filter(
    (m) =>
      m.state === "working" ||
      (workingNames.has(m.name) &&
        m.state !== "waiting" &&
        m.state !== "stopped" &&
        m.state !== "killed"),
  );
}

function getWaitingMembers(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
): SwarmMemberRecord[] {
  const waitingNames = new Set(snapshot.waitingMemberNames);
  const workingNames = new Set(snapshot.workingMemberNames);
  return getOrderedMembers(run).filter(
    (m) =>
      m.state === "waiting" ||
      (waitingNames.has(m.name) &&
        !workingNames.has(m.name) &&
        m.state !== "working" &&
        m.state !== "stopped" &&
        m.state !== "killed"),
  );
}

function getWorkingCount(
  snapshot: SwarmSnapshot,
  workingMembers: readonly SwarmMemberRecord[],
): number {
  return Math.max(workingMembers.length, snapshot.workingMemberNames.length);
}

function getWaitingCount(
  snapshot: SwarmSnapshot,
  waitingMembers: readonly SwarmMemberRecord[],
): number {
  return Math.max(waitingMembers.length, snapshot.waitingMemberNames.length);
}

function resolveEffectiveRoleModels(
  snapshot: SwarmSnapshot,
  run?: SwarmRunState | null,
): SwarmRoleModels {
  const fromRun = run?.roleModels;
  const fromSnap = snapshot.roleModels;
  return {
    orchestrator: fromSnap?.orchestrator ?? fromRun?.orchestrator,
    worker: fromSnap?.worker ?? fromRun?.worker,
    validator: fromSnap?.validator ?? fromRun?.validator,
    fallbackModels: fromSnap?.fallbackModels ?? fromRun?.fallbackModels,
  };
}

function formatEventClock(timestamp: string): string {
  const tIndex = timestamp.indexOf("T");
  if (tIndex >= 0 && timestamp.length >= tIndex + 9) {
    return timestamp.slice(tIndex + 1, tIndex + 9);
  }
  return timestamp.slice(0, 8);
}

function formatRoleShortBadge(role: SwarmMemberRole, theme?: Theme): string {
  const raw = role === "validator" ? "V" : "W";
  if (!theme) return `[${raw}]`;
  return role === "validator"
    ? theme.fg("warning", `[${raw}]`)
    : theme.fg("accent", `[${raw}]`);
}

function getOrderedChannels(run: SwarmRunState): SwarmChannelRecord[] {
  const list = Object.values(run.channels);
  return list.sort((a, b) => {
    if (a.name === "main" && b.name !== "main") return -1;
    if (b.name === "main" && a.name !== "main") return 1;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function formatChannelsSummaryInline(
  run: SwarmRunState,
  theme?: Theme,
): string {
  const channels = getOrderedChannels(run);
  if (channels.length === 0) {
    return theme ? theme.fg("dim", "#main") : "#main";
  }
  return channels
    .map((ch) => {
      const count = ch.subscribers.length;
      const base = `#${ch.name}(${count})${ch.archived ? "[archived]" : ""}`;
      if (!theme) return base;
      return ch.archived ? theme.fg("dim", base) : theme.fg("accent", base);
    })
    .join(theme ? theme.fg("dim", " · ") : " · ");
}

// ============================================================================
// Above-Editor Live Swarm Dashboard Widget
// ============================================================================

class SwarmDashboardComponent implements Component {
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  private readonly spinnerIntervalMs: number;
  private readonly maxCompactWorkers: number;
  private readonly maxRecentBoard: number;
  private readonly hostModel?: string;
  private readonly getHostModel?: () => string | undefined;
  private readonly now: () => number;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getSnapshot: () => SwarmSnapshot,
    private readonly state: SwarmWidgetState,
    options?: SwarmWidgetOptions,
  ) {
    this.spinnerIntervalMs = Math.max(40, options?.spinnerIntervalMs ?? 100);
    this.maxCompactWorkers = Math.max(1, options?.maxCompactWorkers ?? 4);
    this.maxRecentBoard = Math.max(1, options?.maxRecentBoard ?? 5);
    this.hostModel = options?.hostModel;
    this.getHostModel = options?.getHostModel;
    this.now = options?.now ?? (() => Date.now());
  }

  private resolveHostModel(): string {
    return this.getHostModel?.() ?? this.hostModel ?? "default";
  }

  private syncSpinnerTimer(hasWorkingMembers: boolean): void {
    if (this.disposed) {
      this.stopTimer();
      return;
    }
    if (hasWorkingMembers && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        if (this.disposed) {
          this.stopTimer();
          return;
        }
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        if (!isModalOpen(this.state)) {
          this.tui.requestRender();
        }
      }, this.spinnerIntervalMs);
      if (typeof this.spinnerTimer.unref === "function") {
        this.spinnerTimer.unref();
      }
    } else if (!hasWorkingMembers && this.spinnerTimer) {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  invalidate(): void {
    // Stateless per-render formatting driven by live snapshot
  }

  private renderDraftBanner(width: number): string[] {
    const modeLabel =
      this.state.draftMode === "tweak" ? "Swarm Plan Revision" : "Swarm Draft";
    const seedSuffix = this.state.draftSeed
      ? `: ${sanitizePlainText(this.state.draftSeed)}`
      : "";
    const desc = ` — clarifying requirements & strategy${seedSuffix}`;
    const left = `${this.theme.fg("accent", this.theme.bold(`🐝 ${modeLabel}`))}${this.theme.fg("muted", desc)}`;
    const right = this.theme.fg("dim", "/swarm cancel");
    const line =
      width >= 60
        ? joinColumns(left, right, width)
        : fitLine(`${left} · ${right}`, width);
    return [fitLine(line, width)];
  }

  private renderWorkingMemberLine(
    member: SwarmMemberRecord,
    width: number,
    nowMs: number,
  ): string {
    const spinColor = member.role === "validator" ? "warning" : "accent";
    const glyph = this.theme.fg(spinColor, SPINNER_FRAMES[this.spinnerFrame]!);
    const rolePill = formatRoleShortBadge(member.role, this.theme);
    const nameStr = this.theme.bold(sanitizePlainText(member.name));
    const activityRaw =
      member.currentActivity ||
      (member.lastTool ? `tool:${member.lastTool}` : "working");
    const activity = this.theme.fg("muted", sanitizePlainText(activityRaw));
    const elapsed = this.theme.fg(
      "dim",
      formatElapsedSince(member.createdAt, nowMs),
    );

    if (width < 48) {
      return fitLine(`  ${glyph} ${rolePill} ${nameStr} ${elapsed}`, width);
    }

    const left = `  ${glyph} ${rolePill} ${nameStr} ${activity}`;
    return fitLine(joinColumns(left, elapsed, width), width);
  }

  private renderBoardPreviewLine(msg: BoardMessage, width: number): string {
    const seqStr = this.theme.fg("accent", `#${msg.seq}`);
    const chStr = this.theme.fg("dim", `[#${sanitizePlainText(msg.channel || "main")}]`);
    const fromStr = this.theme.bold(sanitizePlainText(msg.from));
    const targets = formatBoardTargets(msg);
    const targetsStyled = targets ? this.theme.fg("accent", targets) : "";
    const textStr = this.theme.fg("muted", sanitizePlainText(msg.text));
    return fitLine(
      `  ${seqStr} ${chStr} ${fromStr}${targetsStyled}: ${textStr}`,
      width,
    );
  }

  private renderCompact(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    workingMembers: readonly SwarmMemberRecord[],
    waitingMembers: readonly SwarmMemberRecord[],
    width: number,
    nowMs: number,
  ): string[] {
    const lines: string[] = [];

    if (this.state.draftActive) {
      lines.push(...this.renderDraftBanner(width));
    }

    const titleText = sanitizePlainText(run.title || run.objective) || run.id;
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const workingCount = getWorkingCount(snapshot, workingMembers);
    const waitingCount = getWaitingCount(snapshot, waitingMembers);
    const boardTag = this.theme.fg("accent", `Board:#${snapshot.boardHead}`);
    const fleetTag = `${this.theme.fg("accent", `${workingCount}w`)}/${this.theme.fg("muted", `${waitingCount}wait`)}`;
    const roleModels = resolveEffectiveRoleModels(snapshot, run);
    const shortcutTag = this.theme.fg("dim", "[Ctrl+Shift+T · /swarm tasks]");

    if (width < 58) {
      const left = this.theme.fg("accent", this.theme.bold(`🐝 ${titleText}`));
      const right = `${statusBadge} · ${boardTag} · ${fleetTag}`;
      lines.push(fitLine(joinColumns(left, right, width), width));
      const modelsPill = formatRoleModelsLine(
        roleModels,
        this.resolveHostModel(),
        {
          maxWidth: Math.max(1, width - 2),
          theme: this.theme,
        },
      );
      lines.push(fitLine(`  ${modelsPill}`, width));
    } else if (width < 112) {
      const left = `${this.theme.fg("accent", this.theme.bold(`🐝 ${titleText}`))} · ${statusBadge}`;
      const right = `${boardTag} · ${fleetTag}`;
      lines.push(fitLine(joinColumns(left, right, width), width));

      const modelsBudget = Math.max(12, width - visibleWidth("[Ctrl+Shift+T · /swarm tasks]") - 4);
      const modelsPill = formatRoleModelsLine(
        roleModels,
        this.resolveHostModel(),
        {
          maxWidth: modelsBudget,
          theme: this.theme,
        },
      );
      lines.push(fitLine(joinColumns(`  ${modelsPill}`, shortcutTag, width), width));
    } else {
      const lead = `${this.theme.fg("accent", this.theme.bold(`🐝 ${titleText}`))} · ${statusBadge} · ${boardTag} · ${fleetTag}`;
      const modelsBudget = Math.max(
        16,
        width - visibleWidth(lead) - visibleWidth("[Ctrl+Shift+T · /swarm tasks]") - 8,
      );
      if (modelsBudget >= 24) {
        const modelsPill = formatRoleModelsLine(
          roleModels,
          this.resolveHostModel(),
          {
            maxWidth: modelsBudget,
            theme: this.theme,
          },
        );
        lines.push(
          fitLine(
            joinColumns(`${lead} · ${modelsPill}`, shortcutTag, width),
            width,
          ),
        );
      } else {
        lines.push(fitLine(joinColumns(lead, shortcutTag, width), width));
        const modelsPill = formatRoleModelsLine(
          roleModels,
          this.resolveHostModel(),
          {
            maxWidth: Math.max(1, width - 2),
            theme: this.theme,
          },
        );
        lines.push(fitLine(`  ${modelsPill}`, width));
      }
    }

    // Active working members (up to 4 + "+N more")
    const visibleWorking = workingMembers.slice(0, this.maxCompactWorkers);
    for (const member of visibleWorking) {
      lines.push(this.renderWorkingMemberLine(member, width, nowMs));
    }
    if (workingMembers.length > visibleWorking.length) {
      const extra = workingMembers.length - visibleWorking.length;
      lines.push(
        fitLine(
          this.theme.fg(
            "dim",
            `  +${extra} more working · /swarm tasks`,
          ),
          width,
        ),
      );
    }

    // Latest board post preview
    if (snapshot.recentBoard.length > 0) {
      const latest = snapshot.recentBoard[snapshot.recentBoard.length - 1]!;
      lines.push(this.renderBoardPreviewLine(latest, width));
    }

    // Rate-limit backoff notice (when active)
    if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > nowMs) {
      const rem = formatDuration(snapshot.rateLimitUntil - nowMs);
      const reason = snapshot.rateLimitReason
        ? ` — ${sanitizePlainText(snapshot.rateLimitReason)}`
        : "";
      lines.push(
        fitLine(
          this.theme.fg("warning", `  ⏳ Rate-limit backoff (${rem})${reason}`),
          width,
        ),
      );
    }

    return lines.map((l) => fitLine(l, width));
  }

  private renderExpanded(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    workingMembers: readonly SwarmMemberRecord[],
    waitingMembers: readonly SwarmMemberRecord[],
    width: number,
    nowMs: number,
  ): string[] {
    const termRows = this.tui.terminal?.rows ?? 32;
    const rawMaxTotal = Math.max(8, Math.min(36, Math.floor(termRows * 0.82)));
    const maxTotalLines =
      termRows >= 10 ? Math.min(termRows - 2, Math.max(10, rawMaxTotal)) : Math.max(4, termRows);
    const innerWidth =
      width < 12 ? Math.max(1, width) : Math.max(1, width - (width < 24 ? 2 : 4));
    const maxInner = Math.max(4, maxTotalLines - 2);

    const body: string[] = [];

    if (this.state.draftActive) {
      body.push(...this.renderDraftBanner(innerWidth));
    }

    const titleText = sanitizePlainText(run.title || run.objective) || run.id;
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const workingCount = getWorkingCount(snapshot, workingMembers);
    const waitingCount = getWaitingCount(snapshot, waitingMembers);
    const roleModels = resolveEffectiveRoleModels(snapshot, run);

    const summaryLeft = `[${statusBadge}] ${sanitizePlainText(run.objective || titleText)}`;
    const summaryRight = `base:${sanitizePlainText(run.baseBranch)} · Board:#${snapshot.boardHead} · ${workingCount}w/${waitingCount}wait · ${formatTokens(snapshot.totalTokens)} ${formatCost(snapshot.totalCost)}`;
    body.push(
      innerWidth >= 72
        ? joinColumns(summaryLeft, summaryRight, innerWidth)
        : fitLine(summaryLeft, innerWidth),
    );
    if (innerWidth < 72) {
      body.push(fitLine(this.theme.fg("muted", summaryRight), innerWidth));
    }

    // 3-Role Models bar
    const modelsPrefix = this.theme.fg("muted", "Models: ");
    const modelsBudget = Math.max(1, innerWidth - visibleWidth("Models: "));
    const modelsLine = formatRoleModelsLine(
      roleModels,
      this.resolveHostModel(),
      {
        maxWidth: modelsBudget,
        theme: this.theme,
      },
    );
    body.push(fitLine(`${modelsPrefix}${modelsLine}`, innerWidth));

    // Channels summary
    const channelsText = formatChannelsSummaryInline(run, this.theme);
    body.push(
      fitLine(`${this.theme.fg("muted", "Channels: ")}${channelsText}`, innerWidth),
    );

    // Rate-limit notice if active
    if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > nowMs) {
      const rem = formatDuration(snapshot.rateLimitUntil - nowMs);
      const reason = snapshot.rateLimitReason
        ? ` — ${sanitizePlainText(snapshot.rateLimitReason)}`
        : "";
      body.push(
        fitLine(
          this.theme.fg("warning", `⏳ Rate-limit backoff (${rem})${reason}`),
          innerWidth,
        ),
      );
    }

    // Full Roster table (Name | Role | State | Model | Workspace | Turns | Activity)
    const members = getSortedMembers(run);
    body.push(
      renderHorizontalRule(
        innerWidth,
        `Roster (${workingCount}w / ${waitingCount}wait · ${members.length} total)`,
        this.theme,
      ),
    );

    if (members.length === 0) {
      body.push(
        fitLine(this.theme.fg("dim", "  (no members spawned yet)"), innerWidth),
      );
    } else {
      const columns: TableColumn<SwarmMemberRecord>[] = [
        {
          key: "name",
          header: "Name",
          minWidth: 8,
          maxWidth: 18,
          priority: 100,
          render: (m) => {
            const icon =
              m.state === "working"
                ? this.theme.fg("accent", SPINNER_FRAMES[this.spinnerFrame]!)
                : memberStateIcon(m.state);
            return `${icon} ${this.theme.bold(sanitizePlainText(m.name))}`;
          },
        },
        {
          key: "role",
          header: "Role",
          minWidth: 6,
          maxWidth: 10,
          priority: 90,
          render: (m) => formatMemberRoleBadge(m.role, this.theme),
        },
        {
          key: "state",
          header: "State",
          minWidth: 7,
          maxWidth: 10,
          priority: 95,
          render: (m) => formatMemberStateBadge(m.state, this.theme),
        },
        {
          key: "model",
          header: "Model",
          minWidth: 10,
          maxWidth: 24,
          flex: 1,
          priority: 75,
          render: (m) => {
            if (!m.model) return this.theme.fg("dim", "default");
            const suffix = m.thinkingLevel ? `:${m.thinkingLevel}` : "";
            return this.theme.fg("muted", `${shortenModelName(m.model, 16)}${suffix}`);
          },
        },
        {
          key: "workspace",
          header: "Workspace",
          minWidth: 9,
          maxWidth: 22,
          flex: 1,
          priority: 65,
          render: (m) => formatWorkspaceBadge(m.workspace, m.branch, this.theme),
        },
        {
          key: "turns",
          header: "Turns",
          minWidth: 5,
          maxWidth: 6,
          align: "right",
          priority: 55,
          render: (m) => this.theme.fg("muted", String(m.turns)),
        },
        {
          key: "activity",
          header: "Activity",
          minWidth: 12,
          maxWidth: 32,
          flex: 2,
          priority: 45,
          render: (m) => {
            const text =
              m.currentActivity ||
              m.parkedOn ||
              (m.lastTool ? `tool:${m.lastTool}` : m.state);
            return this.theme.fg("dim", sanitizePlainText(text));
          },
        },
      ];

      const recentBoardReserve = snapshot.recentBoard.length > 0 ? 7 : 0;
      const maxRosterRows = Math.max(
        1,
        Math.min(members.length, maxInner - body.length - recentBoardReserve - 2),
      );
      const tableLines = renderTable(members, columns, innerWidth, {
        header: true,
        theme: this.theme,
        maxRows: maxRosterRows,
        columnGap: innerWidth < 60 ? 1 : 2,
      });
      body.push(...tableLines);
    }

    // Recent 5 Board messages (#seq)
    const recentBoard = snapshot.recentBoard.slice(-this.maxRecentBoard);
    if (recentBoard.length > 0 && body.length < maxInner - 1) {
      body.push(
        renderHorizontalRule(
          innerWidth,
          `Recent Board (#${snapshot.boardHead})`,
          this.theme,
        ),
      );
      const remaining = Math.max(1, maxInner - body.length);
      for (const msg of recentBoard.slice(-remaining)) {
        body.push(this.renderBoardPreviewLine(msg, innerWidth));
      }
    }

    const title = this.theme.fg(
      "accent",
      this.theme.bold(`🐝 ${titleText} · ${run.id}`),
    );
    const footer = this.theme.fg(
      "dim",
      innerWidth >= 82
        ? "Ctrl+Shift+T / Esc collapse · Ctrl+Shift+M Models · Ctrl+Shift+S UI · /swarm board · /swarm graph"
        : "Ctrl+Shift+T / Esc collapse · ^M Models · ^S UI · /swarm tasks",
    );

    return renderBox(body.slice(0, maxInner), width, {
      title,
      footer,
      borderColor: (s) => this.theme.fg("border", s),
    });
  }

  render(width: number): string[] {
    const targetWidth = Math.max(0, Math.floor(width));
    if (targetWidth === 0) return [];

    const snapshot = this.getSnapshot();
    const run = snapshot.run;

    if (!run) {
      this.syncSpinnerTimer(false);
      if (!this.state.draftActive) {
        return [];
      }
      return this.renderDraftBanner(targetWidth);
    }

    const workingMembers = getWorkingMembers(snapshot, run);
    const waitingMembers = getWaitingMembers(snapshot, run);
    this.syncSpinnerTimer(workingMembers.length > 0);

    const nowMs = this.now();

    if (this.state.expanded) {
      return this.renderExpanded(
        snapshot,
        run,
        workingMembers,
        waitingMembers,
        targetWidth,
        nowMs,
      );
    }
    return this.renderCompact(
      snapshot,
      run,
      workingMembers,
      waitingMembers,
      targetWidth,
      nowMs,
    );
  }
}

export function createSwarmWidget(
  getSnapshot: () => SwarmSnapshot,
  state: SwarmWidgetState,
  options?: SwarmWidgetOptions,
): (tui: TUI, theme: Theme) => Component & { dispose(): void } {
  return (tui: TUI, theme: Theme) =>
    new SwarmDashboardComponent(tui, theme, getSnapshot, state, options);
}

// ============================================================================
// Single-Line Footer Status Bar Formatter
// ============================================================================

export function formatStatusLine(
  snapshot: SwarmSnapshot,
  draftActive = false,
): string | undefined {
  const run = snapshot.run;
  if (!run) {
    return draftActive ? "🐝 swarm:draft" : undefined;
  }

  const workingMembers = getWorkingMembers(snapshot, run);
  const waitingMembers = getWaitingMembers(snapshot, run);
  const workingCount = getWorkingCount(snapshot, workingMembers);
  const waitingCount = getWaitingCount(snapshot, waitingMembers);

  const statusLabel = formatRunStatusBadge(run.status);
  const leadTokens: string[] = [
    `🐝 swarm:${statusLabel}`,
    `${workingCount}w/${waitingCount}wait`,
  ];
  if (snapshot.boardHead > 0) {
    leadTokens.push(`#${snapshot.boardHead}`);
  }

  const parts: string[] = [leadTokens.join(" ")];
  if (snapshot.totalTokens > 0) {
    parts.push(`${formatTokens(snapshot.totalTokens)} tok`);
  }
  if (draftActive) {
    parts.push("draft");
  }

  return parts.join(" · ");
}

// ============================================================================
// Zero-LLM-Turn Markdown Formatters
// (`/swarm status`, `/swarm board`, `/swarm models`, `/swarm graph`)
// ============================================================================

function escapeMdCell(text: string): string {
  return sanitizePlainText(text).replace(/\|/g, "\\|");
}

export function formatZeroTurnStatusDashboard(
  snapshot: SwarmSnapshot,
  options?: StatusDashboardOptions,
): string {
  const run = snapshot.run;
  const nowMs = options?.now ? options.now() : Date.now();

  if (!run) {
    if (options?.draftActive) {
      const seedLine = options.draftSeed
        ? `\n- **Seed:** ${sanitizePlainText(options.draftSeed)}`
        : "";
      return [
        "### 🐝 Swarm Draft Active",
        "",
        `Clarifying requirements & strategy.${seedLine}`,
        "- Continue answering questions in chat or run `/swarm cancel` to discard.",
      ].join("\n");
    }
    return "No active Swarm run. Start one with `/swarm <idea>` or `/swarm direct <objective>`.";
  }

  const members = getSortedMembers(run);
  const workingMembers = getWorkingMembers(snapshot, run);
  const waitingMembers = getWaitingMembers(snapshot, run);
  const workingCount = getWorkingCount(snapshot, workingMembers);
  const waitingCount = getWaitingCount(snapshot, waitingMembers);
  const roleModels = resolveEffectiveRoleModels(snapshot, run);
  const hostFallback = options?.hostModel ?? "host default";
  const channels = getOrderedChannels(run);

  const out: string[] = [];
  const titleStr = sanitizePlainText(run.title || run.objective) || run.id;
  out.push(
    `### 🐝 ${titleStr} — \`${run.id}\` (${formatRunStatusBadge(run.status)})`,
  );
  out.push("");
  out.push(`- **Objective:** ${sanitizePlainText(run.objective)}`);
  if (run.strategy) {
    out.push(`- **Strategy:** ${sanitizePlainText(run.strategy)}`);
  }
  if (run.acceptanceCriteria) {
    out.push(
      `- **Acceptance Criteria:** ${sanitizePlainText(run.acceptanceCriteria)}`,
    );
  }
  out.push(
    `- **Base Branch:** \`${sanitizePlainText(run.baseBranch)}\` · **Roster:** ${workingCount} working · ${waitingCount} waiting / ${members.length} total (max ${run.maxConcurrency}) · **Board:** #${snapshot.boardHead}`,
  );
  out.push(
    `- **Validator Policy:** ${run.validatorEnabled ? "ON" : "OFF"} · **Keep Warm:** ${run.keepWorkersWarm ? "ON" : "OFF"} · **Usage:** ${formatTokens(snapshot.totalTokens)} tokens (${formatCost(snapshot.totalCost)})`,
  );

  if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > nowMs) {
    const rem = formatDuration(snapshot.rateLimitUntil - nowMs);
    const reason = snapshot.rateLimitReason
      ? ` (${sanitizePlainText(snapshot.rateLimitReason)})`
      : "";
    out.push(`- **Rate-Limit Backoff:** ${rem} remaining${reason}`);
  }

  // 3-Role Models
  out.push("");
  out.push("#### 3-Role Models");
  out.push(`- **Summary:** ${formatRoleModelsLine(roleModels, hostFallback)}`);
  out.push("| Role | Model | Thinking |");
  out.push("| --- | --- | --- |");
  const roleRows: { role: SwarmModelRole; label: string }[] = [
    { role: "orchestrator", label: "Orchestrator" },
    { role: "worker", label: "Worker" },
    { role: "validator", label: "Validator" },
  ];
  for (const r of roleRows) {
    const cfg = roleModels[r.role];
    const modelStr = cfg?.model
      ? `\`${escapeMdCell(cfg.model)}\``
      : `_${escapeMdCell(hostFallback)}_`;
    const thinkingStr = cfg?.thinkingLevel ? `\`${cfg.thinkingLevel}\`` : "default";
    out.push(`| ${r.label} | ${modelStr} | ${thinkingStr} |`);
  }
  if (roleModels.fallbackModels && roleModels.fallbackModels.length > 0) {
    out.push(
      `- **Fallback Models:** ${roleModels.fallbackModels.map((m) => `\`${sanitizePlainText(m)}\``).join(", ")}`,
    );
  }

  // Channels
  out.push("");
  out.push(`#### Channels (${channels.length})`);
  if (channels.length === 0) {
    out.push("_No channels configured._");
  } else {
    out.push("| Channel | Topic | Subscribers | Status |");
    out.push("| --- | --- | --- | --- |");
    for (const ch of channels) {
      const topic = ch.topic ? escapeMdCell(ch.topic) : "—";
      const subs =
        ch.subscribers.length > 0
          ? ch.subscribers.map((s) => `\`${escapeMdCell(s)}\``).join(", ")
          : "_none_";
      const status = ch.archived ? "archived" : "active";
      out.push(`| \`#${escapeMdCell(ch.name)}\` | ${topic} | ${subs} | ${status} |`);
    }
  }

  // Full Roster Table
  out.push("");
  out.push(
    `#### Roster (${workingCount} working · ${waitingCount} waiting / ${members.length} total)`,
  );
  if (members.length === 0) {
    out.push("_No members spawned yet._");
  } else {
    out.push(
      "| Name | Role | State | Model | Workspace | Parent | Turns | Last Read/Post |",
    );
    out.push("| --- | --- | --- | --- | --- | --- | ---: | --- |");
    for (const m of members) {
      const stateText = m.humanStopped
        ? `${formatMemberStateBadge(m.state)} (human)`
        : formatMemberStateBadge(m.state);
      const modelCol = m.model
        ? `\`${escapeMdCell(m.model)}\``
        : `_${escapeMdCell(hostFallback)}_`;
      const wsCol = `\`${escapeMdCell(formatWorkspaceBadge(m.workspace, m.branch))}\``;
      const parentCol = `\`${escapeMdCell(m.parentName)}\``;
      const seqCol = `read #${m.lastReadSeq} / post ${m.lastPostSeq !== undefined ? `#${m.lastPostSeq}` : "—"}`;
      out.push(
        `| \`${escapeMdCell(m.name)}\` | ${formatMemberRoleBadge(m.role)} | ${escapeMdCell(stateText)} | ${modelCol} | ${wsCol} | ${parentCol} | ${m.turns} | ${seqCol} |`,
      );
    }
  }

  // Recent Board (#seq)
  const recentBoard = snapshot.recentBoard.slice(-8);
  if (recentBoard.length > 0 || snapshot.boardHead > 0) {
    out.push("");
    out.push(`#### Recent Board (#${snapshot.boardHead})`);
    if (recentBoard.length === 0) {
      out.push(
        `_Board head is #${snapshot.boardHead}; run \`/swarm board\` to inspect._`,
      );
    } else {
      for (const msg of recentBoard) {
        const clock = formatEventClock(msg.timestamp);
        const ch = sanitizePlainText(msg.channel || "main");
        const targets = formatBoardTargets(msg);
        out.push(
          `- **#${msg.seq}** \`${clock}\` [${ch}] \`${formatBoardKindBadge(msg.kind)}\` **@${sanitizePlainText(msg.from)}**${targets}: ${sanitizePlainText(msg.text)}`,
        );
      }
    }
  }

  // Recent Activity
  const recent: SwarmEvent[] = snapshot.recentEvents.slice(-10);
  if (recent.length > 0) {
    out.push("");
    out.push("#### Recent Activity");
    for (const ev of recent) {
      const clock = formatEventClock(ev.timestamp);
      const memberTag = ev.memberName ? ` [\`${ev.memberName}\`]` : "";
      const chTag = ev.channel ? ` [#${ev.channel}]` : "";
      out.push(
        `- \`${clock}\`${memberTag}${chTag} **${ev.type}**: ${sanitizePlainText(ev.summary)}`,
      );
    }
  }

  return out.join("\n");
}

/**
 * Zero-LLM-turn formatter for `/swarm board [N]` — Antigravity-Swarm-style
 * `#seq [ch] @from -> @mentions` feed.
 */
export function formatZeroTurnBoardView(
  messages: readonly BoardMessage[],
  head: number,
  options?: BoardViewOptions,
): string {
  const runSuffix = options?.runId ? ` — \`${sanitizePlainText(options.runId)}\`` : "";
  const chSuffix =
    options?.channel && options.channel !== "*"
      ? ` [#${sanitizePlainText(options.channel)}]`
      : "";
  const out: string[] = [
    `### 🐝 Swarm Board${runSuffix}${chSuffix} (head: #${head})`,
    "",
  ];

  if (messages.length === 0) {
    out.push(
      head > 0
        ? `_No messages in this range (board head is #${head})._`
        : "_No board messages posted yet._",
    );
    return out.join("\n");
  }

  out.push(`Showing ${messages.length} message(s) (head: #${head}).`);
  out.push("");

  for (const msg of messages) {
    const clock = formatEventClock(msg.timestamp);
    const ch = sanitizePlainText(msg.channel || "main");
    const kindBadge = formatBoardKindBadge(msg.kind);
    const sender = sanitizePlainText(msg.from);
    const targets = formatBoardTargets(msg);
    const body = sanitizePlainText(msg.text);
    out.push(
      `- **#${msg.seq}** \`${clock}\` [${ch}] \`${kindBadge}\` **@${sender}**${targets}: ${body}`,
    );
  }

  return out.join("\n");
}

/**
 * Zero-LLM-turn formatter for `/swarm models`.
 * Shows configured 3-role models (`orchestrator`/`worker`/`validator` + `fallbackModels`)
 * and every member's live model & state.
 */
export function formatZeroTurnModelsView(
  settings: SwarmSettings,
  snapshot: SwarmSnapshot,
  hostModel?: string,
): string {
  const hostDisplay = sanitizePlainText(hostModel ?? "") || "host default";
  const effectiveRoles = resolveEffectiveRoleModels(snapshot, snapshot.run);

  const out: string[] = [
    "### 🐝 Swarm 3-Role Models",
    "",
    `- **Host Default Model:** \`${hostDisplay}\``,
    "",
    "#### Configured 3-Role Models",
    "| Role | Settings Model | Active Run Model | Thinking |",
    "| --- | --- | --- | --- |",
  ];

  const roleDefs: {
    role: SwarmModelRole;
    label: string;
    settingsModel?: string;
    settingsThinking?: string;
  }[] = [
    {
      role: "orchestrator",
      label: "orchestrator",
      settingsModel: settings.orchestratorModel,
      settingsThinking: settings.orchestratorThinkingLevel,
    },
    {
      role: "worker",
      label: "worker",
      settingsModel: settings.workerModel,
      settingsThinking: settings.workerThinkingLevel,
    },
    {
      role: "validator",
      label: "validator",
      settingsModel: settings.validatorModel,
      settingsThinking: settings.validatorThinkingLevel,
    },
  ];

  for (const r of roleDefs) {
    const runCfg = effectiveRoles[r.role];
    const settingsCell = r.settingsModel
      ? `\`${escapeMdCell(r.settingsModel)}\``
      : `_${escapeMdCell(hostDisplay)}_`;
    const activeModel = runCfg?.model ?? r.settingsModel;
    const activeCell = activeModel
      ? `\`${escapeMdCell(activeModel)}\``
      : `_${escapeMdCell(hostDisplay)}_`;
    const thinking = runCfg?.thinkingLevel ?? r.settingsThinking ?? "default";
    out.push(
      `| ${r.label} | ${settingsCell} | ${activeCell} | \`${escapeMdCell(thinking)}\` |`,
    );
  }

  const fallbacks = Array.from(
    new Set([
      ...settings.fallbackModels,
      ...(effectiveRoles.fallbackModels ?? []),
    ]),
  );
  out.push("");
  out.push(
    `- **Fallback Models:** ${fallbacks.length > 0 ? fallbacks.map((m) => `\`${sanitizePlainText(m)}\``).join(", ") : "_none_"}`,
  );

  // Live Member Models
  out.push("");
  out.push("#### Live Member Models");
  const run = snapshot.run;
  if (!run) {
    out.push("_No active Swarm run._");
  } else {
    const members = getSortedMembers(run);
    if (members.length === 0) {
      out.push("_No members spawned in the current run._");
    } else {
      out.push("| Name | Role | State | Live Model | Thinking | Workspace | Turns |");
      out.push("| --- | --- | --- | --- | --- | --- | ---: |");
      for (const m of members) {
        const liveModel = m.model ?? hostDisplay;
        const thinking = m.thinkingLevel ?? "default";
        const ws = formatWorkspaceBadge(m.workspace, m.branch);
        out.push(
          `| \`${escapeMdCell(m.name)}\` | ${formatMemberRoleBadge(m.role)} | ${escapeMdCell(formatMemberStateBadge(m.state))} | \`${escapeMdCell(liveModel)}\` | \`${escapeMdCell(thinking)}\` | \`${escapeMdCell(ws)}\` | ${m.turns} |`,
        );
      }
    }
  }

  out.push("");
  out.push(
    "_Tip: Hot-switch any `waiting` member's model with `/swarm model <member> <model>` or press `[m]` in `/swarm tasks`._",
  );

  return out.join("\n");
}

/**
 * Zero-LLM-turn formatter for `/swarm graph`.
 * Renders Markdown/ASCII Spawn Tree + Peer `@mention` Interaction Graph using `buildSwarmGraphLines`.
 */
export function formatZeroTurnGraphView(
  snapshot: SwarmSnapshot,
  options?: GraphViewOptions,
): string {
  const run = snapshot.run;
  if (!run) {
    return "No active Swarm run. Start one with `/swarm <idea>` or `/swarm direct <objective>`.";
  }

  const width = Math.max(40, Math.floor(options?.width ?? 88));
  const board = options?.board ?? snapshot.recentBoard;
  const graphLines = buildSwarmGraphLines(run, board, width);
  const titleStr = sanitizePlainText(run.title || run.objective) || run.id;

  return [
    `### 🐝 Swarm Graph — ${titleStr} (\`${run.id}\`)`,
    "",
    "```text",
    ...graphLines,
    "```",
  ].join("\n");
}

// ============================================================================
// Global Terminal Input Shortcut Bindings (Modal-Depth Guarded)
// ============================================================================

export function bindSwarmShortcuts(
  ctx: ExtensionContext,
  callbacks: SwarmShortcutCallbacks,
): () => void {
  if (ctx.mode !== "tui") {
    return () => {};
  }

  return ctx.ui.onTerminalInput((data: string) => {
    if (isKeyReleaseSafe(data)) {
      return undefined;
    }

    // Strictly never hijack input while any modal/dialog/overlay is open
    if (callbacks.isModalOpen()) {
      return undefined;
    }

    if (matchesKey(data, Key.ctrlShift("t"))) {
      callbacks.onToggleExpand();
      return { consume: true };
    }

    if (matchesKey(data, Key.ctrlShift("m")) && callbacks.onOpenModelPicker) {
      callbacks.onOpenModelPicker();
      return { consume: true };
    }

    if (matchesKey(data, Key.ctrlShift("s")) && callbacks.onOpenMissionControl) {
      callbacks.onOpenMissionControl();
      return { consume: true };
    }

    if (isEscapeKey(data) && callbacks.isExpanded() && !callbacks.isHostStreaming?.()) {
      callbacks.onCollapse();
      return { consume: true };
    }

    return undefined;
  });
}

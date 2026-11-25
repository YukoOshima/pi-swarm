import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { ORCHESTRATOR_NAME } from "../constants.js";
import type {
  AssertionStatus,
  BoardMessage,
  FeatureStatus,
  MissionAssertion,
  MissionFeature,
  MissionHandoffItem,
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
  countMergedMembers,
  fitLine,
  formatBoardKindBadge,
  formatBoardTargets,
  formatCost,
  formatDuration,
  formatElapsedSince,
  formatMemberRoleBadge,
  formatMemberStateBadge,
  formatMergedBadge,
  formatRoleModelsLine,
  formatRunStatusBadge,
  formatTokens,
  formatWorkspaceBadge,
  getOrderedMembers,
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
  orchestratorStandby?: boolean;
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
  orchestratorStandby?: boolean;
  hostModel?: string;
  now?: () => number;
}

export interface FormatStatusLineOptions {
  draftActive?: boolean;
  orchestratorStandby?: boolean;
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
    ...(initial?.orchestratorStandby !== undefined
      ? { orchestratorStandby: initial.orchestratorStandby }
      : {}),
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
      !workingNames.has(m.name) &&
      m.state !== "working" &&
      (m.state === "waiting" ||
        (waitingNames.has(m.name) &&
          m.state !== "stopped" &&
          m.state !== "killed")),
  );
}

function getStoppedMembers(
  run: SwarmRunState,
): SwarmMemberRecord[] {
  return getOrderedMembers(run).filter((m) => m.state === "stopped");
}

function getWorkingCount(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
  workingMembers: readonly SwarmMemberRecord[],
): number {
  const validWorkingNames = snapshot.workingMemberNames.filter((name) => {
    const m = run.members[name];
    return !m || (m.state !== "stopped" && m.state !== "killed");
  });
  return Math.max(workingMembers.length, validWorkingNames.length);
}

function getWaitingCount(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
  waitingMembers: readonly SwarmMemberRecord[],
): number {
  const workingNames = new Set(snapshot.workingMemberNames);
  const nonWorkingWaitingNames = snapshot.waitingMemberNames.filter((name) => {
    if (workingNames.has(name)) return false;
    const m = run.members[name];
    return (
      !m ||
      (m.state !== "working" &&
        m.state !== "stopped" &&
        m.state !== "killed")
    );
  });
  return Math.max(waitingMembers.length, nonWorkingWaitingNames.length);
}

function isTerminalRunStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "abandoned" ||
    status === "cancelled" ||
    status === "failed"
  );
}

function formatFleetSummary(
  workingCount: number,
  waitingCount: number,
  stoppedCount = 0,
  mergedCount = 0,
  theme?: Theme,
): string {
  const sep = theme ? theme.fg("dim", " · ") : " · ";
  const workPart = theme
    ? theme.fg(workingCount > 0 ? "accent" : "muted", `${workingCount} working`)
    : `${workingCount} working`;
  const waitPart = theme
    ? theme.fg("muted", `${waitingCount} waiting`)
    : `${waitingCount} waiting`;
  const parts = [workPart, waitPart];
  if (stoppedCount > 0) {
    parts.push(
      theme
        ? theme.fg("warning", `${stoppedCount} stopped`)
        : `${stoppedCount} stopped`,
    );
  }
  if (mergedCount > 0) {
    parts.push(
      theme
        ? theme.fg("success", `${mergedCount} merged`)
        : `${mergedCount} merged`,
    );
  }
  return parts.join(sep);
}

function formatPhaseMilestones(
  run: SwarmRunState,
  theme?: Theme,
): string | undefined {
  const phase = run.phase ? sanitizePlainText(run.phase) : "";
  const milestones = run.milestones ?? [];
  if (!phase && milestones.length === 0) return undefined;

  const doneCount = milestones.filter((m) => m.status === "done").length;
  const sealedCount = milestones.filter((m) => Boolean(m.sealed)).length;
  const totalCount = milestones.length;
  const sealedSuffix =
    sealedCount > 0
      ? theme
        ? ` ${theme.fg("success", `[S] ${sealedCount}`)}`
        : ` [S] ${sealedCount}`
      : "";

  if (phase && totalCount > 0) {
    const ratio = `[${doneCount}/${totalCount}]`;
    return theme
      ? `${theme.fg("muted", "Phase:")} ${theme.fg("accent", phase)} ${theme.fg(doneCount === totalCount ? "success" : "muted", ratio)}${sealedSuffix}`
      : `Phase: ${phase} ${ratio}${sealedSuffix}`;
  }
  if (phase) {
    return theme
      ? `${theme.fg("muted", "Phase:")} ${theme.fg("accent", phase)}`
      : `Phase: ${phase}`;
  }
  const ratio = `[${doneCount}/${totalCount}]`;
  return theme
    ? `${theme.fg("muted", "Milestones:")} ${theme.fg(doneCount === totalCount ? "success" : "accent", ratio)}${sealedSuffix}`
    : `Milestones: ${ratio}${sealedSuffix}`;
}

interface GoalProgressSummary {
  features: MissionFeature[];
  featDone: number;
  featTotal: number;
  featInProgress: number;
  featFailed: number;
  assertions: MissionAssertion[];
  valPassed: number;
  valTotal: number;
  valFailed: number;
  valBlocked: number;
  valOverridden: number;
  openDebtItems: MissionHandoffItem[];
  openHandoffs: MissionHandoffItem[];
  sealedMilestoneLabels: string[];
  hasCompactBadges: boolean;
  hasExpandedSection: boolean;
}

function summarizeGoalProgress(run: SwarmRunState): GoalProgressSummary {
  const features = run.features ?? [];
  const nonCancelled = features.filter((f) => f.status !== "cancelled");
  const featTotal =
    features.length > 0
      ? nonCancelled.length > 0
        ? nonCancelled.length
        : features.length
      : 0;
  const featDone = nonCancelled.filter((f) => f.status === "completed").length;
  const featInProgress = nonCancelled.filter((f) => f.status === "in_progress").length;
  const featFailed = nonCancelled.filter((f) => f.status === "failed").length;

  const assertions = run.assertions ?? [];
  const valTotal = assertions.length;
  const valPassed = assertions.filter((a) => a.status === "passed").length;
  const valFailed = assertions.filter((a) => a.status === "failed").length;
  const valBlocked = assertions.filter((a) => a.status === "blocked").length;
  const valOverridden = assertions.filter((a) => Boolean(a.overridden)).length;

  const handoffItems = run.handoffItems ?? [];
  const openHandoffs = handoffItems.filter((h) => h.resolution === "open");
  const openDebtItems = openHandoffs.filter(
    (h) => h.type === "discovered_issue" || h.type === "incomplete_work",
  );

  const sealedMilestoneLabels = (run.milestones ?? [])
    .filter((m) => Boolean(m.sealed))
    .map((m) => sanitizePlainText(m.label))
    .filter(Boolean);

  const hasCompactBadges =
    features.length > 0 || assertions.length > 0 || openDebtItems.length > 0;
  const hasExpandedSection =
    hasCompactBadges || sealedMilestoneLabels.length > 0;

  return {
    features,
    featDone,
    featTotal,
    featInProgress,
    featFailed,
    assertions,
    valPassed,
    valTotal,
    valFailed,
    valBlocked,
    valOverridden,
    openDebtItems,
    openHandoffs,
    sealedMilestoneLabels,
    hasCompactBadges,
    hasExpandedSection,
  };
}

function formatAsciiProgressBar(done: number, total: number, cells = 4): string {
  if (total <= 0 || cells <= 0) return "";
  const clampedDone = Math.max(0, Math.min(total, done));
  let filled = Math.round((clampedDone / total) * cells);
  if (clampedDone < total && filled >= cells) {
    filled = Math.max(0, cells - 1);
  }
  if (clampedDone > 0 && filled === 0 && cells >= 4 && clampedDone / total >= 0.15) {
    filled = 1;
  }
  return `[${"█".repeat(filled)}${"░".repeat(cells - filled)}]`;
}

function formatFeatureStatusGlyph(status: FeatureStatus, theme?: Theme): string {
  switch (status) {
    case "completed":
      return theme ? theme.fg("success", "[✓]") : "[✓]";
    case "in_progress":
      return theme ? theme.fg("accent", "[▸]") : "[▸]";
    case "failed":
      return theme ? theme.fg("error", "[!]") : "[!]";
    case "cancelled":
      return theme ? theme.fg("dim", "[~]") : "[~]";
    case "pending":
      return theme ? theme.fg("muted", "[ ]") : "[ ]";
  }
}

function formatAssertionStatusGlyph(status: AssertionStatus, theme?: Theme): string {
  switch (status) {
    case "passed":
      return theme ? theme.fg("success", "[✓]") : "[✓]";
    case "failed":
      return theme ? theme.fg("error", "[✗]") : "[✗]";
    case "blocked":
      return theme ? theme.fg("warning", "[!]") : "[!]";
    case "pending":
      return theme ? theme.fg("muted", "[ ]") : "[ ]";
  }
}

function formatCompactGoalBadges(
  goal: GoalProgressSummary,
  options?: { includeBar?: boolean; includeSealed?: boolean; theme?: Theme },
): string {
  const theme = options?.theme;
  const includeBar = options?.includeBar ?? false;
  const includeSealed = options?.includeSealed ?? false;
  const sep = theme ? theme.fg("dim", " · ") : " · ";
  const parts: string[] = [];

  if (goal.features.length > 0) {
    const bar = includeBar
      ? `${formatAsciiProgressBar(goal.featDone, goal.featTotal, 4)} `
      : "";
    const ratioRaw = `${bar}${goal.featDone}/${goal.featTotal}`;
    if (theme) {
      const ratioColor =
        goal.featFailed > 0
          ? "error"
          : goal.featDone === goal.featTotal && goal.featTotal > 0
            ? "success"
            : "accent";
      parts.push(`${theme.fg("muted", "Feat")} ${theme.fg(ratioColor, ratioRaw)}`);
    } else {
      parts.push(`Feat ${ratioRaw}`);
    }
  }

  if (goal.assertions.length > 0) {
    const bar =
      includeBar && goal.features.length === 0
        ? `${formatAsciiProgressBar(goal.valPassed, goal.valTotal, 4)} `
        : "";
    const ratioRaw = `${bar}${goal.valPassed}/${goal.valTotal}`;
    const ovrRaw = goal.valOverridden > 0 ? `(${goal.valOverridden} ovr)` : "";
    if (theme) {
      const valColor =
        goal.valFailed > 0
          ? "error"
          : goal.valPassed === goal.valTotal && goal.valTotal > 0
            ? "success"
            : "accent";
      const ovrStyled = ovrRaw ? ` ${theme.fg("warning", ovrRaw)}` : "";
      parts.push(
        `${theme.fg("muted", "VAL")} ${theme.fg(valColor, ratioRaw)}${ovrStyled}`,
      );
    } else {
      parts.push(`VAL ${ratioRaw}${ovrRaw ? ` ${ovrRaw}` : ""}`);
    }
  }

  if (includeSealed && goal.sealedMilestoneLabels.length > 0) {
    const sealedRaw = `[S] ${goal.sealedMilestoneLabels.length}`;
    parts.push(theme ? theme.fg("success", sealedRaw) : sealedRaw);
  }

  if (goal.openDebtItems.length > 0) {
    const debtRaw = `!${goal.openDebtItems.length} debt`;
    parts.push(theme ? theme.fg("warning", debtRaw) : debtRaw);
  }

  return parts.join(sep);
}

function selectGoalPreviewFeatures(
  features: readonly MissionFeature[],
  limit: number,
): MissionFeature[] {
  if (limit <= 0 || features.length === 0) return [];
  if (features.length <= limit) return [...features];

  const rank = (s: FeatureStatus): number => {
    switch (s) {
      case "failed":
        return 0;
      case "in_progress":
        return 1;
      case "pending":
        return 2;
      case "completed":
        return 3;
      case "cancelled":
        return 4;
    }
  };

  const indexed = features.map((f, idx) => ({ f, idx }));
  const chosenIndices = new Set<number>();

  // Ensure at least one completed feature is represented when space >= 3 so progress is visible alongside active/failed work
  if (limit >= 3) {
    const lastCompleted = [...indexed]
      .reverse()
      .find((item) => item.f.status === "completed");
    if (lastCompleted) {
      chosenIndices.add(lastCompleted.idx);
    }
  }

  const prioritized = [...indexed].sort(
    (a, b) => rank(a.f.status) - rank(b.f.status) || a.idx - b.idx,
  );
  for (const item of prioritized) {
    if (chosenIndices.size >= limit) break;
    chosenIndices.add(item.idx);
  }

  return indexed
    .filter((item) => chosenIndices.has(item.idx))
    .sort((a, b) => rank(a.f.status) - rank(b.f.status) || a.idx - b.idx)
    .map((item) => item.f);
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

function formatLocalClock(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return "--:--:--";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
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

export class SwarmDashboardComponent implements Component {
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

  private renderStandbyBanner(width: number): string[] {
    if (width < 52) {
      const compactLine = `${this.theme.fg("success", this.theme.bold("🐝 Orchestrator Standby"))}${this.theme.fg("dim", " · /swarm exit")}`;
      return [fitLine(compactLine, width)];
    }
    const left =
      width >= 76
        ? `${this.theme.fg("success", this.theme.bold("🐝 Persistent Orchestrator: Standby"))}${this.theme.fg("muted", ` — @${ORCHESTRATOR_NAME} on duty`)}`
        : this.theme.fg("success", this.theme.bold("🐝 Persistent Orchestrator: Standby"));
    const right = this.theme.fg("dim", "/swarm exit");
    return [fitLine(joinColumns(left, right, width), width)];
  }

  private renderExpandedStandbyLine(innerWidth: number): string {
    const dot = this.theme.fg("success", "●");
    const label = this.theme.fg(
      "accent",
      this.theme.bold("Persistent Orchestrator: Standby"),
    );
    if (innerWidth < 50) {
      return fitLine(`${dot} ${label}`, innerWidth);
    }
    if (innerWidth < 72) {
      return fitLine(
        `${dot} ${label} ${this.theme.fg("dim", "(/swarm exit)")}`,
        innerWidth,
      );
    }
    if (innerWidth < 96) {
      return fitLine(
        `${dot} ${label}${this.theme.fg("muted", ` — @${ORCHESTRATOR_NAME} on duty`)} ${this.theme.fg("dim", "(/swarm exit)")}`,
        innerWidth,
      );
    }
    const left = `${dot} ${label}${this.theme.fg("muted", ` — @${ORCHESTRATOR_NAME} remains on duty for follow-up tasks`)}`;
    const right = this.theme.fg("dim", "/swarm exit to leave");
    return fitLine(joinColumns(left, right, innerWidth), innerWidth);
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
      formatElapsedSince(member.turnStartedAt ?? member.createdAt, nowMs),
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

  private renderCompletedCompact(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    width: number,
  ): string[] {
    const lines: string[] = [];
    if (this.state.draftActive) {
      lines.push(...this.renderDraftBanner(width));
    }

    const titleText = sanitizePlainText(run.title || run.objective) || run.id;
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const mergedCount = countMergedMembers(run);
    const memberCount = getOrderedMembers(run).length;
    const usage =
      snapshot.totalTokens > 0
        ? `${formatTokens(snapshot.totalTokens)} ${formatCost(snapshot.totalCost)}`
        : "";
    const leadColor = run.status === "completed" ? "success" : "muted";
    const left = `${this.theme.fg(leadColor, "🐝")} [${statusBadge}] ${this.theme.bold(titleText)}`;

    if (width < 58) {
      const right = this.theme.fg("dim", `Board:#${snapshot.boardHead}`);
      lines.push(fitLine(joinColumns(left, right, width), width));
      if (this.state.orchestratorStandby) {
        lines.push(...this.renderStandbyBanner(width));
      }
      return lines;
    }

    const metaParts: string[] = [];
    const goal = summarizeGoalProgress(run);
    if (goal.hasCompactBadges) {
      metaParts.push(
        formatCompactGoalBadges(goal, {
          includeBar: false,
          includeSealed: false,
          theme: this.theme,
        }),
      );
    }
    if (mergedCount > 0) {
      metaParts.push(this.theme.fg("success", `${mergedCount} merged`));
    } else if (memberCount > 0) {
      metaParts.push(this.theme.fg("muted", `${memberCount} members`));
    }
    if (usage) {
      metaParts.push(this.theme.fg("dim", usage));
    }
    metaParts.push(this.theme.fg("dim", "Alt+W expand · Alt+S panel"));
    const right = metaParts.join(this.theme.fg("dim", " · "));
    lines.push(fitLine(joinColumns(left, right, width), width));
    if (this.state.orchestratorStandby) {
      lines.push(...this.renderStandbyBanner(width));
    }
    return lines;
  }

  private renderCompact(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    workingMembers: readonly SwarmMemberRecord[],
    waitingMembers: readonly SwarmMemberRecord[],
    stoppedMembers: readonly SwarmMemberRecord[],
    width: number,
    nowMs: number,
  ): string[] {
    const lines: string[] = [];

    if (
      this.state.draftActive &&
      (run.status !== "active" || this.state.draftMode === "tweak")
    ) {
      lines.push(...this.renderDraftBanner(width));
    }

    const titleText = sanitizePlainText(run.title || run.objective) || run.id;
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const workingCount = getWorkingCount(snapshot, run, workingMembers);
    const waitingCount = getWaitingCount(snapshot, run, waitingMembers);
    const stoppedCount = stoppedMembers.length;
    const mergedCount = countMergedMembers(run);
    const boardTag = this.theme.fg("accent", `Board:#${snapshot.boardHead}`);
    const compactFleetTag = `${this.theme.fg("accent", `${workingCount}w`)}/${this.theme.fg("muted", `${waitingCount}wait`)}${stoppedCount > 0 ? `/${this.theme.fg("warning", `${stoppedCount}stop`)}` : ""}${mergedCount > 0 ? `/${this.theme.fg("success", `${mergedCount}m`)}` : ""}`;
    const fleetTag = formatFleetSummary(
      workingCount,
      waitingCount,
      stoppedCount,
      mergedCount,
      this.theme,
    );
    const roleModels = resolveEffectiveRoleModels(snapshot, run);

    if (width < 58) {
      const left = this.theme.fg("accent", this.theme.bold(`🐝 ${titleText}`));
      const right = `${statusBadge} · ${boardTag} · ${compactFleetTag}`;
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
    } else if (width < 76) {
      const left = `${this.theme.fg("accent", this.theme.bold("🐝"))} [${statusBadge}] ${this.theme.fg("accent", this.theme.bold(titleText))}`;
      const right = `${fleetTag} · ${boardTag}`;
      lines.push(fitLine(joinColumns(left, right, width), width));

      const shortcutRaw = "[Alt+S · Alt+M · Alt+W]";
      const shortcutTag = this.theme.fg("dim", shortcutRaw);
      const modelsBudget = Math.max(12, width - visibleWidth(shortcutRaw) - 4);
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
      const left = `${this.theme.fg("accent", this.theme.bold("🐝"))} [${statusBadge}] ${this.theme.fg("accent", this.theme.bold(titleText))}`;
      const right = `${fleetTag} · ${boardTag}`;
      lines.push(fitLine(joinColumns(left, right, width), width));

      const shortcutRaw =
        width >= 96
          ? "[Alt+S panel · Alt+M models · Alt+W expand]"
          : "[Alt+S/M/W · /swarm tasks]";
      const shortcutTag = this.theme.fg("dim", shortcutRaw);
      const modelsBudget = Math.max(16, width - visibleWidth(shortcutRaw) - 4);
      const modelsPill = formatRoleModelsLine(
        roleModels,
        this.resolveHostModel(),
        {
          maxWidth: modelsBudget,
          theme: this.theme,
        },
      );
      lines.push(fitLine(joinColumns(`  ${modelsPill}`, shortcutTag, width), width));
    }

    // Mission phase & milestones progress (when set) + live Goal Progress badges
    const phaseProgress = formatPhaseMilestones(run, this.theme);
    const goal = summarizeGoalProgress(run);
    if (phaseProgress) {
      const costRight =
        snapshot.totalCost > 0
          ? this.theme.fg("dim", formatCost(snapshot.totalCost))
          : "";
      lines.push(
        costRight && width >= 48
          ? fitLine(joinColumns(`  ${phaseProgress}`, costRight, width), width)
          : fitLine(`  ${phaseProgress}`, width),
      );
    }
    if (goal.hasCompactBadges) {
      const goalBadges = formatCompactGoalBadges(goal, {
        includeBar: width >= 68,
        includeSealed: width >= 60 && !phaseProgress,
        theme: this.theme,
      });
      const lead = width >= 68 ? `${this.theme.fg("accent", "◆")} ` : "";
      const activeFeat = goal.features.find((f) => f.status === "in_progress");
      const activeTail =
        activeFeat && width >= 88
          ? `${this.theme.fg("dim", " · ")}${this.theme.fg("accent", "▸")} ${this.theme.bold(sanitizePlainText(activeFeat.id))}: ${this.theme.fg("muted", sanitizePlainText(activeFeat.title))}`
          : "";
      lines.push(fitLine(`  ${lead}${goalBadges}${activeTail}`, width));
    }

    // Active working members (up to 4 + "+N more"), or awaiting-orchestrator hint when active with 0 working
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
    } else if (run.status === "active" && workingCount === 0 && waitingCount > 0) {
      const idleHint = `  ${this.theme.fg("warning", "⏳ 0 working")}${this.theme.fg("muted", ` — awaiting @${ORCHESTRATOR_NAME} next step`)}`;
      lines.push(fitLine(idleHint, width));
    } else if (run.status === "active" && workingCount === 0 && stoppedCount > 0) {
      const stoppedHint = `  ${this.theme.fg("warning", `⏳ 0 working · ${stoppedCount} stopped`)}${this.theme.fg("muted", " — press Alt+S to retry or /swarm resume")}`;
      lines.push(fitLine(stoppedHint, width));
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
    stoppedMembers: readonly SwarmMemberRecord[],
    width: number,
    nowMs: number,
  ): string[] {
    const termRows = this.tui.terminal?.rows ?? 32;
    const maxTotalLines = Math.min(36, Math.max(8, termRows - 7));
    const innerWidth =
      width < 12 ? Math.max(1, width) : Math.max(1, width - (width < 24 ? 2 : 4));
    const maxInner = Math.max(4, maxTotalLines - 2);

    const body: string[] = [];

    if (
      this.state.draftActive &&
      (run.status !== "active" || this.state.draftMode === "tweak")
    ) {
      body.push(...this.renderDraftBanner(innerWidth));
    }
    if (isTerminalRunStatus(run.status) && this.state.orchestratorStandby) {
      body.push(this.renderExpandedStandbyLine(innerWidth));
    }

    const titleText = sanitizePlainText(run.title || run.objective) || run.id;
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const workingCount = getWorkingCount(snapshot, run, workingMembers);
    const waitingCount = getWaitingCount(snapshot, run, waitingMembers);
    const stoppedCount = stoppedMembers.length;
    const mergedCount = countMergedMembers(run);
    const fleetSummaryPlain = formatFleetSummary(
      workingCount,
      waitingCount,
      stoppedCount,
      mergedCount,
    );
    const roleModels = resolveEffectiveRoleModels(snapshot, run);

    const summaryLeft = `[${statusBadge}] ${sanitizePlainText(run.objective || titleText)}`;
    const summaryRight = `base:${sanitizePlainText(run.baseBranch)} · Board:#${snapshot.boardHead} · ${fleetSummaryPlain} · ${formatTokens(snapshot.totalTokens)} ${formatCost(snapshot.totalCost)}`;
    const canJoinSummary = innerWidth >= visibleWidth(summaryRight) + 24;
    body.push(
      canJoinSummary
        ? joinColumns(summaryLeft, summaryRight, innerWidth)
        : fitLine(summaryLeft, innerWidth),
    );
    if (!canJoinSummary) {
      body.push(fitLine(this.theme.fg("muted", summaryRight), innerWidth));
    }

    // Phase & Milestones progress (when set)
    const goal = summarizeGoalProgress(run);
    const tightGoalHeight = goal.hasExpandedSection && maxInner <= 12;
    const phaseProgress = formatPhaseMilestones(run, this.theme);
    if (phaseProgress && !tightGoalHeight) {
      body.push(fitLine(phaseProgress, innerWidth));
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

    // Channels summary (skip on cramped heights so Goal Progress, roster & newest board post stay visible)
    const channelsText = formatChannelsSummaryInline(run, this.theme);
    if ((!goal.hasExpandedSection || maxInner >= 14) && maxInner - body.length >= 7) {
      body.push(
        fitLine(`${this.theme.fg("muted", "Channels: ")}${channelsText}`, innerWidth),
      );
    }

    // Active idle status hint when 0 working and >0 waiting/stopped (1-cell safe glyphs inside renderBox)
    if (run.status === "active" && workingCount === 0 && waitingCount > 0 && maxInner - body.length >= (goal.hasExpandedSection ? 8 : 6)) {
      const idleHint = `${this.theme.fg("warning", "◇ 0 working")}${this.theme.fg("muted", ` — awaiting @${ORCHESTRATOR_NAME} next step`)}`;
      body.push(fitLine(idleHint, innerWidth));
    } else if (run.status === "active" && workingCount === 0 && stoppedCount > 0 && maxInner - body.length >= (goal.hasExpandedSection ? 8 : 6)) {
      const stoppedHint = `${this.theme.fg("warning", `! 0 working · ${stoppedCount} stopped`)}${this.theme.fg("muted", " — press Alt+S to retry or /swarm resume")}`;
      body.push(fitLine(stoppedHint, innerWidth));
    }

    // Rate-limit notice if active
    if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > nowMs && maxInner - body.length >= (goal.hasExpandedSection ? 7 : 5)) {
      const rem = formatDuration(snapshot.rateLimitUntil - nowMs);
      const reason = snapshot.rateLimitReason
        ? ` — ${sanitizePlainText(snapshot.rateLimitReason)}`
        : "";
      body.push(
        fitLine(
          this.theme.fg("warning", `! Rate-limit backoff (${rem})${reason}`),
          innerWidth,
        ),
      );
    }

    // Live Goal Progress section (features, VAL-* contract ratio, sealed milestones [S], open debt)
    const members = getSortedMembers(run);
    const recentBoard = snapshot.recentBoard.slice(-this.maxRecentBoard);
    if (goal.hasExpandedSection) {
      if (maxInner <= 8) {
        const badges = formatCompactGoalBadges(goal, {
          includeBar: innerWidth >= 68,
          includeSealed: true,
          theme: this.theme,
        });
        body.push(
          fitLine(`${this.theme.fg("accent", "◆ Goal Progress:")} ${badges}`, innerWidth),
        );
      } else if (maxInner <= 13) {
        const plainBadges = formatCompactGoalBadges(goal, {
          includeBar: innerWidth >= 78,
          includeSealed: false,
        });
        const sealedLabel =
          goal.sealedMilestoneLabels.length > 0
            ? ` · [S] ${goal.sealedMilestoneLabels[0]}${goal.sealedMilestoneLabels.length > 1 ? `+${goal.sealedMilestoneLabels.length - 1}` : ""}`
            : "";
        const ruleTitle =
          innerWidth >= 56 && (plainBadges || sealedLabel)
            ? `Goal Progress (${plainBadges}${plainBadges ? sealedLabel : sealedLabel.replace(/^ · /, "")})`
            : "Goal Progress";
        body.push(renderHorizontalRule(innerWidth, ruleTitle, this.theme));

        if (innerWidth < 56) {
          const compactBadges = formatCompactGoalBadges(goal, {
            includeBar: false,
            includeSealed: true,
            theme: this.theme,
          });
          const miniFeats = selectGoalPreviewFeatures(goal.features, 2)
            .map(
              (f) =>
                `${formatFeatureStatusGlyph(f.status, this.theme)} ${sanitizePlainText(f.id)}`,
            )
            .join(" ");
          body.push(
            fitLine(
              miniFeats ? `${compactBadges} · ${miniFeats}` : compactBadges,
              innerWidth,
            ),
          );
        } else if (goal.features.length > 0) {
          const pillFeats = selectGoalPreviewFeatures(goal.features, 4).map((f) => {
            const g = formatFeatureStatusGlyph(f.status, this.theme);
            const owner =
              innerWidth >= 88 && f.assignedMember
                ? ` ${this.theme.fg("dim", `(@${sanitizePlainText(f.assignedMember)})`)}`
                : "";
            return `${g} ${this.theme.bold(sanitizePlainText(f.id))}${owner}`;
          });
          body.push(
            fitLine(`  ${pillFeats.join(this.theme.fg("dim", " · "))}`, innerWidth),
          );
        } else if (goal.assertions.length > 0) {
          const pillVals = goal.assertions.slice(0, 4).map((a) => {
            const ovrTag = a.overridden
              ? ` ${this.theme.fg("warning", "[OVERRIDE]")}`
              : "";
            return `${formatAssertionStatusGlyph(a.status, this.theme)} ${sanitizePlainText(a.id)}${ovrTag}`;
          });
          body.push(
            fitLine(`  ${pillVals.join(this.theme.fg("dim", " · "))}`, innerWidth),
          );
        } else if (goal.sealedMilestoneLabels.length > 0) {
          body.push(
            fitLine(
              `  ${this.theme.fg("success", "[S]")} ${this.theme.fg("muted", goal.sealedMilestoneLabels.join(", "))}`,
              innerWidth,
            ),
          );
        }
      } else {
        body.push(renderHorizontalRule(innerWidth, "Goal Progress", this.theme));
        const badges = formatCompactGoalBadges(goal, {
          includeBar: innerWidth >= 56,
          includeSealed: false,
          theme: this.theme,
        });
        const sealedStr =
          goal.sealedMilestoneLabels.length > 0
            ? `${badges ? this.theme.fg("dim", " · ") : ""}${this.theme.fg("success", "[S]")} ${this.theme.fg("muted", goal.sealedMilestoneLabels.join(", "))}`
            : "";
        body.push(fitLine(`  ${badges}${sealedStr}`, innerWidth));

        const minRosterAndBoardReserve =
          (members.length > 0 ? 4 : 2) + (recentBoard.length > 0 ? 2 : 0);
        const itemSlotBudget = Math.min(
          maxInner >= 20 ? 4 : 3,
          Math.max(0, maxInner - body.length - minRosterAndBoardReserve),
        );
        if (itemSlotBudget > 0 && goal.features.length > 0) {
          const sealedSet = new Set(goal.sealedMilestoneLabels);
          const previewCount =
            goal.features.length > itemSlotBudget && itemSlotBudget >= 2
              ? itemSlotBudget - 1
              : itemSlotBudget;
          const previewFeats = selectGoalPreviewFeatures(goal.features, previewCount);
          for (const f of previewFeats) {
            const glyph = formatFeatureStatusGlyph(f.status, this.theme);
            const msClean = sanitizePlainText(f.milestone);
            const msBadge = msClean
              ? ` ${this.theme.fg("muted", `[${msClean}${sealedSet.has(msClean) ? " [S]" : ""}]`)}`
              : "";
            const ownerBadge = f.assignedMember
              ? ` ${this.theme.fg("accent", `@${sanitizePlainText(f.assignedMember)}`)}`
              : "";
            const fulfillsBadge =
              f.fulfills.length > 0 && innerWidth >= 72
                ? ` ${this.theme.fg("dim", `-> ${f.fulfills.map(sanitizePlainText).join(",")}`)}`
                : "";
            body.push(
              fitLine(
                `  ${glyph} ${this.theme.bold(sanitizePlainText(f.id))}: ${sanitizePlainText(f.title)}${msBadge}${ownerBadge}${fulfillsBadge}`,
                innerWidth,
              ),
            );
          }
          if (goal.features.length > previewFeats.length && body.length < maxInner - minRosterAndBoardReserve) {
            const hidden = goal.features.length - previewFeats.length;
            body.push(
              fitLine(
                this.theme.fg("dim", `  … +${hidden} more feature${hidden === 1 ? "" : "s"}`),
                innerWidth,
              ),
            );
          }
        } else if (itemSlotBudget > 0 && goal.assertions.length > 0) {
          for (const a of goal.assertions.slice(0, itemSlotBudget)) {
            const glyph = formatAssertionStatusGlyph(a.status, this.theme);
            const ovrBadge = a.overridden
              ? ` ${this.theme.fg("warning", "[OVERRIDE]")}`
              : "";
            const ovrJust =
              a.overridden && a.overrideJustification
                ? ` ${this.theme.fg("dim", `— ${sanitizePlainText(a.overrideJustification)}`)}`
                : "";
            body.push(
              fitLine(
                `  ${glyph} ${this.theme.bold(sanitizePlainText(a.id))}${ovrBadge}: ${sanitizePlainText(a.title)}${ovrJust}`,
                innerWidth,
              ),
            );
          }
        }
      }
    }

    // Full Roster table (Name | Role | State | Model | Workspace | Turns | Activity)
    body.push(
      renderHorizontalRule(
        innerWidth,
        `Roster (${fleetSummaryPlain} · ${members.length} total)`,
        this.theme,
      ),
    );

    if (members.length === 0) {
      body.push(
        fitLine(this.theme.fg("dim", "  (no members spawned yet)"), innerWidth),
      );
    } else {
      const hasMerged = mergedCount > 0;
      const columns: TableColumn<SwarmMemberRecord>[] = [
        {
          key: "name",
          header: "Name",
          minWidth: 11,
          maxWidth: 18,
          priority: 100,
          render: (m) => {
            const icon =
              m.state === "working"
                ? this.theme.fg("accent", SPINNER_FRAMES[this.spinnerFrame]!)
                : m.error
                  ? this.theme.fg("error", "✗")
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
          minWidth: 12,
          maxWidth: 26,
          flex: 1,
          priority: 75,
          render: (m) => {
            if (!m.model) return this.theme.fg("dim", "default");
            const suffix = m.thinkingLevel ? `:${m.thinkingLevel}` : "";
            const nameBudget = Math.max(8, 22 - suffix.length);
            return this.theme.fg("muted", `${shortenModelName(m.model, nameBudget)}${suffix}`);
          },
        },
        {
          key: "workspace",
          header: "Workspace",
          minWidth: hasMerged ? 16 : 9,
          maxWidth: 18,
          flex: 0,
          priority: 65,
          render: (m) => {
            const mergedBadge = formatMergedBadge(m.mergedCommitSha, this.theme);
            if (mergedBadge) {
              return mergedBadge;
            }
            return formatWorkspaceBadge(m.workspace, m.branch, this.theme);
          },
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
          minWidth: 14,
          maxWidth: 36,
          flex: 2,
          priority: 45,
          render: (m) => {
            const text =
              m.error ||
              m.currentActivity ||
              m.parkedOn ||
              (m.lastTool ? `tool:${m.lastTool}` : m.state);
            return this.theme.fg(m.error ? "error" : "dim", sanitizePlainText(text));
          },
        },
      ];

      const minBoardLines = recentBoard.length > 0 ? 2 : 0; // rule + at least 1 newest post
      const desiredBoardLines =
        recentBoard.length > 0
          ? Math.min(
              recentBoard.length + 1,
              termRows <= 20 ? 3 : this.maxRecentBoard + 1,
            )
          : 0;
      const availableAfterHeader = Math.max(0, maxInner - body.length);
      const fullTableLines = 2 + members.length;
      const boardReserve =
        recentBoard.length === 0
          ? 0
          : fullTableLines + desiredBoardLines <= availableAfterHeader
            ? desiredBoardLines
            : Math.max(
                minBoardLines,
                Math.min(
                  desiredBoardLines,
                  availableAfterHeader - Math.min(fullTableLines, 4),
                ),
              );
      const tableLineBudget = Math.max(3, availableAfterHeader - boardReserve);
      const dataSlots = Math.max(1, tableLineBudget - 2);
      // Only show "… +N more rows" when hiddenCount >= 2 (never spend a line on "… +1 more row" when that row fits directly)
      let maxRosterRows: number;
      if (members.length <= dataSlots) {
        maxRosterRows = members.length;
      } else if (dataSlots >= 2) {
        maxRosterRows = dataSlots - 1;
      } else {
        maxRosterRows = 1;
      }
      const tableLines = renderTable(members, columns, innerWidth, {
        header: true,
        theme: this.theme,
        maxRows: maxRosterRows,
        columnGap: innerWidth < 60 || (innerWidth >= 88 && innerWidth < 104) ? 1 : 2,
      });
      // Guard against dataSlots === 1 with members.length === 2 producing an unwanted "+1 more row"
      if (tableLines.length > tableLineBudget) {
        body.push(...tableLines.slice(0, tableLineBudget));
      } else {
        body.push(...tableLines);
      }
    }

    // Recent Board messages (#seq) — always keep the newest posts within remaining budget
    if (recentBoard.length > 0 && body.length <= maxInner - 2) {
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
    const standbyFooter =
      isTerminalRunStatus(run.status) && Boolean(this.state.orchestratorStandby);
    const footer = this.theme.fg(
      "dim",
      standbyFooter
        ? innerWidth >= 82
          ? "Alt+W collapse · Alt+S panel · Alt+M models · /swarm exit leave standby"
          : innerWidth >= 46
            ? "Alt+W collapse · Alt+S panel · /swarm exit"
            : "Alt+W · Alt+S · /swarm exit"
        : innerWidth >= 82
          ? "Alt+W collapse · Alt+S panel · Alt+M models · /swarm board · /swarm graph"
          : "Alt+W collapse · Alt+S panel · Alt+M models",
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
      if (this.state.draftActive) {
        return this.renderDraftBanner(targetWidth);
      }
      if (this.state.orchestratorStandby) {
        return this.renderStandbyBanner(targetWidth);
      }
      return [];
    }

    const workingMembers = getWorkingMembers(snapshot, run);
    const waitingMembers = getWaitingMembers(snapshot, run);
    const stoppedMembers = getStoppedMembers(run);
    const isTerminal = isTerminalRunStatus(run.status);
    this.syncSpinnerTimer(!isTerminal && workingMembers.length > 0);

    const nowMs = this.now();

    if (this.state.expanded) {
      return this.renderExpanded(
        snapshot,
        run,
        workingMembers,
        waitingMembers,
        stoppedMembers,
        targetWidth,
        nowMs,
      );
    }
    if (isTerminal) {
      return this.renderCompletedCompact(snapshot, run, targetWidth);
    }
    return this.renderCompact(
      snapshot,
      run,
      workingMembers,
      waitingMembers,
      stoppedMembers,
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
  draftActiveOrState: boolean | FormatStatusLineOptions = false,
  orchestratorStandby = false,
): string | undefined {
  const draftActive =
    typeof draftActiveOrState === "boolean"
      ? draftActiveOrState
      : Boolean(draftActiveOrState?.draftActive);
  const standby =
    typeof draftActiveOrState === "boolean"
      ? Boolean(orchestratorStandby)
      : Boolean(draftActiveOrState?.orchestratorStandby ?? orchestratorStandby);

  const run = snapshot.run;
  if (!run) {
    if (draftActive) {
      return "🐝 swarm:draft";
    }
    if (standby) {
      return `🐝 swarm:standby · @${ORCHESTRATOR_NAME} standby (/swarm exit)`;
    }
    return undefined;
  }

  const workingMembers = getWorkingMembers(snapshot, run);
  const waitingMembers = getWaitingMembers(snapshot, run);
  const stoppedMembers = getStoppedMembers(run);
  const workingCount = getWorkingCount(snapshot, run, workingMembers);
  const waitingCount = getWaitingCount(snapshot, run, waitingMembers);
  const stoppedCount = stoppedMembers.length;
  const mergedCount = countMergedMembers(run);

  const statusLabel = formatRunStatusBadge(run.status);
  const leadTokens: string[] = [`🐝 swarm:${statusLabel}`];
  if (snapshot.boardHead > 0) {
    leadTokens.push(`#${snapshot.boardHead}`);
  }

  const parts: string[] = [
    leadTokens.join(" "),
    formatFleetSummary(workingCount, waitingCount, stoppedCount, mergedCount),
  ];
  const goal = summarizeGoalProgress(run);
  if (goal.hasCompactBadges) {
    parts.push(
      formatCompactGoalBadges(goal, {
        includeBar: false,
        includeSealed: false,
      }),
    );
  }
  if (run.status === "active" && workingCount === 0 && waitingCount > 0) {
    parts.push(`⏳ awaiting @${ORCHESTRATOR_NAME}`);
  }
  if (snapshot.totalTokens > 0) {
    parts.push(`${formatTokens(snapshot.totalTokens)} tok`);
  }
  if (draftActive && run.status !== "active") {
    parts.push("draft");
  } else if (standby && isTerminalRunStatus(run.status)) {
    parts.push(`@${ORCHESTRATOR_NAME} standby (/swarm exit)`);
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
    if (options?.orchestratorStandby) {
      return [
        `### 🐝 Persistent Orchestrator Standby (\`@${ORCHESTRATOR_NAME}\`)`,
        "",
        `- **Mode:** Persistent Orchestrator Standby — \`@${ORCHESTRATOR_NAME}\` remains on duty for follow-up tasks.`,
        "- **Exit:** Run `/swarm exit` (or open `/swarm` -> `Exit Swarm Orchestrator Mode`) to return to direct-edit mode.",
      ].join("\n");
    }
    return "No active Swarm run. Start one with `/swarm <idea>` or `/swarm direct <objective>`.";
  }

  const members = getSortedMembers(run);
  const workingMembers = getWorkingMembers(snapshot, run);
  const waitingMembers = getWaitingMembers(snapshot, run);
  const stoppedMembers = getStoppedMembers(run);
  const workingCount = getWorkingCount(snapshot, run, workingMembers);
  const waitingCount = getWaitingCount(snapshot, run, waitingMembers);
  const stoppedCount = stoppedMembers.length;
  const mergedCount = countMergedMembers(run);
  const fleetSummary = formatFleetSummary(
    workingCount,
    waitingCount,
    stoppedCount,
    mergedCount,
  );
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
  const phaseProgress = formatPhaseMilestones(run);
  if (phaseProgress) {
    out.push(`- **${phaseProgress.replace(/^([^:]+):/, "$1:**")}`);
  }
  if (run.strategy) {
    out.push(`- **Strategy:** ${sanitizePlainText(run.strategy)}`);
  }
  if (run.acceptanceCriteria) {
    out.push(
      `- **Acceptance Criteria:** ${sanitizePlainText(run.acceptanceCriteria)}`,
    );
  }
  out.push(
    `- **Base Branch:** \`${sanitizePlainText(run.baseBranch)}\` · **Roster:** ${fleetSummary} / ${members.length} total (max ${run.maxConcurrency}) · **Board:** #${snapshot.boardHead}`,
  );
  out.push(
    `- **Validator Policy:** ${run.validatorEnabled ? "ON" : "OFF"} · **Keep Warm:** ${run.keepWorkersWarm ? "ON" : "OFF"} · **Usage:** ${formatTokens(snapshot.totalTokens)} tokens (${formatCost(snapshot.totalCost)})`,
  );
  out.push(
    `- **Shared Library:** \`.pi/swarm/runs/${sanitizePlainText(run.id)}/library/\` _(shared mission knowledge base)_`,
  );
  if (run.status === "active" && workingCount === 0 && waitingCount > 0) {
    out.push(
      `- **Status:** ⏳ 0 working — awaiting @${ORCHESTRATOR_NAME} next step`,
    );
  } else if (isTerminalRunStatus(run.status) && options?.orchestratorStandby) {
    out.push(
      `- **Orchestrator Mode:** Persistent Orchestrator Standby (\`@${ORCHESTRATOR_NAME}\` on duty — run \`/swarm exit\` to leave)`,
    );
  }

  if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > nowMs) {
    const rem = formatDuration(snapshot.rateLimitUntil - nowMs);
    const reason = snapshot.rateLimitReason
      ? ` (${sanitizePlainText(snapshot.rateLimitReason)})`
      : "";
    out.push(`- **Rate-Limit Backoff:** ${rem} remaining${reason}`);
  }

  const goal = summarizeGoalProgress(run);
  if (goal.hasExpandedSection) {
    const goalSegments: string[] = [];
    if (goal.features.length > 0) {
      goalSegments.push(`Features ${goal.featDone}/${goal.featTotal} completed`);
    }
    if (goal.assertions.length > 0) {
      const ovrSuffix =
        goal.valOverridden > 0
          ? ` (${goal.valOverridden} ovr \`[OVERRIDE]\`)`
          : "";
      goalSegments.push(
        `Validation Contract ${goal.valPassed}/${goal.valTotal} \`VAL-*\` passed${ovrSuffix}`,
      );
    }
    if (goal.sealedMilestoneLabels.length > 0) {
      goalSegments.push(
        `Sealed: ${goal.sealedMilestoneLabels.map((m) => `\`${escapeMdCell(m)}\` \`[S]\``).join(", ")}`,
      );
    }
    if (goal.openDebtItems.length > 0) {
      goalSegments.push(`Open Debt: !${goal.openDebtItems.length}`);
    }
    if (goalSegments.length > 0) {
      out.push(`- **Goal Progress:** ${goalSegments.join(" · ")}`);
    }
  }
  if (run.lastAudit) {
    const auditorPart = run.lastAudit.auditor
      ? ` by \`@${escapeMdCell(run.lastAudit.auditor)}\``
      : "";
    out.push(
      `- **Last Audit:** \`${escapeMdCell(run.lastAudit.verdict)}\`${auditorPart} — ${sanitizePlainText(run.lastAudit.summary)}`,
    );
  }

  const sealedMilestoneSet = new Set(goal.sealedMilestoneLabels);

  // Mission Features Table
  if (run.features && run.features.length > 0) {
    out.push("");
    out.push(
      `#### Mission Features (${goal.featDone}/${goal.featTotal} completed)`,
    );
    out.push("| ID | Milestone | Status | Assigned | Fulfills |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const f of run.features) {
      const idCell = f.title
        ? `\`${escapeMdCell(f.id)}\` — ${escapeMdCell(f.title)}`
        : `\`${escapeMdCell(f.id)}\``;
      const msClean = sanitizePlainText(f.milestone);
      const msCell = msClean
        ? `${escapeMdCell(msClean)}${sealedMilestoneSet.has(msClean) ? " `[S]`" : ""}`
        : "—";
      const shaSuffix = f.mergedCommitSha
        ? ` (\`${escapeMdCell(f.mergedCommitSha.slice(0, 7))}\`)`
        : "";
      const statusCell = `${formatFeatureStatusGlyph(f.status)} \`${escapeMdCell(f.status)}\`${shaSuffix}`;
      const assignedCell = f.assignedMember
        ? `\`@${escapeMdCell(f.assignedMember)}\``
        : "—";
      const fulfillsCell =
        f.fulfills.length > 0
          ? f.fulfills.map((v) => `\`${escapeMdCell(v)}\``).join(", ")
          : "—";
      out.push(
        `| ${idCell} | ${msCell} | ${statusCell} | ${assignedCell} | ${fulfillsCell} |`,
      );
    }
  }

  // Validation Contract (VAL-*) Table
  if (run.assertions && run.assertions.length > 0) {
    out.push("");
    const ovrHeaderSuffix =
      goal.valOverridden > 0 ? ` · ${goal.valOverridden} [OVERRIDE]` : "";
    out.push(
      `#### Validation Contract (${goal.valPassed}/${goal.valTotal} passed${ovrHeaderSuffix})`,
    );
    out.push("| ID | Status | Verified By | Title / Evidence |");
    out.push("| --- | --- | --- | --- |");
    for (const a of run.assertions) {
      const overrideBadge = a.overridden ? " `[OVERRIDE]`" : "";
      const statusCell = `${formatAssertionStatusGlyph(a.status)} \`${escapeMdCell(a.status)}\`${overrideBadge}`;
      const verifiedCell = a.verifiedBy
        ? `\`@${escapeMdCell(a.verifiedBy)}\`${a.verifiedByRole ? ` (${escapeMdCell(a.verifiedByRole)})` : ""}`
        : "—";
      const evidenceSuffix = a.evidence
        ? ` — _${escapeMdCell(a.evidence)}_`
        : a.evidenceRequired
           ? ` _(req: ${escapeMdCell(a.evidenceRequired)})_`
           : "";
      const overrideJustSuffix = a.overrideJustification
        ? ` — **Override:** ${escapeMdCell(a.overrideJustification)}`
        : a.overridden
          ? " — **Override:** _(no justification recorded)_"
          : "";
      const titleEvidenceCell = `${escapeMdCell(a.title)}${evidenceSuffix}${overrideJustSuffix}`;
      out.push(
        `| \`${escapeMdCell(a.id)}\` | ${statusCell} | ${verifiedCell} | ${titleEvidenceCell} |`,
      );
    }
  }

  // Open Handoff Tech-Debt
  if (run.handoffItems && run.handoffItems.length > 0) {
    out.push("");
    const openCount = goal.openHandoffs.length;
    out.push(
      `#### Open Handoff Tech-Debt (${openCount} open / ${run.handoffItems.length} total)`,
    );
    const orderedHandoffs = [
      ...run.handoffItems.filter((h) => h.resolution === "open"),
      ...run.handoffItems.filter((h) => h.resolution !== "open"),
    ];
    out.push("| ID | Type | Source | Resolution | Summary |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const h of orderedHandoffs) {
      const srcFeat = h.sourceFeatureId
        ? ` (\`${escapeMdCell(h.sourceFeatureId)}\`)`
        : "";
      const sourceCell = `\`@${escapeMdCell(h.sourceMember)}\`${srcFeat}`;
      const tracked = h.trackedFeatureId
        ? ` -> \`${escapeMdCell(h.trackedFeatureId)}\``
        : "";
      const resCell = `\`${escapeMdCell(h.resolution)}\`${tracked}`;
      const justSuffix = h.justification
        ? ` _(${escapeMdCell(h.justification)})_`
        : "";
      out.push(
        `| \`${escapeMdCell(h.id)}\` | \`${escapeMdCell(h.type)}\` | ${sourceCell} | ${resCell} | ${escapeMdCell(h.summary)}${justSuffix} |`,
      );
    }
  }

  // Mission Services & Ports
  if (run.services && run.services.length > 0) {
    out.push("");
    out.push(`#### Mission Services & Ports (${run.services.length})`);
    out.push("| Service | Port | Start | Healthcheck | Depends On |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const svc of run.services) {
      const portNum =
        typeof svc.port === "number" && Number.isFinite(svc.port)
          ? Math.floor(svc.port)
          : undefined;
      const portCell = portNum !== undefined ? `\`:${portNum}\`` : "—";
      const stopNote = svc.stop ? ` _(stop: \`${escapeMdCell(svc.stop)}\`)_` : "";
      const startCell = `\`${escapeMdCell(svc.start)}\`${stopNote}`;
      const healthCell = svc.healthcheck
        ? `\`${escapeMdCell(svc.healthcheck)}\``
        : "—";
      const depsCell =
        svc.dependsOn && svc.dependsOn.length > 0
          ? svc.dependsOn.map((d) => `\`${escapeMdCell(d)}\``).join(", ")
          : "—";
      out.push(
        `| \`${escapeMdCell(svc.name)}\` | ${portCell} | ${startCell} | ${healthCell} | ${depsCell} |`,
      );
    }
  }

  // Commands & Boundaries
  const hasCommands = Boolean(run.commands && run.commands.length > 0);
  const hasBoundaries = Boolean(run.boundaries && run.boundaries.length > 0);
  if (hasCommands || hasBoundaries) {
    out.push("");
    out.push("#### Commands & Boundaries");
    if (hasCommands && run.commands) {
      out.push("| Command | Shell |");
      out.push("| --- | --- |");
      for (const cmd of run.commands) {
        out.push(
          `| \`${escapeMdCell(cmd.name)}\` | \`${escapeMdCell(cmd.command)}\` |`,
        );
      }
    }
    if (hasBoundaries && run.boundaries) {
      for (const b of run.boundaries) {
        out.push(`- **Boundary:** ${sanitizePlainText(b)}`);
      }
    }
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
    `#### Roster (${fleetSummary} / ${members.length} total)`,
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
      const wsBase = `\`${escapeMdCell(formatWorkspaceBadge(m.workspace, m.branch))}\``;
      const mergedBadge = formatMergedBadge(m.mergedCommitSha);
      const wsCol = mergedBadge ? `${wsBase} ${escapeMdCell(mergedBadge)}` : wsBase;
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
        const clock = formatLocalClock(msg.timestamp);
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
      const clock = formatLocalClock(ev.timestamp);
      const memberTag = ev.memberName ? ` [\`${ev.memberName}\`]` : "";
      const chTag = ev.channel ? ` [#${ev.channel}]` : "";
      out.push(
        `- \`${clock}\`${memberTag}${chTag} **${ev.type}**: ${sanitizePlainText(ev.summary)}`,
      );
    }
  }

  return out.join("\n");
}

/** Alias for `/swarm status` zero-turn Markdown formatter. */
export const formatZeroTurnStatusView = formatZeroTurnStatusDashboard;

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
    const clock = formatLocalClock(msg.timestamp);
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
        const mergedBadge = formatMergedBadge(m.mergedCommitSha);
        const wsCell = mergedBadge
          ? `\`${escapeMdCell(ws)}\` ${escapeMdCell(mergedBadge)}`
          : `\`${escapeMdCell(ws)}\``;
        out.push(
          `| \`${escapeMdCell(m.name)}\` | ${formatMemberRoleBadge(m.role)} | ${escapeMdCell(formatMemberStateBadge(m.state))} | \`${escapeMdCell(liveModel)}\` | \`${escapeMdCell(thinking)}\` | ${wsCell} | ${m.turns} |`,
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
// Global Terminal Input Shortcut Bindings (Pi 1.6.0 Safe No-Op)
// ============================================================================

/**
 * Retained for API compatibility.
 *
 * Pi 1.6.0 routes `Alt+S`, `Alt+M`, and `Alt+W` cleanly at editor focus via
 * `pi.registerShortcut(...)` in `src/index.ts`. Hooking raw
 * `ctx.ui.onTerminalInput` intercepts keys before Pi's native dialogs
 * (`/model`, `/settings`, `/tree`, `/hotkeys`) and swallows `Esc` inside them,
 * so this binder intentionally does not attach a global terminal listener.
 */
export function bindSwarmShortcuts(
  _ctx: ExtensionContext,
  _callbacks: SwarmShortcutCallbacks,
): () => void {
  return () => {};
}

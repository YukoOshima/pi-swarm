import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { FINAL_AUDIT_MISSION_ID } from "../constants.js";
import type {
  BoardMessage,
  FinalAuditStatus,
  FinalAuditVerdict,
  MissionRecord,
  RosterEntry,
  SwarmDraftMode,
  SwarmEvent,
  SwarmModelRole,
  SwarmRoleModels,
  SwarmRunState,
  SwarmSettings,
  SwarmSnapshot,
} from "../types.js";
import {
  computeActiveFinalAuditRound,
  computeMissionWaves,
  fitLine,
  formatBoardKindBadge,
  formatCost,
  formatDuration,
  formatElapsedSince,
  formatFinalAuditBadge,
  formatMissionKindBadge,
  formatMissionStatusBadge,
  formatReviewBadge,
  formatRoleModelsLine,
  formatRosterRoleBadge,
  formatRosterStatusBadge,
  formatRunStatusBadge,
  formatTokens,
  joinColumns,
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
  /** Maximum working agents shown in compact mode before "+N more" (default: 3). */
  maxCompactWorkers?: number;
  /** Maximum recent ledger events shown in expanded mode (default: 5). */
  maxRecentEvents?: number;
  /** Maximum recent board messages shown in expanded mode (default: 3). */
  maxRecentBoard?: number;
  /** Optional host session model fallback for 3-role display. */
  hostModel?: string;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

export interface SwarmShortcutCallbacks {
  isModalOpen: () => boolean;
  isExpanded: () => boolean;
  onToggleExpand: () => void;
  onCollapse: () => void;
}

export interface StatusDashboardOptions {
  draftActive?: boolean;
  draftSeed?: string;
  hostModel?: string;
  now?: () => number;
}

export interface BoardViewOptions {
  runId?: string;
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

function getOrderedMissions(run: SwarmRunState): MissionRecord[] {
  const seen = new Set<string>();
  const out: MissionRecord[] = [];
  for (const id of run.missionOrder) {
    const m = run.missions[id];
    if (m) {
      seen.add(id);
      out.push(m);
    }
  }
  for (const m of Object.values(run.missions)) {
    if (!seen.has(m.id)) {
      out.push(m);
    }
  }
  return out;
}

function getEffectiveFinalAuditStatus(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
): FinalAuditStatus {
  return snapshot.finalAuditStatus ?? run.finalAuditStatus ?? "idle";
}

function getEffectiveLatestFinalAudit(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
): FinalAuditVerdict | undefined {
  return snapshot.latestFinalAudit ?? run.latestFinalAudit;
}

function isFinalAuditRunning(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
): boolean {
  return run.status === "verifying" || Boolean(snapshot.finalAuditRunningAgentId);
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

function buildWorkingIdSet(snapshot: SwarmSnapshot): Set<string> {
  const set = new Set<string>(snapshot.workingAgentIds);
  if (snapshot.finalAuditRunningAgentId) {
    set.add(snapshot.finalAuditRunningAgentId);
  }
  return set;
}

function findRunningFinalValidatorEntry(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
): RosterEntry | undefined {
  if (snapshot.finalAuditRunningAgentId) {
    const byId = run.roster[snapshot.finalAuditRunningAgentId];
    if (byId) return byId;
  }
  const workingIds = buildWorkingIdSet(snapshot);
  const entries = Object.values(run.roster)
    .filter(
      (entry) =>
        entry.role === "final-validator" || entry.missionId === FINAL_AUDIT_MISSION_ID,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return entries.find(
    (entry) => entry.status === "working" || workingIds.has(entry.agentId),
  );
}

function getWorkingRosterEntries(snapshot: SwarmSnapshot): RosterEntry[] {
  const run = snapshot.run;
  if (!run) return [];
  const workingIds = buildWorkingIdSet(snapshot);
  return Object.values(run.roster)
    .filter(
      (entry) =>
        entry.status === "working" ||
        (workingIds.has(entry.agentId) &&
          entry.status !== "waiting" &&
          entry.status !== "killed" &&
          entry.status !== "stopped"),
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function getWaitingRosterEntries(snapshot: SwarmSnapshot): RosterEntry[] {
  const run = snapshot.run;
  if (!run) return [];
  const waitingIds = new Set(snapshot.waitingAgentIds);
  const workingIds = buildWorkingIdSet(snapshot);
  return Object.values(run.roster)
    .filter(
      (entry) =>
        entry.status === "waiting" ||
        (waitingIds.has(entry.agentId) &&
          !workingIds.has(entry.agentId) &&
          entry.status !== "working"),
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function getWorkingCount(
  snapshot: SwarmSnapshot,
  workingRoster: readonly RosterEntry[],
): number {
  return Math.max(workingRoster.length, snapshot.workingAgentIds.length);
}

function getWaitingCount(
  snapshot: SwarmSnapshot,
  waitingRoster: readonly RosterEntry[],
): number {
  return Math.max(waitingRoster.length, snapshot.waitingAgentIds.length);
}

function rosterStatusRank(
  entry: RosterEntry,
  workingIds: ReadonlySet<string>,
  waitingIds: ReadonlySet<string>,
): number {
  if (entry.status === "working" || workingIds.has(entry.agentId)) return 0;
  if (entry.status === "waiting" || waitingIds.has(entry.agentId)) return 1;
  if (entry.status === "stopped") return 2;
  if (entry.status === "failed" || entry.status === "died") return 3;
  return 4; // killed
}

function getAllRosterEntries(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
): RosterEntry[] {
  const workingIds = buildWorkingIdSet(snapshot);
  const waitingIds = new Set(snapshot.waitingAgentIds);
  return Object.values(run.roster).sort((a, b) => {
    const rankA = rosterStatusRank(a, workingIds, waitingIds);
    const rankB = rosterStatusRank(b, workingIds, waitingIds);
    if (rankA !== rankB) return rankA - rankB;
    const aFinal = a.role === "final-validator" ? 0 : 1;
    const bFinal = b.role === "final-validator" ? 0 : 1;
    if (rankA === 0 && aFinal !== bFinal) return aFinal - bFinal;
    return b.startedAt.localeCompare(a.startedAt);
  });
}

function countMergedMissions(missions: readonly MissionRecord[]): number {
  let count = 0;
  for (const m of missions) {
    if (m.status === "merged") count++;
  }
  return count;
}

function formatEventClock(timestamp: string): string {
  // ISO 8601: 2026-11-20T17:45:00.000Z -> 17:45:00
  const tIndex = timestamp.indexOf("T");
  if (tIndex >= 0 && timestamp.length >= tIndex + 9) {
    return timestamp.slice(tIndex + 1, tIndex + 9);
  }
  return timestamp.slice(0, 8);
}

function formatScopeCompact(scope: readonly string[]): string {
  if (scope.length === 0) return "—";
  if (scope.length === 1) return scope[0]!;
  return `${scope[0]} +${scope.length - 1}`;
}

function formatBoardMentionsSuffix(mentions: readonly string[]): string {
  if (mentions.length === 0) return "";
  const formatted = mentions
    .map((m) => (m.startsWith("@") ? m : `@${m}`))
    .join(", ");
  return ` -> ${formatted}`;
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
  private readonly maxRecentEvents: number;
  private readonly maxRecentBoard: number;
  private readonly hostModel?: string;
  private readonly now: () => number;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly getSnapshot: () => SwarmSnapshot,
    private readonly state: SwarmWidgetState,
    options?: SwarmWidgetOptions,
  ) {
    this.spinnerIntervalMs = Math.max(40, options?.spinnerIntervalMs ?? 100);
    this.maxCompactWorkers = Math.max(1, options?.maxCompactWorkers ?? 3);
    this.maxRecentEvents = Math.max(1, options?.maxRecentEvents ?? 5);
    this.maxRecentBoard = Math.max(1, options?.maxRecentBoard ?? 3);
    this.hostModel = options?.hostModel;
    this.now = options?.now ?? (() => Date.now());
  }

  private syncSpinnerTimer(hasWorkingAgents: boolean): void {
    if (this.disposed) {
      this.stopTimer();
      return;
    }
    if (hasWorkingAgents && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        if (this.disposed) {
          this.stopTimer();
          return;
        }
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.tui.requestRender();
      }, this.spinnerIntervalMs);
      if (typeof this.spinnerTimer.unref === "function") {
        this.spinnerTimer.unref();
      }
    } else if (!hasWorkingAgents && this.spinnerTimer) {
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
    const seedPart = this.state.draftSeed
      ? ` — ${sanitizePlainText(this.state.draftSeed)}`
      : " — answering questions / refining plan";
    const left = `${this.theme.fg("accent", this.theme.bold(`🐝 ${modeLabel}`))}${this.theme.fg("muted", seedPart)}`;
    const right = this.theme.fg("dim", "/swarm cancel");
    const line =
      width >= 56
        ? joinColumns(left, right, width)
        : fitLine(`${left} · ${right}`, width);
    return [fitLine(line, width)];
  }

  private renderAgentLine(
    entry: RosterEntry,
    width: number,
    nowMs: number,
    options?: { showStatus?: boolean },
  ): string {
    const spinColor = entry.role === "final-validator" ? "borderAccent" : "accent";
    const glyph =
      entry.status === "working"
        ? this.theme.fg(spinColor, SPINNER_FRAMES[this.spinnerFrame]!)
        : entry.status === "waiting"
          ? this.theme.fg("muted", "◌")
          : entry.status === "killed"
            ? this.theme.fg("dim", "⊘")
            : entry.status === "failed" || entry.status === "died"
              ? this.theme.fg("error", "✗")
              : this.theme.fg("warning", "■");

    const missionLabel =
      entry.missionId === FINAL_AUDIT_MISSION_ID ? "FINAL" : entry.missionId;
    const roleLabel = formatRosterRoleBadge(entry.role, this.theme);
    const idAndRole = `${this.theme.bold(missionLabel)} (${roleLabel})`;
    const statusPart = options?.showStatus
      ? ` ${formatRosterStatusBadge(entry.status, this.theme)}`
      : "";
    const modelShort = entry.model ? shortenModelName(entry.model, 18) : "";
    const modelPart =
      modelShort && width >= 66
        ? ` ${this.theme.fg("dim", `[${modelShort}]`)}`
        : "";
    const activityRaw =
      entry.status === "waiting"
        ? entry.currentActivity || `waiting warm (turns:${entry.turns})`
        : entry.currentActivity ||
          (entry.lastTool ? `tool:${entry.lastTool}` : entry.status);
    const activity = this.theme.fg("muted", sanitizePlainText(activityRaw));
    const elapsed = this.theme.fg(
      "dim",
      entry.endedAt
        ? formatDuration(
            Math.max(0, Date.parse(entry.endedAt) - Date.parse(entry.startedAt)),
          )
        : formatElapsedSince(entry.startedAt, nowMs),
    );

    if (width < 52) {
      return fitLine(`  ${glyph} ${idAndRole}${statusPart} ${elapsed}`, width);
    }

    return fitLine(
      joinColumns(
        `  ${glyph} ${idAndRole}${statusPart}${modelPart} ${activity}`,
        elapsed,
        width,
      ),
      width,
    );
  }

  private renderVerifyingSpinnerLine(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    width: number,
    nowMs: number,
  ): string {
    const validator = findRunningFinalValidatorEntry(snapshot, run);
    const auditStatus = getEffectiveFinalAuditStatus(snapshot, run);
    const latestAudit = getEffectiveLatestFinalAudit(snapshot, run);
    const round = computeActiveFinalAuditRound(
      auditStatus,
      run.finalAuditRound,
      latestAudit,
      true,
    );
    const maxRounds = Math.max(1, run.maxFinalAuditRounds || 1);
    const spin = this.theme.fg(
      "borderAccent",
      SPINNER_FRAMES[this.spinnerFrame]!,
    );
    const activityRaw =
      validator?.currentActivity ||
      (validator?.lastTool
        ? `tool:${validator.lastTool}`
        : "auditing final integration");
    const header = `${this.theme.fg("borderAccent", this.theme.bold(`🔍 Final Validator (round ${round}/${maxRounds})`))} · base:${this.theme.fg("accent", run.baseBranch)} · ${this.theme.fg("muted", sanitizePlainText(activityRaw))}`;

    if (validator && width >= 72) {
      const elapsed = this.theme.fg(
        "dim",
        formatElapsedSince(validator.startedAt, nowMs),
      );
      return fitLine(joinColumns(`  ${spin} ${header}`, elapsed, width), width);
    }

    return fitLine(`  ${spin} ${header}`, width);
  }

  private renderFinalValidationLine(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    width: number,
  ): string {
    const enabledPill = run.finalValidatorEnabled
      ? this.theme.fg("success", "ON")
      : this.theme.fg("muted", "OFF");
    const auditStatus = getEffectiveFinalAuditStatus(snapshot, run);
    const latestAudit = getEffectiveLatestFinalAudit(snapshot, run);
    const maxRounds = Math.max(1, run.maxFinalAuditRounds || 1);
    const round = computeActiveFinalAuditRound(
      auditStatus,
      run.finalAuditRound,
      latestAudit,
      auditStatus === "running",
    );
    const badge = formatFinalAuditBadge(auditStatus, round, maxRounds, this.theme);

    const parts: string[] = [
      `${this.theme.fg("muted", "Final Validation:")} ${enabledPill}`,
      badge,
    ];
    if (round === 0 && run.finalValidatorEnabled) {
      parts.push(this.theme.fg("dim", `round 0/${maxRounds}`));
    }
    if (latestAudit) {
      const totalChecks = latestAudit.checks.length;
      const passedChecks = latestAudit.checks.filter((c) => c.passed).length;
      const findingsCount = latestAudit.findings.length;
      if (totalChecks > 0) {
        const checksColor = passedChecks === totalChecks ? "success" : "warning";
        parts.push(
          this.theme.fg(checksColor, `checks ${passedChecks}/${totalChecks}`),
        );
      }
      const findingsColor = findingsCount > 0 ? "error" : "success";
      parts.push(
        this.theme.fg(
          findingsColor,
          `${findingsCount} finding${findingsCount === 1 ? "" : "s"}`,
        ),
      );
    } else if (auditStatus === "skipped" && run.finalAuditSkipReason) {
      parts.push(this.theme.fg("dim", sanitizePlainText(run.finalAuditSkipReason)));
    }

    return fitLine(parts.join(" · "), width);
  }

  private renderBoardPreviewLine(msg: BoardMessage, width: number): string {
    const seqStr = this.theme.fg("accent", `#${msg.seq}`);
    const fromStr = this.theme.bold(sanitizePlainText(msg.from));
    const textStr = this.theme.fg("muted", sanitizePlainText(msg.text));
    return fitLine(`  💬 ${seqStr} ${fromStr}: ${textStr}`, width);
  }

  private renderAttentionLines(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    missions: readonly MissionRecord[],
    width: number,
    nowMs: number,
  ): string[] {
    const out: string[] = [];

    const auditStatus = getEffectiveFinalAuditStatus(snapshot, run);
    if (auditStatus === "disapproved") {
      const latestAudit = getEffectiveLatestFinalAudit(snapshot, run);
      const findingsCount = latestAudit?.findings.length ?? 0;
      const findingsText = `${findingsCount} finding${findingsCount === 1 ? "" : "s"}`;
      out.push(
        fitLine(
          this.theme.fg(
            "error",
            `  ⚠ Final Validator disapproved (${findingsText}) — /swarm verify | /swarm verify --skip | add fix mission`,
          ),
          width,
        ),
      );
    }

    if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > nowMs) {
      const rem = formatDuration(snapshot.rateLimitUntil - nowMs);
      const reason = snapshot.rateLimitReason
        ? ` — ${sanitizePlainText(snapshot.rateLimitReason)}`
        : "";
      out.push(
        fitLine(
          this.theme.fg("warning", `  ⏳ Rate-limit backoff (${rem})${reason}`),
          width,
        ),
      );
    }

    if (snapshot.pendingArtifactApprovals.length > 0) {
      const ids = snapshot.pendingArtifactApprovals.join(", ");
      const hint =
        snapshot.pendingArtifactApprovals.length === 1
          ? `/swarm approve ${snapshot.pendingArtifactApprovals[0]}`
          : "/swarm approve <id>";
      out.push(
        fitLine(
          this.theme.fg(
            "warning",
            `  ⚠ Awaiting sign-off: ${ids} · run ${hint}`,
          ),
          width,
        ),
      );
    }

    const failedOrStopped = missions
      .filter((m) => m.status === "failed" || (m.status === "stopped" && m.humanStopped))
      .map((m) => m.id);
    if (failedOrStopped.length > 0) {
      out.push(
        fitLine(
          this.theme.fg(
            "error",
            `  ⚠ Needs attention: ${failedOrStopped.join(", ")} · /swarm tasks`,
          ),
          width,
        ),
      );
    } else if (
      snapshot.readyToMerge.length > 0 &&
      snapshot.pendingArtifactApprovals.length === 0
    ) {
      out.push(
        fitLine(
          this.theme.fg(
            "success",
            `  ✓ Ready to merge: ${snapshot.readyToMerge.join(", ")}`,
          ),
          width,
        ),
      );
    }

    return out;
  }

  private renderCompact(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    missions: readonly MissionRecord[],
    workingRoster: readonly RosterEntry[],
    waitingRoster: readonly RosterEntry[],
    width: number,
    nowMs: number,
  ): string[] {
    const lines: string[] = [];

    if (this.state.draftActive) {
      lines.push(...this.renderDraftBanner(width));
    }

    const merged = countMergedMissions(missions);
    const total = missions.length;
    const workingCount = getWorkingCount(snapshot, workingRoster);
    const waitingCount = getWaitingCount(snapshot, waitingRoster);
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const objSnippet = sanitizePlainText(run.objective);
    const boardTag = this.theme.fg("accent", `board:#${snapshot.boardHead}`);
    const roleModels = resolveEffectiveRoleModels(snapshot, run);

    const valPill = run.validatorEnabled
      ? this.theme.fg("success", "val:ON")
      : this.theme.fg("muted", "val:OFF");
    const slotsPill = this.theme.fg(
      "accent",
      `${workingCount}/${snapshot.maxConcurrency}`,
    );
    const usagePill = this.theme.fg(
      "muted",
      `${formatTokens(snapshot.totalTokens)} · ${formatCost(snapshot.totalCost)}`,
    );

    if (width < 58) {
      const compactHeader = `${this.theme.fg("accent", this.theme.bold("🐝 Swarm"))} [${statusBadge}] ${merged}/${total} · ${boardTag}`;
      lines.push(fitLine(compactHeader, width));
      const modelsPill = formatRoleModelsLine(roleModels, this.hostModel ?? "default", {
        maxWidth: Math.max(1, width - 2),
        theme: this.theme,
        includeThinking: false,
      });
      lines.push(fitLine(`  ${modelsPill}`, width));
    } else if (width < 100) {
      const left = `${this.theme.fg("accent", this.theme.bold("🐝 Swarm"))} [${statusBadge}] ${objSnippet}`;
      const right = `${merged}/${total} merged · ${boardTag}`;
      lines.push(fitLine(joinColumns(left, right, width), width));

      const rightMeta = `${slotsPill} · ${valPill} · ${usagePill}`;
      const modelsBudget = Math.max(12, width - visibleWidth(rightMeta) - 4);
      const modelsPill = formatRoleModelsLine(roleModels, this.hostModel ?? "default", {
        maxWidth: modelsBudget,
        theme: this.theme,
        includeThinking: false,
      });
      lines.push(fitLine(joinColumns(`  ${modelsPill}`, rightMeta, width), width));
    } else {
      const left = `${this.theme.fg("accent", this.theme.bold("🐝 Swarm"))} [${statusBadge}] ${objSnippet}`;
      const right = `base:${this.theme.fg("accent", run.baseBranch)} · ${merged}/${total} merged · ${boardTag} · ${slotsPill} · ${valPill} · ${this.theme.fg("muted", `${formatTokens(snapshot.totalTokens)} ${formatCost(snapshot.totalCost)}`)}`;
      lines.push(fitLine(joinColumns(left, right, width), width));

      const shortcuts = this.theme.fg(
        "dim",
        "[Ctrl+Shift+T expand · /swarm tasks · /swarm board]",
      );
      const modelsBudget = Math.max(16, width - visibleWidth(shortcuts) - 4);
      const modelsPill = formatRoleModelsLine(roleModels, this.hostModel ?? "default", {
        maxWidth: modelsBudget,
        theme: this.theme,
        includeThinking: false,
      });
      lines.push(fitLine(joinColumns(`  ${modelsPill}`, shortcuts, width), width));
    }

    // Active Final Validator spinner line
    const verifying = isFinalAuditRunning(snapshot, run);
    const runningFinalValidator = verifying
      ? findRunningFinalValidatorEntry(snapshot, run)
      : undefined;
    if (verifying) {
      lines.push(this.renderVerifyingSpinnerLine(snapshot, run, width, nowMs));
    }

    // Working agents (max 3 + "+N more"), excluding final-validator already shown above
    const remainingWorking = runningFinalValidator
      ? workingRoster.filter((entry) => entry.agentId !== runningFinalValidator.agentId)
      : workingRoster;
    const visibleWorkers = remainingWorking.slice(0, this.maxCompactWorkers);
    for (const entry of visibleWorkers) {
      lines.push(this.renderAgentLine(entry, width, nowMs));
    }
    if (remainingWorking.length > visibleWorkers.length) {
      const extra = remainingWorking.length - visibleWorkers.length;
      lines.push(
        fitLine(
          this.theme.fg(
            "dim",
            `  +${extra} more working agent${extra === 1 ? "" : "s"} · /swarm tasks`,
          ),
          width,
        ),
      );
    }

    // Warm waiting fleet summary line when any warm sessions are parked
    if (waitingCount > 0) {
      const fleetSummary = `  ${this.theme.fg("accent", `${workingCount} working`)} · ${this.theme.fg("muted", `${waitingCount} waiting warm`)}`;
      lines.push(fitLine(fleetSummary, width));
    }

    // Latest board post preview
    if (snapshot.recentBoard.length > 0) {
      const latest = snapshot.recentBoard[snapshot.recentBoard.length - 1]!;
      lines.push(this.renderBoardPreviewLine(latest, width));
    }

    // Attention / gate banner (max 2 lines so compact stays tight)
    const attention = this.renderAttentionLines(
      snapshot,
      run,
      missions,
      width,
      nowMs,
    );
    for (const line of attention.slice(0, 2)) {
      lines.push(line);
    }

    // Subtle hint line when completely idle with no active/waiting agents and width < 100
    if (
      !verifying &&
      workingRoster.length === 0 &&
      waitingCount === 0 &&
      snapshot.recentBoard.length === 0 &&
      attention.length === 0 &&
      width >= 44 &&
      width < 100
    ) {
      const hint = `  base:${run.baseBranch} · [Ctrl+Shift+T expand · /swarm tasks · /swarm board]`;
      lines.push(fitLine(this.theme.fg("dim", hint), width));
    }

    return lines.map((l) => fitLine(l, width));
  }

  private renderExpanded(
    snapshot: SwarmSnapshot,
    run: SwarmRunState,
    missions: readonly MissionRecord[],
    workingRoster: readonly RosterEntry[],
    waitingRoster: readonly RosterEntry[],
    width: number,
    nowMs: number,
  ): string[] {
    const termRows = this.tui.terminal?.rows ?? 30;
    const maxTotalLines = Math.max(14, Math.min(36, Math.floor(termRows * 0.78)));
    const innerWidth =
      width < 12 ? Math.max(1, width) : Math.max(1, width - (width < 24 ? 2 : 4));
    const maxInner = Math.max(10, maxTotalLines - 2);

    const body: string[] = [];

    if (this.state.draftActive) {
      body.push(...this.renderDraftBanner(innerWidth));
    }

    const merged = countMergedMissions(missions);
    const total = missions.length;
    const workingCount = getWorkingCount(snapshot, workingRoster);
    const waitingCount = getWaitingCount(snapshot, waitingRoster);
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const valStr = run.validatorEnabled
      ? this.theme.fg("success", "val:ON")
      : this.theme.fg("muted", "val:OFF");
    const roleModels = resolveEffectiveRoleModels(snapshot, run);

    const summaryLeft = `[${statusBadge}] ${sanitizePlainText(run.objective)}`;
    const summaryRight = `base:${run.baseBranch} · ${merged}/${total} merged · board:#${snapshot.boardHead} · ${workingCount}w/${waitingCount}wait · ${valStr} · ${formatTokens(snapshot.totalTokens)} ${formatCost(snapshot.totalCost)}`;
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
    const modelsLine = formatRoleModelsLine(roleModels, this.hostModel ?? "default", {
      maxWidth: modelsBudget,
      theme: this.theme,
    });
    body.push(fitLine(`${modelsPrefix}${modelsLine}`, innerWidth));

    // Final Validation status line
    body.push(this.renderFinalValidationLine(snapshot, run, innerWidth));

    // Mission DAG table
    body.push(renderHorizontalRule(innerWidth, "Missions", this.theme));
    const columns: TableColumn<MissionRecord>[] = [
      {
        key: "id",
        header: "ID",
        minWidth: 4,
        maxWidth: 10,
        priority: 100,
        render: (m) => this.theme.bold(m.id),
      },
      {
        key: "status",
        header: "Status",
        minWidth: 10,
        maxWidth: 14,
        priority: 95,
        render: (m) => formatMissionStatusBadge(m.status, this.theme),
      },
      {
        key: "kind",
        header: "Kind",
        minWidth: 6,
        maxWidth: 10,
        priority: 85,
        render: (m) => formatMissionKindBadge(m.kind, this.theme),
      },
      {
        key: "validation",
        header: "Valid",
        minWidth: 7,
        maxWidth: 14,
        priority: 80,
        render: (m) => formatReviewBadge(m, run.validatorEnabled, this.theme),
      },
      {
        key: "branch",
        header: "Branch",
        minWidth: 12,
        maxWidth: 28,
        flex: 2,
        priority: 65,
        render: (m) => this.theme.fg("muted", m.branch),
      },
      {
        key: "scope",
        header: "Scope",
        minWidth: 10,
        maxWidth: 26,
        flex: 2,
        priority: 50,
        render: (m) => this.theme.fg("dim", formatScopeCompact(m.scope)),
      },
      {
        key: "retries",
        header: "Try",
        minWidth: 3,
        maxWidth: 5,
        align: "right",
        priority: 40,
        render: (m) =>
          m.retryCount > 0
            ? this.theme.fg("warning", String(m.retryCount))
            : this.theme.fg("dim", "0"),
      },
    ];

    const maxMissionRows = Math.max(
      2,
      Math.min(missions.length, Math.floor(maxInner * 0.35)),
    );
    const tableLines = renderTable(missions, columns, innerWidth, {
      header: true,
      theme: this.theme,
      maxRows: maxMissionRows,
      columnGap: innerWidth < 60 ? 1 : 2,
    });
    body.push(...tableLines);

    // Attention lines
    const attention = this.renderAttentionLines(
      snapshot,
      run,
      missions,
      innerWidth,
      nowMs,
    );
    for (const line of attention) {
      if (body.length < maxInner - 5) {
        body.push(line);
      }
    }

    // Live Roster section (working / waiting / stopped / killed + live model)
    const roster = getAllRosterEntries(snapshot, run);
    if (roster.length > 0 && body.length < maxInner - 3) {
      const rosterLabel =
        waitingCount > 0
          ? `Roster (${workingCount} working · ${waitingCount} waiting / ${roster.length} total)`
          : `Roster (${workingCount} working / ${roster.length} total)`;
      body.push(renderHorizontalRule(innerWidth, rosterLabel, this.theme));
      const reserveForBoardAndActivity =
        (snapshot.recentBoard.length > 0 ? 3 : 0) +
        (snapshot.recentEvents.length > 0 ? 2 : 0);
      const rosterBudget = Math.max(
        1,
        Math.min(4, maxInner - body.length - reserveForBoardAndActivity),
      );
      const shownRoster = roster.slice(0, rosterBudget);
      for (const entry of shownRoster) {
        body.push(
          this.renderAgentLine(entry, innerWidth, nowMs, { showStatus: true }),
        );
      }
      if (roster.length > shownRoster.length && body.length < maxInner - 3) {
        body.push(
          fitLine(
            this.theme.fg(
              "dim",
              `  … +${roster.length - shownRoster.length} more roster entries`,
            ),
            innerWidth,
          ),
        );
      }
    }

    // Recent Board section (#seq)
    const recentBoard = snapshot.recentBoard.slice(-this.maxRecentBoard);
    if (recentBoard.length > 0 && body.length < maxInner - 2) {
      body.push(
        renderHorizontalRule(
          innerWidth,
          `Recent Board (#${snapshot.boardHead})`,
          this.theme,
        ),
      );
      const boardReserveForActivity = snapshot.recentEvents.length > 0 ? 2 : 0;
      const boardBudget = Math.max(
        1,
        Math.min(
          recentBoard.length,
          maxInner - body.length - boardReserveForActivity,
        ),
      );
      for (const msg of recentBoard.slice(-boardBudget)) {
        body.push(this.renderBoardPreviewLine(msg, innerWidth));
      }
    }

    // Recent Ledger Activity
    const events = snapshot.recentEvents.slice(-this.maxRecentEvents);
    if (events.length > 0 && body.length < maxInner - 1) {
      body.push(renderHorizontalRule(innerWidth, "Recent Activity", this.theme));
      const remaining = Math.max(1, maxInner - body.length);
      const shownEvents = events.slice(-remaining);
      for (const ev of shownEvents) {
        const ts = this.theme.fg("dim", formatEventClock(ev.timestamp));
        const tag = ev.missionId
          ? this.theme.fg("accent", `[${ev.missionId}] `)
          : "";
        body.push(
          fitLine(`  ${ts} ${tag}${sanitizePlainText(ev.summary)}`, innerWidth),
        );
      }
    }

    const title = this.theme.fg(
      "accent",
      this.theme.bold(`🐝 Swarm Dashboard · ${run.id}`),
    );
    const footer = this.theme.fg(
      "dim",
      "Ctrl+Shift+T / Esc collapse · /swarm tasks · /swarm board · /swarm models",
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

    const missions = getOrderedMissions(run);
    const workingRoster = getWorkingRosterEntries(snapshot);
    const waitingRoster = getWaitingRosterEntries(snapshot);
    this.syncSpinnerTimer(
      workingRoster.length > 0 || isFinalAuditRunning(snapshot, run),
    );

    const nowMs = this.now();

    if (this.state.expanded) {
      return this.renderExpanded(
        snapshot,
        run,
        missions,
        workingRoster,
        waitingRoster,
        targetWidth,
        nowMs,
      );
    }
    return this.renderCompact(
      snapshot,
      run,
      missions,
      workingRoster,
      waitingRoster,
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

  const missions = getOrderedMissions(run);
  const merged = countMergedMissions(missions);
  const workingRoster = getWorkingRosterEntries(snapshot);
  const waitingRoster = getWaitingRosterEntries(snapshot);
  const workingCount = getWorkingCount(snapshot, workingRoster);
  const waitingCount = getWaitingCount(snapshot, waitingRoster);

  const auditStatus = getEffectiveFinalAuditStatus(snapshot, run);
  const latestAudit = getEffectiveLatestFinalAudit(snapshot, run);
  const verifying = isFinalAuditRunning(snapshot, run);

  const leadTokens: string[] = [`🐝 swarm:${run.status}`];
  if (verifying) {
    const round = computeActiveFinalAuditRound(
      auditStatus,
      run.finalAuditRound,
      latestAudit,
      true,
    );
    const maxRounds = Math.max(1, run.maxFinalAuditRounds || 1);
    leadTokens.push(`r${round}/${maxRounds}`);
  } else if (workingCount > 0 || waitingCount > 0) {
    leadTokens.push(`${workingCount}w/${waitingCount}wait`);
  }
  if (snapshot.boardHead > 0) {
    leadTokens.push(`#${snapshot.boardHead}`);
  }

  const parts: string[] = [leadTokens.join(" ")];
  parts.push(`${merged}/${missions.length} merged`);

  if (!verifying) {
    if (auditStatus === "disapproved") {
      const findingsCount = latestAudit?.findings.length ?? 0;
      parts.push(
        findingsCount > 0
          ? `⚠ audit:disapproved (${findingsCount})`
          : "⚠ audit:disapproved",
      );
    } else if (auditStatus === "approved") {
      parts.push("✓ audit:approved");
    } else if (auditStatus === "skipped") {
      parts.push("audit:skipped");
    }
  }

  if (snapshot.pendingArtifactApprovals.length > 0) {
    parts.push(`${snapshot.pendingArtifactApprovals.length} approval`);
  }
  if (snapshot.totalTokens > 0) {
    parts.push(`${formatTokens(snapshot.totalTokens)} tok`);
  }
  if (draftActive) {
    parts.push("draft");
  }

  return parts.join(" · ");
}

// ============================================================================
// Zero-LLM-Turn Markdown Formatters (`/swarm status`, `/swarm board`, `/swarm models`)
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
        `An interactive planning interview is in progress.${seedLine}`,
        "- Continue answering questions in chat or run `/swarm cancel` to discard.",
      ].join("\n");
    }
    return "No active Swarm run. Start one with `/swarm <idea>` or `/swarm direct <objective>`.";
  }

  const missions = getOrderedMissions(run);
  const merged = countMergedMissions(missions);
  const waves = computeMissionWaves(missions);
  const roster = getAllRosterEntries(snapshot, run);
  const workingRoster = getWorkingRosterEntries(snapshot);
  const waitingRoster = getWaitingRosterEntries(snapshot);
  const workingCount = getWorkingCount(snapshot, workingRoster);
  const waitingCount = getWaitingCount(snapshot, waitingRoster);
  const roleModels = resolveEffectiveRoleModels(snapshot, run);
  const hostFallback = options?.hostModel ?? "host default";

  const out: string[] = [];
  out.push(`### 🐝 Swarm Status — \`${run.id}\` (${run.status})`);
  out.push("");
  out.push(`- **Objective:** ${sanitizePlainText(run.objective)}`);
  out.push(
    `- **Base Branch:** \`${run.baseBranch}\` · **Progress:** ${merged}/${missions.length} merged · **Fleet:** ${workingCount} working · ${waitingCount} waiting warm (max ${snapshot.maxConcurrency}) · **Board:** #${snapshot.boardHead}`,
  );
  out.push(
    `- **Validator:** ${run.validatorEnabled ? `ON (max ${run.maxValidationRounds} rounds)` : "OFF"} · **Keep Warm:** ${run.keepWorkersWarm ? "ON" : "OFF"} · **Usage:** ${formatTokens(snapshot.totalTokens)} tokens (${formatCost(snapshot.totalCost)})`,
  );

  if (snapshot.unreadOrchestratorMessages > 0) {
    out.push(
      `- **Unread Orchestrator Messages:** ${snapshot.unreadOrchestratorMessages} message(s)`,
    );
  }
  if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > nowMs) {
    const rem = formatDuration(snapshot.rateLimitUntil - nowMs);
    const reason = snapshot.rateLimitReason
      ? ` (${sanitizePlainText(snapshot.rateLimitReason)})`
      : "";
    out.push(`- **Rate-Limit Backoff:** ${rem} remaining${reason}`);
  }

  // 3-Role Models section
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
    const modelStr = cfg?.model ? `\`${escapeMdCell(cfg.model)}\`` : `_${escapeMdCell(hostFallback)}_`;
    const thinkingStr = cfg?.thinkingLevel ? `\`${cfg.thinkingLevel}\`` : "default";
    out.push(`| ${r.label} | ${modelStr} | ${thinkingStr} |`);
  }
  if (roleModels.fallbackModels && roleModels.fallbackModels.length > 0) {
    out.push(
      `- **Fallback Models:** ${roleModels.fallbackModels.map((m) => `\`${sanitizePlainText(m)}\``).join(", ")}`,
    );
  }

  // Wave-grouped missions table
  out.push("");
  out.push("#### Missions by Wave");
  out.push(
    "| Wave | ID | Kind | Status | Deps | Branch | Scope | Validation | Retries |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | ---: |");

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w] ?? [];
    for (const m of wave) {
      const depsStr = m.deps.length > 0 ? m.deps.join(", ") : "—";
      const scopeStr = m.scope.length > 0 ? m.scope.join(", ") : "—";
      const reviewStr = formatReviewBadge(m, run.validatorEnabled);
      const statusStr = m.humanStopped
        ? `${formatMissionStatusBadge(m.status)} (human)`
        : formatMissionStatusBadge(m.status);
      out.push(
        `| W${w + 1} | \`${escapeMdCell(m.id)}\` | ${m.kind} | ${escapeMdCell(statusStr)} | ${escapeMdCell(depsStr)} | \`${escapeMdCell(m.branch)}\` | ${escapeMdCell(scopeStr)} | ${escapeMdCell(reviewStr)} | ${m.retryCount} |`,
      );
    }
  }

  // Final Verification section
  const auditStatus = getEffectiveFinalAuditStatus(snapshot, run);
  const latestAudit = getEffectiveLatestFinalAudit(snapshot, run);
  const maxAuditRounds = Math.max(1, run.maxFinalAuditRounds || 1);
  const displayAuditRound = computeActiveFinalAuditRound(
    auditStatus,
    run.finalAuditRound,
    latestAudit,
    auditStatus === "running",
  );
  const auditBadge = formatFinalAuditBadge(
    auditStatus,
    displayAuditRound,
    maxAuditRounds,
  );

  out.push("");
  out.push("### Final Verification");
  out.push(
    `- **Enabled:** ${run.finalValidatorEnabled ? `ON (max ${maxAuditRounds} round${maxAuditRounds === 1 ? "" : "s"}, auto-fix: ${run.autoFixOnAuditFail ? "ON" : "OFF"})` : "OFF"} · **Status:** ${auditBadge} · **Round:** ${displayAuditRound}/${maxAuditRounds}`,
  );
  const pinnedSha = latestAudit?.commitSha || run.lastAuditedSha;
  if (pinnedSha) {
    out.push(
      `- **Pinned SHA:** \`${pinnedSha.slice(0, 12)}\` (\`${run.baseBranch}\`)`,
    );
  }
  if (auditStatus === "skipped") {
    const by = run.finalAuditSkippedBy
      ? ` by ${sanitizePlainText(run.finalAuditSkippedBy)}`
      : "";
    const reason = run.finalAuditSkipReason
      ? ` — ${sanitizePlainText(run.finalAuditSkipReason)}`
      : "";
    out.push(`- **Skipped:**${by}${reason || " (manual bypass)"}`);
  }
  if (latestAudit) {
    const totalChecks = latestAudit.checks.length;
    const passedChecks = latestAudit.checks.filter((c) => c.passed).length;
    out.push(
      `- **Checks:** ${passedChecks}/${totalChecks} passed · **Findings:** ${latestAudit.findings.length}`,
    );
    if (latestAudit.summary) {
      out.push(`- **Summary:** ${sanitizePlainText(latestAudit.summary)}`);
    }
    if (latestAudit.findings.length > 0) {
      for (const f of latestAudit.findings.slice(0, 5)) {
        const loc = f.file
          ? ` (\`${f.file}${f.line !== undefined ? `:${f.line}` : ""}\`)`
          : "";
        out.push(
          `  - **[${f.severity}]** ${sanitizePlainText(f.title)}${loc} — ${sanitizePlainText(f.detail)}`,
        );
      }
      if (latestAudit.findings.length > 5) {
        out.push(`  - _… +${latestAudit.findings.length - 5} more finding(s)_`);
      }
    }
    if (
      latestAudit.recommendedMissions &&
      latestAudit.recommendedMissions.length > 0
    ) {
      out.push(
        `- **Recommended Fix Missions:** ${latestAudit.recommendedMissions.map((m) => sanitizePlainText(m.title)).join("; ")}`,
      );
    }
  }
  if (auditStatus === "disapproved") {
    out.push(
      "- **Hints:** Run `/swarm verify` to re-verify after fixes, add a fix mission, or `/swarm verify --skip` to bypass.",
    );
  }

  // Pending gates / human attention
  const failedOrStopped = missions.filter(
    (m) => m.status === "failed" || (m.status === "stopped" && m.humanStopped),
  );
  const hasGates =
    snapshot.pendingReviews.length > 0 ||
    snapshot.pendingArtifactApprovals.length > 0 ||
    snapshot.readyToMerge.length > 0 ||
    failedOrStopped.length > 0;

  if (hasGates) {
    out.push("");
    out.push("#### Pending Gates & Attention");
    if (snapshot.pendingReviews.length > 0) {
      out.push(
        `- **Pending Validations:** ${snapshot.pendingReviews.map((id) => `\`${id}\``).join(", ")}`,
      );
    }
    if (snapshot.pendingArtifactApprovals.length > 0) {
      out.push(
        `- **Pending Artifact Sign-Off:** ${snapshot.pendingArtifactApprovals.map((id) => `\`${id}\``).join(", ")} — run \`/swarm approve <id>\``,
      );
    }
    if (snapshot.readyToMerge.length > 0) {
      out.push(
        `- **Ready to Merge:** ${snapshot.readyToMerge.map((id) => `\`${id}\``).join(", ")}`,
      );
    }
    for (const m of failedOrStopped) {
      const detail = m.error
        ? `: ${sanitizePlainText(m.error)}`
        : m.humanStopped
          ? " (stopped by human — will not auto-restart)"
          : "";
      out.push(`- **${m.status.toUpperCase()} \`${m.id}\`**${detail}`);
    }
  }

  // Live Roster
  out.push("");
  out.push(
    `#### Live Roster (${workingCount} working · ${waitingCount} waiting / ${roster.length} total)`,
  );
  if (roster.length === 0) {
    out.push("_No workers, validators, or final validators spawned yet._");
  } else {
    out.push(
      "| Agent | Role | Mission | Status | Model | Turns | Board | Activity | Usage | Elapsed |",
    );
    out.push(
      "| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: |",
    );
    for (const entry of roster) {
      const activity = entry.currentActivity || entry.lastTool || "—";
      const usage = `${formatTokens(entry.tokens)} / ${formatCost(entry.cost)}`;
      const elapsed = entry.endedAt
        ? formatDuration(
            Math.max(0, Date.parse(entry.endedAt) - Date.parse(entry.startedAt)),
          )
        : formatElapsedSince(entry.startedAt, nowMs);
      const statusText = entry.humanStopped
        ? `${formatRosterStatusBadge(entry.status)} (human)`
        : formatRosterStatusBadge(entry.status);
      const missionCol =
        entry.missionId === FINAL_AUDIT_MISSION_ID ? "FINAL" : entry.missionId;
      const modelCol = entry.model ? `\`${escapeMdCell(entry.model)}\`` : "_default_";
      out.push(
        `| \`${escapeMdCell(entry.name || entry.agentId)}\` | ${entry.role} | \`${escapeMdCell(missionCol)}\` | ${escapeMdCell(statusText)} | ${modelCol} | ${entry.turns} | #${entry.lastReadBoardSeq} | ${escapeMdCell(activity)} | ${escapeMdCell(usage)} | ${elapsed} |`,
      );
    }
  }

  // Recent Board preview
  const recentBoard = snapshot.recentBoard.slice(-8);
  if (recentBoard.length > 0 || snapshot.boardHead > 0) {
    out.push("");
    out.push(`#### Recent Board (#${snapshot.boardHead})`);
    if (recentBoard.length === 0) {
      out.push(`_Board head is #${snapshot.boardHead}; run \`/swarm board\` to inspect._`);
    } else {
      for (const msg of recentBoard) {
        const clock = formatEventClock(msg.timestamp);
        const mentions = formatBoardMentionsSuffix(msg.mentions);
        out.push(
          `- **#${msg.seq}** \`${clock}\` \`${formatBoardKindBadge(msg.kind)}\` **${sanitizePlainText(msg.from)}**${mentions}: ${sanitizePlainText(msg.text)}`,
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
      const mTag = ev.missionId ? ` [\`${ev.missionId}\`]` : "";
      out.push(
        `- \`${clock}\`${mTag} **${ev.type}**: ${sanitizePlainText(ev.summary)}`,
      );
    }
  }

  return out.join("\n");
}

/**
 * Zero-LLM-turn formatter for `/swarm board [N]`.
 */
export function formatZeroTurnBoardView(
  messages: readonly BoardMessage[],
  head: number,
  options?: BoardViewOptions,
): string {
  const runSuffix = options?.runId ? ` — \`${sanitizePlainText(options.runId)}\`` : "";
  const out: string[] = [
    `### 🐝 Swarm Board${runSuffix} (head: #${head})`,
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
    const kindBadge = formatBoardKindBadge(msg.kind);
    const sender = sanitizePlainText(msg.from);
    const mentions = formatBoardMentionsSuffix(msg.mentions);
    const missionTag = msg.missionId ? ` [\`${sanitizePlainText(msg.missionId)}\`]` : "";
    const body = sanitizePlainText(msg.text);
    out.push(
      `- **#${msg.seq}** \`${clock}\` \`${kindBadge}\` **${sender}**${mentions}${missionTag}: ${body}`,
    );
  }

  return out.join("\n");
}

/**
 * Zero-LLM-turn formatter for `/swarm models`.
 * Shows configured 3-role models (`orchestrator`, `worker`, `validator`, thinking levels,
 * `fallbackModels`) AND every live/roster agent's actual model & state.
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
    out.push(`| ${r.label} | ${settingsCell} | ${activeCell} | \`${escapeMdCell(thinking)}\` |`);
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

  // Live Roster Models
  out.push("");
  out.push("#### Live Roster Models");
  const run = snapshot.run;
  if (!run) {
    out.push("_No active Swarm run._");
  } else {
    const roster = getAllRosterEntries(snapshot, run);
    if (roster.length === 0) {
      out.push("_No active or waiting agents in the current run._");
    } else {
      out.push("| Agent | Role | Mission | State | Live Model | Thinking | Turns |");
      out.push("| --- | --- | --- | --- | --- | --- | ---: |");
      for (const entry of roster) {
        const missionCol =
          entry.missionId === FINAL_AUDIT_MISSION_ID ? "FINAL" : entry.missionId;
        const liveModel = entry.model ?? hostDisplay;
        const thinking = entry.thinkingLevel ?? "default";
        out.push(
          `| \`${escapeMdCell(entry.name || entry.agentId)}\` | ${entry.role} | \`${escapeMdCell(missionCol)}\` | ${escapeMdCell(formatRosterStatusBadge(entry.status))} | \`${escapeMdCell(liveModel)}\` | \`${escapeMdCell(thinking)}\` | ${entry.turns} |`,
        );
      }
    }
  }

  out.push("");
  out.push(
    "_Tip: Hot-switch any `waiting` agent's model with `/swarm model <agent> <model>` or press `[m]` in `/swarm tasks`._",
  );

  return out.join("\n");
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
    // Strictly never hijack input while any modal/dialog/overlay is open
    if (callbacks.isModalOpen()) {
      return undefined;
    }

    if (matchesKey(data, Key.ctrlShift("t"))) {
      callbacks.onToggleExpand();
      return { consume: true };
    }

    if (matchesKey(data, Key.escape) && callbacks.isExpanded()) {
      callbacks.onCollapse();
      return { consume: true };
    }

    return undefined;
  });
}

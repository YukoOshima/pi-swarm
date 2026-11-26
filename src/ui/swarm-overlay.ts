import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { DEFAULT_CHANNEL, DEFAULT_SWARM_SETTINGS, ORCHESTRATOR_NAME } from "../constants.js";
import { parseModelSpec } from "../store/index.js";
import {
  isReconRun,
  type AssertionStatus,
  type AvailableModelInfo,
  type BoardMessage,
  type DiffSummary,
  type FeatureStatus,
  type ISwarmEngine,
  type IWorktreeManager,
  type MissionAssertion,
  type MissionFeature,
  type MissionHandoffItem,
  type SwarmMemberRecord,
  type SwarmRunState,
  type SwarmSnapshot,
} from "../types.js";
import {
  SwarmModelPickerView,
  type ModelPickerSettingsState,
  type ModelSaveScope,
  type SwarmModelPickerViewOptions,
} from "./model-picker.js";
import {
  buildSwarmGraphLines,
  computeBoxInnerWidth,
  decodePrintableInput,
  fitLine,
  formatBoardKindBadge,
  formatBoardTargets,
  formatClock,
  formatCost,
  formatElapsedSince,
  formatMemberRoleBadge,
  formatMemberStateBadge,
  formatRoleModelsLine,
  formatRunStatusBadge,
  formatTokens,
  formatWorkspaceBadge,
  getOrderedMembers,
  HardwareCursorController,
  isEscapeKey,
  isKeyReleaseSafe,
  isTabKey,
  joinColumns,
  memberStateIcon,
  normalizeEditorInput,
  renderBox,
  renderHorizontalRule,
  sanitizeDiffLine,
  sanitizePlainText,
  shortenModelName,
  visibleWidth,
  wrapLines,
} from "./text-utils.js";

export type SwarmOverlayTab = "board" | "members" | "graph" | "search";
export type SwarmOverlayGraphView = "graph" | "contract";

export interface SwarmOverlayOptions {
  onModalEnter?: () => void;
  onModalExit?: () => void;
  /** Initial active tab (default: "board"). */
  initialTab?: SwarmOverlayTab;
  /** Initial sub-view on the Graph tab ("graph" | "contract", default: "graph"). */
  initialGraphView?: SwarmOverlayGraphView;
  /** Optional member name to pre-select on the Members tab. */
  initialMemberName?: string;
  /** Optional channel filter to pre-select on the Board tab ("*" for all). */
  initialChannel?: string;
  /** Optional host session model fallback for 3-role display. */
  hostModel?: string;
  /** Available models catalog for interactive `[m]` / `[M]` Mission Model Picker. */
  availableModels?: readonly AvailableModelInfo[];
  /** Preferred save scope for `[M]` Mission Models view. */
  initialScope?: ModelSaveScope;
  /** Current 3-role settings & origin metadata getter for `[M]` Mission Models view. */
  getModelSettingsState?: () => ModelPickerSettingsState;
  /** Handler called when updating a role default from `[M]` Mission Models view. */
  onApplyRoleModel?: SwarmModelPickerViewOptions["onApplyRole"];
  /** Handler called when updating fallback models from `[M]` Mission Models view. */
  onApplyFallbacks?: SwarmModelPickerViewOptions["onApplyFallbacks"];
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Live spinner interval in milliseconds while members are working (default: 120ms). */
  spinnerIntervalMs?: number;
}

const OVERLAY_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

const TAB_ORDER: readonly SwarmOverlayTab[] = [
  "board",
  "members",
  "graph",
  "search",
];

type MemberDetailMode = "info" | "logs" | "diff";

type InlineInputMode =
  | { kind: "board_post"; channel: string }
  | { kind: "wake"; member: SwarmMemberRecord; conflictRetry?: boolean }
  | { kind: "model"; member: SwarmMemberRecord };

interface FeedbackMessage {
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

const formatInnerClock = formatClock;
const formatTargetsSuffix = formatBoardTargets;

function formatOverlayRoleShortBadge(
  member: Pick<SwarmMemberRecord, "role" | "recon">,
  theme: Theme,
): string {
  if (member.recon) {
    return theme.fg("borderAccent", "[R]");
  }
  return member.role === "validator"
    ? theme.fg("warning", "[V]")
    : theme.fg("accent", "[W]");
}

function formatOverlayReconRunBadge(theme: Theme): string {
  return theme.fg("borderAccent", theme.bold("[RECON]"));
}

function countOverlayReconMembers(run: SwarmRunState): number {
  let count = 0;
  for (const m of getOrderedMembers(run)) {
    if (m.recon && m.state !== "killed") {
      count += 1;
    }
  }
  return count;
}

function isTerminalRunStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "abandoned" ||
    status === "cancelled" ||
    status === "failed"
  );
}

function countOverlayFleetStates(
  snapshot: SwarmSnapshot,
  run: SwarmRunState,
): {
  workingCount: number;
  waitingCount: number;
  stoppedCount: number;
  mergedCount: number;
} {
  const members = getOrderedMembers(run);
  const workingNames = new Set(snapshot.workingMemberNames);
  let working = 0;
  let waiting = 0;
  let stopped = 0;
  let merged = 0;
  for (const m of members) {
    if (m.mergedCommitSha && sanitizePlainText(m.mergedCommitSha).length > 0) {
      merged += 1;
    }
    const isWorking =
      m.state === "working" ||
      (workingNames.has(m.name) &&
        m.state !== "stopped" &&
        m.state !== "killed");
    if (isWorking) {
      working += 1;
    } else if (m.state === "waiting") {
      waiting += 1;
    } else if (m.state === "stopped") {
      stopped += 1;
    }
  }
  const validWorkingNames = snapshot.workingMemberNames.filter((name) => {
    const m = run.members[name];
    return !m || (m.state !== "stopped" && m.state !== "killed");
  });
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
  return {
    workingCount: Math.max(working, validWorkingNames.length),
    waitingCount: Math.max(waiting, nonWorkingWaitingNames.length),
    stoppedCount: stopped,
    mergedCount: merged,
  };
}

interface OverlayGoalSummary {
  features: MissionFeature[];
  featDone: number;
  featTotal: number;
  featFailed: number;
  assertions: MissionAssertion[];
  valPassed: number;
  valTotal: number;
  valFailed: number;
  valOverridden: number;
  openHandoffs: MissionHandoffItem[];
  openDebtItems: MissionHandoffItem[];
  sealedMilestones: string[];
  hasPipelineGoal: boolean;
  hasMissionInspector: boolean;
}

function summarizeOverlayGoal(run: SwarmRunState): OverlayGoalSummary {
  const features = run.features ?? [];
  const nonCancelled = features.filter((f) => f.status !== "cancelled");
  const featTotal =
    features.length > 0
      ? nonCancelled.length > 0
        ? nonCancelled.length
        : features.length
      : 0;
  const featDone = nonCancelled.filter((f) => f.status === "completed").length;
  const featFailed = nonCancelled.filter((f) => f.status === "failed").length;

  const assertions = run.assertions ?? [];
  const valTotal = assertions.length;
  const valPassed = assertions.filter((a) => a.status === "passed").length;
  const valFailed = assertions.filter((a) => a.status === "failed").length;
  const valOverridden = assertions.filter((a) => Boolean(a.overridden)).length;

  const openHandoffs = (run.handoffItems ?? []).filter(
    (h) => h.resolution === "open",
  );
  const openDebtItems = openHandoffs.filter(
    (h) => h.type === "discovered_issue" || h.type === "incomplete_work",
  );

  const sealedMilestones = (run.milestones ?? [])
    .filter((m) => Boolean(m.sealed))
    .map((m) => sanitizePlainText(m.label))
    .filter(Boolean);

  const hasPipelineGoal =
    features.length > 0 ||
    assertions.length > 0 ||
    sealedMilestones.length > 0 ||
    openDebtItems.length > 0;
  const hasMissionInspector =
    hasPipelineGoal ||
    openHandoffs.length > 0 ||
    Boolean(
      run.commands?.length ||
        run.services?.length ||
        run.boundaries?.length ||
        run.lastAudit,
    );

  return {
    features,
    featDone,
    featTotal,
    featFailed,
    assertions,
    valPassed,
    valTotal,
    valFailed,
    valOverridden,
    openHandoffs,
    openDebtItems,
    sealedMilestones,
    hasPipelineGoal,
    hasMissionInspector,
  };
}

function overlayProgressBar(done: number, total: number, cells = 4): string {
  if (total <= 0 || cells <= 0) return "";
  const clamped = Math.max(0, Math.min(total, done));
  let filled = Math.round((clamped / total) * cells);
  if (clamped < total && filled >= cells) filled = Math.max(0, cells - 1);
  if (clamped > 0 && filled === 0 && cells >= 4 && clamped / total >= 0.15) {
    filled = 1;
  }
  return `[${"█".repeat(filled)}${"░".repeat(cells - filled)}]`;
}

function overlayFeatureGlyph(status: FeatureStatus, theme?: Theme): string {
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

function overlayAssertionGlyph(status: AssertionStatus, theme?: Theme): string {
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

interface MissionContractRenderOptions {
  libraryTopics?: readonly string[] | null;
  activeReader?: {
    topic: string;
    content: string;
    loading: boolean;
    error?: string;
  } | null;
  canReadLibrary?: boolean;
}

function normalizeOverlayLibraryTopic(raw: string): string {
  return sanitizePlainText(raw).trim().replace(/\.md$/i, "");
}

function buildMissionContractLines(
  run: SwarmRunState,
  width: number,
  theme?: Theme,
  options?: MissionContractRenderOptions,
): string[] {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return [];

  const sep = theme ? theme.fg("dim", " · ") : " · ";
  const activeReader = options?.activeReader ?? null;
  if (activeReader) {
    const readerLines: string[] = [];
    const rawTopics =
      options?.libraryTopics && options.libraryTopics.length > 0
        ? options.libraryTopics.map(normalizeOverlayLibraryTopic).filter(Boolean)
        : [activeReader.topic];
    const idx = Math.max(0, rawTopics.indexOf(activeReader.topic));
    const headerTitle =
      targetWidth >= 58
        ? `Shared Library: ${activeReader.topic}.md (${idx + 1}/${rawTopics.length}) [l: next · Esc: contract]`
        : targetWidth >= 42
          ? `Library: ${activeReader.topic}.md (${idx + 1}/${rawTopics.length}) [l/Esc]`
          : `${activeReader.topic}.md [l/Esc]`;
    readerLines.push(renderHorizontalRule(targetWidth, headerTitle, theme));

    const topicPills = rawTopics.map((t) => {
      const label = `${t}.md`;
      if (t === activeReader.topic) {
        return theme ? theme.fg("accent", theme.bold(`[▸ ${label}]`)) : `[▸ ${label}]`;
      }
      return theme ? theme.fg("muted", label) : label;
    });
    readerLines.push(fitLine(`  ${topicPills.join(sep)}`, targetWidth));

    const fullTopicPath = `.pi/swarm/runs/${sanitizePlainText(run.id)}/library/${activeReader.topic}.md`;
    readerLines.push(
      fitLine(
        theme
          ? `  ${theme.fg("muted", "Path:")} ${theme.fg("dim", fullTopicPath)}`
          : `  Path: ${fullTopicPath}`,
        targetWidth,
      ),
    );
    readerLines.push(renderHorizontalRule(targetWidth, undefined, theme));

    if (activeReader.loading) {
      const loadingMsg = `  Loading ${activeReader.topic}.md…`;
      readerLines.push(
        fitLine(theme ? theme.fg("muted", loadingMsg) : loadingMsg, targetWidth),
      );
    } else if (activeReader.error) {
      const errMsg = `  Library read error: ${sanitizePlainText(activeReader.error)}`;
      readerLines.push(
        fitLine(theme ? theme.fg("error", errMsg) : errMsg, targetWidth),
      );
    } else if (!activeReader.content.trim()) {
      const emptyMsg = `  (topic ${activeReader.topic}.md is empty)`;
      readerLines.push(
        fitLine(theme ? theme.fg("dim", emptyMsg) : emptyMsg, targetWidth),
      );
    } else {
      for (const rawLine of activeReader.content.split(/\r?\n/)) {
        const cleanLine = sanitizeDiffLine(rawLine);
        if (cleanLine.length === 0) {
          readerLines.push("");
          continue;
        }
        const wrapped = wrapLines(cleanLine, Math.max(1, targetWidth - 2));
        const isHeading = /^#{1,6}\s/.test(cleanLine.trimStart());
        const isFence = /^```/.test(cleanLine.trimStart());
        for (const seg of wrapped) {
          const styledSeg = theme
            ? isHeading
              ? theme.fg("accent", theme.bold(seg))
              : isFence
                ? theme.fg("dim", seg)
                : seg
            : seg;
          readerLines.push(fitLine(`  ${styledSeg}`, targetWidth));
        }
      }
    }
    return readerLines.map((l) => fitLine(l, targetWidth));
  }

  const goal = summarizeOverlayGoal(run);
  const sealedSet = new Set(goal.sealedMilestones);
  const lines: string[] = [];

  lines.push(
    targetWidth >= 46
      ? renderHorizontalRule(
          targetWidth,
          "Mission Contract & Features [v: Spawn Graph]",
          theme,
        )
      : renderHorizontalRule(targetWidth, "Contract & Features", theme),
  );

  // Overview progress bar & contract summary
  const overviewParts: string[] = [];
  if (goal.features.length > 0) {
    const bar =
      targetWidth >= 56
        ? `${overlayProgressBar(goal.featDone, goal.featTotal, 4)} `
        : "";
    const ratio = `${bar}${goal.featDone}/${goal.featTotal}`;
    overviewParts.push(
      theme
        ? `${theme.fg("muted", "Features")} ${theme.fg(goal.featFailed > 0 ? "error" : goal.featDone === goal.featTotal && goal.featTotal > 0 ? "success" : "accent", ratio)}`
        : `Features ${ratio}`,
    );
  }
  if (goal.assertions.length > 0) {
    const ratio = `${goal.valPassed}/${goal.valTotal}`;
    const ovrRaw = goal.valOverridden > 0 ? ` (${goal.valOverridden} ovr)` : "";
    overviewParts.push(
      theme
        ? `${theme.fg("muted", "VAL")} ${theme.fg(goal.valFailed > 0 ? "error" : goal.valPassed === goal.valTotal && goal.valTotal > 0 ? "success" : "accent", ratio)}${ovrRaw ? theme.fg("warning", ovrRaw) : ""}`
        : `VAL ${ratio}${ovrRaw}`,
    );
  }
  if (goal.sealedMilestones.length > 0) {
    const sRaw = `[S] ${goal.sealedMilestones.length} sealed`;
    overviewParts.push(theme ? theme.fg("success", sRaw) : sRaw);
  }
  if (goal.openDebtItems.length > 0) {
    const dRaw = `!${goal.openDebtItems.length} debt`;
    overviewParts.push(theme ? theme.fg("warning", dRaw) : dRaw);
  }
  if (overviewParts.length > 0) {
    const lead = theme ? theme.fg("accent", "◆") : "◆";
    lines.push(fitLine(`${lead} ${overviewParts.join(sep)}`, targetWidth));
  }
  if (run.lastAudit) {
    const verdictRaw = `[${sanitizePlainText(run.lastAudit.verdict).toUpperCase()}]`;
    const verdictStyled = theme
      ? theme.fg(
          run.lastAudit.verdict === "approved" ? "success" : "error",
          verdictRaw,
        )
      : verdictRaw;
    const auditorStr = run.lastAudit.auditor
      ? ` by @${sanitizePlainText(run.lastAudit.auditor)}`
      : "";
    lines.push(
      fitLine(
        `  ${theme ? theme.fg("muted", "Audit:") : "Audit:"} ${verdictStyled}${theme ? theme.fg("dim", auditorStr) : auditorStr} — ${sanitizePlainText(run.lastAudit.summary)}`,
        targetWidth,
      ),
    );
  }

  // 1. Milestones ([S] sealed)
  const milestones = run.milestones ?? [];
  if (milestones.length > 0) {
    const doneMs = milestones.filter((m) => m.status === "done").length;
    lines.push(
      renderHorizontalRule(
        targetWidth,
        `Milestones (${doneMs}/${milestones.length})`,
        theme,
      ),
    );
    for (const ms of milestones) {
      const msGlyphRaw =
        ms.status === "done"
          ? "[✓]"
          : ms.status === "in_progress"
            ? "[▸]"
            : ms.status === "blocked"
              ? "[!]"
              : "[ ]";
      const msGlyph = theme
        ? theme.fg(
            ms.status === "done"
              ? "success"
              : ms.status === "in_progress"
                ? "accent"
                : ms.status === "blocked"
                  ? "error"
                  : "muted",
            msGlyphRaw,
          )
        : msGlyphRaw;
      const cleanLabel = sanitizePlainText(ms.label);
      const labelStyled = theme ? theme.bold(cleanLabel) : cleanLabel;
      const sealedBadge = ms.sealed
        ? ` ${theme ? theme.fg("success", "[S]") : "[S]"}`
        : "";
      const ownerBadge = ms.owner
        ? ` ${theme ? theme.fg("dim", `(@${sanitizePlainText(ms.owner)})`) : `(@${sanitizePlainText(ms.owner)})`}`
        : "";
      const statusText = theme ? theme.fg("muted", ms.status) : ms.status;
      lines.push(
        fitLine(
          `  ${msGlyph} ${labelStyled}${sealedBadge} — ${statusText}${ownerBadge}`,
          targetWidth,
        ),
      );
    }
  }

  // 2. Ordered Features ([✓] completed, [▸] in_progress, [ ] pending, [!] failed, [~] cancelled)
  lines.push(
    renderHorizontalRule(
      targetWidth,
      `Features (${goal.featDone}/${goal.featTotal})`,
      theme,
    ),
  );
  if (goal.features.length === 0) {
    const emptyFeat = "  (no mission features defined)";
    lines.push(fitLine(theme ? theme.fg("muted", emptyFeat) : emptyFeat, targetWidth));
  } else {
    for (const f of goal.features) {
      const glyph = overlayFeatureGlyph(f.status, theme);
      const cleanId = sanitizePlainText(f.id);
      const idStyled = theme ? theme.bold(cleanId) : cleanId;
      const cleanMs = sanitizePlainText(f.milestone);
      const msRaw = cleanMs
        ? `[${cleanMs}${sealedSet.has(cleanMs) ? " [S]" : ""}]`
        : "";
      const msStyled = msRaw ? (theme ? theme.fg("muted", msRaw) : msRaw) : "";
      const assignedRaw = f.assignedMember
        ? `@${sanitizePlainText(f.assignedMember)}`
        : "unassigned";
      const assignedStyled = theme
        ? f.assignedMember
          ? theme.fg("accent", assignedRaw)
          : theme.fg("dim", assignedRaw)
        : assignedRaw;
      const shaRaw = f.mergedCommitSha
        ? `(${sanitizePlainText(f.mergedCommitSha).slice(0, 7)})`
        : "";
      const shaStyled = shaRaw ? (theme ? theme.fg("success", shaRaw) : shaRaw) : "";
      const cleanTitle = sanitizePlainText(f.title);
      const fulfillsPlain =
        f.fulfills.length > 0
          ? `fulfills: ${f.fulfills.map(sanitizePlainText).join(", ")}`
          : "";
      const depsPlain =
        f.dependsOn && f.dependsOn.length > 0
          ? `dependsOn: ${f.dependsOn.map(sanitizePlainText).join(", ")}`
          : "";

      const headSegments = [
        `  ${glyph} ${idStyled}`,
        msStyled,
        `(${assignedStyled})`,
        shaStyled,
      ].filter(Boolean);
      const primaryLine = cleanTitle
        ? `${headSegments.join(" ")}: ${cleanTitle}`
        : headSegments.join(" ");

      const metaTailPlain = [fulfillsPlain, depsPlain].filter(Boolean).join(" · ");
      const metaTailStyled = metaTailPlain
        ? theme
          ? theme.fg("dim", metaTailPlain)
          : metaTailPlain
        : "";

      if (!metaTailStyled) {
        lines.push(fitLine(primaryLine, targetWidth));
      } else {
        const singleCandidate = `${primaryLine}${sep}${metaTailStyled}`;
        if (visibleWidth(singleCandidate) <= targetWidth) {
          lines.push(fitLine(singleCandidate, targetWidth));
        } else {
          lines.push(fitLine(primaryLine, targetWidth));
          lines.push(fitLine(`      ${metaTailStyled}`, targetWidth));
        }
      }
    }
  }

  // 3. Validation Contract Assertions (VAL-* + verifiedBy + evidence + audited [OVERRIDE])
  const valHeaderTitle =
    goal.valOverridden > 0
      ? targetWidth >= 56
        ? `Validation Assertions (${goal.valPassed}/${goal.valTotal} passed · ${goal.valOverridden} [OVERRIDE])`
        : `Assertions (${goal.valPassed}/${goal.valTotal} · ${goal.valOverridden} ovr)`
      : `Validation Assertions (${goal.valPassed}/${goal.valTotal} passed)`;
  lines.push(renderHorizontalRule(targetWidth, valHeaderTitle, theme));
  if (goal.assertions.length === 0) {
    const emptyVal = "  (no validation assertions defined)";
    lines.push(fitLine(theme ? theme.fg("muted", emptyVal) : emptyVal, targetWidth));
  } else {
    for (const a of goal.assertions) {
      const glyph = overlayAssertionGlyph(a.status, theme);
      const cleanId = sanitizePlainText(a.id);
      const idStyled = theme ? theme.bold(cleanId) : cleanId;
      const statusStyled = theme
        ? theme.fg(
            a.status === "passed"
              ? "success"
              : a.status === "failed"
                ? "error"
                : a.status === "blocked"
                  ? "warning"
                  : "muted",
            `[${a.status}]`,
          )
        : `[${a.status}]`;
      const isOverridden = Boolean(a.overridden);
      const overrideBadge = isOverridden
        ? theme
          ? ` ${theme.fg("warning", theme.bold("[OVERRIDE]"))}`
          : " [OVERRIDE]"
        : "";
      const verifiedRaw = a.verifiedBy
        ? `@${sanitizePlainText(a.verifiedBy)}`
        : "unverified";
      const verifiedStyled = theme
        ? a.verifiedBy
          ? theme.fg("accent", verifiedRaw)
          : theme.fg("dim", verifiedRaw)
        : verifiedRaw;
      const cleanTitle = sanitizePlainText(a.title);
      const statusAndOverride =
        isOverridden && targetWidth < 48
          ? `${overrideBadge.trimStart()} ${statusStyled}`
          : `${statusStyled}${overrideBadge}`;
      lines.push(
        fitLine(
          `  ${glyph} ${idStyled} ${statusAndOverride} (${verifiedStyled}): ${cleanTitle}`,
          targetWidth,
        ),
      );

      const evRaw = a.evidence
        ? `evidence: ${sanitizePlainText(a.evidence)}`
        : a.evidenceRequired
          ? `requires: ${sanitizePlainText(a.evidenceRequired)}`
          : "";
      if (evRaw) {
        lines.push(
          fitLine(
            `      ${theme ? theme.fg("muted", evRaw) : evRaw}`,
            targetWidth,
          ),
        );
      }

      const justClean = a.overrideJustification
        ? sanitizePlainText(a.overrideJustification)
        : isOverridden
          ? "(no justification recorded)"
          : "";
      if (justClean) {
        const justLabel = theme
          ? theme.fg("warning", "override:")
          : "override:";
        const justText = theme ? theme.fg("muted", justClean) : justClean;
        if (targetWidth > 12) {
          const wrappedJust = wrapLines(
            `${justLabel} ${justText}`,
            targetWidth - 6,
            2,
          );
          for (const wl of wrappedJust) {
            lines.push(fitLine(`      ${wl}`, targetWidth));
          }
        } else {
          lines.push(fitLine(`      ${justLabel} ${justText}`, targetWidth));
        }
      }
    }
  }

  // 4. Open Handoff Items
  if (goal.openHandoffs.length > 0) {
    lines.push(
      renderHorizontalRule(
        targetWidth,
        `Open Handoffs (${goal.openHandoffs.length})`,
        theme,
      ),
    );
    for (const h of goal.openHandoffs) {
      const hGlyphRaw = h.type === "critical_context" ? "[*]" : "[!]";
      const hGlyph = theme
        ? theme.fg(
            h.type === "critical_context" ? "accent" : "warning",
            hGlyphRaw,
          )
        : hGlyphRaw;
      const idStyled = theme
        ? theme.bold(sanitizePlainText(h.id))
        : sanitizePlainText(h.id);
      const typeStyled = theme ? theme.fg("muted", `[${h.type}]`) : `[${h.type}]`;
      const srcStr = `@${sanitizePlainText(h.sourceMember)}${h.sourceFeatureId ? ` (${sanitizePlainText(h.sourceFeatureId)})` : ""}`;
      const srcStyled = theme ? theme.fg("accent", srcStr) : srcStr;
      lines.push(
        fitLine(
          `  ${hGlyph} ${idStyled} ${typeStyled} ${srcStyled}: ${sanitizePlainText(h.summary)}`,
          targetWidth,
        ),
      );
    }
  }

  // 5. Services & Ports
  if (run.services && run.services.length > 0) {
    const svcRuleTitle =
      targetWidth >= 36
        ? `Services & Ports (${run.services.length})`
        : `Services (${run.services.length})`;
    lines.push(renderHorizontalRule(targetWidth, svcRuleTitle, theme));
    for (const svc of run.services) {
      const nameClean = sanitizePlainText(svc.name);
      const nameStyled = theme ? theme.bold(nameClean) : nameClean;
      const portNum =
        typeof svc.port === "number" && Number.isFinite(svc.port)
          ? Math.floor(svc.port)
          : undefined;
      const portRaw = portNum !== undefined ? `:${portNum}` : "";
      const portStyled = portRaw
        ? ` ${theme ? theme.fg("accent", portRaw) : portRaw}`
        : "";
      const startClean = sanitizePlainText(svc.start);
      const startStyled = theme
        ? `${theme.fg("muted", "start:")} ${theme.fg("dim", startClean)}`
        : `start: ${startClean}`;
      const leadGlyph = theme ? theme.fg("accent", "▸") : "▸";
      const headLine = `  ${leadGlyph} ${nameStyled}${portStyled} — ${startStyled}`;

      const detailParts: string[] = [];
      if (svc.healthcheck) {
        const hcClean = sanitizePlainText(svc.healthcheck);
        detailParts.push(
          theme
            ? `${theme.fg("muted", "healthcheck:")} ${theme.fg("dim", hcClean)}`
            : `healthcheck: ${hcClean}`,
        );
      }
      if (svc.dependsOn && svc.dependsOn.length > 0) {
        const depsClean = svc.dependsOn.map(sanitizePlainText).join(", ");
        detailParts.push(
          theme
            ? `${theme.fg("muted", "dependsOn:")} ${theme.fg("dim", depsClean)}`
            : `dependsOn: ${depsClean}`,
        );
      }
      if (svc.stop) {
        const stopClean = sanitizePlainText(svc.stop);
        detailParts.push(
          theme
            ? `${theme.fg("muted", "stop:")} ${theme.fg("dim", stopClean)}`
            : `stop: ${stopClean}`,
        );
      }

      if (detailParts.length === 0) {
        lines.push(fitLine(headLine, targetWidth));
      } else {
        const detailTail = detailParts.join(sep);
        const singleCandidate = `${headLine}${sep}${detailTail}`;
        if (visibleWidth(singleCandidate) <= targetWidth) {
          lines.push(fitLine(singleCandidate, targetWidth));
        } else {
          lines.push(fitLine(headLine, targetWidth));
          lines.push(fitLine(`      ${detailTail}`, targetWidth));
        }
      }
    }
  }

  // 6. Commands & Boundaries
  const hasCommands = Boolean(run.commands && run.commands.length > 0);
  const hasBoundaries = Boolean(run.boundaries && run.boundaries.length > 0);
  if (hasCommands || hasBoundaries) {
    lines.push(
      renderHorizontalRule(targetWidth, "Commands & Boundaries", theme),
    );
    for (const cmd of run.commands ?? []) {
      const nameStr = sanitizePlainText(cmd.name);
      const cmdStr = sanitizePlainText(cmd.command);
      lines.push(
        fitLine(
          theme
            ? `  ${theme.fg("accent", "$")} ${theme.bold(nameStr)}: ${theme.fg("muted", cmdStr)}`
            : `  $ ${nameStr}: ${cmdStr}`,
          targetWidth,
        ),
      );
    }
    for (const b of run.boundaries ?? []) {
      const cleanB = sanitizePlainText(b);
      lines.push(
        fitLine(
          theme
            ? `  ${theme.fg("warning", "!")} ${theme.fg("muted", cleanB)}`
            : `  ! ${cleanB}`,
          targetWidth,
        ),
      );
    }
  }

  // 7. Shared Mission Library Reference & Real Topics
  const libraryPath = `.pi/swarm/runs/${sanitizePlainText(run.id)}/library/`;
  const libRuleTitle = options?.canReadLibrary
    ? targetWidth >= 48
      ? "Shared Library [l: read topic]"
      : "Shared Library [l]"
    : "Shared Library";
  lines.push(renderHorizontalRule(targetWidth, libRuleTitle, theme));

  const loadedTopics = options?.libraryTopics;
  if (loadedTopics !== undefined && loadedTopics !== null) {
    const cleanTopics = loadedTopics
      .map(normalizeOverlayLibraryTopic)
      .filter(Boolean);
    if (cleanTopics.length === 0) {
      lines.push(
        fitLine(
          theme
            ? `  ${theme.fg("accent", "◆")} ${theme.bold(libraryPath)}${theme.fg("dim", " (no .md topics yet)")}`
            : `  ◆ ${libraryPath} (no .md topics yet)`,
          targetWidth,
        ),
      );
    } else {
      const mdNames = cleanTopics.map((t) => `${t}.md`).join(" · ");
      const singleLib = theme
        ? `  ${theme.fg("accent", "◆")} ${theme.bold(libraryPath)} ${theme.fg("muted", `(${mdNames})`)}`
        : `  ◆ ${libraryPath} (${mdNames})`;
      if (visibleWidth(singleLib) <= targetWidth) {
        lines.push(fitLine(singleLib, targetWidth));
      } else {
        lines.push(
          fitLine(
            theme
              ? `  ${theme.fg("accent", "◆")} ${theme.bold(libraryPath)}`
              : `  ◆ ${libraryPath}`,
            targetWidth,
          ),
        );
        const wrappedTopics = wrapLines(
          mdNames,
          Math.max(1, targetWidth - 6),
          3,
        );
        for (const wt of wrappedTopics) {
          lines.push(
            fitLine(
              `      ${theme ? theme.fg("muted", wt) : wt}`,
              targetWidth,
            ),
          );
        }
      }
    }
  } else {
    lines.push(
      fitLine(
        theme
          ? `  ${theme.fg("accent", "◆")} ${theme.bold(libraryPath)}${theme.fg("dim", " (architecture.md · environment.md · testing.md)")}`
          : `  ◆ ${libraryPath} (architecture.md · environment.md · testing.md)`,
        targetWidth,
      ),
    );
  }

  return lines.map((l) => fitLine(l, targetWidth));
}

function formatOverlayPhaseMilestones(
  run: SwarmRunState,
  theme: Theme,
): string | undefined {
  const phase = run.phase ? sanitizePlainText(run.phase) : "";
  const milestones = run.milestones ?? [];
  if (!phase && milestones.length === 0) return undefined;

  const doneCount = milestones.filter((m) => m.status === "done").length;
  const sealedCount = milestones.filter((m) => Boolean(m.sealed)).length;
  const totalCount = milestones.length;
  const sealedPart =
    sealedCount > 0 ? ` ${theme.fg("success", `[S] ${sealedCount}`)}` : "";

  if (phase && totalCount > 0) {
    const ratio = `[${doneCount}/${totalCount}]`;
    return `${theme.fg("muted", "Phase:")} ${theme.fg("accent", phase)} ${theme.fg(doneCount === totalCount ? "success" : "muted", ratio)}${sealedPart}`;
  }
  if (phase) {
    return `${theme.fg("muted", "Phase:")} ${theme.fg("accent", phase)}`;
  }
  const ratio = `[${doneCount}/${totalCount}]`;
  return `${theme.fg("muted", "Milestones:")} ${theme.fg(doneCount === totalCount ? "success" : "accent", ratio)}${sealedPart}`;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return sanitizePlainText(err.message);
  return sanitizePlainText(String(err));
}

function parseModelAndThinking(raw: string): {
  model: string;
  thinkingLevel?: ThinkingLevel;
} {
  return parseModelSpec(raw);
}

function matchesSearchQuery(msg: BoardMessage, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (`#${msg.seq}`.includes(needle)) return true;
  if (msg.text.toLowerCase().includes(needle)) return true;
  if (msg.from.toLowerCase().includes(needle)) return true;
  if ((msg.channel || DEFAULT_CHANNEL).toLowerCase().includes(needle)) return true;
  if (msg.kind.toLowerCase().includes(needle)) return true;
  for (const m of msg.mentions) {
    if (m.toLowerCase().includes(needle) || `@${m.toLowerCase()}`.includes(needle)) {
      return true;
    }
  }
  for (const ch of msg.channelMentions ?? []) {
    if (ch.toLowerCase().includes(needle) || `#${ch.toLowerCase()}`.includes(needle)) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// 4-Tab Antigravity-Swarm-Inspired Interactive Overlay Component
// ============================================================================

export class SwarmOverlayComponent implements Component, Focusable {
  private _focused = false;
  private snapshot: SwarmSnapshot;
  private activeTab: SwarmOverlayTab;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private readonly spinnerIntervalMs: number;
  private readonly now: () => number;

  // Board tab state
  private boardMessages: BoardMessage[] = [];
  private channelFilter: string;
  private boardSelectedIndex = 0;

  // Members tab state
  private memberSelectedIndex = 0;
  private memberDetailMode: MemberDetailMode = "info";
  private memberDetailScrollOffset = 0;
  private pendingKillConfirm?: { memberName: string; force: boolean };
  private diffState: {
    memberName: string;
    branch: string;
    loading: boolean;
    summary?: DiffSummary;
    error?: string;
  } | null = null;
  private diffRequestId = 0;

  // Graph / Mission Contract tab state
  private graphViewMode: SwarmOverlayGraphView;
  private graphScrollOffset = 0;
  private libraryTopics: string[] | null = null;
  private libraryTopicsRunId: string | null = null;
  private libraryRefreshInFlight = false;
  private activeLibraryReader: {
    topic: string;
    content: string;
    loading: boolean;
    error?: string;
  } | null = null;
  private libraryRequestId = 0;
  private graphCache:
    | {
        runId: string;
        revision: number;
        boardLen: number;
        lastSeq: number;
        width: number;
        mode: SwarmOverlayGraphView;
        libraryKey: string;
        lines: string[];
      }
    | undefined;

  // Search tab state
  private searchQuery = "";
  private searchFocused = false;
  private searchSelectedIndex = 0;
  private readonly searchInput: Input;

  // Expanded post reader (Board [1] & Search [4])
  private expandedPost: {
    tab: "board" | "search";
    seq: number;
    scrollOffset: number;
  } | null = null;

  // Inline IME action input (Board [p] post, Members [w] wake, Members [m] model)
  private inlineMode: InlineInputMode | undefined;
  private inlineInput: Input;

  private readonly hwCursor = new HardwareCursorController();
  private feedback: FeedbackMessage | undefined;
  private subComponent: (Component & Partial<Focusable> & { dispose?(): void }) | null = null;
  private showHelp = false;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private currentRunId: string | null;
  private readonly hostModel?: string;
  private boardRefreshInFlight = false;
  private boardRefreshPending = false;
  private lastBoardRefreshRunId: string | null = null;
  private lastBoardRefreshHead: number | null = null;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly ctx: ExtensionContext,
    private readonly engine: ISwarmEngine,
    private readonly worktree: IWorktreeManager | null | undefined,
    private readonly options: SwarmOverlayOptions | undefined,
    private readonly done: () => void,
  ) {
    this.hostModel = options?.hostModel;
    this.spinnerIntervalMs = Math.max(40, options?.spinnerIntervalMs ?? 120);
    this.now = options?.now ?? (() => Date.now());
    this.activeTab = options?.initialTab ?? "board";
    this.graphViewMode = options?.initialGraphView ?? "graph";
    this.channelFilter = options?.initialChannel ?? "*";
    this.snapshot = engine.getSnapshot();
    this.currentRunId = this.snapshot.activeRunId ?? this.snapshot.run?.id ?? null;
    this.mergeBoardMessages(this.snapshot.recentBoard);

    const initialFiltered = this.getFilteredBoardMessages();
    this.boardSelectedIndex = Math.max(0, initialFiltered.length - 1);

    if (options?.initialMemberName && this.snapshot.run) {
      const members = getOrderedMembers(this.snapshot.run);
      const idx = members.findIndex((m) => m.name === options.initialMemberName);
      if (idx >= 0) this.memberSelectedIndex = idx;
    }

    this.inlineInput = this.buildInlineInput("› ", "Type message…");
    this.searchInput = new Input({
      prompt: "/ ",
      placeholder: "Search board (#seq, sender, channel, @mention, text)…",
      placeholderStyle: (t) => this.theme.fg("dim", t),
    });
    this.searchInput.onSubmit = () => {
      this.setSearchFocused(false);
      this.tui.requestRender();
    };
    this.searchInput.onEscape = () => {
      this.setSearchFocused(false);
      this.tui.requestRender();
    };

    if (this.activeTab === "search") {
      this.setSearchFocused(true);
    }

    this.unsubscribe = engine.subscribe((ev) => {
      if (this.closed) return;
      const prevFilteredLen = this.getFilteredBoardMessages().length;
      const wasAtLatest =
        prevFilteredLen === 0 || this.boardSelectedIndex >= prevFilteredLen - 1;

      const nextRunId = ev.snapshot.activeRunId ?? ev.snapshot.run?.id ?? null;
      const runSwitched = nextRunId !== this.currentRunId;
      if (runSwitched) {
        this.currentRunId = nextRunId;
        this.boardMessages = [];
        this.diffState = null;
        this.diffRequestId += 1;
        this.boardSelectedIndex = 0;
        this.searchSelectedIndex = 0;
        this.memberDetailScrollOffset = 0;
        this.pendingKillConfirm = undefined;
        this.expandedPost = null;
        this.graphViewMode = "graph";
        this.graphScrollOffset = 0;
        this.libraryTopics = null;
        this.libraryTopicsRunId = null;
        this.activeLibraryReader = null;
        this.libraryRequestId += 1;
        this.graphCache = undefined;
        this.lastBoardRefreshRunId = null;
        this.lastBoardRefreshHead = null;
      }

      if (!ev.snapshot.run) {
        this.inlineMode = undefined;
        this.searchFocused = false;
        this.pendingKillConfirm = undefined;
        this.expandedPost = null;
        this.syncInputFocus();
      }

      const prevMaxSeq =
        this.boardMessages.length > 0
          ? this.boardMessages[this.boardMessages.length - 1]!.seq
          : 0;
      const prevBoardLen = this.boardMessages.length;

      this.snapshot = ev.snapshot;
      this.mergeBoardMessages(ev.snapshot.recentBoard);

      const newFilteredLen = this.getFilteredBoardMessages().length;
      if (wasAtLatest && newFilteredLen > 0) {
        this.boardSelectedIndex = newFilteredLen - 1;
      }
      this.clampSelections();

      const maxLoadedSeq =
        this.boardMessages.length > 0
          ? this.boardMessages[this.boardMessages.length - 1]!.seq
          : 0;
      const minRecentSeq =
        ev.snapshot.recentBoard.length > 0
          ? ev.snapshot.recentBoard[0]!.seq
          : Infinity;
      const alreadyRefreshedHead =
        this.lastBoardRefreshRunId === nextRunId &&
        this.lastBoardRefreshHead !== null &&
        ev.snapshot.boardHead <= this.lastBoardRefreshHead;
      const hasHeadBehind =
        !alreadyRefreshedHead &&
        (ev.snapshot.boardHead > maxLoadedSeq ||
          (prevBoardLen === 0 && ev.snapshot.boardHead > ev.snapshot.recentBoard.length));
      const hasSeqGap =
        hasHeadBehind ||
        (prevMaxSeq > 0 && minRecentSeq > prevMaxSeq + 1);
      if (runSwitched || hasSeqGap) {
        void this.refreshFullBoard();
      }

      this.syncSpinnerTimer(this.hasWorkingMembers());
      if (this.activeTab === "graph" && this.graphViewMode === "contract") {
        void this.refreshLibraryTopics();
      }
      this.tui.requestRender();
    });

    this.syncSpinnerTimer(this.hasWorkingMembers());
    void this.refreshFullBoard();
    if (this.activeTab === "graph" && this.graphViewMode === "contract") {
      void this.refreshLibraryTopics();
    }
  }

  private getLibraryCacheKey(): string {
    const topicsPart =
      this.libraryTopics === null ? "null" : this.libraryTopics.join(",");
    const readerPart = this.activeLibraryReader
      ? `${this.activeLibraryReader.topic}:${this.activeLibraryReader.loading ? "1" : "0"}:${this.activeLibraryReader.error ?? ""}:${this.activeLibraryReader.content.length}`
      : "none";
    const capPart = typeof this.engine.manageMission === "function" ? "rw" : "ro";
    return `${capPart}|${topicsPart}|${readerPart}`;
  }

  private async refreshLibraryTopics(force = false): Promise<string[] | null> {
    const runId = this.snapshot.run?.id;
    if (
      this.closed ||
      !runId ||
      typeof this.engine.manageMission !== "function"
    ) {
      return null;
    }
    if (!force && this.libraryRefreshInFlight) {
      return this.libraryTopics;
    }
    this.libraryRefreshInFlight = true;
    try {
      const res = await this.engine.manageMission({
        op: "read_library",
        callerRole: "human",
        callerName: "human",
      });
      if (this.closed || this.snapshot.run?.id !== runId) {
        return null;
      }
      const normalized = (res.libraryTopics ?? [])
        .map(normalizeOverlayLibraryTopic)
        .filter(Boolean);
      this.libraryTopics = normalized;
      this.libraryTopicsRunId = runId;
      this.graphCache = undefined;
      this.tui.requestRender();
      return normalized;
    } catch {
      return this.libraryTopics;
    } finally {
      this.libraryRefreshInFlight = false;
    }
  }

  private async handleCycleLibraryTopic(): Promise<void> {
    const runId = this.snapshot.run?.id;
    if (!runId || typeof this.engine.manageMission !== "function") {
      this.setFeedback("info", "Shared Library reader unavailable for this run.");
      return;
    }

    let topics =
      this.libraryTopicsRunId === runId && this.libraryTopics !== null
        ? this.libraryTopics
        : await this.refreshLibraryTopics(true);
    if (this.closed || this.snapshot.run?.id !== runId) return;
    topics = topics ?? [];

    if (topics.length === 0) {
      this.activeLibraryReader = null;
      this.graphCache = undefined;
      this.setFeedback("info", "Shared Library has no .md topics yet.");
      return;
    }

    const currentTopic = this.activeLibraryReader?.topic;
    const curIdx = currentTopic ? topics.indexOf(currentTopic) : -1;
    const nextIdx = curIdx + 1;
    if (curIdx >= 0 && nextIdx >= topics.length) {
      // Cycling past the last topic returns cleanly to the full Contract overview
      this.activeLibraryReader = null;
      this.graphScrollOffset = 0;
      this.graphCache = undefined;
      this.feedback = undefined;
      this.tui.requestRender();
      return;
    }

    const targetTopic = topics[nextIdx >= 0 ? nextIdx : 0]!;
    const reqId = ++this.libraryRequestId;
    this.activeLibraryReader = {
      topic: targetTopic,
      content: "",
      loading: true,
    };
    this.graphScrollOffset = 0;
    this.graphCache = undefined;
    this.feedback = undefined;
    this.tui.requestRender();

    try {
      const res = await this.engine.manageMission({
        op: "read_library",
        libraryTopic: targetTopic,
        callerRole: "human",
        callerName: "human",
      });
      if (
        this.closed ||
        this.snapshot.run?.id !== runId ||
        reqId !== this.libraryRequestId
      ) {
        return;
      }
      if (res.libraryTopics) {
        this.libraryTopics = res.libraryTopics
          .map(normalizeOverlayLibraryTopic)
          .filter(Boolean);
        this.libraryTopicsRunId = runId;
      }
      this.activeLibraryReader = {
        topic: targetTopic,
        content: res.libraryContent ?? "",
        loading: false,
      };
      this.graphCache = undefined;
      this.tui.requestRender();
    } catch (err) {
      if (
        this.closed ||
        this.snapshot.run?.id !== runId ||
        reqId !== this.libraryRequestId
      ) {
        return;
      }
      this.activeLibraryReader = {
        topic: targetTopic,
        content: "",
        loading: false,
        error: formatErrorMessage(err),
      };
      this.graphCache = undefined;
      this.tui.requestRender();
    }
  }

  private hasWorkingMembers(): boolean {
    const run = this.snapshot.run;
    if (!run || isTerminalRunStatus(run.status)) return false;
    return countOverlayFleetStates(this.snapshot, run).workingCount > 0;
  }

  private syncSpinnerTimer(hasWorking: boolean): void {
    if (this.closed) {
      this.stopSpinnerTimer();
      return;
    }
    if (hasWorking && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        if (this.closed) {
          this.stopSpinnerTimer();
          return;
        }
        this.spinnerFrame =
          (this.spinnerFrame + 1) % OVERLAY_SPINNER_FRAMES.length;
        if (!this.subComponent) {
          this.tui.requestRender();
        }
      }, this.spinnerIntervalMs);
      if (typeof this.spinnerTimer.unref === "function") {
        this.spinnerTimer.unref();
      }
    } else if (!hasWorking && this.spinnerTimer) {
      this.stopSpinnerTimer();
    }
  }

  private stopSpinnerTimer(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.subComponent && "focused" in this.subComponent) {
      this.subComponent.focused = value;
    }
    this.syncInputFocus();
  }

  private buildInlineInput(prompt: string, placeholder: string): Input {
    const input = new Input({
      prompt,
      placeholder,
      placeholderStyle: (t) => this.theme.fg("dim", t),
    });

    input.onSubmit = (value) => {
      this.handleInlineSubmit(value);
    };

    input.onEscape = () => {
      this.exitInlineMode();
      this.tui.requestRender();
    };

    return input;
  }

  private syncInputFocus(): void {
    const inlineActive = this.inlineMode !== undefined;
    const searchActive =
      !inlineActive && this.activeTab === "search" && this.searchFocused;

    this.inlineInput.focused = this._focused && inlineActive;
    this.searchInput.focused = this._focused && searchActive;

    const wantsCursor = inlineActive || searchActive;
    this.hwCursor.sync(this.tui, this._focused && wantsCursor);
  }

  private enterInlineMode(
    mode: InlineInputMode,
    prompt: string,
    placeholder: string,
    initialValue = "",
  ): void {
    this.searchFocused = false;
    this.inlineMode = mode;
    this.inlineInput = this.buildInlineInput(prompt, placeholder);
    if (initialValue) {
      this.inlineInput.setValue(initialValue);
    }
    this.feedback = undefined;
    this.syncInputFocus();
  }

  private exitInlineMode(): void {
    this.inlineMode = undefined;
    this.syncInputFocus();
  }

  private setSearchFocused(active: boolean): void {
    this.searchFocused = active;
    this.syncInputFocus();
  }

  private switchTab(tab: SwarmOverlayTab): void {
    if (this.activeTab === tab) return;
    this.exitInlineMode();
    this.pendingKillConfirm = undefined;
    this.expandedPost = null;
    this.activeTab = tab;
    this.feedback = undefined;
    if (tab === "search") {
      this.setSearchFocused(true);
    } else {
      this.setSearchFocused(false);
    }
    if (tab === "graph" && this.graphViewMode === "contract") {
      void this.refreshLibraryTopics();
    }
    this.clampSelections();
  }

  private cycleTab(delta: number): void {
    const curIdx = TAB_ORDER.indexOf(this.activeTab);
    const nextIdx = (curIdx + delta + TAB_ORDER.length) % TAB_ORDER.length;
    this.switchTab(TAB_ORDER[nextIdx]!);
  }

  private mergeBoardMessages(incoming: readonly BoardMessage[]): boolean {
    if (incoming.length === 0) return false;
    const bySeq = new Map<number, BoardMessage>();
    for (const msg of this.boardMessages) {
      bySeq.set(msg.seq, msg);
    }
    let changed = false;
    for (const msg of incoming) {
      const existing = bySeq.get(msg.seq);
      if (!existing || existing.text !== msg.text || existing.kind !== msg.kind) {
        changed = true;
      }
      bySeq.set(msg.seq, msg);
    }
    if (changed) {
      this.boardMessages = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
    }
    return changed;
  }

  private async refreshFullBoard(): Promise<void> {
    const runId = this.snapshot.run?.id;
    if (this.closed || !runId) return;
    if (this.boardRefreshInFlight) {
      this.boardRefreshPending = true;
      return;
    }
    this.boardRefreshInFlight = true;
    try {
      const res = await this.engine.readBoard({ channel: "*", limit: 500 });
      if (this.closed || this.snapshot.run?.id !== runId) return;
      this.lastBoardRefreshRunId = runId;
      this.lastBoardRefreshHead = Math.max(
        res.head ?? 0,
        this.snapshot.boardHead,
      );
      const prevLen = this.getFilteredBoardMessages().length;
      const wasAtLatest = prevLen === 0 || this.boardSelectedIndex >= prevLen - 1;
      const changed = this.mergeBoardMessages(res.messages);
      if (changed) {
        const nextLen = this.getFilteredBoardMessages().length;
        if (wasAtLatest && nextLen > 0) {
          this.boardSelectedIndex = nextLen - 1;
        }
        this.clampSelections();
        this.tui.requestRender();
      }
    } catch {
      // Fall back silently to snapshot.recentBoard
    } finally {
      this.boardRefreshInFlight = false;
      if (this.boardRefreshPending && !this.closed) {
        this.boardRefreshPending = false;
        void this.refreshFullBoard();
      }
    }
  }

  private getChannelFilterOptions(): string[] {
    const set = new Set<string>([DEFAULT_CHANNEL]);
    const run = this.snapshot.run;
    if (run) {
      for (const name of Object.keys(run.channels)) {
        if (name) set.add(name);
      }
    }
    for (const msg of this.boardMessages) {
      if (msg.channel) set.add(msg.channel);
    }
    const sorted = Array.from(set).sort((a, b) => {
      if (a === DEFAULT_CHANNEL && b !== DEFAULT_CHANNEL) return -1;
      if (b === DEFAULT_CHANNEL && a !== DEFAULT_CHANNEL) return 1;
      return a.localeCompare(b);
    });
    return ["*", ...sorted];
  }

  private getFilteredBoardMessages(): BoardMessage[] {
    if (this.channelFilter === "*") {
      return this.boardMessages;
    }
    return this.boardMessages.filter(
      (m) => (m.channel || DEFAULT_CHANNEL) === this.channelFilter,
    );
  }

  private getSearchMatches(): BoardMessage[] {
    if (!this.searchQuery.trim()) {
      return this.boardMessages;
    }
    return this.boardMessages.filter((m) =>
      matchesSearchQuery(m, this.searchQuery),
    );
  }

  private getMembers(): SwarmMemberRecord[] {
    const run = this.snapshot.run;
    return run ? getOrderedMembers(run) : [];
  }

  private getSelectedMember(): SwarmMemberRecord | undefined {
    const members = this.getMembers();
    if (members.length === 0) return undefined;
    return members[Math.min(this.memberSelectedIndex, members.length - 1)];
  }

  private clampSelections(): void {
    const boardList = this.getFilteredBoardMessages();
    if (boardList.length === 0) {
      this.boardSelectedIndex = 0;
    } else if (this.boardSelectedIndex >= boardList.length) {
      this.boardSelectedIndex = boardList.length - 1;
    } else if (this.boardSelectedIndex < 0) {
      this.boardSelectedIndex = 0;
    }

    const members = this.getMembers();
    if (members.length === 0) {
      this.memberSelectedIndex = 0;
    } else if (this.memberSelectedIndex >= members.length) {
      this.memberSelectedIndex = members.length - 1;
    } else if (this.memberSelectedIndex < 0) {
      this.memberSelectedIndex = 0;
    }

    const matches = this.getSearchMatches();
    if (matches.length === 0) {
      this.searchSelectedIndex = 0;
    } else if (this.searchSelectedIndex >= matches.length) {
      this.searchSelectedIndex = matches.length - 1;
    } else if (this.searchSelectedIndex < 0) {
      this.searchSelectedIndex = 0;
    }
  }

  private setFeedback(kind: FeedbackMessage["kind"], text: string): void {
    this.feedback = { kind, text: sanitizePlainText(text) };
    if (!this.closed) {
      this.tui.requestRender();
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.done();
  }

  dispose(): void {
    this.closed = true;
    this.stopSpinnerTimer();
    this.subComponent?.dispose?.();
    this.subComponent = null;
    this.inlineMode = undefined;
    this.searchFocused = false;
    this.pendingKillConfirm = undefined;
    this.expandedPost = null;
    this.inlineInput.focused = false;
    this.searchInput.focused = false;
    this.hwCursor.restore(this.tui);
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  invalidate(): void {
    this.graphCache = undefined;
    this.inlineInput.invalidate();
    this.searchInput.invalidate();
    this.subComponent?.invalidate();
  }

  // ==========================================================================
  // Actions (Board post, Wake, Model Switch, Stop, Kill, Merge, Diff)
  // ==========================================================================

  private handleInlineSubmit(rawValue: string): void {
    const mode = this.inlineMode;
    if (!mode) return;
    const trimmed = rawValue.trim();
    if (!trimmed) {
      this.setFeedback("warning", "Input cannot be empty (press Esc to cancel).");
      return;
    }
    this.exitInlineMode();

    if (mode.kind === "board_post") {
      void this.runBoardPost(trimmed, mode.channel);
      return;
    }
    if (mode.kind === "wake") {
      void this.runWakeMember(mode.member, trimmed);
      return;
    }
    if (mode.kind === "model") {
      void this.runSwitchModel(mode.member, trimmed);
    }
  }

  private async runBoardPost(text: string, channel: string): Promise<void> {
    const expectedRunId = this.currentRunId;
    try {
      const posted = await this.engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text,
        channel,
        kind: "chat",
      });
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.snapshot = this.engine.getSnapshot();
      this.mergeBoardMessages([posted]);
      const filtered = this.getFilteredBoardMessages();
      const idx = filtered.findIndex((m) => m.seq === posted.seq);
      if (idx >= 0) this.boardSelectedIndex = idx;
      this.setFeedback("success", `Posted #${posted.seq} to #${posted.channel}.`);
    } catch (err) {
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.setFeedback("error", `Board post failed: ${formatErrorMessage(err)}`);
    }
  }

  private async runWakeMember(
    member: SwarmMemberRecord,
    message: string,
  ): Promise<void> {
    const expectedRunId = this.currentRunId;
    try {
      if (typeof this.engine.steerMember === "function") {
        const res = await this.engine.steerMember(member.name, message, "steer", {
          callerName: ORCHESTRATOR_NAME,
          callerRole: "human",
        });
        if (this.closed || this.currentRunId !== expectedRunId) return;
        this.snapshot = this.engine.getSnapshot();
        this.mergeBoardMessages(this.snapshot.recentBoard);
        if (res.delivery === "steered") {
          this.setFeedback("success", `Steered @${member.name} mid-turn.`);
        } else if (res.delivery === "followUp") {
          this.setFeedback("success", `Queued follow-up for @${member.name}.`);
        } else {
          this.setFeedback(
            "success",
            `Woke @${member.name} via #${member.channels[0] || DEFAULT_CHANNEL}.`,
          );
        }
        return;
      }

      const mentionTag = `@${member.name}`;
      const text = message.includes(mentionTag)
        ? message
        : `${mentionTag} ${message}`;
      const channel = member.channels[0] || DEFAULT_CHANNEL;
      const posted = await this.engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text,
        channel,
        kind: "chat",
      });
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.snapshot = this.engine.getSnapshot();
      this.mergeBoardMessages([posted]);
      this.setFeedback(
        "success",
        `Sent #${posted.seq} to @${member.name} on #${posted.channel}.`,
      );
    } catch (err) {
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.setFeedback(
        "error",
        `Failed to message @${member.name}: ${formatErrorMessage(err)}`,
      );
    }
  }

  private isConflictFailure(member: SwarmMemberRecord): boolean {
    const recentErrEvents = this.snapshot.recentEvents
      .filter(
        (e) =>
          e.memberName === member.name &&
          (e.type === "member_error" ||
            e.summary.toLowerCase().includes("conflict")),
      )
      .slice(-3)
      .map((e) => e.summary);
    const haystack = [
      member.error ?? "",
      member.parkedOn ?? "",
      ...member.logTail.slice(-5),
      ...recentErrEvents,
    ]
      .join(" ")
      .toLowerCase();
    return /(?:rebase|merge)[_\s-]*conflict|conflicting files|resolve conflicts?/i.test(
      haystack,
    );
  }

  private handleRetryMember(member: SwarmMemberRecord): void {
    if (member.state === "killed") {
      this.setFeedback("warning", `Cannot retry killed member ${member.name}.`);
      return;
    }
    if (member.state === "working") {
      this.setFeedback(
        "info",
        `${member.name} is already working (press [w] to steer).`,
      );
      return;
    }
    if (member.state !== "stopped" && !member.error) {
      this.setFeedback(
        "info",
        `${member.name} is waiting without errors (press [w] to wake).`,
      );
      return;
    }

    if (this.isConflictFailure(member)) {
      const baseBranch = sanitizePlainText(this.snapshot.run?.baseBranch || "main");
      const prefill = `Rebase onto ${baseBranch} and resolve conflicts, then re-verify and post status.`;
      this.enterInlineMode(
        { kind: "wake", member, conflictRetry: true },
        "› ",
        `Steer @${member.name} to resolve conflicts…`,
        prefill,
      );
      this.tui.requestRender();
      return;
    }

    const retryMsg = member.error
      ? `Retry and continue your assignment after previous error (${sanitizePlainText(member.error).slice(0, 140)}). Inspect workspace and board state, then post progress.`
      : "Resume your assignment from current workspace and board state, then post progress.";
    void this.runWakeMember(member, retryMsg);
  }

  private async runTogglePauseResume(): Promise<void> {
    const run = this.snapshot.run;
    if (!run) return;
    const expectedRunId = this.currentRunId;
    try {
      if (run.status === "paused") {
        await this.engine.resume(run.id, this.ctx);
        if (this.closed || this.currentRunId !== expectedRunId) return;
        this.snapshot = this.engine.getSnapshot();
        this.setFeedback("success", `Resumed Swarm ${run.id}.`);
      } else if (run.status === "active") {
        await this.engine.pause(run.id, "Paused by user via Mission Control");
        if (this.closed || this.currentRunId !== expectedRunId) return;
        this.snapshot = this.engine.getSnapshot();
        this.setFeedback("warning", `Paused Swarm ${run.id}.`);
      } else {
        this.setFeedback("info", `Swarm ${run.id} is already ${run.status}.`);
      }
    } catch (err) {
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.setFeedback("error", `Pause/resume failed: ${formatErrorMessage(err)}`);
    }
  }

  private buildModelPickerState(): ModelPickerSettingsState {
    if (this.options?.getModelSettingsState) {
      return this.options.getModelSettingsState();
    }
    const run = this.snapshot.run;
    return {
      settings: {
        ...DEFAULT_SWARM_SETTINGS,
        orchestratorModel: run?.roleModels?.orchestrator?.model,
        orchestratorThinkingLevel: run?.roleModels?.orchestrator?.thinkingLevel,
        workerModel: run?.roleModels?.worker?.model,
        workerThinkingLevel: run?.roleModels?.worker?.thinkingLevel,
        validatorModel: run?.roleModels?.validator?.model,
        validatorThinkingLevel: run?.roleModels?.validator?.thinkingLevel,
        fallbackModels: [...(run?.roleModels?.fallbackModels ?? [])],
        maxConcurrency: run?.maxConcurrency ?? DEFAULT_SWARM_SETTINGS.maxConcurrency,
        validatorEnabled: run?.validatorEnabled ?? DEFAULT_SWARM_SETTINGS.validatorEnabled,
        keepWorkersWarm: run?.keepWorkersWarm ?? DEFAULT_SWARM_SETTINGS.keepWorkersWarm,
      },
      hostModel: this.hostModel,
    };
  }

  private openMissionModelsPicker(): void {
    const baseState = this.buildModelPickerState();
    const picker = new SwarmModelPickerView(this.tui, this.theme, {
      mode: "roles",
      initialScope: this.options?.initialScope ?? "global",
      state: baseState,
      availableModels: this.options?.availableModels ?? [],
      onApplyRole: this.options?.onApplyRoleModel,
      onApplyFallbacks: this.options?.onApplyFallbacks,
      onClose: (res) => {
        this.subComponent = null;
        if (!this.closed) {
          this.snapshot = this.engine.getSnapshot();
          if (res?.changed) {
            this.setFeedback("success", "Updated Swarm Mission models.");
          }
          this.tui.requestRender();
        }
      },
    });
    picker.focused = this._focused;
    this.subComponent = picker;
    this.tui.requestRender();
  }

  private openMemberModelPicker(member: SwarmMemberRecord): void {
    const baseState = this.buildModelPickerState();
    const picker = new SwarmModelPickerView(this.tui, this.theme, {
      mode: "member",
      member,
      state: baseState,
      availableModels: this.options?.availableModels ?? [],
      onApplyMember: async (sel) => {
        const expectedRunId = this.currentRunId;
        const result = await this.engine.switchModel({
          targetName: sel.memberName,
          model: sel.model,
          thinkingLevel: sel.thinkingLevel,
          reason: "Hot-switched by user via Swarm overlay",
          callerName: ORCHESTRATOR_NAME,
          callerRole: "human",
          deferIfWorking: true,
          autoResume: false,
          hostContext: this.ctx,
        });
        if (!this.closed && this.currentRunId === expectedRunId) {
          this.snapshot = this.engine.getSnapshot();
          const suffix = result.thinkingLevel ? ` (${result.thinkingLevel})` : "";
          const actionMsg = result.deferred
            ? `Queued switch for @${sel.memberName} -> ${result.model}${suffix} at turn end.`
            : `Switched @${sel.memberName} to ${result.model}${suffix}.`;
          this.setFeedback("success", actionMsg);
        }
      },
      onClose: () => {
        this.subComponent = null;
        if (!this.closed) {
          this.tui.requestRender();
        }
      },
    });
    picker.focused = this._focused;
    this.subComponent = picker;
    this.tui.requestRender();
  }

  private async runSwitchModel(
    member: SwarmMemberRecord,
    rawInput: string,
  ): Promise<void> {
    const { model, thinkingLevel } = parseModelAndThinking(rawInput);
    const expectedRunId = this.currentRunId;
    try {
      const result = await this.engine.switchModel({
        targetName: member.name,
        model,
        thinkingLevel,
        reason: "Hot-switched by user via Swarm overlay",
        callerName: ORCHESTRATOR_NAME,
        callerRole: "human",
        deferIfWorking: true,
        autoResume: false,
        hostContext: this.ctx,
      });
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.snapshot = this.engine.getSnapshot();
      const suffix = result.thinkingLevel ? ` (${result.thinkingLevel})` : "";
      const actionMsg = result.deferred
        ? `Queued switch for ${member.name} -> ${result.model}${suffix} at turn end.`
        : `Switched ${member.name} to ${result.model}${suffix}.`;
      this.setFeedback("success", actionMsg);
    } catch (err) {
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.setFeedback(
        "error",
        `Model switch failed for ${member.name}: ${formatErrorMessage(err)}`,
      );
    }
  }

  private async runStopMember(member: SwarmMemberRecord): Promise<void> {
    if (member.state === "killed") {
      this.setFeedback("warning", `${member.name} is already killed.`);
      return;
    }
    const expectedRunId = this.currentRunId;
    try {
      await this.engine.stopMember(member.name, {
        humanStopped: true,
        reason: "Stopped by user via Swarm overlay",
        callerName: ORCHESTRATOR_NAME,
        callerRole: "human",
      });
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.snapshot = this.engine.getSnapshot();
      this.setFeedback("warning", `Stopped ${member.name} (human-stopped).`);
    } catch (err) {
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.setFeedback(
        "error",
        `Stop failed for ${member.name}: ${formatErrorMessage(err)}`,
      );
    }
  }

  private async runKillMember(
    member: SwarmMemberRecord,
    force = false,
  ): Promise<void> {
    if (member.state === "killed") {
      this.setFeedback("warning", `${member.name} is already killed.`);
      return;
    }
    const expectedRunId = this.currentRunId;
    try {
      await this.engine.killMember(member.name, {
        force,
        reason: "Killed by user",
        callerName: ORCHESTRATOR_NAME,
        callerRole: "human",
      });
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.snapshot = this.engine.getSnapshot();
      this.setFeedback(
        "warning",
        `Killed ${member.name} permanently${force ? " (force)" : ""}.`,
      );
    } catch (err) {
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.setFeedback(
        "error",
        `Kill failed for ${member.name}: ${formatErrorMessage(err)}`,
      );
    }
  }

  private async runMergeMember(member: SwarmMemberRecord): Promise<void> {
    if (member.workspace === "inherit" && !member.branch) {
      this.setFeedback(
        "warning",
        `${member.name} uses inherit workspace (no isolated branch to merge).`,
      );
      return;
    }
    const expectedRunId = this.currentRunId;
    try {
      const merged = await this.engine.mergeMember(member.name, {
        callerName: ORCHESTRATOR_NAME,
        callerRole: "human",
      });
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.snapshot = this.engine.getSnapshot();
      if (merged) {
        this.setFeedback(
          "success",
          `Merged ${member.name} (${merged.strategy}, ${merged.mergedCommitSha.slice(0, 8)}).`,
        );
      } else {
        this.setFeedback("info", `Nothing to merge for ${member.name}.`);
      }
    } catch (err) {
      if (this.closed || this.currentRunId !== expectedRunId) return;
      this.setFeedback(
        "error",
        `Merge failed for ${member.name}: ${formatErrorMessage(err)}`,
      );
    }
  }

  private toggleMemberDiff(member: SwarmMemberRecord): void {
    const run = this.snapshot.run;
    if (!run) return;

    if (
      this.memberDetailMode === "diff" &&
      this.diffState?.memberName === member.name
    ) {
      this.memberDetailMode = "info";
      this.tui.requestRender();
      return;
    }

    if (member.workspace === "inherit" && !member.branch) {
      this.setFeedback(
        "warning",
        `${member.name} uses inherit workspace; no isolated worktree diff.`,
      );
      return;
    }
    if (!member.branch) {
      this.setFeedback(
        "warning",
        `${member.name} has no git branch recorded for diff.`,
      );
      return;
    }
    if (!this.worktree) {
      this.setFeedback("warning", "Git worktree manager unavailable.");
      return;
    }

    this.memberDetailMode = "diff";
    this.feedback = undefined;
    const reqId = ++this.diffRequestId;
    this.diffState = {
      memberName: member.name,
      branch: member.branch,
      loading: true,
    };
    this.tui.requestRender();

    void this.worktree
      .getDiffSummary(run.baseBranch, member.branch, {
        cwd: member.cwd || undefined,
      })
      .then((summary) => {
        if (this.closed || reqId !== this.diffRequestId) return;
        this.diffState = {
          memberName: member.name,
          branch: member.branch!,
          loading: false,
          summary,
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed || reqId !== this.diffRequestId) return;
        this.diffState = {
          memberName: member.name,
          branch: member.branch!,
          loading: false,
          error: formatErrorMessage(err),
        };
        this.tui.requestRender();
      });
  }

  // ==========================================================================
  // Input Handling
  // ==========================================================================

  handleInput(data: string): void {
    if (this.closed || isKeyReleaseSafe(data)) return;

    if (this.subComponent) {
      this.subComponent.handleInput?.(data);
      return;
    }

    // 1. Inline IME action input (Board [p] post, Members [w] wake / [m] model)
    if (this.inlineMode) {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.close();
        return;
      }
      const norm = normalizeEditorInput(data);
      if (norm) {
        this.inlineInput.handleInput(norm);
        this.tui.requestRender();
      }
      return;
    }

    // 2. Live Search IME input on Tab 4
    if (this.activeTab === "search" && this.searchFocused) {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.close();
        return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        this.cycleTab(-1);
        this.tui.requestRender();
        return;
      }
      if (isTabKey(data)) {
        this.cycleTab(1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.up)) {
        const matches = this.getSearchMatches();
        if (matches.length > 0) {
          this.searchSelectedIndex =
            (this.searchSelectedIndex - 1 + matches.length) % matches.length;
          this.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.down)) {
        const matches = this.getSearchMatches();
        if (matches.length > 0) {
          this.searchSelectedIndex =
            (this.searchSelectedIndex + 1) % matches.length;
          this.tui.requestRender();
        }
        return;
      }
      const norm = normalizeEditorInput(data);
      if (!norm) return;
      this.searchInput.handleInput(norm);
      const nextQuery = this.searchInput.getValue();
      if (nextQuery !== this.searchQuery) {
        this.searchQuery = nextQuery;
        this.searchSelectedIndex = 0;
        this.clampSelections();
      }
      this.tui.requestRender();
      return;
    }

    // 3. Global close & tab-switch shortcuts
    const ch = decodePrintableInput(data);

    // 2.5. Inline [k] kill confirmation on Members tab
    if (this.pendingKillConfirm) {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.close();
        return;
      }
      if (ch === "f" || ch === "F") {
        this.pendingKillConfirm.force = !this.pendingKillConfirm.force;
        this.tui.requestRender();
        return;
      }
      if (ch === "y" || ch === "Y" || matchesKey(data, Key.enter)) {
        const { memberName, force } = this.pendingKillConfirm;
        this.pendingKillConfirm = undefined;
        const target =
          this.getMembers().find((m) => m.name === memberName) ??
          this.getSelectedMember();
        if (target) {
          void this.runKillMember(target, force);
        }
        this.tui.requestRender();
        return;
      }
      if (ch === "n" || ch === "N" || isEscapeKey(data)) {
        this.pendingKillConfirm = undefined;
        this.tui.requestRender();
        return;
      }
      // Navigation or tab keys cancel pending kill confirmation and proceed normally
      this.pendingKillConfirm = undefined;
    }

    // 2.6. Expanded multi-line post reader on Board [1] or Search [4]
    if (this.expandedPost && this.expandedPost.tab === this.activeTab) {
      if (matchesKey(data, Key.ctrl("c")) || ch === "q" || ch === "Q") {
        this.close();
        return;
      }
      if (isEscapeKey(data) || matchesKey(data, Key.enter)) {
        this.expandedPost = null;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.up) || ch === "k") {
        this.expandedPost.scrollOffset = Math.max(
          0,
          this.expandedPost.scrollOffset - 1,
        );
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || ch === "j") {
        this.expandedPost.scrollOffset += 1;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.pageUp) || ch === "[" || ch === "b") {
        this.expandedPost.scrollOffset = Math.max(
          0,
          this.expandedPost.scrollOffset - 5,
        );
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.pageDown) || ch === "]" || ch === " ") {
        this.expandedPost.scrollOffset += 5;
        this.tui.requestRender();
        return;
      }
      if (ch === "g" || matchesKey(data, Key.home)) {
        this.expandedPost.scrollOffset = 0;
        this.tui.requestRender();
        return;
      }
      if (ch === "G" || matchesKey(data, Key.end)) {
        this.expandedPost.scrollOffset += 1_000;
        this.tui.requestRender();
        return;
      }
      if (
        ch === "1" || ch === "2" || ch === "3" || ch === "4" ||
        isTabKey(data) || matchesKey(data, Key.shift("tab")) ||
        ch === "?" || ch === "M" || ch === "P"
      ) {
        this.expandedPost = null;
      } else {
        // Never leak other keys (such as 'c' channel cycle or 'p' post) to list behind expandedPost
        return;
      }
    }

    if (this.showHelp) {
      if (matchesKey(data, Key.ctrl("c")) || ch === "q" || ch === "Q") {
        this.close();
        return;
      }
      if (
        isEscapeKey(data) ||
        matchesKey(data, Key.enter) ||
        ch === "?"
      ) {
        this.showHelp = false;
        this.tui.requestRender();
      }
      return;
    }

    if (
      isEscapeKey(data) &&
      this.activeTab === "graph" &&
      this.graphViewMode === "contract" &&
      this.activeLibraryReader !== null
    ) {
      this.activeLibraryReader = null;
      this.graphScrollOffset = 0;
      this.graphCache = undefined;
      this.tui.requestRender();
      return;
    }

    if (
      isEscapeKey(data) ||
      matchesKey(data, Key.ctrl("c")) ||
      ch === "q" ||
      ch === "Q"
    ) {
      this.close();
      return;
    }

    if (ch === "?") {
      this.showHelp = true;
      this.tui.requestRender();
      return;
    }

    if (ch === "M" && (this.options?.onApplyRoleModel || this.options?.getModelSettingsState)) {
      this.openMissionModelsPicker();
      return;
    }

    if (ch === "P") {
      void this.runTogglePauseResume();
      return;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      this.cycleTab(-1);
      this.tui.requestRender();
      return;
    }
    if (isTabKey(data)) {
      this.cycleTab(1);
      this.tui.requestRender();
      return;
    }

    if (ch === "1") {
      this.switchTab("board");
      this.tui.requestRender();
      return;
    }
    if (ch === "2") {
      this.switchTab("members");
      this.tui.requestRender();
      return;
    }
    if (ch === "3") {
      this.switchTab("graph");
      this.tui.requestRender();
      return;
    }
    if (ch === "4") {
      this.switchTab("search");
      this.tui.requestRender();
      return;
    }

    // 4. Tab-specific controls
    if (this.activeTab === "board") {
      this.handleBoardTabInput(data, ch);
      return;
    }
    if (this.activeTab === "members") {
      this.handleMembersTabInput(data, ch);
      return;
    }
    if (this.activeTab === "graph") {
      this.handleGraphTabInput(data, ch);
      return;
    }
    if (this.activeTab === "search") {
      this.handleSearchTabNavigationInput(data, ch);
    }
  }

  private handleBoardTabInput(data: string, ch: string | undefined): void {
    const messages = this.getFilteredBoardMessages();

    if (matchesKey(data, Key.up) || ch === "k") {
      if (messages.length > 0) {
        this.boardSelectedIndex = Math.max(0, this.boardSelectedIndex - 1);
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down) || ch === "j") {
      if (messages.length > 0) {
        this.boardSelectedIndex = Math.min(
          messages.length - 1,
          this.boardSelectedIndex + 1,
        );
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.boardSelectedIndex = Math.max(0, this.boardSelectedIndex - 5);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.boardSelectedIndex = Math.min(
        Math.max(0, messages.length - 1),
        this.boardSelectedIndex + 5,
      );
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = messages[this.boardSelectedIndex];
      if (selected) {
        this.expandedPost = { tab: "board", seq: selected.seq, scrollOffset: 0 };
        this.tui.requestRender();
      }
      return;
    }

    if (ch === "c" || ch === "C") {
      const filters = this.getChannelFilterOptions();
      const curIdx = filters.indexOf(this.channelFilter);
      this.channelFilter = filters[(curIdx + 1) % filters.length] ?? "*";
      const nextMsgs = this.getFilteredBoardMessages();
      this.boardSelectedIndex = Math.max(0, nextMsgs.length - 1);
      this.feedback = undefined;
      this.tui.requestRender();
      return;
    }

    if (ch === "p") {
      const targetChannel =
        this.channelFilter === "*" ? DEFAULT_CHANNEL : this.channelFilter;
      this.enterInlineMode(
        { kind: "board_post", channel: targetChannel },
        "› ",
        `Post to #${targetChannel} as ${ORCHESTRATOR_NAME} (@member to wake)…`,
      );
      this.tui.requestRender();
    }
  }

  private handleMembersTabInput(data: string, ch: string | undefined): void {
    const members = this.getMembers();
    const selected = this.getSelectedMember();

    if (matchesKey(data, Key.up) || ch === "k") {
      if (members.length > 0) {
        this.memberSelectedIndex =
          (this.memberSelectedIndex - 1 + members.length) % members.length;
        this.memberDetailMode = "info";
        this.memberDetailScrollOffset = 0;
        this.diffRequestId += 1;
        this.feedback = undefined;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down) || ch === "j") {
      if (members.length > 0) {
        this.memberSelectedIndex =
          (this.memberSelectedIndex + 1) % members.length;
        this.memberDetailMode = "info";
        this.memberDetailScrollOffset = 0;
        this.diffRequestId += 1;
        this.feedback = undefined;
        this.tui.requestRender();
      }
      return;
    }

    if (!selected) return;

    if (
      (this.memberDetailMode === "logs" || this.memberDetailMode === "diff") &&
      (ch === "[" ||
        ch === "]" ||
        matchesKey(data, Key.pageUp) ||
        matchesKey(data, Key.pageDown))
    ) {
      const step =
        matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) ? 5 : 3;
      if (ch === "[" || matchesKey(data, Key.pageUp)) {
        this.memberDetailScrollOffset = Math.max(
          0,
          this.memberDetailScrollOffset - step,
        );
      } else {
        this.memberDetailScrollOffset += step;
      }
      this.tui.requestRender();
      return;
    }

    if (ch === "r" || ch === "R") {
      this.handleRetryMember(selected);
      return;
    }

    if (ch === "w" || ch === "W") {
      if (selected.state === "killed") {
        this.setFeedback("warning", `Cannot message killed member ${selected.name}.`);
        return;
      }
      this.enterInlineMode(
        { kind: "wake", member: selected },
        "› ",
        `Message @${selected.name}…`,
      );
      this.tui.requestRender();
      return;
    }

    if (ch === "m") {
      if (selected.state === "killed") {
        this.setFeedback("warning", `Cannot switch model on killed member ${selected.name}.`);
        return;
      }
      if ((this.options?.availableModels?.length ?? 0) > 0) {
        this.openMemberModelPicker(selected);
        return;
      }
      this.enterInlineMode(
        { kind: "model", member: selected },
        "› ",
        selected.state === "working"
          ? `Queue turn-end model for ${selected.name} (e.g. openai/gpt-5.4:high)…`
          : `New model for ${selected.name} (e.g. openai/gpt-5.4:high)…`,
      );
      this.tui.requestRender();
      return;
    }

    if (ch === "x" || ch === "X") {
      void this.runStopMember(selected);
      return;
    }

    if (ch === "K") {
      if (selected.state === "killed") {
        this.setFeedback("warning", `${selected.name} is already killed.`);
        return;
      }
      this.pendingKillConfirm = { memberName: selected.name, force: false };
      this.feedback = undefined;
      this.tui.requestRender();
      return;
    }

    if (ch === "g") {
      void this.runMergeMember(selected);
      return;
    }

    if (
      ch === "l" ||
      ch === "L" ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.return)
    ) {
      this.memberDetailMode = this.memberDetailMode === "logs" ? "info" : "logs";
      this.memberDetailScrollOffset = 0;
      this.feedback = undefined;
      this.tui.requestRender();
      return;
    }

    if (ch === "d" || ch === "D") {
      this.memberDetailScrollOffset = 0;
      this.toggleMemberDiff(selected);
    }
  }

  private handleGraphTabInput(data: string, ch: string | undefined): void {
    if (ch === "v" || ch === "V") {
      this.graphViewMode =
        this.graphViewMode === "contract" ? "graph" : "contract";
      this.activeLibraryReader = null;
      this.graphScrollOffset = 0;
      this.graphCache = undefined;
      if (this.graphViewMode === "contract") {
        void this.refreshLibraryTopics();
      }
      this.tui.requestRender();
      return;
    }
    if ((ch === "l" || ch === "L") && this.graphViewMode === "contract") {
      void this.handleCycleLibraryTopic();
      return;
    }
    if (matchesKey(data, Key.up) || ch === "k") {
      this.graphScrollOffset = Math.max(0, this.graphScrollOffset - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || ch === "j") {
      this.graphScrollOffset += 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp) || ch === "[") {
      this.graphScrollOffset = Math.max(0, this.graphScrollOffset - 6);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown) || ch === "]") {
      this.graphScrollOffset += 6;
      this.tui.requestRender();
      return;
    }
    if (ch === "g" || matchesKey(data, Key.home)) {
      this.graphScrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (ch === "G" || matchesKey(data, Key.end)) {
      this.graphScrollOffset += 10_000;
      this.tui.requestRender();
    }
  }

  private handleSearchTabNavigationInput(
    data: string,
    ch: string | undefined,
  ): void {
    if (ch === "/" || ch === "i" || ch === "s") {
      this.setSearchFocused(true);
      this.tui.requestRender();
      return;
    }
    const matches = this.getSearchMatches();
    if (matches.length === 0) return;
    if (matchesKey(data, Key.up) || ch === "k") {
      this.searchSelectedIndex =
        (this.searchSelectedIndex - 1 + matches.length) % matches.length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || ch === "j") {
      this.searchSelectedIndex =
        (this.searchSelectedIndex + 1) % matches.length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = matches[this.searchSelectedIndex];
      if (selected) {
        this.expandedPost = { tab: "search", seq: selected.seq, scrollOffset: 0 };
        this.tui.requestRender();
      }
    }
  }

  // ==========================================================================
  // Tab Renderers
  // ==========================================================================

  private renderTabBar(run: SwarmRunState, innerWidth: number): string {
    const boardCount = Math.max(this.snapshot.boardHead, this.boardMessages.length);
    const members = getOrderedMembers(run);
    const { workingCount } = countOverlayFleetStates(this.snapshot, run);

    const ultraCompact = innerWidth < 46;
    const compact = innerWidth < 64;
    const isContractMode = this.graphViewMode === "contract";
    const tab3Label = ultraCompact
      ? isContractMode
        ? "[3]Cnt"
        : "[3]Grp"
      : compact
        ? isContractMode
          ? "[3]Contract"
          : "[3]Graph"
        : isContractMode
          ? "[3] Contract"
          : innerWidth >= 86
            ? "[3] Graph/Contract"
            : "[3] Graph";
    const tabs: { id: SwarmOverlayTab; label: string }[] = ultraCompact
      ? [
          { id: "board", label: "[1]Brd" },
          { id: "members", label: "[2]Mem" },
          { id: "graph", label: tab3Label },
          { id: "search", label: "[4]Find" },
        ]
      : compact
        ? [
            { id: "board", label: `[1]Board(#${boardCount})` },
            { id: "members", label: `[2]Mem(${workingCount}/${members.length})` },
            { id: "graph", label: tab3Label },
            { id: "search", label: "[4]Find" },
          ]
        : [
            { id: "board", label: `[1] Board (#${boardCount})` },
            {
              id: "members",
              label: `[2] Members (${workingCount}/${members.length})`,
            },
            { id: "graph", label: tab3Label },
            { id: "search", label: "[4] Search" },
          ];

    const sep = this.theme.fg("borderMuted", ultraCompact ? " " : compact ? "|" : " | ");
    const rendered = tabs
      .map((t) =>
        t.id === this.activeTab
          ? this.theme.fg("accent", this.theme.bold(t.label))
          : this.theme.fg("muted", t.label),
      )
      .join(sep);

    return fitLine(rendered, innerWidth);
  }

  private renderBoardListRow(
    msg: BoardMessage,
    isSelected: boolean,
    innerWidth: number,
  ): string {
    const ptr = isSelected ? this.theme.fg("accent", "› ") : "  ";
    const seqStr = this.theme.fg(
      isSelected ? "accent" : "muted",
      isSelected ? this.theme.bold(`#${msg.seq}`) : `#${msg.seq}`,
    );
    const chStr = this.theme.fg("dim", `[#${sanitizePlainText(msg.channel || DEFAULT_CHANNEL)}]`);
    const fromStr = isSelected
      ? this.theme.bold(sanitizePlainText(msg.from))
      : sanitizePlainText(msg.from);
    const targets = formatTargetsSuffix(msg);
    const targetsStr = targets ? this.theme.fg("accent", targets) : "";
    const textStr = this.theme.fg("muted", sanitizePlainText(msg.text));

    if (innerWidth < 54) {
      return fitLine(`${ptr}${seqStr} ${fromStr}: ${textStr}`, innerWidth);
    }

    const clockStr = this.theme.fg("dim", formatClock(msg.timestamp));
    return fitLine(
      `${ptr}${seqStr} ${chStr} ${clockStr} ${fromStr}${targetsStr}: ${textStr}`,
      innerWidth,
    );
  }

  private renderMessagePreview(
    msg: BoardMessage,
    innerWidth: number,
    budget: number,
  ): string[] {
    if (budget <= 0) return [];
    const out: string[] = [];
    const ch = sanitizePlainText(msg.channel || DEFAULT_CHANNEL);
    const kindBadge = formatBoardKindBadge(msg.kind, this.theme);
    const targets = formatTargetsSuffix(msg);
    const metaLeft = `${this.theme.fg("accent", this.theme.bold(`#${msg.seq}`))} ${this.theme.fg("dim", `[#${ch}]`)} ${kindBadge} ${this.theme.bold(`@${sanitizePlainText(msg.from)}`)}${targets ? this.theme.fg("accent", targets) : ""}`;
    const metaRight = this.theme.fg("dim", formatClock(msg.timestamp));
    out.push(
      innerWidth >= 52
        ? joinColumns(metaLeft, metaRight, innerWidth)
        : fitLine(metaLeft, innerWidth),
    );

    const textBudget = Math.max(0, budget - out.length);
    if (textBudget > 0) {
      const wrapped = wrapLines(
        sanitizePlainText(msg.text),
        innerWidth,
        textBudget,
      );
      out.push(...wrapped.map((l) => fitLine(l, innerWidth)));
    }
    return out;
  }

  private renderExpandedPostReader(
    msg: BoardMessage,
    innerWidth: number,
    budget: number,
  ): string[] {
    if (budget <= 0) return [];
    const out: string[] = [];
    const ch = sanitizePlainText(msg.channel || DEFAULT_CHANNEL);
    const kindBadge = formatBoardKindBadge(msg.kind, this.theme);
    const targets = formatTargetsSuffix(msg);
    const metaLeft = `${this.theme.fg("accent", this.theme.bold(`#${msg.seq}`))} ${this.theme.fg("dim", `[#${ch}]`)} ${kindBadge} ${this.theme.bold(`@${sanitizePlainText(msg.from)}`)}${targets ? this.theme.fg("accent", targets) : ""}`;
    const metaRight = this.theme.fg("dim", formatClock(msg.timestamp));
    out.push(
      innerWidth >= 52
        ? joinColumns(metaLeft, metaRight, innerWidth)
        : fitLine(metaLeft, innerWidth),
    );

    if (out.length < budget) {
      out.push(
        renderHorizontalRule(
          innerWidth,
          `Full Post #${msg.seq} [Enter/Esc: back]`,
          this.theme,
        ),
      );
    }

    const bodyBudget = Math.max(0, budget - out.length);
    if (bodyBudget > 0 && this.expandedPost) {
      const bodyLines: string[] = [];
      for (const rawLine of msg.text.split(/\r?\n/)) {
        const cleanLine = sanitizeDiffLine(rawLine);
        if (cleanLine.length === 0) {
          bodyLines.push("");
        } else {
          bodyLines.push(...wrapLines(cleanLine, innerWidth));
        }
      }
      if (bodyLines.length === 0) {
        bodyLines.push(this.theme.fg("dim", "(empty message)"));
      }
      const maxOffset = Math.max(0, bodyLines.length - bodyBudget);
      this.expandedPost.scrollOffset = Math.max(
        0,
        Math.min(this.expandedPost.scrollOffset, maxOffset),
      );
      const visible = bodyLines.slice(
        this.expandedPost.scrollOffset,
        this.expandedPost.scrollOffset + bodyBudget,
      );
      out.push(...visible.map((l) => fitLine(l, innerWidth)));
    }

    return out.slice(0, budget);
  }

  private renderBoardTab(innerWidth: number, budget: number): string[] {
    if (this.expandedPost && this.expandedPost.tab === "board") {
      const targetMsg = this.boardMessages.find(
        (m) => m.seq === this.expandedPost!.seq,
      );
      if (targetMsg) {
        return this.renderExpandedPostReader(targetMsg, innerWidth, budget);
      }
      this.expandedPost = null;
    }

    const out: string[] = [];
    const messages = this.getFilteredBoardMessages();
    const filterLabel =
      this.channelFilter === "*"
        ? "Channel: * (all)"
        : `Channel: #${sanitizePlainText(this.channelFilter)}`;
    const leftHeader = `${this.theme.fg("accent", filterLabel)} (${messages.length})`;
    if (innerWidth >= 74) {
      const headerRight = this.theme.fg(
        "dim",
        "[Enter] read · [c] filter · [p] post · [↑↓] select",
      );
      out.push(joinColumns(leftHeader, headerRight, innerWidth));
    } else if (innerWidth >= 58) {
      const shortRight = this.theme.fg("dim", "[c] ch · [p] post");
      out.push(joinColumns(leftHeader, shortRight, innerWidth));
    } else {
      out.push(fitLine(leftHeader, innerWidth));
    }

    const remaining = Math.max(1, budget - out.length);
    if (messages.length === 0) {
      out.push(
        fitLine(
          this.theme.fg(
            "muted",
            this.channelFilter === "*"
              ? "  No board messages yet. Press [p] to post."
              : `  No messages in #${sanitizePlainText(this.channelFilter)}. Press [c] to switch channel.`,
          ),
          innerWidth,
        ),
      );
      return out.slice(0, budget);
    }

    const previewHeight = remaining >= 7 ? Math.min(4, Math.floor(remaining * 0.4)) : 0;
    const listBudget = Math.max(
      1,
      remaining - (previewHeight > 0 ? previewHeight + 1 : 0),
    );

    let start = 0;
    if (messages.length > listBudget) {
      start = Math.max(
        0,
        Math.min(
          this.boardSelectedIndex - Math.floor(listBudget / 2),
          messages.length - listBudget,
        ),
      );
    }
    const end = Math.min(messages.length, start + listBudget);

    for (let i = start; i < end; i++) {
      out.push(
        this.renderBoardListRow(
          messages[i]!,
          i === this.boardSelectedIndex,
          innerWidth,
        ),
      );
    }

    const selected = messages[this.boardSelectedIndex];
    if (selected && previewHeight > 0) {
      out.push(
        renderHorizontalRule(innerWidth, `Post #${selected.seq}`, this.theme),
      );
      out.push(...this.renderMessagePreview(selected, innerWidth, previewHeight));
    }

    return out.slice(0, budget);
  }

  private renderMemberRow(
    member: SwarmMemberRecord,
    isSelected: boolean,
    innerWidth: number,
  ): string {
    const ptr = isSelected ? this.theme.fg("accent", "› ") : "  ";
    const hasError = Boolean(member.error && sanitizePlainText(member.error));
    const isWorking = member.state === "working";
    const icon = isWorking
      ? this.theme.fg(
          member.recon
            ? "borderAccent"
            : member.role === "validator"
              ? "warning"
              : "accent",
          OVERLAY_SPINNER_FRAMES[this.spinnerFrame]!,
        )
      : hasError
        ? this.theme.fg("error", "✗")
        : member.state === "stopped"
          ? this.theme.fg("warning", memberStateIcon(member.state))
          : member.state === "killed"
            ? this.theme.fg("dim", memberStateIcon(member.state))
            : this.theme.fg("muted", memberStateIcon(member.state));
    const nameStr = isSelected
      ? this.theme.fg("accent", this.theme.bold(member.name))
      : member.state === "killed"
        ? this.theme.fg("dim", member.name)
        : this.theme.bold(member.name);
    const roleShort = formatOverlayRoleShortBadge(member, this.theme);
    const roleStr = member.recon
      ? this.theme.fg("borderAccent", "recon")
      : formatMemberRoleBadge(member.role, this.theme);
    const stateStr = formatMemberStateBadge(member.state, this.theme);
    const errInlineBadge = isWorking && hasError ? ` ${this.theme.fg("error", "✗")}` : "";

    if (innerWidth < 54) {
      return fitLine(
        `${ptr}${icon} ${nameStr} ${roleShort} ${stateStr}${errInlineBadge}`,
        innerWidth,
      );
    }

    const modelShort = member.model
      ? `${shortenModelName(member.model, 16)}${member.thinkingLevel ? `:${member.thinkingLevel}` : ""}`
      : member.thinkingLevel
        ? `default:${member.thinkingLevel}`
        : "default";
    const modelStr = this.theme.fg("dim", `[${modelShort}]`);
    const wsRaw = formatWorkspaceBadge(member.workspace, member.branch);
    const wsShort = wsRaw.length > 18 ? `${wsRaw.slice(0, 17)}…` : wsRaw;
    const wsStr =
      member.workspace === "inherit"
        ? this.theme.fg("dim", wsShort)
        : member.workspace === "share"
          ? this.theme.fg("accent", wsShort)
          : this.theme.fg("borderAccent", wsShort);
    const parentStr =
      member.parentName && member.parentName !== ORCHESTRATOR_NAME
        ? ` ${this.theme.fg("dim", `← ${member.parentName}`)}`
        : "";

    const liveActivity = isWorking
      ? sanitizePlainText(
          member.currentActivity ||
            (member.lastTool ? `tool:${member.lastTool}` : ""),
        )
      : "";
    const errorSnippet = hasError ? sanitizePlainText(member.error!) : "";
    const statusDetail = liveActivity
      ? ` ${this.theme.fg("dim", "·")} ${this.theme.fg("muted", liveActivity)}`
      : errorSnippet
        ? ` ${this.theme.fg("dim", "·")} ${this.theme.fg("error", errorSnippet)}`
        : "";

    const elapsedPart = isWorking
      ? `${this.theme.fg("dim", formatElapsedSince(member.turnStartedAt ?? member.createdAt, this.now()))} `
      : "";
    const rightMeta = `${elapsedPart}${this.theme.fg("muted", `t:${member.turns}`)}`;

    const wsSegment =
      innerWidth >= 82 || !statusDetail ? ` ${wsStr}${parentStr}` : "";
    const left = `${ptr}${icon} ${nameStr} ${roleShort} (${roleStr}) ${stateStr}${errInlineBadge} ${modelStr}${wsSegment}${statusDetail}`;
    return fitLine(joinColumns(left, rightMeta, innerWidth), innerWidth);
  }

  private renderMemberDetailInfo(
    member: SwarmMemberRecord,
    innerWidth: number,
    budget: number,
  ): string[] {
    if (budget <= 0) return [];
    const out: string[] = [];

    const modelLabel = member.model
      ? `${sanitizePlainText(member.model)}${member.thinkingLevel ? `(${member.thinkingLevel})` : ""}`
      : this.hostModel ?? "host default";
    const roleDetail = member.recon
      ? `${formatOverlayRoleShortBadge(member, this.theme)} ${this.theme.fg("borderAccent", "recon (read-only)")}`
      : `${formatOverlayRoleShortBadge(member, this.theme)} ${formatMemberRoleBadge(member.role, this.theme)}`;
    const meta1 = `${this.theme.fg("muted", "Role:")} ${roleDetail} · ${this.theme.fg("muted", "State:")} ${formatMemberStateBadge(member.state, this.theme)} · ${this.theme.fg("muted", "Parent:")} ${sanitizePlainText(member.parentName)} · ${this.theme.fg("muted", "Model:")} ${this.theme.fg("accent", modelLabel)}`;
    out.push(fitLine(meta1, innerWidth));

    if (out.length < budget) {
      const ws = formatWorkspaceBadge(member.workspace, member.branch, this.theme);
      const chs =
        member.channels.length > 0
          ? member.channels.map((c) => `#${sanitizePlainText(c)}`).join(", ")
          : `#${DEFAULT_CHANNEL}`;
      const usage = `${formatTokens(member.tokens)} ${formatCost(member.cost)}`;
      const mergedTag = member.mergedCommitSha
        ? ` · ${this.theme.fg("success", `merged:${member.mergedCommitSha.slice(0, 7)}`)}`
        : "";
      out.push(
        fitLine(
          `${this.theme.fg("muted", "Workspace:")} ${ws}${mergedTag} · ${this.theme.fg("muted", "Channels:")} ${chs} · ${this.theme.fg("dim", usage)}`,
          innerWidth,
        ),
      );
    }

    if (out.length < budget && (member.parkedOn || member.currentActivity || member.error)) {
      if (member.error) {
        out.push(
          fitLine(
            this.theme.fg("error", `Error: ${sanitizePlainText(member.error)}`),
            innerWidth,
          ),
        );
      } else if (member.parkedOn) {
        out.push(
          fitLine(
            `${this.theme.fg("muted", "Parked on:")} ${sanitizePlainText(member.parkedOn)}`,
            innerWidth,
          ),
        );
      } else if (member.currentActivity) {
        out.push(
          fitLine(
            `${this.theme.fg("muted", "Activity:")} ${sanitizePlainText(member.currentActivity)}`,
            innerWidth,
          ),
        );
      }
    }

    if (out.length < budget && member.brief) {
      const briefMax = Math.min(2, Math.max(1, budget - out.length - (member.logTail.length > 0 ? 1 : 0)));
      const briefLines = wrapLines(
        `${this.theme.fg("muted", "Brief: ")}${sanitizePlainText(member.brief)}`,
        innerWidth,
        briefMax,
      );
      out.push(...briefLines.map((l) => fitLine(l, innerWidth)));
    }

    // Live logTail
    const logBudget = budget - out.length;
    if (logBudget > 0 && member.logTail.length > 0) {
      const recentLogs = member.logTail.slice(-logBudget);
      for (const line of recentLogs) {
        out.push(
          fitLine(
            this.theme.fg("toolOutput", `  │ ${sanitizePlainText(line)}`),
            innerWidth,
          ),
        );
      }
    }

    return out.slice(0, budget);
  }

  private renderMemberDetailLogs(
    member: SwarmMemberRecord,
    innerWidth: number,
    budget: number,
  ): string[] {
    if (budget <= 0) return [];
    const allLines: string[] = [];

    if (member.brief) {
      allLines.push(this.theme.fg("muted", "Brief:"));
      for (const rawLine of member.brief.split(/\r?\n/)) {
        const cleanLine = sanitizeDiffLine(rawLine);
        if (!cleanLine) {
          allLines.push("");
        } else {
          allLines.push(...wrapLines(cleanLine, innerWidth));
        }
      }
    }

    if (member.parkedOn) {
      allLines.push(
        ...wrapLines(
          `${this.theme.fg("muted", "Parked on:")} ${sanitizePlainText(member.parkedOn)}`,
          innerWidth,
        ),
      );
    }

    const logHeaderIdx = allLines.length;
    allLines.push(
      this.theme.fg("muted", `Log Tail (${member.logTail.length} line(s)):`),
    );
    if (member.logTail.length === 0) {
      allLines.push(this.theme.fg("dim", "  (no log output recorded yet)"));
    } else {
      const gutter = "  │ ";
      const contentWidth = Math.max(1, innerWidth - visibleWidth(gutter));
      for (const line of member.logTail) {
        const clean = sanitizePlainText(line);
        const wrapped = clean.length > 0 ? wrapLines(clean, contentWidth) : [""];
        for (const seg of wrapped) {
          allLines.push(this.theme.fg("toolOutput", `${gutter}${seg}`));
        }
      }
    }

    const maxOffset = Math.max(0, allLines.length - budget);
    this.memberDetailScrollOffset = Math.max(
      0,
      Math.min(this.memberDetailScrollOffset, maxOffset),
    );

    if (this.memberDetailScrollOffset < maxOffset && budget >= 2) {
      const sliceCount = budget - 1;
      const visible = allLines
        .slice(this.memberDetailScrollOffset, this.memberDetailScrollOffset + sliceCount)
        .map((l) => fitLine(l, innerWidth));
      const hiddenBelow = allLines.length - (this.memberDetailScrollOffset + sliceCount);
      const logsClipped = this.memberDetailScrollOffset + sliceCount <= logHeaderIdx;
      const cue = logsClipped
        ? innerWidth >= 46
          ? `  ↓ scroll (]/PgDn) for logs (+${hiddenBelow} lines)`
          : "  ↓ scroll (]/PgDn)"
        : innerWidth >= 44
          ? `  ↓ scroll (]/PgDn) (+${hiddenBelow} more)`
          : "  ↓ scroll (]/PgDn)";
      visible.push(fitLine(this.theme.fg("accent", cue), innerWidth));
      return visible;
    }

    return allLines
      .slice(this.memberDetailScrollOffset, this.memberDetailScrollOffset + budget)
      .map((l) => fitLine(l, innerWidth));
  }

  private renderMemberDetailDiff(
    member: SwarmMemberRecord,
    innerWidth: number,
    budget: number,
  ): string[] {
    if (budget <= 0) return [];
    const ds = this.diffState;
    if (!ds || ds.memberName !== member.name || ds.loading) {
      return [
        fitLine(
          this.theme.fg("muted", `Loading git diff for ${sanitizePlainText(member.branch ?? member.name)}…`),
          innerWidth,
        ),
      ];
    }
    if (ds.error) {
      return [fitLine(this.theme.fg("error", `Diff error: ${ds.error}`), innerWidth)];
    }
    const summary = ds.summary;
    if (!summary) {
      return [fitLine(this.theme.fg("dim", "No diff available."), innerWidth)];
    }

    const header = fitLine(
      `${this.theme.fg("accent", sanitizePlainText(summary.branch))} vs ${sanitizePlainText(summary.baseBranch)} · ${summary.commitsAhead} commit(s) ahead · ${summary.changedFiles.length} file(s)`,
      innerWidth,
    );
    const bodyBudget = Math.max(0, budget - 1);
    if (bodyBudget === 0) {
      return [header];
    }

    const bodyLines: string[] = [];
    if (summary.stat) {
      for (const line of summary.stat.split(/\r?\n/)) {
        const cleanLine = sanitizeDiffLine(line);
        if (!cleanLine.trim()) continue;
        bodyLines.push(fitLine(this.theme.fg("muted", cleanLine), innerWidth));
      }
    }
    const rawDiffLines = summary.diff ? summary.diff.split(/\r?\n/) : [];
    for (const raw of rawDiffLines) {
      const cleanRaw = sanitizeDiffLine(raw);
      const styled =
        cleanRaw.startsWith("+") && !cleanRaw.startsWith("+++")
          ? this.theme.fg("toolDiffAdded", cleanRaw)
          : cleanRaw.startsWith("-") && !cleanRaw.startsWith("---")
            ? this.theme.fg("toolDiffRemoved", cleanRaw)
            : cleanRaw.startsWith("@@")
              ? this.theme.fg("accent", cleanRaw)
              : this.theme.fg("toolDiffContext", cleanRaw);
      bodyLines.push(fitLine(styled, innerWidth));
    }

    const maxOffset = Math.max(0, bodyLines.length - bodyBudget);
    this.memberDetailScrollOffset = Math.max(
      0,
      Math.min(this.memberDetailScrollOffset, maxOffset),
    );

    return [
      header,
      ...bodyLines.slice(
        this.memberDetailScrollOffset,
        this.memberDetailScrollOffset + bodyBudget,
      ),
    ];
  }

  private renderMembersTab(
    run: SwarmRunState,
    innerWidth: number,
    budget: number,
  ): string[] {
    const out: string[] = [];
    const members = getOrderedMembers(run);

    if (members.length === 0) {
      out.push(
        fitLine(
          this.theme.fg("muted", "  No members spawned yet in this Swarm run."),
          innerWidth,
        ),
      );
      return out;
    }

    const listBudget = Math.max(
      2,
      Math.min(members.length, Math.floor(budget * 0.42)),
    );
    let start = 0;
    if (members.length > listBudget) {
      start = Math.max(
        0,
        Math.min(
          this.memberSelectedIndex - Math.floor(listBudget / 2),
          members.length - listBudget,
        ),
      );
    }
    const end = Math.min(members.length, start + listBudget);
    for (let i = start; i < end; i++) {
      out.push(
        this.renderMemberRow(
          members[i]!,
          i === this.memberSelectedIndex,
          innerWidth,
        ),
      );
    }

    const selected = this.getSelectedMember();
    if (selected && out.length < budget - 1) {
      const modeTag =
        this.memberDetailMode === "diff"
          ? "Git Diff [d: info · [/]/PgUp/Dn: scroll]"
          : this.memberDetailMode === "logs"
            ? "Brief & Logs [Enter/l: info · [/]/PgUp/Dn: scroll]"
            : "Details & Logs";
      out.push(
        renderHorizontalRule(
          innerWidth,
          `${selected.name} — ${modeTag}`,
          this.theme,
        ),
      );
      const detailBudget = Math.max(1, budget - out.length);
      if (this.memberDetailMode === "diff") {
        out.push(...this.renderMemberDetailDiff(selected, innerWidth, detailBudget));
      } else if (this.memberDetailMode === "logs") {
        out.push(...this.renderMemberDetailLogs(selected, innerWidth, detailBudget));
      } else {
        out.push(...this.renderMemberDetailInfo(selected, innerWidth, detailBudget));
      }
    }

    return out.slice(0, budget);
  }

  private renderGraphTab(
    run: SwarmRunState,
    innerWidth: number,
    budget: number,
  ): string[] {
    if (budget <= 0) return [];
    const lastSeq =
      this.boardMessages.length > 0
        ? this.boardMessages[this.boardMessages.length - 1]!.seq
        : 0;
    const libraryKey = this.getLibraryCacheKey();
    const cached = this.graphCache;
    let allLines: string[];
    if (
      cached &&
      cached.runId === run.id &&
      cached.revision === run.revision &&
      cached.boardLen === this.boardMessages.length &&
      cached.lastSeq === lastSeq &&
      cached.width === innerWidth &&
      cached.mode === this.graphViewMode &&
      cached.libraryKey === libraryKey
    ) {
      allLines = cached.lines;
    } else if (this.graphViewMode === "contract") {
      allLines = buildMissionContractLines(run, innerWidth, this.theme, {
        libraryTopics:
          this.libraryTopicsRunId === run.id ? this.libraryTopics : null,
        activeReader: this.activeLibraryReader,
        canReadLibrary: typeof this.engine.manageMission === "function",
      });
      this.graphCache = {
        runId: run.id,
        revision: run.revision,
        boardLen: this.boardMessages.length,
        lastSeq,
        width: innerWidth,
        mode: this.graphViewMode,
        libraryKey,
        lines: allLines,
      };
    } else {
      const baseGraph = buildSwarmGraphLines(
        run,
        this.boardMessages,
        innerWidth,
        {
          theme: this.theme,
        },
      );
      const goal = summarizeOverlayGoal(run);
      if (goal.hasMissionInspector) {
        const sep = this.theme.fg("dim", " · ");
        const summaryParts: string[] = [];
        if (goal.features.length > 0) {
          summaryParts.push(
            `${this.theme.fg("muted", "Features")} ${this.theme.fg(goal.featFailed > 0 ? "error" : goal.featDone === goal.featTotal && goal.featTotal > 0 ? "success" : "accent", `${goal.featDone}/${goal.featTotal}`)}`,
          );
        }
        if (goal.assertions.length > 0) {
          const ovrSuffix =
            goal.valOverridden > 0
              ? ` ${this.theme.fg("warning", `(${goal.valOverridden} ovr)`)}`
              : "";
          summaryParts.push(
            `${this.theme.fg("muted", "VAL")} ${this.theme.fg(goal.valFailed > 0 ? "error" : goal.valPassed === goal.valTotal && goal.valTotal > 0 ? "success" : "accent", `${goal.valPassed}/${goal.valTotal}`)}${ovrSuffix}`,
          );
        }
        if (goal.sealedMilestones.length > 0) {
          summaryParts.push(
            `${this.theme.fg("success", "[S]")} ${this.theme.fg("muted", goal.sealedMilestones.join(", "))}`,
          );
        }
        if (goal.openDebtItems.length > 0) {
          summaryParts.push(
            this.theme.fg("warning", `!${goal.openDebtItems.length} debt`),
          );
        }
        const headerRule =
          innerWidth >= 48
            ? renderHorizontalRule(
                innerWidth,
                "Mission Contract & Features [v: inspect]",
                this.theme,
              )
            : renderHorizontalRule(
                innerWidth,
                "Mission [v: inspect]",
                this.theme,
              );
        const topBanner: string[] = [headerRule];
        if (summaryParts.length > 0) {
          topBanner.push(
            fitLine(
              `  ${this.theme.fg("accent", "◆")} ${summaryParts.join(sep)}`,
              innerWidth,
            ),
          );
        }
        allLines = [...topBanner, ...baseGraph];
      } else {
        allLines = baseGraph;
      }
      this.graphCache = {
        runId: run.id,
        revision: run.revision,
        boardLen: this.boardMessages.length,
        lastSeq,
        width: innerWidth,
        mode: this.graphViewMode,
        libraryKey,
        lines: allLines,
      };
    }

    if (allLines.length > budget && budget >= 2) {
      const sliceBudget = budget - 1;
      const maxOffset = Math.max(0, allLines.length - sliceBudget);
      this.graphScrollOffset = Math.max(
        0,
        Math.min(this.graphScrollOffset, maxOffset),
      );
      const visible = allLines
        .slice(this.graphScrollOffset, this.graphScrollOffset + sliceBudget)
        .map((l) => fitLine(l, innerWidth));
      const above = this.graphScrollOffset;
      const below = Math.max(
        0,
        allLines.length - (this.graphScrollOffset + sliceBudget),
      );
      const dirParts: string[] = [];
      if (above > 0) dirParts.push(`↑ ${above} above`);
      if (below > 0) dirParts.push(`↓ ${below} more`);
      const cueSuffix =
        innerWidth >= 52 ? "  ([/]/PgUp/PgDn scroll)" : " ([/])";
      visible.push(
        fitLine(
          this.theme.fg("accent", `  ${dirParts.join(" · ")}${cueSuffix}`),
          innerWidth,
        ),
      );
      return visible;
    }

    this.graphScrollOffset = 0;
    return allLines.slice(0, budget).map((l) => fitLine(l, innerWidth));
  }

  private renderSearchTab(innerWidth: number, budget: number): string[] {
    if (this.expandedPost && this.expandedPost.tab === "search") {
      const targetMsg = this.boardMessages.find(
        (m) => m.seq === this.expandedPost!.seq,
      );
      if (targetMsg) {
        return this.renderExpandedPostReader(targetMsg, innerWidth, budget);
      }
      this.expandedPost = null;
    }

    const out: string[] = [];
    const matches = this.getSearchMatches();

    // Live IME search input row
    const inputLine = this.searchInput.render(innerWidth)[0] ?? "";
    out.push(inputLine);

    const statusText = this.searchQuery.trim()
      ? `Matches: ${matches.length} / ${this.boardMessages.length} for "${sanitizePlainText(this.searchQuery)}"`
      : `All ${this.boardMessages.length} board message(s) — type to filter live`;
    const focusHint = this.searchFocused
      ? "[Tab] switch tab · [↑↓] select · [Esc] browse"
      : "[/] edit query · [↑↓] select · [1-4] tab";
    out.push(
      innerWidth >= 74
        ? joinColumns(
            this.theme.fg("muted", statusText),
            this.theme.fg("dim", focusHint),
            innerWidth,
          )
        : fitLine(this.theme.fg("muted", statusText), innerWidth),
    );

    const remaining = Math.max(1, budget - out.length);
    if (matches.length === 0) {
      out.push(
        fitLine(
          this.theme.fg("dim", "  No board messages match your search query."),
          innerWidth,
        ),
      );
      return out.slice(0, budget);
    }

    const previewHeight = remaining >= 7 ? Math.min(3, Math.floor(remaining * 0.35)) : 0;
    const listBudget = Math.max(
      1,
      remaining - (previewHeight > 0 ? previewHeight + 1 : 0),
    );

    let start = 0;
    if (matches.length > listBudget) {
      start = Math.max(
        0,
        Math.min(
          this.searchSelectedIndex - Math.floor(listBudget / 2),
          matches.length - listBudget,
        ),
      );
    }
    const end = Math.min(matches.length, start + listBudget);

    for (let i = start; i < end; i++) {
      out.push(
        this.renderBoardListRow(
          matches[i]!,
          i === this.searchSelectedIndex,
          innerWidth,
        ),
      );
    }

    const selected = matches[this.searchSelectedIndex];
    if (selected && previewHeight > 0) {
      out.push(
        renderHorizontalRule(innerWidth, `Match #${selected.seq}`, this.theme),
      );
      out.push(...this.renderMessagePreview(selected, innerWidth, previewHeight));
    }

    return out.slice(0, budget);
  }

  private renderInlinePromptLabel(mode: InlineInputMode): string {
    if (mode.kind === "board_post") {
      return `Post to #${mode.channel} as ${ORCHESTRATOR_NAME} (@member to wake):`;
    }
    if (mode.kind === "wake") {
      if (mode.conflictRetry) {
        return `Conflict retry for @${mode.member.name} (Enter to send):`;
      }
      return mode.member.state === "working"
        ? `Steer @${mode.member.name} mid-turn:`
        : `Wake / message @${mode.member.name}:`;
    }
    const cur = mode.member.model ?? this.hostModel ?? "host default";
    return mode.member.state === "working"
      ? `Queue turn-end model switch for ${mode.member.name} (current: ${cur}):`
      : `Hot-switch model for ${mode.member.name} (current: ${cur}):`;
  }

  private formatActionPill(
    key: string,
    label: string,
    emphasis: "primary" | "merge" | "danger" | "normal" = "normal",
  ): string {
    if (emphasis === "primary") {
      return `${this.theme.fg("accent", this.theme.bold(`[${key}]`))} ${this.theme.bold(label)}`;
    }
    if (emphasis === "merge") {
      return `${this.theme.fg("success", this.theme.bold(`[${key}]`))} ${this.theme.fg("success", this.theme.bold(label))}`;
    }
    if (emphasis === "danger") {
      return `${this.theme.fg("warning", `[${key}]`)} ${this.theme.fg("muted", label)}`;
    }
    return `${this.theme.fg("accent", `[${key}]`)} ${this.theme.fg("muted", label)}`;
  }

  private renderMissionPipelineStrip(
    run: SwarmRunState,
    innerWidth: number,
  ): string {
    const { workingCount, waitingCount, stoppedCount, mergedCount } =
      countOverlayFleetStates(this.snapshot, run);
    const reconMode = isReconRun(run);
    const reconCount = countOverlayReconMembers(run);

    const sep = this.theme.fg("dim", " · ");
    const reconCountSeg =
      reconCount > 0 ? this.theme.fg("borderAccent", `[R] ${reconCount}`) : "";
    const workingSeg =
      workingCount > 0
        ? this.theme.fg("accent", `Working: ${workingCount}`)
        : this.theme.fg("muted", `Working: ${workingCount}`);
    const waitingSeg =
      waitingCount > 0
        ? this.theme.fg("success", `Waiting: ${waitingCount}`)
        : this.theme.fg("muted", `Waiting: ${waitingCount}`);
    const stoppedSeg =
      stoppedCount > 0
        ? `${sep}${this.theme.fg("warning", `Stopped: ${stoppedCount}`)}`
        : "";
    const mergedSeg =
      mergedCount > 0
        ? this.theme.fg("success", `Merged: ${mergedCount}`)
        : this.theme.fg("muted", `Merged: ${mergedCount}`);
    const basePipelineRight = `${workingSeg}${sep}${waitingSeg}${stoppedSeg}${sep}${mergedSeg}`;
    const pipelineRight = reconCountSeg
      ? `${reconCountSeg}${sep}${basePipelineRight}`
      : basePipelineRight;
    const compactFleetRight = `${reconCount > 0 ? `${this.theme.fg("borderAccent", `[R]${reconCount}`)}/` : ""}${this.theme.fg(workingCount > 0 ? "accent" : "muted", `${workingCount}w`)}/${this.theme.fg("muted", `${waitingCount}wait`)}${stoppedCount > 0 ? `/${this.theme.fg("warning", `${stoppedCount}stop`)}` : ""}${mergedCount > 0 ? `/${this.theme.fg("success", `${mergedCount}m`)}` : ""}`;

    if (reconMode) {
      const reconBadge = formatOverlayReconRunBadge(this.theme);
      const reconPipelineRight = reconCountSeg
        ? `${reconCountSeg}${sep}${workingSeg}${sep}${waitingSeg}${stoppedSeg}`
        : `${workingSeg}${sep}${waitingSeg}${stoppedSeg}`;
      const reconFullLeft = `${reconBadge} ${this.theme.fg("muted", "Read-only recon · awaiting plan approval")}`;
      const reconMedLeft = `${reconBadge} ${this.theme.fg("muted", "Read-only · awaiting plan")}`;
      const reconShortLeft = `${reconBadge} ${this.theme.fg("muted", "Read-only")}`;

      if (innerWidth < 48) {
        return fitLine(`${reconBadge}${sep}${compactFleetRight}`, innerWidth);
      }
      if (visibleWidth(reconFullLeft) + 2 + visibleWidth(reconPipelineRight) <= innerWidth) {
        return joinColumns(reconFullLeft, reconPipelineRight, innerWidth, 2);
      }
      if (visibleWidth(reconMedLeft) + 2 + visibleWidth(reconPipelineRight) <= innerWidth) {
        return joinColumns(reconMedLeft, reconPipelineRight, innerWidth, 2);
      }
      if (visibleWidth(reconShortLeft) + 2 + visibleWidth(reconPipelineRight) <= innerWidth) {
        return joinColumns(reconShortLeft, reconPipelineRight, innerWidth, 2);
      }
      if (visibleWidth(reconMedLeft) + 2 + visibleWidth(compactFleetRight) <= innerWidth) {
        return joinColumns(reconMedLeft, compactFleetRight, innerWidth, 2);
      }
      return joinColumns(reconShortLeft, compactFleetRight, innerWidth, 2);
    }

    const phasePart = formatOverlayPhaseMilestones(run, this.theme);
    const goal = summarizeOverlayGoal(run);

    if (goal.hasPipelineGoal) {
      const featLabel = innerWidth >= 52 ? "Features" : "Feat";
      const featSeg =
        goal.features.length > 0
          ? `${this.theme.fg("muted", featLabel)} ${this.theme.fg(goal.featFailed > 0 ? "error" : goal.featDone === goal.featTotal && goal.featTotal > 0 ? "success" : "accent", `${goal.featDone}/${goal.featTotal}`)}`
          : "";
      const valSeg =
        goal.assertions.length > 0
          ? `${this.theme.fg("muted", "VAL")} ${this.theme.fg(goal.valFailed > 0 ? "error" : goal.valPassed === goal.valTotal && goal.valTotal > 0 ? "success" : "accent", `${goal.valPassed}/${goal.valTotal}`)}${goal.valOverridden > 0 ? ` ${this.theme.fg("warning", `(${goal.valOverridden} ovr)`)}` : ""}`
          : "";
      const sealedSeg =
        goal.sealedMilestones.length > 0
          ? this.theme.fg("success", `[S] ${goal.sealedMilestones.length}`)
          : "";
      const debtSeg =
        goal.openDebtItems.length > 0
          ? this.theme.fg("warning", `!${goal.openDebtItems.length} debt`)
          : "";

      const contractCue =
        this.activeTab === "graph"
          ? this.theme.fg(
              "dim",
              this.graphViewMode === "contract" ? "[v] Graph" : "[v] Contract",
            )
          : this.theme.fg("dim", "[3→v] Contract");

      const phaseHasSealed = Boolean(phasePart && goal.sealedMilestones.length > 0);
      const withPhaseParts = [
        phasePart ?? "",
        featSeg,
        valSeg,
        ...(phaseHasSealed ? [] : [sealedSeg]),
        debtSeg,
      ].filter(Boolean);
      const coreGoalParts = [featSeg, valSeg, sealedSeg, debtSeg].filter(Boolean);

      const withPhaseAndCueLeft = [...withPhaseParts, contractCue].join(sep);
      const withPhaseLeft = withPhaseParts.join(sep);
      const coreWithCueLeft = [...coreGoalParts, contractCue].join(sep);
      const coreGoalLeft = coreGoalParts.join(sep);

      if (innerWidth < 48) {
        return fitLine(`${coreGoalLeft}${sep}${compactFleetRight}`, innerWidth);
      }
      if (visibleWidth(withPhaseAndCueLeft) + 2 + visibleWidth(pipelineRight) <= innerWidth) {
        return joinColumns(withPhaseAndCueLeft, pipelineRight, innerWidth, 2);
      }
      if (visibleWidth(withPhaseLeft) + 2 + visibleWidth(pipelineRight) <= innerWidth) {
        return joinColumns(withPhaseLeft, pipelineRight, innerWidth, 2);
      }
      if (visibleWidth(coreWithCueLeft) + 2 + visibleWidth(pipelineRight) <= innerWidth) {
        return joinColumns(coreWithCueLeft, pipelineRight, innerWidth, 2);
      }
      if (visibleWidth(coreGoalLeft) + 2 + visibleWidth(pipelineRight) <= innerWidth) {
        return joinColumns(coreGoalLeft, pipelineRight, innerWidth, 2);
      }
      if (visibleWidth(withPhaseLeft) + 2 + visibleWidth(compactFleetRight) <= innerWidth) {
        return joinColumns(withPhaseLeft, compactFleetRight, innerWidth, 2);
      }
      if (visibleWidth(coreWithCueLeft) + 2 + visibleWidth(compactFleetRight) <= innerWidth) {
        return joinColumns(coreWithCueLeft, compactFleetRight, innerWidth, 2);
      }
      return joinColumns(coreGoalLeft, compactFleetRight, innerWidth, 2);
    }

    if (innerWidth < 48) {
      return fitLine(
        phasePart ? `${phasePart}${sep}${pipelineRight}` : pipelineRight,
        innerWidth,
      );
    }

    let leftPart: string;
    if (phasePart) {
      leftPart = phasePart;
    } else {
      const objectiveRaw = sanitizePlainText(run.objective || run.title) || run.id;
      leftPart =
        innerWidth >= 68
          ? `${this.theme.fg("muted", "Objective:")} ${this.theme.fg("dim", objectiveRaw)}`
          : this.theme.fg("dim", objectiveRaw);
    }

    return joinColumns(leftPart, pipelineRight, innerWidth, 2);
  }

  private renderMembersActionBar(innerWidth: number): string {
    const selected = this.getSelectedMember();
    const hasUnmergedWorktree =
      selected !== undefined &&
      (selected.workspace === "share" || selected.workspace === "branch") &&
      !selected.mergedCommitSha;
    const canRetry =
      selected !== undefined &&
      selected.state !== "killed" &&
      selected.state !== "working" &&
      (selected.state === "stopped" ||
        Boolean(selected.error && sanitizePlainText(selected.error)));

    const compact = innerWidth < 74;
    const gap = compact ? " " : "  ";
    const enterLabel = this.memberDetailMode === "logs" ? "Info" : "Logs";

    let memberBar: string;
    if (selected?.state === "working") {
      memberBar = [
        this.formatActionPill("Enter", enterLabel, "primary"),
        this.formatActionPill("w", compact ? "Steer" : "Steer Live", "primary"),
        this.formatActionPill("d", "Diff"),
        this.formatActionPill("m", compact ? "Model" : "Queue Model"),
        this.formatActionPill("x", "Stop", "danger"),
        this.formatActionPill("K", "Kill", "danger"),
      ].join(gap);
    } else if (canRetry && hasUnmergedWorktree) {
      memberBar = [
        this.formatActionPill("Enter", enterLabel, "primary"),
        this.formatActionPill("r", "Retry", "primary"),
        this.formatActionPill("g", compact ? "Merge" : "Merge Branch", "merge"),
        ...(compact ? [] : [this.formatActionPill("d", "Diff")]),
        this.formatActionPill("w", compact ? "Steer" : "Wake"),
        this.formatActionPill("m", "Model"),
        this.formatActionPill("K", "Kill", "danger"),
      ].join(gap);
    } else if (canRetry) {
      memberBar = [
        this.formatActionPill("Enter", enterLabel, "primary"),
        this.formatActionPill("r", "Retry", "primary"),
        this.formatActionPill("w", compact ? "Steer" : "Wake"),
        this.formatActionPill("m", "Model"),
        this.formatActionPill("K", "Kill", "danger"),
      ].join(gap);
    } else if (selected && selected.state === "waiting" && hasUnmergedWorktree) {
      memberBar = [
        this.formatActionPill("Enter", enterLabel, "primary"),
        this.formatActionPill("g", compact ? "Merge" : "Merge Branch", "merge"),
        this.formatActionPill("d", "Diff"),
        this.formatActionPill("w", compact ? "Steer" : "Wake"),
        this.formatActionPill("m", "Model"),
        this.formatActionPill("K", "Kill", "danger"),
      ].join(gap);
    } else {
      memberBar = [
        this.formatActionPill("Enter", enterLabel, "primary"),
        this.formatActionPill("w", compact ? "Steer" : "Wake", "primary"),
        this.formatActionPill("m", "Model"),
        this.formatActionPill("K", "Kill", "danger"),
      ].join(gap);
    }

    const fullTail = this.theme.fg(
      "dim",
      "  ·  [M] Models  [P] Pause  [?] Help  [q] Close",
    );
    const shortTail = this.theme.fg("dim", "  ·  [M] Models  [?] Help  [q] Close");
    const barW = visibleWidth(memberBar);
    const globalTail =
      barW + visibleWidth(fullTail) <= innerWidth
        ? fullTail
        : barW + visibleWidth(shortTail) <= innerWidth
          ? shortTail
          : "";
    return fitLine(`${memberBar}${globalTail}`, innerWidth);
  }

  private renderActionBar(innerWidth: number): string {
    if (this.pendingKillConfirm) {
      const forceLabel = this.pendingKillConfirm.force ? "ON" : "OFF";
      const confirmText = `Kill @${sanitizePlainText(this.pendingKillConfirm.memberName)} permanently? [y/Enter] confirm · [f] force dirty: ${forceLabel} · [n/Esc] cancel`;
      return fitLine(this.theme.fg("warning", confirmText), innerWidth);
    }
    if (this.expandedPost && this.expandedPost.tab === this.activeTab) {
      return fitLine(
        this.theme.fg(
          "dim",
          "[↑↓/[/]/PgUp/PgDn] scroll · [Enter/Esc] back to list · [q] close",
        ),
        innerWidth,
      );
    }
    if (this.activeTab === "members") {
      return this.renderMembersActionBar(innerWidth);
    }
    if (
      this.activeTab === "graph" &&
      this.graphViewMode === "contract" &&
      this.activeLibraryReader !== null
    ) {
      const libReaderBar =
        innerWidth >= 82
          ? "[l] next topic · [↑↓/jk/[/]] scroll · [Esc] back to contract · [v] graph · [q] close"
          : innerWidth >= 56
            ? "[l] next · [↑↓/[/]] scroll · [Esc] contract · [q] close"
            : "[l] next · [↑↓/[/]] · [Esc] back";
      return fitLine(this.theme.fg("dim", libReaderBar), innerWidth);
    }
    let text: string;
    if (innerWidth >= 108) {
      const globalSuffix = " · [M] models · [P] pause · [?] help · [Esc/q] close";
      if (this.activeTab === "board") {
        text = `[Enter] read · [p] post · [c] channel · [1-4/Tab] tabs${globalSuffix}`;
      } else if (this.activeTab === "graph") {
        text =
          this.graphViewMode === "contract"
            ? `[v] Contract/Graph · [l] library · [↑↓/jk/[/]] scroll${globalSuffix}`
            : `[v] Contract/Graph · [↑↓/jk/[/]] scroll · [1-4/Tab] tabs${globalSuffix}`;
      } else {
        text = this.searchFocused
          ? "Type to search · [↑↓] select · [Tab] switch tab · [Esc] finish typing"
          : `[/] search · [Enter] read · [1-4/Tab] tabs${globalSuffix}`;
      }
    } else if (innerWidth >= 74) {
      const midSuffix = " · [M] models · [P] pause · [?] help · [Esc/q] close";
      if (this.activeTab === "board") {
        text = `[Enter] read · [p] post · [c] ch${midSuffix}`;
      } else if (this.activeTab === "graph") {
        if (this.graphViewMode === "contract") {
          text =
            innerWidth >= 92
              ? `[v] Contract/Graph · [l] library · [↑↓/[/]] scroll${midSuffix}`
              : "[v] Contract/Graph · [l] library · [↑↓/[/]] scroll · [?] help · [Esc/q] close";
        } else {
          text =
            innerWidth >= 90
              ? `[v] Contract/Graph · [↑↓/jk/[/]] scroll${midSuffix}`
              : "[v] Contract/Graph · [↑↓/jk] scroll · [?] help · [Esc/q] close";
        }
      } else {
        text = this.searchFocused
          ? "Type to filter · [↑↓] select · [Tab] tab · [Esc] browse"
          : `[/] find · [Enter] read${midSuffix}`;
      }
    } else {
      const tightSuffix = " · [?] help · [Esc/q] close";
      if (this.activeTab === "board") {
        text = `[Enter] read · [p] post · [c] ch${tightSuffix}`;
      } else if (this.activeTab === "graph") {
        if (this.graphViewMode === "contract") {
          text =
            innerWidth >= 62
              ? `[v] Graph · [l] library · [↑↓/[/]] scroll${tightSuffix}`
              : innerWidth >= 48
                ? "[v] Graph · [l] lib · [↑↓/[/]] · [q] close"
                : "[v] view · [l] lib · [q] close";
        } else {
          text =
            innerWidth >= 62
              ? `[v] Contract/Graph · [↑↓/jk] scroll${tightSuffix}`
              : innerWidth >= 48
                ? "[v] Contract/Graph · [↑↓] · [?] · [q] close"
                : "[v] view · [↑↓] · [q] close";
        }
      } else {
        text = this.searchFocused
          ? "Type filter · [↑↓] sel · [Tab] tab · [Esc] browse"
          : `[/] find · [Enter] read${tightSuffix}`;
      }
    }
    return fitLine(this.theme.fg("dim", text), innerWidth);
  }

  // ==========================================================================
  // Main Render
  // ==========================================================================

  render(width: number): string[] {
    if (this.subComponent) {
      return this.subComponent.render(width);
    }

    this.syncSpinnerTimer(this.hasWorkingMembers());

    const targetWidth = Math.max(1, Math.floor(width));
    const innerWidth = computeBoxInnerWidth(targetWidth);
    const termRows = this.tui.terminal?.rows ?? 30;
    const rowCeiling = Math.max(5, Math.floor(termRows * 0.86));
    const maxTotalLines = Math.min(
      rowCeiling,
      Math.max(5, Math.min(34, Math.floor(termRows * 0.85))),
    );
    const maxInnerLines = Math.max(3, maxTotalLines - 2);

    if (this.showHelp) {
      const helpBody = [
        fitLine(this.theme.fg("accent", this.theme.bold("Global & Overlay Shortcuts")), innerWidth),
        fitLine("  Alt+S / Alt+M / Alt+W  Panel / Models / Dashboard", innerWidth),
        fitLine("  1-4 / Tab / Shift+Tab  Switch 4 Mission tabs", innerWidth),
        fitLine("  j / k or ↑ / ↓ / [ ]   Move or page scroll", innerWidth),
        fitLine("  M / P / ? / Esc or q   Models / Pause / Help / Quit", innerWidth),
        fitLine(this.theme.fg("accent", this.theme.bold("Board [1] & Search [4]")), innerWidth),
        fitLine("  Enter / c / p / /      Read post / Ch / Post / Find", innerWidth),
        fitLine(this.theme.fg("accent", this.theme.bold("Members Tab [2]")), innerWidth),
        fitLine("  w / r / m / g / x / K  Steer/Retry/Model/Merge/Stop/Kill", innerWidth),
        fitLine("  Enter / l / d / [ ]    Brief & Logs / Diff / Scroll", innerWidth),
        fitLine(this.theme.fg("accent", this.theme.bold("Graph & Contract Tab [3]")), innerWidth),
        fitLine("  [v] Contract/Graph · [l] Read library/*.md", innerWidth),
      ];
      const maxEntries = Math.max(1, maxInnerLines - 2);
      const outHelp = helpBody.slice(0, maxEntries);
      outHelp.push(renderHorizontalRule(innerWidth, undefined, this.theme));
      outHelp.push(fitLine(this.theme.fg("dim", "Press Esc, Enter or ? to return"), innerWidth));
      return renderBox(outHelp, targetWidth, {
        title: this.theme.fg("accent", this.theme.bold("🐝 Mission Control Shortcuts")),
        borderColor: (s) => this.theme.fg("borderAccent", s),
      });
    }

    const run = this.snapshot.run;
    if (!run) {
      return renderBox(
        [
          fitLine(this.theme.fg("muted", "No active Swarm run."), innerWidth),
          fitLine(this.theme.fg("dim", "[Esc/q] close"), innerWidth),
        ],
        targetWidth,
        {
          title: this.theme.fg("accent", this.theme.bold("🐝 Swarm Overlay")),
          borderColor: (s) => this.theme.fg("borderAccent", s),
        },
      );
    }

    const body: string[] = [];

    // Top 4-tab bar
    body.push(this.renderTabBar(run, innerWidth));

    // Compact status + base branch & full 3-role models bar (run title is in box top border)
    const reconMode = isReconRun(run);
    const titleStr = sanitizePlainText(run.title || run.objective) || run.id;
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const reconPrefix = reconMode ? `${formatOverlayReconRunBadge(this.theme)} ` : "";
    const runLeft = `${reconPrefix}[${statusBadge}] base:${sanitizePlainText(run.baseBranch)}`;
    const modelsBudget = Math.max(12, innerWidth - visibleWidth(runLeft) - 2);
    const modelsLine = formatRoleModelsLine(
      this.snapshot.roleModels ?? run.roleModels,
      this.hostModel ?? "default",
      {
        maxWidth: modelsBudget,
        theme: this.theme,
      },
    );
    body.push(
      innerWidth >= 52
        ? joinColumns(runLeft, modelsLine, innerWidth, 2)
        : fitLine(runLeft, innerWidth),
    );

    // Compact 1-line Mission Pipeline Strip when terminal height >= 20
    if (termRows >= 20) {
      body.push(this.renderMissionPipelineStrip(run, innerWidth));
    }

    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));

    // Bottom reservation so feedback + rule + inline input / action bar are NEVER clipped
    const footerLinesCount = this.inlineMode ? 2 : 1;
    const bottomReserved =
      (this.feedback ? 1 : 0) + 1 /* rule */ + footerLinesCount;
    const contentBudget = Math.max(1, maxInnerLines - body.length - bottomReserved);

    if (this.activeTab === "board") {
      body.push(...this.renderBoardTab(innerWidth, contentBudget));
    } else if (this.activeTab === "members") {
      body.push(...this.renderMembersTab(run, innerWidth, contentBudget));
    } else if (this.activeTab === "graph") {
      body.push(...this.renderGraphTab(run, innerWidth, contentBudget));
    } else {
      body.push(...this.renderSearchTab(innerWidth, contentBudget));
    }

    // Feedback line (if any)
    if (this.feedback) {
      const color =
        this.feedback.kind === "success"
          ? "success"
          : this.feedback.kind === "warning"
            ? "warning"
            : this.feedback.kind === "error"
              ? "error"
              : "accent";
      body.push(fitLine(this.theme.fg(color, this.feedback.text), innerWidth));
    }

    // Bottom rule + inline IME input OR action bar
    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    if (this.inlineMode) {
      const label = this.renderInlinePromptLabel(this.inlineMode);
      body.push(fitLine(this.theme.fg("accent", label), innerWidth));
      const inputLine = this.inlineInput.render(innerWidth)[0] ?? "";
      body.push(inputLine);
    } else {
      body.push(this.renderActionBar(innerWidth));
    }

    const boxTitle = this.theme.fg(
      "accent",
      this.theme.bold(`🐝 ${reconMode ? "[RECON] " : ""}${titleStr} · ${run.id}`),
    );
    return renderBox(body.slice(0, maxInnerLines), targetWidth, {
      title: boxTitle,
      borderColor: (s) => this.theme.fg("borderAccent", s),
    });
  }
}

// ============================================================================
// RPC / Non-TUI Fallback
// ============================================================================

async function openSwarmBasicMenu(
  ctx: ExtensionContext,
  engine: ISwarmEngine,
  worktree?: IWorktreeManager | null,
): Promise<void> {
  while (true) {
    const snapshot = engine.getSnapshot();
    const run = snapshot.run;
    if (!run) {
      ctx.ui.notify("No active Swarm run.", "info");
      return;
    }

    const members = getOrderedMembers(run);
    const labelToMember = new Map<string, SwarmMemberRecord>();
    const options: string[] = [];

    const boardOpt = `Board (#${snapshot.boardHead}) — Post message`;
    const searchOpt = "Search Board — Filter messages";
    const graphOpt = "Swarm Graph — Spawn tree & @mentions";
    options.push(boardOpt, searchOpt, graphOpt);

    for (const m of members) {
      const modelTag = m.model ? ` [${shortenModelName(m.model)}]` : "";
      const wsTag = formatWorkspaceBadge(m.workspace, m.branch);
      const roleTag = m.recon ? "[R] recon" : m.role;
      const label = `${memberStateIcon(m.state)} ${m.name} (${roleTag} · ${m.state}${modelTag} · ${wsTag})`;
      labelToMember.set(label, m);
      options.push(label);
    }

    const closeOpt = "Close";
    options.push(closeOpt);

    const { workingCount, waitingCount, stoppedCount } = countOverlayFleetStates(
      snapshot,
      run,
    );
    const fleetHeader = `${workingCount} working · ${waitingCount} waiting${stoppedCount > 0 ? ` · ${stoppedCount} stopped` : ""}`;
    const reconHeaderPrefix = isReconRun(run) ? "[RECON] " : "";
    const chosen = await ctx.ui.select(
      `🐝 ${reconHeaderPrefix}${sanitizePlainText(run.title || run.id)} (${formatRunStatusBadge(run.status)} · ${fleetHeader} · Board:#${snapshot.boardHead})`,
      options,
    );
    if (!chosen || chosen === closeOpt) {
      return;
    }

    if (chosen === boardOpt) {
      const msg = await ctx.ui.input(
        "Post to Swarm board",
        "Type message (use @name to wake a member)…",
      );
      if (msg && msg.trim()) {
        try {
          const posted = await engine.postMessage({
            from: ORCHESTRATOR_NAME,
            fromRole: "orchestrator",
            text: msg.trim(),
            channel: DEFAULT_CHANNEL,
            kind: "chat",
          });
          ctx.ui.notify(`Posted #${posted.seq} to #${posted.channel}.`, "info");
        } catch (err) {
          ctx.ui.notify(`Board post failed: ${formatErrorMessage(err)}`, "error");
        }
      }
      continue;
    }

    if (chosen === searchOpt) {
      const query = await ctx.ui.input(
        "Search Swarm board",
        "Enter search query…",
      );
      if (query !== undefined) {
        try {
          const res = await engine.readBoard({
            channel: "*",
            search: query.trim() || undefined,
            limit: 50,
          });
          ctx.ui.notify(
            `Found ${res.messages.length} board message(s) matching "${sanitizePlainText(query)}" (head #${res.head}).`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`Search failed: ${formatErrorMessage(err)}`, "error");
        }
      }
      continue;
    }

    if (chosen === graphOpt) {
      try {
        const res = await engine.readBoard({ channel: "*", limit: 200 });
        const graphLines = buildSwarmGraphLines(run, res.messages, 78);
        ctx.ui.notify(graphLines.join("\n"), "info");
      } catch {
        const graphLines = buildSwarmGraphLines(run, snapshot.recentBoard, 78);
        ctx.ui.notify(graphLines.join("\n"), "info");
      }
      continue;
    }

    const member = labelToMember.get(chosen);
    if (!member) continue;

    const actions: string[] = [];
    if (member.state !== "killed") {
      actions.push(`Wake / message @${member.name}`);
    }
    if (member.state === "waiting" || member.state === "stopped") {
      actions.push(`Hot-switch model on ${member.name}`);
    }
    if (member.state !== "killed") {
      actions.push(`Stop ${member.name} (human-stopped)`);
      actions.push(`Kill ${member.name} permanently`);
    }
    if (member.workspace !== "inherit" || member.branch) {
      actions.push(`Merge ${member.name} worktree`);
    }
    if (worktree && member.branch) {
      actions.push("Show git diff summary");
    }
    actions.push("Back");

    const action = await ctx.ui.select(
      `Member ${member.name} (${member.role} · ${member.state})`,
      actions,
    );
    if (!action || action === "Back") continue;

    try {
      if (action.startsWith("Wake / message @")) {
        const msg = await ctx.ui.input(
          `Message @${member.name}`,
          "Enter instructions…",
        );
        if (msg && msg.trim()) {
          if (typeof engine.steerMember === "function") {
            const res = await engine.steerMember(member.name, msg.trim(), "steer", {
              callerName: ORCHESTRATOR_NAME,
              callerRole: "human",
            });
            ctx.ui.notify(
              res.delivery === "steered"
                ? `Steered @${member.name} mid-turn.`
                : `Woke @${member.name}.`,
              "info",
            );
          } else {
            const text = msg.trim().includes(`@${member.name}`)
              ? msg.trim()
              : `@${member.name} ${msg.trim()}`;
            const posted = await engine.postMessage({
              from: ORCHESTRATOR_NAME,
              fromRole: "orchestrator",
              text,
              channel: member.channels[0] || DEFAULT_CHANNEL,
              kind: "chat",
            });
            ctx.ui.notify(`Posted #${posted.seq} for @${member.name}.`, "info");
          }
        }
      } else if (action.startsWith("Hot-switch model on ")) {
        const raw = await ctx.ui.input(
          `Switch model for ${member.name}`,
          "provider/model-id [thinkingLevel]…",
        );
        if (raw && raw.trim()) {
          const { model, thinkingLevel } = parseModelAndThinking(raw);
          const switched = await engine.switchModel({
            targetName: member.name,
            model,
            thinkingLevel,
            reason: "Hot-switched by user via Swarm overlay",
            callerName: ORCHESTRATOR_NAME,
            callerRole: "human",
            hostContext: ctx,
          });
          ctx.ui.notify(
            `Switched ${member.name} to ${switched.model}.`,
            "info",
          );
        }
      } else if (action.startsWith("Stop ")) {
        await engine.stopMember(member.name, {
          humanStopped: true,
          reason: "Stopped by user via Swarm overlay",
          callerName: ORCHESTRATOR_NAME,
          callerRole: "human",
        });
        ctx.ui.notify(`Stopped ${member.name} (human-stopped).`, "warning");
      } else if (action.startsWith("Kill ")) {
        await engine.killMember(member.name, {
          reason: "Killed by user",
          callerName: ORCHESTRATOR_NAME,
          callerRole: "human",
        });
        ctx.ui.notify(`Killed ${member.name} permanently.`, "warning");
      } else if (action.startsWith("Merge ")) {
        await engine.mergeMember(member.name, {
          callerName: ORCHESTRATOR_NAME,
          callerRole: "human",
        });
        ctx.ui.notify(`Merged ${member.name} worktree.`, "info");
      } else if (action === "Show git diff summary" && worktree && member.branch) {
        const diff = await worktree.getDiffSummary(run.baseBranch, member.branch, {
          cwd: member.cwd || undefined,
        });
        ctx.ui.notify(
          `${member.name} (${sanitizePlainText(member.branch)}): ${diff.commitsAhead} commit(s) ahead, ${diff.changedFiles.length} file(s) changed`,
          "info",
        );
      }
    } catch (err) {
      ctx.ui.notify(
        `Action failed for ${member.name}: ${formatErrorMessage(err)}`,
        "error",
      );
    }
  }
}

// ============================================================================
// Public Entrypoint
// ============================================================================

export async function openSwarmOverlay(
  ctx: ExtensionContext,
  engine: ISwarmEngine,
  worktree?: IWorktreeManager | null,
  options?: SwarmOverlayOptions,
): Promise<void> {
  if (!ctx.hasUI) return;

  if (!engine.getSnapshot().run) {
    ctx.ui.notify(
      "No active Swarm run. Start one with /swarm <idea>.",
      "info",
    );
    return;
  }

  let component: SwarmOverlayComponent | undefined;
  options?.onModalEnter?.();
  try {
    if (ctx.mode === "tui") {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          component = new SwarmOverlayComponent(
            tui,
            theme,
            ctx,
            engine,
            worktree,
            options,
            () => done(undefined),
          );
          return component;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "92%",
            minWidth: 44,
            maxHeight: "88%",
            anchor: "center",
          },
        },
      );
      return;
    }

    await openSwarmBasicMenu(ctx, engine, worktree);
  } finally {
    component?.dispose();
    options?.onModalExit?.();
  }
}

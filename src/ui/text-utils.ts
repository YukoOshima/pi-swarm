import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { ORCHESTRATOR_NAME } from "../constants.js";
import type {
  BoardMessage,
  BoardMessageKind,
  SwarmMemberRecord,
  SwarmMemberRole,
  SwarmMemberState,
  SwarmRoleModels,
  SwarmRunState,
  SwarmRunStatus,
  SwarmWorkspaceMode,
} from "../types.js";

export { visibleWidth, stripTerminalSequences };

export type StyleTheme = Pick<Theme, "fg" | "bold">;

export interface FitLineOptions {
  /** Pad output with trailing spaces to reach exactly `width`. */
  pad?: boolean;
  /** Ellipsis string appended on truncation (default: "…"). */
  ellipsis?: string;
}

export interface BoxOptions {
  title?: string;
  footer?: string;
  borderColor?: (text: string) => string;
  paddingX?: number;
}

export interface TableColumn<T> {
  key: string;
  header: string;
  minWidth: number;
  maxWidth?: number;
  flex?: number;
  /** Higher priority columns are kept first when terminal width is tight. */
  priority?: number;
  align?: "left" | "right";
  render: (row: T) => string;
}

export interface RenderTableOptions {
  header?: boolean;
  theme?: StyleTheme;
  maxRows?: number;
  columnGap?: number;
}

export interface RoleModelsLineOptions {
  /** Optional width ceiling; progressively shortens provider prefixes & names so all 3 roles fit. */
  maxWidth?: number;
  /** Optional Pi theme for styling role tags and model names. */
  theme?: StyleTheme;
  /** Include thinking level suffix when configured and width allows (default: true). */
  includeThinking?: boolean;
}

export interface SwarmGraphOptions {
  /** Optional Pi theme for ANSI styling inside TUI overlays. */
  theme?: StyleTheme;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/;
/** Local control-character matcher for cross-version Pi TUI compatibility (Pi 1.3–1.6+). */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Normalize line breaks and tabs to spaces while preserving ANSI/APC terminal sequences.
 */
export function normalizeSingleLine(text: string): string {
  if (!text) return "";
  return text.replace(/\r\n|\r|\n/g, " ").replace(/\t/g, "  ");
}

/**
 * Strip terminal escape sequences and control characters from untrusted external text.
 */
export function sanitizePlainText(text: string): string {
  if (!text) return "";
  const stripped = stripTerminalSequences(text);
  return stripped.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Strip terminal escape sequences and C0/C1 control characters from a single diff/stat line
 * while preserving leading indentation.
 */
export function sanitizeDiffLine(line: string): string {
  if (!line) return "";
  return stripTerminalSequences(line)
    .replace(/\t/g, "  ")
    .replace(CONTROL_CHARS_RE, " ");
}

/**
 * Clamp a single line so that `visibleWidth(result) <= width` ALWAYS holds,
 * even with ANSI color codes, wide CJK graphemes, emojis, or very narrow widths.
 */
export function fitLine(
  text: string,
  width: number,
  options?: FitLineOptions,
): string {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return "";

  const pad = options?.pad ?? false;
  const clean = normalizeSingleLine(text);
  const currentWidth = visibleWidth(clean);

  if (currentWidth <= targetWidth) {
    if (!pad || currentWidth === targetWidth) return clean;
    return clean + " ".repeat(targetWidth - currentWidth);
  }

  let ellipsis = options?.ellipsis ?? "…";
  if (visibleWidth(ellipsis) > targetWidth) {
    ellipsis = targetWidth >= 1 ? "…" : "";
    if (visibleWidth(ellipsis) > targetWidth) {
      ellipsis = "";
    }
  }

  let result = truncateToWidth(clean, targetWidth, ellipsis, pad);
  let resultWidth = visibleWidth(result);

  if (resultWidth > targetWidth) {
    result = sliceByColumn(result, 0, targetWidth, true);
    if (ANSI_ESCAPE_RE.test(result)) {
      result += "\x1b[0m";
    }
    resultWidth = visibleWidth(result);
  }

  if (pad && resultWidth < targetWidth) {
    result += " ".repeat(targetWidth - resultWidth);
  }

  return result;
}

/**
 * Clamp an array of lines to `width`, optionally capping total line count.
 */
export function fitLines(
  lines: readonly string[],
  width: number,
  options?: FitLineOptions & { maxLines?: number },
): string[] {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return [];

  const maxLines = options?.maxLines;
  if (maxLines !== undefined && maxLines <= 0) return [];

  let slice = lines;
  let overflowCount = 0;

  if (maxLines !== undefined && lines.length > maxLines) {
    if (maxLines === 1) {
      slice = lines.slice(0, 1);
    } else {
      slice = lines.slice(0, maxLines - 1);
      overflowCount = lines.length - (maxLines - 1);
    }
  }

  const out = slice.map((line) => fitLine(line, targetWidth, options));
  if (overflowCount > 0) {
    out.push(fitLine(`… +${overflowCount} more`, targetWidth, options));
  }
  return out;
}

/**
 * ANSI-safe word wrap where every output line is guaranteed `visibleWidth(line) <= width`.
 */
export function wrapLines(
  text: string,
  width: number,
  maxLines?: number,
): string[] {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return [];
  if (maxLines !== undefined && maxLines <= 0) return [];

  const wrapped = wrapTextWithAnsi(text, targetWidth);
  const clamped = wrapped.map((line) => fitLine(line, targetWidth));

  if (maxLines === undefined || clamped.length <= maxLines) {
    return clamped;
  }

  const kept = clamped.slice(0, maxLines);
  const lastIdx = kept.length - 1;
  if (lastIdx >= 0) {
    const base = kept[lastIdx] ?? "";
    const ellipsisWidth = targetWidth >= 1 ? 1 : 0;
    const prefix =
      targetWidth > ellipsisWidth
        ? fitLine(base, targetWidth - ellipsisWidth, { ellipsis: "" })
        : "";
    kept[lastIdx] = fitLine(
      prefix.trimEnd() + (ellipsisWidth > 0 ? "…" : ""),
      targetWidth,
    );
  }
  return kept;
}

/**
 * Right-pad an ANSI string to `width`, truncating cleanly if longer.
 */
export function padRight(text: string, width: number): string {
  return fitLine(text, width, { pad: true });
}

/**
 * Left-pad an ANSI string to `width`, truncating cleanly if longer.
 */
export function padLeft(text: string, width: number): string {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return "";
  const clamped = fitLine(text, targetWidth);
  const w = visibleWidth(clamped);
  if (w >= targetWidth) return clamped;
  return " ".repeat(targetWidth - w) + clamped;
}

/**
 * Place `left` on the left and `right` flush-right within `width`.
 * Guarantees `visibleWidth(result) <= width`.
 */
export function joinColumns(
  left: string,
  right: string,
  width: number,
  minGap = 1,
): string {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return "";

  const cleanLeft = normalizeSingleLine(left);
  const cleanRight = normalizeSingleLine(right);
  if (!cleanRight) return fitLine(cleanLeft, targetWidth);
  if (!cleanLeft) return padLeft(cleanRight, targetWidth);

  const gap = Math.max(1, minGap);
  const rightW = visibleWidth(cleanRight);

  if (rightW >= targetWidth) {
    return fitLine(cleanRight, targetWidth);
  }

  const maxLeftW = targetWidth - rightW - gap;
  if (maxLeftW <= 0) {
    return padLeft(cleanRight, targetWidth);
  }

  const fittedLeft = fitLine(cleanLeft, maxLeftW);
  const leftW = visibleWidth(fittedLeft);
  const spaces = Math.max(gap, targetWidth - leftW - rightW);
  return fitLine(`${fittedLeft}${" ".repeat(spaces)}${cleanRight}`, targetWidth);
}

// ============================================================================
// Duration, Token & Cost Formatters
// ============================================================================

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1_000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0
      ? `${totalMinutes}m${String(seconds).padStart(2, "0")}s`
      : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0
    ? `${hours}h${String(minutes).padStart(2, "0")}m`
    : `${hours}h`;
}

export function formatElapsedSince(
  isoTimestamp: string | undefined,
  nowMs: number = Date.now(),
): string {
  if (!isoTimestamp) return "0s";
  const started = Date.parse(isoTimestamp);
  if (Number.isNaN(started)) return "0s";
  return formatDuration(Math.max(0, nowMs - started));
}

function trimDecimalZeros(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1_000) return `${Math.round(count)}`;
  if (count < 100_000) {
    return `${trimDecimalZeros((count / 1_000).toFixed(1))}k`;
  }
  if (count < 1_000_000) {
    return `${Math.round(count / 1_000)}k`;
  }
  if (count < 10_000_000) {
    return `${trimDecimalZeros((count / 1_000_000).toFixed(2))}M`;
  }
  return `${trimDecimalZeros((count / 1_000_000).toFixed(1))}M`;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ============================================================================
// 3-Role Model Summary Helpers
// ============================================================================

function stripModelProviderPrefix(model: string): string {
  const slashIdx = model.lastIndexOf("/");
  if (slashIdx >= 0 && slashIdx < model.length - 1) {
    return model.slice(slashIdx + 1);
  }
  return model;
}

function stripModelDateSuffix(model: string): string {
  return model.replace(/-(?:20\d{6}|\d{8})$/, "");
}

/**
 * Shorten a potentially long `provider/model-id` string for tight UI columns.
 */
export function shortenModelName(model: string, maxLength?: number): string {
  const clean = sanitizePlainText(model);
  if (!clean) return "";
  if (maxLength === undefined) {
    return stripModelProviderPrefix(clean);
  }
  const budget = Math.max(0, Math.floor(maxLength));
  if (budget === 0) return "";
  if (visibleWidth(clean) <= budget) return clean;

  const noProvider = stripModelProviderPrefix(clean);
  if (visibleWidth(noProvider) <= budget) return noProvider;

  const noDate = stripModelDateSuffix(noProvider);
  if (visibleWidth(noDate) <= budget) return noDate;

  return fitLine(noDate, budget);
}

/**
 * Render a compact 3-role model pill summary: `O:<model> · W:<model> · V:<model>`.
 * When `options.maxWidth` is provided, progressively strips provider prefixes,
 * thinking levels, date suffixes, and budgets each pill cleanly so all 3 roles
 * remain visible and `visibleWidth(result) <= maxWidth` ALWAYS holds.
 */
export function formatRoleModelsLine(
  roleModels?: SwarmRoleModels,
  fallbackCurrentModel?: string,
  options?: RoleModelsLineOptions,
): string {
  const theme = options?.theme;
  const includeThinking = options?.includeThinking ?? true;
  const fallback = sanitizePlainText(fallbackCurrentModel ?? "") || "default";

  const entries: {
    tag: "O" | "W" | "V";
    raw: string;
    isFallback: boolean;
    thinking?: string;
  }[] = [
    {
      tag: "O",
      raw: sanitizePlainText(roleModels?.orchestrator?.model ?? "") || fallback,
      isFallback: !sanitizePlainText(roleModels?.orchestrator?.model ?? ""),
      thinking: roleModels?.orchestrator?.thinkingLevel,
    },
    {
      tag: "W",
      raw: sanitizePlainText(roleModels?.worker?.model ?? "") || fallback,
      isFallback: !sanitizePlainText(roleModels?.worker?.model ?? ""),
      thinking: roleModels?.worker?.thinkingLevel,
    },
    {
      tag: "V",
      raw: sanitizePlainText(roleModels?.validator?.model ?? "") || fallback,
      isFallback: !sanitizePlainText(roleModels?.validator?.model ?? ""),
      thinking: roleModels?.validator?.thinkingLevel,
    },
  ];

  const assemble = (labels: readonly string[]): string => {
    const sep = theme ? theme.fg("dim", " · ") : " · ";
    const parts = entries.map((entry, idx) => {
      const label = labels[idx] ?? "";
      if (!theme) {
        return `${entry.tag}:${label}`;
      }
      const tagStr = theme.fg("muted", `${entry.tag}:`);
      const valStr = entry.isFallback
        ? theme.fg("dim", label)
        : theme.fg("accent", label);
      return `${tagStr}${valStr}`;
    });
    return parts.join(sep);
  };

  const fullLabels = entries.map((e) =>
    includeThinking && e.thinking ? `${e.raw}(${e.thinking})` : e.raw,
  );
  const fullLine = assemble(fullLabels);

  if (options?.maxWidth === undefined) {
    return fullLine;
  }

  const maxW = Math.max(0, Math.floor(options.maxWidth));
  if (maxW === 0) return "";
  if (visibleWidth(fullLine) <= maxW) {
    return fullLine;
  }

  // Pass 1: strip provider prefixes while preserving thinking suffix if it fits
  const shortWithThinking = entries.map((e) => {
    const base = stripModelProviderPrefix(e.raw);
    return includeThinking && e.thinking ? `${base}(${e.thinking})` : base;
  });
  const pass1 = assemble(shortWithThinking);
  if (visibleWidth(pass1) <= maxW) {
    return pass1;
  }

  // Pass 2: strip provider prefixes, thinking suffix, and trailing YYYYMMDD date stamps
  const compactLabels = entries.map((e) =>
    stripModelDateSuffix(stripModelProviderPrefix(e.raw)),
  );
  const pass2 = assemble(compactLabels);
  if (visibleWidth(pass2) <= maxW) {
    return pass2;
  }

  // Pass 3: distribute available column budget across all 3 pills (water-filling)
  const overhead = 12; // "O:" + " · " + "W:" + " · " + "V:"
  if (maxW >= overhead + 6) {
    const available = maxW - overhead;
    const desired = compactLabels.map((l) => visibleWidth(l));
    const budgets = [0, 0, 0];
    let remaining = available;
    const open = new Set([0, 1, 2]);

    while (open.size > 0 && remaining > 0) {
      const share = Math.max(1, Math.floor(remaining / open.size));
      let satisfiedAny = false;
      for (const idx of [...open]) {
        const need = (desired[idx] ?? 0) - (budgets[idx] ?? 0);
        if (need <= share) {
          budgets[idx] = (budgets[idx] ?? 0) + need;
          remaining -= need;
          open.delete(idx);
          satisfiedAny = true;
        }
      }
      if (!satisfiedAny) {
        const list = [...open];
        const baseShare = Math.floor(remaining / list.length);
        let extra = remaining - baseShare * list.length;
        for (const idx of list) {
          const add = baseShare + (extra > 0 ? 1 : 0);
          if (extra > 0) extra--;
          budgets[idx] = (budgets[idx] ?? 0) + add;
        }
        remaining = 0;
        open.clear();
      }
    }

    const budgetedLabels = compactLabels.map((l, idx) =>
      fitLine(l, Math.max(2, budgets[idx] ?? 2)),
    );
    return fitLine(assemble(budgetedLabels), maxW);
  }

  return fitLine(pass2, maxW);
}

// ============================================================================
// Dynamic Swarm v2 Status, Role, State, Workspace & Board Badges
// ============================================================================

export function formatRunStatusBadge(
  status: SwarmRunStatus,
  theme?: StyleTheme,
): string {
  const raw = status === "active" ? "Live" : status;
  if (!theme) return raw;
  switch (status) {
    case "active":
      return theme.fg("accent", theme.bold(raw));
    case "paused":
      return theme.fg("warning", theme.bold(raw));
    case "completed":
      return theme.fg("success", theme.bold(raw));
    case "abandoned":
      return theme.fg("dim", raw);
  }
}

export function formatMemberRoleBadge(
  role: SwarmMemberRole | "orchestrator" | "monitor",
  theme?: StyleTheme,
): string {
  if (!theme) return role;
  switch (role) {
    case "worker":
      return theme.fg("accent", role);
    case "validator":
      return theme.fg("warning", role);
    case "orchestrator":
      return theme.fg("borderAccent", theme.bold(role));
    case "monitor":
      return theme.fg("muted", role);
  }
}

export function memberStateIcon(state: SwarmMemberState): string {
  switch (state) {
    case "working":
      return "●";
    case "waiting":
      return "◌";
    case "stopped":
      return "■";
    case "killed":
      return "⊘";
  }
}

export function formatMemberStateBadge(
  state: SwarmMemberState,
  theme?: StyleTheme,
): string {
  if (!theme) return state;
  switch (state) {
    case "working":
      return theme.fg("accent", state);
    case "waiting":
      return theme.fg("muted", state);
    case "stopped":
      return theme.fg("warning", state);
    case "killed":
      return theme.fg("dim", state);
  }
}

export function formatWorkspaceBadge(
  workspace: SwarmWorkspaceMode,
  branch?: string,
  theme?: StyleTheme,
): string {
  const cleanBranch = branch ? sanitizePlainText(branch) : "";
  const raw =
    workspace === "inherit"
      ? "inherit"
      : cleanBranch
        ? `${workspace}:${cleanBranch}`
        : workspace;
  if (!theme) return raw;
  switch (workspace) {
    case "inherit":
      return theme.fg("dim", raw);
    case "share":
      return theme.fg("accent", raw);
    case "branch":
      return theme.fg("borderAccent", raw);
  }
}

export function formatBoardKindBadge(
  kind: BoardMessageKind,
  theme?: StyleTheme,
): string {
  const raw = `[${kind}]`;
  if (!theme) return raw;
  switch (kind) {
    case "brief":
    case "decision":
      return theme.fg("accent", raw);
    case "done":
      return theme.fg("success", raw);
    case "update":
      return theme.fg("muted", raw);
    case "review":
      return theme.fg("warning", raw);
    case "model_switch":
      return theme.fg("borderAccent", raw);
    case "stall":
      return theme.fg("error", raw);
    case "chat":
      return theme.fg("dim", raw);
  }
}

// ============================================================================
// Box, Rule & Adaptive Table Rendering
// ============================================================================

export function renderHorizontalRule(
  width: number,
  label?: string,
  theme?: StyleTheme,
): string {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return "";
  const style = (s: string) => (theme ? theme.fg("borderMuted", s) : s);

  if (!label) {
    return fitLine(style("─".repeat(targetWidth)), targetWidth);
  }

  const cleanLabel = normalizeSingleLine(label).trim();
  if (!cleanLabel || targetWidth < 8) {
    return fitLine(style("─".repeat(targetWidth)), targetWidth);
  }

  const maxLabelW = Math.max(1, targetWidth - 6);
  const fittedLabel = fitLine(cleanLabel, maxLabelW);
  const labelW = visibleWidth(fittedLabel);
  const rightFill = Math.max(1, targetWidth - 4 - labelW);
  const line = `${style("── ")}${fittedLabel}${style(" " + "─".repeat(rightFill))}`;
  return fitLine(line, targetWidth);
}

/**
 * Render lines inside a rounded Unicode border box, safely degrading on narrow widths.
 * Every output line is guaranteed `visibleWidth(line) <= width`.
 */
export function renderBox(
  lines: readonly string[],
  width: number,
  options?: BoxOptions,
): string[] {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return [];

  const colorBorder = options?.borderColor ?? ((s: string) => s);
  const paddingX = Math.max(0, options?.paddingX ?? 1);

  // Degrade cleanly on ultra-narrow terminals
  if (targetWidth < 12) {
    const out: string[] = [];
    if (options?.title) {
      out.push(fitLine(options.title, targetWidth));
    }
    for (const line of lines) {
      out.push(fitLine(line, targetWidth));
    }
    if (options?.footer) {
      out.push(fitLine(options.footer, targetWidth));
    }
    return out;
  }

  const effectivePad = targetWidth < 24 ? 0 : paddingX;
  const innerWidth = Math.max(1, targetWidth - 2 - effectivePad * 2);
  const padStr = " ".repeat(effectivePad);

  const buildBorder = (
    leftCorner: string,
    rightCorner: string,
    label?: string,
  ): string => {
    const inside = targetWidth - 2;
    if (!label || inside < 6) {
      return fitLine(
        colorBorder(leftCorner + "─".repeat(inside) + rightCorner),
        targetWidth,
      );
    }
    const maxLabelW = Math.max(1, inside - 4);
    const fitted = fitLine(label, maxLabelW);
    const labelW = visibleWidth(fitted);
    const rightDashes = Math.max(1, inside - 3 - labelW);
    return fitLine(
      colorBorder(`${leftCorner}─ `) +
        fitted +
        colorBorder(` ${"─".repeat(rightDashes)}${rightCorner}`),
      targetWidth,
    );
  };

  const result: string[] = [buildBorder("╭", "╮", options?.title)];
  const vBar = colorBorder("│");

  for (const line of lines) {
    const content = fitLine(line, innerWidth, { pad: true });
    result.push(fitLine(`${vBar}${padStr}${content}${padStr}${vBar}`, targetWidth));
  }

  result.push(buildBorder("╰", "╯", options?.footer));
  return result;
}

/**
 * Render an adaptive table that drops lower-priority columns on narrow widths
 * and guarantees `visibleWidth(line) <= width` for every output row.
 */
export function renderTable<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  width: number,
  options?: RenderTableOptions,
): string[] {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0 || columns.length === 0) return [];

  const gap = Math.max(1, options?.columnGap ?? 2);
  const showHeader = options?.header ?? true;
  const theme = options?.theme;

  // Select columns that fit within targetWidth using priority order (keep original display order)
  const indexed = columns.map((col, index) => ({
    col,
    index,
    priority: col.priority ?? 100 - index,
  }));
  const byPriority = [...indexed].sort(
    (a, b) => b.priority - a.priority || a.index - b.index,
  );

  const chosen: typeof indexed = [];
  let minUsed = 0;
  for (const item of byPriority) {
    const extra = item.col.minWidth + (chosen.length > 0 ? gap : 0);
    if (chosen.length === 0 || minUsed + extra <= targetWidth) {
      chosen.push(item);
      minUsed += extra;
    }
  }
  chosen.sort((a, b) => a.index - b.index);
  const activeCols = chosen.map((item) => item.col);

  // Measure desired widths across header and visible rows
  const maxRows = options?.maxRows;
  let visibleRows = rows;
  let hiddenCount = 0;
  if (maxRows !== undefined && maxRows >= 0 && rows.length > maxRows) {
    visibleRows = rows.slice(0, maxRows);
    hiddenCount = rows.length - maxRows;
  }

  const renderedCells = visibleRows.map((row) =>
    activeCols.map((col) => normalizeSingleLine(col.render(row))),
  );

  const widths = activeCols.map((col, cIdx) => {
    let desired = showHeader ? visibleWidth(col.header) : 0;
    for (const r of renderedCells) {
      desired = Math.max(desired, visibleWidth(r[cIdx] ?? ""));
    }
    const minW = Math.min(col.minWidth, targetWidth);
    const bounded = Math.max(minW, desired);
    return col.maxWidth !== undefined ? Math.min(bounded, col.maxWidth) : bounded;
  });

  const totalGap = gap * Math.max(0, activeCols.length - 1);
  const availableForCols = Math.max(1, targetWidth - totalGap);
  const sumW = widths.reduce((a, b) => a + b, 0);

  if (sumW > availableForCols) {
    let excess = sumW - availableForCols;
    const shrinkOrder = activeCols
      .map((col, idx) => ({ idx, flex: col.flex ?? 0, minW: col.minWidth }))
      .sort((a, b) => b.flex - a.flex || (widths[b.idx] ?? 0) - (widths[a.idx] ?? 0));

    for (const item of shrinkOrder) {
      if (excess <= 0) break;
      const cur = widths[item.idx] ?? 0;
      const canDrop = Math.max(0, cur - item.minW);
      const drop = Math.min(canDrop, excess);
      widths[item.idx] = cur - drop;
      excess -= drop;
    }

    while (excess > 0) {
      let reduced = false;
      for (let i = widths.length - 1; i >= 0 && excess > 0; i--) {
        if ((widths[i] ?? 0) > 1) {
          widths[i] = (widths[i] ?? 1) - 1;
          excess--;
          reduced = true;
        }
      }
      if (!reduced) break;
    }
  } else if (sumW < availableForCols) {
    let spare = availableForCols - sumW;
    const flexCols = activeCols
      .map((col, idx) => ({ idx, flex: col.flex ?? 0, maxW: col.maxWidth }))
      .filter((c) => c.flex > 0);
    const totalFlex = flexCols.reduce((a, c) => a + c.flex, 0);
    if (totalFlex > 0) {
      for (const fc of flexCols) {
        if (spare <= 0) break;
        const share = Math.floor((spare * fc.flex) / totalFlex);
        const cur = widths[fc.idx] ?? 0;
        const maxAdd =
          fc.maxW !== undefined ? Math.max(0, fc.maxW - cur) : spare;
        const add = Math.min(share || spare, maxAdd, spare);
        widths[fc.idx] = cur + add;
        spare -= add;
      }
    }
  }

  const gapStr = " ".repeat(gap);
  const formatRow = (cells: readonly string[], isHeaderRow: boolean): string => {
    const parts = activeCols.map((col, idx) => {
      const colW = widths[idx] ?? 1;
      const cell = cells[idx] ?? "";
      const styled = isHeaderRow && theme ? theme.fg("muted", theme.bold(cell)) : cell;
      return col.align === "right" ? padLeft(styled, colW) : padRight(styled, colW);
    });
    return fitLine(parts.join(gapStr), targetWidth);
  };

  const out: string[] = [];
  if (showHeader) {
    out.push(
      formatRow(
        activeCols.map((c) => c.header),
        true,
      ),
    );
    const sep = "─".repeat(Math.min(targetWidth, widths.reduce((a, b) => a + b, 0) + totalGap));
    out.push(fitLine(theme ? theme.fg("borderMuted", sep) : sep, targetWidth));
  }

  for (const cells of renderedCells) {
    out.push(formatRow(cells, false));
  }

  if (hiddenCount > 0) {
    const more = `… +${hiddenCount} more row${hiddenCount === 1 ? "" : "s"}`;
    out.push(fitLine(theme ? theme.fg("muted", more) : more, targetWidth));
  }

  return out;
}

// ============================================================================
// Pure Swarm Collaboration Graph Builder (Spawn Tree + Peer @mentions)
// ============================================================================

function getOrderedRunMembers(run: SwarmRunState): SwarmMemberRecord[] {
  const seen = new Set<string>();
  const out: SwarmMemberRecord[] = [];
  for (const name of run.memberOrder) {
    const member = run.members[name];
    if (member) {
      seen.add(name);
      out.push(member);
    }
  }
  for (const member of Object.values(run.members)) {
    if (!seen.has(member.name)) {
      out.push(member);
    }
  }
  return out;
}

function styleMemberStateIcon(
  state: SwarmMemberState,
  theme?: StyleTheme,
): string {
  const icon = memberStateIcon(state);
  if (!theme) return icon;
  switch (state) {
    case "working":
      return theme.fg("accent", icon);
    case "waiting":
      return theme.fg("muted", icon);
    case "stopped":
      return theme.fg("warning", icon);
    case "killed":
      return theme.fg("dim", icon);
  }
}

/**
 * Build a clean ASCII/Unicode Swarm collaboration graph showing:
 * 1. **Spawn Tree** (`orchestrator` -> top-level members -> helper sub-members,
 *    with live state icon, role, model snippet, and workspace badge).
 * 2. **Peer `@mention` Interactions** (`a ⇄ b (N msgs)`, `a → b (N msg)` derived from `board`).
 *
 * Every output line is strictly guaranteed `visibleWidth(line) <= width`.
 */
export function buildSwarmGraphLines(
  run: SwarmRunState,
  board: readonly BoardMessage[],
  width: number,
  options?: SwarmGraphOptions,
): string[] {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0) return [];

  const theme = options?.theme;
  const lines: string[] = [];

  // --------------------------------------------------------------------------
  // 1. Spawn Tree
  // --------------------------------------------------------------------------
  lines.push(
    targetWidth >= 18
      ? renderHorizontalRule(targetWidth, "Spawn Tree", theme)
      : fitLine("Spawn Tree", targetWidth),
  );

  const orchModel = run.roleModels?.orchestrator?.model
    ? shortenModelName(run.roleModels.orchestrator.model, targetWidth >= 60 ? 20 : 12)
    : "";
  const orchLabel = formatMemberRoleBadge(ORCHESTRATOR_NAME, theme);
  const runBadge = formatRunStatusBadge(run.status, theme);
  const orchModelPart = orchModel
    ? ` ${theme ? theme.fg("dim", `[${orchModel}]`) : `[${orchModel}]`}`
    : "";
  const rootIcon = theme ? theme.fg("borderAccent", "◆") : "◆";
  lines.push(
    fitLine(`${rootIcon} ${orchLabel} [${runBadge}]${orchModelPart}`, targetWidth),
  );

  const ordered = getOrderedRunMembers(run);
  const byName = new Map<string, SwarmMemberRecord>();
  for (const m of ordered) {
    byName.set(m.name, m);
  }

  const childrenOf = new Map<string, SwarmMemberRecord[]>();
  const topLevel: SwarmMemberRecord[] = [];
  for (const m of ordered) {
    const parent = m.parentName?.trim();
    if (
      !parent ||
      parent === ORCHESTRATOR_NAME ||
      parent === "coordinator" ||
      parent === m.name ||
      !byName.has(parent)
    ) {
      topLevel.push(m);
    } else {
      const list = childrenOf.get(parent) ?? [];
      list.push(m);
      childrenOf.set(parent, list);
    }
  }

  const visited = new Set<string>();
  const renderNode = (
    member: SwarmMemberRecord,
    prefix: string,
    isLast: boolean,
  ): void => {
    if (visited.has(member.name)) return;
    visited.add(member.name);

    const connectorRaw = isLast ? "└── " : "├── ";
    const connector = theme ? theme.fg("borderMuted", connectorRaw) : connectorRaw;
    const icon = styleMemberStateIcon(member.state, theme);
    const nameStr = theme
      ? member.state === "killed"
        ? theme.fg("dim", member.name)
        : theme.bold(member.name)
      : member.name;
    const roleStr = formatMemberRoleBadge(member.role, theme);
    const modelShort = member.model
      ? shortenModelName(member.model, targetWidth >= 70 ? 20 : 12)
      : "";
    const modelPart = modelShort
      ? ` ${theme ? theme.fg("dim", `[${modelShort}]`) : `[${modelShort}]`}`
      : "";
    const wsBadge = formatWorkspaceBadge(member.workspace, member.branch, theme);
    const stateTag =
      targetWidth >= 72
        ? ` ${formatMemberStateBadge(member.state, theme)}`
        : "";

    const row = `${prefix}${connector}${icon} ${nameStr} (${roleStr})${stateTag}${modelPart} ${wsBadge}`;
    lines.push(fitLine(row, targetWidth));

    const kids = (childrenOf.get(member.name) ?? []).filter(
      (k) => !visited.has(k.name),
    );
    const childPrefix =
      prefix +
      (isLast
        ? "    "
        : theme
          ? theme.fg("borderMuted", "│   ")
          : "│   ");
    for (let i = 0; i < kids.length; i++) {
      renderNode(kids[i]!, childPrefix, i === kids.length - 1);
    }
  };

  if (ordered.length === 0) {
    const empty = "└── (no members spawned yet)";
    lines.push(fitLine(theme ? theme.fg("muted", empty) : empty, targetWidth));
  } else {
    // Identify any defensive cycle orphans up front so root tree connectors are exact
    const reachable = new Set<string>();
    const markReachable = (member: SwarmMemberRecord): void => {
      if (reachable.has(member.name)) return;
      reachable.add(member.name);
      for (const kid of childrenOf.get(member.name) ?? []) {
        markReachable(kid);
      }
    };
    for (const root of topLevel) {
      markReachable(root);
    }
    const orphans = ordered.filter((m) => !reachable.has(m.name));
    const allRoots = [...topLevel, ...orphans];
    for (let i = 0; i < allRoots.length; i++) {
      const root = allRoots[i]!;
      if (visited.has(root.name)) continue;
      // Check if any later root in allRoots is still unvisited
      const hasMoreRoots = allRoots.slice(i + 1).some((r) => !visited.has(r.name));
      renderNode(root, "", !hasMoreRoots);
    }
  }

  // --------------------------------------------------------------------------
  // 2. Peer @mention Interactions
  // --------------------------------------------------------------------------
  lines.push("");
  lines.push(
    targetWidth >= 24
      ? renderHorizontalRule(targetWidth, "Peer @mention Interactions", theme)
      : targetWidth >= 14
        ? renderHorizontalRule(targetWidth, "@mentions", theme)
        : fitLine("@mentions", targetWidth),
  );

  const directedCounts = new Map<string, number>();
  const channelCounts = new Map<string, number>();

  for (const msg of board) {
    const sender = sanitizePlainText(msg.from).replace(/^@+/, "");
    if (!sender) continue;

    for (const rawMention of msg.mentions) {
      const target = sanitizePlainText(rawMention).replace(/^@+/, "");
      if (!target || target === sender) continue;
      const key = `${sender}\0${target}`;
      directedCounts.set(key, (directedCounts.get(key) ?? 0) + 1);
    }

    for (const rawCh of msg.channelMentions ?? []) {
      const ch = sanitizePlainText(rawCh).replace(/^@#?/, "");
      if (!ch) continue;
      const key = `${sender}\0#${ch}`;
      channelCounts.set(key, (channelCounts.get(key) ?? 0) + 1);
    }
  }

  interface InteractionEdge {
    left: string;
    right: string;
    bidirectional: boolean;
    total: number;
    sortKey: string;
  }

  const edges: InteractionEdge[] = [];
  const handledPairs = new Set<string>();

  for (const [key, ab] of directedCounts.entries()) {
    const sep = key.indexOf("\0");
    if (sep < 0) continue;
    const a = key.slice(0, sep);
    const b = key.slice(sep + 1);
    const pairKey = a < b ? `${a}\0${b}` : `${b}\0${a}`;
    if (handledPairs.has(pairKey)) continue;
    handledPairs.add(pairKey);

    const ba = directedCounts.get(`${b}\0${a}`) ?? 0;
    if (ab > 0 && ba > 0) {
      const [first, second] =
        ab > ba || (ab === ba && a <= b) ? [a, b] : [b, a];
      const total = ab + ba;
      edges.push({
        left: first,
        right: second,
        bidirectional: true,
        total,
        sortKey: `${first}<->${second}`,
      });
    } else if (ab > 0) {
      edges.push({
        left: a,
        right: b,
        bidirectional: false,
        total: ab,
        sortKey: `${a}->${b}`,
      });
    }
  }

  for (const [key, count] of channelCounts.entries()) {
    const sep = key.indexOf("\0");
    if (sep < 0) continue;
    const from = key.slice(0, sep);
    const ch = key.slice(sep + 1);
    edges.push({
      left: from,
      right: ch,
      bidirectional: false,
      total: count,
      sortKey: `${from}->${ch}`,
    });
  }

  edges.sort((x, y) => y.total - x.total || x.sortKey.localeCompare(y.sortKey));

  if (edges.length === 0) {
    const none = "  (no @mention interactions yet)";
    lines.push(fitLine(theme ? theme.fg("muted", none) : none, targetWidth));
  } else {
    for (const edge of edges) {
      const arrowRaw = edge.bidirectional ? "⇄" : "→";
      const countText = `(${edge.total} ${edge.total === 1 ? "msg" : "msgs"})`;
      if (theme) {
        const leftStyled = theme.bold(edge.left);
        const arrowStyled = theme.fg(
          edge.bidirectional ? "accent" : "borderAccent",
          arrowRaw,
        );
        const rightStyled = edge.right.startsWith("#")
          ? theme.fg("accent", edge.right)
          : theme.bold(edge.right);
        const countStyled = theme.fg("muted", countText);
        lines.push(
          fitLine(
            `  ${leftStyled} ${arrowStyled} ${rightStyled} ${countStyled}`,
            targetWidth,
          ),
        );
      } else {
        lines.push(
          fitLine(
            `  ${edge.left} ${arrowRaw} ${edge.right} ${countText}`,
            targetWidth,
          ),
        );
      }
    }
  }

  return lines.map((line) => fitLine(line, targetWidth));
}

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  decodeKittyPrintable,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { SWARM_SETTINGS_BOUNDS } from "../store/index.js";
import type {
  ConfirmProposalOptions,
  InitialMemberProposal,
  IQuestionnaireUI,
  ProposalDialogAction,
  ProposalDialogOutcome,
  ProposedSwarmPlan,
  QuestionAnswer,
  QuestionnaireResult,
  QuestionOption,
  QuestionSpec,
  SwarmDraftMode,
  SwarmRoleModels,
} from "../types.js";
import {
  fitLine,
  formatMemberRoleBadge,
  formatRoleModelsLine,
  formatWorkspaceBadge,
  joinColumns,
  renderBox,
  renderHorizontalRule,
  sanitizePlainText,
  visibleWidth,
  wrapLines,
} from "./text-utils.js";

export interface QuestionnaireUIOptions {
  onModalEnter?: () => void;
  onModalExit?: () => void;
}

interface NormalizedOption {
  label: string;
  value: string;
  description?: string;
  isRecommended: boolean;
  isCustom: boolean;
}

const CUSTOM_OPTION_LABEL = "Custom answer…";
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = SWARM_SETTINGS_BOUNDS.maxConcurrency.max;

function decodePrintableChar(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) return data;
  }
  return undefined;
}

function normalizeQuestionOptions(spec: QuestionSpec): {
  options: NormalizedOption[];
  initialIndex: number;
  hasPresetOptions: boolean;
} {
  const recRaw = spec.recommended?.trim().toLowerCase();
  const normalized: NormalizedOption[] = spec.options.map((opt: QuestionOption) => {
    const value = opt.value ?? opt.label;
    const safeVal = sanitizePlainText(value);
    const isRecommended =
      recRaw !== undefined &&
      recRaw.length > 0 &&
      (value.trim().toLowerCase() === recRaw ||
        opt.label.trim().toLowerCase() === recRaw);
    return {
      label: sanitizePlainText(opt.label) || safeVal || "(option)",
      value,
      description: opt.description ? sanitizePlainText(opt.description) : undefined,
      isRecommended,
      isCustom: false,
    };
  });

  const allowCustom = spec.allowCustom !== false || normalized.length === 0;
  if (allowCustom) {
    normalized.push({
      label: CUSTOM_OPTION_LABEL,
      value: "__custom__",
      description: "Type your own answer inline",
      isRecommended: false,
      isCustom: true,
    });
  }

  const recIndex = normalized.findIndex((o) => o.isRecommended);
  return {
    options: normalized,
    initialIndex: recIndex >= 0 ? recIndex : 0,
    hasPresetOptions: spec.options.length > 0,
  };
}

function computeDialogMaxLines(tui: TUI): number {
  const rows = tui.terminal?.rows ?? 24;
  return Math.max(10, Math.min(28, rows - 4));
}

function computeInnerWidth(outerWidth: number): number {
  if (outerWidth < 12) return Math.max(1, outerWidth);
  const padX = outerWidth < 24 ? 0 : 1;
  return Math.max(1, outerWidth - 2 - padX * 2);
}

function deriveTabLabel(spec: QuestionSpec, index: number): string {
  const idClean = sanitizePlainText(spec.id).replace(/[_-]+/g, " ");
  if (idClean && idClean.length <= 16) return idClean;
  const qClean = sanitizePlainText(spec.question);
  const words = qClean.split(/\s+/).slice(0, 2).join(" ");
  return words || `Q${index + 1}`;
}

async function withModalGuard<T>(
  opts: QuestionnaireUIOptions | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  opts?.onModalEnter?.();
  try {
    return await fn();
  } finally {
    opts?.onModalExit?.();
  }
}

/**
 * Build compact initial-member preview lines for a proposed dynamic Swarm plan.
 */
export function buildInitialMembersSummaryLines(
  members: readonly InitialMemberProposal[] | undefined,
  width: number,
  theme?: Theme,
  maxLines = 3,
): string[] {
  const targetWidth = Math.max(0, Math.floor(width));
  if (targetWidth === 0 || !members || members.length === 0) return [];

  const limit = Math.max(1, maxLines);
  const visible =
    members.length > limit ? members.slice(0, Math.max(1, limit - 1)) : members;
  const out: string[] = [];

  for (const m of visible) {
    const nameStr = theme ? theme.bold(sanitizePlainText(m.name)) : sanitizePlainText(m.name);
    const roleStr = formatMemberRoleBadge(m.role, theme);
    const wsStr = formatWorkspaceBadge(m.workspace ?? "inherit", undefined, theme);
    const briefStr = sanitizePlainText(m.brief);
    const briefPart = briefStr
      ? theme
        ? theme.fg("muted", ` — ${briefStr}`)
        : ` — ${briefStr}`
      : "";
    out.push(
      fitLine(`  • ${nameStr} (${roleStr}, ${wsStr})${briefPart}`, targetWidth),
    );
  }

  if (members.length > visible.length) {
    const extra = members.length - visible.length;
    const more = `  … +${extra} more initial member${extra === 1 ? "" : "s"}`;
    out.push(fitLine(theme ? theme.fg("dim", more) : more, targetWidth));
  }

  return out;
}

// ============================================================================
// Basic Dialog Fallback (RPC / Non-TUI with hasUI)
// ============================================================================

async function askQuestionBasic(
  ctx: ExtensionContext,
  spec: QuestionSpec,
  signal?: AbortSignal,
  prefix?: string,
): Promise<{ cancelled: boolean; answer?: string; isCustom: boolean }> {
  if (signal?.aborted) {
    return { cancelled: true, isCustom: false };
  }

  const titleBase = sanitizePlainText(spec.question);
  const title = prefix ? `${prefix} ${titleBase}` : titleBase;
  const { options, hasPresetOptions } = normalizeQuestionOptions(spec);
  const dialogOpts = signal ? { signal } : undefined;

  if (!hasPresetOptions) {
    const typed = await ctx.ui.input(
      title,
      spec.context ? sanitizePlainText(spec.context) : "Type your answer...",
      dialogOpts,
    );
    if (typed === undefined || signal?.aborted) {
      return { cancelled: true, isCustom: false };
    }
    const trimmed = typed.trim();
    if (!trimmed) {
      return { cancelled: true, isCustom: false };
    }
    return { cancelled: false, answer: trimmed, isCustom: true };
  }

  const labelToOption = new Map<string, NormalizedOption>();
  const selectLabels: string[] = [];

  for (const opt of options) {
    let display = opt.label;
    if (opt.isRecommended) {
      display += " (recommended)";
    }
    if (opt.description && !opt.isCustom) {
      display += ` — ${opt.description}`;
    }
    let uniqueDisplay = display;
    let suffix = 2;
    while (labelToOption.has(uniqueDisplay)) {
      uniqueDisplay = `${display} (${suffix++})`;
    }
    labelToOption.set(uniqueDisplay, opt);
    selectLabels.push(uniqueDisplay);
  }

  const picked = await ctx.ui.select(title, selectLabels, dialogOpts);
  if (picked === undefined || signal?.aborted) {
    return { cancelled: true, isCustom: false };
  }

  const chosen = labelToOption.get(picked);
  if (!chosen) {
    return { cancelled: false, answer: picked, isCustom: false };
  }

  if (chosen.isCustom) {
    const typed = await ctx.ui.input(
      title,
      "Type your custom answer...",
      dialogOpts,
    );
    if (typed === undefined || signal?.aborted) {
      return { cancelled: true, isCustom: false };
    }
    const trimmed = typed.trim();
    if (!trimmed) {
      return { cancelled: true, isCustom: false };
    }
    return { cancelled: false, answer: trimmed, isCustom: true };
  }

  return { cancelled: false, answer: chosen.value, isCustom: false };
}

async function confirmProposalBasic(
  ctx: ExtensionContext,
  plan: ProposedSwarmPlan,
  options?: {
    mode?: SwarmDraftMode;
    signal?: AbortSignal;
  },
): Promise<ProposalDialogOutcome> {
  let validatorEnabled = plan.validatorEnabled;
  let maxConcurrency = Math.max(
    MIN_CONCURRENCY,
    Math.min(MAX_CONCURRENCY, Math.round(plan.maxConcurrency || 6)),
  );
  const signal = options?.signal;
  const dialogOpts = signal ? { signal } : undefined;

  const modelsLine = formatRoleModelsLine(plan.roleModels, "host default");
  const initialCount = plan.initialMembers?.length ?? 0;
  const membersNote =
    initialCount > 0
      ? ` · ${initialCount} initial member${initialCount === 1 ? "" : "s"}`
      : "";
  const planTitle = sanitizePlainText(plan.title);

  while (!signal?.aborted) {
    const header = [
      options?.mode === "tweak"
        ? "Swarm Plan Confirmation (Revision)"
        : "Swarm Plan Confirmation",
      planTitle ? `${planTitle}` : sanitizePlainText(plan.objective),
      `base:${sanitizePlainText(plan.baseBranch)}${membersNote}`,
      `Models: ${modelsLine}`,
      `Independent Validator Policy: ${validatorEnabled ? "ON" : "OFF"} · Max Concurrency: ${maxConcurrency}`,
    ].join(" — ");

    const confirmOpt = "Confirm — launch dynamic Swarm (recommended)";
    const continueOpt = "Continue refining";
    const toggleValOpt = `Toggle Independent Validator Policy (currently ${validatorEnabled ? "ON" : "OFF"})`;
    const incConcOpt = `Increase Max Concurrency (currently ${maxConcurrency})`;
    const decConcOpt = `Decrease Max Concurrency (currently ${maxConcurrency})`;
    const cancelOpt = "Cancel — discard draft";

    const selectOptions: string[] = [confirmOpt, continueOpt, toggleValOpt];
    if (maxConcurrency < MAX_CONCURRENCY) selectOptions.push(incConcOpt);
    if (maxConcurrency > MIN_CONCURRENCY) selectOptions.push(decConcOpt);
    selectOptions.push(cancelOpt);

    const choice = await ctx.ui.select(header, selectOptions, dialogOpts);

    if (choice === undefined || signal?.aborted) {
      return {
        action: "continue",
        validatorEnabled,
        maxConcurrency,
      };
    }
    if (choice === toggleValOpt) {
      validatorEnabled = !validatorEnabled;
      continue;
    }
    if (choice === incConcOpt) {
      maxConcurrency = Math.min(MAX_CONCURRENCY, maxConcurrency + 1);
      continue;
    }
    if (choice === decConcOpt) {
      maxConcurrency = Math.max(MIN_CONCURRENCY, maxConcurrency - 1);
      continue;
    }
    if (choice === confirmOpt) {
      return {
        action: "confirm",
        validatorEnabled,
        maxConcurrency,
      };
    }
    if (choice === cancelOpt) {
      return {
        action: "cancel",
        validatorEnabled,
        maxConcurrency,
      };
    }
    return {
      action: "continue",
      validatorEnabled,
      maxConcurrency,
    };
  }

  return {
    action: "continue",
    validatorEnabled,
    maxConcurrency,
  };
}

// ============================================================================
// TUI Custom Components (IME Focusable + Height-Bounded)
// ============================================================================

class SingleQuestionComponent implements Component, Focusable {
  private _focused = false;
  private selectedIndex: number;
  private inCustomInput: boolean;
  private readonly options: NormalizedOption[];
  private readonly hasPresetOptions: boolean;
  private readonly input: Input;
  private prevHardwareCursor: boolean | null = null;
  private validationHint: string | undefined;
  private settled = false;
  private readonly onAbort?: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly spec: QuestionSpec,
    private readonly done: (result: {
      cancelled: boolean;
      answer?: string;
      isCustom: boolean;
    }) => void,
    private readonly signal?: AbortSignal,
  ) {
    const norm = normalizeQuestionOptions(spec);
    this.options = norm.options;
    this.selectedIndex = norm.initialIndex;
    this.hasPresetOptions = norm.hasPresetOptions;
    this.inCustomInput = !norm.hasPresetOptions;

    this.input = new Input({
      prompt: "› ",
      placeholder: "Type your custom answer…",
      placeholderStyle: (t) => this.theme.fg("dim", t),
    });

    this.input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        this.validationHint = "Please enter an answer or press Esc to go back.";
        this.tui.requestRender();
        return;
      }
      this.finish({ cancelled: false, answer: trimmed, isCustom: true });
    };

    this.input.onEscape = () => {
      this.validationHint = undefined;
      if (!this.hasPresetOptions) {
        this.finish({ cancelled: true, isCustom: false });
        return;
      }
      this.setCustomInputMode(false);
      this.tui.requestRender();
    };

    if (this.inCustomInput) {
      this.setCustomInputMode(true);
    }

    if (signal) {
      if (signal.aborted) {
        this.finish({ cancelled: true, isCustom: false });
      } else {
        this.onAbort = () => this.finish({ cancelled: true, isCustom: false });
        signal.addEventListener("abort", this.onAbort, { once: true });
      }
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.inCustomInput;
  }

  private setCustomInputMode(active: boolean): void {
    if (active) {
      if (this.prevHardwareCursor === null) {
        this.prevHardwareCursor = this.tui.getShowHardwareCursor();
      }
      this.inCustomInput = true;
      this.input.focused = this._focused;
      this.tui.setShowHardwareCursor(true);
    } else {
      this.inCustomInput = false;
      this.input.focused = false;
      if (this.prevHardwareCursor !== null) {
        this.tui.setShowHardwareCursor(this.prevHardwareCursor);
        this.prevHardwareCursor = null;
      }
    }
  }

  private finish(result: {
    cancelled: boolean;
    answer?: string;
    isCustom: boolean;
  }): void {
    if (this.settled) return;
    this.settled = true;
    this.dispose();
    this.done(result);
  }

  dispose(): void {
    if (this.onAbort && this.signal) {
      this.signal.removeEventListener("abort", this.onAbort);
    }
    this.setCustomInputMode(false);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (this.inCustomInput) {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.finish({ cancelled: true, isCustom: false });
        return;
      }
      this.validationHint = undefined;
      this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish({ cancelled: true, isCustom: false });
      return;
    }

    const ch = decodePrintableChar(data);

    if (matchesKey(data, Key.up) || ch === "k") {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.options.length) % this.options.length;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || ch === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % this.options.length;
      this.tui.requestRender();
      return;
    }

    if (ch && ch >= "1" && ch <= "9") {
      const idx = Number(ch) - 1;
      if (idx < this.options.length) {
        this.selectedIndex = idx;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const chosen = this.options[this.selectedIndex];
      if (!chosen) return;
      if (chosen.isCustom) {
        this.setCustomInputMode(true);
        this.tui.requestRender();
      } else {
        this.finish({
          cancelled: false,
          answer: chosen.value,
          isCustom: false,
        });
      }
    }
  }

  render(width: number): string[] {
    const targetWidth = Math.max(1, Math.floor(width));
    const innerWidth = computeInnerWidth(targetWidth);
    const maxTotalLines = computeDialogMaxLines(this.tui);
    const maxInnerLines = Math.max(5, maxTotalLines - 2);

    const body: string[] = [];

    const qWrapped = wrapLines(
      this.theme.bold(sanitizePlainText(this.spec.question)),
      innerWidth,
      3,
    );
    body.push(...qWrapped);

    if (this.spec.context) {
      const ctxWrapped = wrapLines(
        this.theme.fg("muted", sanitizePlainText(this.spec.context)),
        innerWidth,
        2,
      );
      body.push(...ctxWrapped);
    }

    body.push("");

    const tailLines: string[] = [];
    if (this.inCustomInput) {
      tailLines.push(
        fitLine(this.theme.fg("accent", "Custom answer:"), innerWidth),
      );
      const inputW = Math.max(1, innerWidth - 2);
      const inputLine = this.input.render(inputW)[0] ?? "";
      tailLines.push("  " + inputLine);
      if (this.validationHint) {
        tailLines.push(
          fitLine(this.theme.fg("warning", this.validationHint), innerWidth),
        );
      }
    }

    const hint = this.inCustomInput
      ? "[Enter] submit · [Esc] back"
      : "[↑↓] move · [1-9] jump · [Enter] select · [Esc] cancel";
    tailLines.push(fitLine(this.theme.fg("dim", hint), innerWidth));

    const optionRowBudget = Math.max(
      1,
      maxInnerLines - body.length - tailLines.length,
    );

    if (this.hasPresetOptions) {
      renderOptionListWindow(
        body,
        this.options,
        this.selectedIndex,
        undefined,
        innerWidth,
        optionRowBudget,
        this.theme,
      );
    }

    body.push(...tailLines);

    return renderBox(body.slice(0, maxInnerLines), targetWidth, {
      title: this.theme.fg("accent", this.theme.bold("🐝 Swarm Question")),
      borderColor: (s) => this.theme.fg("borderAccent", s),
    });
  }
}

function renderOptionListWindow(
  out: string[],
  options: readonly NormalizedOption[],
  selectedIndex: number,
  chosenValue: string | undefined,
  innerWidth: number,
  budgetLines: number,
  theme: Theme,
): void {
  if (options.length === 0 || budgetLines <= 0) return;

  const startOutLen = out.length;
  const canShowDesc = budgetLines >= options.length * 2;
  const rowsPerOption = canShowDesc ? 2 : 1;
  const needsScroll = options.length * rowsPerOption > budgetLines;
  const indicatorReserve = needsScroll && budgetLines >= 4 ? 2 : 0;
  const effectiveBudget = Math.max(1, budgetLines - indicatorReserve);
  const maxVisibleOptions = Math.max(1, Math.floor(effectiveBudget / rowsPerOption));

  let start = 0;
  if (options.length > maxVisibleOptions) {
    start = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(maxVisibleOptions / 2),
        options.length - maxVisibleOptions,
      ),
    );
  }
  const end = Math.min(options.length, start + maxVisibleOptions);

  if (start > 0 && indicatorReserve > 0) {
    out.push(fitLine(theme.fg("dim", `  ↑ ${start} more above`), innerWidth));
  }

  for (let i = start; i < end; i++) {
    if (
      out.length - startOutLen >=
      budgetLines - (end < options.length && indicatorReserve > 0 ? 1 : 0)
    ) {
      break;
    }
    const opt = options[i]!;
    const isSel = i === selectedIndex;
    const isPicked =
      chosenValue !== undefined && !opt.isCustom && chosenValue === opt.value;
    const pointer = isSel ? theme.fg("accent", "› ") : "  ";
    const num = theme.fg("muted", `${i + 1}. `);
    const labelText = isSel
      ? theme.fg("accent", theme.bold(opt.label))
      : opt.isCustom
        ? theme.fg("muted", opt.label)
        : opt.label;
    const recBadge = opt.isRecommended
      ? " " + theme.fg("success", "★ recommended")
      : "";
    const pickedBadge = isPicked ? " " + theme.fg("accent", "✓") : "";

    out.push(
      fitLine(`${pointer}${num}${labelText}${recBadge}${pickedBadge}`, innerWidth),
    );

    if (
      canShowDesc &&
      opt.description &&
      out.length - startOutLen <
        budgetLines - (end < options.length && indicatorReserve > 0 ? 1 : 0)
    ) {
      out.push(
        fitLine(theme.fg("dim", `     ${opt.description}`), innerWidth),
      );
    }
  }

  if (
    end < options.length &&
    indicatorReserve > 0 &&
    out.length - startOutLen < budgetLines
  ) {
    out.push(
      fitLine(theme.fg("dim", `  ↓ ${options.length - end} more below`), innerWidth),
    );
  }
}

class MultiQuestionComponent implements Component, Focusable {
  private _focused = false;
  private activeTab = 0; // 0..questions.length-1 = questions, questions.length = Submit tab
  private readonly normalizedByTab: {
    options: NormalizedOption[];
    hasPresetOptions: boolean;
  }[];
  private readonly cursors: number[];
  private readonly answers: Map<
    string,
    { answer: string; isCustom: boolean }
  > = new Map();
  private submitCursor = 0;
  private inCustomInput = false;
  private readonly input: Input;
  private prevHardwareCursor: boolean | null = null;
  private validationHint: string | undefined;
  private settled = false;
  private readonly onAbort?: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly questions: readonly QuestionSpec[],
    private readonly done: (result: QuestionnaireResult) => void,
    private readonly signal?: AbortSignal,
  ) {
    this.normalizedByTab = questions.map((q) => {
      const n = normalizeQuestionOptions(q);
      return { options: n.options, hasPresetOptions: n.hasPresetOptions };
    });
    this.cursors = questions.map((q) => normalizeQuestionOptions(q).initialIndex);

    this.input = new Input({
      prompt: "› ",
      placeholder: "Type your custom answer…",
      placeholderStyle: (t) => this.theme.fg("dim", t),
    });

    this.input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        this.validationHint = "Please enter an answer or press Esc to go back.";
        this.tui.requestRender();
        return;
      }
      const q = this.questions[this.activeTab];
      if (q) {
        this.answers.set(q.id, { answer: trimmed, isCustom: true });
      }
      this.validationHint = undefined;
      this.setCustomInputMode(false);
      this.advanceAfterAnswer();
      this.tui.requestRender();
    };

    this.input.onEscape = () => {
      this.validationHint = undefined;
      this.setCustomInputMode(false);
      this.tui.requestRender();
    };

    if (signal) {
      if (signal.aborted) {
        this.finish({ cancelled: true, answers: {}, items: [] });
      } else {
        this.onAbort = () =>
          this.finish({ cancelled: true, answers: {}, items: [] });
        signal.addEventListener("abort", this.onAbort, { once: true });
      }
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.inCustomInput;
  }

  private get submitTabIndex(): number {
    return this.questions.length;
  }

  private get isOnSubmitTab(): boolean {
    return this.activeTab === this.submitTabIndex;
  }

  private setCustomInputMode(active: boolean, initialValue?: string): void {
    if (active) {
      if (this.prevHardwareCursor === null) {
        this.prevHardwareCursor = this.tui.getShowHardwareCursor();
      }
      this.input.setValue(initialValue ?? "");
      this.inCustomInput = true;
      this.input.focused = this._focused;
      this.tui.setShowHardwareCursor(true);
    } else {
      this.inCustomInput = false;
      this.input.focused = false;
      if (this.prevHardwareCursor !== null) {
        this.tui.setShowHardwareCursor(this.prevHardwareCursor);
        this.prevHardwareCursor = null;
      }
    }
  }

  private advanceAfterAnswer(): void {
    if (this.activeTab < this.submitTabIndex) {
      this.activeTab += 1;
      if (this.activeTab === this.submitTabIndex) {
        this.submitCursor = 0;
      }
    }
  }

  private buildResult(): QuestionnaireResult {
    const answersRecord: Record<string, string> = {};
    const items: QuestionAnswer[] = [];
    for (const q of this.questions) {
      const entry = this.answers.get(q.id);
      if (entry) {
        answersRecord[q.id] = entry.answer;
        items.push({
          id: q.id,
          question: q.question,
          answer: entry.answer,
          isCustom: entry.isCustom,
        });
      }
    }
    return { cancelled: false, answers: answersRecord, items };
  }

  private finish(result: QuestionnaireResult): void {
    if (this.settled) return;
    this.settled = true;
    this.dispose();
    this.done(result);
  }

  dispose(): void {
    if (this.onAbort && this.signal) {
      this.signal.removeEventListener("abort", this.onAbort);
    }
    this.setCustomInputMode(false);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private switchTab(delta: number): void {
    const totalTabs = this.questions.length + 1;
    this.activeTab = (this.activeTab + delta + totalTabs) % totalTabs;
    this.validationHint = undefined;
    if (this.isOnSubmitTab) {
      this.submitCursor = 0;
    }
  }

  private getSubmitActions(): {
    id: "jump" | "submit" | "cancel";
    label: string;
  }[] {
    const answeredCount = this.answers.size;
    const total = this.questions.length;
    if (answeredCount >= total) {
      return [
        { id: "submit", label: `Submit all answers (${answeredCount}/${total})` },
        { id: "cancel", label: "Cancel questionnaire" },
      ];
    }
    return [
      {
        id: "jump",
        label: `Jump to first unanswered (${total - answeredCount} remaining)`,
      },
      {
        id: "submit",
        label: `Submit current answers (${answeredCount}/${total})`,
      },
      { id: "cancel", label: "Cancel questionnaire" },
    ];
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (this.inCustomInput) {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.finish({ cancelled: true, answers: {}, items: [] });
        return;
      }
      this.validationHint = undefined;
      this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish({ cancelled: true, answers: {}, items: [] });
      return;
    }

    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.switchTab(-1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.switchTab(1);
      this.tui.requestRender();
      return;
    }

    const ch = decodePrintableChar(data);

    if (this.isOnSubmitTab) {
      const actions = this.getSubmitActions();
      if (matchesKey(data, Key.up) || ch === "k") {
        this.submitCursor =
          (this.submitCursor - 1 + actions.length) % actions.length;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || ch === "j") {
        this.submitCursor = (this.submitCursor + 1) % actions.length;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        const action = actions[this.submitCursor];
        if (!action) return;
        if (action.id === "submit") {
          this.finish(this.buildResult());
        } else if (action.id === "cancel") {
          this.finish({ cancelled: true, answers: {}, items: [] });
        } else {
          const firstUnanswered = this.questions.findIndex(
            (q) => !this.answers.has(q.id),
          );
          if (firstUnanswered >= 0) {
            this.activeTab = firstUnanswered;
          }
          this.tui.requestRender();
        }
      }
      return;
    }

    const tabMeta = this.normalizedByTab[this.activeTab];
    const spec = this.questions[this.activeTab];
    if (!tabMeta || !spec) return;

    const opts = tabMeta.options;
    const cur = this.cursors[this.activeTab] ?? 0;

    if (matchesKey(data, Key.up) || ch === "k") {
      this.cursors[this.activeTab] = (cur - 1 + opts.length) % opts.length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || ch === "j") {
      this.cursors[this.activeTab] = (cur + 1) % opts.length;
      this.tui.requestRender();
      return;
    }
    if (ch && ch >= "1" && ch <= "9") {
      const idx = Number(ch) - 1;
      if (idx < opts.length) {
        this.cursors[this.activeTab] = idx;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const chosen = opts[cur];
      if (!chosen) return;
      if (chosen.isCustom) {
        const existing = this.answers.get(spec.id);
        this.setCustomInputMode(
          true,
          existing?.isCustom ? existing.answer : "",
        );
        this.tui.requestRender();
      } else {
        this.answers.set(spec.id, { answer: chosen.value, isCustom: false });
        this.advanceAfterAnswer();
        this.tui.requestRender();
      }
    }
  }

  private renderTabStrip(innerWidth: number): string {
    const pieces: { idx: number; text: string }[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i]!;
      const answered = this.answers.has(q.id);
      const isActive = i === this.activeTab;
      const mark = answered ? "✓" : isActive ? "•" : "○";
      const raw = `${i + 1}. ${deriveTabLabel(q, i)} ${mark}`;
      const styled = isActive
        ? this.theme.fg("accent", this.theme.bold(raw))
        : answered
          ? this.theme.fg("success", raw)
          : this.theme.fg("muted", raw);
      pieces.push({ idx: i, text: styled });
    }

    const submitLabel = "✓ Submit";
    pieces.push({
      idx: this.submitTabIndex,
      text: this.isOnSubmitTab
        ? this.theme.fg("accent", this.theme.bold(submitLabel))
        : this.theme.fg("muted", submitLabel),
    });

    const sep = this.theme.fg("borderMuted", " │ ");
    const full = pieces.map((p) => p.text).join(sep);
    if (visibleWidth(full) <= innerWidth) {
      return full;
    }

    const activePiece = pieces[this.activeTab]!;
    const selected: typeof pieces = [activePiece];
    let usedW = visibleWidth(activePiece.text);
    const sepW = 3;
    let left = this.activeTab - 1;
    let right = this.activeTab + 1;

    while (left >= 0 || right < pieces.length) {
      let added = false;
      if (right < pieces.length) {
        const p = pieces[right]!;
        const w = visibleWidth(p.text) + sepW;
        if (usedW + w <= innerWidth - 4) {
          selected.push(p);
          usedW += w;
          right++;
          added = true;
        }
      }
      if (left >= 0) {
        const p = pieces[left]!;
        const w = visibleWidth(p.text) + sepW;
        if (usedW + w <= innerWidth - 4) {
          selected.unshift(p);
          usedW += w;
          left--;
          added = true;
        }
      }
      if (!added) break;
    }

    const prefix = left >= 0 ? this.theme.fg("dim", "‹ ") : "";
    const suffix = right < pieces.length ? this.theme.fg("dim", " ›") : "";
    return fitLine(
      prefix + selected.map((p) => p.text).join(sep) + suffix,
      innerWidth,
    );
  }

  render(width: number): string[] {
    const targetWidth = Math.max(1, Math.floor(width));
    const innerWidth = computeInnerWidth(targetWidth);
    const maxTotalLines = computeDialogMaxLines(this.tui);
    const maxInnerLines = Math.max(6, maxTotalLines - 2);

    const body: string[] = [];
    body.push(this.renderTabStrip(innerWidth));
    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));

    if (this.isOnSubmitTab) {
      body.push(
        fitLine(
          this.theme.bold(
            `Review Answers (${this.answers.size}/${this.questions.length} answered)`,
          ),
          innerWidth,
        ),
      );

      const actions = this.getSubmitActions();
      const summaryBudget = Math.max(
        1,
        maxInnerLines - body.length - actions.length - 3,
      );

      const shownQuestions = this.questions.slice(0, summaryBudget);
      for (let i = 0; i < shownQuestions.length; i++) {
        const q = shownQuestions[i]!;
        const ans = this.answers.get(q.id);
        const label = `${i + 1}. ${deriveTabLabel(q, i)}: `;
        const valText = ans
          ? this.theme.fg("success", sanitizePlainText(ans.answer))
          : this.theme.fg("warning", "(unanswered)");
        body.push(fitLine(this.theme.fg("muted", label) + valText, innerWidth));
      }
      if (this.questions.length > shownQuestions.length) {
        body.push(
          fitLine(
            this.theme.fg(
              "dim",
              `… +${this.questions.length - shownQuestions.length} more`,
            ),
            innerWidth,
          ),
        );
      }

      body.push("");
      for (let i = 0; i < actions.length; i++) {
        const act = actions[i]!;
        const isSel = i === this.submitCursor;
        const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
        const text = isSel
          ? this.theme.fg("accent", this.theme.bold(act.label))
          : act.label;
        body.push(fitLine(`${ptr}${text}`, innerWidth));
      }

      body.push(
        fitLine(
          this.theme.fg(
            "dim",
            "[Tab/←→] tabs · [↑↓] move · [Enter] confirm · [Esc] cancel",
          ),
          innerWidth,
        ),
      );
    } else {
      const spec = this.questions[this.activeTab]!;
      const tabMeta = this.normalizedByTab[this.activeTab]!;
      const cur = this.cursors[this.activeTab] ?? 0;
      const saved = this.answers.get(spec.id);

      const qWrapped = wrapLines(
        this.theme.bold(sanitizePlainText(spec.question)),
        innerWidth,
        2,
      );
      body.push(...qWrapped);

      if (spec.context) {
        const ctxWrapped = wrapLines(
          this.theme.fg("muted", sanitizePlainText(spec.context)),
          innerWidth,
          2,
        );
        body.push(...ctxWrapped);
      }

      if (saved) {
        body.push(
          fitLine(
            this.theme.fg(
              "success",
              `Current answer: ${sanitizePlainText(saved.answer)}`,
            ),
            innerWidth,
          ),
        );
      }

      body.push("");

      const tailLines: string[] = [];
      if (this.inCustomInput) {
        tailLines.push(
          fitLine(this.theme.fg("accent", "Custom answer:"), innerWidth),
        );
        const inputW = Math.max(1, innerWidth - 2);
        const inputLine = this.input.render(inputW)[0] ?? "";
        tailLines.push("  " + inputLine);
        if (this.validationHint) {
          tailLines.push(
            fitLine(this.theme.fg("warning", this.validationHint), innerWidth),
          );
        }
      }

      const hint = this.inCustomInput
        ? "[Enter] save & next · [Esc] back"
        : "[Tab/←→] tabs · [↑↓] move · [Enter] select · [Esc] cancel";
      tailLines.push(fitLine(this.theme.fg("dim", hint), innerWidth));

      const optionBudget = Math.max(
        1,
        maxInnerLines - body.length - tailLines.length,
      );

      renderOptionListWindow(
        body,
        tabMeta.options,
        cur,
        saved?.answer,
        innerWidth,
        optionBudget,
        this.theme,
      );

      body.push(...tailLines);
    }

    const title = this.theme.fg(
      "accent",
      this.theme.bold(
        `🐝 Swarm Questionnaire (${this.answers.size}/${this.questions.length})`,
      ),
    );
    return renderBox(body.slice(0, maxInnerLines), targetWidth, {
      title,
      borderColor: (s) => this.theme.fg("borderAccent", s),
    });
  }
}

class ConfirmProposalComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;
  private validatorEnabled: boolean;
  private maxConcurrency: number;
  private roleModels: SwarmRoleModels | undefined;
  private modelsChanged = false;
  private commentText = "";
  private editingComment = false;
  private readonly commentInput = new Input();
  private modelPickerComponent: Component | null = null;
  private settled = false;
  private readonly onAbort?: () => void;

  private readonly choices: {
    action: ProposalDialogAction;
    label: string;
    recommended?: boolean;
    hint?: string;
  }[] = [
    {
      action: "confirm",
      label: "Confirm — launch dynamic Swarm",
      recommended: true,
    },
    {
      action: "continue",
      label: "Continue refining",
      hint: "Esc",
    },
    {
      action: "cancel",
      label: "Cancel — discard draft",
    },
  ];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly plan: ProposedSwarmPlan,
    private readonly options: ConfirmProposalOptions | undefined,
    private readonly done: (result: ProposalDialogOutcome) => void,
  ) {
    this.validatorEnabled = plan.validatorEnabled;
    this.maxConcurrency = Math.max(
      MIN_CONCURRENCY,
      Math.min(MAX_CONCURRENCY, Math.round(plan.maxConcurrency || 6)),
    );
    this.roleModels = plan.roleModels
      ? {
          ...plan.roleModels,
          ...(plan.roleModels.orchestrator
            ? { orchestrator: { ...plan.roleModels.orchestrator } }
            : {}),
          ...(plan.roleModels.worker
            ? { worker: { ...plan.roleModels.worker } }
            : {}),
          ...(plan.roleModels.validator
            ? { validator: { ...plan.roleModels.validator } }
            : {}),
          ...(plan.roleModels.fallbackModels
            ? { fallbackModels: [...plan.roleModels.fallbackModels] }
            : {}),
        }
      : undefined;

    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) {
        this.finish("continue");
      } else {
        this.onAbort = () => this.finish("continue");
        signal.addEventListener("abort", this.onAbort, { once: true });
      }
    }
  }

  private finish(action: ProposalDialogAction): void {
    if (this.settled) return;
    this.settled = true;
    this.dispose();
    this.done({
      action,
      validatorEnabled: this.validatorEnabled,
      maxConcurrency: this.maxConcurrency,
      ...(this.commentText ? { feedback: this.commentText } : {}),
      ...(this.modelsChanged && this.roleModels ? { roleModels: this.roleModels } : {}),
    });
  }

  dispose(): void {
    if (this.onAbort && this.options?.signal) {
      this.options.signal.removeEventListener("abort", this.onAbort);
    }
  }

  invalidate(): void {
    this.modelPickerComponent?.invalidate();
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (this.modelPickerComponent) {
      this.modelPickerComponent.handleInput?.(data);
      return;
    }

    if (this.editingComment) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.editingComment = false;
        this.commentInput.focused = false;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        this.commentText = this.commentInput.getValue().trim();
        this.editingComment = false;
        this.commentInput.focused = false;
        this.tui.requestRender();
        return;
      }
      this.commentInput.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // Esc always maps to "continue" so the user is never trapped
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish("continue");
      return;
    }

    const ch = decodePrintableChar(data);

    if ((ch === "m" || ch === "M") && this.options?.onOpenModelPicker) {
      const comp = this.options.onOpenModelPicker(
        this.tui,
        this.theme,
        this.roleModels,
        (updated) => {
          if (updated) {
            this.roleModels = updated;
            this.modelsChanged = true;
          }
          this.modelPickerComponent = null;
          this.tui.requestRender();
        },
      );
      if (comp && typeof (comp as Component).render === "function") {
        this.modelPickerComponent = comp as Component;
        this.tui.requestRender();
      }
      return;
    }

    if (ch === "c" || ch === "C") {
      this.editingComment = true;
      this.commentInput.setValue(this.commentText);
      this.commentInput.focused = true;
      this.tui.requestRender();
      return;
    }

    if (ch === "v" || ch === "V") {
      this.validatorEnabled = !this.validatorEnabled;
      this.tui.requestRender();
      return;
    }

    if (ch === "+" || ch === "=") {
      this.maxConcurrency = Math.min(MAX_CONCURRENCY, this.maxConcurrency + 1);
      this.tui.requestRender();
      return;
    }

    if (ch === "-" || ch === "_") {
      this.maxConcurrency = Math.max(MIN_CONCURRENCY, this.maxConcurrency - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.up) || ch === "k") {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.choices.length) % this.choices.length;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || ch === "j") {
      this.selectedIndex = (this.selectedIndex + 1) % this.choices.length;
      this.tui.requestRender();
      return;
    }

    if (ch === "1" || ch === "2" || ch === "3") {
      this.selectedIndex = Number(ch) - 1;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const choice = this.choices[this.selectedIndex];
      if (choice) {
        this.finish(choice.action);
      }
    }
  }

  private renderModelsLine(innerWidth: number): string {
    const rm = this.roleModels;
    const fmt = (cfg?: { model?: string; thinkingLevel?: string }) => {
      const m = sanitizePlainText(cfg?.model ?? "") || "host default";
      return cfg?.thinkingLevel ? `${m} · ${cfg.thinkingLevel}` : m;
    };
    const orch = fmt(rm?.orchestrator);
    const work = fmt(rm?.worker);
    const val = fmt(rm?.validator);

    const styleVal = (raw: string, hasExplicit: boolean) =>
      hasExplicit ? this.theme.fg("accent", raw) : this.theme.fg("dim", raw);

    const verbose =
      `${this.theme.fg("muted", "Models: ")}` +
      `${this.theme.fg("muted", "O:")}${styleVal(orch, Boolean(rm?.orchestrator?.model))}` +
      `${this.theme.fg("dim", " · ")}` +
      `${this.theme.fg("muted", "W:")}${styleVal(work, Boolean(rm?.worker?.model))}` +
      `${this.theme.fg("dim", " · ")}` +
      `${this.theme.fg("muted", "V:")}${styleVal(val, Boolean(rm?.validator?.model))}`;

    if (visibleWidth(verbose) <= innerWidth) {
      return verbose;
    }

    const prefix = this.theme.fg("muted", "Models: ");
    const budget = Math.max(1, innerWidth - visibleWidth("Models: "));
    const compact = formatRoleModelsLine(rm, "host default", {
      maxWidth: budget,
      theme: this.theme,
    });
    return fitLine(`${prefix}${compact}`, innerWidth);
  }

  render(width: number): string[] {
    if (this.modelPickerComponent) {
      return this.modelPickerComponent.render(width);
    }

    const targetWidth = Math.max(1, Math.floor(width));
    const innerWidth = computeInnerWidth(targetWidth);
    const maxTotalLines = computeDialogMaxLines(this.tui);
    const maxInnerLines = Math.max(8, maxTotalLines - 2);

    const body: string[] = [];

    // Plan title & objective snippet
    const cleanTitle = sanitizePlainText(this.plan.title);
    const cleanObjective = sanitizePlainText(this.plan.objective);
    if (cleanTitle) {
      body.push(
        fitLine(this.theme.fg("accent", this.theme.bold(cleanTitle)), innerWidth),
      );
    }
    if (cleanObjective && cleanObjective !== cleanTitle) {
      const objLines = wrapLines(
        this.theme.bold(cleanObjective),
        innerWidth,
        maxInnerLines <= 12 ? 1 : 2,
      );
      body.push(...objLines);
    }

    // Base branch + optional initialMembers count
    const initialMembers = this.plan.initialMembers ?? [];
    const basePart = `base:${this.theme.fg("accent", sanitizePlainText(this.plan.baseBranch))}`;
    const membersSummary =
      initialMembers.length > 0
        ? `${this.theme.fg("accent", String(initialMembers.length))} initial member${initialMembers.length === 1 ? "" : "s"}`
        : this.theme.fg("muted", "dynamic on-demand spawning");
    body.push(
      innerWidth >= 52
        ? joinColumns(basePart, membersSummary, innerWidth)
        : fitLine(`${basePart} · ${membersSummary}`, innerWidth),
    );

    // Active 3-role models (O / W / V)
    body.push(this.renderModelsLine(innerWidth));

    // Interactive toggles: [v] Independent Validator Policy + [+/-] Max Concurrency
    const valPill = this.validatorEnabled
      ? this.theme.fg("success", this.theme.bold("ON"))
      : this.theme.fg("warning", this.theme.bold("OFF"));
    const valPart = `${this.theme.fg("dim", "[v]")} Independent Validator Policy: ${valPill}`;
    const concPart = `${this.theme.fg("dim", "[+/-]")} Max Concurrency: ${this.theme.fg("accent", String(this.maxConcurrency))}`;

    if (innerWidth >= 66) {
      body.push(fitLine(`${valPart} · ${concPart}`, innerWidth));
    } else if (maxInnerLines >= 13) {
      body.push(fitLine(valPart, innerWidth));
      body.push(fitLine(concPart, innerWidth));
    } else {
      body.push(
        fitLine(
          `${this.theme.fg("dim", "[v]")} Validator: ${valPill} · ${this.theme.fg("dim", "[+/-]")} Max: ${this.theme.fg("accent", String(this.maxConcurrency))}`,
          innerWidth,
        ),
      );
    }

    // Reserve lines for bottom rule + optional comment row + 3 choices + hint
    const hasCommentRow = this.editingComment || this.commentText.length > 0 ? 1 : 0;
    const bottomReserved = 1 + hasCommentRow + this.choices.length + 1;
    let previewBudget = Math.max(0, maxInnerLines - body.length - bottomReserved);

    // Compact Strategy & Acceptance Criteria preview
    const cleanStrategy = sanitizePlainText(this.plan.strategy);
    const cleanAcceptance = sanitizePlainText(this.plan.acceptanceCriteria);

    if (previewBudget >= 2 && (cleanStrategy || cleanAcceptance)) {
      body.push(renderHorizontalRule(innerWidth, "Plan Strategy & Criteria", this.theme));
      previewBudget -= 1;

      if (cleanStrategy && previewBudget > 0) {
        const stratMax = cleanAcceptance && previewBudget >= 3 ? 2 : 1;
        const stratLines = wrapLines(
          `${this.theme.fg("muted", "Strategy: ")}${cleanStrategy}`,
          innerWidth,
          Math.min(stratMax, previewBudget),
        );
        body.push(...stratLines);
        previewBudget -= stratLines.length;
      }

      if (cleanAcceptance && previewBudget > 0) {
        const accMax = initialMembers.length > 0 && previewBudget >= 3 ? 1 : 2;
        const accLines = wrapLines(
          `${this.theme.fg("muted", "Acceptance: ")}${cleanAcceptance}`,
          innerWidth,
          Math.min(accMax, previewBudget),
        );
        body.push(...accLines);
        previewBudget -= accLines.length;
      }
    }

    // Optional initialMembers summary preview
    if (initialMembers.length > 0 && previewBudget >= 2) {
      body.push(
        renderHorizontalRule(
          innerWidth,
          `Initial Members (${initialMembers.length})`,
          this.theme,
        ),
      );
      previewBudget -= 1;
      const memberLines = buildInitialMembersSummaryLines(
        initialMembers,
        innerWidth,
        this.theme,
        Math.min(3, previewBudget),
      );
      body.push(...memberLines);
    }

    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));

    if (this.editingComment) {
      const inputRendered = this.commentInput.render(Math.max(10, innerWidth - 10))[0] ?? "";
      body.push(
        fitLine(
          `${this.theme.fg("accent", "Comment: ")}${inputRendered}`,
          innerWidth,
        ),
      );
    } else if (this.commentText) {
      body.push(
        fitLine(
          `${this.theme.fg("muted", "Comment: ")}${this.theme.fg("accent", sanitizePlainText(this.commentText))}`,
          innerWidth,
        ),
      );
    }

    // 3 Clear Choices
    for (let i = 0; i < this.choices.length; i++) {
      const choice = this.choices[i]!;
      const isSel = i === this.selectedIndex;
      const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
      const num = this.theme.fg("muted", `${i + 1}. `);
      const label = isSel
        ? this.theme.fg("accent", this.theme.bold(choice.label))
        : choice.label;
      const badge = choice.recommended
        ? " " + this.theme.fg("success", "★")
        : choice.hint
          ? " " + this.theme.fg("dim", `[${choice.hint}]`)
          : "";
      body.push(fitLine(`${ptr}${num}${label}${badge}`, innerWidth));
    }

    const hintsText = this.editingComment
      ? "[Enter] save comment · [Esc] cancel comment"
      : `${this.options?.onOpenModelPicker ? "[m] models · " : ""}[c] comment · [v] validator policy · [+/-] concurrency · [Esc] refine`;
    body.push(fitLine(this.theme.fg("dim", hintsText), innerWidth));

    const titleText =
      this.options?.mode === "tweak"
        ? "🐝 Swarm Plan Confirmation (Revision)"
        : "🐝 Swarm Plan Confirmation";

    return renderBox(body.slice(0, maxInnerLines), targetWidth, {
      title: this.theme.fg("accent", this.theme.bold(titleText)),
      borderColor: (s) => this.theme.fg("borderAccent", s),
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createQuestionnaireUI(
  opts?: QuestionnaireUIOptions,
): IQuestionnaireUI {
  return {
    async askQuestion(ctx, spec, signal) {
      if (!ctx.hasUI || signal?.aborted) {
        return { cancelled: true, isCustom: false };
      }

      return withModalGuard(opts, async () => {
        if (ctx.mode === "tui") {
          let component: SingleQuestionComponent | undefined;
          try {
            return await ctx.ui.custom<{
              cancelled: boolean;
              answer?: string;
              isCustom: boolean;
            }>(
              (tui, theme, _kb, done) => {
                component = new SingleQuestionComponent(tui, theme, spec, done, signal);
                return component;
              },
              {
                blocked: {
                  kind: "question",
                  message: sanitizePlainText(spec.question) || "Swarm question",
                },
              },
            );
          } finally {
            component?.dispose();
          }
        }
        return askQuestionBasic(ctx, spec, signal);
      });
    },

    async askQuestionnaire(ctx, questions, signal) {
      if (questions.length === 0) {
        return { cancelled: false, answers: {}, items: [] };
      }
      if (!ctx.hasUI || signal?.aborted) {
        return { cancelled: true, answers: {}, items: [] };
      }

      return withModalGuard(opts, async () => {
        if (ctx.mode === "tui") {
          let component: MultiQuestionComponent | undefined;
          try {
            return await ctx.ui.custom<QuestionnaireResult>(
              (tui, theme, _kb, done) => {
                component = new MultiQuestionComponent(tui, theme, questions, done, signal);
                return component;
              },
              {
                blocked: {
                  kind: "question",
                  message: `Swarm questionnaire (${questions.length} questions)`,
                },
              },
            );
          } finally {
            component?.dispose();
          }
        }

        const answers: Record<string, string> = {};
        const items: QuestionAnswer[] = [];
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i]!;
          const res = await askQuestionBasic(
            ctx,
            q,
            signal,
            `[${i + 1}/${questions.length}]`,
          );
          if (res.cancelled || res.answer === undefined) {
            return { cancelled: true, answers: {}, items: [] };
          }
          answers[q.id] = res.answer;
          items.push({
            id: q.id,
            question: q.question,
            answer: res.answer,
            isCustom: res.isCustom,
          });
        }
        return { cancelled: false, answers, items };
      });
    },

    async confirmProposal(ctx, plan, options) {
      const safeConcurrency = Math.max(
        MIN_CONCURRENCY,
        Math.min(MAX_CONCURRENCY, Math.round(plan.maxConcurrency || 6)),
      );
      if (!ctx.hasUI) {
        return {
          action: "cancel",
          validatorEnabled: plan.validatorEnabled,
          maxConcurrency: safeConcurrency,
        };
      }
      if (options?.signal?.aborted) {
        return {
          action: "continue",
          validatorEnabled: plan.validatorEnabled,
          maxConcurrency: safeConcurrency,
        };
      }

      return withModalGuard(opts, async () => {
        if (ctx.mode === "tui") {
          let component: ConfirmProposalComponent | undefined;
          try {
            return await ctx.ui.custom<ProposalDialogOutcome>(
              (tui, theme, _kb, done) => {
                component = new ConfirmProposalComponent(tui, theme, plan, options, done);
                return component;
              },
              {
                blocked: {
                  kind: "question",
                  message:
                    options?.mode === "tweak"
                      ? "Confirm Swarm plan revision"
                      : "Confirm dynamic Swarm plan",
                },
              },
            );
          } finally {
            component?.dispose();
          }
        }
        return confirmProposalBasic(ctx, plan, options);
      });
    },
  };
}

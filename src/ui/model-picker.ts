import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyMatch,
  Input,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  isProcessAlive,
  parseModelSpec,
  SWARM_SETTINGS_BOUNDS,
} from "../store/index.js";
import type {
  AvailableModelInfo,
  RoleModelOrigin,
  RunSummary,
  SwarmMemberRecord,
  SwarmModelRole,
  SwarmRoleModels,
  SwarmSettings,
  SwarmSnapshot,
} from "../types.js";
import {
  computeBoxInnerWidth,
  decodePrintableInput,
  fitLine,
  formatElapsedSince,
  formatOriginBadge,
  formatRoleModelsLine,
  formatRunStatusBadge,
  HardwareCursorController,
  isBackspaceKey,
  isEscapeKey,
  isKeyReleaseSafe,
  isTabKey,
  joinColumns,
  normalizeEditorInput,
  renderBox,
  renderHorizontalRule,
  sanitizePlainText,
  shortenModelName,
  visibleWidth,
} from "./text-utils.js";

// ============================================================================
// Shared Constants & Helpers
// ============================================================================

export type ModelPickerTab = SwarmModelRole | "fallbacks";

export type ModelSaveScope = "global" | "project";

export interface ModelPickerSettingsState {
  settings: SwarmSettings;
  origins?: Partial<Record<SwarmModelRole, RoleModelOrigin>>;
  hostModel?: string;
}

export interface ApplyRoleModelSelection {
  scope: ModelSaveScope;
  role: SwarmModelRole;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ApplyFallbacksSelection {
  scope: ModelSaveScope;
  fallbackModels: string[];
}

export interface ApplyMemberModelSelection {
  memberName: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export interface SwarmModelPickerViewOptions {
  mode: "roles" | "member";
  initialTab?: ModelPickerTab;
  initialScope?: ModelSaveScope;
  state: ModelPickerSettingsState;
  availableModels: readonly AvailableModelInfo[];
  member?: SwarmMemberRecord;
  onApplyRole?: (
    selection: ApplyRoleModelSelection,
  ) => Promise<ModelPickerSettingsState & { notice?: string }>;
  onApplyFallbacks?: (
    selection: ApplyFallbacksSelection,
  ) => Promise<ModelPickerSettingsState & { notice?: string }>;
  onApplyMember?: (
    selection: ApplyMemberModelSelection,
  ) => Promise<{ notice?: string } | void>;
  onClose?: (result?: {
    changed: boolean;
    state: ModelPickerSettingsState;
    selectedModel?: string;
    selectedThinkingLevel?: ThinkingLevel;
  }) => void;
}

export type SwarmHubAction =
  | { kind: "cancel" }
  | {
      kind: "draft";
      goal: string;
      validatorEnabled?: boolean;
      maxConcurrency?: number;
    }
  | {
      kind: "direct";
      goal: string;
      validatorEnabled?: boolean;
      maxConcurrency?: number;
    }
  | { kind: "ui" }
  | { kind: "tweak" }
  | { kind: "pause" }
  | { kind: "resume"; runId?: string; kickoff?: boolean }
  | { kind: "done" }
  | { kind: "focus"; runId: string }
  | { kind: "settings" }
  | { kind: "teardown" };

export interface SwarmHubViewOptions {
  state: ModelPickerSettingsState;
  snapshot: SwarmSnapshot;
  runs: readonly RunSummary[];
  availableModels: readonly AvailableModelInfo[];
  initialScope?: ModelSaveScope;
  currentSessionId?: string;
  activatedRun?: boolean;
  onApplyRole?: SwarmModelPickerViewOptions["onApplyRole"];
  onApplyFallbacks?: SwarmModelPickerViewOptions["onApplyFallbacks"];
  onComplete: (action: SwarmHubAction) => void;
}

const PICKER_TABS: readonly ModelPickerTab[] = [
  "orchestrator",
  "worker",
  "validator",
  "fallbacks",
];

const TAB_LABELS: Record<ModelPickerTab, string> = {
  orchestrator: "Orchestrator",
  worker: "Worker",
  validator: "Validator",
  fallbacks: "Fallbacks",
};

const TAB_DESCRIPTIONS: Record<ModelPickerTab, string> = {
  orchestrator:
    "Plans the swarm, interviews you & coordinates agents. Applies immediately to this session.",
  worker:
    "Builds slices in isolated worktrees. Running workers switch on their next turn.",
  validator:
    "Independently audits diffs & tests (read-only). Running validators switch on their next turn.",
  fallbacks:
    "Ordered failover pool for automatic HTTP 429 / quota hot-switching.",
};

interface EffortOption {
  level?: ThinkingLevel;
  label: string;
  description: string;
  recommended?: boolean;
}

const EFFORT_OPTIONS: readonly EffortOption[] = [
  {
    level: undefined,
    label: "Default",
    description: "Use model / provider default reasoning effort",
  },
  {
    level: "off",
    label: "Off",
    description: "Reasoning disabled — fastest lowest-latency responses",
  },
  {
    level: "minimal",
    label: "Minimal",
    description: "Minimal thinking budget for trivial edits",
  },
  {
    level: "low",
    label: "Low",
    description: "Light reasoning for straightforward tasks",
  },
  {
    level: "medium",
    label: "Medium",
    description: "Balanced speed and reasoning depth",
  },
  {
    level: "high",
    label: "High",
    description: "Deep reasoning — recommended for most swarm roles",
    recommended: true,
  },
  {
    level: "xhigh",
    label: "Extra high (xhigh)",
    description: "Maximum deliberation for critical audits or hard debugging",
  },
  {
    level: "max",
    label: "Max",
    description: "Unbounded reasoning budget (highest latency & token usage)",
  },
];

const EFFORT_CYCLE: ReadonlyArray<ThinkingLevel | undefined> = [
  undefined,
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "off",
  "minimal",
];

function computeTerminalRows(tui: TUI): number {
  const rows = Number((tui as unknown as { terminal?: { rows?: number } }).terminal?.rows);
  if (Number.isFinite(rows) && rows > 0) {
    return Math.floor(rows);
  }
  return 28;
}

function computeOverlayMaxBoxLines(tui: TUI): number {
  const termRows = computeTerminalRows(tui);
  const overlayCap = Math.max(3, Math.floor(termRows * 0.86));
  const rawMax =
    termRows >= 10
      ? Math.min(termRows - 1, Math.max(9, Math.min(30, Math.floor(termRows * 0.85))))
      : Math.max(4, termRows);
  return Math.min(rawMax, overlayCap);
}

function formatInheritedHostLabel(hostModel?: string, maxShortLen?: number): string {
  const cleanHost = sanitizePlainText(hostModel ?? "");
  if (!cleanHost) return "host:default";
  const short = shortenModelName(cleanHost, maxShortLen);
  return short ? `host:${short}` : "host:default";
}

function formatContextWindow(tokens?: number): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
    return "";
  }
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

function formatRoleSummaryCell(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
  hostModel: string | undefined,
  origin: RoleModelOrigin | undefined,
  theme: Theme,
  compact = false,
): string {
  const cleanModel = sanitizePlainText(model ?? "");
  const label = cleanModel
    ? compact
      ? shortenModelName(cleanModel)
      : cleanModel
    : formatInheritedHostLabel(hostModel);
  const styledModel = cleanModel ? theme.fg("accent", label) : theme.fg("dim", label);
  const thinkPart = thinking ? theme.fg("borderAccent", ` · ${thinking}`) : "";
  const origStr = formatOriginBadge(origin, theme);
  const origPart = origStr ? ` ${origStr}` : "";
  return `${styledModel}${thinkPart}${origPart}`;
}

export function buildRoleModelsFromPickerState(
  state: ModelPickerSettingsState,
): SwarmRoleModels {
  return {
    orchestrator: {
      ...(state.settings.orchestratorModel
        ? { model: state.settings.orchestratorModel }
        : {}),
      ...(state.settings.orchestratorThinkingLevel
        ? { thinkingLevel: state.settings.orchestratorThinkingLevel }
        : {}),
    },
    worker: {
      ...(state.settings.workerModel
        ? { model: state.settings.workerModel }
        : {}),
      ...(state.settings.workerThinkingLevel
        ? { thinkingLevel: state.settings.workerThinkingLevel }
        : {}),
    },
    validator: {
      ...(state.settings.validatorModel
        ? { model: state.settings.validatorModel }
        : {}),
      ...(state.settings.validatorThinkingLevel
        ? { thinkingLevel: state.settings.validatorThinkingLevel }
        : {}),
    },
    fallbackModels: [...state.settings.fallbackModels],
  };
}

function stripThinkingSuffix(raw?: string): string {
  if (!raw) return "";
  const parsed = parseModelSpec(raw.trim());
  return (parsed.model || raw.trim()).toLowerCase();
}

function matchModelId(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return stripThinkingSuffix(a) === stripThinkingSuffix(b);
}

const GENERIC_MODEL_TIERS = new Set([
  "pro",
  "mini",
  "nano",
  "flash",
  "lite",
  "ultra",
  "turbo",
  "codex",
  "max",
  "chat",
  "exp",
  "preview",
]);

function stripProviderAndDateSuffix(model: string): string {
  const clean = sanitizePlainText(model);
  if (!clean) return "default";
  const slash = clean.lastIndexOf("/");
  const base = slash >= 0 && slash < clean.length - 1 ? clean.slice(slash + 1) : clean;
  return base.replace(/-(?:20\d{6}|\d{8})$/, "");
}

function compactTabModelNickname(model: string): string {
  const base = stripProviderAndDateSuffix(model);
  if (base.startsWith("claude-") && base.length > 7) {
    return base.slice(7);
  }
  const versionedVendor = /^(?:gemini|gpt)-\d+(?:\.\d+)?-([a-zA-Z][a-zA-Z0-9._-]*)$/.exec(base);
  if (versionedVendor) {
    const tail = versionedVendor[1]!;
    const firstToken = tail.split("-")[0]!.toLowerCase();
    if (!GENERIC_MODEL_TIERS.has(firstToken) && tail.length >= 3) {
      return tail;
    }
  }
  return base;
}

function budgetThreePills(
  models: readonly [string, string, string],
  availableCols: number,
): [string, string, string] {
  const safeTotal = Math.max(6, Math.floor(availableCols));
  const desired = models.map((m) => visibleWidth(m));
  if (desired[0]! + desired[1]! + desired[2]! <= safeTotal) {
    return [models[0], models[1], models[2]];
  }
  const budgets = [0, 0, 0];
  let remaining = safeTotal;
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
  return [
    fitLine(models[0], Math.max(2, budgets[0]!)),
    fitLine(models[1], Math.max(2, budgets[1]!)),
    fitLine(models[2], Math.max(2, budgets[2]!)),
  ];
}

function normalizeSearchToken(s: string): string {
  return s.toLowerCase().replace(/[._:/-]+/g, "");
}

type ModelListRow =
  | { kind: "header"; provider: string; selectable: false }
  | { kind: "hint"; text: string; selectable: false }
  | { kind: "inherit"; label: string; selectable: true }
  | {
      kind: "model";
      info: AvailableModelInfo;
      isCustomEntry?: boolean;
      isPinned?: boolean;
      selectable: true;
    };

// ============================================================================
// SwarmModelPickerView (Droid missionModelPicker + Reasoning Effort Picker)
// ============================================================================

export class SwarmModelPickerView implements Component, Focusable {
  readonly capturesViewportInput = true;
  private _focused = false;
  private readonly mode: "roles" | "member";
  private activeTab: ModelPickerTab;
  private saveScope: ModelSaveScope;
  private state: ModelPickerSettingsState;
  private readonly availableModels: AvailableModelInfo[];
  private readonly member?: SwarmMemberRecord;

  private readonly filterInput: Input;
  private readonly hwCursor = new HardwareCursorController();
  private step: "list" | "effort" = "list";
  private selectedIndex = 0;
  private effortIndex = 5; // default to "high"
  private pendingModel: AvailableModelInfo | null = null;
  private busy = false;
  private changed = false;
  private lastAppliedModel?: string;
  private lastAppliedThinking?: ThinkingLevel;
  private feedback: { kind: "info" | "success" | "error"; text: string } | null = null;
  private rows: ModelListRow[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: SwarmModelPickerViewOptions,
  ) {
    this.mode = options.mode;
    this.activeTab = options.initialTab ?? "orchestrator";
    this.saveScope = options.initialScope ?? "global";
    this.state = {
      ...options.state,
      settings: {
        ...options.state.settings,
        fallbackModels: [...options.state.settings.fallbackModels],
      },
      origins: options.state.origins ? { ...options.state.origins } : undefined,
    };
    this.availableModels = [...options.availableModels];
    this.member = options.member;
    this.filterInput = new Input({
      prompt: "Filter: ",
      placeholder: "Type or paste model / provider…",
      placeholderStyle: (s) => this.theme.fg("dim", s),
    });
    this.filterInput.focused = true;
    this.rebuildRows(true);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.filterInput.focused = value && this.step === "list";
    this.hwCursor.sync(this.tui, value && this.step === "list");
  }

  private get searchQuery(): string {
    return this.filterInput.getValue();
  }

  private setSearchQuery(next: string): void {
    this.filterInput.setValue(next);
  }

  invalidate(): void {
    this.filterInput.invalidate();
  }

  dispose(): void {
    this.filterInput.focused = false;
    this.hwCursor.restore(this.tui);
  }

  getState(): ModelPickerSettingsState {
    return this.state;
  }

  hasChanged(): boolean {
    return this.changed;
  }

  private getCurrentRoleConfig(role: SwarmModelRole): {
    model?: string;
    thinkingLevel?: ThinkingLevel;
  } {
    if (role === "orchestrator") {
      return {
        model: this.state.settings.orchestratorModel,
        thinkingLevel: this.state.settings.orchestratorThinkingLevel,
      };
    }
    if (role === "worker") {
      return {
        model: this.state.settings.workerModel,
        thinkingLevel: this.state.settings.workerThinkingLevel,
      };
    }
    return {
      model: this.state.settings.validatorModel,
      thinkingLevel: this.state.settings.validatorThinkingLevel,
    };
  }

  private getTargetCurrentModel(): string | undefined {
    if (this.mode === "member") {
      return this.lastAppliedModel ?? this.member?.model ?? this.state.hostModel;
    }
    if (this.activeTab === "fallbacks") {
      return undefined;
    }
    return this.getCurrentRoleConfig(this.activeTab).model;
  }

  private getTargetCurrentThinking(): ThinkingLevel | undefined {
    if (this.mode === "member") {
      return this.lastAppliedThinking ?? this.member?.thinkingLevel;
    }
    if (this.activeTab === "fallbacks") {
      return undefined;
    }
    return this.getCurrentRoleConfig(this.activeTab).thinkingLevel;
  }

  private getMergedCatalog(): AvailableModelInfo[] {
    const out: AvailableModelInfo[] = [...this.availableModels];
    const seen = new Set(out.map((m) => m.fullId.toLowerCase()));
    const seenShort = new Set(out.map((m) => m.id.toLowerCase()));

    const ensureConfigured = (rawId: string | undefined) => {
      const trimmed = rawId?.trim();
      if (!trimmed) return;
      const baseId = parseModelSpec(trimmed).model || trimmed;
      const lower = baseId.toLowerCase();
      if (seen.has(lower) || seenShort.has(lower)) return;
      const slash = baseId.indexOf("/");
      const provider = slash > 0 ? baseId.slice(0, slash) : "configured";
      const id = slash > 0 ? baseId.slice(slash + 1) : baseId;
      seen.add(lower);
      out.push({
        id,
        provider,
        fullId: baseId,
        name: baseId,
      });
    };

    ensureConfigured(this.state.settings.orchestratorModel);
    ensureConfigured(this.state.settings.workerModel);
    ensureConfigured(this.state.settings.validatorModel);
    for (const fb of this.state.settings.fallbackModels) {
      ensureConfigured(fb);
    }
    if (this.member?.model) {
      ensureConfigured(this.member.model);
    }
    return out;
  }

  private rebuildRows(resetCursor = false): void {
    const query = this.searchQuery.trim().toLowerCase();
    const normQuery = normalizeSearchToken(query);
    const catalog = this.getMergedCatalog();
    const rows: ModelListRow[] = [];

    if (this.mode === "roles" && this.activeTab !== "fallbacks") {
      const cleanHost = sanitizePlainText(this.state.hostModel ?? "");
      const hostDisplay = formatInheritedHostLabel(cleanHost);
      const inheritText = `inherit host session default ${cleanHost} ${hostDisplay}`.toLowerCase();
      if (!query || inheritText.includes(query)) {
        rows.push({
          kind: "inherit",
          label: cleanHost
            ? `Inherit host model (${hostDisplay})`
            : "Inherit host session model",
          selectable: true,
        });
      }
      if (this.availableModels.length === 0 && !query) {
        rows.push({
          kind: "hint",
          text: "No catalog models discovered — type or paste any provider/model ID above.",
          selectable: false,
        });
      }
    }

    const filtered = catalog.filter((m) => {
      if (!query) return true;
      const hay = `${m.fullId} ${m.id} ${m.provider} ${m.name ?? ""}`.toLowerCase();
      if (query.split(/\s+/).every((tok) => hay.includes(tok))) {
        return true;
      }
      if (normQuery) {
        const normHay = normalizeSearchToken(hay);
        if (normHay.includes(normQuery)) {
          return true;
        }
      }
      return fuzzyMatch(query, m.fullId).matches || (m.name ? fuzzyMatch(query, m.name).matches : false);
    });

    const currentTarget = this.getTargetCurrentModel();
    const hostModel = sanitizePlainText(this.state.hostModel ?? "");
    const pinned: AvailableModelInfo[] = [];
    const pinnedIds = new Set<string>();
    const pinIfMatch = (target: string | undefined) => {
      if (!target) return;
      const found = filtered.find(
        (m) =>
          !pinnedIds.has(m.fullId.toLowerCase()) &&
          (matchModelId(m.fullId, target) || matchModelId(m.id, target)),
      );
      if (found) {
        pinned.push(found);
        pinnedIds.add(found.fullId.toLowerCase());
      }
    };
    pinIfMatch(currentTarget);
    pinIfMatch(hostModel);

    if (pinned.length > 0) {
      rows.push({ kind: "header", provider: "* Current / Host", selectable: false });
      for (const info of pinned) {
        rows.push({ kind: "model", info, isPinned: true, selectable: true });
      }
    }

    const byProvider = new Map<string, AvailableModelInfo[]>();
    for (const m of filtered) {
      if (pinnedIds.has(m.fullId.toLowerCase())) continue;
      const prov = m.provider || "other";
      const bucket = byProvider.get(prov) ?? [];
      bucket.push(m);
      byProvider.set(prov, bucket);
    }

    for (const [provider, models] of byProvider.entries()) {
      rows.push({ kind: "header", provider, selectable: false });
      for (const info of models) {
        rows.push({ kind: "model", info, selectable: true });
      }
    }

    const typed = this.searchQuery.trim();
    if (
      typed &&
      !filtered.some(
        (m) =>
          m.fullId.toLowerCase() === typed.toLowerCase() ||
          m.id.toLowerCase() === typed.toLowerCase(),
      )
    ) {
      const slash = typed.indexOf("/");
      rows.push({
        kind: "model",
        info: {
          id: slash > 0 ? typed.slice(slash + 1) : typed,
          provider: slash > 0 ? typed.slice(0, slash) : "custom",
          fullId: typed,
          name: `Use custom model ID "${typed}"`,
        },
        isCustomEntry: true,
        selectable: true,
      });
    }

    const prevRow = this.rows[this.selectedIndex];
    const prevModelId =
      prevRow?.kind === "model" && !prevRow.isCustomEntry
        ? prevRow.info.fullId
        : undefined;
    const prevWasInherit = prevRow?.kind === "inherit";

    this.rows = rows;

    if (resetCursor) {
      const currentTarget = this.getTargetCurrentModel();
      if (currentTarget) {
        const activeIdx = rows.findIndex(
          (r) =>
            r.kind === "model" &&
            !r.isCustomEntry &&
            (matchModelId(r.info.fullId, currentTarget) ||
              matchModelId(r.info.id, currentTarget)),
        );
        if (activeIdx >= 0) {
          this.selectedIndex = activeIdx;
          return;
        }
      }
      this.selectedIndex = this.findFirstSelectableIndex();
    } else if (prevModelId) {
      const preservedIdx = rows.findIndex(
        (r) =>
          r.kind === "model" &&
          !r.isCustomEntry &&
          matchModelId(r.info.fullId, prevModelId),
      );
      if (preservedIdx >= 0) {
        this.selectedIndex = preservedIdx;
        return;
      }
      const firstCatalogIdx = rows.findIndex(
        (r) => r.kind === "model" && !r.isCustomEntry,
      );
      this.selectedIndex =
        firstCatalogIdx >= 0 ? firstCatalogIdx : this.findFirstSelectableIndex();
    } else if (prevWasInherit && rows[0]?.kind === "inherit") {
      this.selectedIndex = 0;
    } else {
      const firstCatalogIdx = rows.findIndex(
        (r) => r.kind === "model" && !r.isCustomEntry,
      );
      this.selectedIndex =
        firstCatalogIdx >= 0 ? firstCatalogIdx : this.findFirstSelectableIndex();
    }
  }

  private findFirstSelectableIndex(): number {
    const idx = this.rows.findIndex((r) => r.selectable);
    return idx >= 0 ? idx : 0;
  }

  private moveSelection(delta: number): void {
    if (this.rows.length === 0) return;
    const selectableIndices: number[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i]!.selectable) selectableIndices.push(i);
    }
    if (selectableIndices.length === 0) return;

    const currentPos = selectableIndices.indexOf(this.selectedIndex);
    if (currentPos === -1) {
      this.selectedIndex = delta >= 0 ? selectableIndices[0]! : selectableIndices[selectableIndices.length - 1]!;
      return;
    }
    const nextPos =
      (currentPos + delta + selectableIndices.length) % selectableIndices.length;
    this.selectedIndex = selectableIndices[nextPos]!;
  }

  private openEffortStep(modelInfo: AvailableModelInfo): void {
    this.pendingModel = modelInfo;
    const currentModel = this.getTargetCurrentModel();
    const currentThinking = this.getTargetCurrentThinking();
    const preferredThinking =
      matchModelId(currentModel, modelInfo.fullId) ||
      matchModelId(currentModel, modelInfo.id)
        ? currentThinking
        : currentThinking ?? "high";
    const foundIdx = EFFORT_OPTIONS.findIndex((opt) => opt.level === preferredThinking);
    this.effortIndex = foundIdx >= 0 ? foundIdx : 5;
    this.step = "effort";
    this.filterInput.focused = false;
    this.hwCursor.sync(this.tui, false);
    this.tui.requestRender();
  }

  private closePicker(): void {
    this.dispose();
    this.options.onClose?.({
      changed: this.changed,
      state: this.state,
      selectedModel: this.lastAppliedModel,
      selectedThinkingLevel: this.lastAppliedThinking,
    });
  }

  private async commitRoleSelection(
    role: SwarmModelRole,
    model: string | undefined,
    thinkingLevel: ThinkingLevel | undefined,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.feedback = {
      kind: "info",
      text: model
        ? `Applying ${role} -> ${model}${thinkingLevel ? ` · ${thinkingLevel}` : ""} (${this.saveScope})…`
        : `Resetting ${role} -> host default (${this.saveScope})…`,
    };
    this.tui.requestRender();
    try {
      if (this.options.onApplyRole) {
        const res = await this.options.onApplyRole({
          scope: this.saveScope,
          role,
          model,
          thinkingLevel,
        });
        this.state = {
          ...res,
          settings: {
            ...res.settings,
            fallbackModels: [...res.settings.fallbackModels],
          },
          origins: res.origins ? { ...res.origins } : undefined,
        };
        this.feedback = {
          kind: "success",
          text:
            res.notice ??
            (model
              ? `Saved ${role} -> ${model}${thinkingLevel ? ` (${thinkingLevel})` : ""} [${this.saveScope}]`
              : `Cleared ${role} override -> host default [${this.saveScope}]`),
        };
      }
      this.changed = true;
      this.lastAppliedModel = model;
      this.lastAppliedThinking = thinkingLevel;
      this.step = "list";
      this.pendingModel = null;
      this.filterInput.focused = this._focused;
      this.hwCursor.sync(this.tui, this._focused);
      this.rebuildRows(false);
    } catch (err) {
      this.feedback = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private async commitMemberSelection(
    model: string,
    thinkingLevel: ThinkingLevel | undefined,
  ): Promise<void> {
    if (this.busy || !this.member) return;
    this.busy = true;
    this.feedback = {
      kind: "info",
      text: `Switching @${this.member.name} -> ${model}${thinkingLevel ? ` · ${thinkingLevel}` : ""}…`,
    };
    this.tui.requestRender();
    try {
      if (this.options.onApplyMember) {
        const res = await this.options.onApplyMember({
          memberName: this.member.name,
          model,
          thinkingLevel,
        });
        if (res && typeof res === "object" && res.notice) {
          this.feedback = { kind: "success", text: res.notice };
        }
      }
      this.changed = true;
      this.lastAppliedModel = model;
      this.lastAppliedThinking = thinkingLevel;
      this.busy = false;
      this.closePicker();
      return;
    } catch (err) {
      this.feedback = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private async commitFallbacks(nextList: string[], notice: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.options.onApplyFallbacks) {
        const res = await this.options.onApplyFallbacks({
          scope: this.saveScope,
          fallbackModels: nextList,
        });
        this.state = {
          ...res,
          settings: {
            ...res.settings,
            fallbackModels: [...res.settings.fallbackModels],
          },
          origins: res.origins ? { ...res.origins } : undefined,
        };
        this.feedback = { kind: "success", text: res.notice ?? notice };
      } else {
        this.state.settings = {
          ...this.state.settings,
          fallbackModels: [...nextList],
        };
        this.feedback = { kind: "success", text: notice };
      }
      this.changed = true;
      this.rebuildRows(false);
    } catch (err) {
      this.feedback = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private jumpToTab(targetIdx: number): void {
    if (this.mode !== "roles") return;
    const nextTab = PICKER_TABS[targetIdx];
    if (!nextTab) return;
    if (
      nextTab === this.activeTab &&
      this.step === "list" &&
      this.searchQuery.length === 0
    ) {
      this.tui.requestRender();
      return;
    }
    this.activeTab = nextTab;
    this.step = "list";
    this.pendingModel = null;
    this.setSearchQuery("");
    this.filterInput.focused = this._focused;
    this.hwCursor.sync(this.tui, this._focused);
    this.rebuildRows(true);
    this.tui.requestRender();
  }

  private switchTab(delta: number): void {
    if (this.mode !== "roles") return;
    const idx = PICKER_TABS.indexOf(this.activeTab);
    const nextIdx = (idx + delta + PICKER_TABS.length) % PICKER_TABS.length;
    this.jumpToTab(nextIdx);
  }

  handleInput(data: string): void {
    if (this.busy || isKeyReleaseSafe(data)) {
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      this.closePicker();
      return;
    }

    if (this.step === "effort") {
      if (isEscapeKey(data)) {
        this.step = "list";
        this.pendingModel = null;
        this.filterInput.focused = this._focused;
        this.hwCursor.sync(this.tui, this._focused);
        this.tui.requestRender();
        return;
      }

      const ch = decodePrintableInput(data);
      if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab")) || ch === "k") {
        this.effortIndex =
          (this.effortIndex - 1 + EFFORT_OPTIONS.length) % EFFORT_OPTIONS.length;
        this.tui.requestRender();
        return;
      }
      if (
        matchesKey(data, Key.down) ||
        isTabKey(data) ||
        matchesKey(data, Key.ctrl("e")) ||
        ch === "j"
      ) {
        this.effortIndex = (this.effortIndex + 1) % EFFORT_OPTIONS.length;
        this.tui.requestRender();
        return;
      }
      if (ch && ch >= "1" && ch <= String(EFFORT_OPTIONS.length)) {
        this.effortIndex = Number(ch) - 1;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const chosen = EFFORT_OPTIONS[this.effortIndex];
        const model = this.pendingModel;
        if (!chosen || !model) return;
        if (this.mode === "member") {
          void this.commitMemberSelection(model.fullId, chosen.level);
        } else if (this.activeTab !== "fallbacks") {
          void this.commitRoleSelection(this.activeTab, model.fullId, chosen.level);
        }
        return;
      }
      return;
    }

    // Step 1: Model / Fallback List
    if (isEscapeKey(data)) {
      if (this.searchQuery.length > 0) {
        this.setSearchQuery("");
        this.rebuildRows(true);
        this.tui.requestRender();
        return;
      }
      this.closePicker();
      return;
    }

    if (this.mode === "roles") {
      if (isTabKey(data)) {
        this.switchTab(1);
        return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        this.switchTab(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("s"))) {
        this.saveScope = this.saveScope === "global" ? "project" : "global";
        this.feedback = {
          kind: "info",
          text:
            this.saveScope === "global"
              ? "Save scope: Global (~/.pi/agent/pi-swarm-settings.json)"
              : "Save scope: Project (.pi/pi-swarm-settings.json)",
        };
        this.tui.requestRender();
        return;
      }
      if (this.searchQuery.length === 0) {
        const altTabKeys = ["1", "2", "3", "4"] as const;
        for (let i = 0; i < altTabKeys.length; i++) {
          if (matchesKey(data, Key.alt(altTabKeys[i]!))) {
            this.jumpToTab(i);
            return;
          }
        }
        if (matchesKey(data, Key.right)) {
          this.switchTab(1);
          return;
        }
        if (matchesKey(data, Key.left)) {
          this.switchTab(-1);
          return;
        }
      }
    }

    if (matchesKey(data, Key.ctrl("u"))) {
      if (this.searchQuery.length > 0) {
        this.setSearchQuery("");
        this.rebuildRows(true);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.ctrl("x"))) {
      if (this.mode === "roles" && this.activeTab === "fallbacks") {
        void this.commitFallbacks([], `Cleared fallbackModels [${this.saveScope}]`);
        return;
      }
      if (this.mode === "roles" && this.activeTab !== "fallbacks") {
        void this.commitRoleSelection(this.activeTab, undefined, undefined);
        return;
      }
    }

    if (matchesKey(data, Key.ctrl("e")) && this.activeTab !== "fallbacks") {
      const targetModel = this.getTargetCurrentModel();
      const row = this.rows[this.selectedIndex];
      const activeModelId =
        targetModel ?? (row?.kind === "model" ? row.info.fullId : undefined);
      if (this.mode === "member") {
        const info =
          row?.kind === "model" && !row.isCustomEntry
            ? row.info
            : activeModelId
              ? this.getMergedCatalog().find((m) => matchModelId(m.fullId, activeModelId) || matchModelId(m.id, activeModelId)) ?? {
                  id: activeModelId,
                  provider: activeModelId.includes("/") ? activeModelId.split("/")[0]! : "custom",
                  fullId: activeModelId,
                }
              : undefined;
        if (info) {
          this.openEffortStep(info);
        }
        return;
      }
      if (activeModelId) {
        const curThinking = this.getTargetCurrentThinking();
        const curIdx = EFFORT_CYCLE.indexOf(curThinking);
        const nextThinking = EFFORT_CYCLE[(curIdx + 1) % EFFORT_CYCLE.length];
        void this.commitRoleSelection(this.activeTab, activeModelId, nextThinking);
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveSelection(-5);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveSelection(5);
      this.tui.requestRender();
      return;
    }

    const row = this.rows[this.selectedIndex];
    const ch = decodePrintableInput(data);

    // Fallbacks reorder shortcuts: Alt+Up / Alt+Down, or `[` / `]` when filter is empty
    if (this.mode === "roles" && this.activeTab === "fallbacks" && row?.kind === "model") {
      const moveUp =
        matchesKey(data, Key.alt("up")) || (this.searchQuery.length === 0 && ch === "[");
      const moveDown =
        matchesKey(data, Key.alt("down")) || (this.searchQuery.length === 0 && ch === "]");
      if (moveUp || moveDown) {
        const list = [...this.state.settings.fallbackModels];
        const idx = list.findIndex(
          (id) => matchModelId(id, row.info.fullId) || matchModelId(id, row.info.id),
        );
        if (idx >= 0) {
          const targetIdx = moveUp ? idx - 1 : idx + 1;
          if (targetIdx >= 0 && targetIdx < list.length) {
            const tmp = list[idx]!;
            list[idx] = list[targetIdx]!;
            list[targetIdx] = tmp;
            void this.commitFallbacks(
              list,
              `Moved fallback #${targetIdx + 1}: ${row.info.fullId} [${this.saveScope}]`,
            );
          }
        }
        return;
      }
    }

    if (matchesKey(data, Key.enter)) {
      if (!row || !row.selectable) return;
      if (row.kind === "inherit" && this.mode === "roles" && this.activeTab !== "fallbacks") {
        void this.commitRoleSelection(this.activeTab, undefined, undefined);
        return;
      }
      if (row.kind === "model") {
        if (this.mode === "roles" && this.activeTab === "fallbacks") {
          this.toggleFallbackRow(row.info);
          return;
        }
        this.openEffortStep(row.info);
        return;
      }
    }

    if (
      this.mode === "roles" &&
      this.activeTab === "fallbacks" &&
      (matchesKey(data, Key.space) || ch === " ")
    ) {
      if (row?.kind === "model") {
        this.toggleFallbackRow(row.info);
      }
      return;
    }

    // Forward typing, bracketed paste, cursor navigation, CJK/IME & Backspace cleanly to Input
    const before = this.searchQuery;
    const normalized = isBackspaceKey(data) ? "\x7f" : normalizeEditorInput(data);
    if (!normalized) {
      return;
    }
    this.filterInput.handleInput(normalized);
    if (this.searchQuery !== before) {
      this.rebuildRows(false);
    }
    this.tui.requestRender();
  }

  private toggleFallbackRow(info: AvailableModelInfo): void {
    const list = [...this.state.settings.fallbackModels];
    const idx = list.findIndex(
      (id) => matchModelId(id, info.fullId) || matchModelId(id, info.id),
    );
    if (idx >= 0) {
      list.splice(idx, 1);
      void this.commitFallbacks(
        list,
        `Removed fallback: ${info.fullId} [${this.saveScope}]`,
      );
    } else {
      list.push(info.fullId);
      void this.commitFallbacks(
        list,
        `Added fallback #${list.length}: ${info.fullId} [${this.saveScope}]`,
      );
    }
  }

  private renderRoleTabBar(innerWidth: number): string {
    const fbCount = this.state.settings.fallbackModels.length;

    if (innerWidth >= 72) {
      const roles: readonly SwarmModelRole[] = ["orchestrator", "worker", "validator"];
      const nicks: [string, string, string] = ["default", "default", "default"];
      const effs: [string, string, string] = ["", "", ""];
      const explicits: [boolean, boolean, boolean] = [false, false, false];

      for (let i = 0; i < 3; i++) {
        const role = roles[i]!;
        const cfg = this.getCurrentRoleConfig(role);
        const explicit = sanitizePlainText(cfg.model ?? "");
        const cleanHost = sanitizePlainText(this.state.hostModel ?? "");
        nicks[i] = explicit
          ? compactTabModelNickname(explicit)
          : cleanHost
            ? `host:${compactTabModelNickname(cleanHost)}`
            : "host:default";
        effs[i] = cfg.thinkingLevel ? `(${cfg.thinkingLevel})` : "";
        explicits[i] = Boolean(explicit);
      }

      const buildStyledTabs = (
        prefixes: readonly [string, string, string],
        models: readonly [string, string, string],
        fbLabel: string,
        sepPlain: string,
      ): { plainWidth: number; styled: string } => {
        const plainParts = [
          `${prefixes[0]}${models[0]}${effs[0]}`,
          `${prefixes[1]}${models[1]}${effs[1]}`,
          `${prefixes[2]}${models[2]}${effs[2]}`,
          fbLabel,
        ];
        const plainWidth =
          plainParts.reduce((sum, p) => sum + visibleWidth(p), 0) +
          visibleWidth(sepPlain) * 3;

        const styledParts = PICKER_TABS.map((tab, idx) => {
          const plain = plainParts[idx]!;
          if (tab === this.activeTab) {
            return this.theme.fg("accent", this.theme.bold(plain));
          }
          if (idx < 3) {
            const pref = prefixes[idx as 0 | 1 | 2];
            const val = `${models[idx as 0 | 1 | 2]}${effs[idx as 0 | 1 | 2]}`;
            return (
              this.theme.fg("muted", pref) +
              this.theme.fg(explicits[idx as 0 | 1 | 2] ? "muted" : "dim", val)
            );
          }
          return this.theme.fg("muted", plain);
        });
        const sepStyled =
          sepPlain === " · " ? this.theme.fg("dim", " · ") : sepPlain;
        return {
          plainWidth,
          styled: fitLine(styledParts.join(sepStyled), innerWidth),
        };
      };

      const widePrefixes: readonly [string, string, string] = [
        "[1] Orch: ",
        "[2] Work: ",
        "[3] Val: ",
      ];
      const cand1 = buildStyledTabs(
        widePrefixes,
        nicks,
        `[4] Fallbacks(${fbCount})`,
        " · ",
      );
      if (cand1.plainWidth <= innerWidth) {
        return cand1.styled;
      }

      const cand2 = buildStyledTabs(
        widePrefixes,
        nicks,
        `[4] FB(${fbCount})`,
        " · ",
      );
      if (cand2.plainWidth <= innerWidth) {
        return cand2.styled;
      }

      const tightPrefixes: readonly [string, string, string] =
        innerWidth >= 84
          ? widePrefixes
          : ["[1]Orch:", "[2]Work:", "[3]Val:"];
      const fbShort = innerWidth >= 84 ? `[4] FB(${fbCount})` : `[4]FB(${fbCount})`;
      const baseFixed =
        tightPrefixes.reduce((sum, p) => sum + visibleWidth(p), 0) +
        effs.reduce((sum, e) => sum + visibleWidth(e), 0) +
        visibleWidth(fbShort);
      const sepPlain = innerWidth - (baseFixed + 9) >= 12 ? " · " : " ";
      const availCols = Math.max(
        6,
        innerWidth - baseFixed - visibleWidth(sepPlain) * 3,
      );
      const budgeted = budgetThreePills(nicks, availCols);
      return buildStyledTabs(tightPrefixes, budgeted, fbShort, sepPlain).styled;
    }

    if (innerWidth >= 46) {
      const fullLabels = [
        "[1] Orch",
        "[2] Work",
        "[3] Val",
        `[4] Fallbacks(${fbCount})`,
      ];
      const shortLabels = [
        "[1] Orch",
        "[2] Work",
        "[3] Val",
        `[4] FB(${fbCount})`,
      ];
      const plainFull = fullLabels.join(" · ");
      const chosen = visibleWidth(plainFull) <= innerWidth ? fullLabels : shortLabels;
      const styled = PICKER_TABS.map((tab, idx) =>
        tab === this.activeTab
          ? this.theme.fg("accent", this.theme.bold(chosen[idx]!))
          : this.theme.fg("muted", chosen[idx]!),
      );
      return fitLine(styled.join(this.theme.fg("dim", " · ")), innerWidth);
    }

    const withCount = ["[1]Orch", "[2]Work", "[3]Val", `[4]FB(${fbCount})`];
    const bare = ["[1]Orch", "[2]Work", "[3]Val", "[4]FB"];
    const chosen =
      visibleWidth(withCount.join(" ")) <= innerWidth ? withCount : bare;
    const styled = PICKER_TABS.map((tab, idx) =>
      tab === this.activeTab
        ? this.theme.fg("accent", this.theme.bold(chosen[idx]!))
        : this.theme.fg("muted", chosen[idx]!),
    );
    return fitLine(styled.join(" "), innerWidth);
  }

  private renderPinnedCurrentBar(innerWidth: number): string {
    if (this.activeTab === "fallbacks") {
      const fbSummary =
        this.state.settings.fallbackModels.length > 0
          ? this.state.settings.fallbackModels
              .map((m, i) => `#${i + 1} ${innerWidth < 72 ? shortenModelName(m) : m}`)
              .join(" · ")
          : "(none configured)";
      const left = `${this.theme.fg("muted", "Pool: ")}${this.theme.fg("accent", fbSummary)}`;
      const rightHint =
        innerWidth >= 94
          ? "Space toggle · [/] move · Ctrl+X clear · Ctrl+S scope"
          : innerWidth >= 68
            ? "Space · [/] · ^X clear · ^S scope"
            : "";
      return rightHint
        ? joinColumns(left, this.theme.fg("dim", rightHint), innerWidth, 2)
        : fitLine(left, innerWidth);
    }

    const cfg = this.getCurrentRoleConfig(this.activeTab);
    const explicitModel = sanitizePlainText(cfg.model ?? "");
    const hostModel = sanitizePlainText(this.state.hostModel ?? "");
    const effortText = cfg.thinkingLevel ?? "default";
    const origin: RoleModelOrigin =
      this.state.origins?.[this.activeTab] ??
      (explicitModel ? this.saveScope : "host");
    const originPlain = `[${origin}]`;
    const originStyled = formatOriginBadge(origin, this.theme);

    const prefixPlain = innerWidth < 46 ? "Cur: " : "Current: ";
    const suffixPlain = ` · ${effortText} ${originPlain}`;
    const fixedLeftCols = visibleWidth(prefixPlain) + visibleWidth(suffixPlain);

    const hintCandidates: ReadonlyArray<{ text: string; minModelCols: number }> = [
      {
        text: "Ctrl+E effort · Ctrl+X inherit host · Ctrl+S scope",
        minModelCols: 14,
      },
      {
        text: "^E effort · ^X inherit · ^S scope",
        minModelCols: 12,
      },
      {
        text: "^E · ^X · ^S",
        minModelCols: 10,
      },
      { text: "", minModelCols: 0 },
    ];

    let rightHint = "";
    for (const cand of hintCandidates) {
      const rightReserve = cand.text ? visibleWidth(cand.text) + 2 : 0;
      if (innerWidth - rightReserve - fixedLeftCols >= cand.minModelCols) {
        rightHint = cand.text;
        break;
      }
    }

    const leftBudget = rightHint
      ? Math.max(1, innerWidth - visibleWidth(rightHint) - 2)
      : innerWidth;
    const modelBudget = Math.max(4, leftBudget - fixedLeftCols);
    const fittedModel = explicitModel
      ? shortenModelName(explicitModel, modelBudget) || "default"
      : formatInheritedHostLabel(hostModel, Math.max(4, modelBudget - 5));

    const modelStyled = explicitModel
      ? this.theme.fg("accent", this.theme.bold(fittedModel))
      : this.theme.fg("dim", fittedModel);
    const effortStyled = cfg.thinkingLevel
      ? this.theme.fg("borderAccent", ` · ${effortText}`)
      : this.theme.fg("dim", ` · ${effortText}`);
    const leftStyled = `${this.theme.fg("muted", prefixPlain)}${modelStyled}${effortStyled} ${originStyled}`;

    return rightHint
      ? joinColumns(leftStyled, this.theme.fg("dim", rightHint), innerWidth, 2)
      : fitLine(leftStyled, innerWidth);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const innerWidth = computeBoxInnerWidth(safeWidth);
    const maxBoxLines = computeOverlayMaxBoxLines(this.tui);
    const maxInnerLines = Math.max(2, maxBoxLines - 2);
    const compact = innerWidth < 72;
    const ultraCompact = innerWidth < 46;

    const body: string[] = [];

    if (this.mode === "roles") {
      // At-a-glance 3-role tab bar + pinned Current:/Pool: status bar
      body.push(this.renderRoleTabBar(innerWidth));
      body.push(this.renderPinnedCurrentBar(innerWidth));

      if (!ultraCompact && maxInnerLines >= 13) {
        body.push(
          fitLine(this.theme.fg("muted", TAB_DESCRIPTIONS[this.activeTab]), innerWidth),
        );
      }
    } else if (this.member) {
      const rawMemberModel = sanitizePlainText(this.lastAppliedModel ?? this.member.model ?? "");
      const curModel = rawMemberModel || formatInheritedHostLabel(this.state.hostModel);
      const curThink = this.lastAppliedThinking ?? this.member.thinkingLevel;
      body.push(
        fitLine(
          `${this.theme.fg("muted", "Member: ")}${this.theme.fg("accent", this.theme.bold(`@${this.member.name}`))} ${this.theme.fg("dim", `(${this.member.role} · ${this.member.state})`)} · ${this.theme.fg("muted", "Current: ")}${curModel}${curThink ? ` · ${curThink}` : ""}`,
          innerWidth,
        ),
      );
      if (!ultraCompact) {
        body.push(
          fitLine(
            this.theme.fg(
              "dim",
              "Preserves 100% conversation history; running members switch at turn end.",
            ),
            innerWidth,
          ),
        );
      }
    }

    if (this.feedback) {
      const color =
        this.feedback.kind === "error"
          ? "error"
          : this.feedback.kind === "success"
            ? "success"
            : "accent";
      body.push(fitLine(this.theme.fg(color, this.feedback.text), innerWidth));
    }

    if (this.step === "effort" && this.pendingModel) {
      body.push(
        renderHorizontalRule(
          innerWidth,
          `Select Reasoning Effort — ${this.pendingModel.fullId}`,
          this.theme,
        ),
      );

      const effFooterLines = maxInnerLines - body.length >= 4 ? 2 : 1;
      const effortViewport = Math.max(1, maxInnerLines - body.length - effFooterLines);
      let effStart = Math.max(
        0,
        this.effortIndex - Math.floor(effortViewport / 2),
      );
      if (effStart + effortViewport > EFFORT_OPTIONS.length) {
        effStart = Math.max(0, EFFORT_OPTIONS.length - effortViewport);
      }
      const effEnd = Math.min(EFFORT_OPTIONS.length, effStart + effortViewport);
      const savedThinking = this.getTargetCurrentThinking();
      const savedModel = this.getTargetCurrentModel();
      const editingSameModel =
        Boolean(savedModel) &&
        (matchModelId(savedModel, this.pendingModel.fullId) ||
          matchModelId(savedModel, this.pendingModel.id));

      for (let i = effStart; i < effEnd; i++) {
        const opt = EFFORT_OPTIONS[i]!;
        const isSel = i === this.effortIndex;
        const isCurrent = editingSameModel && opt.level === savedThinking;
        const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
        const check = isCurrent ? this.theme.fg("success", "✓ ") : "  ";
        const num = this.theme.fg("muted", `${i + 1}. `);
        const label = isSel
          ? this.theme.fg("accent", this.theme.bold(opt.label))
          : opt.label;
        const badge = opt.recommended ? ` ${this.theme.fg("success", "*")}` : "";
        const desc = compact ? "" : ` — ${this.theme.fg("dim", opt.description)}`;
        body.push(fitLine(`${ptr}${check}${num}${label}${badge}${desc}`, innerWidth));
      }

      if (effFooterLines === 2) {
        body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
      }
      const effHint = ultraCompact
        ? "↑↓/1-8 · Enter Save · Esc Back"
        : compact
          ? "↑↓/1-8 Select · Enter Save · Esc Back"
          : "↑/↓ Navigate · 1-8 Jump · Enter Apply & Save · Esc Back to Models";
      body.push(fitLine(this.theme.fg("dim", effHint), innerWidth));

      const title =
        this.mode === "member" && this.member
          ? `◆ Reasoning Effort — @${this.member.name}`
          : `◆ Reasoning Effort — ${TAB_LABELS[this.activeTab]}`;
      return renderBox(body.slice(0, maxInnerLines), safeWidth, {
        title: this.theme.fg("accent", this.theme.bold(title)),
        borderColor: (t) => this.theme.fg("borderAccent", t),
      });
    }

    // Step 1: Search bar (real pi-tui Input with CURSOR_MARKER & bracketed paste) + scrollable list
    const renderedFilter = this.filterInput.render(innerWidth)[0] ?? "Filter: ";
    body.push(renderedFilter);
    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));

    const footerLinesCount = maxInnerLines - body.length >= 4 ? 2 : 1; // omit redundant rule on ultra-tight viewports
    const listViewport = Math.max(1, maxInnerLines - body.length - footerLinesCount);

    if (this.rows.length === 0) {
      body.push(
        fitLine(this.theme.fg("dim", "  (no matching models — type a custom provider/model ID)"), innerWidth),
      );
    } else {
      let start = Math.max(0, this.selectedIndex - Math.floor(listViewport / 2));
      if (start + listViewport > this.rows.length) {
        start = Math.max(0, this.rows.length - listViewport);
      }
      const end = Math.min(this.rows.length, start + listViewport);

      const targetModel = this.getTargetCurrentModel();
      const targetThinking = this.getTargetCurrentThinking();

      for (let i = start; i < end; i++) {
        const row = this.rows[i]!;
        if (row.kind === "header") {
          body.push(
            fitLine(
              this.theme.fg("dim", `── ${row.provider} ──`),
              innerWidth,
            ),
          );
          continue;
        }
        if (row.kind === "hint") {
          body.push(fitLine(this.theme.fg("dim", `  ${row.text}`), innerWidth));
          continue;
        }
        const isSel = i === this.selectedIndex;
        const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
        if (row.kind === "inherit") {
          const isCurrent = this.mode === "roles" && !targetModel;
          const check = isCurrent ? this.theme.fg("success", "✓ ") : "  ";
          const txt = isSel
            ? this.theme.fg("accent", this.theme.bold(row.label))
            : row.label;
          body.push(fitLine(`${ptr}${check}${txt}`, innerWidth));
          continue;
        }

        const info = row.info;
        const fbIndex = this.state.settings.fallbackModels.findIndex(
          (id) => matchModelId(id, info.fullId) || matchModelId(id, info.id),
        );
        const isCurrentTarget =
          this.activeTab === "fallbacks"
            ? fbIndex >= 0
            : Boolean(
                targetModel &&
                  (matchModelId(targetModel, info.fullId) ||
                    matchModelId(targetModel, info.id)),
              );
        const isHostModel = Boolean(
          this.state.hostModel &&
            (matchModelId(this.state.hostModel, info.fullId) ||
              matchModelId(this.state.hostModel, info.id)),
        );
        const check = isCurrentTarget
          ? this.theme.fg("success", "✓ ")
          : row.isPinned || isHostModel
            ? this.theme.fg("accent", "* ")
            : "  ";

        const badges: string[] = [];
        if (isHostModel) {
          badges.push("[host]");
        }
        if (
          matchModelId(this.state.settings.orchestratorModel, info.fullId) ||
          matchModelId(this.state.settings.orchestratorModel, info.id)
        ) {
          badges.push("[O]");
        }
        if (
          matchModelId(this.state.settings.workerModel, info.fullId) ||
          matchModelId(this.state.settings.workerModel, info.id)
        ) {
          badges.push("[W]");
        }
        if (
          matchModelId(this.state.settings.validatorModel, info.fullId) ||
          matchModelId(this.state.settings.validatorModel, info.id)
        ) {
          badges.push("[V]");
        }
        if (fbIndex >= 0) {
          badges.push(`#${fbIndex + 1}`);
        }
        if (row.isPinned && isCurrentTarget) {
          badges.push("*");
        }
        const ctxStr = formatContextWindow(info.contextWindow);
        const rightMeta = [
          isCurrentTarget && targetThinking && this.activeTab !== "fallbacks"
            ? targetThinking
            : "",
          ctxStr,
          ...badges,
        ]
          .filter(Boolean)
          .join(" ");

        const cleanName = info.name?.trim();
        const showFriendlyName =
          Boolean(cleanName) &&
          cleanName!.toLowerCase() !== info.id.toLowerCase() &&
          cleanName!.toLowerCase() !== info.fullId.toLowerCase();
        const primaryLabel = row.isCustomEntry
          ? info.name ?? info.fullId
          : compact
            ? info.fullId
            : showFriendlyName
              ? `${info.fullId} (${cleanName})`
              : info.fullId;
        const styledPrimary = isSel
          ? this.theme.fg("accent", this.theme.bold(primaryLabel))
          : primaryLabel;
        const leftPart = `${ptr}${check}${styledPrimary}`;

        if (rightMeta && innerWidth >= 46) {
          body.push(
            joinColumns(leftPart, this.theme.fg("dim", rightMeta), innerWidth),
          );
        } else {
          body.push(fitLine(leftPart, innerWidth));
        }
      }
    }

    if (footerLinesCount === 2) {
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    }
    const escAction = this.searchQuery.length > 0 ? "Esc Clear" : "Esc";
    const hints =
      this.mode === "member"
        ? ultraCompact
          ? `Enter · ^E Effort · ${escAction}`
          : compact
            ? `↑↓ · Enter Select · ^E Effort · ${escAction}`
            : `↑/↓ Select · Enter Effort · Ctrl+E Effort · ${this.searchQuery.length > 0 ? "Esc Clear" : "Esc Back"}`
        : this.activeTab === "fallbacks"
          ? ultraCompact
            ? `Space · [/] · ^S · Tab · ${escAction}`
            : innerWidth < 58
              ? `Space · [/] · ^S Scope · Tab · ${escAction}`
              : compact
                ? `Space Toggle · [/] · ^S Scope · Tab · ${escAction}`
                : innerWidth < 86
                  ? `↑/↓ Select · Space Toggle · [/] Move · ^S Scope · Tab · ${escAction}`
                  : `↑/↓ Select · Space Toggle · [/] Move · ^S Scope · Tab/Alt+1-4 · ${this.searchQuery.length > 0 ? "Esc Clear" : "Esc Close"}`
          : ultraCompact
            ? `Enter · ^E · ^S · Tab · ${escAction}`
            : innerWidth < 58
              ? `Enter Select · ^E · ^S Scope · Tab · ${escAction}`
              : compact
                ? `Enter Select · ^E Effort · ^X · ^S Scope · Tab · ${escAction}`
                : innerWidth < 86
                  ? `↑/↓ · Enter Select · ^E Effort · ^X Inherit · ^S Scope · Tab · ${escAction}`
                  : `↑/↓ Select · Enter Select · ^E Effort · ^X Inherit · ^S Scope · Tab/Alt+1-4 · ${escAction}`;
    body.push(fitLine(this.theme.fg("dim", hints), innerWidth));

    if (this.mode === "member" && this.member) {
      const memberTitle = `◆ Switch Model — @${this.member.name}`;
      return renderBox(body.slice(0, maxInnerLines), safeWidth, {
        title: this.theme.fg("accent", this.theme.bold(memberTitle)),
        borderColor: (t) => this.theme.fg("borderAccent", t),
      });
    }

    const baseTitle = this.theme.fg(
      "accent",
      this.theme.bold("◆ Swarm Mission Models"),
    );
    const scopeTitle =
      innerWidth >= 46
        ? `${this.theme.fg("dim", " · ")}${this.theme.fg(
            this.saveScope === "global" ? "accent" : "warning",
            `Scope: ${this.saveScope === "global" ? "Global" : "Project"}`,
          )}`
        : "";
    return renderBox(body.slice(0, maxInnerLines), safeWidth, {
      title: `${baseTitle}${scopeTitle}`,
      borderColor: (t) => this.theme.fg("borderAccent", t),
    });
  }
}

export async function openSwarmModelPicker(
  ctx: ExtensionContext,
  options: Omit<SwarmModelPickerViewOptions, "onClose">,
): Promise<{
  changed: boolean;
  state: ModelPickerSettingsState;
  selectedModel?: string;
  selectedThinkingLevel?: ThinkingLevel;
}> {
  if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    return { changed: false, state: options.state };
  }
  let component: SwarmModelPickerView | undefined;
  try {
    return await ctx.ui.custom(
      (tui, theme, _kb, done) => {
        component = new SwarmModelPickerView(tui, theme, {
          ...options,
          onClose: (res) => {
            done(res ?? { changed: false, state: options.state });
          },
        });
        return component;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          minWidth: 44,
          maxHeight: "86%",
          anchor: "center",
        },
      },
    );
  } finally {
    component?.dispose();
  }
}

// ============================================================================
// SwarmHubView (Droid /missions-style Unified Entry Launcher)
// ============================================================================

interface HubMenuItem {
  id:
    | "resume_unfinished"
    | "draft"
    | "direct"
    | "models"
    | "runs"
    | "settings"
    | "ui"
    | "tweak"
    | "pause"
    | "resume"
    | "done"
    | "teardown";
  label: string;
  runId?: string;
}

const MIN_CONCURRENCY = SWARM_SETTINGS_BOUNDS.maxConcurrency.min;
const MAX_CONCURRENCY = SWARM_SETTINGS_BOUNDS.maxConcurrency.max;

export class SwarmHubView implements Component, Focusable {
  readonly capturesViewportInput = true;
  private _focused = false;
  private state: ModelPickerSettingsState;
  private readonly snapshot: SwarmSnapshot;
  private readonly runs: readonly RunSummary[];
  private readonly goalInput: Input;
  private readonly hwCursor = new HardwareCursorController();
  private subView: "hub" | "models" | "runs" | "compose" = "hub";
  private pickerReturnSubView: "hub" | "compose" = "hub";
  private embeddedPicker: SwarmModelPickerView | null = null;
  private selectedIndex = 0;
  private runSelectedIndex = 0;
  private menuItems: HubMenuItem[] = [];
  private hubFeedback: string | null = null;
  private validatorOverride?: boolean;
  private concurrencyOverride?: number;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: SwarmHubViewOptions,
  ) {
    this.state = {
      ...options.state,
      settings: {
        ...options.state.settings,
        fallbackModels: [...options.state.settings.fallbackModels],
      },
      origins: options.state.origins ? { ...options.state.origins } : undefined,
    };
    this.snapshot = options.snapshot;
    this.runs = options.runs;
    this.goalInput = new Input({
      prompt: "Goal: ",
      placeholder: "Type what you want to build…",
      placeholderStyle: (s) => this.theme.fg("dim", s),
    });
    this.goalInput.focused = !this.hasActiveOrPausedRun();
    this.rebuildMenu();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.embeddedPicker) {
      this.embeddedPicker.focused = value;
      this.goalInput.focused = false;
      this.hwCursor.sync(this.tui, false);
      return;
    }
    const showGoal = value && this.isGoalInputActive();
    this.goalInput.focused = showGoal;
    this.hwCursor.sync(this.tui, showGoal);
  }

  dispose(): void {
    this.embeddedPicker?.dispose();
    this.goalInput.focused = false;
    this.hwCursor.restore(this.tui);
  }

  invalidate(): void {
    this.goalInput.invalidate();
    this.embeddedPicker?.invalidate();
  }

  private hasActiveOrPausedRun(): boolean {
    const status = this.snapshot.run?.status;
    return status === "active" || status === "paused";
  }

  private isGoalInputActive(): boolean {
    return (
      this.subView === "compose" ||
      (this.subView === "hub" && !this.hasActiveOrPausedRun())
    );
  }

  private getEffectiveValidatorEnabled(): boolean {
    return this.validatorOverride ?? this.state.settings.validatorEnabled;
  }

  private getEffectiveMaxConcurrency(): number {
    const raw = this.concurrencyOverride ?? this.state.settings.maxConcurrency;
    return Math.max(
      MIN_CONCURRENCY,
      Math.min(MAX_CONCURRENCY, Math.round(raw || 6)),
    );
  }

  private buildPolicyOverrides(): {
    validatorEnabled?: boolean;
    maxConcurrency?: number;
  } {
    return {
      ...(this.validatorOverride !== undefined
        ? { validatorEnabled: this.validatorOverride }
        : {}),
      ...(this.concurrencyOverride !== undefined
        ? { maxConcurrency: this.concurrencyOverride }
        : {}),
    };
  }

  private handlePolicyShortcut(data: string, allowBareKeys: boolean): boolean {
    const ch = decodePrintableInput(data);
    if (
      matchesKey(data, Key.alt("v")) ||
      matchesKey(data, Key.shiftAlt("v")) ||
      data === "\x1bV" ||
      (allowBareKeys && (ch === "v" || ch === "V"))
    ) {
      this.validatorOverride = !this.getEffectiveValidatorEnabled();
      this.tui.requestRender();
      return true;
    }
    if (
      matchesKey(data, Key.alt("+")) ||
      matchesKey(data, Key.alt("=")) ||
      matchesKey(data, Key.shiftAlt("=")) ||
      (allowBareKeys && (ch === "+" || ch === "="))
    ) {
      const cur = this.getEffectiveMaxConcurrency();
      this.concurrencyOverride = Math.min(MAX_CONCURRENCY, cur + 1);
      this.tui.requestRender();
      return true;
    }
    if (
      matchesKey(data, Key.alt("-")) ||
      matchesKey(data, Key.alt("_")) ||
      matchesKey(data, Key.shiftAlt("-")) ||
      (allowBareKeys && (ch === "-" || ch === "_"))
    ) {
      const cur = this.getEffectiveMaxConcurrency();
      this.concurrencyOverride = Math.max(MIN_CONCURRENCY, cur - 1);
      this.tui.requestRender();
      return true;
    }
    return false;
  }

  private openGoalComposer(): void {
    this.subView = "compose";
    this.hubFeedback = null;
    this.goalInput.focused = this._focused;
    this.hwCursor.sync(this.tui, this._focused);
    this.tui.requestRender();
  }

  private getResumableUnfinishedRun(): RunSummary | undefined {
    if (this.hasActiveOrPausedRun()) return undefined;
    const sid = this.options.currentSessionId?.trim();
    return this.runs.find((r) => {
      if (r.status !== "paused" && r.status !== "active") return false;
      if (
        sid &&
        r.ownerSessionId &&
        r.ownerSessionId !== sid &&
        r.ownerPid > 0 &&
        isProcessAlive(r.ownerPid)
      ) {
        return false;
      }
      return true;
    });
  }

  private rebuildMenu(): void {
    const run = this.snapshot.run;
    const items: HubMenuItem[] = [];
    if (run && this.hasActiveOrPausedRun()) {
      const isCrashRecoveredUnstarted =
        run.status === "active" &&
        this.snapshot.workingMemberNames.length === 0 &&
        this.options.activatedRun === false;
      items.push(
        { id: "ui", label: "◆ Open Mission Control (4-Tab UI)" },
        { id: "models", label: "◇ Configure Mission Models & Effort [Alt+M]" },
        { id: "tweak", label: "▸ Tweak Plan / Add Members" },
        run.status === "paused" || isCrashRecoveredUnstarted
          ? { id: "resume", label: "[>] Resume & Continue Mission", runId: run.id }
          : { id: "pause", label: "[||] Pause Swarm" },
        { id: "done", label: "✓ Complete Swarm (/swarm done)" },
        { id: "draft", label: "+ Start New Swarm…" },
      );
      if (this.runs.length > 0) {
        items.push({
          id: "runs",
          label: `◇ Switch Focused Run (${this.runs.length})`,
        });
      }
      items.push(
        { id: "settings", label: "* Runtime Settings" },
        { id: "teardown", label: "✗ Teardown Clean Worktrees" },
      );
    } else {
      const unfinished = this.getResumableUnfinishedRun();
      if (unfinished) {
        const title = sanitizePlainText(unfinished.title || unfinished.objective || unfinished.id);
        items.push({
          id: "resume_unfinished",
          label: `[>] Resume Mission: ${title.slice(0, 36)} (${unfinished.id})`,
          runId: unfinished.id,
        });
      }
      items.push(
        { id: "draft", label: "▸ Start Interactive Swarm — clarify & plan" },
        { id: "direct", label: "◆ Start Direct Swarm — fast-path, skip Q&A" },
        { id: "models", label: "◇ Configure Mission Models & Effort [Alt+M]" },
      );
      if (run) {
        items.push({ id: "ui", label: "◆ Inspect Run (4-Tab UI)" });
        items.push({ id: "teardown", label: "✗ Teardown Clean Worktrees" });
      }
      if (this.runs.length > 0) {
        items.push({
          id: "runs",
          label: `◇ Browse / Focus Previous Runs (${this.runs.length})`,
        });
      }
      items.push({
        id: "settings",
        label: "* Runtime Settings (concurrency, watchdog, git)",
      });
    }
    this.menuItems = items;
    if (this.selectedIndex >= items.length) {
      this.selectedIndex = Math.max(0, items.length - 1);
    }
  }

  private openEmbeddedModels(): void {
    this.pickerReturnSubView = this.subView === "compose" ? "compose" : "hub";
    this.subView = "models";
    this.goalInput.focused = false;
    this.hwCursor.sync(this.tui, false);
    this.embeddedPicker = new SwarmModelPickerView(this.tui, this.theme, {
      mode: "roles",
      initialScope: this.options.initialScope ?? "global",
      state: this.state,
      availableModels: this.options.availableModels,
      onApplyRole: this.options.onApplyRole,
      onApplyFallbacks: this.options.onApplyFallbacks,
      onClose: (res) => {
        if (res?.state) {
          this.state = res.state;
        }
        this.embeddedPicker = null;
        this.subView = this.pickerReturnSubView;
        const showGoal = this._focused && this.isGoalInputActive();
        this.goalInput.focused = showGoal;
        this.hwCursor.sync(this.tui, showGoal);
        this.tui.requestRender();
      },
    });
    this.embeddedPicker.focused = this._focused;
    this.tui.requestRender();
  }

  private triggerMenuItem(item: HubMenuItem): void {
    const goal = this.goalInput.getValue().trim();
    switch (item.id) {
      case "resume_unfinished":
        this.dispose();
        this.options.onComplete({
          kind: "resume",
          ...(item.runId ? { runId: item.runId } : {}),
          kickoff: true,
        });
        return;
      case "draft":
        if (this.hasActiveOrPausedRun()) {
          this.openGoalComposer();
          return;
        }
        this.dispose();
        this.options.onComplete({
          kind: "draft",
          goal,
          ...this.buildPolicyOverrides(),
        });
        return;
      case "direct":
        if (!goal) {
          this.hubFeedback = "Type a goal in Goal: above first (or choose Interactive Swarm).";
          this.tui.requestRender();
          return;
        }
        this.dispose();
        this.options.onComplete({
          kind: "direct",
          goal,
          ...this.buildPolicyOverrides(),
        });
        return;
      case "models":
        this.openEmbeddedModels();
        return;
      case "runs":
        if (this.runs.length > 0) {
          this.subView = "runs";
          this.goalInput.focused = false;
          this.hwCursor.sync(this.tui, false);
          this.runSelectedIndex = 0;
          this.tui.requestRender();
        }
        return;
      case "ui":
        this.dispose();
        this.options.onComplete({ kind: "ui" });
        return;
      case "tweak":
        this.dispose();
        this.options.onComplete({ kind: "tweak" });
        return;
      case "pause":
        this.dispose();
        this.options.onComplete({ kind: "pause" });
        return;
      case "resume":
        this.dispose();
        this.options.onComplete({
          kind: "resume",
          ...(item.runId ? { runId: item.runId } : {}),
          kickoff: true,
        });
        return;
      case "done":
        this.dispose();
        this.options.onComplete({ kind: "done" });
        return;
      case "settings":
        this.dispose();
        this.options.onComplete({ kind: "settings" });
        return;
      case "teardown":
        this.dispose();
        this.options.onComplete({ kind: "teardown" });
        return;
    }
  }

  handleInput(data: string): void {
    if (isKeyReleaseSafe(data)) {
      return;
    }

    if (this.subView === "models" && this.embeddedPicker) {
      this.embeddedPicker.handleInput(data);
      return;
    }

    if (this.subView === "compose") {
      if (isEscapeKey(data)) {
        this.subView = "hub";
        this.hubFeedback = null;
        this.goalInput.focused = false;
        this.hwCursor.sync(this.tui, false);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.ctrl("c"))) {
        this.dispose();
        this.options.onComplete({ kind: "cancel" });
        return;
      }

      const isUnambiguousCtrlM =
        data !== "\r" && data !== "\n" && matchesKey(data, Key.ctrl("m"));
      if (isUnambiguousCtrlM || matchesKey(data, Key.alt("m"))) {
        this.openEmbeddedModels();
        return;
      }

      if (this.handlePolicyShortcut(data, false)) {
        return;
      }

      if (matchesKey(data, Key.alt("enter"))) {
        const goal = this.goalInput.getValue().trim();
        if (!goal) {
          this.hubFeedback =
            "Type a goal in Goal: above first (or press Enter for Interactive Swarm).";
          this.tui.requestRender();
          return;
        }
        this.dispose();
        this.options.onComplete({
          kind: "direct",
          goal,
          ...this.buildPolicyOverrides(),
        });
        return;
      }

      if (matchesKey(data, Key.enter)) {
        const goal = this.goalInput.getValue().trim();
        this.dispose();
        this.options.onComplete({
          kind: "draft",
          goal,
          ...this.buildPolicyOverrides(),
        });
        return;
      }

      const normalized = isBackspaceKey(data) ? "\x7f" : normalizeEditorInput(data);
      if (normalized) {
        this.hubFeedback = null;
        this.goalInput.handleInput(normalized);
        this.tui.requestRender();
      }
      return;
    }

    if (this.subView === "runs") {
      const hasDetachRow = Boolean(this.snapshot.activeRunId);
      const totalRunRows = this.runs.length + (hasDetachRow ? 1 : 0);
      const ch = decodePrintableInput(data);
      if (isEscapeKey(data) || matchesKey(data, Key.ctrl("c"))) {
        this.subView = "hub";
        const showGoal = this._focused && !this.hasActiveOrPausedRun();
        this.goalInput.focused = showGoal;
        this.hwCursor.sync(this.tui, showGoal);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.up) || ch === "k") {
        this.runSelectedIndex =
          (this.runSelectedIndex - 1 + totalRunRows) % Math.max(1, totalRunRows);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || ch === "j") {
        this.runSelectedIndex =
          (this.runSelectedIndex + 1) % Math.max(1, totalRunRows);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (hasDetachRow && this.runSelectedIndex === this.runs.length) {
          this.dispose();
          this.options.onComplete({ kind: "focus", runId: "none" });
          return;
        }
        const chosen = this.runs[this.runSelectedIndex];
        if (chosen) {
          this.dispose();
          this.options.onComplete({ kind: "focus", runId: chosen.id });
        }
        return;
      }
      return;
    }

    if (isEscapeKey(data) || matchesKey(data, Key.ctrl("c"))) {
      this.dispose();
      this.options.onComplete({ kind: "cancel" });
      return;
    }

    const ch = decodePrintableInput(data);

    // Avoid C0 Ctrl+M == '\r' collision on legacy ANSI terminals while supporting CSI-u Ctrl+M, Alt+M, and `m` when no goal input
    const isUnambiguousCtrlM =
      data !== "\r" && data !== "\n" && matchesKey(data, Key.ctrl("m"));
    if (
      isUnambiguousCtrlM ||
      matchesKey(data, Key.alt("m")) ||
      (this.hasActiveOrPausedRun() && (ch === "m" || ch === "M"))
    ) {
      this.openEmbeddedModels();
      return;
    }

    if (this.handlePolicyShortcut(data, this.hasActiveOrPausedRun())) {
      return;
    }

    if (matchesKey(data, Key.alt("enter")) && !this.hasActiveOrPausedRun()) {
      const goal = this.goalInput.getValue().trim();
      if (!goal) {
        this.hubFeedback = "Type a goal in Goal: above first (or press Enter for Interactive Swarm).";
        this.tui.requestRender();
        return;
      }
      this.dispose();
      this.options.onComplete({
        kind: "direct",
        goal,
        ...this.buildPolicyOverrides(),
      });
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const item = this.menuItems[this.selectedIndex];
      if (item) {
        this.triggerMenuItem(item);
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.menuItems.length) % Math.max(1, this.menuItems.length);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex =
        (this.selectedIndex + 1) % Math.max(1, this.menuItems.length);
      this.tui.requestRender();
      return;
    }

    if (!this.hasActiveOrPausedRun()) {
      const normalized = isBackspaceKey(data) ? "\x7f" : normalizeEditorInput(data);
      if (normalized) {
        this.hubFeedback = null;
        const prevValue = this.goalInput.getValue();
        this.goalInput.handleInput(normalized);
        const nextValue = this.goalInput.getValue();
        const typedPrintable =
          !isBackspaceKey(data) &&
          (Boolean(ch) || nextValue.length > prevValue.length);
        if (
          typedPrintable &&
          nextValue.trim().length > 0 &&
          this.menuItems[this.selectedIndex]?.id === "resume_unfinished"
        ) {
          const draftIdx = this.menuItems.findIndex((item) => item.id === "draft");
          if (draftIdx >= 0) {
            this.selectedIndex = draftIdx;
          }
        }
        this.tui.requestRender();
      }
      return;
    }

    // Number / j / k shortcuts when no idle goal composer is active
    if (ch === "k") {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.menuItems.length) % Math.max(1, this.menuItems.length);
      this.tui.requestRender();
      return;
    }
    if (ch === "j") {
      this.selectedIndex =
        (this.selectedIndex + 1) % Math.max(1, this.menuItems.length);
      this.tui.requestRender();
      return;
    }
    if (ch && ch >= "1" && ch <= "9") {
      const idx = Number(ch) - 1;
      if (idx < this.menuItems.length) {
        this.selectedIndex = idx;
        this.tui.requestRender();
      }
    }
  }

  private renderPolicyLine(innerWidth: number, allowBareKeys: boolean): string {
    const valEnabled = this.getEffectiveValidatorEnabled();
    const maxConc = this.getEffectiveMaxConcurrency();
    const valPill = valEnabled
      ? this.theme.fg("success", this.theme.bold("ON"))
      : this.theme.fg("warning", this.theme.bold("OFF"));
    const concPill = this.theme.fg("accent", String(maxConc));
    const valKey = allowBareKeys ? "[v]" : "[Alt+V]";
    const concKey = allowBareKeys ? "[+/-]" : "[Alt+/-]";

    if (innerWidth < 46) {
      return fitLine(
        `${this.theme.fg("muted", "Validator:")} ${valPill} ${this.theme.fg("dim", "·")} ${this.theme.fg("muted", "Max:")} ${concPill}`,
        innerWidth,
      );
    }
    if (allowBareKeys ? innerWidth < 56 : innerWidth < 66) {
      return fitLine(
        `${this.theme.fg("dim", valKey)} Validator: ${valPill} ${this.theme.fg("dim", "·")} ${this.theme.fg("dim", concKey)} Max: ${concPill}`,
        innerWidth,
      );
    }
    return fitLine(
      `${this.theme.fg("dim", valKey)} Validator: ${valPill} ${this.theme.fg("dim", "·")} ${this.theme.fg("dim", concKey)} Max Concurrency: ${concPill}`,
      innerWidth,
    );
  }

  private renderGoalComposer(
    safeWidth: number,
    innerWidth: number,
    maxInner: number,
    compact: boolean,
  ): string[] {
    const body: string[] = [];
    const run = this.snapshot.run;
    if (run) {
      const title = sanitizePlainText(run.title || run.objective) || run.id;
      const badge = formatRunStatusBadge(run.status, this.theme);
      body.push(
        fitLine(
          `${this.theme.fg("warning", "Current run:")} ${this.theme.bold(title)} [${badge}]`,
          innerWidth,
        ),
      );
    }

    if (maxInner >= 9) {
      body.push(
        formatRoleModelsLine(
          buildRoleModelsFromPickerState(this.state),
          formatInheritedHostLabel(this.state.hostModel),
          {
            maxWidth: innerWidth,
            theme: this.theme,
            origins: compact ? undefined : this.state.origins,
          },
        ),
      );
    }

    body.push(this.renderPolicyLine(innerWidth, false));

    if (maxInner >= 7) {
      body.push(renderHorizontalRule(innerWidth, "New Swarm Goal", this.theme));
    }

    const renderedInput = this.goalInput.render(innerWidth)[0] ?? "Goal: ";
    body.push(renderedInput);

    const feedbackReserve = this.hubFeedback ? 1 : 0;
    if (maxInner - body.length - feedbackReserve >= 4) {
      const guidance =
        innerWidth >= 74
          ? "  [Enter] Clarify & Plan (optional) · [Alt+Enter] Direct Launch (goal required)"
          : innerWidth >= 52
            ? "[Enter] Clarify & Plan · [Alt+Enter] Direct Launch"
            : "[Enter] Draft · [Alt+Enter] Direct";
      body.push(fitLine(this.theme.fg("dim", guidance), innerWidth));
    }

    if (this.hubFeedback) {
      body.push(fitLine(this.theme.fg("warning", this.hubFeedback), innerWidth));
    }

    if (maxInner - body.length >= 2) {
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    }

    const footerHint =
      innerWidth < 46
        ? "Enter Draft · Alt+Enter · Esc"
        : compact
          ? "Enter Draft · Alt+Enter Direct · Alt+M · Esc Back"
          : innerWidth < 86
            ? "Enter Plan · Alt+Enter Direct · Alt+V/± Policy · Alt+M · Esc Back"
            : "Enter Clarify & Plan · Alt+Enter Direct · Alt+V/± Policy · Alt+M Models · Esc Back";
    body.push(fitLine(this.theme.fg("dim", footerHint), innerWidth));

    return renderBox(body.slice(0, maxInner), safeWidth, {
      title: this.theme.fg("accent", this.theme.bold("◆ Start New Swarm")),
      borderColor: (t) => this.theme.fg("borderAccent", t),
    });
  }

  render(width: number): string[] {
    if (this.subView === "models" && this.embeddedPicker) {
      return this.embeddedPicker.render(width);
    }

    const safeWidth = Math.max(1, Math.floor(width));
    const innerWidth = computeBoxInnerWidth(safeWidth);
    const compact = innerWidth < 68;
    const body: string[] = [];

    const maxBoxLines = computeOverlayMaxBoxLines(this.tui);
    const maxInner = Math.max(2, maxBoxLines - 2);
    if (this.subView === "compose") {
      return this.renderGoalComposer(safeWidth, innerWidth, maxInner, compact);
    }
    if (this.subView === "runs") {
      body.push(
        fitLine(
          this.theme.fg("muted", "Select a Swarm run to focus in this session:"),
          innerWidth,
        ),
      );
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
      const hasDetachRow = Boolean(this.snapshot.activeRunId);
      const totalRunRows = this.runs.length + (hasDetachRow ? 1 : 0);
      const runsFooterLines = maxInner - body.length >= 4 ? 2 : 1;
      const maxRows = Math.max(1, maxInner - body.length - runsFooterLines);
      let runStart = Math.max(0, this.runSelectedIndex - Math.floor(maxRows / 2));
      if (runStart + maxRows > totalRunRows) {
        runStart = Math.max(0, totalRunRows - maxRows);
      }
      const runEnd = Math.min(totalRunRows, runStart + maxRows);
      for (let i = runStart; i < runEnd; i++) {
        const isSel = i === this.runSelectedIndex;
        const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
        if (hasDetachRow && i === this.runs.length) {
          const lbl = isSel
            ? this.theme.fg("warning", this.theme.bold("Detach (unfocus current run)"))
            : this.theme.fg("muted", "Detach (unfocus current run)");
          body.push(fitLine(`${ptr}  ${lbl}`, innerWidth));
          continue;
        }
        const r = this.runs[i]!;
        const isCurrent = this.snapshot.activeRunId === r.id;
        const tag = isCurrent ? this.theme.fg("success", "● ") : "  ";
        const badge = formatRunStatusBadge(r.status, this.theme);
        const title = sanitizePlainText(r.title || r.objective);
        const age = formatElapsedSince(r.updatedAt);
        const label = `${sanitizePlainText(r.id)} [${badge}] ${title}`;
        const right = compact
          ? `${r.workingCount}/${r.memberCount} #${r.boardHead}`
          : `${r.memberCount}m (${r.workingCount}w) · #${r.boardHead} · ${age}`;
        const styledLeft = isSel
          ? this.theme.fg("accent", this.theme.bold(label))
          : label;
        body.push(joinColumns(`${ptr}${tag}${styledLeft}`, this.theme.fg("dim", right), innerWidth));
      }
      if (runsFooterLines === 2) {
        body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
      }
      body.push(
        fitLine(
          this.theme.fg("dim", "↑/↓ Navigate · Enter Focus Run · Esc Back"),
          innerWidth,
        ),
      );
      return renderBox(body.slice(0, maxInner), safeWidth, {
        title: this.theme.fg("accent", this.theme.bold("◆ Swarm Runs")),
        borderColor: (t) => this.theme.fg("borderAccent", t),
      });
    }

    // Active run status card (if present) or unfinished Mission notice
    const run = this.snapshot.run;
    const unfinished = this.getResumableUnfinishedRun();
    if (run) {
      const title = sanitizePlainText(run.title || run.objective) || run.id;
      if (this.hasActiveOrPausedRun()) {
        const badge = formatRunStatusBadge(run.status, this.theme);
        const leftHeader = `${this.theme.fg("accent", this.theme.bold(title))} [${badge}]`;
        const rightHeader = this.theme.fg(
          "dim",
          compact
            ? `#${this.snapshot.boardHead}`
            : `${sanitizePlainText(run.id)} · board #${this.snapshot.boardHead}`,
        );
        body.push(joinColumns(leftHeader, rightHeader, innerWidth));

        if (maxInner >= 9) {
          const membersList = Object.values(run.members ?? {});
          const workingCount =
            membersList.length > 0
              ? membersList.filter((m) => m.state === "working").length
              : this.snapshot.workingMemberNames.length;
          const waitingCount =
            membersList.length > 0
              ? membersList.filter((m) => m.state === "waiting").length
              : this.snapshot.waitingMemberNames.length;
          const mergedCount = membersList.filter((m) =>
            Boolean(m.mergedCommitSha),
          ).length;
          const stoppedCount = membersList.filter(
            (m) => m.state === "stopped",
          ).length;
          const sep = this.theme.fg("dim", " · ");
          if (innerWidth < 46) {
            const workShort =
              workingCount > 0
                ? this.theme.fg("accent", `${workingCount} working`)
                : this.theme.fg("muted", "0 working");
            const waitShort = this.theme.fg("muted", `${waitingCount} waiting`);
            const mergeShort =
              mergedCount > 0
                ? this.theme.fg("success", `${mergedCount} merged`)
                : this.theme.fg("dim", "0 merged");
            body.push(
              fitLine(
                `${workShort}${sep}${waitShort}${sep}${mergeShort}`,
                innerWidth,
              ),
            );
          } else {
            const workStyled =
              workingCount > 0
                ? this.theme.fg("accent", `● ${workingCount} working`)
                : this.theme.fg("muted", "● 0 working");
            const waitStyled = this.theme.fg(
              "muted",
              `◌ ${waitingCount} waiting`,
            );
            const mergeStyled =
              mergedCount > 0
                ? this.theme.fg("success", `✓ ${mergedCount} merged`)
                : this.theme.fg("dim", "✓ 0 merged");
            const stopStyled =
              !compact && stoppedCount > 0
                ? `${sep}${this.theme.fg("warning", `■ ${stoppedCount} stopped`)}`
                : "";
            body.push(
              fitLine(
                `${this.theme.fg("muted", "Pipeline: ")}${workStyled}${sep}${waitStyled}${sep}${mergeStyled}${stopStyled}`,
                innerWidth,
              ),
            );
          }
        }
      } else {
        const summary = `${run.id} · ${run.status} · working:${this.snapshot.workingMemberNames.length} waiting:${this.snapshot.waitingMemberNames.length} · board #${this.snapshot.boardHead}`;
        body.push(
          fitLine(
            `${this.theme.fg("accent", this.theme.bold(title))}  ${this.theme.fg("dim", summary)}`,
            innerWidth,
          ),
        );
      }
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    } else if (unfinished) {
      const title = sanitizePlainText(unfinished.title || unfinished.objective || unfinished.id);
      const badge = formatRunStatusBadge(unfinished.status, this.theme);
      body.push(
        fitLine(
          `${this.theme.fg("warning", "Unfinished Mission:")} ${this.theme.bold(title)} [${badge}] ${this.theme.fg("dim", `(${unfinished.id} · #${unfinished.boardHead})`)}`,
          innerWidth,
        ),
      );
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    }

    const activeOrPaused = this.hasActiveOrPausedRun();

    // Mission Models Card (collapses cleanly on <= 14-row inner height terminals)
    if (maxInner <= 14) {
      body.push(
        formatRoleModelsLine(
          buildRoleModelsFromPickerState(this.state),
          formatInheritedHostLabel(this.state.hostModel),
          {
            maxWidth: innerWidth,
            theme: this.theme,
            origins: compact ? undefined : this.state.origins,
          },
        ),
      );
      if (maxInner >= 10) {
        body.push(this.renderPolicyLine(innerWidth, activeOrPaused));
      }
    } else {
      const oCell = formatRoleSummaryCell(
        this.state.settings.orchestratorModel,
        this.state.settings.orchestratorThinkingLevel,
        this.state.hostModel,
        this.state.origins?.orchestrator,
        this.theme,
        compact,
      );
      const wCell = formatRoleSummaryCell(
        this.state.settings.workerModel,
        this.state.settings.workerThinkingLevel,
        this.state.hostModel,
        this.state.origins?.worker,
        this.theme,
        compact,
      );
      const vCell = formatRoleSummaryCell(
        this.state.settings.validatorModel,
        this.state.settings.validatorThinkingLevel,
        this.state.hostModel,
        this.state.origins?.validator,
        this.theme,
        compact,
      );

      body.push(
        fitLine(`${this.theme.fg("muted", "Orchestrator  ")}${oCell}`, innerWidth),
      );
      body.push(
        fitLine(`${this.theme.fg("muted", "Worker        ")}${wCell}`, innerWidth),
      );
      body.push(
        fitLine(`${this.theme.fg("muted", "Validator     ")}${vCell}`, innerWidth),
      );
      if (this.state.settings.fallbackModels.length > 0) {
        const fbText = this.state.settings.fallbackModels
          .map((m) => (compact ? shortenModelName(m) : m))
          .join(", ");
        body.push(
          fitLine(
            `${this.theme.fg("muted", "Fallbacks     ")}${this.theme.fg("dim", fbText)}`,
            innerWidth,
          ),
        );
      }
      body.push(this.renderPolicyLine(innerWidth, activeOrPaused));
    }

    if (!activeOrPaused) {
      body.push(renderHorizontalRule(innerWidth, "Goal (optional)", this.theme));
      const renderedInput = this.goalInput.render(innerWidth)[0] ?? "Goal: ";
      body.push(renderedInput);
      if (maxInner - body.length >= 5) {
        const goalHint =
          innerWidth >= 69
            ? "  [Enter] Clarify & Plan · [Alt+Enter] Direct Launch · [Alt+M] Models"
            : innerWidth >= 53
              ? "[Enter] Clarify & Plan · [Alt+Enter] Direct · [Alt+M]"
              : "[Enter] Plan · [Alt+Enter] Direct";
        body.push(fitLine(this.theme.fg("dim", goalHint), innerWidth));
      }
    }

    if (this.hubFeedback) {
      body.push(fitLine(this.theme.fg("warning", this.hubFeedback), innerWidth));
    }

    const footerLines = maxInner - (body.length + 1) >= 4 ? 2 : 1;
    const rawMenuSlots = Math.max(1, maxInner - (body.length + 1) - footerLines);
    const needsScroll = this.menuItems.length > rawMenuSlots;
    const inlineScrollIndicator = needsScroll && rawMenuSlots >= 2;
    const menuViewport = inlineScrollIndicator ? rawMenuSlots - 1 : rawMenuSlots;
    let menuStart = Math.max(0, this.selectedIndex - Math.floor(menuViewport / 2));
    if (menuStart + menuViewport > this.menuItems.length) {
      menuStart = Math.max(0, this.menuItems.length - menuViewport);
    }
    const menuEnd = Math.min(this.menuItems.length, menuStart + menuViewport);
    const hiddenAbove = menuStart;
    const hiddenBelow = Math.max(0, this.menuItems.length - menuEnd);

    const actionsRuleLabel =
      needsScroll && !inlineScrollIndicator
        ? hiddenBelow > 0
          ? `Actions · ↓ +${hiddenBelow} more`
          : `Actions · ↑ +${hiddenAbove} above`
        : "Actions";
    body.push(renderHorizontalRule(innerWidth, actionsRuleLabel, this.theme));

    for (let i = menuStart; i < menuEnd; i++) {
      const item = this.menuItems[i]!;
      const isSel = i === this.selectedIndex;
      const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
      const badge = activeOrPaused
        ? i < 9
          ? `${this.theme.fg(isSel ? "accent" : "muted", `[${i + 1}]`)} `
          : "    "
        : "";
      const label = isSel
        ? this.theme.fg("accent", this.theme.bold(item.label))
        : item.label;
      body.push(fitLine(`${ptr}${badge}${label}`, innerWidth));
    }

    if (inlineScrollIndicator) {
      const scrollParts: string[] = [];
      if (hiddenAbove > 0) scrollParts.push(`↑ +${hiddenAbove} above`);
      if (hiddenBelow > 0) scrollParts.push(`↓ +${hiddenBelow} more`);
      if (scrollParts.length > 0) {
        body.push(
          fitLine(
            this.theme.fg("dim", `  ${scrollParts.join(" · ")}`),
            innerWidth,
          ),
        );
      }
    }

    if (footerLines === 2) {
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    }
    const hint = activeOrPaused
      ? innerWidth < 46
        ? "1-9/↑↓ · Enter · m/Alt+M · Esc"
        : compact
          ? "1-9/↑↓ · Enter · m/Alt+M · v/± · Esc"
          : innerWidth < 86
            ? "1-9/↑↓/jk · Enter · m/Alt+M Models · v/± Policy · Esc"
            : "1-9 / ↑/↓/j/k Navigate · Enter Select · m/Alt+M Models · v/± Policy · Esc"
      : innerWidth < 46
        ? "Goal · Enter · Alt+M · Esc"
        : innerWidth < 50
          ? "Goal · Enter · Alt+Enter Direct · Alt+M · Esc"
          : compact
            ? "Goal · ↑↓ · Enter · Alt+Enter Direct · Alt+M · Esc"
            : innerWidth < 86
              ? "Type Goal · ↑/↓ · Enter · Alt+Enter Direct · Alt+M Models · Esc"
              : "Type Goal · ↑/↓ Action · Enter Launch · Alt+Enter Direct · Alt+M Models · Esc";
    body.push(fitLine(this.theme.fg("dim", hint), innerWidth));

    return renderBox(body.slice(0, maxInner), safeWidth, {
      title: this.theme.fg("accent", this.theme.bold("◆ Pi Swarm Mission Hub")),
      borderColor: (t) => this.theme.fg("borderAccent", t),
    });
  }
}

export async function openSwarmHub(
  ctx: ExtensionContext,
  options: Omit<SwarmHubViewOptions, "onComplete">,
): Promise<SwarmHubAction> {
  if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    return { kind: "cancel" };
  }
  let component: SwarmHubView | undefined;
  try {
    return await ctx.ui.custom<SwarmHubAction>(
      (tui, theme, _kb, done) => {
        component = new SwarmHubView(tui, theme, {
          ...options,
          onComplete: (action) => done(action),
        });
        return component;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          minWidth: 44,
          maxHeight: "86%",
          anchor: "center",
        },
      },
    );
  } finally {
    component?.dispose();
  }
}

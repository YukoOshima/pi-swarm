import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
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
  fitLine,
  joinColumns,
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
  | { kind: "draft"; goal: string }
  | { kind: "direct"; goal: string }
  | { kind: "ui" }
  | { kind: "tweak" }
  | { kind: "pause" }
  | { kind: "resume" }
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

function decodePrintableChar(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) return data;
  }
  return undefined;
}

function computeBoxInnerWidth(totalWidth: number): number {
  const safe = Math.max(20, Math.floor(totalWidth));
  const padX = safe < 24 ? 0 : 1;
  return Math.max(8, safe - 2 - padX * 2);
}

function computeTerminalRows(tui: TUI): number {
  const rows = Number((tui as unknown as { terminal?: { rows?: number } }).terminal?.rows);
  if (Number.isFinite(rows) && rows > 0) {
    return Math.floor(rows);
  }
  return 28;
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

function formatOriginTag(origin?: RoleModelOrigin): string {
  if (origin === "project") return "[project]";
  if (origin === "global") return "[global]";
  return "[session]";
}

function formatRoleSummaryCell(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
  hostModel: string | undefined,
  origin: RoleModelOrigin | undefined,
  compact = false,
): string {
  const raw = sanitizePlainText(model ?? "") || sanitizePlainText(hostModel ?? "") || "session default";
  const label = compact ? shortenModelName(raw) : raw;
  const thinkPart = thinking ? ` · ${thinking}` : "";
  const origPart = origin ? ` ${formatOriginTag(origin)}` : "";
  return `${label}${thinkPart}${origPart}`;
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

function matchModelId(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

type ModelListRow =
  | { kind: "header"; provider: string; selectable: false }
  | { kind: "inherit"; label: string; selectable: true }
  | {
      kind: "model";
      info: AvailableModelInfo;
      isCustomEntry?: boolean;
      selectable: true;
    };

// ============================================================================
// SwarmModelPickerView (Droid missionModelPicker + Reasoning Effort Picker)
// ============================================================================

export class SwarmModelPickerView implements Component {
  private readonly mode: "roles" | "member";
  private activeTab: ModelPickerTab;
  private saveScope: ModelSaveScope;
  private state: ModelPickerSettingsState;
  private readonly availableModels: AvailableModelInfo[];
  private readonly member?: SwarmMemberRecord;

  private searchQuery = "";
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
    this.rebuildRows(true);
  }

  invalidate(): void {
    // Purely state-driven render
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
      const lower = trimmed.toLowerCase();
      if (seen.has(lower) || seenShort.has(lower)) return;
      const slash = trimmed.indexOf("/");
      const provider = slash > 0 ? trimmed.slice(0, slash) : "configured";
      const id = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
      seen.add(lower);
      out.push({
        id,
        provider,
        fullId: trimmed,
        name: trimmed,
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
    const catalog = this.getMergedCatalog();
    const rows: ModelListRow[] = [];

    if (this.mode === "roles" && this.activeTab !== "fallbacks") {
      const hostHint = sanitizePlainText(this.state.hostModel ?? "") || "session default";
      const inheritText = `inherit host session default ${hostHint}`.toLowerCase();
      if (!query || inheritText.includes(query)) {
        rows.push({
          kind: "inherit",
          label: `Inherit host session model (${hostHint})`,
          selectable: true,
        });
      }
    }

    const filtered = catalog.filter((m) => {
      if (!query) return true;
      const hay = `${m.fullId} ${m.id} ${m.provider} ${m.name ?? ""}`.toLowerCase();
      return query.split(/\s+/).every((tok) => hay.includes(tok));
    });

    const byProvider = new Map<string, AvailableModelInfo[]>();
    for (const m of filtered) {
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

  private clampSelectedIndex(): void {
    if (this.rows.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    const clamped = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex));
    if (this.rows[clamped]?.selectable) {
      this.selectedIndex = clamped;
      return;
    }
    this.selectedIndex = this.findFirstSelectableIndex();
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
    this.tui.requestRender();
  }

  private closePicker(): void {
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

  private switchTab(delta: number): void {
    if (this.mode !== "roles") return;
    const idx = PICKER_TABS.indexOf(this.activeTab);
    const nextIdx = (idx + delta + PICKER_TABS.length) % PICKER_TABS.length;
    this.activeTab = PICKER_TABS[nextIdx]!;
    this.step = "list";
    this.pendingModel = null;
    this.searchQuery = "";
    this.rebuildRows(true);
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.busy) {
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      this.closePicker();
      return;
    }

    if (this.step === "effort") {
      if (matchesKey(data, Key.escape)) {
        this.step = "list";
        this.pendingModel = null;
        this.tui.requestRender();
        return;
      }

      const ch = decodePrintableChar(data);
      if (matchesKey(data, Key.up) || ch === "k") {
        this.effortIndex =
          (this.effortIndex - 1 + EFFORT_OPTIONS.length) % EFFORT_OPTIONS.length;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || ch === "j") {
        this.effortIndex = (this.effortIndex + 1) % EFFORT_OPTIONS.length;
        this.tui.requestRender();
        return;
      }
      if (ch && ch >= "1" && ch <= String(EFFORT_OPTIONS.length)) {
        this.effortIndex = Number(ch) - 1;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
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
    if (matchesKey(data, Key.escape)) {
      this.closePicker();
      return;
    }

    if (this.mode === "roles") {
      if (matchesKey(data, Key.tab)) {
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
        this.searchQuery = "";
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
      if (activeModelId) {
        const curThinking = this.getTargetCurrentThinking();
        const curIdx = EFFORT_CYCLE.indexOf(curThinking);
        const nextThinking = EFFORT_CYCLE[(curIdx + 1) % EFFORT_CYCLE.length];
        if (this.mode === "member") {
          void this.commitMemberSelection(activeModelId, nextThinking);
        } else {
          void this.commitRoleSelection(this.activeTab, activeModelId, nextThinking);
        }
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

    if (matchesKey(data, Key.backspace)) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.rebuildRows(false);
        this.tui.requestRender();
      }
      return;
    }

    const row = this.rows[this.selectedIndex];

    // Fallbacks reorder shortcuts: Alt+Up / Alt+Down, or `[` / `]` when filter is empty
    if (this.mode === "roles" && this.activeTab === "fallbacks" && row?.kind === "model") {
      const ch = decodePrintableChar(data);
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

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
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

    if (this.mode === "roles" && this.activeTab === "fallbacks" && data === " ") {
      if (row?.kind === "model") {
        this.toggleFallbackRow(row.info);
      }
      return;
    }

    const ch = decodePrintableChar(data);
    if (ch !== undefined) {
      this.searchQuery += ch;
      this.rebuildRows(false);
      this.tui.requestRender();
    }
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

  render(width: number): string[] {
    const safeWidth = Math.max(20, Math.floor(width));
    const innerWidth = computeBoxInnerWidth(safeWidth);
    const maxRows = computeTerminalRows(this.tui);
    const maxInnerLines = Math.max(8, maxRows - 4);
    const compact = innerWidth < 68;

    const body: string[] = [];

    if (this.mode === "roles") {
      // Tab strip + scope badge
      const tabParts = PICKER_TABS.map((t) => {
        const lbl = TAB_LABELS[t];
        return t === this.activeTab
          ? this.theme.fg("accent", this.theme.bold(`[${lbl}]`))
          : this.theme.fg("muted", ` ${lbl} `);
      });
      const scopeTag =
        this.saveScope === "global"
          ? this.theme.fg("accent", "Scope: Global")
          : this.theme.fg("warning", "Scope: Project");
      body.push(joinColumns(tabParts.join(" "), scopeTag, innerWidth));

      // Role description & current summary
      body.push(
        fitLine(this.theme.fg("muted", TAB_DESCRIPTIONS[this.activeTab]), innerWidth),
      );

      if (this.activeTab === "fallbacks") {
        const fbSummary =
          this.state.settings.fallbackModels.length > 0
            ? this.state.settings.fallbackModels
                .map((m, i) => `#${i + 1} ${compact ? shortenModelName(m) : m}`)
                .join(" · ")
            : "(none configured)";
        body.push(
          fitLine(
            `${this.theme.fg("muted", "Pool: ")}${this.theme.fg("accent", fbSummary)}`,
            innerWidth,
          ),
        );
      } else {
        const oStr = formatRoleSummaryCell(
          this.state.settings.orchestratorModel,
          this.state.settings.orchestratorThinkingLevel,
          this.state.hostModel,
          this.state.origins?.orchestrator,
          true,
        );
        const wStr = formatRoleSummaryCell(
          this.state.settings.workerModel,
          this.state.settings.workerThinkingLevel,
          this.state.hostModel,
          this.state.origins?.worker,
          true,
        );
        const vStr = formatRoleSummaryCell(
          this.state.settings.validatorModel,
          this.state.settings.validatorThinkingLevel,
          this.state.hostModel,
          this.state.origins?.validator,
          true,
        );
        body.push(
          fitLine(
            `${this.theme.fg("muted", "O:")}${oStr} · ${this.theme.fg("muted", "W:")}${wStr} · ${this.theme.fg("muted", "V:")}${vStr}`,
            innerWidth,
          ),
        );
      }
    } else if (this.member) {
      const curModel = sanitizePlainText(this.lastAppliedModel ?? this.member.model ?? "") || "default";
      const curThink = this.lastAppliedThinking ?? this.member.thinkingLevel;
      body.push(
        fitLine(
          `${this.theme.fg("muted", "Member: ")}${this.theme.fg("accent", this.theme.bold(`@${this.member.name}`))} ${this.theme.fg("dim", `(${this.member.role} · ${this.member.state})`)} · ${this.theme.fg("muted", "Current: ")}${curModel}${curThink ? ` · ${curThink}` : ""}`,
          innerWidth,
        ),
      );
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

      const effortViewport = Math.max(2, maxInnerLines - body.length - 2);
      let effStart = Math.max(
        0,
        this.effortIndex - Math.floor(effortViewport / 2),
      );
      if (effStart + effortViewport > EFFORT_OPTIONS.length) {
        effStart = Math.max(0, EFFORT_OPTIONS.length - effortViewport);
      }
      const effEnd = Math.min(EFFORT_OPTIONS.length, effStart + effortViewport);

      for (let i = effStart; i < effEnd; i++) {
        const opt = EFFORT_OPTIONS[i]!;
        const isSel = i === this.effortIndex;
        const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
        const num = this.theme.fg("muted", `${i + 1}. `);
        const label = isSel
          ? this.theme.fg("accent", this.theme.bold(opt.label))
          : opt.label;
        const badge = opt.recommended ? ` ${this.theme.fg("success", "★")}` : "";
        const desc = compact ? "" : ` — ${this.theme.fg("dim", opt.description)}`;
        body.push(fitLine(`${ptr}${num}${label}${badge}${desc}`, innerWidth));
      }

      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
      body.push(
        fitLine(
          this.theme.fg(
            "dim",
            "↑/↓ Navigate · 1-8 Jump · Enter Apply & Save · Esc Back to Models",
          ),
          innerWidth,
        ),
      );

      const title =
        this.mode === "member" && this.member
          ? `🎛 Reasoning Effort — @${this.member.name}`
          : `🎛 Reasoning Effort — ${TAB_LABELS[this.activeTab]}`;
      return renderBox(body.slice(0, maxInnerLines), safeWidth, {
        title: this.theme.fg("accent", this.theme.bold(title)),
        borderColor: (t) => this.theme.fg("borderAccent", t),
      });
    }

    // Step 1: Search bar + scrollable list
    const filterDisplay =
      this.searchQuery.length > 0
        ? this.searchQuery
        : this.theme.fg("dim", "Type to filter models…");
    body.push(
      fitLine(
        `${this.theme.fg("muted", "Filter: ")}${filterDisplay}${this.theme.fg("accent", "▏")}`,
        innerWidth,
      ),
    );
    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));

    const footerLinesCount = 2; // rule + key hint
    const listViewport = Math.max(3, maxInnerLines - body.length - footerLinesCount);

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
        const check = isCurrentTarget ? this.theme.fg("success", "✓ ") : "  ";

        const badges: string[] = [];
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

        const primaryLabel = row.isCustomEntry
          ? info.name ?? info.fullId
          : compact
            ? info.fullId
            : info.name && info.name !== info.id
              ? `${info.fullId} (${info.name})`
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

    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    const hints =
      this.mode === "member"
        ? "↑/↓ Select · Enter Choose Effort · Ctrl+E Cycle Effort · Esc Back"
        : this.activeTab === "fallbacks"
          ? "↑/↓ Select · Space/Enter Toggle · [/] Reorder · Ctrl+S Scope · Tab Role · Esc Close"
          : "↑/↓ Select · Enter Choose Effort · Ctrl+E Cycle · Ctrl+X Inherit · Ctrl+S Scope · Tab Role · Esc Close";
    body.push(fitLine(this.theme.fg("dim", hints), innerWidth));

    const boxTitle =
      this.mode === "member" && this.member
        ? `🎛 Switch Model — @${this.member.name}`
        : "🎛 Swarm Mission Models";
    return renderBox(body.slice(0, maxInnerLines), safeWidth, {
      title: this.theme.fg("accent", this.theme.bold(boxTitle)),
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
  return ctx.ui.custom((tui, theme, _kb, done) => {
    return new SwarmModelPickerView(tui, theme, {
      ...options,
      onClose: (res) => {
        done(res ?? { changed: false, state: options.state });
      },
    });
  });
}

// ============================================================================
// SwarmHubView (Droid /missions-style Unified Entry Launcher)
// ============================================================================

interface HubMenuItem {
  id:
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
}

export class SwarmHubView implements Component, Focusable {
  focused = false;
  private state: ModelPickerSettingsState;
  private readonly snapshot: SwarmSnapshot;
  private readonly runs: readonly RunSummary[];
  private readonly goalInput: Input;
  private subView: "hub" | "models" | "runs" = "hub";
  private embeddedPicker: SwarmModelPickerView | null = null;
  private selectedIndex = 0;
  private runSelectedIndex = 0;
  private menuItems: HubMenuItem[] = [];

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
    this.goalInput = new Input();
    this.goalInput.focused = true;
    this.rebuildMenu();
  }

  invalidate(): void {
    this.embeddedPicker?.invalidate();
  }

  private hasActiveOrPausedRun(): boolean {
    const status = this.snapshot.run?.status;
    return status === "active" || status === "paused";
  }

  private rebuildMenu(): void {
    const run = this.snapshot.run;
    const items: HubMenuItem[] = [];
    if (run && this.hasActiveOrPausedRun()) {
      items.push(
        { id: "ui", label: "🖥 Open Mission Control (4-Tab UI)" },
        { id: "models", label: "🎛 Configure Mission Models & Effort [Ctrl+M]" },
        { id: "tweak", label: "✏ Tweak Plan / Add Members" },
        run.status === "paused"
          ? { id: "resume", label: "▶ Resume Swarm" }
          : { id: "pause", label: "⏸ Pause Swarm" },
        { id: "done", label: "✓ Complete Swarm (/swarm done)" },
        { id: "draft", label: "➕ Start New Swarm…" },
      );
      if (this.runs.length > 0) {
        items.push({
          id: "runs",
          label: `📂 Switch Focused Run (${this.runs.length})`,
        });
      }
      items.push(
        { id: "settings", label: "⚙ Runtime Settings" },
        { id: "teardown", label: "🧹 Teardown Clean Worktrees" },
      );
    } else {
      items.push(
        { id: "draft", label: "▶ Start Interactive Swarm — clarify & plan" },
        { id: "direct", label: "⚡ Start Direct Swarm — fast-path, skip Q&A" },
        { id: "models", label: "🎛 Configure Mission Models & Effort [Ctrl+M]" },
      );
      if (this.runs.length > 0) {
        items.push({
          id: "runs",
          label: `📂 Browse / Focus Previous Runs (${this.runs.length})`,
        });
      }
      items.push({
        id: "settings",
        label: "⚙ Runtime Settings (concurrency, watchdog, git)",
      });
    }
    this.menuItems = items;
    if (this.selectedIndex >= items.length) {
      this.selectedIndex = Math.max(0, items.length - 1);
    }
  }

  private openEmbeddedModels(): void {
    this.subView = "models";
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
        this.subView = "hub";
        this.tui.requestRender();
      },
    });
    this.tui.requestRender();
  }

  private triggerMenuItem(item: HubMenuItem): void {
    const goal = this.goalInput.getValue().trim();
    switch (item.id) {
      case "draft":
        this.options.onComplete({ kind: "draft", goal });
        return;
      case "direct":
        this.options.onComplete({ kind: "direct", goal });
        return;
      case "models":
        this.openEmbeddedModels();
        return;
      case "runs":
        if (this.runs.length > 0) {
          this.subView = "runs";
          this.runSelectedIndex = 0;
          this.tui.requestRender();
        }
        return;
      case "ui":
        this.options.onComplete({ kind: "ui" });
        return;
      case "tweak":
        this.options.onComplete({ kind: "tweak" });
        return;
      case "pause":
        this.options.onComplete({ kind: "pause" });
        return;
      case "resume":
        this.options.onComplete({ kind: "resume" });
        return;
      case "done":
        this.options.onComplete({ kind: "done" });
        return;
      case "settings":
        this.options.onComplete({ kind: "settings" });
        return;
      case "teardown":
        this.options.onComplete({ kind: "teardown" });
        return;
    }
  }

  handleInput(data: string): void {
    if (this.subView === "models" && this.embeddedPicker) {
      this.embeddedPicker.handleInput(data);
      return;
    }

    if (this.subView === "runs") {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.subView = "hub";
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.runSelectedIndex =
          (this.runSelectedIndex - 1 + this.runs.length) % Math.max(1, this.runs.length);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        this.runSelectedIndex =
          (this.runSelectedIndex + 1) % Math.max(1, this.runs.length);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        const chosen = this.runs[this.runSelectedIndex];
        if (chosen) {
          this.options.onComplete({ kind: "focus", runId: chosen.id });
        }
        return;
      }
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.options.onComplete({ kind: "cancel" });
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const item = this.menuItems[this.selectedIndex];
      if (item) {
        this.triggerMenuItem(item);
      }
      return;
    }

    if (matchesKey(data, Key.ctrl("m"))) {
      this.openEmbeddedModels();
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
      this.goalInput.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // Number / j / k shortcuts when no idle goal composer is active
    if (data === "k") {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.menuItems.length) % Math.max(1, this.menuItems.length);
      this.tui.requestRender();
      return;
    }
    if (data === "j") {
      this.selectedIndex =
        (this.selectedIndex + 1) % Math.max(1, this.menuItems.length);
      this.tui.requestRender();
      return;
    }
    if (data >= "1" && data <= String(this.menuItems.length)) {
      this.selectedIndex = Number(data) - 1;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (this.subView === "models" && this.embeddedPicker) {
      return this.embeddedPicker.render(width);
    }

    const safeWidth = Math.max(20, Math.floor(width));
    const innerWidth = computeBoxInnerWidth(safeWidth);
    const compact = innerWidth < 68;
    const body: string[] = [];

    const maxInner = Math.max(8, computeTerminalRows(this.tui) - 4);
    if (this.subView === "runs") {
      body.push(
        fitLine(
          this.theme.fg("muted", "Select a Swarm run to focus in this session:"),
          innerWidth,
        ),
      );
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
      const maxRows = Math.max(2, maxInner - body.length - 2);
      let runStart = Math.max(0, this.runSelectedIndex - Math.floor(maxRows / 2));
      if (runStart + maxRows > this.runs.length) {
        runStart = Math.max(0, this.runs.length - maxRows);
      }
      const runEnd = Math.min(this.runs.length, runStart + maxRows);
      for (let i = runStart; i < runEnd; i++) {
        const r = this.runs[i]!;
        const isSel = i === this.runSelectedIndex;
        const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
        const isCurrent = this.snapshot.activeRunId === r.id;
        const tag = isCurrent ? this.theme.fg("success", "● ") : "  ";
        const title = sanitizePlainText(r.title || r.objective);
        const label = `${r.id} [${r.status}] ${title}`;
        const right = `w:${r.workingCount} #${r.boardHead}`;
        const styledLeft = isSel
          ? this.theme.fg("accent", this.theme.bold(label))
          : label;
        body.push(joinColumns(`${ptr}${tag}${styledLeft}`, this.theme.fg("dim", right), innerWidth));
      }
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
      body.push(
        fitLine(
          this.theme.fg("dim", "↑/↓ Navigate · Enter Focus Run · Esc Back"),
          innerWidth,
        ),
      );
      return renderBox(body.slice(0, maxInner), safeWidth, {
        title: this.theme.fg("accent", this.theme.bold("📂 Swarm Runs")),
        borderColor: (t) => this.theme.fg("borderAccent", t),
      });
    }

    // Active run status card (if present)
    const run = this.snapshot.run;
    if (run) {
      const title = sanitizePlainText(run.title || run.objective) || run.id;
      const summary = `${run.id} · ${run.status} · working:${this.snapshot.workingMemberNames.length} waiting:${this.snapshot.waitingMemberNames.length} · board #${this.snapshot.boardHead}`;
      body.push(
        fitLine(
          `${this.theme.fg("accent", this.theme.bold(title))}  ${this.theme.fg("dim", summary)}`,
          innerWidth,
        ),
      );
      body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    }

    // Mission Models Card
    const oCell = formatRoleSummaryCell(
      this.state.settings.orchestratorModel,
      this.state.settings.orchestratorThinkingLevel,
      this.state.hostModel,
      this.state.origins?.orchestrator,
      compact,
    );
    const wCell = formatRoleSummaryCell(
      this.state.settings.workerModel,
      this.state.settings.workerThinkingLevel,
      this.state.hostModel,
      this.state.origins?.worker,
      compact,
    );
    const vCell = formatRoleSummaryCell(
      this.state.settings.validatorModel,
      this.state.settings.validatorThinkingLevel,
      this.state.hostModel,
      this.state.origins?.validator,
      compact,
    );

    body.push(
      fitLine(
        `${this.theme.fg("muted", "Orchestrator  ")}${this.theme.fg("accent", oCell)}`,
        innerWidth,
      ),
    );
    body.push(
      fitLine(
        `${this.theme.fg("muted", "Worker        ")}${this.theme.fg("accent", wCell)}`,
        innerWidth,
      ),
    );
    body.push(
      fitLine(
        `${this.theme.fg("muted", "Validator     ")}${this.theme.fg("accent", vCell)}`,
        innerWidth,
      ),
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
    const policyLine = `Validator: ${this.state.settings.validatorEnabled ? "ON" : "OFF"} · Max Concurrency: ${this.state.settings.maxConcurrency}`;
    body.push(fitLine(this.theme.fg("dim", policyLine), innerWidth));

    if (!this.hasActiveOrPausedRun()) {
      body.push(renderHorizontalRule(innerWidth, "Goal (optional)", this.theme));
      const inputBudget = Math.max(8, innerWidth - 6);
      const renderedInput = this.goalInput.render(inputBudget)[0] ?? "";
      body.push(
        fitLine(
          `${this.theme.fg("muted", "Goal: ")}${renderedInput || this.theme.fg("dim", "Type what you want to build…")}`,
          innerWidth,
        ),
      );
    }

    body.push(renderHorizontalRule(innerWidth, "Actions", this.theme));

    const menuViewport = Math.max(2, maxInner - body.length - 2);
    let menuStart = Math.max(0, this.selectedIndex - Math.floor(menuViewport / 2));
    if (menuStart + menuViewport > this.menuItems.length) {
      menuStart = Math.max(0, this.menuItems.length - menuViewport);
    }
    const menuEnd = Math.min(this.menuItems.length, menuStart + menuViewport);

    for (let i = menuStart; i < menuEnd; i++) {
      const item = this.menuItems[i]!;
      const isSel = i === this.selectedIndex;
      const ptr = isSel ? this.theme.fg("accent", "› ") : "  ";
      const num = this.theme.fg("muted", `${i + 1}. `);
      const label = isSel
        ? this.theme.fg("accent", this.theme.bold(item.label))
        : item.label;
      body.push(fitLine(`${ptr}${num}${label}`, innerWidth));
    }

    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    const hint = this.hasActiveOrPausedRun()
      ? "↑/↓/j/k Navigate · Enter Select · Ctrl+M Models · Esc Close"
      : "Type Goal · ↑/↓ Choose Mode · Enter Launch · Ctrl+M Models · Esc Close";
    body.push(fitLine(this.theme.fg("dim", hint), innerWidth));

    return renderBox(body.slice(0, maxInner), safeWidth, {
      title: this.theme.fg("accent", this.theme.bold("🐝 Pi Swarm Mission Hub")),
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
  return ctx.ui.custom<SwarmHubAction>((tui, theme, _kb, done) => {
    return new SwarmHubView(tui, theme, {
      ...options,
      onComplete: (action) => done(action),
    });
  });
}

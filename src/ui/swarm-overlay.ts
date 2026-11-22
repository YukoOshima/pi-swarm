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
import { DEFAULT_CHANNEL, ORCHESTRATOR_NAME } from "../constants.js";
import type {
  BoardMessage,
  DiffSummary,
  ISwarmEngine,
  IWorktreeManager,
  SwarmMemberRecord,
  SwarmRunState,
  SwarmSnapshot,
} from "../types.js";
import {
  buildSwarmGraphLines,
  fitLine,
  formatBoardKindBadge,
  formatCost,
  formatMemberRoleBadge,
  formatMemberStateBadge,
  formatRoleModelsLine,
  formatRunStatusBadge,
  formatTokens,
  formatWorkspaceBadge,
  joinColumns,
  memberStateIcon,
  renderBox,
  renderHorizontalRule,
  sanitizeDiffLine,
  sanitizePlainText,
  shortenModelName,
  visibleWidth,
  wrapLines,
} from "./text-utils.js";

export type SwarmOverlayTab = "board" | "members" | "graph" | "search";

export interface SwarmOverlayOptions {
  onModalEnter?: () => void;
  onModalExit?: () => void;
  /** Initial active tab (default: "board"). */
  initialTab?: SwarmOverlayTab;
  /** Optional member name to pre-select on the Members tab. */
  initialMemberName?: string;
  /** Optional channel filter to pre-select on the Board tab ("*" for all). */
  initialChannel?: string;
  /** Optional host session model fallback for 3-role display. */
  hostModel?: string;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

const TAB_ORDER: readonly SwarmOverlayTab[] = [
  "board",
  "members",
  "graph",
  "search",
];

const VALID_THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type MemberDetailMode = "info" | "diff";

type InlineInputMode =
  | { kind: "board_post"; channel: string }
  | { kind: "wake"; member: SwarmMemberRecord }
  | { kind: "model"; member: SwarmMemberRecord };

interface FeedbackMessage {
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

function decodePrintableChar(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) return data;
  }
  return undefined;
}

function computeInnerWidth(outerWidth: number): number {
  if (outerWidth < 12) return Math.max(1, outerWidth);
  const padX = outerWidth < 24 ? 0 : 1;
  return Math.max(1, outerWidth - 2 - padX * 2);
}

function formatClock(timestamp: string): string {
  const tIndex = timestamp.indexOf("T");
  if (tIndex >= 0 && timestamp.length >= tIndex + 9) {
    return timestamp.slice(tIndex + 1, tIndex + 9);
  }
  return timestamp.slice(0, 8);
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return sanitizePlainText(err.message);
  return sanitizePlainText(String(err));
}

function formatTargetsSuffix(
  msg: Pick<BoardMessage, "mentions" | "channelMentions">,
): string {
  const targets: string[] = [];
  for (const m of msg.mentions) {
    const clean = sanitizePlainText(m);
    if (clean) targets.push(clean.startsWith("@") ? clean : `@${clean}`);
  }
  for (const ch of msg.channelMentions ?? []) {
    const clean = sanitizePlainText(ch).replace(/^@#?/, "");
    if (clean) targets.push(`@#${clean}`);
  }
  if (targets.length === 0) return "";
  return ` -> ${targets.join(", ")}`;
}

function getOrderedMembers(run: SwarmRunState): SwarmMemberRecord[] {
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

function parseModelAndThinking(raw: string): {
  model: string;
  thinkingLevel?: ThinkingLevel;
} {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!.toLowerCase();
    if (VALID_THINKING_LEVELS.has(last as ThinkingLevel)) {
      return {
        model: parts.slice(0, -1).join(" "),
        thinkingLevel: last as ThinkingLevel,
      };
    }
  }
  return { model: raw.trim() };
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

class SwarmOverlayComponent implements Component, Focusable {
  private _focused = false;
  private snapshot: SwarmSnapshot;
  private activeTab: SwarmOverlayTab;

  // Board tab state
  private boardMessages: BoardMessage[] = [];
  private channelFilter: string;
  private boardSelectedIndex = 0;

  // Members tab state
  private memberSelectedIndex = 0;
  private memberDetailMode: MemberDetailMode = "info";
  private diffState: {
    memberName: string;
    branch: string;
    loading: boolean;
    summary?: DiffSummary;
    error?: string;
  } | null = null;
  private diffRequestId = 0;

  // Graph tab state
  private graphScrollOffset = 0;

  // Search tab state
  private searchQuery = "";
  private searchFocused = false;
  private searchSelectedIndex = 0;
  private readonly searchInput: Input;

  // Inline IME action input (Board [p] post, Members [w] wake, Members [m] model)
  private inlineMode: InlineInputMode | undefined;
  private inlineInput: Input;

  private prevHardwareCursor: boolean | null = null;
  private feedback: FeedbackMessage | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private readonly hostModel?: string;

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
    this.activeTab = options?.initialTab ?? "board";
    this.channelFilter = options?.initialChannel ?? "*";
    this.snapshot = engine.getSnapshot();
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
      if (ev.type === "board_posted" || ev.snapshot.boardHead > maxLoadedSeq) {
        void this.refreshFullBoard();
      }

      this.tui.requestRender();
    });

    void this.refreshFullBoard();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
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
    if (wantsCursor) {
      if (this.prevHardwareCursor === null) {
        this.prevHardwareCursor = this.tui.getShowHardwareCursor();
      }
      this.tui.setShowHardwareCursor(true);
    } else if (this.prevHardwareCursor !== null) {
      this.tui.setShowHardwareCursor(this.prevHardwareCursor);
      this.prevHardwareCursor = null;
    }
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
    this.activeTab = tab;
    this.feedback = undefined;
    if (tab === "search") {
      this.setSearchFocused(true);
    } else {
      this.setSearchFocused(false);
    }
    this.clampSelections();
  }

  private cycleTab(delta: number): void {
    const curIdx = TAB_ORDER.indexOf(this.activeTab);
    const nextIdx = (curIdx + delta + TAB_ORDER.length) % TAB_ORDER.length;
    this.switchTab(TAB_ORDER[nextIdx]!);
  }

  private mergeBoardMessages(incoming: readonly BoardMessage[]): void {
    if (incoming.length === 0) return;
    const bySeq = new Map<number, BoardMessage>();
    for (const msg of this.boardMessages) {
      bySeq.set(msg.seq, msg);
    }
    for (const msg of incoming) {
      bySeq.set(msg.seq, msg);
    }
    this.boardMessages = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  }

  private async refreshFullBoard(): Promise<void> {
    if (this.closed || !this.snapshot.run) return;
    try {
      const res = await this.engine.readBoard({ channel: "*", limit: 500 });
      if (this.closed) return;
      const prevLen = this.getFilteredBoardMessages().length;
      const wasAtLatest = prevLen === 0 || this.boardSelectedIndex >= prevLen - 1;
      this.mergeBoardMessages(res.messages);
      const nextLen = this.getFilteredBoardMessages().length;
      if (wasAtLatest && nextLen > 0) {
        this.boardSelectedIndex = nextLen - 1;
      }
      this.clampSelections();
      this.tui.requestRender();
    } catch {
      // Fall back silently to snapshot.recentBoard
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
    this.inlineMode = undefined;
    this.searchFocused = false;
    this.inlineInput.focused = false;
    this.searchInput.focused = false;
    if (this.prevHardwareCursor !== null) {
      this.tui.setShowHardwareCursor(this.prevHardwareCursor);
      this.prevHardwareCursor = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  invalidate(): void {
    this.inlineInput.invalidate();
    this.searchInput.invalidate();
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
    try {
      const posted = await this.engine.postMessage({
        from: ORCHESTRATOR_NAME,
        fromRole: "orchestrator",
        text,
        channel,
        kind: "chat",
      });
      if (this.closed) return;
      this.snapshot = this.engine.getSnapshot();
      this.mergeBoardMessages([posted]);
      const filtered = this.getFilteredBoardMessages();
      const idx = filtered.findIndex((m) => m.seq === posted.seq);
      if (idx >= 0) this.boardSelectedIndex = idx;
      this.setFeedback("success", `Posted #${posted.seq} to #${posted.channel}.`);
    } catch (err) {
      this.setFeedback("error", `Board post failed: ${formatErrorMessage(err)}`);
    }
  }

  private async runWakeMember(
    member: SwarmMemberRecord,
    message: string,
  ): Promise<void> {
    try {
      if (typeof this.engine.steerMember === "function") {
        const res = await this.engine.steerMember(member.name, message, "steer", {
          callerName: ORCHESTRATOR_NAME,
          callerRole: "human",
        });
        if (this.closed) return;
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
      if (this.closed) return;
      this.snapshot = this.engine.getSnapshot();
      this.mergeBoardMessages([posted]);
      this.setFeedback(
        "success",
        `Sent #${posted.seq} to @${member.name} on #${posted.channel}.`,
      );
    } catch (err) {
      this.setFeedback(
        "error",
        `Failed to message @${member.name}: ${formatErrorMessage(err)}`,
      );
    }
  }

  private async runSwitchModel(
    member: SwarmMemberRecord,
    rawInput: string,
  ): Promise<void> {
    const { model, thinkingLevel } = parseModelAndThinking(rawInput);
    try {
      const result = await this.engine.switchModel({
        targetName: member.name,
        model,
        thinkingLevel,
        reason: "Hot-switched by user via Swarm overlay",
        callerName: ORCHESTRATOR_NAME,
        callerRole: "human",
        hostContext: this.ctx,
      });
      if (this.closed) return;
      this.snapshot = this.engine.getSnapshot();
      const suffix = result.thinkingLevel ? ` (${result.thinkingLevel})` : "";
      this.setFeedback(
        "success",
        `Switched ${member.name} to ${result.model}${suffix}.`,
      );
    } catch (err) {
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
    try {
      await this.engine.stopMember(member.name, {
        humanStopped: true,
        reason: "Stopped by user via Swarm overlay",
        callerName: ORCHESTRATOR_NAME,
        callerRole: "human",
      });
      if (this.closed) return;
      this.snapshot = this.engine.getSnapshot();
      this.setFeedback("warning", `Stopped ${member.name} (human-stopped).`);
    } catch (err) {
      this.setFeedback(
        "error",
        `Stop failed for ${member.name}: ${formatErrorMessage(err)}`,
      );
    }
  }

  private async runKillMember(member: SwarmMemberRecord): Promise<void> {
    if (member.state === "killed") {
      this.setFeedback("warning", `${member.name} is already killed.`);
      return;
    }
    try {
      await this.engine.killMember(member.name, {
        reason: "Killed by user",
        callerName: ORCHESTRATOR_NAME,
        callerRole: "human",
      });
      if (this.closed) return;
      this.snapshot = this.engine.getSnapshot();
      this.setFeedback("warning", `Killed ${member.name} permanently.`);
    } catch (err) {
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
    try {
      const merged = await this.engine.mergeMember(member.name, {
        callerName: ORCHESTRATOR_NAME,
        callerRole: "human",
      });
      if (this.closed) return;
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
    if (this.closed) return;

    // 1. Inline IME action input (Board [p] post, Members [w] wake / [m] model)
    if (this.inlineMode) {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.close();
        return;
      }
      this.inlineInput.handleInput(data);
      this.tui.requestRender();
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
      if (matchesKey(data, Key.tab)) {
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
      this.searchInput.handleInput(data);
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
    const ch = decodePrintableChar(data);

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      ch === "q" ||
      ch === "Q"
    ) {
      this.close();
      return;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      this.cycleTab(-1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
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

    if (ch === "p" || ch === "P") {
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

    if (matchesKey(data, Key.up)) {
      if (members.length > 0) {
        this.memberSelectedIndex =
          (this.memberSelectedIndex - 1 + members.length) % members.length;
        this.memberDetailMode = "info";
        this.feedback = undefined;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (members.length > 0) {
        this.memberSelectedIndex =
          (this.memberSelectedIndex + 1) % members.length;
        this.memberDetailMode = "info";
        this.feedback = undefined;
        this.tui.requestRender();
      }
      return;
    }

    if (!selected) return;

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

    if (ch === "m" || ch === "M") {
      if (selected.state !== "waiting" && selected.state !== "stopped") {
        this.setFeedback(
          "warning",
          `Cannot hot-switch model while ${selected.name} is ${selected.state} (must be waiting or stopped).`,
        );
        return;
      }
      this.enterInlineMode(
        { kind: "model", member: selected },
        "› ",
        `New model for ${selected.name} (e.g. openai/gpt-5.4 high)…`,
      );
      this.tui.requestRender();
      return;
    }

    if (ch === "x" || ch === "X") {
      void this.runStopMember(selected);
      return;
    }

    if (ch === "k" || ch === "K") {
      void this.runKillMember(selected);
      return;
    }

    if (ch === "g" || ch === "G") {
      void this.runMergeMember(selected);
      return;
    }

    if (ch === "d" || ch === "D") {
      this.toggleMemberDiff(selected);
    }
  }

  private handleGraphTabInput(data: string, ch: string | undefined): void {
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
    if (matchesKey(data, Key.pageUp)) {
      this.graphScrollOffset = Math.max(0, this.graphScrollOffset - 6);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.graphScrollOffset += 6;
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
    }
  }

  // ==========================================================================
  // Tab Renderers
  // ==========================================================================

  private renderTabBar(run: SwarmRunState, innerWidth: number): string {
    const boardCount = Math.max(this.snapshot.boardHead, this.boardMessages.length);
    const members = getOrderedMembers(run);
    const workingCount = Math.max(
      this.snapshot.workingMemberNames.length,
      members.filter((m) => m.state === "working").length,
    );

    const compact = innerWidth < 56;
    const tabs: { id: SwarmOverlayTab; label: string }[] = compact
      ? [
          { id: "board", label: `[1]Board(#${boardCount})` },
          { id: "members", label: `[2]Mem(${workingCount}/${members.length})` },
          { id: "graph", label: "[3]Graph" },
          { id: "search", label: "[4]Find" },
        ]
      : [
          { id: "board", label: `[1] Board (#${boardCount})` },
          {
            id: "members",
            label: `[2] Members (${workingCount}/${members.length})`,
          },
          { id: "graph", label: "[3] Graph" },
          { id: "search", label: "[4] Search" },
        ];

    const sep = this.theme.fg("borderMuted", compact ? "|" : " | ");
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

  private renderBoardTab(innerWidth: number, budget: number): string[] {
    const out: string[] = [];
    const messages = this.getFilteredBoardMessages();
    const filterLabel =
      this.channelFilter === "*"
        ? "Channel: * (all)"
        : `Channel: #${sanitizePlainText(this.channelFilter)}`;
    const headerRight = this.theme.fg("dim", "[c] filter · [p] post · [↑↓] select");
    out.push(
      innerWidth >= 56
        ? joinColumns(
            `${this.theme.fg("accent", filterLabel)} (${messages.length})`,
            headerRight,
            innerWidth,
          )
        : fitLine(`${this.theme.fg("accent", filterLabel)} (${messages.length})`, innerWidth),
    );

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
    const iconRaw = memberStateIcon(member.state);
    const icon =
      member.state === "working"
        ? this.theme.fg("accent", iconRaw)
        : member.state === "stopped"
          ? this.theme.fg("warning", iconRaw)
          : member.state === "killed"
            ? this.theme.fg("dim", iconRaw)
            : this.theme.fg("muted", iconRaw);
    const nameStr = isSelected
      ? this.theme.fg("accent", this.theme.bold(member.name))
      : member.state === "killed"
        ? this.theme.fg("dim", member.name)
        : this.theme.bold(member.name);
    const roleStr = formatMemberRoleBadge(member.role, this.theme);
    const stateStr = formatMemberStateBadge(member.state, this.theme);

    if (innerWidth < 54) {
      return fitLine(`${ptr}${icon} ${nameStr} (${roleStr}) ${stateStr}`, innerWidth);
    }

    const modelShort = member.model
      ? shortenModelName(member.model, 16)
      : "default";
    const modelStr = this.theme.fg("dim", `[${modelShort}]`);
    const wsStr = formatWorkspaceBadge(member.workspace, member.branch, this.theme);
    const parentStr =
      member.parentName && member.parentName !== ORCHESTRATOR_NAME
        ? ` ${this.theme.fg("dim", `← ${member.parentName}`)}`
        : "";
    const turnsStr = this.theme.fg("muted", `t:${member.turns}`);

    const left = `${ptr}${icon} ${nameStr} (${roleStr}) ${stateStr} ${modelStr} ${wsStr}${parentStr}`;
    return fitLine(joinColumns(left, turnsStr, innerWidth), innerWidth);
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
    const meta1 = `${this.theme.fg("muted", "Role:")} ${formatMemberRoleBadge(member.role, this.theme)} · ${this.theme.fg("muted", "State:")} ${formatMemberStateBadge(member.state, this.theme)} · ${this.theme.fg("muted", "Parent:")} ${sanitizePlainText(member.parentName)} · ${this.theme.fg("muted", "Model:")} ${this.theme.fg("accent", modelLabel)}`;
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
          this.theme.fg("muted", `Loading git diff for ${member.branch ?? member.name}…`),
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

    const out: string[] = [];
    out.push(
      fitLine(
        `${this.theme.fg("accent", sanitizePlainText(summary.branch))} vs ${sanitizePlainText(summary.baseBranch)} · ${summary.commitsAhead} commit(s) ahead · ${summary.changedFiles.length} file(s)`,
        innerWidth,
      ),
    );
    if (summary.stat && out.length < budget) {
      for (const line of summary.stat.split(/\r?\n/)) {
        const cleanLine = sanitizeDiffLine(line);
        if (!cleanLine.trim()) continue;
        if (out.length >= Math.min(budget, 4)) break;
        out.push(fitLine(this.theme.fg("muted", cleanLine), innerWidth));
      }
    }
    const rawDiffLines = summary.diff ? summary.diff.split(/\r?\n/) : [];
    for (const raw of rawDiffLines) {
      if (out.length >= budget) break;
      const cleanRaw = sanitizeDiffLine(raw);
      const styled = cleanRaw.startsWith("+") && !cleanRaw.startsWith("+++")
        ? this.theme.fg("toolDiffAdded", cleanRaw)
        : cleanRaw.startsWith("-") && !cleanRaw.startsWith("---")
          ? this.theme.fg("toolDiffRemoved", cleanRaw)
          : cleanRaw.startsWith("@@")
            ? this.theme.fg("accent", cleanRaw)
            : this.theme.fg("toolDiffContext", cleanRaw);
      out.push(fitLine(styled, innerWidth));
    }

    return out.slice(0, budget);
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
        this.memberDetailMode === "diff" ? "Git Diff [d: info]" : "Details & Logs";
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
    const allLines = buildSwarmGraphLines(run, this.boardMessages, innerWidth, {
      theme: this.theme,
    });
    const maxOffset = Math.max(0, allLines.length - budget);
    if (this.graphScrollOffset > maxOffset) {
      this.graphScrollOffset = maxOffset;
    }
    const visible = allLines.slice(
      this.graphScrollOffset,
      this.graphScrollOffset + budget,
    );
    return visible.map((l) => fitLine(l, innerWidth));
  }

  private renderSearchTab(innerWidth: number, budget: number): string[] {
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
      innerWidth >= 60
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
      return mode.member.state === "working"
        ? `Steer @${mode.member.name} mid-turn:`
        : `Wake / message @${mode.member.name}:`;
    }
    const cur = mode.member.model ?? this.hostModel ?? "host default";
    return `Hot-switch model for ${mode.member.name} (current: ${cur}):`;
  }

  private renderActionBar(innerWidth: number): string {
    let text: string;
    if (this.activeTab === "board") {
      text = "[p] post · [c] channel · [↑↓] scroll · [1-4/Tab] tabs · [Esc/q] close";
    } else if (this.activeTab === "members") {
      text =
        "[w] steer/wake · [m] model · [x] stop · [k] kill · [g] merge · [d] diff · [Esc/q] close";
    } else if (this.activeTab === "graph") {
      text = "[↑↓] scroll · [1-4/Tab] tabs · [Esc/q] close";
    } else {
      text = this.searchFocused
        ? "Type to search · [↑↓] select · [Tab] switch tab · [Esc] finish typing"
        : "[/] search · [↑↓] select · [1-4/Tab] tabs · [Esc/q] close";
    }
    return fitLine(this.theme.fg("dim", text), innerWidth);
  }

  // ==========================================================================
  // Main Render
  // ==========================================================================

  render(width: number): string[] {
    const targetWidth = Math.max(1, Math.floor(width));
    const innerWidth = computeInnerWidth(targetWidth);
    const termRows = this.tui.terminal?.rows ?? 30;
    const maxTotalLines = Math.max(14, Math.min(34, Math.floor(termRows * 0.85)));
    const maxInnerLines = Math.max(10, maxTotalLines - 2);

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

    // Compact run & 3-role models bar
    const titleStr = sanitizePlainText(run.title || run.objective) || run.id;
    const statusBadge = formatRunStatusBadge(run.status, this.theme);
    const modelsLine = formatRoleModelsLine(
      this.snapshot.roleModels ?? run.roleModels,
      this.hostModel ?? "default",
      {
        maxWidth: Math.max(12, Math.floor(innerWidth * 0.55)),
        theme: this.theme,
        includeThinking: false,
      },
    );
    const runLeft = `[${statusBadge}] ${titleStr} · base:${run.baseBranch}`;
    body.push(
      innerWidth >= 68
        ? joinColumns(runLeft, modelsLine, innerWidth)
        : fitLine(runLeft, innerWidth),
    );

    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));

    // Bottom reservation so feedback + rule + inline input / action bar are NEVER clipped
    const footerLinesCount = this.inlineMode ? 2 : 1;
    const bottomReserved =
      (this.feedback ? 1 : 0) + 1 /* rule */ + footerLinesCount;
    const contentBudget = Math.max(3, maxInnerLines - body.length - bottomReserved);

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
      this.theme.bold(`🐝 ${titleStr} · ${run.id}`),
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
      const label = `${memberStateIcon(m.state)} ${m.name} (${m.role} · ${m.state}${modelTag} · ${wsTag})`;
      labelToMember.set(label, m);
      options.push(label);
    }

    const closeOpt = "Close";
    options.push(closeOpt);

    const chosen = await ctx.ui.select(
      `🐝 ${sanitizePlainText(run.title || run.id)} (${formatRunStatusBadge(run.status)} · ${snapshot.workingMemberNames.length}w/${snapshot.waitingMemberNames.length}wait · Board:#${snapshot.boardHead})`,
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
          `${member.name} (${member.branch}): ${diff.commitsAhead} commit(s) ahead, ${diff.changedFiles.length} file(s) changed`,
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

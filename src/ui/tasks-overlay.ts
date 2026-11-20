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
import { FINAL_AUDIT_MISSION_ID } from "../constants.js";
import type {
  BoardMessage,
  DiffSummary,
  FinalAuditStatus,
  FinalAuditVerdict,
  ISwarmOrchestrator,
  IWorktreeManager,
  MissionRecord,
  RosterEntry,
  SwarmRunState,
  SwarmSnapshot,
} from "../types.js";
import {
  computeActiveFinalAuditRound,
  fitLine,
  formatBoardKindBadge,
  formatCost,
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
  missionStatusIcon,
  renderBox,
  renderHorizontalRule,
  sanitizePlainText,
  shortenModelName,
  visibleWidth,
} from "./text-utils.js";

export interface TasksOverlayOptions {
  onModalEnter?: () => void;
  onModalExit?: () => void;
  /** Optional mission ID (or FINAL_AUDIT_MISSION_ID) to highlight initially. */
  initialMissionId?: string;
  /** Initial view mode: "fleet" (default) or "board". */
  initialView?: "fleet" | "board";
  /** Clock override for deterministic tests. */
  now?: () => number;
}

type OverlayViewMode = "fleet" | "board";
type DetailViewMode = "logs" | "diff";

type OverlayListItem =
  | { kind: "mission"; mission: MissionRecord }
  | { kind: "final_validator" };

type InlineInputMode =
  | { kind: "steer"; agent: RosterEntry }
  | { kind: "wake"; agent: RosterEntry }
  | { kind: "model"; agent: RosterEntry }
  | { kind: "board_post" };

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

function getMissionRosterEntries(
  run: SwarmRunState,
  missionId: string,
): RosterEntry[] {
  return Object.values(run.roster)
    .filter((entry) => entry.missionId === missionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function getFinalValidatorRosterEntries(run: SwarmRunState): RosterEntry[] {
  return Object.values(run.roster)
    .filter(
      (entry) =>
        entry.missionId === FINAL_AUDIT_MISSION_ID ||
        entry.role === "final-validator",
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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

function hasFinalValidatorItem(snapshot: SwarmSnapshot): boolean {
  const run = snapshot.run;
  if (!run) return false;
  if (getEffectiveFinalAuditStatus(snapshot, run) !== "idle") return true;
  if (snapshot.latestFinalAudit || run.latestFinalAudit) return true;
  if (snapshot.finalAuditRunningAgentId) return true;
  if (run.status === "verifying") return true;
  return getFinalValidatorRosterEntries(run).length > 0;
}

function buildWorkingSet(snapshot: SwarmSnapshot): Set<string> {
  const set = new Set<string>(snapshot.workingAgentIds);
  if (snapshot.finalAuditRunningAgentId) {
    set.add(snapshot.finalAuditRunningAgentId);
  }
  return set;
}

function isAgentWorking(snapshot: SwarmSnapshot, entry: RosterEntry): boolean {
  if (entry.status === "working") return true;
  if (
    entry.status === "waiting" ||
    entry.status === "killed" ||
    entry.status === "stopped" ||
    entry.status === "failed" ||
    entry.status === "died"
  ) {
    return false;
  }
  return buildWorkingSet(snapshot).has(entry.agentId);
}

function isAgentWaiting(snapshot: SwarmSnapshot, entry: RosterEntry): boolean {
  if (entry.status === "waiting") return true;
  if (entry.status === "working") return false;
  return snapshot.waitingAgentIds.includes(entry.agentId);
}

function findWorkingAgentForMission(
  snapshot: SwarmSnapshot,
  missionId: string,
): RosterEntry | undefined {
  const run = snapshot.run;
  if (!run) return undefined;
  return getMissionRosterEntries(run, missionId).find((e) =>
    isAgentWorking(snapshot, e),
  );
}

function findWaitingAgentForMission(
  snapshot: SwarmSnapshot,
  missionId: string,
): RosterEntry | undefined {
  const run = snapshot.run;
  if (!run) return undefined;
  return getMissionRosterEntries(run, missionId).find((e) =>
    isAgentWaiting(snapshot, e),
  );
}

function findLiveAgentForMission(
  snapshot: SwarmSnapshot,
  missionId: string,
): RosterEntry | undefined {
  return (
    findWorkingAgentForMission(snapshot, missionId) ??
    findWaitingAgentForMission(snapshot, missionId)
  );
}

function findLatestAgentForMission(
  snapshot: SwarmSnapshot,
  missionId: string,
): RosterEntry | undefined {
  const live = findLiveAgentForMission(snapshot, missionId);
  if (live) return live;
  const run = snapshot.run;
  if (!run) return undefined;
  return getMissionRosterEntries(run, missionId)[0];
}

function findWorkingFinalValidatorAgent(
  snapshot: SwarmSnapshot,
): RosterEntry | undefined {
  const run = snapshot.run;
  if (!run) return undefined;
  if (snapshot.finalAuditRunningAgentId) {
    const direct = run.roster[snapshot.finalAuditRunningAgentId];
    if (direct && isAgentWorking(snapshot, direct)) {
      return direct;
    }
  }
  return getFinalValidatorRosterEntries(run).find((e) =>
    isAgentWorking(snapshot, e),
  );
}

function findWaitingFinalValidatorAgent(
  snapshot: SwarmSnapshot,
): RosterEntry | undefined {
  const run = snapshot.run;
  if (!run) return undefined;
  return getFinalValidatorRosterEntries(run).find((e) =>
    isAgentWaiting(snapshot, e),
  );
}

function findLiveFinalValidatorAgent(
  snapshot: SwarmSnapshot,
): RosterEntry | undefined {
  return (
    findWorkingFinalValidatorAgent(snapshot) ??
    findWaitingFinalValidatorAgent(snapshot)
  );
}

function findLatestFinalValidatorAgent(
  snapshot: SwarmSnapshot,
): RosterEntry | undefined {
  const live = findLiveFinalValidatorAgent(snapshot);
  if (live) return live;
  const run = snapshot.run;
  if (!run) return undefined;
  return getFinalValidatorRosterEntries(run)[0];
}

function sumMissionUsage(
  run: SwarmRunState,
  missionId: string,
): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const entry of Object.values(run.roster)) {
    if (entry.missionId === missionId) {
      tokens += entry.tokens;
      cost += entry.cost;
    }
  }
  return { tokens, cost };
}

function sumFinalValidatorUsage(run: SwarmRunState): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const entry of getFinalValidatorRosterEntries(run)) {
    tokens += entry.tokens;
    cost += entry.cost;
  }
  return { tokens, cost };
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return sanitizePlainText(err.message);
  return sanitizePlainText(String(err));
}

function formatClock(timestamp: string): string {
  const tIndex = timestamp.indexOf("T");
  if (tIndex >= 0 && timestamp.length >= tIndex + 9) {
    return timestamp.slice(tIndex + 1, tIndex + 9);
  }
  return timestamp.slice(0, 8);
}

function formatMentions(mentions: readonly string[]): string {
  if (mentions.length === 0) return "";
  return ` -> ${mentions.map((m) => (m.startsWith("@") ? m : `@${m}`)).join(", ")}`;
}

function computeInnerWidth(outerWidth: number): number {
  if (outerWidth < 12) return Math.max(1, outerWidth);
  const padX = outerWidth < 24 ? 0 : 1;
  return Math.max(1, outerWidth - 2 - padX * 2);
}

// ============================================================================
// TUI Interactive Swarm Tasks & Board Overlay Component
// ============================================================================

class TasksOverlayComponent implements Component, Focusable {
  private _focused = false;
  private snapshot: SwarmSnapshot;
  private viewMode: OverlayViewMode;
  private selectedIndex = 0;
  private boardScrollFromBottom = 0;
  private detailMode: DetailViewMode = "logs";
  private diffState: {
    missionId: string;
    loading: boolean;
    summary?: DiffSummary;
    error?: string;
  } | null = null;
  private diffRequestId = 0;
  private feedback: FeedbackMessage | undefined;

  private inlineMode: InlineInputMode | undefined;
  private inlineInput: Input;
  private prevHardwareCursor: boolean | null = null;

  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private readonly now: () => number;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly ctx: ExtensionContext,
    private readonly orchestrator: ISwarmOrchestrator,
    private readonly worktree: IWorktreeManager | null | undefined,
    private readonly options: TasksOverlayOptions | undefined,
    private readonly done: () => void,
  ) {
    this.now = options?.now ?? (() => Date.now());
    this.viewMode = options?.initialView ?? "fleet";
    this.snapshot = orchestrator.getSnapshot();

    if (options?.initialMissionId && this.snapshot.run) {
      const items = this.getItems();
      const idx = items.findIndex((item) =>
        item.kind === "final_validator"
          ? options.initialMissionId === FINAL_AUDIT_MISSION_ID
          : item.mission.id === options.initialMissionId,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }

    this.inlineInput = this.buildInlineInput("› ", "Type message…");

    this.unsubscribe = orchestrator.subscribe((ev) => {
      if (this.closed) return;
      this.snapshot = ev.snapshot;
      this.clampSelectedIndex();
      this.tui.requestRender();
    });
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

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.inlineInput.focused = value && this.inlineMode !== undefined;
  }

  private enterInlineMode(mode: InlineInputMode): void {
    if (this.prevHardwareCursor === null) {
      this.prevHardwareCursor = this.tui.getShowHardwareCursor();
    }
    this.inlineMode = mode;

    if (mode.kind === "steer") {
      this.inlineInput = this.buildInlineInput(
        "steer › ",
        "Message for working agent (Enter to send, Esc to cancel)…",
      );
    } else if (mode.kind === "wake") {
      this.inlineInput = this.buildInlineInput(
        "board › ",
        `Message to wake @${mode.agent.name || mode.agent.agentId} (Enter to post, Esc to cancel)…`,
      );
    } else if (mode.kind === "model") {
      this.inlineInput = this.buildInlineInput(
        "model › ",
        "provider/model-id (Enter to hot-switch, Esc to cancel)…",
      );
    } else {
      this.inlineInput = this.buildInlineInput(
        "board › ",
        "Post to shared board (use @name to wake, Enter to post, Esc to cancel)…",
      );
    }

    this.inlineInput.setValue("");
    this.inlineInput.focused = this._focused;
    this.tui.setShowHardwareCursor(true);
  }

  private exitInlineMode(): void {
    this.inlineMode = undefined;
    this.inlineInput.focused = false;
    if (this.prevHardwareCursor !== null) {
      this.tui.setShowHardwareCursor(this.prevHardwareCursor);
      this.prevHardwareCursor = null;
    }
  }

  private handleInlineSubmit(rawValue: string): void {
    const mode = this.inlineMode;
    const trimmed = rawValue.trim();
    if (!mode) {
      this.exitInlineMode();
      this.tui.requestRender();
      return;
    }

    if (!trimmed) {
      this.feedback = {
        kind: "warning",
        text:
          mode.kind === "model"
            ? "Model ID cannot be empty (Esc to cancel)."
            : "Message cannot be empty (Esc to cancel).",
      };
      this.tui.requestRender();
      return;
    }

    this.exitInlineMode();

    if (mode.kind === "steer") {
      const target = mode.agent;
      const targetLabel = target.name || target.agentId;
      this.feedback = {
        kind: "info",
        text: `Sending steering message to ${targetLabel}…`,
      };
      this.tui.requestRender();

      void this.orchestrator
        .steerAgent(target.agentId, trimmed, "steer")
        .then(() => {
          if (this.closed) return;
          this.snapshot = this.orchestrator.getSnapshot();
          this.feedback = {
            kind: "success",
            text: `Steered ${targetLabel} (${target.missionId})`,
          };
          this.tui.requestRender();
        })
        .catch((err) => {
          if (this.closed) return;
          this.feedback = {
            kind: "error",
            text: `Steer failed: ${formatErrorMessage(err)}`,
          };
          this.tui.requestRender();
        });
      return;
    }

    if (mode.kind === "wake") {
      const target = mode.agent;
      const targetName = target.name || target.agentId;
      const mentionPrefix = `@${targetName}`;
      const text = trimmed.includes(mentionPrefix)
        ? trimmed
        : `${mentionPrefix} ${trimmed}`;
      this.feedback = {
        kind: "info",
        text: `Posting to board to wake ${mentionPrefix}…`,
      };
      this.tui.requestRender();

      void this.orchestrator
        .postToBoard({
          from: "human",
          fromRole: "human",
          text,
          kind: "chat",
          missionId:
            target.missionId !== FINAL_AUDIT_MISSION_ID
              ? target.missionId
              : undefined,
        })
        .then((msg) => {
          if (this.closed) return;
          this.snapshot = this.orchestrator.getSnapshot();
          this.feedback = {
            kind: "success",
            text: `Posted #${msg.seq} to wake ${mentionPrefix}.`,
          };
          this.tui.requestRender();
        })
        .catch((err) => {
          if (this.closed) return;
          this.feedback = {
            kind: "error",
            text: `Board post failed: ${formatErrorMessage(err)}`,
          };
          this.tui.requestRender();
        });
      return;
    }

    if (mode.kind === "model") {
      const target = mode.agent;
      const agentName = target.name || target.agentId;
      this.feedback = {
        kind: "info",
        text: `Switching ${agentName} model to ${trimmed}…`,
      };
      this.tui.requestRender();

      void this.orchestrator
        .switchAgentModel(agentName, trimmed)
        .then((updated) => {
          if (this.closed) return;
          this.snapshot = this.orchestrator.getSnapshot();
          this.feedback = {
            kind: "success",
            text: `Switched ${agentName} to ${updated?.model ?? trimmed}.`,
          };
          this.tui.requestRender();
        })
        .catch((err) => {
          if (this.closed) return;
          this.feedback = {
            kind: "error",
            text: `Model switch failed: ${formatErrorMessage(err)}`,
          };
          this.tui.requestRender();
        });
      return;
    }

    // board_post
    this.feedback = {
      kind: "info",
      text: "Posting message to shared board…",
    };
    this.tui.requestRender();

    void this.orchestrator
      .postToBoard({
        from: "human",
        fromRole: "human",
        text: trimmed,
        kind: "chat",
      })
      .then((msg) => {
        if (this.closed) return;
        this.snapshot = this.orchestrator.getSnapshot();
        this.boardScrollFromBottom = 0;
        this.feedback = {
          kind: "success",
          text: `Posted #${msg.seq} to board.`,
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed) return;
        this.feedback = {
          kind: "error",
          text: `Board post failed: ${formatErrorMessage(err)}`,
        };
        this.tui.requestRender();
      });
  }

  private getMissions(): MissionRecord[] {
    if (!this.snapshot.run) return [];
    return getOrderedMissions(this.snapshot.run);
  }

  private getItems(): OverlayListItem[] {
    const items: OverlayListItem[] = this.getMissions().map((mission) => ({
      kind: "mission",
      mission,
    }));
    if (hasFinalValidatorItem(this.snapshot)) {
      items.push({ kind: "final_validator" });
    }
    return items;
  }

  private clampSelectedIndex(): void {
    const items = this.getItems();
    if (items.length === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= items.length) {
      this.selectedIndex = items.length - 1;
    } else if (this.selectedIndex < 0) {
      this.selectedIndex = 0;
    }
  }

  private getSelectedItem(): OverlayListItem | undefined {
    const items = this.getItems();
    this.clampSelectedIndex();
    return items[this.selectedIndex];
  }

  private close(): void {
    if (this.closed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    this.closed = true;
    this.exitInlineMode();
    if (this.unsubscribe) {
      const unsub = this.unsubscribe;
      this.unsubscribe = undefined;
      unsub();
    }
  }

  invalidate(): void {
    this.inlineInput.invalidate();
  }

  // ==========================================================================
  // Orchestrator Actions
  // ==========================================================================

  private triggerSteerOrWake(agent: RosterEntry | undefined, label: string): void {
    if (!agent) {
      this.feedback = {
        kind: "warning",
        text: `No working or waiting agent for ${label} to steer or wake.`,
      };
      this.tui.requestRender();
      return;
    }
    if (isAgentWorking(this.snapshot, agent)) {
      this.enterInlineMode({ kind: "steer", agent });
    } else {
      this.enterInlineMode({ kind: "wake", agent });
    }
    this.tui.requestRender();
  }

  private triggerModelSwitch(
    waitingAgent: RosterEntry | undefined,
    workingAgent: RosterEntry | undefined,
    label: string,
  ): void {
    if (waitingAgent) {
      this.enterInlineMode({ kind: "model", agent: waitingAgent });
      this.tui.requestRender();
      return;
    }
    if (workingAgent) {
      this.feedback = {
        kind: "warning",
        text: `${workingAgent.name || workingAgent.agentId} is currently working; hot-switch requires waiting state.`,
      };
      this.tui.requestRender();
      return;
    }
    this.feedback = {
      kind: "warning",
      text: `No waiting agent for ${label} to switch model.`,
    };
    this.tui.requestRender();
  }

  private triggerStopAgent(
    agent: RosterEntry | undefined,
    label: string,
    isFinalValidator = false,
  ): void {
    if (!agent) {
      this.feedback = {
        kind: "warning",
        text: isFinalValidator
          ? "No active Final Validator agent to stop."
          : `No active agent to stop for ${label}.`,
      };
      this.tui.requestRender();
      return;
    }

    const agentLabel = agent.name || agent.agentId;
    this.feedback = {
      kind: "info",
      text: `Stopping ${agentLabel}…`,
    };
    this.tui.requestRender();

    void this.orchestrator
      .stopAgent(agent.agentId, {
        humanStopped: true,
        reason: isFinalValidator
          ? "Stopped Final Validator by user via /swarm tasks"
          : "Stopped by user via /swarm tasks",
      })
      .then(() => {
        if (this.closed) return;
        this.snapshot = this.orchestrator.getSnapshot();
        this.feedback = {
          kind: "warning",
          text: `Stopped ${agentLabel} (human-stopped).`,
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed) return;
        this.feedback = {
          kind: "error",
          text: `Stop failed: ${formatErrorMessage(err)}`,
        };
        this.tui.requestRender();
      });
  }

  private triggerKillAgent(agent: RosterEntry | undefined, label: string): void {
    if (!agent) {
      this.feedback = {
        kind: "warning",
        text: `No live agent for ${label} to kill.`,
      };
      this.tui.requestRender();
      return;
    }

    const agentName = agent.name || agent.agentId;
    this.feedback = {
      kind: "info",
      text: `Killing ${agentName} permanently…`,
    };
    this.tui.requestRender();

    void this.orchestrator
      .killAgent(agentName, "Killed by user")
      .then(() => {
        if (this.closed) return;
        this.snapshot = this.orchestrator.getSnapshot();
        this.feedback = {
          kind: "warning",
          text: `Killed ${agentName} permanently.`,
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed) return;
        this.feedback = {
          kind: "error",
          text: `Kill failed: ${formatErrorMessage(err)}`,
        };
        this.tui.requestRender();
      });
  }

  private triggerRerunFinalAudit(): void {
    this.feedback = {
      kind: "info",
      text: "Starting Final Validation audit…",
    };
    this.tui.requestRender();

    void this.orchestrator
      .runFinalAudit({ force: true, hostContext: this.ctx })
      .then(() => {
        if (this.closed) return;
        this.snapshot = this.orchestrator.getSnapshot();
        this.feedback = {
          kind: "success",
          text: "Triggered Final Validation audit.",
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed) return;
        this.feedback = {
          kind: "error",
          text: `Re-verify failed: ${formatErrorMessage(err)}`,
        };
        this.tui.requestRender();
      });
  }

  private triggerApprove(mission: MissionRecord): void {
    if (mission.kind !== "artifact") {
      this.feedback = {
        kind: "warning",
        text: `Mission ${mission.id} is kind "${mission.kind}" (only artifacts require human approval).`,
      };
      this.tui.requestRender();
      return;
    }
    if (mission.status === "merged") {
      this.feedback = {
        kind: "info",
        text: `Mission ${mission.id} is already merged.`,
      };
      this.tui.requestRender();
      return;
    }

    this.feedback = {
      kind: "info",
      text: `Approving artifact ${mission.id}…`,
    };
    this.tui.requestRender();

    void this.orchestrator
      .approveArtifact(mission.id, {
        approvedBy: "human",
        autoMerge: true,
      })
      .then(() => {
        if (this.closed) return;
        this.snapshot = this.orchestrator.getSnapshot();
        this.feedback = {
          kind: "success",
          text: `Approved artifact ${mission.id}.`,
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed) return;
        this.feedback = {
          kind: "error",
          text: `Approve failed: ${formatErrorMessage(err)}`,
        };
        this.tui.requestRender();
      });
  }

  private triggerRetry(mission: MissionRecord): void {
    if (
      mission.status !== "failed" &&
      mission.status !== "stopped" &&
      !mission.humanStopped
    ) {
      this.feedback = {
        kind: "warning",
        text: `Mission ${mission.id} is ${mission.status} (retry is for failed/stopped missions).`,
      };
      this.tui.requestRender();
      return;
    }

    this.feedback = {
      kind: "info",
      text: `Retrying mission ${mission.id}…`,
    };
    this.tui.requestRender();

    void this.orchestrator
      .retryMission(mission.id, {
        reason: "Retried by user via /swarm tasks",
        hostContext: this.ctx,
      })
      .then(() => {
        if (this.closed) return;
        this.snapshot = this.orchestrator.getSnapshot();
        this.feedback = {
          kind: "success",
          text: `Queued retry for ${mission.id}.`,
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed) return;
        this.feedback = {
          kind: "error",
          text: `Retry failed: ${formatErrorMessage(err)}`,
        };
        this.tui.requestRender();
      });
  }

  private triggerMerge(mission: MissionRecord): void {
    if (mission.status === "merged") {
      this.feedback = {
        kind: "info",
        text: `Mission ${mission.id} is already merged.`,
      };
      this.tui.requestRender();
      return;
    }

    this.feedback = {
      kind: "info",
      text: `Merging ${mission.id} (${mission.branch})…`,
    };
    this.tui.requestRender();

    void this.orchestrator
      .mergeMission(mission.id, { callerRole: "human", actor: "human" })
      .then((res) => {
        if (this.closed) return;
        this.snapshot = this.orchestrator.getSnapshot();
        const sha = res?.mergedCommitSha ? ` (${res.mergedCommitSha.slice(0, 7)})` : "";
        this.feedback = {
          kind: "success",
          text: `Merged ${mission.id}${sha}.`,
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed) return;
        this.feedback = {
          kind: "error",
          text: `Merge blocked: ${formatErrorMessage(err)}`,
        };
        this.tui.requestRender();
      });
  }

  private toggleDiffView(mission: MissionRecord): void {
    if (this.detailMode === "diff" && this.diffState?.missionId === mission.id) {
      this.detailMode = "logs";
      this.tui.requestRender();
      return;
    }

    if (!this.worktree || !this.snapshot.run) {
      this.feedback = {
        kind: "warning",
        text: "Git worktree manager is not available for diff inspection.",
      };
      this.tui.requestRender();
      return;
    }

    this.detailMode = "diff";
    const reqId = ++this.diffRequestId;
    this.diffState = { missionId: mission.id, loading: true };
    this.tui.requestRender();

    const baseBranch = this.snapshot.run.baseBranch;
    void this.worktree
      .getDiffSummary(baseBranch, mission.branch, {
        cwd: mission.worktreePath || undefined,
      })
      .then((summary) => {
        if (this.closed || reqId !== this.diffRequestId) return;
        this.diffState = {
          missionId: mission.id,
          loading: false,
          summary,
        };
        this.tui.requestRender();
      })
      .catch((err) => {
        if (this.closed || reqId !== this.diffRequestId) return;
        this.diffState = {
          missionId: mission.id,
          loading: false,
          error: formatErrorMessage(err),
        };
        this.tui.requestRender();
      });
  }

  // ==========================================================================
  // Keyboard Input Routing
  // ==========================================================================

  handleInput(data: string): void {
    if (this.closed) return;

    // Inline IME input captures all keys until Enter / Esc / Ctrl+C
    if (this.inlineMode) {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.exitInlineMode();
        this.tui.requestRender();
        return;
      }
      this.inlineInput.handleInput(data);
      this.tui.requestRender();
      return;
    }

    const ch = decodePrintableChar(data);
    const lower = ch?.toLowerCase();

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      lower === "q"
    ) {
      this.close();
      return;
    }

    // [b] toggles seamlessly between Fleet view and Board view
    if (lower === "b") {
      this.viewMode = this.viewMode === "fleet" ? "board" : "fleet";
      if (this.viewMode === "board") {
        this.boardScrollFromBottom = 0;
      }
      this.tui.requestRender();
      return;
    }

    if (this.viewMode === "board") {
      const total = this.snapshot.recentBoard.length;
      if (matchesKey(data, Key.up)) {
        if (total > 1) {
          this.boardScrollFromBottom = Math.min(
            total - 1,
            this.boardScrollFromBottom + 1,
          );
          this.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.down)) {
        if (this.boardScrollFromBottom > 0) {
          this.boardScrollFromBottom = Math.max(0, this.boardScrollFromBottom - 1);
          this.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        if (total > 1) {
          this.boardScrollFromBottom = Math.min(
            total - 1,
            this.boardScrollFromBottom + 5,
          );
          this.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        if (this.boardScrollFromBottom > 0) {
          this.boardScrollFromBottom = Math.max(0, this.boardScrollFromBottom - 5);
          this.tui.requestRender();
        }
        return;
      }
      if (lower === "s") {
        this.enterInlineMode({ kind: "board_post" });
        this.tui.requestRender();
        return;
      }
      return;
    }

    // Fleet view navigation (Up/Down arrows; [k] is permanently reserved for Kill!)
    const items = this.getItems();
    if (items.length === 0) return;

    if (matchesKey(data, Key.up)) {
      this.selectedIndex =
        (this.selectedIndex - 1 + items.length) % items.length;
      if (this.detailMode === "diff") {
        const next = this.getSelectedItem();
        if (
          !next ||
          next.kind !== "mission" ||
          this.diffState?.missionId !== next.mission.id
        ) {
          this.detailMode = "logs";
        }
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % items.length;
      if (this.detailMode === "diff") {
        const next = this.getSelectedItem();
        if (
          !next ||
          next.kind !== "mission" ||
          this.diffState?.missionId !== next.mission.id
        ) {
          this.detailMode = "logs";
        }
      }
      this.tui.requestRender();
      return;
    }

    const selected = this.getSelectedItem();
    if (!selected) return;

    if (selected.kind === "final_validator") {
      const live = findLiveFinalValidatorAgent(this.snapshot);
      const waiting = findWaitingFinalValidatorAgent(this.snapshot);
      const working = findWorkingFinalValidatorAgent(this.snapshot);

      if (lower === "s") {
        this.triggerSteerOrWake(live, "Final Validator");
        return;
      }
      if (lower === "m") {
        this.triggerModelSwitch(waiting, working, "Final Validator");
        return;
      }
      if (lower === "x") {
        this.triggerStopAgent(live, "Final Validator", true);
        return;
      }
      if (lower === "k") {
        this.triggerKillAgent(live, "Final Validator");
        return;
      }
      if (lower === "r") {
        this.triggerRerunFinalAudit();
        return;
      }
      return;
    }

    const mission = selected.mission;
    const live = findLiveAgentForMission(this.snapshot, mission.id);
    const waiting = findWaitingAgentForMission(this.snapshot, mission.id);
    const working = findWorkingAgentForMission(this.snapshot, mission.id);

    if (lower === "s") {
      this.triggerSteerOrWake(live, mission.id);
      return;
    }
    if (lower === "m") {
      this.triggerModelSwitch(waiting, working, mission.id);
      return;
    }
    if (lower === "x") {
      this.triggerStopAgent(live, mission.id, false);
      return;
    }
    if (lower === "k") {
      this.triggerKillAgent(live, mission.id);
      return;
    }
    if (lower === "a") {
      this.triggerApprove(mission);
      return;
    }
    if (lower === "r") {
      this.triggerRetry(mission);
      return;
    }
    if (lower === "g") {
      this.triggerMerge(mission);
      return;
    }
    if (lower === "d") {
      this.toggleDiffView(mission);
      return;
    }
  }

  // ==========================================================================
  // Fleet View Rendering
  // ==========================================================================

  private renderMissionRow(
    run: SwarmRunState,
    mission: MissionRecord,
    isSelected: boolean,
    innerWidth: number,
  ): string {
    const ptr = isSelected ? this.theme.fg("accent", "› ") : "  ";
    const icon = missionStatusIcon(mission.status);
    const idStr = isSelected
      ? this.theme.fg("accent", this.theme.bold(mission.id))
      : this.theme.bold(mission.id);
    const kindStr = formatMissionKindBadge(mission.kind, this.theme);
    const title = sanitizePlainText(mission.title);
    const agent = findLatestAgentForMission(this.snapshot, mission.id);
    const agentStr = agent
      ? `${formatRosterRoleBadge(agent.role, this.theme)}:${formatRosterStatusBadge(agent.status, this.theme)}`
      : this.theme.fg("dim", mission.status);
    const revStr = formatReviewBadge(mission, run.validatorEnabled, this.theme);
    const usage = sumMissionUsage(run, mission.id);
    const retryPart = mission.retryCount > 0 ? `r:${mission.retryCount}` : "";

    if (innerWidth < 56) {
      return fitLine(`${ptr}${icon} ${idStr} [${kindStr}] ${title}`, innerWidth);
    }

    const left = `${ptr}${icon} ${idStr} [${kindStr}] ${title}`;
    const rightParts = [agentStr];
    if (agent?.model && innerWidth >= 96) {
      rightParts.push(this.theme.fg("dim", shortenModelName(agent.model, 16)));
    }
    rightParts.push(revStr);
    if (retryPart) rightParts.push(this.theme.fg("warning", retryPart));
    if (usage.tokens > 0) {
      rightParts.push(this.theme.fg("dim", formatTokens(usage.tokens)));
    }
    return fitLine(joinColumns(left, rightParts.join(" · "), innerWidth), innerWidth);
  }

  private renderFinalValidatorRow(
    run: SwarmRunState,
    isSelected: boolean,
    innerWidth: number,
  ): string {
    const ptr = isSelected ? this.theme.fg("accent", "› ") : "  ";
    const tag = isSelected
      ? this.theme.fg("borderAccent", this.theme.bold("[FINAL]"))
      : this.theme.fg("borderAccent", "[FINAL]");
    const label = `Final Validator (base:${run.baseBranch})`;
    const left = `${ptr}${tag} ${isSelected ? this.theme.bold(label) : label}`;

    if (innerWidth < 56) {
      return fitLine(left, innerWidth);
    }

    const auditStatus = getEffectiveFinalAuditStatus(this.snapshot, run);
    const latestAudit = getEffectiveLatestFinalAudit(this.snapshot, run);
    const maxRounds = Math.max(1, run.maxFinalAuditRounds || 1);
    const round = computeActiveFinalAuditRound(
      auditStatus,
      run.finalAuditRound,
      latestAudit,
      auditStatus === "running",
    );
    const badge = formatFinalAuditBadge(auditStatus, round, maxRounds, this.theme);
    const agent = findLatestFinalValidatorAgent(this.snapshot);
    const rightParts: string[] = [];
    if (agent) {
      rightParts.push(
        `${formatRosterRoleBadge(agent.role, this.theme)}:${formatRosterStatusBadge(agent.status, this.theme)}`,
      );
    }
    rightParts.push(badge);
    const usage = sumFinalValidatorUsage(run);
    if (usage.tokens > 0) {
      rightParts.push(this.theme.fg("dim", formatTokens(usage.tokens)));
    }
    return fitLine(joinColumns(left, rightParts.join(" · "), innerWidth), innerWidth);
  }

  private renderAgentMetaLine(agent: RosterEntry, innerWidth: number): string {
    const nameStr = this.theme.bold(sanitizePlainText(agent.name || agent.agentId));
    const roleStr = formatRosterRoleBadge(agent.role, this.theme);
    const statusStr = formatRosterStatusBadge(agent.status, this.theme);
    const modelStr = agent.model
      ? this.theme.fg("accent", shortenModelName(agent.model, 24))
      : this.theme.fg("dim", "host default");
    const turnsStr = this.theme.fg("muted", `turns:${agent.turns}`);
    const cursorStr = this.theme.fg("muted", `board:#${agent.lastReadBoardSeq}`);
    return fitLine(
      `${this.theme.fg("muted", "Agent:")} ${nameStr} (${roleStr}) · ${statusStr} · ${this.theme.fg("muted", "model:")}${modelStr} · ${turnsStr} · ${cursorStr}`,
      innerWidth,
    );
  }

  private renderFinalValidatorDetailPane(
    run: SwarmRunState,
    innerWidth: number,
    budgetLines: number,
  ): string[] {
    const out: string[] = [];
    if (budgetLines <= 0) return out;

    const auditStatus = getEffectiveFinalAuditStatus(this.snapshot, run);
    const latestAudit = getEffectiveLatestFinalAudit(this.snapshot, run);
    const maxRounds = Math.max(1, run.maxFinalAuditRounds || 1);
    const round = computeActiveFinalAuditRound(
      auditStatus,
      run.finalAuditRound,
      latestAudit,
      auditStatus === "running",
    );
    const badge = formatFinalAuditBadge(auditStatus, round, maxRounds, this.theme);
    const pinnedSha = latestAudit?.commitSha || run.lastAuditedSha;
    const shaPart = pinnedSha ? ` · @ ${pinnedSha.slice(0, 7)}` : "";
    const agent = findLatestFinalValidatorAgent(this.snapshot);

    out.push(
      fitLine(
        `${this.theme.bold("Final Validator")} · ${badge} · base:${this.theme.fg("accent", run.baseBranch)}${shaPart}`,
        innerWidth,
      ),
    );

    if (agent && out.length < budgetLines - 1) {
      out.push(this.renderAgentMetaLine(agent, innerWidth));
    }

    if (latestAudit?.summary && out.length < budgetLines - 1) {
      out.push(
        fitLine(
          `${this.theme.fg("muted", "Summary:")} ${sanitizePlainText(latestAudit.summary)}`,
          innerWidth,
        ),
      );
    }

    if (
      auditStatus === "skipped" &&
      run.finalAuditSkipReason &&
      out.length < budgetLines - 1
    ) {
      out.push(
        fitLine(
          `${this.theme.fg("muted", "Skip reason:")} ${sanitizePlainText(run.finalAuditSkipReason)}`,
          innerWidth,
        ),
      );
    }

    // Reserve at least 3 lines for Live Log when a final-validator roster entry exists
    const logReserve = agent ? 3 : 0;

    // Checks line
    if (
      latestAudit &&
      latestAudit.checks.length > 0 &&
      out.length < budgetLines - logReserve
    ) {
      const passed = latestAudit.checks.filter((c) => c.passed).length;
      const checkItems = latestAudit.checks.map((c) => {
        const icon = c.passed
          ? this.theme.fg("success", "✓")
          : this.theme.fg("error", "✗");
        const detail =
          !c.passed && c.detail ? ` (${sanitizePlainText(c.detail)})` : "";
        return `${icon} ${sanitizePlainText(c.name)}${detail}`;
      });
      out.push(
        fitLine(
          `${this.theme.fg("muted", `Checks (${passed}/${latestAudit.checks.length}):`)} ${checkItems.join(", ")}`,
          innerWidth,
        ),
      );
    }

    // Findings
    const hasRecs =
      Boolean(latestAudit?.recommendedMissions) &&
      (latestAudit?.recommendedMissions?.length ?? 0) > 0;
    const recReserve = hasRecs ? 2 : 0;

    if (
      latestAudit &&
      latestAudit.findings.length > 0 &&
      out.length < budgetLines - logReserve - recReserve - 1
    ) {
      out.push(
        fitLine(
          this.theme.fg("muted", `Findings (${latestAudit.findings.length}):`),
          innerWidth,
        ),
      );
      const maxFindings = Math.min(
        2,
        Math.max(1, budgetLines - out.length - logReserve - recReserve),
      );
      for (const f of latestAudit.findings.slice(0, maxFindings)) {
        const loc = f.file
          ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})`
          : "";
        const sevColor =
          f.severity === "p1"
            ? "error"
            : f.severity === "p2"
              ? "warning"
              : "muted";
        out.push(
          fitLine(
            `  ${this.theme.fg(sevColor, `[${f.severity}]`)} ${sanitizePlainText(f.title)}${loc}`,
            innerWidth,
          ),
        );
      }
      if (
        latestAudit.findings.length > maxFindings &&
        out.length < budgetLines - logReserve - recReserve
      ) {
        out.push(
          fitLine(
            this.theme.fg(
              "dim",
              `  … +${latestAudit.findings.length - maxFindings} more finding(s)`,
            ),
            innerWidth,
          ),
        );
      }
    }

    // Recommended Fix Missions
    if (
      latestAudit?.recommendedMissions &&
      latestAudit.recommendedMissions.length > 0 &&
      out.length < budgetLines - logReserve - 1
    ) {
      out.push(
        fitLine(
          this.theme.fg(
            "muted",
            `Recommended Fix Missions (${latestAudit.recommendedMissions.length}):`,
          ),
          innerWidth,
        ),
      );
      const maxRec = Math.min(
        2,
        Math.max(1, budgetLines - out.length - logReserve),
      );
      for (const rec of latestAudit.recommendedMissions.slice(0, maxRec)) {
        const scopeStr =
          rec.scope.length > 0 ? ` [${rec.scope.join(", ")}]` : "";
        out.push(
          fitLine(
            `  ${this.theme.fg("accent", "•")} ${sanitizePlainText(rec.title)}${this.theme.fg("dim", scopeStr)}`,
            innerWidth,
          ),
        );
      }
    }

    // Live Log Tail for Final Validator agent
    const bodyRemaining = budgetLines - out.length;
    if (bodyRemaining > 0) {
      const logLabel = agent
        ? `Live Log · ${agent.name || agent.agentId} (${agent.role}, ${agent.status}, ${formatElapsedSince(agent.startedAt, this.now())})`
        : "Live Log";
      out.push(renderHorizontalRule(innerWidth, logLabel, this.theme));
      const logBudget = Math.max(0, budgetLines - out.length);
      if (logBudget > 0) {
        if (!agent) {
          out.push(
            fitLine(
              this.theme.fg("dim", "  No Final Validator agent log available yet."),
              innerWidth,
            ),
          );
        } else {
          const tail = agent.logTail;
          if (tail.length === 0) {
            const act = agent.currentActivity || agent.lastTool || agent.status;
            out.push(
              fitLine(
                this.theme.fg("muted", `  ${sanitizePlainText(act)}`),
                innerWidth,
              ),
            );
          } else {
            for (const line of tail.slice(-logBudget)) {
              out.push(
                fitLine(
                  this.theme.fg("toolOutput", `  ${sanitizePlainText(line)}`),
                  innerWidth,
                ),
              );
            }
          }
        }
      }
    }

    return out.slice(0, budgetLines);
  }

  private renderDetailPane(
    _run: SwarmRunState,
    mission: MissionRecord,
    innerWidth: number,
    budgetLines: number,
  ): string[] {
    const out: string[] = [];
    if (budgetLines <= 0) return out;

    const statusBadge = formatMissionStatusBadge(mission.status, this.theme);
    const humanTag = mission.humanStopped
      ? " " + this.theme.fg("warning", "(human-stopped)")
      : "";
    const branchStr = this.theme.fg("accent", mission.branch);
    out.push(
      fitLine(
        `${this.theme.bold(sanitizePlainText(mission.title))} · ${statusBadge}${humanTag} · ${branchStr}`,
        innerWidth,
      ),
    );

    const scopeStr =
      mission.scope.length > 0 ? mission.scope.join(", ") : "(unrestricted)";
    const depsStr = mission.deps.length > 0 ? mission.deps.join(", ") : "none";
    out.push(
      fitLine(
        `${this.theme.fg("muted", "Scope:")} ${scopeStr}  ${this.theme.fg("muted", "Deps:")} ${depsStr}`,
        innerWidth,
      ),
    );

    const agent = findLatestAgentForMission(this.snapshot, mission.id);
    if (agent && out.length < budgetLines - 2) {
      out.push(this.renderAgentMetaLine(agent, innerWidth));
    }

    if (mission.verification && out.length < budgetLines - 2) {
      out.push(
        fitLine(
          `${this.theme.fg("muted", "Verify:")} ${sanitizePlainText(mission.verification)}`,
          innerWidth,
        ),
      );
    }

    if (mission.error && out.length < budgetLines - 1) {
      out.push(
        fitLine(
          `${this.theme.fg("error", "Error:")} ${sanitizePlainText(mission.error)}`,
          innerWidth,
        ),
      );
    }

    // Validation verdict & findings (when present)
    if (mission.latestReview && out.length < budgetLines - 2) {
      const rev = mission.latestReview;
      const revTone =
        rev.status === "clean" && rev.merge === "merge" ? "success" : "warning";
      const shaShort = rev.commitSha ? rev.commitSha.slice(0, 7) : "—";
      out.push(
        fitLine(
          `${this.theme.fg("muted", "Validation:")} ${this.theme.fg(revTone, `${rev.status} (${rev.merge})`)} @ ${shaShort} — ${sanitizePlainText(rev.decision)}`,
          innerWidth,
        ),
      );
      const maxFindings = Math.min(2, Math.max(0, budgetLines - out.length - 3));
      for (const f of rev.findings.slice(0, maxFindings)) {
        const loc = f.file
          ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})`
          : "";
        const sevColor =
          f.severity === "p1"
            ? "error"
            : f.severity === "p2"
              ? "warning"
              : "muted";
        out.push(
          fitLine(
            `  ${this.theme.fg(sevColor, `[${f.severity}]`)} ${sanitizePlainText(f.title)}${loc}`,
            innerWidth,
          ),
        );
      }
    }

    const bodyRemaining = budgetLines - out.length;
    if (bodyRemaining <= 0) return out.slice(0, budgetLines);

    // Lower detail body: either Diff summary or Live Log Tail
    if (this.detailMode === "diff") {
      out.push(renderHorizontalRule(innerWidth, "Git Diff ([d] for logs)", this.theme));
      const diffBudget = Math.max(1, budgetLines - out.length);
      if (
        !this.diffState ||
        this.diffState.missionId !== mission.id ||
        this.diffState.loading
      ) {
        out.push(
          fitLine(this.theme.fg("muted", "  Loading git diff summary…"), innerWidth),
        );
      } else if (this.diffState.error) {
        out.push(
          fitLine(
            this.theme.fg("error", `  Diff error: ${this.diffState.error}`),
            innerWidth,
          ),
        );
      } else if (this.diffState.summary) {
        const ds = this.diffState.summary;
        out.push(
          fitLine(
            `  ${ds.commitsAhead} commit(s) ahead of ${ds.baseBranch} · ${ds.changedFiles.length} file(s) changed (${ds.headSha.slice(0, 7)})`,
            innerWidth,
          ),
        );
        const rawLines = (ds.stat || ds.diff || "(no diff)")
          .split(/\r?\n/)
          .filter((l) => l.length > 0);
        const extraDiffLines =
          ds.stat && ds.diff
            ? [...rawLines, ...ds.diff.split(/\r?\n/).slice(0, 12)]
            : rawLines;
        for (const dl of extraDiffLines.slice(0, Math.max(0, diffBudget - 1))) {
          const clean = sanitizePlainText(dl);
          const styled = clean.startsWith("+")
            ? this.theme.fg("toolDiffAdded", `  ${clean}`)
            : clean.startsWith("-")
              ? this.theme.fg("toolDiffRemoved", `  ${clean}`)
              : clean.startsWith("@@")
                ? this.theme.fg("accent", `  ${clean}`)
                : this.theme.fg("toolDiffContext", `  ${clean}`);
          out.push(fitLine(styled, innerWidth));
        }
      }
    } else {
      const logLabel = agent
        ? `Live Log · ${agent.name || agent.agentId} (${agent.role}, ${agent.status}, ${formatElapsedSince(agent.startedAt, this.now())})`
        : "Live Log";
      out.push(renderHorizontalRule(innerWidth, logLabel, this.theme));

      const logBudget = Math.max(1, budgetLines - out.length);
      if (!agent) {
        out.push(
          fitLine(
            this.theme.fg("dim", "  No worker or validator has run for this mission yet."),
            innerWidth,
          ),
        );
      } else {
        const tail = agent.logTail;
        if (tail.length === 0) {
          const act = agent.currentActivity || agent.lastTool || agent.status;
          out.push(
            fitLine(
              this.theme.fg("muted", `  ${sanitizePlainText(act)}`),
              innerWidth,
            ),
          );
        } else {
          for (const line of tail.slice(-logBudget)) {
            out.push(
              fitLine(
                this.theme.fg("toolOutput", `  ${sanitizePlainText(line)}`),
                innerWidth,
              ),
            );
          }
        }
      }
    }

    return out.slice(0, budgetLines);
  }

  // ==========================================================================
  // Board View Rendering
  // ==========================================================================

  private renderBoardRow(msg: BoardMessage, innerWidth: number): string {
    const seqStr = this.theme.fg("accent", `#${msg.seq}`);
    const fromPart = `[${sanitizePlainText(msg.from)}${formatMentions(msg.mentions)}]`;
    const fromStyled = this.theme.bold(fromPart);
    const kindStr = formatBoardKindBadge(msg.kind, this.theme);
    const textStr = sanitizePlainText(msg.text);

    if (innerWidth < 60) {
      return fitLine(`  ${seqStr} ${fromStyled} ${textStr}`, innerWidth);
    }

    const clock = this.theme.fg("dim", formatClock(msg.timestamp));
    return fitLine(
      `  ${seqStr} ${clock} ${fromStyled} ${kindStr} ${textStr}`,
      innerWidth,
    );
  }

  private renderBoardBody(innerWidth: number, budgetLines: number): string[] {
    const out: string[] = [];
    if (budgetLines <= 0) return out;

    const messages = this.snapshot.recentBoard;
    const headerTitle = `Shared Board (head:#${this.snapshot.boardHead} · ${messages.length} shown) [↑↓ scroll · s post · b fleet]`;
    out.push(renderHorizontalRule(innerWidth, headerTitle, this.theme));

    const contentBudget = Math.max(1, budgetLines - out.length);
    if (messages.length === 0) {
      out.push(
        fitLine(
          this.theme.fg("dim", "  No board messages yet. Press [s] to post to the shared board."),
          innerWidth,
        ),
      );
      return out.slice(0, budgetLines);
    }

    // Clamp scroll offset to valid bounds
    const maxOffset = Math.max(0, messages.length - 1);
    if (this.boardScrollFromBottom > maxOffset) {
      this.boardScrollFromBottom = maxOffset;
    }

    const needsIndicators = messages.length > contentBudget && contentBudget >= 3;
    const endIdx = messages.length - this.boardScrollFromBottom;
    const hasBelow = this.boardScrollFromBottom > 0;
    const reserveBelow = needsIndicators && hasBelow ? 1 : 0;
    const tentativeStart = Math.max(0, endIdx - (contentBudget - reserveBelow));
    const hasAbove = tentativeStart > 0;
    const reserveAbove = needsIndicators && hasAbove ? 1 : 0;
    const rowBudget = Math.max(1, contentBudget - reserveAbove - reserveBelow);
    const startIdx = Math.max(0, endIdx - rowBudget);
    const visible = messages.slice(startIdx, endIdx);

    if (reserveAbove > 0 && startIdx > 0) {
      out.push(
        fitLine(
          this.theme.fg("dim", `  ↑ ${startIdx} older message${startIdx === 1 ? "" : "s"}`),
          innerWidth,
        ),
      );
    }

    for (const msg of visible) {
      out.push(this.renderBoardRow(msg, innerWidth));
    }

    if (reserveBelow > 0 && this.boardScrollFromBottom > 0) {
      out.push(
        fitLine(
          this.theme.fg(
            "dim",
            `  ↓ ${this.boardScrollFromBottom} newer message${this.boardScrollFromBottom === 1 ? "" : "s"}`,
          ),
          innerWidth,
        ),
      );
    }

    return out.slice(0, budgetLines);
  }

  // ==========================================================================
  // Action Bar & Inline Input
  // ==========================================================================

  private renderActionBarLines(
    selected: OverlayListItem | undefined,
    innerWidth: number,
  ): string[] {
    const item = (key: string, label: string, enabled: boolean) =>
      enabled
        ? `${this.theme.fg("accent", `[${key}]`)} ${label}`
        : this.theme.fg("dim", `[${key}] ${label}`);

    const closeItem = `${this.theme.fg("muted", "[Esc/q]")} close`;

    if (this.viewMode === "board") {
      const parts = [
        item("s", "post", true),
        `${this.theme.fg("muted", "[↑↓]")} scroll`,
        item("b", "fleet", true),
        closeItem,
      ];
      return [fitLine(parts.join(" · "), innerWidth)];
    }

    let parts: string[];
    if (selected?.kind === "final_validator") {
      const live = findLiveFinalValidatorAgent(this.snapshot);
      const waiting = findWaitingFinalValidatorAgent(this.snapshot);
      const working = findWorkingFinalValidatorAgent(this.snapshot);
      parts = [
        item("s", working ? "steer" : "wake", live !== undefined),
        item("m", "model", waiting !== undefined),
        item("x", "stop", live !== undefined),
        item("k", "kill", live !== undefined),
        item("r", "re-verify", true),
        item("b", "board", true),
        closeItem,
      ];
    } else {
      const mission = selected?.kind === "mission" ? selected.mission : undefined;
      const live = mission
        ? findLiveAgentForMission(this.snapshot, mission.id)
        : undefined;
      const waiting = mission
        ? findWaitingAgentForMission(this.snapshot, mission.id)
        : undefined;
      const working = mission
        ? findWorkingAgentForMission(this.snapshot, mission.id)
        : undefined;
      const canApprove =
        mission !== undefined &&
        mission.kind === "artifact" &&
        mission.status !== "merged" &&
        !mission.humanApprovedSha;
      const canRetry =
        mission !== undefined &&
        (mission.status === "failed" ||
          mission.status === "stopped" ||
          mission.humanStopped);
      const canMerge =
        mission !== undefined &&
        mission.status !== "merged" &&
        (this.snapshot.readyToMerge.includes(mission.id) ||
          mission.status === "completed");

      parts = [
        item("s", working ? "steer" : "wake", live !== undefined),
        item("m", "model", waiting !== undefined),
        item("x", "stop", live !== undefined),
        item("k", "kill", live !== undefined),
        item("a", "approve", canApprove),
        item("r", "retry", canRetry),
        item("g", "merge", canMerge),
        item("d", this.detailMode === "diff" ? "logs" : "diff", mission !== undefined),
        item("b", "board", true),
        closeItem,
      ];
    }

    const single = parts.join(" · ");
    if (visibleWidth(single) <= innerWidth) {
      return [single];
    }

    // Wrap cleanly across two lines so every key stays legible at 80-110 width
    const splitAt = Math.ceil(parts.length / 2);
    const line1 = fitLine(parts.slice(0, splitAt).join(" · "), innerWidth);
    const line2 = fitLine(parts.slice(splitAt).join(" · "), innerWidth);
    return [line1, line2];
  }

  private renderInlinePromptLabel(mode: InlineInputMode): string {
    if (mode.kind === "steer") {
      const mLabel =
        mode.agent.missionId === FINAL_AUDIT_MISSION_ID
          ? "FINAL"
          : mode.agent.missionId;
      return `Steer ${mode.agent.name || mode.agent.agentId} (${mLabel}):`;
    }
    if (mode.kind === "wake") {
      const mLabel =
        mode.agent.missionId === FINAL_AUDIT_MISSION_ID
          ? "FINAL"
          : mode.agent.missionId;
      return `Wake @${mode.agent.name || mode.agent.agentId} via board (${mLabel}):`;
    }
    if (mode.kind === "model") {
      const cur = mode.agent.model ?? "host default";
      return `Hot-switch model for ${mode.agent.name || mode.agent.agentId} (current: ${cur}):`;
    }
    return "Post to shared Swarm board (mention @agent to wake):";
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
          title: this.theme.fg(
            "accent",
            this.theme.bold("🐝 Swarm Tasks & Board Overlay"),
          ),
          borderColor: (s) => this.theme.fg("borderAccent", s),
        },
      );
    }

    const missions = this.getMissions();
    const items = this.getItems();
    const hasFinal = items.some((i) => i.kind === "final_validator");
    const mergedCount = missions.filter((m) => m.status === "merged").length;
    const workingCount = this.snapshot.workingAgentIds.length;
    const waitingCount = this.snapshot.waitingAgentIds.length;
    const body: string[] = [];

    // Header summary
    const viewBadge =
      this.viewMode === "board"
        ? this.theme.fg("borderAccent", this.theme.bold("[BOARD]"))
        : this.theme.fg("accent", this.theme.bold("[FLEET]"));
    const headerLeft = `${viewBadge} [${formatRunStatusBadge(run.status, this.theme)}] ${sanitizePlainText(run.objective)}`;
    const headerRight = `base:${run.baseBranch} · ${mergedCount}/${missions.length} · ${workingCount}w/${waitingCount}wait · board:#${this.snapshot.boardHead} · ${formatTokens(this.snapshot.totalTokens)} ${formatCost(this.snapshot.totalCost)}`;
    body.push(
      innerWidth >= 68
        ? joinColumns(headerLeft, headerRight, innerWidth)
        : fitLine(headerLeft, innerWidth),
    );

    if (innerWidth >= 56) {
      const modelsLine = formatRoleModelsLine(
        this.snapshot.roleModels ?? run.roleModels,
        "default",
        {
          maxWidth: Math.max(1, innerWidth - visibleWidth("Models: ")),
          theme: this.theme,
          includeThinking: false,
        },
      );
      body.push(fitLine(`${this.theme.fg("muted", "Models: ")}${modelsLine}`, innerWidth));
    }

    const selected = this.getSelectedItem();
    const actionBarLines = this.inlineMode
      ? []
      : this.renderActionBarLines(selected, innerWidth);
    const footerLinesCount = this.inlineMode ? 2 : actionBarLines.length;
    const bottomReserved =
      (this.feedback ? 1 : 0) + 1 /* rule */ + footerLinesCount;

    if (this.viewMode === "board") {
      const boardBudget = Math.max(4, maxInnerLines - body.length - bottomReserved);
      body.push(...this.renderBoardBody(innerWidth, boardBudget));
    } else {
      const contentBudget = Math.max(
        6,
        maxInnerLines - body.length - bottomReserved,
      );
      const listMax = Math.max(
        2,
        Math.min(items.length + 1, Math.floor(contentBudget * 0.4)),
      );

      const listTitle = hasFinal
        ? `Missions (${missions.length}) + Final Validator [↑↓ select]`
        : `Missions (${missions.length}) [↑↓ select]`;
      body.push(renderHorizontalRule(innerWidth, listTitle, this.theme));

      const visibleListRows = Math.max(1, listMax - 1);
      let listStart = 0;
      if (items.length > visibleListRows) {
        listStart = Math.max(
          0,
          Math.min(
            this.selectedIndex - Math.floor(visibleListRows / 2),
            items.length - visibleListRows,
          ),
        );
      }
      const listEnd = Math.min(items.length, listStart + visibleListRows);

      for (let i = listStart; i < listEnd; i++) {
        const entry = items[i]!;
        if (entry.kind === "final_validator") {
          body.push(
            this.renderFinalValidatorRow(run, i === this.selectedIndex, innerWidth),
          );
        } else {
          body.push(
            this.renderMissionRow(
              run,
              entry.mission,
              i === this.selectedIndex,
              innerWidth,
            ),
          );
        }
      }

      // Selected detail pane (mission OR Final Validator)
      if (selected) {
        const detailHeader =
          selected.kind === "final_validator"
            ? `Final Validator (base:${run.baseBranch})`
            : `Mission ${selected.mission.id} (${selected.mission.kind})`;
        body.push(renderHorizontalRule(innerWidth, detailHeader, this.theme));
        const detailBudget = Math.max(
          1,
          maxInnerLines - body.length - bottomReserved,
        );
        if (selected.kind === "final_validator") {
          body.push(
            ...this.renderFinalValidatorDetailPane(run, innerWidth, detailBudget),
          );
        } else {
          body.push(
            ...this.renderDetailPane(run, selected.mission, innerWidth, detailBudget),
          );
        }
      }
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

    // Inline IME Input OR Action bar
    body.push(renderHorizontalRule(innerWidth, undefined, this.theme));
    if (this.inlineMode) {
      const label = this.renderInlinePromptLabel(this.inlineMode);
      body.push(fitLine(this.theme.fg("accent", label), innerWidth));
      const inputLine = this.inlineInput.render(innerWidth)[0] ?? "";
      body.push(inputLine);
    } else {
      body.push(...actionBarLines);
    }

    return renderBox(body.slice(0, maxInnerLines), targetWidth, {
      title: this.theme.fg(
        "accent",
        this.theme.bold(`🐝 Swarm Tasks & Board · ${run.id}`),
      ),
      borderColor: (s) => this.theme.fg("borderAccent", s),
    });
  }
}

// ============================================================================
// RPC / Non-TUI Fallback
// ============================================================================

async function openTasksBasicMenu(
  ctx: ExtensionContext,
  orchestrator: ISwarmOrchestrator,
  worktree?: IWorktreeManager | null,
): Promise<void> {
  while (true) {
    const snapshot = orchestrator.getSnapshot();
    const run = snapshot.run;
    if (!run) {
      ctx.ui.notify("No active Swarm run.", "info");
      return;
    }

    const missions = getOrderedMissions(run);
    const labelToMission = new Map<string, MissionRecord>();
    const options: string[] = [];

    for (const m of missions) {
      const live = findLiveAgentForMission(snapshot, m.id);
      const agentTag = live
        ? ` · ${live.role}:${live.status}${live.model ? ` [${shortenModelName(live.model)}]` : ""}`
        : "";
      const revTag = formatReviewBadge(m, run.validatorEnabled);
      const label = `${missionStatusIcon(m.status)} ${m.id} [${m.kind}] ${sanitizePlainText(m.title)} (${m.status}${agentTag} · val:${revTag})`;
      labelToMission.set(label, m);
      options.push(label);
    }

    let finalValidatorOpt: string | undefined;
    if (hasFinalValidatorItem(snapshot)) {
      const auditStatus = getEffectiveFinalAuditStatus(snapshot, run);
      const latestAudit = getEffectiveLatestFinalAudit(snapshot, run);
      const maxRounds = Math.max(1, run.maxFinalAuditRounds || 1);
      const round = computeActiveFinalAuditRound(
        auditStatus,
        run.finalAuditRound,
        latestAudit,
        auditStatus === "running",
      );
      const badge = formatFinalAuditBadge(auditStatus, round, maxRounds);
      finalValidatorOpt = `[FINAL] Final Validator (base:${run.baseBranch}) — ${badge}`;
      options.push(finalValidatorOpt);
    }

    const boardOpt = `Shared Board (#${snapshot.boardHead}) — Post message`;
    options.push(boardOpt);

    const closeOpt = "Close";
    options.push(closeOpt);

    const chosenLabel = await ctx.ui.select(
      `Swarm Tasks & Board — ${run.id} (${snapshot.workingAgentIds.length} working · ${snapshot.waitingAgentIds.length} waiting · board:#${snapshot.boardHead})`,
      options,
    );
    if (!chosenLabel || chosenLabel === closeOpt) {
      return;
    }

    if (chosenLabel === boardOpt) {
      const msg = await ctx.ui.input(
        "Post to shared Swarm board",
        "Type message (use @name to wake an agent)…",
      );
      if (msg && msg.trim()) {
        try {
          const posted = await orchestrator.postToBoard({
            from: "human",
            fromRole: "human",
            text: msg.trim(),
            kind: "chat",
          });
          ctx.ui.notify(`Posted #${posted.seq} to board.`, "info");
        } catch (err) {
          ctx.ui.notify(`Board post failed: ${formatErrorMessage(err)}`, "error");
        }
      }
      continue;
    }

    if (finalValidatorOpt && chosenLabel === finalValidatorOpt) {
      const liveValidator = findLiveFinalValidatorAgent(snapshot);
      const waitingValidator = findWaitingFinalValidatorAgent(snapshot);
      const actions: string[] = [];
      if (liveValidator) {
        const name = liveValidator.name || liveValidator.agentId;
        if (waitingValidator) {
          actions.push(`Hot-switch model on ${name}`);
        }
        actions.push(`Stop ${name} (human-stopped)`);
        actions.push(`Kill ${name} permanently`);
      }
      actions.push("Re-run Final Validation");
      actions.push("Back");

      const action = await ctx.ui.select(
        `[FINAL] Final Validator (base:${run.baseBranch})`,
        actions,
      );
      if (!action || action === "Back") continue;

      try {
        if (action.startsWith("Hot-switch model on ") && waitingValidator) {
          const modelId = await ctx.ui.input(
            `Switch model for ${waitingValidator.name || waitingValidator.agentId}`,
            "provider/model-id…",
          );
          if (modelId && modelId.trim()) {
            await orchestrator.switchAgentModel(
              waitingValidator.name || waitingValidator.agentId,
              modelId.trim(),
            );
            ctx.ui.notify(
              `Switched ${waitingValidator.name || waitingValidator.agentId} to ${modelId.trim()}.`,
              "info",
            );
          }
        } else if (action.startsWith("Stop ") && liveValidator) {
          await orchestrator.stopAgent(liveValidator.agentId, {
            humanStopped: true,
            reason: "Stopped Final Validator by user via /swarm tasks",
          });
          ctx.ui.notify(
            `Stopped ${liveValidator.name || liveValidator.agentId} (human-stopped).`,
            "warning",
          );
        } else if (action.startsWith("Kill ") && liveValidator) {
          await orchestrator.killAgent(
            liveValidator.name || liveValidator.agentId,
            "Killed by user",
          );
          ctx.ui.notify(
            `Killed ${liveValidator.name || liveValidator.agentId} permanently.`,
            "warning",
          );
        } else if (action === "Re-run Final Validation") {
          await orchestrator.runFinalAudit({ force: true, hostContext: ctx });
          ctx.ui.notify("Triggered Final Validation audit.", "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Final Validator action failed: ${formatErrorMessage(err)}`,
          "error",
        );
      }
      continue;
    }

    const mission = labelToMission.get(chosenLabel);
    if (!mission) continue;

    const live = findLiveAgentForMission(snapshot, mission.id);
    const working = findWorkingAgentForMission(snapshot, mission.id);
    const waiting = findWaitingAgentForMission(snapshot, mission.id);
    const actions: string[] = [];
    if (working) {
      actions.push(`Steer ${working.name || working.agentId}`);
    } else if (waiting) {
      actions.push(`Wake @${waiting.name || waiting.agentId} via board`);
    }
    if (waiting) {
      actions.push(`Hot-switch model on ${waiting.name || waiting.agentId}`);
    }
    if (live) {
      actions.push(`Stop ${live.name || live.agentId} (human-stopped)`);
      actions.push(`Kill ${live.name || live.agentId} permanently`);
    }
    if (mission.kind === "artifact" && mission.status !== "merged") {
      actions.push("Approve artifact");
    }
    if (
      mission.status === "failed" ||
      mission.status === "stopped" ||
      mission.humanStopped
    ) {
      actions.push("Retry mission");
    }
    if (mission.status !== "merged") {
      actions.push("Merge mission");
    }
    if (worktree) {
      actions.push("Show git diff summary");
    }
    actions.push("Back");

    const action = await ctx.ui.select(
      `Mission ${mission.id}: ${sanitizePlainText(mission.title)} (${mission.branch})`,
      actions,
    );
    if (!action || action === "Back") continue;

    try {
      if (action.startsWith("Steer ") && working) {
        const msg = await ctx.ui.input(
          `Steer ${working.name || working.agentId}`,
          "Enter steering instructions…",
        );
        if (msg && msg.trim()) {
          await orchestrator.steerAgent(working.agentId, msg.trim(), "steer");
          ctx.ui.notify(`Steered ${working.name || working.agentId}.`, "info");
        }
      } else if (action.startsWith("Wake @") && waiting) {
        const name = waiting.name || waiting.agentId;
        const msg = await ctx.ui.input(
          `Wake @${name} via board`,
          "Enter instructions…",
        );
        if (msg && msg.trim()) {
          const text = msg.trim().includes(`@${name}`)
            ? msg.trim()
            : `@${name} ${msg.trim()}`;
          await orchestrator.postToBoard({
            from: "human",
            fromRole: "human",
            text,
            kind: "chat",
            missionId: mission.id,
          });
          ctx.ui.notify(`Posted wakeup for @${name}.`, "info");
        }
      } else if (action.startsWith("Hot-switch model on ") && waiting) {
        const name = waiting.name || waiting.agentId;
        const modelId = await ctx.ui.input(
          `Switch model for ${name}`,
          "provider/model-id…",
        );
        if (modelId && modelId.trim()) {
          await orchestrator.switchAgentModel(name, modelId.trim());
          ctx.ui.notify(`Switched ${name} to ${modelId.trim()}.`, "info");
        }
      } else if (action.startsWith("Stop ") && live) {
        await orchestrator.stopAgent(live.agentId, {
          humanStopped: true,
          reason: "Stopped by user via /swarm tasks",
        });
        ctx.ui.notify(
          `Stopped ${live.name || live.agentId} (human-stopped).`,
          "warning",
        );
      } else if (action.startsWith("Kill ") && live) {
        const name = live.name || live.agentId;
        await orchestrator.killAgent(name, "Killed by user");
        ctx.ui.notify(`Killed ${name} permanently.`, "warning");
      } else if (action === "Approve artifact") {
        await orchestrator.approveArtifact(mission.id, {
          approvedBy: "human",
          autoMerge: true,
        });
        ctx.ui.notify(`Approved artifact ${mission.id}.`, "info");
      } else if (action === "Retry mission") {
        await orchestrator.retryMission(mission.id, {
          reason: "Retried by user via /swarm tasks",
          hostContext: ctx,
        });
        ctx.ui.notify(`Retried mission ${mission.id}.`, "info");
      } else if (action === "Merge mission") {
        await orchestrator.mergeMission(mission.id, {
          callerRole: "human",
          actor: "human",
        });
        ctx.ui.notify(`Merged mission ${mission.id}.`, "info");
      } else if (action === "Show git diff summary" && worktree) {
        const diff = await worktree.getDiffSummary(
          run.baseBranch,
          mission.branch,
          { cwd: mission.worktreePath || undefined },
        );
        ctx.ui.notify(
          `${mission.id} (${mission.branch}): ${diff.commitsAhead} commit(s) ahead, ${diff.changedFiles.length} file(s) changed`,
          "info",
        );
      }
    } catch (err) {
      ctx.ui.notify(
        `Action failed for ${mission.id}: ${formatErrorMessage(err)}`,
        "error",
      );
    }
  }
}

// ============================================================================
// Public Entrypoint
// ============================================================================

export async function openTasksOverlay(
  ctx: ExtensionContext,
  orchestrator: ISwarmOrchestrator,
  worktree?: IWorktreeManager | null,
  options?: TasksOverlayOptions,
): Promise<void> {
  if (!ctx.hasUI) return;

  if (!orchestrator.getSnapshot().run) {
    ctx.ui.notify(
      "No active Swarm run. Start one with /swarm <idea>.",
      "info",
    );
    return;
  }

  options?.onModalEnter?.();
  try {
    if (ctx.mode === "tui") {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) =>
          new TasksOverlayComponent(
            tui,
            theme,
            ctx,
            orchestrator,
            worktree,
            options,
            () => done(undefined),
          ),
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

    await openTasksBasicMenu(ctx, orchestrator, worktree);
  } finally {
    options?.onModalExit?.();
  }
}

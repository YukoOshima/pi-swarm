import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import {
  DEFAULT_CHANNEL,
  ORCHESTRATOR_NAME,
  POST_MESSAGE_TOOL,
  READ_BOARD_TOOL,
  SWARM_ACTIONS,
  SWARM_CHANNEL_ACTIONS,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../constants.js";
import {
  type AvailableModelInfo,
  type BoardMessage,
  type BoardMessageKind,
  type CallerRole,
  type ISwarmEngine,
  isSwarmProtocolError,
  type MemberEngineBridge,
  type MergeBranchResult,
  type ParkOrchestratorWaitResult,
  type ReadBoardResult,
  type SwarmChannelAction,
  type SwarmMemberRecord,
  type SwarmMemberRole,
  type SwarmMilestone,
  SwarmProtocolError,
  type SwarmRosterStatus,
  type SwarmRunState,
  type SwarmSnapshot,
  type SwitchModelResult,
} from "../types.js";
import { formatBoardEntryFull } from "./role-prompts.js";

// ============================================================================
// Helpers & Schema Utilities
// ============================================================================

const MAX_TOOL_OUTPUT_CHARS = 40_000;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const HANDLE_MENTION_RE =
  /(?<![A-Za-z0-9._%+@-])@(?!#)([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;
const CHANNEL_MENTION_RE =
  /(?<![A-Za-z0-9._%+\-@])@#([A-Za-z](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?)/g;

const THINKING_LEVEL_VALUES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const MEMBER_ROLES = ["worker", "validator"] as const;

const MEMBER_SWARM_ACTIONS = [
  "status",
  "models",
  "add",
  "model",
  "steer",
  "stop",
  "kill",
  "channel",
] as const;

const MEMBER_CHANNEL_ACTIONS = ["list", "join", "leave"] as const;
const WORKSPACE_MODES = ["inherit", "share", "branch"] as const;

const BOARD_MESSAGE_KINDS = [
  "chat",
  "brief",
  "done",
  "update",
  "review",
  "decision",
  "model_switch",
  "stall",
] as const;

const MILESTONE_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "blocked",
] as const;

function normalizeOptionalChannel(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const cleaned = raw.trim().replace(/^#+/, "");
  if (!cleaned) {
    return undefined;
  }
  const lower = cleaned.toLowerCase();
  if (lower === "null" || lower === "undefined") {
    return undefined;
  }
  return cleaned;
}

type DirectionUpdatePatch = Parameters<ISwarmEngine["updateDirection"]>[0] & {
  phase?: string | null;
  milestones?: SwarmMilestone[] | null;
};

function stringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>(StringEnum(values, options) as unknown as TSchema);
}

// ============================================================================
// Parameter Schemas (Flat StringEnum / Type.Object — Strict Provider Compatibility)
// ============================================================================

export const SwarmToolParamsSchema = Type.Object({
  action: stringEnum(SWARM_ACTIONS, {
    description:
      'Swarm action: "title" | "add" | "status" | "models" | "model" | "steer" | "stop" | "kill" | "merge" | "channel" | "done".',
  }),
  title: Type.Optional(
    Type.String({ description: 'Run title (for action="title").' }),
  ),
  objective: Type.Optional(
    Type.String({
      description: 'Optional updated run objective when updating direction via action="title".',
    }),
  ),
  strategy: Type.Optional(
    Type.String({
      description: 'Optional updated coordination strategy when updating direction via action="title".',
    }),
  ),
  acceptance_criteria: Type.Optional(
    Type.String({
      description: 'Optional updated acceptance criteria when updating direction via action="title".',
    }),
  ),
  phase: Type.Optional(
    Type.String({
      description:
        'Optional current swarm phase label (e.g. "discovery", "implementation", "verification") for action="title".',
    }),
  ),
  milestones: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String({
          description: "Short milestone description.",
        }),
        status: stringEnum(MILESTONE_STATUSES, {
          description: 'Milestone status: "pending" | "in_progress" | "done" | "blocked".',
        }),
        owner: Type.Optional(
          Type.String({
            description: "Optional owner handle (e.g. member name).",
          }),
        ),
      }),
      {
        description: 'Optional list of run milestones for action="title".',
      },
    ),
  ),
  name: Type.Optional(
    Type.String({
      description:
        'Member name (or base name with n/tasks for "add", target member for "model"/"steer"/"stop"/"kill"/"merge", or member to join/leave for "channel").',
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: 'Redirection/steering instruction (required for action="steer").',
    }),
  ),
  mode: Type.Optional(
    stringEnum(["steer", "followUp"], {
      description: 'Delivery mode for action="steer" on a working member (default "steer").',
      default: "steer",
    }),
  ),
  role: Type.Optional(
    stringEnum(MEMBER_ROLES, {
      description: 'Member role for action="add": "worker" (default) or read-only "validator".',
      default: "worker",
    }),
  ),
  brief: Type.Optional(
    Type.String({
      description:
        'Public assignment brief posted to the board as @<name> (required for action="add"). Cite prior posts by #seq instead of copy-pasting.',
    }),
  ),
  workspace: Type.Optional(
    stringEnum(WORKSPACE_MODES, {
      description:
        'Workspace mode for action="add": "inherit" (default, shared repo), "share" (isolated worktree for concurrent editing), or "branch" (isolated worktree).',
      default: "inherit",
    }),
  ),
  fork: Type.Optional(
    Type.String({
      description:
        'Optional member name (or "orchestrator"/"coordinator") whose conversation history to fork into the new member.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        'Model identifier (e.g. "anthropic/claude-sonnet-4-5") for action="add" or action="model".',
    }),
  ),
  thinking_level: Type.Optional(
    stringEnum(THINKING_LEVEL_VALUES, {
      description: 'Optional thinking level for action="add" or action="model".',
    }),
  ),
  channels: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Optional subscribed channel names for action="add" (defaults to ["main"]).',
    }),
  ),
  n: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        'Number of homogeneous copies (<name>-1..<name>-n) to spawn for action="add".',
    }),
  ),
  tasks: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Per-worker slice targets (<name>-1..<name>-k) for sharded action="add", each combined with brief.',
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description: 'For action="models": list every available model, not only suggested ones.',
    }),
  ),
  op: Type.Optional(
    stringEnum(SWARM_CHANNEL_ACTIONS, {
      description:
        'Sub-action for action="channel": "create" | "list" | "join" | "leave" | "archive".',
    }),
  ),
  channel: Type.Optional(
    Type.String({
      description: 'Channel name for action="channel" (create/join/leave/archive).',
    }),
  ),
  topic: Type.Optional(
    Type.String({
      description: 'Optional channel topic for action="channel" op="create".',
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Force completion even if members are still working or unmerged.",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description: 'Final completion summary (required for action="done").',
    }),
  ),
  teardown: Type.Optional(
    Type.Boolean({
      description: 'For action="done": optionally remove clean idle worktrees after completion.',
    }),
  ),
  delete_branches: Type.Optional(
    Type.Boolean({
      description: 'For action="done" when teardown=true: also delete local swarm branches.',
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: 'Optional reason for action="model", action="stop", or action="kill".',
    }),
  ),
});

export type SwarmToolParams = Static<typeof SwarmToolParamsSchema>;

export const PostMessageToolParamsSchema = Type.Object({
  text: Type.String({
    description: "Concise board message text (include @name / @prefix / @#channel / @all to wake).",
  }),
  channel: Type.Optional(
    Type.String({
      description: 'Optional channel name (defaults to "main").',
    }),
  ),
  kind: Type.Optional(
    stringEnum(BOARD_MESSAGE_KINDS, {
      description: 'Optional message kind (defaults to "chat").',
    }),
  ),
});

export type PostMessageToolParams = Static<typeof PostMessageToolParamsSchema>;

export const ReadBoardToolParamsSchema = Type.Object({
  since: Type.Optional(
    Type.Integer({ minimum: 0, description: "Return oldest messages with seq > since." }),
  ),
  seqs: Type.Optional(
    Type.Array(Type.Integer({ minimum: 0 }), {
      description: "Fetch exact sequence numbers only (e.g. [4, 6]).",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 0, description: "Maximum number of messages to return (default 20)." }),
  ),
  channel: Type.Optional(
    Type.String({ description: 'Filter by channel name, or "*" for all channels.' }),
  ),
  status: Type.Optional(
    Type.Boolean({
      description: "When true, return live roster status instead of board messages.",
    }),
  ),
  search: Type.Optional(
    Type.String({
      description: "Case-insensitive substring filter across board messages.",
    }),
  ),
});

export type ReadBoardToolParams = Static<typeof ReadBoardToolParamsSchema>;

export const SwarmWaitToolParamsSchema = Type.Object({
  since: Type.Integer({
    minimum: 0,
    description: "Highest sequence number you have already read (0 to wait from start).",
  }),
  mentions_only: Type.Optional(
    Type.Boolean({
      description:
        "Wake only on messages addressing @orchestrator/@all/@#channel (default true). Pass false to wake on any board post.",
      default: true,
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: "Optional maximum wait duration in milliseconds.",
    }),
  ),
});

export type SwarmWaitToolParams = Static<typeof SwarmWaitToolParamsSchema>;

// ============================================================================
// Result & Roster Formatting Helpers
// ============================================================================

type RosterStatusMemberWithWorktree = SwarmRosterStatus["members"][number] & {
  cwd?: string;
  mergedCommitSha?: string;
};

function clampOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n... [truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} chars]`;
}

function okResult(text: string, details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: clampOutput(text) }],
    details,
  };
}

export function formatSwarmToolError(err: unknown): AgentToolResult<unknown> {
  if (isSwarmProtocolError(err)) {
    return {
      isError: true,
      content: [{ type: "text", text: `[SwarmProtocolError:${err.code}] ${err.message}` }],
      details: { errorCode: err.code, details: err.details },
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${msg}` }],
    details: { error: msg },
  };
}

async function runToolSafe(
  fn: () => Promise<AgentToolResult<unknown>>,
): Promise<AgentToolResult<unknown>> {
  try {
    return await fn();
  } catch (err) {
    return formatSwarmToolError(err);
  }
}

export function formatRosterStatusText(status: SwarmRosterStatus): string {
  const lines: string[] = [
    `Swarm "${status.title}" (${status.runId}) | status=${status.status} | base=${status.baseBranch} | board=#${status.boardHead}`,
  ];
  if (status.channels.length > 0) {
    lines.push(
      "Channels: " +
        status.channels
          .map(
            (c) =>
              `#${c.name}${c.archived ? "[archived]" : ""}(${c.subscribers.length})`,
          )
          .join(", "),
    );
  }
  if (status.members.length === 0) {
    lines.push("Members: (none)");
  } else {
    lines.push("Members:");
    for (const m of status.members) {
      const ext = m as RosterStatusMemberWithWorktree;
      const isIsolated = m.workspace === "share" || m.workspace === "branch";
      const ws = m.branch ? `${m.workspace}:${m.branch}` : m.workspace;
      const cwd = isIsolated && ext.cwd ? ` cwd=${ext.cwd}` : "";
      const merged = isIsolated
        ? ext.mergedCommitSha
          ? ` merged=${ext.mergedCommitSha.slice(0, 12)}`
          : " merged=unmerged"
        : "";
      const model = m.model ? ` model=${m.model}` : "";
      const lastPost = m.lastPostSeq ? ` lastPost=#${m.lastPostSeq}` : "";
      const info = m.currentActivity
        ? ` — ${m.currentActivity}`
        : m.parkedOn
          ? ` — ${m.parkedOn}`
          : "";
      lines.push(
        `- @${m.name} (${m.role}) [${m.state}] ws=${ws}${cwd}${merged} parent=@${m.parentName}${model} turns=${m.turns}${lastPost}${info}`,
      );
    }
  }
  return lines.join("\n");
}

function snapshotToRosterStatus(snapshot: SwarmSnapshot): SwarmRosterStatus | null {
  const run = snapshot.run;
  if (!run) {
    return null;
  }
  const members: RosterStatusMemberWithWorktree[] = run.memberOrder
    .map((name) => run.members[name])
    .filter((m): m is SwarmMemberRecord => Boolean(m))
    .map((m) => ({
      name: m.name,
      role: m.role,
      state: m.state,
      parentName: m.parentName,
      groupPrefix: m.groupPrefix,
      workspace: m.workspace,
      branch: m.branch,
      cwd: m.cwd,
      mergedCommitSha: m.mergedCommitSha,
      model: m.model,
      thinkingLevel: m.thinkingLevel,
      channels: m.channels,
      parkedOn: m.parkedOn,
      currentActivity: m.currentActivity,
      lastPostSeq: m.lastPostSeq,
      lastPostTime: m.lastPostTime,
      turns: m.turns,
      ...(m.llmTurns !== undefined ? { llmTurns: m.llmTurns } : {}),
      ...(m.turnStartedAt !== undefined ? { turnStartedAt: m.turnStartedAt } : {}),
      tokens: m.tokens,
      cost: m.cost,
    }));
  return {
    runId: run.id,
    title: run.title,
    status: run.status,
    baseBranch: run.baseBranch,
    boardHead: snapshot.boardHead,
    members,
    channels: Object.values(run.channels),
  };
}

function formatModelsList(
  models: readonly AvailableModelInfo[],
  snapshot?: SwarmSnapshot,
): string {
  const lines: string[] = [];
  if (snapshot?.roleModels) {
    const rm = snapshot.roleModels;
    lines.push(
      `Configured 3-Role Models: orchestrator=${rm.orchestrator?.model ?? "host-default"} | worker=${rm.worker?.model ?? "host-default"} | validator=${rm.validator?.model ?? "host-default"}` +
        (rm.fallbackModels && rm.fallbackModels.length > 0
          ? ` | fallbacks=[${rm.fallbackModels.join(", ")}]`
          : ""),
    );
  }
  if (models.length === 0) {
    lines.push("Available models: (none reported by active model runtime)");
  } else {
    lines.push(`Available models (${models.length}):`);
    for (const m of models) {
      const roles =
        m.activeRoles && m.activeRoles.length > 0
          ? ` [roles: ${m.activeRoles.join(",")}]`
          : "";
      const reasoning = m.reasoning ? " [reasoning]" : "";
      lines.push(`- ${m.fullId}${m.name && m.name !== m.id ? ` (${m.name})` : ""}${reasoning}${roles}`);
    }
  }
  return lines.join("\n");
}

function formatAddedMembers(members: readonly SwarmMemberRecord[]): string {
  const lines = [`Added ${members.length} swarm member(s):`];
  for (const m of members) {
    const ws = m.branch ? `${m.workspace}:${m.branch}` : m.workspace;
    const isIsolated = m.workspace === "share" || m.workspace === "branch";
    const cwd = isIsolated && m.cwd ? ` cwd=${m.cwd}` : "";
    const model = m.model ? ` model=${m.model}` : "";
    const fork = m.forkedFrom ? ` forkedFrom=@${m.forkedFrom}` : "";
    const seq = m.briefSeq ? ` brief=#${m.briefSeq}` : "";
    lines.push(`- @${m.name} (${m.role}) ws=${ws}${cwd}${model}${fork}${seq} channels=[${m.channels.join(",")}]`);
  }
  return lines.join("\n");
}

function normalizeChannelAction(raw?: string): SwarmChannelAction {
  const value = (raw ?? "list").trim().toLowerCase();
  if (value === "subscribe") return "join";
  if (value === "unsubscribe") return "leave";
  if (
    value === "create" ||
    value === "list" ||
    value === "join" ||
    value === "leave" ||
    value === "archive"
  ) {
    return value;
  }
  throw new SwarmProtocolError(
    "INVALID_INPUT",
    `Unsupported channel op "${raw}". Expected one of: ${SWARM_CHANNEL_ACTIONS.join(", ")}.`,
  );
}

// ============================================================================
// Rich Custom TUI Renderers (Shared by Orchestrator & Member-Scoped Tools)
// ============================================================================

interface RenderContextLike {
  expanded?: boolean;
  isError?: boolean;
  keyHint?: (keybinding: "app.tools.expand", description: string) => string;
}

function formatExpandHint(
  options: ToolRenderResultOptions | undefined,
  theme: Theme,
  context?: RenderContextLike,
): string {
  const optionsWithKeyHint = options as
    | (ToolRenderResultOptions & {
        keyHint?: (keybinding: "app.tools.expand", description: string) => string;
      })
    | undefined;
  const keyHintFn = optionsWithKeyHint?.keyHint ?? context?.keyHint;
  if (typeof keyHintFn === "function") {
    try {
      const hint = keyHintFn("app.tools.expand", "to expand");
      if (typeof hint === "string" && hint.trim().length > 0) {
        const trimmed = hint.trim();
        if (trimmed.startsWith("(")) {
          return ` ${trimmed}`;
        }
        return `${theme.fg("dim", " (")}${hint}${theme.fg("dim", ")")}`;
      }
    } catch {
      // Fall back to static hint
    }
  }
  return theme.fg("dim", " (Ctrl+O to expand)");
}

function extractFirstText(
  content: readonly { type: string; text?: string }[] | undefined,
): string {
  if (!Array.isArray(content)) {
    return "";
  }
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return "";
}

function sanitizeInline(text: unknown): string {
  if (typeof text !== "string" || !text) return "";
  return text.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
}

function clipInline(text: unknown, maxChars = 84): string {
  const clean = sanitizeInline(text);
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function isToolErrorResult(
  result: AgentToolResult<unknown> | undefined,
  context?: RenderContextLike,
): boolean {
  if (!result) return Boolean(context?.isError);
  if (result.isError || context?.isError) return true;
  const details = result.details as Record<string, unknown> | undefined;
  return Boolean(
    details &&
      typeof details === "object" &&
      (typeof details.errorCode === "string" || typeof details.error === "string"),
  );
}

function extractTargetsFromText(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const targets: string[] = [];

  HANDLE_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HANDLE_MENTION_RE.exec(text)) !== null) {
    const handle = m[1]!;
    const lower = `@${handle.toLowerCase()}`;
    if (!seen.has(lower)) {
      seen.add(lower);
      targets.push(`@${handle}`);
    }
  }

  CHANNEL_MENTION_RE.lastIndex = 0;
  while ((m = CHANNEL_MENTION_RE.exec(text)) !== null) {
    const ch = m[1]!.toLowerCase();
    const key = `@#${ch}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(key);
    }
  }

  return targets;
}

function renderSwarmCall(
  args: Partial<SwarmToolParams> | undefined,
  theme: Theme,
  defaults?: { defaultRole?: string; selfTarget?: string },
): Text {
  const action = typeof args?.action === "string" ? args.action.trim() : "";
  const rawName =
    typeof args?.name === "string" ? args.name.trim().replace(/^@/, "") : "";
  const atName = rawName ? `@${rawName}` : "@…";

  switch (action) {
    case "add": {
      const role =
        typeof args?.role === "string" && args.role.trim()
          ? args.role.trim()
          : (defaults?.defaultRole ?? "worker");
      const workspace =
        typeof args?.workspace === "string" && args.workspace.trim()
          ? args.workspace.trim()
          : "inherit";
      const shardCount =
        Array.isArray(args?.tasks) && args.tasks.length > 0
          ? args.tasks.length
          : typeof args?.n === "number" && Number.isFinite(args.n) && args.n > 1
            ? Math.floor(args.n)
            : 0;
      const forkRaw =
        typeof args?.fork === "string" && args.fork.trim()
          ? args.fork.trim().replace(/^@/, "")
          : "";
      const extraMeta = [
        shardCount > 0 ? `×${shardCount}` : "",
        forkRaw ? `fork:@${forkRaw}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const meta = extraMeta
        ? `(${role} · ${workspace} · ${extraMeta})`
        : `(${role} · ${workspace})`;
      return new Text(
        `🐝 ${theme.fg("toolTitle", theme.bold("swarm add"))} ${theme.fg("accent", atName)} ${theme.fg("muted", meta)}`,
        0,
        0,
      );
    }

    case "merge":
      return new Text(
        `🔀 ${theme.fg("toolTitle", theme.bold("swarm merge"))} ${theme.fg("accent", atName)}`,
        0,
        0,
      );

    case "model": {
      const target = rawName
        ? `@${rawName}`
        : `@${defaults?.selfTarget ?? ORCHESTRATOR_NAME}`;
      const model =
        typeof args?.model === "string" ? args.model.trim() : "";
      const effort =
        typeof args?.thinking_level === "string"
          ? args.thinking_level.trim()
          : "";
      const spec =
        model && effort
          ? `${model} (${effort})`
          : model || (effort ? `effort=${effort}` : "…");
      return new Text(
        `🎛 ${theme.fg("toolTitle", theme.bold("swarm model"))} ${theme.fg("accent", target)} ${theme.fg("muted", `-> ${spec}`)}`,
        0,
        0,
      );
    }

    case "steer": {
      const modeTag = args?.mode === "followUp" ? " (followUp)" : "";
      const msgPreview =
        typeof args?.message === "string" && args.message.trim()
          ? ` — "${clipInline(args.message, 52)}"`
          : "";
      return new Text(
        `⚡ ${theme.fg("toolTitle", theme.bold("swarm steer"))} ${theme.fg("accent", atName)}${modeTag ? theme.fg("dim", modeTag) : ""}${msgPreview ? theme.fg("muted", msgPreview) : ""}`,
        0,
        0,
      );
    }

    case "stop": {
      const reason =
        typeof args?.reason === "string" && args.reason.trim()
          ? ` (${clipInline(args.reason, 44)})`
          : "";
      return new Text(
        `⏸ ${theme.fg("toolTitle", theme.bold("swarm stop"))} ${theme.fg("accent", atName)}${reason ? theme.fg("muted", reason) : ""}`,
        0,
        0,
      );
    }

    case "kill": {
      const forceBadge = args?.force === true ? " [force]" : "";
      return new Text(
        `🧹 ${theme.fg("toolTitle", theme.bold("swarm kill"))} ${theme.fg("accent", atName)}${forceBadge ? theme.fg("warning", forceBadge) : ""}`,
        0,
        0,
      );
    }

    case "done": {
      const forceBadge = args?.force === true ? " [force]" : "";
      const summaryPreview =
        typeof args?.summary === "string" && args.summary.trim()
          ? ` — ${clipInline(args.summary, 56)}`
          : "";
      return new Text(
        `🏁 ${theme.fg("toolTitle", theme.bold("swarm done"))}${forceBadge ? theme.fg("warning", forceBadge) : ""}${summaryPreview ? theme.fg("muted", summaryPreview) : ""}`,
        0,
        0,
      );
    }

    case "status":
      return new Text(
        `📊 ${theme.fg("toolTitle", theme.bold("swarm status"))}`,
        0,
        0,
      );

    case "models": {
      const suffix = args?.all === true ? " (all)" : "";
      return new Text(
        `🎛 ${theme.fg("toolTitle", theme.bold("swarm models"))}${suffix ? theme.fg("muted", suffix) : ""}`,
        0,
        0,
      );
    }

    case "channel": {
      const op =
        typeof args?.op === "string" && args.op.trim()
          ? args.op.trim().toLowerCase()
          : "list";
      const ch =
        typeof args?.channel === "string" && args.channel.trim()
          ? ` #${args.channel.trim().replace(/^#/, "")}`
          : "";
      const memberTag =
        rawName &&
        (op === "join" ||
          op === "leave" ||
          op === "subscribe" ||
          op === "unsubscribe")
          ? ` @${rawName}`
          : "";
      return new Text(
        `📡 ${theme.fg("toolTitle", theme.bold(`swarm channel ${op}`))}${ch ? theme.fg("accent", ch) : ""}${memberTag ? theme.fg("muted", memberTag) : ""}`,
        0,
        0,
      );
    }

    case "title": {
      const parts: string[] = [];
      if (typeof args?.title === "string" && args.title.trim()) {
        parts.push(`"${clipInline(args.title, 48)}"`);
      }
      if (typeof args?.phase === "string" && args.phase.trim()) {
        parts.push(`phase="${clipInline(args.phase, 28)}"`);
      }
      if (Array.isArray(args?.milestones) && args.milestones.length > 0) {
        const doneCount = args.milestones.filter((m) => m?.status === "done").length;
        parts.push(`milestones=${doneCount}/${args.milestones.length}`);
      }
      const titleText = parts.length > 0 ? ` ${parts.join(" · ")}` : " (update direction)";
      return new Text(
        `🏷 ${theme.fg("toolTitle", theme.bold("swarm title"))}${theme.fg("accent", titleText)}`,
        0,
        0,
      );
    }

    default:
      return new Text(
        `🐝 ${theme.fg("toolTitle", theme.bold(SWARM_TOOL))}${action ? ` ${theme.fg("muted", action)}` : ""}`,
        0,
        0,
      );
  }
}

function renderSwarmResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions | undefined,
  theme: Theme,
  context?: RenderContextLike,
): Text {
  const fullText = extractFirstText(result?.content);
  if (isToolErrorResult(result, context)) {
    return new Text(
      theme.fg("error", fullText || "Swarm tool call failed."),
      0,
      0,
    );
  }
  if (options?.expanded) {
    return new Text(theme.fg("toolOutput", fullText), 0, 0);
  }

  const lines = fullText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const expandHint =
    lines.length > 1 ? formatExpandHint(options, theme, context) : "";

  if (lines.length === 0) {
    return new Text(`${theme.fg("success", "✓")} ${theme.fg("muted", "OK")}`, 0, 0);
  }

  // Prominent top-level warning (e.g. noop merge)
  if (lines[0]!.startsWith("⚠")) {
    const second =
      lines.length > 1
        ? `\n${theme.fg("muted", clipInline(lines[1]!, 92))}`
        : "";
    return new Text(
      `${theme.fg("warning", clipInline(lines[0]!, 96))}${expandHint}${second}`,
      0,
      0,
    );
  }

  // Secondary warning line (e.g. swarm done with unmerged branches)
  const warningLine = lines.find((l) => l.startsWith("⚠"));
  if (warningLine) {
    const moreHint =
      lines.length > 2 ? formatExpandHint(options, theme, context) : expandHint;
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", clipInline(lines[0]!, 92))}${moreHint}\n${theme.fg("warning", clipInline(warningLine, 96))}`,
      0,
      0,
    );
  }

  const details = result?.details as Record<string, unknown> | undefined;

  // Roster status summary
  if (
    details &&
    Array.isArray(details.members) &&
    typeof details.boardHead === "number"
  ) {
    const status = details as unknown as SwarmRosterStatus;
    const validMembers = status.members.filter(
      (m): m is SwarmRosterStatus["members"][number] =>
        Boolean(m && typeof m === "object"),
    );
    const statusLabel =
      typeof status.status === "string" ? status.status : "unknown";
    const header = `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Swarm "${clipInline(status.title, 36)}" · ${validMembers.length} member(s) · status=${statusLabel} · head #${status.boardHead}`)}${expandHint}`;
    if (validMembers.length === 0) {
      return new Text(header, 0, 0);
    }
    const pills = validMembers
      .slice(0, 5)
      .map((m) => `@${sanitizeInline(m.name) || "?"}[${sanitizeInline(m.state) || "?"}]`)
      .join(" · ");
    const overflow =
      validMembers.length > 5 ? ` · +${validMembers.length - 5} more` : "";
    return new Text(`${header}\n${theme.fg("muted", `  ${pills}${overflow}`)}`, 0, 0);
  }

  // Added members summary
  if (details && Array.isArray(details.members)) {
    const added = (details.members as unknown[]).filter(
      (m): m is SwarmMemberRecord => Boolean(m && typeof m === "object"),
    );
    const handles = added
      .slice(0, 5)
      .map((m) => `@${sanitizeInline(m.name) || "?"}`)
      .join(", ");
    const more = added.length > 5 ? `, +${added.length - 5} more` : "";
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Added ${added.length} member(s): ${handles}${more}`)}${expandHint}`,
      0,
      0,
    );
  }

  // Models list summary
  if (details && Array.isArray(details.models)) {
    const models = details.models as AvailableModelInfo[];
    const firstIsRoles = lines[0]?.startsWith("Configured 3-Role Models:");
    const secondLine = firstIsRoles
      ? `\n${theme.fg("muted", `  ${clipInline(lines[0]!, 92)}`)}`
      : "";
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `${models.length} model(s) listed`)}${expandHint}${secondLine}`,
      0,
      0,
    );
  }

  // Real merge summary (first line + changed files line)
  if (
    details &&
    typeof details.strategy === "string" &&
    Array.isArray(details.changedFiles)
  ) {
    const mergeDetails = details as unknown as MergeBranchResult;
    const validChangedFiles = mergeDetails.changedFiles.filter(
      (f): f is string => typeof f === "string" && f.length > 0,
    );
    const secondLine =
      validChangedFiles.length > 0
        ? `\n${theme.fg("muted", `  Changed: ${clipInline(validChangedFiles.join(", "), 84)}`)}`
        : "";
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", clipInline(lines[0]!, 92))}${expandHint}${secondLine}`,
      0,
      0,
    );
  }

  // Default 1–2 line summary
  if (lines.length === 1) {
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", clipInline(lines[0]!, 96))}`,
      0,
      0,
    );
  }
  return new Text(
    `${theme.fg("success", "✓")} ${theme.fg("toolOutput", clipInline(lines[0]!, 92))}${expandHint}\n${theme.fg("muted", `  ${clipInline(lines[1]!, 88)}`)}`,
    0,
    0,
  );
}

function renderPostMessageCall(
  args: Partial<PostMessageToolParams> | undefined,
  theme: Theme,
  defaultChannel: string,
  context?: RenderContextLike,
): Text {
  const channel = normalizeOptionalChannel(args?.channel) ?? defaultChannel;
  const rawText = typeof args?.text === "string" ? args.text : "";
  const targets = extractTargetsFromText(rawText);
  const targetDisplay = targets.length > 0 ? targets.join(", ") : "board";
  const kindBadge =
    typeof args?.kind === "string" && args.kind.trim() && args.kind !== "chat"
      ? ` [${args.kind.trim()}]`
      : "";

  const header = `📨 ${theme.fg("toolTitle", theme.bold(`post #${channel}`))} ${theme.fg("muted", "->")} ${theme.fg(targets.length > 0 ? "accent" : "muted", targetDisplay)}${kindBadge ? theme.fg("dim", kindBadge) : ""}`;

  if (!rawText.trim()) {
    return new Text(header, 0, 0);
  }
  if (context?.expanded) {
    return new Text(`${header}\n${theme.fg("toolOutput", rawText.trim())}`, 0, 0);
  }
  return new Text(
    `${header} ${theme.fg("muted", `— ${clipInline(rawText, 72)}`)}`,
    0,
    0,
  );
}

function renderPostMessageResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions | undefined,
  theme: Theme,
  context?: RenderContextLike,
): Text {
  const fallbackText = extractFirstText(result?.content);
  if (isToolErrorResult(result, context)) {
    return new Text(
      theme.fg("error", fallbackText || "Failed to post message."),
      0,
      0,
    );
  }

  const msg = result?.details as Partial<BoardMessage> | undefined;
  if (msg && typeof msg.seq === "number" && typeof msg.text === "string") {
    const channel = typeof msg.channel === "string" && msg.channel ? msg.channel : DEFAULT_CHANNEL;
    const targets = [
      ...(Array.isArray(msg.mentions)
        ? msg.mentions.filter((m): m is string => typeof m === "string" && m.length > 0).map((m) => `@${m}`)
        : []),
      ...(Array.isArray(msg.channelMentions)
        ? msg.channelMentions.filter((c): c is string => typeof c === "string" && c.length > 0).map((c) => `@#${c}`)
        : []),
    ];
    const route = targets.length > 0 ? ` -> ${targets.join(", ")}` : "";
    if (options?.expanded) {
      return new Text(
        `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Posted #${msg.seq} to #${channel}${route}`)}\n${theme.fg("toolOutput", msg.text)}`,
        0,
        0,
      );
    }
    const isMultiLineOrLong = msg.text.includes("\n") || msg.text.length > 76;
    const expandHint = isMultiLineOrLong
      ? formatExpandHint(options, theme, context)
      : "";
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `#${msg.seq} (#${channel}${route}):`)} ${theme.fg("muted", clipInline(msg.text, 72))}${expandHint}`,
      0,
      0,
    );
  }

  if (options?.expanded) {
    return new Text(theme.fg("toolOutput", fallbackText), 0, 0);
  }
  return new Text(
    `${theme.fg("success", "✓")} ${theme.fg("toolOutput", clipInline(fallbackText, 92))}`,
    0,
    0,
  );
}

function renderReadBoardCall(
  args: Partial<ReadBoardToolParams> | undefined,
  theme: Theme,
): Text {
  const parts: string[] = [];
  if (args?.status === true) {
    parts.push("status");
  } else {
    const ch = normalizeOptionalChannel(args?.channel);
    if (ch) {
      parts.push(ch === "*" ? "all channels" : `#${ch}`);
    }
    const validSeqs = Array.isArray(args?.seqs)
      ? args.seqs.filter((s): s is number => typeof s === "number" && Number.isFinite(s))
      : [];
    if (validSeqs.length > 0) {
      const previewSeqs = validSeqs.slice(0, 6).map((s) => `#${Math.max(0, Math.floor(s))}`).join(", ");
      const more = validSeqs.length > 6 ? `, +${validSeqs.length - 6}` : "";
      parts.push(`seqs ${previewSeqs}${more}`);
    } else if (typeof args?.since === "number" && Number.isFinite(args.since)) {
      parts.push(`since #${Math.max(0, Math.floor(args.since))}`);
    }
    if (typeof args?.limit === "number" && Number.isFinite(args.limit)) {
      parts.push(`limit ${Math.max(0, Math.floor(args.limit))}`);
    }
    if (typeof args?.search === "string" && args.search.trim()) {
      parts.push(`search "${clipInline(args.search, 28)}"`);
    }
    if (parts.length === 0) {
      parts.push("recent");
    }
  }

  return new Text(
    `📖 ${theme.fg("toolTitle", theme.bold(READ_BOARD_TOOL))} ${theme.fg("muted", `(${parts.join(" · ")})`)}`,
    0,
    0,
  );
}

function renderReadBoardResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions | undefined,
  theme: Theme,
  context?: RenderContextLike,
): Text {
  const fullText = extractFirstText(result?.content);
  if (isToolErrorResult(result, context)) {
    return new Text(
      theme.fg("error", fullText || "Failed to read board."),
      0,
      0,
    );
  }
  if (options?.expanded) {
    return new Text(theme.fg("toolOutput", fullText), 0, 0);
  }

  const details = result?.details as Record<string, unknown> | undefined;
  if (
    details &&
    Array.isArray(details.messages) &&
    typeof details.head === "number"
  ) {
    const board = details as unknown as ReadBoardResult;
    const count = board.messages.length;
    const expandHint =
      count > 0 ? formatExpandHint(options, theme, context) : "";
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `${count} message(s) (head #${board.head})`)}${expandHint}`,
      0,
      0,
    );
  }

  if (
    details &&
    Array.isArray(details.members) &&
    typeof details.boardHead === "number"
  ) {
    const status = details as unknown as SwarmRosterStatus;
    const expandHint = fullText.includes("\n")
      ? formatExpandHint(options, theme, context)
      : "";
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Roster: ${status.members.length} member(s) (head #${status.boardHead})`)}${expandHint}`,
      0,
      0,
    );
  }

  return new Text(
    `${theme.fg("success", "✓")} ${theme.fg("toolOutput", clipInline(fullText, 92))}`,
    0,
    0,
  );
}

function renderSwarmWaitCall(
  args: Partial<SwarmWaitToolParams> | undefined,
  theme: Theme,
): Text {
  const sinceText =
    typeof args?.since === "number" && Number.isFinite(args.since)
      ? `#${Math.max(0, Math.floor(args.since))}`
      : "#…";
  const parts = [`since ${sinceText}`];
  if (args?.mentions_only === false) {
    parts.push("all posts");
  }
  if (typeof args?.timeout_ms === "number" && Number.isFinite(args.timeout_ms)) {
    parts.push(`timeout ${Math.round(args.timeout_ms)}ms`);
  }
  return new Text(
    `⏳ ${theme.fg("toolTitle", theme.bold(SWARM_WAIT_TOOL))} ${theme.fg("muted", `(${parts.join(" · ")})`)}`,
    0,
    0,
  );
}

function renderSwarmWaitResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions | undefined,
  theme: Theme,
  context?: RenderContextLike,
): Text {
  const fullText = extractFirstText(result?.content);
  if (isToolErrorResult(result, context)) {
    return new Text(
      theme.fg("error", fullText || "Swarm wait failed."),
      0,
      0,
    );
  }
  if (options?.expanded) {
    return new Text(theme.fg("toolOutput", fullText), 0, 0);
  }

  const details = result?.details as Record<string, unknown> | undefined;
  if (details?.parked === true) {
    if (typeof details.member === "string") {
      const since =
        typeof details.since === "number" ? details.since : 0;
      return new Text(
        `💤 ${theme.fg("muted", `Parked @${details.member} in warm waiting (since #${since})`)}`,
        0,
        0,
      );
    }
    const waitRes = details as unknown as ParkOrchestratorWaitResult;
    const activeCount = Array.isArray(waitRes.activeMembers)
      ? waitRes.activeMembers.length
      : 0;
    const activeInfo =
      activeCount > 0
        ? theme.fg("dim", ` · ${activeCount} working`)
        : "";
    return new Text(
      `💤 ${theme.fg("muted", "Parked non-blocking (type anytime to redirect)")}${activeInfo}`,
      0,
      0,
    );
  }

  const head =
    details && typeof details.head === "number" ? details.head : "?";
  const wokeBy =
    details && typeof details.wokeBy === "string" ? details.wokeBy : "";
  const msgCount =
    details && Array.isArray(details.messages) ? details.messages.length : 0;
  const metaParts = [
    wokeBy ? `via ${wokeBy}` : "",
    msgCount > 0 ? `${msgCount} message(s)` : "",
  ].filter(Boolean);
  const meta =
    metaParts.length > 0 ? theme.fg("muted", ` · ${metaParts.join(" · ")}`) : "";
  const expandHint = fullText.includes("\n")
    ? formatExpandHint(options, theme, context)
    : "";
  return new Text(
    `⚡ ${theme.fg("accent", `Woke (head #${head})`)}${meta}${expandHint}`,
    0,
    0,
  );
}

// ============================================================================
// Orchestrator Swarm Tools (4 Core Tools)
// ============================================================================

export interface SwarmToolDeps {
  engine: ISwarmEngine;
  getCallerRole?: () => CallerRole;
  getCallerName?: () => string;
  /** Optional host callback when `swarm{action:"model"}` switches the orchestrator itself. */
  onOrchestratorModelSwitch?: (
    model: string,
    thinkingLevel?: ThinkingLevel,
    reason?: string,
  ) => Promise<SwitchModelResult | void> | SwitchModelResult | void;
}

export function createSwarmTool(deps: SwarmToolDeps): ToolDefinition {
  const getCallerRole = (): CallerRole => deps.getCallerRole?.() ?? "orchestrator";
  const getCallerName = (): string => deps.getCallerName?.() ?? ORCHESTRATOR_NAME;

  return defineTool({
    name: SWARM_TOOL,
    label: "Swarm",
    description:
      'Manage the dynamic Pi Swarm: set run title/direction ("title"), spawn workers/validators/sharded groups with optional context forking or isolated worktrees ("add"), inspect roster/channels ("status"), list models ("models"), hot-switch & resume a waiting member model ("model"), steer/redirect a member mid-flight ("steer"), stop a member ("stop"), permanently retire a member ("kill"), land a share/branch worktree ("merge"), manage channels ("channel"), or complete the run ("done").',
    promptSnippet:
      "Manage dynamic swarm members, steering, models, worktrees, channels, and run lifecycle.",
    promptGuidelines: [
      `Use ${SWARM_TOOL} with action="add" to delegate technical work to named workers or independent read-only validators (workspace="share" for shared worktrees or workspace="branch" for isolated clones; fork="<member>|orchestrator" to branch conversation history).`,
      `Use action="steer" to redirect a working or waiting member mid-flight; action="model" hot-switches and immediately resumes a member; never kill a waiting member as a pause; use action="stop" to pause it, action="merge" to land worktrees, action="kill" once integrated, and action="done" when complete.`,
    ],
    parameters: SwarmToolParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runToolSafe(async () => {
        const callerRole = getCallerRole();
        const callerName = getCallerName();

        switch (params.action) {
          case "title": {
            const title = params.title?.trim();
            const objective = params.objective?.trim();
            const strategy = params.strategy?.trim();
            const acceptanceCriteria = params.acceptance_criteria?.trim();
            const hasPhase = params.phase !== undefined;
            const phase = params.phase !== undefined ? (params.phase.trim() || null) : undefined;
            const hasMilestones = params.milestones !== undefined;
            const milestones: SwarmMilestone[] | undefined =
              params.milestones !== undefined
                ? params.milestones.map((m) => ({
                    label: m.label.trim(),
                    status: m.status,
                    ...(m.owner?.trim() ? { owner: m.owner.trim().replace(/^@/, "") } : {}),
                  }))
                : undefined;
            if (
              !title &&
              !objective &&
              !strategy &&
              !acceptanceCriteria &&
              !hasPhase &&
              !hasMilestones
            ) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'At least one of title, objective, strategy, acceptance_criteria, phase, or milestones is required for swarm{action:"title"}.',
              );
            }
            const directionPatch: DirectionUpdatePatch = {
              ...(title ? { title } : {}),
              ...(objective ? { objective } : {}),
              ...(strategy ? { strategy } : {}),
              ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
              ...(hasPhase ? { phase } : {}),
              ...(hasMilestones ? { milestones } : {}),
            };
            const updated = await (
              deps.engine.updateDirection as (
                patch: DirectionUpdatePatch,
                options?: { callerRole?: CallerRole; actor?: string },
              ) => Promise<SwarmRunState>
            )(directionPatch, {
              callerRole,
              actor: callerName,
            });
            const phaseSuffix = updated.phase ? ` | phase="${updated.phase}"` : "";
            const milestonesSuffix =
              updated.milestones && updated.milestones.length > 0
                ? ` | milestones=${updated.milestones.filter((m) => m.status === "done").length}/${updated.milestones.length} done`
                : "";
            return okResult(
              `Updated swarm direction/title ("${updated.title}"${phaseSuffix}${milestonesSuffix}).`,
              {
                runId: updated.id,
                title: updated.title,
                objective: updated.objective,
                strategy: updated.strategy,
                acceptanceCriteria: updated.acceptanceCriteria,
                ...(updated.phase !== undefined ? { phase: updated.phase } : {}),
                ...(updated.milestones !== undefined ? { milestones: updated.milestones } : {}),
              },
            );
          }

          case "add": {
            const name = params.name?.trim() ?? "";
            const brief = params.brief?.trim() ?? "";
            if (!name || !brief) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'Both "name" and "brief" are required for swarm{action:"add"}.',
              );
            }
            const members = await deps.engine.addMembers({
              name,
              role: params.role,
              brief,
              workspace: params.workspace,
              fork: params.fork,
              model: params.model,
              thinkingLevel: params.thinking_level,
              channels: params.channels,
              n: params.n,
              tasks: params.tasks,
              callerName,
              callerRole,
              hostContext: ctx,
            });
            return okResult(formatAddedMembers(members), { members });
          }

          case "status": {
            const snapshot = deps.engine.getSnapshot();
            const status = snapshotToRosterStatus(snapshot);
            if (!status) {
              return okResult(
                "No active Swarm run. Start a Swarm run with `/swarm <goal>`.",
                { activeRunId: null },
              );
            }
            return okResult(formatRosterStatusText(status), status);
          }

          case "models": {
            const snapshot = deps.engine.getSnapshot();
            const models = await deps.engine.listModels({
              all: params.all,
              hostContext: ctx,
            });
            return okResult(formatModelsList(models, snapshot), {
              models,
              roleModels: snapshot.roleModels,
            });
          }

          case "model": {
            const rawModel = params.model?.trim() ?? "";
            if (!rawModel && !params.thinking_level) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'Specify "model" and/or "thinking_level" for swarm{action:"model"}.',
              );
            }
            const targetName = params.name?.trim().replace(/^@/, "");
            const isOrchestratorTarget =
              !targetName ||
              targetName.toLowerCase() === ORCHESTRATOR_NAME ||
              targetName.toLowerCase() === "coordinator";
            if (isOrchestratorTarget && deps.onOrchestratorModelSwitch) {
              const snapshot = deps.engine.getSnapshot();
              const ctxModel = ctx?.model?.id
                ? ctx.model.provider
                  ? `${ctx.model.provider}/${ctx.model.id}`
                  : ctx.model.id
                : "";
              const effectiveOrchModel =
                rawModel ||
                snapshot.roleModels.orchestrator?.model?.trim() ||
                ctxModel;
              const res = await deps.onOrchestratorModelSwitch(
                effectiveOrchModel,
                params.thinking_level,
                params.reason,
              );
              const resolvedModel =
                res?.model?.trim() || effectiveOrchModel || "host-default";
              const resolvedThinking = res?.thinkingLevel ?? params.thinking_level;
              return okResult(
                `Switched orchestrator model -> ${resolvedModel}${resolvedThinking ? ` (${resolvedThinking})` : ""}.`,
                res ?? { targetName: ORCHESTRATOR_NAME, model: resolvedModel, thinkingLevel: resolvedThinking },
              );
            }
            const res = await deps.engine.switchModel({
              targetName,
              ...(rawModel ? { model: rawModel } : {}),
              thinkingLevel: params.thinking_level,
              reason: params.reason,
              callerName,
              callerRole,
              hostContext: ctx,
            });
            const suffix = res.resumed
              ? " and automatically resumed work (conversation history preserved)"
              : " (conversation history preserved)";
            return okResult(
              `Hot-switched @${res.targetName} model -> ${res.model}${res.thinkingLevel ? ` (${res.thinkingLevel})` : ""}${suffix}.`,
              res,
            );
          }

          case "steer": {
            const name = params.name?.trim().replace(/^@/, "") ?? "";
            const message = params.message?.trim() ?? "";
            if (!name || !message) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'Both "name" and "message" are required for swarm{action:"steer"}.',
              );
            }
            const steerRes = await deps.engine.steerMember(
              name,
              message,
              params.mode ?? "steer",
              { callerName, callerRole },
            );
            return okResult(
              `Delivered steering instruction to @${name} via ${steerRes.delivery}.`,
              { name, ...steerRes },
            );
          }

          case "stop": {
            const name = params.name?.trim().replace(/^@/, "") ?? "";
            if (!name) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'name is required for swarm{action:"stop"}.',
              );
            }
            await deps.engine.stopMember(name, {
              reason: params.reason,
              callerName,
              callerRole,
            });
            return okResult(
              `Stopped @${name}${params.reason ? ` (${params.reason})` : ""}.`,
              { name, stopped: true },
            );
          }

          case "kill": {
            const name = params.name?.trim().replace(/^@/, "") ?? "";
            if (!name) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'name is required for swarm{action:"kill"}.',
              );
            }
            await deps.engine.killMember(name, {
              reason: params.reason,
              force: params.force,
              callerName,
              callerRole,
            });
            return okResult(
              `Killed @${name}${params.reason ? ` (${params.reason})` : ""}.`,
              { name, killed: true },
            );
          }

          case "merge": {
            const name = params.name?.trim().replace(/^@/, "") ?? "";
            if (!name) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'name is required for swarm{action:"merge"}.',
              );
            }
            const baseBranch =
              deps.engine.getSnapshot().run?.baseBranch ?? "baseBranch";
            const merged = await deps.engine.mergeMember(name, {
              callerName,
              callerRole,
            });
            if (!merged) {
              return okResult(
                `@${name} uses inherit workspace (no separate branch to merge).`,
                { name, merged: false },
              );
            }
            if (merged.strategy === "noop") {
              return okResult(
                `⚠ Merge noop: @${name} has 0 commits ahead of ${baseBranch} — verify @${name} committed its edits before killing!`,
                { name, baseBranch, ...merged },
              );
            }
            const maxListedFiles = 15;
            const shownFiles = merged.changedFiles.slice(0, maxListedFiles);
            const overflowFiles =
              merged.changedFiles.length > maxListedFiles
                ? `, +${merged.changedFiles.length - maxListedFiles} more`
                : "";
            const filesLine =
              merged.changedFiles.length > 0
                ? `\nChanged files (${merged.changedFiles.length}): ${shownFiles.join(", ")}${overflowFiles}`
                : "\nChanged files: (none)";
            const verifyLine = `\nNext: run post-merge verification (typecheck / tests) on ${baseBranch} before completing the run.`;
            return okResult(
              `Merged @${name} (${merged.strategy}) -> ${merged.mergedCommitSha.slice(0, 12)} (${merged.changedFiles.length} file(s)).${filesLine}${verifyLine}`,
              { name, baseBranch, ...merged },
            );
          }

          case "channel": {
            const op = normalizeChannelAction(params.op);
            const result = await deps.engine.manageChannel({
              action: op,
              name: params.channel,
              topic: params.topic,
              member: params.name?.trim().replace(/^@/, ""),
              callerName,
              callerRole,
            });
            return okResult(result.summary, result);
          }

          case "done": {
            const summary = params.summary?.trim() ?? "";
            if (!summary) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'summary is required for swarm{action:"done"}.',
              );
            }

            let snapshot = deps.engine.getSnapshot();
            if (!params.force && snapshot.workingMemberNames.length > 0) {
              // Allow in-flight post-turn persistence (e.g. just-resolved turn flushing run.json) to settle briefly
              for (
                let attempt = 0;
                attempt < 5 && snapshot.workingMemberNames.length > 0;
                attempt++
              ) {
                await new Promise<void>((resolve) => {
                  const t = setTimeout(resolve, 5);
                  t.unref?.();
                });
                snapshot = deps.engine.getSnapshot();
              }
            }

            if (!params.force && snapshot.workingMemberNames.length > 0) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Cannot complete Swarm while member(s) are still working: ${snapshot.workingMemberNames.map((n) => "@" + n).join(", ")}. Call swarm_wait to let them finish, or stop/kill them first (or pass force:true).`,
              );
            }

            const preDoneRun = snapshot.run;
            const orderedMembers = preDoneRun
              ? preDoneRun.memberOrder.length > 0
                ? preDoneRun.memberOrder
                    .map((n) => preDoneRun.members[n])
                    .filter((m): m is SwarmMemberRecord => Boolean(m))
                : Object.values(preDoneRun.members)
              : [];
            const unmergedMembers = orderedMembers.filter(
              (m) =>
                m.state !== "killed" &&
                (m.workspace === "share" || m.workspace === "branch") &&
                !m.mergedCommitSha,
            );

            const completed = await deps.engine.completeRun({
              summary,
              teardown: params.teardown,
              deleteBranches: params.delete_branches,
              callerRole,
              actor: callerName,
            });

            const unmergedLabels = unmergedMembers.map((m) =>
              m.branch ? `@${m.name} (${m.workspace}:${m.branch})` : `@${m.name} (${m.workspace})`,
            );
            const unmergedWarning =
              unmergedMembers.length > 0
                ? `\n⚠ Warning: ${unmergedMembers.length} unmerged ${unmergedMembers.length === 1 ? "worktree branch remains" : "worktree branches remain"} on ${completed.baseBranch}: ${unmergedLabels.join(", ")}. Their commits were NOT merged into ${completed.baseBranch}.`
                : "";

            return okResult(
              `Swarm run "${completed.title}" (${completed.id}) completed: ${summary}${unmergedWarning}`,
              {
                runId: completed.id,
                status: completed.status,
                summary,
                ...(unmergedMembers.length > 0
                  ? { unmergedMembers: unmergedMembers.map((m) => m.name) }
                  : {}),
              },
            );
          }

          default:
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Unsupported swarm action: ${String(params.action)}`,
            );
        }
      });
    },
    renderCall(args, theme) {
      return renderSwarmCall(args, theme, {
        defaultRole: "worker",
        selfTarget: ORCHESTRATOR_NAME,
      });
    },
    renderResult(result, options, theme, context) {
      return renderSwarmResult(result, options, theme, context);
    },
  });
}

export function createPostMessageTool(deps: SwarmToolDeps): ToolDefinition {
  const getCallerRole = (): CallerRole => deps.getCallerRole?.() ?? "orchestrator";
  const getCallerName = (): string => deps.getCallerName?.() ?? ORCHESTRATOR_NAME;

  return defineTool({
    name: POST_MESSAGE_TOOL,
    label: "Post Message",
    description:
      "Post a concise message to the shared Swarm message board. Use `@name` to wake a member, `@<prefix>` for a sharded group, `@#<channel>` for a channel (never `@#main`), or `@all` for swarm-wide rules/decisions. Reference earlier posts by `#seq`.",
    promptSnippet: "Post a message (with optional @mentions / @#channel) to the shared board.",
    promptGuidelines: [
      `Use ${POST_MESSAGE_TOOL} for concise coordination, decisions, or waking waiting members. Reference prior reports by #seq rather than copy-pasting.`,
    ],
    parameters: PostMessageToolParamsSchema,
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const text = params.text.trim();
        if (!text) {
          throw new SwarmProtocolError("INVALID_INPUT", "Board message text must be non-empty.");
        }
        const msg = await deps.engine.postMessage({
          from: getCallerName(),
          fromRole: getCallerRole(),
          text,
          channel: normalizeOptionalChannel(params.channel),
          kind: params.kind as BoardMessageKind | undefined,
        });
        const targets = [
          ...msg.mentions.map((m) => `@${m}`),
          ...msg.channelMentions.map((c) => `@#${c}`),
        ];
        const targetText = targets.length > 0 ? ` (notified: ${targets.join(", ")})` : "";
        return okResult(`Posted #${msg.seq} to #${msg.channel}${targetText}.`, msg);
      });
    },
    renderCall(args, theme, context) {
      return renderPostMessageCall(args, theme, DEFAULT_CHANNEL, context);
    },
    renderResult(result, options, theme, context) {
      return renderPostMessageResult(result, options, theme, context);
    },
  });
}

export function createReadBoardTool(deps: SwarmToolDeps): ToolDefinition {
  return defineTool({
    name: READ_BOARD_TOOL,
    label: "Read Board",
    description:
      "Read messages from the shared Swarm message board (oldest first), or pass `status: true` to inspect the live member roster instead. Use `seqs` for zero-copy `#seq` lookups, `since` for unread messages, `channel` to filter (`*` for all), or `search` for substring filtering.",
    promptSnippet: "Read shared board messages (#seq/since/channel/search) or inspect roster (status:true).",
    parameters: ReadBoardToolParamsSchema,
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        if (params.status) {
          const snapshot = deps.engine.getSnapshot();
          const status = snapshotToRosterStatus(snapshot);
          if (!status) {
            return okResult("No active Swarm run.", { activeRunId: null });
          }
          return okResult(formatRosterStatusText(status), status);
        }

        const res = await deps.engine.readBoard({
          since: params.since,
          seqs: params.seqs,
          limit: params.limit,
          channel: normalizeOptionalChannel(params.channel),
          search: params.search,
        });

        if (res.messages.length === 0) {
          return okResult(`Board has no matching messages (head: #${res.head}).`, res);
        }
        const perMessageCap =
          params.seqs && params.seqs.length > 0 ? undefined : 4000;
        const formatted = res.messages.map((m) =>
          formatBoardEntryFull(m, perMessageCap),
        );
        return okResult(
          `Swarm Board (head: #${res.head}, showing ${res.messages.length}):\n\n${formatted.join("\n\n")}`,
          res,
        );
      });
    },
    renderCall(args, theme) {
      return renderReadBoardCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderReadBoardResult(result, options, theme, context);
    },
  });
}

export function createSwarmWaitTool(deps: SwarmToolDeps): ToolDefinition {
  return defineTool({
    name: SWARM_WAIT_TOOL,
    label: "Swarm Wait",
    description:
      "End your current turn cleanly and sleep (non-blocking) until a swarm member posts a message addressing you (or any message when mentions_only=false), all workers park, or the user sends a new message. Always pass the highest `#seq` you have actually read as `since`.",
    promptSnippet: "End turn and sleep until woken by a board post, all_idle, or user message.",
    promptGuidelines: [
      `Call ${SWARM_WAIT_TOOL} after spawning or waking workers instead of polling ${READ_BOARD_TOOL} in a loop. It ends your turn cleanly so the user can message you anytime while workers run. Pass the highest #seq you have read as since.`,
    ],
    executionMode: "sequential",
    parameters: SwarmWaitToolParamsSchema,
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const res = await deps.engine.parkOrchestratorWait({
          since: params.since,
          mentionsOnly: params.mentions_only ?? true,
          timeoutMs: params.timeout_ms,
        });

        if (res.parked) {
          const activeLabel =
            res.activeMembers.length > 0
              ? res.activeMembers.map((m) => `@${m}`).join(", ")
              : "none";
          return {
            content: [
              {
                type: "text",
                text: `Parked @${ORCHESTRATOR_NAME} in non-blocking swarm_wait (since #${params.since}, active: ${activeLabel}, head: #${res.head}). Ending turn now — you will wake automatically when a matching post arrives, all workers park, or the user sends a message.`,
              },
            ],
            details: res,
            terminate: true,
          };
        }

        const header = `swarm_wait woke immediately (${res.wokeBy ?? "message"}, head: #${res.head}): ${res.summary}`;
        if (res.messages.length === 0) {
          return okResult(header, res);
        }
        const formatted = res.messages
          .map((m) => formatBoardEntryFull(m, 2500))
          .join("\n\n");
        return okResult(`${header}\n\n${formatted}`, res);
      });
    },
    renderCall(args, theme) {
      return renderSwarmWaitCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderSwarmWaitResult(result, options, theme, context);
    },
  });
}

/**
 * Creates the 4 core Antigravity Swarm tools for the Orchestrator (main Pi session):
 * `swarm`, `post_message`, `read_board`, `swarm_wait`.
 */
export function createSwarmTools(deps: SwarmToolDeps): ToolDefinition[] {
  return [
    createSwarmTool(deps),
    createPostMessageTool(deps),
    createReadBoardTool(deps),
    createSwarmWaitTool(deps),
  ];
}

/**
 * Registers all 4 core Antigravity Swarm tools on a Pi ExtensionAPI instance.
 */
export function registerSwarmTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  deps: SwarmToolDeps,
): ToolDefinition[] {
  const tools = createSwarmTools(deps);
  for (const tool of tools) {
    pi.registerTool(tool);
  }
  return tools;
}

// ============================================================================
// Member-Scoped Swarm Tools (Injected Inside Worker & Validator AgentSessions)
// ============================================================================

export interface MemberScopedToolContext {
  name: string;
  role: SwarmMemberRole;
  runId: string;
  defaultChannel?: string;
  /** Invoked when a member calls `swarm_wait` so transport/engine can record `since` & `mentionsOnly`. */
  onWaitRecorded?: (wait: { since: number; mentionsOnly: boolean }) => void;
  /** Invoked when a working member schedules a deferred self model switch. */
  onSelfModelSwitchScheduled?: () => void;
}

/**
 * Creates the 4 scoped Antigravity Swarm tools (`swarm`, `post_message`, `read_board`, `swarm_wait`)
 * injected inside every Worker and Validator `AgentSession`.
 */
export function createMemberScopedTools(
  bridge: MemberEngineBridge,
  member: MemberScopedToolContext,
): ToolDefinition[] {
  const primaryChannel = member.defaultChannel ?? DEFAULT_CHANNEL;

  // --------------------------------------------------------------------------
  // 1. post_message
  // --------------------------------------------------------------------------
  const postMessageTool = defineTool({
    name: POST_MESSAGE_TOOL,
    label: "Post Message",
    description:
      "Post a concise message to the shared Swarm message board. Use `@name` as a wakeup doorbell only for peers who must act next; start completion posts with `[done]` after `@<peer-or-parent>`.",
    promptSnippet: "Post a concise message (with @mentions) to the shared Swarm board.",
    promptGuidelines: [
      `Use ${POST_MESSAGE_TOOL} for concise handoffs, questions, findings, or final [done] reports. Reference earlier posts as #seq instead of copying them.`,
    ],
    parameters: Type.Object({
      text: Type.String({
        description: "Concise board message text (include @name to wake specific peers).",
      }),
      channel: Type.Optional(
        Type.String({
          description: `Optional target channel (defaults to your primary channel "${primaryChannel}").`,
        }),
      ),
      kind: Type.Optional(
        stringEnum(BOARD_MESSAGE_KINDS, {
          description: 'Optional message kind (defaults to "chat").',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const text = params.text.trim();
        if (!text) {
          throw new SwarmProtocolError("INVALID_INPUT", "Board message text must be non-empty.");
        }
        const msg = await bridge.postMessage({
          text,
          channel: normalizeOptionalChannel(params.channel),
          kind: params.kind as BoardMessageKind | undefined,
        });
        const targets = [
          ...msg.mentions.map((m) => `@${m}`),
          ...msg.channelMentions.map((c) => `@#${c}`),
        ];
        const targetText =
          targets.length > 0
            ? ` (notified: ${targets.join(", ")})`
            : " (no @mention included — no peer was woken)";
        return okResult(`Posted #${msg.seq} to #${msg.channel}${targetText}.`, msg);
      });
    },
    renderCall(args, theme, context) {
      return renderPostMessageCall(args, theme, primaryChannel, context);
    },
    renderResult(result, options, theme, context) {
      return renderPostMessageResult(result, options, theme, context);
    },
  });

  // --------------------------------------------------------------------------
  // 2. read_board
  // --------------------------------------------------------------------------
  const readBoardTool = defineTool({
    name: READ_BOARD_TOOL,
    label: "Read Board",
    description:
      "Read messages from the shared Swarm message board (oldest first), or pass `status: true` to inspect the live member roster.",
    promptSnippet: "Read shared board messages (#seq/since/channel/search) or roster (status:true).",
    parameters: Type.Object({
      since: Type.Optional(
        Type.Integer({ minimum: 0, description: "Return oldest messages with seq > since." }),
      ),
      seqs: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0 }), { description: "Fetch exact sequence numbers only." }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 0, description: "Maximum number of messages to return (default 20)." }),
      ),
      channel: Type.Optional(
        Type.String({ description: 'Optional channel filter, or "*" for all channels.' }),
      ),
      status: Type.Optional(
        Type.Boolean({ description: "When true, return the live member roster instead of messages." }),
      ),
      search: Type.Optional(
        Type.String({ description: "Case-insensitive substring filter." }),
      ),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        if (params.status) {
          const status = await bridge.getStatus();
          return okResult(formatRosterStatusText(status), status);
        }
        const res = await bridge.readBoard({
          since: params.since,
          seqs: params.seqs,
          limit: params.limit,
          channel: normalizeOptionalChannel(params.channel),
          search: params.search,
        });
        if (res.messages.length === 0) {
          return okResult(`Board has no matching messages (head: #${res.head}).`, res);
        }
        const perMessageCap =
          params.seqs && params.seqs.length > 0 ? undefined : 4000;
        const formatted = res.messages.map((m) =>
          formatBoardEntryFull(m, perMessageCap),
        );
        return okResult(
          `Swarm Board (head: #${res.head}, showing ${res.messages.length}):\n\n${formatted.join("\n\n")}`,
          res,
        );
      });
    },
    renderCall(args, theme) {
      return renderReadBoardCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderReadBoardResult(result, options, theme, context);
    },
  });

  // --------------------------------------------------------------------------
  // 3. swarm_wait (terminates current turn cleanly & parks warm in `waiting`!)
  // --------------------------------------------------------------------------
  const swarmWaitTool = defineTool({
    name: SWARM_WAIT_TOOL,
    label: "Swarm Wait",
    description:
      "End your current turn and sleep in warm `waiting` state (zero tokens, full memory preserved) until another swarm member posts a message addressing you. Always pass the highest `#seq` you have read as `since`.",
    promptSnippet: "Park in warm waiting state until woken by a board message.",
    promptGuidelines: [
      `When you finish your work or are waiting for a peer response, post your update via ${POST_MESSAGE_TOOL} and call ${SWARM_WAIT_TOOL} to sleep cleanly with zero token cost.`,
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      since: Type.Integer({
        minimum: 0,
        description: "Highest sequence number you have already read.",
      }),
      mentions_only: Type.Optional(
        Type.Boolean({
          description:
            "Wake only for messages mentioning you, your group prefix, your subscribed channel, or @all (default true).",
          default: true,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const since = Number.isFinite(params.since) ? Math.max(0, Math.floor(params.since)) : 0;
      const mentionsOnly = params.mentions_only ?? true;
      member.onWaitRecorded?.({ since, mentionsOnly });
      return {
        content: [
          {
            type: "text",
            text: `Parking @${member.name} in warm waiting state (since #${since}, mentions_only=${mentionsOnly}).`,
          },
        ],
        details: {
          member: member.name,
          since,
          mentionsOnly,
          parked: true,
        },
        terminate: true,
      };
    },
    renderCall(args, theme) {
      return renderSwarmWaitCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderSwarmWaitResult(result, options, theme, context);
    },
  });

  // --------------------------------------------------------------------------
  // 4. swarm (scoped: status, models, add, model, steer, stop, kill, channel)
  // --------------------------------------------------------------------------
  const scopedSwarmTool = defineTool({
    name: SWARM_TOOL,
    label: "Swarm",
    description:
      member.role === "validator"
        ? 'Scoped Swarm helper tool for read-only validators: inspect roster ("status"), list models ("models"), spawn read-only validator helpers ("add"), switch model for self or own helpers ("model"), steer/stop/kill own helpers ("steer"/"stop"/"kill"), or list/join/leave channels ("channel").'
        : 'Scoped Swarm helper tool for workers: inspect roster ("status"), list models ("models"), spawn helper workers/validators reporting back to you ("add"), switch model for self or own helpers ("model"), steer/stop/kill own helpers ("steer"/"stop"/"kill"), or list/join/leave channels ("channel"). Cannot call title/merge/done or touch other members.',
    promptSnippet:
      "Inspect swarm status/models, manage your own helpers (add/model/steer/stop/kill), or join/leave channels.",
    parameters: Type.Object({
      action: stringEnum(MEMBER_SWARM_ACTIONS, {
        description:
          'Allowed member actions: "status" | "models" | "add" | "model" | "steer" | "stop" | "kill" | "channel".',
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Helper name (for "add"/"steer"/"stop"/"kill"), target name (self or own helper for "model"/"channel").',
        }),
      ),
      message: Type.Optional(
        Type.String({
          description: 'Steering instruction (required for action="steer").',
        }),
      ),
      mode: Type.Optional(
        stringEnum(["steer", "followUp"], {
          description: 'Delivery mode for action="steer" (default "steer").',
        }),
      ),
      role: Type.Optional(
        stringEnum(
          member.role === "validator" ? (["validator"] as const) : MEMBER_ROLES,
          {
            description:
              member.role === "validator"
                ? 'Read-only "validator" only.'
                : 'Helper role: "worker" (default) or read-only "validator".',
          },
        ),
      ),
      brief: Type.Optional(
        Type.String({
          description: `Public brief for helper (tell it to report back to @${member.name}).`,
        }),
      ),
      workspace: Type.Optional(
        stringEnum(WORKSPACE_MODES, {
          description: 'Workspace mode for helper: "inherit" (default), "share", or "branch".',
        }),
      ),
      fork: Type.Optional(
        Type.String({
          description: `Optional member name (e.g. "${member.name}") whose conversation history to fork.`,
        }),
      ),
      model: Type.Optional(
        Type.String({ description: 'Model identifier for "add" or "model".' }),
      ),
      thinking_level: Type.Optional(
        stringEnum(THINKING_LEVEL_VALUES, {
          description: 'Optional thinking level for "add" or "model".',
        }),
      ),
      channels: Type.Optional(
        Type.Array(Type.String(), { description: 'Optional channels for "add".' }),
      ),
      n: Type.Optional(
        Type.Integer({ minimum: 1, description: 'Number of homogeneous helper copies for "add".' }),
      ),
      tasks: Type.Optional(
        Type.Array(Type.String(), { description: 'Per-helper slice targets for sharded "add".' }),
      ),
      all: Type.Optional(
        Type.Boolean({ description: 'For "models": list every available model.' }),
      ),
      op: Type.Optional(
        stringEnum(MEMBER_CHANNEL_ACTIONS, {
          description: 'Channel op ("list" | "join" | "leave").',
        }),
      ),
      channel: Type.Optional(
        Type.String({ description: 'Channel name for action="channel".' }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: 'For action="kill": force removal even if isolated worktree has uncommitted changes.',
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: 'Optional reason for "model", "stop", or "kill".' }),
      ),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        switch (params.action as string) {
          case "title":
          case "merge":
          case "done":
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Member "@${member.name}" (${member.role}) is not permitted to call swarm{action:"${params.action}"}. Only @${ORCHESTRATOR_NAME} can perform "${params.action}".`,
            );

          case "status": {
            const status = await bridge.getStatus();
            return okResult(formatRosterStatusText(status), status);
          }

          case "models": {
            const models = await bridge.listModels({ all: params.all });
            return okResult(formatModelsList(models), { models });
          }

          case "add": {
            const name = params.name?.trim() ?? "";
            const brief = params.brief?.trim() ?? "";
            if (!name || !brief) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'Both "name" and "brief" are required for swarm{action:"add"}.',
              );
            }
            if (member.role === "validator" && params.role && params.role !== "validator") {
              throw new SwarmProtocolError(
                "ROLE_FORBIDDEN",
                `Read-only validator "@${member.name}" may only add read-only "validator" helpers.`,
              );
            }
            const added = await bridge.addHelper({
              name,
              role: member.role === "validator" ? "validator" : params.role,
              brief,
              workspace: params.workspace,
              fork: params.fork,
              model: params.model,
              thinkingLevel: params.thinking_level,
              channels: params.channels,
              n: params.n,
              tasks: params.tasks,
            });
            return okResult(formatAddedMembers(added), { members: added });
          }

          case "model": {
            const rawModel = params.model?.trim() ?? "";
            if (!rawModel && !params.thinking_level) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'Specify "model" and/or "thinking_level" for swarm{action:"model"}.',
              );
            }
            const res = await bridge.switchModel(
              params.name?.trim().replace(/^@/, "") || member.name,
              rawModel,
              params.thinking_level,
              params.reason,
            );
            if (res.deferred) {
              member.onSelfModelSwitchScheduled?.();
              return {
                content: [
                  {
                    type: "text",
                    text: `Scheduled self model switch -> ${res.model}${res.thinkingLevel ? ` (${res.thinkingLevel})` : ""}. Ending turn now; you will immediately resume on the new model with conversation history preserved.`,
                  },
                ],
                details: res,
                terminate: true,
              };
            }
            return okResult(
              `Switched @${res.targetName} model -> ${res.model}${res.thinkingLevel ? ` (${res.thinkingLevel})` : ""}${res.resumed ? " and resumed work" : ""}.`,
              res,
            );
          }

          case "steer": {
            const name = params.name?.trim().replace(/^@/, "") ?? "";
            const message = params.message?.trim() ?? "";
            if (!name || !message) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'Both "name" and "message" are required for swarm{action:"steer"}.',
              );
            }
            if (!bridge.steerHelper) {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Steering helpers is not supported in this context.`,
              );
            }
            const steerRes = await bridge.steerHelper(
              name,
              message,
              params.mode ?? "steer",
            );
            return okResult(
              `Steered helper @${name} via ${steerRes.delivery}.`,
              { name, ...steerRes },
            );
          }

          case "stop": {
            const name = params.name?.trim().replace(/^@/, "") ?? "";
            if (!name) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'name is required for swarm{action:"stop"}.',
              );
            }
            if (!bridge.stopHelper) {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Stopping helpers is not supported in this context.`,
              );
            }
            await bridge.stopHelper(name, params.reason);
            return okResult(`Stopped helper @${name}.`, { name, stopped: true });
          }

          case "kill": {
            const name = params.name?.trim().replace(/^@/, "") ?? "";
            if (!name) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                'name is required for swarm{action:"kill"}.',
              );
            }
            await bridge.killHelper(name, params.reason, params.force);
            return okResult(`Killed helper @${name}.`, { name, killed: true });
          }

          case "channel": {
            const op = normalizeChannelAction(params.op);
            const res = await bridge.manageChannel({
              action: op,
              name: params.channel,
              member: params.name?.trim().replace(/^@/, "") || member.name,
              callerName: member.name,
              callerRole: member.role,
            });
            return okResult(res.summary, res);
          }

          default:
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Unsupported swarm action: ${String(params.action)}`,
            );
        }
      });
    },
    renderCall(args, theme) {
      return renderSwarmCall(args as Partial<SwarmToolParams> | undefined, theme, {
        defaultRole: member.role === "validator" ? "validator" : "worker",
        selfTarget: member.name,
      });
    },
    renderResult(result, options, theme, context) {
      return renderSwarmResult(result, options, theme, context);
    },
  });

  return [scopedSwarmTool, postMessageTool, readBoardTool, swarmWaitTool];
}

/** Alias for `createMemberScopedTools`. */
export const createMemberTools = createMemberScopedTools;

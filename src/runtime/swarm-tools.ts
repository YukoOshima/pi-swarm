import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import {
  ALL_MENTION_NAME,
  ASSERTION_STATUSES,
  DEFAULT_CHANNEL,
  FEATURE_STATUSES,
  HANDOFF_RESOLUTIONS,
  ORCHESTRATOR_NAME,
  POST_MESSAGE_TOOL,
  READ_BOARD_TOOL,
  SWARM_ACTIONS,
  SWARM_CHANNEL_ACTIONS,
  SWARM_MISSION_OPS,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../constants.js";
import {
  type AssertionStatus,
  type AvailableModelInfo,
  type BoardMessage,
  type BoardMessageKind,
  type CallerRole,
  type FeatureStatus,
  type HandoffItemResolution,
  type ISwarmEngine,
  isSwarmProtocolError,
  type ManageMissionInput,
  type ManageMissionResult,
  type MemberEngineBridge,
  type MergeBranchResult,
  type MissionAssertionInput,
  type MissionFeatureInput,
  type MissionServiceEntry,
  type ParkOrchestratorWaitResult,
  type ReadBoardResult,
  type SwarmChannelAction,
  type SwarmMemberRecord,
  type SwarmMemberRole,
  type SwarmMilestone,
  type SwarmMissionOp,
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
  "mission",
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
      'Swarm action: "title" | "add" | "status" | "models" | "model" | "steer" | "stop" | "kill" | "merge" | "channel" | "mission" | "done".',
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
        'Member name (or base name with n/tasks for "add", target member for "model"/"steer"/"stop"/"kill"/"merge", or member to join/leave for "channel"). Use neutral engineering/QA handles (e.g. "scout", "parser", "validator", "probe"); offensive/red-team words ("attack", "exploit", "hack", etc.) are rejected to avoid provider safety-filter false positives.',
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
      description:
        'Member role for action="add": "worker" (default) or read-only "validator" (includes an isolated OS scratch directory for temporary builds/fixtures/mutation checks; never spawn a "worker" solely to run temporary verification builds).',
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
  mission_op: Type.Optional(
    stringEnum(SWARM_MISSION_OPS, {
      description:
        'Sub-operation for action="mission": "status" | "upsert_assertions" | "remove_assertion" | "verify_assertion" | "override_assertion" | "upsert_features" | "update_feature" | "dispatch_ready" | "resolve_handoff" | "set_manifest" | "read_library" | "write_library".',
    }),
  ),
  assertions: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({
          description: 'Assertion ID (e.g. "VAL-AUTH-001").',
        }),
        title: Type.String({
          description: "Short assertion title.",
        }),
        description: Type.String({
          description: "Concrete testable behavioral requirement.",
        }),
        evidence_required: Type.Optional(
          Type.String({
            description: "Required verification command/evidence to prove this assertion.",
          }),
        ),
        status: Type.Optional(
          stringEnum(ASSERTION_STATUSES, {
            description: 'Optional assertion status ("pending" | "passed" | "failed" | "blocked").',
          }),
        ),
      }),
      {
        description: 'VAL-* assertions to add or update for mission_op="upsert_assertions".',
      },
    ),
  ),
  assertion_id: Type.Optional(
    Type.String({
      description:
        'Target VAL-* assertion ID for mission_op="verify_assertion", "override_assertion", or "remove_assertion".',
    }),
  ),
  assertion_status: Type.Optional(
    stringEnum(ASSERTION_STATUSES, {
      description:
        'Verification outcome for mission_op="verify_assertion": "pending" | "passed" | "failed" | "blocked".',
    }),
  ),
  evidence: Type.Optional(
    Type.String({
      description:
        'Concrete command/inspection evidence (required when assertion_status is "passed" or "failed").',
    }),
  ),
  features: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({
          description: 'Unique feature ID (e.g. "feat-auth-jwt").',
        }),
        title: Type.String({
          description: "Short feature title.",
        }),
        description: Type.String({
          description: "Feature implementation scope and details.",
        }),
        milestone: Type.String({
          description: 'Milestone label this feature belongs to (never a sealed milestone).',
        }),
        depends_on: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional upstream feature IDs that must complete before this feature.",
          }),
        ),
        files_owned: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional exclusive files/directories owned by this feature.",
          }),
        ),
        preconditions: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional preconditions before starting.",
          }),
        ),
        expected_behavior: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional expected observable behaviors.",
          }),
        ),
        verification_steps: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional runnable verification steps.",
          }),
        ),
        fulfills: Type.Optional(
          Type.Array(Type.String(), {
            description: "VAL-* assertion IDs claimed by this feature.",
          }),
        ),
        status: Type.Optional(
          stringEnum(FEATURE_STATUSES, {
            description:
              'Optional feature status: "pending" | "in_progress" | "completed" | "failed" | "cancelled".',
          }),
        ),
        assigned_member: Type.Optional(
          Type.String({
            description: "Optional assigned member handle.",
          }),
        ),
      }),
      {
        description: 'Mission features to add or update for mission_op="upsert_features".',
      },
    ),
  ),
  prepend: Type.Optional(
    Type.Boolean({
      description:
        'For mission_op="upsert_features": when true, insert new urgent/fix features at the TOP of pending features.',
    }),
  ),
  feature_id: Type.Optional(
    Type.String({
      description: 'Target feature ID for mission_op="update_feature".',
    }),
  ),
  feature_status: Type.Optional(
    stringEnum(FEATURE_STATUSES, {
      description:
        'Updated feature status for mission_op="update_feature": "pending" | "in_progress" | "completed" | "failed" | "cancelled".',
    }),
  ),
  assigned_member: Type.Optional(
    Type.String({
      description: 'Assigned member handle for mission_op="update_feature".',
    }),
  ),
  merged_commit_sha: Type.Optional(
    Type.String({
      description: 'Optional merged commit SHA for mission_op="update_feature".',
    }),
  ),
  handoff_id: Type.Optional(
    Type.String({
      description: 'Open handoff item ID (e.g. "HO-5-1") for mission_op="resolve_handoff".',
    }),
  ),
  resolution: Type.Optional(
    stringEnum(HANDOFF_RESOLUTIONS, {
      description: 'Handoff resolution for mission_op="resolve_handoff": "tracked" | "dismissed".',
    }),
  ),
  tracked_feature_id: Type.Optional(
    Type.String({
      description:
        'Feature ID tracking an open handoff item (required when resolution="tracked").',
    }),
  ),
  justification: Type.Optional(
    Type.String({
      description:
        'Concrete technical justification (>= 20 chars for resolve_handoff resolution="dismissed"; >= 30 chars for audited mission_op="override_assertion"; no lazy deferrals).',
    }),
  ),
  commands: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({
          description: 'Command key (e.g. "init", "test", "typecheck", "lint", "build").',
        }),
        command: Type.String({
          description: "Exact runnable shell command.",
        }),
      }),
      {
        description: 'Operational command entries for mission_op="set_manifest".',
      },
    ),
  ),
  services: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({
          description: 'Unique service name (e.g. "api", "web", "redis").',
        }),
        start: Type.String({
          description: "Shell command to start the service.",
        }),
        stop: Type.Optional(
          Type.String({
            description: "Optional shell command to stop the service.",
          }),
        ),
        healthcheck: Type.Optional(
          Type.String({
            description: "Optional healthcheck URL or command.",
          }),
        ),
        port: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 65535,
            description:
              "Optional reserved TCP port (1..65535; must be unique across services).",
          }),
        ),
        depends_on: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional upstream service names this service depends on.",
          }),
        ),
      }),
      {
        description: 'Service and port manifest entries for mission_op="set_manifest".',
      },
    ),
  ),
  boundaries: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Operational boundary rules for mission_op="set_manifest".',
    }),
  ),
  library_topic: Type.Optional(
    Type.String({
      description:
        'Shared library topic name (e.g. "architecture", "environment", "testing") for mission_op="read_library" or "write_library" (omit on read_library to list topics).',
    }),
  ),
  library_content: Type.Optional(
    Type.String({
      description: 'Markdown content to write or append for mission_op="write_library".',
    }),
  ),
  library_append: Type.Optional(
    Type.Boolean({
      description:
        'For mission_op="write_library": when true, append to existing topic content instead of replacing.',
    }),
  ),
  max_dispatch: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 64,
      description:
        'Optional cap on parallel workers spawned in one batch for mission_op="dispatch_ready".',
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        'Force override when explicitly authorized (for action="kill", action="mission", or human /swarm done --force; LLM orchestrator cannot use force:true on action="done").',
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
  feature_id: Type.Optional(
    Type.String({
      description:
        "Mission feature ID this message/deliverable implements (auto-updates assigned feature on [done]; required when multiple features are assigned to you).",
    }),
  ),
  discovered_issues: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional non-blocking bugs or tech-debt items discovered while working (auto-appended as open handoff items).",
    }),
  ),
  left_undone: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional incomplete items left undone on this feature (auto-appended as open incomplete_work handoff items).",
    }),
  ),
  verification_evidence: Type.Optional(
    Type.String({
      description:
        "Concrete verification evidence (>= 10 chars with exact commands run and exit/pass counts; required when reporting [done] on a Mission feature unless left_undone is non-empty).",
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
      const parkBlocked =
        m.lastParkBlockedSeq !== undefined
          ? ` lastParkBlockedSeq=#${m.lastParkBlockedSeq}`
          : "";
      const info = m.currentActivity
        ? ` — ${m.currentActivity}`
        : m.parkedOn
          ? ` — ${m.parkedOn}`
          : "";
      lines.push(
        `- @${m.name} (${m.role}) [${m.state}] ws=${ws}${cwd}${merged} parent=@${m.parentName}${model} turns=${m.turns}${lastPost}${parkBlocked}${info}`,
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
      ...(m.lastParkBlockedSeq !== undefined
        ? { lastParkBlockedSeq: m.lastParkBlockedSeq }
        : {}),
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

function normalizeMissionOp(raw?: string): SwarmMissionOp {
  const value = (raw ?? "status").trim().toLowerCase();
  if ((SWARM_MISSION_OPS as readonly string[]).includes(value)) {
    return value as SwarmMissionOp;
  }
  throw new SwarmProtocolError(
    "INVALID_INPUT",
    `Unsupported mission_op "${raw}". Expected one of: ${SWARM_MISSION_OPS.join(", ")}.`,
  );
}

function buildManageMissionInputFromParams(
  params: Partial<SwarmToolParams>,
  callerName: string,
  callerRole: CallerRole,
  hostContext?: ExtensionContext,
): ManageMissionInput {
  const op = normalizeMissionOp(params.mission_op);
  const assertions: MissionAssertionInput[] | undefined = Array.isArray(params.assertions)
    ? params.assertions.map((a) => {
        const raw = a as Record<string, unknown>;
        const evidenceReq =
          typeof a.evidence_required === "string"
            ? a.evidence_required
            : typeof raw.evidenceRequired === "string"
              ? raw.evidenceRequired
              : undefined;
        return {
          id: a.id,
          title: a.title,
          description: a.description,
          ...(evidenceReq !== undefined ? { evidenceRequired: evidenceReq } : {}),
          ...(a.status !== undefined ? { status: a.status as AssertionStatus } : {}),
        };
      })
    : undefined;

  const features: MissionFeatureInput[] | undefined = Array.isArray(params.features)
    ? params.features.map((f) => {
        const raw = f as Record<string, unknown>;
        const dependsOn = Array.isArray(f.depends_on)
          ? f.depends_on
          : Array.isArray(raw.dependsOn)
            ? (raw.dependsOn as string[])
            : undefined;
        const filesOwned = Array.isArray(f.files_owned)
          ? f.files_owned
          : Array.isArray(raw.filesOwned)
            ? (raw.filesOwned as string[])
            : undefined;
        const expectedBehavior = Array.isArray(f.expected_behavior)
          ? f.expected_behavior
          : Array.isArray(raw.expectedBehavior)
            ? (raw.expectedBehavior as string[])
            : undefined;
        const verificationSteps = Array.isArray(f.verification_steps)
          ? f.verification_steps
          : Array.isArray(raw.verificationSteps)
            ? (raw.verificationSteps as string[])
            : undefined;
        const assignedMember =
          typeof f.assigned_member === "string"
            ? f.assigned_member
            : typeof raw.assignedMember === "string"
              ? raw.assignedMember
              : undefined;
        return {
          id: f.id,
          title: f.title,
          description: f.description,
          milestone: f.milestone,
          ...(dependsOn !== undefined ? { dependsOn } : {}),
          ...(filesOwned !== undefined ? { filesOwned } : {}),
          ...(f.preconditions !== undefined ? { preconditions: f.preconditions } : {}),
          ...(expectedBehavior !== undefined ? { expectedBehavior } : {}),
          ...(verificationSteps !== undefined ? { verificationSteps } : {}),
          ...(f.fulfills !== undefined ? { fulfills: f.fulfills } : {}),
          ...(f.status !== undefined ? { status: f.status as FeatureStatus } : {}),
          ...(assignedMember !== undefined ? { assignedMember } : {}),
        };
      })
    : undefined;

  const services: MissionServiceEntry[] | undefined = Array.isArray(params.services)
    ? params.services.map((s) => {
        const raw = s as Record<string, unknown>;
        const dependsOn = Array.isArray(s.depends_on)
          ? s.depends_on
          : Array.isArray(raw.dependsOn)
            ? (raw.dependsOn as string[])
            : undefined;
        return {
          name: s.name,
          start: s.start,
          ...(s.stop !== undefined ? { stop: s.stop } : {}),
          ...(s.healthcheck !== undefined ? { healthcheck: s.healthcheck } : {}),
          ...(s.port !== undefined ? { port: s.port } : {}),
          ...(dependsOn !== undefined ? { dependsOn } : {}),
        };
      })
    : undefined;

  return {
    op,
    ...(assertions !== undefined ? { assertions } : {}),
    ...(params.assertion_id !== undefined ? { assertionId: params.assertion_id } : {}),
    ...(params.assertion_status !== undefined
      ? { assertionStatus: params.assertion_status as AssertionStatus }
      : {}),
    ...(params.evidence !== undefined ? { evidence: params.evidence } : {}),
    ...(features !== undefined ? { features } : {}),
    ...(params.prepend !== undefined ? { prepend: params.prepend } : {}),
    ...(params.feature_id !== undefined ? { featureId: params.feature_id } : {}),
    ...(params.feature_status !== undefined
      ? { featureStatus: params.feature_status as FeatureStatus }
      : {}),
    ...(params.assigned_member !== undefined
      ? { assignedMember: params.assigned_member }
      : {}),
    ...(params.merged_commit_sha !== undefined
      ? { mergedCommitSha: params.merged_commit_sha }
      : {}),
    ...(params.handoff_id !== undefined ? { handoffId: params.handoff_id } : {}),
    ...(params.resolution !== undefined
      ? { resolution: params.resolution as HandoffItemResolution }
      : {}),
    ...(params.tracked_feature_id !== undefined
      ? { trackedFeatureId: params.tracked_feature_id }
      : {}),
    ...(params.justification !== undefined
      ? { justification: params.justification }
      : {}),
    ...(params.commands !== undefined ? { commands: params.commands } : {}),
    ...(services !== undefined ? { services } : {}),
    ...(params.boundaries !== undefined ? { boundaries: params.boundaries } : {}),
    ...(params.library_topic !== undefined ? { libraryTopic: params.library_topic } : {}),
    ...(params.library_content !== undefined
      ? { libraryContent: params.library_content }
      : {}),
    ...(params.library_append !== undefined
      ? { libraryAppend: params.library_append }
      : {}),
    ...(params.max_dispatch !== undefined ? { maxDispatch: params.max_dispatch } : {}),
    ...(hostContext !== undefined ? { hostContext } : {}),
    ...(params.force !== undefined ? { force: params.force } : {}),
    callerName,
    callerRole,
  };
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

    case "mission": {
      const missionOp =
        typeof args?.mission_op === "string" && args.mission_op.trim()
          ? args.mission_op.trim()
          : "status";
      const metaParts: string[] = [];
      if (missionOp === "verify_assertion") {
        if (typeof args?.assertion_id === "string" && args.assertion_id.trim()) {
          metaParts.push(args.assertion_id.trim());
        }
        if (typeof args?.assertion_status === "string" && args.assertion_status.trim()) {
          metaParts.push(`-> ${args.assertion_status.trim()}`);
        }
      } else if (missionOp === "override_assertion") {
        if (typeof args?.assertion_id === "string" && args.assertion_id.trim()) {
          metaParts.push(args.assertion_id.trim());
        }
        metaParts.push("[OVERRIDE]");
      } else if (missionOp === "upsert_assertions") {
        const count = Array.isArray(args?.assertions) ? args.assertions.length : 0;
        if (count > 0) metaParts.push(`${count} VAL`);
      } else if (missionOp === "remove_assertion") {
        if (typeof args?.assertion_id === "string" && args.assertion_id.trim()) {
          metaParts.push(args.assertion_id.trim());
        }
      } else if (missionOp === "upsert_features") {
        const count = Array.isArray(args?.features) ? args.features.length : 0;
        if (count > 0) metaParts.push(`${count} feature(s)`);
        if (args?.prepend === true) metaParts.push("prepend");
      } else if (missionOp === "update_feature") {
        if (typeof args?.feature_id === "string" && args.feature_id.trim()) {
          metaParts.push(args.feature_id.trim());
        }
        if (typeof args?.feature_status === "string" && args.feature_status.trim()) {
          metaParts.push(`-> ${args.feature_status.trim()}`);
        }
        if (typeof args?.assigned_member === "string" && args.assigned_member.trim()) {
          metaParts.push(`@${args.assigned_member.trim().replace(/^@/, "")}`);
        }
      } else if (missionOp === "dispatch_ready") {
        if (typeof args?.max_dispatch === "number" && Number.isFinite(args.max_dispatch)) {
          metaParts.push(`max=${Math.floor(args.max_dispatch)}`);
        }
      } else if (missionOp === "resolve_handoff") {
        if (typeof args?.handoff_id === "string" && args.handoff_id.trim()) {
          metaParts.push(args.handoff_id.trim());
        }
        if (typeof args?.resolution === "string" && args.resolution.trim()) {
          metaParts.push(`-> ${args.resolution.trim()}`);
        }
      } else if (missionOp === "set_manifest") {
        const cmdCount = Array.isArray(args?.commands) ? args.commands.length : 0;
        const svcCount = Array.isArray(args?.services) ? args.services.length : 0;
        const bndCount = Array.isArray(args?.boundaries) ? args.boundaries.length : 0;
        if (cmdCount > 0) metaParts.push(`${cmdCount} cmd(s)`);
        if (svcCount > 0) metaParts.push(`${svcCount} svc(s)`);
        if (bndCount > 0) metaParts.push(`${bndCount} boundary(s)`);
      } else if (missionOp === "read_library") {
        if (typeof args?.library_topic === "string" && args.library_topic.trim()) {
          metaParts.push(`${args.library_topic.trim()}.md`);
        } else {
          metaParts.push("list topics");
        }
      } else if (missionOp === "write_library") {
        if (typeof args?.library_topic === "string" && args.library_topic.trim()) {
          metaParts.push(`${args.library_topic.trim()}.md`);
        }
        if (args?.library_append === true) {
          metaParts.push("append");
        }
      }
      if (args?.force === true) {
        metaParts.push("[force]");
      }
      const metaSuffix =
        metaParts.length > 0 ? ` ${theme.fg("muted", `(${metaParts.join(" · ")})`)}` : "";
      return new Text(
        `🎯 ${theme.fg("toolTitle", theme.bold(`swarm mission ${missionOp}`))}${metaSuffix}`,
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

  // Mission Goal Engine summary card
  if (
    details &&
    typeof details.op === "string" &&
    (SWARM_MISSION_OPS as readonly string[]).includes(details.op) &&
    typeof details.summary === "string"
  ) {
    const missionRes = details as unknown as ManageMissionResult;
    const stats: string[] = [];
    if (Array.isArray(missionRes.features) && missionRes.features.length > 0) {
      const nonCancelled = missionRes.features.filter((f) => f.status !== "cancelled");
      const doneFeat = nonCancelled.filter((f) => f.status === "completed").length;
      stats.push(`Feat ${doneFeat}/${nonCancelled.length}`);
    }
    if (Array.isArray(missionRes.assertions) && missionRes.assertions.length > 0) {
      const passedVal = missionRes.assertions.filter((a) => a.status === "passed").length;
      stats.push(`VAL ${passedVal}/${missionRes.assertions.length}`);
    }
    if (Array.isArray(missionRes.milestones) && missionRes.milestones.length > 0) {
      const sealedCount = missionRes.milestones.filter((m) => m.sealed).length;
      if (sealedCount > 0) {
        stats.push(`${sealedCount} sealed`);
      }
    }
    if (Array.isArray(missionRes.handoffItems) && missionRes.handoffItems.length > 0) {
      const openDebt = missionRes.handoffItems.filter((h) => h.resolution === "open").length;
      if (openDebt > 0) {
        stats.push(`!${openDebt} debt`);
      }
    }
    const statsBadge = stats.length > 0 ? ` [${stats.join(" · ")}]` : "";
    const firstLine = lines[0] ?? missionRes.summary;
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `${clipInline(firstLine, 86)}${statsBadge}`)}${expandHint}`,
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

function formatHandoffBadges(fields: {
  featureId?: unknown;
  discoveredIssues?: unknown;
  leftUndone?: unknown;
  verificationEvidence?: unknown;
}): string {
  const badges: string[] = [];
  if (typeof fields.featureId === "string" && fields.featureId.trim()) {
    badges.push(`[feat:${sanitizeInline(fields.featureId.trim())}]`);
  }
  const issuesCount = Array.isArray(fields.discoveredIssues)
    ? fields.discoveredIssues.filter((x) => typeof x === "string" && x.trim().length > 0).length
    : 0;
  if (issuesCount > 0) {
    badges.push(`[+${issuesCount} issue${issuesCount === 1 ? "" : "s"}]`);
  }
  const undoneCount = Array.isArray(fields.leftUndone)
    ? fields.leftUndone.filter((x) => typeof x === "string" && x.trim().length > 0).length
    : 0;
  if (undoneCount > 0) {
    badges.push(`[!${undoneCount} undone]`);
  }
  if (
    typeof fields.verificationEvidence === "string" &&
    fields.verificationEvidence.trim()
  ) {
    badges.push("[✓evidence]");
  }
  return badges.length > 0 ? ` ${badges.join(" ")}` : "";
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
  const handoffBadges = formatHandoffBadges({
    featureId: args?.feature_id,
    discoveredIssues: args?.discovered_issues,
    leftUndone: args?.left_undone,
    verificationEvidence: args?.verification_evidence,
  });

  const header = `📨 ${theme.fg("toolTitle", theme.bold(`post #${channel}`))} ${theme.fg("muted", "->")} ${theme.fg(targets.length > 0 ? "accent" : "muted", targetDisplay)}${kindBadge ? theme.fg("dim", kindBadge) : ""}${handoffBadges ? theme.fg("accent", handoffBadges) : ""}`;

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
    const handoffBadges = formatHandoffBadges({
      featureId: msg.featureId,
      discoveredIssues: msg.discoveredIssues,
      leftUndone: msg.leftUndone,
      verificationEvidence: msg.verificationEvidence,
    });
    const badgeStyled = handoffBadges ? theme.fg("accent", handoffBadges) : "";
    if (options?.expanded) {
      return new Text(
        `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Posted #${msg.seq} to #${channel}${route}`)}${badgeStyled}\n${theme.fg("toolOutput", msg.text)}`,
        0,
        0,
      );
    }
    const isMultiLineOrLong = msg.text.includes("\n") || msg.text.length > 76;
    const expandHint = isMultiLineOrLong
      ? formatExpandHint(options, theme, context)
      : "";
    return new Text(
      `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `#${msg.seq} (#${channel}${route}):`)}${badgeStyled} ${theme.fg("muted", clipInline(msg.text, 72))}${expandHint}`,
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

  if (details?.parked === false && typeof details.blockedBySeq === "number") {
    const memberLabel =
      typeof details.member === "string" ? `@${details.member} ` : "";
    const sinceLabel =
      typeof details.since === "number" ? `, since #${details.since}` : "";
    return new Text(
      `🔔 ${theme.fg("warning", `Park blocked ${memberLabel}(unread up to #${details.blockedBySeq}${sinceLabel})`)}`,
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
      'Manage the dynamic Pi Swarm & Mission Goal Engine: set run title/direction ("title"), spawn workers/validators/sharded groups with optional context forking or isolated worktrees ("add"), inspect roster/channels ("status"), list models ("models"), hot-switch & resume a waiting member model ("model"), steer/redirect a member mid-flight ("steer"), stop a member ("stop"), permanently retire a member ("kill"), land a share/branch worktree ("merge"), manage channels ("channel"), manage dynamic Mission VAL-* assertions/features/handoffs/manifest ("mission"), or complete the run ("done").',
    promptSnippet:
      "Manage dynamic swarm members, mission features/assertions/handoffs, steering, models, worktrees, channels, and run lifecycle.",
    promptGuidelines: [
      `Use ${SWARM_TOOL} with action="add" to delegate technical work to named workers or independent read-only validators (workspace="share" for shared worktrees or workspace="branch" for isolated clones; fork="<member>|orchestrator" to branch conversation history).`,
      `Use action="mission" to inspect or dynamically evolve VAL-* assertions, feature queue, operational commands/boundaries, and resolve open worker handoff items. Use action="steer" to redirect mid-flight, action="merge" to land worktrees, action="kill" once integrated, and action="done" when all features and VAL-* assertions pass.`,
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
            const runBefore = deps.engine.getSnapshot().run;
            const targetBefore = runBefore
              ? (runBefore.members[name] ??
                  Object.values(runBefore.members).find(
                    (m) => m.name.toLowerCase() === name.toLowerCase(),
                  ))
              : undefined;
            const canonicalTarget = targetBefore?.name ?? name;
            await deps.engine.killMember(name, {
              reason: params.reason,
              force: params.force,
              callerName,
              callerRole,
            });
            const latestRun = deps.engine.getSnapshot().run ?? runBefore;
            const orderedMembers = latestRun
              ? [
                  ...latestRun.memberOrder
                    .map((n) => latestRun.members[n])
                    .filter((m): m is SwarmMemberRecord => Boolean(m)),
                  ...Object.values(latestRun.members).filter(
                    (m) => !latestRun.memberOrder.includes(m.name),
                  ),
                ]
              : [];
            const orphanedHelpers = collectLiveOrphanedHelpers(
              orderedMembers,
              canonicalTarget,
            );
            const orphanWarning = formatOrphanedHelpersWarning(
              canonicalTarget,
              orphanedHelpers,
            );
            return okResult(
              `Killed @${canonicalTarget}${params.reason ? ` (${params.reason})` : ""}.${orphanWarning}`,
              { name: canonicalTarget, killed: true, orphanedHelpers },
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
            const extMerged = merged as MergeBranchResult & {
              completedFeatureIds?: string[];
              milestoneValidationCues?: Array<{
                milestone: string;
                assertionIds: string[];
                validatorWoken?: string;
                validatorSpawned?: string;
                boardSeq?: number;
                needsValidatorSpawn?: boolean;
              }>;
            };
            const featureLine =
              Array.isArray(extMerged.completedFeatureIds) &&
              extMerged.completedFeatureIds.length > 0
                ? `\nAuto-completed feature(s): ${extMerged.completedFeatureIds.join(", ")}`
                : "";
            const milestoneCueLines: string[] = [];
            if (Array.isArray(extMerged.milestoneValidationCues)) {
              for (const cue of extMerged.milestoneValidationCues) {
                if (cue.validatorSpawned) {
                  milestoneCueLines.push(
                    `\n🎯 Milestone "${cue.milestone}" features are all merged — auto-spawned @${cue.validatorSpawned} (#${cue.boardSeq ?? "?"} [milestone-review], dual-layer scrutiny + behavioral validation) to verify: ${cue.assertionIds.join(", ")}.`,
                  );
                } else if (cue.validatorWoken) {
                  milestoneCueLines.push(
                    `\n🎯 Milestone "${cue.milestone}" features are all merged — auto-woke @${cue.validatorWoken} (#${cue.boardSeq ?? "?"} [milestone-review]) to verify: ${cue.assertionIds.join(", ")}.`,
                  );
                } else if (cue.needsValidatorSpawn) {
                  milestoneCueLines.push(
                    `\n⚠ Milestone "${cue.milestone}" features are all merged with pending validation assertions (${cue.assertionIds.join(", ")}) — no idle inherit @validator exists yet! Spawn @validator (role:"validator", workspace:"inherit") immediately to verify them via swarm{action:"mission", mission_op:"verify_assertion"}.`,
                  );
                }
              }
            }
            const verifyLine =
              milestoneCueLines.length > 0
                ? milestoneCueLines.join("")
                : `\nNext: run post-merge verification (typecheck / tests) on ${baseBranch} before completing the run.`;
            return okResult(
              `Merged @${name} (${merged.strategy}) -> ${merged.mergedCommitSha.slice(0, 12)} (${merged.changedFiles.length} file(s)).${filesLine}${featureLine}${verifyLine}`,
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

          case "mission": {
            if (!deps.engine.manageMission) {
              throw new SwarmProtocolError(
                "NOT_FOUND",
                "Mission Goal Engine management is not available on this SwarmEngine instance.",
              );
            }
            const missionInput = buildManageMissionInputFromParams(
              params,
              callerName,
              callerRole,
              ctx,
            );
            const result = await deps.engine.manageMission(missionInput);
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

            const humanForce = params.force === true && callerRole === "human";
            if (params.force === true && callerRole !== "human") {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                'LLM orchestrator cannot pass force:true on swarm{action:"done"} to bypass Mission Goal Gates (unmerged commits, incomplete features, open handoff tech-debt, or unpassed VAL-* assertions). Only human /swarm done --force may force-close; for justified assertion exceptions, use audited swarm{action:"mission", mission_op:"override_assertion", assertion_id, justification}.',
                { callerRole },
              );
            }

            let snapshot = deps.engine.getSnapshot();
            if (!humanForce && snapshot.workingMemberNames.length > 0) {
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

            // Gate A: Working members
            if (!humanForce && snapshot.workingMemberNames.length > 0) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Cannot complete Swarm while member(s) are still working: ${snapshot.workingMemberNames.map((n) => "@" + n).join(", ")}. Call swarm_wait to let them finish, or stop/kill them first.`,
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

            if (!humanForce && preDoneRun) {
              // Gate B: Real Unmerged Commits ahead of baseBranch
              if (unmergedMembers.length > 0) {
                const engineWithUnmerged = deps.engine as ISwarmEngine & {
                  getUnmergedMembersWithCommits?: () => Promise<
                    Array<{ member: SwarmMemberRecord; commitsAhead: number }>
                  >;
                };
                const unmergedAhead =
                  (await engineWithUnmerged.getUnmergedMembersWithCommits?.()) ?? [];
                if (unmergedAhead.length > 0) {
                  const labels = unmergedAhead.map(
                    ({ member: m, commitsAhead }) =>
                      `@${m.name} (${m.branch ?? m.workspace}, ${commitsAhead} commit${commitsAhead === 1 ? "" : "s"} ahead)`,
                  );
                  throw new SwarmProtocolError(
                    "INVALID_INPUT",
                    `Cannot complete Swarm while unmerged worktree branch(es) have commits ahead of ${preDoneRun.baseBranch}: ${labels.join(", ")}. Merge ready branches via swarm{action:"merge", name} or kill obsolete branches via swarm{action:"kill", name} first.`,
                    {
                      unmergedMembers: unmergedAhead.map(({ member: m, commitsAhead }) => ({
                        name: m.name,
                        branch: m.branch,
                        commitsAhead,
                      })),
                    },
                  );
                }
              }

              // Gate C: Incomplete Features
              if (preDoneRun.features && preDoneRun.features.length > 0) {
                const incompleteFeatures = preDoneRun.features.filter(
                  (f) =>
                    f.status === "pending" ||
                    f.status === "in_progress" ||
                    f.status === "failed",
                );
                if (incompleteFeatures.length > 0) {
                  throw new SwarmProtocolError(
                    "INVALID_INPUT",
                    `Cannot complete Mission while ${incompleteFeatures.length} feature(s) remain incomplete: ${incompleteFeatures.map((f) => `${f.id} [${f.status}]`).join(", ")}. Complete or cancel remaining features via swarm{action:"mission"} before calling done.`,
                    {
                      incompleteFeatures: incompleteFeatures.map((f) => ({
                        id: f.id,
                        status: f.status,
                      })),
                    },
                  );
                }
              }

              // Gate D: Open Handoff Tech Debt
              const openTechDebt = (preDoneRun.handoffItems ?? []).filter(
                (h) =>
                  h.resolution === "open" &&
                  (h.type === "discovered_issue" || h.type === "incomplete_work"),
              );
              if (openTechDebt.length > 0) {
                throw new SwarmProtocolError(
                  "INVALID_INPUT",
                  `Cannot complete Mission with ${openTechDebt.length} open handoff tech-debt item(s): ${openTechDebt.map((h) => `${h.id} (${h.type} from @${h.sourceMember}: "${h.summary.slice(0, 72)}")`).join("; ")}. Track follow-up features via swarm{action:"mission", mission_op:"upsert_features"} and resolve each item via swarm{action:"mission", mission_op:"resolve_handoff"} before calling done.`,
                  { openHandoffIds: openTechDebt.map((h) => h.id) },
                );
              }

              // Gate E: 100% Validation Contract VAL-* Passed & Claimed by Completed Features
              if (preDoneRun.assertions && preDoneRun.assertions.length > 0) {
                const unpassedAssertions = preDoneRun.assertions.filter(
                  (a) => a.status !== "passed",
                );
                const completedFulfills = new Set(
                  (preDoneRun.features ?? [])
                    .filter((f) => f.status === "completed")
                    .flatMap((f) => f.fulfills),
                );
                const unclaimedByCompleted = preDoneRun.assertions.filter(
                  (a) => !completedFulfills.has(a.id),
                );
                if (unpassedAssertions.length > 0 || unclaimedByCompleted.length > 0) {
                  const reasons: string[] = [];
                  if (unpassedAssertions.length > 0) {
                    reasons.push(
                      `unpassed VAL-* assertions: ${unpassedAssertions.map((a) => `${a.id} [${a.status}]`).join(", ")} (verify via @validator calling swarm{action:"mission", mission_op:"verify_assertion"}, or use audited mission_op:"override_assertion" with >=30 char justification)`,
                    );
                  }
                  if (unclaimedByCompleted.length > 0) {
                    reasons.push(
                      `VAL-* assertions not claimed in fulfills[] of any "completed" feature: ${unclaimedByCompleted.map((a) => a.id).join(", ")} (ensure completed features claim 100% of assertions via swarm{action:"mission", mission_op:"upsert_features"})`,
                    );
                  }
                  throw new SwarmProtocolError(
                    "INVALID_INPUT",
                    `Cannot complete Mission until 100% of Validation Contract passes and is claimed: ${reasons.join("; ")}.`,
                    {
                      unpassedAssertionIds: unpassedAssertions.map((a) => a.id),
                      unclaimedAssertionIds: unclaimedByCompleted.map((a) => a.id),
                    },
                  );
                }
              }
            }

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
          ...(params.feature_id !== undefined ? { featureId: params.feature_id } : {}),
          ...(params.discovered_issues !== undefined
            ? { discoveredIssues: params.discovered_issues }
            : {}),
          ...(params.left_undone !== undefined ? { leftUndone: params.left_undone } : {}),
          ...(params.verification_evidence !== undefined
            ? { verificationEvidence: params.verification_evidence }
            : {}),
        });
        const targets = [
          ...msg.mentions.map((m) => `@${m}`),
          ...msg.channelMentions.map((c) => `@#${c}`),
        ];
        const targetText = targets.length > 0 ? ` (notified: ${targets.join(", ")})` : "";
        const handoffSummary = formatHandoffBadges({
          featureId: msg.featureId,
          discoveredIssues: msg.discoveredIssues,
          leftUndone: msg.leftUndone,
          verificationEvidence: msg.verificationEvidence,
        });
        return okResult(`Posted #${msg.seq} to #${msg.channel}${targetText}${handoffSummary}.`, msg);
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
  channels?: readonly string[];
  groupPrefix?: string;
  /** Invoked when a member calls `swarm_wait` so transport/engine can record `since` & `mentionsOnly`. */
  onWaitRecorded?: (wait: { since: number; mentionsOnly: boolean }) => void;
  /** Invoked when a working member schedules a deferred self model switch. */
  onSelfModelSwitchScheduled?: () => void;
}

function collectLiveOrphanedHelpers(
  members: ReadonlyArray<{ name: string; parentName: string; state: string }>,
  targetName: string,
): string[] {
  const targetLower = targetName.toLowerCase();
  return members
    .filter(
      (m) =>
        m.state !== "killed" &&
        m.name.toLowerCase() !== targetLower &&
        m.parentName.toLowerCase() === targetLower,
    )
    .map((m) => m.name);
}

function formatOrphanedHelpersWarning(
  targetName: string,
  orphanedHelpers: readonly string[],
): string {
  if (orphanedHelpers.length === 0) {
    return "";
  }
  const handles = orphanedHelpers.map((h) => `@${h}`).join(", ");
  return `\nWarning: @${targetName} still has live child helper(s): ${handles} — kill or reassign them before done.`;
}

function doesUnreadMessageBlockMemberPark(
  msg: BoardMessage,
  selfLower: string,
  groupPrefixLower: string | undefined,
  mentionsOnly: boolean,
  subscribedChannels: ReadonlySet<string>,
  nonMainSubscribedChannels: ReadonlySet<string>,
): boolean {
  if (!msg || typeof msg.seq !== "number" || !Number.isFinite(msg.seq)) {
    return false;
  }
  if ((msg.from ?? "").toLowerCase() === selfLower) {
    return false;
  }
  const msgChannelLower = (msg.channel || DEFAULT_CHANNEL).toLowerCase();
  if (!mentionsOnly) {
    return subscribedChannels.has(msgChannelLower);
  }
  const mentionsLower = Array.isArray(msg.mentions)
    ? msg.mentions.map((m) => m.toLowerCase())
    : [];
  if (
    mentionsLower.includes(selfLower) ||
    mentionsLower.includes(ALL_MENTION_NAME) ||
    (groupPrefixLower !== undefined && mentionsLower.includes(groupPrefixLower))
  ) {
    return true;
  }
  const chMentionsLower = Array.isArray(msg.channelMentions)
    ? msg.channelMentions.map((c) => c.toLowerCase())
    : [];
  if (
    chMentionsLower.some(
      (ch) => ch !== DEFAULT_CHANNEL && nonMainSubscribedChannels.has(ch),
    )
  ) {
    return true;
  }
  return false;
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
      "Post a concise message to the shared Swarm message board. Use `@name` as a wakeup doorbell only for peers who must act next; start completion posts with `[done]` after `@<peer-or-parent>`. When reporting `[done]` on a Mission feature, you MUST include `verification_evidence` (>= 10 chars with exact commands & results run, unless `left_undone` is non-empty) and `feature_id` (if multiple features are assigned) plus any `discovered_issues` / `left_undone`.",
    promptSnippet: "Post a concise message (with @mentions and structured [done] handoff fields) to the shared Swarm board.",
    promptGuidelines: [
      `Use ${POST_MESSAGE_TOOL} for concise handoffs, questions, findings, or final [done] reports. Reference earlier posts as #seq instead of copying them. When reporting [done] on a Mission feature, always pass verification_evidence (>= 10 chars) and any discovered_issues / left_undone.`,
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
      feature_id: Type.Optional(
        Type.String({
          description:
            "Mission feature ID this deliverable implements (auto-updates assigned feature on [done]; required when multiple features are assigned to you).",
        }),
      ),
      discovered_issues: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional non-blocking bugs or tech-debt items discovered while working (auto-recorded as open handoff items).",
        }),
      ),
      left_undone: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional incomplete items left undone on this feature (auto-recorded as open incomplete_work handoff items).",
        }),
      ),
      verification_evidence: Type.Optional(
        Type.String({
          description:
            "Concrete verification evidence (>= 10 chars with exact commands run and exit/pass counts; required when reporting [done] on a Mission feature unless left_undone is non-empty).",
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
          ...(params.feature_id !== undefined ? { featureId: params.feature_id } : {}),
          ...(params.discovered_issues !== undefined
            ? { discoveredIssues: params.discovered_issues }
            : {}),
          ...(params.left_undone !== undefined ? { leftUndone: params.left_undone } : {}),
          ...(params.verification_evidence !== undefined
            ? { verificationEvidence: params.verification_evidence }
            : {}),
        });
        const targets = [
          ...msg.mentions.map((m) => `@${m}`),
          ...msg.channelMentions.map((c) => `@#${c}`),
        ];
        const targetText =
          targets.length > 0
            ? ` (notified: ${targets.join(", ")})`
            : " (no @mention included — no peer was woken)";
        const handoffSummary = formatHandoffBadges({
          featureId: msg.featureId,
          discoveredIssues: msg.discoveredIssues,
          leftUndone: msg.leftUndone,
          verificationEvidence: msg.verificationEvidence,
        });
        return okResult(`Posted #${msg.seq} to #${msg.channel}${targetText}${handoffSummary}.`, msg);
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
      type MemberSwarmWaitDetails = {
        member: string;
        since: number;
        mentionsOnly: boolean;
        parked: boolean;
        blockedBySeq?: number;
        unreadSeqs?: number[];
        error?: string;
        errorCode?: string;
      };

      const since = Number.isFinite(params.since) ? Math.max(0, Math.floor(params.since)) : 0;
      const mentionsOnly = params.mentions_only ?? true;

      let liveCtx:
        | {
            channels: readonly string[];
            broadcastChannels?: readonly string[];
            groupPrefix?: string;
          }
        | undefined;
      try {
        liveCtx = bridge.getMemberContext?.();
      } catch {
        liveCtx = undefined;
      }
      const rawChannels =
        liveCtx?.channels ??
        member.channels ??
        (member.defaultChannel
          ? [member.defaultChannel, DEFAULT_CHANNEL]
          : [DEFAULT_CHANNEL]);
      const subscribedChannels = new Set<string>([
        DEFAULT_CHANNEL,
        ...rawChannels.map((c) => c.toLowerCase()),
      ]);
      const nonMainSubscribedChannels = new Set<string>(
        liveCtx?.broadcastChannels
          ? liveCtx.broadcastChannels
              .map((c) => c.toLowerCase())
              .filter((c) => c !== DEFAULT_CHANNEL)
          : Array.from(subscribedChannels).filter((c) => c !== DEFAULT_CHANNEL),
      );
      const selfLower = member.name.toLowerCase();
      const groupPrefixLower =
        (liveCtx?.groupPrefix ?? member.groupPrefix)?.trim().toLowerCase() ||
        undefined;

      const PAGE_SIZE = 20;
      const matching: BoardMessage[] = [];
      let cursor = since;
      let targetHead: number | undefined;
      let latestHead = since;

      try {
        while (true) {
          const boardRes = await Promise.resolve(
            bridge.readBoard({
              since: cursor,
              limit: PAGE_SIZE,
              channel: "*",
              peek: true,
            }),
          );
          const pageMessages = Array.isArray(boardRes?.messages)
            ? boardRes.messages
            : [];
          const resHead =
            typeof boardRes?.head === "number" && Number.isFinite(boardRes.head)
              ? Math.max(0, Math.floor(boardRes.head))
              : since;
          if (resHead > latestHead) {
            latestHead = resHead;
          }

          let maxPageSeq = cursor;
          for (const msg of pageMessages) {
            if (
              !msg ||
              typeof msg.seq !== "number" ||
              !Number.isFinite(msg.seq)
            ) {
              continue;
            }
            if (msg.seq > maxPageSeq) {
              maxPageSeq = msg.seq;
            }
            if (
              msg.seq > cursor &&
              doesUnreadMessageBlockMemberPark(
                msg,
                selfLower,
                groupPrefixLower,
                mentionsOnly,
                subscribedChannels,
                nonMainSubscribedChannels,
              )
            ) {
              matching.push(msg);
            }
          }

          if (targetHead === undefined) {
            targetHead = Math.max(resHead, maxPageSeq);
          }

          if (
            pageMessages.length === 0 ||
            maxPageSeq <= cursor ||
            maxPageSeq >= targetHead
          ) {
            break;
          }
          cursor = maxPageSeq;
        }
      } catch (err) {
        const rawErr = err instanceof Error ? err.message : String(err);
        const prefix = isSwarmProtocolError(err)
          ? `[SwarmProtocolError:${err.code}] ${err.message}`
          : `Error: ${rawErr}`;
        const errDetails: MemberSwarmWaitDetails = {
          member: member.name,
          since,
          mentionsOnly,
          parked: false,
          error: rawErr,
          ...(isSwarmProtocolError(err) ? { errorCode: err.code } : {}),
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `${prefix} (failed to verify unread board messages before swarm_wait; retry read_board{since: ${since}} before calling swarm_wait again).`,
            },
          ],
          details: errDetails,
        };
      }

      if (matching.length > 0) {
        const unreadSeqs = Array.from(new Set(matching.map((m) => m.seq))).sort(
          (a, b) => a - b,
        );
        const maxMatchingSeq = unreadSeqs[unreadSeqs.length - 1]!;
        const head = Math.max(latestHead, maxMatchingSeq);
        await Promise.resolve(
          bridge.recordParkBlocked?.(maxMatchingSeq),
        ).catch(() => {});
        const preview = matching
          .slice(0, 6)
          .map((m) => `#${m.seq} (${m.from} in #${m.channel || DEFAULT_CHANNEL})`)
          .join(", ");
        const overflow =
          matching.length > 6 ? `, +${matching.length - 6} more` : "";
        const hasCrossChannelMatch = matching.some(
          (m) =>
            !subscribedChannels.has((m.channel || DEFAULT_CHANNEL).toLowerCase()),
        );
        const readArgs = hasCrossChannelMatch
          ? `since: ${since}, channel: "*"`
          : `since: ${since}`;
        const blockedDetails: MemberSwarmWaitDetails = {
          member: member.name,
          since,
          mentionsOnly,
          parked: false,
          blockedBySeq: maxMatchingSeq,
          unreadSeqs,
        };
        return {
          content: [
            {
              type: "text",
              text: `[board] New message(s) arrived since #${since} (head #${head}): ${preview}${overflow}. Call read_board{${readArgs}} before calling swarm_wait again.`,
            },
          ],
          details: blockedDetails,
        };
      }

      member.onWaitRecorded?.({ since, mentionsOnly });
      const parkedDetails: MemberSwarmWaitDetails = {
        member: member.name,
        since,
        mentionsOnly,
        parked: true,
      };
      return {
        content: [
          {
            type: "text",
            text: `Parking @${member.name} in warm waiting state (since #${since}, mentions_only=${mentionsOnly}).`,
          },
        ],
        details: parkedDetails,
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
        ? 'Scoped Swarm helper tool for read-only validators: inspect roster ("status"), list models ("models"), inspect Mission status, read/write shared library topics, or verify VAL-* assertions ("mission"), spawn read-only validator helpers ("add"), switch model for self or own helpers ("model"), steer/stop/kill own helpers ("steer"/"stop"/"kill"), or list/join/leave channels ("channel").'
        : 'Scoped Swarm helper tool for workers: inspect roster ("status"), list models ("models"), inspect Mission status, read/write shared library topics, or update your own assigned feature ("mission"), spawn helper workers/validators reporting back to you ("add"), switch model for self or own helpers ("model"), steer/stop/kill own helpers ("steer"/"stop"/"kill"), or list/join/leave channels ("channel"). Cannot call title/merge/done, self-verify or override VAL-* assertions, or touch other members.',
    promptSnippet:
      "Inspect swarm/mission status, read/write shared library, verify VAL-* assertions (validator) or update own feature (worker), manage your own helpers, or join/leave channels.",
    parameters: Type.Object({
      action: stringEnum(MEMBER_SWARM_ACTIONS, {
        description:
          'Allowed member actions: "status" | "models" | "add" | "model" | "steer" | "stop" | "kill" | "channel" | "mission".',
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
      mission_op: Type.Optional(
        stringEnum(SWARM_MISSION_OPS, {
          description:
            'Sub-operation for action="mission": "status" | "read_library" | "write_library" | "verify_assertion" (validator) | "update_feature" (worker own feature).',
        }),
      ),
      assertion_id: Type.Optional(
        Type.String({
          description: 'Target VAL-* assertion ID for mission_op="verify_assertion".',
        }),
      ),
      assertion_status: Type.Optional(
        stringEnum(ASSERTION_STATUSES, {
          description:
            'Verification outcome for mission_op="verify_assertion": "pending" | "passed" | "failed" | "blocked".',
        }),
      ),
      evidence: Type.Optional(
        Type.String({
          description:
            'Concrete command/inspection evidence (required when assertion_status is "passed" or "failed").',
        }),
      ),
      feature_id: Type.Optional(
        Type.String({
          description: 'Target feature ID for mission_op="update_feature".',
        }),
      ),
      feature_status: Type.Optional(
        stringEnum(FEATURE_STATUSES, {
          description:
            'Updated feature status for mission_op="update_feature": "pending" | "in_progress" | "completed" | "failed" | "cancelled".',
        }),
      ),
      assigned_member: Type.Optional(
        Type.String({
          description: 'Optional assigned member handle for mission_op="update_feature".',
        }),
      ),
      merged_commit_sha: Type.Optional(
        Type.String({
          description: 'Optional merged commit SHA for mission_op="update_feature".',
        }),
      ),
      library_topic: Type.Optional(
        Type.String({
          description:
            'Shared library topic name (e.g. "architecture", "environment", "testing") for mission_op="read_library" or "write_library" (omit on read_library to list topics).',
        }),
      ),
      library_content: Type.Optional(
        Type.String({
          description: 'Markdown content to write or append for mission_op="write_library".',
        }),
      ),
      library_append: Type.Optional(
        Type.Boolean({
          description:
            'For mission_op="write_library": when true, append to existing topic content instead of replacing.',
        }),
      ),
      justification: Type.Optional(
        Type.String({
          description: 'Optional justification string.',
        }),
      ),
      services: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            start: Type.String(),
            stop: Type.Optional(Type.String()),
            healthcheck: Type.Optional(Type.String()),
            port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
            depends_on: Type.Optional(Type.Array(Type.String())),
          }),
        ),
      ),
      max_dispatch: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 64,
        }),
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
            const statusAfter = await Promise.resolve(bridge.getStatus?.()).catch(
              () => undefined,
            );
            const canonicalTarget =
              statusAfter?.members.find(
                (m) => m.name.toLowerCase() === name.toLowerCase(),
              )?.name ?? name;
            const orphanedHelpers = statusAfter
              ? collectLiveOrphanedHelpers(statusAfter.members, canonicalTarget)
              : [];
            const orphanWarning = formatOrphanedHelpersWarning(
              canonicalTarget,
              orphanedHelpers,
            );
            return okResult(`Killed helper @${canonicalTarget}.${orphanWarning}`, {
              name: canonicalTarget,
              killed: true,
              orphanedHelpers,
            });
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

          case "mission": {
            if (!bridge.manageMission) {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Mission Goal Engine management is not available in this member bridge context.`,
              );
            }
            const missionInput = buildManageMissionInputFromParams(
              params as Partial<SwarmToolParams>,
              member.name,
              member.role,
            );
            const res = await bridge.manageMission(missionInput);
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

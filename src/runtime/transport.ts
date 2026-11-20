import path from "node:path";
import type { AgentMessage, AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, StringEnum } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
  isToolCallEventType,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import {
  FINAL_AUDIT_MISSION_ID,
  ORCHESTRATOR_BOARD_NAME,
  SWARM_BOARD_POST_TOOL,
  SWARM_BOARD_READ_TOOL,
  SWARM_DIR,
  SWARM_FINAL_VERDICT_TOOL,
  SWARM_FINDING_TOOL,
  SWARM_MISSION_TOOL,
  SWARM_REVIEW_VERDICT_TOOL,
  SWARM_STATUS_TOOL,
  SWARM_WORKER_DONE_TOOL,
  VALIDATOR_BOARD_TOOLS,
  VALIDATOR_BUILTIN_TOOLS,
  WORKER_BUILTIN_TOOLS,
  WORKER_SWARM_TOOLS,
} from "../constants.js";
import {
  type AgentTurnResult,
  type BoardMessage,
  type BoardMessageKind,
  type CallerRole,
  computeReviewSeverityStatus,
  type FinalAuditVerdict,
  type FinalValidatorSpawnRequest,
  type ISwarmBoard,
  type ISwarmStore,
  type ISwarmTransport,
  isSwarmProtocolError,
  isValidReviewSeverityStatus,
  type MissionReviewVerdict,
  type ModelSwitchResult,
  type PersistentAgentHandle,
  type ReviewCheck,
  type ReviewFinding,
  type ReviewMergeDecision,
  type RosterAgentRole,
  type RosterAgentStatus,
  type SuggestedFixMission,
  type SwarmModelRole,
  SwarmProtocolError,
  type SwarmSettings,
  type TokenUsage,
  type ValidatorSpawnRequest,
  type WorkerDonePayload,
  type WorkerRunOutcome,
  type WorkerSpawnRequest,
  type WorkerTelemetryEvent,
} from "../types.js";
import { isRateLimitOrTransientError, parseRetryAfterMs } from "./rate-limit.js";
import { formatBoardExcerptLine } from "./role-prompts.js";

// ============================================================================
// Typed StringEnum Helper (Google-compatible JSON schema + TypeBox Static)
// ============================================================================

function stringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>(StringEnum(values, options) as unknown as TSchema);
}

// ============================================================================
// 3-Role Model Resolution Helper
// ============================================================================

/**
 * Resolves the effective model and thinking level for one of the 3 Swarm roles
 * (`orchestrator` | `worker` | `validator`), applying explicit per-call overrides first.
 */
export function resolveRoleModel(
  role: SwarmModelRole,
  settings: SwarmSettings,
  override?: string,
  thinkingOverride?: ThinkingLevel,
): { model?: string; thinkingLevel?: ThinkingLevel } {
  let defaultModel: string | undefined;
  let defaultThinking: ThinkingLevel | undefined;

  if (role === "orchestrator") {
    defaultModel = settings.orchestratorModel;
    defaultThinking = settings.orchestratorThinkingLevel;
  } else if (role === "worker") {
    defaultModel = settings.workerModel;
    defaultThinking = settings.workerThinkingLevel;
  } else {
    defaultModel = settings.validatorModel;
    defaultThinking = settings.validatorThinkingLevel;
  }

  const effectiveModel = override?.trim() || defaultModel?.trim() || undefined;
  const effectiveThinking = thinkingOverride ?? defaultThinking;
  return {
    model: effectiveModel,
    thinkingLevel: effectiveThinking,
  };
}

function formatModelId(model: { provider?: string; id?: string } | undefined): string | undefined {
  if (!model?.id) {
    return undefined;
  }
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

// ============================================================================
// Scope, Path Normalization & Command Safety Guards
// ============================================================================

const PROTECTED_PREFIXES = [".pi/swarm", ".swarm", ".git"] as const;

/**
 * Normalizes a repo-relative path to POSIX separators without leading `./` or trailing `/`.
 */
export function normalizeRepoPath(filePath: string): string {
  const posix = filePath.replace(/\\/g, "/").trim();
  const normalized = path.posix.normalize(posix);
  if (normalized === "." || normalized === "./") {
    return ".";
  }
  return normalized.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Resolves `targetPath` relative to `worktreePath`.
 * Returns `null` if `targetPath` escapes outside `worktreePath`.
 */
export function resolveWorktreeRelativePath(worktreePath: string, targetPath: string): string | null {
  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, targetPath);
  const rel = path.relative(root, resolved);
  if (rel === "") {
    return ".";
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return normalizeRepoPath(rel);
}

/**
 * Returns true if `relPath` targets `.pi/swarm/`, `.swarm/`, or `.git/` internals.
 */
export function isProtectedSwarmPath(relPath: string): boolean {
  const norm = normalizeRepoPath(relPath);
  if (!norm || norm === ".") {
    return false;
  }
  return PROTECTED_PREFIXES.some((prefix) => norm === prefix || norm.startsWith(`${prefix}/`));
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if ("\\^$+?.()|[]{}".includes(ch)) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

/**
 * Checks whether a normalized repo-relative path falls inside any declared scope entry.
 * Always rejects protected Swarm/Git internal paths and parent traversal (`..`).
 */
export function isPathInScope(relPath: string, scope: readonly string[]): boolean {
  const norm = normalizeRepoPath(relPath);
  if (!norm || norm === ".." || norm.startsWith("../") || path.posix.isAbsolute(norm)) {
    return false;
  }
  if (isProtectedSwarmPath(norm)) {
    return false;
  }
  if (scope.length === 0) {
    return false;
  }

  for (const rawEntry of scope) {
    const entry = normalizeRepoPath(rawEntry);
    if (!entry) {
      continue;
    }
    if (entry === "." || entry === "*" || entry === "**" || entry === "**/*") {
      return true;
    }
    if (entry.includes("*") || entry.includes("?")) {
      if (globToRegExp(entry).test(norm)) {
        return true;
      }
      continue;
    }
    if (norm === entry || norm.startsWith(`${entry}/`)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns every file from `files` that violates `scope` or touches protected Swarm/Git paths.
 */
export function findOutOfScopeFiles(files: readonly string[], scope: readonly string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const norm = normalizeRepoPath(file);
    if (!isPathInScope(norm, scope)) {
      violations.push(norm);
    }
  }
  return violations;
}

export interface CommandGuardResult {
  allowed: boolean;
  reason?: string;
}

const MUTATING_REDIRECTION_RE = /(?<![=\->&])(?:[0-9]?>{1,2}|&>|<>)\s*(?!\/dev\/null\b|&\d\b)\S/;

const VALIDATOR_FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: MUTATING_REDIRECTION_RE,
    reason: "Output redirection to files is blocked in read-only validator sessions.",
  },
  {
    pattern: /\btee\b/,
    reason: "`tee` is blocked in read-only validator sessions.",
  },
  {
    pattern: /\bsed\b[^\n;|&]*\s-i(?:\b|['".])/,
    reason: "In-place `sed -i` is blocked in read-only validator sessions.",
  },
  {
    pattern: /\bperl\b[^\n;|&]*\s-[a-zA-Z]*i/,
    reason: "In-place `perl -i` is blocked in read-only validator sessions.",
  },
  {
    pattern: /(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|truncate|dd|install|patch)\b/,
    reason: "Filesystem mutation commands are blocked in read-only validator sessions.",
  },
  {
    pattern:
      /\bgit\b(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+(?:add|commit|rm|mv|checkout|switch|reset|rebase|merge|cherry-pick|clean|stash|push|pull|fetch|tag|apply|am|restore|worktree)\b/,
    reason: "Mutating git subcommands are blocked in read-only validator sessions.",
  },
  {
    pattern: /\bgit\b[^\n;|&]*\bbranch\b[^\n;|&]*\s-(?:d|D|m|M|c|C|f)\b/,
    reason: "Mutating `git branch` flags are blocked in read-only validator sessions.",
  },
  {
    pattern: /\b(?:npm|pnpm|yarn|bun)\b\s+(?:install|i|add|remove|uninstall|rm|update|upgrade|publish|link)\b/,
    reason: "Package-mutating commands are blocked in read-only validator sessions.",
  },
];

/**
 * Guard for bash commands executed by an independent read-only Validator or Final Validator.
 * Rejects file writes, redirects, mutating git commands, and package mutations
 * while permitting inspection and verification commands (git diff/log/show, tests, typecheck, lint).
 */
export function isReadOnlyValidationCommand(command: string): CommandGuardResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: true };
  }
  for (const rule of VALIDATOR_FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { allowed: false, reason: rule.reason };
    }
  }
  return { allowed: true };
}

/**
 * Guard for bash commands executed by a build/artifact Worker.
 * Blocks direct mutation of `.pi/swarm/` / `.swarm/` internals and manual
 * `git merge` / `git push` / `git worktree` / base-branch checkout operations.
 */
export function isForbiddenWorkerBashCommand(command: string, baseBranch: string): CommandGuardResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: true };
  }

  if (
    /(?:^|[\s"'`\/])(?:\.pi\/swarm|\.swarm)(?:\/|$|\s|["'`])/.test(trimmed) &&
    /(?:>|>>|\b(?:rm|mv|cp|tee|touch|mkdir|chmod|truncate|sed\s+-i|perl\s+-i|cat\s+<<)\b)/.test(trimmed)
  ) {
    return {
      allowed: false,
      reason: `Workers are forbidden from mutating \`${SWARM_DIR}/\` directly. Use Swarm tools instead.`,
    };
  }

  if (/\bgit\b(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+(?:merge|push|worktree)\b/.test(trimmed)) {
    return {
      allowed: false,
      reason: "Workers must not run `git merge`, `git push`, or `git worktree`. Only the Swarm Orchestrator merges.",
    };
  }

  if (baseBranch) {
    const escapedBase = baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const checkoutBaseRe = new RegExp(
      `\\bgit\\b(?:\\s+-[^\\s]+(?:\\s+[^\\s]+)?)*\\s+(?:checkout|switch)\\s+(?:-f\\s+)?${escapedBase}(?:\\s|$|[;&|])`,
    );
    if (checkoutBaseRe.test(trimmed)) {
      return {
        allowed: false,
        reason: `Workers must stay on their mission branch and must not switch to base branch \`${baseBranch}\`.`,
      };
    }
  }

  return { allowed: true };
}

// ============================================================================
// Shared Board & Status Custom Tools (Workers, Validators & Final Validators)
// ============================================================================

function formatToolError(err: unknown): AgentToolResult<unknown> {
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

interface BoardToolContext {
  runId: string;
  from: string;
  fromRole: CallerRole;
  missionId?: string;
  store?: ISwarmStore;
  board?: ISwarmBoard;
  onBoardPost?: (msg: BoardMessage) => Promise<void> | void;
}

const SUBAGENT_BOARD_KINDS = [
  "chat",
  "handoff",
  "decision",
  "fix",
  "review",
  "done",
  "brief",
  "stall",
] as const;

function buildBoardAndStatusTools(ctx: BoardToolContext): ToolDefinition[] {
  const statusTool = defineTool({
    name: SWARM_STATUS_TOOL,
    label: "Swarm Status",
    description: "Inspect current Swarm run status, missions, and roster (read-only).",
    promptSnippet: "Inspect read-only Swarm run status and roster.",
    parameters: Type.Object({}),
    async execute() {
      try {
        if (!ctx.store) {
          return {
            content: [{ type: "text", text: `Swarm agent ${ctx.from} (${ctx.fromRole})` }],
            details: { runId: ctx.runId, from: ctx.from },
          };
        }
        const run = await ctx.store.loadRun(ctx.runId);
        const head = await ctx.store.getBoardHead(ctx.runId).catch(() => 0);
        const lines = [
          `Run ${run.id} (${run.status}) | base=${run.baseBranch} | board=#${head}`,
          "Missions:",
          ...run.missionOrder.map((id) => {
            const m = run.missions[id];
            return m ? `- ${m.id} (${m.kind}) [${m.status}] ${m.title}` : "";
          }),
          "Roster:",
          ...Object.values(run.roster).map(
            (r) => `- ${r.name} (${r.role}) [${r.status}]${r.model ? ` model=${r.model}` : ""}`,
          ),
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { runId: run.id, status: run.status, boardHead: head },
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  });

  const boardPostTool = defineTool({
    name: SWARM_BOARD_POST_TOOL,
    label: "Swarm Board Post",
    description:
      "Post a short message to the shared Swarm message board. Use `@name` (e.g. `@M2`, `@validator-M1`, `@orchestrator`) only to wake peers who need to act; reference earlier posts by `#seq`.",
    promptSnippet: "Post a message to the shared Swarm message board (with optional @mentions).",
    promptGuidelines: [
      `Use ${SWARM_BOARD_POST_TOOL} for short peer-to-peer handoffs, questions, or blockers. Reference prior posts as #seq instead of copy-pasting; use @name only as a wakeup doorbell.`,
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Concise board message text (include @name to wake specific peers)." }),
      kind: Type.Optional(
        stringEnum(SUBAGENT_BOARD_KINDS, {
          description: 'Optional message kind (defaults to "chat").',
          default: "chat",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const text = params.text.trim();
        if (!text) {
          throw new SwarmProtocolError("INVALID_TRANSITION", "Board message text must be non-empty.");
        }
        const kind: BoardMessageKind = params.kind ?? "chat";
        const postInput = {
          from: ctx.from,
          fromRole: ctx.fromRole,
          text,
          kind,
          missionId: ctx.missionId,
        };

        let msg: BoardMessage;
        if (ctx.store) {
          msg = await ctx.store.postBoardMessage(ctx.runId, postInput);
        } else if (ctx.board) {
          msg = await ctx.board.post(ctx.runId, postInput);
        } else {
          msg = {
            seq: 0,
            runId: ctx.runId,
            from: ctx.from,
            fromRole: ctx.fromRole,
            text,
            mentions: [],
            kind,
            missionId: ctx.missionId,
            timestamp: new Date().toISOString(),
          };
        }

        if (ctx.onBoardPost) {
          await ctx.onBoardPost(msg);
        }

        const notified =
          msg.mentions.length > 0 ? ` (notified: ${msg.mentions.map((m) => `@${m}`).join(", ")})` : "";
        return {
          content: [{ type: "text", text: `Posted #${msg.seq} to swarm board${notified}.` }],
          details: msg,
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  });

  const boardReadTool = defineTool({
    name: SWARM_BOARD_READ_TOOL,
    label: "Swarm Board Read",
    description:
      "Read messages from the shared Swarm message board (oldest first). Pass `since` for unread messages, `seqs` to inspect specific `#seq` posts, or omit both for the latest messages.",
    promptSnippet: "Read messages from the shared Swarm message board.",
    parameters: Type.Object({
      since: Type.Optional(Type.Number({ description: "Return messages with seq > since." })),
      seqs: Type.Optional(
        Type.Array(Type.Number(), { description: "Fetch specific message sequence numbers only." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of messages to return (default 20)." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const opts = {
          since: params.since,
          seqs: params.seqs,
          limit: params.limit,
        };
        const res = ctx.store
          ? await ctx.store.readBoard(ctx.runId, opts)
          : ctx.board
            ? await ctx.board.read(ctx.runId, opts)
            : { messages: [], head: 0 };

        if (res.messages.length === 0) {
          return {
            content: [{ type: "text", text: `Board has no matching messages (head: #${res.head}).` }],
            details: res,
          };
        }
        const lines = res.messages.map((m) => formatBoardExcerptLine(m, 500));
        return {
          content: [
            {
              type: "text",
              text: `Swarm Board (head: #${res.head}, showing ${res.messages.length}):\n${lines.join("\n")}`,
            },
          ],
          details: res,
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  });

  return [statusTool, boardPostTool, boardReadTool];
}

// ============================================================================
// Worker & Validator Custom Tools
// ============================================================================

function buildWorkerCustomTools(
  request: WorkerSpawnRequest,
  onCaptureDone: (payload: WorkerDonePayload) => void,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // 1. swarm_worker_done (terminating current turn; parks warm if keepWarm)
  tools.push(
    defineTool({
      name: SWARM_WORKER_DONE_TOOL,
      label: "Swarm Worker Done",
      description: request.keepWarm
        ? "Signal that your mission work is complete (verified & cleanly committed for build/artifact, or findings recorded for survey). Posts [done] on the shared board and parks your session in warm waiting state with full memory intact."
        : "Signal that your mission work is complete (verified & cleanly committed for build/artifact, or findings recorded for survey). Immediately ends this worker session.",
      promptSnippet: "Call when your mission work is complete and verified.",
      promptGuidelines: [
        `Always finish your mission by calling ${SWARM_WORKER_DONE_TOOL} with a concise summary and verification report.`,
      ],
      parameters: Type.Object({
        summary: Type.String({ description: "Concise summary of completed work or findings." }),
        verificationRan: Type.Optional(
          Type.String({ description: "Verification commands/checks executed and their results." }),
        ),
        notes: Type.Optional(
          Type.String({ description: "Optional notes, caveats, or human sign-off guidance." }),
        ),
      }),
      async execute(_toolCallId, params) {
        const payload: WorkerDonePayload = {
          missionId: request.mission.id,
          summary: params.summary.trim(),
          verificationRan: params.verificationRan?.trim() || undefined,
          notes: params.notes?.trim() || undefined,
        };
        onCaptureDone(payload);
        if (request.onWorkerDone) {
          await request.onWorkerDone(payload);
        }
        return {
          content: [
            {
              type: "text",
              text: request.keepWarm
                ? `Completion recorded for mission ${request.mission.id}. Parking warm in waiting state.`
                : `Completion recorded for mission ${request.mission.id}. Ending worker session.`,
            },
          ],
          details: payload,
          terminate: true,
        };
      },
    }),
  );

  // 2-4. swarm_status, swarm_board_post, swarm_board_read
  tools.push(
    ...buildBoardAndStatusTools({
      runId: request.runId,
      from: request.name,
      fromRole: "worker",
      missionId: request.mission.id,
      store: request.store,
      board: request.board,
      onBoardPost: request.onBoardPost,
    }),
  );

  // 5. swarm_mission (worker-scoped: get / progress / task_done only)
  tools.push(
    defineTool({
      name: SWARM_MISSION_TOOL,
      label: "Swarm Mission",
      description:
        "Inspect your mission or update progress/checklist items (actions: get, progress, task_done). Workers cannot abandon or patch scope directly.",
      promptSnippet: "Read mission details or mark progress / checklist items done.",
      promptGuidelines: [
        `Use ${SWARM_MISSION_TOOL} with action="task_done" to check off completed checklist items and action="progress" to report progress.`,
      ],
      parameters: Type.Object({
        action: stringEnum(["get", "progress", "task_done"] as const, {
          description: "Mission action to perform.",
        }),
        missionId: Type.Optional(
          Type.String({ description: "Mission ID (defaults to your assigned mission; writes restricted to own mission)." }),
        ),
        summary: Type.Optional(Type.String({ description: "Progress summary (for action=progress)." })),
        taskIds: Type.Optional(
          Type.Array(Type.String(), { description: "Checklist task IDs completed (for action=task_done)." }),
        ),
      }),
      async execute(_toolCallId, params) {
        try {
          if (!request.store) {
            return {
              content: [{ type: "text", text: `Mission ${request.mission.id}: ${request.mission.status}` }],
              details: { missionId: request.mission.id },
            };
          }
          const targetId = params.missionId?.trim() || request.mission.id;
          if (params.action === "get") {
            const run = await request.store.loadRun(request.runId);
            const m = run.missions[targetId];
            if (!m) {
              throw new SwarmProtocolError("NOT_FOUND", `Mission "${targetId}" not found.`);
            }
            return {
              content: [{ type: "text", text: JSON.stringify(m, null, 2) }],
              details: m,
            };
          }

          if (targetId !== request.mission.id) {
            throw new SwarmProtocolError(
              "ROLE_FORBIDDEN",
              `Worker ${request.name} (${request.agentId}) may only update its own mission (${request.mission.id}), not "${targetId}".`,
            );
          }

          if (params.action === "progress") {
            if (!params.summary?.trim()) {
              throw new SwarmProtocolError("INVALID_TRANSITION", "summary is required for action=progress.");
            }
            const updated = await request.store.updateMission(request.runId, targetId, {
              progressSummary: params.summary.trim(),
              callerRole: "worker",
              actor: request.name,
            });
            return {
              content: [{ type: "text", text: `Updated progress for ${targetId}.` }],
              details: updated.missions[targetId],
            };
          }

          if (params.action === "task_done") {
            const ids = params.taskIds ?? [];
            if (ids.length === 0) {
              throw new SwarmProtocolError("INVALID_TRANSITION", "taskIds must be non-empty for action=task_done.");
            }
            const updated = await request.store.updateMission(request.runId, targetId, {
              taskDoneIds: ids,
              callerRole: "worker",
              actor: request.name,
            });
            return {
              content: [{ type: "text", text: `Marked task(s) done on ${targetId}: ${ids.join(", ")}` }],
              details: updated.missions[targetId],
            };
          }

          throw new SwarmProtocolError("ROLE_FORBIDDEN", `Unsupported worker action: ${String(params.action)}`);
        } catch (err) {
          return formatToolError(err);
        }
      },
    }),
  );

  // 6. swarm_finding (record or list findings)
  tools.push(
    defineTool({
      name: SWARM_FINDING_TOOL,
      label: "Swarm Finding",
      description: "Record structured survey/diagnostic findings or list existing run findings.",
      promptSnippet: "Record structured findings (especially for survey missions) or read upstream findings.",
      promptGuidelines: [
        `Use ${SWARM_FINDING_TOOL} to record structured research findings so downstream missions inherit them.`,
      ],
      parameters: Type.Object({
        action: Type.Optional(
          stringEnum(["record", "list"] as const, {
            description: "Defaults to 'record'.",
            default: "record",
          }),
        ),
        title: Type.Optional(Type.String({ description: "Short finding title (required for record)." })),
        summary: Type.Optional(Type.String({ description: "Concise takeaway (required for record)." })),
        details: Type.Optional(
          Type.String({ description: "Detailed evidence, file paths, constraints (required for record)." }),
        ),
        files: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths." })),
        missionId: Type.Optional(Type.String({ description: "Optional filter for action=list." })),
      }),
      async execute(_toolCallId, params) {
        try {
          if (!request.store) {
            return {
              content: [{ type: "text", text: "Finding recorded (in-memory transport without store)." }],
              details: params,
            };
          }
          const action = params.action ?? "record";
          if (action === "list") {
            const run = await request.store.loadRun(request.runId);
            const items = params.missionId
              ? run.findings.filter((f) => f.missionId === params.missionId)
              : run.findings;
            const text =
              items.length === 0
                ? "No findings recorded yet."
                : items.map((f) => `[${f.missionId}] ${f.title}: ${f.summary}\n${f.details}`).join("\n\n");
            return {
              content: [{ type: "text", text }],
              details: { count: items.length, findings: items },
            };
          }
          if (!params.title?.trim() || !params.summary?.trim() || !params.details?.trim()) {
            throw new SwarmProtocolError(
              "INVALID_TRANSITION",
              "title, summary, and details are required when recording a finding.",
            );
          }
          const record = await request.store.recordFinding(request.runId, {
            missionId: request.mission.id,
            author: request.name,
            title: params.title.trim(),
            summary: params.summary.trim(),
            details: params.details.trim(),
            files: params.files,
          });
          return {
            content: [{ type: "text", text: `Recorded finding ${record.id}: "${record.title}"` }],
            details: record,
          };
        } catch (err) {
          return formatToolError(err);
        }
      },
    }),
  );

  return tools;
}

function buildValidatorVerdictTool(
  request: ValidatorSpawnRequest,
  onCaptureVerdict: (verdict: MissionReviewVerdict) => void,
): ToolDefinition {
  const FindingSchema = Type.Object({
    severity: stringEnum(["p1", "p2", "note"] as const, {
      description: "p1 = blocking defect, p2 = should fix before merge, note = informational.",
    }),
    title: Type.String({ description: "Short finding title." }),
    detail: Type.String({ description: "Concrete explanation of the defect and evidence." }),
    file: Type.Optional(Type.String({ description: "Repo-relative file path if applicable." })),
    line: Type.Optional(Type.Number({ description: "1-based line number if applicable." })),
    suggestion: Type.Optional(Type.String({ description: "Concrete fix suggestion." })),
  });

  const CheckSchema = Type.Object({
    name: Type.String({ description: "Check name (e.g., 'scope', 'typecheck', 'unit-tests', 'security')." }),
    passed: Type.Boolean({ description: "Whether the check passed." }),
    detail: Type.Optional(Type.String({ description: "Brief evidence or failure summary." })),
  });

  return defineTool({
    name: SWARM_REVIEW_VERDICT_TOOL,
    label: "Swarm Review Verdict",
    description:
      "Submit your structured independent validation verdict pinned to the audited commit SHA and finish this validation turn.",
    promptSnippet: "Submit structured validation verdict (status, merge, findings, checks, decision).",
    promptGuidelines: [
      `Always finish your audit by calling ${SWARM_REVIEW_VERDICT_TOOL} with consistent status, merge decision, findings, checks, and rationale.`,
    ],
    parameters: Type.Object({
      status: Type.String({
        description: 'Severity status: "clean", "p1-Nitems", or "p2-Nitems" matching findings.',
      }),
      merge: stringEnum(["merge", "fix-then-merge", "hold"] as const, {
        description: '"merge" only if status is "clean"; "fix-then-merge" for actionable fixes; "hold" for human/design hold.',
      }),
      findings: Type.Array(FindingSchema, {
        description: "All findings discovered during validation (empty array if clean).",
      }),
      checks: Type.Array(CheckSchema, {
        description: "Checklist of verification criteria audited.",
      }),
      decision: Type.String({
        description: "Concise overall audit rationale.",
      }),
    }),
    async execute(_toolCallId, params) {
      try {
        const findings: ReviewFinding[] = params.findings.map((f) => ({
          severity: f.severity,
          title: f.title.trim(),
          detail: f.detail.trim(),
          file: f.file?.trim() || undefined,
          line: f.line,
          suggestion: f.suggestion?.trim() || undefined,
        }));
        const checks: ReviewCheck[] = params.checks.map((c) => ({
          name: c.name.trim(),
          passed: c.passed,
          detail: c.detail?.trim() || undefined,
        }));

        const expectedStatus = computeReviewSeverityStatus(findings);
        const submittedStatus = params.status.trim();
        if (!isValidReviewSeverityStatus(submittedStatus)) {
          throw new SwarmProtocolError(
            "INVALID_TRANSITION",
            `Invalid validation status "${submittedStatus}". Expected "clean", "p1-Nitems", or "p2-Nitems" (computed from findings: "${expectedStatus}").`,
          );
        }
        if (submittedStatus !== expectedStatus) {
          throw new SwarmProtocolError(
            "INVALID_TRANSITION",
            `Validation status "${submittedStatus}" does not match findings (expected "${expectedStatus}"). Please align status with findings.`,
          );
        }

        const merge: ReviewMergeDecision = params.merge;
        if (merge === "merge" && submittedStatus !== "clean") {
          throw new SwarmProtocolError(
            "INVALID_TRANSITION",
            `Cannot set merge="merge" when status is "${submittedStatus}". Use "fix-then-merge" or "hold".`,
          );
        }

        const verdict: MissionReviewVerdict = {
          commitSha: request.targetCommitSha ?? "",
          missionId: request.mission.id,
          branch: request.branch,
          reviewedAt: new Date().toISOString(),
          reviewerAgentId: request.agentId,
          status: submittedStatus,
          merge,
          findings,
          checks,
          decision: params.decision.trim(),
          round: request.mission.reviewRound + 1,
        };

        onCaptureVerdict(verdict);
        if (request.onReviewVerdict) {
          await request.onReviewVerdict(verdict);
        }

        return {
          content: [
            {
              type: "text",
              text: `Validation verdict submitted for ${request.mission.id}@${verdict.commitSha.slice(0, 12)}: ${verdict.status} (${verdict.merge}).`,
            },
          ],
          details: verdict,
          terminate: true,
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  });
}

function buildFinalValidatorVerdictTool(
  request: FinalValidatorSpawnRequest,
  onCaptureVerdict: (verdict: FinalAuditVerdict) => void,
): ToolDefinition {
  const FindingSchema = Type.Object({
    severity: stringEnum(["p1", "p2", "note"] as const, {
      description: "p1 = blocking defect/missing goal requirement, p2 = important integration gap, note = informational.",
    }),
    title: Type.String({ description: "Short finding title." }),
    detail: Type.String({ description: "Concrete explanation of the defect and evidence." }),
    file: Type.Optional(Type.String({ description: "Repo-relative file path if applicable." })),
    line: Type.Optional(Type.Number({ description: "1-based line number if applicable." })),
    suggestion: Type.Optional(Type.String({ description: "Concrete fix suggestion." })),
  });

  const CheckSchema = Type.Object({
    name: Type.String({ description: "Check name (e.g., 'typecheck', 'unit-tests', 'integration', 'contract')." }),
    passed: Type.Boolean({ description: "Whether the check passed." }),
    detail: Type.Optional(Type.String({ description: "Brief evidence or failure summary." })),
  });

  const RecommendedMissionSchema = Type.Object({
    title: Type.String({
      description: "Printable ASCII mission title containing letters/digits (used for unique feat/<slug> branch).",
    }),
    description: Type.String({ description: "Detailed fix specification for the follow-up mission." }),
    scope: Type.Array(Type.String(), {
      minItems: 1,
      description: "Concrete repo-relative POSIX scope paths (pairwise-disjoint across recommended build missions; no globs or ..).",
    }),
    verification: Type.String({ description: "Concrete verification command or criteria for this fix mission." }),
    kind: Type.Optional(
      stringEnum(["build", "artifact"] as const, {
        description: 'Mission kind ("build" default, or "artifact").',
        default: "build",
      }),
    ),
    tasks: Type.Optional(
      Type.Array(Type.String(), { description: "Optional checklist item titles." }),
    ),
  });

  return defineTool({
    name: SWARM_FINAL_VERDICT_TOOL,
    label: "Swarm Final Verdict",
    description:
      "Submit your structured Run-Level Final Validation verdict pinned to the audited base branch HEAD SHA and end this validation turn.",
    promptSnippet:
      "Submit structured final audit verdict (verdict, summary, checks, findings, optional recommended_missions).",
    promptGuidelines: [
      `Always conclude your final audit by calling ${SWARM_FINAL_VERDICT_TOOL} with verdict ("approved" | "disapproved"), summary, checks, findings, and optional recommended_missions when disapproved.`,
    ],
    parameters: Type.Object({
      verdict: stringEnum(["approved", "disapproved"] as const, {
        description: '"approved" only if the overall objective & verification contract are genuinely satisfied with zero p1 defects; otherwise "disapproved".',
      }),
      summary: Type.String({
        description: "Concise, evidence-backed overall verification verdict summary.",
      }),
      checks: Type.Array(CheckSchema, {
        description: "Checklist of verification contract items and integration checks executed.",
      }),
      findings: Type.Array(FindingSchema, {
        description: "All findings discovered during final validation (empty array if clean).",
      }),
      recommended_missions: Type.Optional(
        Type.Array(RecommendedMissionSchema, {
          description:
            'Optional concrete follow-up fix missions when verdict is "disapproved". Must use printable ASCII titles and pairwise-disjoint concrete scope paths.',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const summary = params.summary.trim();
        if (!summary) {
          throw new SwarmProtocolError("INVALID_TRANSITION", "Final verdict summary must be non-empty.");
        }

        const findings: ReviewFinding[] = params.findings.map((f) => ({
          severity: f.severity,
          title: f.title.trim(),
          detail: f.detail.trim(),
          file: f.file?.trim() || undefined,
          line: f.line,
          suggestion: f.suggestion?.trim() || undefined,
        }));
        const checks: ReviewCheck[] = params.checks.map((c) => ({
          name: c.name.trim(),
          passed: c.passed,
          detail: c.detail?.trim() || undefined,
        }));

        if (params.verdict === "approved" && findings.some((f) => f.severity === "p1")) {
          throw new SwarmProtocolError(
            "INVALID_TRANSITION",
            'Cannot submit verdict="approved" while blocking p1 findings exist. Either resolve severity or submit verdict="disapproved".',
          );
        }

        const recommendedMissions: SuggestedFixMission[] | undefined =
          params.verdict === "disapproved" &&
          params.recommended_missions &&
          params.recommended_missions.length > 0
            ? params.recommended_missions.map((m) => ({
                title: m.title.trim(),
                description: m.description.trim(),
                scope: m.scope.map((s) => s.trim()).filter(Boolean),
                verification: m.verification.trim(),
                ...(m.kind ? { kind: m.kind } : {}),
                ...(m.tasks && m.tasks.length > 0
                  ? { tasks: m.tasks.map((t) => t.trim()).filter(Boolean) }
                  : {}),
              }))
            : undefined;

        const verdict: FinalAuditVerdict = {
          commitSha: request.targetCommitSha,
          baseBranch: request.baseBranch,
          auditedAt: new Date().toISOString(),
          verifierAgentId: request.agentId,
          verdict: params.verdict,
          summary,
          checks,
          findings,
          ...(recommendedMissions && recommendedMissions.length > 0 ? { recommendedMissions } : {}),
          round: request.round,
        };

        onCaptureVerdict(verdict);
        if (request.onFinalVerdict) {
          await request.onFinalVerdict(verdict);
        }

        return {
          content: [
            {
              type: "text",
              text: `Final audit verdict submitted for ${request.baseBranch}@${verdict.commitSha.slice(0, 12)} (round ${verdict.round}): ${verdict.verdict}.`,
            },
          ],
          details: verdict,
          terminate: true,
        };
      } catch (err) {
        return formatToolError(err);
      }
    },
  });
}

// ============================================================================
// Inline Guard Extension Factories (Enforced via Pi tool_call Hook)
// ============================================================================

function createWorkerGuardExtensionFactory(request: WorkerSpawnRequest): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (request.mission.kind === "survey") {
        if (
          isToolCallEventType("write", event) ||
          isToolCallEventType("edit", event) ||
          isToolCallEventType("bash", event) ||
          isToolCallEventType("powershell", event)
        ) {
          return {
            block: true,
            reason: `Survey mission ${request.mission.id} is strictly read-only. Tool "${event.toolName}" is disabled.`,
          };
        }
        return undefined;
      }

      if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
        const rel = resolveWorktreeRelativePath(request.worktreePath, event.input.path);
        if (rel === null) {
          return {
            block: true,
            reason: `Path "${event.input.path}" escapes worktree root "${request.worktreePath}".`,
          };
        }
        if (isProtectedSwarmPath(rel)) {
          return {
            block: true,
            reason: `Workers are forbidden from editing protected path "${rel}" (${SWARM_DIR}/ or .git/).`,
          };
        }
        if (request.mission.scope.length > 0 && !isPathInScope(rel, request.mission.scope)) {
          return {
            block: true,
            reason: `Path "${rel}" is outside mission ${request.mission.id} declared scope [${request.mission.scope.join(", ")}]. Post @${ORCHESTRATOR_BOARD_NAME} via ${SWARM_BOARD_POST_TOOL} to request a scope patch.`,
          };
        }
        return undefined;
      }

      if (isToolCallEventType("bash", event)) {
        const check = isForbiddenWorkerBashCommand(event.input.command, request.baseBranch);
        if (!check.allowed) {
          return { block: true, reason: check.reason };
        }
      }

      if (isToolCallEventType("powershell", event)) {
        const check = isForbiddenWorkerBashCommand(event.input.command, request.baseBranch);
        if (!check.allowed) {
          return { block: true, reason: check.reason };
        }
      }

      return undefined;
    });
  };
}

function createValidatorGuardExtensionFactory(
  sessionLabel: string,
  enforceReadOnlyBash: boolean,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event) ||
        isToolCallEventType("powershell", event)
      ) {
        return {
          block: true,
          reason: `${sessionLabel} is strictly read-only. Tool "${event.toolName}" is blocked.`,
        };
      }

      if (enforceReadOnlyBash && isToolCallEventType("bash", event)) {
        const check = isReadOnlyValidationCommand(event.input.command);
        if (!check.allowed) {
          return {
            block: true,
            reason:
              check.reason ??
              `Mutating bash commands are blocked in read-only ${sessionLabel.toLowerCase()} sessions.`,
          };
        }
      }

      return undefined;
    });
  };
}

// ============================================================================
// Telemetry & Assistant Message Extraction Helpers
// ============================================================================

function formatToolActivity(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return toolName;
  }
  const record = args as Record<string, unknown>;
  const target =
    (typeof record.path === "string" && record.path) ||
    (typeof record.command === "string" && record.command.slice(0, 60)) ||
    (typeof record.pattern === "string" && record.pattern.slice(0, 40)) ||
    (typeof record.action === "string" && record.action) ||
    (typeof record.title === "string" && record.title.slice(0, 40)) ||
    "";
  return target ? `${toolName}: ${target}` : toolName;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
  if (!message) {
    return "";
  }
  const texts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  return texts.join("\n");
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

// ============================================================================
// InProcessPiTransport (Pi 1.5.2 SDK — Warm Persistent AgentSessions)
// ============================================================================

export interface InProcessPiTransportOptions {
  /** Override agentDir (defaults to Pi's getAgentDir()). */
  agentDir?: string;
  /** Enforce read-only bash guard inside validator sessions (default true). */
  validatorReadOnlyBash?: boolean;
  /** Optional session factory override (defaults to Pi's `createAgentSession`, primarily for deterministic tests). */
  createSession?: typeof createAgentSession;
}

interface InternalSessionLaunchSpec {
  agentId: string;
  name: string;
  missionId: string;
  role: RosterAgentRole;
  cwd: string;
  prompt: string;
  systemPromptAppendix?: string;
  keepWarm: boolean;
  modelOverride?: string;
  thinkingLevel?: ThinkingLevel;
  hostContext?: ExtensionContext;
  onTelemetry?: (event: WorkerTelemetryEvent) => void;
  allowedTools: string[];
  customTools: ToolDefinition[];
  guardFactory: ExtensionFactory;
  startActivity: string;
  getNudgePrompt?: () => string | null;
  resetCaptured: () => void;
  getCapturedResult: () => {
    workerDone?: WorkerDonePayload;
    reviewVerdict?: MissionReviewVerdict;
    finalAuditVerdict?: FinalAuditVerdict;
    summaryOverride?: string;
  };
}

/**
 * In-process multi-agent transport backed by Pi 1.5.2's `createAgentSession`.
 *
 * Supports Antigravity Swarm warm persistent sessions:
 * - When `keepWarm: true`, completed turns transition `"working"` -> `"waiting"` WITHOUT
 *   disposing `AgentSession`, preserving 100% conversation history across `wake(prompt)`
 *   and `switchModel(modelOverride, thinkingLevel)` calls!
 * - `kill()` permanently disposes the session (`"killed"` state).
 * - Respects all Pi 1.5.2 SDK invariants: shared `ModelRuntime`, `SettingsManager.create`,
 *   `SessionManager.inMemory`, `DefaultResourceLoader({ noExtensions: true })` + `reload()`
 *   + `bindExtensions({})`, custom tools explicitly included in `options.tools`, and
 *   `message_end` / `stopReason === "error"` / 429 inspection.
 */
export class InProcessPiTransport implements ISwarmTransport {
  private readonly agentDirOverride?: string;
  private readonly validatorReadOnlyBash: boolean;
  private readonly createSessionFn: typeof createAgentSession;
  private fallbackRuntimePromise?: Promise<ModelRuntime>;

  constructor(options: InProcessPiTransportOptions = {}) {
    this.agentDirOverride = options.agentDir;
    this.validatorReadOnlyBash = options.validatorReadOnlyBash ?? true;
    this.createSessionFn = options.createSession ?? createAgentSession;
  }

  async spawnWorker(request: WorkerSpawnRequest): Promise<PersistentAgentHandle> {
    return this.spawnMissionAgent({ ...request, role: "worker" });
  }

  async spawnValidator(request: ValidatorSpawnRequest): Promise<PersistentAgentHandle> {
    return this.spawnMissionAgent({ ...request, role: "validator" });
  }

  async spawnFinalValidator(request: FinalValidatorSpawnRequest): Promise<PersistentAgentHandle> {
    let capturedFinalVerdict: FinalAuditVerdict | undefined;

    const allowedTools = Array.from(
      new Set<string>([
        ...VALIDATOR_BUILTIN_TOOLS,
        "bash",
        ...VALIDATOR_BOARD_TOOLS,
        SWARM_FINAL_VERDICT_TOOL,
      ]),
    );
    const customTools: ToolDefinition[] = [
      ...buildBoardAndStatusTools({
        runId: request.runId,
        from: request.name,
        fromRole: "validator",
        missionId: FINAL_AUDIT_MISSION_ID,
        store: request.store,
        board: request.board,
        onBoardPost: request.onBoardPost,
      }),
      buildFinalValidatorVerdictTool(request, (verdict) => {
        capturedFinalVerdict = verdict;
      }),
    ];
    const guardFactory = createValidatorGuardExtensionFactory(
      `Final Validator for run ${request.runId}`,
      true,
    );

    return this.runPersistentSession({
      agentId: request.agentId,
      name: request.name,
      missionId: FINAL_AUDIT_MISSION_ID,
      role: "final-validator",
      cwd: request.repoRoot,
      prompt: request.prompt,
      systemPromptAppendix: request.systemPromptAppendix,
      keepWarm: request.keepWarm,
      modelOverride: request.modelOverride,
      thinkingLevel: request.thinkingLevel,
      hostContext: request.hostContext,
      onTelemetry: request.onTelemetry,
      allowedTools,
      customTools,
      guardFactory,
      startActivity: `starting final validation (r${request.round}/${request.maxRounds})`,
      getNudgePrompt: () =>
        capturedFinalVerdict
          ? null
          : `You have not yet submitted your structured final validation verdict. Call \`${SWARM_FINAL_VERDICT_TOOL}\` now with verdict ("approved" or "disapproved"), summary, checks, findings, and optional recommended_missions.`,
      resetCaptured: () => {
        capturedFinalVerdict = undefined;
      },
      getCapturedResult: () => ({
        finalAuditVerdict: capturedFinalVerdict,
        summaryOverride: capturedFinalVerdict?.summary,
      }),
    });
  }

  private async resolveModelRuntime(
    hostContext: ExtensionContext | undefined,
    agentDir: string,
  ): Promise<ModelRuntime> {
    const hostRegistry = hostContext?.modelRegistry as
      | {
          runtime?: ModelRuntime;
          getRegisteredProviderIds?: () => readonly string[];
          getRegisteredProviderConfig?: (id: string) => unknown;
          getRegisteredNativeProvider?: (id: string) => unknown;
        }
      | undefined;

    if (hostRegistry?.runtime) {
      return hostRegistry.runtime;
    }

    if (!this.fallbackRuntimePromise) {
      this.fallbackRuntimePromise = ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
      });
    }
    const runtime = await this.fallbackRuntimePromise;

    // Best-effort copy of any custom providers registered on host registry
    if (hostRegistry?.getRegisteredProviderIds) {
      for (const providerId of hostRegistry.getRegisteredProviderIds()) {
        if (runtime.getProvider(providerId)) {
          continue;
        }
        const nativeProvider = hostRegistry.getRegisteredNativeProvider?.(providerId);
        if (nativeProvider) {
          try {
            runtime.registerNativeProvider(
              nativeProvider as Parameters<ModelRuntime["registerNativeProvider"]>[0],
            );
            continue;
          } catch {
            // ignore duplicate/incompatible provider registration
          }
        }
        const config = hostRegistry.getRegisteredProviderConfig?.(providerId);
        if (config) {
          try {
            runtime.registerProvider(
              providerId,
              config as Parameters<ModelRuntime["registerProvider"]>[1],
            );
          } catch {
            // ignore duplicate/incompatible provider registration
          }
        }
      }
    }

    return runtime;
  }

  private async spawnMissionAgent(
    request: WorkerSpawnRequest | ValidatorSpawnRequest,
  ): Promise<PersistentAgentHandle> {
    let capturedWorkerDone: WorkerDonePayload | undefined;
    let capturedVerdict: MissionReviewVerdict | undefined;

    let allowedTools: string[];
    let customTools: ToolDefinition[];
    let guardFactory: ExtensionFactory;

    if (request.role === "validator") {
      allowedTools = Array.from(
        new Set<string>([
          ...VALIDATOR_BUILTIN_TOOLS,
          "bash",
          ...VALIDATOR_BOARD_TOOLS,
          SWARM_REVIEW_VERDICT_TOOL,
        ]),
      );
      customTools = [
        ...buildBoardAndStatusTools({
          runId: request.runId,
          from: request.name,
          fromRole: "validator",
          missionId: request.mission.id,
          store: request.store,
          board: request.board,
          onBoardPost: request.onBoardPost,
        }),
        buildValidatorVerdictTool(request, (verdict) => {
          capturedVerdict = verdict;
        }),
      ];
      guardFactory = createValidatorGuardExtensionFactory(
        `Validator ${request.name} for mission ${request.mission.id}`,
        this.validatorReadOnlyBash,
      );
    } else {
      customTools = buildWorkerCustomTools(request, (payload) => {
        capturedWorkerDone = payload;
      });
      if (request.mission.kind === "survey") {
        allowedTools = Array.from(
          new Set<string>(["read", "grep", "find", "ls", ...WORKER_SWARM_TOOLS]),
        );
      } else {
        allowedTools = Array.from(
          new Set<string>([...WORKER_BUILTIN_TOOLS, ...WORKER_SWARM_TOOLS]),
        );
      }
      guardFactory = createWorkerGuardExtensionFactory(request);
    }

    return this.runPersistentSession({
      agentId: request.agentId,
      name: request.name,
      missionId: request.mission.id,
      role: request.role,
      cwd: request.worktreePath,
      prompt: request.prompt,
      systemPromptAppendix: request.systemPromptAppendix,
      keepWarm: request.keepWarm,
      modelOverride: request.modelOverride,
      thinkingLevel: request.thinkingLevel,
      hostContext: request.hostContext,
      onTelemetry: request.onTelemetry,
      allowedTools,
      customTools,
      guardFactory,
      startActivity: request.role === "validator" ? "starting validation" : "starting mission",
      getNudgePrompt:
        request.role === "validator"
          ? () =>
              capturedVerdict
                ? null
                : `You have not yet submitted your structured verdict. Call \`${SWARM_REVIEW_VERDICT_TOOL}\` now with status, merge, findings, checks, and decision.`
          : undefined,
      resetCaptured: () => {
        capturedWorkerDone = undefined;
        capturedVerdict = undefined;
      },
      getCapturedResult: () => ({
        workerDone: capturedWorkerDone,
        reviewVerdict: capturedVerdict,
        summaryOverride: capturedWorkerDone?.summary ?? capturedVerdict?.decision,
      }),
    });
  }

  private async runPersistentSession(spec: InternalSessionLaunchSpec): Promise<PersistentAgentHandle> {
    let session: AgentSession | undefined;
    let modelRuntime: ModelRuntime | undefined;
    let unsubscribe: (() => void) | undefined;
    const disposedSessions = new WeakSet<AgentSession>();

    let state: RosterAgentStatus = "working";
    const getCurrentState = (): RosterAgentStatus => state;
    let currentModelId: string | undefined = spec.modelOverride?.trim() || formatModelId(spec.hostContext?.model);
    let promptActive = false;
    let switchingModel = false;
    let killed = false;
    const isKilled = (): boolean => killed;
    let abortedByCaller = false;
    const isAbortedByCaller = (): boolean => abortedByCaller;
    let abortReason: string | undefined;
    const assistantRef: { current: AssistantMessage | undefined } = { current: undefined };
    const getLastAssistant = (): AssistantMessage | undefined => assistantRef.current;
    let lastTextEmitAt = 0;

    const pendingSteers: Array<{ text: string; mode: "steer" | "followUp" }> = [];

    const emitTelemetry = (
      partial: Omit<WorkerTelemetryEvent, "agentId" | "name" | "missionId" | "role" | "timestamp">,
    ): void => {
      if (!spec.onTelemetry) {
        return;
      }
      try {
        spec.onTelemetry({
          agentId: spec.agentId,
          name: spec.name,
          missionId: spec.missionId,
          role: spec.role,
          timestamp: new Date().toISOString(),
          model: currentModelId,
          ...partial,
        });
      } catch {
        // telemetry errors must never crash agent execution
      }
    };

    const readStats = (
      activeSession: AgentSession | undefined,
    ): { tokens: number; breakdown?: TokenUsage; cost: number } => {
      if (!activeSession) {
        return { tokens: 0, cost: 0 };
      }
      try {
        const stats = activeSession.getSessionStats();
        return {
          tokens: stats.tokens.total,
          breakdown: {
            input: stats.tokens.input,
            output: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead,
            cacheWrite: stats.tokens.cacheWrite,
            total: stats.tokens.total,
          },
          cost: stats.cost,
        };
      } catch {
        return { tokens: 0, cost: 0 };
      }
    };

    const disposeSessionOnce = async (targetSession?: AgentSession): Promise<void> => {
      const activeSession = targetSession ?? session;
      if (!activeSession) {
        unsubscribe?.();
        unsubscribe = undefined;
        return;
      }
      if (session === activeSession) {
        session = undefined;
      }
      unsubscribe?.();
      unsubscribe = undefined;
      if (disposedSessions.has(activeSession)) {
        return;
      }
      disposedSessions.add(activeSession);
      try {
        if (activeSession.extensionRunner?.hasHandlers("session_shutdown")) {
          await activeSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } catch {
        // ignore shutdown hook errors
      }
      try {
        activeSession.dispose();
      } catch {
        // ignore dispose error
      }
    };

    const makeEarlyAbortResult = (): AgentTurnResult => {
      state = killed ? "killed" : "stopped";
      const reason = abortReason ?? "Aborted before session start";
      if (!killed) {
        emitTelemetry({
          type: "aborted",
          model: currentModelId,
          activity: "stopped",
          logLine: `aborted: ${reason}`,
          error: reason,
        });
      }
      return {
        agentId: spec.agentId,
        name: spec.name,
        missionId: spec.missionId,
        role: spec.role,
        outcome: "aborted",
        summary: reason,
        model: currentModelId,
        tokens: 0,
        cost: 0,
        error: reason,
        stopReason: "aborted",
      };
    };

    const runPromptTurn = async (
      promptText: string,
      options: { isInitialTurn: boolean },
    ): Promise<AgentTurnResult> => {
      let caughtError: unknown;
      assistantRef.current = undefined;

      try {
        if (options.isInitialTurn) {
          const agentDir = this.agentDirOverride ?? getAgentDir();
          modelRuntime = await this.resolveModelRuntime(spec.hostContext, agentDir);
          const settingsManager = SettingsManager.create(spec.cwd, agentDir);
          const sessionManager = SessionManager.inMemory(spec.cwd);

          let resolvedModel = spec.hostContext?.model;
          let resolvedThinking = spec.thinkingLevel;

          if (spec.modelOverride?.trim()) {
            const cliRes = resolveCliModel({
              cliModel: spec.modelOverride.trim(),
              cliThinking: spec.thinkingLevel,
              modelRuntime,
            });
            if (cliRes.model) {
              resolvedModel = cliRes.model;
            }
            if (cliRes.thinkingLevel && !resolvedThinking) {
              resolvedThinking = cliRes.thinkingLevel;
            }
          }

          if (killed || abortedByCaller) {
            return makeEarlyAbortResult();
          }

          const resourceLoader = new DefaultResourceLoader({
            cwd: spec.cwd,
            agentDir,
            settingsManager,
            noExtensions: true,
            appendSystemPrompt: spec.systemPromptAppendix ? [spec.systemPromptAppendix] : [],
            extensionFactories: [spec.guardFactory],
          });
          await resourceLoader.reload();

          if (killed || abortedByCaller) {
            return makeEarlyAbortResult();
          }

          const created = await this.createSessionFn({
            cwd: spec.cwd,
            agentDir,
            modelRuntime,
            model: resolvedModel,
            thinkingLevel: resolvedThinking,
            tools: spec.allowedTools,
            customTools: spec.customTools,
            resourceLoader,
            sessionManager,
            settingsManager,
          });

          if (killed || abortedByCaller) {
            await disposeSessionOnce(created.session);
            return makeEarlyAbortResult();
          }

          session = created.session;
          await session.bindExtensions({});

          if (killed || abortedByCaller) {
            await disposeSessionOnce(created.session);
            return makeEarlyAbortResult();
          }

          currentModelId =
            formatModelId(session.model ?? resolvedModel) ?? currentModelId;

          // Persistent telemetry + assistant message subscription kept alive across warm turns!
          unsubscribe = session.subscribe((event: AgentSessionEvent) => {
            switch (event.type) {
              case "tool_execution_start": {
                const activity = formatToolActivity(event.toolName, event.args);
                emitTelemetry({
                  type: "tool_start",
                  toolName: event.toolName,
                  activity,
                  logLine: `> ${activity}`,
                });
                break;
              }
              case "tool_execution_end": {
                emitTelemetry({
                  type: "tool_end",
                  toolName: event.toolName,
                  activity: event.isError ? `${event.toolName} (error)` : `${event.toolName} (ok)`,
                  logLine: `< ${event.toolName} (${event.isError ? "error" : "ok"})`,
                });
                break;
              }
              case "message_update": {
                if (event.assistantMessageEvent.type === "text_delta") {
                  const now = Date.now();
                  if (now - lastTextEmitAt >= 250) {
                    lastTextEmitAt = now;
                    const snippet = event.assistantMessageEvent.delta.replace(/\s+/g, " ").trim();
                    if (snippet) {
                      emitTelemetry({
                        type: "text_delta",
                        activity: "generating response",
                        logLine: snippet.slice(0, 120),
                      });
                    }
                  }
                }
                break;
              }
              case "message_end": {
                if (isAssistantMessage(event.message)) {
                  assistantRef.current = event.message;
                }
                break;
              }
              case "turn_end": {
                if (session) {
                  const usage = readStats(session);
                  emitTelemetry({
                    type: "turn_end",
                    tokens: usage.tokens,
                    tokenBreakdown: usage.breakdown,
                    cost: usage.cost,
                  });
                }
                break;
              }
              case "auto_retry_start": {
                emitTelemetry({
                  type: "rate_limit",
                  activity: `retrying (${event.attempt}/${event.maxAttempts})`,
                  logLine: `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
                  error: event.errorMessage,
                });
                break;
              }
              default:
                break;
            }
          });

          emitTelemetry({
            type: "started",
            model: currentModelId,
            activity: spec.startActivity,
            logLine: `spawned ${spec.role} ${spec.name} (${spec.agentId}) in ${spec.cwd}`,
          });
        }

        if (!session) {
          throw new SwarmProtocolError(
            "AGENT_KILLED",
            `Agent "${spec.name}" session is no longer active.`,
          );
        }

        if (killed || abortedByCaller) {
          await session.abort();
        } else {
          promptActive = true;
          const promptPromise = session.prompt(promptText, { expandPromptTemplates: false });

          // Drain any early steer/followUp calls buffered before session.prompt() started
          if (pendingSteers.length > 0) {
            for (const queued of pendingSteers.splice(0, pendingSteers.length)) {
              if (killed || abortedByCaller) {
                break;
              }
              if (queued.mode === "followUp") {
                await session.followUp(queued.text).catch(() => {});
              } else {
                await session.steer(queued.text).catch(() => {});
              }
            }
          }

          await promptPromise;

          // If a validator or final validator ended its initial audit turn without submitting a verdict, nudge once!
          if (options.isInitialTurn) {
            const nudgePrompt = spec.getNudgePrompt?.();
            const currentAssistant = getLastAssistant();
            if (
              nudgePrompt &&
              !killed &&
              !abortedByCaller &&
              currentAssistant?.stopReason !== "error" &&
              currentAssistant?.stopReason !== "aborted"
            ) {
              await session.prompt(nudgePrompt, { expandPromptTemplates: false });
            }
          }
        }
      } catch (err) {
        caughtError = err;
      } finally {
        promptActive = false;
        pendingSteers.length = 0;
      }

      // Read stats BEFORE potential disposal
      const usage = readStats(session);

      // Classify turn outcome (session.prompt() does NOT throw on provider/quota/429 errors!)
      let outcome: WorkerRunOutcome = "completed";
      let errorText: string | undefined;
      let retryAfterMs: number | undefined;
      const finalAssistant = getLastAssistant();
      const stopReason = finalAssistant?.stopReason;

      if (killed || abortedByCaller || stopReason === "aborted") {
        outcome = "aborted";
        errorText = abortReason ?? finalAssistant?.errorMessage ?? "Aborted";
      } else if (caughtError !== undefined) {
        errorText = caughtError instanceof Error ? caughtError.message : String(caughtError);
        if (isRateLimitOrTransientError(caughtError)) {
          outcome = "rate_limited";
          retryAfterMs = parseRetryAfterMs(caughtError);
        } else {
          outcome = "failed";
        }
      } else if (stopReason === "error") {
        errorText = finalAssistant?.errorMessage ?? "Provider returned stopReason=error";
        if (isRateLimitOrTransientError(errorText)) {
          outcome = "rate_limited";
          retryAfterMs = parseRetryAfterMs(errorText);
        } else {
          outcome = "failed";
        }
      }

      const captured = spec.getCapturedResult();
      const summary =
        captured.summaryOverride ||
        extractAssistantText(finalAssistant) ||
        errorText ||
        "";

      // Transition handle state cleanly: keep warm in `waiting` when keepWarm && alive!
      if (killed) {
        state = "killed";
        await disposeSessionOnce();
      } else if (spec.keepWarm && session) {
        if (outcome === "completed") {
          state = "waiting";
          emitTelemetry({
            type: "completed",
            activity: "completed turn",
            logLine: `completed: ${summary.slice(0, 120)}`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
          });
          emitTelemetry({
            type: "waiting",
            activity: "waiting (warm)",
            logLine: `${spec.name} parked warm in waiting state`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
          });
        } else if (outcome === "aborted") {
          state = "stopped";
          emitTelemetry({
            type: "aborted",
            activity: "stopped",
            logLine: `aborted: ${errorText ?? "stopped"}`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
            error: errorText,
          });
        } else if (outcome === "rate_limited") {
          // Keep warm session alive in `waiting` so orchestrator can hot-switch to a fallback model!
          state = "waiting";
          emitTelemetry({
            type: "rate_limit",
            activity: "rate limited (warm)",
            logLine: `rate_limited: ${errorText ?? "429"}`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
            error: errorText,
          });
        } else {
          state = "failed";
          emitTelemetry({
            type: "error",
            activity: "failed",
            logLine: `failed: ${errorText ?? "error"}`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
            error: errorText,
          });
        }
      } else {
        // Non-warm session or session failed before creation -> dispose cleanly
        state =
          outcome === "completed" || outcome === "aborted"
            ? "stopped"
            : "failed";
        await disposeSessionOnce();
        emitTelemetry({
          type:
            outcome === "completed"
              ? "completed"
              : outcome === "aborted"
                ? "aborted"
                : outcome === "rate_limited"
                  ? "rate_limit"
                  : "error",
          activity: outcome,
          logLine: errorText ? `${outcome}: ${errorText}` : `${outcome}: ${summary.slice(0, 120)}`,
          tokens: usage.tokens,
          tokenBreakdown: usage.breakdown,
          cost: usage.cost,
          error: errorText,
        });
      }

      return {
        agentId: spec.agentId,
        name: spec.name,
        missionId: spec.missionId,
        role: spec.role,
        outcome,
        summary,
        workerDone: captured.workerDone,
        reviewVerdict: captured.reviewVerdict,
        finalAuditVerdict: captured.finalAuditVerdict,
        model: currentModelId,
        tokens: usage.tokens,
        tokenBreakdown: usage.breakdown,
        cost: usage.cost,
        error: errorText,
        stopReason,
        retryAfterMs,
      };
    };

    let currentTurnPromise: Promise<AgentTurnResult> = runPromptTurn(spec.prompt, {
      isInitialTurn: true,
    });

    return {
      agentId: spec.agentId,
      name: spec.name,
      missionId: spec.missionId,
      role: spec.role,

      getState(): RosterAgentStatus {
        return state;
      },

      getModel(): string | undefined {
        return currentModelId;
      },

      async wake(prompt: string): Promise<AgentTurnResult> {
        if (killed || state === "killed") {
          throw new SwarmProtocolError(
            "AGENT_KILLED",
            `Agent "${spec.name}" (${spec.agentId}) has been killed and cannot be woken.`,
          );
        }
        if (switchingModel) {
          throw new SwarmProtocolError(
            "AGENT_NOT_WAITING",
            `Agent "${spec.name}" (${spec.agentId}) is currently switching models; retry wake once model switch completes.`,
          );
        }
        if (state !== "waiting" || promptActive) {
          throw new SwarmProtocolError(
            "AGENT_NOT_WAITING",
            `Agent "${spec.name}" (${spec.agentId}) is not waiting (currently "${state}"); cannot wake.`,
          );
        }
        if (!session) {
          throw new SwarmProtocolError(
            "AGENT_KILLED",
            `Agent "${spec.name}" (${spec.agentId}) does not have an active persistent session.`,
          );
        }

        // Preserve 100% conversation history on the exact same AgentSession!
        spec.resetCaptured();
        abortedByCaller = false;
        abortReason = undefined;
        state = "working";

        emitTelemetry({
          type: "woken",
          model: currentModelId,
          activity: "woken by board",
          logLine: `woken ${spec.name}: ${prompt.replace(/\s+/g, " ").trim().slice(0, 100)}`,
        });

        currentTurnPromise = runPromptTurn(prompt, { isInitialTurn: false });
        return currentTurnPromise;
      },

      async steer(message: string): Promise<void> {
        if (killed || state === "killed" || abortedByCaller) {
          return;
        }
        if (!session || !promptActive) {
          if (state === "working") {
            pendingSteers.push({ text: message, mode: "steer" });
          }
          return;
        }
        await session.steer(message);
      },

      async followUp(message: string): Promise<void> {
        if (killed || state === "killed" || abortedByCaller) {
          return;
        }
        if (!session || !promptActive) {
          if (state === "working") {
            pendingSteers.push({ text: message, mode: "followUp" });
          }
          return;
        }
        await session.followUp(message);
      },

      async switchModel(
        modelOverride: string,
        thinkingLevel?: ThinkingLevel,
      ): Promise<ModelSwitchResult> {
        if (killed || state === "killed") {
          throw new SwarmProtocolError(
            "AGENT_KILLED",
            `Agent "${spec.name}" (${spec.agentId}) has been killed and cannot switch models.`,
          );
        }
        if (switchingModel || state !== "waiting" || promptActive) {
          throw new SwarmProtocolError(
            "AGENT_NOT_WAITING",
            `Agent "${spec.name}" (${spec.agentId}) is not in waiting state (currently "${switchingModel ? "switchingModel" : state}"). Wait until it parks in waiting state before switching models.`,
          );
        }
        const activeSession = session;
        const activeRuntime = modelRuntime;
        if (!activeSession || !activeRuntime) {
          throw new SwarmProtocolError(
            "AGENT_KILLED",
            `Agent "${spec.name}" (${spec.agentId}) has no live session for model switching.`,
          );
        }

        const trimmed = modelOverride.trim();
        if (!trimmed) {
          throw new SwarmProtocolError("MODEL_NOT_FOUND", "Model identifier must be non-empty.");
        }

        const cliRes = resolveCliModel({
          cliModel: trimmed,
          cliThinking: thinkingLevel,
          modelRuntime: activeRuntime,
        });
        if (!cliRes.model) {
          throw new SwarmProtocolError(
            "MODEL_NOT_FOUND",
            `Model "${trimmed}" could not be resolved in the active Pi model registry.`,
            { modelOverride: trimmed },
          );
        }

        switchingModel = true;
        try {
          await activeSession.setModel(cliRes.model, { persist: false });

          const postSwitchState = getCurrentState();
          if (isKilled() || postSwitchState === "killed" || !session || session !== activeSession) {
            throw new SwarmProtocolError(
              "AGENT_KILLED",
              `Agent "${spec.name}" (${spec.agentId}) was killed while switching models.`,
            );
          }
          if (isAbortedByCaller() || postSwitchState !== "waiting") {
            throw new SwarmProtocolError(
              "AGENT_NOT_WAITING",
              `Agent "${spec.name}" (${spec.agentId}) stopped waiting (currently "${postSwitchState}") while switching models.`,
            );
          }

          const effectiveThinking = thinkingLevel ?? cliRes.thinkingLevel;
          if (effectiveThinking) {
            activeSession.setThinkingLevel(effectiveThinking, { persist: false });
          }

          const resolvedId = formatModelId(cliRes.model) ?? trimmed;
          currentModelId = resolvedId;

          emitTelemetry({
            type: "model_switched",
            model: resolvedId,
            activity: `switched model -> ${resolvedId}`,
            logLine: `model switched -> ${resolvedId}${effectiveThinking ? ` (${effectiveThinking})` : ""}`,
          });

          return {
            model: resolvedId,
            thinkingLevel: effectiveThinking,
          };
        } finally {
          switchingModel = false;
        }
      },

      async abort(reason?: string): Promise<void> {
        if (killed || state === "killed") {
          return;
        }
        abortedByCaller = true;
        abortReason = reason ?? "Aborted";
        if (session && promptActive) {
          try {
            await session.abort();
          } catch {
            // ignore abort race
          }
        } else {
          state = "stopped";
        }
      },

      async kill(reason?: string): Promise<void> {
        if (killed || state === "killed") {
          return;
        }
        killed = true;
        abortedByCaller = true;
        abortReason = reason ?? "Killed";
        state = "killed";
        pendingSteers.length = 0;

        if (session && promptActive) {
          try {
            await session.abort();
          } catch {
            // ignore abort race
          }
        }
        await disposeSessionOnce();

        emitTelemetry({
          type: "killed",
          model: currentModelId,
          activity: reason ?? "killed",
          logLine: `killed ${spec.name}: ${reason ?? "session disposed"}`,
        });
      },

      get currentTurn(): Promise<AgentTurnResult> {
        return currentTurnPromise;
      },
    };
  }
}

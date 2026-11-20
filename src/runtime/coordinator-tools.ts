import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import {
  ORCHESTRATOR_BOARD_NAME,
  SWARM_BOARD_POST_TOOL,
  SWARM_BOARD_READ_TOOL,
  SWARM_DIR,
  SWARM_FINDING_TOOL,
  SWARM_KILL_TOOL,
  SWARM_MERGE_TOOL,
  SWARM_MISSION_TOOL,
  SWARM_MODEL_TOOL,
  SWARM_PLAN_ADD_TOOL,
  SWARM_SPAWN_TOOL,
  SWARM_STATUS_TOOL,
  SWARM_TEARDOWN_TOOL,
  SWARM_VERIFY_TOOL,
} from "../constants.js";
import {
  type BoardMessageKind,
  type CallerRole,
  type ISwarmOrchestrator,
  type ISwarmStore,
  isSwarmProtocolError,
  type IWorktreeManager,
  type MissionPlanInput,
  type MissionRecord,
  type SpawnMissionOptions,
  type SwarmModelRole,
  SwarmProtocolError,
  type SwarmRoleModels,
  type SwarmRunState,
} from "../types.js";
import { formatBoardExcerptLine } from "./role-prompts.js";

// ============================================================================
// Helpers
// ============================================================================

const MAX_TOOL_OUTPUT_CHARS = 40_000;

const THINKING_LEVEL_VALUES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const BOARD_MESSAGE_KINDS = [
  "chat",
  "brief",
  "done",
  "review",
  "fix",
  "handoff",
  "decision",
  "model_switch",
  "stall",
] as const;

const CLEAR_MODEL_TOKENS = new Set(["default", "clear", "reset", "none"]);

function stringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>(StringEnum(values, options) as unknown as TSchema);
}

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

function errorResult(err: unknown): AgentToolResult<unknown> {
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
    return errorResult(err);
  }
}

function computeDisplayWaves(run: SwarmRunState): string[][] {
  const ordered = run.missionOrder.filter((id) => Boolean(run.missions[id]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const getDepth = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(id)) {
      return 0;
    }
    visiting.add(id);
    const m = run.missions[id];
    let maxDep = -1;
    if (m) {
      for (const dep of m.deps) {
        if (run.missions[dep]) {
          maxDep = Math.max(maxDep, getDepth(dep));
        }
      }
    }
    visiting.delete(id);
    const d = maxDep + 1;
    depth.set(id, d);
    return d;
  };

  const buckets = new Map<number, string[]>();
  for (const id of ordered) {
    const d = getDepth(id);
    const list = buckets.get(d) ?? [];
    list.push(id);
    buckets.set(d, list);
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, ids]) => ids);
}

function formatMissionLine(m: MissionRecord): string {
  const deps = m.deps.length > 0 ? ` deps=[${m.deps.join(",")}]` : "";
  const review =
    m.kind === "build" && m.latestReview
      ? ` validation=${m.latestReview.status}/${m.latestReview.merge}@${m.latestReview.commitSha.slice(0, 7)}`
      : "";
  const approved =
    m.kind === "artifact" && m.humanApprovedSha
      ? ` approved@${m.humanApprovedSha.slice(0, 7)}`
      : "";
  const stopped = m.humanStopped ? " [HUMAN-STOPPED]" : "";
  const doneTasks = m.tasks.filter((t) => t.done).length;
  const tasks = m.tasks.length > 0 ? ` tasks=${doneTasks}/${m.tasks.length}` : "";
  const err = m.error ? ` err="${m.error.slice(0, 100)}"` : "";
  return `  - ${m.id} (${m.kind}) [${m.status}] "${m.title}" branch=${m.branch} scope=[${m.scope.join(",")}]${deps}${tasks}${review}${approved}${stopped}${err}`;
}

function getDisplayFinalAuditRound(run: SwarmRunState): number {
  return run.finalAuditStatus === "running"
    ? run.finalAuditRound + 1
    : run.finalAuditRound;
}

function isSwarmModelRole(value: string): value is SwarmModelRole {
  return value === "orchestrator" || value === "worker" || value === "validator";
}

// ============================================================================
// Orchestrator Tools Dependencies & Factories (All 12 ORCHESTRATOR_TOOLS)
// ============================================================================

export interface OrchestratorToolDeps {
  store: ISwarmStore;
  worktree: IWorktreeManager;
  orchestrator: ISwarmOrchestrator;
  getActiveRunId: () => string | null;
  getSessionId?: () => string | undefined;
  getCallerRole?: () => CallerRole;
  /** Optional callback invoked when `swarm_model` updates a role default (`orchestrator`/`worker`/`validator`). */
  onRoleModelChanged?: (
    role: SwarmModelRole,
    model: string,
    thinkingLevel?: ThinkingLevel,
    reason?: string,
  ) => Promise<void> | void;
}

/**
 * Builds the `swarm_verify` orchestrator tool (`SWARM_VERIFY_TOOL`).
 * Supports `action: "status" | "run"` ONLY — skipping final verification is
 * strictly human-only via `/swarm verify --skip`.
 */
export function createSwarmVerifyTool(deps: OrchestratorToolDeps): ToolDefinition {
  const resolveRunId = (explicit?: string): string => {
    const id = explicit?.trim() || deps.getActiveRunId();
    if (!id) {
      throw new SwarmProtocolError("NOT_FOUND", "No active Swarm run. Start a run with `/swarm` first.");
    }
    return id;
  };

  return defineTool({
    name: SWARM_VERIFY_TOOL,
    label: "Swarm Verify",
    description:
      'Inspect Final Validation status ("status") or trigger/re-run the read-only Run-Level Final Validator ("run", optionally with force=true after manual base fixes). Skipping final validation is human-only via `/swarm verify --skip`.',
    promptSnippet: "Inspect final validation audit status or trigger/re-run Final Validator.",
    promptGuidelines: [
      `Use ${SWARM_VERIFY_TOOL} with action="status" to inspect Final Validator checks, findings, and recommended fix missions, or action="run" (with force=true after manual fixes) to re-run validation. Never attempt to skip validation — skipping is human-only.`,
    ],
    parameters: Type.Object({
      action: stringEnum(["run", "status"] as const, {
        description: '"status" to inspect final audit state & findings, or "run" to trigger final validation.',
      }),
      force: Type.Optional(
        Type.Boolean({
          description:
            'For action="run": force re-running final validation even if already approved or blocked on the same SHA (e.g. after manual fixes on baseBranch).',
        }),
      ),
      runId: Type.Optional(Type.String({ description: "Optional run ID (defaults to active run)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runToolSafe(async () => {
        const rawAction = String(params.action);
        if (rawAction === "skip") {
          throw new SwarmProtocolError(
            "ROLE_FORBIDDEN",
            "Skipping final validation is human-only via `/swarm verify --skip`.",
          );
        }

        const runId = resolveRunId(params.runId);

        if (params.action === "status") {
          const run = await deps.store.loadRun(runId);
          const snapshot = deps.orchestrator.getSnapshot();
          const audit = run.latestFinalAudit;
          const displayRound = getDisplayFinalAuditRound(run);

          const lines: string[] = [
            `# Final Validation — Run ${run.id}`,
            `- Enabled: ${run.finalValidatorEnabled ? "ON" : "OFF"} | Auto-Fix: ${run.autoFixOnAuditFail ? "ON" : "OFF"}`,
            `- Status: ${run.finalAuditStatus} | Round: ${displayRound}/${run.maxFinalAuditRounds}`,
            `- Base Branch: ${run.baseBranch}${run.lastAuditedSha ? ` | Last Audited SHA: ${run.lastAuditedSha}` : ""}`,
          ];

          if (snapshot.finalAuditRunningAgentId) {
            lines.push(`- Active Final Validator Agent: ${snapshot.finalAuditRunningAgentId}`);
          }
          if (run.finalAuditStatus === "skipped") {
            lines.push(
              `- Skipped By: ${run.finalAuditSkippedBy ?? "human"}${run.finalAuditSkippedAt ? ` at ${run.finalAuditSkippedAt}` : ""}${run.finalAuditSkipReason ? ` (${run.finalAuditSkipReason})` : ""}`,
            );
          }

          if (audit) {
            lines.push(
              "",
              `## Latest Verdict (Round ${audit.round} @ ${audit.commitSha.slice(0, 12)})`,
              `- Verdict: ${audit.verdict}`,
              `- Summary: ${audit.summary}`,
            );
            if (audit.checks.length > 0) {
              const passedCount = audit.checks.filter((c) => c.passed).length;
              lines.push("", `### Checks (${passedCount}/${audit.checks.length} passed)`);
              for (const c of audit.checks) {
                lines.push(`- [${c.passed ? "PASS" : "FAIL"}] ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
              }
            }
            if (audit.findings.length > 0) {
              lines.push("", `### Findings (${audit.findings.length})`);
              for (const f of audit.findings) {
                const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
                const sug = f.suggestion ? ` Suggestion: ${f.suggestion}` : "";
                lines.push(`- [${f.severity.toUpperCase()}] ${f.title}${loc}: ${f.detail}${sug}`);
              }
            }
            if (audit.recommendedMissions && audit.recommendedMissions.length > 0) {
              lines.push("", `### Recommended Fix Missions (${audit.recommendedMissions.length})`);
              for (const m of audit.recommendedMissions) {
                lines.push(
                  `- "${m.title}" (${m.kind ?? "build"}) scope=[${m.scope.join(", ")}] — ${m.description}`,
                );
              }
            }
          }

          return okResult(lines.join("\n"), {
            runId: run.id,
            finalValidatorEnabled: run.finalValidatorEnabled,
            autoFixOnAuditFail: run.autoFixOnAuditFail,
            finalAuditStatus: run.finalAuditStatus,
            round: displayRound,
            maxRounds: run.maxFinalAuditRounds,
            lastAuditedSha: run.lastAuditedSha,
            runningAgentId: snapshot.finalAuditRunningAgentId,
            checks: audit?.checks ?? [],
            findings: audit?.findings ?? [],
            recommendedMissions: audit?.recommendedMissions ?? [],
            latestFinalAudit: audit,
            skippedBy: run.finalAuditSkippedBy,
            skippedAt: run.finalAuditSkippedAt,
            skipReason: run.finalAuditSkipReason,
          });
        }

        if (params.action === "run") {
          const updated = await deps.orchestrator.runFinalAudit({
            runId,
            force: params.force ?? false,
            hostContext: ctx,
          });
          const snapshot = deps.orchestrator.getSnapshot();
          const displayRound = getDisplayFinalAuditRound(updated);
          return okResult(
            `Final validation triggered for run ${runId} (status=${updated.status}, finalAuditStatus=${updated.finalAuditStatus}, round=${displayRound}/${updated.maxFinalAuditRounds}${snapshot.finalAuditRunningAgentId ? `, agent=${snapshot.finalAuditRunningAgentId}` : ""}).`,
            {
              runId,
              status: updated.status,
              finalAuditStatus: updated.finalAuditStatus,
              round: displayRound,
              maxRounds: updated.maxFinalAuditRounds,
              lastAuditedSha: updated.lastAuditedSha,
              runningAgentId: snapshot.finalAuditRunningAgentId,
            },
          );
        }

        throw new SwarmProtocolError("INVALID_TRANSITION", `Unsupported action: ${rawAction}`);
      });
    },
  });
}

/**
 * Builds all 12 Pi Swarm orchestrator tools (`ORCHESTRATOR_TOOLS`).
 * All protocol invariants are strictly enforced via `SwarmProtocolError` -> `{ isError: true }`.
 */
export function createOrchestratorTools(deps: OrchestratorToolDeps): ToolDefinition[] {
  const resolveRunId = (explicit?: string): string => {
    const id = explicit?.trim() || deps.getActiveRunId();
    if (!id) {
      throw new SwarmProtocolError("NOT_FOUND", "No active Swarm run. Start a run with `/swarm` first.");
    }
    return id;
  };

  const callerRole = (): CallerRole => deps.getCallerRole?.() ?? "orchestrator";

  // --------------------------------------------------------------------------
  // 1. swarm_status
  // --------------------------------------------------------------------------
  const swarmStatusTool = defineTool({
    name: SWARM_STATUS_TOOL,
    label: "Swarm Status",
    description:
      "Read-only status summary of the active Swarm run: 3-role models, waves, missions, live/warm roster, shared board head, pending gates, rate-limit state, and recent ledger events.",
    promptSnippet: "Inspect active Swarm run waves, missions, warm roster, board head, models, and gates.",
    promptGuidelines: [
      `Use ${SWARM_STATUS_TOOL} to inspect current Swarm run status before taking orchestration actions.`,
    ],
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Optional run ID (defaults to active run)." })),
      includeEvents: Type.Optional(
        Type.Boolean({ description: "Include recent ledger events (default true)." }),
      ),
      eventLimit: Type.Optional(
        Type.Number({ description: "Max recent ledger events to display (default 10)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const runId = resolveRunId(params.runId);
        const run = await deps.store.loadRun(runId);
        const snapshot = deps.orchestrator.getSnapshot();
        const waves = computeDisplayWaves(run);

        const displayFinalRound = getDisplayFinalAuditRound(run);
        const lines: string[] = [
          `# Swarm Run ${run.id} (${run.status})`,
          `- Objective: ${run.objective}`,
          `- Base Branch: ${run.baseBranch} | Max Concurrency: ${run.maxConcurrency} | Validator: ${run.validatorEnabled ? `ON (max ${run.maxValidationRounds} rounds)` : "OFF"} | Final Validator: ${run.finalValidatorEnabled ? `ON (${run.finalAuditStatus}, r${displayFinalRound}/${run.maxFinalAuditRounds})` : "OFF"} | Warm Workers: ${run.keepWorkersWarm ? "ON" : "OFF"}`,
          `- Working: ${snapshot.workingAgentIds.length}/${snapshot.maxConcurrency} | Waiting (warm): ${snapshot.waitingAgentIds.length} | Board Head: #${snapshot.boardHead} | Tokens: ${snapshot.totalTokens} | Cost: $${snapshot.totalCost.toFixed(4)}`,
          `- Role Models: orchestrator=${snapshot.roleModels.orchestrator?.model ?? "host-default"} | worker=${snapshot.roleModels.worker?.model ?? "host-default"} | validator=${snapshot.roleModels.validator?.model ?? "host-default"}${snapshot.roleModels.fallbackModels && snapshot.roleModels.fallbackModels.length > 0 ? ` | fallbacks=[${snapshot.roleModels.fallbackModels.join(", ")}]` : ""}`,
        ];

        if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > Date.now()) {
          const secs = Math.ceil((snapshot.rateLimitUntil - Date.now()) / 1000);
          lines.push(
            `- Rate-Limit Backoff: ${secs}s remaining${snapshot.rateLimitReason ? ` (${snapshot.rateLimitReason})` : ""}`,
          );
        }

        lines.push("", "## Waves & Missions");
        for (let i = 0; i < waves.length; i++) {
          lines.push(`Wave ${i + 1}:`);
          for (const id of waves[i]!) {
            const m = run.missions[id];
            if (m) {
              lines.push(formatMissionLine(m));
            }
          }
        }

        const rosterEntries = Object.values(run.roster);
        if (rosterEntries.length > 0) {
          lines.push("", "## Roster");
          for (const r of rosterEntries) {
            const modelPart = r.model ? ` model=${r.model}` : "";
            const act = r.currentActivity ? ` — ${r.currentActivity}` : "";
            const stopped = r.humanStopped ? " [HUMAN-STOPPED]" : "";
            lines.push(
              `- ${r.name} (${r.role} on ${r.missionId}, id=${r.agentId}) [${r.status}]${modelPart} turns=${r.turns} board=#${r.lastReadBoardSeq}${stopped} tokens=${r.tokens} cost=$${r.cost.toFixed(4)}${act}`,
            );
          }
        }

        lines.push(
          "",
          "## Pending Gates",
          `- Pending validations: ${snapshot.pendingReviews.length > 0 ? snapshot.pendingReviews.join(", ") : "none"}`,
          `- Pending human artifact approvals: ${snapshot.pendingArtifactApprovals.length > 0 ? snapshot.pendingArtifactApprovals.join(", ") : "none"}`,
          `- Ready to merge: ${snapshot.readyToMerge.length > 0 ? snapshot.readyToMerge.join(", ") : "none"}`,
          `- Final validation: ${run.finalValidatorEnabled ? `${run.finalAuditStatus} (round ${displayFinalRound}/${run.maxFinalAuditRounds}${snapshot.finalAuditRunningAgentId ? `, agent=${snapshot.finalAuditRunningAgentId}` : ""})` : "disabled"}`,
          `- Unread @${ORCHESTRATOR_BOARD_NAME} board posts: ${snapshot.unreadOrchestratorMessages}`,
        );

        if (snapshot.recentBoard.length > 0) {
          const tail = snapshot.recentBoard.slice(-5);
          lines.push("", `## Recent Board (head #${snapshot.boardHead})`);
          for (const msg of tail) {
            lines.push(`- ${formatBoardExcerptLine(msg, 180)}`);
          }
        }

        if (params.includeEvents !== false) {
          const limit = Math.max(1, Math.min(50, Math.floor(params.eventLimit ?? 10)));
          const events = await deps.store.getRecentEvents(runId, limit);
          if (events.length > 0) {
            lines.push("", `## Recent Events (last ${events.length})`);
            for (const ev of events) {
              const target = ev.missionId ? ` [${ev.missionId}]` : "";
              lines.push(`- ${ev.timestamp} ${ev.type}${target}: ${ev.summary}`);
            }
          }
        }

        return okResult(lines.join("\n"), {
          runId: run.id,
          status: run.status,
          missionCount: run.missionOrder.length,
          runningCount: snapshot.runningCount,
          workingAgentIds: snapshot.workingAgentIds,
          waitingAgentIds: snapshot.waitingAgentIds,
          boardHead: snapshot.boardHead,
          roleModels: snapshot.roleModels,
          pendingReviews: snapshot.pendingReviews,
          pendingArtifactApprovals: snapshot.pendingArtifactApprovals,
          readyToMerge: snapshot.readyToMerge,
          finalAuditStatus: run.finalAuditStatus,
          finalAuditRunningAgentId: snapshot.finalAuditRunningAgentId,
        });
      });
    },
  });

  // --------------------------------------------------------------------------
  // 2. swarm_board_post
  // --------------------------------------------------------------------------
  const swarmBoardPostTool = defineTool({
    name: SWARM_BOARD_POST_TOOL,
    label: "Swarm Board Post",
    description:
      "Post a message to the shared Swarm message board. `@name` wakes a waiting agent with full context (or queues a follow-up on a working agent); `@all` broadcasts to all waiting agents.",
    promptSnippet: "Post a message to the shared Swarm message board (with optional @mentions).",
    promptGuidelines: [
      `Use ${SWARM_BOARD_POST_TOOL} to relay guidance, wake waiting agents (@M1, @validator-M1), or share swarm-wide decisions (@all). Refer to earlier posts by #seq.`,
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Message text to post on the shared board (use @name to wake peers)." }),
      kind: Type.Optional(
        stringEnum(BOARD_MESSAGE_KINDS, {
          description: 'Optional board message kind (defaults to "chat").',
          default: "chat",
        }),
      ),
      mission_id: Type.Optional(
        Type.String({ description: "Optional associated mission ID (e.g., M1)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const text = params.text.trim();
        if (!text) {
          throw new SwarmProtocolError("INVALID_TRANSITION", "Board message text must be non-empty.");
        }
        const kind: BoardMessageKind = params.kind ?? "chat";
        const role = callerRole();
        const msg = await deps.orchestrator.postToBoard({
          from: role === "human" ? "human" : ORCHESTRATOR_BOARD_NAME,
          fromRole: role,
          text,
          kind,
          missionId: params.mission_id?.trim() || undefined,
        });
        const mentionSummary =
          msg.mentions.length > 0 ? ` (mentions: ${msg.mentions.map((m) => `@${m}`).join(", ")})` : "";
        return okResult(`Posted board message #${msg.seq}${mentionSummary}.`, {
          seq: msg.seq,
          mentions: msg.mentions,
          message: msg,
        });
      });
    },
  });

  // --------------------------------------------------------------------------
  // 3. swarm_board_read
  // --------------------------------------------------------------------------
  const swarmBoardReadTool = defineTool({
    name: SWARM_BOARD_READ_TOOL,
    label: "Swarm Board Read",
    description:
      "Read messages from the shared Swarm message board (oldest first). Pass `since` for unread messages after `#seq`, `seqs` to inspect specific `#seq` entries, or omit both for recent messages.",
    promptSnippet: "Read messages from the shared Swarm message board.",
    promptGuidelines: [
      `Use ${SWARM_BOARD_READ_TOOL} to inspect peer discussions, scope requests, or specific #seq board posts.`,
    ],
    parameters: Type.Object({
      since: Type.Optional(Type.Number({ description: "Return messages with seq > since." })),
      seqs: Type.Optional(
        Type.Array(Type.Number(), { description: "Fetch exact message sequence numbers only." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of messages to return (default 20)." })),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const res = await deps.orchestrator.readBoard({
          since: params.since,
          seqs: params.seqs,
          limit: params.limit,
        });
        if (res.messages.length === 0) {
          return okResult(`Swarm board has no matching messages (head: #${res.head}).`, {
            head: res.head,
            count: 0,
            messages: [],
          });
        }
        const lines = res.messages.map((m) => formatBoardExcerptLine(m, 500));
        return okResult(
          `Swarm Board (head: #${res.head}, showing ${res.messages.length}):\n${lines.join("\n")}`,
          {
            head: res.head,
            count: res.messages.length,
            messages: res.messages,
          },
        );
      });
    },
  });

  // --------------------------------------------------------------------------
  // 4. swarm_mission
  // --------------------------------------------------------------------------
  const swarmMissionTool = defineTool({
    name: SWARM_MISSION_TOOL,
    label: "Swarm Mission",
    description:
      'Inspect or manage a mission: "get" full details, update "progress", mark "task_done", "patch_scope" (re-validating disjoint build scopes), "abandon" (kills handles, frees scope & unblocks deps), or "retry".',
    promptSnippet: "Inspect or update a mission (get, progress, task_done, patch_scope, abandon, retry).",
    promptGuidelines: [
      `Use ${SWARM_MISSION_TOOL} to inspect mission details, patch disjoint scope, abandon blocked missions, or retry failed/stopped missions. Never hand-edit ${SWARM_DIR}/ files.`,
    ],
    parameters: Type.Object({
      missionId: Type.String({ description: "Mission ID (e.g., M1)." }),
      action: stringEnum(["get", "progress", "task_done", "patch_scope", "abandon", "retry"] as const, {
        description: "Operation to perform on the mission.",
      }),
      summary: Type.Optional(Type.String({ description: "Progress summary (for action=progress)." })),
      taskIds: Type.Optional(
        Type.Array(Type.String(), { description: "Checklist task IDs to mark done (for action=task_done)." }),
      ),
      scope: Type.Optional(
        Type.Array(Type.String(), { description: "Replacement declared scope paths (for action=patch_scope)." }),
      ),
      reason: Type.Optional(
        Type.String({ description: "Reason or guidance (for action=abandon or action=retry)." }),
      ),
      runId: Type.Optional(Type.String({ description: "Optional run ID (defaults to active run)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runToolSafe(async () => {
        const runId = resolveRunId(params.runId);
        const missionId = params.missionId.trim();
        const role = callerRole();

        if (params.action === "get") {
          const run = await deps.store.loadRun(runId);
          const m = run.missions[missionId];
          if (!m) {
            throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);
          }
          return okResult(JSON.stringify(m, null, 2), m);
        }

        if (params.action === "progress") {
          if (!params.summary?.trim()) {
            throw new SwarmProtocolError("INVALID_TRANSITION", "summary is required for action=progress.");
          }
          const updated = await deps.store.updateMission(runId, missionId, {
            progressSummary: params.summary.trim(),
            callerRole: role,
            actor: role,
          });
          return okResult(`Updated progress for ${missionId}.`, updated.missions[missionId]);
        }

        if (params.action === "task_done") {
          const ids = params.taskIds ?? [];
          if (ids.length === 0) {
            throw new SwarmProtocolError("INVALID_TRANSITION", "taskIds must be non-empty for action=task_done.");
          }
          const updated = await deps.store.updateMission(runId, missionId, {
            taskDoneIds: ids,
            callerRole: role,
            actor: role,
          });
          return okResult(`Marked task(s) done on ${missionId}: ${ids.join(", ")}`, updated.missions[missionId]);
        }

        if (params.action === "patch_scope") {
          const scope = params.scope ?? [];
          if (scope.length === 0) {
            throw new SwarmProtocolError("INVALID_TRANSITION", "scope must be non-empty for action=patch_scope.");
          }
          const updated = await deps.store.patchMissionScope(runId, missionId, scope, {
            callerRole: role,
            actor: role,
          });
          return okResult(
            `Patched scope for ${missionId} to [${scope.join(", ")}].`,
            updated.missions[missionId],
          );
        }

        if (params.action === "abandon") {
          if (role !== "orchestrator" && role !== "human") {
            throw new SwarmProtocolError("ROLE_FORBIDDEN", `Role "${role}" cannot abandon missions.`);
          }
          // Permanently kill any live worker/validator handles for this mission (best-effort)
          for (const candidate of [missionId, `validator-${missionId}`]) {
            try {
              await deps.orchestrator.killAgent(candidate, params.reason ?? "Mission abandoned");
            } catch {
              // ignore if no live handle
            }
          }
          const updated = await deps.store.updateMission(runId, missionId, {
            status: "abandoned",
            error: params.reason?.trim() || "Abandoned by orchestrator",
            callerRole: role,
            actor: role,
          });
          await deps.orchestrator.tick(ctx);
          return okResult(
            `Abandoned mission ${missionId}; handles killed, scope released, and downstream dependents unblocked.`,
            updated.missions[missionId],
          );
        }

        if (params.action === "retry") {
          const updated = await deps.orchestrator.retryMission(missionId, {
            reason: params.reason,
            hostContext: ctx,
          });
          return okResult(`Retrying mission ${missionId}.`, updated.missions[missionId]);
        }

        throw new SwarmProtocolError("INVALID_TRANSITION", `Unknown action: ${String(params.action)}`);
      });
    },
  });

  // --------------------------------------------------------------------------
  // 5. swarm_spawn
  // --------------------------------------------------------------------------
  const swarmSpawnTool = defineTool({
    name: SWARM_SPAWN_TOOL,
    label: "Swarm Spawn",
    description:
      "Manually spawn a worker or independent validator for a mission (with optional per-spawn model override). Respects humanStopped unless force=true is passed on explicit user request.",
    promptSnippet: "Manually spawn a worker or validator for a mission.",
    promptGuidelines: [
      `Use ${SWARM_SPAWN_TOOL} only when manually triggering a worker or validator; never pass force=true on a human-stopped mission unless the user explicitly asked to restart it.`,
    ],
    parameters: Type.Object({
      missionId: Type.String({ description: "Mission ID to spawn an agent for." }),
      role: Type.Optional(
        stringEnum(["worker", "validator"] as const, {
          description: 'Role to spawn ("worker" default, or "validator" for a completed build mission).',
          default: "worker",
        }),
      ),
      promptOverride: Type.Optional(
        Type.String({ description: "Optional custom task prompt override for this spawn." }),
      ),
      modelOverride: Type.Optional(
        Type.String({ description: "Optional model identifier override for this spawn." }),
      ),
      thinkingLevel: Type.Optional(
        stringEnum(THINKING_LEVEL_VALUES, {
          description: "Optional thinking level override for this spawn.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Override humanStopped ONLY if the user explicitly requested restarting a stopped mission.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runToolSafe(async () => {
        const runId = resolveRunId();
        const missionId = params.missionId.trim();
        const run = await deps.store.loadRun(runId);
        const mission = run.missions[missionId];
        if (!mission) {
          throw new SwarmProtocolError("NOT_FOUND", `Mission "${missionId}" not found.`);
        }
        if (mission.humanStopped && !params.force) {
          throw new SwarmProtocolError(
            "INVALID_TRANSITION",
            `Mission "${missionId}" was stopped by the user. Refusing automatic restart — pass force=true only if the user explicitly asks to restart it.`,
          );
        }

        const spawnOpts: SpawnMissionOptions = {
          missionId,
          role: params.role ?? "worker",
          promptOverride: params.promptOverride,
          modelOverride: params.modelOverride,
          thinkingLevel: params.thinkingLevel,
          hostContext: ctx,
          force: params.force,
        };
        const handle = await deps.orchestrator.spawnForMission(spawnOpts);
        return okResult(
          `Spawned ${handle.role} ${handle.name} (${handle.agentId}) for mission ${handle.missionId}${handle.getModel() ? ` on model ${handle.getModel()}` : ""}.`,
          {
            agentId: handle.agentId,
            name: handle.name,
            missionId: handle.missionId,
            role: handle.role,
            model: handle.getModel(),
          },
        );
      });
    },
  });

  // --------------------------------------------------------------------------
  // 6. swarm_model
  // --------------------------------------------------------------------------
  const swarmModelTool = defineTool({
    name: SWARM_MODEL_TOOL,
    label: "Swarm Model",
    description:
      'Hot-switch a waiting agent\'s live model (preserving full conversation history) OR update a 3-role default ("orchestrator" | "worker" | "validator") for future spawns.',
    promptSnippet: "Hot-switch a waiting agent's model or update a role default (orchestrator/worker/validator).",
    promptGuidelines: [
      `Use ${SWARM_MODEL_TOOL} when an agent hits quota/capacity or needs a stronger/faster model. Live agents MUST be in waiting state (never kill & respawn just to switch models!).`,
    ],
    parameters: Type.Object({
      target: Type.String({
        description:
          'Role default ("orchestrator" | "worker" | "validator") or waiting agent handle/ID (e.g. "M1", "validator-M1").',
      }),
      model: Type.String({
        description:
          'Target model identifier (e.g. "anthropic/claude-sonnet-4" or "openai/gpt-5"), or "default"/"clear"/"reset"/"none" when clearing a 3-role default back to host default.',
      }),
      thinking_level: Type.Optional(
        stringEnum(THINKING_LEVEL_VALUES, {
          description: "Optional thinking level to apply with the model switch.",
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: "Optional reason for switching models (e.g., quota fallback or user request)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const target = params.target.trim();
        const model = params.model.trim();
        const thinkingLevel: ThinkingLevel | undefined = params.thinking_level;
        const reason = params.reason?.trim() || undefined;

        if (!target || !model) {
          throw new SwarmProtocolError("INVALID_TRANSITION", "Both `target` and `model` must be non-empty.");
        }

        const targetLower = target.toLowerCase();
        if (isSwarmModelRole(targetLower)) {
          const isClearing = CLEAR_MODEL_TOKENS.has(model.toLowerCase());
          const effectiveModel = isClearing ? undefined : model;

          if (deps.onRoleModelChanged) {
            await deps.onRoleModelChanged(targetLower, model, thinkingLevel, reason);
          }

          let effectiveThinking: ThinkingLevel | undefined = thinkingLevel;
          const activeRunId = deps.getActiveRunId();
          if (activeRunId) {
            const run = await deps.store.loadRun(activeRunId);
            const currentEntry = run.roleModels?.[targetLower];

            effectiveThinking = isClearing
              ? thinkingLevel
              : thinkingLevel ?? currentEntry?.thinkingLevel;

            const desiredEntry = {
              ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
              ...(effectiveThinking !== undefined ? { thinkingLevel: effectiveThinking } : {}),
            };

            const needsStoreUpdate =
              currentEntry?.model !== desiredEntry.model ||
              currentEntry?.thinkingLevel !== desiredEntry.thinkingLevel;

            if (needsStoreUpdate) {
              const nextRoleModels: SwarmRoleModels = {
                ...(run.roleModels ?? {}),
                [targetLower]: desiredEntry,
              };
              await deps.store.updateRun(activeRunId, {
                roleModels: nextRoleModels,
                actor: ORCHESTRATOR_BOARD_NAME,
              });
            }

            // Refresh orchestrator's cached run snapshot (same-run attachRun preserves transient state)
            await deps.orchestrator.attachRun(activeRunId);
          }

          const message = isClearing
            ? `Cleared "${targetLower}" role default model back to host default${effectiveThinking ? ` (thinking: ${effectiveThinking})` : ""}${reason ? ` — ${reason}` : ""}.`
            : `Updated "${targetLower}" role default model to ${effectiveModel}${effectiveThinking ? ` (thinking: ${effectiveThinking})` : ""}${reason ? ` — ${reason}` : ""}.`;

          return okResult(message, {
            target: targetLower,
            scope: "role_default",
            model: effectiveModel,
            cleared: isClearing,
            thinkingLevel: effectiveThinking,
            reason,
          });
        }

        const updated = await deps.orchestrator.switchAgentModel(target, model, thinkingLevel);
        return okResult(
          `Hot-switched agent ${updated.name} (${updated.agentId}) to ${updated.model ?? model}${updated.thinkingLevel ? ` (thinking: ${updated.thinkingLevel})` : ""} with conversation history preserved.`,
          updated,
        );
      });
    },
  });

  // --------------------------------------------------------------------------
  // 7. swarm_kill
  // --------------------------------------------------------------------------
  const swarmKillTool = defineTool({
    name: SWARM_KILL_TOOL,
    label: "Swarm Kill",
    description:
      "Permanently kill an agent and dispose its persistent session (cannot be revived). Use when work is finished or an agent is stuck — never use kill as a pause.",
    promptSnippet: "Permanently kill an agent and dispose its warm session.",
    promptGuidelines: [
      `Use ${SWARM_KILL_TOOL} only to permanently dispose finished or stuck agents; warm waiting agents cost nothing until woken.`,
    ],
    parameters: Type.Object({
      target: Type.String({
        description: 'Agent board handle (e.g. "M1", "validator-M1", "final-validator") or agentId to kill.',
      }),
      reason: Type.Optional(Type.String({ description: "Optional reason for killing the agent." })),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const target = params.target.trim();
        if (!target) {
          throw new SwarmProtocolError("INVALID_TRANSITION", "`target` must be non-empty.");
        }
        const reason = params.reason?.trim() || "Killed by orchestrator";
        await deps.orchestrator.killAgent(target, reason);
        return okResult(`Permanently killed agent "${target}" (${reason}).`, {
          target,
          reason,
        });
      });
    },
  });

  // --------------------------------------------------------------------------
  // 8. swarm_finding
  // --------------------------------------------------------------------------
  const swarmFindingTool = defineTool({
    name: SWARM_FINDING_TOOL,
    label: "Swarm Finding",
    description: "Record a structured survey/diagnostic finding or list recorded findings for the run.",
    promptSnippet: "Record or list structured survey/diagnostic findings.",
    promptGuidelines: [
      `Use ${SWARM_FINDING_TOOL} to inspect findings recorded by survey missions or add orchestrator-level findings.`,
    ],
    parameters: Type.Object({
      action: stringEnum(["record", "list"] as const, {
        description: '"record" a new finding or "list" existing findings.',
      }),
      missionId: Type.Optional(
        Type.String({ description: "Mission ID (required for record; optional filter for list)." }),
      ),
      title: Type.Optional(Type.String({ description: "Finding title (required for record)." })),
      summary: Type.Optional(Type.String({ description: "Concise finding summary (required for record)." })),
      details: Type.Optional(Type.String({ description: "Detailed findings/evidence (required for record)." })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths." })),
      runId: Type.Optional(Type.String({ description: "Optional run ID (defaults to active run)." })),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const runId = resolveRunId(params.runId);
        if (params.action === "list") {
          const run = await deps.store.loadRun(runId);
          const items = params.missionId?.trim()
            ? run.findings.filter((f) => f.missionId === params.missionId!.trim())
            : run.findings;
          if (items.length === 0) {
            return okResult("No findings recorded.", { count: 0, findings: [] });
          }
          const formatted = items
            .map((f) => {
              const files = f.files && f.files.length > 0 ? `\nFiles: ${f.files.join(", ")}` : "";
              return `### [${f.missionId}] ${f.title} (${f.author})\n${f.summary}\n${f.details}${files}`;
            })
            .join("\n\n");
          return okResult(formatted, { count: items.length, findings: items });
        }

        const missionId = params.missionId?.trim();
        const title = params.title?.trim();
        const summary = params.summary?.trim();
        const details = params.details?.trim();
        if (!missionId || !title || !summary || !details) {
          throw new SwarmProtocolError(
            "INVALID_TRANSITION",
            "missionId, title, summary, and details are required for action=record.",
          );
        }
        const record = await deps.store.recordFinding(runId, {
          missionId,
          author: callerRole(),
          title,
          summary,
          details,
          files: params.files,
        });
        return okResult(`Recorded finding ${record.id}: "${record.title}"`, record);
      });
    },
  });

  // --------------------------------------------------------------------------
  // 9. swarm_merge
  // --------------------------------------------------------------------------
  const swarmMergeTool = defineTool({
    name: SWARM_MERGE_TOOL,
    label: "Swarm Merge",
    description:
      "Trigger the serialized orchestrator merge gate for a completed mission. Enforces clean worktree, scope compliance, tip-SHA-pinned clean validation (build), human sign-off (artifact), or zero-diff (survey).",
    promptSnippet: "Run the serialized merge gate for a completed mission.",
    promptGuidelines: [
      `Use ${SWARM_MERGE_TOOL} to merge completed missions into the base branch; never run manual git merge outside ${SWARM_MERGE_TOOL}.`,
    ],
    parameters: Type.Object({
      missionId: Type.String({ description: "Completed mission ID to merge." }),
    }),
    async execute(_toolCallId, params) {
      return runToolSafe(async () => {
        const missionId = params.missionId.trim();
        const role = callerRole();
        const res = await deps.orchestrator.mergeMission(missionId, {
          callerRole: role,
          actor: role,
        });
        if (!res) {
          return okResult(`Closed zero-diff survey mission ${missionId}.`, {
            missionId,
            mergedCommitSha: null,
          });
        }
        return okResult(
          `Merged mission ${missionId} (${res.strategy}) -> commit ${res.mergedCommitSha.slice(0, 12)} (${res.changedFiles.length} file(s) changed).`,
          res,
        );
      });
    },
  });

  // --------------------------------------------------------------------------
  // 10. swarm_verify
  // --------------------------------------------------------------------------
  const swarmVerifyTool = createSwarmVerifyTool(deps);

  // --------------------------------------------------------------------------
  // 11. swarm_plan_add
  // --------------------------------------------------------------------------
  const MissionInputSchema = Type.Object({
    id: Type.String({ description: "Unique mission ID (e.g., M4)." }),
    title: Type.String({ description: "Printable ASCII mission title (used for feat/<slug> branch)." }),
    kind: stringEnum(["build", "artifact", "survey"] as const, {
      description: "Mission kind.",
    }),
    description: Type.String({ description: "Detailed mission specification." }),
    scope: Type.Array(Type.String(), {
      description: "Declared repo-relative scope paths (disjoint across open build missions).",
    }),
    deps: Type.Array(Type.String(), {
      description: "Upstream mission IDs this mission depends on.",
    }),
    verification: Type.String({ description: "Concrete verification command or criteria." }),
    tasks: Type.Optional(
      Type.Array(Type.String(), { description: "Optional checklist item titles." }),
    ),
  });

  const swarmPlanAddTool = defineTool({
    name: SWARM_PLAN_ADD_TOOL,
    label: "Swarm Plan Add",
    description:
      "Atomically add one or more new missions to the active Swarm run (validates DAG, disjoint build scopes, ASCII titles, and unique branches), then schedules ready work.",
    promptSnippet: "Dynamically append validated missions to the active Swarm run.",
    promptGuidelines: [
      `Use ${SWARM_PLAN_ADD_TOOL} to append follow-up missions to an active run with atomic DAG and disjoint-scope validation.`,
    ],
    parameters: Type.Object({
      missions: Type.Array(MissionInputSchema, {
        minItems: 1,
        description: "One or more mission specifications to add atomically.",
      }),
      runId: Type.Optional(Type.String({ description: "Optional run ID (defaults to active run)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runToolSafe(async () => {
        const runId = resolveRunId(params.runId);
        const existingBranches = await deps.worktree.listLocalBranches();
        const planInputs: MissionPlanInput[] = params.missions.map((m) => ({
          id: m.id.trim(),
          title: m.title.trim(),
          kind: m.kind,
          description: m.description.trim(),
          scope: m.scope.map((s) => s.trim()).filter(Boolean),
          deps: m.deps.map((d) => d.trim()).filter(Boolean),
          verification: m.verification.trim(),
          tasks: m.tasks?.map((t) => t.trim()).filter(Boolean),
        }));

        const updated = await deps.store.addMissions(runId, planInputs, {
          existingBranches,
          actor: callerRole(),
        });
        await deps.orchestrator.tick(ctx);

        const addedSummary = planInputs
          .map((m) => {
            const rec = updated.missions[m.id];
            return `- ${m.id} (${m.kind}): "${m.title}" branch=${rec?.branch ?? "(unknown)"}`;
          })
          .join("\n");

        return okResult(
          `Added ${planInputs.length} mission(s) to run ${runId} and triggered scheduling:\n${addedSummary}`,
          {
            runId,
            addedIds: planInputs.map((m) => m.id),
            totalMissions: updated.missionOrder.length,
          },
        );
      });
    },
  });

  // --------------------------------------------------------------------------
  // 12. swarm_teardown
  // --------------------------------------------------------------------------
  const swarmTeardownTool = defineTool({
    name: SWARM_TEARDOWN_TOOL,
    label: "Swarm Teardown",
    description: `Safely remove clean, idle mission worktrees while preserving ${SWARM_DIR}/ audit history and branches (enforces live-session ownership & dirty-worktree protection).`,
    promptSnippet: "Safely remove clean, idle worktrees while preserving audit trail.",
    promptGuidelines: [
      `Use ${SWARM_TEARDOWN_TOOL} to clean up idle worktrees safely without losing uncommitted edits or audit records.`,
    ],
    parameters: Type.Object({
      deleteBranches: Type.Optional(
        Type.Boolean({ description: "Also delete local mission branches for removed worktrees (default false)." }),
      ),
      runId: Type.Optional(Type.String({ description: "Optional run ID (defaults to active run)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runToolSafe(async () => {
        const runId = resolveRunId(params.runId);
        const sessionId = deps.getSessionId?.() ?? ctx?.sessionManager?.getSessionId?.();
        const res = await deps.orchestrator.teardown({
          runId,
          deleteBranches: params.deleteBranches ?? false,
          sessionId,
        });
        const lines: string[] = [
          `Teardown for run ${runId}: ${res.removed.length} removed, ${res.skipped.length} skipped, ${res.errors.length} error(s).`,
        ];
        if (res.removed.length > 0) {
          lines.push(`Removed: ${res.removed.map((r) => `${r.missionId} (${r.worktreePath})`).join(", ")}`);
        }
        if (res.skipped.length > 0) {
          lines.push(
            `Skipped: ${res.skipped.map((s) => `${s.missionId} [${s.action}${s.reason ? `: ${s.reason}` : ""}]`).join(", ")}`,
          );
        }
        if (res.errors.length > 0) {
          lines.push(`Errors: ${res.errors.map((e) => `${e.missionId}: ${e.reason ?? "error"}`).join(", ")}`);
        }
        return okResult(lines.join("\n"), res);
      });
    },
  });

  return [
    swarmStatusTool,
    swarmBoardPostTool,
    swarmBoardReadTool,
    swarmMissionTool,
    swarmSpawnTool,
    swarmModelTool,
    swarmKillTool,
    swarmFindingTool,
    swarmMergeTool,
    swarmVerifyTool,
    swarmPlanAddTool,
    swarmTeardownTool,
  ];
}

/**
 * Registers all 12 orchestrator tools on a Pi `ExtensionAPI` instance.
 */
export function registerOrchestratorTools(
  pi: ExtensionAPI,
  deps: OrchestratorToolDeps,
): ToolDefinition[] {
  const tools = createOrchestratorTools(deps);
  for (const tool of tools) {
    pi.registerTool(tool);
  }
  return tools;
}

import {
  DEFAULT_CHANNEL,
  ORCHESTRATOR_NAME,
  POST_MESSAGE_TOOL,
  READ_BOARD_TOOL,
  SWARM_DIR,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../constants.js";
import type {
  BoardMessage,
  SwarmMemberRecord,
  SwarmRoleModelConfig,
  SwarmRunState,
  SwarmSnapshot,
} from "../types.js";

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatRoleConfig(cfg?: SwarmRoleModelConfig): string {
  const model = cfg?.model?.trim() || "host-default";
  return cfg?.thinkingLevel ? `${model} (${cfg.thinkingLevel})` : model;
}

/**
 * Formats a single board message concisely for prompts, wakeups, and status summaries.
 */
export function formatBoardExcerptLine(msg: BoardMessage, maxChars = 240): string {
  const targets: string[] = [];
  for (const handle of msg.mentions) {
    targets.push(handle.startsWith("@") ? handle : `@${handle}`);
  }
  for (const ch of msg.channelMentions) {
    const clean = ch.replace(/^@#/, "");
    targets.push(`@#${clean}`);
  }
  const targetPart = targets.length > 0 ? ` -> ${targets.join(",")}` : "";
  const channelPart = `#${msg.channel || DEFAULT_CHANNEL}`;
  const kindPart = msg.kind && msg.kind !== "chat" ? ` (${msg.kind})` : "";
  const compact = msg.text.replace(/\s+/g, " ").trim();
  const clipped = compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
  return `#${msg.seq} [${channelPart}] ${msg.from}${targetPart}${kindPart}: ${clipped}`;
}

/**
 * Formats a slice of board messages for inclusion in prompts, wakeups, or playbook sections.
 */
export function formatBoardExcerpt(
  messages: readonly BoardMessage[],
  maxCharsPerLine = 240,
): string {
  if (messages.length === 0) {
    return "";
  }
  return messages.map((m) => formatBoardExcerptLine(m, maxCharsPerLine)).join("\n");
}

// ============================================================================
// Orchestrator Playbook Section (Prompt-Cache-Safe Tail / sections.swarm)
// ============================================================================

/**
 * Builds the Antigravity Swarm Coordinator Playbook + live run state section
 * injected prompt-cache-safely into `sections.swarm` (or tail context) while a run is active.
 */
export function buildOrchestratorPlaybookSection(snapshot: SwarmSnapshot): string {
  const run = snapshot.run;
  const sections: string[] = [];

  sections.push(
    [
      "# Pi Swarm Orchestrator Playbook (Antigravity Swarm)",
      "",
      "## 1. Do Not Do the Technical Work Yourself",
      `- Delegate ALL technical work (codebase research, scaffolding, coding, integration, builds/tests, verification) to named swarm members via \`${SWARM_TOOL}{action:"add"}\`.`,
      `- Your job is orchestration: read \`#seq\` board reports, judge quality and completeness, decide the next phase, merge isolated worktrees (\`${SWARM_TOOL}{action:"merge"}\`), retire finished workers (\`${SWARM_TOOL}{action:"kill"}\`), and communicate clearly with the user.`,
      "",
      "## 2. Dynamic Phased Collaboration",
      "- Adapt wave-by-wave instead of locking into a rigid upfront DAG:",
      "  1. **Discovery**: Spawn read-only researchers/scouts first when unknowns exist → inspect their `#seq` reports.",
      "  2. **Contract / Scaffold**: Spawn a contract/scaffold worker when shared interfaces must settle before fan-out → inspect its `#seq`.",
      "  3. **Parallel Execution**: Spawn disjoint named authors in parallel (`workspace:\"share\"` whenever multiple authors edit/build simultaneously; `workspace:\"inherit\"` for read-only scouts or strictly non-overlapping edits; use `n` or `tasks[]` for sharded slices).",
      "  4. **Independent Read-Only Validation**: Spawn independent `role:\"validator\"` members (~1 validator per 2–4 authors) to audit code, diffs, tests, and runtime behavior. NEVER let authors self-certify!",
      "  5. **Peer-to-Peer Bug Closure**: Let `@validator` and `@author` resolve defects directly on the board (`@author` <-> `@validator`) without waking `@orchestrator` on intermediate bounces.",
      `  6. **Land & Complete**: Merge \`share\`/\`branch\` worktrees via \`${SWARM_TOOL}{action:"merge"}\`, kill finished members via \`${SWARM_TOOL}{action:"kill"}\`, and close the run cleanly via \`${SWARM_TOOL}{action:"done", summary}\`.`,
      "",
      "## 3. Zero-Copy `#seq` Referencing & `@mention` Discipline",
      `- Point downstream workers to earlier reports by sequence number (e.g. "Read \`#4\` and \`#6\` via \`${READ_BOARD_TOOL}{seqs:[4,6]}\`") — NEVER copy-paste one worker's report into another worker's brief!`,
      `- \`@name\` is a wakeup doorbell, never a CC. Use \`@<prefix>\` for sharded groups, \`@#<channel>\` for channel broadcasts (NEVER \`@#main\`), and \`@all\` only for genuine swarm-wide rules or plan changes.`,
      "",
      "## 4. Core Swarm Tools (4 Tools)",
      `- \`${SWARM_TOOL}\`: \`title\` | \`add\` (\`name\`, \`role\`, \`brief\`, \`workspace\`, \`fork\`, \`model\`, \`thinking_level\`, \`channels\`, \`n\`, \`tasks\`) | \`status\` | \`models\` | \`model\` | \`kill\` | \`merge\` | \`channel\` (\`create\`/\`list\`/\`join\`/\`leave\`/\`archive\`) | \`done\`.`,
      `- \`${POST_MESSAGE_TOOL}\`: Post to the shared board (\`text\`, optional \`channel\`).`,
      `- \`${READ_BOARD_TOOL}\`: Read board messages (\`since\`, \`seqs\`, \`limit\`, \`channel\`, \`search\`) or inspect roster (\`status:true\`).`,
      `- \`${SWARM_WAIT_TOOL}\`: Sleep until a member wakes \`@${ORCHESTRATOR_NAME}\` or all workers go idle (\`all_idle\`). Always pass the highest \`#seq\` you have already read as \`since\`.`,
      "",
      "## 5. Keep Warm, Context Forking & 3-Role Models",
      `- **Keep Warm**: Completed members park in \`waiting\` (zero tokens, full history intact). NEVER \`kill\` as a pause!`,
      `- **Hot Model Switch**: On quota/429 or wrong capability, call \`${SWARM_TOOL}{action:"model", name, model}\` on a \`waiting\` member to hot-switch while keeping conversation history.`,
      `- **Context Forking**: Pass \`fork:"orchestrator"\` or \`fork:"<member>"\` on \`${SWARM_TOOL}{action:"add"}\` when a new member benefits from branching existing conversation history.`,
      "- **3-Role Models**: `orchestrator` (host session), `worker` (default for `role:\"worker\"`), `validator` (default for `role:\"validator\"`).",
    ].join("\n"),
  );

  if (!run) {
    sections.push(
      [
        "## Current Swarm State",
        "No active Swarm run. Use `/swarm` to start a run.",
      ].join("\n"),
    );
    return sections.join("\n\n");
  }

  const fallbacks =
    snapshot.roleModels.fallbackModels && snapshot.roleModels.fallbackModels.length > 0
      ? ` | fallbacks=[${snapshot.roleModels.fallbackModels.join(", ")}]`
      : "";

  const stateHeader: string[] = [
    "## Active Swarm Run State",
    `- **Title**: ${run.title} (\`${run.id}\`)`,
    `- **Status**: \`${run.status}\` | **Base Branch**: \`${run.baseBranch}\` | **Board Head**: \`#${snapshot.boardHead}\``,
    `- **Concurrency**: ${snapshot.workingMemberNames.length}/${run.maxConcurrency} working | ${snapshot.waitingMemberNames.length} warm waiting | Validator Policy: ${run.validatorEnabled ? "ON" : "OFF"}`,
    `- **3-Role Models**: orchestrator=${formatRoleConfig(snapshot.roleModels.orchestrator)} | worker=${formatRoleConfig(snapshot.roleModels.worker)} | validator=${formatRoleConfig(snapshot.roleModels.validator)}${fallbacks}`,
    `- **Usage**: ${snapshot.totalTokens} tokens | $${snapshot.totalCost.toFixed(4)}`,
    `- **Objective**: ${run.objective}`,
  ];

  if (run.strategy.trim()) {
    stateHeader.push(`- **Strategy**: ${run.strategy.trim()}`);
  }
  if (run.acceptanceCriteria.trim()) {
    stateHeader.push(`- **Acceptance Criteria**: ${run.acceptanceCriteria.trim()}`);
  }
  if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > Date.now()) {
    const secs = Math.ceil((snapshot.rateLimitUntil - Date.now()) / 1000);
    stateHeader.push(
      `- **RATE-LIMIT BACKOFF**: pausing new launches for ~${secs}s${snapshot.rateLimitReason ? ` (${snapshot.rateLimitReason})` : ""}.`,
    );
  }
  sections.push(stateHeader.join("\n"));

  // Channels compact summary
  const channels = Object.values(run.channels);
  if (channels.length > 0) {
    const chLines = channels.map((ch) => {
      const subs = ch.subscribers.length > 0 ? ch.subscribers.join(",") : "(all)";
      const topic = ch.topic ? ` — ${ch.topic}` : "";
      const archived = ch.archived ? " [ARCHIVED]" : "";
      return `- \`#${ch.name}\`${archived} subscribers=[${subs}]${topic}`;
    });
    sections.push(`### Channels\n${chLines.join("\n")}`);
  }

  // Live members compact summary
  const members = run.memberOrder
    .map((name) => run.members[name])
    .filter((m): m is SwarmMemberRecord => Boolean(m));
  if (members.length > 0) {
    const memberLines = members.map((m) => {
      const ws = m.branch ? `${m.workspace}:${m.branch}` : m.workspace;
      const model = m.model ? ` model=${m.model}` : "";
      const post = m.lastPostSeq ? ` lastPost=#${m.lastPostSeq}` : "";
      const merged = m.mergedCommitSha ? ` merged=${m.mergedCommitSha.slice(0, 7)}` : "";
      const stopped = m.humanStopped ? " [HUMAN-STOPPED]" : "";
      const err = m.error ? ` err="${m.error.slice(0, 80)}"` : "";
      const activity = m.currentActivity
        ? ` — ${m.currentActivity}`
        : m.parkedOn
          ? ` — ${m.parkedOn}`
          : "";
      return `- \`@${m.name}\` (${m.role}) [${m.state}] ws=${ws} parent=@${m.parentName}${model} turns=${m.turns}${post}${merged}${stopped}${err}${activity}`;
    });
    sections.push(`### Live Members (${members.length})\n${memberLines.join("\n")}`);
  } else {
    sections.push("### Live Members (0)\n(none spawned yet — add members with `swarm{action:\"add\"}`)");
  }

  // Recent board excerpts
  if (snapshot.recentBoard.length > 0) {
    const tail = snapshot.recentBoard.slice(-8);
    sections.push(
      `### Recent Shared Board (head #${snapshot.boardHead}, last ${tail.length})\n${formatBoardExcerpt(tail, 200)}`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Convenience alias returning the Orchestrator Playbook + live run state section.
 */
export function buildOrchestratorContextSummary(snapshot: SwarmSnapshot): string {
  return buildOrchestratorPlaybookSection(snapshot);
}

// ============================================================================
// Worker & Validator System / Initial / Wakeup Prompts
// ============================================================================

/**
 * Builds the concise, high-signal system prompt appendix injected into a
 * Worker or Validator Pi session.
 */
export function buildMemberSystemPrompt(
  run: SwarmRunState,
  member: SwarmMemberRecord,
): string {
  const sections: string[] = [];
  const primaryChannel = member.channels[0] ?? DEFAULT_CHANNEL;
  const workspaceDesc =
    member.workspace === "inherit"
      ? `\`inherit\` (shared checkout at \`${member.cwd}\` — edit ONLY files assigned in your brief)`
      : `\`${member.workspace}\` (isolated git worktree at \`${member.cwd}\` on branch \`${member.branch ?? "unknown"}\`, base \`${run.baseBranch}\`)`;

  const headerLines: string[] = [
    `# Pi Swarm ${member.role === "validator" ? "Independent Validator" : "Worker"} — @${member.name}`,
    `- **Handle**: \`@${member.name}\` (role: \`${member.role}\`${member.groupPrefix ? `, group: \`@${member.groupPrefix}\`` : ""})`,
    `- **Parent**: \`@${member.parentName}\``,
    `- **Run**: ${run.title} (\`${run.id}\`) | Base Branch: \`${run.baseBranch}\``,
    `- **Run Objective**: ${run.objective}`,
    `- **Workspace**: ${workspaceDesc}`,
    `- **Channels**: ${member.channels.map((c) => `#${c}`).join(", ")} (default post channel: \`#${primaryChannel}\`; \`#main\` is always visible)`,
  ];

  if (member.forkedFrom) {
    headerLines.push(
      `- **Forked History**: Branched from \`@${member.forkedFrom}\`'s conversation history.`,
    );
  }
  if (run.acceptanceCriteria.trim()) {
    headerLines.push(`- **Acceptance Criteria**: ${run.acceptanceCriteria.trim()}`);
  }
  sections.push(headerLines.join("\n"));

  // Shared board & warm session protocol (shared across workers and validators)
  sections.push(
    [
      "## Shared Message Board & Warm Session Rules",
      `1. **Tools**: Use \`${POST_MESSAGE_TOOL}\` to communicate, \`${READ_BOARD_TOOL}\` (\`since?\`, \`seqs?\`, \`limit?\`, \`channel?\`, \`status?\`) to inspect prior posts or roster, and \`${SWARM_WAIT_TOOL}\` (\`since\`, \`mentions_only?\`) to park cleanly in warm \`waiting\` state when idle.`,
      "2. **Zero-Copy `#seq` Refs**: Reference earlier board posts by sequence number (e.g. `#4`, `#6`) and fetch them with `read_board{seqs:[4,6]}` — never copy-paste large reports.",
      `3. **\`@mention\` Discipline**: \`@name\` is a wakeup doorbell, never a CC. Tag ONLY the peer(s) who must act next; do NOT tag \`@${ORCHESTRATOR_NAME}\` on intermediate peer-to-peer handoffs. Tag \`@${member.parentName}\` when your deliverable is ready or you hit a blocker only they can resolve.`,
      `4. **Completion Convention**: Start your final deliverable post with \`[done]\` right after the \`@mention\` (e.g. \`@${member.parentName} [done] <concise summary of results, files/commits, and verification>\`).`,
      `5. **Stay Warm via \`${SWARM_WAIT_TOOL}\`**: After posting your result (or while awaiting a peer reply), call \`${SWARM_WAIT_TOOL}{since: <highest-seq-you-read>}\` to park in warm \`waiting\` state (zero tokens, full conversation memory intact). Never poll \`${READ_BOARD_TOOL}\` in a loop!`,
      "6. **Keep Posts Short**: No greetings or empty acknowledgements — post concrete findings, questions, or results.",
    ].join("\n"),
  );

  if (member.role === "validator") {
    sections.push(
      [
        "## Independent Read-Only Validator Rules (Strictly Enforced)",
        "1. **STRICTLY READ-ONLY — NEVER Edit Files**: You are an independent auditor. NEVER create, edit, or delete files, stage changes, or make git commits. `write`, `edit`, `powershell`, and mutating `bash` commands are blocked by protocol.",
        "2. **Verify Independently**: Treat worker reports as untrusted claims. Inspect source code, git diffs (`git diff` / `git show`), typechecks, tests, and real CLI/runtime behavior directly against the Run Objective, Acceptance Criteria, and your brief.",
        "3. **Peer-to-Peer Fix Loop**: If you find bugs, regressions, edge-case failures, or missing requirements, post concrete actionable findings (file path, line number, reproduction/command output, and concrete fix) directly to `@<author>` on the board — do NOT bother `@orchestrator` on intermediate bug bounces — then call `swarm_wait` to await their fix and re-audit!",
        `4. **Sign-Off**: Post \`@${member.parentName} [done] <evidence-backed audit report>\` ONLY when every check passes with zero blocking defects (or escalate clearly to \`@${member.parentName}\` if blocked).`,
        `5. **Read-Only Helpers**: You may spawn read-only \`role:"validator"\` sub-auditors via \`${SWARM_TOOL}{action:"add"}\` if your audit splits cleanly across independent areas. Tell helpers to report to \`@${member.name}\`, and \`${SWARM_TOOL}{action:"kill"}\` them once integrated.`,
      ].join("\n"),
    );
  } else {
    const workspaceCommitRule =
      member.workspace === "inherit"
        ? `2. **Shared Checkout Discipline**: You are working in \`inherit\` mode at \`${member.cwd}\`. Touch ONLY files owned by your brief so you never collide with sibling workers.`
        : `2. **Isolated Worktree Commits**: You are working in an isolated worktree at \`${member.cwd}\` on branch \`${member.branch ?? "swarm"}\`. Commit all intended changes cleanly on your branch with a clean \`git status\` before posting \`[done]\`. NEVER run \`git merge\`, \`git push\`, \`git worktree\`, or switch to \`${run.baseBranch}\` — only \`@${ORCHESTRATOR_NAME}\` merges worktrees.`;

    sections.push(
      [
        "## Worker Execution & Helper Rules",
        `1. **Protected Paths**: NEVER touch \`${SWARM_DIR}/\`, \`.swarm/\`, or \`.git/\` directly — use Swarm tools instead.`,
        workspaceCommitRule,
        "3. **Verify Before Reporting**: Run relevant typechecks/tests/build checks for your owned slice before posting `[done]`.",
        `4. **Spawning & Managing Own Helpers**: You may call \`${SWARM_TOOL}{action:"add", name, brief, ...}\` when your assignment splits into independent pieces or needs an investigator/helper. Tell helpers to report back to \`@${member.name}\` by name. You may call \`${SWARM_TOOL}{action:"model"}\` on yourself or your own helpers, and MUST call \`${SWARM_TOOL}{action:"kill"}\` on your own helpers once you integrate their work. You cannot kill other members or call \`title\`/\`merge\`/\`done\`.`,
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * Builds the initial user turn prompt that launches a newly added member.
 */
export function buildMemberInitialPrompt(
  run: SwarmRunState,
  member: SwarmMemberRecord,
  briefSeq: number,
): string {
  const lines = [
    `You have just joined Swarm "${run.title}" as \`@${member.name}\` (${member.role}).`,
    `Your assignment (recorded on the shared board as \`#${briefSeq}\` from \`@${member.parentName}\`):`,
    "",
    member.brief.trim(),
    "",
    `Start working immediately. Read referenced \`#seq\` posts via \`${READ_BOARD_TOOL}\` if needed, post your result via \`${POST_MESSAGE_TOOL}\`, and call \`${SWARM_WAIT_TOOL}{since: <highest-seq-read>}\` when waiting for follow-ups or finished.`,
  ];
  return lines.join("\n");
}

/**
 * Builds the wakeup prompt delivered to a warm `waiting` (or revived `stopped`) member
 * when one or more new board messages target it.
 */
export function buildWakeupPrompt(
  member: SwarmMemberRecord,
  messages: readonly BoardMessage[],
  head: number,
): string {
  const formatted = messages.map((m) => formatBoardExcerptLine(m, 600)).join("\n");
  return [
    `New shared board message(s) for \`@${member.name}\` (board head: \`#${head}\`):`,
    "",
    formatted,
    "",
    `Respond/act on the board via \`${POST_MESSAGE_TOOL}\` as needed, then call \`${SWARM_WAIT_TOOL}{since: ${head}}\` when idle again.`,
  ].join("\n");
}

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
  SwarmChannelRecord,
  SwarmMemberRecord,
  SwarmRoleModelConfig,
  SwarmRoleModels,
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

/**
 * Formats a board message preserving multiline structure, markdown blocks, and formatting.
 * When `maxChars` is omitted, emits the complete untruncated message body (for `read_board{seqs:[...]}`).
 */
export function formatBoardEntryFull(
  msg: BoardMessage,
  maxChars?: number,
): string {
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
  const kindTag = msg.kind && msg.kind !== "chat" ? ` (${msg.kind})` : "";
  const header = `#${msg.seq} [${channelPart}] ${msg.from}${targetPart}${kindTag}:`;

  const body = msg.text.trimEnd();
  if (maxChars !== undefined && body.length > maxChars) {
    const remaining = body.length - maxChars;
    return `${header}\n${body.slice(0, maxChars)}\n... [truncated ${remaining} chars; call ${READ_BOARD_TOOL}{seqs:[${msg.seq}]} for full message]`;
  }
  return body.length > 0 ? `${header}\n${body}` : header;
}

// ============================================================================
// Orchestrator Playbook Section (Prompt-Cache-Safe Tail / sections.swarm)
// ============================================================================

export interface OrchestratorPlaybookOptions {
  humanSteeringText?: string;
}

export interface OrchestratorLiveStateOptions {
  includeRecentBoard?: boolean;
  humanSteeringText?: string;
}

function buildOrchestratorPlaybookCore(validatorEnabled: boolean): string {
  const nextPeerExample = validatorEnabled
    ? `\`@validator [done] commit=<sha> workspace=<cwd> summary=...\` so author -> validator runs zero-hop without waking \`@${ORCHESTRATOR_NAME}\` in between, or \`@${ORCHESTRATOR_NAME} [done] ...\` when no downstream peer exists`
    : `\`@<downstream-peer> [done] commit=<sha> workspace=<cwd> summary=...\` for zero-hop peer handoffs, or \`@${ORCHESTRATOR_NAME} [done] commit=<sha> workspace=<cwd> summary=...\` when no downstream peer exists`;

  const rightSizingRule = validatorEnabled
    ? "- **Right-Size the Swarm**: Spawn **1–2 workers** for localized/single-module changes (do not over-shard small edits); for multi-module work, fan out parallel `workspace:\"share\"` authors on strictly disjoint slices + **1 `role:\"validator\"` per 2–4 authors**."
    : "- **Right-Size the Swarm**: Spawn **1–2 workers** for localized/single-module changes (do not over-shard small edits); for multi-module work, fan out parallel `workspace:\"share\"` authors on strictly disjoint file slices.";

  return [
    "# Pi Swarm Orchestrator Playbook (Antigravity Swarm)",
    "",
    "## 1. Do Not Do the Technical Work Yourself",
    `- Delegate ALL technical work (codebase research, scaffolding, coding, integration, builds/tests, verification) to named swarm members via \`${SWARM_TOOL}{action:"add"}\` — never edit repository files directly from Orchestrator (dirtying \`baseBranch\` breaks worktree merges).`,
    `- Your job is orchestration: right-size the swarm, write high-signal briefs, read \`#seq\` board reports, judge quality and completeness, merge isolated worktrees/clones (\`${SWARM_TOOL}{action:"merge"}\`), verify post-merge integration on \`baseBranch\`, retire finished workers (\`${SWARM_TOOL}{action:"kill"}\`), and adapt seamlessly whenever the user redirects you.`,
    "",
    "## 2. Right-Sizing, Dynamic Phased Collaboration & Mid-Flight User Redirection",
    rightSizingRule,
    "- Adapt wave-by-wave instead of locking into a rigid upfront DAG:",
    "  1. **Discovery**: Spawn read-only researchers/scouts first when unknowns exist → inspect their `#seq` reports.",
    "  2. **Contract / Scaffold**: Spawn a contract/scaffold worker when shared interfaces must settle before fan-out → inspect its `#seq`.",
    "  3. **Parallel Execution**: Spawn disjoint named authors in parallel (`workspace:\"share\"` for shared git worktrees when multiple authors edit/build simultaneously; `workspace:\"branch\"` for fully isolated git clones; `workspace:\"inherit\"` for read-only scouts; use `n` or `tasks[]` for sharded slices).",
    ...(validatorEnabled
      ? [
          "  4. **Independent Read-Only Validation**: Spawn independent `role:\"validator\"` members (~1 validator per 2–4 authors) to audit code, diffs, tests, and runtime behavior inside each author's worktree `cwd`. NEVER let authors self-certify!",
          "  5. **Peer-to-Peer Bug Closure**: Let `@validator` and `@author` resolve defects directly on the board (`@author` <-> `@validator`) without waking `@orchestrator` on intermediate bounces.",
          `  6. **Land & Complete**: Merge verified \`share\`/\`branch\` worktrees via \`${SWARM_TOOL}{action:"merge"}\`, run a **post-merge integration check on \`baseBranch\`** (wake \`@validator\` or an \`inherit\` verifier to run full \`typecheck\`/tests on merged \`baseBranch\`) BEFORE calling \`done\`, kill finished members via \`${SWARM_TOOL}{action:"kill"}\`, and close the run cleanly via \`${SWARM_TOOL}{action:"done", summary}\`.`,
        ]
      : [
          `  4. **Land & Complete**: Merge \`share\`/\`branch\` worktrees via \`${SWARM_TOOL}{action:"merge"}\`, run a **post-merge integration check on \`baseBranch\`** (via an \`inherit\` check worker running full \`typecheck\`/tests on merged \`baseBranch\`) BEFORE calling \`done\`, kill finished members via \`${SWARM_TOOL}{action:"kill"}\`, and close the run cleanly via \`${SWARM_TOOL}{action:"done", summary}\`.`,
        ]),
    "- **Dynamic User Redirection**: Calling `swarm_wait` ends your turn cleanly so the user can message you at any time while workers run. When the user sends a new instruction or change of direction mid-flight:",
    `  - Use \`${SWARM_TOOL}{action:"steer", name, message, mode?}\` to redirect a working or parked member immediately (or \`post_message\` with \`@all\` / \`@name\` for parked members), \`${SWARM_TOOL}{action:"stop"/"kill"}\` to halt obsolete work, \`${SWARM_TOOL}{action:"title", objective, strategy, acceptance_criteria}\` to update the run goal/plan, and \`${SWARM_TOOL}{action:"add"}\` for new work, then call \`${SWARM_WAIT_TOOL}\` again.`,
    "",
    "## 3. Mandatory 4-Part Brief Contract, Zero-Copy `#seq` & `@mention` Discipline",
    `- **4-Part Brief Contract**: Every \`${SWARM_TOOL}{action:"add"}\` brief you write MUST explicitly state all four parts:`,
    "  - **(a) Exclusive File/Directory Ownership & Off-Limits Files**: Exact files/directories this member owns and files it MUST NOT edit (prevents two-worker collisions and `REBASE_CONFLICT`).",
    `  - **(b) Interface Contracts & \`#seq\` Board References**: Shared types/invariants plus prior \`#seq\` numbers to read via \`${READ_BOARD_TOOL}{seqs:[...]}\` — NEVER copy-paste one worker's report into another worker's brief!`,
    "  - **(c) Concrete Verification Commands**: Exact runnable `typecheck`, test, and build commands the member must pass in its workspace before reporting `[done]`.",
    `  - **(d) Direct Next-Peer \`@mention\` Doorbell**: Exact handle to wake on completion (e.g., ${nextPeerExample}).`,
    `- **Zero-Copy \`#seq\` & \`@mention\` Discipline**: \`@name\` is a wakeup doorbell, never a CC. Use \`@<prefix>\` for sharded groups, \`@#<channel>\` for channel broadcasts (NEVER \`@#main\`), and \`@all\` only for genuine swarm-wide rules or plan changes.${validatorEnabled ? " Avoid writing `@validator` (or another peer's `@handle`) in prose when addressing a worker unless you intend to wake that peer right now — refer to them without `@` (e.g. \"the validator\") for future handoffs." : " Avoid writing another peer's `@handle` in prose when addressing a worker unless you intend to wake that peer right now."}`,
    "",
    "## 4. Core Swarm Tools (4 Tools)",
    `- \`${SWARM_TOOL}\`: \`title\`, \`add\`, \`status\`, \`models\`, \`model\` (auto-resumes switched member), \`steer\`, \`stop\`, \`kill\`, \`merge\`, \`channel\`, \`done\`.`,
    `- \`${POST_MESSAGE_TOOL}\` / \`${READ_BOARD_TOOL}\`: Post to the shared board, read messages (\`#seq\`/\`since\`/\`channel\`/\`search\`), or inspect roster (\`status:true\`).`,
    `- \`${SWARM_WAIT_TOOL}\`: End your turn cleanly (non-blocking) and sleep until woken by a member, \`all_idle\`, or user input. Always pass the highest read \`#seq\` as \`since\`.`,
    "",
    "## 5. Keep Warm, Context Forking & 3-Role Models",
    `- **Keep Warm**: Completed members park in \`waiting\` (zero tokens, full history intact, disk-backed sessions). NEVER \`kill\` as a pause!`,
    `- **Hot Model Switch**: Calling \`${SWARM_TOOL}{action:"model", name, model}\` on a \`waiting\` member hot-switches while keeping conversation history AND automatically resumes it to continue unfinished work.`,
    `- **Context Forking**: Pass \`fork:"orchestrator"\` or \`fork:"<member>"\` on \`${SWARM_TOOL}{action:"add"}\` when a new member benefits from branching existing conversation history.`,
    "- **3-Role Models**: `orchestrator` (host session), `worker` (default for `role:\"worker\"`), `validator` (default for `role:\"validator\"`).",
  ].join("\n");
}

function formatRoleModelsLine(roleModels: SwarmRoleModels): string {
  const fallbacks =
    roleModels.fallbackModels && roleModels.fallbackModels.length > 0
      ? ` | fallbacks=[${roleModels.fallbackModels.join(", ")}]`
      : "";
  return `- **3-Role Models**: orchestrator=${formatRoleConfig(roleModels.orchestrator)} | worker=${formatRoleConfig(roleModels.worker)} | validator=${formatRoleConfig(roleModels.validator)}${fallbacks}`;
}

function buildHumanSteeringSection(humanSteeringText: string): string {
  const cleanSteer = humanSteeringText.replace(/\s+/g, " ").trim().slice(0, 500);
  return [
    "### ⚡ Live User Direction Update",
    `The user just sent a dynamic message while the Swarm is running: "${cleanSteer}".`,
    `Adjust active/parked workers immediately using \`${SWARM_TOOL}{action:"steer"}\`, \`${SWARM_TOOL}{action:"stop"/"kill"}\`, \`${SWARM_TOOL}{action:"title"}\`, \`${SWARM_TOOL}{action:"add"}\`, or \`${POST_MESSAGE_TOOL}\`, and report clearly.`,
  ].join("\n");
}

function formatChannelLine(ch: SwarmChannelRecord): string {
  const subs = ch.subscribers.length > 0 ? ch.subscribers.join(",") : "(all)";
  const topic = ch.topic ? ` — ${ch.topic}` : "";
  const archived = ch.archived ? " [ARCHIVED]" : "";
  return `- \`#${ch.name}\`${archived} subscribers=[${subs}]${topic}`;
}

function getOrderedMembers(run: SwarmRunState): SwarmMemberRecord[] {
  const seen = new Set<string>();
  const result: SwarmMemberRecord[] = [];
  for (const name of run.memberOrder) {
    const m = run.members[name];
    if (m && !seen.has(m.name)) {
      seen.add(m.name);
      result.push(m);
    }
  }
  for (const m of Object.values(run.members)) {
    if (m && !seen.has(m.name)) {
      seen.add(m.name);
      result.push(m);
    }
  }
  return result;
}

function formatMemberLine(
  m: SwarmMemberRecord,
  includeCurrentActivity: boolean,
): string {
  const ws = m.branch ? `${m.workspace}:${m.branch}` : m.workspace;
  const isIsolated = m.workspace === "share" || m.workspace === "branch";
  const cwdPart = isIsolated && m.state !== "killed" ? ` cwd=${m.cwd}` : "";
  const model = m.model ? ` model=${m.model}` : "";
  const post = m.lastPostSeq ? ` lastPost=#${m.lastPostSeq}` : "";
  const merged = m.mergedCommitSha
    ? ` merged=${m.mergedCommitSha.slice(0, 7)}`
    : isIsolated && m.state !== "killed"
      ? " merged=UNMERGED"
      : "";
  const stopped = m.humanStopped ? " [HUMAN-STOPPED]" : "";
  const err = m.error ? ` err="${m.error.slice(0, 80)}"` : "";
  const activityText = includeCurrentActivity
    ? (m.currentActivity ?? m.parkedOn)
    : m.parkedOn;
  const activity = activityText ? ` — ${activityText}` : "";
  return `- \`@${m.name}\` (${m.role}) [${m.state}] ws=${ws}${cwdPart} parent=@${m.parentName}${model} turns=${m.turns}${post}${merged}${stopped}${err}${activity}`;
}

function buildActionNeededSection(
  run: SwarmRunState,
  snapshot: SwarmSnapshot,
  members: readonly SwarmMemberRecord[],
): string | null {
  if (run.status !== "active") {
    return null;
  }

  const workingSet = new Set(snapshot.workingMemberNames);
  const unmergedParked = members.filter(
    (m) =>
      m.state !== "killed" &&
      !workingSet.has(m.name) &&
      (m.state === "waiting" || m.state === "stopped") &&
      (m.workspace === "share" || m.workspace === "branch") &&
      !m.mergedCommitSha,
  );

  const items: string[] = [];

  if (unmergedParked.length > 0) {
    const peerSummary = unmergedParked
      .map(
        (m) =>
          `\`@${m.name}\` [${m.state}, \`${m.workspace}:${m.branch ?? "unbranched"}\`${m.lastPostSeq ? `, lastPost=#${m.lastPostSeq}` : ""}]`,
      )
      .join(", ");
    const auditHint = run.validatorEnabled
      ? "confirm independent `@validator` sign-off, then "
      : "";
    items.push(
      `- **Unmerged Branches (${unmergedParked.length})**: ${peerSummary} — UNMERGED into \`${run.baseBranch}\`; ${auditHint}merge ready branches via \`${SWARM_TOOL}{action:"merge", name}\` and run a post-merge check on \`${run.baseBranch}\` before killing or calling \`done\`.`,
    );
  }

  const activeWorkingCount = Math.max(
    workingSet.size,
    members.filter((m) => m.state === "working").length,
  );
  if (activeWorkingCount === 0) {
    const liveCount = members.filter((m) => m.state !== "killed").length;
    if (liveCount === 0) {
      items.push(
        `- **0 Members Working**: The Swarm is idle and waiting on your next decision — spawn workers via \`${SWARM_TOOL}{action:"add"}\` (or close with \`${SWARM_TOOL}{action:"done", summary}\` once verified).`,
      );
    } else {
      items.push(
        `- **0 Members Working**: All ${liveCount} live member(s) are parked (\`waiting\`/\`stopped\`) — the Swarm is waiting on your next decision (inspect recent \`#seq\` reports via \`${READ_BOARD_TOOL}\`, wake/steer/add next-wave members, merge verified branches, or verify \`${run.baseBranch}\` and call \`${SWARM_TOOL}{action:"done", summary}\`).`,
      );
    }
  }

  if (items.length === 0) {
    return null;
  }

  return ["### Action Needed", ...items].join("\n");
}

/**
 * Builds the static, cache-friendly Orchestrator Playbook and Swarm Run Contract
 * (zero volatile counters or board excerpts, so `diffSystemPromptSections` emits it once per run).
 */
export function buildOrchestratorStaticSection(snapshot: SwarmSnapshot): string {
  const run = snapshot.run;
  const sections: string[] = [
    buildOrchestratorPlaybookCore(run?.validatorEnabled !== false),
  ];

  if (!run) {
    return sections.join("\n\n");
  }

  const contractLines: string[] = [
    "## Swarm Run Contract",
    `- **Title**: ${run.title}`,
    `- **ID**: \`${run.id}\``,
    `- **Base Branch**: \`${run.baseBranch}\``,
    `- **Max Concurrency**: ${run.maxConcurrency}`,
    `- **Validator Policy**: ${run.validatorEnabled ? "ON" : "OFF"}`,
    `- **Objective**: ${run.objective}`,
  ];
  if (run.strategy.trim()) {
    contractLines.push(`- **Strategy**: ${run.strategy.trim()}`);
  }
  if (run.acceptanceCriteria.trim()) {
    contractLines.push(`- **Acceptance Criteria**: ${run.acceptanceCriteria.trim()}`);
  }
  sections.push(contractLines.join("\n"));

  return sections.join("\n\n");
}

/**
 * Builds the compact live Swarm delta section for injection after the static contract.
 * Omits sub-second `currentActivity` churn and collapses `killed` members to one summary line.
 */
export function buildOrchestratorLiveStateSection(
  snapshot: SwarmSnapshot,
  options?: OrchestratorLiveStateOptions,
): string {
  const run = snapshot.run;
  if (!run) {
    return [
      "## Active Swarm State",
      "No active Swarm run. Use `/swarm` to start a run.",
    ].join("\n");
  }

  const sections: string[] = [];
  const stateHeader: string[] = [
    "## Active Swarm State",
    `- **Status**: \`${run.status}\` | **Board Head**: \`#${snapshot.boardHead}\``,
    `- **Active / Waiting**: ${snapshot.workingMemberNames.length}/${run.maxConcurrency} active | ${snapshot.waitingMemberNames.length} waiting`,
    formatRoleModelsLine(snapshot.roleModels),
  ];

  if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > Date.now()) {
    const secs = Math.ceil((snapshot.rateLimitUntil - Date.now()) / 1000);
    stateHeader.push(
      `- **RATE-LIMIT BACKOFF**: pausing new launches for ~${secs}s${snapshot.rateLimitReason ? ` (${snapshot.rateLimitReason})` : ""}.`,
    );
  }
  sections.push(stateHeader.join("\n"));

  if (options?.humanSteeringText?.trim()) {
    sections.push(buildHumanSteeringSection(options.humanSteeringText));
  }

  const members = getOrderedMembers(run);
  const actionNeeded = buildActionNeededSection(run, snapshot, members);
  if (actionNeeded) {
    sections.push(actionNeeded);
  }

  const customChannels = Object.values(run.channels).filter(
    (ch) => ch.name !== DEFAULT_CHANNEL,
  );
  if (customChannels.length > 0) {
    sections.push(`### Channels\n${customChannels.map(formatChannelLine).join("\n")}`);
  }

  const liveMembers = members.filter((m) => m.state !== "killed");
  const killedMembers = members.filter((m) => m.state === "killed");

  if (members.length === 0) {
    sections.push(
      `### Live Members (0)\n(none spawned yet — add members with \`${SWARM_TOOL}{action:"add"}\`)`,
    );
  } else {
    const memberLines = liveMembers.map((m) => formatMemberLine(m, false));
    if (killedMembers.length > 0) {
      const mergedNames = killedMembers
        .filter((m) => Boolean(m.mergedCommitSha))
        .map((m) => `@${m.name}`);
      const mergedSuffix =
        mergedNames.length > 0 ? ` (merged: ${mergedNames.join(", ")})` : "";
      memberLines.push(`- Retired (killed): ${killedMembers.length}${mergedSuffix}`);
    }
    sections.push(`### Live Members (${liveMembers.length})\n${memberLines.join("\n")}`);
  }

  if (options?.includeRecentBoard !== false && snapshot.recentBoard.length > 0) {
    const tail = snapshot.recentBoard.slice(-8);
    sections.push(
      `### Recent Shared Board (head #${snapshot.boardHead}, last ${tail.length})\n${formatBoardExcerpt(tail, 200)}`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Builds the Antigravity Swarm Coordinator Playbook + live run state section
 * injected prompt-cache-safely into `sections.swarm` (or tail context) while a run is active.
 */
export function buildOrchestratorPlaybookSection(
  snapshot: SwarmSnapshot,
  options?: OrchestratorPlaybookOptions,
): string {
  const run = snapshot.run;
  const sections: string[] = [];

  sections.push(buildOrchestratorPlaybookCore(run?.validatorEnabled !== false));

  if (!run) {
    sections.push(
      [
        "## Current Swarm State",
        "No active Swarm run. Use `/swarm` to start a run.",
      ].join("\n"),
    );
    return sections.join("\n\n");
  }

  const stateHeader: string[] = [
    "## Active Swarm Run State",
    `- **Title**: ${run.title} (\`${run.id}\`)`,
    `- **Status**: \`${run.status}\` | **Base Branch**: \`${run.baseBranch}\` | **Board Head**: \`#${snapshot.boardHead}\``,
    `- **Concurrency**: ${snapshot.workingMemberNames.length}/${run.maxConcurrency} working | ${snapshot.waitingMemberNames.length} warm waiting | Validator Policy: ${run.validatorEnabled ? "ON" : "OFF"}`,
    formatRoleModelsLine(snapshot.roleModels),
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

  if (options?.humanSteeringText?.trim()) {
    sections.push(buildHumanSteeringSection(options.humanSteeringText));
  }

  const members = getOrderedMembers(run);
  const actionNeeded = buildActionNeededSection(run, snapshot, members);
  if (actionNeeded) {
    sections.push(actionNeeded);
  }

  // Channels compact summary
  const channels = Object.values(run.channels);
  if (channels.length > 0) {
    sections.push(`### Channels\n${channels.map(formatChannelLine).join("\n")}`);
  }

  // Live members compact summary
  if (members.length > 0) {
    const memberLines = members.map((m) => formatMemberLine(m, true));
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

function buildValidatorPeerWorktreesSection(
  run: SwarmRunState,
  validator: SwarmMemberRecord,
): string {
  const isolatedPeers = getOrderedMembers(run).filter(
    (m) =>
      m.name !== validator.name &&
      m.state !== "killed" &&
      (m.workspace === "share" || m.workspace === "branch"),
  );

  const lines: string[] = [
    "### Peer Worktrees & Branches to Audit",
    `Your validator session runs at \`${validator.cwd}\` (\`${run.baseBranch}\`). Unmerged \`share\`/\`branch\` worker edits exist ONLY inside each author's isolated \`cwd\` — running \`git diff\` or tests in \`${validator.cwd}\` before merge will miss unmerged worker code!`,
  ];

  if (isolatedPeers.length === 0) {
    lines.push(
      `- (no active \`share\`/\`branch\` worktrees yet — call \`${READ_BOARD_TOOL}{status:true}\` or \`${SWARM_TOOL}{action:"status"}\` to inspect newly spawned peer \`cwd\`/\`branch\` paths, then run \`git -C "<cwd>" status --short\`, \`git -C "<cwd>" diff ${run.baseBranch}...HEAD\`, and \`cd "<cwd>" && <slice test command>\`)`,
    );
    return lines.join("\n");
  }

  for (const peer of isolatedPeers) {
    const mergeStatus = peer.mergedCommitSha
      ? `merged=${peer.mergedCommitSha.slice(0, 7)}`
      : "UNMERGED";
    const branchName = peer.branch ?? "unknown";
    lines.push(
      `- \`@${peer.name}\` [${peer.state}] workspace=\`${peer.workspace}\` branch=\`${branchName}\` cwd=\`${peer.cwd}\` (${mergeStatus})`,
      `  - Audit commands: \`git -C "${peer.cwd}" status --short\`, \`git -C "${peer.cwd}" diff ${run.baseBranch}...HEAD\`, and run slice tests inside \`${peer.cwd}\` via \`cd "${peer.cwd}" && <typecheck/test command>\`.`,
    );
  }
  lines.push(
    `- If new \`share\`/\`branch\` peers join after you started, call \`${READ_BOARD_TOOL}{status:true}\` (or check \`workspace=<cwd>\` in their \`[done]\` post) to get their \`cwd\` and \`branch\`.`,
  );

  return lines.join("\n");
}

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
      `3. **\`@mention\` Discipline**: \`@name\` is a wakeup doorbell, never a CC. Tag ONLY the peer(s) who must act next (follow your brief's next-peer doorbell, e.g. \`@validator\`, without waking \`@${ORCHESTRATOR_NAME}\` on intermediate handoffs). Tag \`@${member.parentName}\` when your deliverable has no downstream peer or you hit a blocker only they can resolve.`,
      `4. **Completion Convention**: Start your final deliverable post with \`[done]\` right after the \`@mention\` (e.g. \`@<next-peer-or-${member.parentName}> [done] <concise summary of results, files/commits, and verification>\`).`,
      `5. **Stay Warm via \`${SWARM_WAIT_TOOL}\`**: After posting your result (or while awaiting a peer reply), call \`${SWARM_WAIT_TOOL}{since: <highest-seq-you-read>}\` to park in warm \`waiting\` state (zero tokens, full conversation memory intact). Never poll \`${READ_BOARD_TOOL}\` in a loop!`,
      "6. **Keep Posts Short**: No greetings or empty acknowledgements — post concrete findings, questions, or results.",
    ].join("\n"),
  );

  if (member.role === "validator") {
    sections.push(
      [
        "## Independent Read-Only Validator Rules (Strictly Enforced)",
        "1. **STRICTLY READ-ONLY — NEVER Edit Files**: You are an independent auditor. NEVER create, edit, or delete files, stage changes, or make git commits. `write`, `edit`, `powershell`, and mutating `bash` commands are blocked by protocol.",
        `2. **Verify Independently**: Treat worker reports as untrusted claims. For \`share\`/\`branch\` workers, audit directly inside each author's isolated worktree \`cwd\` (\`git -C "<cwd>" status --short\`, \`git -C "<cwd>" diff ${run.baseBranch}...HEAD\`, \`git -C "<cwd>" show\`, reading files under \`<cwd>/\`, and running slice typechecks/tests inside \`<cwd>\`) against the Run Objective, Acceptance Criteria, and your brief.`,
        "3. **Peer-to-Peer Fix Loop**: If you find bugs, regressions, edge-case failures, or missing requirements, post concrete actionable findings (file path, line number, reproduction/command output, and concrete fix) directly to `@<author>` on the board — do NOT bother `@orchestrator` on intermediate bug bounces — then call `swarm_wait` to await their fix and re-audit!",
        `4. **Sign-Off**: Post \`@${member.parentName} [done] <evidence-backed audit report>\` ONLY when every check passes with zero blocking defects (or escalate clearly to \`@${member.parentName}\` if blocked).`,
        `5. **Read-Only Helpers**: You may spawn read-only \`role:"validator"\` sub-auditors via \`${SWARM_TOOL}{action:"add"}\` if your audit splits cleanly across independent areas. Tell helpers to report to \`@${member.name}\`, and \`${SWARM_TOOL}{action:"kill"}\` them once integrated.`,
      ].join("\n"),
    );
    sections.push(buildValidatorPeerWorktreesSection(run, member));
  } else {
    const workspaceCommitRule =
      member.workspace === "inherit"
        ? `2. **Shared Checkout Discipline**: You are working in \`inherit\` mode at \`${member.cwd}\`. Touch ONLY files owned by your brief so you never collide with sibling workers.`
        : `2. **Isolated Worktree Commits**: You are working in an isolated worktree at \`${member.cwd}\` on branch \`${member.branch ?? "swarm"}\`. Respect your brief's exclusive file ownership (never edit off-limits files), and commit all intended changes cleanly on your branch with a clean \`git status\` before posting \`[done]\` (include \`commit=<sha>\` and \`workspace=${member.cwd}\` in your \`[done]\` report). NEVER run \`git merge\`, \`git push\`, \`git worktree\`, or switch to \`${run.baseBranch}\` — only \`@${ORCHESTRATOR_NAME}\` merges worktrees.`;

    sections.push(
      [
        "## Worker Execution & Helper Rules",
        `1. **Protected Paths**: NEVER touch \`${SWARM_DIR}/\`, \`.swarm/\`, or \`.git/\` directly — use Swarm tools instead.`,
        workspaceCommitRule,
        `3. **Verify Before Reporting**: Run the concrete verification commands from your brief (typechecks, tests, build checks) inside \`${member.cwd}\` before posting \`[done]\`. Batch independent read, inspection, or verification shell commands into a single compound \`bash\` call (e.g. \`git status --short && npm run typecheck && npm test\`) instead of running 4–5 serial single-command \`bash\` turns.`,
        `4. **Spawning & Managing Own Helpers**: You may call \`${SWARM_TOOL}{action:"add", name, brief, ...}\` when your assignment splits into independent pieces or needs an investigator/helper. Tell helpers to report back to \`@${member.name}\` by name. You may call \`${SWARM_TOOL}{action:"model"}\` on yourself (safely deferred to turn end with automatic resume on the new model) or your own waiting helpers, \`${SWARM_TOOL}{action:"steer"/"stop"}\` on your own helpers, and MUST call \`${SWARM_TOOL}{action:"kill"}\` on your own helpers once you integrate their work. You cannot kill other members or call \`title\`/\`merge\`/\`done\`.`,
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
    `Start working immediately. Read referenced \`#seq\` posts via \`${READ_BOARD_TOOL}\` if needed, post your result via \`${POST_MESSAGE_TOOL}\`, and call \`${SWARM_WAIT_TOOL}{since: ${briefSeq}}\` (or the highest #seq you read or posted) when waiting for follow-ups or finished.`,
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
  const formatted = messages.map((m) => formatBoardEntryFull(m, 2500)).join("\n\n");
  const lines: string[] = [
    `New shared board message(s) for \`@${member.name}\` (board head: \`#${head}\`):`,
    "",
    formatted,
    "",
  ];
  if (member.role === "validator") {
    lines.push(
      `Validator audit reminder: unmerged \`share\`/\`branch\` worker commits live in each author's isolated worktree \`cwd\` (not \`${member.cwd}\`) — run \`git -C "<cwd>" status --short\`, \`git -C "<cwd>" diff <baseBranch>...HEAD\`, and \`cd "<cwd>" && <slice test command>\` (call \`${READ_BOARD_TOOL}{status:true}\` if you need a peer's \`cwd\`/\`branch\`/merge status).`,
      "",
    );
  }
  lines.push(
    `Respond/act on the board via \`${POST_MESSAGE_TOOL}\` as needed, then call \`${SWARM_WAIT_TOOL}{since: ${head}}\` when idle again.`,
  );
  return lines.join("\n");
}

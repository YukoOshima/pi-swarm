import {
  DEFAULT_CHANNEL,
  ORCHESTRATOR_NAME,
  POST_MESSAGE_TOOL,
  PROPOSE_SWARM_PLAN_TOOL,
  READ_BOARD_TOOL,
  STANDBY_SWARM_TOOLS,
  SWARM_DIR,
  SWARM_FEATURES_FILE,
  SWARM_LIBRARY_DIR,
  SWARM_MISSION_FILE,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_QUESTION_TOOL,
  SWARM_RUNS_DIR,
  SWARM_SERVICES_FILE,
  SWARM_TOOL,
  SWARM_VALIDATION_CONTRACT_FILE,
  SWARM_WAIT_TOOL,
} from "../constants.js";
import type {
  BoardMessage,
  FeatureStatus,
  SwarmChannelRecord,
  SwarmMemberRecord,
  SwarmMilestone,
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

function formatMessageHandoffInline(msg: BoardMessage): string {
  const tags: string[] = [];
  if (msg.featureId) {
    tags.push(`[feat:${msg.featureId}]`);
  }
  if (msg.discoveredIssues && msg.discoveredIssues.length > 0) {
    tags.push(`[+${msg.discoveredIssues.length} issue]`);
  }
  if (msg.leftUndone && msg.leftUndone.length > 0) {
    tags.push(`[!${msg.leftUndone.length} undone]`);
  }
  if (msg.verificationEvidence) {
    tags.push("[✓evidence]");
  }
  return tags.length > 0 ? ` ${tags.join(" ")}` : "";
}

function formatMessageHandoffBlock(msg: BoardMessage): string {
  const lines: string[] = [];
  if (msg.featureId) {
    lines.push(`- Feature: \`${msg.featureId}\``);
  }
  if (msg.verificationEvidence) {
    lines.push(`- Verification Evidence: ${msg.verificationEvidence}`);
  }
  if (msg.discoveredIssues && msg.discoveredIssues.length > 0) {
    lines.push(`- Discovered Issues: ${msg.discoveredIssues.join("; ")}`);
  }
  if (msg.leftUndone && msg.leftUndone.length > 0) {
    lines.push(`- Left Undone: ${msg.leftUndone.join("; ")}`);
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function formatFeatureBadge(status: FeatureStatus): string {
  switch (status) {
    case "completed":
      return "[✓]";
    case "in_progress":
      return "[▸]";
    case "failed":
      return "[!]";
    case "cancelled":
      return "[~]";
    default:
      return "[ ]";
  }
}

function formatMilestoneBadge(m: SwarmMilestone): string {
  const glyph =
    m.status === "done"
      ? "[✓]"
      : m.status === "in_progress"
        ? "[▸]"
        : m.status === "blocked"
          ? "[!]"
          : "[ ]";
  return `${glyph} ${m.label} (${m.status})${m.sealed ? " [sealed]" : ""}`;
}

function formatMissionArtifactPaths(runId: string): string {
  const base = `${SWARM_DIR}/${SWARM_RUNS_DIR}/${runId}`;
  return `\`${base}/${SWARM_MISSION_FILE}\`, \`${base}/${SWARM_VALIDATION_CONTRACT_FILE}\`, \`${base}/${SWARM_FEATURES_FILE}\`, \`${base}/${SWARM_SERVICES_FILE}\`, \`${base}/${SWARM_LIBRARY_DIR}/\``;
}

function buildMissionManifestLines(run: SwarmRunState): string[] {
  const lines: string[] = [];
  if (run.commands && run.commands.length > 0) {
    lines.push(
      `- **Operational Commands**: ${run.commands.map((c) => `\`${c.name}\`: \`${c.command}\``).join(" | ")}`,
    );
  }
  if (run.services && run.services.length > 0) {
    const svcFormatted = run.services
      .map((s) => {
        const portPart = s.port !== undefined ? ` (port ${s.port})` : "";
        const hcPart = s.healthcheck ? `, healthcheck: \`${s.healthcheck}\`` : "";
        const stopPart = s.stop ? `, stop: \`${s.stop}\`` : "";
        const depPart =
          s.dependsOn && s.dependsOn.length > 0
            ? `, dependsOn=[${s.dependsOn.join(",")}]`
            : "";
        return `\`${s.name}\`${portPart} [start: \`${s.start}\`${hcPart}${stopPart}${depPart}]`;
      })
      .join(" | ");
    lines.push(`- **Mission Services & Ports**: ${svcFormatted}`);
  }
  if (run.boundaries && run.boundaries.length > 0) {
    lines.push(`- **Mission Boundaries**: ${run.boundaries.join(" · ")}`);
  }
  lines.push(
    `- **Shared Mission Library**: \`${SWARM_DIR}/${SWARM_RUNS_DIR}/${run.id}/${SWARM_LIBRARY_DIR}/\` (use \`${SWARM_TOOL}{action:"mission", mission_op:"read_library", library_topic?}\` & \`mission_op:"write_library"\` with \`library_append:true\` to share \`architecture\`, \`environment\`, and \`testing\` notes)`,
  );
  return lines;
}

function buildMissionGoalSummarySection(
  run: SwarmRunState,
  options?: { highlightMember?: string; includeManifest?: boolean },
): string | null {
  const milestones = run.milestones ?? [];
  const features = run.features ?? [];
  const assertions = run.assertions ?? [];
  const handoffs = run.handoffItems ?? [];
  const openHandoffs = handoffs.filter((h) => h.resolution === "open");
  const hasManifest =
    options?.includeManifest !== false &&
    ((run.commands?.length ?? 0) > 0 ||
      (run.services?.length ?? 0) > 0 ||
      (run.boundaries?.length ?? 0) > 0);

  if (
    milestones.length === 0 &&
    features.length === 0 &&
    assertions.length === 0 &&
    openHandoffs.length === 0 &&
    !hasManifest
  ) {
    return null;
  }

  const lines: string[] = [
    "### Mission Goal Progress & Validation Contract",
    `- **Mission Artifacts**: ${formatMissionArtifactPaths(run.id)}`,
  ];

  if (options?.includeManifest !== false) {
    lines.push(...buildMissionManifestLines(run));
  }

  if (milestones.length > 0) {
    lines.push(`- **Milestones**: ${milestones.map(formatMilestoneBadge).join(" · ")}`);
  }

  if (features.length > 0) {
    const nonCancelled = features.filter((f) => f.status !== "cancelled");
    const completedCount = nonCancelled.filter((f) => f.status === "completed").length;
    lines.push(
      `- **Feature Queue (${completedCount}/${nonCancelled.length} completed)**:`,
    );
    const preview = features.slice(0, 12);
    for (const f of preview) {
      const assignedTag = f.assignedMember
        ? options?.highlightMember === f.assignedMember
          ? ` **[@${f.assignedMember} — YOUR FEATURE]**`
          : ` (@${f.assignedMember})`
        : "";
      const depsTag =
        f.dependsOn && f.dependsOn.length > 0
          ? ` dependsOn=[${f.dependsOn.join(",")}]`
          : "";
      const fulfillsTag =
        f.fulfills.length > 0 ? ` fulfills=[${f.fulfills.join(",")}]` : "";
      lines.push(
        `  - ${formatFeatureBadge(f.status)} \`${f.id}\` [${f.milestone}] ${f.title}${assignedTag}${depsTag}${fulfillsTag}`,
      );
    }
    if (features.length > preview.length) {
      lines.push(
        `  - ... +${features.length - preview.length} more feature(s) (inspect via \`${SWARM_TOOL}{action:"mission", mission_op:"status"}\`)`,
      );
    }
  }

  if (assertions.length > 0) {
    const passed = assertions.filter((a) => a.status === "passed").length;
    const overridden = assertions.filter((a) => a.overridden === true).length;
    const failed = assertions.filter((a) => a.status === "failed").length;
    const pending = assertions.filter((a) => a.status === "pending").length;
    const blocked = assertions.filter((a) => a.status === "blocked").length;
    const claimedSet = new Set(
      features
        .filter((f) => f.status !== "cancelled")
        .flatMap((f) => f.fulfills),
    );
    const unclaimed = assertions.filter((a) => !claimedSet.has(a.id));
    lines.push(
      `- **Validation Contract (\`VAL-*\`: ${passed}/${assertions.length} passed${overridden > 0 ? ` [${overridden} OVERRIDE]` : ""} · ${pending} pending · ${failed} failed${blocked > 0 ? ` · ${blocked} blocked` : ""})**:`,
    );
    for (const a of assertions.slice(0, 14)) {
      const verifier = a.verifiedBy ? ` by @${a.verifiedBy}` : "";
      const overrideTag = a.overridden ? " [OVERRIDE]" : "";
      lines.push(`  - \`${a.id}\` [${a.status}]${overrideTag}${verifier}: ${a.title}`);
    }
    if (assertions.length > 14) {
      lines.push(`  - ... +${assertions.length - 14} more assertion(s)`);
    }
    if (unclaimed.length > 0) {
      lines.push(
        `  - ⚠ **Unclaimed \`VAL-*\` Assertions**: ${unclaimed.map((a) => `\`${a.id}\``).join(", ")} (assign to feature \`fulfills[]\`)`,
      );
    }
  }

  if (openHandoffs.length > 0) {
    lines.push(`- **Open Handoff Tech-Debt (${openHandoffs.length})**:`);
    for (const h of openHandoffs.slice(0, 8)) {
      const featPart = h.sourceFeatureId ? ` on \`${h.sourceFeatureId}\`` : "";
      lines.push(
        `  - \`${h.id}\` (${h.type} from \`@${h.sourceMember}\`${featPart}): ${h.summary.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
  }

  return lines.join("\n");
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
  const handoffPart = formatMessageHandoffInline(msg);
  const compact = msg.text.replace(/\s+/g, " ").trim();
  const clipped = compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
  return `#${msg.seq} [${channelPart}] ${msg.from}${targetPart}${kindPart}${handoffPart}: ${clipped}`;
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
  const handoffInline = formatMessageHandoffInline(msg);
  const header = `#${msg.seq} [${channelPart}] ${msg.from}${targetPart}${kindTag}${handoffInline}:`;

  const body = msg.text.trimEnd();
  const handoffBlock = formatMessageHandoffBlock(msg);
  if (maxChars !== undefined && body.length > maxChars) {
    const remaining = body.length - maxChars;
    return `${header}\n${body.slice(0, maxChars)}\n... [truncated ${remaining} chars; call ${READ_BOARD_TOOL}{seqs:[${msg.seq}]} for full message]${handoffBlock}`;
  }
  const combinedBody = `${body}${handoffBlock}`;
  return combinedBody.length > 0 ? `${header}\n${combinedBody}` : header;
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

export interface OrchestratorStandbyOptions {
  /** Optional most recently completed Swarm run used to carry forward `.pi/swarm/runs/<runId>/library/`, commands, services, boundaries, and summary context. */
  priorRun?: Pick<
    SwarmRunState,
    | "id"
    | "title"
    | "objective"
    | "baseBranch"
    | "completionSummary"
    | "commands"
    | "services"
    | "boundaries"
  > | null;
  /** True when Persistent Orchestrator Mode defaults to `autoConfirm: true` (e.g. entered via `/swarm direct`). */
  autoConfirmDefault?: boolean;
  /** Optional 3-role model configuration override when `snapshot` is omitted. */
  roleModels?: SwarmRoleModels;
}

function buildOrchestratorPlaybookCore(validatorEnabled: boolean): string {
  const nextPeerExample = validatorEnabled
    ? `\`@validator [done] summary=... files=...\` (plus \`commit=<sha> workspace=<cwd>\` when using opt-in \`share\`/\`branch\` worktrees) so author -> validator runs zero-hop without waking \`@${ORCHESTRATOR_NAME}\` in between, or \`@${ORCHESTRATOR_NAME} [done] ...\` when no downstream peer exists`
    : `\`@<downstream-peer> [done] summary=... files=...\` for zero-hop peer handoffs, or \`@${ORCHESTRATOR_NAME} [done] summary=... files=...\` when no downstream peer exists`;

  const rightSizingRule = validatorEnabled
    ? "- **Right-Size & Default to `workspace:\"inherit\"` (No Worktree Sprawl)**: Spawn **1–2 workers** for localized/single-module changes (do not over-shard small edits); for multi-module work, fan out parallel **`workspace:\"inherit\"`** authors (the default!) on strictly disjoint `filesOwned` slices in the shared repo + **1 `role:\"validator\"` per 2–4 authors** (zero worktree creation, zero `merge --no-ff` commits, instant shared visibility for `@validator`). Use `workspace:\"share\"` / `\"branch\"` strictly as opt-in ONLY when concurrent workers genuinely must edit overlapping files or run isolated/destructive branch experiments."
    : "- **Right-Size & Default to `workspace:\"inherit\"` (No Worktree Sprawl)**: Spawn **1–2 workers** for localized/single-module changes (do not over-shard small edits); for multi-module work, fan out parallel **`workspace:\"inherit\"`** authors (the default!) on strictly disjoint `filesOwned` slices in the shared repo (use `workspace:\"share\"` / `\"branch\"` strictly as opt-in ONLY when concurrent workers genuinely must edit overlapping files or run isolated/destructive branch experiments).";

  return [
    "# Pi Swarm Orchestrator Playbook (Antigravity Swarm)",
    "",
    "## 1. Do Not Do the Technical Work Yourself (Ephemeral Specialists, Permanent `@orchestrator`)",
    `- **Persistent Orchestrator Lifecycle**: Workers (\`role:"worker"\`) and Validators (\`role:"validator"\`) are **ephemeral** per-mission specialists that are retired and destroyed (along with any opt-in worktrees and scratch directories) when finished (\`${SWARM_TOOL}{action:"kill"}\` / \`${SWARM_TOOL}{action:"done"}\`). By contrast, \`@${ORCHESTRATOR_NAME}\` (you) stays **permanently on duty** across subsequent user tasks — transitioning to \`"standby"\` mode after \`done\` until the user explicitly exits via \`/swarm exit\` (never attempt to exit Orchestrator Mode yourself).`,
    `- **Never Self-Implement**: Delegate ALL technical work (codebase research, scaffolding, coding, integration, builds/tests, verification) to named swarm members via \`${SWARM_TOOL}{action:"add"}\` (defaults to \`workspace:"inherit"\` on disjoint \`filesOwned\`) or \`${SWARM_TOOL}{action:"mission", mission_op:"dispatch_ready"}\` — never edit repository files or run mutating \`bash\`/\`write\`/\`edit\`/\`powershell\` commands directly from Orchestrator (hard-blocked by protocol guard).`,
    `- Your job is orchestration: right-size the swarm, write high-signal briefs, read \`#seq\` board reports, judge quality and completeness, merge any opt-in isolated worktrees/clones (\`${SWARM_TOOL}{action:"merge"}\`), verify integration on \`baseBranch\`, retire finished workers (\`${SWARM_TOOL}{action:"kill"}\`), preserve reusable insights in \`${SWARM_LIBRARY_DIR}/\`, and adapt seamlessly whenever the user redirects you.`,
    "",
    "## 2. Right-Sizing, Dynamic Phased Collaboration & Mid-Mission Scope Propagation",
    rightSizingRule,
    "- Adapt wave-by-wave instead of locking into a rigid upfront DAG:",
    "  1. **Discovery**: Spawn read-only researchers/scouts first when unknowns exist → inspect their `#seq` reports.",
    "  2. **Contract / Scaffold**: Spawn a contract/scaffold worker when shared interfaces must settle before fan-out → inspect its `#seq`.",
    "  3. **Parallel Execution (`workspace:\"inherit\"` Default)**: Spawn disjoint named authors in parallel on **`workspace:\"inherit\"` by default** in the shared repo when each worker owns disjoint `filesOwned` slices (no worktrees or merges needed!). Opt into `workspace:\"share\"` or `workspace:\"branch\"` ONLY when two concurrent workers genuinely must edit overlapping files at the same time or run isolated/destructive branch experiments (use `n` or `tasks[]` for sharded slices).",
    ...(validatorEnabled
      ? [
          "  4. **Independent Read-Only Validation (with Isolated Scratch Sandbox)**: Spawn independent `role:\"validator\"` members (~1 validator per 2–4 authors) to audit code, diffs, tests, and runtime behavior directly in the shared repo for `inherit` workers (and inside each author's worktree `cwd` for any opt-in `share`/`branch` workers). Each `role:\"validator\"` automatically gets a dedicated OS temp scratch directory (`scratchDir`) where `write`/`edit` and explicit-path `mkdir`/`cp`/`mv`/`rm`/output redirections work for temporary builds (`--target-dir`), synthetic fixtures, and mutation/negative-case checks while repository and worktree files stay strictly read-only — NEVER spawn `role:\"worker\"` members as pseudo-validators just to write temporary test files, and NEVER let authors self-certify!",
          "  5. **Peer-to-Peer Bug Closure**: Let `@validator` and `@author` resolve defects directly on the board (`@author` <-> `@validator`) without waking `@orchestrator` on intermediate bounces.",
          `  6. **Land & Complete**: Default \`inherit\` edits are already live on \`baseBranch\` (no \`merge\` needed); if any opt-in \`share\`/\`branch\` worktrees were used, merge them via \`${SWARM_TOOL}{action:"merge"}\` and run a **post-merge integration check on \`baseBranch\`** BEFORE calling \`done\`. Kill finished members via \`${SWARM_TOOL}{action:"kill"}\`, and close the run cleanly via \`${SWARM_TOOL}{action:"done", summary}\` (which retires ephemeral members and returns \`@${ORCHESTRATOR_NAME}\` to Persistent Standby Mode).`,
        ]
      : [
          `  4. **Land & Complete**: Default \`inherit\` edits are already live on \`baseBranch\` (no \`merge\` needed); if any opt-in \`share\`/\`branch\` worktrees were used, merge them via \`${SWARM_TOOL}{action:"merge"}\` and run a **post-merge integration check on \`baseBranch\`** BEFORE calling \`done\`. Kill finished members via \`${SWARM_TOOL}{action:"kill"}\`, and close the run cleanly via \`${SWARM_TOOL}{action:"done", summary}\` (which retires ephemeral members and returns \`@${ORCHESTRATOR_NAME}\` to Persistent Standby Mode).`,
        ]),
    "- **Droid Mid-Mission Scope Propagation & User Redirection**: Calling `swarm_wait` ends your turn cleanly so the user can message you at any time while workers run. When the user sends a mid-mission requirement change, scope expansion, or new direction:",
    `  - **1. Sync Shared Mission Truth FIRST (Droid Shared-Truth Rule)**: Never implement changes yourself and never bolt untracked scope onto workers. Propagate scope changes through the live contract FIRST via \`${SWARM_TOOL}{action:"title", objective, strategy, acceptance_criteria}\` (when goal/strategy shifts) and \`${SWARM_TOOL}{action:"mission"}\`: \`upsert_assertions\`/\`remove_assertion\` for \`VAL-*\` assertions, \`upsert_features\`/\`update_feature\` for 100% \`fulfills\` coverage and disjoint \`filesOwned\` (**never** add new features into an already \`[sealed]\` milestone — append a follow-up milestone instead), \`set_manifest\` for \`commands\`/\`services\`/\`boundaries\`, and \`write_library\` (\`library_append:true\`) to record updated \`architecture\`/\`environment\`/\`testing\` decisions.`,
    `  - **2. Propagate to Active & Parked Members**: Use \`${SWARM_TOOL}{action:"steer", name, message, mode?}\` to redirect working or parked members immediately (or \`${POST_MESSAGE_TOOL}\` with \`@all\` / \`@name\` for parked members), \`${SWARM_TOOL}{action:"stop"/"kill"}\` to halt obsolete work, and \`${SWARM_TOOL}{action:"mission", mission_op:"dispatch_ready"}\` or \`${SWARM_TOOL}{action:"add"}\` for new slices (waking \`@validator\` if already-audited code changed), then call \`${SWARM_WAIT_TOOL}\` again.`,
    "",
    "## 3. Mandatory 4-Part Brief Contract, Zero-Copy `#seq` & `@mention` Discipline",
    `- **4-Part Brief Contract**: Every \`${SWARM_TOOL}{action:"add"}\` brief you write MUST explicitly state all four parts:`,
    "  - **(a) Exclusive File/Directory Ownership & Off-Limits Files**: Exact `filesOwned` paths this member owns and files it MUST NOT edit (prevents two-worker collisions in shared `inherit` mode and `REBASE_CONFLICT` in opt-in `share` mode).",
    `  - **(b) Interface Contracts & \`#seq\` Board References**: Shared types/invariants plus prior \`#seq\` numbers to read via \`${READ_BOARD_TOOL}{seqs:[...]}\` — NEVER copy-paste one worker's report into another worker's brief!`,
    "  - **(c) Concrete Verification Commands**: Exact runnable `typecheck`, test, and build commands the member must pass in its workspace before reporting `[done]`.",
    `  - **(d) Direct Next-Peer \`@mention\` Doorbell**: Exact handle to wake on completion (e.g., ${nextPeerExample}).`,
    `- **Zero-Copy \`#seq\` & \`@mention\` Discipline**: \`@name\` is a wakeup doorbell, never a CC. Use \`@<prefix>\` for sharded groups, \`@#<channel>\` for channel broadcasts (NEVER \`@#main\`), and \`@all\` only for genuine swarm-wide rules or plan changes.${validatorEnabled ? " Avoid writing `@validator` (or another peer's `@handle`) in prose when addressing a worker unless you intend to wake that peer right now — refer to them without `@` (e.g. \"the validator\") for future handoffs." : " Avoid writing another peer's `@handle` in prose when addressing a worker unless you intend to wake that peer right now."}`,
    "- **Safety-Filter-Safe Naming & Verification Phrasing**: NEVER name members, channels, or temp paths with offensive/red-team trigger words (`attack`, `exploit`, `hack`, `malware`, `backdoor`, etc.) — `attack-*`/`exploit-*`/`hack-*` handles are rejected by protocol — and avoid phrasing QA briefs as \"attacks / exploits / bypassing security\". Upstream provider safety classifiers can misflag benign verification turns as cybersecurity risk. Always use neutral QA handles (`validator`, `auditor`, `probe-1`, `mutcheck-1`, `negtest-1`) and standard engineering phrasing (*negative-case testing*, *boundary verification*, *mutation testing*, *invalid-input rejection checks*).",
    "",
    "## 4. Core Swarm Tools (4 Tools)",
    `- \`${SWARM_TOOL}\`: \`title\`, \`add\`, \`status\`, \`models\`, \`model\` (auto-resumes switched member), \`steer\`, \`stop\`, \`kill\`, \`merge\`, \`channel\`, \`mission\` (\`status\`, \`upsert_assertions\`, \`remove_assertion\`, \`verify_assertion\`, \`override_assertion\`, \`upsert_features\`, \`update_feature\`, \`dispatch_ready\`, \`resolve_handoff\`, \`set_manifest\`, \`read_library\`, \`write_library\`), \`done\`.`,
    `- \`${POST_MESSAGE_TOOL}\` / \`${READ_BOARD_TOOL}\`: Post to the shared board, read messages (\`#seq\`/\`since\`/\`channel\`/\`search\`), or inspect roster (\`status:true\`).`,
    `- \`${SWARM_WAIT_TOOL}\`: End your turn cleanly (non-blocking) and sleep until woken by a member, \`all_idle\`, or user input. Always pass the highest read \`#seq\` as \`since\`.`,
    "",
    "## 5. Keep Warm, Context Forking & 3-Role Models",
    `- **Keep Warm**: Completed members park in \`waiting\` (zero tokens, full history intact, disk-backed sessions). NEVER \`kill\` as a pause!`,
    `- **Hot Model Switch**: Calling \`${SWARM_TOOL}{action:"model", name, model}\` on a \`waiting\` member hot-switches while keeping conversation history AND automatically resumes it to continue unfinished work.`,
    `- **Context Forking**: Pass \`fork:"orchestrator"\` or \`fork:"<member>"\` on \`${SWARM_TOOL}{action:"add"}\` when a new member benefits from branching existing conversation history.`,
    "- **3-Role Models**: `orchestrator` (host session), `worker` (default for `role:\"worker\"`), `validator` (default for `role:\"validator\"`).",
    "",
    "## 6. Dynamic Mission Goal Engine & Contract Evolution",
    `- **Deterministic Queue Dispatch & Living Contract**: Dispatch DAG-ready pending features with disjoint \`filesOwned\` onto **\`workspace:"inherit"\` by default** via \`${SWARM_TOOL}{action:"mission", mission_op:"dispatch_ready", max_dispatch?, workspace?}\` (pass \`workspace:"share"\` ONLY when isolated worktrees are explicitly required; auto-runs any configured \`init\` command in isolated worktrees), or spawn specialized workers via \`${SWARM_TOOL}{action:"add"}\`. Evolve the contract and queue dynamically via \`upsert_assertions\` (including \`VAL-CROSS-*\` cross-feature integration assertions when a mission spans multiple modules/milestones), \`upsert_features\` (\`prepend:true\` for urgent fixes), \`remove_assertion\`, \`set_manifest\` (\`commands\`, \`services\` with unique ports & healthchecks, \`boundaries\`), and \`read_library\`/\`write_library\` (recording reusable \`architecture\`, \`environment\`, and \`testing\` knowledge — including \`## Known Pre-Existing Issues\` in \`library/testing.md\` for unrelated pre-existing repo failures so workers/validators don't scope-creep). Modified \`"passed"\` assertions automatically reset to \`"pending"\` for re-verification.`,
    `- **Dual-Layer Milestone Validation & Sealed Milestones**: Completing/merging the final feature of a milestone automatically wakes or spawns \`@validator\` to run Dual-Layer Validation (\`scrutiny\` commands/diffs + \`behavioral\` surface checks, using incremental re-validation after fixes). Once all features and \`VAL-*\` assertions of a milestone pass, it becomes \`[sealed]\`. Place any new or follow-up work into a new milestone (e.g. \`<milestone>-followup\` or \`misc-fixes\`) so zero code bypasses validation.`,
    `- **Zero Open Handoff Tech Debt**: Resolve every worker \`discovered_issue\` and \`incomplete_work\` item via \`upsert_features\` + \`${SWARM_TOOL}{action:"mission", mission_op:"resolve_handoff", handoff_id, resolution:"tracked", tracked_feature_id}\` (or \`resolution:"dismissed"\` ONLY with concrete technical proof >= 20 chars — lazy excuses like \`"low priority"\` or \`"fix later"\` are rejected).`,
    `- **End-of-Mission Hard Gates & \`[NEEDS_HUMAN]\` Escalation**: \`${SWARM_TOOL}{action:"done"}\` enforces 0 working members, 0 unmerged commits ahead of \`baseBranch\`, 0 incomplete features, 0 open handoff tech-debt items, and 100% \`VAL-*\` assertions \`"passed"\` and claimed by \`"completed"\` features. LLM \`force:true\` on \`done\` is rejected with \`PERMISSION_DENIED\` (only human \`/swarm done --force\` may force-close); for rare justified assertion exceptions, use audited \`${SWARM_TOOL}{action:"mission", mission_op:"override_assertion", assertion_id, justification}\` (>= 30 chars, stamped \`[OVERRIDE]\`). Only when genuinely blocked on external credentials or a human product judgment that cannot be resolved from the repo, explain the blocker clearly and include \`[NEEDS_HUMAN]\` to pause auto-continuation.`,
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
    `- **Droid Shared-Truth Rule**: Before resuming or steering workers on changed requirements, sync shared Mission truth FIRST via \`${SWARM_TOOL}{action:"mission"}\` (\`upsert_assertions\` / \`remove_assertion\` for \`assertions\`, \`upsert_features\` / \`update_feature\` for \`features\` — never adding new features into a \`[sealed]\` milestone, \`set_manifest\` for \`commands\` / \`services\` / \`boundaries\`, \`write_library\` with \`library_append:true\` for shared \`library/\` context) and \`${SWARM_TOOL}{action:"title"}\` if the objective or strategy changed!`,
    `- **Member Propagation**: Never self-implement edits. Adjust active/parked workers immediately using \`${SWARM_TOOL}{action:"steer"}\`, \`${SWARM_TOOL}{action:"stop"/"kill"}\`, \`${SWARM_TOOL}{action:"mission", mission_op:"dispatch_ready"}\`, \`${SWARM_TOOL}{action:"add"}\`, or \`${POST_MESSAGE_TOOL}\`, wake \`@validator\` if already-audited slices changed, and report clearly.`,
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

  const failedFeatures = (run.features ?? []).filter((f) => f.status === "failed");
  if (failedFeatures.length > 0) {
    items.push(
      `- **Failed Features (${failedFeatures.length})**: ${failedFeatures.map((f) => `\`${f.id}\``).join(", ")} — inspect failure reports and assign/wake a worker (or \`upsert_features\` with \`prepend:true\`) to resolve before calling \`done\`.`,
    );
  }

  const openDebt = (run.handoffItems ?? []).filter(
    (h) =>
      h.resolution === "open" &&
      (h.type === "discovered_issue" || h.type === "incomplete_work"),
  );
  if (openDebt.length > 0) {
    items.push(
      `- **Open Handoff Tech-Debt (${openDebt.length})**: ${openDebt.map((h) => `\`${h.id}\``).join(", ")} — create follow-up feature(s) via \`upsert_features\` and link with \`${SWARM_TOOL}{action:"mission", mission_op:"resolve_handoff", handoff_id, resolution:"tracked", tracked_feature_id}\` (or dismiss ONLY with concrete technical proof >= 20 chars).`,
    );
  }

  if (run.validatorEnabled && (run.features?.length ?? 0) > 0 && (run.assertions?.length ?? 0) > 0) {
    const assertionMap = new Map((run.assertions ?? []).map((a) => [a.id, a]));
    for (const ms of run.milestones ?? []) {
      if (ms.sealed) continue;
      const msFeatures = (run.features ?? []).filter(
        (f) => f.milestone === ms.label && f.status !== "cancelled",
      );
      if (msFeatures.length === 0 || !msFeatures.every((f) => f.status === "completed")) {
        continue;
      }
      const unpassedIds = [...new Set(msFeatures.flatMap((f) => f.fulfills))].filter(
        (id) => assertionMap.get(id)?.status !== "passed",
      );
      if (unpassedIds.length > 0) {
        items.push(
          `- **Milestone \`${ms.label}\` Awaiting Validation**: All features completed; wake or spawn \`role:"validator"\` to verify ${unpassedIds.map((id) => `\`${id}\``).join(", ")} via \`${SWARM_TOOL}{action:"mission", mission_op:"verify_assertion"}\` and seal \`${ms.label}\`.`,
        );
      }
    }
  }

  const activeWorkingCount = Math.max(
    workingSet.size,
    members.filter((m) => m.state === "working").length,
  );
  if (activeWorkingCount === 0) {
    const liveCount = members.filter((m) => m.state !== "killed").length;
    if (liveCount === 0) {
      items.push(
        `- **0 Members Working**: The Swarm is idle and waiting on your next decision — dispatch ready features via \`${SWARM_TOOL}{action:"mission", mission_op:"dispatch_ready"}\` (defaults to \`workspace:"inherit"\`), spawn workers via \`${SWARM_TOOL}{action:"add"}\`, or close with \`${SWARM_TOOL}{action:"done", summary}\` once verified.`,
      );
    } else {
      items.push(
        `- **0 Members Working**: All ${liveCount} live member(s) are parked (\`waiting\`/\`stopped\`) — the Swarm is waiting on your next decision (inspect recent \`#seq\` reports via \`${READ_BOARD_TOOL}\`, dispatch/wake/steer/add next-wave members, merge any opt-in \`share\`/\`branch\` worktrees, or verify \`${run.baseBranch}\` and call \`${SWARM_TOOL}{action:"done", summary}\`).`,
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
    `- **Mission Artifacts**: ${formatMissionArtifactPaths(run.id)}`,
    `- **Objective**: ${run.objective}`,
  ];
  if (run.strategy.trim()) {
    contractLines.push(`- **Strategy**: ${run.strategy.trim()}`);
  }
  if (run.acceptanceCriteria.trim()) {
    contractLines.push(`- **Acceptance Criteria**: ${run.acceptanceCriteria.trim()}`);
  }
  contractLines.push(...buildMissionManifestLines(run));
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

  const missionSummary = buildMissionGoalSummarySection(run, {
    includeManifest: false,
  });
  if (missionSummary) {
    sections.push(missionSummary);
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
    `- **Mission Artifacts**: ${formatMissionArtifactPaths(run.id)}`,
    `- **Objective**: ${run.objective}`,
  ];

  if (run.strategy.trim()) {
    stateHeader.push(`- **Strategy**: ${run.strategy.trim()}`);
  }
  if (run.acceptanceCriteria.trim()) {
    stateHeader.push(`- **Acceptance Criteria**: ${run.acceptanceCriteria.trim()}`);
  }
  stateHeader.push(...buildMissionManifestLines(run));
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

  const missionSummary = buildMissionGoalSummarySection(run, {
    includeManifest: false,
  });
  if (missionSummary) {
    sections.push(missionSummary);
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

/**
 * Builds the Droid-style Persistent Mission Orchestrator Standby prompt section
 * injected while `@orchestrator` remains on duty between Swarm runs (`"standby"` profile)
 * until the user explicitly exits via `/swarm exit`.
 */
export function buildOrchestratorStandbySection(
  snapshot?: SwarmSnapshot | null,
  options?: OrchestratorStandbyOptions,
): string {
  const priorRun =
    options?.priorRun !== undefined ? options.priorRun : (snapshot?.run ?? null);
  const roleModels = options?.roleModels ?? snapshot?.roleModels;
  const autoConfirmDefault = options?.autoConfirmDefault === true;

  const clarificationStep = autoConfirmDefault
    ? `  2. **Direct Fast-Path (\`autoConfirmDefault: true\`)**: Skip interactive Q&A — do NOT call \`${SWARM_QUESTION_TOOL}\` or \`${SWARM_QUESTIONNAIRE_TOOL}\`; proceed straight from read-only recon to \`${PROPOSE_SWARM_PLAN_TOOL}\` (which auto-confirms after validation and Adversarial Contract Review).`
    : `  2. **Lean Upfront Clarification (\`AskUser\` — \`${SWARM_QUESTIONNAIRE_TOOL}\` / \`${SWARM_QUESTION_TOOL}\`)**: Ask **0 questions** when the goal and constraints are already clear from the user prompt + repo recon; otherwise ask **at most 1–3 high-leverage trade-off questions** via \`${SWARM_QUESTIONNAIRE_TOOL}\` (or \`${SWARM_QUESTION_TOOL}\`) with the best option placed first and prefixed \`(Recommended)\`.`;

  const standbyCoreLines: string[] = [
    "# Pi Swarm Persistent Orchestrator — Standby Mode (Droid Mission)",
    "",
    "## 1. Ephemeral Specialists, Permanent `@orchestrator` Until `/swarm exit`",
    `- **Persistent Orchestrator Duty**: You are \`@${ORCHESTRATOR_NAME}\` remaining **permanently on duty** in \`"standby"\` mode across subsequent user tasks. Workers (\`role:"worker"\`) and Validators (\`role:"validator"\`) are **ephemeral** per-mission specialists that were retired and destroyed (along with isolated worktrees and validator scratch directories) when the prior run completed.`,
    "- **User-Only Exit Rule**: Remain in Persistent Orchestrator Mode until the user explicitly runs `/swarm exit` (or `/swarm leave`, Hub `Exit Swarm Orchestrator Mode`, or `/swarm cancel`). NEVER attempt to exit Orchestrator Mode yourself.",
    "- **Never Self-Implement (Hard Write & Mutating-Bash Guard)**: NEVER write, edit, or implement code yourself, and NEVER offer to \"make a quick edit directly\". `write`, `edit`, `powershell`, and mutating `bash` commands (file edits/redirections, `rm`/`mv`/`cp`/`mkdir`, `git add`/`commit`/`checkout`/`merge`, package installs, etc.) are **hard-blocked** by protocol guard. Even small 1-file code edits must be executed through a right-sized Swarm Mission (e.g. 1 `inherit` worker in the shared repo — zero worktrees needed!) unless the user runs `/swarm exit`.",
    ...(roleModels ? [formatRoleModelsLine(roleModels)] : []),
    `- **Standby Tools (${STANDBY_SWARM_TOOLS.length})**: ${STANDBY_SWARM_TOOLS.map((t) => `\`${t}\``).join(", ")}.`,
    "",
    "## 2. How to Handle Incoming User Messages in Standby Mode",
    `- **Read-Only Inquiries, Explanations & Status Checks -> Answer Directly**: When the user asks a read-only question about the codebase, architecture, test status, or prior mission results, answer **directly and concisely** using read-only tools (\`read\`, \`grep\`, \`find\`, \`ls\`, read-only \`bash\`, \`${SWARM_TOOL}{action:"status"}\`, \`${READ_BOARD_TOOL}\`) WITHOUT launching a new Swarm run.`,
    `- **Code Changes, Bug Fixes, Refactors & Engineering Tasks -> Route via Recon -> \`${SWARM_QUESTIONNAIRE_TOOL}\` -> \`${PROPOSE_SWARM_PLAN_TOOL}\`**: Launch a new Contract-First Swarm Mission directly from Standby Mode without asking the user to run \`/swarm\` again:`,
    `  1. **Read-Only Operational Recon FIRST**: Inspect target files, \`package.json\`/configs, and any prior mission \`${SWARM_LIBRARY_DIR}/\` notes (\`${SWARM_DIR}/${SWARM_RUNS_DIR}/<runId>/${SWARM_LIBRARY_DIR}/\`: \`architecture\`, \`environment\`, \`testing\`) using \`read\`, \`grep\`, \`find\`, \`ls\` to ground exact **already-installed** \`commands\` (\`test\`, \`typecheck\`, \`build\`, \`lint\`, optional \`"init"\`), \`services\` (explicit unique ports & healthchecks), and \`boundaries\` (never invent speculative \`npx -y\` downloads).`,
    clarificationStep,
    `  3. **Contract-First Mission Proposal (\`ProposeMission\` — \`${PROPOSE_SWARM_PLAN_TOOL}\`)**: Call \`${PROPOSE_SWARM_PLAN_TOOL}\` directly with \`title\`, \`objective\`, wave-by-wave \`strategy\` (disjoint file/directory ownership boundaries; \`workspace:"inherit"\` default, \`share\` opt-in only for overlapping concurrent edits), \`acceptance_criteria\` (exact runnable already-installed verification commands), \`commands\`, \`services\`, \`boundaries\`, **mandatory** \`VAL-<AREA>-<NNN>\` (and \`VAL-CROSS-*\` for multi-module/milestone integration) \`assertions\` (\`minItems: 1\`) + milestone-ordered \`features\` (\`minItems: 1\`, acyclic \`depends_on\`, disjoint \`files_owned\`, 100% 1-to-1 \`fulfills\` coverage), and right-sized wave-1 \`initial_members\` (1–2 \`inherit\` workers for localized edits; disjoint parallel \`inherit\` workers + on-demand \`validator\` for multi-module work). Do NOT dump the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\`.`,
    "",
    "## 3. Carry Forward Prior Mission `library/` Context",
    `- Reuse institutional knowledge recorded in prior \`${SWARM_DIR}/${SWARM_RUNS_DIR}/<runId>/${SWARM_LIBRARY_DIR}/\` (\`architecture.md\`, \`environment.md\`, \`testing.md\`) so follow-up missions inherit established architecture, service ports, boundaries, and verification commands instead of re-discovering them from scratch (seed relevant prior notes into the new run via \`${SWARM_TOOL}{action:"mission", mission_op:"write_library", library_append:true}\` or worker briefs once confirmed).`,
  ];

  const sections: string[] = [standbyCoreLines.join("\n")];

  if (priorRun) {
    const priorLines: string[] = [
      "## Prior Completed Mission Context",
      `- **Prior Run**: ${priorRun.title} (\`${priorRun.id}\`) on \`${priorRun.baseBranch}\``,
      `- **Prior Objective**: ${priorRun.objective}`,
      `- **Prior Shared Library**: \`${SWARM_DIR}/${SWARM_RUNS_DIR}/${priorRun.id}/${SWARM_LIBRARY_DIR}/\` (\`architecture.md\`, \`environment.md\`, \`testing.md\`)`,
    ];
    if (priorRun.completionSummary?.trim()) {
      priorLines.push(`- **Completion Summary**: ${priorRun.completionSummary.trim()}`);
    }
    if (priorRun.commands && priorRun.commands.length > 0) {
      priorLines.push(
        `- **Prior Operational Commands**: ${priorRun.commands.map((c) => `\`${c.name}\`: \`${c.command}\``).join(" | ")}`,
      );
    }
    if (priorRun.services && priorRun.services.length > 0) {
      const svcFormatted = priorRun.services
        .map((s) => {
          const portPart = s.port !== undefined ? ` (port ${s.port})` : "";
          const hcPart = s.healthcheck ? `, healthcheck: \`${s.healthcheck}\`` : "";
          return `\`${s.name}\`${portPart} [start: \`${s.start}\`${hcPart}]`;
        })
        .join(" | ");
      priorLines.push(`- **Prior Services & Ports**: ${svcFormatted}`);
    }
    if (priorRun.boundaries && priorRun.boundaries.length > 0) {
      priorLines.push(`- **Prior Boundaries**: ${priorRun.boundaries.join(" · ")}`);
    }
    sections.push(priorLines.join("\n"));
  }

  return sections.join("\n\n");
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

  if (isolatedPeers.length === 0) {
    return [
      "### Peer Workspaces to Audit (`inherit` Shared Repo)",
      `Your validator session runs at \`${validator.cwd}\` (\`${run.baseBranch}\`). All current peers use \`workspace:"inherit"\` (the default), so their edits are **already live directly in \`${validator.cwd}\`** — run \`git status --short\`, \`git diff\`, and verification commands directly in \`${validator.cwd}\`!`,
      `- If any opt-in \`share\`/\`branch\` worktree peer is spawned later, call \`${READ_BOARD_TOOL}{status:true}\` or \`${SWARM_TOOL}{action:"status"}\` to inspect its isolated \`cwd\` and \`branch\`.`,
    ].join("\n");
  }

  const lines: string[] = [
    "### Peer Workspaces & Opt-In Worktrees to Audit",
    `Your validator session runs at \`${validator.cwd}\` (\`${run.baseBranch}\`). Edits from default \`inherit\` workers are already live in \`${validator.cwd}\`, whereas unmerged opt-in \`share\`/\`branch\` worker edits exist ONLY inside each isolated author's \`cwd\` below:`,
  ];

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

export interface MemberPromptOptions {
  scratchDir?: string;
}

/**
 * Builds the concise, high-signal system prompt appendix injected into a
 * Worker or Validator Pi session.
 */
export function buildMemberSystemPrompt(
  run: SwarmRunState,
  member: SwarmMemberRecord,
  options?: MemberPromptOptions,
): string {
  const sections: string[] = [];
  const primaryChannel = member.channels[0] ?? DEFAULT_CHANNEL;
  const scratchDir =
    member.role === "validator" ? options?.scratchDir?.trim() : undefined;
  const workspaceDesc =
    member.workspace === "inherit"
      ? `\`inherit\` (shared checkout at \`${member.cwd}\` — ${member.role === "validator" ? "read-only on repository/worktree files" : "edit ONLY files assigned in your brief"})`
      : `\`${member.workspace}\` (isolated git worktree at \`${member.cwd}\` on branch \`${member.branch ?? "unknown"}\`, base \`${run.baseBranch}\`)`;

  const headerLines: string[] = [
    `# Pi Swarm ${member.role === "validator" ? "Independent Validator" : "Worker"} — @${member.name}`,
    `- **Handle**: \`@${member.name}\` (role: \`${member.role}\`${member.groupPrefix ? `, group: \`@${member.groupPrefix}\`` : ""})`,
    `- **Parent**: \`@${member.parentName}\``,
    `- **Run**: ${run.title} (\`${run.id}\`) | Base Branch: \`${run.baseBranch}\``,
    `- **Mission Artifacts**: ${formatMissionArtifactPaths(run.id)}`,
    `- **Run Objective**: ${run.objective}`,
    `- **Workspace**: ${workspaceDesc}`,
    ...(scratchDir
      ? [
          `- **Isolated Scratch Directory**: \`${scratchDir}\` (temporary build/fixture/mutation sandbox; auto-cleaned when retired)`,
        ]
      : []),
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
  headerLines.push(...buildMissionManifestLines(run));
  sections.push(headerLines.join("\n"));

  const memberMissionSummary = buildMissionGoalSummarySection(run, {
    highlightMember: member.name,
    includeManifest: false,
  });
  if (memberMissionSummary) {
    sections.push(memberMissionSummary);
  }

  // Shared board & warm session protocol (shared across workers and validators)
  sections.push(
    [
      "## Shared Message Board & Warm Session Rules",
      `1. **Tools**: Use \`${POST_MESSAGE_TOOL}\` to communicate, \`${READ_BOARD_TOOL}\` (\`since?\`, \`seqs?\`, \`limit?\`, \`channel?\`, \`status?\`) to inspect prior posts or roster, \`${SWARM_TOOL}{action:"mission", mission_op:"status"}\` to inspect live milestones/features/\`VAL-*\` assertions/services, \`${SWARM_TOOL}{action:"mission", mission_op:"read_library", library_topic?}\` & \`mission_op:"write_library"\` (\`library_append:true\`) to read/share persistent notes in \`${SWARM_DIR}/${SWARM_RUNS_DIR}/${run.id}/${SWARM_LIBRARY_DIR}/\`, and \`${SWARM_WAIT_TOOL}\` (\`since\`, \`mentions_only?\`) to park cleanly in warm \`waiting\` state when idle.`,
      "2. **Zero-Copy `#seq` Refs**: Reference earlier board posts by sequence number (e.g. `#4`, `#6`) and fetch them with `read_board{seqs:[4,6]}` — never copy-paste large reports.",
      `3. **\`@mention\` Discipline**: \`@name\` is a wakeup doorbell, never a CC. Tag ONLY the peer(s) who must act next (follow your brief's next-peer doorbell, e.g. \`@validator\`, without waking \`@${ORCHESTRATOR_NAME}\` on intermediate handoffs). Tag \`@${member.parentName}\` when your deliverable has no downstream peer or you hit a blocker only they can resolve.`,
      `4. **Completion Convention**: Start your final deliverable post with \`[done]\` right after the \`@mention\` (e.g. \`@<next-peer-or-${member.parentName}> [done] <concise summary of results, files/commits, and verification>\`).`,
      `5. **Stay Warm via \`${SWARM_WAIT_TOOL}\`**: After posting your result (or while awaiting a peer reply), call \`${SWARM_WAIT_TOOL}{since: <highest-seq-you-read>}\` to park in warm \`waiting\` state (zero tokens, full conversation memory intact). Never poll \`${READ_BOARD_TOOL}\` in a loop!`,
      "6. **Keep Posts Short**: No greetings or empty acknowledgements — post concrete findings, questions, or results.",
    ].join("\n"),
  );

  if (member.role === "validator") {
    const scratchRule = scratchDir
      ? `1. **STRICTLY READ-ONLY on Repository & Worktrees (Isolated Scratch Allowed)**: You are an independent auditor. NEVER create, edit, or delete files inside \`${member.cwd}\` or any peer worktree, stage changes, or make git commits. For isolated builds (\`--target-dir "${scratchDir}/target"\`), synthetic fixtures, or mutation/negative-case probes, use ONLY your dedicated scratch directory \`${scratchDir}\` (\`write\`/\`edit\` tools and explicit literal paths under \`${scratchDir}\` for \`mkdir\`, \`cp\`, \`mv\`, \`rm\`, \`sed -i\`, and \`>\` output redirections — or \`cd "${scratchDir}" && ...\` — are permitted; shell variables/globs/symlinks outside \`${scratchDir}\` are blocked).`
      : "1. **STRICTLY READ-ONLY — NEVER Edit Files**: You are an independent auditor. NEVER create, edit, or delete files, stage changes, or make git commits. `write`, `edit`, `powershell`, and mutating `bash` commands are blocked by protocol.";
    sections.push(
      [
        "## Independent Read-Only Validator Rules (Dual-Layer Scrutiny + Behavioral Validation)",
        scratchRule,
        `2. **Layer 1 — Code & Test Suite Scrutiny (\`scrutiny\`)**: Treat worker reports as untrusted claims. Read \`${SWARM_DIR}/${SWARM_RUNS_DIR}/${run.id}/${SWARM_LIBRARY_DIR}/\` via \`${SWARM_TOOL}{action:"mission", mission_op:"read_library"}\`, run the configured operational \`commands\` (\`test\`/\`typecheck\`/\`lint\`/\`build\`), and inspect diffs/edits directly (in \`${member.cwd}\` for default \`inherit\` workers and post-merge \`[milestone-review]\`, or inside each author's isolated worktree \`cwd\` via \`git -C "<cwd>" status --short\`, \`git -C "<cwd>" diff ${run.baseBranch}...HEAD\`, \`git -C "<cwd>" show\`, and \`cd "<cwd>" && <slice test command>\` for unmerged opt-in \`share\`/\`branch\` workers).`,
        `3. **Layer 2 — Behavioral / Surface Validation (\`behavioral\` + Incremental Re-Test)**: Exercise real user/API/CLI behavior and configured \`services\` (ports & healthchecks) against every \`VAL-*\` (and cross-feature \`VAL-CROSS-*\`) assertion in scope. On re-runs after bug fixes (when some milestone assertions are already \`"passed"\` while others are \`"failed"\`/\`"pending"\`), perform **Incremental Re-Validation**: focus behavioral testing on the unpassed (\`pending\`/\`failed\`) \`VAL-*\` assertions plus a fast regression check that previously passed assertions still hold.`,
        `4. **Stamp \`VAL-*\` Assertions & Record Testing Notes**: For every \`VAL-*\` assertion in scope (check \`${SWARM_TOOL}{action:"mission", mission_op:"status"}\`), record your verdict via \`${SWARM_TOOL}{action:"mission", mission_op:"verify_assertion", assertion_id, assertion_status, evidence}\` (\`assertion_status:"passed"\` or \`"failed"\` with concrete command/code evidence, or \`"blocked"\`). Passing all assertions of a completed milestone automatically seals that milestone. Persist reusable observations — including unrelated pre-existing repo failures under \`## Known Pre-Existing Issues\` in \`library/testing.md\` so nobody scope-creeps — via \`${SWARM_TOOL}{action:"mission", mission_op:"write_library", library_topic:"testing", library_content:"...", library_append:true}\`.`,
        "5. **Peer-to-Peer Fix Loop**: If you find bugs, regressions, edge-case failures, or missing requirements, stamp affected `VAL-*` assertions `\"failed\"` with actionable evidence and post concrete findings (file path, line number, reproduction/command output, and concrete fix) directly to `@<author>` on the board — do NOT bother `@orchestrator` on intermediate bug bounces — then call `swarm_wait` to await their fix and re-audit!",
        `6. **Sign-Off, Neutral QA Naming & Read-Only Helpers**: Post \`@${member.parentName} [done] <evidence-backed audit report>\` ONLY when every check and \`VAL-*\` assertion in scope passes with zero blocking defects (or escalate clearly to \`@${member.parentName}\` if blocked). Use neutral engineering names (\`probe\`, \`fixture\`, \`mutcheck\`, \`negtest\` — avoid \`attack\`/\`exploit\`/\`hack\`) in helper handles, scratch filenames, and reports to prevent upstream safety-filter false positives. You may spawn read-only \`role:"validator"\` sub-auditors via \`${SWARM_TOOL}{action:"add"}\` if your audit splits cleanly across independent areas (tell them to report to \`@${member.name}\`, and \`${SWARM_TOOL}{action:"kill"}\` them once integrated).`,
      ].join("\n"),
    );
    sections.push(buildValidatorPeerWorktreesSection(run, member));
  } else {
    const workspaceCommitRule =
      member.workspace === "inherit"
        ? `2. **Shared Checkout & Disjoint \`filesOwned\` Discipline (\`inherit\`)**: You are working in the shared repository at \`${member.cwd}\`. Edit **ONLY** your assigned \`filesOwned\` slice from your brief/feature and strictly obey Mission Boundaries so you never collide with sibling \`inherit\` workers. **NEVER** run \`git reset --hard\`, \`git checkout -- .\`, \`git clean\`, or \`git stash\` (which would wipe or disrupt sibling \`inherit\` workers!). Run your slice verification commands and report \`[done]\` via \`${POST_MESSAGE_TOOL}\` with \`verification_evidence\` (no worktree branch commit or \`git merge\` needed).`
        : `2. **Isolated Worktree Commits & Boundaries**: You are working in an isolated worktree at \`${member.cwd}\` on branch \`${member.branch ?? "swarm"}\`. Strictly obey Mission Boundaries and your brief's exclusive file ownership (never edit off-limits files), and commit all intended changes cleanly on your branch with a clean \`git status\` before posting \`[done]\` (include \`commit=<sha>\` and \`workspace=${member.cwd}\` in your \`[done]\` report). NEVER run \`git merge\`, \`git push\`, \`git worktree\`, or switch to \`${run.baseBranch}\` — only \`@${ORCHESTRATOR_NAME}\` merges worktrees.`;

    sections.push(
      [
        "## Worker Execution, Startup Discipline (`mission-worker-base`) & Helper Rules",
        `1. **Protected Paths**: NEVER touch \`${SWARM_DIR}/\`, \`.swarm/\`, or \`.git/\` directly — use Swarm tools instead.`,
        workspaceCommitRule,
        `3. **Startup Discipline — Read \`library/\` & Verify Baseline First**: Before editing code, inspect shared Mission knowledge (\`${SWARM_DIR}/${SWARM_RUNS_DIR}/${run.id}/${SWARM_LIBRARY_DIR}/\`: \`architecture\`, \`environment\`, \`testing\`) via \`${SWARM_TOOL}{action:"mission", mission_op:"read_library"}\`, check configured \`services\` ports/healthchecks (strictly honor reserved service ports — never bind conflicting ports), and run a fast baseline check using configured operational \`commands\` (never guess \`npx -y <random-pkg>\` when operational commands are configured!) inside \`${member.cwd}\`. Write back non-obvious architecture/environment/testing discoveries — and record any unrelated pre-existing repo failures under \`## Known Pre-Existing Issues\` in \`library/testing.md\` instead of scope-creeping outside your \`filesOwned\` — via \`${SWARM_TOOL}{action:"mission", mission_op:"write_library", library_topic, library_content, library_append:true}\`. Batch independent read, inspection, or verification shell commands into a single compound \`bash\` call (e.g. \`git status --short && npm run typecheck && npm test\`) instead of running 4–5 serial single-command \`bash\` turns.`,
        `4. **Mandatory Structured Feature Handoffs on \`[done]\`**: When reporting \`[done]\` on a Mission feature via \`${POST_MESSAGE_TOOL}\`, you MUST provide \`verification_evidence\` (>= 10 chars with exact commands & exit/pass counts run — rejected with \`INVALID_INPUT\` if omitted, unless \`left_undone\` is non-empty explaining why work stopped incomplete), \`feature_id\` (required when multiple features are assigned to you), plus any \`discovered_issues\` (out-of-scope bugs/debt spotted) and \`left_undone\` (incomplete items). You may also claim or update your assigned feature status via \`${SWARM_TOOL}{action:"mission", mission_op:"update_feature", feature_id, feature_status}\`.`,
        `5. **Spawning & Managing Own Helpers**: You may call \`${SWARM_TOOL}{action:"add", name, brief, ...}\` when your assignment splits into independent pieces or needs an investigator/helper. Tell helpers to report back to \`@${member.name}\` by name. You may call \`${SWARM_TOOL}{action:"model"}\` on yourself (safely deferred to turn end with automatic resume on the new model) or your own waiting helpers, \`${SWARM_TOOL}{action:"steer"/"stop"}\` on your own helpers, and MUST call \`${SWARM_TOOL}{action:"kill"}\` on your own helpers once you integrate their work. You cannot kill other members, verify or override \`VAL-*\` assertions, or call \`title\`/\`merge\`/\`done\`.`,
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
  options?: MemberPromptOptions,
): string {
  const formatted = messages.map((m) => formatBoardEntryFull(m, 2500)).join("\n\n");
  const lines: string[] = [
    `New shared board message(s) for \`@${member.name}\` (board head: \`#${head}\`):`,
    "",
    formatted,
    "",
  ];
  if (member.role === "validator") {
    const scratchHint = options?.scratchDir?.trim()
      ? ` (use isolated scratch \`${options.scratchDir.trim()}\` if you need temporary build/fixture/mutation files)`
      : "";
    lines.push(
      `Validator audit reminder: edits from default \`inherit\` workers are already live in \`${member.cwd}\` (run \`git status --short\`, \`git diff\`, and verification commands directly in \`${member.cwd}\`), while any unmerged opt-in \`share\`/\`branch\` worker commits live in that author's isolated worktree \`cwd\` (\`git -C "<cwd>" diff <baseBranch>...HEAD\` and \`cd "<cwd>" && <slice test command>\`)${scratchHint}. Call \`${READ_BOARD_TOOL}{status:true}\` if you need a peer's \`workspace\`/\`cwd\`/\`branch\`, and stamp verified \`VAL-*\` assertions via \`${SWARM_TOOL}{action:"mission", mission_op:"verify_assertion", assertion_id, assertion_status, evidence}\`.`,
      "",
    );
  }
  lines.push(
    `Respond/act on the board via \`${POST_MESSAGE_TOOL}\` as needed, then call \`${SWARM_WAIT_TOOL}{since: ${head}}\` when idle again.`,
  );
  return lines.join("\n");
}

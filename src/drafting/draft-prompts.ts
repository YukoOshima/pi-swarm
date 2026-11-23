import {
  DEFAULT_SWARM_SETTINGS,
  MEMBER_NAME_PATTERN,
  POST_MESSAGE_TOOL,
  PROPOSE_SWARM_PLAN_TOOL,
  READ_BOARD_TOOL,
  RESERVED_MEMBER_NAMES,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_QUESTION_TOOL,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../constants.js";
import type {
  ActiveSwarmDraft,
  InitialMemberProposal,
  ProposedSwarmPlan,
  SwarmDraftMode,
  SwarmRoleModelConfig,
  SwarmRoleModels,
  SwarmSettings,
} from "../types.js";

// ============================================================================
// XML & Formatting Helpers
// ============================================================================

/**
 * Escapes untrusted / user-supplied strings for safe XML tag framing in prompts.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function collapseInlineWhitespace(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function escapeTableCell(value: string): string {
  return collapseInlineWhitespace(value).replace(/\|/g, "\\|");
}

function formatRoleModelSlot(config?: SwarmRoleModelConfig): string {
  const model = config?.model?.trim();
  const thinking = config?.thinkingLevel;
  if (model && thinking) {
    return `${model} (${thinking})`;
  }
  if (model) {
    return model;
  }
  if (thinking) {
    return `default (${thinking})`;
  }
  return "default";
}

function formatRoleModelsLine(roleModels?: SwarmRoleModels): string {
  const orchestrator = formatRoleModelSlot(roleModels?.orchestrator);
  const worker = formatRoleModelSlot(roleModels?.worker);
  const validator = formatRoleModelSlot(roleModels?.validator);
  const fallbackList = (roleModels?.fallbackModels ?? [])
    .map((m) => m.trim())
    .filter(Boolean);
  const fallbacks =
    fallbackList.length > 0
      ? ` | **Fallbacks:** ${fallbackList.join(", ")}`
      : "";
  return `**Models:** Orchestrator: ${orchestrator} | Worker: ${worker} | Validator: ${validator}${fallbacks}`;
}

function formatMemberBriefCell(member: InitialMemberProposal): string {
  const brief = escapeTableCell(member.brief || "") || "—";
  const channels = (member.channels ?? [])
    .map((c) => c.trim())
    .filter(Boolean);
  if (channels.length === 0) {
    return brief;
  }
  const channelTags = channels
    .map((c) => `#${escapeTableCell(c.replace(/^#/, ""))}`)
    .join(", ");
  return `${brief} _(channels: ${channelTags})_`;
}

function formatInitialMembersBreakdown(
  members: readonly InitialMemberProposal[],
): string {
  let workers = 0;
  let validators = 0;
  let isolated = 0;
  for (const m of members) {
    if (m.role === "validator") {
      validators += 1;
    } else {
      workers += 1;
    }
    if (m.workspace === "share" || m.workspace === "branch") {
      isolated += 1;
    }
  }
  const parts: string[] = [];
  if (workers > 0) {
    parts.push(`${workers} ${workers === 1 ? "worker" : "workers"}`);
  }
  if (validators > 0) {
    parts.push(`${validators} ${validators === 1 ? "validator" : "validators"}`);
  }
  if (isolated > 0) {
    parts.push(`${isolated} isolated ${isolated === 1 ? "worktree" : "worktrees"}`);
  }
  return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
}

// ============================================================================
// Drafting Prompts (pi-goal-x Upfront Clarification for Dynamic Antigravity Swarm)
// ============================================================================

export interface DraftingKickoffOptions {
  baseBranch?: string;
  maxConcurrency?: number;
  validatorEnabled?: boolean;
  roleModels?: SwarmRoleModels;
  targetRun?: {
    id: string;
    title?: string;
    objective: string;
    baseBranch: string;
    memberCount?: number;
  };
  existingEcho?: Record<string, string>;
}

/**
 * Builds the kickoff user message for interactive `pi-swarm` drafting (`/swarm [seed]`).
 * Guides the Orchestrator through fast targeted repo recon, lean high-leverage Q&A,
 * right-sized slice decomposition, and a Flexible Dynamic Swarm Plan.
 */
export function buildDraftingKickoffPrompt(
  seed: string,
  mode: SwarmDraftMode = "swarm",
  options: DraftingKickoffOptions = {},
): string {
  const trimmedSeed = seed.trim();
  const rawBaseBranch = options.baseBranch?.trim();
  const baseBranch =
    rawBaseBranch && rawBaseBranch !== "HEAD"
      ? rawBaseBranch
      : "(auto-detect current branch)";
  const maxConcurrency =
    options.maxConcurrency ?? DEFAULT_SWARM_SETTINGS.maxConcurrency;
  const validatorEnabled =
    options.validatorEnabled ?? DEFAULT_SWARM_SETTINGS.validatorEnabled;

  const lines: string[] = [
    `<swarm_drafting_kickoff mode="${escapeXml(mode)}">`,
    `<seed>${escapeXml(trimmedSeed || "(User did not supply an initial goal yet — ask what they want to build.)")}</seed>`,
    `<defaults base_branch="${escapeXml(baseBranch)}" max_concurrency="${maxConcurrency}" validator_enabled="${validatorEnabled ? "true" : "false"}" />`,
  ];

  if (options.roleModels) {
    lines.push(
      `<role_models orchestrator="${escapeXml(formatRoleModelSlot(options.roleModels.orchestrator))}" worker="${escapeXml(formatRoleModelSlot(options.roleModels.worker))}" validator="${escapeXml(formatRoleModelSlot(options.roleModels.validator))}" />`,
    );
  }

  if (options.targetRun) {
    const titleAttr = options.targetRun.title
      ? ` title="${escapeXml(options.targetRun.title)}"`
      : "";
    const memberAttr =
      options.targetRun.memberCount !== undefined
        ? ` members="${options.targetRun.memberCount}"`
        : "";
    lines.push(
      `<target_run id="${escapeXml(options.targetRun.id)}"${titleAttr} base_branch="${escapeXml(options.targetRun.baseBranch)}"${memberAttr}>${escapeXml(options.targetRun.objective)}</target_run>`,
    );
  }

  if (options.existingEcho && Object.keys(options.existingEcho).length > 0) {
    lines.push("<prior_clarifications>");
    for (const [key, answer] of Object.entries(options.existingEcho)) {
      lines.push(`  <answer id="${escapeXml(key)}">${escapeXml(answer)}</answer>`);
    }
    lines.push("</prior_clarifications>");
  }

  lines.push("<instructions>");
  lines.push(
    mode === "tweak"
      ? "You are in `pi-swarm` Drafting Mode (`tweak`) as the **Orchestrator** to clarify and refine the active Dynamic Antigravity Swarm plan."
      : "You are entering `pi-swarm` Planning / Drafting Mode as the **Orchestrator** to ground, clarify, and propose a **Flexible Dynamic Swarm Plan** before launching the swarm.",
  );
  lines.push("");
  lines.push("How the Dynamic Antigravity Swarm executes once approved:");
  lines.push(
    `- **Orchestrator (you):** Dynamically coordinates the run over the shared **Message Board** using the 4 core tools (\`${SWARM_TOOL}\`, \`${POST_MESSAGE_TOOL}\`, \`${READ_BOARD_TOOL}\`, \`${SWARM_WAIT_TOOL}\`) — spawning/naming workers and validators wave-by-wave on demand, organizing \`#channels\`, hot-switching models on waiting members, merging clean worktrees, killing finished helpers, and completing the run.`,
  );
  lines.push(
    "- **Workers:** Warm persistent sessions that collaborate on the shared `#seq` Message Board with `@mention` wakeups, optional context forking (`fork`), and flexible workspaces (`inherit` for read-only scouts/researchers, `share` or `branch` for isolated Git worktree edits). Workers can also spawn their own helpers when a slice splits naturally.",
  );
  lines.push(
    "- **Validators:** Independent read-only verifiers (`validator` role) spawned on demand to audit peer worktrees/diffs, run checks, and report issues directly via `@mention` on the board without mutating code.",
  );
  lines.push("");
  lines.push(
    "1. **No Mutations Yet:** DO NOT start editing, writing, or implementing code yet. Do not run mutating shell commands or create git branches/worktrees.",
  );
  lines.push(
    "2. **Fast Targeted Reconnaissance FIRST:** Run fast read-only repository recon (`read`, `grep`, `find`, `ls` on `package.json`, key entrypoints, and target modules/tests) FIRST so every question, ownership slice, and verification command is grounded in real code.",
  );
  lines.push(
    "3. **Lean Upfront Q&A (事前澄清 — `pi-goal-x` style):**",
  );
  lines.push(
    "   - Ask **0 questions** when the goal, scope, and constraints are already clear from the seed + repo recon — proceed straight to proposing the plan!",
  );
  lines.push(
    `   - Otherwise ask **at most 1–3 high-leverage trade-off questions** via \`${SWARM_QUESTIONNAIRE_TOOL}\` (or \`${SWARM_QUESTION_TOOL}\` for a single focused question). Place the best option **first** and prefix its label with \`(Recommended)\`.`,
  );
  lines.push(
    "   - **Never interrogate the user on obvious details** or facts you can inspect directly in the repository.",
  );
  lines.push(
    "4. **Right-Size the Swarm:**",
  );
  lines.push(
    "   - **1–2 workers** for small, localized, or single-module tasks (do not over-spawn).",
  );
  lines.push(
    "   - **Disjoint parallel `share` authors + independent `validator`** for multi-module work (e.g. 1 read-only `validator` auditing peer branches/worktrees per 2–4 parallel authors).",
  );
  lines.push(
    `5. **Flexible Dynamic Swarm Plan:** Once clear, call \`${PROPOSE_SWARM_PLAN_TOOL}\` with:`,
  );
  lines.push("   - `title`: short, clear human-readable title for this swarm.");
  lines.push("   - `objective`: crisp statement of what the swarm must accomplish.");
  lines.push(
    "   - `strategy`: **wave-by-wave execution with disjoint file/directory ownership boundaries** (assign non-overlapping files/directories per parallel `share`/`branch` worker so zero two-worker collisions occur on the same file, plus `@mention` -> `validator` review and merge gates on the shared Message Board). Keep wave transitions adaptive on the live board — do NOT invent a rigid pre-locked file-level DAG.",
  );
  lines.push(
    '   - `acceptance_criteria`: concrete, testable definition of "what done looks like" listing **exact runnable verification commands** (`typecheck`, targeted test commands, build checks) and behavioral invariants.',
  );
  lines.push(
    `   - \`initial_members\` (optional): right-sized initial wave — e.g. read-only scout (\`workspace: "inherit"\`) or disjoint parallel workers (\`workspace: "share"\` / \`"branch"\` with explicit file ownership & verification commands in each \`brief\`) plus an optional \`validator\`. Each name must match \`${MEMBER_NAME_PATTERN.source}\`, be unique, and avoid reserved names (${RESERVED_MEMBER_NAMES.join(", ")}). Leave omitted/empty to spawn wave 1 dynamically after launch.`,
  );
  lines.push(
    `6. Do NOT dump the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\` — its tool renderer already prints the full formatted proposal into scrollback before opening the confirmation modal.`,
  );
  lines.push("</instructions>");
  lines.push("</swarm_drafting_kickoff>");

  return lines.join("\n");
}

/**
 * Concise, prompt-cache-safe tail addendum injected while a `pi-swarm` draft is active.
 * Designed for tail context injection (never mutating the leading system prompt).
 */
export function buildDraftingSystemOverlay(draft: ActiveSwarmDraft): string {
  const autoConfirmAttr = draft.autoConfirm ? ' auto_confirm="true"' : "";
  const lines: string[] = [
    `<swarm_drafting_active mode="${escapeXml(draft.mode)}" base_branch="${escapeXml(draft.baseBranch ?? "auto")}" max_concurrency="${draft.maxConcurrency}" validator_enabled="${draft.validatorEnabled ? "true" : "false"}"${autoConfirmAttr}>`,
    `Active \`pi-swarm\` draft for a **Dynamic Antigravity Swarm** (Orchestrator dynamically spawns/steers warm Workers & read-only Validators on the shared \`#seq\` Message Board with \`@mention\` wakeups). Rules: (1) Run fast targeted read-only recon (\`ls\`, \`find\`, \`grep\`, \`read\` key entrypoints/\`package.json\`) FIRST — do NOT edit files or implement code yet; (2) Ask **0 questions** when clear, or **at most 1–3 high-leverage trade-off questions** via \`${SWARM_QUESTIONNAIRE_TOOL}\` (or \`${SWARM_QUESTION_TOOL}\`) with the best option placed first and prefixed \`(Recommended)\` — never interrogate on obvious details; (3) Right-size the swarm (1–2 workers for small/single-module tasks; disjoint parallel \`share\` authors + independent \`validator\` for multi-module work); (4) Finalize via \`${PROPOSE_SWARM_PLAN_TOOL}\` with \`title\`, \`objective\`, \`strategy\` specifying **wave-by-wave execution with disjoint file/directory ownership boundaries** (zero same-file collisions; not a rigid pre-locked file-level DAG), \`acceptance_criteria\` listing **exact runnable verification commands** (\`typecheck\`, test commands, build checks), and optional valid \`initial_members\`; (5) Do not repeat the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\`.`,
  ];

  if (draft.seed.trim()) {
    lines.push(`<seed>${escapeXml(draft.seed.trim())}</seed>`);
  }

  if (draft.questionnaireEcho && Object.keys(draft.questionnaireEcho).length > 0) {
    lines.push("<recorded_clarifications>");
    for (const [key, answer] of Object.entries(draft.questionnaireEcho)) {
      lines.push(`  <item id="${escapeXml(key)}">${escapeXml(answer)}</item>`);
    }
    lines.push("</recorded_clarifications>");
  }

  lines.push("</swarm_drafting_active>");
  return lines.join("\n");
}

/**
 * Fast-path prompt for `/swarm direct <goal>` that skips interactive Q&A and
 * instructs the Orchestrator to invoke `propose_swarm_plan` immediately (with `autoConfirm: true`).
 */
export function buildDirectPlanPrompt(
  goal: string,
  baseBranch: string,
  settings: Pick<SwarmSettings, "maxConcurrency" | "validatorEnabled">,
): string {
  const trimmedBranch = baseBranch?.trim();
  const hasNamedBranch = Boolean(trimmedBranch && trimmedBranch !== "HEAD");
  const displayBranch = hasNamedBranch
    ? trimmedBranch!
    : "(auto-detect current branch)";
  const baseBranchRule = hasNamedBranch
    ? `   - Use \`base_branch: "${escapeXml(trimmedBranch!)}"\`, \`max_concurrency: ${settings.maxConcurrency}\`, \`validator_enabled: ${settings.validatorEnabled ? "true" : "false"}\`.`
    : `   - Omit \`base_branch\` (auto-detect current branch), and use \`max_concurrency: ${settings.maxConcurrency}\`, \`validator_enabled: ${settings.validatorEnabled ? "true" : "false"}\`.`;
  const lines: string[] = [
    `<swarm_direct_plan base_branch="${escapeXml(displayBranch)}" max_concurrency="${settings.maxConcurrency}" validator_enabled="${settings.validatorEnabled ? "true" : "false"}" auto_confirm="true">`,
    `<goal>${escapeXml(goal.trim())}</goal>`,
    "<instructions>",
    "Fast-path `pi-swarm` launch (`/swarm direct`) as the **Orchestrator** (`autoConfirm: true`):",
    `1. Skip interactive Q&A — do NOT call \`${SWARM_QUESTION_TOOL}\` or \`${SWARM_QUESTIONNAIRE_TOOL}\`.`,
    "2. Run fast targeted read-only recon (`ls`, `find`, `grep`, `read` key entrypoints/`package.json`) FIRST so your slice boundaries and verification commands are grounded in real code — do NOT edit or implement code directly.",
    "3. Right-size the swarm (1–2 workers for small/single-module tasks; disjoint parallel `share` authors + independent `validator` for multi-module work).",
    `4. Immediately call \`${PROPOSE_SWARM_PLAN_TOOL}\` with a **Flexible Dynamic Swarm Plan** (not a rigid pre-locked file-level DAG):`,
    baseBranchRule,
    "   - `strategy`: **wave-by-wave execution with disjoint file/directory ownership boundaries** (zero two-worker collisions on the same file) plus board review/merge gates.",
    "   - `acceptance_criteria`: **exact runnable verification commands** (`typecheck`, test commands, build checks) plus behavioral invariants.",
    `   - Provide \`title\`, \`objective\`, and optional right-sized \`initial_members\` (unique lowercase names matching \`${MEMBER_NAME_PATTERN.source}\`, avoiding ${RESERVED_MEMBER_NAMES.join(", ")}, with explicit file ownership in each brief).`,
    `5. Because this draft runs with \`autoConfirm: true\`, calling \`${PROPOSE_SWARM_PLAN_TOOL}\` validates and launches the Dynamic Swarm immediately without a confirmation modal. Do NOT dump the full plan in prose beforehand.`,
    "</instructions>",
    "</swarm_direct_plan>",
  ];

  return lines.join("\n");
}

// ============================================================================
// Scrollable Transcript & Durable Tool-Result Summary Formatter
// ============================================================================

/**
 * Renders a Flexible Dynamic Swarm Plan proposal into clean, structured Markdown.
 * Used BOTH in `propose_swarm_plan.renderCall()` (scrollable transcript before the
 * confirmation modal opens) AND persisted in the tool result for confirm/continue/cancel.
 */
export function formatProposalTranscriptSummary(plan: ProposedSwarmPlan): string {
  const cleanTitle = collapseInlineWhitespace(plan.title ?? "");
  const cleanObjective = collapseInlineWhitespace(plan.objective ?? "");
  const cleanBaseBranch = collapseInlineWhitespace(plan.baseBranch ?? "") || "auto";
  const titleText = cleanTitle || "(pending)";
  const objectiveText = cleanObjective || "(pending)";
  const strategyText = plan.strategy?.trim() || "_(pending)_";
  const acceptanceText = plan.acceptanceCriteria?.trim() || "_(pending)_";
  const feedbackText = collapseInlineWhitespace(plan.feedback ?? "");

  const lines: string[] = [
    `## Swarm Plan Proposal${cleanTitle ? `: ${cleanTitle}` : ""}`,
    "",
    `**Title:** ${titleText}`,
    `**Objective:** ${objectiveText}`,
    `**Base Branch:** \`${cleanBaseBranch}\` | **Max Concurrency:** ${plan.maxConcurrency} | **Validator Policy:** ${plan.validatorEnabled ? "ON" : "OFF"}`,
    formatRoleModelsLine(plan.roleModels),
  ];

  if (feedbackText) {
    lines.push("", `> **Launch Note:** ${feedbackText}`);
  }

  lines.push(
    "",
    "### Dynamic Strategy (Waves & Disjoint Ownership)",
    "",
    strategyText,
    "",
    "### Acceptance Criteria & Verification",
    "",
    acceptanceText,
  );

  const initialMembers = plan.initialMembers ?? [];
  if (initialMembers.length > 0) {
    const breakdown = formatInitialMembersBreakdown(initialMembers);
    lines.push(
      "",
      `### Initial Members (${initialMembers.length})${breakdown}`,
      "",
      "| Name | Role | Workspace | Brief |",
      "| --- | --- | --- | --- |",
    );

    for (const member of initialMembers) {
      const name = escapeTableCell(member.name || "") || "(unnamed)";
      const role = escapeTableCell(member.role || "") || "worker";
      const workspace = escapeTableCell(member.workspace ?? "") || "inherit";
      const brief = formatMemberBriefCell(member);
      lines.push(`| **${name}** | \`${role}\` | \`${workspace}\` | ${brief} |`);
    }
  } else {
    lines.push(
      "",
      "_Initial Members: none pre-specified — Orchestrator will dynamically spawn right-sized waves on the shared board._",
    );
  }

  return lines.join("\n");
}

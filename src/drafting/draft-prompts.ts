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

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
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
  const fallbacks =
    roleModels?.fallbackModels && roleModels.fallbackModels.length > 0
      ? ` | **Fallbacks:** ${roleModels.fallbackModels.join(", ")}`
      : "";
  return `**Models:** Orchestrator: ${orchestrator} | Worker: ${worker} | Validator: ${validator}${fallbacks}`;
}

function formatMemberBriefCell(member: InitialMemberProposal): string {
  const brief = escapeTableCell(member.brief || "—");
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
 * Guides the Orchestrator through `pi-goal-x`-style upfront clarification ("事前澄清")
 * and a Flexible Dynamic Swarm Plan tailored for the Dynamic Antigravity Swarm architecture.
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
      : "You are entering `pi-swarm` Planning / Drafting Mode as the **Orchestrator** to clarify requirements and propose a **Flexible Dynamic Swarm Plan** before launching the swarm.",
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
    "- **Validators:** Independent read-only verifiers (`validator` role) spawned on demand to audit diffs, run checks, and report issues directly via `@mention` on the board without mutating code.",
  );
  lines.push("");
  lines.push(
    "1. DO NOT start editing, writing, or implementing code yet. Do not run mutating shell commands or create git branches/worktrees.",
  );
  lines.push(
    "2. Read-only repository reconnaissance (`read`, `grep`, `find`, `ls`) IS strongly encouraged so your clarifying questions, strategy, and acceptance criteria are sharp and grounded in the actual codebase.",
  );
  lines.push(
    "3. Upfront Clarification (事前澄清 — `pi-goal-x` style): Identify genuine ambiguities around requirements, architecture choices, constraints, edge cases, and acceptance criteria.",
  );
  lines.push(
    `   - Prefer \`${SWARM_QUESTIONNAIRE_TOOL}\` to ask 2–4 related questions in a single tabbed prompt with clear options and recommended defaults, or \`${SWARM_QUESTION_TOOL}\` for one focused question.`,
  );
  lines.push(
    "   - Skip trivial or already-unambiguous questions; if the goal and constraints are already crystal clear, proceed straight to proposing the plan.",
  );
  lines.push(
    `4. Flexible Dynamic Swarm Plan: Once clear, call \`${PROPOSE_SWARM_PLAN_TOOL}\` with:`,
  );
  lines.push("   - `title`: short, clear human-readable title for this swarm.");
  lines.push("   - `objective`: crisp statement of what the swarm must accomplish.");
  lines.push(
    "   - `strategy`: phased dynamic orchestration plan explaining how you will scout, partition work, iterate wave-by-wave, review with read-only validators, and adapt on the shared board as findings emerge. Do NOT invent a rigid pre-locked file-level DAG — keep the strategy flexible because you will dynamically spawn, steer, review, and adapt members live.",
  );
  lines.push(
    '   - `acceptance_criteria`: concrete, testable definition of "what done looks like" (commands, test suites, typechecks, and behavioral invariants).',
  );
  lines.push(
    `   - \`initial_members\` (optional): initial read-only researchers/scouts (\`workspace: "inherit"\`) or a first wave of workers (\`workspace: "share"\` / \`"branch"\`) and/or a validator. Each name must match \`${MEMBER_NAME_PATTERN.source}\`, be unique, and avoid reserved names (${RESERVED_MEMBER_NAMES.join(", ")}). Leave omitted/empty if you want to spawn the first wave dynamically after launch.`,
  );
  lines.push(
    `5. Do NOT dump the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\` — its tool renderer already prints the full formatted proposal into scrollback before opening the confirmation modal.`,
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
    `Active \`pi-swarm\` draft for a **Dynamic Antigravity Swarm** (Orchestrator dynamically spawns/steers warm Workers & read-only Validators on the shared \`#seq\` Message Board with \`@mention\` wakeups). Rules: (1) Read-only reconnaissance (\`read\`, \`grep\`, \`find\`, \`ls\`) only — do NOT edit files or implement code yet; (2) Use \`${SWARM_QUESTIONNAIRE_TOOL}\` or \`${SWARM_QUESTION_TOOL}\` only for genuine ambiguities (with recommended defaults); (3) Finalize via \`${PROPOSE_SWARM_PLAN_TOOL}\` with \`title\`, \`objective\`, a flexible phased \`strategy\` (no rigid pre-locked file-level DAG), concrete \`acceptance_criteria\`, and optional valid \`initial_members\`; (4) Do not repeat the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\`.`,
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
    "2. Do NOT edit or implement code directly; perform a quick read-only inspection (`ls`, `find`, `grep`, `read`) if needed to ground your dynamic strategy and acceptance criteria in the real repository layout.",
    `3. Immediately call \`${PROPOSE_SWARM_PLAN_TOOL}\` with a **Flexible Dynamic Swarm Plan** (not a rigid pre-locked file-level DAG):`,
    baseBranchRule,
    `   - Provide \`title\`, \`objective\`, phased dynamic \`strategy\`, concrete testable \`acceptance_criteria\`, and optional \`initial_members\` (unique lowercase names matching \`${MEMBER_NAME_PATTERN.source}\`, avoiding ${RESERVED_MEMBER_NAMES.join(", ")}).`,
    `4. Because this draft runs with \`autoConfirm: true\`, calling \`${PROPOSE_SWARM_PLAN_TOOL}\` validates and launches the Dynamic Swarm immediately without a confirmation modal. Do NOT dump the full plan in prose beforehand.`,
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
  const titleText = plan.title?.trim() || "(pending)";
  const objectiveText = plan.objective?.trim() || "(pending)";
  const strategyText = plan.strategy?.trim() || "_(pending)_";
  const acceptanceText = plan.acceptanceCriteria?.trim() || "_(pending)_";
  const baseBranchText = plan.baseBranch?.trim() || "auto";

  const lines: string[] = [
    `## Swarm Plan Proposal${plan.title?.trim() ? `: ${plan.title.trim()}` : ""}`,
    "",
    `**Title:** ${titleText}`,
    `**Objective:** ${objectiveText}`,
    `**Base Branch:** \`${baseBranchText}\` | **Max Concurrency:** ${plan.maxConcurrency} | **Validator Policy:** ${plan.validatorEnabled ? "ON" : "OFF"}`,
    formatRoleModelsLine(plan.roleModels),
    "",
    "### Dynamic Strategy",
    "",
    strategyText,
    "",
    "### Acceptance Criteria",
    "",
    acceptanceText,
  ];

  const initialMembers = plan.initialMembers ?? [];
  if (initialMembers.length > 0) {
    lines.push(
      "",
      `### Initial Members (${initialMembers.length})`,
      "",
      "| Name | Role | Workspace | Brief |",
      "| --- | --- | --- | --- |",
    );

    for (const member of initialMembers) {
      const name = escapeTableCell(member.name || "(unnamed)");
      const role = escapeTableCell(member.role || "worker");
      const workspace = escapeTableCell(member.workspace ?? "inherit");
      const brief = formatMemberBriefCell(member);
      lines.push(`| **${name}** | \`${role}\` | \`${workspace}\` | ${brief} |`);
    }
  } else {
    lines.push(
      "",
      "_Initial Members: none pre-specified — Orchestrator will dynamically spawn members wave-by-wave on the shared board._",
    );
  }

  return lines.join("\n");
}

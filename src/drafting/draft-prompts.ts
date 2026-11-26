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
  MissionFeature,
  ProposedSwarmPlan,
  SwarmDraftMode,
  SwarmMilestone,
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
  const metaParts: string[] = [];
  if (member.fork?.trim()) {
    metaParts.push(`fork: @${escapeTableCell(member.fork.trim())}`);
  }
  const channels = (member.channels ?? [])
    .map((c) => c.trim())
    .filter(Boolean);
  if (channels.length > 0) {
    const channelTags = channels
      .map((c) => `#${escapeTableCell(c.replace(/^#/, ""))}`)
      .join(", ");
    metaParts.push(`channels: ${channelTags}`);
  }
  if (metaParts.length === 0) {
    return brief;
  }
  return `${brief} _(${metaParts.join(" · ")})_`;
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
  skipContractReview?: boolean;
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

  const skipReviewAttr = options.skipContractReview
    ? ' skip_contract_review="true"'
    : "";

  const lines: string[] = [
    `<swarm_drafting_kickoff mode="${escapeXml(mode)}">`,
    `<seed>${escapeXml(trimmedSeed || "(User did not supply an initial goal yet — ask what they want to build.)")}</seed>`,
    `<defaults base_branch="${escapeXml(baseBranch)}" max_concurrency="${maxConcurrency}" validator_enabled="${validatorEnabled ? "true" : "false"}"${skipReviewAttr} />`,
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
      ? "You are in `pi-swarm` Drafting Mode (`tweak`) as the **Orchestrator** to clarify and refine the active Dynamic Antigravity Swarm plan (preserving unchanged `passed` `VAL-*` assertions, `completed` features, and `sealed` milestones while dynamically extending or adjusting remaining work)."
      : "You are entering `pi-swarm` Planning / Drafting Mode as the **Orchestrator** to ground, clarify, and propose a Contract-First **Flexible Dynamic Swarm Plan** before launching the swarm.",
  );
  lines.push("");
  lines.push("How the Dynamic Antigravity Swarm executes once approved:");
  lines.push(
    `   - **Orchestrator (you — permanent until \`/swarm exit\`):** Stays permanently on duty across subsequent user tasks in Persistent Orchestrator Mode (transitioning to \`"standby"\` between runs until explicit \`/swarm exit\`) and coordinates each active run over the shared **Message Board** using the 4 core tools (\`${SWARM_TOOL}\`, \`${POST_MESSAGE_TOOL}\`, \`${READ_BOARD_TOOL}\`, \`${SWARM_WAIT_TOOL}\`) — never editing files or running mutating shell commands directly, spawning/naming workers and validators wave-by-wave on demand, auto-dispatching ready parallel features onto \`workspace:"inherit"\` by default via \`swarm{action:"mission", mission_op:"dispatch_ready"}\` (using opt-in \`workspace:"share"\` only when concurrent workers must edit overlapping files), updating the live contract via \`swarm{action:"mission"}\`, organizing \`#channels\`, hot-switching models on waiting members, merging any opt-in worktrees, killing finished helpers, and completing the run.`,
  );
  lines.push(
    "- **Workers (ephemeral per-mission specialists):** Warm persistent sessions during the run that are retired/destroyed when finished, collaborating on the shared `#seq` Message Board with `@mention` wakeups, optional context forking (`fork`), and Antigravity-style **`workspace: \"inherit\"` by default** for BOTH single workers AND parallel workers owning disjoint `files_owned` slices in the shared repo (zero worktree creation, zero `merge --no-ff` commits, instant shared visibility for `@validator`; use opt-in `share` or `branch` Git worktrees ONLY when concurrent workers genuinely must edit overlapping files or run isolated/destructive branch experiments, with automatic `node_modules`/`.venv` symlink bootstrap + optional `init` command). Workers can also spawn their own helpers when a slice splits naturally.",
  );
  lines.push(
    "- **Validators (ephemeral independent continuous auditors):** Independent read-only verifiers (`validator` role) spawned on demand as soon as the first slice is ready (~1 read-only validator per 2–4 parallel authors, reusing warm validator(s) continuously for peer-to-peer `@worker <-> @validator` review & fix loops) and retired when the run finishes to audit shared `inherit` edits directly in the repo root (and any opt-in `share`/`branch` peer worktrees), verify `VAL-*` contract assertions with concrete evidence, and report issues directly via `@mention` on the board without mutating repo/worktree code (each `validator` automatically gets an isolated OS scratch directory for temporary builds, synthetic fixtures, and mutation/negative-case checks — never spawn `worker` pseudo-validators or use red-team names like `attack`/`exploit`/`hack`; use neutral QA handles like `validator`, `val-api`, `val-ui`, `auditor`, `probe-1`).",
  );
  lines.push("");
  lines.push(
    "1. **No Mutations Yet:** DO NOT start editing, writing, or implementing code yet. Do not run mutating shell commands or create git branches/worktrees.",
  );
  lines.push(
    `2. **Recon-in-Swarm FIRST (Parallel Read-Only Recon Workers vs. Quick Direct Reads — NEVER run heavy test suites or deep serial code reads yourself!):** \`${SWARM_TOOL}\` (\`add\`, \`${POST_MESSAGE_TOOL}\`, \`${READ_BOARD_TOOL}\`, \`${SWARM_WAIT_TOOL}\`) is **ALREADY active in read-only Recon mode** during Drafting! For **tiny 1-file tasks**, run 1–3 quick read-only calls (\`read\`, \`grep\`, \`find\`, \`ls\` on \`package.json\`, \`tsconfig*\`, build/lint/test configs, and 1–2 top-level entrypoints — plus any prior mission \`.pi/swarm/runs/<runId>/library/\` notes) and propose directly. For **medium, large, or unfamiliar repos**, **immediately spawn 2–4 parallel read-only recon workers** via \`swarm{action:"add", name:"research-...", brief:"..."}\` (e.g. \`research-arch\`, \`research-baseline\`, \`research-ui\`) to inspect architecture, run baseline \`test\`/\`lint\`/\`typecheck\`/\`build\` probes, and seed \`library/*.md\` (\`library/architecture.md\`, \`library/environment.md\`, \`library/testing.md\` including \`## Known Pre-Existing Issues\`), then call \`${SWARM_WAIT_TOOL}\` to collect their concise \`@orchestrator [done]\` summaries and call \`${PROPOSE_SWARM_PLAN_TOOL}\` (optionally setting \`fork\` on \`initial_members\` to inherit a warm recon worker's conversation context). Discover exact **already-installed** \`commands\` (\`test\`, \`typecheck\`, \`build\`, \`lint\`, plus optional idempotent \`init\` if opt-in isolated worktrees require setup beyond automatic \`node_modules\`/\`.venv\` symlinks), \`services\` (background/dev services with explicit unique ports in \`start\`/\`stop\`/\`healthcheck\` + \`port\` and acyclic \`depends_on\`), and \`boundaries\` (reserved ports, off-limits directories/services) — never invent speculative \`npx -y\` downloads. **DO NOT run \`npm/pnpm test\`, \`lint\`, \`typecheck\`, \`build\`, Playwright, or deep serial file reads yourself during Drafting** (delegate heavy baseline probes & deep code tracing to parallel read-only recon workers or post-launch workers!). If the user wants a different target branch than the current checkout (e.g. branching off \`origin/main\` while on another feature branch), do NOT stall debating git state — specify \`workspace: "share"\` or a wave-1 branch-prep step in \`strategy\` and move straight to \`${PROPOSE_SWARM_PLAN_TOOL}\`. Note any known unrelated pre-existing failures for \`library/testing.md\` (\`## Known Pre-Existing Issues\`).`,
  );
  lines.push(
    "3. **Requirement Echo, Lean Clarification & Immediate Proposal (事前澄清 — Anti-Paralysis):**",
  );
  lines.push(
    "   - Capture every explicit and implicit user requirement faithfully without silently dropping edge cases.",
  );
  lines.push(
    "   - Ask **0 questions** when the goal, scope, and constraints are already clear from the seed + repo recon — proceed straight to proposing the plan!",
  );
  lines.push(
    `   - Otherwise ask **at most 1–3 high-leverage trade-off questions** for genuine ambiguities via \`${SWARM_QUESTIONNAIRE_TOOL}\` (or \`${SWARM_QUESTION_TOOL}\` for a single focused question). Place the best option **first** and prefix its label with \`(Recommended)\`. Once answered, call \`${PROPOSE_SWARM_PLAN_TOOL}\` **immediately on your very next turn** (remember \`features\`, \`assertions\`, and \`commands\` stay dynamically extensible mid-mission via \`swarm{action:"mission"}\`).`,
  );
  lines.push(
    "   - **Never interrogate the user on obvious details** or facts you can inspect directly in the repository.",
  );
  lines.push(
    "4. **Mission-Level TDD (`assertions` -> `features` are MANDATORY) & Right-Sizing:**",
  );
  lines.push(
    "   - **Mandatory Contract First (`VAL-<AREA>-<NNN>` & `VAL-CROSS-*`):** `assertions` (`minItems: 1`) and `features` (`minItems: 1`) are **MANDATORY** in `propose_swarm_plan`! Define concrete, testable behavioral `assertions` (`id` like `VAL-AUTH-001`, `title`, `description`, `evidence_required`) FIRST, covering happy paths, critical edge cases, and cross-feature integration assertions (`VAL-CROSS-*`) whenever a mission spans multiple modules or milestones.",
  );
  lines.push(
    "   - **Ordered Milestones & Parallel Features (`workspace: \"inherit\"` Default):** Decompose vertical `milestones` and `features` (`id`, `title`, `description`, `milestone`, `depends_on`, `files_owned`, `preconditions`, `expected_behavior`, `verification_steps`, `fulfills`) where `depends_on` forms an acyclic DAG and `files_owned` assigns disjoint paths so independent features in the same milestone run concurrently on **`workspace: \"inherit\"` by default** in the shared repo (and are auto-dispatched onto `workspace: \"inherit\"` by default via `swarm{action:\"mission\", mission_op:\"dispatch_ready\"}`; use opt-in `workspace: \"share\"` worktrees ONLY when concurrent workers must edit overlapping files)! Every assertion in `assertions` MUST be claimed by a single feature's `fulfills[]` (**100% `fulfills` coverage**, 1-to-1 leaf rule, zero orphan assertions).",
  );
  lines.push(
    "   - **Right-Size the Swarm:** **1–2 workers** for small, localized, or single-module tasks (do not over-spawn); **Disjoint parallel `inherit` authors + independent `validator`** for multi-module work (prefer `workspace: \"inherit\"` on disjoint `files_owned` for zero worktree sprawl and instant `@validator` visibility, reserving opt-in `share` worktrees strictly for overlapping concurrent edits; spawn read-only `validator` teammate(s) on demand as soon as the first slice is ready — or continuously alongside parallel authors at ~1 read-only validator per 2–4 authors, reusing warm validator(s) for peer-to-peer `@worker <-> @validator` review & fix loops with domain names like `val-api`/`val-ui` allowed — rather than waking an idle validator before any code exists).",
  );
  lines.push(
    `5. **Flexible Dynamic Swarm Plan, Adversarial Contract Review & Living Dynamic Workflow:** Once clear, call \`${PROPOSE_SWARM_PLAN_TOOL}\` with:`,
  );
  lines.push("   - `title`: short, clear human-readable title for this swarm.");
  lines.push("   - `objective`: crisp statement echoing every user requirement the swarm must accomplish.");
  lines.push(
    "   - `strategy`: **wave-by-wave execution with disjoint file/directory ownership boundaries** (assign non-overlapping `files_owned` per parallel `inherit` worker — or opt-in `share`/`branch` worktrees only when concurrent workers must touch overlapping files — so zero two-worker collisions occur on the same file, plus continuous peer-to-peer `@worker <-> @validator` review gates on the shared Message Board). Keep wave transitions adaptive on the live board — this is NOT a rigid pre-locked file-level DAG: `features`, `assertions`, `milestones`, and workers are **dynamically extensible mid-mission** via `swarm{action:\"mission\"}` (including `swarm{action:\"mission\", mission_op:\"dispatch_ready\"}`) and `swarm{action:\"add\"}`!",
  );
  lines.push(
    '   - `acceptance_criteria`: concrete, testable definition of "what done looks like" listing **exact runnable verification commands** using **already-installed** repo scripts discovered during recon (`npm test`, `npm run typecheck`, `node --test`, build checks — explicitly avoid speculative `npx -y` network package downloads) and behavioral invariants.',
  );
  lines.push(
    '   - `commands`, `services` & `boundaries`: single-source-of-truth command manifest (`test`, `typecheck`, `build`, `lint`, plus optional `"init"` setup command if opt-in isolated worktrees need setup beyond `node_modules`/`.venv` auto-symlinks), optional `services` manifest (`name`, `start`, `stop`, `healthcheck`, unique `port`, acyclic `depends_on` with explicit ports in `start`/`stop`/`healthcheck`), and mission boundaries (port ranges, off-limits dirs/services).',
  );
  lines.push(
    "   - **MANDATORY** `assertions` & `features`: `VAL-<AREA>-<NNN>` (and `VAL-CROSS-*` for multi-module/milestone integration) validation contract assertions (`minItems: 1`) + milestone-ordered features (`minItems: 1`) claiming 100% of `assertions` via 1-to-1 `fulfills` (in `tweak` mode, never add new features into an already `sealed` milestone — append a new milestone instead). Note: `propose_swarm_plan` runs an automated **Adversarial Contract Review** checking for missing edge-case assertions, file-ownership collisions, and speculative commands — if it requests refinements, address every `[BLOCKING]` finding and call `propose_swarm_plan` again.",
  );
  lines.push(
    `   - \`initial_members\` (optional): populate with **wave-1 workers only** by default — using **\`workspace: "inherit"\` by default** for both single workers and disjoint parallel workers (use opt-in \`workspace: "share"\` / \`"branch"\` ONLY when concurrent workers must edit overlapping files or run isolated branch experiments), with optional \`feature_id\` linking each wave-1 worker to its feature in \`features[]\` (auto-matched when \`name === feature.id\`) and optional \`fork\` pointing to a warm recon worker handle (e.g. \`research-arch\`) to inherit its conversation context. Spawn an independent \`validator\` on demand as soon as the first slice is ready (~1 read-only validator per 2–4 authors, reusing warm validator(s) continuously for peer-to-peer \`@worker <-> @validator\` review & fix loops; domain names like \`val-api\`/\`val-ui\` allowed; only include a \`validator\` initially when reviewing already-existing code). Keep each \`brief\` concise with exclusive file ownership and **already-installed** repo verification scripts (no speculative \`npx -y\` downloads). Each name must match \`${MEMBER_NAME_PATTERN.source}\`, be unique (and not collide with any active recon worker handle), and avoid reserved names (${RESERVED_MEMBER_NAMES.join(", ")}). Leave omitted/empty to spawn wave 1 dynamically after launch (or via \`swarm{action:"mission", mission_op:"dispatch_ready"}\`).`,
  );
  lines.push(
    `6. Do NOT dump the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\` — the expandable proposal card and confirmation modal already display the full formatted plan.`,
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
  const skipReviewAttr = draft.skipContractReview
    ? ' skip_contract_review="true"'
    : "";
  const reconRunAttr = draft.reconRunId
    ? ` recon_run_id="${escapeXml(draft.reconRunId)}"`
    : "";
  const lines: string[] = [
    `<swarm_drafting_active mode="${escapeXml(draft.mode)}" base_branch="${escapeXml(draft.baseBranch ?? "auto")}" max_concurrency="${draft.maxConcurrency}" validator_enabled="${draft.validatorEnabled ? "true" : "false"}"${autoConfirmAttr}${skipReviewAttr}${reconRunAttr}>`,
    `Active \`pi-swarm\` draft for a **Dynamic Antigravity Swarm** (Orchestrator dynamically spawns/steers warm Workers & read-only Validators on the shared \`#seq\` Message Board with \`@mention\` wakeups). Rules: (1) Recon-in-Swarm FIRST — \`${SWARM_TOOL}\` (\`add\`, \`${POST_MESSAGE_TOOL}\`, \`${READ_BOARD_TOOL}\`, \`${SWARM_WAIT_TOOL}\`) is ALREADY active in read-only Recon mode during Drafting! For tiny 1-file tasks, run 1–3 quick read-only calls (\`read\`, \`grep\`, \`find\`, \`ls\` on \`package.json\`/configs/1–2 top-level entrypoints) and propose directly; for medium/large/unfamiliar repos, **immediately spawn 2–4 parallel read-only recon workers** via \`swarm{action:"add", name:"research-...", brief:"..."}\` (e.g. \`research-arch\`, \`research-baseline\`, \`research-ui\`) to inspect architecture, run baseline \`test\`/\`lint\`/\`typecheck\`/\`build\` probes, and seed \`library/*.md\`, then call \`${SWARM_WAIT_TOOL}\` to collect their concise \`@orchestrator [done]\` summaries and call \`${PROPOSE_SWARM_PLAN_TOOL}\` (optionally setting \`fork\` on \`initial_members\` to inherit a warm recon worker's context). Discover **already-installed** \`commands\` (\`test\`, \`typecheck\`, \`build\`, \`lint\`, plus optional \`"init"\` setup command if opt-in worktrees need setup beyond \`node_modules\`/\`.venv\` auto-symlinks), \`services\` (explicit unique ports in \`start\`/\`stop\`/\`healthcheck\` + \`port\` and acyclic \`depends_on\`), and \`boundaries\` (never invent speculative \`npx -y\` network downloads; **NEVER run heavy test suites/linters/typecheckers/builds/Playwright or deep serial code reads yourself during Drafting** — delegate those to parallel read-only recon workers or post-launch workers; if the target branch differs from the current checkout, use opt-in \`workspace:"share"\` or a wave-1 branch-prep step instead of stalling; note unrelated pre-existing failures for \`library/testing.md\` \`## Known Pre-Existing Issues\`; do NOT edit files or implement code yet); (2) Requirement Echo, Lean Clarification & Immediate Proposal — capture every user requirement, ask **0 questions** when clear, or **at most 1–3 high-leverage trade-off questions** for real ambiguities via \`${SWARM_QUESTIONNAIRE_TOOL}\` (or \`${SWARM_QUESTION_TOOL}\`) with the best option placed first and prefixed \`(Recommended)\` — never interrogate on obvious details, and once answered call \`${PROPOSE_SWARM_PLAN_TOOL}\` **immediately on your very next turn**; (3) Mission-Level TDD (**MANDATORY** \`assertions\` & \`features\`) & Right-Sizing — \`assertions\` (\`VAL-<AREA>-<NNN>\` + \`VAL-CROSS-*\` for multi-module/milestone integration, \`minItems: 1\`) and \`features\` (\`fulfills\`, \`minItems: 1\`) are **MANDATORY** in \`${PROPOSE_SWARM_PLAN_TOOL}\`: define testable \`VAL-<AREA>-<NNN>\` \`assertions\` with \`evidence_required\` FIRST, then decompose ordered vertical \`milestones\` and \`features\` (\`depends_on\` DAG + disjoint \`files_owned\` for parallel \`workspace:"inherit"\` workers in the shared repo — using opt-in \`share\` worktrees ONLY when concurrent workers must edit overlapping files — + 100% 1-to-1 \`fulfills\` coverage), right-sizing to 1–2 workers for small/single-module tasks or disjoint parallel \`inherit\` authors + independent \`validator\` spawned on demand as soon as the first slice is ready (~1 read-only validator per 2–4 authors, reusing warm validator(s) continuously for peer-to-peer \`@worker <-> @validator\` review & fix loops; domain names like \`val-api\`/\`val-ui\` allowed); (4) Adversarial Contract Review & Living Dynamic Workflow — finalize via \`${PROPOSE_SWARM_PLAN_TOOL}\` (which runs an automated **Adversarial Contract Review** for missing edge-case assertions, file-ownership collisions, and speculative commands) with \`title\`, \`objective\`, \`strategy\` specifying **wave-by-wave execution with disjoint file/directory ownership boundaries** (zero same-file collisions; not a rigid pre-locked file-level DAG — \`features\`, \`assertions\`, \`milestones\`, and workers remain dynamically extensible mid-mission via \`swarm{action:"mission"}\`, \`swarm{action:"mission", mission_op:"dispatch_ready"}\` auto-dispatching ready parallel features onto \`workspace:"inherit"\` by default, and \`swarm{action:"add"}\`), \`acceptance_criteria\` listing **exact runnable verification commands** using **already-installed** repo scripts, \`commands\`, \`services\`, \`boundaries\`, **MANDATORY** \`assertions\` & \`features\`, and optional valid \`initial_members\` populated with **wave-1 workers only** by default (\`workspace:"inherit"\` default, optional \`feature_id\` matching \`features[]\`, optional \`fork\` from a warm recon worker, concise briefs; only include a \`validator\` initially when reviewing already-existing code); (5) Do not repeat the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\`.`,
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
  options?: { skipContractReview?: boolean },
): string {
  const trimmedBranch = baseBranch?.trim();
  const hasNamedBranch = Boolean(trimmedBranch && trimmedBranch !== "HEAD");
  const displayBranch = hasNamedBranch
    ? trimmedBranch!
    : "(auto-detect current branch)";
  const baseBranchRule = hasNamedBranch
    ? `   - Use \`base_branch: "${escapeXml(trimmedBranch!)}"\`, \`max_concurrency: ${settings.maxConcurrency}\`, \`validator_enabled: ${settings.validatorEnabled ? "true" : "false"}\`.`
    : `   - Omit \`base_branch\` (auto-detect current branch), and use \`max_concurrency: ${settings.maxConcurrency}\`, \`validator_enabled: ${settings.validatorEnabled ? "true" : "false"}\`.`;
  const skipReviewAttr = options?.skipContractReview
    ? ' skip_contract_review="true"'
    : "";
  const lines: string[] = [
    `<swarm_direct_plan base_branch="${escapeXml(displayBranch)}" max_concurrency="${settings.maxConcurrency}" validator_enabled="${settings.validatorEnabled ? "true" : "false"}" auto_confirm="true"${skipReviewAttr}>`,
    `<goal>${escapeXml(goal.trim())}</goal>`,
    "<instructions>",
    "Fast-path `pi-swarm` launch (`/swarm direct`) as the **Orchestrator** (`autoConfirm: true`):",
    `1. Skip interactive Q&A — do NOT call \`${SWARM_QUESTION_TOOL}\` or \`${SWARM_QUESTIONNAIRE_TOOL}\`, while still echoing every goal requirement faithfully.`,
    `2. Recon-in-Swarm FIRST — \`${SWARM_TOOL}\` (\`add\`, \`${POST_MESSAGE_TOOL}\`, \`${READ_BOARD_TOOL}\`, \`${SWARM_WAIT_TOOL}\`) is ALREADY active in read-only Recon mode during Drafting! For tiny 1-file tasks, run 1–3 quick read-only calls (\`read\`, \`grep\`, \`find\`, \`ls\` on \`package.json\`/configs/1–2 top-level entrypoints) and propose directly; for medium/large/unfamiliar repos, **immediately spawn 2–4 parallel read-only recon workers** via \`swarm{action:"add", name:"research-...", brief:"..."}\` (e.g. \`research-arch\`, \`research-baseline\`, \`research-ui\`) to inspect architecture, run baseline \`test\`/\`lint\`/\`typecheck\`/\`build\` probes, and seed \`library/*.md\`, then call \`${SWARM_WAIT_TOOL}\` to collect their concise \`@orchestrator [done]\` summaries before calling \`${PROPOSE_SWARM_PLAN_TOOL}\` (optionally setting \`fork\` on \`initial_members\` to inherit a warm recon worker's context). Discover exact **already-installed** \`commands\` (\`test\`, \`typecheck\`, \`build\`, \`lint\`, plus optional \`"init"\` setup command if opt-in isolated worktrees need setup beyond \`node_modules\`/\`.venv\` auto-symlinks), \`services\` (explicit unique ports in \`start\`/\`stop\`/\`healthcheck\` + \`port\` and acyclic \`depends_on\`), and \`boundaries\` (ports, off-limits dirs) — never invent speculative \`npx -y\` downloads, **NEVER run heavy test suites, linters, typecheckers, builds, Playwright, or deep serial code reads yourself during Drafting** (delegate to parallel read-only recon workers or post-launch workers), note unrelated pre-existing repo failures for \`library/testing.md\` (\`## Known Pre-Existing Issues\`), and do NOT edit or implement code directly.`,
    "3. Mission-Level TDD (**MANDATORY** `assertions` & `features`) & Right-Sizing — `assertions` (`VAL-<AREA>-<NNN>`, plus `VAL-CROSS-*` for multi-module/milestone integration, `minItems: 1`) and `features` (`fulfills`, `minItems: 1`) are **MANDATORY** in `propose_swarm_plan`: define testable `VAL-<AREA>-<NNN>` behavioral `assertions` with required evidence FIRST, then decompose ordered vertical `milestones` and `features` (acyclic `depends_on` + disjoint `files_owned` so independent features in the same milestone run concurrently on **`workspace: \"inherit\"` by default** in the shared repo and can be auto-dispatched via `swarm{action:\"mission\", mission_op:\"dispatch_ready\"}` — using opt-in `workspace: \"share\"` worktrees ONLY when concurrent workers must edit overlapping files — with 100% 1-to-1 `fulfills` coverage). Right-size the swarm (1–2 workers for small/single-module tasks; disjoint parallel `inherit` authors + independent `validator` spawned on demand as soon as the first slice is ready — ~1 read-only validator per 2–4 authors, reusing warm validator(s) continuously for peer-to-peer `@worker <-> @validator` review & fix loops, domain names like `val-api`/`val-ui` allowed — for multi-module work).",
    `4. Immediately call \`${PROPOSE_SWARM_PLAN_TOOL}\` with a Contract-First **Flexible Dynamic Swarm Plan** (not a rigid pre-locked file-level DAG — \`features\`, \`assertions\`, \`milestones\`, and workers remain **dynamically extensible mid-mission** via \`swarm{action:"mission"}\`, \`swarm{action:"mission", mission_op:"dispatch_ready"}\`, and \`swarm{action:"add"}\`):`,
    baseBranchRule,
    "   - `strategy`: **wave-by-wave execution with disjoint file/directory ownership boundaries** (zero two-worker collisions on the same file; default `workspace: \"inherit\"` in the shared repo, with opt-in `share` worktrees only for overlapping concurrent edits) plus continuous peer-to-peer `@worker <-> @validator` review gates.",
    "   - `acceptance_criteria`: **exact runnable verification commands** using **already-installed** repo scripts discovered during recon (`npm test`, `npm run typecheck`, `node --test`, build checks — explicitly avoid speculative `npx -y` network package downloads) plus behavioral invariants.",
    "   - `commands` (including optional `\"init\"`), `services` (unique `port`, `start`/`stop`/`healthcheck`, `depends_on`), `boundaries`, and **MANDATORY** `assertions` (`VAL-*`) and `features` (with `milestone`, `depends_on`, `files_owned`, and 100% `fulfills` coverage).",
    `   - Provide \`title\`, \`objective\`, and optional right-sized \`initial_members\` with **wave-1 workers only** by default (\`workspace: "inherit"\` default, optional \`feature_id\` matching \`features[]\`, optional \`fork\` from a warm recon worker; spawn \`validator\` on demand as soon as the first slice is ready — ~1 read-only validator per 2–4 authors for continuous peer-to-peer \`@worker <-> @validator\` review & fix loops, domain names like \`val-api\`/\`val-ui\` allowed — and only include a \`validator\` initially when reviewing already-existing code). Keep each \`brief\` concise with exclusive file ownership and already-installed repo verification scripts; use unique lowercase names matching \`${MEMBER_NAME_PATTERN.source}\`, avoiding ${RESERVED_MEMBER_NAMES.join(", ")}.`,
    `5. Because this draft runs with \`autoConfirm: true\`, calling \`${PROPOSE_SWARM_PLAN_TOOL}\` runs pre-launch validation + automated **Adversarial Contract Review** (checking for missing edge-case assertions, file-ownership collisions, and speculative commands) and launches the Dynamic Swarm immediately without a confirmation modal once approved. Do NOT dump the full plan in prose beforehand.`,
    "</instructions>",
    "</swarm_direct_plan>",
  ];

  return lines.join("\n");
}

// ============================================================================
// Scrollable Transcript & Durable Tool-Result Summary Formatter
// ============================================================================

function formatInlineBacktick(value: string): string {
  return collapseInlineWhitespace(value).replace(/`/g, "\\`");
}

function groupFeaturesByMilestone(
  features: readonly MissionFeature[],
  milestones?: readonly SwarmMilestone[],
): Array<{
  label: string;
  status?: SwarmMilestone["status"];
  sealed?: boolean;
  features: MissionFeature[];
}> {
  const milestoneMeta = new Map<string, SwarmMilestone>();
  const orderedLabels: string[] = [];
  const seenLabels = new Set<string>();

  if (Array.isArray(milestones)) {
    for (const ms of milestones) {
      const label = collapseInlineWhitespace(ms.label ?? "");
      if (label && !seenLabels.has(label)) {
        seenLabels.add(label);
        orderedLabels.push(label);
        milestoneMeta.set(label, ms);
      }
    }
  }

  for (const feat of features) {
    const label = collapseInlineWhitespace(feat.milestone ?? "") || "Milestone";
    if (!seenLabels.has(label)) {
      seenLabels.add(label);
      orderedLabels.push(label);
    }
  }

  const groups: Array<{
    label: string;
    status?: SwarmMilestone["status"];
    sealed?: boolean;
    features: MissionFeature[];
  }> = [];

  for (const label of orderedLabels) {
    const groupFeatures = features.filter(
      (f) => (collapseInlineWhitespace(f.milestone ?? "") || "Milestone") === label,
    );
    if (groupFeatures.length === 0) {
      continue;
    }
    const meta = milestoneMeta.get(label);
    groups.push({
      label,
      ...(meta?.status ? { status: meta.status } : {}),
      ...(meta?.sealed ? { sealed: true } : {}),
      features: groupFeatures,
    });
  }

  return groups;
}

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

  const commands = plan.commands ?? [];
  const services = plan.services ?? [];
  const boundaries = plan.boundaries ?? [];
  if (commands.length > 0 || services.length > 0 || boundaries.length > 0) {
    lines.push("", "### Commands & Boundaries");
    if (commands.length > 0) {
      lines.push("", "**Commands:**");
      for (const cmd of commands) {
        const name = formatInlineBacktick(cmd.name || "cmd");
        const command = formatInlineBacktick(cmd.command || "");
        lines.push(`- \`${name}\`: \`${command}\``);
      }
    }
    if (services.length > 0) {
      lines.push("", "**Services & Ports:**");
      for (const svc of services) {
        const svcName = escapeTableCell(svc.name || "service");
        const portPart = svc.port !== undefined ? ` (\`:${svc.port}\`)` : "";
        const details: string[] = [
          `start: \`${formatInlineBacktick(svc.start || "")}\``,
        ];
        if (svc.stop) {
          details.push(`stop: \`${formatInlineBacktick(svc.stop)}\``);
        }
        if (svc.healthcheck) {
          details.push(`healthcheck: \`${formatInlineBacktick(svc.healthcheck)}\``);
        }
        if (svc.dependsOn && svc.dependsOn.length > 0) {
          details.push(
            `dependsOn: ${svc.dependsOn.map((d) => `\`${formatInlineBacktick(d)}\``).join(", ")}`,
          );
        }
        lines.push(`- **${svcName}**${portPart} — ${details.join(" | ")}`);
      }
    }
    if (boundaries.length > 0) {
      lines.push("", "**Boundaries:**");
      for (const b of boundaries) {
        const cleanBoundary = collapseInlineWhitespace(b);
        if (cleanBoundary) {
          lines.push(`- ${cleanBoundary}`);
        }
      }
    }
  }

  const assertions = plan.assertions ?? [];
  if (assertions.length > 0) {
    const passedCount = assertions.filter((a) => a.status === "passed").length;
    const passedSuffix =
      passedCount > 0 ? ` · ${passedCount} passed` : "";
    lines.push(
      "",
      `### Validation Contract (VAL-*) (${assertions.length}${passedSuffix})`,
      "",
      "| ID | Status | Assertion & Behavioral Requirement | Evidence Required |",
      "| --- | --- | --- | --- |",
    );
    for (const a of assertions) {
      const id = escapeTableCell(a.id || "") || "(id)";
      const status = escapeTableCell(a.status || "pending");
      const title = escapeTableCell(a.title || "");
      const desc = escapeTableCell(a.description || "");
      const reqBody =
        title && desc
          ? `**${title}** — ${desc}`
          : title
            ? `**${title}**`
            : desc || "—";
      const evReq = escapeTableCell(a.evidenceRequired || "") || "—";
      const evCollected = a.evidence
        ? ` _(verified: ${escapeTableCell(a.evidence)})_`
        : "";
      lines.push(
        `| \`${id}\` | \`${status}\` | ${reqBody} | ${evReq}${evCollected} |`,
      );
    }
  }

  const features = plan.features ?? [];
  if (features.length > 0) {
    const groups = groupFeaturesByMilestone(features, plan.milestones);
    lines.push(
      "",
      `### Features by Milestone (${features.length} ${features.length === 1 ? "feature" : "features"} · ${groups.length} ${groups.length === 1 ? "milestone" : "milestones"})`,
    );

    for (const group of groups) {
      const sealedTag = group.sealed ? " [SEALED]" : "";
      const statusTag =
        group.status && group.status !== "pending"
          ? ` (\`${escapeTableCell(group.status)}\`)`
          : "";
      lines.push(
        "",
        `#### ${escapeTableCell(group.label)}${sealedTag}${statusTag}`,
        "",
        "| Feature | Status | dependsOn | fulfills | Scope & Files |",
        "| --- | --- | --- | --- | --- |",
      );

      for (const f of group.features) {
        const fId = escapeTableCell(f.id || "") || "(feature)";
        const fTitle = escapeTableCell(f.title || "");
        const featCell = fTitle ? `**${fId}** — ${fTitle}` : `**${fId}**`;
        const shaSuffix = f.mergedCommitSha
          ? ` (@${escapeTableCell(f.mergedCommitSha.slice(0, 7))})`
          : "";
        const statusCell = `\`${escapeTableCell(f.status || "pending")}\`${shaSuffix}`;
        const depsCell =
          f.dependsOn && f.dependsOn.length > 0
            ? f.dependsOn.map((d) => `\`${escapeTableCell(d)}\``).join(", ")
            : "—";
        const fulfillsCell =
          f.fulfills && f.fulfills.length > 0
            ? f.fulfills.map((v) => `\`${escapeTableCell(v)}\``).join(", ")
            : "—";
        const descText = escapeTableCell(f.description || "") || "—";
        const filesSuffix =
          f.filesOwned && f.filesOwned.length > 0
            ? ` _(files: ${f.filesOwned.map((p) => `\`${escapeTableCell(p)}\``).join(", ")})_`
            : "";
        lines.push(
          `| ${featCell} | ${statusCell} | ${depsCell} | ${fulfillsCell} | ${descText}${filesSuffix} |`,
        );
      }
    }
  }

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

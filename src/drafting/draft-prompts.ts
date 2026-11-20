import {
  DEFAULT_SWARM_SETTINGS,
  PROPOSE_SWARM_PLAN_TOOL,
  SWARM_BRANCH_PREFIX,
  SWARM_FINDING_TOOL,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_QUESTION_TOOL,
} from "../constants.js";
import type {
  ActiveSwarmDraft,
  MissionPlanInput,
  MissionTaskInput,
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

/**
 * Derives a preview `feat/<slug>` branch name for a mission title.
 * Used for transcript previews in `renderCall()` before `SwarmStore.validatePlan()` runs.
 */
export function previewMissionBranch(title: string, fallbackId = "mission"): string {
  const slugify = (raw: string): string =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);

  const slug = slugify(title) || slugify(fallbackId) || "mission";
  return `${SWARM_BRANCH_PREFIX}${slug}`;
}

/**
 * Computes a safe preview map of mission ID -> `feat/<slug>` branches.
 */
export function computePreviewBranches(
  missions: readonly Pick<MissionPlanInput, "id" | "title">[],
): Record<string, string> {
  const branches: Record<string, string> = {};
  const used = new Set<string>();

  for (const mission of missions) {
    const id = mission.id || "mission";
    const base = previewMissionBranch(mission.title || id, id);
    let candidate = base;
    if (used.has(candidate)) {
      const idSlug = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      candidate = idSlug ? `${base}-${idSlug}` : `${base}-2`;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${base}-${suffix++}`;
      }
    }
    used.add(candidate);
    branches[id] = candidate;
  }

  return branches;
}

/**
 * Computes topological execution waves for preview rendering.
 * Never throws or loops infinitely even on cyclic or partial/streaming inputs:
 * any remaining missions are placed into a final fallback wave.
 */
export function computePreviewWaves(
  missions: readonly Pick<MissionPlanInput, "id" | "deps">[],
): string[][] {
  if (missions.length === 0) {
    return [];
  }

  const knownIds = new Set(missions.map((m) => m.id));
  const placed = new Set<string>();
  const remaining = missions.map((m) => ({
    id: m.id,
    deps: (m.deps ?? []).filter((d) => knownIds.has(d) && d !== m.id),
  }));
  const waves: string[][] = [];

  while (remaining.length > 0) {
    const ready: string[] = [];
    for (const item of remaining) {
      if (item.deps.every((dep) => placed.has(dep))) {
        ready.push(item.id);
      }
    }

    if (ready.length === 0) {
      // Cycle or unresolved dep in preview — append remaining in order so nothing is hidden.
      waves.push(remaining.map((r) => r.id));
      break;
    }

    waves.push(ready);
    for (const id of ready) {
      placed.add(id);
    }
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (placed.has(remaining[i]!.id)) {
        remaining.splice(i, 1);
      }
    }
  }

  return waves;
}

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function formatTaskCell(task: MissionTaskInput): string {
  if (typeof task === "string") {
    return `[ ] ${escapeTableCell(task)}`;
  }
  const mark = task.done ? "x" : " ";
  const prefix = task.id ? `\`${escapeTableCell(task.id)}\` ` : "";
  return `[${mark}] ${prefix}${escapeTableCell(task.title)}`;
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

// ============================================================================
// Drafting Prompts
// ============================================================================

export interface DraftingKickoffOptions {
  baseBranch?: string;
  maxConcurrency?: number;
  validatorEnabled?: boolean;
  finalValidatorEnabled?: boolean;
  roleModels?: SwarmRoleModels;
  targetRun?: {
    id: string;
    objective: string;
    baseBranch: string;
    missionCount: number;
  };
  existingEcho?: Record<string, string>;
}

/**
 * Builds the kickoff user message for interactive `pi-swarm` planning (`/swarm [seed]`).
 * Guides the Orchestrator through upfront clarification ("事前澄清") and strict Mission DAG
 * design tailored to the 3-role Antigravity Swarm architecture (Orchestrator, Worker, Validator).
 */
export function buildDraftingKickoffPrompt(
  seed: string,
  mode: SwarmDraftMode = "swarm",
  options: DraftingKickoffOptions = {},
): string {
  const trimmedSeed = seed.trim();
  const baseBranch = options.baseBranch?.trim() || "(auto-detect current branch)";
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_SWARM_SETTINGS.maxConcurrency;
  const validatorEnabled =
    options.validatorEnabled ?? DEFAULT_SWARM_SETTINGS.validatorEnabled;
  const finalValidatorEnabled =
    options.finalValidatorEnabled ?? DEFAULT_SWARM_SETTINGS.finalValidatorEnabled;

  const lines: string[] = [
    `<swarm_drafting_kickoff mode="${escapeXml(mode)}">`,
    `<seed>${escapeXml(trimmedSeed || "(User did not supply an initial goal yet — ask what they want to build.)")}</seed>`,
    `<defaults base_branch="${escapeXml(baseBranch)}" max_concurrency="${maxConcurrency}" validator_enabled="${validatorEnabled ? "true" : "false"}" final_validator_enabled="${finalValidatorEnabled ? "true" : "false"}" />`,
  ];

  if (options.roleModels) {
    lines.push(
      `<role_models orchestrator="${escapeXml(formatRoleModelSlot(options.roleModels.orchestrator))}" worker="${escapeXml(formatRoleModelSlot(options.roleModels.worker))}" validator="${escapeXml(formatRoleModelSlot(options.roleModels.validator))}" />`,
    );
  }

  if (options.targetRun) {
    lines.push(
      `<target_run id="${escapeXml(options.targetRun.id)}" base_branch="${escapeXml(options.targetRun.baseBranch)}" missions="${options.targetRun.missionCount}">${escapeXml(options.targetRun.objective)}</target_run>`,
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
    "You are entering `pi-swarm` Planning / Drafting Mode as the **Orchestrator** to design a parallel multi-agent Mission DAG before launching the swarm.",
  );
  lines.push("");
  lines.push("How the 3-role Antigravity Swarm executes once approved:");
  lines.push(
    "- **Orchestrator (you):** Plans waves, monitors the shared Message Board, manages merges/models/teardown, and resolves escalations.",
  );
  lines.push(
    "- **Workers:** Run in parallel inside isolated Git worktrees (`feat/<slug>`), collaborating over the shared **Message Board** (`#seq` posts with `@mention` wakeups and warm persistent sessions that preserve context across turns).",
  );
  lines.push(
    "- **Validators:** Independent read-only **Per-Mission Validators** audit each `build` branch pinned to its exact tip commit SHA and wake the Worker directly via `@<mission>` on the Message Board when fixes are required; after all missions merge into `base_branch`, an independent read-only **Final Validator** audits the integrated `base_branch` directly against `verification_contract` before the run can complete.",
  );
  lines.push("");
  lines.push(
    "1. DO NOT start editing, writing, or implementing code yet. Do not run mutating shell commands or create git branches/worktrees.",
  );
  lines.push(
    "2. Targeted read-only repository reconnaissance (using `read`, `grep`, `find`, `ls`) IS strongly encouraged so your clarifying questions and mission file scopes are grounded in the actual codebase.",
  );
  lines.push(
    "3. Upfront Clarification (事前澄清): Identify genuine ambiguities (architecture choices, module boundaries, acceptance criteria, edge cases, or base branch / concurrency tradeoffs).",
  );
  lines.push(
    `   - Prefer \`${SWARM_QUESTIONNAIRE_TOOL}\` to ask 2–4 related questions in a single tabbed prompt with clear options and recommended defaults, or \`${SWARM_QUESTION_TOOL}\` for one focused question.`,
  );
  lines.push(
    "   - Skip trivial or already-unambiguous questions; if the goal and codebase boundaries are already completely clear, proceed straight to proposing the plan.",
  );
  lines.push(
    `4. Mission DAG Proposal: Once clear, call \`${PROPOSE_SWARM_PLAN_TOOL}\` with a clean, protocol-valid Mission DAG:`,
  );
  lines.push(
    "   - Printable ASCII mission titles only (used to derive clean `feat/<slug>` branches).",
  );
  lines.push(
    `   - Choose the right mission \`kind\`: \`"build"\` (code/tests in isolated worktree; audited by a Per-Mission Validator at tip SHA + merged), \`"artifact"\` (deliverables requiring human approval before merge), or \`"survey"\` (strictly read-only research whose findings feed downstream missions via \`${SWARM_FINDING_TOOL}\` and the Message Board, closing with zero diff).`,
  );
  lines.push(
    '   - Pairwise-disjoint `scope` paths across all `"build"` missions (no shared files or prefix overlaps, e.g. never `src/` alongside `src/auth/`) so parallel Workers never collide.',
  );
  lines.push(
    "   - Explicit `deps` DAG for sequential waves — only add a dependency when a mission truly needs an upstream mission's merged code or survey findings.",
  );
  lines.push(
    "   - Concrete `verification` criteria per mission and an overall, testable `verification_contract` — verified post-merge on `base_branch` by the independent read-only Final Validator.",
  );
  lines.push(
    `5. Do NOT dump the full plan or mission table in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\` — its tool renderer already prints the full formatted Mission DAG into scrollback before opening the confirmation dialog.`,
  );
  lines.push("</instructions>");
  lines.push("</swarm_drafting_kickoff>");

  return lines.join("\n");
}

/**
 * Short, prompt-cache-friendly tail addendum injected while a `pi-swarm` draft is active.
 * Designed for tail context injection (never rewriting the leading system prompt).
 */
export function buildDraftingSystemOverlay(draft: ActiveSwarmDraft): string {
  const finalValidatorEnabled =
    draft.finalValidatorEnabled ?? DEFAULT_SWARM_SETTINGS.finalValidatorEnabled;
  const lines: string[] = [
    `<swarm_drafting_active mode="${escapeXml(draft.mode)}" base_branch="${escapeXml(draft.baseBranch ?? "auto")}" max_concurrency="${draft.maxConcurrency}" validator_enabled="${draft.validatorEnabled ? "true" : "false"}" final_validator_enabled="${finalValidatorEnabled ? "true" : "false"}">`,
    `Active \`pi-swarm\` draft is in progress (3-role swarm: Orchestrator, parallel Workers in isolated worktrees on the shared \`#seq\` Message Board with \`@mention\` wakeups, Per-Mission Validators auditing \`build\` branches at tip SHA, and Run-level Final Validator auditing \`base_branch\`). Rules: (1) Read-only repo reconnaissance only — do NOT edit files or implement yet; (2) Use \`${SWARM_QUESTIONNAIRE_TOOL}\` or \`${SWARM_QUESTION_TOOL}\` only for genuine ambiguities; (3) Finalize via \`${PROPOSE_SWARM_PLAN_TOOL}\` with printable ASCII titles, appropriate kinds (\`build\`/\`artifact\`/\`survey\`), pairwise-disjoint \`build\` scopes, valid \`deps\` DAG, and a concrete, testable \`verification_contract\`; (4) Do not repeat the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\`.`,
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
 * instructs the Orchestrator to perform brief read-only repo inspection then immediately
 * invoke `propose_swarm_plan`.
 */
export function buildDirectPlanPrompt(
  goal: string,
  baseBranch: string,
  settings: Pick<SwarmSettings, "maxConcurrency" | "validatorEnabled"> &
    Partial<Pick<SwarmSettings, "finalValidatorEnabled">>,
): string {
  const finalValidatorEnabled =
    settings.finalValidatorEnabled ?? DEFAULT_SWARM_SETTINGS.finalValidatorEnabled;
  const lines: string[] = [
    `<swarm_direct_plan base_branch="${escapeXml(baseBranch)}" max_concurrency="${settings.maxConcurrency}" validator_enabled="${settings.validatorEnabled ? "true" : "false"}" final_validator_enabled="${finalValidatorEnabled ? "true" : "false"}">`,
    `<goal>${escapeXml(goal.trim())}</goal>`,
    "<instructions>",
    "Fast-path `pi-swarm` launch (`/swarm direct`) as the Orchestrator:",
    `1. Skip interactive Q&A — do NOT call \`${SWARM_QUESTION_TOOL}\` or \`${SWARM_QUESTIONNAIRE_TOOL}\`.`,
    "2. Do NOT edit or implement code directly; perform a quick read-only inspection (`ls`, `find`, `grep`, `read`) to ground mission scopes and verification commands in the real repository layout.",
    `3. Immediately call \`${PROPOSE_SWARM_PLAN_TOOL}\` with a valid Mission DAG for the 3-role swarm (parallel Workers in isolated worktrees collaborating over the shared \`#seq\` Message Board with \`@mention\` wakeups, Per-Mission Validators auditing each \`build\` branch at tip SHA and waking \`@<mission>\` on fixes, and the Run-level Final Validator auditing \`base_branch\` against \`verification_contract\`):`,
    `   - Use \`base_branch: "${escapeXml(baseBranch)}"\`, \`max_concurrency: ${settings.maxConcurrency}\`, \`validator_enabled: ${settings.validatorEnabled ? "true" : "false"}\`, \`final_validator_enabled: ${finalValidatorEnabled ? "true" : "false"}\`.`,
    "   - Printable ASCII mission titles, appropriate kinds (`build`, `artifact`, `survey`), pairwise-disjoint `scope` paths across `build` missions, explicit acyclic `deps`, and concrete per-mission `verification` + a concrete, testable `verification_contract`.",
    `4. Do NOT dump the full plan in prose before calling \`${PROPOSE_SWARM_PLAN_TOOL}\` — calling it will validate and launch the Swarm immediately.`,
    "</instructions>",
    "</swarm_direct_plan>",
  ];

  return lines.join("\n");
}

// ============================================================================
// Scrollable Transcript & Durable Tool-Result Summary Formatter
// ============================================================================

/**
 * Renders the full Mission DAG proposal into clean, structured Markdown.
 * Used BOTH in `propose_swarm_plan.renderCall()` (scrollable transcript before the
 * confirmation modal opens) AND persisted in the tool result for confirm/continue/cancel.
 */
export function formatProposalTranscriptSummary(
  plan: ProposedSwarmPlan,
  waves: readonly (readonly string[])[],
  branches: Readonly<Record<string, string>>,
): string {
  const missionById = new Map<string, MissionPlanInput>();
  for (const mission of plan.missions) {
    missionById.set(mission.id, mission);
  }

  const effectiveWaves: readonly (readonly string[])[] =
    waves.length > 0 ? waves : computePreviewWaves(plan.missions);
  const finalValidatorEnabled = plan.finalValidatorEnabled ?? true;

  const lines: string[] = [
    "## Swarm Mission Plan Proposal",
    "",
    `**Objective:** ${plan.objective || "(pending)"}`,
    `**Base Branch:** \`${plan.baseBranch || "auto"}\` | **Concurrency:** ${plan.maxConcurrency} | **Per-Mission Validator:** ${plan.validatorEnabled ? "ON" : "OFF"} | **Final Validator:** ${finalValidatorEnabled ? "ON" : "OFF"} | **Missions:** ${plan.missions.length} | **Waves:** ${effectiveWaves.length}`,
    formatRoleModelsLine(plan.roleModels),
    `**Verification Contract:** ${plan.verificationContract || "(pending)"}`,
  ];

  if (plan.missions.length === 0) {
    lines.push("", "_No missions specified yet._");
    return lines.join("\n");
  }

  lines.push("", "### Execution Waves & Mission DAG");

  const renderedIds = new Set<string>();
  const appendWaveSection = (heading: string, ids: readonly string[]): void => {
    lines.push(
      "",
      heading,
      "",
      "| ID | Title | Kind | Branch | Scope | Deps | Verification | Tasks |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );

    const descriptions: string[] = [];
    for (const id of ids) {
      const mission = missionById.get(id);
      if (!mission) {
        lines.push(
          `| **${escapeTableCell(id)}** | _(mission definition missing)_ | — | — | — | — | — | — |`,
        );
        continue;
      }

      renderedIds.add(mission.id);
      const branch = branches[mission.id] ?? previewMissionBranch(mission.title, mission.id);
      const depsText =
        mission.deps.length > 0
          ? mission.deps.map((d) => escapeTableCell(d)).join(", ")
          : "none";
      const scopeText =
        mission.scope.length > 0
          ? mission.scope.map((s) => `\`${escapeTableCell(s)}\``).join(", ")
          : "(none)";
      const verificationText = mission.verification.trim()
        ? escapeTableCell(mission.verification)
        : "—";
      const tasksText =
        mission.tasks && mission.tasks.length > 0
          ? mission.tasks.map((t) => formatTaskCell(t)).join("; ")
          : "—";

      lines.push(
        `| **${escapeTableCell(mission.id)}** | ${escapeTableCell(mission.title)} | \`${mission.kind}\` | \`${escapeTableCell(branch)}\` | ${scopeText} | ${depsText} | ${verificationText} | ${tasksText} |`,
      );

      if (mission.description.trim()) {
        descriptions.push(
          `- **${mission.id}:** ${mission.description.replace(/\r?\n/g, " ").trim()}`,
        );
      }
    }

    if (descriptions.length > 0) {
      lines.push("", ...descriptions);
    }
  };

  effectiveWaves.forEach((waveIds, idx) => {
    const waveLabel =
      waveIds.length > 1
        ? `#### Wave ${idx + 1} (${waveIds.length} parallel)`
        : `#### Wave ${idx + 1}`;
    appendWaveSection(waveLabel, waveIds);
  });

  // Ensure any mission not covered by `waves` is still rendered
  const leftover = plan.missions.filter((m) => !renderedIds.has(m.id));
  if (leftover.length > 0) {
    appendWaveSection(
      "#### Unscheduled Missions",
      leftover.map((m) => m.id),
    );
  }

  return lines.join("\n");
}

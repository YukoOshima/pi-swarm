import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  CHANNEL_NAME_PATTERN,
  MEMBER_NAME_PATTERN,
  PROPOSE_SWARM_PLAN_TOOL,
  RESERVED_MEMBER_NAMES,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_QUESTION_TOOL,
  type ReservedMemberName,
} from "../constants.js";
import { SWARM_SETTINGS_BOUNDS, isPrototypeKey } from "../store/index.js";
import {
  isSwarmProtocolError,
  type ConfirmProposalOptions,
  type InitialMemberProposal,
  type IQuestionnaireUI,
  type ISwarmStore,
  type IWorktreeManager,
  type ProposalDialogOutcome,
  type ProposedSwarmPlan,
  type QuestionAnswer,
  type QuestionOption,
  type QuestionSpec,
  type SwarmErrorCode,
  type SwarmMemberRole,
  type SwarmRoleModelConfig,
  type SwarmRoleModels,
  type SwarmRunState,
  type SwarmSettings,
  type SwarmWorkspaceMode,
} from "../types.js";
import { formatProposalTranscriptSummary } from "./draft-prompts.js";
import { DraftStateController, type SwarmDraftState } from "./draft-state.js";

// ============================================================================
// Dependencies & Tool Details Types
// ============================================================================

export interface DraftingDeps {
  store?: ISwarmStore;
  worktree?: IWorktreeManager;
  ui: IQuestionnaireUI;
  getSettings: () => SwarmSettings;
  onPlanConfirmed: (
    plan: ProposedSwarmPlan,
    ctx: ExtensionContext,
  ) => Promise<SwarmRunState>;
  onModalEnter?: () => void;
  onModalExit?: () => void;
  /** Optional shared draft state controller; created automatically if omitted. */
  draftController?: DraftStateController;
  /** Optional hook fired when active draft state changes (for widget/status sync). */
  onDraftChanged?: (draft: SwarmDraftState | null, ctx: ExtensionContext) => void;
  /** Optional extra modal options (e.g. inline `[m]` Mission Model Picker). */
  confirmProposalOptions?: (
    ctx: ExtensionContext,
    plan: ProposedSwarmPlan,
  ) => Partial<ConfirmProposalOptions>;
}

export interface DraftPlanValidationIssue {
  code: SwarmErrorCode;
  message: string;
  memberName?: string;
  field?: string;
}

export interface SwarmQuestionToolDetails {
  cancelled: boolean;
  id: string;
  question: string;
  answer?: string;
  isCustom?: boolean;
}

export interface SwarmQuestionnaireToolDetails {
  cancelled: boolean;
  questionCount: number;
  answers: Record<string, string>;
  items?: QuestionAnswer[];
  error?: string;
}

export interface ProposeSwarmPlanToolDetails {
  outcome: "confirmed" | "continue" | "cancelled" | "validation_error" | "error";
  runId?: string;
  plan?: ProposedSwarmPlan;
  autoConfirmed?: boolean;
  feedback?: string;
  errors?: DraftPlanValidationIssue[];
  errorCode?: SwarmErrorCode | string;
  errorMessage?: string;
}

// ============================================================================
// Parameter Schemas (Google-compatible flat object schemas; StringEnum for enums)
// ============================================================================

const QuestionOptionSchema = Type.Object({
  label: Type.String({
    description:
      "Short choice label displayed to the user (place the best option first and prefix with '(Recommended)').",
  }),
  value: Type.Optional(
    Type.String({ description: "Optional canonical value returned when chosen." }),
  ),
  description: Type.Optional(
    Type.String({ description: "Optional brief explanation or tradeoff for this choice." }),
  ),
});

export const SwarmQuestionParamsSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: "Optional short key for persisting this answer in draft state." }),
  ),
  question: Type.String({
    description:
      "Clear, concise high-leverage trade-off question grounded in repository recon.",
  }),
  context: Type.Optional(
    Type.String({ description: "Optional brief repo-grounded context or tradeoff note." }),
  ),
  options: Type.Optional(
    Type.Array(QuestionOptionSchema, {
      description:
        "Suggested answer choices (put the best option first, prefixed with '(Recommended)').",
    }),
  ),
  recommended: Type.Optional(
    Type.String({ description: "Label or value of the recommended default option." }),
  ),
  allow_custom: Type.Optional(
    Type.Boolean({ description: "Allow a custom typed answer (default true)." }),
  ),
});

export const SwarmQuestionnaireItemSchema = Type.Object({
  id: Type.String({ description: "Short unique identifier for this question (e.g. 'auth_mode')." }),
  question: Type.String({
    description: "Clear, concise high-leverage trade-off question text.",
  }),
  context: Type.Optional(
    Type.String({ description: "Optional brief context or tradeoff grounded in the repo." }),
  ),
  options: Type.Array(QuestionOptionSchema, {
    minItems: 1,
    description:
      "Suggested options for this question (place the best option first and prefix with '(Recommended)').",
  }),
  recommended: Type.Optional(
    Type.String({ description: "Label or value of the recommended default option." }),
  ),
  allow_custom: Type.Optional(
    Type.Boolean({ description: "Allow a custom typed answer (default true)." }),
  ),
});

export const SwarmQuestionnaireParamsSchema = Type.Object({
  questions: Type.Array(SwarmQuestionnaireItemSchema, {
    minItems: 1,
    description:
      "Ordered list of 1–3 high-leverage clarifying trade-off questions shown in a tabbed modal.",
  }),
});

const InitialMemberRoleSchema = Type.Unsafe<SwarmMemberRole>(
  StringEnum(["worker", "validator"] as const, {
    description:
      'Member role: "worker" (full workspace access & able to add helpers) or "validator" (independent read-only auditor).',
  }),
);

const InitialMemberWorkspaceSchema = Type.Unsafe<SwarmWorkspaceMode>(
  StringEnum(["inherit", "share", "branch"] as const, {
    description:
      'Workspace mode: "inherit" (default, shared repo root for read-only scouting/validation), "share" (isolated Git worktree on a new branch), or "branch" (isolated Git worktree clone).',
  }),
);

export const InitialMemberProposalSchema = Type.Object({
  name: Type.String({
    description:
      'Unique short lowercase member handle matching /^[a-z][a-z0-9-]{0,31}$/ (e.g. "scout", "parser", "verifier"). Reserved names (orchestrator, coordinator, all, monitor) are forbidden.',
  }),
  role: InitialMemberRoleSchema,
  brief: Type.String({
    description:
      "Concise public assignment posted on the shared Message Board: exclusive file/directory ownership, constraints, already-installed repo verification scripts (avoid speculative 'npx -y' downloads), and next-peer @mention.",
  }),
  workspace: Type.Optional(InitialMemberWorkspaceSchema),
  channels: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional additional board channels to subscribe this member to (e.g. ["backend", "api"]). "main" is always included.',
    }),
  ),
});

export const ProposeSwarmPlanParamsSchema = Type.Object({
  title: Type.String({
    description: "Short human-readable title for this Dynamic Swarm run.",
  }),
  objective: Type.String({
    description: "Overall objective of this Swarm run.",
  }),
  strategy: Type.String({
    description:
      "Wave-by-wave dynamic orchestration plan with disjoint file/directory ownership boundaries (zero two-worker collisions on the same file) and @mention -> validator review/merge gates on the shared Message Board.",
  }),
  acceptance_criteria: Type.String({
    description:
      'Concrete, testable definition of "what done looks like" listing exact runnable verification commands using already-installed repo scripts (e.g. npm test, npm run typecheck, node --test — avoid speculative npx -y downloads) and behavioral checks.',
  }),
  base_branch: Type.Optional(
    Type.String({
      description:
        "Target local git branch to base isolated worktrees on and merge clean work back into.",
    }),
  ),
  max_concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 64,
      description: "Maximum parallel working Swarm members (defaults to draft/settings).",
    }),
  ),
  validator_enabled: Type.Optional(
    Type.Boolean({
      description:
        "Whether independent read-only Validator review policy is enabled by default for this Swarm run.",
    }),
  ),
  initial_members: Type.Optional(
    Type.Array(InitialMemberProposalSchema, {
      description:
        "Optional wave-1 workers only by default (1–2 workers for small/single-module tasks; disjoint parallel 'share' workers for multi-module work). Spawn an independent 'validator' on demand once a worker commits/posts '[done]' (only include a validator initially when reviewing already-existing code). Keep briefs concise and grounded in already-installed repo verification scripts (no speculative 'npx -y' downloads). Leave omitted/empty to spawn dynamically after launch.",
    }),
  ),
});

export type SwarmQuestionParams = Static<typeof SwarmQuestionParamsSchema>;
export type SwarmQuestionnaireParams = Static<typeof SwarmQuestionnaireParamsSchema>;
export type InitialMemberProposalParams = Static<typeof InitialMemberProposalSchema>;
export type ProposeSwarmPlanParams = Static<typeof ProposeSwarmPlanParamsSchema>;

// ============================================================================
// Normalization, Role Models & Pre-Modal Validation Helpers
// ============================================================================

function buildRoleModelConfig(
  model?: string,
  thinkingLevel?: ThinkingLevel,
): SwarmRoleModelConfig {
  const trimmed = model?.trim();
  return {
    ...(trimmed ? { model: trimmed } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/**
 * Derives the active 3-role model configuration (`orchestrator`, `worker`, `validator`,
 * plus `fallbackModels`) from `SwarmSettings` so the confirmation modal and proposal
 * transcript display the exact model trio that will execute the run.
 */
export function buildRoleModelsFromSettings(
  settings: Pick<
    SwarmSettings,
    | "orchestratorModel"
    | "orchestratorThinkingLevel"
    | "workerModel"
    | "workerThinkingLevel"
    | "validatorModel"
    | "validatorThinkingLevel"
    | "fallbackModels"
  >,
): SwarmRoleModels {
  const fallbackModels = (settings.fallbackModels ?? [])
    .map((m) => m.trim())
    .filter(Boolean);

  return {
    orchestrator: buildRoleModelConfig(
      settings.orchestratorModel,
      settings.orchestratorThinkingLevel,
    ),
    worker: buildRoleModelConfig(settings.workerModel, settings.workerThinkingLevel),
    validator: buildRoleModelConfig(
      settings.validatorModel,
      settings.validatorThinkingLevel,
    ),
    fallbackModels,
  };
}

async function withModalGuard<T>(
  deps: Pick<DraftingDeps, "onModalEnter" | "onModalExit">,
  fn: () => Promise<T>,
): Promise<T> {
  deps.onModalEnter?.();
  try {
    return await fn();
  } finally {
    deps.onModalExit?.();
  }
}

function sanitizePositiveInt(
  value: number,
  fallback = 1,
  max = SWARM_SETTINGS_BOUNDS.maxConcurrency.max,
): number {
  const clamp = (n: number): number => Math.min(max, Math.max(1, Math.floor(n)));
  if (!Number.isFinite(value) || value < 1) {
    return clamp(Number.isFinite(fallback) && fallback >= 1 ? fallback : 1);
  }
  return clamp(value);
}

function sanitizeQuestionId(rawId: string): string {
  return isPrototypeKey(rawId) ? `q_${rawId}` : rawId;
}

function slugifyQuestionId(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return slug || "question";
}

function normalizeRawOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalized: QuestionOption[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const label = item.trim();
      if (label) {
        normalized.push({ label });
      }
      continue;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const label = typeof obj.label === "string" ? obj.label.trim() : "";
      if (!label) {
        continue;
      }
      const option: QuestionOption = { label };
      if (typeof obj.value === "string" && obj.value.trim()) {
        option.value = obj.value.trim();
      }
      if (typeof obj.description === "string" && obj.description.trim()) {
        option.description = obj.description.trim();
      }
      normalized.push(option);
    }
  }
  return normalized;
}

function isValidMemberRole(value: unknown): value is SwarmMemberRole {
  return value === "worker" || value === "validator";
}

function isValidWorkspaceMode(value: unknown): value is SwarmWorkspaceMode {
  return value === "inherit" || value === "share" || value === "branch";
}

function isReservedMemberName(name: string): name is ReservedMemberName {
  return (RESERVED_MEMBER_NAMES as readonly string[]).includes(name);
}

/**
 * Validates `propose_swarm_plan` parameters BEFORE opening any confirmation modal.
 * Verifies non-empty `title`/`objective`/`strategy`/`acceptance_criteria`, and checks
 * `initial_members` against `MEMBER_NAME_PATTERN`, `RESERVED_MEMBER_NAMES`, uniqueness,
 * valid role/workspace/brief, and valid `CHANNEL_NAME_PATTERN` channels.
 */
export function validateProposedSwarmPlan(
  params: ProposeSwarmPlanParams,
):
  | {
      valid: true;
      title: string;
      objective: string;
      strategy: string;
      acceptanceCriteria: string;
      initialMembers?: InitialMemberProposal[];
    }
  | {
      valid: false;
      issues: DraftPlanValidationIssue[];
    } {
  const issues: DraftPlanValidationIssue[] = [];

  const title = typeof params.title === "string" ? params.title.trim() : "";
  const objective =
    typeof params.objective === "string" ? params.objective.trim() : "";
  const strategy =
    typeof params.strategy === "string" ? params.strategy.trim() : "";
  const acceptanceCriteria =
    typeof params.acceptance_criteria === "string"
      ? params.acceptance_criteria.trim()
      : "";

  if (!title) {
    issues.push({
      code: "INVALID_INPUT",
      field: "title",
      message: "Plan title must not be empty.",
    });
  }
  if (!objective) {
    issues.push({
      code: "INVALID_INPUT",
      field: "objective",
      message: "Plan objective must not be empty.",
    });
  }
  if (!strategy) {
    issues.push({
      code: "INVALID_INPUT",
      field: "strategy",
      message: "Plan strategy must not be empty.",
    });
  }
  if (!acceptanceCriteria) {
    issues.push({
      code: "INVALID_INPUT",
      field: "acceptance_criteria",
      message: "Plan acceptance_criteria must not be empty.",
    });
  }

  const baseBranchInput =
    typeof params.base_branch === "string" ? params.base_branch.trim() : "";
  if (baseBranchInput === "HEAD" || baseBranchInput.startsWith("-")) {
    issues.push({
      code: "WRONG_BRANCH",
      field: "base_branch",
      message:
        baseBranchInput === "HEAD"
          ? 'Base branch cannot be detached "HEAD"; specify a named local branch (e.g. "main") or omit base_branch to auto-detect.'
          : `Invalid base branch "${baseBranchInput}" — branch names cannot start with "-".`,
    });
  }

  const normalizedMembers: InitialMemberProposal[] = [];
  const seenNames = new Set<string>();
  const rawMembers = Array.isArray(params.initial_members)
    ? params.initial_members
    : [];

  for (let i = 0; i < rawMembers.length; i++) {
    const raw = rawMembers[i];
    if (!raw || typeof raw !== "object") {
      issues.push({
        code: "INVALID_INPUT",
        field: "initial_members",
        memberName: `#${i + 1}`,
        message: `Initial member #${i + 1} must be an object.`,
      });
      continue;
    }

    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const memberTag = name || `#${i + 1}`;

    if (!name || !MEMBER_NAME_PATTERN.test(name)) {
      issues.push({
        code: "INVALID_NAME",
        field: "initial_members",
        memberName: memberTag,
        message: `Initial member name "${name}" is invalid — must match ${MEMBER_NAME_PATTERN.source} (lowercase letters, digits, hyphens; 1–32 chars starting with a–z).`,
      });
    } else if (isPrototypeKey(name)) {
      issues.push({
        code: "INVALID_NAME",
        field: "initial_members",
        memberName: name,
        message: `Initial member name "${name}" is forbidden (prototype key).`,
      });
    } else if (isReservedMemberName(name)) {
      issues.push({
        code: "INVALID_NAME",
        field: "initial_members",
        memberName: name,
        message: `Initial member name "${name}" is reserved (${RESERVED_MEMBER_NAMES.join(", ")}) and cannot be used.`,
      });
    } else if (seenNames.has(name)) {
      issues.push({
        code: "DUPLICATE_MEMBER",
        field: "initial_members",
        memberName: name,
        message: `Duplicate initial member name "${name}" — every member must have a unique name.`,
      });
    } else {
      seenNames.add(name);
    }

    if (!isValidMemberRole(raw.role)) {
      issues.push({
        code: "INVALID_INPUT",
        field: "role",
        memberName: memberTag,
        message: `Initial member "${memberTag}" has invalid role "${String(raw.role)}"; expected "worker" or "validator".`,
      });
    }

    const brief = typeof raw.brief === "string" ? raw.brief.trim() : "";
    if (!brief) {
      issues.push({
        code: "INVALID_INPUT",
        field: "brief",
        memberName: memberTag,
        message: `Initial member "${memberTag}" must have a non-empty brief.`,
      });
    }

    if (raw.workspace !== undefined && !isValidWorkspaceMode(raw.workspace)) {
      issues.push({
        code: "INVALID_INPUT",
        field: "workspace",
        memberName: memberTag,
        message: `Initial member "${memberTag}" has invalid workspace "${String(raw.workspace)}"; expected "inherit", "share", or "branch".`,
      });
    }

    let normalizedChannels: string[] | undefined;
    if (raw.channels !== undefined) {
      if (!Array.isArray(raw.channels)) {
        issues.push({
          code: "INVALID_CHANNEL",
          field: "channels",
          memberName: memberTag,
          message: `Initial member "${memberTag}" channels must be an array of channel names.`,
        });
      } else {
        const deduped: string[] = [];
        const seenChannels = new Set<string>();
        for (const ch of raw.channels) {
          const trimmedCh =
            typeof ch === "string"
              ? ch.trim().replace(/^[@#]+/, "").toLowerCase()
              : "";
          if (!trimmedCh || !CHANNEL_NAME_PATTERN.test(trimmedCh) || isPrototypeKey(trimmedCh)) {
            issues.push({
              code: "INVALID_CHANNEL",
              field: "channels",
              memberName: memberTag,
              message: `Initial member "${memberTag}" has invalid channel "${trimmedCh}" — must match ${CHANNEL_NAME_PATTERN.source}.`,
            });
            continue;
          }
          if (!seenChannels.has(trimmedCh)) {
            seenChannels.add(trimmedCh);
            deduped.push(trimmedCh);
          }
        }
        if (deduped.length > 0) {
          normalizedChannels = deduped;
        }
      }
    }

    if (
      name &&
      isValidMemberRole(raw.role) &&
      brief &&
      (raw.workspace === undefined || isValidWorkspaceMode(raw.workspace))
    ) {
      normalizedMembers.push({
        name,
        role: raw.role,
        brief,
        ...(raw.workspace !== undefined ? { workspace: raw.workspace } : {}),
        ...(normalizedChannels ? { channels: normalizedChannels } : {}),
      });
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    title,
    objective,
    strategy,
    acceptanceCriteria,
    ...(normalizedMembers.length > 0 ? { initialMembers: normalizedMembers } : {}),
  };
}

async function resolveBaseBranch(
  worktree: IWorktreeManager | undefined,
  explicitBranch: string | undefined,
  draftBranch: string | undefined,
  cwd: string,
): Promise<string> {
  const trimmedExplicit = explicitBranch?.trim();
  if (
    trimmedExplicit &&
    trimmedExplicit !== "HEAD" &&
    !trimmedExplicit.startsWith("-")
  ) {
    return trimmedExplicit;
  }
  const trimmedDraft = draftBranch?.trim();
  if (trimmedDraft && trimmedDraft !== "HEAD" && !trimmedDraft.startsWith("-")) {
    return trimmedDraft;
  }
  if (worktree) {
    try {
      const current = await worktree.getCurrentBranch(cwd);
      const trimmed = current.trim();
      if (trimmed && trimmed !== "HEAD") {
        return trimmed;
      }
    } catch {
      // Repo may not be initialized yet during upfront drafting; fall back cleanly.
    }
  }
  return "main";
}

function formatValidationErrors(issues: readonly DraftPlanValidationIssue[]): string {
  const lines: string[] = [
    `Swarm plan validation failed — please fix the following protocol error(s) and call \`${PROPOSE_SWARM_PLAN_TOOL}\` again:`,
    "",
  ];

  for (const issue of issues) {
    const targetTag = issue.memberName ? ` (${issue.memberName})` : "";
    lines.push(`- [SwarmProtocolError:${issue.code}]${targetTag} ${issue.message}`);
  }

  return lines.join("\n");
}

function extractFirstText(
  content: readonly { type?: string; text?: string }[] | undefined | null,
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

function formatInlineSnippet(value: unknown, maxChars = 88): string {
  if (typeof value !== "string") {
    return "";
  }
  const collapsed = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  return collapsed.length > maxChars
    ? `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`
    : collapsed;
}

function shortenModelSlug(model: string | undefined): string {
  const trimmed = typeof model === "string" ? model.trim() : "";
  if (!trimmed) {
    return "default";
  }
  const slashIdx = trimmed.lastIndexOf("/");
  return slashIdx >= 0 && slashIdx < trimmed.length - 1
    ? trimmed.slice(slashIdx + 1)
    : trimmed;
}

function formatRoleModelPill(
  roleTag: string,
  config: SwarmRoleModelConfig | undefined,
  theme: Theme,
): string {
  const hasModel = Boolean(config?.model?.trim());
  const slug = shortenModelSlug(config?.model);
  const effort = config?.thinkingLevel ? `(${config.thinkingLevel})` : "";
  const modelStyled = hasModel
    ? `${theme.fg("accent", slug)}${effort ? theme.fg("dim", effort) : ""}`
    : `${theme.fg("dim", "default")}${effort ? theme.fg("dim", effort) : ""}`;
  return `${theme.fg("muted", `${roleTag}:`)}${modelStyled}`;
}

function formatRoleModelsPillBar(
  roleModels: SwarmRoleModels | undefined,
  theme: Theme,
): string {
  const sep = theme.fg("dim", " · ");
  const orch = formatRoleModelPill("Orch", roleModels?.orchestrator, theme);
  const work = formatRoleModelPill("Work", roleModels?.worker, theme);
  const val = formatRoleModelPill("Val", roleModels?.validator, theme);
  const fbCount = Array.isArray(roleModels?.fallbackModels)
    ? roleModels.fallbackModels.filter(
        (m) => typeof m === "string" && m.trim().length > 0,
      ).length
    : 0;
  const fbTag = fbCount > 0 ? `${sep}${theme.fg("dim", `+${fbCount} fb`)}` : "";
  return `${theme.fg("dim", "[")}${orch}${sep}${work}${sep}${val}${fbTag}${theme.fg("dim", "]")}`;
}

function formatExpandHint(
  context:
    | { keyHint?: (keybinding: any, description: string) => string }
    | undefined,
  theme: Theme,
): string {
  const customHint =
    typeof context?.keyHint === "function"
      ? context.keyHint("app.tools.expand", "to expand")
      : undefined;
  if (typeof customHint === "string" && customHint.trim()) {
    const trimmed = customHint.trim();
    return trimmed.startsWith("(") && trimmed.endsWith(")")
      ? trimmed
      : `${theme.fg("dim", "(")}${trimmed}${theme.fg("dim", ")")}`;
  }
  return theme.fg("dim", "(Ctrl+O to expand)");
}

function isRecommendedOption(
  option: QuestionOption,
  recommended?: string,
): boolean {
  const rec = typeof recommended === "string" ? recommended.trim().toLowerCase() : "";
  const labelLower = option.label.trim().toLowerCase();
  const valueLower = option.value?.trim().toLowerCase();
  if (labelLower.startsWith("(recommended)")) {
    return true;
  }
  if (!rec) {
    return false;
  }
  return labelLower === rec || valueLower === rec;
}

function findRecommendedLabel(
  options: readonly QuestionOption[],
  recommended?: string,
): string {
  for (const opt of options) {
    if (isRecommendedOption(opt, recommended)) {
      return formatInlineSnippet(opt.label.replace(/^\(recommended\)\s*/i, ""), 28);
    }
  }
  return typeof recommended === "string" && recommended.trim()
    ? formatInlineSnippet(recommended.trim(), 28)
    : "";
}

function ensureDraftSynced(
  controller: DraftStateController,
  ctx: ExtensionContext,
): SwarmDraftState | null {
  return controller.rehydrate(ctx, { syncToolProfile: false });
}

// ============================================================================
// Tool 1: swarm_question
// ============================================================================

export function createSwarmQuestionTool(
  deps: DraftingDeps,
  draftController: DraftStateController,
) {
  return defineTool({
    name: SWARM_QUESTION_TOOL,
    label: "Swarm Question",
    description:
      "Ask the user a single focused clarifying trade-off question with optional choices and a '(Recommended)' default during Swarm drafting.",
    promptSnippet:
      "Ask the user one high-leverage clarifying question with '(Recommended)' first during Swarm planning.",
    promptGuidelines: [
      `Run fast read-only repo recon FIRST; ask 0 questions when clear, or use \`${SWARM_QUESTION_TOOL}\` only for 1 high-leverage trade-off question (put the best option first, prefixed with '(Recommended)'). Prefer \`${SWARM_QUESTIONNAIRE_TOOL}\` when asking 2–3 related questions.`,
    ],
    exposure: "model-only",
    defaultActive: false,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: SwarmQuestionParamsSchema,
    prepareArguments(raw: unknown): SwarmQuestionParams {
      if (!raw || typeof raw !== "object") {
        return raw as SwarmQuestionParams;
      }
      const obj = raw as Record<string, unknown>;
      return {
        ...(typeof obj.id === "string" ? { id: obj.id } : {}),
        question: typeof obj.question === "string" ? obj.question : "",
        ...(typeof obj.context === "string" ? { context: obj.context } : {}),
        ...(obj.options !== undefined
          ? { options: normalizeRawOptions(obj.options) }
          : {}),
        ...(typeof obj.recommended === "string" ? { recommended: obj.recommended } : {}),
        ...(typeof obj.allow_custom === "boolean"
          ? { allow_custom: obj.allow_custom }
          : {}),
      };
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questionText = params.question.trim();
      if (!questionText) {
        const rawErrId = params.id?.trim() || "question";
        return {
          isError: true,
          content: [{ type: "text", text: "Question text must not be empty." }],
          details: {
            cancelled: true,
            id: sanitizeQuestionId(rawErrId),
            question: "",
          } satisfies SwarmQuestionToolDetails,
        };
      }

      const id = sanitizeQuestionId(
        params.id?.trim() || slugifyQuestionId(questionText),
      );
      const spec: QuestionSpec = {
        id,
        question: questionText,
        ...(params.context?.trim() ? { context: params.context.trim() } : {}),
        options: normalizeRawOptions(params.options),
        ...(params.recommended?.trim() ? { recommended: params.recommended.trim() } : {}),
        allowCustom: params.allow_custom ?? true,
      };

      const response = await withModalGuard(deps, () =>
        deps.ui.askQuestion(ctx, spec, signal),
      );

      if (response.cancelled || response.answer === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `User dismissed question "${spec.question}" without answering. Continue naturally or clarify briefly in chat.`,
            },
          ],
          details: {
            cancelled: true,
            id: spec.id,
            question: spec.question,
          } satisfies SwarmQuestionToolDetails,
        };
      }

      const answer = response.answer.trim();
      const activeDraft = ensureDraftSynced(draftController, ctx);
      if (activeDraft) {
        const updated = draftController.recordQuestionnaireAnswers({
          [spec.id]: answer,
        });
        deps.onDraftChanged?.(updated, ctx);
      }

      const modeTag = response.isCustom ? " (custom)" : "";
      return {
        content: [
          {
            type: "text",
            text: `Question (${spec.id}): ${spec.question}\nAnswer: ${answer}${modeTag}`,
          },
        ],
        details: {
          cancelled: false,
          id: spec.id,
          question: spec.question,
          answer,
          isCustom: response.isCustom,
        } satisfies SwarmQuestionToolDetails,
      };
    },
    renderCall(args: SwarmQuestionParams, theme: Theme, context) {
      const isExpanded = Boolean(context?.expanded);
      const rawId =
        typeof args?.id === "string" ? formatInlineSnippet(args.id, 32) : "";
      const question =
        formatInlineSnippet(args?.question, isExpanded ? 400 : 140) || "…";
      const optionsList = normalizeRawOptions(args?.options);
      const allowCustom =
        typeof args?.allow_custom === "boolean" ? args.allow_custom : true;
      const recommended =
        typeof args?.recommended === "string"
          ? args.recommended.trim()
          : undefined;
      const optionBadge =
        optionsList.length > 0
          ? `${optionsList.length} ${optionsList.length === 1 ? "option" : "options"}${allowCustom ? " + custom" : ""}`
          : allowCustom
            ? "free-text"
            : "prompt";
      const idTag = rawId ? ` ${theme.fg("dim", `[${rawId}]`)}` : "";

      const lines: string[] = [
        `${theme.fg("accent", "❓")} ${theme.fg("toolTitle", theme.bold(SWARM_QUESTION_TOOL))}${idTag} ${theme.fg("muted", `(${optionBadge})`)}`,
        `  ${theme.fg("accent", question)}`,
      ];

      if (typeof args?.context === "string" && args.context.trim()) {
        lines.push(
          isExpanded
            ? `  ${theme.fg("muted", args.context.trim())}`
            : `  ${theme.fg("dim", formatInlineSnippet(args.context, 100))}`,
        );
      }

      if (optionsList.length > 0) {
        if (isExpanded) {
          for (let i = 0; i < optionsList.length; i++) {
            const opt = optionsList[i]!;
            const isRec = isRecommendedOption(opt, recommended);
            const recStar = isRec ? ` ${theme.fg("warning", "★")}` : "";
            const desc = opt.description
              ? ` ${theme.fg("dim", `— ${formatInlineSnippet(opt.description, 100)}`)}`
              : "";
            lines.push(
              `    ${theme.fg("muted", `${i + 1}.`)} ${theme.fg(isRec ? "accent" : "toolOutput", opt.label)}${recStar}${desc}`,
            );
          }
        } else {
          const previewChoices = optionsList
            .slice(0, 4)
            .map((opt) => {
              const isRec = isRecommendedOption(opt, recommended);
              const label = formatInlineSnippet(opt.label, 32);
              return isRec
                ? `${theme.fg("accent", label)}${theme.fg("warning", " ★")}`
                : theme.fg("toolOutput", label);
            })
            .join(theme.fg("dim", " · "));
          const moreTag =
            optionsList.length > 4
              ? theme.fg("dim", ` · +${optionsList.length - 4} more`)
              : "";
          lines.push(`  ${theme.fg("dim", "Choices:")} ${previewChoices}${moreTag}`);
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, options, theme: Theme, context) {
      const details = result?.details as SwarmQuestionToolDetails | undefined;
      const isExpanded = Boolean(options?.expanded);
      if (result?.isError || context?.isError) {
        const errText =
          extractFirstText(result?.content) || "Question failed.";
        return new Text(
          `${theme.fg("error", "✗ [ERROR]")} ${theme.fg("error", errText)}`,
          0,
          0,
        );
      }
      if (options?.isPartial) {
        return new Text(
          `${theme.fg("warning", "⏳ [AWAITING]")} ${theme.fg("muted", "Waiting for user answer…")}`,
          0,
          0,
        );
      }
      if (details?.cancelled) {
        return new Text(
          theme.fg("muted", "○ [SKIPPED] Question dismissed by user."),
          0,
          0,
        );
      }
      if (typeof details?.answer === "string") {
        const idTag =
          typeof details.id === "string" && details.id
            ? ` ${theme.fg("dim", `[${details.id}]`)}`
            : "";
        const suffix = details.isCustom ? theme.fg("warning", " (custom)") : "";
        if (isExpanded) {
          const qLine =
            typeof details.question === "string" && details.question
              ? `\n  ${theme.fg("muted", "Question:")} ${theme.fg("toolOutput", details.question)}`
              : "";
          const aLine = `\n  ${theme.fg("muted", "Answer:")}   ${theme.fg("accent", details.answer)}${suffix}`;
          return new Text(
            `${theme.fg("success", "✓ [ANSWERED]")}${idTag}${qLine}${aLine}`,
            0,
            0,
          );
        }
        const compactAns =
          formatInlineSnippet(details.answer, 96) || details.answer;
        return new Text(
          `${theme.fg("success", "✓ [ANSWERED]")}${idTag} ${theme.fg("toolOutput", compactAns)}${suffix}`,
          0,
          0,
        );
      }
      return new Text(
        theme.fg("toolOutput", extractFirstText(result?.content)),
        0,
        0,
      );
    },
  });
}

// ============================================================================
// Tool 2: swarm_questionnaire
// ============================================================================

export function createSwarmQuestionnaireTool(
  deps: DraftingDeps,
  draftController: DraftStateController,
) {
  return defineTool({
    name: SWARM_QUESTIONNAIRE_TOOL,
    label: "Swarm Questionnaire",
    description:
      "Ask 1–3 high-leverage clarifying trade-off questions in a single tabbed questionnaire modal (with '(Recommended)' placed first) during Swarm drafting.",
    promptSnippet:
      "Present 1–3 high-leverage clarifying trade-off questions together in a tabbed modal with '(Recommended)' defaults.",
    promptGuidelines: [
      `Prefer \`${SWARM_QUESTIONNAIRE_TOOL}\` over multiple sequential \`${SWARM_QUESTION_TOOL}\` calls when asking 1–3 high-leverage trade-off questions; put the best choice first prefixed with '(Recommended)' and never interrogate on obvious details.`,
    ],
    exposure: "model-only",
    defaultActive: false,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: SwarmQuestionnaireParamsSchema,
    prepareArguments(raw: unknown): SwarmQuestionnaireParams {
      if (!raw || typeof raw !== "object") {
        return raw as SwarmQuestionnaireParams;
      }
      const obj = raw as Record<string, unknown>;
      const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
      const normalizedQuestions = rawQuestions.map((q, idx) => {
        if (!q || typeof q !== "object") {
          return {
            id: `q${idx + 1}`,
            question: "",
            options: [],
          };
        }
        const item = q as Record<string, unknown>;
        const rawId =
          typeof item.id === "string" && item.id.trim()
            ? item.id.trim()
            : `q${idx + 1}`;
        return {
          id: sanitizeQuestionId(rawId),
          question: typeof item.question === "string" ? item.question : "",
          ...(typeof item.context === "string" ? { context: item.context } : {}),
          options: normalizeRawOptions(item.options),
          ...(typeof item.recommended === "string"
            ? { recommended: item.recommended }
            : {}),
          ...(typeof item.allow_custom === "boolean"
            ? { allow_custom: item.allow_custom }
            : {}),
        };
      });
      return { questions: normalizedQuestions };
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params.questions || params.questions.length === 0) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Questionnaire must include at least one question." },
          ],
          details: {
            cancelled: true,
            questionCount: 0,
            answers: {},
            error: "empty_questions",
          } satisfies SwarmQuestionnaireToolDetails,
        };
      }

      const blankIndex = params.questions.findIndex(
        (q) => typeof q.question !== "string" || q.question.trim().length === 0,
      );
      if (blankIndex !== -1) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Question #${blankIndex + 1} text must not be empty.`,
            },
          ],
          details: {
            cancelled: true,
            questionCount: params.questions.length,
            answers: {},
            error: "empty_question_text",
          } satisfies SwarmQuestionnaireToolDetails,
        };
      }

      const seenIds = new Set<string>();
      const specs: QuestionSpec[] = params.questions.map((q, idx) => {
        const baseId = sanitizeQuestionId(
          q.id.trim() || slugifyQuestionId(q.question) || `q${idx + 1}`,
        );
        let uniqueId = baseId;
        let suffix = 2;
        while (seenIds.has(uniqueId) || isPrototypeKey(uniqueId)) {
          uniqueId = `${baseId}_${suffix++}`;
        }
        seenIds.add(uniqueId);

        return {
          id: uniqueId,
          question: q.question.trim(),
          ...(q.context?.trim() ? { context: q.context.trim() } : {}),
          options: normalizeRawOptions(q.options),
          ...(q.recommended?.trim() ? { recommended: q.recommended.trim() } : {}),
          allowCustom: q.allow_custom ?? true,
        };
      });

      const result = await withModalGuard(deps, () =>
        deps.ui.askQuestionnaire(ctx, specs, signal),
      );

      if (result.cancelled) {
        return {
          content: [
            {
              type: "text",
              text: "User cancelled the questionnaire before submitting. Continue clarifying in chat or adjust based on their feedback.",
            },
          ],
          details: {
            cancelled: true,
            questionCount: specs.length,
            answers: {},
          } satisfies SwarmQuestionnaireToolDetails,
        };
      }

      const mergedAnswers: Record<string, string> = {};
      if (result.answers && typeof result.answers === "object") {
        for (const [k, v] of Object.entries(result.answers)) {
          if (typeof v === "string") {
            mergedAnswers[sanitizeQuestionId(k)] = v;
          }
        }
      }
      for (const item of result.items) {
        if (item.id) {
          const safeItemId = sanitizeQuestionId(item.id);
          if (!Object.hasOwn(mergedAnswers, safeItemId)) {
            mergedAnswers[safeItemId] = item.answer;
          }
        }
      }

      const activeDraft = ensureDraftSynced(draftController, ctx);
      if (activeDraft && Object.keys(mergedAnswers).length > 0) {
        const updated = draftController.recordQuestionnaireAnswers(mergedAnswers);
        deps.onDraftChanged?.(updated, ctx);
      }

      const summaryLines: string[] = ["Questionnaire answers recorded:"];
      if (result.items.length > 0) {
        for (const item of result.items) {
          const customTag = item.isCustom ? " (custom)" : "";
          summaryLines.push(
            `- [${sanitizeQuestionId(item.id)}] ${item.question}\n  Answer: ${item.answer}${customTag}`,
          );
        }
      } else {
        for (const spec of specs) {
          if (Object.hasOwn(mergedAnswers, spec.id)) {
            const ans = mergedAnswers[spec.id];
            summaryLines.push(`- [${spec.id}] ${spec.question}\n  Answer: ${ans}`);
          }
        }
      }

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: {
          cancelled: false,
          questionCount: specs.length,
          answers: mergedAnswers,
          items: result.items,
        } satisfies SwarmQuestionnaireToolDetails,
      };
    },
    renderCall(args: SwarmQuestionnaireParams, theme: Theme, context) {
      const isExpanded = Boolean(context?.expanded);
      const rawQuestions = Array.isArray(args?.questions) ? args.questions : [];
      const safeQuestions = rawQuestions.filter(
        (q): q is SwarmQuestionnaireParams["questions"][number] =>
          Boolean(q && typeof q === "object"),
      );
      const count = rawQuestions.length;
      let totalOptions = 0;
      for (const q of safeQuestions) {
        totalOptions += normalizeRawOptions(q.options).length;
      }

      const previewIds =
        safeQuestions.length > 0
          ? safeQuestions
              .map((q, idx) =>
                typeof q.id === "string" && q.id.trim()
                  ? formatInlineSnippet(q.id, 24)
                  : `q${idx + 1}`,
              )
              .join(", ")
          : "…";
      const countMeta = `${count} ${count === 1 ? "question" : "questions"}${totalOptions > 0 ? ` · ${totalOptions} ${totalOptions === 1 ? "option" : "options"}` : ""}: ${previewIds}`;

      const lines: string[] = [
        `${theme.fg("accent", "📋")} ${theme.fg("toolTitle", theme.bold(SWARM_QUESTIONNAIRE_TOOL))} ${theme.fg("muted", `(${countMeta})`)}`,
      ];

      const visibleQuestions = isExpanded
        ? safeQuestions
        : safeQuestions.slice(0, 4);
      for (let idx = 0; idx < visibleQuestions.length; idx++) {
        const q = visibleQuestions[idx]!;
        const qId =
          typeof q.id === "string" && q.id.trim()
            ? formatInlineSnippet(q.id, 24)
            : `q${idx + 1}`;
        const qText =
          formatInlineSnippet(q.question, isExpanded ? 300 : 88) || "…";
        const opts = normalizeRawOptions(q.options);
        const recRaw =
          typeof q.recommended === "string" ? q.recommended.trim() : undefined;
        const recLabel = findRecommendedLabel(opts, recRaw);
        const optMeta = `${opts.length} ${opts.length === 1 ? "option" : "options"}${recLabel ? ` · ★ ${recLabel}` : ""}`;
        lines.push(
          `  ${theme.fg("muted", `${idx + 1}.`)} ${theme.fg("dim", `[${qId}]`)} ${theme.fg("accent", qText)} ${theme.fg("muted", `(${optMeta})`)}`,
        );

        if (isExpanded) {
          if (typeof q.context === "string" && q.context.trim()) {
            lines.push(`     ${theme.fg("dim", q.context.trim())}`);
          }
          for (const opt of opts) {
            const isRec = isRecommendedOption(opt, recRaw);
            const recStar = isRec ? ` ${theme.fg("warning", "★")}` : "";
            const desc = opt.description
              ? ` ${theme.fg("dim", `— ${formatInlineSnippet(opt.description, 88)}`)}`
              : "";
            lines.push(
              `     ${theme.fg("muted", "•")} ${theme.fg(isRec ? "accent" : "toolOutput", opt.label)}${recStar}${desc}`,
            );
          }
        }
      }

      if (!isExpanded && safeQuestions.length > 4) {
        lines.push(
          `  ${theme.fg("dim", `… +${safeQuestions.length - 4} more question(s)`)} ${formatExpandHint(context, theme)}`,
        );
      }

      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, options, theme: Theme, context) {
      const details = result?.details as SwarmQuestionnaireToolDetails | undefined;
      const isExpanded = Boolean(options?.expanded);
      if (result?.isError || context?.isError || Boolean(details?.error)) {
        const errText =
          extractFirstText(result?.content) ||
          (typeof details?.error === "string" && details.error
            ? details.error
            : "Questionnaire failed.");
        return new Text(
          `${theme.fg("error", "✗ [ERROR]")} ${theme.fg("error", errText)}`,
          0,
          0,
        );
      }
      if (options?.isPartial) {
        return new Text(
          `${theme.fg("warning", "⏳ [AWAITING]")} ${theme.fg("muted", "Waiting for questionnaire submission…")}`,
          0,
          0,
        );
      }
      if (details?.cancelled) {
        return new Text(
          theme.fg("muted", "○ [CANCELLED] Questionnaire cancelled by user."),
          0,
          0,
        );
      }

      const rawAnswers =
        details?.answers && typeof details.answers === "object"
          ? details.answers
          : {};
      const answerEntries = Object.entries(rawAnswers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      const answeredCount = answerEntries.length;
      const totalCount =
        typeof details?.questionCount === "number" && details.questionCount > 0
          ? details.questionCount
          : answeredCount;

      if (isExpanded) {
        const body = extractFirstText(result?.content);
        const header = `${theme.fg("success", "✓ [RECORDED]")} ${theme.fg("toolOutput", `Recorded ${answeredCount}/${totalCount} questionnaire answer(s)`)}`;
        return new Text(
          body ? `${header}\n${theme.fg("toolOutput", body)}` : header,
          0,
          0,
        );
      }

      const items = Array.isArray(details?.items) ? details.items : [];
      const customIds = new Set<string>();
      for (const item of items) {
        if (item && item.isCustom && typeof item.id === "string") {
          customIds.add(sanitizeQuestionId(item.id));
        }
      }

      const totalSuffix =
        totalCount > answeredCount
          ? theme.fg("muted", ` (of ${totalCount})`)
          : "";
      const expandHint =
        answeredCount > 0 ? ` ${formatExpandHint(context, theme)}` : "";
      const lines: string[] = [
        `${theme.fg("success", "✓ [RECORDED]")} ${theme.fg("toolOutput", `Recorded ${answeredCount} questionnaire answer(s).`)}${totalSuffix}${expandHint}`,
      ];

      for (const [key, ans] of answerEntries.slice(0, 4)) {
        const customSuffix = customIds.has(key)
          ? theme.fg("warning", " (custom)")
          : "";
        lines.push(
          `  ${theme.fg("muted", "•")} ${theme.fg("accent", key)}${theme.fg("dim", ":")} ${theme.fg("toolOutput", formatInlineSnippet(ans, 68) || ans)}${customSuffix}`,
        );
      }
      if (answerEntries.length > 4) {
        lines.push(
          `  ${theme.fg("dim", `… +${answerEntries.length - 4} more answer(s)`)}`,
        );
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

// ============================================================================
// Tool 3: propose_swarm_plan
// ============================================================================

export function createProposeSwarmPlanTool(
  deps: DraftingDeps,
  draftController: DraftStateController,
) {
  return defineTool({
    name: PROPOSE_SWARM_PLAN_TOOL,
    label: "Swarm Plan",
    description:
      "Validate a Flexible Dynamic Swarm Plan, render a compact expandable summary card (with full strategy, acceptance criteria, 3-role models, and optional initial members on expand), and ask the user to Confirm, Continue refining, or Cancel.",
    promptSnippet:
      "Validate and present a Flexible Dynamic Swarm Plan (title, objective, strategy, acceptance criteria, optional initial members) for user confirmation before launching.",
    promptGuidelines: [
      `Call \`${PROPOSE_SWARM_PLAN_TOOL}\` once requirements are clear with wave-by-wave disjoint file/directory ownership in \`strategy\`, exact runnable verification commands using already-installed repo scripts (no speculative \`npx -y\` downloads) in \`acceptance_criteria\`, and wave-1 workers only in \`initial_members\` (spawn \`validator\` on demand once workers commit/post \`[done]\`); do NOT duplicate the full plan in prose beforehand because the expandable proposal card and confirmation modal present it automatically.`,
    ],
    exposure: "model-only",
    defaultActive: false,
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: ProposeSwarmPlanParamsSchema,
    prepareArguments(raw: unknown): ProposeSwarmPlanParams {
      if (!raw || typeof raw !== "object") {
        return raw as ProposeSwarmPlanParams;
      }
      const obj = raw as Record<string, unknown>;
      const prepared: Record<string, unknown> = {
        ...obj,
        title: typeof obj.title === "string" ? obj.title : "",
        objective: typeof obj.objective === "string" ? obj.objective : "",
        strategy: typeof obj.strategy === "string" ? obj.strategy : "",
        acceptance_criteria:
          typeof obj.acceptance_criteria === "string"
            ? obj.acceptance_criteria
            : "",
      };

      if (Array.isArray(obj.initial_members)) {
        prepared.initial_members = obj.initial_members.map((item) => {
          if (!item || typeof item !== "object") {
            return item;
          }
          const m = item as Record<string, unknown>;
          return {
            ...m,
            name: typeof m.name === "string" ? m.name : "",
            brief: typeof m.brief === "string" ? m.brief : "",
            ...(Array.isArray(m.channels)
              ? {
                  channels: m.channels.filter(
                    (c): c is string => typeof c === "string",
                  ),
                }
              : {}),
          };
        });
      }

      return prepared as ProposeSwarmPlanParams;
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const currentDraft = ensureDraftSynced(draftController, ctx);
      const settings = deps.getSettings();

      // Step 1: Pre-modal validation (non-empty required fields + valid/unique/non-reserved initial_members)
      const validation = validateProposedSwarmPlan(params);
      if (!validation.valid) {
        return {
          isError: true,
          content: [{ type: "text", text: formatValidationErrors(validation.issues) }],
          details: {
            outcome: "validation_error",
            errors: validation.issues,
            errorCode: validation.issues[0]?.code,
            errorMessage: validation.issues[0]?.message,
          } satisfies ProposeSwarmPlanToolDetails,
        };
      }

      // Step 2: Resolve baseBranch, concurrency, validator policy, and 3-role model trio
      const baseBranch = await resolveBaseBranch(
        deps.worktree,
        params.base_branch,
        currentDraft?.baseBranch,
        ctx.cwd,
      );
      const maxConcurrency = sanitizePositiveInt(
        params.max_concurrency ??
          currentDraft?.maxConcurrency ??
          settings.maxConcurrency,
        settings.maxConcurrency,
      );
      const validatorEnabled =
        params.validator_enabled ??
        currentDraft?.validatorEnabled ??
        settings.validatorEnabled;
      const roleModels = buildRoleModelsFromSettings(settings);

      const proposedPlan: ProposedSwarmPlan = {
        title: validation.title,
        objective: validation.objective,
        strategy: validation.strategy,
        acceptanceCriteria: validation.acceptanceCriteria,
        baseBranch,
        maxConcurrency,
        validatorEnabled,
        roleModels,
        ...(validation.initialMembers
          ? { initialMembers: validation.initialMembers }
          : {}),
      };

      // Step 3: Show confirmation modal (or auto-confirm for `/swarm direct`)
      const autoConfirm = Boolean(currentDraft?.autoConfirm);
      let outcome: ProposalDialogOutcome;
      if (autoConfirm) {
        outcome = {
          action: "confirm",
          validatorEnabled,
          maxConcurrency,
        };
      } else {
        const extraOpts = deps.confirmProposalOptions?.(ctx, proposedPlan);
        outcome = await withModalGuard(deps, () =>
          deps.ui.confirmProposal(ctx, proposedPlan, {
            ...extraOpts,
            mode: currentDraft?.mode ?? "swarm",
            signal,
          }),
        );
      }

      // Step 4: Execute user's decision
      if (outcome.action === "confirm") {
        const launchComment = outcome.feedback?.trim();
        const finalPlan: ProposedSwarmPlan = {
          ...proposedPlan,
          strategy: launchComment
            ? `${proposedPlan.strategy}\n\nUser launch guidance: ${launchComment}`
            : proposedPlan.strategy,
          ...(outcome.roleModels ? { roleModels: outcome.roleModels } : {}),
          ...(launchComment ? { feedback: launchComment } : {}),
          validatorEnabled: outcome.validatorEnabled,
          maxConcurrency: sanitizePositiveInt(
            outcome.maxConcurrency,
            proposedPlan.maxConcurrency,
          ),
        };

        let run: SwarmRunState;
        try {
          run = await deps.onPlanConfirmed(finalPlan, ctx);
        } catch (err) {
          if (isSwarmProtocolError(err)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `[SwarmProtocolError:${err.code}] Failed to launch Swarm run: ${err.message}`,
                },
              ],
              details: {
                outcome: "error",
                plan: finalPlan,
                errorCode: err.code,
                errorMessage: err.message,
              } satisfies ProposeSwarmPlanToolDetails,
            };
          }
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to launch Swarm run: ${message}`,
              },
            ],
            details: {
              outcome: "error",
              plan: finalPlan,
              errorMessage: message,
            } satisfies ProposeSwarmPlanToolDetails,
          };
        }

        // Clear draft and swap tool profile to `"running"` (the 4 core Swarm tools)
        draftController.clear("running");
        deps.onDraftChanged?.(null, ctx);

        const summary = formatProposalTranscriptSummary(finalPlan);
        const memberCount =
          run.memberOrder.length || finalPlan.initialMembers?.length || 0;
        const memberLabel =
          memberCount > 0 ? `, ${memberCount} initial member(s)` : "";
        const guidanceLine = launchComment
          ? `\nUser guidance: ${launchComment}`
          : "";

        return {
          content: [
            {
              type: "text",
              text: `${summary}\n\n---\nStatus: CONFIRMED — Swarm run \`${run.id}\` ("${run.title}") created and launched on \`${run.baseBranch}\` (concurrency: ${finalPlan.maxConcurrency}, Validator: ${finalPlan.validatorEnabled ? "ON" : "OFF"}${memberLabel}).${guidanceLine}`,
            },
          ],
          details: {
            outcome: "confirmed",
            runId: run.id,
            plan: finalPlan,
            autoConfirmed: autoConfirm,
          } satisfies ProposeSwarmPlanToolDetails,
          terminate: true,
        };
      }

      if (outcome.action === "cancel") {
        draftController.clear(
          deps.onDraftChanged
            ? undefined
            : currentDraft?.mode === "tweak" || currentDraft?.targetRunId
              ? "running"
              : "idle",
        );
        deps.onDraftChanged?.(null, ctx);

        const summary = formatProposalTranscriptSummary(proposedPlan);

        return {
          content: [
            {
              type: "text",
              text: `${summary}\n\n---\nStatus: CANCELLED — Swarm draft discarded and normal tools restored. No run or worktrees were created.`,
            },
          ],
          details: {
            outcome: "cancelled",
            plan: proposedPlan,
          } satisfies ProposeSwarmPlanToolDetails,
          terminate: true,
        };
      }

      // "continue" (refine) — keep draft active and persist any toggled Validator / concurrency settings
      const refinedValidatorEnabled = outcome.validatorEnabled;
      const refinedMaxConcurrency = sanitizePositiveInt(
        outcome.maxConcurrency,
        proposedPlan.maxConcurrency,
      );
      const refinedPlan: ProposedSwarmPlan = {
        ...proposedPlan,
        roleModels:
          outcome.roleModels ?? buildRoleModelsFromSettings(deps.getSettings()),
        validatorEnabled: refinedValidatorEnabled,
        maxConcurrency: refinedMaxConcurrency,
      };

      let updatedDraft: SwarmDraftState | null;
      if (draftController.isActive()) {
        updatedDraft = draftController.update({
          validatorEnabled: refinedValidatorEnabled,
          maxConcurrency: refinedMaxConcurrency,
          baseBranch,
        });
      } else {
        updatedDraft = draftController.start({
          mode: currentDraft?.mode ?? "swarm",
          seed: currentDraft?.seed || validation.objective,
          targetRunId: currentDraft?.targetRunId,
          validatorEnabled: refinedValidatorEnabled,
          maxConcurrency: refinedMaxConcurrency,
          baseBranch,
          questionnaireEcho: currentDraft?.questionnaireEcho,
        });
      }
      deps.onDraftChanged?.(updatedDraft, ctx);

      const summary = formatProposalTranscriptSummary(refinedPlan);
      const feedbackNote = outcome.feedback?.trim()
        ? `\nUser feedback: ${outcome.feedback.trim()}`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n---\nStatus: CONTINUE REFINING — Draft remains active (Validator: ${refinedValidatorEnabled ? "ON" : "OFF"}, concurrency: ${refinedMaxConcurrency}).${feedbackNote}\nAsk the user what they would like to adjust, refine the Dynamic Swarm Plan, and call \`${PROPOSE_SWARM_PLAN_TOOL}\` again when ready.`,
          },
        ],
        details: {
          outcome: "continue",
          plan: refinedPlan,
          ...(outcome.feedback?.trim()
            ? { feedback: outcome.feedback.trim() }
            : {}),
        } satisfies ProposeSwarmPlanToolDetails,
      };
    },
    renderCall(args: ProposeSwarmPlanParams, theme: Theme, context) {
      const isExpanded = Boolean(context?.expanded);
      const isPartial = Boolean(context?.isPartial);
      const settings = deps.getSettings();
      const draft = draftController.getDraft();
      const rawMembers = Array.isArray(args?.initial_members)
        ? args.initial_members
        : [];
      const previewMembers: InitialMemberProposal[] = rawMembers
        .filter((item): item is InitialMemberProposalParams =>
          Boolean(item && typeof item === "object"),
        )
        .map((m) => ({
          name: typeof m.name === "string" ? m.name.trim() : "",
          role: isValidMemberRole(m.role) ? m.role : "worker",
          brief: typeof m.brief === "string" ? m.brief.trim() : "",
          ...(isValidWorkspaceMode(m.workspace) ? { workspace: m.workspace } : {}),
          ...(Array.isArray(m.channels) && m.channels.length > 0
            ? {
                channels: m.channels.filter(
                  (c): c is string => typeof c === "string" && c.trim().length > 0,
                ),
              }
            : {}),
        }));

      const draftBranch =
        draft?.baseBranch && draft.baseBranch !== "HEAD"
          ? draft.baseBranch
          : undefined;
      const previewPlan: ProposedSwarmPlan = {
        title: typeof args?.title === "string" ? args.title.trim() : "",
        objective: typeof args?.objective === "string" ? args.objective.trim() : "",
        strategy: typeof args?.strategy === "string" ? args.strategy.trim() : "",
        acceptanceCriteria:
          typeof args?.acceptance_criteria === "string"
            ? args.acceptance_criteria.trim()
            : "",
        baseBranch:
          (typeof args?.base_branch === "string" && args.base_branch.trim()) ||
          draftBranch ||
          "auto",
        maxConcurrency: sanitizePositiveInt(
          typeof args?.max_concurrency === "number"
            ? args.max_concurrency
            : draft?.maxConcurrency ?? settings.maxConcurrency,
          settings.maxConcurrency,
        ),
        validatorEnabled:
          typeof args?.validator_enabled === "boolean"
            ? args.validator_enabled
            : draft?.validatorEnabled ?? settings.validatorEnabled,
        roleModels: buildRoleModelsFromSettings(settings),
        ...(previewMembers.length > 0 ? { initialMembers: previewMembers } : {}),
      };

      const modeBadge = draft?.autoConfirm
        ? theme.fg("accent", "[DIRECT]")
        : draft?.mode === "tweak"
          ? theme.fg("warning", "[TWEAK]")
          : theme.fg("accent", "[PROPOSAL]");
      const memberMeta =
        previewMembers.length > 0
          ? ` · ${previewMembers.length} ${previewMembers.length === 1 ? "member" : "members"}`
          : " · dynamic waves";
      const metaPill = theme.fg(
        "dim",
        `(${previewPlan.baseBranch} · max:${previewPlan.maxConcurrency} · validator:${previewPlan.validatorEnabled ? "ON" : "OFF"}${memberMeta})`,
      );
      const modelPills = formatRoleModelsPillBar(previewPlan.roleModels, theme);
      const titleLine = `${theme.fg("accent", "🗺")} ${theme.fg("toolTitle", theme.bold("Swarm Plan"))} ${theme.fg("muted", `(${PROPOSE_SWARM_PLAN_TOOL})`)} ${modeBadge} ${metaPill}`;

      if (!isExpanded) {
        const titleSnippet =
          formatInlineSnippet(previewPlan.title, 72) ||
          (isPartial ? "Drafting…" : "(pending)");
        const streamingTag = isPartial
          ? previewPlan.title
            ? ` ${theme.fg("warning", "⏳ streaming…")}`
            : ` ${theme.fg("warning", "⏳")}`
          : "";
        const expandHint = formatExpandHint(context, theme);
        const lines: string[] = [
          titleLine,
          `  ${theme.fg("muted", "Title:")} ${theme.fg("accent", titleSnippet)}${streamingTag} ${expandHint}`,
          `  ${theme.fg("muted", "Role Models:")} ${modelPills}`,
        ];
        if (previewMembers.length > 0) {
          const memberTags = previewMembers
            .slice(0, 4)
            .map((m) => {
              const name = formatInlineSnippet(m.name, 24) || "(unnamed)";
              const ws = m.workspace ?? "inherit";
              return `${theme.fg("accent", name)}${theme.fg("dim", `(${m.role}/${ws})`)}`;
            })
            .join(theme.fg("dim", " · "));
          const moreTag =
            previewMembers.length > 4
              ? theme.fg("dim", ` · +${previewMembers.length - 4} more`)
              : "";
          lines.push(`  ${theme.fg("muted", "Initial Wave:")} ${memberTags}${moreTag}`);
        }
        return new Text(lines.join("\n"), 0, 0);
      }

      const summary = formatProposalTranscriptSummary(previewPlan);
      const header = `${titleLine}\n  ${theme.fg("muted", "Role Models:")} ${modelPills}`;
      return new Text(`${header}\n\n${theme.fg("toolOutput", summary)}`, 0, 0);
    },
    renderResult(result, options, theme: Theme, context) {
      const details = result?.details as ProposeSwarmPlanToolDetails | undefined;
      const isExpanded = Boolean(options?.expanded);

      if (
        result?.isError ||
        context?.isError ||
        details?.outcome === "validation_error" ||
        details?.outcome === "error"
      ) {
        const issueCount = Array.isArray(details?.errors)
          ? details.errors.length
          : 0;
        const badge =
          details?.outcome === "validation_error"
            ? theme.fg(
                "error",
                `✗ [VALIDATION ERROR${issueCount > 0 ? ` · ${issueCount} ${issueCount === 1 ? "issue" : "issues"}` : ""}]`,
              )
            : theme.fg("error", "✗ [ERROR]");
        const errBody =
          extractFirstText(result?.content) ||
          details?.errorMessage ||
          "Swarm Plan failed.";
        return new Text(`${badge} ${theme.fg("error", errBody)}`, 0, 0);
      }

      if (options?.isPartial) {
        return new Text(
          `${theme.fg("warning", "⏳ [AWAITING]")} ${theme.fg("muted", "Awaiting Swarm Plan confirmation…")}`,
          0,
          0,
        );
      }

      if (isExpanded) {
        const body = extractFirstText(result?.content);
        let statusHeader = "";
        if (details?.outcome === "confirmed") {
          const badge = details.autoConfirmed
            ? theme.fg("success", "✓ [CONFIRMED · DIRECT]")
            : theme.fg("success", "✓ [CONFIRMED]");
          const runTag = details.runId
            ? ` ${theme.fg("accent", details.runId)}`
            : "";
          const pills = details.plan?.roleModels
            ? ` ${formatRoleModelsPillBar(details.plan.roleModels, theme)}`
            : "";
          statusHeader = `${badge}${runTag}${pills}\n`;
        } else if (details?.outcome === "continue") {
          const pills = details.plan?.roleModels
            ? ` ${formatRoleModelsPillBar(details.plan.roleModels, theme)}`
            : "";
          statusHeader = `${theme.fg("warning", "✎ [REFINING]")}${pills}\n`;
        } else if (details?.outcome === "cancelled") {
          statusHeader = `${theme.fg("muted", "✕ [CANCELLED]")}\n`;
        }
        return new Text(
          `${statusHeader}${theme.fg("toolOutput", body)}`,
          0,
          0,
        );
      }

      if (details?.outcome === "confirmed") {
        const statusBadge = details.autoConfirmed
          ? theme.fg("success", "✓ [CONFIRMED · DIRECT]")
          : theme.fg("success", "✓ [CONFIRMED]");
        const autoTag = details.autoConfirmed ? " (direct)" : "";
        const flagsSuffix = details.plan
          ? ` (Validator: ${details.plan.validatorEnabled ? "ON" : "OFF"}, concurrency: ${details.plan.maxConcurrency})`
          : "";
        const expandHint = ` ${formatExpandHint(context, theme)}`;
        const lines: string[] = [
          `${statusBadge} ${theme.fg("toolOutput", `Swarm Plan confirmed${autoTag} — launched run ${details.runId ?? ""}${flagsSuffix}`)}${expandHint}`,
        ];
        if (details.plan) {
          const metaParts: string[] = [];
          if (details.plan.baseBranch) {
            metaParts.push(
              `${theme.fg("muted", "branch:")}${theme.fg("accent", details.plan.baseBranch)}`,
            );
          }
          const memberCount = details.plan.initialMembers?.length ?? 0;
          if (memberCount > 0) {
            metaParts.push(
              theme.fg(
                "muted",
                `${memberCount} initial ${memberCount === 1 ? "member" : "members"}`,
              ),
            );
          }
          if (details.plan.roleModels) {
            metaParts.push(
              formatRoleModelsPillBar(details.plan.roleModels, theme),
            );
          }
          if (metaParts.length > 0) {
            lines.push(`  ${metaParts.join(theme.fg("dim", " · "))}`);
          }
          const note = formatInlineSnippet(details.plan.feedback, 96);
          if (note) {
            lines.push(
              `  ${theme.fg("muted", "Note:")} ${theme.fg("toolOutput", note)}`,
            );
          }
        }
        return new Text(lines.join("\n"), 0, 0);
      }

      if (details?.outcome === "cancelled") {
        return new Text(
          `${theme.fg("muted", "✕ [CANCELLED] Swarm Plan cancelled — draft discarded.")}`,
          0,
          0,
        );
      }

      if (details?.outcome === "continue") {
        const validator = details.plan?.validatorEnabled ? "ON" : "OFF";
        const concurrency = details.plan?.maxConcurrency;
        const suffix =
          concurrency !== undefined
            ? `Validator: ${validator}, concurrency: ${concurrency}`
            : `Validator: ${validator}`;
        const expandHint = ` ${formatExpandHint(context, theme)}`;
        const lines: string[] = [
          `${theme.fg("warning", "✎ [REFINING]")} ${theme.fg("toolOutput", `Continuing Swarm Plan refinement (${suffix}).`)}${expandHint}`,
        ];
        if (details.plan?.roleModels) {
          lines.push(
            `  ${theme.fg("muted", "Models:")} ${formatRoleModelsPillBar(details.plan.roleModels, theme)}`,
          );
        }
        const feedback = formatInlineSnippet(details.feedback, 96);
        if (feedback) {
          lines.push(
            `  ${theme.fg("muted", "Feedback:")} ${theme.fg("toolOutput", feedback)}`,
          );
        }
        return new Text(lines.join("\n"), 0, 0);
      }

      return new Text(
        theme.fg("toolOutput", extractFirstText(result?.content)),
        0,
        0,
      );
    },
  });
}

// ============================================================================
// Registration Helper
// ============================================================================

export function createDraftingTools(
  pi: ExtensionAPI,
  deps: DraftingDeps,
): {
  tools: ToolDefinition<any, any, any>[];
  draftController: DraftStateController;
} {
  const draftController =
    deps.draftController ??
    new DraftStateController(
      pi,
      {
        onModalEnter: deps.onModalEnter,
        onModalExit: deps.onModalExit,
      },
      deps.getSettings,
    );

  const tools: ToolDefinition<any, any, any>[] = [
    createSwarmQuestionTool(deps, draftController),
    createSwarmQuestionnaireTool(deps, draftController),
    createProposeSwarmPlanTool(deps, draftController),
  ];

  return { tools, draftController };
}

export function registerDraftingTools(
  pi: ExtensionAPI,
  deps: DraftingDeps,
): DraftStateController {
  const { tools, draftController } = createDraftingTools(pi, deps);
  for (const tool of tools) {
    pi.registerTool(tool);
  }
  return draftController;
}

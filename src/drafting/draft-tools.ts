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
// Parameter Schemas (Google-compatible — zero anyOf unions; StringEnum for enums)
// ============================================================================

const QuestionOptionSchema = Type.Object({
  label: Type.String({ description: "Short choice label displayed to the user." }),
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
  question: Type.String({ description: "Clear, concise clarifying question for the user." }),
  context: Type.Optional(
    Type.String({ description: "Optional brief repo-grounded context or tradeoff note." }),
  ),
  options: Type.Optional(
    Type.Array(QuestionOptionSchema, {
      description: "Suggested answer choices for the user to select from.",
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
  question: Type.String({ description: "Clear, concise question text." }),
  context: Type.Optional(
    Type.String({ description: "Optional brief context or tradeoff grounded in the repo." }),
  ),
  options: Type.Array(QuestionOptionSchema, {
    minItems: 1,
    description: "Suggested options for this question.",
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
    description: "Ordered list of 2–4 related clarifying questions shown in a tabbed modal.",
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
      "Public assignment posted on the shared Message Board: what this member owns, constraints, and what done looks like.",
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
      "Phased dynamic orchestration plan — how the Orchestrator will scout, partition work, spawn/adapt members wave-by-wave, and verify results on the shared Message Board.",
  }),
  acceptance_criteria: Type.String({
    description:
      'Concrete, testable definition of "what done looks like" (commands, test suites, typechecks, and behavioral checks).',
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
        "Optional initial researchers/scouts or first wave of workers/validators to spawn at launch. Leave omitted/empty to spawn dynamically after launch.",
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
  content: readonly { type: string; text?: string }[],
): string {
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return "";
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
      "Ask the user a single focused clarifying question with optional choices and a recommended default during Swarm drafting.",
    promptSnippet:
      "Ask the user one clarifying question with options and a recommended default during Swarm planning.",
    promptGuidelines: [
      `Use \`${SWARM_QUESTION_TOOL}\` only for a single genuine ambiguity during Swarm drafting; prefer \`${SWARM_QUESTIONNAIRE_TOOL}\` when you have 2–4 related questions.`,
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
    renderCall(args: SwarmQuestionParams, theme: Theme) {
      const question = args?.question ? args.question.trim() : "…";
      return new Text(
        `${theme.fg("toolTitle", theme.bold(SWARM_QUESTION_TOOL))} ${theme.fg("accent", question)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme: Theme) {
      const details = result.details as SwarmQuestionToolDetails | undefined;
      if (result.isError) {
        return new Text(theme.fg("error", extractFirstText(result.content)), 0, 0);
      }
      if (details?.cancelled) {
        return new Text(theme.fg("muted", "Question dismissed by user."), 0, 0);
      }
      if (details?.answer !== undefined) {
        const suffix = details.isCustom ? theme.fg("dim", " (custom)") : "";
        return new Text(
          `${theme.fg("success", "✓")} ${theme.fg("toolOutput", details.answer)}${suffix}`,
          0,
          0,
        );
      }
      return new Text(theme.fg("toolOutput", extractFirstText(result.content)), 0, 0);
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
      "Ask 2–4 related clarifying questions in a single tabbed questionnaire modal during Swarm drafting.",
    promptSnippet:
      "Present 2–4 related clarifying questions together in a tabbed modal with recommended defaults.",
    promptGuidelines: [
      `Prefer \`${SWARM_QUESTIONNAIRE_TOOL}\` over multiple sequential \`${SWARM_QUESTION_TOOL}\` calls whenever you have 2–4 related clarifying questions.`,
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
    renderCall(args: SwarmQuestionnaireParams, theme: Theme) {
      const count = Array.isArray(args?.questions) ? args.questions.length : 0;
      const preview =
        count > 0
          ? args.questions.map((q) => q.id || "?").join(", ")
          : "…";
      return new Text(
        `${theme.fg("toolTitle", theme.bold(SWARM_QUESTIONNAIRE_TOOL))} ${theme.fg("muted", `(${count} questions: ${preview})`)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme: Theme) {
      const details = result.details as SwarmQuestionnaireToolDetails | undefined;
      if (result.isError) {
        return new Text(theme.fg("error", extractFirstText(result.content)), 0, 0);
      }
      if (details?.cancelled) {
        return new Text(theme.fg("muted", "Questionnaire cancelled by user."), 0, 0);
      }
      if (options.expanded) {
        return new Text(theme.fg("toolOutput", extractFirstText(result.content)), 0, 0);
      }
      const answeredCount = details ? Object.keys(details.answers).length : 0;
      return new Text(
        `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Recorded ${answeredCount} questionnaire answer(s).`)}`,
        0,
        0,
      );
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
      "Validate a Flexible Dynamic Swarm Plan, render the full formatted strategy, acceptance criteria, 3-role models, and optional initial members into scrollback, and ask the user to Confirm, Continue refining, or Cancel.",
    promptSnippet:
      "Validate and present a Flexible Dynamic Swarm Plan (title, objective, strategy, acceptance criteria, optional initial members) for user confirmation before launching.",
    promptGuidelines: [
      `Call \`${PROPOSE_SWARM_PLAN_TOOL}\` once requirements are clear; do NOT duplicate the full plan in prose beforehand because \`${PROPOSE_SWARM_PLAN_TOOL}\` renders the full formatted proposal into scrollback automatically.`,
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
    renderCall(args: ProposeSwarmPlanParams, theme: Theme) {
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
          draft?.baseBranch ||
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

      const summary = formatProposalTranscriptSummary(previewPlan);
      const header = `${theme.fg("toolTitle", theme.bold("Swarm Plan"))} ${theme.fg("muted", `(${PROPOSE_SWARM_PLAN_TOOL})`)}`;
      return new Text(`${header}\n${theme.fg("toolOutput", summary)}`, 0, 0);
    },
    renderResult(result, options, theme: Theme) {
      const details = result.details as ProposeSwarmPlanToolDetails | undefined;
      if (
        result.isError ||
        details?.outcome === "validation_error" ||
        details?.outcome === "error"
      ) {
        return new Text(theme.fg("error", extractFirstText(result.content)), 0, 0);
      }
      if (options.expanded) {
        return new Text(theme.fg("toolOutput", extractFirstText(result.content)), 0, 0);
      }
      if (details?.outcome === "confirmed") {
        const autoTag = details.autoConfirmed ? " (direct)" : "";
        const flagsSuffix = details.plan
          ? ` (Validator: ${details.plan.validatorEnabled ? "ON" : "OFF"}, concurrency: ${details.plan.maxConcurrency})`
          : "";
        return new Text(
          `${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Swarm Plan confirmed${autoTag} — launched run ${details.runId ?? ""}${flagsSuffix}`)}`,
          0,
          0,
        );
      }
      if (details?.outcome === "cancelled") {
        return new Text(
          `${theme.fg("muted", "✕ Swarm Plan cancelled — draft discarded.")}`,
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
        return new Text(
          `${theme.fg("warning", "✎")} ${theme.fg("toolOutput", `Continuing Swarm Plan refinement (${suffix}).`)}`,
          0,
          0,
        );
      }
      return new Text(theme.fg("toolOutput", extractFirstText(result.content)), 0, 0);
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

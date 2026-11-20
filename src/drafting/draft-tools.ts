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
  DEFAULT_SWARM_SETTINGS,
  PROPOSE_SWARM_PLAN_TOOL,
  SWARM_QUESTIONNAIRE_TOOL,
  SWARM_QUESTION_TOOL,
} from "../constants.js";
import {
  isSwarmProtocolError,
  type IQuestionnaireUI,
  type ISwarmStore,
  type IWorktreeManager,
  type MissionKind,
  type MissionPlanInput,
  type MissionTaskInput,
  type PlanValidationIssue,
  type PlanValidationResult,
  type ProposalDialogOutcome,
  type ProposedSwarmPlan,
  type QuestionAnswer,
  type QuestionOption,
  type QuestionSpec,
  type SwarmRoleModelConfig,
  type SwarmRoleModels,
  type SwarmRunState,
  type SwarmSettings,
} from "../types.js";
import {
  computePreviewBranches,
  computePreviewWaves,
  formatProposalTranscriptSummary,
} from "./draft-prompts.js";
import { DraftStateController, type SwarmDraftState } from "./draft-state.js";

// ============================================================================
// Dependencies & Tool Details Types
// ============================================================================

export interface DraftingDeps {
  store: ISwarmStore;
  worktree: IWorktreeManager;
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
  waves?: string[][];
  branches?: Record<string, string>;
  autoConfirmed?: boolean;
  feedback?: string;
  errors?: PlanValidationIssue[];
  errorCode?: string;
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

const MissionKindSchema = Type.Unsafe<MissionKind>(
  StringEnum(["build", "artifact", "survey"] as const, {
    description:
      'Mission kind: "build" (code changes, disjoint scope, Per-Mission Validator gate + merge), "artifact" (deliverables requiring human approval before merge), or "survey" (read-only research, non-exclusive scope, zero-diff closure).',
  }),
);

const MissionTaskObjectSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Optional checklist task ID." })),
  title: Type.String({ description: "Checklist task title." }),
  done: Type.Optional(Type.Boolean({ description: "Whether already completed (default false)." })),
});

const MissionPlanItemSchema = Type.Object({
  id: Type.String({ description: 'Short unique mission ID (e.g. "M1", "M2").' }),
  title: Type.String({
    description: "Printable ASCII mission title used to derive the feat/<slug> git branch.",
  }),
  kind: MissionKindSchema,
  description: Type.String({ description: "Clear, self-contained mission specification." }),
  scope: Type.Array(Type.String(), {
    description:
      "POSIX relative paths/prefixes owned by this mission. Must be pairwise-disjoint across all build missions.",
  }),
  deps: Type.Array(Type.String(), {
    description: "Upstream mission IDs that must finish/merge before this mission starts.",
  }),
  verification: Type.String({
    description: "Concrete commands or checks proving this mission is complete.",
  }),
  tasks: Type.Optional(
    Type.Array(MissionTaskObjectSchema, {
      description: "Optional checklist subtasks for progress tracking.",
    }),
  ),
});

export const ProposeSwarmPlanParamsSchema = Type.Object({
  objective: Type.String({ description: "Overall objective of this Swarm run." }),
  base_branch: Type.Optional(
    Type.String({
      description: "Target local git branch to fork mission branches from and merge back into.",
    }),
  ),
  max_concurrency: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Maximum parallel Workers/Validators (defaults to draft/settings).",
    }),
  ),
  validator_enabled: Type.Optional(
    Type.Boolean({
      description:
        "Whether build missions require an independent read-only Per-Mission Validator gate pinned to tip SHA.",
    }),
  ),
  final_validator_enabled: Type.Optional(
    Type.Boolean({
      description:
        "Whether an independent read-only Final Validator audits the integrated base branch against verification_contract after all missions merge.",
    }),
  ),
  verification_contract: Type.String({
    description:
      "Run-level verification contract proving the full objective is met (audited post-merge by the independent Final Validator).",
  }),
  missions: Type.Array(MissionPlanItemSchema, {
    minItems: 1,
    description: "Acyclic Mission DAG with pairwise-disjoint build scopes and ASCII titles.",
  }),
});

export type SwarmQuestionParams = Static<typeof SwarmQuestionParamsSchema>;
export type SwarmQuestionnaireParams = Static<typeof SwarmQuestionnaireParamsSchema>;
export type ProposeSwarmPlanParams = Static<typeof ProposeSwarmPlanParamsSchema>;

// ============================================================================
// Normalization & Helper Utilities
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
 * plus `fallbackModels`) from `SwarmSettings` so the confirmation modal and plan summary
 * display the exact model trio that will execute the run.
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

function sanitizePositiveInt(value: number, fallback = 1): number {
  if (!Number.isFinite(value) || value < 1) {
    return Math.max(1, Math.floor(fallback));
  }
  return Math.max(1, Math.floor(value));
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

function normalizeRawTasks(
  raw: unknown,
): Array<{ id?: string; title: string; done?: boolean }> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const tasks: Array<{ id?: string; title: string; done?: boolean }> = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const title = item.trim();
      if (title) {
        tasks.push({ title });
      }
      continue;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const title = typeof obj.title === "string" ? obj.title.trim() : "";
      if (!title) {
        continue;
      }
      const normalized: { id?: string; title: string; done?: boolean } = { title };
      if (typeof obj.id === "string" && obj.id.trim()) {
        normalized.id = obj.id.trim();
      }
      if (typeof obj.done === "boolean") {
        normalized.done = obj.done;
      }
      tasks.push(normalized);
    }
  }
  return tasks.length > 0 ? tasks : undefined;
}

function normalizeMissionInputs(
  rawMissions: ProposeSwarmPlanParams["missions"],
): MissionPlanInput[] {
  return rawMissions.map((m) => {
    const tasks: MissionTaskInput[] | undefined = m.tasks
      ? m.tasks.map((t) => ({
          ...(t.id ? { id: t.id.trim() } : {}),
          title: t.title.trim(),
          ...(t.done !== undefined ? { done: t.done } : {}),
        }))
      : undefined;

    return {
      id: m.id.trim(),
      title: m.title.trim(),
      kind: m.kind,
      description: m.description.trim(),
      scope: m.scope.map((s) => s.trim()).filter(Boolean),
      deps: m.deps.map((d) => d.trim()).filter(Boolean),
      verification: m.verification.trim(),
      ...(tasks && tasks.length > 0 ? { tasks } : {}),
    };
  });
}

async function resolveBaseBranch(
  worktree: IWorktreeManager,
  explicitBranch: string | undefined,
  draftBranch: string | undefined,
  cwd: string,
): Promise<string> {
  if (explicitBranch?.trim()) {
    return explicitBranch.trim();
  }
  if (draftBranch?.trim()) {
    return draftBranch.trim();
  }
  try {
    const current = await worktree.getCurrentBranch(cwd);
    if (current.trim()) {
      return current.trim();
    }
  } catch {
    // Repo may not be initialized yet during upfront drafting; fall back cleanly.
  }
  return "main";
}

async function safeListLocalBranches(worktree: IWorktreeManager): Promise<string[]> {
  try {
    return await worktree.listLocalBranches();
  } catch {
    return [];
  }
}

function formatValidationErrors(issues: readonly PlanValidationIssue[]): string {
  const lines: string[] = [
    `Swarm plan validation failed — please fix the following protocol error(s) and call \`${PROPOSE_SWARM_PLAN_TOOL}\` again:`,
    "",
  ];

  for (const issue of issues) {
    const missionTag = issue.missionId ? ` (${issue.missionId})` : "";
    const detailSuffix =
      issue.details && Object.keys(issue.details).length > 0
        ? ` — ${JSON.stringify(issue.details)}`
        : "";
    lines.push(`- [SwarmProtocolError:${issue.code}]${missionTag} ${issue.message}${detailSuffix}`);
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
  return controller.getDraft() ?? controller.rehydrate(ctx);
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
        return {
          isError: true,
          content: [{ type: "text", text: "Question text must not be empty." }],
          details: {
            cancelled: true,
            id: params.id?.trim() || "question",
            question: "",
          } satisfies SwarmQuestionToolDetails,
        };
      }

      const id = params.id?.trim() || slugifyQuestionId(questionText);
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
        return {
          id:
            typeof item.id === "string" && item.id.trim()
              ? item.id.trim()
              : `q${idx + 1}`,
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

      const seenIds = new Set<string>();
      const specs: QuestionSpec[] = params.questions.map((q, idx) => {
        const baseId = q.id.trim() || slugifyQuestionId(q.question) || `q${idx + 1}`;
        let uniqueId = baseId;
        let suffix = 2;
        while (seenIds.has(uniqueId)) {
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

      const mergedAnswers: Record<string, string> = { ...result.answers };
      for (const item of result.items) {
        if (item.id && mergedAnswers[item.id] === undefined) {
          mergedAnswers[item.id] = item.answer;
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
            `- [${item.id}] ${item.question}\n  Answer: ${item.answer}${customTag}`,
          );
        }
      } else {
        for (const spec of specs) {
          const ans = mergedAnswers[spec.id];
          if (ans !== undefined) {
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
      "Validate a Mission DAG plan against Swarm protocol invariants, render the full wave schedule and 3-role models into scrollback, and ask the user to Confirm, Continue refining, or Cancel.",
    promptSnippet:
      "Validate and present the complete Mission DAG plan for user confirmation before launching Swarm agents.",
    promptGuidelines: [
      `Call \`${PROPOSE_SWARM_PLAN_TOOL}\` once requirements are clear; do NOT duplicate the full plan in prose beforehand because \`${PROPOSE_SWARM_PLAN_TOOL}\` renders the full formatted Mission DAG into scrollback automatically.`,
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
      const rawMissions = Array.isArray(obj.missions) ? obj.missions : [];
      const missions = rawMissions.map((item) => {
        if (!item || typeof item !== "object") {
          return item;
        }
        const m = item as Record<string, unknown>;
        const normalizedTasks = normalizeRawTasks(m.tasks);
        return {
          ...m,
          scope: Array.isArray(m.scope)
            ? m.scope.filter((s): s is string => typeof s === "string")
            : [],
          deps: Array.isArray(m.deps)
            ? m.deps.filter((d): d is string => typeof d === "string")
            : [],
          ...(normalizedTasks ? { tasks: normalizedTasks } : {}),
        };
      });

      return {
        ...(obj as ProposeSwarmPlanParams),
        missions: missions as ProposeSwarmPlanParams["missions"],
      };
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const currentDraft = ensureDraftSynced(draftController, ctx);
      const settings = deps.getSettings();

      const objective = params.objective.trim();
      const verificationContract = params.verification_contract.trim();

      if (!objective) {
        return {
          isError: true,
          content: [{ type: "text", text: "Plan objective must not be empty." }],
          details: {
            outcome: "validation_error",
            errors: [
              { code: "INVALID_DAG", message: "Plan objective must not be empty." },
            ],
          } satisfies ProposeSwarmPlanToolDetails,
        };
      }

      if (!verificationContract) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Plan verification_contract must not be empty." },
          ],
          details: {
            outcome: "validation_error",
            errors: [
              {
                code: "INVALID_DAG",
                message: "Plan verification_contract must not be empty.",
              },
            ],
          } satisfies ProposeSwarmPlanToolDetails,
        };
      }

      const missions = normalizeMissionInputs(params.missions ?? []);
      if (missions.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: formatValidationErrors([
                { code: "INVALID_DAG", message: "Plan must define at least one mission." },
              ]),
            },
          ],
          details: {
            outcome: "validation_error",
            errors: [
              { code: "INVALID_DAG", message: "Plan must define at least one mission." },
            ],
          } satisfies ProposeSwarmPlanToolDetails,
        };
      }

      // Step 1: Resolve baseBranch, concurrency, Validator/Final Validator flags, roleModels, and local branches
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
      const finalValidatorEnabled =
        params.final_validator_enabled ??
        currentDraft?.finalValidatorEnabled ??
        settings.finalValidatorEnabled ??
        DEFAULT_SWARM_SETTINGS.finalValidatorEnabled;
      const roleModels = buildRoleModelsFromSettings(settings);
      const existingBranches = await safeListLocalBranches(deps.worktree);

      // Step 2: Validate BEFORE opening any confirmation modal
      let validation: PlanValidationResult;
      try {
        validation = deps.store.validatePlan(missions, {
          existingBranches,
          baseBranch,
        });
      } catch (err) {
        if (isSwarmProtocolError(err)) {
          const issues: PlanValidationIssue[] = [
            { code: err.code, message: err.message, details: err.details },
          ];
          return {
            isError: true,
            content: [{ type: "text", text: formatValidationErrors(issues) }],
            details: {
              outcome: "validation_error",
              errors: issues,
              errorCode: err.code,
              errorMessage: err.message,
            } satisfies ProposeSwarmPlanToolDetails,
          };
        }
        throw err;
      }

      if (!validation.valid) {
        const issues: PlanValidationIssue[] =
          validation.errors.length > 0
            ? validation.errors
            : [
                {
                  code: "INVALID_DAG",
                  message: "Plan failed validation without detailed issues.",
                },
              ];
        return {
          isError: true,
          content: [{ type: "text", text: formatValidationErrors(issues) }],
          details: {
            outcome: "validation_error",
            errors: issues,
          } satisfies ProposeSwarmPlanToolDetails,
        };
      }

      const proposedPlan: ProposedSwarmPlan = {
        objective,
        baseBranch,
        maxConcurrency,
        validatorEnabled,
        finalValidatorEnabled,
        verificationContract,
        roleModels,
        missions,
      };

      // Step 3: Show bounded confirmation modal (or auto-confirm for `/swarm direct`)
      const autoConfirm = Boolean(currentDraft?.autoConfirm);
      let outcome: ProposalDialogOutcome;
      if (autoConfirm) {
        outcome = {
          action: "confirm",
          validatorEnabled,
          finalValidatorEnabled,
          maxConcurrency,
        };
      } else {
        outcome = await withModalGuard(deps, () =>
          deps.ui.confirmProposal(ctx, proposedPlan, {
            mode: currentDraft?.mode ?? "swarm",
            validation,
            signal,
          }),
        );
      }

      // Step 4: Execute user's decision
      if (outcome.action === "confirm") {
        const finalValidator =
          outcome.finalValidatorEnabled ??
          proposedPlan.finalValidatorEnabled ??
          DEFAULT_SWARM_SETTINGS.finalValidatorEnabled;
        const finalPlan: ProposedSwarmPlan = {
          ...proposedPlan,
          validatorEnabled: outcome.validatorEnabled,
          finalValidatorEnabled: finalValidator,
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

        draftController.clear("running");
        deps.onDraftChanged?.(null, ctx);

        const summary = formatProposalTranscriptSummary(
          finalPlan,
          validation.waves,
          validation.branches,
        );

        return {
          content: [
            {
              type: "text",
              text: `${summary}\n\n---\nStatus: CONFIRMED — Swarm run \`${run.id}\` created and launched on \`${run.baseBranch}\` (${run.missionOrder.length} mission(s), concurrency: ${finalPlan.maxConcurrency}, Validator: ${finalPlan.validatorEnabled ? "ON" : "OFF"}, Final Validator: ${(finalPlan.finalValidatorEnabled ?? true) ? "ON" : "OFF"}).`,
            },
          ],
          details: {
            outcome: "confirmed",
            runId: run.id,
            plan: finalPlan,
            waves: validation.waves,
            branches: validation.branches,
            autoConfirmed: autoConfirm,
          } satisfies ProposeSwarmPlanToolDetails,
          terminate: true,
        };
      }

      if (outcome.action === "cancel") {
        draftController.clear("idle");
        deps.onDraftChanged?.(null, ctx);

        const summary = formatProposalTranscriptSummary(
          proposedPlan,
          validation.waves,
          validation.branches,
        );

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
            waves: validation.waves,
            branches: validation.branches,
          } satisfies ProposeSwarmPlanToolDetails,
          terminate: true,
        };
      }

      // "continue" (refine) — keep draft active and persist any toggled Validator/Final Validator/concurrency settings
      const refinedValidatorEnabled = outcome.validatorEnabled;
      const refinedFinalValidatorEnabled =
        outcome.finalValidatorEnabled ??
        proposedPlan.finalValidatorEnabled ??
        DEFAULT_SWARM_SETTINGS.finalValidatorEnabled;
      const refinedMaxConcurrency = sanitizePositiveInt(
        outcome.maxConcurrency,
        proposedPlan.maxConcurrency,
      );
      const refinedPlan: ProposedSwarmPlan = {
        ...proposedPlan,
        validatorEnabled: refinedValidatorEnabled,
        finalValidatorEnabled: refinedFinalValidatorEnabled,
        maxConcurrency: refinedMaxConcurrency,
      };

      let updatedDraft: SwarmDraftState | null;
      if (draftController.isActive()) {
        updatedDraft = draftController.update({
          validatorEnabled: refinedValidatorEnabled,
          finalValidatorEnabled: refinedFinalValidatorEnabled,
          maxConcurrency: refinedMaxConcurrency,
          baseBranch,
        });
      } else {
        updatedDraft = draftController.start({
          mode: currentDraft?.mode ?? "swarm",
          seed: currentDraft?.seed || objective,
          targetRunId: currentDraft?.targetRunId,
          validatorEnabled: refinedValidatorEnabled,
          finalValidatorEnabled: refinedFinalValidatorEnabled,
          maxConcurrency: refinedMaxConcurrency,
          baseBranch,
          questionnaireEcho: currentDraft?.questionnaireEcho,
        });
      }
      deps.onDraftChanged?.(updatedDraft, ctx);

      const summary = formatProposalTranscriptSummary(
        refinedPlan,
        validation.waves,
        validation.branches,
      );
      const feedbackNote = outcome.feedback?.trim()
        ? `\nUser feedback: ${outcome.feedback.trim()}`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n---\nStatus: CONTINUE REFINING — Draft remains active (Validator: ${refinedValidatorEnabled ? "ON" : "OFF"}, Final Validator: ${refinedFinalValidatorEnabled ? "ON" : "OFF"}, concurrency: ${refinedMaxConcurrency}).${feedbackNote}\nAsk the user what they would like to adjust, refine the Mission DAG, and call \`${PROPOSE_SWARM_PLAN_TOOL}\` again when ready.`,
          },
        ],
        details: {
          outcome: "continue",
          plan: refinedPlan,
          waves: validation.waves,
          branches: validation.branches,
          ...(outcome.feedback?.trim()
            ? { feedback: outcome.feedback.trim() }
            : {}),
        } satisfies ProposeSwarmPlanToolDetails,
      };
    },
    renderCall(args: ProposeSwarmPlanParams, theme: Theme) {
      const settings = deps.getSettings();
      const draft = draftController.getDraft();
      const rawMissions = Array.isArray(args?.missions) ? args.missions : [];
      const previewMissions: MissionPlanInput[] = rawMissions.map((m, idx) => ({
        id: typeof m?.id === "string" && m.id.trim() ? m.id.trim() : `M${idx + 1}`,
        title: typeof m?.title === "string" ? m.title.trim() : "(untitled)",
        kind:
          m?.kind === "build" || m?.kind === "artifact" || m?.kind === "survey"
            ? m.kind
            : "build",
        description: typeof m?.description === "string" ? m.description.trim() : "",
        scope: Array.isArray(m?.scope)
          ? m.scope.filter((s): s is string => typeof s === "string")
          : [],
        deps: Array.isArray(m?.deps)
          ? m.deps.filter((d): d is string => typeof d === "string")
          : [],
        verification: typeof m?.verification === "string" ? m.verification.trim() : "",
        ...(Array.isArray(m?.tasks) && m.tasks.length > 0 ? { tasks: m.tasks } : {}),
      }));

      const previewPlan: ProposedSwarmPlan = {
        objective: typeof args?.objective === "string" ? args.objective.trim() : "",
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
        finalValidatorEnabled:
          typeof args?.final_validator_enabled === "boolean"
            ? args.final_validator_enabled
            : draft?.finalValidatorEnabled ??
              settings.finalValidatorEnabled ??
              DEFAULT_SWARM_SETTINGS.finalValidatorEnabled,
        verificationContract:
          typeof args?.verification_contract === "string"
            ? args.verification_contract.trim()
            : "",
        roleModels: buildRoleModelsFromSettings(settings),
        missions: previewMissions,
      };

      const previewWaves = computePreviewWaves(previewMissions);
      const previewBranches = computePreviewBranches(previewMissions);
      const summary = formatProposalTranscriptSummary(
        previewPlan,
        previewWaves,
        previewBranches,
      );

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
          ? ` (Validator: ${details.plan.validatorEnabled ? "ON" : "OFF"}, Final Validator: ${(details.plan.finalValidatorEnabled ?? true) ? "ON" : "OFF"})`
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
        const finalValidator = (details.plan?.finalValidatorEnabled ?? true) ? "ON" : "OFF";
        return new Text(
          `${theme.fg("warning", "✎")} ${theme.fg("toolOutput", `Continuing Swarm Plan refinement (Validator: ${validator}, Final Validator: ${finalValidator}).`)}`,
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

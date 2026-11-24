import path from "node:path";
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
  SwarmProtocolError,
  isSwarmProtocolError,
  type ConfirmProposalOptions,
  type ContractReviewResult,
  type InitialMemberProposal,
  type IQuestionnaireUI,
  type ISwarmStore,
  type IWorktreeManager,
  type MissionAssertion,
  type MissionCommandEntry,
  type MissionFeature,
  type MissionServiceEntry,
  type ProposalDialogOutcome,
  type ProposedSwarmPlan,
  type QuestionAnswer,
  type QuestionOption,
  type QuestionSpec,
  type SwarmDraftMode,
  type SwarmErrorCode,
  type SwarmMemberRole,
  type SwarmMilestone,
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
  /** Optional pre-modal adversarial contract reviewer (at most 1 automatic blocking bounce per draft). */
  reviewProposedContract?: (
    plan: ProposedSwarmPlan,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => Promise<ContractReviewResult | undefined>;
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
  outcome:
    | "confirmed"
    | "continue"
    | "cancelled"
    | "contract_review_changes_requested"
    | "validation_error"
    | "error";
  status?: "contract_review_changes_requested";
  runId?: string;
  plan?: ProposedSwarmPlan;
  autoConfirmed?: boolean;
  feedback?: string;
  contractReview?: ContractReviewResult;
  reviewPass?: number;
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

export const MissionAssertionProposalSchema = Type.Object({
  id: Type.String({
    description:
      'Unique validation contract assertion ID (e.g. "VAL-AUTH-001", "VAL-API-002").',
  }),
  title: Type.String({
    description: "Short human-readable behavioral assertion title.",
  }),
  description: Type.String({
    description:
      "Concrete testable behavioral requirement verified before completion.",
  }),
  evidence_required: Type.Optional(
    Type.String({
      description:
        "Optional concrete evidence required from independent verification (e.g. passing test command output, CLI check, or endpoint response).",
    }),
  ),
});

export const MissionFeatureProposalSchema = Type.Object({
  id: Type.String({
    description:
      'Unique lowercase feature identifier (e.g. "oauth-pkce-client", "audit-log-sink").',
  }),
  title: Type.String({
    description: "Short human-readable feature title.",
  }),
  description: Type.String({
    description:
      "Focused vertical implementation slice description with clear scope.",
  }),
  milestone: Type.String({
    description:
      'Ordered vertical milestone label this feature belongs to (e.g. "M1: Core Auth", "M2: Integration").',
  }),
  depends_on: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional upstream feature IDs that must complete before this feature starts (must form an acyclic DAG; omit for independent parallel features in the same milestone).",
    }),
  ),
  files_owned: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional disjoint file or directory paths owned by this feature so parallel share workers never collide on the same file.",
    }),
  ),
  preconditions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional preconditions checked before starting this feature.",
    }),
  ),
  expected_behavior: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional concrete behavioral outcomes expected from this feature.",
    }),
  ),
  verification_steps: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional runnable verification commands/checks for this feature using already-installed repo scripts (no speculative npx -y downloads).",
    }),
  ),
  fulfills: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Validation assertion IDs (VAL-*) claimed and fulfilled by this feature (100% of assertions must be claimed; each VAL-* ID must be claimed by a single feature).",
    }),
  ),
});

export const MissionCommandProposalSchema = Type.Object({
  name: Type.String({
    description:
      'Canonical command slot name (e.g. "test", "typecheck", "build", "lint", or optional "init" setup command for isolated worktrees).',
  }),
  command: Type.String({
    description:
      "Exact runnable command discovered from package.json/repo config using already-installed tools (avoid speculative npx -y downloads).",
  }),
});

export const MissionServiceProposalSchema = Type.Object({
  name: Type.String({
    description:
      'Unique service identifier (e.g. "api", "web", "worker-queue").',
  }),
  start: Type.String({
    description:
      "Exact runnable start command with explicit port flag/env using already-installed repo tools (avoid speculative npx -y downloads).",
  }),
  stop: Type.Optional(
    Type.String({
      description: "Optional command to cleanly stop this service.",
    }),
  ),
  healthcheck: Type.Optional(
    Type.String({
      description:
        "Optional healthcheck command or URL probe verifying service readiness on its assigned port.",
    }),
  ),
  port: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 65535,
      description:
        "Optional explicit TCP port (1–65535) reserved exclusively by this service (must be unique across all services).",
    }),
  ),
  depends_on: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional upstream service names that must start before this service (must form an acyclic DAG).",
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
  assertions: Type.Array(MissionAssertionProposalSchema, {
    minItems: 1,
    description:
      "Mandatory contract-first validation assertions (e.g. VAL-AUTH-001) defining concrete testable behaviors and required evidence (minItems: 1). Features must claim 100% of assertions via fulfills.",
  }),
  features: Type.Array(MissionFeatureProposalSchema, {
    minItems: 1,
    description:
      "Mandatory ordered vertical features grouped by milestone with acyclic depends_on, disjoint files_owned for parallel share worktrees, and 1-to-1 fulfills coverage of assertions (minItems: 1).",
  }),
  commands: Type.Optional(
    Type.Array(MissionCommandProposalSchema, {
      description:
        'Optional canonical command manifest ("test", "typecheck", "build", "lint", plus optional idempotent "init" worktree setup command) discovered from package.json and repo configs.',
    }),
  ),
  services: Type.Optional(
    Type.Array(MissionServiceProposalSchema, {
      description:
        "Optional service manifest defining local background/dev services with explicit unique ports, start/stop/healthcheck commands, and acyclic depends_on ordering.",
    }),
  ),
  boundaries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional mission boundaries (reserved port ranges, off-limits directories, external service rules).",
    }),
  ),
});

export type SwarmQuestionParams = Static<typeof SwarmQuestionParamsSchema>;
export type SwarmQuestionnaireParams = Static<typeof SwarmQuestionnaireParamsSchema>;
export type InitialMemberProposalParams = Static<typeof InitialMemberProposalSchema>;
export type MissionAssertionProposalParams = Static<typeof MissionAssertionProposalSchema>;
export type MissionFeatureProposalParams = Static<typeof MissionFeatureProposalSchema>;
export type MissionCommandProposalParams = Static<typeof MissionCommandProposalSchema>;
export type MissionServiceProposalParams = Static<typeof MissionServiceProposalSchema>;
export type ProposeSwarmPlanParams = Static<typeof ProposeSwarmPlanParamsSchema>;
export type ProposeSwarmPlanInput = Omit<
  ProposeSwarmPlanParams,
  "assertions" | "features"
> & {
  assertions?: ProposeSwarmPlanParams["assertions"];
  features?: ProposeSwarmPlanParams["features"];
};

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

export interface ValidateProposedSwarmPlanOptions {
  mode?: SwarmDraftMode;
  existingRun?: SwarmRunState | null;
  now?: string;
}

export interface TweakedMissionContractInput {
  assertions?: MissionAssertion[];
  features?: MissionFeature[];
  milestones?: SwarmMilestone[];
  commands?: MissionCommandEntry[];
  services?: MissionServiceEntry[];
  boundaries?: string[];
}

export interface MergedTweakedMissionContract {
  assertions?: MissionAssertion[];
  features?: MissionFeature[];
  milestones?: SwarmMilestone[];
  commands?: MissionCommandEntry[];
  services?: MissionServiceEntry[];
  boundaries?: string[];
}

/**
 * Auto-derives ordered `SwarmMilestone[]` in first-seen feature `milestone` order.
 * When `existingMilestones` are supplied (e.g. during `/swarm tweak`), preserves
 * `owner` and `sealed` / `sealedAt` on milestones whose features remain completed
 * and whose fulfilled `VAL-*` assertions remain `"passed"`.
 */
export function deriveMilestonesFromFeatures(
  features: readonly MissionFeature[],
  existingMilestones?: readonly SwarmMilestone[],
  assertions?: readonly MissionAssertion[],
): SwarmMilestone[] {
  const orderedLabels: string[] = [];
  const seenLabels = new Set<string>();
  for (const feat of features) {
    const label = typeof feat.milestone === "string" ? feat.milestone.trim() : "";
    if (label && !seenLabels.has(label)) {
      seenLabels.add(label);
      orderedLabels.push(label);
    }
  }

  const existingByLabel = new Map<string, SwarmMilestone>();
  if (Array.isArray(existingMilestones)) {
    for (const ms of existingMilestones) {
      if (ms && typeof ms.label === "string" && ms.label.trim()) {
        existingByLabel.set(ms.label.trim(), ms);
      }
    }
  }

  const assertionById = new Map<string, MissionAssertion>();
  if (Array.isArray(assertions)) {
    for (const a of assertions) {
      if (a && typeof a.id === "string" && a.id.trim()) {
        assertionById.set(a.id.trim(), a);
      }
    }
  }

  return orderedLabels.map((label) => {
    const group = features.filter((f) => f.milestone.trim() === label);
    const activeGroup = group.filter((f) => f.status !== "cancelled");
    let status: SwarmMilestone["status"] = "pending";
    if (activeGroup.length > 0 && activeGroup.every((f) => f.status === "completed")) {
      status = "done";
    } else if (
      group.some((f) => f.status === "in_progress" || f.status === "completed")
    ) {
      status = "in_progress";
    } else if (group.some((f) => f.status === "failed")) {
      status = "blocked";
    }

    const prev = existingByLabel.get(label);
    const allFulfilledPassed = activeGroup.every((f) =>
      f.fulfills.every((valId) => {
        const linked = assertionById.get(valId);
        return linked ? linked.status === "passed" : true;
      }),
    );
    if (status === "done" && !allFulfilledPassed && assertionById.size > 0) {
      status = "in_progress";
    }
    const preserveSealed =
      prev?.sealed === true && status === "done" && allFulfilledPassed;

    return {
      label,
      status,
      ...(prev?.owner ? { owner: prev.owner } : {}),
      ...(preserveSealed
        ? {
            sealed: true,
            ...(prev?.sealedAt ? { sealedAt: prev.sealedAt } : {}),
          }
        : {}),
    };
  });
}

function mergeFeaturePreservingUntouched(
  prev: MissionFeature | undefined,
  inc: MissionFeature,
  overrides: {
    status: MissionFeature["status"];
    assignedMember?: string;
    mergedCommitSha?: string;
    updatedAt: string;
  },
): MissionFeature {
  const base: Partial<MissionFeature> = prev ? structuredClone(prev) : {};
  const incomingClone = structuredClone(inc);
  const definedIncoming = Object.fromEntries(
    Object.entries(incomingClone).filter(([, value]) => value !== undefined),
  ) as Partial<MissionFeature>;

  const merged: MissionFeature = {
    ...(base as MissionFeature),
    ...definedIncoming,
    status: overrides.status,
    updatedAt: overrides.updatedAt,
  };
  if (overrides.assignedMember !== undefined) {
    merged.assignedMember = overrides.assignedMember;
  } else {
    delete merged.assignedMember;
  }
  if (overrides.mergedCommitSha !== undefined) {
    merged.mergedCommitSha = overrides.mergedCommitSha;
  } else {
    delete merged.mergedCommitSha;
  }
  return merged;
}

function mergeIncomingFeatureWithPrior(
  prev: MissionFeature | undefined,
  inc: MissionFeature,
  effectiveNow: string,
): MissionFeature {
  if (prev?.status === "completed") {
    return mergeFeaturePreservingUntouched(prev, inc, {
      status: "completed",
      assignedMember: prev.assignedMember ?? inc.assignedMember,
      mergedCommitSha: prev.mergedCommitSha ?? inc.mergedCommitSha,
      updatedAt: prev.updatedAt || inc.updatedAt || effectiveNow,
    });
  }
  if (
    prev?.status === "in_progress" &&
    (!inc.status || inc.status === "pending")
  ) {
    return mergeFeaturePreservingUntouched(prev, inc, {
      status: "in_progress",
      assignedMember: inc.assignedMember ?? prev.assignedMember,
      mergedCommitSha: inc.mergedCommitSha ?? prev.mergedCommitSha,
      updatedAt: prev.updatedAt || inc.updatedAt || effectiveNow,
    });
  }
  // Allow failed/cancelled work to be requeued to "pending" on tweak (matches legacy index helper)
  const nextStatus = inc.status ?? prev?.status ?? "pending";
  return mergeFeaturePreservingUntouched(prev, inc, {
    status: nextStatus,
    assignedMember: inc.assignedMember ?? prev?.assignedMember,
    mergedCommitSha: inc.mergedCommitSha ?? prev?.mergedCommitSha,
    updatedAt: inc.updatedAt || effectiveNow,
  });
}

function mergeTweakedMilestones(
  explicitMilestones: readonly SwarmMilestone[] | undefined,
  features: readonly MissionFeature[] | undefined,
  assertions: readonly MissionAssertion[] | undefined,
  priorMilestones: readonly SwarmMilestone[] | undefined,
  resetAssertionIds: ReadonlySet<string>,
): SwarmMilestone[] {
  const hasExplicit = Boolean(explicitMilestones && explicitMilestones.length > 0);
  const priorByLabel = new Map<string, SwarmMilestone>();
  for (const pm of priorMilestones ?? []) {
    const clean = pm.label.trim();
    if (clean) {
      priorByLabel.set(clean, pm);
    }
  }

  const explicitByLabel = new Map<string, SwarmMilestone>();
  const orderedLabels: string[] = [];
  const pushLabel = (rawLabel: string): void => {
    const clean = rawLabel.trim();
    if (clean && !orderedLabels.includes(clean)) {
      orderedLabels.push(clean);
    }
  };

  for (const m of explicitMilestones ?? []) {
    const clean = m.label.trim();
    if (clean) {
      explicitByLabel.set(clean, m);
      pushLabel(clean);
    }
  }
  for (const pm of priorMilestones ?? []) {
    const clean = pm.label.trim();
    if (!clean) continue;
    const stillHasFeatures = (features ?? []).some(
      (f) => f.milestone.trim() === clean,
    );
    if (pm.sealed || stillHasFeatures || !hasExplicit) {
      pushLabel(clean);
    }
  }
  for (const f of features ?? []) {
    pushLabel(f.milestone);
  }

  const assertionMap = new Map<string, MissionAssertion>();
  for (const a of assertions ?? []) {
    assertionMap.set(a.id, a);
  }

  return orderedLabels.map((label): SwarmMilestone => {
    const exp = explicitByLabel.get(label);
    const prev = priorByLabel.get(label);
    const milestoneFeatures = (features ?? []).filter(
      (f) => f.milestone.trim() === label,
    );
    const activeFeatures = milestoneFeatures.filter(
      (f) => f.status !== "cancelled",
    );

    const claimedIds = new Set<string>();
    for (const f of activeFeatures) {
      for (const aid of f.fulfills ?? []) {
        claimedIds.add(aid);
      }
    }
    const hadResetAssertion = Array.from(claimedIds).some((aid) =>
      resetAssertionIds.has(aid),
    );
    const allClaimedPassed = Array.from(claimedIds).every((aid) => {
      const linked = assertionMap.get(aid);
      return linked ? linked.status === "passed" : true;
    });
    const allFeaturesCompleted =
      activeFeatures.length > 0 &&
      activeFeatures.every((f) => f.status === "completed");
    const anyProgress = activeFeatures.some(
      (f) => f.status === "in_progress" || f.status === "completed",
    );
    const owner = exp?.owner ?? prev?.owner;

    if (hadResetAssertion) {
      return {
        label,
        status: "in_progress",
        ...(owner ? { owner } : {}),
      };
    }

    const wasSealed = Boolean(prev?.sealed ?? exp?.sealed);
    if (
      wasSealed &&
      (activeFeatures.length === 0 || (allFeaturesCompleted && allClaimedPassed))
    ) {
      const sealedAt = prev?.sealedAt ?? exp?.sealedAt;
      return {
        label,
        status: "done",
        ...(owner ? { owner } : {}),
        sealed: true,
        ...(sealedAt ? { sealedAt } : {}),
      };
    }

    let status: SwarmMilestone["status"] =
      exp?.status ?? prev?.status ?? "pending";
    if (activeFeatures.length > 0) {
      if (allFeaturesCompleted && allClaimedPassed) {
        status = "done";
      } else if (
        exp?.status === "blocked" ||
        activeFeatures.some((f) => f.status === "failed")
      ) {
        status = "blocked";
      } else if (anyProgress || status === "done") {
        status = "in_progress";
      } else {
        status = exp?.status ?? prev?.status ?? "pending";
      }
    }

    return {
      label,
      status,
      ...(owner ? { owner } : {}),
      ...(exp?.sealed === true && !wasSealed ? { sealed: true } : {}),
      ...(exp?.sealed === true && exp.sealedAt ? { sealedAt: exp.sealedAt } : {}),
    };
  });
}

/**
 * Canonical shared tweak-merge helper for Mission contracts.
 *
 * Used by BOTH `validateProposedSwarmPlan` (pre-modal tweak normalization) and
 * post-confirmation persistence (`handlePlanConfirmed`) so both stages apply the
 * exact same merge semantics:
 * - Blocks adding new features or moving features into `sealed: true` milestones
 *   (`SwarmProtocolError("INVALID_INPUT", ...)`).
 * - Preserves `completed` and `in_progress` feature progress (`mergedCommitSha`,
 *   `assignedMember`, `updatedAt`) and preserves omitted optional fields
 *   (`filesOwned`, `dependsOn`, `preconditions`, `expectedBehavior`,
 *   `verificationSteps`) from prior features while carrying forward omitted
 *   `completed` features whose assertions were not re-claimed.
 * - Preserves verification metadata (`status`, `evidence`, `verifiedBy`,
 *   `verifiedByRole`, `overridden`, `overrideJustification`, `updatedAt`) on
 *   unchanged assertions, and resets modified assertions (`description` or
 *   `evidenceRequired` changed) back to `"pending"` without stale evidence.
 * - Merges `commands` and `services` by `name`, unions `boundaries`, and preserves
 *   untouched prior milestones verbatim when neither milestones, features, nor
 *   assertions were reset; otherwise reconciles milestones preserving prior
 *   ordering, featureless/explicit milestones, and sealed status.
 * - Idempotent when invoked repeatedly with its own merged output.
 */
export function mergeTweakedMissionContract(
  existingRun: Pick<
    SwarmRunState,
    | "assertions"
    | "features"
    | "milestones"
    | "commands"
    | "services"
    | "boundaries"
  >,
  incoming: TweakedMissionContractInput,
  nowIso?: string,
): MergedTweakedMissionContract {
  const effectiveNow = nowIso ?? new Date().toISOString();

  const existingAssertionById = new Map<string, MissionAssertion>();
  for (const prevA of existingRun.assertions ?? []) {
    if (prevA && typeof prevA.id === "string" && prevA.id.trim()) {
      existingAssertionById.set(prevA.id.trim(), prevA);
    }
  }

  const existingFeatureById = new Map<string, MissionFeature>();
  for (const prevF of existingRun.features ?? []) {
    if (prevF && typeof prevF.id === "string" && prevF.id.trim()) {
      existingFeatureById.set(prevF.id.trim(), prevF);
    }
  }

  const sealedMilestones = new Set<string>();
  for (const ms of existingRun.milestones ?? []) {
    if (ms && ms.sealed === true && typeof ms.label === "string" && ms.label.trim()) {
      sealedMilestones.add(ms.label.trim());
    }
  }

  const incomingAssertionIds = new Set<string>(
    (incoming.assertions ?? [])
      .map((a) => a.id.trim())
      .filter(Boolean),
  );

  // 1. Sealed milestone guard + feature merge (preserving omitted optional fields from prev)
  let mergedFeatures: MissionFeature[] | undefined;
  const carriedCompletedFeatures: MissionFeature[] = [];
  if (incoming.features !== undefined) {
    for (const inc of incoming.features) {
      const cleanMilestone = inc.milestone.trim();
      const prev = existingFeatureById.get(inc.id);
      if (
        sealedMilestones.has(cleanMilestone) &&
        (!prev || prev.milestone.trim() !== cleanMilestone)
      ) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Cannot add new feature "${inc.id}" into already sealed milestone "${cleanMilestone}" — add a follow-up milestone instead.`,
          { featureId: inc.id, milestone: cleanMilestone },
        );
      }
    }

    const incomingFeatureIds = new Set<string>(
      incoming.features.map((f) => f.id),
    );
    const incomingClaimOwner = new Map<string, string>();
    for (const inc of incoming.features) {
      for (const valId of inc.fulfills ?? []) {
        if (!incomingClaimOwner.has(valId)) {
          incomingClaimOwner.set(valId, inc.id);
        }
      }
    }

    // Carry forward omitted already-completed features; reject contradictory VAL-* reclaims
    // rather than silently dropping completed history or creating duplicate assertion ownership.
    for (const prev of existingRun.features ?? []) {
      if (prev.status === "completed" && !incomingFeatureIds.has(prev.id)) {
        for (const valId of prev.fulfills ?? []) {
          const reclaimingFeatureId = incomingClaimOwner.get(valId);
          if (reclaimingFeatureId) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Feature "${reclaimingFeatureId}" cannot reclaim assertion "${valId}" already fulfilled by completed feature "${prev.id}" — keep "${prev.id}" in features or define a new assertion ID instead.`,
              {
                featureId: reclaimingFeatureId,
                completedFeatureId: prev.id,
                assertionId: valId,
              },
            );
          }
        }
        carriedCompletedFeatures.push(structuredClone(prev));
      }
    }

    const nextFeatures: MissionFeature[] = [];
    for (const inc of incoming.features) {
      const prev = existingFeatureById.get(inc.id);
      nextFeatures.push(mergeIncomingFeatureWithPrior(prev, inc, effectiveNow));
    }

    mergedFeatures = [...carriedCompletedFeatures, ...nextFeatures];
  } else if (existingRun.features && existingRun.features.length > 0) {
    mergedFeatures = structuredClone(existingRun.features);
  }

  // 2. Assertion merge (preserve metadata when contract unchanged; reset when modified)
  const resetAssertionIds = new Set<string>();
  let mergedAssertions: MissionAssertion[] | undefined;
  if (incoming.assertions !== undefined) {
    // Carry forward omitted assertions across the UNION of all completed features
    // (both carried-forward omitted completed features AND incoming retained completed features)
    const carriedAssertions: MissionAssertion[] = [];
    const seenCarried = new Set<string>();
    const effectiveFeatures = mergedFeatures ?? existingRun.features ?? [];
    for (const feat of effectiveFeatures) {
      if (feat.status !== "completed") continue;
      for (const valId of feat.fulfills ?? []) {
        if (!incomingAssertionIds.has(valId) && !seenCarried.has(valId)) {
          const prevA = existingAssertionById.get(valId);
          if (prevA) {
            seenCarried.add(valId);
            carriedAssertions.push(structuredClone(prevA));
          }
        }
      }
    }

    const nextAssertions: MissionAssertion[] = [];
    for (const incA of incoming.assertions) {
      const prevA = existingAssertionById.get(incA.id);
      if (prevA) {
        const prevDesc = (prevA.description ?? "").trim();
        const nextDesc = incA.description.trim();
        const prevEvReq = (prevA.evidenceRequired ?? "").trim();
        const nextEvReq = (incA.evidenceRequired ?? "").trim();
        const contractUnchanged = prevDesc === nextDesc && prevEvReq === nextEvReq;

        if (contractUnchanged) {
          // An unchanged "passed" assertion cannot be downgraded by incoming non-pending status
          const isPrevPassed = prevA.status === "passed";
          const mergedStatus = isPrevPassed
            ? "passed"
            : incA.status && incA.status !== "pending"
              ? incA.status
              : prevA.status;
          const evidence = isPrevPassed
            ? prevA.evidence ?? incA.evidence
            : incA.evidence ?? prevA.evidence;
          const verifiedBy = isPrevPassed
            ? prevA.verifiedBy ?? incA.verifiedBy
            : incA.verifiedBy ?? prevA.verifiedBy;
          const verifiedByRole = isPrevPassed
            ? prevA.verifiedByRole ?? incA.verifiedByRole
            : incA.verifiedByRole ?? prevA.verifiedByRole;
          const overridden = isPrevPassed
            ? prevA.overridden !== undefined
              ? prevA.overridden
              : incA.overridden
            : incA.overridden !== undefined
              ? incA.overridden
              : prevA.overridden;
          const overrideJustification = isPrevPassed
            ? prevA.overrideJustification ?? incA.overrideJustification
            : incA.overrideJustification ?? prevA.overrideJustification;
          nextAssertions.push({
            id: incA.id,
            title: incA.title,
            description: nextDesc,
            ...(incA.evidenceRequired !== undefined
              ? { evidenceRequired: incA.evidenceRequired }
              : {}),
            status: mergedStatus,
            ...(evidence !== undefined ? { evidence } : {}),
            ...(verifiedBy !== undefined ? { verifiedBy } : {}),
            ...(verifiedByRole !== undefined ? { verifiedByRole } : {}),
            ...(overridden !== undefined ? { overridden } : {}),
            ...(overrideJustification !== undefined
              ? { overrideJustification }
              : {}),
            updatedAt: prevA.updatedAt || incA.updatedAt || effectiveNow,
          });
          continue;
        }

        // Contract description or evidenceRequired changed -> reset to "pending" & clear stale evidence
        if (prevA.status !== "pending") {
          resetAssertionIds.add(incA.id);
        }
        nextAssertions.push({
          id: incA.id,
          title: incA.title,
          description: nextDesc,
          ...(incA.evidenceRequired !== undefined
            ? { evidenceRequired: incA.evidenceRequired }
            : {}),
          status: "pending",
          updatedAt: effectiveNow,
        });
        continue;
      }

      nextAssertions.push({
        ...structuredClone(incA),
        status: incA.status ?? "pending",
        updatedAt: incA.updatedAt || effectiveNow,
      });
    }

    mergedAssertions = [...carriedAssertions, ...nextAssertions];
  } else if (existingRun.assertions && existingRun.assertions.length > 0) {
    mergedAssertions = structuredClone(existingRun.assertions);
  }

  // 3. Commands, Services & Boundaries merge
  let mergedCommands: MissionCommandEntry[] | undefined;
  if (incoming.commands !== undefined) {
    const cmdMap = new Map<string, MissionCommandEntry>();
    for (const c of existingRun.commands ?? []) {
      cmdMap.set(c.name, { ...c });
    }
    for (const c of incoming.commands) {
      cmdMap.set(c.name, { ...c });
    }
    if (cmdMap.size > 0) {
      mergedCommands = [...cmdMap.values()];
    }
  } else if (existingRun.commands && existingRun.commands.length > 0) {
    mergedCommands = existingRun.commands.map((c) => ({ ...c }));
  }

  let mergedServices: MissionServiceEntry[] | undefined;
  if (incoming.services !== undefined) {
    const svcMap = new Map<string, MissionServiceEntry>();
    for (const s of existingRun.services ?? []) {
      svcMap.set(s.name, structuredClone(s));
    }
    for (const s of incoming.services) {
      svcMap.set(s.name, structuredClone(s));
    }
    if (svcMap.size > 0) {
      mergedServices = [...svcMap.values()];
    }
  } else if (existingRun.services && existingRun.services.length > 0) {
    mergedServices = structuredClone(existingRun.services);
  }

  let mergedBoundaries: string[] | undefined;
  if (incoming.boundaries !== undefined) {
    const seen = new Set<string>();
    const combined: string[] = [];
    for (const b of [
      ...(existingRun.boundaries ?? []),
      ...incoming.boundaries,
    ]) {
      const trimmed = b.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        combined.push(trimmed);
      }
    }
    if (combined.length > 0) {
      mergedBoundaries = combined;
    }
  } else if (existingRun.boundaries && existingRun.boundaries.length > 0) {
    mergedBoundaries = [...existingRun.boundaries];
  }

  // 4. Milestones reconciliation:
  //    - When neither incoming.milestones, incoming.features, nor resetAssertionIds changed
  //      (e.g. a strategy-only or commands-only tweak), preserve existingRun.milestones verbatim.
  //    - Otherwise reconcile while preserving prior ordering, explicit/featureless milestones,
  //      and sealed metadata (unsealing only milestones whose claimed assertion reset).
  let mergedMilestones: SwarmMilestone[] | undefined;
  const shouldReconcileMilestones =
    incoming.milestones !== undefined ||
    incoming.features !== undefined ||
    resetAssertionIds.size > 0;
  if (shouldReconcileMilestones) {
    const reconciled = mergeTweakedMilestones(
      incoming.milestones,
      mergedFeatures,
      mergedAssertions,
      existingRun.milestones,
      resetAssertionIds,
    );
    if (reconciled.length > 0) {
      mergedMilestones = reconciled;
    }
  } else if (existingRun.milestones && existingRun.milestones.length > 0) {
    mergedMilestones = structuredClone(existingRun.milestones);
  }

  return {
    ...(mergedAssertions && mergedAssertions.length > 0
      ? { assertions: mergedAssertions }
      : {}),
    ...(mergedFeatures && mergedFeatures.length > 0
      ? { features: mergedFeatures }
      : {}),
    ...(mergedMilestones && mergedMilestones.length > 0
      ? { milestones: mergedMilestones }
      : {}),
    ...(mergedCommands && mergedCommands.length > 0
      ? { commands: mergedCommands }
      : {}),
    ...(mergedServices && mergedServices.length > 0
      ? { services: mergedServices }
      : {}),
    ...(mergedBoundaries && mergedBoundaries.length > 0
      ? { boundaries: mergedBoundaries }
      : {}),
  };
}

// ============================================================================
// Static Local files_owned Overlap Validation Helpers
// ============================================================================

interface NormalizedOwnedPath {
  raw: string;
  /**
   * Canonical POSIX path after normalizing `/`/`\`, `./`, `..`, trailing `/`,
   * and trailing `/*` or `/**` directory wildcards (`""` represents repo root).
   *
   * Overlap detection is a deterministic literal + POSIX directory-containment
   * gate (consistent with `engine.ts`'s `ownedPathsOverlap`), without heuristic
   * glob intersection so disjoint wildcard patterns (e.g. `src/auth-*.ts` vs
   * `src/ui-*.ts`) never trigger false positives.
   */
  normalized: string;
}

function normalizeOwnedPath(raw: string): NormalizedOwnedPath | null {
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return null;

  p = p.replace(/\/+/g, "/");
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");

  if (p === "" || p === "." || p === "*" || p === "**") {
    return { raw, normalized: "" };
  }

  const posixNorm = path.posix
    .normalize(p)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (
    posixNorm === "" ||
    posixNorm === "." ||
    posixNorm === "*" ||
    posixNorm === "**"
  ) {
    return { raw, normalized: "" };
  }

  let stripped = posixNorm;
  while (stripped.endsWith("/**") || stripped.endsWith("/*")) {
    stripped = stripped.replace(/\/\*+$/, "");
  }
  if (
    stripped === "" ||
    stripped === "." ||
    stripped === "*" ||
    stripped === "**"
  ) {
    return { raw, normalized: "" };
  }

  return { raw, normalized: stripped };
}

function ownedPathEntriesCollide(
  a: NormalizedOwnedPath,
  b: NormalizedOwnedPath,
): boolean {
  if (a.normalized === "" || b.normalized === "") return true;
  if (a.normalized === b.normalized) return true;
  return (
    a.normalized.startsWith(`${b.normalized}/`) ||
    b.normalized.startsWith(`${a.normalized}/`)
  );
}

function collectFeatureFileOverlapIssues(
  features: readonly Pick<
    MissionFeature,
    "id" | "milestone" | "dependsOn" | "filesOwned" | "status"
  >[],
): DraftPlanValidationIssue[] {
  const issues: DraftPlanValidationIssue[] = [];
  if (features.length < 2) {
    return issues;
  }

  const depsById = new Map<string, readonly string[]>();
  for (const feat of features) {
    depsById.set(feat.id, feat.dependsOn ?? []);
  }

  const ancestorCache = new Map<string, Set<string>>();
  const getAncestors = (startId: string): Set<string> => {
    const cached = ancestorCache.get(startId);
    if (cached) return cached;
    const visited = new Set<string>();
    const stack = [...(depsById.get(startId) ?? [])];
    while (stack.length > 0) {
      const depId = stack.pop()!;
      if (depId === startId || visited.has(depId)) continue;
      visited.add(depId);
      const nextDeps = depsById.get(depId);
      if (nextDeps) {
        for (const nd of nextDeps) {
          if (!visited.has(nd)) {
            stack.push(nd);
          }
        }
      }
    }
    ancestorCache.set(startId, visited);
    return visited;
  };

  // Skip only features whose EFFECTIVE status is terminal (completed/cancelled)
  const parsedByFeature = features.map((feat) => {
    const isTerminal =
      feat.status === "completed" || feat.status === "cancelled";
    const parsedPaths = isTerminal
      ? []
      : (feat.filesOwned ?? [])
          .map(normalizeOwnedPath)
          .filter((p): p is NormalizedOwnedPath => p !== null);
    return { feat, milestone: feat.milestone.trim(), parsedPaths };
  });

  for (let i = 0; i < parsedByFeature.length; i++) {
    const a = parsedByFeature[i]!;
    if (a.parsedPaths.length === 0) continue;

    for (let j = i + 1; j < parsedByFeature.length; j++) {
      const b = parsedByFeature[j]!;
      if (b.parsedPaths.length === 0) continue;
      if (a.milestone !== b.milestone) continue;

      if (
        getAncestors(a.feat.id).has(b.feat.id) ||
        getAncestors(b.feat.id).has(a.feat.id)
      ) {
        continue;
      }

      let overlapPair: [string, string] | null = null;
      for (const pathA of a.parsedPaths) {
        for (const pathB of b.parsedPaths) {
          if (ownedPathEntriesCollide(pathA, pathB)) {
            overlapPair = [pathA.raw, pathB.raw];
            break;
          }
        }
        if (overlapPair) break;
      }

      if (overlapPair) {
        issues.push({
          code: "INVALID_INPUT",
          field: "features",
          message: `Overlapping files_owned between parallel features "${a.feat.id}" ("${overlapPair[0]}") and "${b.feat.id}" ("${overlapPair[1]}") in milestone "${a.milestone}" without depends_on ordering — assign disjoint paths or add depends_on between them.`,
        });
      }
    }
  }

  return issues;
}

function collectFeatureDagErrors(
  features: readonly Pick<MissionFeature, "id" | "dependsOn">[],
  knownCompletedIds?: ReadonlySet<string>,
): SwarmProtocolError[] {
  const errors: SwarmProtocolError[] = [];
  const featureById = new Map<string, Pick<MissionFeature, "id" | "dependsOn">>();
  for (const feat of features) {
    featureById.set(feat.id, feat);
  }

  for (const feat of features) {
    for (const depId of feat.dependsOn ?? []) {
      if (depId === feat.id) {
        errors.push(
          new SwarmProtocolError(
            "INVALID_INPUT",
            `Feature "${feat.id}" cannot depend on itself (self-cycle in depends_on: ${feat.id} -> ${feat.id}).`,
            { featureId: feat.id, dependsOn: depId },
          ),
        );
      } else if (!featureById.has(depId) && !knownCompletedIds?.has(depId)) {
        errors.push(
          new SwarmProtocolError(
            "INVALID_INPUT",
            `Feature "${feat.id}" depends_on unknown feature "${depId}".`,
            { featureId: feat.id, dependsOn: depId },
          ),
        );
      }
    }
  }

  // 3-color DFS (0 = unvisited, 1 = visiting, 2 = visited) for cycle detection
  const visitState = new Map<string, 0 | 1 | 2>();
  const pathStack: string[] = [];
  const reportedCycles = new Set<string>();

  const dfs = (nodeId: string): void => {
    visitState.set(nodeId, 1);
    pathStack.push(nodeId);

    const node = featureById.get(nodeId);
    for (const depId of node?.dependsOn ?? []) {
      if (depId === nodeId || !featureById.has(depId)) {
        continue;
      }
      const depState = visitState.get(depId) ?? 0;
      if (depState === 1) {
        const cycleStart = pathStack.indexOf(depId);
        const cycleSlice =
          cycleStart >= 0 ? [...pathStack.slice(cycleStart), depId] : [nodeId, depId];
        const cycleKey = cycleSlice.join("->");
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          errors.push(
            new SwarmProtocolError(
              "INVALID_INPUT",
              `Dependency cycle detected in features.depends_on: ${cycleSlice.join(" -> ")}. Features must form an acyclic DAG.`,
              { cycle: cycleSlice },
            ),
          );
        }
      } else if (depState === 0) {
        dfs(depId);
      }
    }

    pathStack.pop();
    visitState.set(nodeId, 2);
  };

  for (const feat of features) {
    if ((visitState.get(feat.id) ?? 0) === 0) {
      dfs(feat.id);
    }
  }

  return errors;
}

/**
 * Validates that `features` form a valid acyclic `dependsOn` DAG where every
 * referenced dependency exists, throwing `SwarmProtocolError("INVALID_INPUT", ...)`
 * on self-cycles, multi-hop cycles, or unknown feature references.
 */
export function assertFeatureDependencyDag(
  features: readonly Pick<MissionFeature, "id" | "dependsOn">[],
  knownCompletedIds?: ReadonlySet<string>,
): void {
  const errors = collectFeatureDagErrors(features, knownCompletedIds);
  if (errors.length > 0) {
    throw errors[0]!;
  }
}

function collectServiceDagErrors(
  services: readonly Pick<MissionServiceEntry, "name" | "dependsOn">[],
): SwarmProtocolError[] {
  const errors: SwarmProtocolError[] = [];
  const serviceByName = new Map<
    string,
    Pick<MissionServiceEntry, "name" | "dependsOn">
  >();
  for (const svc of services) {
    serviceByName.set(svc.name, svc);
  }

  for (const svc of services) {
    for (const depName of svc.dependsOn ?? []) {
      if (depName === svc.name) {
        errors.push(
          new SwarmProtocolError(
            "INVALID_INPUT",
            `Service "${svc.name}" cannot depend on itself (self-cycle in depends_on: ${svc.name} -> ${svc.name}).`,
            { serviceName: svc.name, dependsOn: depName },
          ),
        );
      } else if (!serviceByName.has(depName)) {
        errors.push(
          new SwarmProtocolError(
            "INVALID_INPUT",
            `Service "${svc.name}" depends_on unknown service "${depName}".`,
            { serviceName: svc.name, dependsOn: depName },
          ),
        );
      }
    }
  }

  // 3-color DFS (0 = unvisited, 1 = visiting, 2 = visited) for service cycle detection
  const visitState = new Map<string, 0 | 1 | 2>();
  const pathStack: string[] = [];
  const reportedCycles = new Set<string>();

  const dfs = (nodeName: string): void => {
    visitState.set(nodeName, 1);
    pathStack.push(nodeName);

    const node = serviceByName.get(nodeName);
    for (const depName of node?.dependsOn ?? []) {
      if (depName === nodeName || !serviceByName.has(depName)) {
        continue;
      }
      const depState = visitState.get(depName) ?? 0;
      if (depState === 1) {
        const cycleStart = pathStack.indexOf(depName);
        const cycleSlice =
          cycleStart >= 0
            ? [...pathStack.slice(cycleStart), depName]
            : [nodeName, depName];
        const cycleKey = cycleSlice.join("->");
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          errors.push(
            new SwarmProtocolError(
              "INVALID_INPUT",
              `Dependency cycle detected in services.depends_on: ${cycleSlice.join(" -> ")}. Services must form an acyclic DAG.`,
              { cycle: cycleSlice },
            ),
          );
        }
      } else if (depState === 0) {
        dfs(depName);
      }
    }

    pathStack.pop();
    visitState.set(nodeName, 2);
  };

  for (const svc of services) {
    if ((visitState.get(svc.name) ?? 0) === 0) {
      dfs(svc.name);
    }
  }

  return errors;
}

/**
 * Validates that `services` have unique ports and form a valid acyclic `dependsOn` DAG,
 * throwing `SwarmProtocolError("INVALID_INPUT", ...)` on duplicate ports, unknown references,
 * or dependency cycles.
 */
export function assertServiceManifest(
  services: readonly Pick<MissionServiceEntry, "name" | "port" | "dependsOn">[],
): void {
  const seenNames = new Set<string>();
  const seenPorts = new Map<number, string>();
  for (const svc of services) {
    const cleanName = typeof svc.name === "string" ? svc.name.trim() : "";
    if (!cleanName || isPrototypeKey(cleanName)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        "Every service entry must have a valid non-empty name.",
      );
    }
    if (seenNames.has(cleanName)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Duplicate service name "${cleanName}" — every service must have a unique name.`,
        { serviceName: cleanName },
      );
    }
    seenNames.add(cleanName);

    if (svc.port !== undefined) {
      if (
        typeof svc.port !== "number" ||
        !Number.isInteger(svc.port) ||
        svc.port < 1 ||
        svc.port > 65535
      ) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Service "${cleanName}" port must be an integer between 1 and 65535.`,
          { serviceName: cleanName, port: svc.port },
        );
      }
      const prevOwner = seenPorts.get(svc.port);
      if (prevOwner) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Duplicate service port ${svc.port} across services "${prevOwner}" and "${cleanName}" — each service must use a unique port.`,
          { port: svc.port, services: [prevOwner, cleanName] },
        );
      }
      seenPorts.set(svc.port, cleanName);
    }
  }

  const dagErrors = collectServiceDagErrors(services);
  if (dagErrors.length > 0) {
    throw dagErrors[0]!;
  }
}

function normalizeValidatedStringList(
  raw: unknown,
  field: string,
  ownerLabel: string,
  issues: DraftPlanValidationIssue[],
  options?: { rejectEmptyItems?: boolean; dedupe?: boolean },
): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.push({
      code: "INVALID_INPUT",
      field,
      message: `${ownerLabel} "${field}" must be an array of strings.`,
    });
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    if (typeof item !== "string") {
      issues.push({
        code: "INVALID_INPUT",
        field,
        message: `${ownerLabel} "${field}" entry #${idx + 1} must be a string.`,
      });
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      if (options?.rejectEmptyItems) {
        issues.push({
          code: "INVALID_INPUT",
          field,
          message: `${ownerLabel} "${field}" entry #${idx + 1} must not be empty.`,
        });
      }
      continue;
    }
    if (isPrototypeKey(trimmed)) {
      issues.push({
        code: "INVALID_INPUT",
        field,
        message: `${ownerLabel} "${field}" entry "${trimmed}" is forbidden (prototype key).`,
      });
      continue;
    }
    if (options?.dedupe) {
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    } else {
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Validates `propose_swarm_plan` parameters BEFORE opening any confirmation modal.
 * Verifies non-empty `title`/`objective`/`strategy`/`acceptance_criteria`, checks
 * `initial_members`, validates Mission-Level TDD contracts (`assertions` + `features`
 * uniqueness, `depends_on` DAG, 100% 1-to-1 `fulfills` coverage), and smart-merges
 * existing progress + sealed milestone protection during `/swarm tweak`.
 */
export function validateProposedSwarmPlan(
  params: ProposeSwarmPlanInput,
  options?: ValidateProposedSwarmPlanOptions,
):
  | {
      valid: true;
      title: string;
      objective: string;
      strategy: string;
      acceptanceCriteria: string;
      initialMembers?: InitialMemberProposal[];
      assertions?: MissionAssertion[];
      features?: MissionFeature[];
      milestones?: SwarmMilestone[];
      commands?: MissionCommandEntry[];
      services?: MissionServiceEntry[];
      boundaries?: string[];
    }
  | {
      valid: false;
      issues: DraftPlanValidationIssue[];
    } {
  const issues: DraftPlanValidationIssue[] = [];
  const nowIso = options?.now ?? new Date().toISOString();
  const isTweak = options?.mode === "tweak" && Boolean(options?.existingRun);
  const existingRun = isTweak ? options?.existingRun ?? null : null;

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

  // --------------------------------------------------------------------------
  // Commands & Boundaries Validation
  // --------------------------------------------------------------------------
  let normalizedCommands: MissionCommandEntry[] | undefined;
  if (params.commands !== undefined) {
    if (!Array.isArray(params.commands)) {
      issues.push({
        code: "INVALID_INPUT",
        field: "commands",
        message: "Plan commands must be an array of { name, command } objects.",
      });
    } else {
      const cmdMap = new Map<string, MissionCommandEntry>();
      for (let i = 0; i < params.commands.length; i++) {
        const rawCmd = params.commands[i];
        if (!rawCmd || typeof rawCmd !== "object" || Array.isArray(rawCmd)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "commands",
            message: `Command entry #${i + 1} must be an object with non-empty name and command.`,
          });
          continue;
        }
        const cmdName =
          typeof rawCmd.name === "string" ? rawCmd.name.trim() : "";
        const cmdBody =
          typeof rawCmd.command === "string" ? rawCmd.command.trim() : "";
        if (!cmdName || isPrototypeKey(cmdName)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "commands",
            message: `Command entry #${i + 1} must have a valid non-empty name.`,
          });
          continue;
        }
        if (!cmdBody) {
          issues.push({
            code: "INVALID_INPUT",
            field: "commands",
            message: `Command "${cmdName}" must have a non-empty runnable command string.`,
          });
          continue;
        }
        cmdMap.set(cmdName, { name: cmdName, command: cmdBody });
      }
      if (cmdMap.size > 0) {
        normalizedCommands = [...cmdMap.values()];
      }
    }
  } else if (existingRun?.commands && existingRun.commands.length > 0) {
    normalizedCommands = existingRun.commands.map((c) => ({ ...c }));
  }

  // --------------------------------------------------------------------------
  // Services & Ports Validation + Tweak Merge
  // --------------------------------------------------------------------------
  let normalizedServices: MissionServiceEntry[] | undefined;
  if (params.services !== undefined) {
    if (!Array.isArray(params.services)) {
      issues.push({
        code: "INVALID_INPUT",
        field: "services",
        message:
          "Plan services must be an array of { name, start, stop?, healthcheck?, port?, depends_on? } objects.",
      });
    } else {
      const incomingServices: MissionServiceEntry[] = [];
      const seenServiceNames = new Set<string>();
      const seenServicePorts = new Map<number, string>();

      for (let i = 0; i < params.services.length; i++) {
        const rawSvc = params.services[i];
        if (!rawSvc || typeof rawSvc !== "object" || Array.isArray(rawSvc)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "services",
            message: `Service entry #${i + 1} must be an object with non-empty name and start command.`,
          });
          continue;
        }
        const svcName =
          typeof rawSvc.name === "string" ? rawSvc.name.trim() : "";
        const svcTag = svcName || `#${i + 1}`;
        let nameOk = false;
        if (!svcName) {
          issues.push({
            code: "INVALID_INPUT",
            field: "services",
            message: `Service entry #${i + 1} must have a non-empty name.`,
          });
        } else if (isPrototypeKey(svcName)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "services",
            message: `Service name "${svcName}" is forbidden (prototype key).`,
          });
        } else if (seenServiceNames.has(svcName)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "services",
            message: `Duplicate service name "${svcName}" — every service must have a unique name.`,
          });
        } else {
          seenServiceNames.add(svcName);
          nameOk = true;
        }

        const svcStart =
          typeof rawSvc.start === "string" ? rawSvc.start.trim() : "";
        if (!svcStart) {
          issues.push({
            code: "INVALID_INPUT",
            field: "services",
            message: `Service "${svcTag}" must have a non-empty start command.`,
          });
        }

        let svcStop: string | undefined;
        if (rawSvc.stop !== undefined) {
          if (typeof rawSvc.stop !== "string") {
            issues.push({
              code: "INVALID_INPUT",
              field: "services",
              message: `Service "${svcTag}" stop command must be a string.`,
            });
          } else if (rawSvc.stop.trim()) {
            svcStop = rawSvc.stop.trim();
          }
        }

        let svcHealthcheck: string | undefined;
        if (rawSvc.healthcheck !== undefined) {
          if (typeof rawSvc.healthcheck !== "string") {
            issues.push({
              code: "INVALID_INPUT",
              field: "services",
              message: `Service "${svcTag}" healthcheck must be a string.`,
            });
          } else if (rawSvc.healthcheck.trim()) {
            svcHealthcheck = rawSvc.healthcheck.trim();
          }
        }

        let svcPort: number | undefined;
        if (rawSvc.port !== undefined) {
          if (
            typeof rawSvc.port !== "number" ||
            !Number.isInteger(rawSvc.port) ||
            rawSvc.port < 1 ||
            rawSvc.port > 65535
          ) {
            issues.push({
              code: "INVALID_INPUT",
              field: "services",
              message: `Service "${svcTag}" port must be an integer between 1 and 65535.`,
            });
          } else {
            const prevPortOwner = seenServicePorts.get(rawSvc.port);
            if (prevPortOwner) {
              const dupPortErr = new SwarmProtocolError(
                "INVALID_INPUT",
                `Duplicate service port ${rawSvc.port} across services "${prevPortOwner}" and "${svcTag}" — each service must use a unique port.`,
                { port: rawSvc.port, services: [prevPortOwner, svcTag] },
              );
              issues.push({
                code: dupPortErr.code,
                field: "services",
                message: dupPortErr.message,
              });
            } else {
              seenServicePorts.set(rawSvc.port, svcTag);
              svcPort = rawSvc.port;
            }
          }
        }

        const svcDependsOn = normalizeValidatedStringList(
          rawSvc.depends_on,
          "depends_on",
          `Service "${svcTag}"`,
          issues,
          { rejectEmptyItems: true, dedupe: true },
        );

        if (nameOk && svcStart) {
          incomingServices.push({
            name: svcName,
            start: svcStart,
            ...(svcStop !== undefined ? { stop: svcStop } : {}),
            ...(svcHealthcheck !== undefined
              ? { healthcheck: svcHealthcheck }
              : {}),
            ...(svcPort !== undefined ? { port: svcPort } : {}),
            ...(svcDependsOn && svcDependsOn.length > 0
              ? { dependsOn: svcDependsOn }
              : {}),
          });
        }
      }

      // Merge with existingRun.services in tweak mode (by service name) before port/DAG cross-check
      let effectiveServices: MissionServiceEntry[] = incomingServices;
      if (existingRun?.services && existingRun.services.length > 0) {
        const svcMap = new Map<string, MissionServiceEntry>();
        for (const prevSvc of existingRun.services) {
          svcMap.set(prevSvc.name, structuredClone(prevSvc));
        }
        for (const incSvc of incomingServices) {
          svcMap.set(incSvc.name, incSvc);
        }
        effectiveServices = [...svcMap.values()];

        const mergedPorts = new Map<number, string>();
        for (const svc of effectiveServices) {
          if (svc.port !== undefined) {
            const prevOwner = mergedPorts.get(svc.port);
            if (prevOwner && !seenServicePorts.has(svc.port)) {
              issues.push({
                code: "INVALID_INPUT",
                field: "services",
                message: `Duplicate service port ${svc.port} across services "${prevOwner}" and "${svc.name}" — each service must use a unique port.`,
              });
            } else if (prevOwner && seenServiceNames.has(svc.name) && !seenServiceNames.has(prevOwner)) {
              issues.push({
                code: "INVALID_INPUT",
                field: "services",
                message: `Duplicate service port ${svc.port} across existing service "${prevOwner}" and "${svc.name}" — each service must use a unique port.`,
              });
            } else {
              mergedPorts.set(svc.port, svc.name);
            }
          }
        }
      }

      if (effectiveServices.length > 0) {
        const svcDagErrors = collectServiceDagErrors(effectiveServices);
        for (const err of svcDagErrors) {
          issues.push({
            code: err.code,
            field: "services",
            message: err.message,
          });
        }
        normalizedServices = effectiveServices;
      }
    }
  } else if (existingRun?.services && existingRun.services.length > 0) {
    normalizedServices = structuredClone(existingRun.services);
  }

  let normalizedBoundaries: string[] | undefined;
  if (params.boundaries !== undefined) {
    if (!Array.isArray(params.boundaries)) {
      issues.push({
        code: "INVALID_INPUT",
        field: "boundaries",
        message: "Plan boundaries must be an array of strings.",
      });
    } else {
      const bounds: string[] = [];
      for (let i = 0; i < params.boundaries.length; i++) {
        const rawB = params.boundaries[i];
        if (typeof rawB !== "string") {
          issues.push({
            code: "INVALID_INPUT",
            field: "boundaries",
            message: `Boundary entry #${i + 1} must be a string.`,
          });
          continue;
        }
        const trimmedB = rawB.trim();
        if (trimmedB) {
          bounds.push(trimmedB);
        }
      }
      if (bounds.length > 0) {
        normalizedBoundaries = bounds;
      }
    }
  } else if (existingRun?.boundaries && existingRun.boundaries.length > 0) {
    normalizedBoundaries = [...existingRun.boundaries];
  }

  // --------------------------------------------------------------------------
  // Mission-Level TDD Validation (assertions & features) + Dynamic Tweak Merge
  // Legacy JS unit tests omitting BOTH assertions === undefined && features === undefined
  // remain compatible; empty [] arrays or half-omitted contracts are strictly rejected!
  // --------------------------------------------------------------------------
  if (Array.isArray(params.assertions) && params.assertions.length === 0) {
    const err = new SwarmProtocolError(
      "INVALID_INPUT",
      "Plan assertions must include at least 1 validation assertion (minItems: 1).",
      { field: "assertions" },
    );
    issues.push({
      code: err.code,
      field: "assertions",
      message: err.message,
    });
  }
  if (Array.isArray(params.features) && params.features.length === 0) {
    const err = new SwarmProtocolError(
      "INVALID_INPUT",
      "Plan features must include at least 1 feature (minItems: 1).",
      { field: "features" },
    );
    issues.push({
      code: err.code,
      field: "features",
      message: err.message,
    });
  }
  if (params.assertions === undefined && params.features !== undefined) {
    issues.push({
      code: "INVALID_INPUT",
      field: "assertions",
      message:
        "Plan assertions must include at least 1 validation assertion (minItems: 1) when features are provided.",
    });
  }
  if (params.assertions !== undefined && params.features === undefined) {
    issues.push({
      code: "INVALID_INPUT",
      field: "features",
      message:
        "Plan features must include at least 1 feature (minItems: 1) claiming all assertions via fulfills.",
    });
  }

  const incomingAssertions: MissionAssertion[] = [];
  const seenAssertionIds = new Set<string>();
  if (params.assertions !== undefined) {
    if (!Array.isArray(params.assertions)) {
      issues.push({
        code: "INVALID_INPUT",
        field: "assertions",
        message: "Plan assertions must be an array of validation assertion objects.",
      });
    } else {
      for (let i = 0; i < params.assertions.length; i++) {
        const rawA = params.assertions[i];
        if (!rawA || typeof rawA !== "object" || Array.isArray(rawA)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "assertions",
            message: `Assertion #${i + 1} must be an object.`,
          });
          continue;
        }
        const aId = typeof rawA.id === "string" ? rawA.id.trim() : "";
        const aTag = aId || `#${i + 1}`;
        if (!aId) {
          issues.push({
            code: "INVALID_INPUT",
            field: "assertions",
            message: `Assertion #${i + 1} must have a non-empty id (e.g. "VAL-AUTH-001").`,
          });
        } else if (isPrototypeKey(aId)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "assertions",
            message: `Assertion id "${aId}" is forbidden (prototype key).`,
          });
        } else if (seenAssertionIds.has(aId)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "assertions",
            message: `Duplicate assertion id "${aId}" — every assertion must have a unique id.`,
          });
        } else {
          seenAssertionIds.add(aId);
        }

        const aTitle = typeof rawA.title === "string" ? rawA.title.trim() : "";
        if (!aTitle) {
          issues.push({
            code: "INVALID_INPUT",
            field: "assertions",
            message: `Assertion "${aTag}" must have a non-empty title.`,
          });
        }

        const aDesc =
          typeof rawA.description === "string" ? rawA.description.trim() : "";
        if (!aDesc) {
          issues.push({
            code: "INVALID_INPUT",
            field: "assertions",
            message: `Assertion "${aTag}" must have a non-empty description.`,
          });
        }

        const aEvReq =
          typeof rawA.evidence_required === "string" &&
          rawA.evidence_required.trim().length > 0
            ? rawA.evidence_required.trim()
            : undefined;

        if (aId && !isPrototypeKey(aId) && aTitle && aDesc) {
          incomingAssertions.push({
            id: aId,
            title: aTitle,
            description: aDesc,
            ...(aEvReq !== undefined ? { evidenceRequired: aEvReq } : {}),
            status: "pending",
            updatedAt: nowIso,
          });
        }
      }
    }
  }

  const incomingFeatures: MissionFeature[] = [];
  const seenFeatureIds = new Set<string>();
  if (params.features !== undefined) {
    if (!Array.isArray(params.features)) {
      issues.push({
        code: "INVALID_INPUT",
        field: "features",
        message: "Plan features must be an array of feature objects.",
      });
    } else {
      for (let i = 0; i < params.features.length; i++) {
        const rawF = params.features[i];
        if (!rawF || typeof rawF !== "object" || Array.isArray(rawF)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "features",
            message: `Feature #${i + 1} must be an object.`,
          });
          continue;
        }
        const fId = typeof rawF.id === "string" ? rawF.id.trim() : "";
        const fTag = fId || `#${i + 1}`;
        if (!fId) {
          issues.push({
            code: "INVALID_INPUT",
            field: "features",
            message: `Feature #${i + 1} must have a non-empty id.`,
          });
        } else if (isPrototypeKey(fId)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "features",
            message: `Feature id "${fId}" is forbidden (prototype key).`,
          });
        } else if (seenFeatureIds.has(fId)) {
          issues.push({
            code: "INVALID_INPUT",
            field: "features",
            message: `Duplicate feature id "${fId}" — every feature must have a unique id.`,
          });
        } else {
          seenFeatureIds.add(fId);
        }

        const fTitle = typeof rawF.title === "string" ? rawF.title.trim() : "";
        if (!fTitle) {
          issues.push({
            code: "INVALID_INPUT",
            field: "features",
            message: `Feature "${fTag}" must have a non-empty title.`,
          });
        }

        const fDesc =
          typeof rawF.description === "string" ? rawF.description.trim() : "";
        if (!fDesc) {
          issues.push({
            code: "INVALID_INPUT",
            field: "features",
            message: `Feature "${fTag}" must have a non-empty description.`,
          });
        }

        const fMilestone =
          typeof rawF.milestone === "string" ? rawF.milestone.trim() : "";
        if (!fMilestone) {
          issues.push({
            code: "INVALID_INPUT",
            field: "features",
            message: `Feature "${fTag}" must have a non-empty milestone.`,
          });
        }

        const ownerLabel = `Feature "${fTag}"`;
        const dependsOn = normalizeValidatedStringList(
          rawF.depends_on,
          "depends_on",
          ownerLabel,
          issues,
          { rejectEmptyItems: true, dedupe: true },
        );
        const filesOwned = normalizeValidatedStringList(
          rawF.files_owned,
          "files_owned",
          ownerLabel,
          issues,
          { dedupe: true },
        );
        const preconditions = normalizeValidatedStringList(
          rawF.preconditions,
          "preconditions",
          ownerLabel,
          issues,
        );
        const expectedBehavior = normalizeValidatedStringList(
          rawF.expected_behavior,
          "expected_behavior",
          ownerLabel,
          issues,
        );
        const verificationSteps = normalizeValidatedStringList(
          rawF.verification_steps,
          "verification_steps",
          ownerLabel,
          issues,
        );
        const fulfills =
          normalizeValidatedStringList(
            rawF.fulfills,
            "fulfills",
            ownerLabel,
            issues,
            { rejectEmptyItems: true, dedupe: true },
          ) ?? [];

        if (fId && !isPrototypeKey(fId) && fTitle && fDesc && fMilestone) {
          incomingFeatures.push({
            id: fId,
            title: fTitle,
            description: fDesc,
            milestone: fMilestone,
            ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
            ...(filesOwned && filesOwned.length > 0 ? { filesOwned } : {}),
            ...(preconditions && preconditions.length > 0
              ? { preconditions }
              : {}),
            ...(expectedBehavior && expectedBehavior.length > 0
              ? { expectedBehavior }
              : {}),
            ...(verificationSteps && verificationSteps.length > 0
              ? { verificationSteps }
              : {}),
            fulfills,
            status: "pending",
            updatedAt: nowIso,
          });
        }
      }
    }
  }

  const existingAssertionMap = new Map<string, MissionAssertion>();
  for (const prevA of existingRun?.assertions ?? []) {
    if (prevA && typeof prevA.id === "string" && prevA.id.trim()) {
      existingAssertionMap.set(prevA.id.trim(), prevA);
    }
  }

  const existingFeatureMap = new Map<string, MissionFeature>();
  for (const prevF of existingRun?.features ?? []) {
    if (prevF && typeof prevF.id === "string" && prevF.id.trim()) {
      existingFeatureMap.set(prevF.id.trim(), prevF);
    }
  }

  const sealedMilestoneLabels = new Set<string>();
  for (const ms of existingRun?.milestones ?? []) {
    if (ms && ms.sealed === true && typeof ms.label === "string" && ms.label.trim()) {
      sealedMilestoneLabels.add(ms.label.trim());
    }
  }

  // Sealed milestone gate in tweak mode: reject adding new features (or moving features) into sealed milestones
  if (existingRun && sealedMilestoneLabels.size > 0) {
    for (const feat of incomingFeatures) {
      const prevFeat = existingFeatureMap.get(feat.id);
      if (
        sealedMilestoneLabels.has(feat.milestone) &&
        (!prevFeat || prevFeat.milestone.trim() !== feat.milestone)
      ) {
        const err = new SwarmProtocolError(
          "INVALID_INPUT",
          `Cannot add new feature "${feat.id}" into already sealed milestone "${feat.milestone}" — add a follow-up milestone instead.`,
          { featureId: feat.id, milestone: feat.milestone },
        );
        issues.push({
          code: err.code,
          field: "features",
          message: err.message,
        });
      }
    }
  }

  // Known omitted completed features from existingRun (supports incremental tweak depends_on
  // references and rejects contradictory VAL-* reclaims without dropping completed history)
  const carriedCompletedIds = new Set<string>();
  const carriedCompletedOwnerByVal = new Map<string, string>();
  if (existingRun && params.features !== undefined) {
    for (const [prevId, prevFeat] of existingFeatureMap.entries()) {
      if (prevFeat.status === "completed" && !seenFeatureIds.has(prevId)) {
        carriedCompletedIds.add(prevId);
        for (const valId of prevFeat.fulfills ?? []) {
          carriedCompletedOwnerByVal.set(valId, prevId);
        }
      }
    }
  }

  // Validate depends_on existence, acyclic DAG, and local static files_owned overlaps
  // against EFFECTIVE merged ownership, dependencies, and status (so tweak inheritance of
  // omitted filesOwned/dependsOn and cancelled->pending requeues are validated accurately).
  if (incomingFeatures.length > 0) {
    const effectiveIncomingFeatures: MissionFeature[] = existingRun
      ? incomingFeatures.map((inc) =>
          mergeIncomingFeatureWithPrior(
            existingFeatureMap.get(inc.id),
            inc,
            nowIso,
          ),
        )
      : incomingFeatures;

    const dagErrors = collectFeatureDagErrors(
      effectiveIncomingFeatures,
      carriedCompletedIds.size > 0 ? carriedCompletedIds : undefined,
    );
    for (const err of dagErrors) {
      issues.push({
        code: err.code,
        field: "features",
        message: err.message,
      });
    }

    const effectiveAllFeatures: MissionFeature[] = existingRun
      ? [
          ...Array.from(carriedCompletedIds)
            .map((id) => existingFeatureMap.get(id))
            .filter((f): f is MissionFeature => Boolean(f)),
          ...effectiveIncomingFeatures,
        ]
      : effectiveIncomingFeatures;

    const overlapIssues = collectFeatureFileOverlapIssues(effectiveAllFeatures);
    for (const overlapIssue of overlapIssues) {
      issues.push(overlapIssue);
    }
  }

  // Validate fulfills references:
  // - Every ID in feature.fulfills[] must match a defined assertion.id in assertions
  // - Reject contradictory reclaims of assertions already fulfilled by omitted completed features
  // - Reject duplicate fulfills claiming the same VAL-* across multiple features (1-to-1 leaf rule)
  // - If assertions is non-empty, require features to claim 100% of assertions (zero orphan assertions)
  const claimedAssertions = new Map<string, string>();
  for (const [valId, prevFeatId] of carriedCompletedOwnerByVal.entries()) {
    if (seenAssertionIds.has(valId)) {
      claimedAssertions.set(valId, prevFeatId);
    }
  }
  for (const feat of incomingFeatures) {
    for (const valId of feat.fulfills) {
      if (!seenAssertionIds.has(valId)) {
        issues.push({
          code: "INVALID_INPUT",
          field: "features",
          message: `Feature "${feat.id}" fulfills unknown assertion "${valId}" — define "${valId}" in assertions first.`,
        });
        continue;
      }
      const carriedOwner = carriedCompletedOwnerByVal.get(valId);
      if (carriedOwner) {
        issues.push({
          code: "INVALID_INPUT",
          field: "features",
          message: `Feature "${feat.id}" cannot reclaim assertion "${valId}" already fulfilled by completed feature "${carriedOwner}" — keep "${carriedOwner}" in features or define a new assertion ID instead.`,
        });
        continue;
      }
      const existingOwner = claimedAssertions.get(valId);
      if (existingOwner && existingOwner !== feat.id) {
        issues.push({
          code: "INVALID_INPUT",
          field: "features",
          message: `Duplicate fulfills claim for assertion "${valId}" across features "${existingOwner}" and "${feat.id}" — each assertion must be claimed by a single feature (1-to-1).`,
        });
      } else {
        claimedAssertions.set(valId, feat.id);
      }
    }
  }

  if (incomingAssertions.length > 0) {
    const unclaimed = incomingAssertions
      .filter((a) => !claimedAssertions.has(a.id))
      .map((a) => a.id);
    if (unclaimed.length > 0) {
      issues.push({
        code: "INVALID_INPUT",
        field: "assertions",
        message: `Unclaimed assertion(s) in validation contract: ${unclaimed.join(", ")} — features must claim 100% of assertions via fulfills[].`,
      });
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  // Smart normalization & canonical tweak-mode merge onto ProposedSwarmPlan
  const hasExplicitContractInput =
    params.assertions !== undefined || params.features !== undefined;

  if (existingRun) {
    const merged = mergeTweakedMissionContract(
      existingRun,
      {
        ...(hasExplicitContractInput
          ? { assertions: incomingAssertions, features: incomingFeatures }
          : {}),
        ...(params.commands !== undefined && normalizedCommands
          ? { commands: normalizedCommands }
          : {}),
        ...(params.services !== undefined && normalizedServices
          ? { services: normalizedServices }
          : {}),
        ...(params.boundaries !== undefined && normalizedBoundaries
          ? { boundaries: normalizedBoundaries }
          : {}),
      },
      nowIso,
    );

    return {
      valid: true,
      title,
      objective,
      strategy,
      acceptanceCriteria,
      ...(normalizedMembers.length > 0 ? { initialMembers: normalizedMembers } : {}),
      ...(merged.assertions ? { assertions: merged.assertions } : {}),
      ...(merged.features ? { features: merged.features } : {}),
      ...(merged.milestones ? { milestones: merged.milestones } : {}),
      ...(merged.commands ? { commands: merged.commands } : {}),
      ...(merged.services ? { services: merged.services } : {}),
      ...(merged.boundaries ? { boundaries: merged.boundaries } : {}),
    };
  }

  let finalAssertions: MissionAssertion[] | undefined;
  let finalFeatures: MissionFeature[] | undefined;
  let finalMilestones: SwarmMilestone[] | undefined;

  if (hasExplicitContractInput) {
    if (incomingAssertions.length > 0) {
      finalAssertions = incomingAssertions;
    }
    if (incomingFeatures.length > 0) {
      finalFeatures = incomingFeatures;
      finalMilestones = deriveMilestonesFromFeatures(
        incomingFeatures,
        undefined,
        incomingAssertions,
      );
    }
  }

  return {
    valid: true,
    title,
    objective,
    strategy,
    acceptanceCriteria,
    ...(normalizedMembers.length > 0 ? { initialMembers: normalizedMembers } : {}),
    ...(finalAssertions ? { assertions: finalAssertions } : {}),
    ...(finalFeatures ? { features: finalFeatures } : {}),
    ...(finalMilestones && finalMilestones.length > 0
      ? { milestones: finalMilestones }
      : {}),
    ...(normalizedCommands ? { commands: normalizedCommands } : {}),
    ...(normalizedServices ? { services: normalizedServices } : {}),
    ...(normalizedBoundaries ? { boundaries: normalizedBoundaries } : {}),
  };
}

/**
 * Validates `params` via `validateProposedSwarmPlan` and throws a genuine
 * `SwarmProtocolError(issue.code, issue.message)` when any validation gate fails
 * (including empty `assertions: []`, empty `features: []`, duplicate service ports,
 * or dependency cycles).
 */
export function assertProposedSwarmPlan(
  params: ProposeSwarmPlanInput,
  options?: ValidateProposedSwarmPlanOptions,
): Extract<ReturnType<typeof validateProposedSwarmPlan>, { valid: true }> {
  const result = validateProposedSwarmPlan(params, options);
  if (!result.valid) {
    const first = result.issues[0]!;
    throw new SwarmProtocolError(
      first.code,
      first.message,
      first.field ? { field: first.field } : undefined,
    );
  }
  return result;
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

function formatContractReviewRefinementRequest(
  plan: ProposedSwarmPlan,
  review: ContractReviewResult,
  passNumber: number,
): string {
  const summaryLine =
    review.summary?.trim() ||
    "Adversarial Contract Review identified blocking gaps in the proposed mission contract.";
  const lines: string[] = [
    `status: contract_review_changes_requested (pass ${passNumber})`,
    "",
    "### Adversarial Contract Review — Refinements Requested",
    "",
    summaryLine,
    "",
    "**Findings:**",
  ];

  if (!Array.isArray(review.findings) || review.findings.length === 0) {
    lines.push(`- [BLOCKING] (other) ${summaryLine}`);
  } else {
    for (const f of review.findings) {
      const sevTag = f.severity === "blocking" ? "[BLOCKING]" : "[WARNING]";
      const catTag = f.category || "other";
      const msg = f.message?.trim() || "(unspecified finding)";
      const suggestionLine = f.suggestion?.trim()
        ? `\n  Suggestion: ${f.suggestion.trim()}`
        : "";
      lines.push(`- ${sevTag} (${catTag}) ${msg}${suggestionLine}`);
    }
  }

  lines.push(
    "",
    "---",
    `Draft remains active for "${plan.title}" — do NOT ask the user to confirm yet. Address every [BLOCKING] finding above (add the missing \`VAL-*\` assertions, fix \`features\`/\`fulfills\`/disjoint \`files_owned\`, and verify \`commands\`/\`services\`) and call \`${PROPOSE_SWARM_PLAN_TOOL}\` again.`,
  );

  return lines.join("\n");
}

function formatRemainingContractReviewNote(
  review: ContractReviewResult,
  passNumber: number,
): string | undefined {
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const hasNotes =
    findings.length > 0 || passNumber >= 2 || !review.approved;
  if (!hasNotes) {
    return undefined;
  }

  const summary = review.summary?.trim() || "";
  const findingItems = findings
    .map((f) => {
      const sev = f.severity === "blocking" ? "[BLOCKING]" : "[WARNING]";
      const cat = f.category || "other";
      const msg = f.message?.trim() || "";
      const sug = f.suggestion?.trim() ? ` (Suggestion: ${f.suggestion.trim()})` : "";
      return `${sev} (${cat}) ${msg}${sug}`.trim();
    })
    .filter(Boolean);

  if (!summary && findingItems.length === 0) {
    return undefined;
  }

  const passTag = passNumber >= 2 ? ` (Pass ${passNumber})` : "";
  const bodyParts: string[] = [];
  if (summary) {
    bodyParts.push(summary);
  }
  if (findingItems.length > 0) {
    bodyParts.push(findingItems.join("; "));
  }
  return `Adversarial Contract Review${passTag}: ${bodyParts.join(" — ")}`;
}

export function createProposeSwarmPlanTool(
  deps: DraftingDeps,
  draftController: DraftStateController,
) {
  const reviewPassCounts = new Map<string, number>();

  const resolveDraftReviewKey = (
    draft: SwarmDraftState | null,
    ctx: ExtensionContext,
  ): string => {
    const sessionId = ctx?.sessionManager?.getSessionId?.() || "default-session";
    if (draft?.startedAt) {
      return `${sessionId}::${draft.mode}::${draft.startedAt}`;
    }
    return `${sessionId}::ephemeral`;
  };

  return defineTool({
    name: PROPOSE_SWARM_PLAN_TOOL,
    label: "Swarm Plan",
    description:
      "Validate a Contract-First Dynamic Swarm Plan (mandatory VAL-* assertions and milestone features with 100% fulfills coverage, plus commands, services, and boundaries), run Adversarial Contract Review, render a compact expandable summary card, and ask the user to Confirm, Continue refining, or Cancel.",
    promptSnippet:
      "Validate and present a Contract-First Dynamic Swarm Plan (title, objective, strategy, acceptance criteria, mandatory VAL-* assertions & milestone features, commands, services, boundaries, optional initial members) for user confirmation before launching.",
    promptGuidelines: [
      `Call \`${PROPOSE_SWARM_PLAN_TOOL}\` once requirements are clear with wave-by-wave disjoint file/directory ownership in \`strategy\`, exact runnable verification commands using already-installed repo scripts (no speculative \`npx -y\` downloads) in \`acceptance_criteria\` and \`commands\` (including optional \`"init"\` worktree setup), optional \`services\` with unique \`port\`s and acyclic \`depends_on\`, **mandatory** testable \`VAL-<AREA>-<NNN>\` \`assertions\` (\`minItems: 1\`) paired with ordered \`features\` (\`minItems: 1\`, 100% \`fulfills\` coverage + acyclic \`depends_on\` + disjoint \`files_owned\`), and wave-1 workers only in \`initial_members\` (spawn \`validator\` on demand once workers commit/post \`[done]\`); do NOT duplicate the full plan in prose beforehand because the expandable proposal card and confirmation modal present it automatically.`,
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

      if (Array.isArray(obj.assertions)) {
        prepared.assertions = obj.assertions.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return item;
          }
          const a = item as Record<string, unknown>;
          const evReq =
            typeof a.evidence_required === "string"
              ? a.evidence_required
              : typeof a.evidenceRequired === "string"
                ? a.evidenceRequired
                : undefined;
          return {
            ...a,
            id: typeof a.id === "string" ? a.id : "",
            title: typeof a.title === "string" ? a.title : "",
            description: typeof a.description === "string" ? a.description : "",
            ...(evReq !== undefined ? { evidence_required: evReq } : {}),
          };
        });
      }

      if (Array.isArray(obj.features)) {
        prepared.features = obj.features.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return item;
          }
          const f = item as Record<string, unknown>;
          return {
            ...f,
            id: typeof f.id === "string" ? f.id : "",
            title: typeof f.title === "string" ? f.title : "",
            description: typeof f.description === "string" ? f.description : "",
            milestone: typeof f.milestone === "string" ? f.milestone : "",
          };
        });
      }

      if (Array.isArray(obj.commands)) {
        prepared.commands = obj.commands.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return item;
          }
          const c = item as Record<string, unknown>;
          return {
            ...c,
            name: typeof c.name === "string" ? c.name : "",
            command: typeof c.command === "string" ? c.command : "",
          };
        });
      }

      if (Array.isArray(obj.services)) {
        prepared.services = obj.services.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return item;
          }
          const s = item as Record<string, unknown>;
          const depsList =
            s.depends_on !== undefined
              ? s.depends_on
              : Array.isArray(s.dependsOn)
                ? s.dependsOn
                : undefined;
          return {
            ...s,
            name: typeof s.name === "string" ? s.name : "",
            start: typeof s.start === "string" ? s.start : "",
            ...(depsList !== undefined ? { depends_on: depsList } : {}),
          };
        });
      }

      return prepared as ProposeSwarmPlanParams;
    },
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as ProposeSwarmPlanInput;
      const currentDraft = ensureDraftSynced(draftController, ctx);
      const settings = deps.getSettings();

      // Load existing run in tweak mode so pre-modal gates & smart progress merge inspect real state
      let existingRun: SwarmRunState | null = null;
      if (
        currentDraft?.mode === "tweak" &&
        currentDraft.targetRunId &&
        deps.store
      ) {
        try {
          existingRun = await deps.store.loadRun(currentDraft.targetRunId);
        } catch {
          existingRun = null;
        }
      }

      // Step 1: Pre-modal validation (required fields, initial_members, VAL-* assertions, features DAG & fulfills, services ports/DAG, sealed milestones)
      const validation = validateProposedSwarmPlan(params, {
        mode: currentDraft?.mode,
        existingRun,
      });
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
        ...(validation.assertions ? { assertions: validation.assertions } : {}),
        ...(validation.features ? { features: validation.features } : {}),
        ...(validation.milestones ? { milestones: validation.milestones } : {}),
        ...(validation.commands ? { commands: validation.commands } : {}),
        ...(validation.services ? { services: validation.services } : {}),
        ...(validation.boundaries ? { boundaries: validation.boundaries } : {}),
        ...(existingRun?.handoffItems && existingRun.handoffItems.length > 0
          ? { handoffItems: structuredClone(existingRun.handoffItems) }
          : {}),
        ...(existingRun?.lastAudit
          ? { lastAudit: structuredClone(existingRun.lastAudit) }
          : {}),
      };

      // Step 2.5: Pre-Modal Adversarial Contract Reviewer (at most 1 automatic rejection bounce per draft;
      // bypassed cleanly when draft.skipContractReview is true, while Step 1 local validation stays active)
      const draftReviewKey = resolveDraftReviewKey(currentDraft, ctx);
      let attachedContractReview: ContractReviewResult | undefined;
      let attachedReviewPass: number | undefined;
      if (
        typeof deps.reviewProposedContract === "function" &&
        proposedPlan.assertions &&
        proposedPlan.assertions.length > 0 &&
        currentDraft?.skipContractReview !== true &&
        currentDraft?.validatorEnabled !== false &&
        proposedPlan.validatorEnabled !== false
      ) {
        const currentPass = (reviewPassCounts.get(draftReviewKey) ?? 0) + 1;
        reviewPassCounts.set(draftReviewKey, currentPass);
        attachedReviewPass = currentPass;

        let review: ContractReviewResult | undefined;
        try {
          review = await deps.reviewProposedContract(proposedPlan, ctx, signal);
        } catch {
          review = undefined;
        }

        if (review) {
          attachedContractReview = review;
          const findings = Array.isArray(review.findings) ? review.findings : [];
          const hasBlockingFinding =
            !review.approved ||
            findings.some((f) => f && f.severity === "blocking");

          if (hasBlockingFinding && currentPass === 1) {
            return {
              content: [
                {
                  type: "text",
                  text: formatContractReviewRefinementRequest(
                    proposedPlan,
                    review,
                    currentPass,
                  ),
                },
              ],
              details: {
                outcome: "contract_review_changes_requested",
                status: "contract_review_changes_requested",
                plan: proposedPlan,
                contractReview: review,
                reviewPass: currentPass,
              } satisfies ProposeSwarmPlanToolDetails,
            };
          }

          const reviewNote = formatRemainingContractReviewNote(
            review,
            currentPass,
          );
          if (reviewNote) {
            proposedPlan.feedback = proposedPlan.feedback
              ? `${proposedPlan.feedback} | ${reviewNote}`
              : reviewNote;
          }
        }
      }

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
        const combinedFeedback =
          launchComment && proposedPlan.feedback
            ? `${launchComment} | ${proposedPlan.feedback}`
            : launchComment || proposedPlan.feedback;
        const finalPlan: ProposedSwarmPlan = {
          ...proposedPlan,
          strategy: launchComment
            ? `${proposedPlan.strategy}\n\nUser launch guidance: ${launchComment}`
            : proposedPlan.strategy,
          ...(outcome.roleModels ? { roleModels: outcome.roleModels } : {}),
          ...(combinedFeedback ? { feedback: combinedFeedback } : {}),
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
        reviewPassCounts.delete(draftReviewKey);
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
            ...(attachedContractReview
              ? {
                  contractReview: attachedContractReview,
                  reviewPass: attachedReviewPass,
                }
              : {}),
          } satisfies ProposeSwarmPlanToolDetails,
          terminate: true,
        };
      }

      if (outcome.action === "cancel") {
        reviewPassCounts.delete(draftReviewKey);
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
            ...(attachedContractReview
              ? {
                  contractReview: attachedContractReview,
                  reviewPass: attachedReviewPass,
                }
              : {}),
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
          ...(typeof currentDraft?.skipContractReview === "boolean"
            ? { skipContractReview: currentDraft.skipContractReview }
            : {}),
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
          ...(attachedContractReview
            ? {
                contractReview: attachedContractReview,
                reviewPass: attachedReviewPass,
              }
            : {}),
        } satisfies ProposeSwarmPlanToolDetails,
      };
    },
    renderCall(rawArgs: ProposeSwarmPlanParams, theme: Theme, context) {
      const args = rawArgs as ProposeSwarmPlanInput | undefined;
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

      const rawAssertions = Array.isArray(args?.assertions)
        ? args.assertions
        : [];
      const previewTimestamp = "";
      const previewAssertions: MissionAssertion[] = rawAssertions
        .filter((item): item is MissionAssertionProposalParams =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
        .map((a, idx) => {
          const id =
            typeof a.id === "string" && a.id.trim()
              ? a.id.trim()
              : `VAL-${idx + 1}`;
          const title = typeof a.title === "string" ? a.title.trim() : "";
          const description =
            typeof a.description === "string" ? a.description.trim() : "";
          const evReq =
            typeof a.evidence_required === "string" && a.evidence_required.trim()
              ? a.evidence_required.trim()
              : undefined;
          return {
            id,
            title,
            description,
            ...(evReq !== undefined ? { evidenceRequired: evReq } : {}),
            status: "pending" as const,
            updatedAt: previewTimestamp,
          };
        });

      const toCleanStringArray = (raw: unknown): string[] =>
        Array.isArray(raw)
          ? raw
              .filter((v): v is string => typeof v === "string")
              .map((v) => v.trim())
              .filter(Boolean)
          : [];

      const rawFeatures = Array.isArray(args?.features) ? args.features : [];
      const previewFeatures: MissionFeature[] = rawFeatures
        .filter((item): item is MissionFeatureProposalParams =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
        .map((f, idx) => {
          const id =
            typeof f.id === "string" && f.id.trim()
              ? f.id.trim()
              : `feature-${idx + 1}`;
          const title = typeof f.title === "string" ? f.title.trim() : "";
          const description =
            typeof f.description === "string" ? f.description.trim() : "";
          const milestone =
            typeof f.milestone === "string" && f.milestone.trim()
              ? f.milestone.trim()
              : "Milestone 1";
          const dependsOn = toCleanStringArray(f.depends_on);
          const filesOwned = toCleanStringArray(f.files_owned);
          const preconditions = toCleanStringArray(f.preconditions);
          const expectedBehavior = toCleanStringArray(f.expected_behavior);
          const verificationSteps = toCleanStringArray(f.verification_steps);
          const fulfills = toCleanStringArray(f.fulfills);
          return {
            id,
            title,
            description,
            milestone,
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            ...(filesOwned.length > 0 ? { filesOwned } : {}),
            ...(preconditions.length > 0 ? { preconditions } : {}),
            ...(expectedBehavior.length > 0 ? { expectedBehavior } : {}),
            ...(verificationSteps.length > 0 ? { verificationSteps } : {}),
            fulfills,
            status: "pending" as const,
            updatedAt: previewTimestamp,
          };
        });

      const previewMilestones =
        previewFeatures.length > 0
          ? deriveMilestonesFromFeatures(
              previewFeatures,
              undefined,
              previewAssertions,
            )
          : [];

      const rawCommands = Array.isArray(args?.commands) ? args.commands : [];
      const previewCommands: MissionCommandEntry[] = rawCommands
        .filter((item): item is MissionCommandProposalParams =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
        .map((c) => ({
          name: typeof c.name === "string" ? c.name.trim() : "",
          command: typeof c.command === "string" ? c.command.trim() : "",
        }))
        .filter((c) => Boolean(c.name && c.command));

      const rawServices = Array.isArray(args?.services) ? args.services : [];
      const previewServices: MissionServiceEntry[] = rawServices
        .filter((item): item is MissionServiceProposalParams =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
        .map((s) => {
          const name = typeof s.name === "string" ? s.name.trim() : "";
          const start = typeof s.start === "string" ? s.start.trim() : "";
          const stop =
            typeof s.stop === "string" && s.stop.trim() ? s.stop.trim() : undefined;
          const healthcheck =
            typeof s.healthcheck === "string" && s.healthcheck.trim()
              ? s.healthcheck.trim()
              : undefined;
          const port =
            typeof s.port === "number" &&
            Number.isInteger(s.port) &&
            s.port >= 1 &&
            s.port <= 65535
              ? s.port
              : undefined;
          const dependsOn = toCleanStringArray(s.depends_on);
          return {
            name,
            start,
            ...(stop !== undefined ? { stop } : {}),
            ...(healthcheck !== undefined ? { healthcheck } : {}),
            ...(port !== undefined ? { port } : {}),
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
          };
        })
        .filter((s) => Boolean(s.name && s.start));

      const previewBoundaries = toCleanStringArray(args?.boundaries);

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
        ...(previewAssertions.length > 0 ? { assertions: previewAssertions } : {}),
        ...(previewFeatures.length > 0 ? { features: previewFeatures } : {}),
        ...(previewMilestones.length > 0 ? { milestones: previewMilestones } : {}),
        ...(previewCommands.length > 0 ? { commands: previewCommands } : {}),
        ...(previewServices.length > 0 ? { services: previewServices } : {}),
        ...(previewBoundaries.length > 0 ? { boundaries: previewBoundaries } : {}),
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
        const contractParts: string[] = [];
        if (previewFeatures.length > 0) {
          contractParts.push(
            `${previewFeatures.length} ${previewFeatures.length === 1 ? "feature" : "features"}`,
          );
        }
        if (previewAssertions.length > 0) {
          contractParts.push(
            `${previewAssertions.length} VAL ${previewAssertions.length === 1 ? "assertion" : "assertions"}`,
          );
        }
        if (previewMilestones.length > 0) {
          contractParts.push(
            `${previewMilestones.length} ${previewMilestones.length === 1 ? "milestone" : "milestones"}`,
          );
        }
        if (previewServices.length > 0) {
          const portTags = previewServices
            .filter((s) => s.port !== undefined)
            .map((s) => `:${s.port}`);
          const portSuffix =
            portTags.length > 0 ? ` (${portTags.join(", ")})` : "";
          contractParts.push(
            `${previewServices.length} ${previewServices.length === 1 ? "service" : "services"}${portSuffix}`,
          );
        }
        if (contractParts.length === 0) {
          if (previewCommands.length > 0) {
            contractParts.push(
              `${previewCommands.length} ${previewCommands.length === 1 ? "command" : "commands"}`,
            );
          }
          if (previewBoundaries.length > 0) {
            contractParts.push(
              `${previewBoundaries.length} ${previewBoundaries.length === 1 ? "boundary" : "boundaries"}`,
            );
          }
        }
        if (contractParts.length > 0) {
          lines.push(
            `  ${theme.fg("muted", "Contract:")} ${theme.fg("accent", contractParts.join(" · "))}`,
          );
        }
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
        } else if (
          details?.outcome === "contract_review_changes_requested" ||
          details?.status === "contract_review_changes_requested"
        ) {
          statusHeader = `${theme.fg("warning", "⚠ [CONTRACT REVIEW · CHANGES REQUESTED]")}\n`;
        } else if (details?.outcome === "cancelled") {
          statusHeader = `${theme.fg("muted", "✕ [CANCELLED]")}\n`;
        }
        return new Text(
          `${statusHeader}${theme.fg("toolOutput", body)}`,
          0,
          0,
        );
      }

      if (
        details?.outcome === "contract_review_changes_requested" ||
        details?.status === "contract_review_changes_requested"
      ) {
        const findingCount = details.contractReview?.findings?.length ?? 0;
        const countTag =
          findingCount > 0
            ? ` (${findingCount} ${findingCount === 1 ? "finding" : "findings"})`
            : "";
        const expandHint = ` ${formatExpandHint(context, theme)}`;
        const summaryLine = formatInlineSnippet(
          details.contractReview?.summary ||
            "Adversarial Contract Review requested plan refinements.",
          96,
        );
        return new Text(
          `${theme.fg("warning", "⚠ [CONTRACT REVIEW]")}${theme.fg("toolOutput", `${countTag} ${summaryLine}`)}${expandHint}`,
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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ALL_SWARM_EXTENSION_TOOLS,
  DEFAULT_SWARM_SETTINGS,
  DRAFTING_TOOLS,
  IDLE_SWARM_TOOLS,
  SWARM_CORE_TOOLS,
  SWARM_DRAFT_ENTRY,
  SWARM_DRAFT_VERSION,
} from "../constants.js";
import { SWARM_SETTINGS_BOUNDS, isPrototypeKey } from "../store/index.js";
import type { ActiveSwarmDraft, SwarmDraftMode, SwarmSettings } from "../types.js";

// ============================================================================
// Types
// ============================================================================

export type SwarmToolProfileMode = "idle" | "drafting" | "running";

/**
 * Branch-local durable Swarm draft state persisted via `pi.appendEntry` (`version: 2`).
 */
export type SwarmDraftState = ActiveSwarmDraft;

export interface StartDraftOptions {
  mode?: SwarmDraftMode;
  seed: string;
  targetRunId?: string;
  validatorEnabled?: boolean;
  maxConcurrency?: number;
  baseBranch?: string;
  autoConfirm?: boolean;
  skipContractReview?: boolean;
  questionnaireEcho?: Record<string, string>;
}

export interface StartDraftExecutionOptions {
  applyToolProfile?: boolean;
  settings?: Partial<Pick<SwarmSettings, "validatorEnabled" | "maxConcurrency">>;
}

export type UpdateDraftPatch = Partial<
  Omit<SwarmDraftState, "version" | "startedAt" | "clearedAt">
>;

export interface DraftModalHooks {
  onModalEnter?: () => void;
  onModalExit?: () => void;
}

export type ExistingDraftAction = "resume" | "append" | "replace" | "cancel";

export interface StartOrResumeDraftResult {
  action: "started" | "resumed" | "appended" | "replaced" | "cancelled";
  draft: SwarmDraftState | null;
}

export type DraftPersistenceAPI = Pick<
  ExtensionAPI,
  "appendEntry" | "getActiveTools" | "setActiveTools"
>;

// ============================================================================
// Tool Profile Swap (Idempotent — Preserves Host & Third-Party Tools)
// ============================================================================

export { IDLE_SWARM_TOOLS };

export function getSwarmToolsForMode(mode: SwarmToolProfileMode): readonly string[] {
  switch (mode) {
    case "drafting":
      return DRAFTING_TOOLS;
    case "running":
      return SWARM_CORE_TOOLS;
    case "idle":
      return IDLE_SWARM_TOOLS;
  }
}

/**
 * Swaps ONLY `pi-swarm`'s own extension tools (`ALL_SWARM_EXTENSION_TOOLS`, 7 tools)
 * to the target profile while leaving all host tools (`read`, `grep`, `find`, `ls`,
 * `bash`, `edit`, `write`, etc.) and any third-party extension tools completely untouched.
 *
 * - `"idle"`     -> `IDLE_SWARM_TOOLS` (`["swarm"]`)
 * - `"drafting"` -> `DRAFTING_TOOLS` (`["swarm_question", "swarm_questionnaire", "propose_swarm_plan"]`)
 * - `"running"`  -> `SWARM_CORE_TOOLS` (`["swarm", "post_message", "read_board", "swarm_wait"]`)
 *
 * Calls `pi.setActiveTools()` ONLY when the sorted tool membership actually changes,
 * preventing unnecessary LLM prompt-cache invalidation.
 *
 * @returns `true` if `setActiveTools` was invoked, `false` if already in sync.
 */
export function applySwarmToolProfile(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  mode: SwarmToolProfileMode,
): boolean {
  const currentTools = pi.getActiveTools();
  const currentSet = new Set(currentTools);
  const nextSet = new Set(currentTools);

  for (const swarmTool of ALL_SWARM_EXTENSION_TOOLS) {
    nextSet.delete(swarmTool);
  }
  for (const targetTool of getSwarmToolsForMode(mode)) {
    nextSet.add(targetTool);
  }

  const sortedCurrent = [...currentSet].sort();
  const sortedNext = [...nextSet].sort();

  if (
    sortedCurrent.length === sortedNext.length &&
    sortedCurrent.every((name, idx) => name === sortedNext[idx])
  ) {
    return false;
  }

  pi.setActiveTools([...nextSet]);
  return true;
}

// ============================================================================
// Draft State Validation & Rehydration
// ============================================================================

function sanitizeConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(
    SWARM_SETTINGS_BOUNDS.maxConcurrency.max,
    Math.max(1, Math.floor(value)),
  );
}

function cloneEcho(echo?: Record<string, string>): Record<string, string> | undefined {
  if (!echo || typeof echo !== "object" || Array.isArray(echo)) {
    return undefined;
  }
  const entries = Object.entries(echo).filter(
    ([key, val]) =>
      typeof key === "string" &&
      !isPrototypeKey(key) &&
      typeof val === "string",
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function cloneDraft(draft: SwarmDraftState): SwarmDraftState {
  const echo = cloneEcho(draft.questionnaireEcho);
  const cloned: SwarmDraftState = {
    version: SWARM_DRAFT_VERSION,
    mode: draft.mode,
    seed: draft.seed,
    startedAt: draft.startedAt,
    validatorEnabled: draft.validatorEnabled,
    maxConcurrency: sanitizeConcurrency(draft.maxConcurrency),
  };
  if (draft.targetRunId !== undefined) {
    cloned.targetRunId = draft.targetRunId;
  }
  if (draft.baseBranch !== undefined) {
    cloned.baseBranch = draft.baseBranch;
  }
  if (typeof draft.autoConfirm === "boolean") {
    cloned.autoConfirm = draft.autoConfirm;
  }
  if (typeof draft.skipContractReview === "boolean") {
    cloned.skipContractReview = draft.skipContractReview;
  }
  if (echo !== undefined) {
    cloned.questionnaireEcho = echo;
  }
  if (draft.clearedAt !== undefined) {
    cloned.clearedAt = draft.clearedAt;
  }
  return cloned;
}

function isValidDraftMode(value: unknown): value is SwarmDraftMode {
  return value === "swarm" || value === "tweak";
}

function isSwarmDraftState(value: unknown): value is SwarmDraftState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj.version === SWARM_DRAFT_VERSION &&
    isValidDraftMode(obj.mode) &&
    typeof obj.seed === "string" &&
    typeof obj.startedAt === "string" &&
    typeof obj.validatorEnabled === "boolean" &&
    typeof obj.maxConcurrency === "number" &&
    Number.isFinite(obj.maxConcurrency) &&
    (obj.targetRunId === undefined || typeof obj.targetRunId === "string") &&
    (obj.baseBranch === undefined || typeof obj.baseBranch === "string") &&
    (obj.autoConfirm === undefined || typeof obj.autoConfirm === "boolean") &&
    (obj.skipContractReview === undefined ||
      typeof obj.skipContractReview === "boolean") &&
    (obj.questionnaireEcho === undefined ||
      (typeof obj.questionnaireEcho === "object" &&
        obj.questionnaireEcho !== null &&
        !Array.isArray(obj.questionnaireEcho))) &&
    (obj.clearedAt === undefined || typeof obj.clearedAt === "string")
  );
}

/**
 * Returns true if the given draft exists and has not been tombstoned via `clearedAt`.
 */
export function isDraftActive(
  draft: ActiveSwarmDraft | null | undefined,
): draft is ActiveSwarmDraft {
  return Boolean(draft && (!draft.clearedAt || draft.clearedAt.length === 0));
}

/**
 * Rehydrates the latest branch-local active Swarm draft (`version: 2`) by scanning
 * `ctx.sessionManager.getBranch()` backwards for `SWARM_DRAFT_ENTRY`.
 *
 * - Survives compaction (compaction entries sit alongside custom entries on the branch).
 * - Respects session tree navigation (`getBranch()` only walks root -> current leaf).
 * - Returns `null` if no entry exists, if the latest entry is tombstoned (`clearedAt`),
 *   or if the latest entry does not match `version: 2`.
 */
export function rehydrateDraft(
  ctx: Pick<ExtensionContext, "sessionManager">,
): SwarmDraftState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "custom" || entry.customType !== SWARM_DRAFT_ENTRY) {
      continue;
    }

    const data = entry.data;
    if (!data || typeof data !== "object") {
      return null;
    }

    const maybeCleared = (data as { clearedAt?: unknown }).clearedAt;
    if (typeof maybeCleared === "string" && maybeCleared.length > 0) {
      return null;
    }

    if (!isSwarmDraftState(data)) {
      return null;
    }

    return cloneDraft(data);
  }
  return null;
}

// ============================================================================
// Pure Draft Lifecycle Operations
// ============================================================================

/**
 * Starts a new durable branch-local draft (`version: 2`) without writing anything
 * under `.pi/swarm/runs/`.
 * Optionally swaps the active tool profile into `"drafting"` mode (default `true`).
 */
export function startDraft(
  pi: DraftPersistenceAPI,
  options: StartDraftOptions,
  opts?: StartDraftExecutionOptions,
): SwarmDraftState {
  const validatorEnabled =
    options.validatorEnabled ??
    opts?.settings?.validatorEnabled ??
    DEFAULT_SWARM_SETTINGS.validatorEnabled;
  const maxConcurrency = sanitizeConcurrency(
    options.maxConcurrency ??
      opts?.settings?.maxConcurrency ??
      DEFAULT_SWARM_SETTINGS.maxConcurrency,
  );

  const draft: SwarmDraftState = {
    version: SWARM_DRAFT_VERSION,
    mode: options.mode ?? "swarm",
    seed: options.seed.trim(),
    startedAt: new Date().toISOString(),
    validatorEnabled,
    maxConcurrency,
  };

  if (options.targetRunId?.trim()) {
    draft.targetRunId = options.targetRunId.trim();
  }
  if (options.baseBranch?.trim()) {
    draft.baseBranch = options.baseBranch.trim();
  }
  if (options.autoConfirm) {
    draft.autoConfirm = true;
  }
  if (options.skipContractReview) {
    draft.skipContractReview = true;
  }
  const echo = cloneEcho(options.questionnaireEcho);
  if (echo) {
    draft.questionnaireEcho = echo;
  }

  pi.appendEntry(SWARM_DRAFT_ENTRY, cloneDraft(draft));

  if (opts?.applyToolProfile !== false) {
    applySwarmToolProfile(pi, "drafting");
  }

  return cloneDraft(draft);
}

/**
 * Persists an incremental update to an active draft via `pi.appendEntry`.
 * Merges `questionnaireEcho` keys with any previously recorded answers.
 */
export function updateDraft(
  pi: Pick<ExtensionAPI, "appendEntry">,
  current: SwarmDraftState,
  patch: UpdateDraftPatch,
): SwarmDraftState {
  const mergedEcho =
    patch.questionnaireEcho !== undefined
      ? {
          ...(cloneEcho(current.questionnaireEcho) ?? {}),
          ...(cloneEcho(patch.questionnaireEcho) ?? {}),
        }
      : current.questionnaireEcho;

  const next: SwarmDraftState = {
    ...cloneDraft(current),
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.seed !== undefined ? { seed: patch.seed } : {}),
    ...(patch.targetRunId !== undefined ? { targetRunId: patch.targetRunId } : {}),
    ...(patch.validatorEnabled !== undefined
      ? { validatorEnabled: patch.validatorEnabled }
      : {}),
    ...(patch.maxConcurrency !== undefined
      ? { maxConcurrency: sanitizeConcurrency(patch.maxConcurrency) }
      : {}),
    ...(patch.baseBranch !== undefined ? { baseBranch: patch.baseBranch } : {}),
    ...(patch.autoConfirm !== undefined ? { autoConfirm: patch.autoConfirm } : {}),
    ...(patch.skipContractReview !== undefined
      ? { skipContractReview: patch.skipContractReview }
      : {}),
  };

  const cleanedEcho = cloneEcho(mergedEcho);
  if (cleanedEcho) {
    next.questionnaireEcho = cleanedEcho;
  } else {
    delete next.questionnaireEcho;
  }
  delete next.clearedAt;

  pi.appendEntry(SWARM_DRAFT_ENTRY, cloneDraft(next));
  return cloneDraft(next);
}

/**
 * Clears an active draft by appending a `clearedAt` tombstone entry.
 * If `nextProfile` is provided, also swaps the tool profile idempotently.
 */
export function clearDraft(
  pi: DraftPersistenceAPI,
  current: SwarmDraftState | null,
  nextProfile?: SwarmToolProfileMode,
): SwarmDraftState {
  const clearedAt = new Date().toISOString();
  const tombstone: SwarmDraftState = current
    ? {
        ...cloneDraft(current),
        clearedAt,
      }
    : {
        version: SWARM_DRAFT_VERSION,
        mode: "swarm",
        seed: "",
        startedAt: clearedAt,
        validatorEnabled: DEFAULT_SWARM_SETTINGS.validatorEnabled,
        maxConcurrency: DEFAULT_SWARM_SETTINGS.maxConcurrency,
        clearedAt,
      };

  pi.appendEntry(SWARM_DRAFT_ENTRY, cloneDraft(tombstone));

  if (nextProfile !== undefined) {
    applySwarmToolProfile(pi, nextProfile);
  }

  return tombstone;
}

// ============================================================================
// Existing-Draft Conflict Handling (Resume / Append / Replace / Cancel)
// ============================================================================

const EXISTING_DRAFT_RESUME_LABEL = "Resume — continue the active draft";
const EXISTING_DRAFT_APPEND_LABEL =
  "Append — add new goal details to the active draft";
const EXISTING_DRAFT_REPLACE_LABEL = "Replace — discard active draft and start fresh";
const EXISTING_DRAFT_CANCEL_LABEL = "Cancel — keep current state unchanged";

/**
 * Prompts the user with `Resume / [Append] / Replace / Cancel` when starting a second
 * draft while one is already active. Offers `Append` only when `incomingSeed` is
 * non-empty and differs from `existing.seed`. Wraps `ctx.ui.select` in
 * `onModalEnter`/`onModalExit` so global terminal shortcuts never hijack modal keys.
 */
export async function promptExistingDraftConflict(
  ctx: ExtensionContext,
  existing: SwarmDraftState,
  hooks?: DraftModalHooks,
  incomingSeed?: string,
): Promise<ExistingDraftAction> {
  if (!ctx.hasUI) {
    return "cancel";
  }

  const trimmedExisting = existing.seed.trim();
  const trimmedIncoming =
    typeof incomingSeed === "string" ? incomingSeed.trim() : "";
  const canAppend =
    trimmedIncoming.length > 0 && trimmedIncoming !== trimmedExisting;

  const seedSnippet =
    existing.seed.length > 60
      ? `${existing.seed.slice(0, 57)}...`
      : existing.seed || "(no seed)";
  const title = `A Swarm draft is already active ("${seedSnippet}"). How do you want to proceed?`;
  const choices = canAppend
    ? [
        EXISTING_DRAFT_RESUME_LABEL,
        EXISTING_DRAFT_APPEND_LABEL,
        EXISTING_DRAFT_REPLACE_LABEL,
        EXISTING_DRAFT_CANCEL_LABEL,
      ]
    : [
        EXISTING_DRAFT_RESUME_LABEL,
        EXISTING_DRAFT_REPLACE_LABEL,
        EXISTING_DRAFT_CANCEL_LABEL,
      ];

  let selected: string | undefined;
  hooks?.onModalEnter?.();
  try {
    selected = await ctx.ui.select(title, choices);
  } finally {
    hooks?.onModalExit?.();
  }

  if (selected === EXISTING_DRAFT_RESUME_LABEL) {
    return "resume";
  }
  if (canAppend && selected === EXISTING_DRAFT_APPEND_LABEL) {
    return "append";
  }
  if (selected === EXISTING_DRAFT_REPLACE_LABEL) {
    return "replace";
  }
  return "cancel";
}

/**
 * Starts a new draft or resolves a conflict with an already-active draft via
 * `Resume / Append / Replace / Cancel`.
 */
export async function startOrResolveDraft(
  pi: DraftPersistenceAPI,
  ctx: ExtensionContext,
  existing: SwarmDraftState | null,
  options: StartDraftOptions,
  hooks?: DraftModalHooks,
  startOpts?: StartDraftExecutionOptions,
): Promise<StartOrResumeDraftResult> {
  if (isDraftActive(existing)) {
    const decision = await promptExistingDraftConflict(
      ctx,
      existing,
      hooks,
      options.seed,
    );
    if (decision === "cancel") {
      return { action: "cancelled", draft: cloneDraft(existing) };
    }
    if (decision === "resume") {
      applySwarmToolProfile(pi, "drafting");
      return { action: "resumed", draft: cloneDraft(existing) };
    }
    if (decision === "append") {
      const existingSeed = existing.seed.trim();
      const incomingSeed = options.seed.trim();
      const mergedSeed = existingSeed
        ? `${existingSeed}\n\n${incomingSeed}`
        : incomingSeed;
      const appended = updateDraft(pi, existing, { seed: mergedSeed });
      applySwarmToolProfile(pi, "drafting");
      return { action: "appended", draft: appended };
    }
    // decision === "replace"
    clearDraft(pi, existing);
    const replaced = startDraft(pi, options, startOpts);
    return { action: "replaced", draft: replaced };
  }

  const started = startDraft(pi, options, startOpts);
  return { action: "started", draft: started };
}

// ============================================================================
// Stateful Draft Controller (In-Memory Cache + Branch-Local Persistence)
// ============================================================================

export class DraftStateController {
  private readonly pi: DraftPersistenceAPI;
  private readonly hooks?: DraftModalHooks;
  private readonly getSettings?: () => Partial<
    Pick<SwarmSettings, "validatorEnabled" | "maxConcurrency">
  >;
  private current: SwarmDraftState | null = null;

  constructor(
    pi: DraftPersistenceAPI,
    hooks?: DraftModalHooks,
    getSettings?: () => Partial<
      Pick<SwarmSettings, "validatorEnabled" | "maxConcurrency">
    >,
  ) {
    this.pi = pi;
    this.hooks = hooks;
    this.getSettings = getSettings;
  }

  private resolveStartOpts(
    opts?: StartDraftExecutionOptions,
  ): StartDraftExecutionOptions | undefined {
    if (opts?.settings || !this.getSettings) {
      return opts;
    }
    return {
      ...opts,
      settings: this.getSettings(),
    };
  }

  getDraft(): SwarmDraftState | null {
    return this.current ? cloneDraft(this.current) : null;
  }

  isActive(): boolean {
    return isDraftActive(this.current);
  }

  rehydrate(
    ctx: Pick<ExtensionContext, "sessionManager">,
    options?: { syncToolProfile?: boolean; hasActiveRun?: boolean },
  ): SwarmDraftState | null {
    this.current = rehydrateDraft(ctx);
    if (options?.syncToolProfile) {
      const targetMode: SwarmToolProfileMode = this.current
        ? "drafting"
        : options.hasActiveRun
          ? "running"
          : "idle";
      applySwarmToolProfile(this.pi, targetMode);
    }
    return this.getDraft();
  }

  start(
    options: StartDraftOptions,
    opts?: StartDraftExecutionOptions,
  ): SwarmDraftState {
    this.current = startDraft(this.pi, options, this.resolveStartOpts(opts));
    return this.getDraft()!;
  }

  async startOrResolve(
    ctx: ExtensionContext,
    options: StartDraftOptions,
    opts?: StartDraftExecutionOptions,
  ): Promise<StartOrResumeDraftResult> {
    this.rehydrate(ctx, { syncToolProfile: false });
    const result = await startOrResolveDraft(
      this.pi,
      ctx,
      this.current,
      options,
      this.hooks,
      this.resolveStartOpts(opts),
    );
    this.current = result.draft ? cloneDraft(result.draft) : null;
    return result;
  }

  update(patch: UpdateDraftPatch): SwarmDraftState | null {
    if (!this.current) {
      return null;
    }
    this.current = updateDraft(this.pi, this.current, patch);
    return this.getDraft();
  }

  recordQuestionnaireAnswers(
    answers: Record<string, string>,
  ): SwarmDraftState | null {
    if (!this.current || Object.keys(answers).length === 0) {
      return this.getDraft();
    }
    this.current = updateDraft(this.pi, this.current, {
      questionnaireEcho: answers,
    });
    return this.getDraft();
  }

  clear(nextProfile?: SwarmToolProfileMode): void {
    clearDraft(this.pi, this.current, nextProfile);
    this.current = null;
  }

  applyToolProfile(mode: SwarmToolProfileMode): boolean {
    return applySwarmToolProfile(this.pi, mode);
  }
}

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertOwnerSession, isPrototypeKey, parseModelSpec } from "../store/index.js";
import { MAX_LIBRARY_TOPIC_BYTES } from "../store/swarm-store.js";
import {
  ALL_MENTION_NAME,
  ASSERTION_STATUSES,
  CHANNEL_NAME_PATTERN,
  DEFAULT_CHANNEL,
  DEFAULT_LIBRARY_TOPICS,
  DEFAULT_SWARM_SETTINGS,
  FEATURE_STATUSES,
  findSafetySensitiveMemberSegment,
  HANDOFF_RESOLUTIONS,
  MEMBER_NAME_PATTERN,
  MONITOR_NAME,
  ORCHESTRATOR_NAME,
  POST_MESSAGE_TOOL,
  PROPOSE_SWARM_PLAN_TOOL,
  RESERVED_MEMBER_NAMES,
  SWARM_BRANCH_PREFIX,
  SWARM_DIR,
  SWARM_LIBRARY_DIR,
  SWARM_MAX_BOARD_HOPS,
  SWARM_MISSION_OPS,
  SWARM_RUNS_DIR,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
} from "../constants.js";
import {
  type AddHelperInput,
  type AddMemberInput,
  type AgentTelemetryEvent,
  type AgentTurnResult,
  type AssertionStatus,
  type AvailableModelInfo,
  type BoardMessage,
  type BoardMessageKind,
  type CallerRole,
  type CompleteRunOptions,
  type FeatureStatus,
  type HandoffItemResolution,
  type ISwarmEngine,
  isReconRun,
  type ISwarmStore,
  type ISwarmTransport,
  type IWorktreeManager,
  type KillMemberOptions,
  type ManageChannelInput,
  type ManageChannelResult,
  type ManageMissionInput,
  type ManageMissionResult,
  type MemberEngineBridge,
  type MergeBranchResult,
  type MergeMemberOptions,
  type MissionAssertion,
  type MissionCommandEntry,
  type MissionFeature,
  type MissionHandoffItem,
  type MissionServiceEntry,
  type ParkOrchestratorWaitOptions,
  type ParkOrchestratorWaitResult,
  type PersistentAgentHandle,
  type PostBoardMessageInput,
  type PromoteReconRunInput,
  type PropagateRoleModelOptions,
  type PropagateRoleModelResult,
  type ReadBoardOptions,
  type ReadBoardResult,
  type RunUpdateInput,
  type SafeTeardownResult,
  type SafeTeardownTarget,
  type StopMemberOptions,
  type SwarmChannelRecord,
  type SwarmEngineEvent,
  type SwarmEngineEventType,
  type SwarmEvent,
  type SwarmMemberRecord,
  type SwarmMemberRole,
  type SwarmMemberStatusEntry,
  type SwarmMilestone,
  type SwarmMissionOp,
  type SwarmModelRole,
  SwarmProtocolError,
  type SwarmRoleModels,
  type SwarmRosterStatus,
  type SwarmRunState,
  type SwarmSettings,
  type SwarmSnapshot,
  type SwarmWorkspaceMode,
  type SwitchModelOptions,
  type SwitchModelResult,
  type TeardownEntryResult,
  type TeardownOptions,
  type TokenUsage,
  type WaitForBoardOptions,
  type WaitForBoardResult,
} from "../types.js";
import {
  ConcurrencyGate,
  RateLimitBreaker,
  selectFallbackModel,
} from "./rate-limit.js";
import {
  buildMemberInitialPrompt,
  buildMemberSystemPrompt,
  buildWakeupPrompt,
} from "./role-prompts.js";
import {
  extractSessionMessages,
  getRunValidatorScratchRoot,
  getValidatorScratchDir,
  isPathInScope,
  resolveRoleModel,
  sanitizeForkSeedMessages,
} from "./transport.js";

// ============================================================================
// Parsing & Helper Utilities
// ============================================================================

const RESERVED_SET: ReadonlySet<string> = new Set<string>(RESERVED_MEMBER_NAMES);

/** Matches `@<name>` handles (not emails, not `@@`, and NOT `@#channel`). */
const HANDLE_MENTION_RE =
  /(?<![A-Za-z0-9._%+@-])@(?!#)([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;

/** Matches `@#<channel>` channel broadcasts (1–32 chars starting with ASCII letter; not emails or `@@#`). */
const CHANNEL_MENTION_RE =
  /(?<![A-Za-z0-9._%+\-@])@#([A-Za-z](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?)/g;

const WAIT_TELEMETRY_RE = /^swarm_wait since=#(\d+) mentions_only=(true|false)$/;

/** Anchored `[done]` prefix (start of message, optionally preceded by `@handle` / `@#channel` mentions). */
const DONE_PREFIX_RE =
  /^\s*(?:@#?[A-Za-z0-9._-]+\s+)*\[done\](?=\s|$|[:,.;!\])-])/i;

const BARRIER_URGENT_TAG_RE =
  /\[(?:blocker|error|rate-limit|hop-cap|stall|NEEDS_HUMAN)\]/i;
const WORKER_DONE_URGENT_TAG_RE = /\[(?:blocker|error|NEEDS_HUMAN)\]/i;

function isUrgentBarrierBypassMessage(msg: BoardMessage): boolean {
  return (
    msg.fromRole === "human" ||
    msg.fromRole === "monitor" ||
    BARRIER_URGENT_TAG_RE.test(msg.text)
  );
}

const BOARD_CACHE_LIMIT = 200;
const EVENT_CACHE_LIMIT = 50;
const MAX_SHARD_COUNT = 32;

function parseHandleMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  HANDLE_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HANDLE_MENTION_RE.exec(text)) !== null) {
    const handle = match[1]!;
    const key = handle.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(handle);
    }
  }
  return out;
}

function parseChannelMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  CHANNEL_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHANNEL_MENTION_RE.exec(text)) !== null) {
    const ch = match[1]!.toLowerCase();
    if (!seen.has(ch)) {
      seen.add(ch);
      out.push(ch);
    }
  }
  return out;
}

function mergeUniqueLower(lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      const cleaned = raw.trim().replace(/^@#?/, "").toLowerCase();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function getOwnMember(
  run: SwarmRunState | null | undefined,
  name: string,
): SwarmMemberRecord | undefined {
  if (!run || !Object.hasOwn(run.members, name)) {
    return undefined;
  }
  return run.members[name];
}

function getOwnChannel(
  run: SwarmRunState | null | undefined,
  name: string,
): SwarmChannelRecord | undefined {
  if (!run || !Object.hasOwn(run.channels, name)) {
    return undefined;
  }
  return run.channels[name];
}

function validateMemberName(rawName: string): string {
  const name = rawName.trim();
  if (!name || !MEMBER_NAME_PATTERN.test(name)) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Invalid member name "${rawName}". Names must match ${MEMBER_NAME_PATTERN.source} (short lowercase alphanumeric/hyphen).`,
      { name: rawName },
    );
  }
  if (RESERVED_SET.has(name.toLowerCase())) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Member name "${name}" is reserved (${RESERVED_MEMBER_NAMES.join(", ")}).`,
      { name },
    );
  }
  if (isPrototypeKey(name)) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Member name "${name}" is a reserved prototype key.`,
      { name },
    );
  }
  const sensitiveSeg = findSafetySensitiveMemberSegment(name);
  if (sensitiveSeg) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Member name "${name}" contains security-sensitive segment "${sensitiveSeg}" which can trigger provider cybersecurity safety filters. Choose a neutral QA/engineering handle instead (e.g. "probe", "audit", "verify", "mutcheck", "negtest").`,
      { name, segment: sensitiveSeg },
    );
  }
  return name;
}

function validateChannelName(rawName: string): string {
  const name = rawName.trim().toLowerCase();
  if (!name || !CHANNEL_NAME_PATTERN.test(name) || isPrototypeKey(name)) {
    throw new SwarmProtocolError(
      "INVALID_CHANNEL",
      `Invalid channel name "${rawName}". Channel names must match ${CHANNEL_NAME_PATTERN.source}.`,
      { channel: rawName },
    );
  }
  return name;
}

function normalizeOptionalChannel(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const cleaned = raw.trim().replace(/^#+/, "");
  if (!cleaned) {
    return undefined;
  }
  const lower = cleaned.toLowerCase();
  if (lower === "null" || lower === "undefined") {
    return undefined;
  }
  return cleaned;
}

function isIsolatedWorktreeWorkspace(
  workspace: SwarmWorkspaceMode,
): workspace is "share" | "branch" {
  return workspace === "share" || workspace === "branch";
}

function isOrchestratorOrHuman(role: CallerRole | undefined): boolean {
  return role === undefined || role === "orchestrator" || role === "human";
}

function buildRoleModelsSnapshot(
  settings: SwarmSettings,
  runRoleModels?: SwarmRoleModels,
): SwarmRoleModels {
  return {
    orchestrator: {
      model: runRoleModels?.orchestrator?.model ?? settings.orchestratorModel,
      thinkingLevel:
        runRoleModels?.orchestrator?.thinkingLevel ?? settings.orchestratorThinkingLevel,
    },
    worker: {
      model: settings.workerModel ?? runRoleModels?.worker?.model,
      thinkingLevel: settings.workerThinkingLevel ?? runRoleModels?.worker?.thinkingLevel,
    },
    validator: {
      model: settings.validatorModel ?? runRoleModels?.validator?.model,
      thinkingLevel: settings.validatorThinkingLevel ?? runRoleModels?.validator?.thinkingLevel,
    },
    fallbackModels:
      settings.fallbackModels.length > 0
        ? [...settings.fallbackModels]
        : [...(runRoleModels?.fallbackModels ?? [])],
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function mergeTokenBreakdown(
  prior: TokenUsage | undefined,
  current: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!prior && !current) {
    return undefined;
  }
  return {
    input: (prior?.input ?? 0) + (current?.input ?? 0),
    output: (prior?.output ?? 0) + (current?.output ?? 0),
    cacheRead: (prior?.cacheRead ?? 0) + (current?.cacheRead ?? 0),
    cacheWrite: (prior?.cacheWrite ?? 0) + (current?.cacheWrite ?? 0),
    total: (prior?.total ?? 0) + (current?.total ?? 0),
  };
}

function maxTokenBreakdown(
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    total: Math.max(a.total, b.total),
  };
}

function sanitizeStallMentionsText(
  text: string,
  allowedMentions: readonly string[],
): string {
  const allowedLower = new Set(allowedMentions.map((m) => m.toLowerCase()));
  const allowCoordinatorAlias = allowedLower.has(ORCHESTRATOR_NAME);
  const kept = new Set<string>();
  const withoutSecondaryHandles = text.replace(
    HANDLE_MENTION_RE,
    (full, handle: string) => {
      const lower = handle.toLowerCase();
      const isAllowed =
        allowedLower.has(lower) || (allowCoordinatorAlias && lower === "coordinator");
      if (isAllowed && !kept.has(lower)) {
        kept.add(lower);
        return full;
      }
      return handle;
    },
  );
  return withoutSecondaryHandles.replace(CHANNEL_MENTION_RE, (_full, ch: string) => `#${ch}`);
}

const VALID_MISSION_OPS_SET: ReadonlySet<SwarmMissionOp> = new Set<SwarmMissionOp>(
  SWARM_MISSION_OPS,
);
const VALID_ASSERTION_STATUS_SET: ReadonlySet<AssertionStatus> = new Set<AssertionStatus>(
  ASSERTION_STATUSES,
);
const VALID_FEATURE_STATUS_SET: ReadonlySet<FeatureStatus> = new Set<FeatureStatus>(
  FEATURE_STATUSES,
);
const VALID_HANDOFF_RESOLUTION_SET: ReadonlySet<HandoffItemResolution> =
  new Set<HandoffItemResolution>(HANDOFF_RESOLUTIONS);

const LAZY_JUSTIFICATION_RE =
  /\b(?:low[\s-]+priority|non[\s-]+blocking|will\s+handle\s+later|handle\s+later|fix\s+later|todo|minor\s+issue|do\s+it\s+later|defer(?:red|ring)?\s+for\s+now)\b/i;

const LAZY_OVERRIDE_EXCUSE_RE =
  /^(low[\s-]*priority|non[\s-]*blocking|will\s+(handle|fix|do)\s+later|later|todo|n\/a|minor|ignore|skip|force)\b/i;

const LIBRARY_TOPIC_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function normalizeLibraryTopicName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !LIBRARY_TOPIC_RE.test(trimmed) || isPrototypeKey(trimmed)) {
    throw new SwarmProtocolError(
      "INVALID_INPUT",
      `Invalid library_topic "${raw}". Expected alphanumeric/hyphen/underscore topic name matching ${LIBRARY_TOPIC_RE.source}.`,
      { libraryTopic: raw },
    );
  }
  return trimmed.toLowerCase();
}

function normalizeOwnedPath(raw: string): string | null {
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return null;
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  p = p.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (p === "." || p === "*" || p === "**" || p === "**/*" || p === "") {
    return "";
  }
  p = p.replace(/\/\*\*\/\*$/, "").replace(/\/\*+$/, "").replace(/\/+$/, "");
  if (p === "." || p === "*" || p === "**" || p === "**/*" || p === "") {
    return "";
  }
  return p;
}

function hasGlobWildcards(p: string): boolean {
  return p.includes("*") || p.includes("?");
}

function extractStaticDirPrefix(p: string): string {
  const segs = p.split("/");
  const staticSegs: string[] = [];
  for (const seg of segs) {
    if (seg.includes("*") || seg.includes("?")) {
      break;
    }
    staticSegs.push(seg);
  }
  return staticSegs.join("/");
}

function singleOwnedPathsCollide(a: string, b: string): boolean {
  if (a === "" || b === "") return true;
  if (a === b) return true;
  const aGlob = hasGlobWildcards(a);
  const bGlob = hasGlobWildcards(b);
  if (!aGlob && !bGlob) {
    return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }
  if (aGlob && !bGlob) {
    if (isPathInScope(b, [a])) return true;
    const prefixA = extractStaticDirPrefix(a);
    if (prefixA === b || prefixA.startsWith(`${b}/`)) return true;
    // If `b` can be a directory (no file extension) inside `a`'s glob root
    if (
      !path.posix.extname(b) &&
      (prefixA === "" || b.startsWith(`${prefixA}/`)) &&
      (a.includes("**") || prefixA === b)
    ) {
      return true;
    }
    return false;
  }
  if (!aGlob && bGlob) {
    return singleOwnedPathsCollide(b, a);
  }
  const prefixA = extractStaticDirPrefix(a);
  const prefixB = extractStaticDirPrefix(b);
  if (prefixA === "" || prefixB === "" || prefixA === prefixB) {
    return true;
  }
  return prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`);
}

function ownedPathsOverlap(
  pathsA: readonly string[] | undefined,
  pathsB: readonly string[] | undefined,
): boolean {
  if (!pathsA?.length || !pathsB?.length) return false;
  const normA = pathsA
    .map(normalizeOwnedPath)
    .filter((p): p is string => p !== null);
  const normB = pathsB
    .map(normalizeOwnedPath)
    .filter((p): p is string => p !== null);
  if (normA.length === 0 || normB.length === 0) return false;
  for (const a of normA) {
    for (const b of normB) {
      if (singleOwnedPathsCollide(a, b)) {
        return true;
      }
    }
  }
  return false;
}

function effectiveDispatchOwnedPaths(feat: MissionFeature): readonly string[] {
  return feat.filesOwned && feat.filesOwned.length > 0 ? feat.filesOwned : ["*"];
}

function uniqueHandleFromFeatureId(
  featureId: string,
  run: SwarmRunState,
  liveNames: Iterable<string>,
  reservedLower?: Set<string>,
): string {
  let slug = featureId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((seg) => Boolean(seg) && !findSafetySensitiveMemberSegment(seg))
    .join("-");
  if (!slug || !/^[a-z]/.test(slug)) {
    slug = slug ? `w-${slug}` : "worker";
  }
  if (RESERVED_SET.has(slug) || isPrototypeKey(slug)) {
    slug = `w-${slug}`;
  }
  const base = slug.slice(0, 26).replace(/-+$/g, "") || "worker";
  const taken = new Set<string>(reservedLower ?? []);
  for (const name of Object.keys(run.members)) {
    taken.add(name.toLowerCase());
  }
  for (const name of liveNames) {
    taken.add(name.toLowerCase());
  }
  if (!taken.has(base) && MEMBER_NAME_PATTERN.test(base) && !RESERVED_SET.has(base)) {
    reservedLower?.add(base);
    return base;
  }
  for (let idx = 2; idx <= 9999; idx++) {
    const suffix = `-${idx}`;
    const prefix =
      base.slice(0, Math.max(1, 32 - suffix.length)).replace(/-+$/g, "") || "w";
    const candidate = `${prefix}${suffix}`;
    if (
      !taken.has(candidate) &&
      MEMBER_NAME_PATTERN.test(candidate) &&
      !RESERVED_SET.has(candidate)
    ) {
      reservedLower?.add(candidate);
      return candidate;
    }
  }
  const fallback = `w-${randomBytes(3).toString("hex")}`;
  reservedLower?.add(fallback);
  return fallback;
}

function uniqueValidatorHandle(
  run: SwarmRunState,
  liveNames: Iterable<string>,
): string {
  const taken = new Set<string>();
  for (const name of Object.keys(run.members)) {
    taken.add(name.toLowerCase());
  }
  for (const name of liveNames) {
    taken.add(name.toLowerCase());
  }
  if (!taken.has("validator")) {
    return "validator";
  }
  for (let idx = 2; idx <= 9999; idx++) {
    const candidate = `validator-${idx}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `validator-${randomBytes(2).toString("hex")}`;
}

function buildFeatureWorkerBrief(
  run: SwarmRunState,
  feat: MissionFeature,
  workspace: SwarmWorkspaceMode = "inherit",
  liveValidatorHandle?: string,
): string {
  const assertionMap = new Map((run.assertions ?? []).map((a) => [a.id, a]));
  const fulfilledDetails = feat.fulfills.map((id) => {
    const a = assertionMap.get(id);
    if (!a) return `  - \`${id}\``;
    const evPart = a.evidenceRequired ? ` (required evidence: ${a.evidenceRequired})` : "";
    return `  - \`${a.id}\`: ${a.title} — ${a.description}${evPart}`;
  });
  const cmdSummary =
    run.commands && run.commands.length > 0
      ? run.commands
          .filter((c) => c.name.trim().toLowerCase() !== "init")
          .map((c) => `${c.name}: \`${c.command}\``)
          .join(" | ")
      : "(inspect package.json / repo scripts)";
  const svcSummary =
    run.services && run.services.length > 0
      ? run.services
          .map(
            (s) =>
              `${s.name}${s.port !== undefined ? `:${s.port}` : ""} (start: \`${s.start}\`${s.healthcheck ? `, healthcheck: \`${s.healthcheck}\`` : ""})`,
          )
          .join(" | ")
      : "";
  const ownedFilesText =
    feat.filesOwned && feat.filesOwned.length > 0
      ? feat.filesOwned.map((p) => `\`${p}\``).join(", ")
      : "(scoped to this feature only — do not touch files owned by sibling features)";

  const lines: string[] = [
    `Implement Mission Feature \`${feat.id}\` — **${feat.title}** (milestone: \`${feat.milestone}\`).`,
    "",
    `Scope: ${feat.description || feat.title}`,
  ];
  if (feat.preconditions && feat.preconditions.length > 0) {
    lines.push(`Preconditions: ${feat.preconditions.join("; ")}`);
  }
  if (feat.expectedBehavior && feat.expectedBehavior.length > 0) {
    lines.push(`Expected Behavior: ${feat.expectedBehavior.join("; ")}`);
  }
  lines.push(
    "",
    "(a) Exclusive File Ownership & Boundaries:",
    `- Owned files/paths: ${ownedFilesText}. Do NOT edit files outside your ownership slice.`,
  );
  if (run.boundaries && run.boundaries.length > 0) {
    lines.push(`- Mission boundaries: ${run.boundaries.join(" · ")}`);
  }
  lines.push(
    "",
    "(b) Validation Contract & Shared Library:",
    `- Startup step 1: Read shared Mission Library (\`${SWARM_DIR}/${SWARM_RUNS_DIR}/${run.id}/${SWARM_LIBRARY_DIR}/\`) via \`${SWARM_TOOL}{action:"mission", mission_op:"read_library"}\` to reuse architecture/environment/testing notes, and record non-obvious discoveries via \`mission_op:"write_library"\` (\`library_append:true\`).`,
  );
  if (fulfilledDetails.length > 0) {
    lines.push("- Fulfilled VAL-* assertions:", ...fulfilledDetails);
  }
  lines.push(
    "",
    "(c) Baseline Check & Verification Commands:",
    `- Operational commands: ${cmdSummary}`,
  );
  if (svcSummary) {
    lines.push(`- Services & reserved ports: ${svcSummary}`);
  }
  if (feat.verificationSteps && feat.verificationSteps.length > 0) {
    lines.push(`- Feature verification steps: ${feat.verificationSteps.join(" && ")}`);
  }
  const wsInstruction =
    workspace === "inherit"
      ? '- Implement and verify all changes strictly within your owned files in the shared `inherit` workspace (skip full-repo baseline build/test suites before editing if `library/testing.md` already records baseline health; run targeted verification after editing, and do NOT switch branches or run `git commit` / destructive workspace-wide git commands).'
      : `- Verify baseline health before editing, implement and verify all changes inside your isolated \`${workspace}\` worktree, and commit cleanly on your branch (\`git status\` clean).`;
  const doorbellTarget = liveValidatorHandle?.trim() || ORCHESTRATOR_NAME;
  const doneHeaderExample =
    workspace === "inherit"
      ? `@${doorbellTarget} [done] workspace=<cwd> <concise summary>`
      : `@${doorbellTarget} [done] commit=<sha> workspace=<cwd> <concise summary>`;
  const fallbackNote = liveValidatorHandle?.trim()
    ? ` (fall back to \`@${ORCHESTRATOR_NAME} [done] ...\` if \`@${doorbellTarget}\` has been retired)`
    : "";
  lines.push(
    wsInstruction,
    "",
    "(d) Next-Peer Doorbell & Mandatory Structured Handoff:",
    `- Report completion via \`${POST_MESSAGE_TOOL}\` starting with \`${doneHeaderExample}\`${fallbackNote} AND pass \`feature_id: "${feat.id}"\`, \`verification_evidence\` (>= 10 chars with exact commands & pass counts), plus any \`discovered_issues\` / \`left_undone\`, then call \`${SWARM_WAIT_TOOL}\`.`,
  );
  return lines.join("\n");
}

function buildMilestoneValidationBrief(
  run: SwarmRunState,
  milestoneLabel: string,
  mFeatures: readonly MissionFeature[],
  pendingOrFailed: readonly MissionAssertion[],
  alreadyPassed: readonly MissionAssertion[],
  options?: { postMergeIntegrationCheck?: boolean },
): string {
  const nonInitCommands = (run.commands ?? []).filter(
    (c) => c.name.trim().toLowerCase() !== "init",
  );
  const cmdManifest =
    nonInitCommands.length > 0
      ? nonInitCommands.map((c) => `${c.name}: \`${c.command}\``).join(" | ")
      : "(inspect package.json / repo test & typecheck scripts)";
  const mergedFeatureSummary = mFeatures
    .map((f) =>
      f.mergedCommitSha ? `${f.id} (${f.mergedCommitSha.slice(0, 8)})` : f.id,
    )
    .join(", ");
  const unpassedDetails = pendingOrFailed
    .map(
      (a) =>
        `${a.id} [${a.status}] (${a.title}${a.evidenceRequired ? ` — required: ${a.evidenceRequired}` : ""})`,
    )
    .join("; ");
  const isPostMergeRecheck =
    options?.postMergeIntegrationCheck === true &&
    pendingOrFailed.length === 0 &&
    alreadyPassed.length > 0;
  const isIncremental = !isPostMergeRecheck && alreadyPassed.length > 0;
  const svcLine =
    run.services && run.services.length > 0
      ? ` Exercise configured services/ports (${run.services.map((s) => `${s.name}${s.port !== undefined ? `:${s.port}` : ""}${s.healthcheck ? ` [${s.healthcheck}]` : ""}`).join(", ")}).`
      : "";

  const layer2Instruction = isPostMergeRecheck
    ? `Layer 2 (Post-Merge Base-Branch Integration Validation): Assertion(s) (${alreadyPassed.map((a) => a.id).join(", ")}) were verified before the isolated worktree merge landed onto \`${run.baseBranch}\`; re-verify integration health directly on \`${run.baseBranch}\` and update via verify_assertion if any regression is found.${svcLine}`
    : isIncremental
      ? `Layer 2 (Behavioral / Surface — Incremental Re-Validation): ${alreadyPassed.length} assertion(s) in milestone "${milestoneLabel}" already passed (${alreadyPassed.map((a) => a.id).join(", ")}); focus behavioral testing on the remaining unpassed VAL-* assertion(s) (${unpassedDetails}) plus a fast regression check that previously passed assertions still hold.${svcLine}`
      : `Layer 2 (Behavioral / Surface Validation): Behaviorally test and verify each milestone VAL-* assertion against real execution/outputs: ${unpassedDetails}.${svcLine}`;

  const hasMergedWorktrees =
    options?.postMergeIntegrationCheck === true ||
    mFeatures.some((f) => Boolean(f.mergedCommitSha));
  const completionPhrase = hasMergedWorktrees
    ? `completed and merged onto \`${run.baseBranch}\``
    : `completed on \`${run.baseBranch}\``;
  const diffTargetPhrase = hasMergedWorktrees
    ? `the merged commits/diffs for milestone "${milestoneLabel}"`
    : `the edits/diffs for milestone "${milestoneLabel}"`;
  const warmAuthors = Array.from(
    new Set(
      mFeatures
        .map((f) => f.assignedMember?.trim())
        .filter((name): name is string => {
          if (!name) return false;
          const m = getOwnMember(run, name);
          return Boolean(m && m.state !== "killed");
        }),
    ),
  );
  const defectBounceClause =
    warmAuthors.length > 0
      ? ` If you find defects, bounce concrete findings directly to warm feature author(s) (${warmAuthors.map((a) => `\`@${a}\``).join(", ")}) for peer-to-peer fixes before reporting your final verdict to \`@${ORCHESTRATOR_NAME} [done] ...\``
      : ` then report your verdict to \`@${ORCHESTRATOR_NAME} [done] ...\``;

  return [
    `[milestone-review] All features in milestone "${milestoneLabel}" (${mergedFeatureSummary}) are ${completionPhrase}. Execute Dual-Layer Milestone Validation now:`,
    `1. Layer 1 (Scrutiny): Run operational commands (${cmdManifest}) on \`${run.baseBranch}\` and review ${diffTargetPhrase}.`,
    `2. ${layer2Instruction}`,
    `3. Stamp every verified assertion via \`${SWARM_TOOL}{action:"mission", mission_op:"verify_assertion", assertion_ids:[...], assertion_status, evidence}\` (use \`assertion_ids\` to batch-stamp multiple assertions sharing outcome and evidence in 1 call, or \`assertion_id\` for one) and record reusable testing/environment findings in \`${SWARM_DIR}/${SWARM_RUNS_DIR}/${run.id}/${SWARM_LIBRARY_DIR}/testing.md\` via \`${SWARM_TOOL}{action:"mission", mission_op:"write_library", library_topic:"testing", library_content:"...", library_append:true}\`;${defectBounceClause} and call \`${SWARM_WAIT_TOOL}\`.`,
  ].join("\n");
}

function isActiveFeatureStatus(status: FeatureStatus): boolean {
  return status === "failed" || status === "in_progress" || status === "pending";
}

function orderMissionFeatures(
  features: readonly MissionFeature[],
  options?: { promoteIdsToTop?: ReadonlySet<string> },
): MissionFeature[] {
  const promoted: MissionFeature[] = [];
  const active: MissionFeature[] = [];
  const terminal: MissionFeature[] = [];
  const promoteSet = options?.promoteIdsToTop;

  for (const f of features) {
    if (isActiveFeatureStatus(f.status)) {
      if (promoteSet?.has(f.id)) {
        promoted.push(f);
      } else {
        active.push(f);
      }
    } else {
      terminal.push(f);
    }
  }
  return [...promoted, ...active, ...terminal];
}

function validateFeatureDag(features: readonly MissionFeature[]): void {
  const byId = new Map<string, MissionFeature>();
  for (const f of features) {
    byId.set(f.id, f);
  }
  for (const f of features) {
    for (const dep of f.dependsOn ?? []) {
      if (dep === f.id) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Feature "${f.id}" cannot depend on itself in dependsOn.`,
          { featureId: f.id, dependsOn: f.dependsOn },
        );
      }
      if (!byId.has(dep)) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Feature "${f.id}" dependsOn unknown feature "${dep}".`,
          { featureId: f.id, missingDependency: dep },
        );
      }
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const cur = state.get(id) ?? 0;
    if (cur === 2) return;
    if (cur === 1) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart >= 0 ? cycleStart : 0), id];
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Dependency cycle detected in mission features: ${cycle.join(" -> ")}.`,
        { cycle },
      );
    }
    state.set(id, 1);
    stack.push(id);
    const feat = byId.get(id);
    for (const dep of feat?.dependsOn ?? []) {
      visit(dep);
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const f of features) {
    if ((state.get(f.id) ?? 0) === 0) {
      visit(f.id);
    }
  }
}

interface MissionCoverageAnalysis {
  unclaimedAssertions: string[];
  duplicateFulfills: Array<{ assertionId: string; featureIds: string[] }>;
  unknownFulfills: Array<{ featureId: string; assertionId: string }>;
}

function analyzeMissionCoverage(
  assertions: readonly MissionAssertion[],
  features: readonly MissionFeature[],
): MissionCoverageAnalysis {
  const assertionSet = new Set(assertions.map((a) => a.id));
  const claimedBy = new Map<string, string[]>();
  const unknownFulfills: Array<{ featureId: string; assertionId: string }> = [];

  for (const f of features) {
    if (f.status === "cancelled") continue;
    for (const valId of f.fulfills) {
      const list = claimedBy.get(valId) ?? [];
      if (!list.includes(f.id)) {
        list.push(f.id);
      }
      claimedBy.set(valId, list);
      if (assertions.length > 0 && !assertionSet.has(valId)) {
        unknownFulfills.push({ featureId: f.id, assertionId: valId });
      }
    }
  }

  const unclaimedAssertions = assertions
    .filter((a) => !claimedBy.has(a.id))
    .map((a) => a.id);
  const duplicateFulfills: Array<{ assertionId: string; featureIds: string[] }> = [];
  for (const [assertionId, featureIds] of claimedBy.entries()) {
    if (featureIds.length > 1 && !/^VAL-CROSS-/i.test(assertionId)) {
      duplicateFulfills.push({ assertionId, featureIds });
    }
  }

  return { unclaimedAssertions, duplicateFulfills, unknownFulfills };
}

interface MilestoneSyncOutcome {
  milestones: SwarmMilestone[];
  newlySealed: string[];
  unsealed: string[];
}

function syncMissionMilestones(
  existingMilestones: readonly SwarmMilestone[] | undefined,
  features: readonly MissionFeature[],
  assertions: readonly MissionAssertion[],
  nowIso: string,
  members?: Readonly<Record<string, SwarmMemberRecord>>,
): MilestoneSyncOutcome {
  const milestones: SwarmMilestone[] = (existingMilestones ?? []).map((m) => ({
    ...m,
  }));
  const seenLabels = new Set(milestones.map((m) => m.label));
  for (const f of features) {
    const label = f.milestone.trim();
    if (label && !seenLabels.has(label)) {
      seenLabels.add(label);
      milestones.push({ label, status: "pending" });
    }
  }

  const assertionById = new Map(assertions.map((a) => [a.id, a]));
  const newlySealed: string[] = [];
  const unsealed: string[] = [];

  for (const m of milestones) {
    const mFeatures = features.filter(
      (f) => f.milestone === m.label && f.status !== "cancelled",
    );
    if (mFeatures.length === 0) {
      continue;
    }

    const claimedIds = Array.from(new Set(mFeatures.flatMap((f) => f.fulfills)));
    const hasUnmergedIsolatedFeature = mFeatures.some((f) => {
      if (!f.assignedMember || !members) return false;
      const assigned = Object.hasOwn(members, f.assignedMember)
        ? members[f.assignedMember]
        : undefined;
      if (!assigned || !isIsolatedWorktreeWorkspace(assigned.workspace)) {
        return false;
      }
      return !f.mergedCommitSha && !assigned.mergedCommitSha;
    });
    const allFeaturesCompletedAndMerged =
      mFeatures.every((f) => f.status === "completed") &&
      !hasUnmergedIsolatedFeature;
    const anyFeatureStarted = mFeatures.some(
      (f) =>
        f.status === "in_progress" ||
        f.status === "completed" ||
        f.status === "failed",
    );
    const anyAssertionFailed = claimedIds.some(
      (id) => assertionById.get(id)?.status === "failed",
    );
    const anyAssertionBlocked = claimedIds.some(
      (id) => assertionById.get(id)?.status === "blocked",
    );
    const allClaimedPassed =
      claimedIds.length > 0
        ? claimedIds.every((id) => assertionById.get(id)?.status === "passed")
        : assertions.length > 0 && assertions.every((a) => a.status === "passed");

    if (allFeaturesCompletedAndMerged && allClaimedPassed) {
      const wasSealed = m.sealed === true;
      m.status = "done";
      m.sealed = true;
      m.sealedAt = m.sealedAt ?? nowIso;
      if (!wasSealed) {
        newlySealed.push(m.label);
      }
      continue;
    }

    // Foundational milestones with `fulfills: []` in multi-milestone runs (or runs with 0 assertions)
    // reach `status: "done"` once all their features are completed & merged.
    if (
      allFeaturesCompletedAndMerged &&
      claimedIds.length === 0 &&
      (milestones.length > 1 || assertions.length === 0)
    ) {
      m.status = "done";
      continue;
    }

    if (m.sealed === true) {
      m.sealed = false;
      delete m.sealedAt;
      unsealed.push(m.label);
    }

    if (anyAssertionBlocked) {
      m.status = "blocked";
    } else if (anyAssertionFailed || anyFeatureStarted || m.status === "done") {
      m.status = "in_progress";
    }
  }

  return { milestones, newlySealed, unsealed };
}

function featureGlyph(status: FeatureStatus): string {
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

function milestoneGlyph(status: SwarmMilestone["status"]): string {
  switch (status) {
    case "done":
      return "[✓]";
    case "in_progress":
      return "[▸]";
    case "blocked":
      return "[!]";
    default:
      return "[ ]";
  }
}

function formatMissionStatusSummary(run: SwarmRunState): string {
  const assertions = run.assertions ?? [];
  const features = run.features ?? [];
  const handoffs = run.handoffItems ?? [];
  const milestones = run.milestones ?? [];
  const commands = run.commands ?? [];
  const services = run.services ?? [];
  const boundaries = run.boundaries ?? [];

  const nonCancelledFeatures = features.filter((f) => f.status !== "cancelled");
  const completedFeatures = nonCancelledFeatures.filter(
    (f) => f.status === "completed",
  ).length;
  const passedAssertions = assertions.filter((a) => a.status === "passed").length;
  const overriddenAssertions = assertions.filter((a) => a.overridden === true).length;
  const pendingAssertions = assertions.filter((a) => a.status === "pending").length;
  const failedAssertions = assertions.filter((a) => a.status === "failed").length;
  const blockedAssertions = assertions.filter((a) => a.status === "blocked").length;
  const openHandoffs = handoffs.filter((h) => h.resolution === "open");
  const overrideHeader =
    overriddenAssertions > 0 ? ` (${overriddenAssertions} [OVERRIDE])` : "";

  const lines: string[] = [
    `# Mission Goal Status — "${run.title}" (${run.id})`,
    `Status: ${run.status}${run.phase ? ` | Phase: ${run.phase}` : ""} | Features: ${completedFeatures}/${nonCancelledFeatures.length} completed | VAL: ${passedAssertions}/${assertions.length} passed${overrideHeader} | Open Handoffs: ${openHandoffs.length}`,
    `Artifacts: .pi/swarm/runs/${run.id}/mission.md · .pi/swarm/runs/${run.id}/validation-contract.md · .pi/swarm/runs/${run.id}/features.json · .pi/swarm/runs/${run.id}/services.json · .pi/swarm/runs/${run.id}/library/`,
  ];

  lines.push("");
  lines.push("## Commands & Boundaries");
  if (commands.length === 0) {
    lines.push("- Commands: (none configured)");
  } else {
    for (const cmd of commands) {
      lines.push(`- \`${cmd.name}\`: \`${cmd.command}\``);
    }
  }
  if (services.length > 0) {
    for (const svc of services) {
      const portPart = svc.port !== undefined ? ` (port ${svc.port})` : "";
      const hcPart = svc.healthcheck ? ` | healthcheck: \`${svc.healthcheck}\`` : "";
      const stopPart = svc.stop ? ` | stop: \`${svc.stop}\`` : "";
      const depPart =
        svc.dependsOn && svc.dependsOn.length > 0
          ? ` | dependsOn=[${svc.dependsOn.join(",")}]`
          : "";
      lines.push(
        `- Service \`${svc.name}\`${portPart}: start \`${svc.start}\`${hcPart}${stopPart}${depPart}`,
      );
    }
  }
  if (boundaries.length === 0) {
    lines.push("- Boundaries: (none configured)");
  } else {
    for (const b of boundaries) {
      lines.push(`- Boundary: ${b}`);
    }
  }

  lines.push("");
  lines.push(`## Milestones (${milestones.length})`);
  if (milestones.length === 0) {
    lines.push("- (no milestones defined)");
  } else {
    for (const m of milestones) {
      const sealedTag = m.sealed ? " [sealed]" : "";
      const ownerTag = m.owner ? ` (@${m.owner})` : "";
      lines.push(`- ${milestoneGlyph(m.status)} ${m.label} (${m.status})${sealedTag}${ownerTag}`);
    }
  }

  lines.push("");
  lines.push(`## Feature Queue (${features.length})`);
  if (features.length === 0) {
    lines.push("- (no features queued)");
  } else {
    for (const f of features) {
      const owner = f.assignedMember ? ` assigned=@${f.assignedMember}` : "";
      const merged = f.mergedCommitSha ? ` merged=${f.mergedCommitSha.slice(0, 8)}` : "";
      const deps =
        f.dependsOn && f.dependsOn.length > 0
          ? ` dependsOn=[${f.dependsOn.join(",")}]`
          : "";
      const fulfills =
        f.fulfills.length > 0 ? ` fulfills=[${f.fulfills.join(",")}]` : " fulfills=[]";
      lines.push(
        `- ${featureGlyph(f.status)} ${f.id} (${f.milestone}): ${f.title}${owner}${merged}${deps}${fulfills}`,
      );
    }
  }

  const coverage = analyzeMissionCoverage(assertions, features);
  lines.push("");
  lines.push(
    `## Validation Contract (${passedAssertions} passed · ${pendingAssertions} pending · ${failedAssertions} failed · ${blockedAssertions} blocked)`,
  );
  if (assertions.length === 0) {
    lines.push("- (no VAL-* assertions defined)");
  } else {
    for (const a of assertions) {
      const badge =
        a.status === "passed"
          ? a.overridden
            ? "[✓ passed · OVERRIDE]"
            : "[✓ passed]"
          : a.status === "failed"
            ? "[! failed]"
            : a.status === "blocked"
              ? "[~ blocked]"
              : "[  pending]";
      const verifier = a.verifiedBy ? ` by @${a.verifiedBy}` : "";
      const ev = a.evidence ? ` — ${a.evidence.replace(/\s+/g, " ").slice(0, 140)}` : "";
      lines.push(`- ${badge} ${a.id}: ${a.title}${verifier}${ev}`);
    }
    if (coverage.unclaimedAssertions.length > 0) {
      lines.push(
        `- ⚠ Unclaimed VAL-* assertions (${coverage.unclaimedAssertions.length}): ${coverage.unclaimedAssertions.join(", ")}`,
      );
    }
    if (coverage.duplicateFulfills.length > 0) {
      lines.push(
        `- ⚠ Duplicate fulfills claims: ${coverage.duplicateFulfills.map((d) => `${d.assertionId} (${d.featureIds.join(", ")})`).join("; ")}`,
      );
    }
  }

  lines.push("");
  lines.push(`## Open Handoff Tech-Debt (${openHandoffs.length} open / ${handoffs.length} total)`);
  if (openHandoffs.length === 0) {
    lines.push("- (zero open handoff tech-debt items)");
  } else {
    for (const h of openHandoffs) {
      const featRef = h.sourceFeatureId ? ` [feature=${h.sourceFeatureId}]` : "";
      lines.push(`- [!] ${h.id} (${h.type} from @${h.sourceMember}${featRef}): ${h.summary}`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// Internal Runtime Structures
// ============================================================================

interface LiveMember {
  name: string;
  agentId: string;
  role: SwarmMemberRole;
  handle?: PersistentAgentHandle;
  /** True while waiting for concurrency slot or spawning transport handle. */
  spawning: boolean;
  /** Synchronous lock while dispatching a wake/revive to prevent concurrent wake() races. */
  waking: boolean;
  /** True from turn launch through the end of handleTurnFinished (closes async post-turn race window). */
  turnActive: boolean;
  /** Synchronous lock while hot-switching models on a waiting session. */
  switchingModel: boolean;
  /** Whether this parked member only wakes on mentions (`true`) or any channel message (`false`). */
  parkedMentionsOnly: boolean;
  /** Board messages queued while spawning, waking, working, or switching models (coalesced on next wake). */
  pendingWakes: BoardMessage[];
  /** Sequence numbers already delivered to this member (prevents duplicate delivery). */
  deliveredSeqs: Set<number>;
  /** Models already attempted on this member (for quota fallback selection). */
  triedModels: Set<string>;
  /** Last known conversation snapshot (for forking even if session later pauses/stops). */
  lastMessages: AgentMessage[];
  /** Live telemetry log tail preserved across cache refreshes and persisted on turn end. */
  logTail: string[];
  /** Live last tool name preserved across cache refreshes. */
  lastTool?: string;
  /** Live activity description while working, preserved across cache refreshes. */
  currentActivity?: string;
  /** Latest swarm_wait request captured during current turn. */
  lastWaitRequest?: { since: number; mentionsOnly: boolean };
  /** Member's lastPostSeq when its current/latest turn started (detects silent turns without post_message). */
  turnStartPostSeq?: number;
  /** Normalized summary from the most recent silent turn (cleared once delivered in an all_idle digest or on next turn). */
  lastSilentSummary?: string;
  /** Pending deferred model switch scheduled while working (self-switch or human role propagation). */
  pendingSelfModelSwitch?: {
    model: string;
    thinkingLevel?: ThinkingLevel;
    reason?: string;
    callerName: string;
    callerRole: CallerRole;
    autoResume?: boolean;
    silentBoardNotice?: boolean;
    fromRolePropagation?: boolean;
  };
  /** AbortController for cancelling in-flight concurrency/backoff waits on stop/kill/dispose. */
  launchAbort?: AbortController;
  /** Per-attempt token to prevent cancelled launch/wake/revive coroutines from clobbering newer attempts. */
  attemptToken?: symbol;
  /** Active concurrency slot release callback, if currently holding a slot. */
  releaseSlot?: () => void;
  /** Number of consecutive automatic retries attempted after rate_limited turns. */
  retryCount: number;
  /** Timer handle for pending automatic rate-limit retry. */
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Cumulative tokens persisted from previous handles before revival. */
  priorHandlesTokens: number;
  /** Cumulative token breakdown persisted from previous handles before revival. */
  priorHandlesBreakdown?: TokenUsage;
  /** Cumulative cost persisted from previous handles before revival. */
  priorHandlesCost: number;
  /** Monotonic live total tokens observed via telemetry/turn completion (survives cache refreshes). */
  liveTokens?: number;
  /** Monotonic live token breakdown observed via telemetry/turn completion. */
  liveTokenBreakdown?: TokenUsage;
  /** Monotonic live cost observed via telemetry/turn completion (survives cache refreshes). */
  liveCost?: number;
  /** Monotonic live LLM turn count incremented on turn_end telemetry events. */
  liveLlmTurns?: number;
  /** ISO timestamp when the currently active turn started (cleared on wait/stop/kill). */
  turnStartedAt?: string;
  /** Monotonic last read sequence observed via readBoard/turn completion (survives cache refreshes). */
  lastReadSeq?: number;
  /** Latest unread matching sequence that blocked a `swarm_wait` park attempt (survives cache refreshes). */
  lastParkBlockedSeq?: number;
}

interface BoardWaiter {
  since: number;
  mentionsOnly: boolean;
  targetName: string;
  targetChannels: readonly string[];
  onProgress?: (summary: string) => void;
  resolve: (result: WaitForBoardResult) => void;
  cleanup: () => void;
}

// ============================================================================
// SwarmEngine Dependencies & Implementation
// ============================================================================

export interface SwarmEngineDeps {
  store: ISwarmStore;
  worktree: IWorktreeManager;
  transport: ISwarmTransport;
  settings?: Partial<SwarmSettings>;
  getSettings?: () => SwarmSettings;
  now?: () => number;
  generateAgentId?: (name: string) => string;
  /**
   * Optional base temporary directory for isolated validator scratch directories
   * (`<scratchRoot>/pi-swarm-validator/<runId>/<member>`). Defaults to `os.tmpdir()`.
   */
  scratchRoot?: string;
}

/**
 * Dynamic Antigravity Swarm execution engine (`ISwarmEngine`).
 *
 * Orchestrates:
 * - Dynamic member lifecycle (`addMembers` single / `n` / `tasks[]`, helpers, `fork`, `killMember`, `stopMember`)
 * - 3-role model resolution (`orchestrator` / `worker` / `validator`) + warm hot model switching (`switchModel`) + quota auto-fallback
 * - Shared Message Board & channels (`postMessage`, `readBoard`, `manageChannel`) with `@name`, `@prefix`, `@#channel`, `@all` wakeup routing, zero-drop coalescing, and hop-cap safety
 * - Blocking `waitForBoard` with anti-deadlock `all_idle` exit, `AbortSignal`, and live progress callbacks
 * - Zero-token Stall Watchdog timer posting `[stall]` from `monitor` when the swarm goes silent
 * - Isolated `share` / `branch` Git worktree provisioning, auto-rebase, merge, dirty-worktree guards, and safe teardown
 */
export class SwarmEngine implements ISwarmEngine {
  private readonly store: ISwarmStore;
  private readonly worktree: IWorktreeManager;
  private readonly transport: ISwarmTransport;
  private readonly staticSettings?: Partial<SwarmSettings>;
  private readonly getSettingsFn?: () => SwarmSettings;
  private readonly nowFn: () => number;
  private readonly generateAgentIdFn: (name: string) => string;
  private readonly scratchRoot?: string;

  private activeRunId: string | null = null;
  private cachedRun: SwarmRunState | null = null;
  private cachedBoard: BoardMessage[] = [];
  private cachedEvents: SwarmEvent[] = [];
  private hostContext?: ExtensionContext;

  private readonly liveMembers = new Map<string, LiveMember>();
  private readonly listeners = new Set<(event: SwarmEngineEvent) => void>();
  private readonly boardWaiters = new Set<BoardWaiter>();
  private readonly rateLimitBreaker: RateLimitBreaker;
  private readonly concurrencyGate: ConcurrencyGate;

  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStallAlertHead: number | null = null;
  private lastMonitorNudgeSeq: number | null = null;
  private humanInputAwaited = false;
  private monitorRunning = false;
  private activeMonitorHandle?: PersistentAgentHandle;
  private activeMonitorAbort?: AbortController;
  private monitorTokens = 0;
  private monitorCost = 0;
  private orchestratorWait: {
    since: number;
    mentionsOnly: boolean;
    waitForAll: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private runDonePosted = false;
  private boardHopCount = 0;
  private hopCapAlerted = false;
  private disposed = false;
  private attachRunChain: Promise<void> = Promise.resolve();
  private roleModelsChain: Promise<void> = Promise.resolve();
  private missionChain: Promise<void> = Promise.resolve();
  private repoGitLock: Promise<void> = Promise.resolve();
  private readonly fallbackLibrary = new Map<string, Map<string, string>>();

  constructor(deps: SwarmEngineDeps) {
    this.store = deps.store;
    this.worktree = deps.worktree;
    this.transport = deps.transport;
    this.staticSettings = deps.settings;
    this.getSettingsFn = deps.getSettings;
    this.nowFn = deps.now ?? (() => Date.now());
    this.generateAgentIdFn =
      deps.generateAgentId ??
      ((name: string) => `${name}-${randomBytes(3).toString("hex")}`);
    this.scratchRoot = deps.scratchRoot?.trim() || undefined;

    const initialSettings = this.getEffectiveSettings();
    this.rateLimitBreaker = new RateLimitBreaker({
      baseBackoffMs: initialSettings.rateLimitBaseBackoffMs,
      maxBackoffMs: initialSettings.rateLimitMaxBackoffMs,
      now: this.nowFn,
    });
    this.concurrencyGate = new ConcurrencyGate(
      initialSettings.maxConcurrency,
      this.rateLimitBreaker,
    );
  }

  private getRunScratchRoot(runId: string): string {
    return getRunValidatorScratchRoot(runId, this.scratchRoot);
  }

  private getMemberScratchDir(runId: string, memberName: string): string {
    return getValidatorScratchDir(runId, memberName, this.scratchRoot);
  }

  // --------------------------------------------------------------------------
  // Run Lifecycle (startRun / attachRun / setTitle / pause / resume / completeRun)
  // --------------------------------------------------------------------------

  async startRun(
    runId: string,
    hostContext?: ExtensionContext,
  ): Promise<SwarmRunState> {
    if (hostContext) {
      this.hostContext = hostContext;
    }
    const snapshot = await this.attachRun(runId, hostContext);
    if (!snapshot.run) {
      throw new SwarmProtocolError("NOT_FOUND", `Swarm run "${runId}" could not be loaded.`);
    }
    if (snapshot.run.status === "paused") {
      return this.resume(runId, hostContext);
    }
    if (snapshot.run.status === "active") {
      this.concurrencyGate.resume();
    }
    return snapshot.run;
  }

  async attachRun(
    runId: string | null,
    hostContext?: ExtensionContext,
  ): Promise<SwarmSnapshot> {
    const prev = this.attachRunChain;
    let release!: () => void;
    this.attachRunChain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await this.attachRunInternal(runId, hostContext);
    } finally {
      release();
    }
  }

  private async attachRunInternal(
    runId: string | null,
    hostContext?: ExtensionContext,
  ): Promise<SwarmSnapshot> {
    if (hostContext) {
      this.hostContext = hostContext;
    }

    if (runId === null) {
      this.cancelStallWatchdog();
      await this.cancelActiveMonitor("Detached from Swarm run");
      this.clearOrchestratorWait("Detached from Swarm run.");
      this.resolveAllWaiters("run_ended", "Detached from Swarm run.");
      const prevRunId = this.activeRunId;
      const liveWorkingNames = this.collectLiveWorkingMemberNames();
      this.activeRunId = null;
      this.cachedRun = null;
      await this.persistWorkingMembersStopped(prevRunId, liveWorkingNames, "stopped (detached)");
      await this.disposeLiveHandles("Detached from Swarm run");
      this.cachedBoard = [];
      this.cachedEvents = [];
      this.runDonePosted = false;
      this.lastStallAlertHead = null;
      this.lastMonitorNudgeSeq = null;
      this.humanInputAwaited = false;
      this.boardHopCount = 0;
      this.hopCapAlerted = false;
      this.monitorTokens = 0;
      this.monitorCost = 0;
      const snap = this.getSnapshot();
      this.emitEngineEvent("snapshot_changed", "Detached from Swarm run.");
      return snap;
    }

    const isSameRun = this.activeRunId === runId;
    if (this.activeRunId && !isSameRun) {
      this.cancelStallWatchdog();
      await this.cancelActiveMonitor(`Switched focus to run ${runId}`);
      this.clearOrchestratorWait(`Switched focus to run ${runId}.`);
      this.resolveAllWaiters("run_ended", `Switched focus to run ${runId}.`);
      this.monitorTokens = 0;
      this.monitorCost = 0;
      const prevRunId = this.activeRunId;
      const liveWorkingNames = this.collectLiveWorkingMemberNames();
      this.activeRunId = null;
      this.cachedRun = null;
      await this.persistWorkingMembersStopped(
        prevRunId,
        liveWorkingNames,
        "stopped (switched run)",
      );
      await this.disposeLiveHandles("Switched active run");
    }

    let run = await this.store.loadRun(runId);

    // Crash/restart recovery: when attaching a run after a fresh process start (no live handles in memory),
    // normalize stale persisted `working` or orphan `waiting` members to `stopped` so `@mention` revives them from disk `sessionFile`.
    if (!isSameRun && (run.status === "active" || run.status === "paused")) {
      for (const m of Object.values(run.members)) {
        if ((m.state === "working" || m.state === "waiting") && !this.liveMembers.has(m.name)) {
          run = await this.store.updateMember(run.id, m.name, {
            state: "stopped",
            currentActivity: null,
            turnStartedAt: null,
            parkedOn: "stopped (reloaded; @mention to revive)",
          });
        }
      }
    }
    const boardRes = await this.store
      .readBoard(runId, { channel: "*", limit: BOARD_CACHE_LIMIT })
      .catch(() => ({ messages: [] as BoardMessage[], head: run.boardHead }));
    const events = await this.store
      .getRecentEvents(runId, EVENT_CACHE_LIMIT)
      .catch(() => [] as SwarmEvent[]);

    this.activeRunId = run.id;
    this.setCachedRun(run);
    this.cachedBoard = boardRes.messages;
    this.cachedEvents = events;
    this.runDonePosted = run.status === "completed" || run.status === "abandoned";
    if (!isSameRun) {
      this.lastStallAlertHead = null;
      this.lastMonitorNudgeSeq = null;
      this.humanInputAwaited = false;
      this.boardHopCount = 0;
      this.hopCapAlerted = false;
    }

    const settings = this.getEffectiveSettings();
    this.rateLimitBreaker.configure({
      baseBackoffMs: settings.rateLimitBaseBackoffMs,
      maxBackoffMs: settings.rateLimitMaxBackoffMs,
    });
    this.concurrencyGate.setMaxConcurrency(run.maxConcurrency || settings.maxConcurrency);
    if (run.status === "paused") {
      this.concurrencyGate.pause();
    } else {
      this.concurrencyGate.resume();
    }

    if (isSameRun && (run.status === "completed" || run.status === "abandoned")) {
      this.humanInputAwaited = false;
      this.cancelStallWatchdog();
      await this.cancelActiveMonitor(`Swarm run ${run.status}`);
      this.clearOrchestratorWait(`Swarm run ${run.status}.`);
      this.resolveAllWaiters("run_ended", `Swarm run ${run.status}.`);
      await this.disposeLiveHandles(`Swarm run ${run.status}`);
    } else if (run.status === "active") {
      this.maybeArmStallWatchdog();
    }

    const snap = this.getSnapshot();
    this.emitEngineEvent("snapshot_changed", `Attached to Swarm run "${run.title}" (${run.id}).`);
    return snap;
  }

  async setTitle(
    title: string,
    options?: { callerRole?: CallerRole; actor?: string },
  ): Promise<SwarmRunState> {
    return this.updateDirection({ title }, options);
  }

  async updateDirection(
    patch: {
      title?: string;
      objective?: string;
      strategy?: string;
      acceptanceCriteria?: string;
      phase?: string | null;
      milestones?: SwarmMilestone[] | null;
    },
    options?: { callerRole?: CallerRole; actor?: string },
  ): Promise<SwarmRunState> {
    if (!isOrchestratorOrHuman(options?.callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${options?.callerRole}" is not allowed to change swarm title or direction.`,
      );
    }
    const run = this.requireActiveRun();
    const updatePatch: RunUpdateInput = {
      actor: options?.actor ?? ORCHESTRATOR_NAME,
    };

    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      if (!trimmed) {
        throw new SwarmProtocolError("INVALID_INPUT", "Swarm title must be non-empty.");
      }
      updatePatch.title = trimmed;
    }
    if (patch.objective !== undefined) {
      const trimmed = patch.objective.trim();
      if (!trimmed) {
        throw new SwarmProtocolError("INVALID_INPUT", "Swarm objective must be non-empty.");
      }
      updatePatch.objective = trimmed;
    }
    if (patch.strategy !== undefined) {
      updatePatch.strategy = patch.strategy.trim();
    }
    if (patch.acceptanceCriteria !== undefined) {
      updatePatch.acceptanceCriteria = patch.acceptanceCriteria.trim();
    }
    if (patch.phase !== undefined) {
      if (patch.phase === null) {
        updatePatch.phase = null;
      } else {
        const trimmed = patch.phase.trim();
        updatePatch.phase = trimmed.length > 0 ? trimmed : null;
      }
    }
    if (patch.milestones !== undefined) {
      const assertionById = new Map(
        (run.assertions ?? []).map((a) => [a.id, a]),
      );
      const isStillSealed = (m: SwarmMilestone | undefined): boolean => {
        if (!m || m.sealed !== true) return false;
        const mFeatures = (run.features ?? []).filter(
          (f) => f.milestone === m.label && f.status !== "cancelled",
        );
        const claimed = Array.from(new Set(mFeatures.flatMap((f) => f.fulfills)));
        if (claimed.length > 0) {
          return claimed.every((id) => assertionById.get(id)?.status === "passed");
        }
        return (
          (run.assertions ?? []).length === 0 ||
          (run.assertions ?? []).every((a) => a.status === "passed")
        );
      };

      if (patch.milestones === null) {
        const preservedSealed =
          options?.callerRole === "human"
            ? []
            : (run.milestones ?? [])
                .filter((m) => isStillSealed(m))
                .map((m) => ({ ...m, status: "done" as const, sealed: true }));
        updatePatch.milestones =
          preservedSealed.length > 0 ? preservedSealed : null;
      } else {
        const normalized: SwarmMilestone[] = [];
        const seenLabels = new Set<string>();
        for (const item of patch.milestones) {
          if (!item || typeof item !== "object") {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              "Each milestone must be an object with label and status.",
            );
          }
          const label = typeof item.label === "string" ? item.label.trim() : "";
          if (!label) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              "Milestone label must be non-empty.",
            );
          }
          if (
            item.status !== "pending" &&
            item.status !== "in_progress" &&
            item.status !== "done" &&
            item.status !== "blocked"
          ) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Invalid milestone status "${String(item.status)}". Expected pending, in_progress, done, or blocked.`,
            );
          }
          const owner =
            typeof item.owner === "string" ? item.owner.trim().replace(/^@/, "") : "";
          const priorMilestone = run.milestones?.find((m) => m.label === label);
          const lockedSealed = isStillSealed(priorMilestone);
          const keepSealed = lockedSealed || item.sealed === true;
          const effectiveStatus = lockedSealed ? "done" : item.status;
          seenLabels.add(label);
          normalized.push({
            label,
            status: effectiveStatus,
            ...(owner ? { owner } : {}),
            ...(keepSealed
              ? {
                  sealed: true,
                  sealedAt:
                    item.sealedAt ??
                    priorMilestone?.sealedAt ??
                    new Date(this.nowFn()).toISOString(),
                }
              : {}),
          });
        }
        // Preserve any already-sealed milestones omitted from patch.milestones
        if (options?.callerRole !== "human") {
          for (const prev of run.milestones ?? []) {
            if (!seenLabels.has(prev.label) && isStillSealed(prev)) {
              normalized.push({
                ...prev,
                status: "done",
                sealed: true,
              });
            }
          }
        }
        updatePatch.milestones = normalized;
      }
    }

    const updated = await this.store.updateRun(run.id, updatePatch);
    await this.refreshCache(updated);
    this.emitEngineEvent("snapshot_changed", `Updated swarm "${updated.title}".`);
    return updated;
  }

  async pause(runId?: string, reason?: string): Promise<SwarmRunState> {
    const targetRunId = runId?.trim() || this.activeRunId;
    if (!targetRunId) {
      throw new SwarmProtocolError("NOT_FOUND", "No active Swarm run to pause.");
    }
    const targetRun = await this.store.loadRun(targetRunId);
    if (targetRun.status === "completed" || targetRun.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot pause a ${targetRun.status} Swarm run.`,
      );
    }

    // Non-focused run: update ONLY the store without touching active liveMembers/concurrencyGate/cachedRun
    if (targetRunId !== this.activeRunId) {
      let updated = await this.store.updateRun(targetRunId, {
        status: "paused",
        actor: ORCHESTRATOR_NAME,
      });
      for (const member of Object.values(updated.members)) {
        if (member.state === "working") {
          updated = await this.store.updateMember(targetRunId, member.name, {
            state: "stopped",
            ...(member.sessionFile ? { sessionFile: member.sessionFile } : {}),
            currentActivity: null,
            turnStartedAt: null,
            parkedOn: reason ?? "paused",
            actor: ORCHESTRATOR_NAME,
          });
        }
      }
      return updated;
    }

    // Focused run: synchronously disarm watchdog/gates/flags first so concurrent turn finishes cannot race
    if (this.cachedRun && this.cachedRun.id === targetRunId) {
      this.cachedRun.status = "paused";
    }
    this.cancelStallWatchdog();
    this.clearOrchestratorWait(reason ?? "Swarm run paused.");
    this.concurrencyGate.pause();
    this.resolveAllWaiters("run_ended", reason ?? "Swarm run paused.");

    for (const live of this.liveMembers.values()) {
      this.cancelMemberRetryTimer(live);
      live.launchAbort?.abort();
      live.attemptToken = undefined;
      live.spawning = false;
      live.waking = false;
      live.turnActive = false;
      live.switchingModel = false;
      live.pendingSelfModelSwitch = undefined;
      live.lastWaitRequest = undefined;
      live.lastSilentSummary = undefined;
      live.currentActivity = undefined;
      live.turnStartedAt = undefined;
      live.pendingWakes.length = 0;
      live.releaseSlot?.();
      live.releaseSlot = undefined;
    }

    await this.cancelActiveMonitor(reason ?? "Swarm run paused");

    let updated = await this.store.updateRun(targetRunId, {
      status: "paused",
      actor: ORCHESTRATOR_NAME,
    });
    await this.refreshCache(updated);

    // Abort & dispose any working handles (or handles whose persisted member state is still working) in parallel
    const capturedSessionFiles = new Map<string, string>();
    const workingLives = Array.from(this.liveMembers.values()).filter(
      (live) =>
        Boolean(live.handle) &&
        (live.handle!.getState() === "working" ||
          getOwnMember(updated, live.name)?.state === "working"),
    );
    await Promise.all(
      workingLives.map(async (live) => {
        const handle = live.handle;
        if (!handle) {
          return;
        }
        await handle.abort(reason ?? "Swarm run paused").catch(() => {});
        await Promise.race([
          handle.currentTurn.catch(() => {}),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 250);
            t.unref?.();
          }),
        ]);
        live.lastMessages = sanitizeForkSeedMessages(handle.getConversationMessages());
        const sessionFile = handle.getSessionFile?.();
        if (sessionFile) {
          capturedSessionFiles.set(live.name, sessionFile);
        }
        await handle.kill("Paused").catch(() => {});
        live.handle = undefined;
      }),
    );

    for (const member of Object.values(updated.members)) {
      if (member.state === "working") {
        const live = this.liveMembers.get(member.name);
        const sessionFile = capturedSessionFiles.get(member.name) ?? member.sessionFile;
        const flushedBreakdown = maxTokenBreakdown(
          member.tokenBreakdown,
          live?.liveTokenBreakdown,
        );
        const flushedLlmTurns = Math.max(member.llmTurns ?? 0, live?.liveLlmTurns ?? 0);
        updated = await this.store.updateMember(targetRunId, member.name, {
          state: "stopped",
          tokens: Math.max(member.tokens, live?.liveTokens ?? 0),
          cost: Math.max(member.cost, live?.liveCost ?? 0),
          ...(flushedBreakdown ? { tokenBreakdown: flushedBreakdown } : {}),
          logTail: live && live.logTail.length > 0 ? [...live.logTail] : member.logTail,
          ...(flushedLlmTurns > 0 ? { llmTurns: flushedLlmTurns } : {}),
          ...(live?.lastTool !== undefined ? { lastTool: live.lastTool } : {}),
          ...(sessionFile ? { sessionFile } : {}),
          currentActivity: null,
          turnStartedAt: null,
          parkedOn: reason ?? "paused",
          actor: ORCHESTRATOR_NAME,
        });
      }
    }
    await this.refreshCache(updated);
    this.cancelStallWatchdog();
    this.emitEngineEvent("snapshot_changed", `Paused Swarm run ${targetRunId}.`);
    return updated;
  }

  async resume(
    runId?: string,
    hostContext?: ExtensionContext,
  ): Promise<SwarmRunState> {
    if (hostContext) {
      this.hostContext = hostContext;
    }
    const targetRunId = runId?.trim() || this.activeRunId;
    if (!targetRunId) {
      throw new SwarmProtocolError("NOT_FOUND", "No Swarm run specified to resume.");
    }
    const targetRun = await this.store.loadRun(targetRunId);
    if (targetRun.status === "completed" || targetRun.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot resume a ${targetRun.status} Swarm run.`,
      );
    }
    if (this.activeRunId !== targetRunId) {
      await this.attachRun(targetRunId, hostContext);
    }
    const updated = await this.store.updateRun(targetRunId, {
      status: "active",
      actor: ORCHESTRATOR_NAME,
    });
    this.runDonePosted = false;
    this.lastStallAlertHead = null;
    this.lastMonitorNudgeSeq = null;
    this.humanInputAwaited = false;
    this.boardHopCount = 0;
    this.hopCapAlerted = false;
    this.concurrencyGate.resume();
    await this.refreshCache(updated);
    this.maybeArmStallWatchdog();
    this.emitEngineEvent("snapshot_changed", `Resumed Swarm run ${targetRunId}.`);
    return updated;
  }

  async completeRun(options: CompleteRunOptions): Promise<SwarmRunState> {
    if (!isOrchestratorOrHuman(options.callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${options.callerRole}" is not allowed to complete the Swarm run.`,
      );
    }
    const summary = options.summary.trim();
    if (!summary) {
      throw new SwarmProtocolError("INVALID_INPUT", "Completion summary must be non-empty.");
    }
    const run = this.requireActiveRun();
    const currentRun = await this.store.loadRun(run.id);
    if (isReconRun(currentRun)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot complete Swarm run "${currentRun.id}" while in read-only recon mode. Propose and confirm the execution plan via ${PROPOSE_SWARM_PLAN_TOOL} first (or cancel via /swarm cancel).`,
        { runId: currentRun.id, runMode: "recon" },
      );
    }
    if (currentRun.status === "completed" || currentRun.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot complete a ${currentRun.status} Swarm run.`,
      );
    }
    const sid = options.sessionId?.trim();
    if (sid) {
      if (this.store.assertOwnerSession) {
        await this.store.assertOwnerSession(currentRun, sid);
      } else {
        assertOwnerSession(currentRun, sid);
      }
    }
    if (options.callerRole === "orchestrator") {
      await this.assertMissionGoalGatesForCompletion(currentRun);
    }
    const actor = options.actor ?? ORCHESTRATOR_NAME;

    // Silence watchdog immediately and prevent any further spawns, posts, or wakeups
    this.runDonePosted = true;
    this.humanInputAwaited = false;
    this.concurrencyGate.pause();
    this.cancelStallWatchdog();
    await this.cancelActiveMonitor("Run completed");
    this.clearOrchestratorWait("Run completed.");

    // Post `[done] <summary>` (NO @mentions!) on board directly so Stall Watchdog stays quiet
    const safeSummary = summary.replace(/@(?=#?[A-Za-z0-9])/g, "");
    const doneMsg = await this.store.postBoardMessage(run.id, {
      from: actor,
      fromRole: options.callerRole ?? "orchestrator",
      channel: DEFAULT_CHANNEL,
      kind: "done",
      text: `[done] ${safeSummary}`,
      mentions: [],
      channelMentions: [],
    });
    this.recordBoardMessageInCache(doneMsg);
    this.emitEngineEvent("board_posted", `Posted completion #${doneMsg.seq}`, {
      seq: doneMsg.seq,
    });

    // Snapshot live usage before disposing handles so working members never drop accumulated tokens/cost
    const liveSnapshots = new Map<string, LiveMember>(this.liveMembers);

    // Dispose all warm/live AgentSession handles cleanly (preserving worktrees safely!)
    await this.disposeLiveHandles("Run completed");

    // Mark any still-working or warm-waiting member records as stopped (0 active)
    const latestRun = await this.store.loadRun(run.id);
    const nowIso = new Date(this.nowFn()).toISOString();
    for (const member of Object.values(latestRun.members)) {
      if (member.state === "working" || member.state === "waiting") {
        const live = liveSnapshots.get(member.name);
        const flushedBreakdown = maxTokenBreakdown(
          member.tokenBreakdown,
          live?.liveTokenBreakdown,
        );
        const flushedLlmTurns = Math.max(member.llmTurns ?? 0, live?.liveLlmTurns ?? 0);
        await this.store.updateMember(run.id, member.name, {
          state: "stopped",
          tokens: Math.max(member.tokens, live?.liveTokens ?? 0),
          cost: Math.max(member.cost, live?.liveCost ?? 0),
          ...(flushedBreakdown ? { tokenBreakdown: flushedBreakdown } : {}),
          logTail: live && live.logTail.length > 0 ? [...live.logTail] : member.logTail,
          ...(flushedLlmTurns > 0 ? { llmTurns: flushedLlmTurns } : {}),
          ...(live?.lastTool !== undefined ? { lastTool: live.lastTool } : {}),
          currentActivity: null,
          turnStartedAt: null,
          parkedOn: "run completed",
          endedAt: nowIso,
          actor,
        });
      }
    }

    const completed = await this.store.updateRun(run.id, {
      status: "completed",
      completionSummary: summary,
      actor,
    });

    const shouldTeardown =
      options.teardown ?? this.getEffectiveSettings().autoTeardownOnComplete;
    if (shouldTeardown) {
      await this.teardown({
        runId: run.id,
        deleteBranches: options.deleteBranches,
        sessionId: options.sessionId,
      });
    }
    await rm(this.getRunScratchRoot(run.id), {
      recursive: true,
      force: true,
    }).catch(() => {});

    const finalRun = await this.store.loadRun(run.id);
    await this.refreshCache(finalRun);
    this.resolveAllWaiters("run_ended", `Swarm run completed: ${summary}`);
    this.emitEngineEvent("run_finished", `Swarm run "${completed.title}" completed: ${summary}`);
    this.emitEngineEvent("snapshot_changed", `Swarm run "${completed.title}" completed.`);
    return finalRun;
  }

  /**
   * Promotes an active `runMode: "recon"` run in-place to `runMode: "executing"` when
   * the user confirms `propose_swarm_plan`, preserving board.jsonl, events.jsonl,
   * library/*.md, channels, and warm/forkable recon worker sessions under the same runId.
   */
  async promoteReconRun(
    runId: string,
    input: PromoteReconRunInput,
  ): Promise<SwarmRunState> {
    const current = await this.store.loadRun(runId);
    if (!isReconRun(current)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot promote run "${runId}": run is not in recon mode (runMode="${current.runMode ?? "executing"}").`,
        { runId, runMode: current.runMode ?? "executing" },
      );
    }
    if (current.status === "completed" || current.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot promote ${current.status} recon run "${runId}".`,
        { runId, status: current.status },
      );
    }

    const actor = input.actor?.trim() || ORCHESTRATOR_NAME;

    // Abort/stop any still-working recon members cleanly (preserving lastMessages & sessionFile for fork);
    // keep already-"waiting" recon workers warm (they remain recon:true read-only forever).
    if (this.activeRunId === runId) {
      const workingNames = new Set(this.getWorkingOrPendingMemberNames());
      for (const m of Object.values(current.members)) {
        if (m.state === "killed") continue;
        if (m.state === "working" || workingNames.has(m.name)) {
          await this.stopMember(m.name, {
            reason: "Stopped on recon promotion (conversation preserved for fork)",
            humanStopped: false,
            callerName: actor,
            callerRole: "orchestrator",
          }).catch(() => {});
        }
      }
    }

    const promoted = await this.store.updateRun(runId, {
      runMode: "executing",
      phase: null,
      title: input.title,
      objective: input.objective,
      strategy: input.strategy ?? "",
      acceptanceCriteria: input.acceptanceCriteria ?? "",
      baseBranch: input.baseBranch,
      maxConcurrency: input.maxConcurrency,
      validatorEnabled: input.validatorEnabled,
      ...(input.roleModels !== undefined ? { roleModels: input.roleModels } : {}),
      ...(input.milestones !== undefined ? { milestones: input.milestones } : {}),
      ...(input.assertions !== undefined ? { assertions: input.assertions } : {}),
      ...(input.features !== undefined ? { features: input.features } : {}),
      ...(input.commands !== undefined ? { commands: input.commands } : {}),
      ...(input.services !== undefined ? { services: input.services } : {}),
      ...(input.boundaries !== undefined ? { boundaries: input.boundaries } : {}),
      ...(input.lastAudit !== undefined ? { lastAudit: input.lastAudit } : {}),
      actor,
    });

    // Post a SILENT [decision] board entry (mentions: [], NO @all) so warm recon workers are NOT woken!
    const decisionMsg = await this.store.postBoardMessage(runId, {
      from: actor,
      fromRole: "orchestrator",
      channel: DEFAULT_CHANNEL,
      kind: "decision",
      text: `[decision] Promoted recon run "${runId}" to executing mode ("${promoted.title}") on ${promoted.baseBranch}.`,
      mentions: [],
      channelMentions: [],
    });

    const latest = await this.store.loadRun(runId);
    if (this.activeRunId === runId) {
      this.recordBoardMessageInCache(decisionMsg);
      this.concurrencyGate.setMaxConcurrency(promoted.maxConcurrency);
      if (latest.status === "active") {
        this.concurrencyGate.resume();
      }
      await this.refreshCache(latest);
      this.emitEngineEvent("board_posted", `Posted promotion decision #${decisionMsg.seq}`, {
        seq: decisionMsg.seq,
      });
      this.emitEngineEvent(
        "snapshot_changed",
        `Promoted recon run "${promoted.title}" (${runId}) to executing mode.`,
      );
      this.maybeArmStallWatchdog();
    }
    return latest;
  }

  /**
   * Rolls `runMode` back to `"recon"` if launching wave-1 `initial_members` fails
   * immediately after `promoteReconRun`, preserving the recon board history.
   */
  async revertReconPromotion(runId: string): Promise<SwarmRunState> {
    const current = await this.store.loadRun(runId);
    if (current.status === "completed" || current.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot revert promotion on ${current.status} run "${runId}".`,
        { runId, status: current.status },
      );
    }
    const reverted = await this.store.updateRun(runId, {
      runMode: "recon",
      phase: "recon",
      actor: ORCHESTRATOR_NAME,
    });
    if (this.activeRunId === runId) {
      this.cancelStallWatchdog();
      await this.refreshCache(reverted);
      this.emitEngineEvent(
        "snapshot_changed",
        `Reverted run "${reverted.title}" (${runId}) back to recon mode.`,
      );
    }
    return reverted;
  }

  /**
   * Disposes live `AgentSession` handles and marks all non-killed `m.recon === true`
   * members as `state: "killed"` cleanly after promotion (and after any wave-1 `fork`
   * has cloned their conversation history), without posting noisy `@` wakes.
   */
  async retireReconMembers(runId: string): Promise<string[]> {
    const current = await this.store.loadRun(runId);
    const ordered = [
      ...current.memberOrder
        .map((n) => getOwnMember(current, n))
        .filter((m): m is SwarmMemberRecord => Boolean(m)),
      ...Object.values(current.members).filter(
        (m) => !current.memberOrder.includes(m.name),
      ),
    ];
    const reconTargets = ordered.filter(
      (m) => m.recon === true && m.state !== "killed",
    );
    if (reconTargets.length === 0) {
      return [];
    }

    const nowIso = new Date(this.nowFn()).toISOString();
    const retiredNames: string[] = [];
    let updated = current;

    for (const member of reconTargets) {
      const live =
        this.activeRunId === runId ? this.liveMembers.get(member.name) : undefined;
      if (live) {
        this.cancelMemberRetryTimer(live);
        live.launchAbort?.abort();
        live.attemptToken = undefined;
        live.spawning = false;
        live.waking = false;
        live.turnActive = false;
        live.switchingModel = false;
        live.pendingSelfModelSwitch = undefined;
        live.lastWaitRequest = undefined;
        live.lastSilentSummary = undefined;
        live.parkedMentionsOnly = true;
        live.currentActivity = undefined;
        live.turnStartedAt = undefined;
        live.pendingWakes.length = 0;
        if (live.handle) {
          await live.handle
            .kill("Retired recon session after promotion")
            .catch(() => {});
        }
        live.releaseSlot?.();
        live.releaseSlot = undefined;
        this.liveMembers.delete(member.name);
      }

      const flushedBreakdown = maxTokenBreakdown(
        member.tokenBreakdown,
        live?.liveTokenBreakdown,
      );
      const flushedLlmTurns = Math.max(
        member.llmTurns ?? 0,
        live?.liveLlmTurns ?? 0,
      );
      updated = await this.store.updateMember(runId, member.name, {
        state: "killed",
        tokens: Math.max(member.tokens, live?.liveTokens ?? 0),
        cost: Math.max(member.cost, live?.liveCost ?? 0),
        ...(flushedBreakdown ? { tokenBreakdown: flushedBreakdown } : {}),
        logTail:
          live && live.logTail.length > 0 ? [...live.logTail] : member.logTail,
        ...(flushedLlmTurns > 0 ? { llmTurns: flushedLlmTurns } : {}),
        ...(live?.lastTool !== undefined ? { lastTool: live.lastTool } : {}),
        currentActivity: null,
        turnStartedAt: null,
        parkedOn: "retired recon session",
        endedAt: nowIso,
        actor: ORCHESTRATOR_NAME,
      });
      retiredNames.push(member.name);
    }

    if (this.activeRunId === runId) {
      await this.refreshCache(updated);
      this.emitEngineEvent(
        "snapshot_changed",
        `Retired ${retiredNames.length} recon member(s): ${retiredNames.map((n) => `@${n}`).join(", ")}`,
      );
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
    }

    return retiredNames;
  }

  // --------------------------------------------------------------------------
  // Dynamic Member Management (addMembers, switchModel, steer, stop, kill, merge)
  // --------------------------------------------------------------------------

  async addMembers(input: AddMemberInput): Promise<SwarmMemberRecord[]> {
    if (input.hostContext) {
      this.hostContext = input.hostContext;
    }
    const run = this.requireActiveRun();
    if (this.runDonePosted || run.status === "completed" || run.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot add members to a ${this.runDonePosted ? "completing" : run.status} Swarm run.`,
      );
    }

    const callerRole: CallerRole = input.callerRole ?? "orchestrator";
    const callerName =
      input.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    // Permission & role validation
    let parentName: string = ORCHESTRATOR_NAME;
    let parentMember: SwarmMemberRecord | undefined;

    if (callerRole === "worker" || callerRole === "validator") {
      parentMember = this.findMember(run, callerName);
      if (!parentMember) {
        throw new SwarmProtocolError(
          "MEMBER_NOT_FOUND",
          `Caller member "${callerName}" was not found in run "${run.id}".`,
        );
      }
      if (parentMember.state === "killed") {
        throw new SwarmProtocolError(
          "MEMBER_KILLED",
          `Killed member "${callerName}" cannot add helpers.`,
        );
      }
      parentName = parentMember.name;
      if (callerRole === "validator" && input.role && input.role !== "validator") {
        throw new SwarmProtocolError(
          "ROLE_FORBIDDEN",
          `Read-only validator "@${parentName}" may only add read-only "validator" helpers.`,
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${callerRole}" is not allowed to add swarm members.`,
      );
    }

    const memberRole: SwarmMemberRole =
      callerRole === "validator" ? "validator" : (input.role ?? "worker");

    const baseName = validateMemberName(input.name);
    const brief = input.brief?.trim() ?? "";
    if (!brief) {
      throw new SwarmProtocolError("INVALID_INPUT", "Member brief must be non-empty.");
    }

    const hasTasks = Array.isArray(input.tasks) && input.tasks.length > 0;
    const hasCount = input.n !== undefined && input.n > 1;
    if (hasTasks && hasCount) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        'Specify either "n" or "tasks", not both.',
      );
    }

    // Build member spawn specifications (single, n copies, or sharded tasks[])
    interface MemberSpec {
      name: string;
      groupPrefix?: string;
      brief: string;
    }

    const specs: MemberSpec[] = [];
    if (hasTasks) {
      if (input.tasks!.length > MAX_SHARD_COUNT) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Too many sharded tasks (${input.tasks!.length}); maximum is ${MAX_SHARD_COUNT}.`,
        );
      }
      for (let i = 0; i < input.tasks!.length; i++) {
        const target = input.tasks![i]!.trim();
        if (!target) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            `Task slice at index ${i} must be non-empty.`,
          );
        }
        const shardName = validateMemberName(`${baseName}-${i + 1}`);
        specs.push({
          name: shardName,
          groupPrefix: baseName,
          brief: `${brief}\n\nAssigned slice (${i + 1}/${input.tasks!.length}): ${target}`,
        });
      }
    } else if (hasCount) {
      const count = input.n!;
      if (!Number.isInteger(count) || count < 1 || count > MAX_SHARD_COUNT) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Invalid member copy count n=${String(count)} (expected integer 1..${MAX_SHARD_COUNT}).`,
        );
      }
      for (let i = 1; i <= count; i++) {
        const shardName = validateMemberName(`${baseName}-${i}`);
        specs.push({
          name: shardName,
          groupPrefix: baseName,
          brief,
        });
      }
    } else {
      specs.push({
        name: baseName,
        brief,
      });
    }

    // Reject duplicates (including previously killed names — killed names are never reused!)
    const batchNames = new Set<string>();
    for (const spec of specs) {
      const lower = spec.name.toLowerCase();
      const hasLive = Array.from(this.liveMembers.keys()).some(
        (k) => k.toLowerCase() === lower,
      );
      if (batchNames.has(lower) || this.findMember(run, spec.name) || hasLive) {
        throw new SwarmProtocolError(
          "DUPLICATE_MEMBER",
          `Member name "${spec.name}" already exists in this Swarm run (killed names cannot be reused).`,
          { name: spec.name },
        );
      }
      batchNames.add(lower);
    }

    // Resolve and validate channels
    let channels: string[];
    if (input.channels && input.channels.length > 0) {
      channels = [];
      const seen = new Set<string>();
      for (const rawCh of input.channels) {
        const ch = validateChannelName(rawCh);
        const record = getOwnChannel(run, ch);
        if (!record) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            `Channel "#${ch}" does not exist. Create it first via swarm{action:"channel", op:"create"}.`,
            { channel: ch },
          );
        }
        if (record.archived) {
          throw new SwarmProtocolError(
            "CHANNEL_ARCHIVED",
            `Channel "#${ch}" is archived and cannot accept new members.`,
            { channel: ch },
          );
        }
        if (!seen.has(ch)) {
          seen.add(ch);
          channels.push(ch);
        }
      }
    } else if (parentMember) {
      const inherited = parentMember.channels.filter((ch) => {
        const rec = getOwnChannel(run, ch);
        return Boolean(rec && !rec.archived);
      });
      channels = inherited.length > 0 ? [...inherited] : [DEFAULT_CHANNEL];
    } else {
      channels = [DEFAULT_CHANNEL];
    }
    const primaryChannel = channels[0] ?? DEFAULT_CHANNEL;

    // Resolve TRUE Conversation Fork (`input.fork`) before creating worktrees/members
    let forkedFrom: string | undefined;
    let seedMessages: AgentMessage[] | undefined;
    if (input.fork?.trim()) {
      const forkTarget = input.fork.trim();
      const forkLower = forkTarget.toLowerCase();
      if (forkLower === ORCHESTRATOR_NAME || forkLower === "coordinator") {
        const ctx = input.hostContext ?? this.hostContext;
        seedMessages = sanitizeForkSeedMessages(extractSessionMessages(ctx?.sessionManager));
        forkedFrom = ORCHESTRATOR_NAME;
      } else {
        const sourceMember = this.findMember(run, forkTarget);
        if (!sourceMember) {
          throw new SwarmProtocolError(
            "MEMBER_NOT_FOUND",
            `Cannot fork from unknown member "${forkTarget}".`,
            { fork: forkTarget },
          );
        }
        const sourceLive = this.liveMembers.get(sourceMember.name);
        if (sourceLive?.handle) {
          seedMessages = sanitizeForkSeedMessages(sourceLive.handle.getConversationMessages());
        } else if (sourceLive && sourceLive.lastMessages.length > 0) {
          seedMessages = sanitizeForkSeedMessages(sourceLive.lastMessages);
        } else if (sourceMember.state === "killed") {
          throw new SwarmProtocolError(
            "MEMBER_KILLED",
            `Cannot fork from killed member "@${sourceMember.name}" (session disposed).`,
            { fork: sourceMember.name },
          );
        } else if (sourceMember.sessionFile) {
          try {
            const reopened = SessionManager.open(sourceMember.sessionFile);
            seedMessages = sanitizeForkSeedMessages(extractSessionMessages(reopened));
          } catch {
            seedMessages = [];
          }
        } else {
          seedMessages = [];
        }
        forkedFrom = sourceMember.name;
      }
    }

    // Resolve 3-role model (`worker` vs `validator`, with explicit override taking precedence)
    const settings = this.getEffectiveSettings();
    const roleDefaultFromRun = run.roleModels[memberRole];
    const resolvedFromSettings = resolveRoleModel(
      memberRole,
      settings,
      input.model,
      input.thinkingLevel,
    );
    const effectiveModel =
      resolvedFromSettings.model ?? roleDefaultFromRun?.model?.trim() ?? undefined;
    const effectiveThinking =
      resolvedFromSettings.thinkingLevel ?? roleDefaultFromRun?.thinkingLevel;

    const reconRunActive = isReconRun(run);
    const isReconMember = Boolean(reconRunActive || parentMember?.recon);
    if (
      isReconMember &&
      (input.workspace === "share" || input.workspace === "branch")
    ) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Isolated workspace "${input.workspace}" is blocked while Swarm run "${run.id}" is in read-only recon mode. Recon workers always run read-only in workspace:"inherit" — propose and confirm the execution plan via ${PROPOSE_SWARM_PLAN_TOOL} first.`,
        { runId: run.id, runMode: run.runMode ?? "recon", workspace: input.workspace },
      );
    }
    const workspaceMode: SwarmWorkspaceMode =
      isReconMember || memberRole === "validator"
        ? "inherit"
        : (input.workspace ?? "inherit");
    const safeRunBranchSegment =
      run.id
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "run";
    const createdRecords: SwarmMemberRecord[] = [];
    const launches: Array<{
      memberName: string;
      briefSeq: number;
      seedMessages?: AgentMessage[];
    }> = [];

    if (isOrchestratorOrHuman(callerRole)) {
      this.boardHopCount = 0;
      this.hopCapAlerted = false;
    }

    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");

    const preparedSpecs: Array<{
      spec: (typeof specs)[number];
      cwd: string;
      branch?: string;
      initWarning?: string;
    }> = [];
    const provisionedWorktrees: Array<{ worktreePath: string; branch?: string }> = [];

    try {
      for (const spec of specs) {
        let cwd: string;
        let branch: string | undefined;
        let initWarning: string | undefined;

        if (workspaceMode === "share" || workspaceMode === "branch") {
          branch = `${SWARM_BRANCH_PREFIX}${safeRunBranchSegment}/${spec.name}`;
          const worktreePath = this.store.getWorktreePath(run.id, spec.name);
          const createdWt = await this.worktree.createWorktree({
            branch,
            baseBranch: run.baseBranch,
            worktreePath,
            mode: workspaceMode,
          });
          cwd = createdWt.worktreePath;
          branch = createdWt.branch;
          provisionedWorktrees.push({ worktreePath: cwd, branch });
          const initRes = await this.executeWorktreeInitCommand(
            this.cachedRun ?? run,
            cwd,
          );
          if (!initRes.ok && initRes.warning) {
            initWarning = initRes.warning;
          }
        } else {
          cwd =
            parentMember && parentMember.workspace !== "inherit"
              ? parentMember.cwd
              : this.worktree.repoRoot;
        }

        preparedSpecs.push({ spec, cwd, branch, initWarning });
      }
    } catch (err) {
      for (const wt of provisionedWorktrees) {
        await this.worktree.removeWorktree(wt.worktreePath, { force: true }).catch(() => {});
        if (wt.branch) {
          await this.worktree.deleteBranch?.(wt.branch).catch(() => {});
        }
      }
      throw err;
    }

    const registeredWorktrees = new Set<string>();
    const preRegisteredLiveNames: string[] = [];
    try {
      for (const { spec, cwd, branch, initWarning } of preparedSpecs) {
        const agentId = this.generateAgentIdFn(spec.name);
        // Register LiveMember SYNCHRONOUSLY as spawning BEFORE store.addMember so concurrent peer
        // @all / @<prefix> posts during registration queue into pendingWakes instead of spawning duplicates!
        const live: LiveMember = {
          name: spec.name,
          agentId,
          role: memberRole,
          spawning: true,
          waking: false,
          turnActive: false,
          switchingModel: false,
          parkedMentionsOnly: true,
          pendingWakes: [],
          deliveredSeqs: new Set<number>(),
          triedModels: new Set<string>(effectiveModel ? [effectiveModel] : []),
          lastMessages: seedMessages ? sanitizeForkSeedMessages(seedMessages) : [],
          logTail: initWarning ? [initWarning] : [],
          currentActivity: "queued to start",
          turnStartPostSeq: 0,
          lastSilentSummary: undefined,
          retryCount: 0,
          priorHandlesTokens: 0,
          priorHandlesBreakdown: undefined,
          priorHandlesCost: 0,
          liveLlmTurns: 0,
          turnStartedAt: new Date(this.nowFn()).toISOString(),
        };
        this.liveMembers.set(spec.name, live);
        preRegisteredLiveNames.push(spec.name);

        await this.store.addMember(
          run.id,
          {
            name: spec.name,
            agentId,
            role: memberRole,
            ...(isReconMember ? { recon: true } : {}),
            parentName,
            groupPrefix: spec.groupPrefix,
            brief: spec.brief,
            workspace: workspaceMode,
            cwd,
            branch,
            forkedFrom,
            channels,
            state: "working",
            model: effectiveModel,
            thinkingLevel: effectiveThinking,
            modelExplicit: Boolean(input.model?.trim()),
            lastReadSeq: this.cachedRun?.boardHead ?? run.boardHead,
            turnStartedAt: live.turnStartedAt,
            llmTurns: 0,
          },
          { actor: callerName },
        );
        if (workspaceMode === "share" || workspaceMode === "branch") {
          registeredWorktrees.add(cwd);
        }

        // Post public brief on the shared board as callerName
        const briefKnownMembers = this.collectKnownMentionHandles(this.cachedRun ?? run);
        briefKnownMembers.add(spec.name.toLowerCase());
        if (spec.groupPrefix) {
          briefKnownMembers.add(spec.groupPrefix.toLowerCase());
        }
        const briefMsg = await this.store.postBoardMessage(run.id, {
          from: callerName,
          fromRole: callerRole,
          channel: primaryChannel,
          kind: "brief",
          text: `@${spec.name} ${spec.brief}`,
          knownMembers: briefKnownMembers,
        });
        this.recordBoardMessageInCache(briefMsg);
        live.deliveredSeqs.add(briefMsg.seq);

        const updatedRun = await this.store.updateMember(run.id, spec.name, {
          briefSeq: briefMsg.seq,
          lastReadSeq: briefMsg.seq,
          currentActivity: "queued to start",
          ...(initWarning ? { logLine: initWarning } : {}),
          actor: callerName,
        });
        this.setCachedRun(updatedRun);

        const memberRecord = getOwnMember(updatedRun, spec.name)!;
        live.logTail =
          memberRecord.logTail.length > 0
            ? [...memberRecord.logTail]
            : initWarning
              ? [initWarning]
              : [];
        createdRecords.push(memberRecord);

        this.emitEngineEvent("board_posted", `Posted brief #${briefMsg.seq} for @${spec.name}`, {
          memberName: spec.name,
          seq: briefMsg.seq,
        });
        this.notifyWaitersOnMessage(briefMsg);

        launches.push({
          memberName: spec.name,
          briefSeq: briefMsg.seq,
          seedMessages: seedMessages ? sanitizeForkSeedMessages(seedMessages) : undefined,
        });
      }
    } catch (err) {
      for (const name of preRegisteredLiveNames) {
        this.liveMembers.delete(name);
      }
      for (const wt of provisionedWorktrees) {
        if (!registeredWorktrees.has(wt.worktreePath)) {
          await this.worktree.removeWorktree(wt.worktreePath, { force: true }).catch(() => {});
          if (wt.branch) {
            await this.worktree.deleteBranch?.(wt.branch).catch(() => {});
          }
        }
      }
      throw err;
    }

    await this.refreshCache();
    this.emitEngineEvent(
      "snapshot_changed",
      `Added ${createdRecords.length} member(s): ${createdRecords.map((m) => `@${m.name}`).join(", ")}`,
    );

    // Launch all newly registered members asynchronously
    const effectiveCtx = input.hostContext ?? this.hostContext;
    for (const launch of launches) {
      void this.launchMemberInitialTurn(
        run.id,
        launch.memberName,
        launch.briefSeq,
        launch.seedMessages,
        effectiveCtx,
      );
    }

    return createdRecords;
  }

  async postMessage(input: PostBoardMessageInput): Promise<BoardMessage> {
    const run = this.requireActiveRun();
    if (this.runDonePosted || run.status === "completed" || run.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot post messages to a ${this.runDonePosted ? "completing" : run.status} Swarm run.`,
      );
    }
    const text = input.text?.trim() ?? "";
    if (!text) {
      throw new SwarmProtocolError("INVALID_INPUT", "Board message text must be non-empty.");
    }

    // Parse & validate channel mentions (`@#<ch>`): reject `@#main`, unknown, or archived channels
    const parsedChMentions = mergeUniqueLower([
      parseChannelMentions(text),
      input.channelMentions,
    ]);
    for (const ch of parsedChMentions) {
      if (ch === DEFAULT_CHANNEL) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          'Cannot mention "@#main". Use "@all" for swarm-wide notices or target a specific channel.',
          { channel: ch },
        );
      }
      const chRecord = getOwnChannel(run, ch);
      if (!chRecord) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          `Channel "#${ch}" does not exist.`,
          { channel: ch },
        );
      }
      if (chRecord.archived) {
        throw new SwarmProtocolError(
          "CHANNEL_ARCHIVED",
          `Channel "#${ch}" is archived and cannot be mentioned.`,
          { channel: ch },
        );
      }
    }

    // Resolve and validate target post channel (sanitize null/"null"/"undefined"/"" as omitted)
    const senderMember = this.findMember(run, input.from);
    const sanitizedChannel = normalizeOptionalChannel(input.channel)?.toLowerCase();
    const channel =
      sanitizedChannel ||
      senderMember?.channels[0] ||
      DEFAULT_CHANNEL;
    const channelRecord = getOwnChannel(run, channel);
    if (!channelRecord) {
      throw new SwarmProtocolError(
        "INVALID_CHANNEL",
        `Channel "#${channel}" does not exist.`,
        { channel },
      );
    }
    if (channelRecord.archived) {
      throw new SwarmProtocolError(
        "CHANNEL_ARCHIVED",
        `Channel "#${channel}" is archived and cannot receive posts.`,
        { channel },
      );
    }

    // Parse handle mentions (`@name`, `@prefix`, `@all`) filtered against the active roster
    const knownMembers = this.collectKnownMentionHandles(run);
    const parsedMentions = mergeUniqueLower([parseHandleMentions(text), input.mentions]).filter(
      (handle) => knownMembers.has(handle),
    );

    const rawFeatureId =
      typeof input.featureId === "string" && input.featureId.trim()
        ? input.featureId.trim()
        : undefined;
    const discoveredIssues = Array.isArray(input.discoveredIssues)
      ? input.discoveredIssues
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const leftUndone = Array.isArray(input.leftUndone)
      ? input.leftUndone
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const verificationEvidence =
      typeof input.verificationEvidence === "string" && input.verificationEvidence.trim()
        ? input.verificationEvidence.trim()
        : undefined;

    // Enforce mandatory structured worker handoff on [done] when Mission features exist!
    const isWorkerSenderPreCheck =
      input.fromRole === "worker" || senderMember?.role === "worker";
    const isCompletionPostPreCheck =
      input.kind === "done" || DONE_PREFIX_RE.test(text);
    let featureId = rawFeatureId;

    if (
      isWorkerSenderPreCheck &&
      isCompletionPostPreCheck &&
      run.features &&
      run.features.length > 0
    ) {
      const workerHandle = senderMember?.name ?? input.from.trim().replace(/^@/, "");
      let targetFeature: MissionFeature | undefined;
      if (featureId) {
        targetFeature = run.features.find((f) => f.id === featureId);
      } else {
        const assignedActive = run.features.filter(
          (f) =>
            f.assignedMember === workerHandle &&
            (f.status === "in_progress" || f.status === "pending"),
        );
        if (assignedActive.length > 1) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            `Multiple Mission features are assigned to you (${assignedActive.map((f) => f.id).join(", ")}); pass feature_id explicitly on post_message when reporting [done].`,
            { assignedFeatures: assignedActive.map((f) => f.id) },
          );
        }
        if (assignedActive.length === 1) {
          targetFeature = assignedActive[0];
          featureId = targetFeature.id;
        }
      }

      if (targetFeature && targetFeature.status !== "cancelled") {
        if (
          targetFeature.assignedMember &&
          targetFeature.assignedMember !== workerHandle &&
          senderMember?.parentName !== targetFeature.assignedMember
        ) {
          const assignedOwner = getOwnMember(run, targetFeature.assignedMember);
          if (!assignedOwner || assignedOwner.state !== "killed") {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Worker "@${workerHandle}" cannot report [done] on feature "${targetFeature.id}" assigned to "@${targetFeature.assignedMember}".`,
              {
                featureId: targetFeature.id,
                assignedMember: targetFeature.assignedMember,
                callerName: workerHandle,
              },
            );
          }
        }
        const hasUndoneItems = Boolean(leftUndone && leftUndone.length > 0);
        const evidenceLen = verificationEvidence?.trim().length ?? 0;
        if (!hasUndoneItems && evidenceLen < 10) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            `Structured handoff required when reporting [done] on Mission feature "${targetFeature.id}": provide verification_evidence (>= 10 chars with exact commands & results run) plus any discovered_issues[] / left_undone[].`,
            { featureId: targetFeature.id },
          );
        }
      }
    }

    // Validator [done] pre-check: prevent reporting @orchestrator [done] when completed features still have unverified "pending" VAL-* assertions
    const isValidatorSenderPreCheck =
      (input.fromRole === "validator" || senderMember?.role === "validator") &&
      !senderMember?.recon &&
      !isReconRun(run);
    if (
      isValidatorSenderPreCheck &&
      isCompletionPostPreCheck &&
      run.assertions &&
      run.assertions.length > 0
    ) {
      const validatorHandle = (
        senderMember?.name ?? input.from.trim().replace(/^@/, "")
      ).toLowerCase();
      const mentionsOrchestrator =
        parsedMentions.includes(ORCHESTRATOR_NAME) ||
        parsedMentions.includes("coordinator");
      const mentionsWorkerPeer = parsedMentions.some((h) => {
        const m = this.findMember(run, h);
        return Boolean(m && m.role === "worker" && m.state !== "killed");
      });
      const hasBlockerOrHumanTag = /\[(?:blocker|NEEDS_HUMAN)\]/i.test(text);

      if (mentionsOrchestrator && !mentionsWorkerPeer && !hasBlockerOrHumanTag) {
        const assertionById = new Map(run.assertions.map((a) => [a.id, a]));
        const anyFailedOrBlocked = run.assertions.some(
          (a) => a.status === "failed" || a.status === "blocked",
        );
        if (!anyFailedOrBlocked) {
          const otherLiveValidators = Object.values(run.members).filter(
            (m) =>
              m.role === "validator" &&
              !m.recon &&
              m.state !== "killed" &&
              m.name.toLowerCase() !== validatorHandle,
          );
          const thisValidatorVerifiedAny = run.assertions.some(
            (a) =>
              a.verifiedBy?.toLowerCase() === validatorHandle &&
              a.status !== "pending",
          );
          const completedFeaturesWithAllPending = (run.features ?? []).filter(
            (f) =>
              f.status === "completed" &&
              f.fulfills.length > 0 &&
              f.fulfills.every((id) => assertionById.get(id)?.status === "pending"),
          );
          const pendingIdsToVerify = Array.from(
            new Set(completedFeaturesWithAllPending.flatMap((f) => f.fulfills)),
          ).filter((id) => assertionById.get(id)?.status === "pending");

          if (
            pendingIdsToVerify.length > 0 &&
            (otherLiveValidators.length === 0 || !thisValidatorVerifiedAny)
          ) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Validator "@${senderMember?.name ?? input.from}" cannot report @${ORCHESTRATOR_NAME} [done] while completed feature(s) (${completedFeaturesWithAllPending.map((f) => f.id).join(", ")}) still have unverified "pending" VAL-* assertion(s): ${pendingIdsToVerify.join(", ")}. Call swarm{action:"mission", mission_op:"verify_assertion", assertion_ids:${JSON.stringify(pendingIdsToVerify)}, assertion_status:"passed"|"failed", evidence:"..."} before reporting @${ORCHESTRATOR_NAME} [done] (or @mention the author directly to bounce defects).`,
              {
                unverifiedAssertionIds: pendingIdsToVerify,
                completedFeatureIds: completedFeaturesWithAllPending.map((f) => f.id),
              },
            );
          }
        }
      }
    }

    const msg = await this.store.postBoardMessage(run.id, {
      ...input,
      text,
      channel,
      mentions: parsedMentions,
      channelMentions: parsedChMentions,
      ...(featureId !== undefined ? { featureId } : {}),
      ...(discoveredIssues && discoveredIssues.length > 0 ? { discoveredIssues } : {}),
      ...(leftUndone && leftUndone.length > 0 ? { leftUndone } : {}),
      ...(verificationEvidence !== undefined ? { verificationEvidence } : {}),
      knownMembers,
    });

    // Ensure consistent normalized mentions & structured handoff fields even with minimal mock stores
    const normalizedMsg: BoardMessage = {
      ...msg,
      channel: msg.channel || channel,
      mentions: mergeUniqueLower([msg.mentions, parsedMentions]).filter((handle) =>
        knownMembers.has(handle),
      ),
      channelMentions: mergeUniqueLower([msg.channelMentions, parsedChMentions]),
      ...(featureId !== undefined ? { featureId } : {}),
      ...(discoveredIssues && discoveredIssues.length > 0 ? { discoveredIssues } : {}),
      ...(leftUndone && leftUndone.length > 0 ? { leftUndone } : {}),
      ...(verificationEvidence !== undefined ? { verificationEvidence } : {}),
    };

    this.recordBoardMessageInCache(normalizedMsg);
    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");
    this.lastStallAlertHead = null;
    this.lastMonitorNudgeSeq = null;

    if (normalizedMsg.fromRole === "human") {
      this.humanInputAwaited = false;
    }
    if (normalizedMsg.fromRole === "orchestrator" || normalizedMsg.fromRole === "human") {
      this.boardHopCount = 0;
      this.hopCapAlerted = false;
    }

    // Auto-record structured worker handoff items & auto-link featureId on worker [done] posts
    const hasDiscovered = Boolean(discoveredIssues && discoveredIssues.length > 0);
    const hasUndone = Boolean(leftUndone && leftUndone.length > 0);
    const isWorkerSender =
      normalizedMsg.fromRole === "worker" || senderMember?.role === "worker";
    const isDonePost =
      normalizedMsg.kind === "done" || DONE_PREFIX_RE.test(text);
    const autoCompletedInheritMilestones = new Set<string>();

    let latestRun: SwarmRunState;
    if (hasDiscovered || hasUndone || (featureId && isWorkerSender)) {
      latestRun = await this.withMissionLock(async () => {
        const fresh = await this.store.loadRun(run.id);
        const nowIso = new Date(this.nowFn()).toISOString();
        const nextHandoffs: MissionHandoffItem[] = [...(fresh.handoffItems ?? [])];
        let handoffMutated = false;
        let itemIdx = 0;
        const makeHandoffId = (): string => {
          let candidate = `HO-${normalizedMsg.seq}-${++itemIdx}`;
          while (nextHandoffs.some((h) => h.id === candidate)) {
            candidate = `HO-${normalizedMsg.seq}-${++itemIdx}`;
          }
          return candidate;
        };

        for (const issue of discoveredIssues ?? []) {
          nextHandoffs.push({
            id: makeHandoffId(),
            type: "discovered_issue",
            sourceMember: normalizedMsg.from,
            ...(featureId ? { sourceFeatureId: featureId } : {}),
            summary: issue,
            resolution: "open",
            createdAt: nowIso,
          });
          handoffMutated = true;
        }
        for (const undone of leftUndone ?? []) {
          nextHandoffs.push({
            id: makeHandoffId(),
            type: "incomplete_work",
            sourceMember: normalizedMsg.from,
            ...(featureId ? { sourceFeatureId: featureId } : {}),
            summary: undone,
            resolution: "open",
            createdAt: nowIso,
          });
          handoffMutated = true;
        }

        let nextFeatures = fresh.features
          ? fresh.features.map((f) => ({ ...f }))
          : undefined;
        let nextMilestones = fresh.milestones;
        let featuresMutated = false;

        if (featureId && isWorkerSender && nextFeatures && nextFeatures.length > 0) {
          const targetIdx = nextFeatures.findIndex((f) => f.id === featureId);
          if (targetIdx >= 0) {
            const feat = nextFeatures[targetIdx]!;
            if (feat.status !== "cancelled") {
              const effectiveMemberName = senderMember?.name ?? normalizedMsg.from;
              const freshSender =
                getOwnMember(fresh, effectiveMemberName) ?? senderMember;
              const isHelperOfAssigned =
                Boolean(feat.assignedMember) &&
                freshSender?.parentName === feat.assignedMember;
              const canTouchFeature =
                !feat.assignedMember ||
                feat.assignedMember === effectiveMemberName ||
                isHelperOfAssigned;

              if (canTouchFeature) {
                const prevStatus = feat.status;
                if (isDonePost && !hasUndone) {
                  if (!feat.assignedMember) {
                    feat.assignedMember = effectiveMemberName;
                  }
                  const isSharedRepoInherit =
                    freshSender !== undefined &&
                    freshSender.workspace === "inherit" &&
                    path.resolve(freshSender.cwd) ===
                      path.resolve(this.worktree.repoRoot);
                  const isInheritOrMerged =
                    !freshSender ||
                    isSharedRepoInherit ||
                    Boolean(freshSender.mergedCommitSha);
                  if (isInheritOrMerged) {
                    feat.status = "completed";
                    if (freshSender?.mergedCommitSha && !feat.mergedCommitSha) {
                      feat.mergedCommitSha = freshSender.mergedCommitSha;
                    }
                    if (prevStatus !== "completed" && feat.milestone) {
                      autoCompletedInheritMilestones.add(feat.milestone);
                    }
                  } else if (feat.status === "pending" || feat.status === "failed") {
                    feat.status = "in_progress";
                  }
                  feat.updatedAt = nowIso;
                  nextFeatures = orderMissionFeatures(nextFeatures);
                  featuresMutated = true;
                } else if (isDonePost && hasUndone) {
                  if (!feat.assignedMember) {
                    feat.assignedMember = effectiveMemberName;
                  }
                  if (feat.status === "pending") {
                    feat.status = "in_progress";
                  }
                  feat.updatedAt = nowIso;
                  featuresMutated = true;
                } else if (!feat.assignedMember && feat.status === "pending") {
                  feat.assignedMember = effectiveMemberName;
                  feat.status = "in_progress";
                  feat.updatedAt = nowIso;
                  featuresMutated = true;
                }
              }

              if (featuresMutated) {
                nextMilestones = syncMissionMilestones(
                  fresh.milestones,
                  nextFeatures,
                  fresh.assertions ?? [],
                  nowIso,
                  fresh.members,
                ).milestones;
              }
            }
          }
        }

        if (!handoffMutated && !featuresMutated) {
          return fresh;
        }
        return this.store.updateRun(run.id, {
          ...(handoffMutated ? { handoffItems: nextHandoffs } : {}),
          ...(featuresMutated
            ? { features: nextFeatures!, milestones: nextMilestones }
            : {}),
          actor: normalizedMsg.from,
        });
      });
    } else {
      latestRun = await this.store.loadRun(run.id);
    }

    this.setCachedRun(latestRun);
    if (senderMember) {
      const senderLive = this.liveMembers.get(senderMember.name);
      if (senderLive) {
        senderLive.lastSilentSummary = undefined;
      }
    }

    this.emitEngineEvent("board_posted", `Posted #${normalizedMsg.seq} from ${normalizedMsg.from}`, {
      memberName: senderMember?.name,
      seq: normalizedMsg.seq,
    });

    // Coordinate auto-validator trigger with Orchestrator wakeup so worker `@orchestrator [done]`
    // does not fire a premature sandwich wakeup when `@validator` immediately takes over the milestone!
    const canDeferOrchWakeForValidator =
      latestRun.status === "active" &&
      normalizedMsg.fromRole !== "monitor" &&
      autoCompletedInheritMilestones.size > 0 &&
      latestRun.validatorEnabled &&
      isWorkerSender &&
      isDonePost &&
      !hasDiscovered &&
      !hasUndone &&
      !WORKER_DONE_URGENT_TAG_RE.test(text) &&
      !this.hasDagReadyPendingFeatures(latestRun);

    // Route peer wakeups SYNCHRONOUSLY marking `live.waking = true` BEFORE resolving waiters or returning!
    let emittedOrchWakeup = false;
    if (latestRun.status === "active" && normalizedMsg.fromRole !== "monitor") {
      emittedOrchWakeup = await this.routeBoardMessageWakeups(
        latestRun,
        normalizedMsg,
        canDeferOrchWakeForValidator ? { suppressOrchestratorWakeup: true } : undefined,
      );
    }

    if (!canDeferOrchWakeForValidator) {
      // If Orchestrator is parked in non-blocking `swarm_wait`, check if this message wakes it (without double-emitting!)
      this.maybeWakeParkedOrchestratorOnMessage(normalizedMsg, emittedOrchWakeup);
    }

    // Notify blocking `waitForBoard` waiters immediately
    this.notifyWaitersOnMessage(normalizedMsg);

    // Auto-trigger milestone @validator when an inherit feature completion finishes all features of a milestone!
    let autoValidatorTriggered = false;
    if (autoCompletedInheritMilestones.size > 0) {
      const alreadyNotifiedHandles = this.computeNotifiedValidatorHandles(
        latestRun,
        normalizedMsg,
      );
      const cues = await this.maybeTriggerMilestoneValidation(
        run.id,
        autoCompletedInheritMilestones,
        alreadyNotifiedHandles.size > 0 ? { alreadyNotifiedHandles } : undefined,
      );
      autoValidatorTriggered = cues.some((c) =>
        Boolean(c.validatorWoken || c.validatorSpawned),
      );
    }

    if (canDeferOrchWakeForValidator && !autoValidatorTriggered) {
      const latestAfterVal = this.cachedRun ?? latestRun;
      const deferredEmitted = this.emitOrchestratorMessageWakeupIfAddressed(
        latestAfterVal,
        normalizedMsg,
      );
      this.maybeWakeParkedOrchestratorOnMessage(normalizedMsg, deferredEmitted);
    }

    // Re-arm watchdog if 0 working and no waiter is blocked (and not done)
    this.maybeArmStallWatchdog();

    return normalizedMsg;
  }

  clearOrchestratorWait(_reason?: string): void {
    if (!this.orchestratorWait) {
      return;
    }
    if (this.orchestratorWait.timer) {
      clearTimeout(this.orchestratorWait.timer);
      this.orchestratorWait.timer = null;
    }
    this.orchestratorWait = null;
    this.maybeArmStallWatchdog();
  }

  setHumanInputAwaited(waiting: boolean): void {
    const next = Boolean(waiting);
    if (this.humanInputAwaited === next) {
      if (next) {
        this.cancelStallWatchdog();
      }
      return;
    }
    this.humanInputAwaited = next;
    if (next) {
      this.cancelStallWatchdog();
      void this.cancelActiveMonitor("Awaiting human input ([NEEDS_HUMAN])");
    } else {
      this.maybeArmStallWatchdog();
    }
  }

  async parkOrchestratorWait(
    options: ParkOrchestratorWaitOptions,
  ): Promise<ParkOrchestratorWaitResult> {
    const since = Number.isFinite(options.since) ? Math.max(0, Math.floor(options.since)) : 0;
    const mentionsOnly = options.mentionsOnly ?? true;
    const currentHead = this.cachedRun?.boardHead ?? 0;

    if (!this.activeRunId || !this.cachedRun || this.cachedRun.status !== "active") {
      return {
        parked: false,
        wokeBy: "run_ended",
        messages: [],
        head: currentHead,
        activeMembers: [],
        summary: "Swarm run is not active.",
      };
    }

    const runId = this.activeRunId;
    const initial = await this.store.readBoard(runId, {
      since,
      channel: "*",
      limit: Number.MAX_SAFE_INTEGER,
    });
    const latestHead = Math.max(initial.head, this.cachedRun?.boardHead ?? 0);

    const mergedBySeq = new Map<number, BoardMessage>();
    for (const m of initial.messages) {
      mergedBySeq.set(m.seq, m);
    }
    for (const m of this.getCachedMessagesSince(since)) {
      mergedBySeq.set(m.seq, m);
    }
    const mergedUnread = Array.from(mergedBySeq.values()).sort((a, b) => a.seq - b.seq);

    if (
      this.disposed ||
      this.activeRunId !== runId ||
      !this.cachedRun ||
      this.cachedRun.status !== "active"
    ) {
      return {
        parked: false,
        wokeBy: "run_ended",
        messages: mergedUnread,
        head: latestHead,
        activeMembers: [],
        summary: "Swarm run is not active.",
      };
    }

    const immediateMatches = mergedUnread.filter((m) =>
      this.doesMessageMatchWaiter(m, ORCHESTRATOR_NAME, mentionsOnly, []),
    );
    const waitForAll = options.waitForAll ?? isReconRun(this.cachedRun);
    const activeMembers = this.getWorkingOrPendingMemberNames();

    if (
      immediateMatches.length > 0 &&
      (!waitForAll ||
        activeMembers.length === 0 ||
        immediateMatches.some((m) => isUrgentBarrierBypassMessage(m)))
    ) {
      return {
        parked: false,
        wokeBy: "message",
        messages: mergedUnread,
        head: latestHead,
        activeMembers,
        ...(waitForAll ? { waitForAll: true } : {}),
        summary: `${immediateMatches.length} matching board message(s) already waiting since #${since}.`,
      };
    }

    if (activeMembers.length === 0) {
      const digest = this.buildAllIdleDigest();
      const silentDigest = this.consumeSilentTurnSummaries();
      const fullDigest = [digest, silentDigest].filter(Boolean).join(" ");
      return {
        parked: false,
        wokeBy: "all_idle",
        messages: mergedUnread,
        head: latestHead,
        activeMembers: [],
        ...(waitForAll ? { waitForAll: true } : {}),
        summary: fullDigest
          ? `All swarm members are idle (0 working/pending); nothing left to wait for. ${fullDigest}`
          : "All swarm members are idle (0 working/pending); nothing left to wait for.",
      };
    }

    // Arm non-blocking Orchestrator wait and end Orchestrator's current turn cleanly!
    if (this.orchestratorWait?.timer) {
      clearTimeout(this.orchestratorWait.timer);
    }
    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (
      options.timeoutMs !== undefined &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
    ) {
      const waitTimeout = Math.max(10, options.timeoutMs);
      const parkedRunId = runId;
      timer = setTimeout(() => {
        if (!this.orchestratorWait || this.disposed || this.activeRunId !== parkedRunId) {
          return;
        }
        const expired = this.orchestratorWait;
        this.orchestratorWait = null;
        const unread = this.getCachedMessagesSince(expired.since);
        this.emitEngineEvent(
          "wakeup_needed",
          `swarm_wait timed out after ${Math.round(waitTimeout)}ms (board #${this.cachedRun?.boardHead ?? latestHead})`,
          { ...(unread.length > 0 ? { messages: unread } : {}) },
        );
      }, waitTimeout);
      timer.unref?.();
    }

    this.orchestratorWait = {
      since,
      mentionsOnly,
      waitForAll,
      timer,
    };

    return {
      parked: true,
      messages: [],
      head: latestHead,
      activeMembers,
      ...(waitForAll ? { waitForAll: true } : {}),
      summary: `Parked waiting on ${activeMembers.length} active member(s) since #${since}${waitForAll ? " (wait_for_all)" : ""}.`,
    };
  }

  async readBoard(options?: ReadBoardOptions): Promise<ReadBoardResult> {
    const run = this.requireActiveRun();
    const sanitizedChannel = normalizeOptionalChannel(options?.channel);
    const sanitizedOptions: ReadBoardOptions | undefined = options
      ? {
          ...options,
          ...(options.channel !== undefined ? { channel: sanitizedChannel } : {}),
        }
      : undefined;
    const res = await this.store.readBoard(run.id, sanitizedOptions);
    return res;
  }

  async waitForBoard(options: WaitForBoardOptions): Promise<WaitForBoardResult> {
    const since = Number.isFinite(options.since) ? Math.max(0, Math.floor(options.since)) : 0;
    const mentionsOnly = options.mentionsOnly ?? true;
    const targetName = (options.targetName?.trim() || ORCHESTRATOR_NAME).toLowerCase();
    const targetChannels = options.targetChannels ?? [];

    const currentHead = this.cachedRun?.boardHead ?? 0;

    if (options.signal?.aborted) {
      return {
        wokeBy: "aborted",
        messages: [],
        head: currentHead,
        summary: "Wait cancelled by abort signal.",
      };
    }

    if (!this.activeRunId || !this.cachedRun || this.cachedRun.status !== "active") {
      return {
        wokeBy: "run_ended",
        messages: [],
        head: currentHead,
        summary: "Swarm run is not active.",
      };
    }

    const runId = this.activeRunId;
    const initial = await this.store.readBoard(runId, {
      since,
      channel: "*",
      limit: Number.MAX_SAFE_INTEGER,
    });

    // Re-check abort, run lifecycle, and mid-await messages synchronously BEFORE adding waiter!
    const latestHead = Math.max(initial.head, this.cachedRun?.boardHead ?? 0);
    const mergedBySeq = new Map<number, BoardMessage>();
    for (const m of initial.messages) {
      mergedBySeq.set(m.seq, m);
    }
    for (const m of this.getCachedMessagesSince(since)) {
      mergedBySeq.set(m.seq, m);
    }
    const mergedUnread = Array.from(mergedBySeq.values()).sort((a, b) => a.seq - b.seq);

    if (options.signal?.aborted) {
      return {
        wokeBy: "aborted",
        messages: mergedUnread,
        head: latestHead,
        summary: "Wait cancelled by abort signal.",
      };
    }

    if (
      this.disposed ||
      this.activeRunId !== runId ||
      !this.cachedRun ||
      this.cachedRun.status !== "active"
    ) {
      return {
        wokeBy: "run_ended",
        messages: mergedUnread,
        head: latestHead,
        summary: "Swarm run is not active.",
      };
    }

    const immediateMatches = mergedUnread.filter((m) =>
      this.doesMessageMatchWaiter(m, targetName, mentionsOnly, targetChannels),
    );
    if (immediateMatches.length > 0) {
      return {
        wokeBy: "message",
        messages: mergedUnread,
        head: latestHead,
        summary: `${immediateMatches.length} matching board message(s) already waiting since #${since}.`,
      };
    }

    // Anti-deadlock check: if NO member is working, spawning, waking, or switching models -> return immediately!
    const activeNames = this.getWorkingOrPendingMemberNames();
    if (activeNames.length === 0) {
      const digest = this.buildAllIdleDigest();
      const silentDigest = this.consumeSilentTurnSummaries();
      const fullDigest = [digest, silentDigest].filter(Boolean).join(" ");
      return {
        wokeBy: "all_idle",
        messages: mergedUnread,
        head: latestHead,
        summary: fullDigest
          ? `All swarm members are idle (0 working/pending); nothing left to wait for. ${fullDigest}`
          : "All swarm members are idle (0 working/pending); nothing left to wait for.",
      };
    }

    // Orchestrator is actively waiting -> cancel Stall Watchdog so it won't double-alert
    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");

    return new Promise<WaitForBoardResult>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      let progressInterval: ReturnType<typeof setInterval> | null = null;

      const emitProgress = (): void => {
        if (!options.onProgress || settled) return;
        const working = this.getWorkingOrPendingMemberNames();
        const head = this.cachedRun?.boardHead ?? initial.head;
        const statusParts = working.map((name) => {
          const m = getOwnMember(this.cachedRun, name);
          const act = m?.currentActivity ? ` (${m.currentActivity})` : "";
          return `@${name}${act}`;
        });
        try {
          options.onProgress(
            `Waiting on ${working.length} active member(s): ${statusParts.join(", ") || "none"} | board=#${head}`,
          );
        } catch {
          // progress callback errors must not break waitForBoard
        }
      };

      const onAbort = (): void => {
        finish({
          wokeBy: "aborted",
          messages: this.getCachedMessagesSince(since),
          head: this.cachedRun?.boardHead ?? initial.head,
          summary: "Wait cancelled by abort signal.",
        });
      };

      const cleanup = (): void => {
        this.boardWaiters.delete(waiter);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      };

      const finish = (result: WaitForBoardResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const waiter: BoardWaiter = {
        since,
        mentionsOnly,
        targetName,
        targetChannels,
        onProgress: options.onProgress,
        resolve: finish,
        cleanup,
      };

      this.boardWaiters.add(waiter);

      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (
        options.timeoutMs !== undefined &&
        Number.isFinite(options.timeoutMs) &&
        options.timeoutMs > 0
      ) {
        timeoutHandle = setTimeout(() => {
          finish({
            wokeBy: "timeout",
            messages: this.getCachedMessagesSince(since),
            head: this.cachedRun?.boardHead ?? initial.head,
            summary: `Timed out after ${Math.round(options.timeoutMs!)}ms while waiting on board.`,
          });
        }, options.timeoutMs);
        timeoutHandle.unref?.();
      }

      if (options.onProgress) {
        emitProgress();
        progressInterval = setInterval(emitProgress, 1000);
        progressInterval.unref?.();
      }
    });
  }

  async switchModel(options: SwitchModelOptions): Promise<SwitchModelResult> {
    return this.performSwitchModel(options, { holdSwitchingLock: false });
  }

  private async performSwitchModel(
    options: SwitchModelOptions,
    internal: { holdSwitchingLock: boolean },
  ): Promise<SwitchModelResult> {
    if (options.hostContext) {
      this.hostContext = options.hostContext;
    }
    const run = this.requireActiveRun();
    const callerRole: CallerRole = options.callerRole ?? "orchestrator";
    const callerName =
      options.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);
    const targetRaw = options.targetName?.trim().replace(/^@/, "") || callerName;

    const existingMemberForFallback =
      targetRaw.toLowerCase() === ORCHESTRATOR_NAME ||
      targetRaw.toLowerCase() === "coordinator"
        ? undefined
        : this.findMember(run, targetRaw);
    const fallbackModelFromTarget =
      targetRaw.toLowerCase() === ORCHESTRATOR_NAME ||
      targetRaw.toLowerCase() === "coordinator"
        ? run.roleModels.orchestrator?.model?.trim() ||
          this.getEffectiveSettings().orchestratorModel?.trim() ||
          (this.hostContext?.model?.id
            ? this.hostContext.model.provider
              ? `${this.hostContext.model.provider}/${this.hostContext.model.id}`
              : this.hostContext.model.id
            : "")
        : existingMemberForFallback?.model?.trim() || "";

    const rawModelInput = options.model?.trim() || (options.thinkingLevel ? fallbackModelFromTarget : "");
    if (!rawModelInput) {
      throw new SwarmProtocolError("INVALID_INPUT", "Model identifier must be non-empty.");
    }
    const parsedModelInput = parseModelSpec(rawModelInput);
    const modelOverride = parsedModelInput.model || rawModelInput;
    const requestedThinking = options.thinkingLevel ?? parsedModelInput.thinkingLevel;

    // Switching orchestrator role model
    if (
      targetRaw.toLowerCase() === ORCHESTRATOR_NAME ||
      targetRaw.toLowerCase() === "coordinator"
    ) {
      if (!isOrchestratorOrHuman(callerRole)) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" cannot switch the orchestrator's model.`,
        );
      }
      const { previousModel, nextThinking, updated } = await this.withRoleModelsLock(async () => {
        const freshRun = await this.store.loadRun(run.id);
        const prev = freshRun.roleModels.orchestrator?.model;
        const thinking =
          requestedThinking ?? freshRun.roleModels.orchestrator?.thinkingLevel;
        const nextRoleModels: SwarmRoleModels = {
          ...freshRun.roleModels,
          orchestrator: {
            model: modelOverride,
            thinkingLevel: thinking,
          },
        };
        const upd = await this.store.updateRun(run.id, {
          roleModels: nextRoleModels,
          actor: callerName,
        });
        return { previousModel: prev, nextThinking: thinking, updated: upd };
      });

      await this.store.appendEvent({
        runId: run.id,
        type: "member_model_switched",
        actor: callerName,
        memberName: ORCHESTRATOR_NAME,
        summary: `Switched @${ORCHESTRATOR_NAME} model -> ${modelOverride}${nextThinking ? ` (${nextThinking})` : ""}${options.reason ? ` (${options.reason})` : ""}`,
        data: {
          previousModel,
          model: modelOverride,
          thinkingLevel: nextThinking,
          reason: options.reason,
        },
      });

      if (!options.silentBoardNotice) {
        const noticeMsg = await this.store.postBoardMessage(run.id, {
          from: callerName,
          fromRole: callerRole,
          channel: DEFAULT_CHANNEL,
          kind: "model_switch",
          text: `[model] ${ORCHESTRATOR_NAME} switched to ${modelOverride}${nextThinking ? ` (${nextThinking})` : ""}${options.reason ? ` — ${options.reason}` : ""}`,
          mentions: [],
          channelMentions: [],
        });
        this.recordBoardMessageInCache(noticeMsg);
        this.emitEngineEvent("board_posted", `Posted model switch #${noticeMsg.seq}`, {
          memberName: ORCHESTRATOR_NAME,
          seq: noticeMsg.seq,
        });
      }

      await this.refreshCache(updated);
      this.emitEngineEvent(
        "snapshot_changed",
        `Switched orchestrator model -> ${modelOverride}`,
      );
      return {
        targetName: ORCHESTRATOR_NAME,
        model: modelOverride,
        thinkingLevel: nextThinking,
      };
    }

    const member = existingMemberForFallback ?? this.findMember(run, targetRaw);
    if (!member) {
      throw new SwarmProtocolError(
        "MEMBER_NOT_FOUND",
        `Member "${targetRaw}" was not found in Swarm run "${run.id}".`,
        { targetName: targetRaw },
      );
    }

    // Permission boundary: workers/validators may switch ONLY themselves or helpers they added!
    if (callerRole === "worker" || callerRole === "validator") {
      if (member.name !== callerName && member.parentName !== callerName) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" may only switch models for itself or helpers it added, not "@${member.name}".`,
          { callerName, targetName: member.name },
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${callerRole}" cannot switch member models.`,
      );
    }

    if (member.state === "killed") {
      throw new SwarmProtocolError(
        "MEMBER_KILLED",
        `Member "@${member.name}" has been killed and cannot switch models.`,
        { memberName: member.name },
      );
    }
    const live = this.liveMembers.get(member.name);
    const liveState = live?.handle?.getState() ?? member.state;
    const isMemberWorking =
      member.state === "working" ||
      liveState === "working" ||
      Boolean(live?.turnActive) ||
      Boolean(live?.spawning) ||
      Boolean(live?.waking);
    const isWorkingSelfSwitch =
      (callerRole === "worker" || callerRole === "validator") &&
      member.name === callerName &&
      isMemberWorking;
    const isDeferredHumanSwitch =
      options.deferIfWorking === true &&
      isOrchestratorOrHuman(callerRole) &&
      isMemberWorking;

    // Deferred Model Switch: when a worker/validator switches itself while running,
    // or a human role-model update queues a turn-end switch via `deferIfWorking: true`,
    // validate the target model now and schedule the switch for turn end.
    if ((isWorkingSelfSwitch || isDeferredHumanSwitch) && live) {
      let validatedModel = modelOverride;
      let validatedThinking = requestedThinking;
      if (this.transport.resolveModel) {
        const resolved = await this.transport.resolveModel(
          modelOverride,
          requestedThinking,
          this.hostContext,
        );
        validatedModel = resolved.model;
        validatedThinking = resolved.thinkingLevel;
      }
      const latestAfterResolve = getOwnMember(this.cachedRun, member.name);
      const stillWorking =
        live.turnActive ||
        live.spawning ||
        live.waking ||
        live.handle?.getState() === "working" ||
        latestAfterResolve?.state === "working";
      if (stillWorking) {
        live.pendingSelfModelSwitch = {
          model: validatedModel,
          thinkingLevel: validatedThinking,
          reason: options.reason,
          callerName,
          callerRole,
          autoResume: options.autoResume ?? true,
          silentBoardNotice: options.silentBoardNotice,
          fromRolePropagation: options.fromRolePropagation,
        };
        return {
          targetName: member.name,
          model: validatedModel,
          thinkingLevel: validatedThinking,
          deferred: true,
        };
      }
    }

    const isParkedState = member.state === "waiting" || member.state === "stopped";
    if (
      !isParkedState ||
      liveState === "working" ||
      live?.spawning ||
      live?.waking ||
      live?.turnActive ||
      (!internal.holdSwitchingLock && live?.switchingModel)
    ) {
      throw new SwarmProtocolError(
        "MEMBER_NOT_WAITING",
        `Member "@${member.name}" is currently "${live?.switchingModel ? "switchingModel" : liveState}" (not waiting). Wait until it parks in waiting state before switching models.`,
        { memberName: member.name, state: live?.switchingModel ? "switchingModel" : liveState },
      );
    }

    // Ensure a LiveMember record exists if member is persisted `stopped` so lock & revive work cleanly
    let activeLive = live;
    if (!activeLive) {
      activeLive = {
        name: member.name,
        agentId: member.agentId,
        role: member.role,
        spawning: false,
        waking: false,
        turnActive: false,
        switchingModel: false,
        parkedMentionsOnly: true,
        pendingWakes: [],
        deliveredSeqs: new Set<number>(),
        triedModels: new Set<string>(member.model ? [member.model] : []),
        lastMessages: [],
        logTail: [...member.logTail],
        lastTool: member.lastTool,
        turnStartPostSeq: member.lastPostSeq ?? 0,
        lastSilentSummary: undefined,
        retryCount: 0,
        priorHandlesTokens: member.tokens,
        priorHandlesBreakdown: member.tokenBreakdown ? { ...member.tokenBreakdown } : undefined,
        priorHandlesCost: member.cost,
        liveLlmTurns: member.llmTurns ?? 0,
      };
      this.liveMembers.set(member.name, activeLive);
    }

    // Acquire synchronous switchingModel lock BEFORE any await so concurrent @mentions queue safely!
    const wasColdParkedBeforeSwitch =
      member.state === "stopped" || (member.state === "waiting" && !activeLive.handle);
    const acquiredLock = !internal.holdSwitchingLock;
    if (acquiredLock) {
      this.cancelMemberRetryTimer(activeLive);
      activeLive.switchingModel = true;
    }

    let switchSucceeded = false;
    let shouldAutoResume = false;
    let resumePromptText = "";
    try {
      let resolvedModel = modelOverride;
      let resolvedThinking = requestedThinking;

      if (activeLive.handle && activeLive.handle.getState() === "waiting") {
        const switched = await activeLive.handle.switchModel(modelOverride, requestedThinking);
        resolvedModel = switched.model;
        resolvedThinking = switched.thinkingLevel;
        activeLive.triedModels.add(resolvedModel);
      } else {
        if (this.transport.resolveModel) {
          const resolved = await this.transport.resolveModel(
            modelOverride,
            requestedThinking,
            this.hostContext,
          );
          resolvedModel = resolved.model;
          resolvedThinking = resolved.thinkingLevel;
        }
        activeLive.triedModels.add(resolvedModel);
      }

      const updatedRun = await this.store.updateMember(run.id, member.name, {
        model: resolvedModel,
        thinkingLevel: resolvedThinking ?? null,
        modelExplicit: options.fromRolePropagation ? false : true,
        error: null,
        actor: callerName,
      });

      await this.store.appendEvent({
        runId: run.id,
        type: "member_model_switched",
        actor: callerName,
        memberName: member.name,
        agentId: member.agentId,
        summary: `Switched @${member.name} model -> ${resolvedModel}${resolvedThinking ? ` (${resolvedThinking})` : ""}${options.reason ? ` (${options.reason})` : ""}`,
        data: {
          previousModel: member.model,
          model: resolvedModel,
          thinkingLevel: resolvedThinking,
          reason: options.reason,
        },
      });

      if (!options.silentBoardNotice) {
        // Post non-waking `[model]` notice on board (no `@` so it doesn't duplicate-wake)
        const noticeMsg = await this.store.postBoardMessage(run.id, {
          from: callerName,
          fromRole: callerRole,
          channel: member.channels[0] ?? DEFAULT_CHANNEL,
          kind: "model_switch",
          text: `[model] ${member.name} switched to ${resolvedModel}${resolvedThinking ? ` (${resolvedThinking})` : ""}${options.reason ? ` — ${options.reason}` : ""}`,
          mentions: [],
          channelMentions: [],
        });
        this.recordBoardMessageInCache(noticeMsg);
        this.emitEngineEvent("board_posted", `Posted model switch #${noticeMsg.seq}`, {
          memberName: member.name,
          seq: noticeMsg.seq,
        });
      }

      await this.refreshCache(updatedRun);
      this.emitEngineEvent(
        "snapshot_changed",
        `${activeLive.handle?.getState() === "waiting" ? "Hot-switched" : "Switched"} @${member.name} model -> ${resolvedModel}`,
        { memberName: member.name },
      );

      switchSucceeded = true;
      const latestMemberAfter = getOwnMember(this.cachedRun, member.name);
      const isWarmWaiting =
        latestMemberAfter?.state === "waiting" && activeLive.handle?.getState() === "waiting";
      const canReviveColdAfter =
        wasColdParkedBeforeSwitch &&
        !latestMemberAfter?.humanStopped &&
        (latestMemberAfter?.state === "stopped" ||
          (latestMemberAfter?.state === "waiting" && !activeLive.handle));
      shouldAutoResume =
        options.autoResume !== false &&
        !internal.holdSwitchingLock &&
        activeLive.switchingModel &&
        !this.disposed &&
        this.activeRunId === run.id &&
        this.cachedRun?.status === "active" &&
        (isWarmWaiting || canReviveColdAfter);
      if (shouldAutoResume) {
        const reasonNote = options.reason ? ` (${options.reason})` : "";
        resumePromptText = `Your model was ${isWarmWaiting ? "hot-switched" : "switched"} to "${resolvedModel}"${resolvedThinking ? ` (${resolvedThinking})` : ""}${reasonNote} with your conversation history preserved. Resume any unfinished work immediately, or post an update / call swarm_wait if already done.`;
      }

      return {
        targetName: member.name,
        model: resolvedModel,
        thinkingLevel: resolvedThinking,
        member: latestMemberAfter,
        ...(shouldAutoResume ? { resumed: true } : {}),
      };
    } finally {
      if (acquiredLock) {
        const stillLive = this.liveMembers.get(member.name) === activeLive;
        const lockStillHeld = activeLive.switchingModel;
        const currentMember = getOwnMember(this.cachedRun, member.name);
        const canAutoResumeWarm =
          currentMember?.state === "waiting" && activeLive.handle?.getState() === "waiting";
        const canAutoReviveCold =
          wasColdParkedBeforeSwitch &&
          !currentMember?.humanStopped &&
          (currentMember?.state === "stopped" ||
            (currentMember?.state === "waiting" && !activeLive.handle));

        if (
          stillLive &&
          lockStillHeld &&
          !this.disposed &&
          this.activeRunId === run.id &&
          this.cachedRun?.status === "active" &&
          switchSucceeded &&
          options.autoResume !== false &&
          (canAutoResumeWarm || canAutoReviveCold)
        ) {
          // Atomically hand off switchingModel -> waking so the switched member immediately resumes!
          activeLive.switchingModel = false;
          activeLive.waking = true;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          if (canAutoResumeWarm) {
            void this.drainMemberPendingWakes(run.id, member.name, resumePromptText);
          } else {
            void this.reviveMemberWithPendingWakes(run.id, member.name, resumePromptText);
          }
        } else if (
          stillLive &&
          lockStillHeld &&
          !this.disposed &&
          this.activeRunId === run.id &&
          this.cachedRun?.status === "active" &&
          (canAutoResumeWarm || canAutoReviveCold) &&
          activeLive.pendingWakes.length > 0
        ) {
          // Atomically hand off switchingModel -> waking to drain wakes queued during switch!
          activeLive.switchingModel = false;
          activeLive.waking = true;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          if (canAutoResumeWarm) {
            void this.drainMemberPendingWakes(run.id, member.name);
          } else {
            void this.reviveMemberWithPendingWakes(run.id, member.name);
          }
        } else {
          activeLive.switchingModel = false;
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
        }
      }
    }
  }

  /**
   * Droid `missionSettings`-style role propagation:
   * - Updates `run.roleModels` for the focused run.
   * - When setting a concrete model for `worker` or `validator` on an active/paused run,
   *   switches existing non-killed members that track the role default (silent on waiting/stopped,
   *   deferred until turn end on working). When cleared to Inherit (`model` empty), applies only to new agents.
   */
  async propagateRoleModel(
    options: PropagateRoleModelOptions,
  ): Promise<PropagateRoleModelResult> {
    if (options.hostContext) {
      this.hostContext = options.hostContext;
    }
    const run = this.cachedRun;
    const rawTrimmed = options.model?.trim() || undefined;
    const parsedOpt = rawTrimmed ? parseModelSpec(rawTrimmed) : undefined;
    const trimmedModel = parsedOpt?.model || rawTrimmed;
    const targetThinking = options.thinkingLevel ?? parsedOpt?.thinkingLevel;

    const prevModels = new Set<string>();
    const addPrev = (m: string | undefined): void => {
      const clean = m?.trim();
      if (!clean) return;
      const base = parseModelSpec(clean).model || clean;
      prevModels.add(base.toLowerCase());
    };
    addPrev(options.previousModel);
    const runPrevModel = run?.roleModels?.[options.role]?.model;
    addPrev(runPrevModel);
    if (!runPrevModel && !options.previousModel) {
      const hm = (options.hostContext ?? this.hostContext)?.model;
      if (hm?.id) {
        addPrev(hm.provider ? `${hm.provider}/${hm.id}` : hm.id);
        addPrev(hm.id);
      }
    }

    if (!run || this.activeRunId !== run.id) {
      return {
        roleModels: {
          [options.role]: {
            ...(trimmedModel ? { model: trimmedModel } : {}),
            ...(targetThinking !== undefined ? { thinkingLevel: targetThinking } : {}),
          },
        },
        switched: [],
        deferred: [],
      };
    }

    const updatedRun = await this.withRoleModelsLock(async () => {
      const freshRun = await this.store.loadRun(run.id);
      const nextRoleModels: SwarmRoleModels = {
        ...freshRun.roleModels,
        [options.role]: {
          ...(trimmedModel ? { model: trimmedModel } : {}),
          ...(targetThinking !== undefined ? { thinkingLevel: targetThinking } : {}),
        },
      };
      return this.store.updateRun(run.id, {
        roleModels: nextRoleModels,
        actor: ORCHESTRATOR_NAME,
      });
    });
    await this.refreshCache(updatedRun);
    this.emitEngineEvent(
      "snapshot_changed",
      `Updated ${options.role} role model configuration.`,
    );

    const switched: string[] = [];
    const deferred: string[] = [];

    const isClearToInherit =
      options.clearToInherit === true ||
      (!trimmedModel && targetThinking === undefined);
    if (isClearToInherit || (updatedRun.status !== "active" && updatedRun.status !== "paused")) {
      return {
        roleModels: updatedRun.roleModels,
        switched,
        deferred,
      };
    }

    const hostFallbackModel = (() => {
      const hm = (options.hostContext ?? this.hostContext)?.model;
      if (!hm?.id) return undefined;
      return hm.provider ? `${hm.provider}/${hm.id}` : hm.id;
    })();
    const targetLower = trimmedModel?.toLowerCase();

    for (const member of Object.values(updatedRun.members)) {
      if (member.state === "killed" || member.role !== options.role) {
        continue;
      }
      const memberModelLower = member.model?.trim().toLowerCase();
      const tracksDefault =
        member.modelExplicit === false
          ? true
          : member.modelExplicit === true
            ? false
            : !memberModelLower ||
              prevModels.has(memberModelLower) ||
              (targetLower !== undefined && memberModelLower === targetLower);
      if (!tracksDefault) {
        continue;
      }
      const effectiveTargetModel = trimmedModel ?? member.model ?? hostFallbackModel;
      if (!effectiveTargetModel) {
        continue;
      }
      if (
        member.model?.toLowerCase() === effectiveTargetModel.toLowerCase() &&
        member.thinkingLevel === targetThinking
      ) {
        continue;
      }
      try {
        const res = await this.switchModel({
          targetName: member.name,
          model: effectiveTargetModel,
          thinkingLevel: targetThinking,
          callerName: "human",
          callerRole: "human",
          autoResume: false,
          deferIfWorking: true,
          silentBoardNotice: true,
          fromRolePropagation: true,
          reason: `${options.role} role updated`,
          hostContext: options.hostContext,
        });
        if (res.deferred) {
          deferred.push(member.name);
        } else {
          switched.push(member.name);
        }
      } catch {
        // Best-effort per member; explicit per-member overrides can still be adjusted individually
      }
    }

    return {
      roleModels: this.cachedRun?.roleModels ?? updatedRun.roleModels,
      switched,
      deferred,
    };
  }

  async steerMember(
    memberName: string,
    message: string,
    mode: "steer" | "followUp" = "steer",
    options?: { callerName?: string; callerRole?: CallerRole },
  ): Promise<{ delivery: "steered" | "followUp" | "woken" }> {
    const run = this.requireActiveRun();
    if (run.status !== "active") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot steer members while Swarm run is ${run.status}.`,
      );
    }
    const member = this.findMember(run, memberName);
    if (!member) {
      throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
    }

    const callerRole: CallerRole = options?.callerRole ?? "orchestrator";
    const callerName =
      options?.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    if (callerRole === "worker" || callerRole === "validator") {
      if (member.parentName !== callerName) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" may only steer helpers it added, not "@${member.name}".`,
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError("PERMISSION_DENIED", `Role "${callerRole}" cannot steer members.`);
    }

    if (member.state === "killed") {
      throw new SwarmProtocolError("MEMBER_KILLED", `Member "@${member.name}" has been killed.`);
    }

    const trimmedMsg = message.trim();
    if (!trimmedMsg) {
      throw new SwarmProtocolError("INVALID_INPUT", "Steering message must be non-empty.");
    }

    const live = this.liveMembers.get(member.name);
    if (live) {
      this.cancelMemberRetryTimer(live);
    }
    const isLiveWorking = Boolean(live?.handle) && live!.handle!.getState() === "working";

    if (isLiveWorking && live?.handle) {
      this.lastStallAlertHead = null;
      if (mode === "followUp") {
        await live.handle.followUp(trimmedMsg);
        return { delivery: "followUp" };
      }
      await live.handle.steer(trimmedMsg);
      return { delivery: "steered" };
    }

    // Parked waiting or stopped -> wake/revive cleanly via board post targeting @<member>
    await this.postMessage({
      from: callerName,
      fromRole: callerRole,
      channel: member.channels[0] ?? DEFAULT_CHANNEL,
      kind: "decision",
      text: `@${member.name} [steer] ${trimmedMsg}`,
    });
    return { delivery: "woken" };
  }

  async stopMember(memberName: string, options?: StopMemberOptions): Promise<void> {
    const run = this.requireActiveRun();
    const member = this.findMember(run, memberName);
    if (!member) {
      throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
    }

    const callerRole: CallerRole = options?.callerRole ?? "orchestrator";
    const callerName =
      options?.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    if (callerRole === "worker" || callerRole === "validator") {
      if (member.name !== callerName && member.parentName !== callerName) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" may only stop itself or helpers it added, not "@${member.name}".`,
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError("PERMISSION_DENIED", `Role "${callerRole}" cannot stop members.`);
    }

    if (member.state === "killed") {
      throw new SwarmProtocolError("MEMBER_KILLED", `Member "@${member.name}" is already killed.`);
    }

    let capturedSessionFile = member.sessionFile;
    const live = this.liveMembers.get(member.name);
    if (live) {
      this.cancelMemberRetryTimer(live);
      live.launchAbort?.abort();
      live.attemptToken = undefined;
      live.spawning = false;
      live.waking = false;
      live.turnActive = false;
      live.switchingModel = false;
      live.pendingSelfModelSwitch = undefined;
      live.lastWaitRequest = undefined;
      live.lastSilentSummary = undefined;
      live.parkedMentionsOnly = true;
      live.currentActivity = undefined;
      live.turnStartedAt = undefined;
      live.pendingWakes.length = 0;
      if (live.handle) {
        const handle = live.handle;
        await handle.abort(options?.reason ?? "Stopped").catch(() => {});
        await Promise.race([
          handle.currentTurn.catch(() => {}),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 250);
            t.unref?.();
          }),
        ]);
        live.lastMessages = sanitizeForkSeedMessages(handle.getConversationMessages());
        capturedSessionFile = handle.getSessionFile?.() ?? capturedSessionFile;
        await handle.kill(options?.reason ?? "Stopped").catch(() => {});
        live.handle = undefined;
      }
      live.releaseSlot?.();
      live.releaseSlot = undefined;
    }

    const humanStopped = options?.humanStopped ?? callerRole === "human";
    const flushedBreakdown = maxTokenBreakdown(
      member.tokenBreakdown,
      live?.liveTokenBreakdown,
    );
    const flushedLlmTurns = Math.max(member.llmTurns ?? 0, live?.liveLlmTurns ?? 0);
    const updated = await this.store.updateMember(run.id, member.name, {
      state: "stopped",
      humanStopped,
      tokens: Math.max(member.tokens, live?.liveTokens ?? 0),
      cost: Math.max(member.cost, live?.liveCost ?? 0),
      ...(flushedBreakdown ? { tokenBreakdown: flushedBreakdown } : {}),
      logTail: live && live.logTail.length > 0 ? [...live.logTail] : member.logTail,
      ...(flushedLlmTurns > 0 ? { llmTurns: flushedLlmTurns } : {}),
      ...(live?.lastTool !== undefined ? { lastTool: live.lastTool } : {}),
      ...(capturedSessionFile ? { sessionFile: capturedSessionFile } : {}),
      currentActivity: null,
      turnStartedAt: null,
      parkedOn: options?.reason ?? (humanStopped ? "stopped by user" : "stopped"),
      actor: callerName,
    });
    await this.refreshCache(updated);
    this.emitEngineEvent("snapshot_changed", `Stopped @${member.name}`, {
      memberName: member.name,
    });
    this.checkAllIdleAndNotifyWaiters();
    this.maybeArmStallWatchdog();
  }

  async killMember(memberName: string, options?: KillMemberOptions): Promise<void> {
    const run = this.requireActiveRun();
    const member = this.findMember(run, memberName);
    if (!member) {
      throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
    }

    const callerRole: CallerRole = options?.callerRole ?? "orchestrator";
    const callerName =
      options?.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    // Permission boundary: workers/validators may ONLY kill helpers they added!
    if (callerRole === "worker" || callerRole === "validator") {
      if (member.parentName !== callerName) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Member "@${callerName}" may only kill helpers it added, not "@${member.name}".`,
          { callerName, targetName: member.name, parentName: member.parentName },
        );
      }
    } else if (!isOrchestratorOrHuman(callerRole)) {
      throw new SwarmProtocolError("PERMISSION_DENIED", `Role "${callerRole}" cannot kill members.`);
    }

    if (member.state === "killed") {
      return;
    }

    const hasOwnWorktree =
      (member.workspace === "share" || member.workspace === "branch") &&
      Boolean(member.cwd) &&
      member.cwd !== this.worktree.repoRoot;

    // Dirty worktree guard BEFORE killing / deleting worktree!
    if (hasOwnWorktree && !options?.force) {
      const dirty = await this.worktree.isWorktreeDirty(member.cwd).catch(() => false);
      if (dirty) {
        throw new SwarmProtocolError(
          "DIRTY_WORKTREE",
          `Refusing to delete dirty worktree for "@${member.name}" (${member.cwd}). Commit/merge its changes first or pass force=true.`,
          { memberName: member.name, worktreePath: member.cwd },
        );
      }
    }

    const live = this.liveMembers.get(member.name);
    if (live) {
      this.cancelMemberRetryTimer(live);
      live.launchAbort?.abort();
      live.attemptToken = undefined;
      live.spawning = false;
      live.waking = false;
      live.turnActive = false;
      live.switchingModel = false;
      live.pendingSelfModelSwitch = undefined;
      live.lastWaitRequest = undefined;
      live.lastSilentSummary = undefined;
      live.parkedMentionsOnly = true;
      live.currentActivity = undefined;
      live.pendingWakes.length = 0;
      if (live.handle) {
        await live.handle.kill(options?.reason ?? "Killed").catch(() => {});
      }
      live.releaseSlot?.();
      live.releaseSlot = undefined;
      this.liveMembers.delete(member.name);
    }

    if (hasOwnWorktree) {
      try {
        // Preserve committed unmerged branches from isolated `branch` clones in base repo before deleting clone dir!
        if (
          member.workspace === "branch" &&
          member.branch &&
          !member.mergedCommitSha &&
          this.worktree.fetchBranchFromClone
        ) {
          if (options?.force) {
            await this.worktree.fetchBranchFromClone(member.cwd, member.branch).catch(() => {});
          } else {
            await this.worktree.fetchBranchFromClone(member.cwd, member.branch);
          }
        }
        await this.worktree.removeWorktree(member.cwd, { force: Boolean(options?.force) });
      } catch (err) {
        if (member.state === "working" || member.state === "waiting") {
          const stoppedRun = await this.store
            .updateMember(run.id, member.name, {
              state: "stopped",
              currentActivity: null,
              parkedOn: "kill worktree cleanup failed",
              actor: callerName,
            })
            .catch(() => undefined);
          if (stoppedRun) {
            await this.refreshCache(stoppedRun);
            this.emitEngineEvent("snapshot_changed", `Stopped @${member.name} after kill cleanup error`, {
              memberName: member.name,
            });
          }
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        throw err;
      }
    }

    if (member.role === "validator") {
      await rm(this.getMemberScratchDir(run.id, member.name), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }

    const nowIso = new Date(this.nowFn()).toISOString();
    const flushedKillBreakdown = maxTokenBreakdown(
      member.tokenBreakdown,
      live?.liveTokenBreakdown,
    );
    const flushedKillLlmTurns = Math.max(member.llmTurns ?? 0, live?.liveLlmTurns ?? 0);
    const updated = await this.store.updateMember(run.id, member.name, {
      state: "killed",
      tokens: Math.max(member.tokens, live?.liveTokens ?? 0),
      cost: Math.max(member.cost, live?.liveCost ?? 0),
      ...(flushedKillBreakdown ? { tokenBreakdown: flushedKillBreakdown } : {}),
      logTail: live && live.logTail.length > 0 ? [...live.logTail] : member.logTail,
      ...(flushedKillLlmTurns > 0 ? { llmTurns: flushedKillLlmTurns } : {}),
      ...(live?.lastTool !== undefined ? { lastTool: live.lastTool } : {}),
      currentActivity: null,
      turnStartedAt: null,
      parkedOn: options?.reason ?? "killed",
      endedAt: nowIso,
      actor: callerName,
    });
    await this.refreshCache(updated);
    this.emitEngineEvent("snapshot_changed", `Killed @${member.name}`, {
      memberName: member.name,
    });
    this.checkAllIdleAndNotifyWaiters();
    this.maybeArmStallWatchdog();
  }

  async mergeMember(
    memberName: string,
    options?: MergeMemberOptions,
  ): Promise<MergeBranchResult | null> {
    if (!isOrchestratorOrHuman(options?.callerRole)) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${options?.callerRole}" is not allowed to merge worktrees. Only @${ORCHESTRATOR_NAME} can merge.`,
      );
    }
    const run = this.requireActiveRun();
    if (isReconRun(run)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot merge branches while Swarm run "${run.id}" is in read-only recon mode. Propose and confirm the execution plan via ${PROPOSE_SWARM_PLAN_TOOL} first.`,
        { runId: run.id, runMode: "recon" },
      );
    }
    const member = this.findMember(run, memberName);
    if (!member) {
      throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
    }

    if (member.workspace === "inherit" || !member.branch) {
      return null;
    }

    const live = this.liveMembers.get(member.name);
    const liveState = live?.handle?.getState() ?? member.state;
    if (
      member.state === "working" ||
      liveState === "working" ||
      live?.spawning ||
      live?.waking ||
      live?.turnActive ||
      live?.switchingModel
    ) {
      throw new SwarmProtocolError(
        "MEMBER_NOT_WAITING",
        `Cannot merge "@${member.name}" while it is still working. Wait until it parks in waiting state.`,
        { memberName: member.name },
      );
    }

    const completedFeatureIds: string[] = [];
    const touchedMilestones = new Set<string>();
    const newlyMergedIsolatedMilestones = new Set<string>();

    const mergeOutcome = await this.withRepoGitLock(async () => {
      const freshRun = this.requireActiveRun();
      const freshMember = this.findMember(freshRun, memberName);
      if (!freshMember) {
        throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${memberName}" not found.`);
      }
      if (freshMember.workspace === "inherit" || !freshMember.branch) {
        return null;
      }
      const freshLive = this.liveMembers.get(freshMember.name);
      const freshLiveState = freshLive?.handle?.getState() ?? freshMember.state;
      if (
        freshMember.state === "working" ||
        freshLiveState === "working" ||
        freshLive?.spawning ||
        freshLive?.waking ||
        freshLive?.turnActive ||
        freshLive?.switchingModel
      ) {
        throw new SwarmProtocolError(
          "MEMBER_NOT_WAITING",
          `Cannot merge "@${freshMember.name}" while it is still working. Wait until it parks in waiting state.`,
          { memberName: freshMember.name },
        );
      }

      // 1. Verify member worktree is clean (skip if already removed after kill — branch still exists!)
      if (
        freshMember.state !== "killed" &&
        freshMember.cwd &&
        freshMember.cwd !== this.worktree.repoRoot
      ) {
        const dirty = await this.worktree.isWorktreeDirty(freshMember.cwd);
        if (dirty) {
          throw new SwarmProtocolError(
            "DIRTY_WORKTREE",
            `Worktree for "@${freshMember.name}" (${freshMember.cwd}) has uncommitted changes. Ask @${freshMember.name} to commit cleanly before merging.`,
            { memberName: freshMember.name, worktreePath: freshMember.cwd },
          );
        }
      }

      // 2. Verify base checkout is clean and on run.baseBranch
      const baseCheck = await this.worktree.isBaseCleanOnBranch(freshRun.baseBranch);
      if (!baseCheck.ok) {
        if (baseCheck.currentBranch && baseCheck.currentBranch !== freshRun.baseBranch) {
          throw new SwarmProtocolError(
            "WRONG_BRANCH",
            baseCheck.reason ??
              `Base repository is on "${baseCheck.currentBranch}", expected "${freshRun.baseBranch}".`,
            { expected: freshRun.baseBranch, actual: baseCheck.currentBranch },
          );
        }
        throw new SwarmProtocolError(
          "DIRTY_BASE",
          baseCheck.reason ?? `Base branch "${freshRun.baseBranch}" has uncommitted changes.`,
          { baseBranch: freshRun.baseBranch },
        );
      }

      // 3. Auto-rebase onto baseBranch when enabled and worktree is live
      const settings = this.getEffectiveSettings();
      let skipSourceWorktree = false;
      if (
        settings.autoRebase &&
        freshMember.state !== "killed" &&
        freshMember.cwd &&
        freshMember.cwd !== this.worktree.repoRoot
      ) {
        const rebaseRes = await this.worktree.autoRebase(
          freshMember.cwd,
          freshRun.baseBranch,
        );
        if (rebaseRes.status === "missing_worktree") {
          skipSourceWorktree = true;
        } else if (rebaseRes.status === "conflict") {
          const conflictFiles = rebaseRes.conflictFiles ?? [];
          const fileList = conflictFiles.length > 0 ? conflictFiles.join(", ") : "";
          const baseMsg = rebaseRes.message
            ? rebaseRes.message.replace(/\.?\s*$/, ".") +
              (fileList && !conflictFiles.every((f) => rebaseRes.message!.includes(f))
                ? ` Conflicting files: ${fileList}.`
                : "")
            : `Rebase conflict while rebasing "${freshMember.branch}" onto "${freshRun.baseBranch}".${fileList ? ` Conflicting files: ${fileList}.` : ""}`;
          const recovery = ` Recovery: wake @${freshMember.name} via post_message to rebase onto "${freshRun.baseBranch}", resolve ${fileList || "the conflicts"} in "${freshMember.cwd}", and re-commit cleanly before retrying merge.`;
          throw new SwarmProtocolError(
            "REBASE_CONFLICT",
            `${baseMsg}${recovery}`,
            {
              memberName: freshMember.name,
              branch: freshMember.branch,
              worktreePath: freshMember.cwd,
              conflictFiles,
            },
          );
        } else if (rebaseRes.status === "skipped_dirty") {
          throw new SwarmProtocolError(
            "DIRTY_WORKTREE",
            rebaseRes.message ?? `Worktree for "@${freshMember.name}" is dirty.`,
            { memberName: freshMember.name },
          );
        }
      }

      // 4. Merge branch into baseBranch
      const mergeRes = await this.worktree.mergeBranch({
        baseBranch: freshRun.baseBranch,
        branch: freshMember.branch,
        commitMessage:
          options?.commitMessage ??
          `swarm(${freshMember.name}): merge ${freshMember.branch}`,
        noFf: options?.noFf ?? true,
        ...(skipSourceWorktree ? {} : { sourceWorktreePath: freshMember.cwd }),
      });

      const actor = options?.callerName ?? ORCHESTRATOR_NAME;
      if (mergeRes.strategy === "noop") {
        const noopSummary = `Merge noop for @${freshMember.name} (${freshMember.branch}): @${freshMember.name} had 0 commits ahead of ${freshRun.baseBranch}.`;
        await this.store.appendEvent({
          runId: freshRun.id,
          type: "member_merged",
          actor,
          memberName: freshMember.name,
          agentId: freshMember.agentId,
          summary: noopSummary,
          data: {
            strategy: "noop",
            commitsAhead: 0,
            baseBranch: freshRun.baseBranch,
            ...(freshMember.branch ? { branch: freshMember.branch } : {}),
          },
        });
        await this.refreshCache();
        this.emitEngineEvent("snapshot_changed", noopSummary, {
          memberName: freshMember.name,
        });
        return { noop: true as const, mergeRes };
      }

      let updated = await this.store.updateMember(freshRun.id, freshMember.name, {
        mergedCommitSha: mergeRes.mergedCommitSha,
        actor,
      });

      if (updated.features && updated.features.length > 0) {
        updated = await this.withMissionLock(async () => {
          const fresh = await this.store.loadRun(freshRun.id);
          if (!fresh.features || fresh.features.length === 0) {
            return fresh;
          }
          const nowIso = new Date(this.nowFn()).toISOString();
          const handoffs = fresh.handoffItems ?? [];
          let mutated = false;
          const nextFeatures = fresh.features.map((f) => {
            if (f.assignedMember !== freshMember.name) {
              return { ...f };
            }
            if (f.status === "in_progress") {
              const hasOpenLeftUndone = handoffs.some(
                (h) =>
                  h.resolution === "open" &&
                  h.type === "incomplete_work" &&
                  h.sourceFeatureId === f.id,
              );
              const nextStatus: FeatureStatus = hasOpenLeftUndone
                ? "in_progress"
                : "completed";
              if (nextStatus === "completed") {
                completedFeatureIds.push(f.id);
              }
              if (f.milestone) {
                touchedMilestones.add(f.milestone);
                if (!f.mergedCommitSha) {
                  newlyMergedIsolatedMilestones.add(f.milestone);
                }
              }
              mutated = true;
              return {
                ...f,
                status: nextStatus,
                mergedCommitSha: mergeRes.mergedCommitSha,
                updatedAt: nowIso,
              };
            }
            if (f.status === "completed" && !f.mergedCommitSha) {
              if (f.milestone) {
                touchedMilestones.add(f.milestone);
                newlyMergedIsolatedMilestones.add(f.milestone);
              }
              mutated = true;
              return {
                ...f,
                mergedCommitSha: mergeRes.mergedCommitSha,
                updatedAt: nowIso,
              };
            }
            return { ...f };
          });

          if (!mutated) {
            return fresh;
          }
          const ordered = orderMissionFeatures(nextFeatures);
          const syncedMilestones = syncMissionMilestones(
            fresh.milestones,
            ordered,
            fresh.assertions ?? [],
            nowIso,
            fresh.members,
          );
          const saved = await this.store.updateRun(freshRun.id, {
            features: ordered,
            milestones: syncedMilestones.milestones,
            actor,
          });
          await this.store.appendEvent({
            runId: freshRun.id,
            type: "mission_updated",
            actor,
            memberName: freshMember.name,
            summary:
              completedFeatureIds.length > 0
                ? `Merge @${freshMember.name} auto-completed feature(s): ${completedFeatureIds.join(", ")}`
                : `Merge @${freshMember.name} stamped mergedCommitSha on assigned feature(s)`,
            data: {
              mergedCommitSha: mergeRes.mergedCommitSha,
              completedFeatureIds,
              newlySealedMilestones: syncedMilestones.newlySealed,
            },
          });
          return saved;
        });
      }

      await this.refreshCache(updated);
      this.emitEngineEvent(
        "snapshot_changed",
        `Merged @${freshMember.name} (${freshMember.branch}) -> ${mergeRes.mergedCommitSha.slice(0, 12)}`,
        { memberName: freshMember.name },
      );
      return { noop: false as const, mergeRes, updated };
    });

    if (!mergeOutcome) {
      return null;
    }
    if (mergeOutcome.noop) {
      return mergeOutcome.mergeRes;
    }

    const { mergeRes } = mergeOutcome;
    const milestoneValidationCues = await this.maybeTriggerMilestoneValidation(
      run.id,
      touchedMilestones,
      { postMergeCheckMilestones: newlyMergedIsolatedMilestones },
    );

    if (completedFeatureIds.length === 0 && milestoneValidationCues.length === 0) {
      return mergeRes;
    }

    return {
      ...mergeRes,
      ...(completedFeatureIds.length > 0 ? { completedFeatureIds } : {}),
      ...(milestoneValidationCues.length > 0 ? { milestoneValidationCues } : {}),
    } as MergeBranchResult;
  }

  private computeNotifiedValidatorHandles(
    run: SwarmRunState,
    msg: BoardMessage,
  ): Set<string> {
    const notified = new Set<string>();
    const senderLower = msg.from.toLowerCase();
    const mentionsLower = new Set(msg.mentions.map((m) => m.toLowerCase()));
    const chMentionsLower = new Set(msg.channelMentions.map((c) => c.toLowerCase()));

    for (const member of Object.values(run.members)) {
      if (
        member.role !== "validator" ||
        member.workspace !== "inherit" ||
        member.recon ||
        member.state === "killed" ||
        member.humanStopped ||
        member.name.toLowerCase() === senderLower
      ) {
        continue;
      }
      const lowerName = member.name.toLowerCase();
      if (
        mentionsLower.has(ALL_MENTION_NAME) ||
        mentionsLower.has(lowerName) ||
        (member.groupPrefix && mentionsLower.has(member.groupPrefix.toLowerCase()))
      ) {
        notified.add(lowerName);
        continue;
      }
      let matchedChannel = false;
      for (const ch of chMentionsLower) {
        const chRecord = getOwnChannel(run, ch);
        if (!chRecord || chRecord.archived) continue;
        if (member.channels.includes(ch) || chRecord.subscribers.includes(member.name)) {
          matchedChannel = true;
          break;
        }
      }
      if (matchedChannel) {
        notified.add(lowerName);
        continue;
      }
      if (member.state === "waiting") {
        const live = this.liveMembers.get(member.name);
        if (
          live &&
          live.parkedMentionsOnly === false &&
          (msg.channel === DEFAULT_CHANNEL || member.channels.includes(msg.channel))
        ) {
          notified.add(lowerName);
        }
      }
    }
    return notified;
  }

  private async maybeTriggerMilestoneValidation(
    runId: string,
    touchedMilestones: ReadonlySet<string>,
    options?: {
      postMergeCheckMilestones?: ReadonlySet<string>;
      alreadyNotifiedHandles?: ReadonlySet<string>;
    },
  ): Promise<
    Array<{
      milestone: string;
      assertionIds: string[];
      validatorWoken?: string;
      validatorSpawned?: string;
      boardSeq?: number;
      needsValidatorSpawn?: boolean;
    }>
  > {
    const milestoneValidationCues: Array<{
      milestone: string;
      assertionIds: string[];
      validatorWoken?: string;
      validatorSpawned?: string;
      boardSeq?: number;
      needsValidatorSpawn?: boolean;
    }> = [];

    if (
      touchedMilestones.size === 0 ||
      this.disposed ||
      this.runDonePosted ||
      this.activeRunId !== runId
    ) {
      return milestoneValidationCues;
    }

    const initialRun = this.cachedRun ?? (await this.store.loadRun(runId));
    if (!initialRun.validatorEnabled) {
      return milestoneValidationCues;
    }

    for (const milestoneLabel of touchedMilestones) {
      const currentRunForVal = this.cachedRun ?? initialRun;
      if (!currentRunForVal.validatorEnabled) break;

      const mFeatures = (currentRunForVal.features ?? []).filter(
        (f) => f.milestone === milestoneLabel && f.status !== "cancelled",
      );
      if (mFeatures.length === 0) continue;

      const allCompletedAndMerged = mFeatures.every((f) => {
        if (f.status !== "completed") return false;
        if (!f.assignedMember) return true;
        const assigned = getOwnMember(currentRunForVal, f.assignedMember);
        if (!assigned || !isIsolatedWorktreeWorkspace(assigned.workspace)) {
          return true;
        }
        return Boolean(f.mergedCommitSha || assigned.mergedCommitSha);
      });
      if (!allCompletedAndMerged) continue;

      const claimedValIds = Array.from(
        new Set(mFeatures.flatMap((f) => f.fulfills)),
      );
      const candidateAssertions =
        claimedValIds.length > 0
          ? (currentRunForVal.assertions ?? []).filter((a) => claimedValIds.includes(a.id))
          : (currentRunForVal.milestones?.length ?? 0) <= 1
            ? (currentRunForVal.assertions ?? [])
            : [];
      const alreadyPassed = candidateAssertions.filter(
        (a) => a.status === "passed",
      );
      const pendingOrFailed = candidateAssertions.filter(
        (a) => a.status === "pending" || a.status === "failed",
      );
      const preMergePassed =
        pendingOrFailed.length === 0 &&
        options?.postMergeCheckMilestones?.has(milestoneLabel)
          ? alreadyPassed.filter((a) => !a.overridden)
          : [];
      if (pendingOrFailed.length === 0 && preMergePassed.length === 0) {
        continue;
      }

      const isPostMergeIntegrationCheck =
        pendingOrFailed.length === 0 && preMergePassed.length > 0;
      const dualLayerBrief = buildMilestoneValidationBrief(
        currentRunForVal,
        milestoneLabel,
        mFeatures,
        pendingOrFailed,
        isPostMergeIntegrationCheck ? preMergePassed : alreadyPassed,
        { postMergeIntegrationCheck: isPostMergeIntegrationCheck },
      );
      const assertionIds = isPostMergeIntegrationCheck
        ? preMergePassed.map((a) => a.id)
        : pendingOrFailed.map((a) => a.id);

      const orderedValidators = currentRunForVal.memberOrder
        .map((n) => getOwnMember(currentRunForVal, n))
        .filter(
          (m): m is SwarmMemberRecord =>
            Boolean(
              m &&
                m.role === "validator" &&
                m.workspace === "inherit" &&
                !m.recon &&
                m.state !== "killed" &&
                !m.humanStopped,
            ),
        );

      if (
        !isPostMergeIntegrationCheck &&
        options?.alreadyNotifiedHandles &&
        options.alreadyNotifiedHandles.size > 0 &&
        orderedValidators.some((v) =>
          options.alreadyNotifiedHandles!.has(v.name.toLowerCase()),
        )
      ) {
        continue;
      }

      const parkableValidator = orderedValidators.find((m) => {
        if (m.state !== "waiting" && m.state !== "stopped") {
          return false;
        }
        const vLive = this.liveMembers.get(m.name);
        return (
          !vLive?.spawning &&
          !vLive?.waking &&
          !vLive?.turnActive &&
          !vLive?.switchingModel &&
          vLive?.handle?.getState() !== "working"
        );
      });
      const targetExistingValidator = parkableValidator ?? orderedValidators[0];

      if (targetExistingValidator) {
        const cuePost = await this.postMessage({
          from: ORCHESTRATOR_NAME,
          fromRole: "orchestrator",
          channel: targetExistingValidator.channels[0] ?? DEFAULT_CHANNEL,
          kind: "review",
          text: `@${targetExistingValidator.name} ${dualLayerBrief}`,
        });
        milestoneValidationCues.push({
          milestone: milestoneLabel,
          assertionIds,
          validatorWoken: targetExistingValidator.name,
          boardSeq: cuePost.seq,
        });
      } else if (
        !this.disposed &&
        !this.runDonePosted &&
        currentRunForVal.status === "active"
      ) {
        const validatorName = uniqueValidatorHandle(
          currentRunForVal,
          this.liveMembers.keys(),
        );
        const spawnedValidators = await this.addMembers({
          name: validatorName,
          role: "validator",
          workspace: "inherit",
          brief: dualLayerBrief,
          callerName: ORCHESTRATOR_NAME,
          callerRole: "orchestrator",
          hostContext: this.hostContext,
        });
        const spawnedVal = spawnedValidators[0]!;
        milestoneValidationCues.push({
          milestone: milestoneLabel,
          assertionIds,
          validatorSpawned: spawnedVal.name,
          ...(spawnedVal.briefSeq !== undefined
            ? { boardSeq: spawnedVal.briefSeq }
            : {}),
        });
      } else {
        milestoneValidationCues.push({
          milestone: milestoneLabel,
          assertionIds,
          needsValidatorSpawn: true,
        });
      }
    }

    return milestoneValidationCues;
  }

  // --------------------------------------------------------------------------
  // Channels
  // --------------------------------------------------------------------------

  async manageChannel(input: ManageChannelInput): Promise<ManageChannelResult> {
    const run = this.requireActiveRun();
    const callerRole: CallerRole = input.callerRole ?? "orchestrator";
    const callerName =
      input.callerName?.trim() ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    switch (input.action) {
      case "list": {
        const channels = Object.values(run.channels);
        const lines = channels.map(
          (c) =>
            `#${c.name}${c.archived ? " [archived]" : ""} (${c.subscribers.length} subscribers)${c.topic ? ` — ${c.topic}` : ""}`,
        );
        return {
          action: "list",
          channels,
          summary:
            channels.length > 0
              ? `Channels (${channels.length}):\n${lines.join("\n")}`
              : "No channels.",
        };
      }

      case "create": {
        if (!isOrchestratorOrHuman(callerRole)) {
          throw new SwarmProtocolError(
            "PERMISSION_DENIED",
            `Role "${callerRole}" cannot create channels. Ask @${ORCHESTRATOR_NAME}.`,
          );
        }
        const name = validateChannelName(input.name ?? "");
        if (name === DEFAULT_CHANNEL) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            'Channel "#main" already exists by default.',
          );
        }
        if (run.channels && Object.hasOwn(run.channels, name)) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            `Channel "#${name}" already exists.`,
            { channel: name },
          );
        }
        const created = await this.store.createChannel(run.id, {
          name,
          topic: input.topic?.trim() || undefined,
          createdBy: callerName,
        });
        await this.refreshCache();
        this.emitEngineEvent("snapshot_changed", `Created channel #${created.name}`);
        return {
          action: "create",
          channel: created,
          summary: `Created channel #${created.name}${created.topic ? ` — ${created.topic}` : ""}.`,
        };
      }

      case "archive": {
        if (!isOrchestratorOrHuman(callerRole)) {
          throw new SwarmProtocolError(
            "PERMISSION_DENIED",
            `Role "${callerRole}" cannot archive channels. Ask @${ORCHESTRATOR_NAME}.`,
          );
        }
        const name = validateChannelName(input.name ?? "");
        if (name === DEFAULT_CHANNEL) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            'Default channel "#main" cannot be archived.',
          );
        }
        if (!getOwnChannel(run, name)) {
          throw new SwarmProtocolError("INVALID_CHANNEL", `Channel "#${name}" does not exist.`);
        }
        const archived = await this.store.archiveChannel(run.id, name, callerName);
        await this.refreshCache();
        this.emitEngineEvent("snapshot_changed", `Archived channel #${archived.name}`);
        return {
          action: "archive",
          channel: archived,
          summary: `Archived channel #${archived.name}.`,
        };
      }

      case "join":
      case "leave": {
        const name = validateChannelName(input.name ?? "");
        const channelRecord = getOwnChannel(run, name);
        if (!channelRecord) {
          throw new SwarmProtocolError("INVALID_CHANNEL", `Channel "#${name}" does not exist.`);
        }
        if (input.action === "join" && channelRecord.archived) {
          throw new SwarmProtocolError(
            "CHANNEL_ARCHIVED",
            `Channel "#${name}" is archived and cannot be joined.`,
          );
        }
        if (input.action === "leave" && name === DEFAULT_CHANNEL) {
          throw new SwarmProtocolError(
            "INVALID_CHANNEL",
            'Members cannot leave default channel "#main".',
          );
        }

        const targetName =
          input.member?.trim().replace(/^@/, "") ||
          (callerRole === "worker" || callerRole === "validator" ? callerName : "");
        if (!targetName) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            `Member name is required for channel "${input.action}".`,
          );
        }
        const member = this.findMember(run, targetName);
        if (!member) {
          throw new SwarmProtocolError("MEMBER_NOT_FOUND", `Member "${targetName}" not found.`);
        }
        if (member.state === "killed") {
          throw new SwarmProtocolError("MEMBER_KILLED", `Member "@${member.name}" is killed.`);
        }

        if (callerRole === "worker" || callerRole === "validator") {
          if (member.name !== callerName && member.parentName !== callerName) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Member "@${callerName}" may only change channel membership for itself or its helpers, not "@${member.name}".`,
            );
          }
        } else if (!isOrchestratorOrHuman(callerRole)) {
          throw new SwarmProtocolError(
            "PERMISSION_DENIED",
            `Role "${callerRole}" cannot modify channel subscriptions.`,
          );
        }

        const updatedChannel =
          input.action === "join"
            ? await this.store.subscribeChannel(run.id, name, member.name)
            : await this.store.unsubscribeChannel(run.id, name, member.name);
        await this.refreshCache();
        this.emitEngineEvent(
          "snapshot_changed",
          `${member.name} ${input.action === "join" ? "joined" : "left"} #${name}`,
          { memberName: member.name },
        );
        return {
          action: input.action,
          channel: updatedChannel,
          summary: `@${member.name} ${input.action === "join" ? "joined" : "left"} #${name}.`,
        };
      }

      default:
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Unsupported channel action: ${String(input.action)}`,
        );
    }
  }

  // --------------------------------------------------------------------------
  // Dynamic Mission Goal Engine (manageMission & unmerged commit check)
  // --------------------------------------------------------------------------

  async getUnmergedMembersWithCommits(): Promise<
    Array<{ member: SwarmMemberRecord; commitsAhead: number }>
  > {
    const run = this.cachedRun;
    if (!run || !this.activeRunId) {
      return [];
    }
    const ordered =
      run.memberOrder.length > 0
        ? run.memberOrder
            .map((n) => getOwnMember(run, n))
            .filter((m): m is SwarmMemberRecord => Boolean(m))
        : Object.values(run.members);

    const results: Array<{ member: SwarmMemberRecord; commitsAhead: number }> = [];
    for (const m of ordered) {
      if (
        m.state === "killed" ||
        !isIsolatedWorktreeWorkspace(m.workspace) ||
        m.mergedCommitSha ||
        !m.branch
      ) {
        continue;
      }
      let commitsAhead = await this.worktree
        .getCommitCountAhead(run.baseBranch, m.branch)
        .catch(() => 0);
      if (
        commitsAhead === 0 &&
        m.workspace === "branch" &&
        m.cwd &&
        existsSync(m.cwd)
      ) {
        commitsAhead = await this.worktree
          .getCommitCountAhead(run.baseBranch, m.branch, m.cwd)
          .catch(() => 0);
      }
      if (commitsAhead > 0) {
        results.push({ member: m, commitsAhead });
      }
    }
    return results;
  }

  async manageMission(input: ManageMissionInput): Promise<ManageMissionResult> {
    const run = this.requireActiveRun();
    const op = input.op;
    if (!op || !VALID_MISSION_OPS_SET.has(op)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Unsupported mission op "${String(op)}". Expected one of: ${SWARM_MISSION_OPS.join(", ")}.`,
      );
    }

    const callerRole: CallerRole = input.callerRole ?? "orchestrator";
    const callerName =
      input.callerName?.trim().replace(/^@/, "") ||
      (callerRole === "human" ? "human" : ORCHESTRATOR_NAME);

    if (
      input.force === true &&
      input.callerRole !== undefined &&
      input.callerRole !== "human"
    ) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Role "${input.callerRole}" (@${callerName}) cannot pass force:true on manageMission("${op}"). Only human callers may force-override mission guards.`,
        { op, callerRole: input.callerRole },
      );
    }

    if (op === "status") {
      const latest = await this.store.loadRun(run.id);
      await this.refreshCache(latest);
      const libraryTopics = await this.listMissionLibraryTopics(latest.id);
      return {
        op: "status",
        assertions: latest.assertions ? [...latest.assertions] : [],
        features: latest.features ? [...latest.features] : [],
        handoffItems: latest.handoffItems ? [...latest.handoffItems] : [],
        milestones: latest.milestones ? [...latest.milestones] : [],
        commands: latest.commands ? [...latest.commands] : [],
        services: latest.services ? [...latest.services] : [],
        boundaries: latest.boundaries ? [...latest.boundaries] : [],
        libraryTopics,
        ...(latest.lastAudit ? { lastAudit: { ...latest.lastAudit } } : {}),
        summary: formatMissionStatusSummary(latest),
      };
    }

    if (op === "read_library") {
      if (callerRole === "monitor") {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Role "${callerRole}" cannot read Mission library topics.`,
        );
      }
      const rawTopic = input.libraryTopic?.trim() ?? "";
      if (rawTopic) {
        const safeTopic = normalizeLibraryTopicName(rawTopic);
        const content = await this.readMissionLibraryTopic(run.id, safeTopic);
        if (content === null) {
          const topics = await this.listMissionLibraryTopics(run.id);
          return {
            op: "read_library",
            libraryTopic: safeTopic,
            libraryContent: "",
            libraryTopics: topics,
            summary: `Shared library topic "${safeTopic}" does not exist yet in .pi/swarm/runs/${run.id}/library/${topics.length > 0 ? ` (available: ${topics.map((t) => `${t}.md`).join(", ")})` : ""}.`,
          };
        }
        return {
          op: "read_library",
          libraryTopic: safeTopic,
          libraryContent: content,
          summary: `# Shared Library (${safeTopic}.md)\nPath: .pi/swarm/runs/${run.id}/library/${safeTopic}.md\n\n${content}`,
        };
      }
      const topics = await this.listMissionLibraryTopics(run.id);
      return {
        op: "read_library",
        libraryTopics: topics,
        summary:
          topics.length > 0
            ? `Shared Library topics in .pi/swarm/runs/${run.id}/library/ (${topics.length}): ${topics.map((t) => `${t}.md`).join(", ")}.`
            : `Shared Library in .pi/swarm/runs/${run.id}/library/ has no topics yet.`,
      };
    }

    if (this.runDonePosted || run.status === "completed" || run.status === "abandoned") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot mutate Mission state on a ${this.runDonePosted ? "completing" : run.status} Swarm run.`,
      );
    }

    if (isReconRun(run) && op !== "write_library") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Mission operation "${op}" is blocked while Swarm run "${run.id}" is in read-only recon mode (only "status", "read_library", and "write_library" are allowed during recon). Propose and confirm the execution plan via ${PROPOSE_SWARM_PLAN_TOOL} first.`,
        { runId: run.id, runMode: "recon", op },
      );
    }

    if (op === "dispatch_ready") {
      if (!isOrchestratorOrHuman(callerRole)) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Role "${callerRole}" (@${callerName}) cannot dispatch Mission features. Only @${ORCHESTRATOR_NAME} or human may run mission_op="dispatch_ready".`,
        );
      }
      if (
        input.maxDispatch !== undefined &&
        (!Number.isInteger(input.maxDispatch) || input.maxDispatch < 1)
      ) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Invalid max_dispatch=${String(input.maxDispatch)}; expected positive integer.`,
        );
      }
      if (
        input.workspace !== undefined &&
        input.workspace !== "inherit" &&
        input.workspace !== "share" &&
        input.workspace !== "branch"
      ) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Invalid workspace="${String(input.workspace)}" for dispatch_ready; expected "inherit", "share", or "branch".`,
        );
      }
      const dispatchWorkspace: SwarmWorkspaceMode = input.workspace ?? "inherit";
      if (input.hostContext) {
        this.hostContext = input.hostContext;
      }

      interface PlannedDispatch {
        feature: MissionFeature;
        handleName: string;
        brief: string;
      }

      const reservation = await this.withMissionLock(async () => {
        const state = await this.store.loadRun(run.id);
        if (state.status === "completed" || state.status === "abandoned") {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            `Cannot dispatch Mission features on a ${state.status} Swarm run.`,
          );
        }
        const features = (state.features ?? []).map((f) => ({ ...f }));
        const workingCount = this.getSnapshot().workingMemberNames.length;
        const rawSlots = state.maxConcurrency - workingCount;
        const availableConcurrencySlots =
          workingCount === 0 ? Math.max(1, rawSlots) : Math.max(0, rawSlots);
        const dispatchCap = Math.min(
          input.maxDispatch ?? Number.POSITIVE_INFINITY,
          availableConcurrencySlots,
        );

        const orderedMilestoneLabels: string[] = [];
        const seenMs = new Set<string>();
        for (const m of state.milestones ?? []) {
          const lbl = m.label.trim();
          if (lbl && !seenMs.has(lbl)) {
            seenMs.add(lbl);
            orderedMilestoneLabels.push(lbl);
          }
        }
        for (const f of features) {
          const lbl = f.milestone.trim();
          if (lbl && !seenMs.has(lbl)) {
            seenMs.add(lbl);
            orderedMilestoneLabels.push(lbl);
          }
        }
        const activeMilestoneLabel = orderedMilestoneLabels.find((lbl) =>
          features.some(
            (f) =>
              f.milestone.trim() === lbl &&
              (f.status === "pending" ||
                f.status === "in_progress" ||
                f.status === "failed"),
          ),
        );

        const featureById = new Map(features.map((f) => [f.id, f]));
        const activeCollisionFeatures = features.filter((f) => {
          if (f.status === "in_progress") return true;
          if (f.status === "failed" && f.assignedMember && !f.mergedCommitSha) {
            const assigned = getOwnMember(state, f.assignedMember);
            if (assigned && assigned.state !== "killed") {
              return true;
            }
          }
          return false;
        });
        const liveValidatorHandle = state.validatorEnabled
          ? state.memberOrder
              .map((n) => getOwnMember(state, n))
              .find(
                (m): m is SwarmMemberRecord =>
                  Boolean(
                    m &&
                      m.role === "validator" &&
                      m.workspace === "inherit" &&
                      !m.recon &&
                      m.state !== "killed" &&
                      !m.humanStopped,
                  ),
              )?.name
          : undefined;
        const planned: PlannedDispatch[] = [];
        const reservedHandles = new Set<string>();

        for (const feat of features) {
          if (planned.length >= dispatchCap) {
            break;
          }
          if (feat.status !== "pending") {
            continue;
          }
          if (
            activeMilestoneLabel &&
            feat.milestone.trim() !== activeMilestoneLabel
          ) {
            continue;
          }
          const depsSatisfied = (feat.dependsOn ?? []).every((depId) => {
            const dep = featureById.get(depId);
            return Boolean(
              dep && (dep.status === "completed" || dep.status === "cancelled"),
            );
          });
          if (!depsSatisfied) {
            continue;
          }
          const featOwned = effectiveDispatchOwnedPaths(feat);
          const collidesWithActive = activeCollisionFeatures.some((active) =>
            ownedPathsOverlap(featOwned, effectiveDispatchOwnedPaths(active)),
          );
          if (collidesWithActive) {
            continue;
          }
          const collidesWithBatch = planned.some((earlier) =>
            ownedPathsOverlap(
              featOwned,
              effectiveDispatchOwnedPaths(earlier.feature),
            ),
          );
          if (collidesWithBatch) {
            continue;
          }

          const handleName = uniqueHandleFromFeatureId(
            feat.id,
            state,
            this.liveMembers.keys(),
            reservedHandles,
          );
          const brief = buildFeatureWorkerBrief(
            state,
            feat,
            dispatchWorkspace,
            liveValidatorHandle,
          );
          planned.push({ feature: feat, handleName, brief });
        }

        if (planned.length === 0) {
          return {
            planned,
            state,
            workingCount,
            availableConcurrencySlots,
          };
        }

        const nowIso = new Date(this.nowFn()).toISOString();
        const plannedById = new Map(planned.map((p) => [p.feature.id, p]));
        const nextFeatures = features.map((f) => {
          const item = plannedById.get(f.id);
          if (!item) return f;
          return {
            ...f,
            status: "in_progress" as FeatureStatus,
            assignedMember: item.handleName,
            updatedAt: nowIso,
          };
        });
        const ordered = orderMissionFeatures(nextFeatures);
        const milestoneSync = syncMissionMilestones(
          state.milestones,
          ordered,
          state.assertions ?? [],
          nowIso,
          state.members,
        );
        const saved = await this.store.updateRun(run.id, {
          features: ordered,
          milestones: milestoneSync.milestones,
          actor: callerName,
        });
        await this.refreshCache(saved);
        return {
          planned,
          state: saved,
          workingCount,
          availableConcurrencySlots,
        };
      });

      if (reservation.planned.length === 0) {
        const pendingCount = (reservation.state.features ?? []).filter(
          (f) => f.status === "pending",
        ).length;
        const summary =
          pendingCount === 0
            ? "No pending features remaining in Mission queue."
            : reservation.availableConcurrencySlots <= 0
              ? `No concurrency slots currently available (${reservation.workingCount}/${reservation.state.maxConcurrency} working); call swarm_wait for active workers to finish.`
              : `0 of ${pendingCount} pending feature(s) are ready right now (blocked on earlier milestone completion, upstream dependsOn, or overlapping filesOwned with active features).`;
        return {
          op: "dispatch_ready",
          dispatchedFeatures: [],
          spawnedMembers: [],
          features: reservation.state.features ?? [],
          milestones: reservation.state.milestones ?? [],
          summary,
        };
      }

      const dispatchedFeatures: string[] = [];
      const spawnedMembers: string[] = [];
      const spawnedFeatureSet = new Set<string>();
      let partialSpawnWarning: string | undefined;

      try {
        for (const item of reservation.planned) {
          const added = await this.addMembers({
            name: item.handleName,
            role: "worker",
            workspace: dispatchWorkspace,
            brief: item.brief,
            callerName,
            callerRole,
            hostContext: input.hostContext ?? this.hostContext,
          });
          const spawned = added[0]!;
          spawnedFeatureSet.add(item.feature.id);
          dispatchedFeatures.push(item.feature.id);
          spawnedMembers.push(spawned.name);
        }
      } catch (err) {
        const unspawnedIds = new Set(
          reservation.planned
            .map((p) => p.feature.id)
            .filter((id) => !spawnedFeatureSet.has(id)),
        );
        if (unspawnedIds.size > 0) {
          await this.withMissionLock(async () => {
            const cur = await this.store.loadRun(run.id);
            const nowIso = new Date(this.nowFn()).toISOString();
            const revertedFeatures = (cur.features ?? []).map((f) => {
              if (!unspawnedIds.has(f.id)) return { ...f };
              const copy: MissionFeature = {
                ...f,
                status: "pending",
                updatedAt: nowIso,
              };
              delete copy.assignedMember;
              return copy;
            });
            const ordered = orderMissionFeatures(revertedFeatures);
            const ms = syncMissionMilestones(
              cur.milestones,
              ordered,
              cur.assertions ?? [],
              nowIso,
              cur.members,
            );
            const revertedRun = await this.store.updateRun(run.id, {
              features: ordered,
              milestones: ms.milestones,
              actor: callerName,
            });
            await this.refreshCache(revertedRun);
          }).catch(() => {});
        }
        if (spawnedMembers.length === 0) {
          throw err;
        }
        const errText = err instanceof Error ? err.message : String(err);
        partialSpawnWarning = `⚠ Partial dispatch warning: spawn stopped after ${spawnedMembers.length} worker(s) (${errText}); reverted ${unspawnedIds.size} unspawned feature(s) to "pending".`;
      }

      return this.withMissionLock(async () => {
        const finalState = await this.store.loadRun(run.id);
        const succeededPlanned = reservation.planned.filter((p) =>
          spawnedFeatureSet.has(p.feature.id),
        );
        const pairSummary = succeededPlanned
          .map((p, idx) => `${p.feature.id} -> @${spawnedMembers[idx] ?? p.handleName}`)
          .join(", ");
        const wsSummary =
          dispatchWorkspace === "inherit"
            ? "in shared inherit workspace (zero Git worktrees)"
            : `to fresh isolated ${dispatchWorkspace} worktrees`;
        const baseSummary = `Dispatched ${dispatchedFeatures.length} ready feature(s) ${wsSummary}: ${pairSummary}.`;
        const summary = partialSpawnWarning
          ? `${baseSummary}\n${partialSpawnWarning}`
          : baseSummary;
        await this.store.appendEvent({
          runId: run.id,
          type: "mission_updated",
          actor: callerName,
          summary,
          data: {
            op: "dispatch_ready",
            workspace: dispatchWorkspace,
            dispatchedFeatures,
            spawnedMembers,
            ...(partialSpawnWarning ? { partialSpawnWarning } : {}),
          },
        });
        await this.refreshCache(finalState);
        this.emitEngineEvent("snapshot_changed", summary);
        return {
          op: "dispatch_ready",
          dispatchedFeatures,
          spawnedMembers,
          features: finalState.features ?? [],
          milestones: finalState.milestones ?? [],
          summary,
        };
      });
    }

    return this.withMissionLock(async () => {
      const state = await this.store.loadRun(run.id);
      if (state.status === "completed" || state.status === "abandoned") {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Cannot mutate Mission state on a ${state.status} Swarm run.`,
        );
      }
      const nowIso = new Date(this.nowFn()).toISOString();

      switch (op) {
        case "upsert_assertions": {
          if (!isOrchestratorOrHuman(callerRole)) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" (@${callerName}) cannot upsert VAL-* assertions. Only @${ORCHESTRATOR_NAME} or human may modify the Validation Contract.`,
            );
          }
          if (!Array.isArray(input.assertions) || input.assertions.length === 0) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'Non-empty "assertions" array is required for mission_op="upsert_assertions".',
            );
          }

          const nextAssertions: MissionAssertion[] = (state.assertions ?? []).map((a) => ({
            ...a,
          }));
          const indexById = new Map<string, number>();
          nextAssertions.forEach((a, idx) => indexById.set(a.id, idx));

          let addedCount = 0;
          let updatedCount = 0;
          const resetToPendingIds: string[] = [];
          const seenBatchIds = new Set<string>();

          for (const raw of input.assertions) {
            if (!raw || typeof raw !== "object") {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                "Each assertion in upsert_assertions must be an object.",
              );
            }
            const id = typeof raw.id === "string" ? raw.id.trim() : "";
            const title = typeof raw.title === "string" ? raw.title.trim() : "";
            const description =
              typeof raw.description === "string" ? raw.description.trim() : "";
            if (!id || isPrototypeKey(id) || !title) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                "Each assertion requires a non-empty id and title.",
                { assertion: raw },
              );
            }
            if (seenBatchIds.has(id)) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Duplicate assertion id "${id}" in upsert_assertions batch.`,
                { assertionId: id },
              );
            }
            seenBatchIds.add(id);

            if (
              raw.status !== undefined &&
              !VALID_ASSERTION_STATUS_SET.has(raw.status)
            ) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Invalid assertion status "${String(raw.status)}" for "${id}".`,
              );
            }
            if (
              raw.status === "passed" &&
              state.validatorEnabled &&
              !input.force &&
              callerRole !== "human"
            ) {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Cannot set assertion "${id}" directly to "passed" via upsert_assertions while validatorEnabled is ON. Use verify_assertion from an independent read-only validator.`,
              );
            }

            const existingIdx = indexById.get(id);
            if (existingIdx !== undefined) {
              const prev = nextAssertions[existingIdx]!;
              const nextEvidenceRequired =
                raw.evidenceRequired !== undefined
                  ? raw.evidenceRequired.trim() || undefined
                  : prev.evidenceRequired;
              const requirementChanged =
                description !== prev.description ||
                (raw.evidenceRequired !== undefined &&
                  (nextEvidenceRequired ?? "") !== (prev.evidenceRequired ?? ""));

              let nextStatus: AssertionStatus = raw.status ?? prev.status;
              let nextEvidence =
                raw.evidence !== undefined
                  ? raw.evidence.trim() || undefined
                  : prev.evidence;
              let nextVerifiedBy = prev.verifiedBy;
              let nextVerifiedByRole = prev.verifiedByRole;
              let nextOverridden = prev.overridden;
              let nextOverrideJustification = prev.overrideJustification;

              // Droid Rule: modifying description or evidenceRequired of a "passed" assertion resets it to "pending"!
              if (prev.status === "passed" && requirementChanged && !input.force) {
                nextStatus = "pending";
                nextEvidence = undefined;
                nextVerifiedBy = undefined;
                nextVerifiedByRole = undefined;
                nextOverridden = undefined;
                nextOverrideJustification = undefined;
                resetToPendingIds.push(id);
              }

              nextAssertions[existingIdx] = {
                id,
                title,
                description,
                ...(nextEvidenceRequired ? { evidenceRequired: nextEvidenceRequired } : {}),
                status: nextStatus,
                ...(nextEvidence ? { evidence: nextEvidence } : {}),
                ...(nextVerifiedBy ? { verifiedBy: nextVerifiedBy } : {}),
                ...(nextVerifiedByRole ? { verifiedByRole: nextVerifiedByRole } : {}),
                ...(nextOverridden ? { overridden: nextOverridden } : {}),
                ...(nextOverrideJustification
                  ? { overrideJustification: nextOverrideJustification }
                  : {}),
                updatedAt: nowIso,
              };
              updatedCount += 1;
            } else {
              const evidenceRequired = raw.evidenceRequired?.trim() || undefined;
              const evidence = raw.evidence?.trim() || undefined;
              const initialStatus: AssertionStatus = raw.status ?? "pending";
              const created: MissionAssertion = {
                id,
                title,
                description,
                ...(evidenceRequired ? { evidenceRequired } : {}),
                status: initialStatus,
                ...(evidence ? { evidence } : {}),
                ...(initialStatus === "passed" || initialStatus === "failed"
                  ? { verifiedBy: callerName, verifiedByRole: callerRole }
                  : {}),
                updatedAt: nowIso,
              };
              indexById.set(id, nextAssertions.length);
              nextAssertions.push(created);
              addedCount += 1;
            }
          }

          const milestoneSync = syncMissionMilestones(
            state.milestones,
            state.features ?? [],
            nextAssertions,
            nowIso,
            state.members,
          );
          const updatedRun = await this.store.updateRun(run.id, {
            assertions: nextAssertions,
            ...(state.milestones || (state.features?.length ?? 0) > 0
              ? { milestones: milestoneSync.milestones }
              : {}),
            actor: callerName,
          });
          const coverage = analyzeMissionCoverage(
            updatedRun.assertions ?? [],
            updatedRun.features ?? [],
          );
          const notes: string[] = [
            `Upserted ${addedCount + updatedCount} assertion(s) (${addedCount} added, ${updatedCount} updated; total=${nextAssertions.length}).`,
          ];
          if (resetToPendingIds.length > 0) {
            notes.push(
              `Auto-reset modified passed assertion(s) to "pending" for re-verification: ${resetToPendingIds.join(", ")}.`,
            );
          }
          if (milestoneSync.unsealed.length > 0) {
            notes.push(
              `Unsealed milestone(s) due to pending/modified assertions: ${milestoneSync.unsealed.join(", ")}.`,
            );
          }
          if (coverage.unclaimedAssertions.length > 0) {
            notes.push(
              `⚠ Unclaimed VAL-* assertion(s) not yet in any feature fulfills[]: ${coverage.unclaimedAssertions.join(", ")}.`,
            );
          }

          const summary = notes.join(" ");
          await this.store.appendEvent({
            runId: run.id,
            type: "mission_updated",
            actor: callerName,
            summary,
            data: {
              op,
              addedCount,
              updatedCount,
              resetToPendingIds,
              unsealedMilestones: milestoneSync.unsealed,
            },
          });
          await this.refreshCache(updatedRun);
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op,
            assertions: updatedRun.assertions ?? [],
            features: updatedRun.features ?? [],
            milestones: updatedRun.milestones ?? [],
            summary,
          };
        }

        case "remove_assertion": {
          if (!isOrchestratorOrHuman(callerRole)) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" (@${callerName}) cannot remove VAL-* assertions.`,
            );
          }
          const assertionId = input.assertionId?.trim() ?? "";
          if (!assertionId) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'assertion_id is required for mission_op="remove_assertion".',
            );
          }
          const currentAssertions = state.assertions ?? [];
          if (!currentAssertions.some((a) => a.id === assertionId)) {
            throw new SwarmProtocolError(
              "NOT_FOUND",
              `Assertion "${assertionId}" was not found in Validation Contract.`,
              { assertionId },
            );
          }

          const nextAssertions = currentAssertions.filter((a) => a.id !== assertionId);
          if (nextAssertions.length === 0 && callerRole !== "human") {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Cannot remove the last assertion "${assertionId}" from the Validation Contract. A Mission contract must retain at least 1 VAL-* assertion (upsert replacement assertions first).`,
              { assertionId },
            );
          }
          let strippedFeatureIds: string[] = [];
          const nextFeatures = state.features
            ? state.features.map((f) => {
                if (!f.fulfills.includes(assertionId)) {
                  return { ...f };
                }
                strippedFeatureIds.push(f.id);
                return {
                  ...f,
                  fulfills: f.fulfills.filter((id) => id !== assertionId),
                  updatedAt: nowIso,
                };
              })
            : undefined;

          const milestoneSync = syncMissionMilestones(
            state.milestones,
            nextFeatures ?? [],
            nextAssertions,
            nowIso,
            state.members,
          );
          const updatedRun = await this.store.updateRun(run.id, {
            assertions: nextAssertions,
            ...(nextFeatures !== undefined ? { features: nextFeatures } : {}),
            ...(state.milestones || (nextFeatures?.length ?? 0) > 0
              ? { milestones: milestoneSync.milestones }
              : {}),
            actor: callerName,
          });
          const stripNote =
            strippedFeatureIds.length > 0
              ? ` Stripped orphaned reference from feature(s): ${strippedFeatureIds.join(", ")}.`
              : "";
          const summary = `Removed assertion "${assertionId}" (${nextAssertions.length} remaining).${stripNote}`;

          await this.store.appendEvent({
            runId: run.id,
            type: "mission_updated",
            actor: callerName,
            summary,
            data: { op, assertionId, strippedFeatureIds },
          });
          await this.refreshCache(updatedRun);
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op,
            assertions: updatedRun.assertions ?? [],
            features: updatedRun.features ?? [],
            milestones: updatedRun.milestones ?? [],
            summary,
          };
        }

        case "verify_assertion": {
          // Strict Droid Gate: Workers can NEVER self-grade VAL-* assertions!
          if (callerRole === "worker" || callerRole === "monitor") {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" (@${callerName}) is forbidden from verifying VAL-* assertions (workers cannot self-grade). Hand off to an independent read-only @validator!`,
              { callerName, callerRole },
            );
          }
          const targetAssertionIds: string[] = [];
          const seenAssertionIds = new Set<string>();
          const pushAssertionId = (raw: unknown): void => {
            if (typeof raw !== "string") return;
            const trimmed = raw.trim();
            if (!trimmed || seenAssertionIds.has(trimmed)) return;
            seenAssertionIds.add(trimmed);
            targetAssertionIds.push(trimmed);
          };
          pushAssertionId(input.assertionId);
          if (Array.isArray(input.assertionIds)) {
            for (const rawId of input.assertionIds) {
              pushAssertionId(rawId);
            }
          }

          const assertionStatus = input.assertionStatus;
          if (
            targetAssertionIds.length === 0 ||
            !assertionStatus ||
            !VALID_ASSERTION_STATUS_SET.has(assertionStatus)
          ) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'At least one "assertion_id" (or "assertion_ids") and a valid "assertion_status" ("pending" | "passed" | "failed" | "blocked") are required for verify_assertion.',
            );
          }

          const targetLabel =
            targetAssertionIds.length === 1
              ? `"${targetAssertionIds[0]!}"`
              : targetAssertionIds.map((id) => `"${id}"`).join(", ");

          if (
            assertionStatus === "passed" &&
            state.validatorEnabled &&
            !input.force &&
            callerRole !== "validator" &&
            callerRole !== "human"
          ) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `When validatorEnabled is ON, only an independent read-only "validator" (or human) may mark assertion ${targetLabel} as "passed". Spawn or wake @validator to verify it.`,
              {
                assertionId: targetAssertionIds[0],
                assertionIds: targetAssertionIds,
                callerRole,
              },
            );
          }

          const evidence = input.evidence?.trim() ?? "";
          if (
            (assertionStatus === "passed" || assertionStatus === "failed") &&
            !evidence
          ) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Non-empty "evidence" is required when setting assertion ${targetLabel} to "${assertionStatus}".`,
              {
                assertionId: targetAssertionIds[0],
                assertionIds: targetAssertionIds,
                assertionStatus,
              },
            );
          }

          const currentAssertions = state.assertions ?? [];
          const existingIds = new Set(currentAssertions.map((a) => a.id));
          const missingIds = targetAssertionIds.filter((id) => !existingIds.has(id));
          if (missingIds.length > 0) {
            throw new SwarmProtocolError(
              "NOT_FOUND",
              missingIds.length === 1
                ? `Assertion "${missingIds[0]!}" not found in Validation Contract.`
                : `Assertions ${missingIds.map((id) => `"${id}"`).join(", ")} not found in Validation Contract.`,
              {
                assertionId: missingIds[0],
                missingAssertionIds: missingIds,
              },
            );
          }

          const targetIdSet = new Set(targetAssertionIds);
          const nextAssertions = currentAssertions.map((a) => {
            if (!targetIdSet.has(a.id)) return { ...a };
            if (assertionStatus === "pending") {
              const reset: MissionAssertion = {
                id: a.id,
                title: a.title,
                description: a.description,
                ...(a.evidenceRequired ? { evidenceRequired: a.evidenceRequired } : {}),
                status: "pending",
                ...(evidence ? { evidence } : {}),
                updatedAt: nowIso,
              };
              return reset;
            }
            const {
              overridden: _prevOverridden,
              overrideJustification: _prevOverrideJustification,
              ...restAssertion
            } = a;
            return {
              ...restAssertion,
              status: assertionStatus,
              ...(evidence ? { evidence } : {}),
              verifiedBy: callerName,
              verifiedByRole: callerRole,
              updatedAt: nowIso,
            };
          });

          const milestoneSync = syncMissionMilestones(
            state.milestones,
            state.features ?? [],
            nextAssertions,
            nowIso,
            state.members,
          );

          // If an assertion explicitly failed, also ensure any milestone claiming it is unsealed & in_progress
          const affectedMilestones = new Set<string>(
            (state.features ?? [])
              .filter(
                (f) =>
                  f.status !== "cancelled" &&
                  f.fulfills.some((id) => targetIdSet.has(id)),
              )
              .map((f) => f.milestone),
          );
          if (assertionStatus === "failed") {
            for (const m of milestoneSync.milestones) {
              if (affectedMilestones.has(m.label)) {
                if (m.sealed) {
                  m.sealed = false;
                  delete m.sealedAt;
                  if (!milestoneSync.unsealed.includes(m.label)) {
                    milestoneSync.unsealed.push(m.label);
                  }
                }
                m.status = "in_progress";
              }
            }
          }

          const updatedRun = await this.store.updateRun(run.id, {
            assertions: nextAssertions,
            milestones: milestoneSync.milestones,
            actor: callerName,
          });

          const passedCount = nextAssertions.filter((a) => a.status === "passed").length;
          const notes: string[] = [
            targetAssertionIds.length === 1
              ? `Assertion ${targetAssertionIds[0]!} marked "${assertionStatus}" by @${callerName} (${passedCount}/${nextAssertions.length} VAL passed).`
              : `Assertions ${targetAssertionIds.join(", ")} (${targetAssertionIds.length}) marked "${assertionStatus}" by @${callerName} (${passedCount}/${nextAssertions.length} VAL passed).`,
          ];
          if (milestoneSync.newlySealed.length > 0) {
            notes.push(
              `Sealed milestone(s): ${milestoneSync.newlySealed.join(", ")} [sealed].`,
            );
          }
          if (assertionStatus === "failed") {
            const claimingFeatures = (state.features ?? []).filter(
              (f) =>
                f.status !== "cancelled" &&
                f.fulfills.some((id) => targetIdSet.has(id)),
            );
            const owners = claimingFeatures
              .map((f) =>
                f.assignedMember ? `${f.id} (@${f.assignedMember})` : f.id,
              )
              .join(", ");
            if (milestoneSync.unsealed.length > 0) {
              notes.push(`Unsealed milestone(s): ${milestoneSync.unsealed.join(", ")}.`);
            }
            notes.push(
              `Action needed: fix failure (${evidence.slice(0, 140)})${owners ? ` on ${owners}` : ""}, merge/re-test, and re-verify ${targetAssertionIds.join(", ")}.`,
            );
          }

          const summary = notes.join(" ");
          await this.store.appendEvent({
            runId: run.id,
            type: "audit_completed",
            actor: callerName,
            summary,
            data: {
              assertionId: targetAssertionIds[0],
              assertionIds: targetAssertionIds,
              status: assertionStatus,
              verifiedBy: callerName,
              verifiedByRole: callerRole,
              newlySealedMilestones: milestoneSync.newlySealed,
              unsealedMilestones: milestoneSync.unsealed,
            },
          });
          await this.refreshCache(updatedRun);
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op,
            assertions: updatedRun.assertions ?? [],
            features: updatedRun.features ?? [],
            milestones: updatedRun.milestones ?? [],
            summary,
          };
        }

        case "override_assertion": {
          if (!isOrchestratorOrHuman(callerRole)) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" (@${callerName}) cannot override VAL-* assertions. Only @${ORCHESTRATOR_NAME} or human may perform an audited override_assertion.`,
              { callerName, callerRole },
            );
          }
          const assertionId = input.assertionId?.trim() ?? "";
          if (!assertionId) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'assertion_id is required for mission_op="override_assertion".',
            );
          }
          const trimmedJustification = input.justification?.trim() ?? "";
          if (trimmedJustification.length < 30) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Audited override_assertion for "${assertionId}" requires a concrete technical "justification" of at least 30 characters (received ${trimmedJustification.length}).`,
              { assertionId, length: trimmedJustification.length },
            );
          }
          const lazyMatch =
            LAZY_OVERRIDE_EXCUSE_RE.exec(trimmedJustification) ??
            LAZY_JUSTIFICATION_RE.exec(trimmedJustification);
          if (lazyMatch) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Lazy override justification rejected ("${lazyMatch[0]}") for "${assertionId}". Provide a concrete technical justification (>= 30 chars) explaining why external/environmental constraints require overriding this assertion.`,
              { assertionId, matchedPhrase: lazyMatch[0] },
            );
          }

          const currentAssertions = state.assertions ?? [];
          const targetIdx = currentAssertions.findIndex((a) => a.id === assertionId);
          if (targetIdx < 0) {
            throw new SwarmProtocolError(
              "NOT_FOUND",
              `Assertion "${assertionId}" not found in Validation Contract.`,
              { assertionId },
            );
          }

          const overrideEvidence = `[OVERRIDE] ${trimmedJustification}`;
          const nextAssertions: MissionAssertion[] = currentAssertions.map((a, idx) => {
            if (idx !== targetIdx) return { ...a };
            return {
              ...a,
              status: "passed",
              overridden: true,
              overrideJustification: trimmedJustification,
              evidence: overrideEvidence,
              verifiedBy: callerName,
              verifiedByRole: callerRole,
              updatedAt: nowIso,
            };
          });

          const milestoneSync = syncMissionMilestones(
            state.milestones,
            state.features ?? [],
            nextAssertions,
            nowIso,
            state.members,
          );
          const updatedRun = await this.store.updateRun(run.id, {
            assertions: nextAssertions,
            milestones: milestoneSync.milestones,
            actor: callerName,
          });

          const passedCount = nextAssertions.filter((a) => a.status === "passed").length;
          const notes: string[] = [
            `[OVERRIDE] Assertion ${assertionId} marked "passed" via audited override by @${callerName} (${passedCount}/${nextAssertions.length} VAL passed): ${trimmedJustification.slice(0, 120)}.`,
          ];
          if (milestoneSync.newlySealed.length > 0) {
            notes.push(
              `Sealed milestone(s): ${milestoneSync.newlySealed.join(", ")} [sealed].`,
            );
          }
          const summary = notes.join(" ");

          await this.store.appendEvent({
            runId: run.id,
            type: "audit_completed",
            actor: callerName,
            summary,
            data: {
              op: "override_assertion",
              assertionId,
              status: "passed",
              overridden: true,
              overrideJustification: trimmedJustification,
              evidence: overrideEvidence,
              verifiedBy: callerName,
              verifiedByRole: callerRole,
              newlySealedMilestones: milestoneSync.newlySealed,
            },
          });
          await this.refreshCache(updatedRun);
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op,
            assertions: updatedRun.assertions ?? [],
            features: updatedRun.features ?? [],
            milestones: updatedRun.milestones ?? [],
            summary,
          };
        }

        case "upsert_features": {
          if (!isOrchestratorOrHuman(callerRole)) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" (@${callerName}) cannot upsert features. Only @${ORCHESTRATOR_NAME} or human may modify the Feature Queue.`,
            );
          }
          if (!Array.isArray(input.features) || input.features.length === 0) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'Non-empty "features" array is required for mission_op="upsert_features".',
            );
          }

          const sealedSet = new Set(
            (state.milestones ?? [])
              .filter((m) => m.sealed === true)
              .map((m) => m.label),
          );
          const existingList = (state.features ?? []).map((f) => ({ ...f }));
          const existingById = new Map<string, MissionFeature>();
          for (const f of existingList) {
            existingById.set(f.id, f);
          }

          const seenBatchIds = new Set<string>();
          const newFeatures: MissionFeature[] = [];
          const promoteIds = new Set<string>();
          let addedCount = 0;
          let updatedCount = 0;

          for (const raw of input.features) {
            if (!raw || typeof raw !== "object") {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                "Each feature in upsert_features must be an object.",
              );
            }
            const id = typeof raw.id === "string" ? raw.id.trim() : "";
            const title = typeof raw.title === "string" ? raw.title.trim() : "";
            const milestone =
              typeof raw.milestone === "string" ? raw.milestone.trim() : "";
            const description =
              typeof raw.description === "string" ? raw.description.trim() : "";

            if (!id || isPrototypeKey(id) || !title || !milestone) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                "Each feature requires non-empty id, title, and milestone.",
                { feature: raw },
              );
            }
            if (seenBatchIds.has(id)) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Duplicate feature id "${id}" in upsert_features batch.`,
                { featureId: id },
              );
            }
            seenBatchIds.add(id);

            if (raw.status !== undefined && !VALID_FEATURE_STATUS_SET.has(raw.status)) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Invalid feature status "${String(raw.status)}" for "${id}".`,
              );
            }

            const existing = existingById.get(id);
            const nextStatus: FeatureStatus =
              raw.status ?? existing?.status ?? "pending";

            // Sealed Milestone Guard: prevent adding new work or re-opening completed work inside a sealed milestone!
            if (!input.force && sealedSet.has(milestone)) {
              const isNewInSealed = !existing || existing.milestone !== milestone;
              const isReopenedInSealed =
                Boolean(existing) &&
                (existing!.status === "completed" || existing!.status === "cancelled") &&
                nextStatus !== "completed" &&
                nextStatus !== "cancelled";
              if (isNewInSealed || isReopenedInSealed) {
                throw new SwarmProtocolError(
                  "INVALID_INPUT",
                  `Milestone "${milestone}" is already sealed [sealed]. Place new or follow-up work into a new follow-up milestone (e.g. "${milestone}-followup" or "misc-fixes") so zero code bypasses validation.`,
                  { featureId: id, milestone },
                );
              }
            }

            const cleanList = (arr?: string[]): string[] | undefined =>
              Array.isArray(arr)
                ? arr
                    .filter((s): s is string => typeof s === "string")
                    .map((s) => s.trim())
                    .filter(Boolean)
                : undefined;

            const assignedMember =
              raw.assignedMember !== undefined
                ? raw.assignedMember.trim().replace(/^@/, "") || undefined
                : existing?.assignedMember;
            const mergedCommitSha =
              raw.mergedCommitSha !== undefined
                ? raw.mergedCommitSha.trim() || undefined
                : existing?.mergedCommitSha;

            const normalizedFeature: MissionFeature = {
              id,
              title,
              description: description || existing?.description || "",
              milestone,
              ...(raw.dependsOn !== undefined
                ? { dependsOn: cleanList(raw.dependsOn) }
                : existing?.dependsOn
                  ? { dependsOn: existing.dependsOn }
                  : {}),
              ...(raw.filesOwned !== undefined
                ? { filesOwned: cleanList(raw.filesOwned) }
                : existing?.filesOwned
                  ? { filesOwned: existing.filesOwned }
                  : {}),
              ...(raw.preconditions !== undefined
                ? { preconditions: cleanList(raw.preconditions) }
                : existing?.preconditions
                  ? { preconditions: existing.preconditions }
                  : {}),
              ...(raw.expectedBehavior !== undefined
                ? { expectedBehavior: cleanList(raw.expectedBehavior) }
                : existing?.expectedBehavior
                  ? { expectedBehavior: existing.expectedBehavior }
                  : {}),
              ...(raw.verificationSteps !== undefined
                ? { verificationSteps: cleanList(raw.verificationSteps) }
                : existing?.verificationSteps
                  ? { verificationSteps: existing.verificationSteps }
                  : {}),
              fulfills:
                raw.fulfills !== undefined
                  ? cleanList(raw.fulfills) ?? []
                  : existing?.fulfills ?? [],
              status: nextStatus,
              ...(assignedMember ? { assignedMember } : {}),
              ...(mergedCommitSha ? { mergedCommitSha } : {}),
              updatedAt: nowIso,
            };

            if (existing) {
              const idx = existingList.findIndex((f) => f.id === id);
              if (idx >= 0) {
                existingList[idx] = normalizedFeature;
              }
              if (input.prepend || nextStatus === "failed") {
                promoteIds.add(id);
              }
              updatedCount += 1;
            } else {
              newFeatures.push(normalizedFeature);
              if (input.prepend || nextStatus === "failed") {
                promoteIds.add(id);
              }
              addedCount += 1;
            }
          }

          const combined = input.prepend
            ? [...newFeatures, ...existingList]
            : [...existingList, ...newFeatures];
          const orderedFeatures = orderMissionFeatures(combined, {
            promoteIdsToTop: promoteIds,
          });
          validateFeatureDag(orderedFeatures);

          const milestoneSync = syncMissionMilestones(
            state.milestones,
            orderedFeatures,
            state.assertions ?? [],
            nowIso,
            state.members,
          );
          const updatedRun = await this.store.updateRun(run.id, {
            features: orderedFeatures,
            milestones: milestoneSync.milestones,
            actor: callerName,
          });

          const coverage = analyzeMissionCoverage(
            updatedRun.assertions ?? [],
            updatedRun.features ?? [],
          );
          const notes: string[] = [
            `Upserted ${addedCount + updatedCount} feature(s) (${addedCount} added${input.prepend ? " at top of queue" : ""}, ${updatedCount} updated; total=${orderedFeatures.length}).`,
          ];
          if (coverage.unclaimedAssertions.length > 0) {
            notes.push(
              `⚠ Unclaimed VAL-* assertion(s): ${coverage.unclaimedAssertions.join(", ")}.`,
            );
          }
          if (coverage.duplicateFulfills.length > 0) {
            notes.push(
              `⚠ Duplicate fulfills across active/completed features: ${coverage.duplicateFulfills.map((d) => `${d.assertionId} -> [${d.featureIds.join(", ")}]`).join("; ")}.`,
            );
          }
          if (coverage.unknownFulfills.length > 0) {
            notes.push(
              `⚠ Unknown fulfills VAL ID(s): ${coverage.unknownFulfills.map((u) => `${u.featureId}:${u.assertionId}`).join(", ")}.`,
            );
          }

          const summary = notes.join(" ");
          await this.store.appendEvent({
            runId: run.id,
            type: "mission_updated",
            actor: callerName,
            summary,
            data: {
              op,
              addedCount,
              updatedCount,
              prepend: Boolean(input.prepend),
              unclaimedAssertions: coverage.unclaimedAssertions,
              duplicateFulfills: coverage.duplicateFulfills,
            },
          });
          await this.refreshCache(updatedRun);
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op,
            features: updatedRun.features ?? [],
            assertions: updatedRun.assertions ?? [],
            milestones: updatedRun.milestones ?? [],
            summary,
          };
        }

        case "update_feature": {
          if (callerRole === "validator" || callerRole === "monitor") {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Read-only role "${callerRole}" (@${callerName}) cannot update features. Use verify_assertion for VAL-* checks.`,
            );
          }
          const featureId = input.featureId?.trim() ?? "";
          if (!featureId) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'feature_id is required for mission_op="update_feature".',
            );
          }
          const currentFeatures = (state.features ?? []).map((f) => ({ ...f }));
          const idx = currentFeatures.findIndex((f) => f.id === featureId);
          if (idx < 0) {
            throw new SwarmProtocolError(
              "NOT_FOUND",
              `Feature "${featureId}" not found in Mission Feature Queue.`,
              { featureId },
            );
          }
          const target = currentFeatures[idx]!;

          if (
            input.featureStatus !== undefined &&
            !VALID_FEATURE_STATUS_SET.has(input.featureStatus)
          ) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Invalid feature_status "${String(input.featureStatus)}".`,
            );
          }

          const requestedAssigned =
            input.assignedMember !== undefined
              ? input.assignedMember.trim().replace(/^@/, "")
              : undefined;

          if (callerRole === "worker") {
            if (
              input.featureStatus !== undefined &&
              input.featureStatus !== "in_progress"
            ) {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Worker "@${callerName}" may only set feature_status="in_progress" via update_feature (got "${input.featureStatus}"). Report completion via post_message with [done] and verification_evidence instead.`,
                { featureId, callerName, featureStatus: input.featureStatus },
              );
            }
            if (input.mergedCommitSha !== undefined) {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Worker "@${callerName}" cannot set merged_commit_sha on feature "${featureId}".`,
                { featureId, callerName },
              );
            }
            if (input.assignedMember !== undefined && requestedAssigned === "") {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Worker "@${callerName}" cannot unassign feature "${featureId}".`,
                { featureId, callerName },
              );
            }
            if (target.status === "completed" || target.status === "cancelled") {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Worker "@${callerName}" cannot modify ${target.status} feature "${featureId}".`,
                { featureId, callerName, status: target.status },
              );
            }
            const isAssignedToCaller = target.assignedMember === callerName;
            const isClaimingUnassigned =
              !target.assignedMember &&
              input.featureStatus === "in_progress" &&
              (!requestedAssigned || requestedAssigned === callerName);
            if (!isAssignedToCaller && !isClaimingUnassigned) {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Worker "@${callerName}" may only update a feature assigned to "@${callerName}" or claim an unassigned feature as "in_progress" (feature "${featureId}" is assigned to "${target.assignedMember ?? "unassigned"}").`,
                { featureId, callerName, assignedMember: target.assignedMember },
              );
            }
            if (requestedAssigned && requestedAssigned !== callerName) {
              throw new SwarmProtocolError(
                "PERMISSION_DENIED",
                `Worker "@${callerName}" cannot reassign feature "${featureId}" to "@${requestedAssigned}".`,
              );
            }
          } else if (!isOrchestratorOrHuman(callerRole)) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" cannot update features.`,
            );
          }

          const nextStatus: FeatureStatus = input.featureStatus ?? target.status;

          // Sealed Milestone Guard when re-opening a completed/cancelled feature inside a sealed milestone
          const parentMilestone = state.milestones?.find(
            (m) => m.label === target.milestone,
          );
          if (
            !input.force &&
            parentMilestone?.sealed === true &&
            (target.status === "completed" || target.status === "cancelled") &&
            nextStatus !== "completed" &&
            nextStatus !== "cancelled"
          ) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Milestone "${target.milestone}" is already sealed [sealed]. Create a new follow-up feature in a new milestone (e.g. "${target.milestone}-followup") instead of re-opening "${featureId}".`,
              { featureId, milestone: target.milestone },
            );
          }

          const nextAssigned =
            requestedAssigned !== undefined
              ? requestedAssigned || undefined
              : callerRole === "worker" && !target.assignedMember && nextStatus === "in_progress"
                ? callerName
                : target.assignedMember;
          const nextMergedSha =
            input.mergedCommitSha !== undefined
              ? input.mergedCommitSha.trim() || undefined
              : target.mergedCommitSha;

          currentFeatures[idx] = {
            ...target,
            status: nextStatus,
            ...(nextAssigned ? { assignedMember: nextAssigned } : {}),
            ...(nextMergedSha ? { mergedCommitSha: nextMergedSha } : {}),
            updatedAt: nowIso,
          };
          if (!nextAssigned) {
            delete currentFeatures[idx]!.assignedMember;
          }
          if (!nextMergedSha) {
            delete currentFeatures[idx]!.mergedCommitSha;
          }

          // Droid Queue Rule: failed moves to top for retry/fix; completed/cancelled sinks to bottom!
          const promoteIds =
            nextStatus === "failed" ? new Set<string>([featureId]) : undefined;
          let reordered: MissionFeature[];
          if (nextStatus === "completed" || nextStatus === "cancelled") {
            const updatedItem = currentFeatures[idx]!;
            const others = currentFeatures.filter((_, i) => i !== idx);
            reordered = orderMissionFeatures([...others, updatedItem]);
          } else {
            reordered = orderMissionFeatures(currentFeatures, {
              promoteIdsToTop: promoteIds,
            });
          }

          const milestoneSync = syncMissionMilestones(
            state.milestones,
            reordered,
            state.assertions ?? [],
            nowIso,
            state.members,
          );
          const updatedRun = await this.store.updateRun(run.id, {
            features: reordered,
            milestones: milestoneSync.milestones,
            actor: callerName,
          });

          const summary = `Updated feature "${featureId}" -> status=${nextStatus}${nextAssigned ? `, assigned=@${nextAssigned}` : ""}${nextMergedSha ? `, merged=${nextMergedSha.slice(0, 8)}` : ""}.`;
          await this.store.appendEvent({
            runId: run.id,
            type: "mission_updated",
            actor: callerName,
            summary,
            data: {
              op,
              featureId,
              status: nextStatus,
              assignedMember: nextAssigned,
              mergedCommitSha: nextMergedSha,
            },
          });
          await this.refreshCache(updatedRun);
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op,
            features: updatedRun.features ?? [],
            milestones: updatedRun.milestones ?? [],
            summary,
          };
        }

        case "resolve_handoff": {
          if (!isOrchestratorOrHuman(callerRole)) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" (@${callerName}) cannot resolve handoff tech-debt items. Only @${ORCHESTRATOR_NAME} or human may resolve handoffs.`,
            );
          }
          const handoffId = input.handoffId?.trim() ?? "";
          const resolution = input.resolution;
          if (
            !handoffId ||
            !resolution ||
            !VALID_HANDOFF_RESOLUTION_SET.has(resolution) ||
            resolution === "open"
          ) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'Both "handoff_id" and "resolution" ("tracked" | "dismissed") are required for resolve_handoff.',
            );
          }

          const handoffs = (state.handoffItems ?? []).map((h) => ({ ...h }));
          const idx = handoffs.findIndex((h) => h.id === handoffId);
          if (idx < 0) {
            throw new SwarmProtocolError(
              "NOT_FOUND",
              `Handoff item "${handoffId}" not found.`,
              { handoffId },
            );
          }

          const trackedFeatureId = input.trackedFeatureId?.trim() || undefined;
          const justification = input.justification?.trim() || undefined;

          if (resolution === "tracked") {
            const targetFeature = trackedFeatureId
              ? (state.features ?? []).find((f) => f.id === trackedFeatureId)
              : undefined;
            if (!trackedFeatureId || !targetFeature) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Resolving handoff "${handoffId}" as "tracked" requires a valid "tracked_feature_id" matching an existing feature in run.features. Add the follow-up feature via upsert_features first.`,
                { handoffId, trackedFeatureId },
              );
            }
            if (
              targetFeature.status === "completed" ||
              targetFeature.status === "cancelled"
            ) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Cannot resolve handoff "${handoffId}" as "tracked" against ${targetFeature.status} feature "${trackedFeatureId}". Track open handoff debt against an active ("pending", "in_progress", or "failed") follow-up feature, or use resolution="dismissed" with >=20 chars concrete evidence if already addressed.`,
                {
                  handoffId,
                  trackedFeatureId,
                  featureStatus: targetFeature.status,
                },
              );
            }
          } else if (resolution === "dismissed") {
            if (!justification || justification.length < 20) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Dismissing handoff "${handoffId}" requires a concrete technical "justification" of at least 20 characters (received ${justification?.length ?? 0}).`,
                { handoffId },
              );
            }
            const lazyMatch = LAZY_JUSTIFICATION_RE.exec(justification);
            if (lazyMatch) {
              throw new SwarmProtocolError(
                "INVALID_INPUT",
                `Lazy justification rejected ("${lazyMatch[0]}") when dismissing handoff "${handoffId}". Provide concrete technical evidence why this item is already addressed, invalid, or superseded — or create a follow-up feature via upsert_features and resolve as "tracked".`,
                { handoffId, matchedPhrase: lazyMatch[0] },
              );
            }
          }

          const currentItem = handoffs[idx]!;
          handoffs[idx] = {
            ...currentItem,
            resolution,
            ...(resolution === "tracked" && trackedFeatureId
              ? { trackedFeatureId }
              : {}),
            ...(resolution === "dismissed" && justification
              ? { justification }
              : {}),
            resolvedAt: nowIso,
          };

          const updatedRun = await this.store.updateRun(run.id, {
            handoffItems: handoffs,
            actor: callerName,
          });
          const remainingOpen = handoffs.filter((h) => h.resolution === "open").length;
          const detail =
            resolution === "tracked"
              ? `tracked by feature "${trackedFeatureId}"`
              : `dismissed ("${justification!.slice(0, 80)}")`;
          const summary = `Resolved handoff "${handoffId}" -> ${detail} (${remainingOpen} open handoff(s) remaining).`;

          await this.store.appendEvent({
            runId: run.id,
            type: "mission_updated",
            actor: callerName,
            summary,
            data: {
              op,
              handoffId,
              resolution,
              trackedFeatureId,
              remainingOpen,
            },
          });
          await this.refreshCache(updatedRun);
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op,
            handoffItems: updatedRun.handoffItems ?? [],
            summary,
          };
        }

        case "set_manifest": {
          if (!isOrchestratorOrHuman(callerRole)) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" (@${callerName}) cannot modify Mission commands, services, or boundaries.`,
            );
          }
          if (
            input.commands === undefined &&
            input.services === undefined &&
            input.boundaries === undefined
          ) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'Provide "commands", "services", and/or "boundaries" for mission_op="set_manifest".',
            );
          }

          let nextCommands = state.commands ? [...state.commands] : undefined;
          if (input.commands !== undefined) {
            const cmdMap = new Map<string, MissionCommandEntry>();
            if (!input.force && state.commands) {
              for (const existingCmd of state.commands) {
                cmdMap.set(existingCmd.name, { ...existingCmd });
              }
            }
            for (const entry of input.commands) {
              const name = typeof entry?.name === "string" ? entry.name.trim() : "";
              const command =
                typeof entry?.command === "string" ? entry.command.trim() : "";
              if (!name || !command) {
                throw new SwarmProtocolError(
                  "INVALID_INPUT",
                  "Each command entry in set_manifest requires non-empty name and command.",
                );
              }
              cmdMap.set(name, { name, command });
            }
            nextCommands = Array.from(cmdMap.values());
          }

          let nextServices = state.services ? [...state.services] : undefined;
          if (input.services !== undefined) {
            const seenBatchNames = new Set<string>();
            const svcMap = new Map<string, MissionServiceEntry>();
            if (!input.force && state.services) {
              for (const existingSvc of state.services) {
                svcMap.set(existingSvc.name.toLowerCase(), {
                  ...existingSvc,
                  ...(existingSvc.dependsOn ? { dependsOn: [...existingSvc.dependsOn] } : {}),
                });
              }
            }
            for (const entry of input.services) {
              const name = typeof entry?.name === "string" ? entry.name.trim() : "";
              const start = typeof entry?.start === "string" ? entry.start.trim() : "";
              if (!name || isPrototypeKey(name) || !start) {
                throw new SwarmProtocolError(
                  "INVALID_INPUT",
                  "Each service entry in set_manifest requires non-empty name and start command.",
                );
              }
              const lowerName = name.toLowerCase();
              if (seenBatchNames.has(lowerName)) {
                throw new SwarmProtocolError(
                  "INVALID_INPUT",
                  `Duplicate service name "${name}" in set_manifest.`,
                  { serviceName: name },
                );
              }
              seenBatchNames.add(lowerName);

              let port: number | undefined;
              if (entry.port !== undefined) {
                if (
                  typeof entry.port !== "number" ||
                  !Number.isInteger(entry.port) ||
                  entry.port < 1 ||
                  entry.port > 65535
                ) {
                  throw new SwarmProtocolError(
                    "INVALID_INPUT",
                    `Invalid port "${String(entry.port)}" for service "${name}" (expected integer 1..65535).`,
                    { serviceName: name, port: entry.port },
                  );
                }
                port = entry.port;
              }

              const stop =
                typeof entry.stop === "string" && entry.stop.trim()
                  ? entry.stop.trim()
                  : undefined;
              const healthcheck =
                typeof entry.healthcheck === "string" && entry.healthcheck.trim()
                  ? entry.healthcheck.trim()
                  : undefined;
              const dependsOn = Array.isArray(entry.dependsOn)
                ? entry.dependsOn
                    .filter((d): d is string => typeof d === "string")
                    .map((d) => d.trim())
                    .filter(Boolean)
                : undefined;

              svcMap.set(lowerName, {
                name,
                start,
                ...(stop ? { stop } : {}),
                ...(healthcheck ? { healthcheck } : {}),
                ...(port !== undefined ? { port } : {}),
                ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
              });
            }

            const candidateServices = Array.from(svcMap.values());
            const portOwners = new Map<number, string>();
            for (const svc of candidateServices) {
              if (svc.port !== undefined) {
                const existingOwner = portOwners.get(svc.port);
                if (
                  existingOwner &&
                  existingOwner.toLowerCase() !== svc.name.toLowerCase()
                ) {
                  throw new SwarmProtocolError(
                    "INVALID_INPUT",
                    `Duplicate service port ${svc.port} across services "${existingOwner}" and "${svc.name}". Each service must declare a unique port.`,
                    { port: svc.port, services: [existingOwner, svc.name] },
                  );
                }
                portOwners.set(svc.port, svc.name);
              }
            }
            nextServices = candidateServices;
          }

          let nextBoundaries = state.boundaries ? [...state.boundaries] : undefined;
          if (input.boundaries !== undefined) {
            const incoming = input.boundaries
              .filter((b): b is string => typeof b === "string")
              .map((b) => b.trim())
              .filter(Boolean);
            if (input.force || !state.boundaries) {
              nextBoundaries = Array.from(new Set(incoming));
            } else {
              nextBoundaries = Array.from(
                new Set([...state.boundaries, ...incoming]),
              );
            }
          }

          const updatedRun = await this.store.updateRun(run.id, {
            ...(nextCommands !== undefined ? { commands: nextCommands } : {}),
            ...(nextServices !== undefined ? { services: nextServices } : {}),
            ...(nextBoundaries !== undefined ? { boundaries: nextBoundaries } : {}),
            actor: callerName,
          });
          const svcSuffix =
            (updatedRun.services?.length ?? 0) > 0
              ? `, ${updatedRun.services!.length} service(s)`
              : "";
          const summary = `Updated Mission manifest (${updatedRun.commands?.length ?? 0} command(s)${svcSuffix}, ${updatedRun.boundaries?.length ?? 0} boundary rule(s)).`;

          await this.store.appendEvent({
            runId: run.id,
            type: "mission_updated",
            actor: callerName,
            summary,
            data: {
              op,
              commandsCount: updatedRun.commands?.length ?? 0,
              servicesCount: updatedRun.services?.length ?? 0,
              boundariesCount: updatedRun.boundaries?.length ?? 0,
            },
          });
          await this.refreshCache(updatedRun);
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op,
            commands: updatedRun.commands ?? [],
            services: updatedRun.services ?? [],
            boundaries: updatedRun.boundaries ?? [],
            summary,
          };
        }

        case "write_library": {
          if (callerRole === "monitor") {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Role "${callerRole}" cannot write to Mission library.`,
            );
          }
          const rawTopic = input.libraryTopic?.trim() ?? "";
          if (!rawTopic) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              'library_topic is required for mission_op="write_library".',
            );
          }
          const safeTopic = normalizeLibraryTopicName(rawTopic);
          const content = input.libraryContent;
          if (typeof content !== "string" || content.trim().length === 0) {
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              `Non-empty "library_content" is required for mission_op="write_library" (topic "${safeTopic}").`,
              { libraryTopic: safeTopic },
            );
          }

          const written = await this.writeMissionLibraryTopic(
            run.id,
            safeTopic,
            content,
            {
              append: Boolean(input.libraryAppend),
              actor: callerName,
            },
          );
          const summary = `${input.libraryAppend ? "Appended to" : "Updated"} shared library topic "${written.topic}" (.pi/swarm/runs/${run.id}/library/${written.topic}.md) by @${callerName}.`;

          await this.store.appendEvent({
            runId: run.id,
            type: "mission_updated",
            actor: callerName,
            summary,
            data: {
              op: "write_library",
              topic: written.topic,
              append: Boolean(input.libraryAppend),
              callerRole,
            },
          });
          this.emitEngineEvent("snapshot_changed", summary);

          return {
            op: "write_library",
            libraryTopic: written.topic,
            libraryContent: written.content,
            summary,
          };
        }

        default:
          throw new SwarmProtocolError("INVALID_INPUT", `Unsupported mission_op: ${String(op)}`);
      }
    });
  }

  private getOrInitFallbackLibrary(runId: string): Map<string, string> {
    let map = this.fallbackLibrary.get(runId);
    if (!map) {
      map = new Map<string, string>();
      for (const defaultTopic of DEFAULT_LIBRARY_TOPICS) {
        map.set(
          defaultTopic,
          `# ${defaultTopic[0]!.toUpperCase()}${defaultTopic.slice(1)} Notes\n`,
        );
      }
      this.fallbackLibrary.set(runId, map);
    }
    return map;
  }

  private async readMissionLibraryTopic(
    runId: string,
    topic: string,
  ): Promise<string | null> {
    if (this.store.readLibraryTopic) {
      return this.store.readLibraryTopic(runId, topic);
    }
    const map = this.getOrInitFallbackLibrary(runId);
    return map.has(topic) ? (map.get(topic) ?? null) : null;
  }

  private async writeMissionLibraryTopic(
    runId: string,
    topic: string,
    content: string,
    options?: { append?: boolean; actor?: string },
  ): Promise<{ topic: string; path: string; content: string }> {
    if (this.store.writeLibraryTopic) {
      return this.store.writeLibraryTopic(runId, topic, content, options);
    }
    const incomingBytes = Buffer.byteLength(content, "utf8");
    if (incomingBytes > MAX_LIBRARY_TOPIC_BYTES) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Library topic "${topic}" content exceeds maximum size of ${MAX_LIBRARY_TOPIC_BYTES} bytes (got ${incomingBytes} bytes).`,
        { runId, topic, bytes: incomingBytes, maxBytes: MAX_LIBRARY_TOPIC_BYTES },
      );
    }
    const map = this.getOrInitFallbackLibrary(runId);
    let nextContent = content;
    if (options?.append) {
      const existing = map.get(topic) ?? "";
      if (existing.length === 0) {
        nextContent = content;
      } else if (existing.endsWith("\n") || content.startsWith("\n")) {
        nextContent = `${existing}${content}`;
      } else {
        nextContent = `${existing}\n${content}`;
      }
    }
    const totalBytes = Buffer.byteLength(nextContent, "utf8");
    if (totalBytes > MAX_LIBRARY_TOPIC_BYTES) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Library topic "${topic}" exceeds maximum size of ${MAX_LIBRARY_TOPIC_BYTES} bytes after update (got ${totalBytes} bytes).`,
        { runId, topic, bytes: totalBytes, maxBytes: MAX_LIBRARY_TOPIC_BYTES },
      );
    }
    map.set(topic, nextContent);
    return {
      topic,
      path: `${this.store.getRunDir(runId)}/${SWARM_LIBRARY_DIR}/${topic}.md`,
      content: nextContent,
    };
  }

  private async listMissionLibraryTopics(runId: string): Promise<string[]> {
    if (this.store.listLibraryTopics) {
      const listed = await this.store.listLibraryTopics(runId);
      return listed.map((item) => item.topic);
    }
    const map = this.getOrInitFallbackLibrary(runId);
    return Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
  }

  private async executeWorktreeInitCommand(
    run: SwarmRunState,
    cwd: string,
  ): Promise<{ ok: boolean; command?: string; warning?: string }> {
    const initEntry = (run.commands ?? []).find(
      (c) =>
        typeof c.name === "string" &&
        c.name.trim().toLowerCase() === "init" &&
        typeof c.command === "string" &&
        c.command.trim().length > 0,
    );
    if (!initEntry) {
      return { ok: true };
    }
    const command = initEntry.command.trim();
    const timeoutMs = Math.max(
      500,
      this.getEffectiveSettings().gitTimeoutMs || 30_000,
    );

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let outputTail = "";

      const finish = (res: { ok: boolean; command?: string; warning?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      };

      const appendOutput = (chunk: Buffer | string): void => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (!text) return;
        outputTail = (outputTail + text).slice(-1200);
      };

      const useProcessGroup = process.platform !== "win32";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, {
          cwd,
          shell: true,
          detached: useProcessGroup,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        clearTimeout(undefined);
        resolve({
          ok: false,
          command,
          warning: `[init] Worktree init command "${command}" failed to launch in ${cwd}: ${msg}`,
        });
        return;
      }

      const killInitProcessTree = (sig: NodeJS.Signals): void => {
        if (useProcessGroup && child.pid && child.pid > 0) {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch {
            // fall back to child.kill below
          }
        }
        try {
          child.kill(sig);
        } catch {
          // ignore
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killInitProcessTree("SIGTERM");
        const forceKill = setTimeout(() => {
          killInitProcessTree("SIGKILL");
        }, 200);
        forceKill.unref?.();
        finish({
          ok: false,
          command,
          warning: `[init] Worktree init command "${command}" timed out after ${timeoutMs}ms in ${cwd}.`,
        });
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", appendOutput);
      child.stderr?.on("data", appendOutput);

      child.on("error", (err) => {
        finish({
          ok: false,
          command,
          warning: `[init] Worktree init command "${command}" failed in ${cwd}: ${err.message}`,
        });
      });

      child.on("close", (code, signal) => {
        if (timedOut) {
          return;
        }
        if (code === 0) {
          finish({ ok: true, command });
          return;
        }
        const compactTail = outputTail.replace(/\s+/g, " ").trim().slice(0, 240);
        const exitDesc =
          code !== null ? `code ${code}` : `signal ${String(signal ?? "unknown")}`;
        finish({
          ok: false,
          command,
          warning: `[init] Worktree init command "${command}" exited with ${exitDesc} in ${cwd}${compactTail ? `: ${compactTail}` : ""}`,
        });
      });
    });
  }

  // --------------------------------------------------------------------------
  // Teardown, Models, Snapshot, Subscription & Dispose
  // --------------------------------------------------------------------------

  async teardown(options?: TeardownOptions): Promise<SafeTeardownResult> {
    const targetRunId = options?.runId?.trim() || this.activeRunId;
    if (!targetRunId) {
      throw new SwarmProtocolError("NOT_FOUND", "No Swarm run specified for teardown.");
    }
    const run = await this.store.loadRun(targetRunId);
    const sid = options?.sessionId?.trim();
    if (sid) {
      if (this.store.assertOwnerSession) {
        await this.store.assertOwnerSession(run, sid);
      } else {
        assertOwnerSession(run, sid);
      }
    }
    const force = Boolean(options?.force);
    const isLiveRun = run.status === "active" || run.status === "paused";
    const targets: SafeTeardownTarget[] = [];
    const preSkipped: TeardownEntryResult[] = [];

    for (const member of Object.values(run.members)) {
      if (
        isIsolatedWorktreeWorkspace(member.workspace) &&
        member.cwd &&
        member.branch &&
        member.cwd !== this.worktree.repoRoot
      ) {
        const live = targetRunId === this.activeRunId ? this.liveMembers.get(member.name) : undefined;
        const hasActiveAgent =
          member.state === "working" ||
          Boolean(live?.spawning) ||
          Boolean(live?.waking) ||
          Boolean(live?.turnActive) ||
          Boolean(live?.switchingModel) ||
          live?.handle?.getState() === "working";

        if (!force && member.state !== "killed") {
          if (hasActiveAgent || isLiveRun) {
            preSkipped.push({
              memberName: member.name,
              worktreePath: path.resolve(member.cwd),
              branch: member.branch,
              action: "skipped_active",
              reason: hasActiveAgent
                ? `Member "@${member.name}" has an active running agent.`
                : `Member "@${member.name}" is still ${member.state} in ${run.status} run; kill the member or pass force=true to tear down.`,
            });
            continue;
          }
          if (!member.mergedCommitSha) {
            let commitsAhead = await this.worktree
              .getCommitCountAhead(run.baseBranch, member.branch)
              .catch(() => 0);
            if (commitsAhead === 0 && member.workspace === "branch" && existsSync(member.cwd)) {
              commitsAhead = await this.worktree
                .getCommitCountAhead(run.baseBranch, member.branch, member.cwd)
                .catch(() => 0);
            }
            if (commitsAhead > 0) {
              preSkipped.push({
                memberName: member.name,
                worktreePath: path.resolve(member.cwd),
                branch: member.branch,
                action: "skipped_dirty",
                reason: `Branch "${member.branch}" for "@${member.name}" has ${commitsAhead} unmerged commit(s) ahead of "${run.baseBranch}"; merge or pass force=true to tear down.`,
              });
              continue;
            }
          }
        }

        targets.push({
          memberName: member.name,
          worktreePath: member.cwd,
          branch: member.branch,
          hasActiveAgent,
        });
      }
    }

    const worktreeResult = await this.worktree.safeTeardown(targets, {
      deleteBranches: options?.deleteBranches ?? false,
      force,
    });
    const result: SafeTeardownResult = {
      removed: worktreeResult.removed,
      skipped: [...preSkipped, ...worktreeResult.skipped],
      errors: worktreeResult.errors,
    };

    await this.store.appendEvent({
      runId: run.id,
      type: "teardown_completed",
      actor: ORCHESTRATOR_NAME,
      summary: `Teardown removed ${result.removed.length}, skipped ${result.skipped.length}, errors ${result.errors.length}`,
      data: {
        removed: result.removed.map((r) => r.memberName),
        skipped: result.skipped.map((s) => ({ memberName: s.memberName, action: s.action })),
        errors: result.errors.map((e) => ({ memberName: e.memberName, reason: e.reason })),
      },
    });

    if (!isLiveRun || force) {
      await rm(this.getRunScratchRoot(run.id), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }

    if (this.activeRunId === run.id) {
      await this.refreshCache();
      this.emitEngineEvent("snapshot_changed", `Teardown completed for run ${run.id}.`);
    }

    return result;
  }

  async listModels(options?: {
    all?: boolean;
    hostContext?: ExtensionContext;
  }): Promise<AvailableModelInfo[]> {
    const ctx = options?.hostContext ?? this.hostContext;
    const raw = (await this.transport.listAvailableModels?.(ctx)) ?? [];
    const settings = this.getEffectiveSettings();

    const roleMap = new Map<string, SwarmModelRole[]>();
    const addRole = (model: string | undefined, role: SwarmModelRole): void => {
      const key = model?.trim().toLowerCase();
      if (!key) return;
      const list = roleMap.get(key) ?? [];
      if (!list.includes(role)) {
        list.push(role);
      }
      roleMap.set(key, list);
    };
    addRole(settings.orchestratorModel, "orchestrator");
    addRole(settings.workerModel, "worker");
    addRole(settings.validatorModel, "validator");

    const enriched: AvailableModelInfo[] = raw.map((m) => {
      const roles = [
        ...(roleMap.get(m.fullId.toLowerCase()) ?? []),
        ...(roleMap.get(m.id.toLowerCase()) ?? []),
      ];
      const uniqueRoles = Array.from(new Set(roles));
      return {
        ...m,
        suggested: m.suggested ?? uniqueRoles.length > 0,
        ...(uniqueRoles.length > 0 ? { activeRoles: uniqueRoles } : {}),
      };
    });

    if (options?.all || enriched.length <= 20) {
      return enriched;
    }
    const suggested = enriched.filter((m) => m.suggested || (m.activeRoles?.length ?? 0) > 0);
    return suggested.length > 0 ? suggested : enriched.slice(0, 20);
  }

  getSnapshot(): SwarmSnapshot {
    const run = this.cachedRun;
    const settings = this.getEffectiveSettings();
    const roleModels = buildRoleModelsSnapshot(settings, run?.roleModels);

    let totalTokens = this.monitorTokens;
    let totalCost = this.monitorCost;
    const workingMemberNames: string[] = [];
    const waitingMemberNames: string[] = [];

    if (run) {
      for (const name of run.memberOrder) {
        const m = getOwnMember(run, name);
        if (!m) continue;
        totalTokens += m.tokens;
        totalCost += m.cost;
        const live = this.liveMembers.get(m.name);
        const isWorking =
          m.state === "working" ||
          Boolean(live?.spawning) ||
          Boolean(live?.waking) ||
          Boolean(live?.turnActive) ||
          Boolean(live?.switchingModel) ||
          live?.handle?.getState() === "working";
        if (isWorking && m.state !== "killed") {
          workingMemberNames.push(m.name);
        } else if (m.state === "waiting" && (isReconRun(run) || !m.recon)) {
          waitingMemberNames.push(m.name);
        }
      }
    }

    const backoffUntil = this.rateLimitBreaker.getBackoffUntil();
    return {
      run,
      activeRunId: this.activeRunId,
      workingMemberNames,
      waitingMemberNames,
      boardHead: run?.boardHead ?? 0,
      recentBoard: [...this.cachedBoard],
      recentEvents: [...this.cachedEvents],
      roleModels,
      totalTokens,
      totalCost,
      ...(backoffUntil > 0
        ? {
            rateLimitUntil: backoffUntil,
            rateLimitReason: this.rateLimitBreaker.getLastReason(),
          }
        : {}),
      updatedAt: new Date(this.nowFn()).toISOString(),
    };
  }

  subscribe(listener: (event: SwarmEngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelStallWatchdog();
    await this.cancelActiveMonitor("Engine disposed");
    this.clearOrchestratorWait("Swarm engine disposed.");
    this.resolveAllWaiters("run_ended", "Swarm engine disposed.");
    const prevRunId = this.activeRunId;
    const liveWorkingNames = this.collectLiveWorkingMemberNames();
    this.activeRunId = null;
    this.cachedRun = null;
    await this.persistWorkingMembersStopped(
      prevRunId,
      liveWorkingNames,
      "stopped (engine disposed)",
    );
    await this.disposeLiveHandles("Engine disposed");
    this.listeners.clear();
  }

  // --------------------------------------------------------------------------
  // Internal Member Launch, Wakeup & Turn Lifecycle
  // --------------------------------------------------------------------------

  private async launchMemberInitialTurn(
    runId: string,
    memberName: string,
    briefSeq: number,
    seedMessages: AgentMessage[] | undefined,
    hostContext: ExtensionContext | undefined,
  ): Promise<void> {
    const live = this.liveMembers.get(memberName);
    if (!live || this.disposed) {
      return;
    }

    const launchAbort = new AbortController();
    const attemptToken = Symbol("launch");
    live.launchAbort = launchAbort;
    live.attemptToken = attemptToken;

    const isCurrentAttempt = (): boolean =>
      this.liveMembers.get(memberName) === live && live.attemptToken === attemptToken;

    const isCancelled = (): boolean =>
      this.disposed ||
      this.runDonePosted ||
      this.activeRunId !== runId ||
      !isCurrentAttempt() ||
      launchAbort.signal.aborted;

    let release: (() => void) | undefined;
    const releaseCurrentSlot = (): void => {
      if (release) {
        const fn = release;
        release = undefined;
        fn();
        if (live.releaseSlot === fn) {
          live.releaseSlot = undefined;
        }
      }
    };

    try {
      release = await this.concurrencyGate.acquire(launchAbort.signal);
      if (isCurrentAttempt()) {
        live.releaseSlot = release;
      } else {
        releaseCurrentSlot();
        return;
      }

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.spawning = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const run = await this.store.loadRun(runId);
      const member = getOwnMember(run, memberName);
      if (isCancelled() || !member || member.state === "killed" || member.state === "stopped" || run.status !== "active") {
        if (isCurrentAttempt()) {
          live.spawning = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const readOnlyRecon = Boolean(member.recon || isReconRun(run));
      const validatorScratchDir =
        member.role === "validator" && !readOnlyRecon
          ? this.getMemberScratchDir(runId, member.name)
          : undefined;
      if (validatorScratchDir) {
        await mkdir(validatorScratchDir, { recursive: true }).catch(() => {});
      }

      const systemPrompt = buildMemberSystemPrompt(
        run,
        member,
        validatorScratchDir ? { scratchDir: validatorScratchDir } : undefined,
      );
      const initialPrompt = buildMemberInitialPrompt(run, member, briefSeq);
      const engineApi = this.createMemberBridge(runId, member);
      const isIsolatedWorktree =
        member.workspace !== "inherit" ||
        path.resolve(member.cwd) !== path.resolve(this.store.projectRoot);
      const ownedScope = this.computeMemberFilesOwnedScope(
        run,
        member,
        isIsolatedWorktree,
      );
      live.lastWaitRequest = undefined;
      live.turnStartPostSeq = member.lastPostSeq ?? 0;
      live.lastSilentSummary = undefined;

      const handle = await this.transport.spawnMember({
        agentId: member.agentId,
        name: member.name,
        role: member.role,
        runId,
        cwd: member.cwd,
        branch: member.branch,
        baseBranch: run.baseBranch,
        workspace: member.workspace,
        isIsolatedWorktree,
        ...(ownedScope.filesOwned ? { filesOwned: ownedScope.filesOwned } : {}),
        ...(ownedScope.peerFilesOwned
          ? { peerFilesOwned: ownedScope.peerFilesOwned }
          : {}),
        parentName: member.parentName,
        brief: member.brief,
        channels: member.channels,
        systemPrompt,
        initialPrompt,
        keepWarm: run.keepWorkersWarm,
        modelOverride: member.model,
        thinkingLevel: member.thinkingLevel,
        seedMessages,
        sessionDir: this.store.getMemberSessionDir?.(runId),
        sessionFile: member.sessionFile,
        ...(validatorScratchDir ? { scratchDir: validatorScratchDir } : {}),
        ...(readOnlyRecon ? { readOnlyRecon: true } : {}),
        hostContext,
        onTelemetry: (evt) => this.handleTelemetry(runId, evt),
        engineApi,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.spawning = false;
        }
        await handle.kill("Cancelled during launch").catch(() => {});
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      live.handle = handle;
      live.spawning = false;
      live.turnActive = true;
      this.lastStallAlertHead = null;

      const resolvedModel = handle.getModel();
      if (resolvedModel) {
        live.triedModels.add(resolvedModel);
      }
      const sessionFile = handle.getSessionFile?.() ?? member.sessionFile;

      const startActivity =
        member.role === "validator" ? "validating" : "working on assignment";
      const turnStartedAt = new Date(this.nowFn()).toISOString();
      live.currentActivity = startActivity;
      live.turnStartedAt = turnStartedAt;

      const updated = await this.store.updateMember(runId, memberName, {
        state: "working",
        model: resolvedModel ?? member.model,
        thinkingLevel: handle.getThinkingLevel() ?? member.thinkingLevel ?? null,
        ...(sessionFile ? { sessionFile } : {}),
        currentActivity: startActivity,
        turnStartedAt,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.turnActive = false;
        }
        await handle.kill("Cancelled after launch").catch(() => {});
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }

      this.setCachedRun(updated);
      this.emitEngineEvent("snapshot_changed", `Started @${memberName}`, { memberName });

      const result = await handle.currentTurn;
      const preRecordedDelayMs = this.recordRateLimitBeforeRelease(live, result);
      releaseCurrentSlot();

      await this.handleTurnFinished(runId, memberName, result, attemptToken, preRecordedDelayMs);
    } catch (err) {
      if (isCurrentAttempt()) {
        live.spawning = false;
        live.turnActive = false;
      }
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
      if (isAbortError(err) || isCancelled()) {
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleLaunchError(runId, memberName, errMsg, attemptToken);
    } finally {
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
    }
  }

  private async drainMemberPendingWakes(
    runId: string,
    memberName: string,
    directPrompt?: string,
  ): Promise<void> {
    const live = this.liveMembers.get(memberName);
    if (!live || this.disposed) {
      return;
    }

    const launchAbort = new AbortController();
    const attemptToken = Symbol("wake");
    live.launchAbort = launchAbort;
    live.attemptToken = attemptToken;

    const isCurrentAttempt = (): boolean =>
      this.liveMembers.get(memberName) === live && live.attemptToken === attemptToken;

    const isCancelled = (): boolean =>
      this.disposed ||
      this.runDonePosted ||
      this.activeRunId !== runId ||
      !isCurrentAttempt() ||
      launchAbort.signal.aborted;

    let release: (() => void) | undefined;
    const releaseCurrentSlot = (): void => {
      if (release) {
        const fn = release;
        release = undefined;
        fn();
        if (live.releaseSlot === fn) {
          live.releaseSlot = undefined;
        }
      }
    };

    try {
      release = await this.concurrencyGate.acquire(launchAbort.signal);
      if (isCurrentAttempt()) {
        live.releaseSlot = release;
      } else {
        releaseCurrentSlot();
        return;
      }

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const run = await this.store.loadRun(runId);
      const member = getOwnMember(run, memberName);
      if (
        isCancelled() ||
        !member ||
        member.state === "killed" ||
        (member.state === "stopped" && member.humanStopped) ||
        run.status !== "active"
      ) {
        if (isCurrentAttempt()) {
          live.waking = false;
          live.pendingWakes.length = 0;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const batch = live.pendingWakes.splice(0, live.pendingWakes.length);
      if (batch.length === 0 && !directPrompt) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      // If persisted stopped (non-humanStopped) or no warm waiting handle, revive fresh handle
      if (member.state === "stopped" || !live.handle || live.handle.getState() !== "waiting") {
        live.pendingWakes.unshift(...batch);
        releaseCurrentSlot();
        await this.reviveMemberWithPendingWakes(runId, memberName, directPrompt);
        return;
      }

      const maxSeq = batch.reduce((acc, m) => Math.max(acc, m.seq), member.lastReadSeq);
      const wakeScratchDir =
        member.role === "validator"
          ? this.getMemberScratchDir(runId, member.name)
          : undefined;
      if (wakeScratchDir) {
        await mkdir(wakeScratchDir, { recursive: true }).catch(() => {});
      }
      const wakePromptBody = buildWakeupPrompt(
        member,
        batch,
        run.boardHead,
        wakeScratchDir ? { scratchDir: wakeScratchDir } : undefined,
      );
      const prompt =
        directPrompt && batch.length > 0
          ? `${directPrompt}\n\n${wakePromptBody}`
          : (directPrompt ?? wakePromptBody);

      const wakeTurnStartedAt = new Date(this.nowFn()).toISOString();
      live.parkedMentionsOnly = true;
      live.currentActivity = "woken by board";
      live.turnStartedAt = wakeTurnStartedAt;

      const updated = await this.store.updateMember(runId, memberName, {
        state: "working",
        humanStopped: false,
        lastReadSeq: Math.max(member.lastReadSeq, maxSeq),
        currentActivity: "woken by board",
        turnStartedAt: wakeTurnStartedAt,
        error: null,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
          live.turnActive = false;
        }
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      this.setCachedRun(updated);

      await this.store.appendEvent({
        runId,
        type: "member_woken",
        actor: batch[0]?.from ?? ORCHESTRATOR_NAME,
        memberName: member.name,
        agentId: member.agentId,
        summary:
          batch.length > 0
            ? `Woke @${member.name} with ${batch.length} board message(s) (${batch.map((m) => `#${m.seq}`).join(", ")})`
            : `Woke @${member.name} after model hot-switch`,
      });

      if (isCancelled() || !live.handle || live.handle.getState() !== "waiting") {
        if (isCurrentAttempt()) {
          live.waking = false;
          live.turnActive = false;
        }
        const canRequeue =
          !this.disposed &&
          this.activeRunId === runId &&
          !getOwnMember(this.cachedRun, memberName)?.humanStopped &&
          getOwnMember(this.cachedRun, memberName)?.state !== "killed";
        if (batch.length > 0 && canRequeue) {
          live.pendingWakes.unshift(...batch);
        }
        if (
          !isCancelled() &&
          canRequeue &&
          this.cachedRun?.status === "active" &&
          live.pendingWakes.length > 0 &&
          (!live.handle || live.handle.getState() !== "waiting")
        ) {
          releaseCurrentSlot();
          live.waking = true;
          void this.reviveMemberWithPendingWakes(runId, memberName, directPrompt);
          return;
        }
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      this.emitEngineEvent("snapshot_changed", `Woke @${memberName}`, { memberName });

      this.lastStallAlertHead = null;
      live.turnActive = true;
      live.lastWaitRequest = undefined;
      live.turnStartPostSeq = member.lastPostSeq ?? 0;
      live.lastSilentSummary = undefined;
      let turnPromise: Promise<AgentTurnResult>;
      try {
        turnPromise = live.handle.wake(prompt);
      } catch (wakeErr) {
        if (batch.length > 0) {
          live.pendingWakes.unshift(...batch);
        }
        throw wakeErr;
      }
      for (const m of batch) {
        live.deliveredSeqs.add(m.seq);
      }
      // Handle is now synchronously in `working` state; clear waking lock so new posts queue into pendingWakes!
      live.waking = false;
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }

      const result = await turnPromise;
      const preRecordedDelayMs = this.recordRateLimitBeforeRelease(live, result);
      releaseCurrentSlot();

      await this.handleTurnFinished(runId, memberName, result, attemptToken, preRecordedDelayMs);
    } catch (err) {
      if (isCurrentAttempt()) {
        live.waking = false;
        live.turnActive = false;
      }
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
      if (isAbortError(err) || isCancelled()) {
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleLaunchError(runId, memberName, errMsg, attemptToken);
    } finally {
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
    }
  }

  private async reviveMemberWithPendingWakes(
    runId: string,
    memberName: string,
    directPrompt?: string,
  ): Promise<void> {
    const live = this.liveMembers.get(memberName);
    if (!live || this.disposed) {
      return;
    }

    const launchAbort = new AbortController();
    const attemptToken = Symbol("revive");
    live.launchAbort = launchAbort;
    live.attemptToken = attemptToken;

    const isCurrentAttempt = (): boolean =>
      this.liveMembers.get(memberName) === live && live.attemptToken === attemptToken;

    const isCancelled = (): boolean =>
      this.disposed ||
      this.runDonePosted ||
      this.activeRunId !== runId ||
      !isCurrentAttempt() ||
      launchAbort.signal.aborted;

    let release: (() => void) | undefined;
    const releaseCurrentSlot = (): void => {
      if (release) {
        const fn = release;
        release = undefined;
        fn();
        if (live.releaseSlot === fn) {
          live.releaseSlot = undefined;
        }
      }
    };

    try {
      release = await this.concurrencyGate.acquire(launchAbort.signal);
      if (isCurrentAttempt()) {
        live.releaseSlot = release;
      } else {
        releaseCurrentSlot();
        return;
      }

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const run = await this.store.loadRun(runId);
      const member = getOwnMember(run, memberName);
      if (isCancelled() || !member || member.state === "killed" || run.status !== "active") {
        if (isCurrentAttempt()) {
          live.waking = false;
          live.pendingWakes.length = 0;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const batch = live.pendingWakes.splice(0, live.pendingWakes.length);
      if (batch.length === 0 && !directPrompt) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      // Cleanly dispose any stale handle before spawning replacement
      if (live.handle) {
        live.lastMessages = sanitizeForkSeedMessages(live.handle.getConversationMessages());
        await live.handle.kill("Reviving stopped member").catch(() => {});
        if (isCurrentAttempt()) {
          live.handle = undefined;
        }
      }

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
          if (batch.length > 0 && this.cachedRun?.status === "active") {
            live.pendingWakes.unshift(...batch);
          }
        }
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      const maxSeq = batch.reduce((acc, m) => Math.max(acc, m.seq), member.lastReadSeq);
      const readOnlyRecon = Boolean(member.recon || isReconRun(run));
      const reviveScratchDir =
        member.role === "validator" && !readOnlyRecon
          ? this.getMemberScratchDir(runId, member.name)
          : undefined;
      if (reviveScratchDir) {
        await mkdir(reviveScratchDir, { recursive: true }).catch(() => {});
      }
      const reviveWakeBody = buildWakeupPrompt(
        member,
        batch,
        run.boardHead,
        reviveScratchDir ? { scratchDir: reviveScratchDir } : undefined,
      );
      const prompt =
        directPrompt && batch.length > 0
          ? `${directPrompt}\n\n${reviveWakeBody}`
          : (directPrompt ?? reviveWakeBody);
      const systemPrompt = buildMemberSystemPrompt(
        run,
        member,
        reviveScratchDir ? { scratchDir: reviveScratchDir } : undefined,
      );
      const engineApi = this.createMemberBridge(runId, member);

      // Accumulate persisted usage from prior handle lifetimes before spawning replacement handle
      live.priorHandlesTokens = member.tokens;
      live.priorHandlesBreakdown = member.tokenBreakdown
        ? { ...member.tokenBreakdown }
        : undefined;
      live.priorHandlesCost = member.cost;
      const isIsolatedWorktree =
        member.workspace !== "inherit" ||
        path.resolve(member.cwd) !== path.resolve(this.store.projectRoot);
      const reviveOwnedScope = this.computeMemberFilesOwnedScope(
        run,
        member,
        isIsolatedWorktree,
      );
      live.lastWaitRequest = undefined;
      live.turnStartPostSeq = member.lastPostSeq ?? 0;
      live.lastSilentSummary = undefined;

      let handle: PersistentAgentHandle;
      try {
        // Auto-recover missing or broken (missing `.git`) isolated worktree from existing branch before spawning replacement session
        if (
          isIsolatedWorktreeWorkspace(member.workspace) &&
          member.cwd &&
          member.cwd !== this.worktree.repoRoot &&
          member.branch &&
          (!existsSync(member.cwd) || !existsSync(path.join(member.cwd, ".git")))
        ) {
          await this.worktree.createWorktree({
            branch: member.branch,
            baseBranch: run.baseBranch,
            worktreePath: member.cwd,
            reuseExistingBranch: true,
            mode: member.workspace,
          });
          const reviveInitRes = await this.executeWorktreeInitCommand(run, member.cwd);
          if (!reviveInitRes.ok && reviveInitRes.warning) {
            live.logTail = [...live.logTail, reviveInitRes.warning].slice(-50);
            await this.store
              .updateMember(runId, memberName, { logLine: reviveInitRes.warning })
              .catch(() => {});
          }
          if (isCancelled()) {
            if (isCurrentAttempt()) {
              live.waking = false;
              if (batch.length > 0 && this.cachedRun?.status === "active") {
                live.pendingWakes.unshift(...batch);
              }
            }
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
        }
        handle = await this.transport.spawnMember({
          agentId: member.agentId,
          name: member.name,
          role: member.role,
          runId,
          cwd: member.cwd,
          branch: member.branch,
          baseBranch: run.baseBranch,
          workspace: member.workspace,
          isIsolatedWorktree,
          ...(reviveOwnedScope.filesOwned
            ? { filesOwned: reviveOwnedScope.filesOwned }
            : {}),
          ...(reviveOwnedScope.peerFilesOwned
            ? { peerFilesOwned: reviveOwnedScope.peerFilesOwned }
            : {}),
          parentName: member.parentName,
          brief: member.brief,
          channels: member.channels,
          systemPrompt,
          initialPrompt: prompt,
          keepWarm: run.keepWorkersWarm,
          modelOverride: member.model,
          thinkingLevel: member.thinkingLevel,
          seedMessages: live.lastMessages.length > 0 ? live.lastMessages : undefined,
          sessionDir: this.store.getMemberSessionDir?.(runId),
          sessionFile: member.sessionFile,
          ...(reviveScratchDir ? { scratchDir: reviveScratchDir } : {}),
          ...(readOnlyRecon ? { readOnlyRecon: true } : {}),
          hostContext: this.hostContext,
          onTelemetry: (evt) => this.handleTelemetry(runId, evt),
          engineApi,
        });
      } catch (spawnErr) {
        if (batch.length > 0) {
          live.pendingWakes.unshift(...batch);
        }
        throw spawnErr;
      }

      // Critically check cancellation IMMEDIATELY after spawnMember so stopped/killed/paused/disposed runs never leak handles!
      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.waking = false;
        }
        await handle.kill("Cancelled during revive").catch(() => {});
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      for (const m of batch) {
        live.deliveredSeqs.add(m.seq);
      }
      const reviveTurnStartedAt = new Date(this.nowFn()).toISOString();
      live.handle = handle;
      live.turnActive = true;
      live.waking = false;
      live.parkedMentionsOnly = true;
      live.currentActivity = "revived by board";
      live.turnStartedAt = reviveTurnStartedAt;
      const latestSessionFile = handle.getSessionFile?.() ?? member.sessionFile;

      const updated = await this.store.updateMember(runId, memberName, {
        state: "working",
        humanStopped: false,
        lastReadSeq: Math.max(member.lastReadSeq, maxSeq),
        ...(latestSessionFile ? { sessionFile: latestSessionFile } : {}),
        currentActivity: "revived by board",
        turnStartedAt: reviveTurnStartedAt,
        error: null,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.turnActive = false;
        }
        await handle.kill("Cancelled after revive").catch(() => {});
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      this.setCachedRun(updated);

      await this.store.appendEvent({
        runId,
        type: "member_woken",
        actor: batch[0]?.from ?? ORCHESTRATOR_NAME,
        memberName: member.name,
        agentId: member.agentId,
        summary: `Revived @${member.name} with ${batch.length} board message(s)`,
      });

      if (isCancelled()) {
        if (isCurrentAttempt()) {
          live.turnActive = false;
        }
        await handle.kill("Cancelled after revive").catch(() => {});
        await this.ensureNotResurrectedAfterCancel(runId, memberName, attemptToken);
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }

      this.lastStallAlertHead = null;
      this.emitEngineEvent("snapshot_changed", `Revived @${memberName}`, { memberName });

      const result = await handle.currentTurn;
      const preRecordedDelayMs = this.recordRateLimitBeforeRelease(live, result);
      releaseCurrentSlot();

      await this.handleTurnFinished(runId, memberName, result, attemptToken, preRecordedDelayMs);
    } catch (err) {
      if (isCurrentAttempt()) {
        live.waking = false;
        live.turnActive = false;
      }
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
      if (isAbortError(err) || isCancelled()) {
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.handleLaunchError(runId, memberName, errMsg, attemptToken);
    } finally {
      if (live.launchAbort === launchAbort) {
        live.launchAbort = undefined;
      }
      releaseCurrentSlot();
    }
  }

  private async ensureNotResurrectedAfterCancel(
    runId: string,
    memberName: string,
    attemptToken?: symbol,
  ): Promise<void> {
    if (this.disposed) return;
    if (attemptToken && this.liveMembers.get(memberName)?.attemptToken !== attemptToken) {
      return;
    }
    try {
      const current = await this.store.loadRun(runId);
      if (attemptToken && this.liveMembers.get(memberName)?.attemptToken !== attemptToken) {
        return;
      }
      const m = getOwnMember(current, memberName);
      if (m && m.state === "working") {
        const reverted = await this.store.updateMember(runId, memberName, {
          state: "stopped",
          currentActivity: null,
          turnStartedAt: null,
        });
        this.setCachedRun(reverted);
      }
    } catch {
      // ignore cleanup error
    }
  }

  private recordRateLimitBeforeRelease(
    live: LiveMember | undefined,
    result: AgentTurnResult,
  ): number | undefined {
    if (result.outcome !== "rate_limited") {
      return undefined;
    }
    const settings = this.getEffectiveSettings();
    const effectiveModel = result.model ?? live?.handle?.getModel();
    const fallback = selectFallbackModel(
      effectiveModel,
      settings.fallbackModels,
      live?.triedModels,
    );
    if (fallback) {
      return undefined;
    }
    return this.rateLimitBreaker.recordRateLimit(
      result.retryAfterMs,
      result.error ?? "Provider rate limited (429)",
    );
  }

  private async handleTurnFinished(
    runId: string,
    memberName: string,
    result: AgentTurnResult,
    attemptToken?: symbol,
    preRecordedDelayMs?: number,
  ): Promise<void> {
    const live = this.liveMembers.get(memberName);
    if (this.disposed || this.activeRunId !== runId) {
      if (live && (!attemptToken || live.attemptToken === attemptToken)) {
        live.turnActive = false;
      }
      return;
    }
    if (attemptToken && (!live || live.attemptToken !== attemptToken)) {
      return;
    }

    if (live?.handle) {
      live.lastMessages = sanitizeForkSeedMessages(live.handle.getConversationMessages());
    }

    const run = await this.store.loadRun(runId);
    const currentLive = this.liveMembers.get(memberName);
    if (this.disposed || this.activeRunId !== runId) {
      return;
    }
    if (attemptToken && (!currentLive || currentLive.attemptToken !== attemptToken)) {
      return;
    }
    const member = getOwnMember(run, memberName);
    if (!member || member.state === "killed") {
      if (currentLive) currentLive.turnActive = false;
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }
    if (!currentLive || !currentLive.turnActive) {
      // Stopped/paused concurrently while loadRun was in flight; never overwrite stopped back to waiting.
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    const isStillValidTurn = (): boolean =>
      !this.disposed &&
      !this.runDonePosted &&
      this.activeRunId === runId &&
      this.cachedRun?.status === "active" &&
      Boolean(live) &&
      this.liveMembers.get(memberName) === live &&
      (!attemptToken || live!.attemptToken === attemptToken);

    const waitReq = live?.lastWaitRequest;
    if (live) {
      live.lastWaitRequest = undefined;
      live.currentActivity = undefined;
      live.turnStartedAt = undefined;
    }

    const nextTurns = member.turns + 1;
    const nextLlmTurns = Math.max(member.llmTurns ?? 0, live?.liveLlmTurns ?? 0);
    const nextTokens = Math.max(
      member.tokens,
      live?.liveTokens ?? 0,
      (live?.priorHandlesTokens ?? 0) + result.tokens,
    );
    const nextTokenBreakdown = maxTokenBreakdown(
      live?.liveTokenBreakdown ?? member.tokenBreakdown,
      mergeTokenBreakdown(live?.priorHandlesBreakdown, result.tokenBreakdown),
    );
    const nextCost = Math.max(
      member.cost,
      live?.liveCost ?? 0,
      (live?.priorHandlesCost ?? 0) + result.cost,
    );
    const nextLastReadSeq = Math.max(
      member.lastReadSeq,
      live?.lastReadSeq ?? 0,
      waitReq?.since ?? 0,
      member.lastPostSeq ?? 0,
    );
    if (live) {
      live.liveTokens = nextTokens;
      live.liveTokenBreakdown = nextTokenBreakdown;
      live.liveCost = nextCost;
      live.liveLlmTurns = nextLlmTurns;
    }
    const effectiveModel = result.model ?? live?.handle?.getModel() ?? member.model;
    const effectiveThinking =
      result.thinkingLevel ?? live?.handle?.getThinkingLevel() ?? member.thinkingLevel;
    const latestSessionFile =
      (currentLive?.handle ?? live?.handle)?.getSessionFile?.() ?? member.sessionFile;
    const persistedTelemetry = {
      ...(nextLlmTurns > 0 ? { llmTurns: nextLlmTurns } : {}),
      turnStartedAt: null as null,
      ...(latestSessionFile ? { sessionFile: latestSessionFile } : {}),
      ...(live && live.logTail.length > 0 ? { logTail: [...live.logTail] } : {}),
      ...(live?.lastTool !== undefined ? { lastTool: live.lastTool } : {}),
    };

    if (result.outcome === "killed") {
      const nowIso = new Date(this.nowFn()).toISOString();
      const updated = await this.store.updateMember(runId, memberName, {
        state: "killed",
        turns: nextTurns,
        tokens: nextTokens,
        tokenBreakdown: nextTokenBreakdown,
        cost: nextCost,
        model: effectiveModel,
        thinkingLevel: effectiveThinking ?? null,
        currentActivity: null,
        parkedOn: result.summary || "killed",
        endedAt: nowIso,
        ...persistedTelemetry,
      });
      this.liveMembers.delete(memberName);
      await this.refreshCache(updated);
      this.emitEngineEvent("snapshot_changed", `@${memberName} killed`, { memberName });
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    if (result.outcome === "stopped") {
      const isNormalStop = result.stopReason !== "aborted";
      if (isNormalStop) {
        this.rateLimitBreaker.recordSuccess();
      }
      const normalizedSummary = (result.summary ?? "").replace(/\s+/g, " ").trim();
      const parkedOn = isNormalStop
        ? normalizedSummary.slice(0, 240) || "stopped"
        : result.summary?.slice(0, 120) || "stopped";
      if (
        isNormalStop &&
        live &&
        !waitReq &&
        (member.lastPostSeq ?? 0) <= (live.turnStartPostSeq ?? 0) &&
        normalizedSummary.length > 0
      ) {
        live.lastSilentSummary = normalizedSummary.slice(0, 300);
      }
      const updated = await this.store.updateMember(runId, memberName, {
        state: "stopped",
        turns: nextTurns,
        tokens: nextTokens,
        tokenBreakdown: nextTokenBreakdown,
        cost: nextCost,
        model: effectiveModel,
        thinkingLevel: effectiveThinking ?? null,
        ...(isNormalStop
          ? { lastReadSeq: nextLastReadSeq }
          : {}),
        currentActivity: null,
        parkedOn,
        ...persistedTelemetry,
      });
      await this.refreshCache(updated);
      if (live) {
        live.parkedMentionsOnly = true;
        if (result.stopReason !== "aborted") {
          live.retryCount = 0;
          live.lastReadSeq = nextLastReadSeq;
        }
      }

      // Deferred Self Model Switch when keepWorkersWarm === false: execute model switch and revive onto new model.
      if (
        live?.pendingSelfModelSwitch &&
        !getOwnMember(updated, memberName)?.humanStopped &&
        isStillValidTurn()
      ) {
        const pendingSwitch = live.pendingSelfModelSwitch;
        live.pendingSelfModelSwitch = undefined;
        live.switchingModel = true;
        live.turnActive = false;
        try {
          const switched = await this.performSwitchModel(
            {
              targetName: memberName,
              model: pendingSwitch.model,
              thinkingLevel: pendingSwitch.thinkingLevel,
              reason: pendingSwitch.reason,
              callerName: pendingSwitch.callerName,
              callerRole: pendingSwitch.callerRole,
              autoResume: false,
              silentBoardNotice: pendingSwitch.silentBoardNotice,
              fromRolePropagation: pendingSwitch.fromRolePropagation,
            },
            { holdSwitchingLock: true },
          );
          if (
            !isStillValidTurn() ||
            !live.switchingModel ||
            getOwnMember(this.cachedRun, memberName)?.humanStopped
          ) {
            live.switchingModel = false;
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          live.switchingModel = false;
          if (pendingSwitch.autoResume !== false) {
            live.waking = true;
            this.cancelStallWatchdog();
            void this.cancelActiveMonitor("Swarm activity resumed");
            const reasonNote = pendingSwitch.reason ? ` (${pendingSwitch.reason})` : "";
            const isSelfSwitch = pendingSwitch.callerName === memberName;
            const resumeMsg = `${isSelfSwitch ? "Self model switch" : "Model switch"} to "${switched.model}"${switched.thinkingLevel ? ` (${switched.thinkingLevel})` : ""} completed${reasonNote} with conversation history preserved. Continue your work immediately.`;
            void this.reviveMemberWithPendingWakes(runId, memberName, resumeMsg);
            return;
          }
          // When autoResume is false (e.g. role-level propagation), fall through so member stays parked or drains wakes!
        } catch (err) {
          live.switchingModel = false;
          live.pendingWakes.length = 0;
          const switchErr = err instanceof Error ? err.message : String(err);
          if (isStillValidTurn()) {
            await this.postMonitorOrchestratorAlert(
              runId,
              `@${ORCHESTRATOR_NAME} [error] Deferred self model switch for @${memberName} failed: ${switchErr}`,
              "update",
            );
          }
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
          return;
        }
      }

      if (
        live &&
        live.pendingWakes.length > 0 &&
        isStillValidTurn() &&
        !getOwnMember(this.cachedRun, memberName)?.humanStopped &&
        result.stopReason !== "aborted"
      ) {
        live.pendingSelfModelSwitch = undefined;
        live.turnActive = false;
        live.waking = true;
        this.cancelStallWatchdog();
        void this.cancelActiveMonitor("Swarm activity resumed");
        this.emitEngineEvent("snapshot_changed", `@${memberName} stopped`, { memberName });
        void this.reviveMemberWithPendingWakes(runId, memberName);
        return;
      }

      if (live) {
        live.pendingSelfModelSwitch = undefined;
        live.turnActive = false;
      }
      this.emitEngineEvent("snapshot_changed", `@${memberName} stopped`, { memberName });
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    if (result.outcome === "waiting") {
      this.rateLimitBreaker.recordSuccess();
      const normalizedSummary = (result.summary ?? "").replace(/\s+/g, " ").trim();
      const parkedOn = waitReq
        ? `waiting (since #${waitReq.since})`
        : normalizedSummary.slice(0, 240) || "waiting";
      if (
        result.stopReason !== "aborted" &&
        live &&
        !waitReq &&
        (member.lastPostSeq ?? 0) <= (live.turnStartPostSeq ?? 0) &&
        normalizedSummary.length > 0
      ) {
        live.lastSilentSummary = normalizedSummary.slice(0, 300);
      }

      const updated = await this.store.updateMember(runId, memberName, {
        state: "waiting",
        turns: nextTurns,
        tokens: nextTokens,
        tokenBreakdown: nextTokenBreakdown,
        cost: nextCost,
        model: effectiveModel,
        thinkingLevel: effectiveThinking ?? null,
        lastReadSeq: nextLastReadSeq,
        parkedOn,
        currentActivity: null,
        error: null,
        ...persistedTelemetry,
      });
      await this.refreshCache(updated);

      // Remember whether this parked member asked for mentions_only=false so future non-mention posts wake it!
      if (live) {
        live.retryCount = 0;
        live.lastReadSeq = nextLastReadSeq;
        live.parkedMentionsOnly = waitReq ? waitReq.mentionsOnly : true;
      }

      // Deferred Self Model Switch (Defect #3): if this member scheduled `swarm{action:"model"}` on itself
      // during this turn, apply the hot switch NOW while parked in waiting, then immediately resume it!
      if (
        live?.pendingSelfModelSwitch &&
        live.handle?.getState() === "waiting" &&
        isStillValidTurn() &&
        !getOwnMember(this.cachedRun, memberName)?.humanStopped
      ) {
        const pendingSwitch = live.pendingSelfModelSwitch;
        live.pendingSelfModelSwitch = undefined;
        live.switchingModel = true;
        live.turnActive = false;
        try {
          const switched = await this.performSwitchModel(
            {
              targetName: memberName,
              model: pendingSwitch.model,
              thinkingLevel: pendingSwitch.thinkingLevel,
              reason: pendingSwitch.reason,
              callerName: pendingSwitch.callerName,
              callerRole: pendingSwitch.callerRole,
              autoResume: false,
              silentBoardNotice: pendingSwitch.silentBoardNotice,
              fromRolePropagation: pendingSwitch.fromRolePropagation,
            },
            { holdSwitchingLock: true },
          );
          if (
            !isStillValidTurn() ||
            !live.switchingModel ||
            getOwnMember(this.cachedRun, memberName)?.humanStopped
          ) {
            live.switchingModel = false;
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          live.switchingModel = false;
          if (pendingSwitch.autoResume !== false) {
            live.waking = true;
            this.cancelStallWatchdog();
            void this.cancelActiveMonitor("Swarm activity resumed");
            const reasonNote = pendingSwitch.reason ? ` (${pendingSwitch.reason})` : "";
            const resumeMsg = `Self model hot-switch to "${switched.model}"${switched.thinkingLevel ? ` (${switched.thinkingLevel})` : ""} completed${reasonNote} with full conversation history preserved. Continue your work immediately.`;
            void this.drainMemberPendingWakes(runId, memberName, resumeMsg);
            return;
          }
          // When autoResume is false (e.g. human role-level propagation), fall through
          // to drain any queued wakes on the new model or park cleanly in waiting.
        } catch (err) {
          live.switchingModel = false;
          const switchErr = err instanceof Error ? err.message : String(err);
          if (isStillValidTurn()) {
            await this.postMonitorOrchestratorAlert(
              runId,
              `@${ORCHESTRATOR_NAME} [error] Deferred self model switch for @${memberName} failed: ${switchErr}`,
              "update",
            );
          }
          if (
            live.pendingWakes.length > 0 &&
            live.handle?.getState() === "waiting" &&
            isStillValidTurn() &&
            !getOwnMember(this.cachedRun, memberName)?.humanStopped
          ) {
            live.waking = true;
            this.cancelStallWatchdog();
            void this.cancelActiveMonitor("Swarm activity resumed");
            void this.drainMemberPendingWakes(runId, memberName);
            return;
          }
          live.pendingWakes.length = 0;
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
          return;
        }
      }

      if (live) {
        live.pendingSelfModelSwitch = undefined;
        if (waitReq && live.pendingWakes.length > 0) {
          const readFloor = Math.min(waitReq.since, live.lastReadSeq ?? 0);
          if (readFloor > 0) {
            live.pendingWakes = live.pendingWakes.filter((w) => {
              if (w.seq <= readFloor) {
                live.deliveredSeqs.add(w.seq);
                return false;
              }
              return true;
            });
          }
        }
      }

      // Check for unread non-mention messages if the member explicitly called swarm_wait{mentions_only:false}
      if (live && waitReq && !waitReq.mentionsOnly && isStillValidTurn()) {
        const unread = await this.store.readBoard(runId, {
          since: Math.max(waitReq.since, member.briefSeq ?? 0, member.lastReadSeq),
          memberChannels: member.channels,
          limit: 50,
        });
        if (
          !isStillValidTurn() ||
          !live.turnActive ||
          getOwnMember(this.cachedRun, memberName)?.humanStopped
        ) {
          live.turnActive = false;
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
          return;
        }
        for (const msg of unread.messages) {
          if (
            msg.from !== memberName &&
            !live.deliveredSeqs.has(msg.seq) &&
            !live.pendingWakes.some((w) => w.seq === msg.seq)
          ) {
            live.pendingWakes.push(msg);
          }
        }
      }

      // Atomically hand off turnActive -> waking if any wakes coalesced while working/finishing!
      if (live && live.pendingWakes.length > 0 && isStillValidTurn()) {
        live.turnActive = false;
        live.waking = true;
        this.cancelStallWatchdog();
        void this.cancelActiveMonitor("Swarm activity resumed");
        this.emitEngineEvent("snapshot_changed", `@${memberName} parked in waiting`, {
          memberName,
        });
        void this.drainMemberPendingWakes(runId, memberName);
        return;
      }

      if (live) live.turnActive = false;
      this.emitEngineEvent("snapshot_changed", `@${memberName} parked in waiting`, {
        memberName,
      });
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    if (result.outcome === "rate_limited") {
      if (live) {
        live.pendingSelfModelSwitch = undefined;
        if (effectiveModel) {
          live.triedModels.add(effectiveModel);
        }
      }

      const settings = this.getEffectiveSettings();
      const errorText = result.error ?? "Provider rate limited (429)";
      const nextState = live?.handle?.getState() === "waiting" ? "waiting" : "stopped";

      const updated = await this.store.updateMember(runId, memberName, {
        state: nextState,
        turns: nextTurns,
        tokens: nextTokens,
        tokenBreakdown: nextTokenBreakdown,
        cost: nextCost,
        model: effectiveModel,
        thinkingLevel: effectiveThinking ?? null,
        currentActivity: null,
        parkedOn: `rate limited: ${errorText.slice(0, 80)}`,
        error: errorText,
        ...persistedTelemetry,
      });
      await this.refreshCache(updated);

      // Attempt automatic hot-switch to next untried fallback model with ZERO lock gap!
      const fallback = selectFallbackModel(
        effectiveModel,
        settings.fallbackModels,
        live?.triedModels,
      );
      const canRecoverColdOrWarm =
        live &&
        isStillValidTurn() &&
        !getOwnMember(this.cachedRun, memberName)?.humanStopped &&
        (live.handle?.getState() === "waiting" ||
          !live.handle ||
          live.handle.getState() === "stopped");
      if (fallback && canRecoverColdOrWarm) {
        const parsedFallback = parseModelSpec(fallback);
        live.triedModels.add(parsedFallback.model || fallback);
        // Atomic handoff: turnActive -> switchingModel (prevents concurrent @mention from racing wake!)
        live.switchingModel = true;
        live.turnActive = false;
        try {
          const fbSwitched = await this.performSwitchModel(
            {
              targetName: memberName,
              model: parsedFallback.model || fallback,
              thinkingLevel: parsedFallback.thinkingLevel,
              reason: `Auto-fallback after rate limit (${errorText})`,
              callerName: ORCHESTRATOR_NAME,
              callerRole: "orchestrator",
              autoResume: false,
            },
            { holdSwitchingLock: true },
          );
          if (
            !isStillValidTurn() ||
            !live.switchingModel ||
            getOwnMember(this.cachedRun, memberName)?.humanStopped
          ) {
            live.switchingModel = false;
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          // Atomic handoff: switchingModel -> waking!
          live.waking = true;
          live.switchingModel = false;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          const fbPrompt = `Model automatically hot-switched to "${fbSwitched.model}"${fbSwitched.thinkingLevel ? ` (${fbSwitched.thinkingLevel})` : ""} after provider rate limit (${errorText}). Continue your work with your preserved conversation history.`;
          if (live.handle?.getState() === "waiting") {
            void this.drainMemberPendingWakes(runId, memberName, fbPrompt);
          } else {
            void this.reviveMemberWithPendingWakes(runId, memberName, fbPrompt);
          }
          return;
        } catch {
          live.switchingModel = false;
          if (!isStillValidTurn()) {
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          // Re-acquire turnActive lock while scheduling backoff/retry below
          live.turnActive = true;
        }
      }

      if (live && !isStillValidTurn()) {
        live.turnActive = false;
        this.checkAllIdleAndNotifyWaiters();
        this.maybeArmStallWatchdog();
        return;
      }

      // Engage shared fleet rate-limit breaker (reusing delay if already recorded before slot release)
      const delayMs =
        preRecordedDelayMs ?? this.rateLimitBreaker.recordRateLimit(result.retryAfterMs, errorText);
      await this.store.appendEvent({
        runId,
        type: "rate_limit_backoff",
        actor: MONITOR_NAME,
        memberName,
        agentId: member.agentId,
        summary: `Rate-limit backoff (${Math.ceil(delayMs / 1000)}s) after ${memberName} hit: ${errorText}`,
        data: {
          delayMs,
          error: errorText,
          model: effectiveModel,
          retryCount: live?.retryCount ?? 0,
          maxRetries: settings.maxRetries,
        },
      });

      // Automatic backoff retry when `settings.maxRetries` allows and member can be woken/revived
      if (
        live &&
        (live.handle?.getState() === "waiting" ||
          !live.handle ||
          live.handle.getState() === "stopped") &&
        isStillValidTurn() &&
        live.turnActive &&
        !getOwnMember(this.cachedRun, memberName)?.humanStopped &&
        settings.maxRetries > 0 &&
        live.retryCount < settings.maxRetries
      ) {
        this.cancelMemberRetryTimer(live);
        live.retryCount += 1;
        const attempt = live.retryCount;
        const maxRetries = settings.maxRetries;
        const backoffSecs = Math.max(1, Math.ceil(delayMs / 1000));
        const parkedLabel = `rate limited; auto-retry ${attempt}/${maxRetries} in ${backoffSecs}s`;

        const scheduledRun = await this.store.updateMember(runId, memberName, {
          parkedOn: parkedLabel,
        });
        await this.refreshCache(scheduledRun);

        if (
          !isStillValidTurn() ||
          !live.turnActive ||
          getOwnMember(this.cachedRun, memberName)?.humanStopped ||
          (live.handle && live.handle.getState() !== "waiting" && live.handle.getState() !== "stopped")
        ) {
          live.turnActive = false;
          this.checkAllIdleAndNotifyWaiters();
          this.maybeArmStallWatchdog();
          return;
        }

        live.retryTimer = setTimeout(() => {
          live.retryTimer = undefined;
          const isWarmWaiting = live.handle?.getState() === "waiting";
          const isColdRecoverable = !live.handle || live.handle.getState() === "stopped";
          if (
            this.disposed ||
            this.activeRunId !== runId ||
            this.cachedRun?.status !== "active" ||
            this.liveMembers.get(memberName) !== live ||
            (!isWarmWaiting && !isColdRecoverable) ||
            live.spawning ||
            live.waking ||
            live.turnActive ||
            live.switchingModel
          ) {
            this.checkAllIdleAndNotifyWaiters();
            this.maybeArmStallWatchdog();
            return;
          }
          live.waking = true;
          this.cancelStallWatchdog();
          void this.cancelActiveMonitor("Swarm activity resumed");
          const retryPrompt = `Rate-limit backoff elapsed (automatic retry ${attempt}/${maxRetries} after ${errorText}). Continue your work from where you left off.`;
          if (isWarmWaiting) {
            void this.drainMemberPendingWakes(runId, memberName, retryPrompt);
          } else {
            void this.reviveMemberWithPendingWakes(runId, memberName, retryPrompt);
          }
        }, delayMs);
        live.retryTimer.unref?.();
        live.turnActive = false;

        this.emitEngineEvent(
          "snapshot_changed",
          `Scheduled retry ${attempt}/${maxRetries} for @${memberName} in ${backoffSecs}s`,
          { memberName },
        );
        return;
      }

      if (live) {
        live.turnActive = false;
      }
      if (isStillValidTurn()) {
        await this.postMonitorOrchestratorAlert(
          runId,
          `@${ORCHESTRATOR_NAME} [rate-limit] Member ${memberName} hit rate limit (${errorText}); backoff ${Math.ceil(delayMs / 1000)}s. Hot-switch with swarm{action:"model"} or message member to retry.`,
          "update",
        );
      }
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
      return;
    }

    // `failed` -> park in `waiting` (when warm handle alive) with error recorded so Orchestrator can hot-switch or retry!
    const errorText = result.error ?? "Member turn failed";
    const parkedState = live?.handle?.getState() === "waiting" ? "waiting" : "stopped";
    const updated = await this.store.updateMember(runId, memberName, {
      state: parkedState,
      turns: nextTurns,
      tokens: nextTokens,
      tokenBreakdown: nextTokenBreakdown,
      cost: nextCost,
      model: effectiveModel,
      thinkingLevel: effectiveThinking ?? null,
      currentActivity: null,
      parkedOn: `error: ${errorText.slice(0, 100)}`,
      error: errorText,
      ...persistedTelemetry,
    });
    await this.store.appendEvent({
      runId,
      type: "member_error",
      actor: memberName,
      memberName,
      agentId: member.agentId,
      summary: `Member ${memberName} failed: ${errorText}`,
      data: { error: errorText, stopReason: result.stopReason },
    });
    await this.refreshCache(updated);
    if (live) {
      live.pendingSelfModelSwitch = undefined;
      live.turnActive = false;
    }
    if (isStillValidTurn()) {
      const assignedInProgress = (updated.features ?? [])
        .filter((f) => f.assignedMember === memberName && f.status === "in_progress")
        .map((f) => f.id);
      const featHint =
        assignedInProgress.length > 0
          ? ` (feature ${assignedInProgress.join(", ")} remains in_progress for retry)`
          : "";
      await this.postMonitorOrchestratorAlert(
        runId,
        `@${ORCHESTRATOR_NAME} [error] Member ${memberName} encountered an error${featHint}: ${errorText}. Switch its model or message it to retry.`,
        "update",
      );
    }
    this.checkAllIdleAndNotifyWaiters();
    this.maybeArmStallWatchdog();
  }

  private async handleLaunchError(
    runId: string,
    memberName: string,
    errMsg: string,
    attemptToken?: symbol,
  ): Promise<void> {
    if (this.disposed || this.activeRunId !== runId) {
      return;
    }
    const live = this.liveMembers.get(memberName);
    if (attemptToken && live && live.attemptToken !== attemptToken) {
      return;
    }
    if (live) {
      live.pendingSelfModelSwitch = undefined;
    }
    try {
      const latestRun = await this.store.loadRun(runId);
      const current = getOwnMember(latestRun, memberName);
      if (live && (!current || current.state === "killed" || current.humanStopped)) {
        live.pendingWakes.length = 0;
      }
      // Never resurrect killed or stopped members back to "waiting"!
      if (!current || current.state === "killed" || current.state === "stopped") {
        this.setCachedRun(latestRun);
        return;
      }
      const nextState = live?.handle?.getState() === "waiting" ? "waiting" : "stopped";
      if (live) {
        live.turnStartedAt = undefined;
      }
      const updated = await this.store.updateMember(runId, memberName, {
        state: nextState,
        currentActivity: null,
        turnStartedAt: null,
        parkedOn: `launch error: ${errMsg.slice(0, 100)}`,
        error: errMsg,
      });
      await this.store.appendEvent({
        runId,
        type: "member_error",
        actor: memberName,
        memberName,
        summary: `Launch error for ${memberName}: ${errMsg}`,
        data: { error: errMsg },
      });
      await this.refreshCache(updated);
      const assignedInProgress = (updated.features ?? [])
        .filter((f) => f.assignedMember === memberName && f.status === "in_progress")
        .map((f) => f.id);
      const featHint =
        assignedInProgress.length > 0
          ? ` (feature ${assignedInProgress.join(", ")} remains in_progress for retry)`
          : "";
      await this.postMonitorOrchestratorAlert(
        runId,
        `@${ORCHESTRATOR_NAME} [error] Member ${memberName} failed to launch${featHint}: ${errMsg}`,
        "update",
      );
    } catch {
      // avoid cascading errors
    } finally {
      this.checkAllIdleAndNotifyWaiters();
      this.maybeArmStallWatchdog();
    }
  }

  // --------------------------------------------------------------------------
  // Board Wakeup Routing & Coalescing
  // --------------------------------------------------------------------------

  private hasDagReadyPendingFeatures(run: SwarmRunState): boolean {
    const features = run.features ?? [];
    if (features.length === 0 || !features.some((f) => f.status === "pending")) {
      return false;
    }

    const orderedMilestoneLabels: string[] = [];
    const seenMs = new Set<string>();
    for (const m of run.milestones ?? []) {
      const lbl = m.label.trim();
      if (lbl && !seenMs.has(lbl)) {
        seenMs.add(lbl);
        orderedMilestoneLabels.push(lbl);
      }
    }
    for (const f of features) {
      const lbl = f.milestone.trim();
      if (lbl && !seenMs.has(lbl)) {
        seenMs.add(lbl);
        orderedMilestoneLabels.push(lbl);
      }
    }
    const activeMilestoneLabel = orderedMilestoneLabels.find((lbl) =>
      features.some(
        (f) =>
          f.milestone.trim() === lbl &&
          (f.status === "pending" ||
            f.status === "in_progress" ||
            f.status === "failed"),
      ),
    );

    const featureById = new Map(features.map((f) => [f.id, f]));
    const activeCollisionFeatures = features.filter((f) => {
      if (f.status === "in_progress") return true;
      if (f.status === "failed" && f.assignedMember && !f.mergedCommitSha) {
        const assigned = getOwnMember(run, f.assignedMember);
        if (assigned && assigned.state !== "killed") {
          return true;
        }
      }
      return false;
    });

    for (const feat of features) {
      if (feat.status !== "pending") continue;
      if (activeMilestoneLabel && feat.milestone.trim() !== activeMilestoneLabel) {
        continue;
      }
      const depsSatisfied = (feat.dependsOn ?? []).every((depId) => {
        const dep = featureById.get(depId);
        return Boolean(
          dep && (dep.status === "completed" || dep.status === "cancelled"),
        );
      });
      if (!depsSatisfied) continue;
      const featOwned = effectiveDispatchOwnedPaths(feat);
      const collidesWithActive = activeCollisionFeatures.some((active) =>
        ownedPathsOverlap(featOwned, effectiveDispatchOwnedPaths(active)),
      );
      if (!collidesWithActive) {
        return true;
      }
    }

    return false;
  }

  private computeMemberFilesOwnedScope(
    run: SwarmRunState | null | undefined,
    member: SwarmMemberRecord,
    isIsolatedWorktree: boolean,
  ): { filesOwned?: string[]; peerFilesOwned?: Record<string, string[]> } {
    if (
      !run ||
      member.workspace !== "inherit" ||
      isIsolatedWorktree ||
      member.recon ||
      isReconRun(run) ||
      member.role !== "worker"
    ) {
      return {};
    }
    const features = run.features ?? [];
    if (features.length === 0) {
      return {};
    }
    const assigned = features.filter(
      (f) => f.status !== "cancelled" && f.assignedMember === member.name,
    );
    if (assigned.length === 0) {
      return {};
    }

    const hasUnrestrictedAssigned = assigned.some((f) => {
      if (!f.filesOwned || f.filesOwned.length === 0) return true;
      return f.filesOwned.some((raw) => {
        const norm = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
        return norm === "*" || norm === "." || norm === "**" || norm === "**/*";
      });
    });
    if (hasUnrestrictedAssigned) {
      return { filesOwned: ["*"] };
    }

    const seenOwned = new Set<string>();
    const filesOwned: string[] = [];
    for (const f of assigned) {
      for (const raw of f.filesOwned ?? []) {
        const trimmed = raw.trim();
        if (trimmed && !seenOwned.has(trimmed)) {
          seenOwned.add(trimmed);
          filesOwned.push(trimmed);
        }
      }
    }

    const peerFilesOwned: Record<string, string[]> = {};
    for (const f of features) {
      if (
        f.status === "cancelled" ||
        f.assignedMember === member.name ||
        !f.filesOwned ||
        f.filesOwned.length === 0
      ) {
        continue;
      }
      const ownerKey = f.assignedMember?.trim() || f.id;
      const existing = peerFilesOwned[ownerKey] ?? [];
      for (const p of f.filesOwned) {
        const trimmed = p.trim();
        if (trimmed && !existing.includes(trimmed)) {
          existing.push(trimmed);
        }
      }
      if (existing.length > 0) {
        peerFilesOwned[ownerKey] = existing;
      }
    }

    return {
      ...(filesOwned.length > 0 ? { filesOwned } : {}),
      ...(Object.keys(peerFilesOwned).length > 0 ? { peerFilesOwned } : {}),
    };
  }

  private shouldSuppressOrchestratorBarrierWake(msg: BoardMessage): boolean {
    if (!this.orchestratorWait?.waitForAll) {
      return false;
    }
    if (isUrgentBarrierBypassMessage(msg)) {
      return false;
    }
    return this.getWorkingOrPendingMemberNames().length > 0;
  }

  private emitOrchestratorMessageWakeupIfAddressed(
    run: SwarmRunState,
    msg: BoardMessage,
  ): boolean {
    if (
      this.disposed ||
      this.runDonePosted ||
      run.status !== "active" ||
      this.activeRunId !== run.id
    ) {
      return false;
    }
    const mentionsLower = new Set(msg.mentions.map((m) => m.toLowerCase()));
    const chMentionsLower = new Set(msg.channelMentions.map((c) => c.toLowerCase()));
    const wakesOrchestrator =
      msg.fromRole !== "orchestrator" &&
      (mentionsLower.has(ORCHESTRATOR_NAME) ||
        mentionsLower.has("coordinator") ||
        mentionsLower.has(ALL_MENTION_NAME) ||
        chMentionsLower.size > 0);
    if (!wakesOrchestrator) {
      return false;
    }
    if (this.shouldSuppressOrchestratorBarrierWake(msg)) {
      return false;
    }
    let unreadMessages: BoardMessage[] = [msg];
    if (this.orchestratorWait && msg.seq > this.orchestratorWait.since) {
      const since = this.orchestratorWait.since;
      this.clearOrchestratorWait();
      unreadMessages = this.getCachedMessagesSince(since);
      if (unreadMessages.length === 0) {
        unreadMessages = [msg];
      }
    }
    this.emitEngineEvent(
      "wakeup_needed",
      `Board #${msg.seq} from ${msg.from} addressed @${ORCHESTRATOR_NAME}`,
      { seq: msg.seq, messages: unreadMessages },
    );
    return true;
  }

  private async routeBoardMessageWakeups(
    run: SwarmRunState,
    msg: BoardMessage,
    options?: { suppressOrchestratorWakeup?: boolean },
  ): Promise<boolean> {
    if (this.disposed || this.runDonePosted || run.status !== "active" || this.activeRunId !== run.id) {
      return false;
    }
    const senderLower = msg.from.toLowerCase();
    const mentionsLower = new Set(msg.mentions.map((m) => m.toLowerCase()));
    const chMentionsLower = new Set(msg.channelMentions.map((c) => c.toLowerCase()));
    const isExecutingRun = !isReconRun(run);

    // Resolve all target non-killed members (never wake the sender!)
    const targetNames = new Set<string>();
    const allMembers = Object.values(run.members).filter(
      (m) => m.state !== "killed" && m.name.toLowerCase() !== senderLower,
    );

    for (const handle of mentionsLower) {
      if (handle === ALL_MENTION_NAME) {
        for (const m of allMembers) {
          if (isExecutingRun && m.recon === true) continue;
          targetNames.add(m.name);
        }
        continue;
      }
      if (handle === ORCHESTRATOR_NAME || handle === "coordinator" || handle === MONITOR_NAME) {
        continue;
      }
      const exact = allMembers.find((m) => m.name.toLowerCase() === handle);
      if (exact) {
        targetNames.add(exact.name);
        continue;
      }
      // Group prefix wakeup (`@parser` wakes `parser-1..k`)
      for (const m of allMembers) {
        if (isExecutingRun && m.recon === true) continue;
        if (m.groupPrefix && m.groupPrefix.toLowerCase() === handle) {
          targetNames.add(m.name);
        }
      }
    }

    // Channel broadcast wakeup (`@#backend` wakes every subscribed non-killed member)
    for (const ch of chMentionsLower) {
      const chRecord = getOwnChannel(run, ch);
      if (!chRecord || chRecord.archived) continue;
      for (const m of allMembers) {
        if (isExecutingRun && m.recon === true) continue;
        if (m.channels.includes(ch) || chRecord.subscribers.includes(m.name)) {
          targetNames.add(m.name);
        }
      }
    }

    // Wake parked members who explicitly waited with `swarm_wait{mentions_only: false}`
    // on any non-self post in DEFAULT_CHANNEL or one of their subscribed channels!
    for (const m of allMembers) {
      if (isExecutingRun && m.recon === true) continue;
      if (m.state !== "waiting") continue;
      const live = this.liveMembers.get(m.name);
      if (live && live.parkedMentionsOnly === false) {
        if (msg.channel === DEFAULT_CHANNEL || m.channels.includes(msg.channel)) {
          targetNames.add(m.name);
        }
      }
    }

    // Respect human-stop sovereignty: peer @mentions NEVER revive humanStopped members,
    // while explicit human or orchestrator messages MAY revive them!
    const eligibleTargets: string[] = [];
    for (const name of targetNames) {
      const member = getOwnMember(run, name);
      if (!member || member.state === "killed") continue;
      if (member.state === "stopped" && member.humanStopped) {
        if (msg.fromRole !== "human" && msg.fromRole !== "orchestrator") {
          continue;
        }
      }
      eligibleTargets.push(name);
    }

    let hopCapped = false;
    if (eligibleTargets.length > 0) {
      // Enforce SWARM_MAX_BOARD_HOPS safety cap on peer-to-peer bounce chains!
      if (msg.fromRole === "worker" || msg.fromRole === "validator") {
        if (this.boardHopCount >= SWARM_MAX_BOARD_HOPS) {
          hopCapped = true;
          if (!this.hopCapAlerted) {
            this.hopCapAlerted = true;
            await this.postMonitorOrchestratorAlert(
              run.id,
              `@${ORCHESTRATOR_NAME} [hop-cap] Reached SWARM_MAX_BOARD_HOPS (${SWARM_MAX_BOARD_HOPS}) peer-to-peer wakeups at #${msg.seq}. Inspect the board and post an orchestrator decision to reset hops.`,
              "update",
            );
          }
        } else {
          this.boardHopCount += 1;
        }
      }

      if (!hopCapped) {
        // Deliver to each eligible target cleanly with synchronous waking lock + coalescing BEFORE checking barrier wake!
        for (const targetName of eligibleTargets) {
          this.deliverBoardMessageToMember(run.id, targetName, msg);
        }
      }
    }

    if (options?.suppressOrchestratorWakeup) {
      return false;
    }
    return this.emitOrchestratorMessageWakeupIfAddressed(run, msg);
  }

  private maybeWakeParkedOrchestratorOnMessage(
    msg: BoardMessage,
    alreadyEmittedWakeup: boolean,
  ): void {
    if (alreadyEmittedWakeup || !this.orchestratorWait) {
      return;
    }
    if (msg.seq <= this.orchestratorWait.since) {
      return;
    }
    if (this.shouldSuppressOrchestratorBarrierWake(msg)) {
      return;
    }
    if (
      this.doesMessageMatchWaiter(
        msg,
        ORCHESTRATOR_NAME,
        this.orchestratorWait.mentionsOnly,
        [],
      )
    ) {
      const since = this.orchestratorWait.since;
      this.clearOrchestratorWait();
      const unread = this.getCachedMessagesSince(since);
      this.emitEngineEvent(
        "wakeup_needed",
        `New board message #${msg.seq} from ${msg.from} in #${msg.channel}`,
        {
          seq: msg.seq,
          messages: unread.length > 0 ? unread : [msg],
        },
      );
    }
  }

  private deliverBoardMessageToMember(
    runId: string,
    memberName: string,
    msg: BoardMessage,
  ): void {
    if (this.disposed || this.runDonePosted || this.activeRunId !== runId) {
      return;
    }
    const run = this.cachedRun;
    const member = getOwnMember(run, memberName);
    if (!member || member.state === "killed") {
      return;
    }

    let live = this.liveMembers.get(memberName);
    if (!live) {
      live = {
        name: member.name,
        agentId: member.agentId,
        role: member.role,
        spawning: false,
        waking: false,
        turnActive: false,
        switchingModel: false,
        parkedMentionsOnly: true,
        pendingWakes: [],
        deliveredSeqs: new Set<number>(),
        triedModels: new Set<string>(member.model ? [member.model] : []),
        lastMessages: [],
        logTail: [...member.logTail],
        lastTool: member.lastTool,
        turnStartPostSeq: member.lastPostSeq ?? 0,
        lastSilentSummary: undefined,
        retryCount: 0,
        priorHandlesTokens: member.tokens,
        priorHandlesBreakdown: member.tokenBreakdown ? { ...member.tokenBreakdown } : undefined,
        priorHandlesCost: member.cost,
        liveLlmTurns: member.llmTurns ?? 0,
      };
      this.liveMembers.set(memberName, live);
    }

    if (
      live.deliveredSeqs.has(msg.seq) ||
      live.pendingWakes.some((w) => w.seq === msg.seq)
    ) {
      return;
    }
    live.pendingWakes.push(msg);
    this.cancelMemberRetryTimer(live);

    // If currently spawning, waking, finishing/running a turn, or switching models -> queue safely!
    if (
      live.spawning ||
      live.waking ||
      live.turnActive ||
      live.switchingModel ||
      live.handle?.getState() === "working"
    ) {
      return;
    }

    // Synchronously acquire `waking` lock before scheduling async dispatch so simultaneous posts coalesce!
    live.waking = true;
    this.cancelStallWatchdog();
    void this.cancelActiveMonitor("Swarm activity resumed");

    if (live.handle && live.handle.getState() === "waiting") {
      void this.drainMemberPendingWakes(runId, memberName);
    } else {
      void this.reviveMemberWithPendingWakes(runId, memberName);
    }
  }

  // --------------------------------------------------------------------------
  // Waiter Matching, Anti-Deadlock & Zero-Token Stall Watchdog
  // --------------------------------------------------------------------------

  private doesMessageMatchWaiter(
    msg: BoardMessage,
    targetName: string,
    mentionsOnly: boolean,
    targetChannels: readonly string[],
  ): boolean {
    if (msg.from.toLowerCase() === targetName) {
      return false;
    }
    if (!mentionsOnly) {
      return true;
    }
    const mentions = msg.mentions.map((m) => m.toLowerCase());
    if (mentions.includes(targetName) || mentions.includes(ALL_MENTION_NAME)) {
      return true;
    }
    if (targetName === ORCHESTRATOR_NAME && mentions.includes("coordinator")) {
      return true;
    }
    if (msg.channelMentions.length > 0) {
      if (targetName === ORCHESTRATOR_NAME) {
        return true;
      }
      const chSet = new Set(targetChannels.map((c) => c.toLowerCase()));
      if (msg.channelMentions.some((ch) => chSet.has(ch.toLowerCase()))) {
        return true;
      }
    }
    return false;
  }

  private notifyWaitersOnMessage(msg: BoardMessage): void {
    if (this.boardWaiters.size === 0) {
      return;
    }
    const head = Math.max(this.cachedRun?.boardHead ?? 0, msg.seq);
    for (const waiter of Array.from(this.boardWaiters)) {
      if (msg.seq <= waiter.since) {
        continue;
      }
      if (
        this.doesMessageMatchWaiter(
          msg,
          waiter.targetName,
          waiter.mentionsOnly,
          waiter.targetChannels,
        )
      ) {
        const unread = this.getCachedMessagesSince(waiter.since);
        waiter.resolve({
          wokeBy: "message",
          messages: unread.length > 0 ? unread : [msg],
          head,
          summary: `New message #${msg.seq} from ${msg.from} in #${msg.channel}.`,
        });
      }
    }
  }

  private buildAllIdleDigest(): string {
    const run = this.cachedRun;
    if (!run) {
      return "";
    }
    const entries: string[] = [];
    for (const name of run.memberOrder) {
      const m = getOwnMember(run, name);
      if (!m || m.state === "killed") {
        continue;
      }
      const postLabel =
        m.lastPostSeq !== undefined ? `lastPost=#${m.lastPostSeq}` : "no board post";
      const parkedDetail = m.parkedOn
        ? ` — ${m.parkedOn.replace(/\s+/g, " ").trim().slice(0, 80)}`
        : "";
      entries.push(`@${m.name} [${m.state}, ${postLabel}${parkedDetail}]`);
    }
    if (entries.length === 0) {
      return "";
    }
    return `Roster: ${entries.join("; ")}.`;
  }

  private consumeSilentTurnSummaries(): string {
    const run = this.cachedRun;
    if (!run) {
      return "";
    }
    const entries: string[] = [];
    for (const name of run.memberOrder) {
      const m = getOwnMember(run, name);
      if (!m || m.state === "killed" || m.state === "working") {
        continue;
      }
      const live = this.liveMembers.get(m.name);
      if (!live?.lastSilentSummary) {
        continue;
      }
      if ((m.lastPostSeq ?? 0) <= (live.turnStartPostSeq ?? 0)) {
        entries.push(`@${m.name}: "${live.lastSilentSummary}"`);
      }
      live.lastSilentSummary = undefined;
    }
    if (entries.length === 0) {
      return "";
    }
    return `Unposted turn summaries: ${entries.join("; ")}`;
  }

  private checkAllIdleAndNotifyWaiters(): void {
    const active = this.getWorkingOrPendingMemberNames();
    if (active.length > 0) {
      return;
    }
    if (!this.orchestratorWait && this.boardWaiters.size === 0) {
      return;
    }
    const digest = this.buildAllIdleDigest();
    const silentDigest = this.consumeSilentTurnSummaries();
    const fullDigest = [digest, silentDigest].filter(Boolean).join(" ");
    if (this.orchestratorWait) {
      const since = this.orchestratorWait.since;
      this.clearOrchestratorWait();
      const unread = this.getCachedMessagesSince(since);
      this.emitEngineEvent(
        "wakeup_needed",
        fullDigest
          ? `All active swarm members have finished and parked (all_idle). ${fullDigest}`
          : "All active swarm members have finished and parked (all_idle).",
        unread.length > 0
          ? { seq: unread[unread.length - 1]!.seq, messages: unread }
          : undefined,
      );
    }
    if (this.boardWaiters.size === 0) {
      return;
    }
    const head = this.cachedRun?.boardHead ?? 0;
    const waiterSummary = fullDigest
      ? `All active swarm members have finished and parked in waiting/stopped state. ${fullDigest}`
      : "All active swarm members have finished and parked in waiting/stopped state.";
    for (const waiter of Array.from(this.boardWaiters)) {
      waiter.resolve({
        wokeBy: "all_idle",
        messages: this.getCachedMessagesSince(waiter.since),
        head,
        summary: waiterSummary,
      });
    }
  }

  private resolveAllWaiters(
    wokeBy: WaitForBoardResult["wokeBy"],
    summary: string,
  ): void {
    const head = this.cachedRun?.boardHead ?? 0;
    for (const waiter of Array.from(this.boardWaiters)) {
      waiter.resolve({
        wokeBy,
        messages: this.getCachedMessagesSince(waiter.since),
        head,
        summary,
      });
    }
  }

  private cancelMemberRetryTimer(live: LiveMember): void {
    if (live.retryTimer) {
      clearTimeout(live.retryTimer);
      live.retryTimer = undefined;
    }
  }

  private async cancelActiveMonitor(reason: string): Promise<void> {
    const abort = this.activeMonitorAbort;
    this.activeMonitorAbort = undefined;
    abort?.abort();
    const handle = this.activeMonitorHandle;
    this.activeMonitorHandle = undefined;
    this.monitorRunning = false;
    if (handle) {
      await handle.kill(reason).catch(() => {});
    }
  }

  private cancelStallWatchdog(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private maybeArmStallWatchdog(): void {
    this.cancelStallWatchdog();
    if (this.disposed || this.runDonePosted || this.humanInputAwaited) {
      return;
    }
    const settings = this.getEffectiveSettings();
    if (!settings.stallWatchdogEnabled) {
      return;
    }
    const run = this.cachedRun;
    if (!run || run.status !== "active" || isReconRun(run)) {
      return;
    }
    if (this.boardWaiters.size > 0 || this.orchestratorWait) {
      return;
    }
    if (this.monitorRunning) {
      return;
    }
    // Require at least one live (non-killed, non-recon) member parked before considering swarm stalled
    const nonKilled = Object.values(run.members).filter(
      (m) => m.state !== "killed" && !m.recon,
    );
    if (nonKilled.length === 0) {
      return;
    }
    if (this.getWorkingOrPendingMemberNames().length > 0) {
      return;
    }
    if (this.lastStallAlertHead === run.boardHead) {
      return;
    }

    const armedHead = run.boardHead;
    const armedRunId = run.id;
    const timeoutMs = Math.max(10, settings.stallTimeoutMs);

    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      void this.fireStallWatchdog(armedRunId, armedHead, timeoutMs);
    }, timeoutMs);
    this.stallTimer.unref?.();
  }

  private async fireStallWatchdog(
    runId: string,
    armedHead: number,
    timeoutMs: number,
  ): Promise<void> {
    if (
      this.disposed ||
      this.runDonePosted ||
      this.humanInputAwaited ||
      this.activeRunId !== runId ||
      this.boardWaiters.size > 0 ||
      Boolean(this.orchestratorWait) ||
      this.monitorRunning
    ) {
      return;
    }
    const run = this.cachedRun;
    if (
      !run ||
      run.status !== "active" ||
      run.boardHead !== armedHead ||
      this.lastStallAlertHead === armedHead
    ) {
      return;
    }
    if (this.getWorkingOrPendingMemberNames().length > 0) {
      return;
    }

    const isNudgeEscalation =
      this.lastMonitorNudgeSeq !== null && armedHead === this.lastMonitorNudgeSeq;
    const settings = this.getEffectiveSettings();
    if (settings.stallMonitorMode === "llm" && !isNudgeEscalation) {
      const llmOutcome = await this.runSmartLlmMonitor(run, armedHead, timeoutMs, settings);
      if (llmOutcome === "handled") {
        if (this.getWorkingOrPendingMemberNames().length === 0) {
          this.maybeArmStallWatchdog();
        }
        return;
      }
      if (llmOutcome === "cancelled") {
        return;
      }
      // If LLM monitor errored or didn't post `[noop]`, re-verify run didn't advance then fall back deterministically
      if (
        this.disposed ||
        this.runDonePosted ||
        this.humanInputAwaited ||
        this.activeRunId !== runId ||
        this.boardWaiters.size > 0 ||
        Boolean(this.orchestratorWait) ||
        this.cachedRun?.status !== "active" ||
        this.cachedRun.boardHead !== armedHead ||
        this.lastStallAlertHead === armedHead ||
        this.getWorkingOrPendingMemberNames().length > 0
      ) {
        return;
      }
    }

    const rosterSummary = run.memberOrder
      .map((name) => getOwnMember(run, name))
      .filter((m): m is SwarmMemberRecord => Boolean(m && m.state !== "killed" && !m.recon))
      .map((m) => `${m.name}[${m.state}${m.parkedOn ? `:${m.parkedOn.slice(0, 32)}` : ""}]`)
      .join(", ");

    const latestSeqs =
      this.cachedBoard.length > 0
        ? this.cachedBoard
            .slice(-3)
            .map((m) => `#${m.seq}(${m.from})`)
            .join(", ")
        : "none";

    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const escalationNote = isNudgeEscalation
      ? `Nudged worker parked again without advancing board past #${armedHead}. `
      : "";
    const text = `@${ORCHESTRATOR_NAME} [stall] ${escalationNote}Swarm has been idle for ${seconds}s with 0 working members (board #${armedHead}). Roster: ${rosterSummary}. Latest posts: ${latestSeqs}. Wake a member, spawn next phase, or call swarm{action:"done"}.`;

    const posted = await this.emitStallMessage(
      runId,
      armedHead,
      timeoutMs,
      text,
      [ORCHESTRATOR_NAME],
      "deterministic",
    );
    if (!posted && this.getWorkingOrPendingMemberNames().length === 0) {
      this.maybeArmStallWatchdog();
    }
  }

  private async emitStallMessage(
    runId: string,
    armedHead: number,
    timeoutMs: number,
    text: string,
    mentions: string[],
    mode: "llm" | "deterministic",
    abortSignal?: AbortSignal,
  ): Promise<BoardMessage | null> {
    if (
      abortSignal?.aborted ||
      this.disposed ||
      this.runDonePosted ||
      this.humanInputAwaited ||
      this.activeRunId !== runId ||
      this.cachedRun?.status !== "active" ||
      this.cachedRun.boardHead !== armedHead ||
      this.lastStallAlertHead === armedHead ||
      Boolean(this.orchestratorWait) ||
      this.boardWaiters.size > 0 ||
      this.getWorkingOrPendingMemberNames().length > 0
    ) {
      return null;
    }
    try {
      const sanitizedText = sanitizeStallMentionsText(text, mentions);
      const stallMsg = await this.store.postBoardMessage(runId, {
        from: MONITOR_NAME,
        fromRole: "monitor",
        channel: DEFAULT_CHANNEL,
        kind: "stall",
        text: sanitizedText,
        mentions,
        channelMentions: [],
      });
      this.recordBoardMessageInCache(stallMsg);

      const lowerMentions = mentions.map((m) => m.toLowerCase());
      const hitsOrchestrator =
        lowerMentions.length === 0 ||
        lowerMentions.includes(ORCHESTRATOR_NAME) ||
        lowerMentions.includes("coordinator") ||
        lowerMentions.includes(ALL_MENTION_NAME);

      if (hitsOrchestrator) {
        this.lastStallAlertHead = stallMsg.seq;
        this.lastMonitorNudgeSeq = null;
      } else {
        this.lastMonitorNudgeSeq = stallMsg.seq;
      }

      await this.store.appendEvent({
        runId,
        type: "stall_detected",
        actor: MONITOR_NAME,
        summary: `Stall detected (${mode}) after ${timeoutMs}ms idle at board #${armedHead}`,
        data: { armedHead, stallSeq: stallMsg.seq, timeoutMs, mode, mentions },
      });

      const refreshed = await this.store.loadRun(runId);
      await this.refreshCache(refreshed);

      const latestRun = refreshed;

      this.emitEngineEvent("board_posted", `Posted stall alert #${stallMsg.seq}`, {
        seq: stallMsg.seq,
      });
      this.emitEngineEvent("stall_detected", `Swarm stalled at #${armedHead} (alert #${stallMsg.seq})`, {
        seq: stallMsg.seq,
        ...(!hitsOrchestrator && mentions[0] ? { memberName: mentions[0] } : {}),
      });

      if (hitsOrchestrator) {
        let unread = this.getCachedMessagesSince(
          this.orchestratorWait ? this.orchestratorWait.since : Math.max(0, stallMsg.seq - 1),
        );
        if (this.orchestratorWait) {
          this.clearOrchestratorWait();
        }
        if (unread.length === 0) {
          unread = [stallMsg];
        }
        this.emitEngineEvent("wakeup_needed", `Stall alert #${stallMsg.seq} for @${ORCHESTRATOR_NAME}`, {
          seq: stallMsg.seq,
          messages: unread,
        });
      } else if (latestRun.status === "active") {
        // Wake ONLY the specific target(s) that the smart monitor identified as the bottleneck
        await this.routeBoardMessageWakeups(latestRun, {
          ...stallMsg,
          mentions,
          channelMentions: [],
        });
      }

      this.notifyWaitersOnMessage(stallMsg);
      return stallMsg;
    } catch {
      return null;
    }
  }

  private async runSmartLlmMonitor(
    run: SwarmRunState,
    armedHead: number,
    timeoutMs: number,
    settings: SwarmSettings,
  ): Promise<"handled" | "cancelled" | "fallback"> {
    this.monitorRunning = true;
    const abort = new AbortController();
    this.activeMonitorAbort = abort;
    let handle: PersistentAgentHandle | undefined;
    let monitorSuperseded = false;
    const isMonitorCheckStillValid = (): boolean =>
      !abort.signal.aborted &&
      !this.disposed &&
      !this.runDonePosted &&
      !this.humanInputAwaited &&
      this.activeRunId === run.id &&
      this.cachedRun?.status === "active" &&
      this.cachedRun.boardHead === armedHead &&
      !this.orchestratorWait &&
      this.boardWaiters.size === 0 &&
      this.getWorkingOrPendingMemberNames().length === 0;

    try {
      const recent = await this.store
        .readBoard(run.id, { channel: "*", limit: 15 })
        .catch(() => ({ messages: this.cachedBoard.slice(-15), head: run.boardHead }));

      const rosterLines = run.memberOrder
        .map((n) => getOwnMember(run, n))
        .filter((m): m is SwarmMemberRecord => Boolean(m && m.state !== "killed" && !m.recon))
        .map(
          (m) =>
            `- @${m.name} (${m.role}) state=${m.state} parent=@${m.parentName} turns=${m.turns} lastPost=${m.lastPostSeq ? `#${m.lastPostSeq}` : "none"} parkedOn=${m.parkedOn ?? "-"} error=${m.error ?? "-"}`,
        )
        .join("\n");

      const boardLines = recent.messages
        .map((m) => `#${m.seq} [#${m.channel}] ${m.from}: ${m.text.replace(/\s+/g, " ").slice(0, 320)}`)
        .join("\n");

      const monitorSystemPrompt = [
        "# Pi Swarm Monitor (`@monitor` — Read-Only Stall Diagnostician)",
        "You diagnose whether the swarm has genuinely stalled and post ONE concise nudge naming ONLY the single member who can unstick the run.",
        "Rules:",
        "1. If `[done]` has already been delivered, work looks finished, or the swarm is legitimately waiting on the human, do NOT post to the board — simply reply with `[noop]`.",
        "2. Otherwise call `post_message` ONCE starting with `@<single-target> [stall] <concrete actionable instruction>` — target `@<member>` if a worker/validator left work incomplete, errored, or missed a handoff, OR `@orchestrator` if next-phase decisions/merges/completion are needed.",
        "3. Never edit files or spawn workers; you only have `read_board` and `post_message`.",
      ].join("\n");

      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      const monitorPrompt = [
        `Swarm "${run.title}" (${run.id}) has been idle for ${seconds}s with 0 working members (board head: #${armedHead}).`,
        `Objective: ${run.objective}`,
        "",
        "Active Roster:",
        rosterLines || "(none)",
        "",
        "Recent Board Messages:",
        boardLines || "(empty)",
        "",
        "Diagnose now: either reply `[noop]` or call `post_message` ONCE naming the single member `@<target>` who can unstick the swarm.",
      ].join("\n");

      let monitorPosted = false;
      const monitorBridge: MemberEngineBridge = {
        postMessage: async ({ text }) => {
          if (!isMonitorCheckStillValid()) {
            monitorSuperseded = true;
            throw new SwarmProtocolError(
              "INVALID_INPUT",
              "Monitor stall check was superseded by new swarm activity.",
            );
          }

          const parsedMentions = mergeUniqueLower([parseHandleMentions(text)]);
          const candidate = parsedMentions[0];
          let targetMentions: string[];
          let effectiveText = text;

          if (
            !candidate ||
            candidate === ORCHESTRATOR_NAME ||
            candidate === "coordinator" ||
            candidate === ALL_MENTION_NAME
          ) {
            targetMentions =
              candidate === ALL_MENTION_NAME ? [ALL_MENTION_NAME] : [ORCHESTRATOR_NAME];
            if (!candidate) {
              effectiveText = `@${ORCHESTRATOR_NAME} ${text}`;
            }
          } else {
            const currentRun = this.cachedRun;
            const exactTarget = currentRun
              ? Object.values(currentRun.members).find(
                  (m) =>
                    m.name.toLowerCase() === candidate &&
                    m.state !== "killed" &&
                    !(m.state === "stopped" && m.humanStopped),
                )
              : undefined;
            const groupTargets =
              !exactTarget && currentRun
                ? Object.values(currentRun.members).filter(
                    (m) =>
                      m.groupPrefix?.toLowerCase() === candidate &&
                      m.state !== "killed" &&
                      !(m.state === "stopped" && m.humanStopped),
                  )
                : [];
            if (exactTarget || groupTargets.length > 0) {
              targetMentions = [exactTarget ? exactTarget.name : candidate];
            } else {
              // Rewrite invalid/killed/humanStopped mention to @orchestrator
              const escapedCandidate = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              effectiveText = text.replace(
                new RegExp(`@${escapedCandidate}\\b`, "gi"),
                `@${ORCHESTRATOR_NAME}`,
              );
              if (
                !parseHandleMentions(effectiveText).some(
                  (m) => m.toLowerCase() === ORCHESTRATOR_NAME,
                )
              ) {
                effectiveText = `@${ORCHESTRATOR_NAME} ${effectiveText}`;
              }
              targetMentions = [ORCHESTRATOR_NAME];
            }
          }

          effectiveText = sanitizeStallMentionsText(effectiveText, targetMentions);

          const posted = await this.emitStallMessage(
            run.id,
            armedHead,
            timeoutMs,
            effectiveText,
            targetMentions,
            "llm",
            abort.signal,
          );
          if (!posted) {
            if (!isMonitorCheckStillValid()) {
              monitorSuperseded = true;
            }
            throw new SwarmProtocolError("NOT_FOUND", "Failed to post monitor diagnosis.");
          }
          monitorPosted = true;
          return posted;
        },
        readBoard: async (options) => this.readBoard(options),
        getStatus: async () => {
          const latest =
            this.cachedRun && this.activeRunId === run.id
              ? this.cachedRun
              : await this.store.loadRun(run.id);
          return this.buildRosterStatus(latest);
        },
        listModels: async (options) => this.listModels(options),
        addHelper: async () => {
          throw new SwarmProtocolError("PERMISSION_DENIED", "Monitor cannot spawn members.");
        },
        killHelper: async () => {
          throw new SwarmProtocolError("PERMISSION_DENIED", "Monitor cannot kill members.");
        },
        switchModel: async () => {
          throw new SwarmProtocolError("PERMISSION_DENIED", "Monitor cannot switch models.");
        },
        manageChannel: async () => {
          throw new SwarmProtocolError("PERMISSION_DENIED", "Monitor cannot manage channels.");
        },
        manageMission: async (missionInput) =>
          this.manageMission({
            ...missionInput,
            callerName: MONITOR_NAME,
            callerRole: "monitor",
          }),
      };

      const rawMonitorConfig =
        run.roleModels.validator?.model || settings.validatorModel
          ? {
              model: run.roleModels.validator?.model ?? settings.validatorModel,
              thinkingLevel:
                run.roleModels.validator?.thinkingLevel ?? settings.validatorThinkingLevel,
            }
          : run.roleModels.worker?.model || settings.workerModel
            ? {
                model: run.roleModels.worker?.model ?? settings.workerModel,
                thinkingLevel:
                  run.roleModels.worker?.thinkingLevel ?? settings.workerThinkingLevel,
              }
            : {
                model: run.roleModels.orchestrator?.model ?? settings.orchestratorModel,
                thinkingLevel:
                  run.roleModels.orchestrator?.thinkingLevel ?? settings.orchestratorThinkingLevel,
              };
      const parsedMonitorSpec = rawMonitorConfig.model?.trim()
        ? parseModelSpec(rawMonitorConfig.model.trim())
        : undefined;
      const monitorModel = parsedMonitorSpec?.model || rawMonitorConfig.model?.trim() || undefined;
      const monitorThinking = rawMonitorConfig.thinkingLevel ?? parsedMonitorSpec?.thinkingLevel;

      handle = await this.transport.spawnMember({
        agentId: this.generateAgentIdFn(MONITOR_NAME),
        name: MONITOR_NAME,
        role: "validator",
        runId: run.id,
        cwd: this.worktree.repoRoot,
        workspace: "inherit",
        parentName: ORCHESTRATOR_NAME,
        brief: "Read-only stall diagnosis",
        systemPrompt: monitorSystemPrompt,
        initialPrompt: monitorPrompt,
        keepWarm: false,
        modelOverride: monitorModel,
        thinkingLevel: monitorThinking,
        hostContext: this.hostContext,
        engineApi: monitorBridge,
        isMonitor: true,
      });

      if (abort.signal.aborted || this.disposed) {
        await handle.kill("Monitor cancelled before turn start").catch(() => {});
        return "cancelled";
      }

      this.activeMonitorHandle = handle;

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const turnResult = await Promise.race([
        handle.currentTurn,
        new Promise<AgentTurnResult | null>((resolve) => {
          timeoutTimer = setTimeout(() => resolve(null), 30_000);
          timeoutTimer.unref?.();
          onAbort = () => resolve(null);
          abort.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (onAbort) {
          abort.signal.removeEventListener("abort", onAbort);
        }
      });

      if (turnResult) {
        const addedTokens = Math.max(0, turnResult.tokens || 0);
        const addedCost = Math.max(0, turnResult.cost || 0);
        if (addedTokens > 0 || addedCost > 0) {
          this.monitorTokens += addedTokens;
          this.monitorCost += addedCost;
          this.emitEngineEvent("snapshot_changed", "Updated @monitor usage", {
            memberName: MONITOR_NAME,
          });
        }
      }

      if (abort.signal.aborted || this.disposed || monitorSuperseded) {
        return "cancelled";
      }

      if (monitorPosted) {
        return "handled";
      }
      if (turnResult && /\[noop\]/i.test(turnResult.summary)) {
        if (!isMonitorCheckStillValid()) {
          return "cancelled";
        }
        this.lastStallAlertHead = armedHead;
        this.lastMonitorNudgeSeq = null;
        return "handled";
      }
      return "fallback";
    } catch {
      return abort.signal.aborted || this.disposed || monitorSuperseded ? "cancelled" : "fallback";
    } finally {
      if (this.activeMonitorAbort === abort) {
        this.activeMonitorAbort = undefined;
        this.monitorRunning = false;
      }
      if (this.activeMonitorHandle === handle) {
        this.activeMonitorHandle = undefined;
      }
      if (handle) {
        await handle.kill("Monitor check complete").catch(() => {});
      }
    }
  }

  private async postMonitorOrchestratorAlert(
    runId: string,
    text: string,
    kind: BoardMessageKind,
  ): Promise<void> {
    try {
      const alertMsg = await this.store.postBoardMessage(runId, {
        from: MONITOR_NAME,
        fromRole: "monitor",
        channel: DEFAULT_CHANNEL,
        kind,
        text,
        mentions: [ORCHESTRATOR_NAME],
        channelMentions: [],
      });
      this.recordBoardMessageInCache(alertMsg);
      const refreshed = await this.store.loadRun(runId);
      this.setCachedRun(refreshed);
      this.emitEngineEvent("board_posted", `Posted monitor alert #${alertMsg.seq}`, {
        seq: alertMsg.seq,
      });
      let unread = this.getCachedMessagesSince(
        this.orchestratorWait ? this.orchestratorWait.since : Math.max(0, alertMsg.seq - 1),
      );
      if (this.orchestratorWait) {
        this.clearOrchestratorWait();
      }
      if (unread.length === 0) {
        unread = [alertMsg];
      }
      this.emitEngineEvent("wakeup_needed", text, { seq: alertMsg.seq, messages: unread });
      this.notifyWaitersOnMessage(alertMsg);
    } catch {
      this.emitEngineEvent("wakeup_needed", text);
    }
  }

  // --------------------------------------------------------------------------
  // Telemetry & Member Engine Bridge
  // --------------------------------------------------------------------------

  private handleTelemetry(runId: string, evt: AgentTelemetryEvent): void {
    if (this.disposed || this.activeRunId !== runId) {
      return;
    }

    const live = this.liveMembers.get(evt.name);
    if (live) {
      if (evt.activity !== undefined) {
        live.currentActivity = evt.activity.length > 0 ? evt.activity : undefined;
      }
      if (evt.toolName !== undefined) {
        live.lastTool = evt.toolName;
      }
      if (evt.logLine) {
        live.logTail = [...live.logTail, evt.logLine].slice(-50);
        const waitMatch = evt.logLine.match(WAIT_TELEMETRY_RE);
        if (waitMatch) {
          live.lastWaitRequest = {
            since: Number.parseInt(waitMatch[1]!, 10),
            mentionsOnly: waitMatch[2] === "true",
          };
        }
      }
    }

    const existingMember = getOwnMember(this.cachedRun, evt.name);
    if (live) {
      if (evt.type === "turn_end") {
        live.liveLlmTurns = Math.max(live.liveLlmTurns ?? 0, existingMember?.llmTurns ?? 0) + 1;
      }
      if (evt.tokens !== undefined) {
        live.liveTokens = Math.max(
          live.liveTokens ?? 0,
          existingMember?.tokens ?? 0,
          live.priorHandlesTokens + evt.tokens,
        );
      }
      if (evt.tokenBreakdown !== undefined) {
        live.liveTokenBreakdown = maxTokenBreakdown(
          live.liveTokenBreakdown ?? existingMember?.tokenBreakdown,
          mergeTokenBreakdown(live.priorHandlesBreakdown, evt.tokenBreakdown),
        );
      }
      if (evt.cost !== undefined) {
        live.liveCost = Math.max(
          live.liveCost ?? 0,
          existingMember?.cost ?? 0,
          live.priorHandlesCost + evt.cost,
        );
      }
    }

    // Fast in-memory cachedRun patch for crisp real-time UI rendering
    if (existingMember && this.cachedRun) {
      const member: SwarmMemberRecord = { ...existingMember };
      if (evt.activity !== undefined) {
        if (evt.activity.length > 0) {
          member.currentActivity = evt.activity;
        } else {
          delete member.currentActivity;
        }
      }
      if (evt.toolName !== undefined) {
        member.lastTool = evt.toolName;
      }
      if (evt.type === "turn_end") {
        member.llmTurns = live
          ? live.liveLlmTurns
          : (member.llmTurns ?? 0) + 1;
      }
      if (evt.tokens !== undefined) {
        member.tokens = Math.max(
          member.tokens,
          live?.liveTokens ?? 0,
          (live?.priorHandlesTokens ?? 0) + evt.tokens,
        );
      }
      if (evt.tokenBreakdown !== undefined) {
        member.tokenBreakdown =
          live?.liveTokenBreakdown ??
          mergeTokenBreakdown(live?.priorHandlesBreakdown, evt.tokenBreakdown);
      }
      if (evt.cost !== undefined) {
        member.cost = Math.max(
          member.cost,
          live?.liveCost ?? 0,
          (live?.priorHandlesCost ?? 0) + evt.cost,
        );
      }
      if (evt.logLine) {
        member.logTail = live ? [...live.logTail] : [...member.logTail, evt.logLine].slice(-50);
      }
      member.updatedAt = evt.timestamp;
      this.cachedRun.members[evt.name] = member;
    }

    this.emitEngineEvent(
      "snapshot_changed",
      evt.logLine ?? (evt.activity || `${evt.name}: ${evt.type}`),
      { memberName: evt.name },
    );
  }

  private createMemberBridge(
    runId: string,
    member: SwarmMemberRecord,
  ): MemberEngineBridge {
    const assertBridgeActive = (): SwarmMemberRecord => {
      if (this.disposed || this.activeRunId !== runId) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Swarm run "${runId}" is no longer active for member "@${member.name}".`,
        );
      }
      const currentMember = getOwnMember(this.cachedRun, member.name);
      if (!currentMember || currentMember.state === "killed") {
        throw new SwarmProtocolError(
          "MEMBER_KILLED",
          `Member "@${member.name}" has been killed and can no longer invoke Swarm tools.`,
        );
      }
      return currentMember;
    };

    return {
      postMessage: async ({
        text,
        channel,
        kind,
        featureId,
        discoveredIssues,
        leftUndone,
        verificationEvidence,
      }) => {
        const latest = assertBridgeActive();
        const isDonePost = kind === "done" || DONE_PREFIX_RE.test(text);
        const knownMembers = this.cachedRun
          ? this.collectKnownMentionHandles(this.cachedRun)
          : undefined;
        const handleMentions = parseHandleMentions(text);
        const hasValidHandleMention = knownMembers
          ? handleMentions.some((h) => knownMembers.has(h.toLowerCase()))
          : handleMentions.length > 0;
        const hasAnyMention =
          hasValidHandleMention || parseChannelMentions(text).length > 0;
        const effectiveText =
          isDonePost && !hasAnyMention ? `@${latest.parentName} ${text.trimStart()}` : text;
        const normalizedChannel = normalizeOptionalChannel(channel);
        return this.postMessage({
          from: latest.name,
          fromRole: latest.role,
          text: effectiveText,
          channel: normalizedChannel ?? latest.channels[0] ?? DEFAULT_CHANNEL,
          kind,
          ...(featureId !== undefined ? { featureId } : {}),
          ...(discoveredIssues !== undefined ? { discoveredIssues } : {}),
          ...(leftUndone !== undefined ? { leftUndone } : {}),
          ...(verificationEvidence !== undefined ? { verificationEvidence } : {}),
          ...(isDonePost && !hasAnyMention ? { mentions: [latest.parentName] } : {}),
        });
      },

      readBoard: async (options?: ReadBoardOptions) => {
        const latest = assertBridgeActive();
        const normalizedChannel = normalizeOptionalChannel(options?.channel);
        const effectiveOptions: ReadBoardOptions = {
          ...options,
          ...(options?.channel !== undefined ? { channel: normalizedChannel } : {}),
          ...(normalizedChannel === undefined
            ? { memberChannels: latest.channels }
            : {}),
        };
        const res = await this.readBoard(effectiveOptions);
        const isUnfilteredFeedRead =
          !options?.peek &&
          !options?.seqs &&
          !options?.search &&
          (!normalizedChannel || normalizedChannel === "*") &&
          (options?.limit === undefined || options.limit > 0);
        if (isUnfilteredFeedRead && this.activeRunId === runId) {
          let readUpToSeq = 0;
          if (res.messages.length > 0) {
            for (const m of res.messages) {
              if (m.seq > readUpToSeq) {
                readUpToSeq = m.seq;
              }
            }
          } else if (options?.since !== undefined) {
            readUpToSeq = res.head;
          }
          if (readUpToSeq > 0) {
            const live = this.liveMembers.get(latest.name);
            if (live) {
              live.lastReadSeq = Math.max(live.lastReadSeq ?? 0, readUpToSeq);
            }
          }
          if (readUpToSeq > latest.lastReadSeq && this.cachedRun) {
            const cachedMember = getOwnMember(this.cachedRun, latest.name);
            if (cachedMember && readUpToSeq > cachedMember.lastReadSeq) {
              this.cachedRun.members[latest.name] = {
                ...cachedMember,
                lastReadSeq: readUpToSeq,
              };
            }
          }
        }
        return res;
      },

      getStatus: async (): Promise<SwarmRosterStatus> => {
        assertBridgeActive();
        const run =
          this.cachedRun && this.activeRunId === runId
            ? this.cachedRun
            : await this.store.loadRun(runId);
        return this.buildRosterStatus(run);
      },

      listModels: async (options?: { all?: boolean }) => {
        assertBridgeActive();
        return this.listModels(options);
      },

      addHelper: async (input: AddHelperInput) => {
        assertBridgeActive();
        return this.addMembers({
          ...input,
          callerName: member.name,
          callerRole: member.role,
          hostContext: this.hostContext,
        });
      },

      killHelper: async (name: string, reason?: string, force?: boolean) => {
        assertBridgeActive();
        return this.killMember(name, {
          reason,
          force,
          callerName: member.name,
          callerRole: member.role,
        });
      },

      stopHelper: async (name: string, reason?: string) => {
        assertBridgeActive();
        return this.stopMember(name, {
          reason,
          callerName: member.name,
          callerRole: member.role,
        });
      },

      steerHelper: async (
        name: string,
        message: string,
        mode?: "steer" | "followUp",
      ) => {
        assertBridgeActive();
        return this.steerMember(name, message, mode, {
          callerName: member.name,
          callerRole: member.role,
        });
      },

      switchModel: async (
        targetName: string | undefined,
        model: string,
        thinkingLevel?: ThinkingLevel,
        reason?: string,
      ) => {
        assertBridgeActive();
        return this.switchModel({
          targetName: targetName?.trim().replace(/^@/, "") || member.name,
          model,
          thinkingLevel,
          reason,
          callerName: member.name,
          callerRole: member.role,
          hostContext: this.hostContext,
        });
      },

      manageChannel: async (input: ManageChannelInput) => {
        assertBridgeActive();
        return this.manageChannel({
          ...input,
          callerName: member.name,
          callerRole: member.role,
        });
      },

      manageMission: async (input: ManageMissionInput) => {
        const latest = assertBridgeActive();
        return this.manageMission({
          ...input,
          callerName: latest.name,
          callerRole: latest.role,
        });
      },

      getMemberContext: () => {
        const run = this.cachedRun;
        const current = getOwnMember(run, member.name) ?? member;
        const broadcastChannels = run
          ? Object.values(run.channels)
              .filter(
                (ch) =>
                  ch.name !== DEFAULT_CHANNEL &&
                  !ch.archived &&
                  (current.channels.includes(ch.name) ||
                    ch.subscribers.includes(current.name)),
              )
              .map((ch) => ch.name)
          : current.channels.filter((ch) => ch !== DEFAULT_CHANNEL);
        return {
          channels: current.channels,
          broadcastChannels,
          ...(current.groupPrefix ? { groupPrefix: current.groupPrefix } : {}),
        };
      },

      getFilesOwnedScope: () => {
        const run = this.cachedRun;
        const current = getOwnMember(run, member.name) ?? member;
        const isIsolatedWorktree =
          current.workspace !== "inherit" ||
          path.resolve(current.cwd) !== path.resolve(this.store.projectRoot);
        return this.computeMemberFilesOwnedScope(run, current, isIsolatedWorktree);
      },

      recordParkBlocked: async (seq: number) => {
        if (!Number.isFinite(seq) || seq < 0) {
          return;
        }
        const normalizedSeq = Math.max(0, Math.floor(seq));
        const current = assertBridgeActive();
        const live = this.liveMembers.get(current.name);
        if (live) {
          live.lastParkBlockedSeq = Math.max(
            live.lastParkBlockedSeq ?? 0,
            normalizedSeq,
          );
        }
        const updated = await this.store.updateMember(runId, current.name, {
          lastParkBlockedSeq: normalizedSeq,
        });
        await this.refreshCache(updated);
        this.emitEngineEvent(
          "snapshot_changed",
          `@${current.name} swarm_wait blocked by unread #${normalizedSeq}`,
          { memberName: current.name, seq: normalizedSeq },
        );
      },
    };
  }

  // --------------------------------------------------------------------------
  // Internal State & Cache Helpers
  // --------------------------------------------------------------------------

  private getEffectiveSettings(): SwarmSettings {
    const base = this.getSettingsFn
      ? this.getSettingsFn()
      : { ...DEFAULT_SWARM_SETTINGS, ...this.staticSettings };
    return {
      ...DEFAULT_SWARM_SETTINGS,
      ...base,
      fallbackModels: [...(base.fallbackModels ?? [])],
    };
  }

  private requireActiveRun(): SwarmRunState {
    if (!this.activeRunId || !this.cachedRun) {
      throw new SwarmProtocolError(
        "NOT_FOUND",
        "No active Swarm run. Start or attach to a Swarm run first.",
      );
    }
    return this.cachedRun;
  }

  private findMember(run: SwarmRunState, name: string): SwarmMemberRecord | undefined {
    const clean = name.trim().replace(/^@/, "");
    const direct = getOwnMember(run, clean);
    if (direct) return direct;
    const lower = clean.toLowerCase();
    return Object.values(run.members).find((m) => m.name.toLowerCase() === lower);
  }

  private collectKnownMentionHandles(run: SwarmRunState): Set<string> {
    const known = new Set<string>([ALL_MENTION_NAME, ORCHESTRATOR_NAME, "coordinator"]);
    for (const member of Object.values(run.members)) {
      if (member.name) {
        known.add(member.name.toLowerCase());
      }
      if (member.groupPrefix) {
        known.add(member.groupPrefix.toLowerCase());
      }
    }
    return known;
  }

  private buildRosterStatus(run: SwarmRunState): SwarmRosterStatus {
    const members: Array<SwarmMemberStatusEntry & { cwd?: string; mergedCommitSha?: string }> =
      run.memberOrder
        .map((n) => getOwnMember(run, n))
        .filter((m): m is SwarmMemberRecord => Boolean(m))
        .map((m) => ({
          name: m.name,
          role: m.role,
          ...(m.recon === true ? { recon: true } : {}),
          state: m.state,
          parentName: m.parentName,
          groupPrefix: m.groupPrefix,
          workspace: m.workspace,
          cwd: m.cwd,
          branch: m.branch,
          ...(m.mergedCommitSha ? { mergedCommitSha: m.mergedCommitSha } : {}),
          model: m.model,
          thinkingLevel: m.thinkingLevel,
          channels: m.channels,
          parkedOn: m.parkedOn,
          currentActivity: m.currentActivity,
          lastPostSeq: m.lastPostSeq,
          lastPostTime: m.lastPostTime,
          ...(m.lastParkBlockedSeq !== undefined
            ? { lastParkBlockedSeq: m.lastParkBlockedSeq }
            : {}),
          turns: m.turns,
          ...(m.llmTurns !== undefined ? { llmTurns: m.llmTurns } : {}),
          ...(m.turnStartedAt !== undefined ? { turnStartedAt: m.turnStartedAt } : {}),
          tokens: m.tokens,
          cost: m.cost,
        }));
    return {
      runId: run.id,
      title: run.title,
      status: run.status,
      ...(run.runMode !== undefined ? { runMode: run.runMode } : {}),
      baseBranch: run.baseBranch,
      boardHead: run.boardHead,
      members,
      channels: Object.values(run.channels),
    };
  }

  private getWorkingOrPendingMemberNames(): string[] {
    const run = this.cachedRun;
    if (!run) return [];
    const reconMode = isReconRun(run);
    const active = new Set<string>();
    for (const member of Object.values(run.members)) {
      if (member.state === "killed") continue;
      if (!reconMode && member.recon === true) continue;
      const live = this.liveMembers.get(member.name);
      if (
        member.state === "working" ||
        live?.spawning ||
        live?.waking ||
        live?.turnActive ||
        live?.switchingModel ||
        Boolean(live?.retryTimer) ||
        live?.handle?.getState() === "working"
      ) {
        active.add(member.name);
      }
    }
    return Array.from(active);
  }

  private recordBoardMessageInCache(msg: BoardMessage): void {
    const idx = this.cachedBoard.findIndex((m) => m.seq === msg.seq);
    if (idx >= 0) {
      this.cachedBoard[idx] = msg;
    } else {
      this.cachedBoard.push(msg);
      if (this.cachedBoard.length > BOARD_CACHE_LIMIT) {
        this.cachedBoard = this.cachedBoard.slice(-BOARD_CACHE_LIMIT);
      }
    }
    if (this.cachedRun && msg.seq > this.cachedRun.boardHead) {
      this.cachedRun.boardHead = msg.seq;
    }
  }

  private getCachedMessagesSince(since: number): BoardMessage[] {
    return this.cachedBoard.filter((m) => m.seq > since);
  }

  private setCachedRun(nextRun: SwarmRunState): void {
    if (
      this.cachedRun &&
      this.cachedRun.id === nextRun.id &&
      nextRun.revision < this.cachedRun.revision
    ) {
      return;
    }
    const prevHead =
      this.cachedRun && this.cachedRun.id === nextRun.id
        ? this.cachedRun.boardHead
        : 0;
    const mergedMembers: Record<string, SwarmMemberRecord> = { ...nextRun.members };
    if (this.liveMembers.size > 0) {
      for (const [name, m] of Object.entries(mergedMembers)) {
        const live = this.liveMembers.get(name);
        if (!live) continue;
        const preserveLogTail =
          live.logTail.length > m.logTail.length ? [...live.logTail] : m.logTail;
        const preserveLastTool = live.lastTool ?? m.lastTool;
        const isWorking = m.state === "working" || live.turnActive || live.spawning;
        const preserveActivity =
          isWorking && live.currentActivity ? live.currentActivity : m.currentActivity;
        const preserveTokens = Math.max(m.tokens, live.liveTokens ?? 0);
        const preserveCost = Math.max(m.cost, live.liveCost ?? 0);
        const preserveLlmTurns = Math.max(m.llmTurns ?? 0, live.liveLlmTurns ?? 0);
        const llmTurnsChanged =
          (preserveLlmTurns > 0 || m.llmTurns !== undefined) &&
          preserveLlmTurns !== m.llmTurns;
        const preserveTurnStartedAt =
          isWorking && live.turnStartedAt ? live.turnStartedAt : m.turnStartedAt;
        const preserveLastReadSeq = Math.max(m.lastReadSeq, live.lastReadSeq ?? 0);
        const preserveParkBlockedSeq = Math.max(
          m.lastParkBlockedSeq ?? -1,
          live.lastParkBlockedSeq ?? -1,
        );
        const parkBlockedChanged =
          preserveParkBlockedSeq >= 0 &&
          preserveParkBlockedSeq !== m.lastParkBlockedSeq;
        const preserveBreakdown = maxTokenBreakdown(m.tokenBreakdown, live.liveTokenBreakdown);
        const breakdownAdvanced = Boolean(
          live.liveTokenBreakdown &&
            (!m.tokenBreakdown || preserveBreakdown!.total > m.tokenBreakdown.total),
        );
        if (
          preserveLogTail !== m.logTail ||
          preserveLastTool !== m.lastTool ||
          preserveActivity !== m.currentActivity ||
          preserveTokens !== m.tokens ||
          preserveCost !== m.cost ||
          llmTurnsChanged ||
          preserveTurnStartedAt !== m.turnStartedAt ||
          preserveLastReadSeq !== m.lastReadSeq ||
          parkBlockedChanged ||
          breakdownAdvanced
        ) {
          mergedMembers[name] = {
            ...m,
            logTail: preserveLogTail,
            lastTool: preserveLastTool,
            currentActivity: preserveActivity,
            tokens: preserveTokens,
            cost: preserveCost,
            ...(llmTurnsChanged ? { llmTurns: preserveLlmTurns } : {}),
            ...(preserveTurnStartedAt !== undefined
              ? { turnStartedAt: preserveTurnStartedAt }
              : {}),
            lastReadSeq: preserveLastReadSeq,
            ...(parkBlockedChanged
              ? { lastParkBlockedSeq: preserveParkBlockedSeq }
              : {}),
            ...(breakdownAdvanced ? { tokenBreakdown: preserveBreakdown } : {}),
          };
        }
      }
    }
    this.cachedRun = {
      ...nextRun,
      members: mergedMembers,
      boardHead: Math.max(nextRun.boardHead, prevHead),
    };
  }

  private async refreshCache(knownRun?: SwarmRunState): Promise<void> {
    if (!this.activeRunId) return;
    try {
      const next = knownRun ?? (await this.store.loadRun(this.activeRunId));
      this.setCachedRun(next);
      this.cachedEvents = await this.store
        .getRecentEvents(this.activeRunId, EVENT_CACHE_LIMIT)
        .catch(() => this.cachedEvents);
    } catch {
      // retain prior cache on transient read failure
    }
  }

  private async withRoleModelsLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.roleModelsChain;
    let release!: () => void;
    this.roleModelsChain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async withMissionLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.missionChain;
    let release!: () => void;
    this.missionChain = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async withRepoGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.repoGitLock;
    let release!: () => void;
    this.repoGitLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async assertMissionGoalGatesForCompletion(
    currentRun: SwarmRunState,
  ): Promise<void> {
    let snapshot = this.getSnapshot();
    if (snapshot.workingMemberNames.length > 0) {
      for (
        let attempt = 0;
        attempt < 5 && snapshot.workingMemberNames.length > 0;
        attempt++
      ) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5);
          t.unref?.();
        });
        snapshot = this.getSnapshot();
      }
    }

    // Gate A: Working members
    if (snapshot.workingMemberNames.length > 0) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot complete Swarm while member(s) are still working: ${snapshot.workingMemberNames.map((n) => "@" + n).join(", ")}. Call swarm_wait to let them finish, or stop/kill them first.`,
      );
    }

    // Gate B: Unmerged worktree branches with commits ahead of baseBranch
    const unmergedAhead = await this.getUnmergedMembersWithCommits();
    if (unmergedAhead.length > 0) {
      const labels = unmergedAhead.map(
        ({ member: m, commitsAhead }) =>
          `@${m.name} (${m.branch ?? m.workspace}, ${commitsAhead} commit${commitsAhead === 1 ? "" : "s"} ahead)`,
      );
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot complete Swarm while unmerged worktree branch(es) have commits ahead of ${currentRun.baseBranch}: ${labels.join(", ")}. Merge ready branches via swarm{action:"merge", name} or kill obsolete branches via swarm{action:"kill", name} first.`,
        {
          unmergedMembers: unmergedAhead.map(({ member: m, commitsAhead }) => ({
            name: m.name,
            branch: m.branch,
            commitsAhead,
          })),
        },
      );
    }

    // Gate C: Incomplete Features
    if (currentRun.features && currentRun.features.length > 0) {
      const incompleteFeatures = currentRun.features.filter(
        (f) =>
          f.status === "pending" ||
          f.status === "in_progress" ||
          f.status === "failed",
      );
      if (incompleteFeatures.length > 0) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Cannot complete Mission while ${incompleteFeatures.length} feature(s) remain incomplete: ${incompleteFeatures.map((f) => `${f.id} [${f.status}]`).join(", ")}. Complete or cancel remaining features via swarm{action:"mission"} before calling done.`,
          {
            incompleteFeatures: incompleteFeatures.map((f) => ({
              id: f.id,
              status: f.status,
            })),
          },
        );
      }
    }

    // Gate D: Open Handoff Tech Debt
    const openTechDebt = (currentRun.handoffItems ?? []).filter(
      (h) =>
        h.resolution === "open" &&
        (h.type === "discovered_issue" || h.type === "incomplete_work"),
    );
    if (openTechDebt.length > 0) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Cannot complete Mission with ${openTechDebt.length} open handoff tech-debt item(s): ${openTechDebt.map((h) => `${h.id} (${h.type} from @${h.sourceMember}: "${h.summary.slice(0, 72)}")`).join("; ")}. Track follow-up features via swarm{action:"mission", mission_op:"upsert_features"} and resolve each item via swarm{action:"mission", mission_op:"resolve_handoff"} before calling done.`,
        { openHandoffIds: openTechDebt.map((h) => h.id) },
      );
    }

    // Gate E: 100% Validation Contract VAL-* Passed & Claimed by Completed Features
    if (currentRun.assertions && currentRun.assertions.length > 0) {
      const unpassedAssertions = currentRun.assertions.filter(
        (a) => a.status !== "passed",
      );
      const completedFulfills = new Set(
        (currentRun.features ?? [])
          .filter((f) => f.status === "completed")
          .flatMap((f) => f.fulfills),
      );
      const unclaimedByCompleted = currentRun.assertions.filter(
        (a) => !completedFulfills.has(a.id),
      );
      if (unpassedAssertions.length > 0 || unclaimedByCompleted.length > 0) {
        const reasons: string[] = [];
        if (unpassedAssertions.length > 0) {
          reasons.push(
            `unpassed VAL-* assertions: ${unpassedAssertions.map((a) => `${a.id} [${a.status}]`).join(", ")} (verify via @validator calling swarm{action:"mission", mission_op:"verify_assertion"}, or use audited mission_op:"override_assertion" with >=30 char justification)`,
          );
        }
        if (unclaimedByCompleted.length > 0) {
          reasons.push(
            `VAL-* assertions not claimed in fulfills[] of any "completed" feature: ${unclaimedByCompleted.map((a) => a.id).join(", ")} (ensure completed features claim 100% of assertions via swarm{action:"mission", mission_op:"upsert_features"})`,
          );
        }
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Cannot complete Mission until 100% of Validation Contract passes and is claimed: ${reasons.join("; ")}.`,
          {
            unpassedAssertionIds: unpassedAssertions.map((a) => a.id),
            unclaimedAssertionIds: unclaimedByCompleted.map((a) => a.id),
          },
        );
      }
    }
  }

  private collectLiveWorkingMemberNames(): Set<string> {
    const names = new Set<string>();
    for (const [name, live] of this.liveMembers.entries()) {
      if (
        live.spawning ||
        live.waking ||
        live.turnActive ||
        live.switchingModel ||
        Boolean(live.retryTimer) ||
        live.handle?.getState() === "working"
      ) {
        names.add(name);
      }
    }
    return names;
  }

  private async persistWorkingMembersStopped(
    runId: string | null,
    liveWorkingNames: ReadonlySet<string>,
    parkedOn: string,
  ): Promise<void> {
    if (!runId) {
      return;
    }
    try {
      const currentRun = await this.store.loadRun(runId);
      if (currentRun.status !== "active" && currentRun.status !== "paused") {
        return;
      }
      for (const m of Object.values(currentRun.members)) {
        if (m.state === "killed") continue;
        if (m.state === "working" || liveWorkingNames.has(m.name)) {
          const live = this.liveMembers.get(m.name);
          const flushedTokens = Math.max(m.tokens, live?.liveTokens ?? 0);
          const flushedCost = Math.max(m.cost, live?.liveCost ?? 0);
          const flushedBreakdown = maxTokenBreakdown(
            m.tokenBreakdown,
            live?.liveTokenBreakdown,
          );
          const flushedLogTail =
            live && live.logTail.length > 0 ? [...live.logTail] : m.logTail;
          const flushedLlmTurns = Math.max(m.llmTurns ?? 0, live?.liveLlmTurns ?? 0);
          await this.store.updateMember(runId, m.name, {
            state: "stopped",
            tokens: flushedTokens,
            cost: flushedCost,
            ...(flushedBreakdown ? { tokenBreakdown: flushedBreakdown } : {}),
            logTail: flushedLogTail,
            ...(flushedLlmTurns > 0 ? { llmTurns: flushedLlmTurns } : {}),
            ...(live?.lastTool !== undefined ? { lastTool: live.lastTool } : {}),
            currentActivity: null,
            turnStartedAt: null,
            parkedOn,
          });
        }
      }
    } catch {
      // Best-effort persistence during detach/switch/dispose
    }
  }

  private async disposeLiveHandles(reason: string): Promise<void> {
    const entries = Array.from(this.liveMembers.values());
    this.liveMembers.clear();
    await Promise.all(
      entries.map(async (live) => {
        this.cancelMemberRetryTimer(live);
        live.launchAbort?.abort();
        live.spawning = false;
        live.waking = false;
        live.turnActive = false;
        live.switchingModel = false;
        live.pendingSelfModelSwitch = undefined;
        live.lastWaitRequest = undefined;
        live.lastSilentSummary = undefined;
        live.parkedMentionsOnly = true;
        live.currentActivity = undefined;
        live.turnStartedAt = undefined;
        live.pendingWakes.length = 0;
        live.releaseSlot?.();
        live.releaseSlot = undefined;
        if (live.handle) {
          await live.handle.kill(reason).catch(() => {});
        }
      }),
    );
  }

  private emitEngineEvent(
    type: SwarmEngineEventType,
    summary: string,
    extra?: { memberName?: string; seq?: number; messages?: BoardMessage[] },
  ): void {
    if (this.listeners.size === 0) return;
    const event: SwarmEngineEvent = {
      type,
      runId: this.activeRunId,
      memberName: extra?.memberName,
      seq: extra?.seq,
      ...(extra?.messages !== undefined ? { messages: extra.messages } : {}),
      summary,
      snapshot: this.getSnapshot(),
    };
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // listener errors must never disrupt the engine
      }
    }
  }
}

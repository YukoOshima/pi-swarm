import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ASSERTION_STATUSES,
  CHANNEL_NAME_PATTERN,
  DEFAULT_CHANNEL,
  DEFAULT_LIBRARY_TOPICS,
  DEFAULT_SWARM_SETTINGS,
  FEATURE_STATUSES,
  HANDOFF_ITEM_TYPES,
  HANDOFF_RESOLUTIONS,
  MEMBER_NAME_PATTERN,
  ORCHESTRATOR_NAME,
  RESERVED_MEMBER_NAMES,
  SWARM_BRANCH_PREFIX,
  SWARM_DIR,
  SWARM_EVENTS_FILE,
  SWARM_FEATURES_FILE,
  SWARM_LIBRARY_DIR,
  SWARM_LOCKS_DIR,
  SWARM_LOG_TAIL_LIMIT,
  SWARM_MISSION_FILE,
  SWARM_ROSTER_FILE,
  SWARM_RUNS_DIR,
  SWARM_SERVICES_FILE,
  SWARM_SESSIONS_DIR,
  SWARM_STATE_FILE,
  SWARM_STATE_VERSION,
  SWARM_VALIDATION_CONTRACT_FILE,
  SWARM_VALIDATION_STATE_FILE,
  SWARM_WORKTREES_DIR,
  SWARM_WORKTREE_PREFIX,
} from "../constants.js";
import {
  SwarmProtocolError,
  type AssertionStatus,
  type BoardMessage,
  type CallerRole,
  type CreateChannelInput,
  type CreateRunInput,
  type FeatureStatus,
  type HandoffItemResolution,
  type HandoffItemType,
  type ISwarmStore,
  type MemberUpdateInput,
  type MissionAssertion,
  type MissionAuditRecord,
  type MissionCommandEntry,
  type MissionFeature,
  type MissionHandoffItem,
  type MissionServiceEntry,
  type PostBoardMessageInput,
  type ReadBoardOptions,
  type ReadBoardResult,
  type RegisterMemberInput,
  type RunSummary,
  type RunUpdateInput,
  type SwarmChannelRecord,
  type SwarmEvent,
  type SwarmEventInput,
  type SwarmMemberRecord,
  type SwarmMemberRole,
  type SwarmMemberState,
  type SwarmMilestone,
  type SwarmRoleModels,
  type SwarmRunState,
  type SwarmRunStatus,
  type SwarmWorkspaceMode,
} from "../types.js";
import { SwarmBoard } from "./board.js";
import { appendLedgerEvent, readRecentLedgerEvents } from "./ledger.js";
import { SWARM_SETTINGS_BOUNDS } from "./settings.js";

// ============================================================================
// Constants & Validation Tables
// ============================================================================

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LIBRARY_TOPIC_PATTERN = /^[a-z0-9][a-z0-9-_]{0,47}$/i;
export const MAX_LIBRARY_TOPIC_BYTES = 256 * 1024;

const DEFAULT_LIBRARY_STARTER_CONTENT: Readonly<
  Record<(typeof DEFAULT_LIBRARY_TOPICS)[number], string>
> = Object.freeze({
  architecture: "# Architecture\n\n",
  environment: "# Environment\n\n",
  testing: "# Testing\n\n",
});

const RESERVED_MEMBER_NAME_SET: ReadonlySet<string> = new Set<string>(
  RESERVED_MEMBER_NAMES,
);

const VALID_RUN_STATUSES: ReadonlySet<SwarmRunStatus> = new Set<SwarmRunStatus>([
  "active",
  "paused",
  "completed",
  "abandoned",
]);

const VALID_MEMBER_ROLES: ReadonlySet<SwarmMemberRole> =
  new Set<SwarmMemberRole>(["worker", "validator"]);

const VALID_MEMBER_STATES: ReadonlySet<SwarmMemberState> =
  new Set<SwarmMemberState>(["working", "waiting", "stopped", "killed"]);

const VALID_WORKSPACE_MODES: ReadonlySet<SwarmWorkspaceMode> =
  new Set<SwarmWorkspaceMode>(["inherit", "share", "branch"]);

const VALID_MILESTONE_STATUSES: ReadonlySet<SwarmMilestone["status"]> =
  new Set<SwarmMilestone["status"]>(["pending", "in_progress", "done", "blocked"]);

const VALID_ASSERTION_STATUSES: ReadonlySet<AssertionStatus> =
  new Set<AssertionStatus>(ASSERTION_STATUSES);

const VALID_FEATURE_STATUSES: ReadonlySet<FeatureStatus> =
  new Set<FeatureStatus>(FEATURE_STATUSES);

const VALID_HANDOFF_TYPES: ReadonlySet<HandoffItemType> =
  new Set<HandoffItemType>(HANDOFF_ITEM_TYPES);

const VALID_HANDOFF_RESOLUTIONS: ReadonlySet<HandoffItemResolution> =
  new Set<HandoffItemResolution>(HANDOFF_RESOLUTIONS);

const VALID_CALLER_ROLES: ReadonlySet<CallerRole> = new Set<CallerRole>([
  "orchestrator",
  "worker",
  "validator",
  "monitor",
  "human",
]);

const VALID_AUDIT_VERDICTS: ReadonlySet<MissionAuditRecord["verdict"]> =
  new Set<MissionAuditRecord["verdict"]>(["approved", "disapproved"]);

const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 20;

// ============================================================================
// Pure Protocol Helpers
// ============================================================================

const PROTOTYPE_KEY_SET = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "tostring",
  "valueof",
  "hasownproperty",
  "isprototypeof",
  "propertyisenumerable",
  "tolocalestring",
]);

/** Return true for prototype-polluting keys (`__proto__`, `prototype`, `constructor`, `Object.prototype` keys, and their lowercase equivalents). */
export function isPrototypeKey(k: string): boolean {
  return (
    PROTOTYPE_KEY_SET.has(k) ||
    PROTOTYPE_KEY_SET.has(k.toLowerCase()) ||
    k in Object.prototype
  );
}

function getOwnRecord<T>(
  map: Record<string, T> | undefined,
  key: string,
): T | undefined {
  if (!map || isPrototypeKey(key) || !Object.hasOwn(map, key)) {
    return undefined;
  }
  return map[key];
}

/** Validate a dynamic member name against `MEMBER_NAME_PATTERN` and `RESERVED_MEMBER_NAMES`. */
export function validateMemberName(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name !== name.trim()) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Invalid member name: ${JSON.stringify(name)} (must match ${MEMBER_NAME_PATTERN.source}).`,
      { name },
    );
  }
  if (!MEMBER_NAME_PATTERN.test(name)) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Invalid member name "${name}": must be 1–32 lowercase alphanumeric/hyphen characters starting with a letter.`,
      { name },
    );
  }
  if (isPrototypeKey(name)) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Member name "${name}" is forbidden.`,
      { name },
    );
  }
  if (RESERVED_MEMBER_NAME_SET.has(name)) {
    throw new SwarmProtocolError(
      "INVALID_NAME",
      `Member name "${name}" is reserved (${RESERVED_MEMBER_NAMES.join(", ")}).`,
      { name, reserved: [...RESERVED_MEMBER_NAMES] },
    );
  }
  return name;
}

/** Validate a board channel name against `CHANNEL_NAME_PATTERN`. */
export function validateChannelName(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name !== name.trim()) {
    throw new SwarmProtocolError(
      "INVALID_CHANNEL",
      `Invalid channel name: ${JSON.stringify(name)} (must match ${CHANNEL_NAME_PATTERN.source}).`,
      { channel: name },
    );
  }
  if (!CHANNEL_NAME_PATTERN.test(name)) {
    throw new SwarmProtocolError(
      "INVALID_CHANNEL",
      `Invalid channel name "${name}": must be 1–32 lowercase alphanumeric/hyphen characters starting with a letter.`,
      { channel: name },
    );
  }
  if (isPrototypeKey(name)) {
    throw new SwarmProtocolError(
      "INVALID_CHANNEL",
      `Channel name "${name}" is forbidden.`,
      { channel: name },
    );
  }
  return name;
}

/** Validate a Mission Library topic slug strictly against `/^[a-z0-9][a-z0-9-_]{0,47}$/i`. */
export function validateLibraryTopic(topic: string): string {
  if (typeof topic !== "string") {
    throw new SwarmProtocolError(
      "INVALID_INPUT",
      `Invalid library topic: ${JSON.stringify(topic)}`,
      { topic },
    );
  }
  const trimmed = topic.trim();
  if (
    trimmed.length === 0 ||
    topic.includes("..") ||
    topic.includes("/") ||
    topic.includes("\\") ||
    topic.includes("\0") ||
    !LIBRARY_TOPIC_PATTERN.test(trimmed) ||
    isPrototypeKey(trimmed)
  ) {
    throw new SwarmProtocolError(
      "INVALID_INPUT",
      `Invalid library topic ${JSON.stringify(topic)}: must match ${LIBRARY_TOPIC_PATTERN.source} without path separators or "..".`,
      { topic },
    );
  }
  return trimmed.toLowerCase();
}

/** Derive a deterministic git branch name (`swarm/<run-short>/<memberName>`) for isolated worktrees. */
export function deriveMemberBranch(runId: string, memberName: string): string {
  const safeRunId = validateSafeIdentifier(runId, "runId");
  const safeMember = validateMemberName(memberName);
  const shortRun = safeRunId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return `${SWARM_BRANCH_PREFIX}${shortRun || "run"}/${safeMember}`;
}

/** Normalize a changed file path reported by git into a clean POSIX repo-relative path. */
export function normalizeRelativeRepoPath(raw: string): string | null {
  let candidate = raw.trim().replace(/\\/g, "/");
  while (candidate.startsWith("./")) {
    candidate = candidate.slice(2);
  }
  while (candidate.endsWith("/")) {
    candidate = candidate.slice(0, -1);
  }
  if (candidate.length === 0 || candidate.startsWith("/")) {
    return null;
  }
  const segments = candidate.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    return null;
  }
  return segments.join("/");
}

/** Check whether a POSIX process ID is currently alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Enforces live-session ownership for destructive actions like teardown:
 * allowed only when invoked by the owning session OR when the owning PID is no longer alive.
 */
export function assertOwnerSession(
  state: SwarmRunState,
  currentSessionId: string,
  options?: { isPidAlive?: (pid: number) => boolean },
): void {
  if (!state.ownerSessionId || state.ownerSessionId === currentSessionId) {
    return;
  }
  const checkAlive = options?.isPidAlive ?? isProcessAlive;
  if (state.ownerPid > 0 && checkAlive(state.ownerPid)) {
    throw new SwarmProtocolError(
      "OWNERSHIP_CONFLICT",
      `Run "${state.id}" is owned by active session "${state.ownerSessionId}" (PID ${state.ownerPid}); current session "${currentSessionId}" cannot take over or tear down.`,
      {
        runId: state.id,
        ownerSessionId: state.ownerSessionId,
        ownerPid: state.ownerPid,
        currentSessionId,
      },
    );
  }
}

// ============================================================================
// Internal Safety & Persistence Helpers
// ============================================================================

function validateSafeIdentifier(
  value: string,
  label: string,
  pattern: RegExp = SAFE_ID_RE,
): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    trimmed.length === 0 ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    !pattern.test(trimmed)
  ) {
    throw new SwarmProtocolError(
      "INVALID_INPUT",
      `Invalid ${label}: ${JSON.stringify(value)}`,
      { label, value },
    );
  }
  return trimmed;
}

function assertWithinRoot(rootDir: string, targetPath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new SwarmProtocolError(
      "PERMISSION_DENIED",
      `Path escapes project boundary: ${targetPath}`,
      { rootDir: resolvedRoot, targetPath: resolvedTarget },
    );
  }
  return resolvedTarget;
}

/**
 * Verify that no existing path component STRICTLY INSIDE `rootDir` is a symlink.
 * (Ancestors of `rootDir` such as macOS `/var -> /private/var` are intentionally ignored.)
 */
async function assertNoSymlinksWithin(
  rootDir: string,
  targetPath: string,
): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = assertWithinRoot(resolvedRoot, targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (!rel || rel === ".") {
    return;
  }
  const parts = rel.split(path.sep).filter(Boolean);
  let current = resolvedRoot;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Refusing to traverse symlink inside project: ${current}`,
          { path: current },
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

async function assertLeafNotSymlink(targetPath: string): Promise<void> {
  try {
    const st = await lstat(targetPath);
    if (st.isSymbolicLink()) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Refusing to traverse symlink inside project: ${targetPath}`,
        { path: targetPath },
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw err;
  }
}

async function writeTmpAndRename(
  targetPath: string,
  content: string,
): Promise<Stats> {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, targetPath);
    return await lstat(targetPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function cloneRoleModels(roleModels: SwarmRoleModels | undefined): SwarmRoleModels {
  if (!roleModels || typeof roleModels !== "object") {
    return {};
  }
  return {
    ...(roleModels.orchestrator
      ? { orchestrator: { ...roleModels.orchestrator } }
      : {}),
    ...(roleModels.worker ? { worker: { ...roleModels.worker } } : {}),
    ...(roleModels.validator ? { validator: { ...roleModels.validator } } : {}),
    ...(Array.isArray(roleModels.fallbackModels)
      ? { fallbackModels: [...roleModels.fallbackModels] }
      : {}),
  };
}

function ensureMainChannel(state: SwarmRunState): void {
  if (
    !state.channels ||
    typeof state.channels !== "object" ||
    Array.isArray(state.channels)
  ) {
    state.channels = {};
  } else {
    for (const key of Object.keys(state.channels)) {
      if (isPrototypeKey(key)) {
        delete state.channels[key];
      }
    }
  }
  if (!Object.hasOwn(state.channels, DEFAULT_CHANNEL)) {
    state.channels[DEFAULT_CHANNEL] = {
      name: DEFAULT_CHANNEL,
      topic: "Primary swarm coordination channel",
      createdBy: ORCHESTRATOR_NAME,
      createdAt: state.createdAt ?? new Date().toISOString(),
      archived: false,
      subscribers: Object.keys(state.members ?? {}),
    };
  }
}

function normalizeOptionalNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return undefined;
  }
  return Math.floor(raw);
}

function normalizeMilestones(raw: unknown): SwarmMilestone[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized: SwarmMilestone[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const label = normalizeOptionalNonEmptyString(candidate.label);
    const status = candidate.status;
    if (
      !label ||
      typeof status !== "string" ||
      !VALID_MILESTONE_STATUSES.has(status as SwarmMilestone["status"])
    ) {
      continue;
    }
    const owner = normalizeOptionalNonEmptyString(candidate.owner);
    const sealed =
      typeof candidate.sealed === "boolean" ? candidate.sealed : undefined;
    const sealedAt = normalizeOptionalNonEmptyString(candidate.sealedAt);
    normalized.push({
      label,
      status: status as SwarmMilestone["status"],
      ...(owner !== undefined ? { owner } : {}),
      ...(sealed !== undefined ? { sealed } : {}),
      ...(sealedAt !== undefined ? { sealedAt } : {}),
    });
  }
  return normalized;
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

function normalizeOptionalStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return normalizeStringArray(raw);
}

function normalizeAssertions(
  raw: unknown,
  fallbackTimestamp: string,
): MissionAssertion[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized: MissionAssertion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const id = normalizeOptionalNonEmptyString(candidate.id);
    const title = normalizeOptionalNonEmptyString(candidate.title);
    const status = candidate.status;
    if (
      !id ||
      isPrototypeKey(id) ||
      !title ||
      typeof status !== "string" ||
      !VALID_ASSERTION_STATUSES.has(status as AssertionStatus)
    ) {
      continue;
    }
    const description =
      typeof candidate.description === "string"
        ? candidate.description.trim()
        : "";
    const evidenceRequired = normalizeOptionalNonEmptyString(
      candidate.evidenceRequired,
    );
    const evidence = normalizeOptionalNonEmptyString(candidate.evidence);
    const verifiedBy = normalizeOptionalNonEmptyString(candidate.verifiedBy);
    const verifiedByRole =
      typeof candidate.verifiedByRole === "string" &&
      VALID_CALLER_ROLES.has(candidate.verifiedByRole as CallerRole)
        ? (candidate.verifiedByRole as CallerRole)
        : undefined;
    const overridden =
      typeof candidate.overridden === "boolean"
        ? candidate.overridden
        : undefined;
    const overrideJustification = normalizeOptionalNonEmptyString(
      candidate.overrideJustification,
    );
    const updatedAt =
      normalizeOptionalNonEmptyString(candidate.updatedAt) ?? fallbackTimestamp;

    normalized.push({
      id,
      title,
      description,
      ...(evidenceRequired !== undefined ? { evidenceRequired } : {}),
      status: status as AssertionStatus,
      ...(evidence !== undefined ? { evidence } : {}),
      ...(verifiedBy !== undefined ? { verifiedBy } : {}),
      ...(verifiedByRole !== undefined ? { verifiedByRole } : {}),
      ...(overridden !== undefined ? { overridden } : {}),
      ...(overrideJustification !== undefined ? { overrideJustification } : {}),
      updatedAt,
    });
  }
  return normalized;
}

function normalizeFeatures(
  raw: unknown,
  fallbackTimestamp: string,
): MissionFeature[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized: MissionFeature[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const id = normalizeOptionalNonEmptyString(candidate.id);
    const title = normalizeOptionalNonEmptyString(candidate.title);
    const status = candidate.status;
    if (
      !id ||
      isPrototypeKey(id) ||
      !title ||
      typeof candidate.milestone !== "string" ||
      typeof status !== "string" ||
      !VALID_FEATURE_STATUSES.has(status as FeatureStatus)
    ) {
      continue;
    }
    const milestone = candidate.milestone.trim();
    const description =
      typeof candidate.description === "string"
        ? candidate.description.trim()
        : "";
    const dependsOn = normalizeOptionalStringArray(candidate.dependsOn);
    const filesOwned = normalizeOptionalStringArray(candidate.filesOwned);
    const preconditions = normalizeOptionalStringArray(candidate.preconditions);
    const expectedBehavior = normalizeOptionalStringArray(
      candidate.expectedBehavior,
    );
    const verificationSteps = normalizeOptionalStringArray(
      candidate.verificationSteps,
    );
    const fulfills = normalizeStringArray(candidate.fulfills);
    const assignedMember = normalizeOptionalNonEmptyString(
      candidate.assignedMember,
    );
    const mergedCommitSha = normalizeOptionalNonEmptyString(
      candidate.mergedCommitSha,
    );
    const updatedAt =
      normalizeOptionalNonEmptyString(candidate.updatedAt) ?? fallbackTimestamp;

    normalized.push({
      id,
      title,
      description,
      milestone,
      ...(dependsOn !== undefined ? { dependsOn } : {}),
      ...(filesOwned !== undefined ? { filesOwned } : {}),
      ...(preconditions !== undefined ? { preconditions } : {}),
      ...(expectedBehavior !== undefined ? { expectedBehavior } : {}),
      ...(verificationSteps !== undefined ? { verificationSteps } : {}),
      fulfills,
      status: status as FeatureStatus,
      ...(assignedMember !== undefined ? { assignedMember } : {}),
      ...(mergedCommitSha !== undefined ? { mergedCommitSha } : {}),
      updatedAt,
    });
  }
  return normalized;
}

function normalizeHandoffItems(
  raw: unknown,
  fallbackTimestamp: string,
): MissionHandoffItem[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized: MissionHandoffItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const id = normalizeOptionalNonEmptyString(candidate.id);
    const type = candidate.type;
    const sourceMember = normalizeOptionalNonEmptyString(
      candidate.sourceMember,
    );
    const summary = normalizeOptionalNonEmptyString(candidate.summary);
    const resolution = candidate.resolution;
    if (
      !id ||
      isPrototypeKey(id) ||
      typeof type !== "string" ||
      !VALID_HANDOFF_TYPES.has(type as HandoffItemType) ||
      !sourceMember ||
      !summary ||
      typeof resolution !== "string" ||
      !VALID_HANDOFF_RESOLUTIONS.has(resolution as HandoffItemResolution)
    ) {
      continue;
    }
    const sourceFeatureId = normalizeOptionalNonEmptyString(
      candidate.sourceFeatureId,
    );
    const trackedFeatureId = normalizeOptionalNonEmptyString(
      candidate.trackedFeatureId,
    );
    const justification = normalizeOptionalNonEmptyString(
      candidate.justification,
    );
    const createdAt =
      normalizeOptionalNonEmptyString(candidate.createdAt) ?? fallbackTimestamp;
    const resolvedAt = normalizeOptionalNonEmptyString(candidate.resolvedAt);

    normalized.push({
      id,
      type: type as HandoffItemType,
      sourceMember,
      ...(sourceFeatureId !== undefined ? { sourceFeatureId } : {}),
      summary,
      resolution: resolution as HandoffItemResolution,
      ...(trackedFeatureId !== undefined ? { trackedFeatureId } : {}),
      ...(justification !== undefined ? { justification } : {}),
      createdAt,
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    });
  }
  return normalized;
}

function normalizeCommands(raw: unknown): MissionCommandEntry[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized: MissionCommandEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const name = normalizeOptionalNonEmptyString(candidate.name);
    const command = normalizeOptionalNonEmptyString(candidate.command);
    if (!name || !command) {
      continue;
    }
    normalized.push({ name, command });
  }
  return normalized;
}

function normalizeServices(raw: unknown): MissionServiceEntry[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const normalized: MissionServiceEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const name = normalizeOptionalNonEmptyString(candidate.name);
    const start = normalizeOptionalNonEmptyString(candidate.start);
    if (!name || isPrototypeKey(name) || !start) {
      continue;
    }
    const stop = normalizeOptionalNonEmptyString(candidate.stop);
    const healthcheck = normalizeOptionalNonEmptyString(candidate.healthcheck);
    const rawPort = candidate.port;
    const port =
      typeof rawPort === "number" &&
      Number.isFinite(rawPort) &&
      Math.floor(rawPort) >= 1 &&
      Math.floor(rawPort) <= 65535
        ? Math.floor(rawPort)
        : undefined;
    const dependsOn = normalizeOptionalStringArray(candidate.dependsOn);
    normalized.push({
      name,
      start,
      ...(stop !== undefined ? { stop } : {}),
      ...(healthcheck !== undefined ? { healthcheck } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
    });
  }
  return normalized;
}

function normalizeBoundaries(raw: unknown): string[] | undefined {
  return normalizeOptionalStringArray(raw);
}

function normalizeLastAudit(
  raw: unknown,
  fallbackTimestamp: string,
): MissionAuditRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const verdict = candidate.verdict;
  if (
    typeof verdict !== "string" ||
    !VALID_AUDIT_VERDICTS.has(verdict as MissionAuditRecord["verdict"]) ||
    typeof candidate.summary !== "string"
  ) {
    return undefined;
  }
  const summary = candidate.summary.trim();
  const auditor = normalizeOptionalNonEmptyString(candidate.auditor);
  const timestamp =
    normalizeOptionalNonEmptyString(candidate.timestamp) ?? fallbackTimestamp;
  return {
    verdict: verdict as MissionAuditRecord["verdict"],
    summary,
    ...(auditor !== undefined ? { auditor } : {}),
    timestamp,
  };
}

function backfillRunState(state: SwarmRunState): SwarmRunState {
  const raw = state as unknown as Record<string, unknown>;
  state.version = SWARM_STATE_VERSION;
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
    state.title = state.objective || state.id;
  }
  if (typeof raw.strategy !== "string") {
    state.strategy = "";
  }
  if (typeof raw.acceptanceCriteria !== "string") {
    state.acceptanceCriteria = "";
  }
  if (typeof raw.validatorEnabled !== "boolean") {
    state.validatorEnabled = DEFAULT_SWARM_SETTINGS.validatorEnabled;
  }
  if (typeof raw.keepWorkersWarm !== "boolean") {
    state.keepWorkersWarm = DEFAULT_SWARM_SETTINGS.keepWorkersWarm;
  }
  if (
    typeof raw.maxConcurrency !== "number" ||
    !Number.isFinite(raw.maxConcurrency) ||
    raw.maxConcurrency < 1
  ) {
    state.maxConcurrency = DEFAULT_SWARM_SETTINGS.maxConcurrency;
  } else {
    state.maxConcurrency = Math.min(
      SWARM_SETTINGS_BOUNDS.maxConcurrency.max,
      Math.floor(raw.maxConcurrency),
    );
  }
  if (!raw.roleModels || typeof raw.roleModels !== "object") {
    state.roleModels = {};
  }
  if (
    !raw.members ||
    typeof raw.members !== "object" ||
    Array.isArray(raw.members)
  ) {
    state.members = {};
  } else {
    for (const key of Object.keys(state.members)) {
      if (isPrototypeKey(key)) {
        delete state.members[key];
      }
    }
  }
  if (!Array.isArray(raw.memberOrder)) {
    state.memberOrder = Object.keys(state.members);
  }
  if (
    typeof raw.boardHead !== "number" ||
    !Number.isFinite(raw.boardHead) ||
    raw.boardHead < 0
  ) {
    state.boardHead = 0;
  } else {
    state.boardHead = Math.floor(raw.boardHead);
  }
  if (raw.phase !== undefined) {
    const normalizedPhase = normalizeOptionalNonEmptyString(raw.phase);
    if (normalizedPhase !== undefined) {
      state.phase = normalizedPhase;
    } else {
      delete state.phase;
    }
  }
  if (raw.milestones !== undefined) {
    const normalizedMilestones = normalizeMilestones(raw.milestones);
    if (normalizedMilestones !== undefined) {
      state.milestones = normalizedMilestones;
    } else {
      delete state.milestones;
    }
  }
  const fallbackTimestamp =
    normalizeOptionalNonEmptyString(raw.updatedAt) ??
    normalizeOptionalNonEmptyString(raw.createdAt) ??
    new Date().toISOString();
  if (raw.assertions !== undefined) {
    const normalizedAssertions = normalizeAssertions(
      raw.assertions,
      fallbackTimestamp,
    );
    if (normalizedAssertions !== undefined) {
      state.assertions = normalizedAssertions;
    } else {
      delete state.assertions;
    }
  }
  if (raw.features !== undefined) {
    const normalizedFeatures = normalizeFeatures(
      raw.features,
      fallbackTimestamp,
    );
    if (normalizedFeatures !== undefined) {
      state.features = normalizedFeatures;
    } else {
      delete state.features;
    }
  }
  if (raw.handoffItems !== undefined) {
    const normalizedHandoffs = normalizeHandoffItems(
      raw.handoffItems,
      fallbackTimestamp,
    );
    if (normalizedHandoffs !== undefined) {
      state.handoffItems = normalizedHandoffs;
    } else {
      delete state.handoffItems;
    }
  }
  if (raw.commands !== undefined) {
    const normalizedCommands = normalizeCommands(raw.commands);
    if (normalizedCommands !== undefined) {
      state.commands = normalizedCommands;
    } else {
      delete state.commands;
    }
  }
  if (raw.services !== undefined) {
    const normalizedServices = normalizeServices(raw.services);
    if (normalizedServices !== undefined) {
      state.services = normalizedServices;
    } else {
      delete state.services;
    }
  }
  if (raw.boundaries !== undefined) {
    const normalizedBoundaries = normalizeBoundaries(raw.boundaries);
    if (normalizedBoundaries !== undefined) {
      state.boundaries = normalizedBoundaries;
    } else {
      delete state.boundaries;
    }
  }
  if (raw.lastAudit !== undefined) {
    const normalizedAudit = normalizeLastAudit(raw.lastAudit, fallbackTimestamp);
    if (normalizedAudit !== undefined) {
      state.lastAudit = normalizedAudit;
    } else {
      delete state.lastAudit;
    }
  }
  ensureMainChannel(state);
  for (const member of Object.values(state.members)) {
    const rawMember = member as unknown as Record<string, unknown>;
    if (!Array.isArray(member.channels) || member.channels.length === 0) {
      member.channels = [DEFAULT_CHANNEL];
    } else if (!member.channels.includes(DEFAULT_CHANNEL)) {
      member.channels.push(DEFAULT_CHANNEL);
    }
    if (
      typeof member.lastReadSeq !== "number" ||
      !Number.isFinite(member.lastReadSeq)
    ) {
      member.lastReadSeq = 0;
    }
    if (typeof member.turns !== "number" || !Number.isFinite(member.turns)) {
      member.turns = 0;
    }
    if (rawMember.llmTurns !== undefined) {
      const normalizedLlmTurns = normalizeOptionalNonNegativeInt(rawMember.llmTurns);
      if (normalizedLlmTurns !== undefined) {
        member.llmTurns = normalizedLlmTurns;
      } else {
        delete member.llmTurns;
      }
    }
    if (rawMember.lastParkBlockedSeq !== undefined) {
      const normalizedParkBlocked = normalizeOptionalNonNegativeInt(
        rawMember.lastParkBlockedSeq,
      );
      if (normalizedParkBlocked !== undefined) {
        member.lastParkBlockedSeq = normalizedParkBlocked;
      } else {
        delete member.lastParkBlockedSeq;
      }
    }
    if (rawMember.turnStartedAt !== undefined) {
      const normalizedTurnStartedAt = normalizeOptionalNonEmptyString(
        rawMember.turnStartedAt,
      );
      if (normalizedTurnStartedAt !== undefined) {
        member.turnStartedAt = normalizedTurnStartedAt;
      } else {
        delete member.turnStartedAt;
      }
    }
    if (typeof member.tokens !== "number" || !Number.isFinite(member.tokens)) {
      member.tokens = 0;
    }
    if (typeof member.cost !== "number" || !Number.isFinite(member.cost)) {
      member.cost = 0;
    }
    if (typeof member.humanStopped !== "boolean") {
      member.humanStopped = false;
    }
    if (!Array.isArray(member.logTail)) {
      member.logTail = [];
    }
  }
  return state;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const rand = randomUUID().replace(/-/g, "").slice(0, 6);
  return `run_${stamp}_${rand}`;
}

function resolveMemberChannels(
  state: SwarmRunState,
  rawChannels: readonly string[] | undefined,
  runId: string,
): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  if (Array.isArray(rawChannels)) {
    for (const raw of rawChannels) {
      const ch = validateChannelName(raw);
      const record = getOwnRecord(state.channels, ch);
      if (!record) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          `Channel "${ch}" does not exist in run "${runId}".`,
          { runId, channel: ch },
        );
      }
      if (record.archived) {
        throw new SwarmProtocolError(
          "CHANNEL_ARCHIVED",
          `Channel "${ch}" is archived in run "${runId}".`,
          { runId, channel: ch },
        );
      }
      if (!seen.has(ch)) {
        seen.add(ch);
        resolved.push(ch);
      }
    }
  }

  if (!seen.has(DEFAULT_CHANNEL)) {
    resolved.push(DEFAULT_CHANNEL);
  }
  return resolved;
}

function formatRoleModelsSummary(
  roleModels: SwarmRoleModels | undefined,
): string {
  const fmt = (cfg?: { model?: string; thinkingLevel?: string }): string => {
    const model = cfg?.model?.trim() || "default";
    const thinking = cfg?.thinkingLevel ? ` (${cfg.thinkingLevel})` : "";
    return `\`${escapeMarkdownCell(model)}\`${thinking}`;
  };
  const base = `Orchestrator: ${fmt(roleModels?.orchestrator)} | Worker: ${fmt(roleModels?.worker)} | Validator: ${fmt(roleModels?.validator)}`;
  const fallbacks =
    roleModels?.fallbackModels?.filter((m) => m.trim().length > 0) ?? [];
  if (fallbacks.length > 0) {
    return `${base} | Fallbacks: ${fallbacks.map((m) => `\`${escapeMarkdownCell(m)}\``).join(", ")}`;
  }
  return base;
}

interface LockFilePayload {
  pid: number;
  token: string;
  hostname: string;
  createdAt: string;
}

interface RunStateCacheEntry {
  ino: number;
  size: number;
  mtimeMs: number;
  state: SwarmRunState;
  lastCanonicalRosterBody?: string;
  lastMissionBody?: string;
  lastValidationContractBody?: string;
  lastValidationStateBody?: string;
  lastFeaturesBody?: string;
  lastServicesBody?: string;
}

export interface SwarmStoreOptions {
  staleLockMs?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

function canonicalizeRosterForDiff(markdown: string): string {
  return markdown
    .replace(/^- \*\*(?:Revision|Updated At):\*\* .*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

// ============================================================================
// SwarmStore Implementation (Dynamic Antigravity Swarm v2)
// ============================================================================

export class SwarmStore implements ISwarmStore {
  readonly projectRoot: string;
  private readonly swarmRoot: string;
  private readonly runsRoot: string;
  private readonly worktreesRoot: string;
  private readonly locksRoot: string;
  private readonly board: SwarmBoard;
  private readonly staleLockMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly checkPidAlive: (pid: number) => boolean;

  /** In-process per-run mutex queues to serialize local async mutations cleanly. */
  private readonly runQueues = new Map<string, Promise<unknown>>();

  /** Stat-validated per-run state.json and ROSTER.md cache. */
  private readonly stateCache = new Map<string, RunStateCacheEntry>();

  constructor(projectRoot: string, options?: SwarmStoreOptions) {
    this.projectRoot = path.resolve(projectRoot);
    this.swarmRoot = path.join(this.projectRoot, SWARM_DIR);
    this.runsRoot = path.join(this.swarmRoot, SWARM_RUNS_DIR);
    this.worktreesRoot = path.join(this.swarmRoot, SWARM_WORKTREES_DIR);
    this.locksRoot = path.join(this.swarmRoot, SWARM_LOCKS_DIR);
    this.board = new SwarmBoard(this.projectRoot);
    this.staleLockMs = options?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryMs = options?.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.checkPidAlive = options?.isPidAlive ?? isProcessAlive;
  }

  getRunDir(runId: string): string {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.runsRoot, safeRunId),
    );
  }

  getMemberSessionDir(runId: string): string {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.getRunDir(safeRunId), SWARM_SESSIONS_DIR),
    );
  }

  getLibraryDir(runId: string): string {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.getRunDir(safeRunId), SWARM_LIBRARY_DIR),
    );
  }

  private getLibraryTopicPath(runId: string, topic: string): string {
    const safeTopic = validateLibraryTopic(topic);
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.getLibraryDir(runId), `${safeTopic}.md`),
    );
  }

  getWorktreePath(runId: string, memberName: string): string {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    const safeMember = validateSafeIdentifier(memberName, "memberName");
    const dirName = safeMember.startsWith(SWARM_WORKTREE_PREFIX)
      ? safeMember
      : `${SWARM_WORKTREE_PREFIX}${safeMember}`;
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.worktreesRoot, safeRunId, dirName),
    );
  }

  private getStatePath(runId: string): string {
    return path.join(this.getRunDir(runId), SWARM_STATE_FILE);
  }

  private getRosterMarkdownPath(runId: string): string {
    return path.join(this.getRunDir(runId), SWARM_ROSTER_FILE);
  }

  private getEventsPath(runId: string): string {
    return path.join(this.getRunDir(runId), SWARM_EVENTS_FILE);
  }

  private getLockPath(runId: string): string {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.locksRoot, `${safeRunId}.lock`),
    );
  }

  // --------------------------------------------------------------------------
  // Locking & Atomic State Persistence
  // --------------------------------------------------------------------------

  private async withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    const previous = this.runQueues.get(safeRunId) ?? Promise.resolve();
    const runPromise = previous.then(
      () => this.acquireFileLockAndRun(safeRunId, fn),
      () => this.acquireFileLockAndRun(safeRunId, fn),
    );

    const tracker = runPromise.then(
      () => {
        if (this.runQueues.get(safeRunId) === tracker) {
          this.runQueues.delete(safeRunId);
        }
      },
      () => {
        if (this.runQueues.get(safeRunId) === tracker) {
          this.runQueues.delete(safeRunId);
        }
      },
    );
    this.runQueues.set(safeRunId, tracker);
    return runPromise;
  }

  private async acquireFileLockAndRun<T>(
    safeRunId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockPath = this.getLockPath(safeRunId);
    await assertNoSymlinksWithin(this.projectRoot, this.locksRoot);
    await mkdir(this.locksRoot, { recursive: true });
    await assertNoSymlinksWithin(this.projectRoot, lockPath);

    const token = randomUUID();
    const payload: LockFilePayload = {
      pid: process.pid,
      token,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    };
    const deadline = Date.now() + this.lockTimeoutMs;

    let acquired = false;
    let acquiredIno: number | undefined;
    let acquiredDev: number | undefined;
    while (!acquired) {
      try {
        const handle = await open(lockPath, "wx");
        let setupOk = false;
        try {
          await handle.writeFile(JSON.stringify(payload), "utf8");
          const st = await handle.stat();
          acquiredIno = st.ino;
          acquiredDev = st.dev;
          setupOk = true;
        } finally {
          await handle.close().catch(() => {});
          if (!setupOk) {
            await unlink(lockPath).catch(() => {});
          }
        }
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
          throw err;
        }

        const recovered = await this.tryRecoverStaleLock(lockPath);
        if (recovered) {
          continue;
        }

        if (Date.now() >= deadline) {
          throw new SwarmProtocolError(
            "REVISION_CONFLICT",
            `Timed out acquiring lock for run "${safeRunId}" after ${this.lockTimeoutMs}ms`,
            { runId: safeRunId, lockPath },
          );
        }
        await sleep(this.lockRetryMs);
      }
    }

    try {
      return await fn();
    } finally {
      await this.releaseFileLock(lockPath, token, acquiredIno, acquiredDev);
    }
  }

  private async tryRecoverStaleLock(lockPath: string): Promise<boolean> {
    const reapPath = `${lockPath}.reap`;
    const reapStaleMs = Math.max(
      200,
      Math.min(this.staleLockMs, Math.floor(this.lockTimeoutMs / 2), 5_000),
    );
    const reapToken = randomUUID();
    let reapAcquired = false;
    let reapIno = 0;
    let reapDev = 0;

    try {
      const reapHandle = await open(reapPath, "wx");
      let setupOk = false;
      try {
        await reapHandle.writeFile(
          JSON.stringify({
            token: reapToken,
            pid: process.pid,
            hostname: os.hostname(),
            createdAt: new Date().toISOString(),
          }),
          "utf8",
        );
        const reapStat = await reapHandle.stat();
        reapIno = reapStat.ino;
        reapDev = reapStat.dev;
        setupOk = true;
      } finally {
        await reapHandle.close().catch(() => {});
        if (!setupOk) {
          await unlink(reapPath).catch(() => {});
        }
      }
      reapAcquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        return false;
      }
      try {
        const reapStat = await lstat(reapPath);
        if (reapStat.isSymbolicLink()) {
          throw new SwarmProtocolError(
            "PERMISSION_DENIED",
            `Refusing to use symlinked reap lock file: ${reapPath}`,
            { lockPath: reapPath },
          );
        }
        let reapInfo: Partial<LockFilePayload> = {};
        let reapParsed = false;
        try {
          const reapRaw = await readFile(reapPath, "utf8");
          const parsed = JSON.parse(reapRaw) as Partial<LockFilePayload>;
          if (parsed && typeof parsed === "object") {
            reapInfo = parsed;
            reapParsed = true;
          }
        } catch {
          // Malformed or empty .reap file; fall back to mtime staleness check.
        }

        const isReapStale =
          Date.now() - reapStat.mtimeMs >= reapStaleMs ||
          (typeof reapInfo.pid === "number" &&
            (!reapInfo.hostname || reapInfo.hostname === os.hostname()) &&
            !this.checkPidAlive(reapInfo.pid));

        if (isReapStale) {
          const confirmStat = await lstat(reapPath);
          if (confirmStat.isSymbolicLink()) {
            throw new SwarmProtocolError(
              "PERMISSION_DENIED",
              `Refusing to use symlinked reap lock file: ${reapPath}`,
              { lockPath: reapPath },
            );
          }
          if (
            confirmStat.ino === reapStat.ino &&
            confirmStat.dev === reapStat.dev
          ) {
            let tokenMatches = true;
            if (reapParsed && typeof reapInfo.token === "string") {
              try {
                const confirmRaw = await readFile(reapPath, "utf8");
                const confirmInfo = JSON.parse(
                  confirmRaw,
                ) as Partial<LockFilePayload>;
                if (confirmInfo.token !== reapInfo.token) {
                  tokenMatches = false;
                }
              } catch {
                tokenMatches = false;
              }
            } else if (
              confirmStat.size !== reapStat.size ||
              confirmStat.mtimeMs !== reapStat.mtimeMs
            ) {
              tokenMatches = false;
            }
            if (tokenMatches) {
              await unlink(reapPath).catch(() => {});
            }
          }
        }
      } catch (innerErr) {
        if (innerErr instanceof SwarmProtocolError) {
          throw innerErr;
        }
        // Another recoverer just finished and removed the reap lock.
      }
      return false;
    }

    try {
      const st = await lstat(lockPath);
      if (st.isSymbolicLink()) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Refusing to use symlinked lock file: ${lockPath}`,
          { lockPath },
        );
      }
      const ageMs = Date.now() - st.mtimeMs;
      let isStale = ageMs >= this.staleLockMs;
      let expectedToken: string | undefined;

      try {
        const raw = await readFile(lockPath, "utf8");
        const info = JSON.parse(raw) as Partial<LockFilePayload>;
        expectedToken = typeof info.token === "string" ? info.token : undefined;
        if (!isStale) {
          const createdMs = info.createdAt
            ? Date.parse(info.createdAt)
            : Number.NaN;
          if (
            Number.isFinite(createdMs) &&
            Date.now() - createdMs >= this.staleLockMs
          ) {
            isStale = true;
          } else if (
            typeof info.pid === "number" &&
            (!info.hostname || info.hostname === os.hostname()) &&
            !this.checkPidAlive(info.pid)
          ) {
            isStale = true;
          }
        }
      } catch {
        if (ageMs >= Math.min(this.staleLockMs, 2_000)) {
          isStale = true;
        }
      }

      if (!isStale) {
        return false;
      }

      // Confirm we still hold the .reap lock right before final lockPath verification and unlink.
      try {
        const reapCheck = await lstat(reapPath);
        if (reapCheck.ino !== reapIno || reapCheck.dev !== reapDev) {
          return false;
        }
      } catch {
        return false;
      }

      // Re-verify inode/dev and token (or size/mtime for 0-byte/unparsed locks) right before unlink so a concurrent release+reacquire is never deleted.
      const currentStat = await lstat(lockPath);
      if (currentStat.isSymbolicLink()) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Refusing to use symlinked lock file: ${lockPath}`,
          { lockPath },
        );
      }
      if (currentStat.ino !== st.ino || currentStat.dev !== st.dev) {
        return false;
      }
      if (expectedToken !== undefined) {
        try {
          const currentRaw = await readFile(lockPath, "utf8");
          const currentInfo = JSON.parse(currentRaw) as Partial<LockFilePayload>;
          if (currentInfo.token !== expectedToken) {
            return false;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            throw err;
          }
          return false;
        }
      } else if (
        currentStat.size !== st.size ||
        currentStat.mtimeMs !== st.mtimeMs
      ) {
        return false;
      }

      await unlink(lockPath).catch(() => {});
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return true;
      }
      throw err;
    } finally {
      if (reapAcquired) {
        try {
          const reapCheck = await lstat(reapPath);
          if (reapCheck.ino === reapIno && reapCheck.dev === reapDev) {
            await unlink(reapPath).catch(() => {});
          }
        } catch {
          // .reap already removed or inaccessible.
        }
      }
    }
  }

  private async releaseFileLock(
    lockPath: string,
    token: string,
    expectedIno?: number,
    expectedDev?: number,
  ): Promise<void> {
    try {
      const stBefore = await lstat(lockPath);
      if (stBefore.isSymbolicLink()) {
        return;
      }
      if (
        (expectedIno !== undefined && stBefore.ino !== expectedIno) ||
        (expectedDev !== undefined && stBefore.dev !== expectedDev)
      ) {
        return;
      }
      const raw = await readFile(lockPath, "utf8");
      const info = JSON.parse(raw) as Partial<LockFilePayload>;
      if (info.token !== token) {
        return;
      }
      const stAfter = await lstat(lockPath);
      if (
        stAfter.isSymbolicLink() ||
        stAfter.ino !== stBefore.ino ||
        stAfter.dev !== stBefore.dev
      ) {
        return;
      }
      await unlink(lockPath).catch(() => {});
    } catch {
      // Lock already removed or unreadable; nothing left to release.
    }
  }

  private setStateCacheEntry(runId: string, entry: RunStateCacheEntry): void {
    if (this.stateCache.has(runId)) {
      this.stateCache.delete(runId);
    } else if (this.stateCache.size >= 32) {
      const oldest = this.stateCache.keys().next().value;
      if (oldest !== undefined) {
        this.stateCache.delete(oldest);
      }
    }
    this.stateCache.set(runId, entry);
  }

  private async readStateUnlocked(
    runId: string,
    options?: { runsRootVerified?: boolean },
  ): Promise<SwarmRunState> {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    const statePath = this.getStatePath(safeRunId);
    await assertNoSymlinksWithin(
      options?.runsRootVerified ? this.runsRoot : this.projectRoot,
      statePath,
    );
    try {
      const st = await lstat(statePath);
      const cached = this.stateCache.get(safeRunId);
      if (
        cached &&
        cached.ino === st.ino &&
        cached.size === st.size &&
        cached.mtimeMs === st.mtimeMs
      ) {
        this.setStateCacheEntry(safeRunId, cached);
        return structuredClone(cached.state);
      }

      const handle = await open(statePath, "r");
      let raw: string;
      let actualStat: Awaited<ReturnType<typeof handle.stat>>;
      try {
        actualStat = await handle.stat();
        raw = await handle.readFile("utf8");
      } finally {
        await handle.close().catch(() => {});
      }
      const parsed = JSON.parse(raw) as SwarmRunState;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.id !== "string"
      ) {
        this.stateCache.delete(safeRunId);
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Corrupted run state for "${safeRunId}"`,
          { runId: safeRunId },
        );
      }
      const backfilled = backfillRunState(parsed);
      this.setStateCacheEntry(safeRunId, {
        ino: actualStat.ino,
        size: actualStat.size,
        mtimeMs: actualStat.mtimeMs,
        state: structuredClone(backfilled),
      });
      return backfilled;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.stateCache.delete(safeRunId);
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Swarm run "${safeRunId}" not found`,
          { runId: safeRunId },
        );
      }
      if (err instanceof SyntaxError) {
        this.stateCache.delete(safeRunId);
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Corrupted run state for "${safeRunId}"`,
          { runId: safeRunId },
        );
      }
      throw err;
    }
  }

  private async persistStateUnlocked(
    state: SwarmRunState,
  ): Promise<SwarmRunState> {
    const runDir = this.getRunDir(state.id);
    await assertNoSymlinksWithin(this.projectRoot, runDir);
    await mkdir(runDir, { recursive: true });
    await assertNoSymlinksWithin(this.projectRoot, runDir);

    const statePath = assertWithinRoot(
      this.projectRoot,
      path.join(runDir, SWARM_STATE_FILE),
    );
    const rosterMdPath = assertWithinRoot(
      this.projectRoot,
      path.join(runDir, SWARM_ROSTER_FILE),
    );
    const missionMdPath = assertWithinRoot(
      this.projectRoot,
      path.join(runDir, SWARM_MISSION_FILE),
    );
    const validationContractPath = assertWithinRoot(
      this.projectRoot,
      path.join(runDir, SWARM_VALIDATION_CONTRACT_FILE),
    );
    const validationStatePath = assertWithinRoot(
      this.projectRoot,
      path.join(runDir, SWARM_VALIDATION_STATE_FILE),
    );
    const featuresJsonPath = assertWithinRoot(
      this.projectRoot,
      path.join(runDir, SWARM_FEATURES_FILE),
    );
    const servicesJsonPath = assertWithinRoot(
      this.projectRoot,
      path.join(runDir, SWARM_SERVICES_FILE),
    );

    const json = `${JSON.stringify(state, null, 2)}\n`;
    const rosterBody = this.renderRosterMarkdown(state);
    const canonicalRosterBody = canonicalizeRosterForDiff(rosterBody);
    const missionBody = this.renderMissionMarkdown(state);
    const validationContractBody =
      state.assertions !== undefined
        ? this.renderValidationContractMarkdown(state)
        : undefined;
    const validationStateBody =
      state.assertions !== undefined
        ? this.renderValidationStateJson(state)
        : undefined;
    const featuresBody =
      state.features !== undefined ? this.renderFeaturesJson(state) : undefined;
    const servicesBody =
      state.services !== undefined && state.services.length > 0
        ? this.renderServicesJson(state)
        : undefined;

    const cached = this.stateCache.get(state.id);
    const shouldWriteRoster =
      !cached?.lastCanonicalRosterBody ||
      canonicalRosterBody !== cached.lastCanonicalRosterBody;
    const shouldWriteMission =
      !cached?.lastMissionBody || missionBody !== cached.lastMissionBody;
    const shouldWriteValidationContract =
      validationContractBody !== undefined &&
      (!cached?.lastValidationContractBody ||
        validationContractBody !== cached.lastValidationContractBody);
    const shouldWriteValidationState =
      validationStateBody !== undefined &&
      (!cached?.lastValidationStateBody ||
        validationStateBody !== cached.lastValidationStateBody);
    const shouldWriteFeatures =
      featuresBody !== undefined &&
      (!cached?.lastFeaturesBody || featuresBody !== cached.lastFeaturesBody);
    const shouldWriteServices =
      servicesBody !== undefined &&
      (!cached?.lastServicesBody || servicesBody !== cached.lastServicesBody);

    const shouldRemoveValidationArtifacts =
      state.assertions === undefined &&
      (cached?.state.assertions !== undefined ||
        cached?.lastValidationContractBody !== undefined ||
        cached?.lastValidationStateBody !== undefined);
    const shouldRemoveFeaturesArtifact =
      state.features === undefined &&
      (cached?.state.features !== undefined ||
        cached?.lastFeaturesBody !== undefined);
    const shouldRemoveServicesArtifact =
      servicesBody === undefined &&
      ((cached?.state.services !== undefined &&
        cached.state.services.length > 0) ||
        cached?.lastServicesBody !== undefined);

    await assertLeafNotSymlink(statePath);
    if (shouldWriteRoster) {
      await assertLeafNotSymlink(rosterMdPath);
    }
    if (shouldWriteMission) {
      await assertLeafNotSymlink(missionMdPath);
    }
    if (shouldWriteValidationContract || shouldRemoveValidationArtifacts) {
      await assertLeafNotSymlink(validationContractPath);
    }
    if (shouldWriteValidationState || shouldRemoveValidationArtifacts) {
      await assertLeafNotSymlink(validationStatePath);
    }
    if (shouldWriteFeatures || shouldRemoveFeaturesArtifact) {
      await assertLeafNotSymlink(featuresJsonPath);
    }
    if (shouldWriteServices || shouldRemoveServicesArtifact) {
      await assertLeafNotSymlink(servicesJsonPath);
    }

    const [stateStat] = await Promise.all([
      writeTmpAndRename(statePath, json),
      ...(shouldWriteRoster
        ? [writeTmpAndRename(rosterMdPath, rosterBody)]
        : []),
      ...(shouldWriteMission
        ? [writeTmpAndRename(missionMdPath, missionBody)]
        : []),
      ...(shouldWriteValidationContract && validationContractBody !== undefined
        ? [writeTmpAndRename(validationContractPath, validationContractBody)]
        : []),
      ...(shouldWriteValidationState && validationStateBody !== undefined
        ? [writeTmpAndRename(validationStatePath, validationStateBody)]
        : []),
      ...(shouldWriteFeatures && featuresBody !== undefined
        ? [writeTmpAndRename(featuresJsonPath, featuresBody)]
        : []),
      ...(shouldWriteServices && servicesBody !== undefined
        ? [writeTmpAndRename(servicesJsonPath, servicesBody)]
        : []),
      ...(shouldRemoveValidationArtifacts
        ? [
            unlink(validationContractPath).catch(() => {}),
            unlink(validationStatePath).catch(() => {}),
          ]
        : []),
      ...(shouldRemoveFeaturesArtifact
        ? [unlink(featuresJsonPath).catch(() => {})]
        : []),
      ...(shouldRemoveServicesArtifact
        ? [unlink(servicesJsonPath).catch(() => {})]
        : []),
    ]);

    const cachedState = structuredClone(state);
    this.setStateCacheEntry(state.id, {
      ino: stateStat.ino,
      size: stateStat.size,
      mtimeMs: stateStat.mtimeMs,
      state: cachedState,
      lastCanonicalRosterBody: shouldWriteRoster
        ? canonicalRosterBody
        : cached.lastCanonicalRosterBody,
      lastMissionBody: missionBody,
      ...(validationContractBody !== undefined
        ? { lastValidationContractBody: validationContractBody }
        : {}),
      ...(validationStateBody !== undefined
        ? { lastValidationStateBody: validationStateBody }
        : {}),
      ...(featuresBody !== undefined ? { lastFeaturesBody: featuresBody } : {}),
      ...(servicesBody !== undefined ? { lastServicesBody: servicesBody } : {}),
    });
    return structuredClone(cachedState);
  }

  private checkExpectedRevision(
    state: SwarmRunState,
    expectedRevision: number | undefined,
  ): void {
    if (
      expectedRevision !== undefined &&
      state.revision !== expectedRevision
    ) {
      throw new SwarmProtocolError(
        "REVISION_CONFLICT",
        `Revision conflict for run "${state.id}": expected ${expectedRevision}, actual ${state.revision}`,
        {
          runId: state.id,
          expectedRevision,
          actualRevision: state.revision,
        },
      );
    }
  }

  // --------------------------------------------------------------------------
  // Run Lifecycle Operations
  // --------------------------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<SwarmRunState> {
    const runId = input.id
      ? validateSafeIdentifier(input.id, "runId")
      : generateRunId();

    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        "Run title must not be empty.",
      );
    }
    const objective =
      typeof input.objective === "string" ? input.objective.trim() : "";
    if (!objective) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        "Run objective must not be empty.",
      );
    }
    const baseBranch =
      typeof input.baseBranch === "string" ? input.baseBranch.trim() : "";
    if (!baseBranch) {
      throw new SwarmProtocolError(
        "WRONG_BRANCH",
        "Base branch must not be empty.",
      );
    }
    const ownerSessionId =
      typeof input.ownerSessionId === "string"
        ? input.ownerSessionId.trim()
        : "";
    if (!ownerSessionId) {
      throw new SwarmProtocolError(
        "OWNERSHIP_CONFLICT",
        "ownerSessionId must not be empty.",
      );
    }

    return this.withRunLock(runId, async () => {
      const statePath = this.getStatePath(runId);
      await assertNoSymlinksWithin(this.projectRoot, statePath);
      try {
        await stat(statePath);
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Run "${runId}" already exists.`,
          { runId },
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
      }

      const now = new Date().toISOString();
      const rawConcurrency =
        typeof input.maxConcurrency === "number" &&
        Number.isFinite(input.maxConcurrency)
          ? input.maxConcurrency
          : DEFAULT_SWARM_SETTINGS.maxConcurrency;
      const maxConcurrency = Math.min(
        SWARM_SETTINGS_BOUNDS.maxConcurrency.max,
        Math.max(1, Math.floor(rawConcurrency)),
      );

      const channels: Record<string, SwarmChannelRecord> = {
        [DEFAULT_CHANNEL]: {
          name: DEFAULT_CHANNEL,
          topic: "Primary swarm coordination channel",
          createdBy: ORCHESTRATOR_NAME,
          createdAt: now,
          archived: false,
          subscribers: [],
        },
      };

      const initialPhase = normalizeOptionalNonEmptyString(input.phase);
      const initialMilestones = normalizeMilestones(input.milestones);
      const initialAssertions = normalizeAssertions(input.assertions, now);
      const initialFeatures = normalizeFeatures(input.features, now);
      const initialHandoffItems = normalizeHandoffItems(
        input.handoffItems,
        now,
      );
      const initialCommands = normalizeCommands(input.commands);
      const initialServices = normalizeServices(input.services);
      const initialBoundaries = normalizeBoundaries(input.boundaries);
      const initialAudit = normalizeLastAudit(input.lastAudit, now);
      const state: SwarmRunState = {
        version: SWARM_STATE_VERSION,
        id: runId,
        title,
        objective,
        strategy: input.strategy?.trim() ?? "",
        acceptanceCriteria: input.acceptanceCriteria?.trim() ?? "",
        baseBranch,
        ownerSessionId,
        ownerPid: input.ownerPid ?? process.pid,
        status: "active",
        ...(initialPhase !== undefined ? { phase: initialPhase } : {}),
        ...(initialMilestones !== undefined
          ? { milestones: initialMilestones }
          : {}),
        ...(initialAssertions !== undefined
          ? { assertions: initialAssertions }
          : {}),
        ...(initialFeatures !== undefined ? { features: initialFeatures } : {}),
        ...(initialHandoffItems !== undefined
          ? { handoffItems: initialHandoffItems }
          : {}),
        ...(initialCommands !== undefined ? { commands: initialCommands } : {}),
        ...(initialServices !== undefined ? { services: initialServices } : {}),
        ...(initialBoundaries !== undefined
          ? { boundaries: initialBoundaries }
          : {}),
        ...(initialAudit !== undefined ? { lastAudit: initialAudit } : {}),
        maxConcurrency,
        validatorEnabled:
          input.validatorEnabled ?? DEFAULT_SWARM_SETTINGS.validatorEnabled,
        keepWorkersWarm:
          input.keepWorkersWarm ?? DEFAULT_SWARM_SETTINGS.keepWorkersWarm,
        roleModels: cloneRoleModels(input.roleModels),
        revision: 1,
        members: {},
        memberOrder: [],
        channels,
        boardHead: 0,
        createdAt: now,
        updatedAt: now,
      };

      const saved = await this.persistStateUnlocked(state);
      await this.ensureLibraryInitializedUnlocked(runId);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "run_created",
        actor: ORCHESTRATOR_NAME,
        summary: `Created run "${runId}" (${title}) on base "${baseBranch}".`,
        data: {
          title,
          baseBranch,
          maxConcurrency: state.maxConcurrency,
          validatorEnabled: state.validatorEnabled,
        },
      });
      return saved;
    });
  }

  async loadRun(runId: string): Promise<SwarmRunState> {
    validateSafeIdentifier(runId, "runId");
    return this.readStateUnlocked(runId);
  }

  async listRuns(): Promise<RunSummary[]> {
    await assertNoSymlinksWithin(this.projectRoot, this.runsRoot);
    let entries: string[];
    try {
      entries = await readdir(this.runsRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const validEntries = entries.filter(
      (entry) => SAFE_ID_RE.test(entry) && !entry.includes(".."),
    );
    const summaries: RunSummary[] = [];
    const CONCURRENCY = 8;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < validEntries.length) {
        const entry = validEntries[cursor++];
        try {
          const state = await this.readStateUnlocked(entry, {
            runsRootVerified: true,
          });
          const allMembers = Object.values(state.members);
          const workingCount = allMembers.filter(
            (m) => m.state === "working",
          ).length;
          const waitingCount = allMembers.filter(
            (m) => m.state === "waiting",
          ).length;
          summaries.push({
            id: state.id,
            title: state.title,
            objective: state.objective,
            baseBranch: state.baseBranch,
            status: state.status,
            memberCount: allMembers.length,
            workingCount,
            waitingCount,
            boardHead: state.boardHead,
            ownerSessionId: state.ownerSessionId,
            ownerPid: state.ownerPid,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
          });
        } catch {
          // Ignore non-run or unreadable subdirectories.
        }
      }
    };

    const workerCount = Math.min(CONCURRENCY, validEntries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    summaries.sort((a, b) => {
      const cmp = b.updatedAt.localeCompare(a.updatedAt);
      if (cmp !== 0) return cmp;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return summaries;
  }

  async getActiveRunId(): Promise<string | null> {
    const runs = await this.listRuns();
    const active = runs.find((r) => r.status === "active");
    if (active) {
      return active.id;
    }
    const paused = runs.find((r) => r.status === "paused");
    return paused ? paused.id : null;
  }

  async updateRun(
    runId: string,
    patch: RunUpdateInput,
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, patch.expectedRevision);

      if (patch.status !== undefined && !VALID_RUN_STATUSES.has(patch.status)) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Invalid run status "${String(patch.status)}" for run "${runId}".`,
          { runId, status: patch.status },
        );
      }

      const previousStatus = state.status;
      const previousTitle = state.title;

      if (patch.title !== undefined) {
        const trimmed = patch.title.trim();
        if (!trimmed) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            "Run title must not be empty.",
            { runId },
          );
        }
        state.title = trimmed;
      }
      if (patch.objective !== undefined) {
        const trimmed = patch.objective.trim();
        if (!trimmed) {
          throw new SwarmProtocolError(
            "INVALID_INPUT",
            "Run objective must not be empty.",
            { runId },
          );
        }
        state.objective = trimmed;
      }
      if (patch.strategy !== undefined) {
        state.strategy = patch.strategy.trim();
      }
      if (patch.acceptanceCriteria !== undefined) {
        state.acceptanceCriteria = patch.acceptanceCriteria.trim();
      }
      if (patch.baseBranch !== undefined) {
        const trimmed = patch.baseBranch.trim();
        if (!trimmed) {
          throw new SwarmProtocolError(
            "WRONG_BRANCH",
            "Base branch must not be empty.",
            { runId },
          );
        }
        state.baseBranch = trimmed;
      }
      if (patch.status !== undefined) {
        state.status = patch.status;
      }
      if (
        patch.maxConcurrency !== undefined &&
        typeof patch.maxConcurrency === "number" &&
        Number.isFinite(patch.maxConcurrency)
      ) {
        state.maxConcurrency = Math.min(
          SWARM_SETTINGS_BOUNDS.maxConcurrency.max,
          Math.max(1, Math.floor(patch.maxConcurrency)),
        );
      }
      if (patch.validatorEnabled !== undefined) {
        state.validatorEnabled = patch.validatorEnabled;
      }
      if (patch.keepWorkersWarm !== undefined) {
        state.keepWorkersWarm = patch.keepWorkersWarm;
      }
      if (patch.roleModels !== undefined) {
        state.roleModels = cloneRoleModels(patch.roleModels);
      }
      if (patch.ownerSessionId !== undefined) {
        state.ownerSessionId = patch.ownerSessionId;
      }
      if (patch.ownerPid !== undefined) {
        state.ownerPid = patch.ownerPid;
      }
      if (patch.phase === null) {
        delete state.phase;
      } else if (patch.phase !== undefined) {
        const normalizedPhase = normalizeOptionalNonEmptyString(patch.phase);
        if (normalizedPhase !== undefined) {
          state.phase = normalizedPhase;
        } else {
          delete state.phase;
        }
      }
      const now = new Date().toISOString();
      if (patch.milestones === null) {
        delete state.milestones;
      } else if (patch.milestones !== undefined) {
        const normalizedMilestones = normalizeMilestones(patch.milestones);
        if (normalizedMilestones !== undefined) {
          state.milestones = normalizedMilestones;
        } else {
          delete state.milestones;
        }
      }
      if (patch.assertions === null) {
        delete state.assertions;
      } else if (patch.assertions !== undefined) {
        const normalizedAssertions = normalizeAssertions(patch.assertions, now);
        if (normalizedAssertions !== undefined) {
          state.assertions = normalizedAssertions;
        } else {
          delete state.assertions;
        }
      }
      if (patch.features === null) {
        delete state.features;
      } else if (patch.features !== undefined) {
        const normalizedFeatures = normalizeFeatures(patch.features, now);
        if (normalizedFeatures !== undefined) {
          state.features = normalizedFeatures;
        } else {
          delete state.features;
        }
      }
      if (patch.handoffItems === null) {
        delete state.handoffItems;
      } else if (patch.handoffItems !== undefined) {
        const normalizedHandoffs = normalizeHandoffItems(
          patch.handoffItems,
          now,
        );
        if (normalizedHandoffs !== undefined) {
          state.handoffItems = normalizedHandoffs;
        } else {
          delete state.handoffItems;
        }
      }
      if (patch.commands === null) {
        delete state.commands;
      } else if (patch.commands !== undefined) {
        const normalizedCommands = normalizeCommands(patch.commands);
        if (normalizedCommands !== undefined) {
          state.commands = normalizedCommands;
        } else {
          delete state.commands;
        }
      }
      if (patch.services === null) {
        delete state.services;
      } else if (patch.services !== undefined) {
        const normalizedServices = normalizeServices(patch.services);
        if (normalizedServices !== undefined) {
          state.services = normalizedServices;
        } else {
          delete state.services;
        }
      }
      if (patch.boundaries === null) {
        delete state.boundaries;
      } else if (patch.boundaries !== undefined) {
        const normalizedBoundaries = normalizeBoundaries(patch.boundaries);
        if (normalizedBoundaries !== undefined) {
          state.boundaries = normalizedBoundaries;
        } else {
          delete state.boundaries;
        }
      }
      if (patch.lastAudit === null) {
        delete state.lastAudit;
      } else if (patch.lastAudit !== undefined) {
        const normalizedAudit = normalizeLastAudit(patch.lastAudit, now);
        if (normalizedAudit !== undefined) {
          state.lastAudit = normalizedAudit;
        } else {
          delete state.lastAudit;
        }
      }
      if (patch.completionSummary !== undefined) {
        state.completionSummary = patch.completionSummary;
      }

      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);
      const actor = patch.actor ?? ORCHESTRATOR_NAME;

      if (patch.title !== undefined && state.title !== previousTitle) {
        await appendLedgerEvent(this.getEventsPath(runId), {
          runId,
          type: "run_titled",
          actor,
          summary: `Renamed swarm to "${state.title}".`,
          data: { previousTitle, title: state.title },
        });
      }

      if (patch.status && patch.status !== previousStatus) {
        const eventType =
          patch.status === "paused"
            ? "run_paused"
            : patch.status === "active" && previousStatus === "paused"
              ? "run_resumed"
              : patch.status === "completed"
                ? "run_completed"
                : patch.status === "abandoned"
                  ? "run_abandoned"
                  : null;
        if (eventType) {
          await appendLedgerEvent(this.getEventsPath(runId), {
            runId,
            type: eventType,
            actor,
            summary: `Run "${runId}" transitioned ${previousStatus} -> ${patch.status}.`,
            ...(patch.status === "completed" && state.completionSummary
              ? { data: { completionSummary: state.completionSummary } }
              : {}),
          });
        }
      }

      return saved;
    });
  }

  /**
   * Live-session ownership check helper: allows teardown only by owning session
   * or when the owning PID is no longer alive.
   */
  async assertOwnerSession(
    runIdOrState: string | SwarmRunState,
    currentSessionId: string,
  ): Promise<void> {
    const state =
      typeof runIdOrState === "string"
        ? await this.loadRun(runIdOrState)
        : runIdOrState;
    assertOwnerSession(state, currentSessionId, {
      isPidAlive: this.checkPidAlive,
    });
  }

  // --------------------------------------------------------------------------
  // Dynamic Member Roster Operations
  // --------------------------------------------------------------------------

  async addMember(
    runId: string,
    member: RegisterMemberInput,
    options?: { expectedRevision?: number; actor?: string },
  ): Promise<SwarmRunState> {
    const name = validateMemberName(member.name);
    if (!VALID_MEMBER_ROLES.has(member.role)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Invalid member role "${String(member.role)}" for "${name}".`,
        { runId, memberName: name, role: member.role },
      );
    }
    if (!VALID_WORKSPACE_MODES.has(member.workspace)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Invalid workspace mode "${String(member.workspace)}" for "${name}".`,
        { runId, memberName: name, workspace: member.workspace },
      );
    }
    const initialState: SwarmMemberState = member.state ?? "working";
    if (!VALID_MEMBER_STATES.has(initialState)) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Invalid initial member state "${String(member.state)}" for "${name}".`,
        { runId, memberName: name, state: member.state },
      );
    }
    const agentId =
      typeof member.agentId === "string" ? member.agentId.trim() : "";
    if (!agentId) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Member "${name}" agentId must not be empty.`,
        { runId, memberName: name },
      );
    }
    const parentName =
      typeof member.parentName === "string" ? member.parentName.trim() : "";
    if (!parentName) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Member "${name}" parentName must not be empty.`,
        { runId, memberName: name },
      );
    }
    const cwd = typeof member.cwd === "string" ? member.cwd.trim() : "";
    if (!cwd) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Member "${name}" cwd must not be empty.`,
        { runId, memberName: name },
      );
    }

    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, options?.expectedRevision);

      if (Object.hasOwn(state.members, name)) {
        throw new SwarmProtocolError(
          "DUPLICATE_MEMBER",
          `Member "${name}" already exists in run "${runId}".`,
          { runId, memberName: name },
        );
      }

      const channels = resolveMemberChannels(state, member.channels, runId);
      const now = member.createdAt ?? new Date().toISOString();

      const initialTurnStartedAt = normalizeOptionalNonEmptyString(
        member.turnStartedAt,
      );
      const initialLlmTurns = normalizeOptionalNonNegativeInt(member.llmTurns);

      const record: SwarmMemberRecord = {
        name,
        agentId,
        role: member.role,
        state: initialState,
        parentName,
        ...(member.groupPrefix !== undefined
          ? { groupPrefix: member.groupPrefix }
          : {}),
        brief: member.brief,
        ...(member.briefSeq !== undefined ? { briefSeq: member.briefSeq } : {}),
        workspace: member.workspace,
        cwd,
        ...(member.branch !== undefined ? { branch: member.branch } : {}),
        ...(member.sessionFile !== undefined
          ? { sessionFile: member.sessionFile }
          : {}),
        ...(member.forkedFrom !== undefined
          ? { forkedFrom: member.forkedFrom }
          : {}),
        channels,
        ...(member.model !== undefined ? { model: member.model } : {}),
        ...(member.thinkingLevel !== undefined
          ? { thinkingLevel: member.thinkingLevel }
          : {}),
        ...(member.modelExplicit !== undefined
          ? { modelExplicit: member.modelExplicit }
          : {}),
        lastReadSeq:
          typeof member.lastReadSeq === "number" &&
          Number.isFinite(member.lastReadSeq)
            ? Math.max(0, Math.floor(member.lastReadSeq))
            : 0,
        turns: 0,
        ...(initialLlmTurns !== undefined ? { llmTurns: initialLlmTurns } : {}),
        ...(initialTurnStartedAt !== undefined
          ? { turnStartedAt: initialTurnStartedAt }
          : {}),
        tokens: 0,
        cost: 0,
        humanStopped: false,
        logTail: [],
        createdAt: now,
        updatedAt: now,
      };

      state.members[name] = record;
      state.memberOrder.push(name);

      for (const ch of channels) {
        const channelRecord = getOwnRecord(state.channels, ch);
        if (channelRecord && !channelRecord.subscribers.includes(name)) {
          channelRecord.subscribers.push(name);
        }
      }

      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "member_added",
        actor: options?.actor ?? parentName,
        memberName: name,
        agentId,
        summary: `Added ${record.role} "${name}" (${record.workspace}, parent: ${parentName}).`,
        data: {
          role: record.role,
          parentName,
          workspace: record.workspace,
          channels: record.channels,
          ...(record.groupPrefix ? { groupPrefix: record.groupPrefix } : {}),
          ...(record.forkedFrom ? { forkedFrom: record.forkedFrom } : {}),
          ...(record.model ? { model: record.model } : {}),
        },
      });

      return saved;
    });
  }

  async updateMember(
    runId: string,
    memberName: string,
    patch: MemberUpdateInput,
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, patch.expectedRevision);

      const record = getOwnRecord(state.members, memberName);
      if (!record) {
        throw new SwarmProtocolError(
          "MEMBER_NOT_FOUND",
          `Member "${memberName}" not found in run "${runId}".`,
          { runId, memberName },
        );
      }

      if (
        patch.state !== undefined &&
        !VALID_MEMBER_STATES.has(patch.state)
      ) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Invalid member state "${String(patch.state)}" for "${memberName}".`,
          { runId, memberName, state: patch.state },
        );
      }

      const previousState = record.state;
      const previousMergedSha = record.mergedCommitSha;

      if (
        previousState === "killed" &&
        patch.state !== undefined &&
        patch.state !== "killed"
      ) {
        throw new SwarmProtocolError(
          "MEMBER_KILLED",
          `Member "${memberName}" is permanently killed and cannot transition to "${patch.state}".`,
          { runId, memberName, targetState: patch.state },
        );
      }

      if (patch.channels !== undefined) {
        const nextChannels = resolveMemberChannels(state, patch.channels, runId);
        const nextSet = new Set(nextChannels);
        for (const channelRecord of Object.values(state.channels)) {
          const idx = channelRecord.subscribers.indexOf(memberName);
          if (nextSet.has(channelRecord.name)) {
            if (idx === -1) {
              channelRecord.subscribers.push(memberName);
            }
          } else if (idx !== -1) {
            channelRecord.subscribers.splice(idx, 1);
          }
        }
        record.channels = nextChannels;
      }

      if (patch.state !== undefined) record.state = patch.state;
      if (
        patch.briefSeq !== undefined &&
        Number.isFinite(patch.briefSeq)
      ) {
        record.briefSeq = Math.max(0, Math.floor(patch.briefSeq));
      }
      if (patch.branch !== undefined) record.branch = patch.branch;
      if (patch.sessionFile === null) {
        delete record.sessionFile;
      } else if (patch.sessionFile !== undefined) {
        record.sessionFile = patch.sessionFile;
      }
      if (patch.mergedCommitSha !== undefined) {
        record.mergedCommitSha = patch.mergedCommitSha;
      }
      if (patch.model !== undefined) record.model = patch.model;
      if (patch.thinkingLevel === null) {
        delete record.thinkingLevel;
      } else if (patch.thinkingLevel !== undefined) {
        record.thinkingLevel = patch.thinkingLevel;
      }
      if (patch.modelExplicit !== undefined) {
        record.modelExplicit = patch.modelExplicit;
      }
      if (
        patch.lastReadSeq !== undefined &&
        Number.isFinite(patch.lastReadSeq)
      ) {
        record.lastReadSeq = Math.max(0, Math.floor(patch.lastReadSeq));
      }
      if (
        patch.lastPostSeq !== undefined &&
        Number.isFinite(patch.lastPostSeq)
      ) {
        record.lastPostSeq = Math.max(0, Math.floor(patch.lastPostSeq));
      }
      if (patch.lastPostTime !== undefined) {
        record.lastPostTime = patch.lastPostTime;
      }
      if (patch.lastParkBlockedSeq === null) {
        delete record.lastParkBlockedSeq;
      } else if (
        patch.lastParkBlockedSeq !== undefined &&
        Number.isFinite(patch.lastParkBlockedSeq)
      ) {
        record.lastParkBlockedSeq = Math.max(
          0,
          Math.floor(patch.lastParkBlockedSeq),
        );
      }
      if (patch.parkedOn === null) {
        delete record.parkedOn;
      } else if (patch.parkedOn !== undefined) {
        record.parkedOn = patch.parkedOn;
      }
      if (patch.turns !== undefined && Number.isFinite(patch.turns)) {
        record.turns = Math.max(0, Math.floor(patch.turns));
      }
      if (patch.llmTurns !== undefined && Number.isFinite(patch.llmTurns)) {
        record.llmTurns = Math.max(0, Math.floor(patch.llmTurns));
      }
      if (patch.turnStartedAt === null) {
        delete record.turnStartedAt;
      } else if (patch.turnStartedAt !== undefined) {
        const normalizedTurnStartedAt = normalizeOptionalNonEmptyString(
          patch.turnStartedAt,
        );
        if (normalizedTurnStartedAt !== undefined) {
          record.turnStartedAt = normalizedTurnStartedAt;
        } else {
          delete record.turnStartedAt;
        }
      }
      if (patch.tokens !== undefined && Number.isFinite(patch.tokens)) {
        record.tokens = Math.max(0, Math.floor(patch.tokens));
      }
      if (patch.tokenBreakdown !== undefined) {
        record.tokenBreakdown = { ...patch.tokenBreakdown };
      }
      if (patch.cost !== undefined && Number.isFinite(patch.cost)) {
        record.cost = patch.cost;
      }
      if (patch.humanStopped !== undefined) {
        record.humanStopped = patch.humanStopped;
      }
      if (patch.currentActivity === null) {
        delete record.currentActivity;
      } else if (patch.currentActivity !== undefined) {
        record.currentActivity = patch.currentActivity;
      }
      if (patch.lastTool === null) {
        delete record.lastTool;
      } else if (patch.lastTool !== undefined) {
        record.lastTool = patch.lastTool;
      }
      if (patch.logTail !== undefined) {
        record.logTail = patch.logTail.slice(-SWARM_LOG_TAIL_LIMIT);
      }
      if (patch.logLine !== undefined) {
        record.logTail.push(patch.logLine);
        if (record.logTail.length > SWARM_LOG_TAIL_LIMIT) {
          record.logTail = record.logTail.slice(-SWARM_LOG_TAIL_LIMIT);
        }
      }
      if (patch.error === null) {
        delete record.error;
      } else if (patch.error !== undefined) {
        record.error = patch.error;
      }
      if (patch.endedAt === null) {
        delete record.endedAt;
      } else if (patch.endedAt !== undefined) {
        record.endedAt = patch.endedAt;
      }

      const now = new Date().toISOString();
      record.updatedAt = now;
      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      // Auto-emitted lifecycle transition events:
      // - state -> "waiting" emits `member_waiting`
      // - state -> "stopped" emits `member_stopped`
      // - state -> "killed"  emits `member_killed`
      // - mergedCommitSha newly set emits `member_merged`
      if (patch.state && patch.state !== previousState) {
        if (patch.state === "waiting") {
          await appendLedgerEvent(this.getEventsPath(runId), {
            runId,
            type: "member_waiting",
            actor: patch.actor ?? memberName,
            memberName,
            agentId: record.agentId,
            summary: `${record.role} "${memberName}" is waiting${record.parkedOn ? ` (${record.parkedOn})` : ""}.`,
            data: {
              role: record.role,
              previousState,
              ...(record.parkedOn ? { parkedOn: record.parkedOn } : {}),
            },
          });
        } else if (patch.state === "stopped") {
          await appendLedgerEvent(this.getEventsPath(runId), {
            runId,
            type: "member_stopped",
            actor:
              patch.actor ??
              (record.humanStopped ? "human" : ORCHESTRATOR_NAME),
            memberName,
            agentId: record.agentId,
            summary: `${record.role} "${memberName}" stopped${record.humanStopped ? " by human" : ""}${record.error ? `: ${record.error}` : ""}.`,
            data: {
              role: record.role,
              previousState,
              humanStopped: record.humanStopped,
            },
          });
        } else if (patch.state === "killed") {
          await appendLedgerEvent(this.getEventsPath(runId), {
            runId,
            type: "member_killed",
            actor:
              patch.actor ??
              (record.humanStopped ? "human" : ORCHESTRATOR_NAME),
            memberName,
            agentId: record.agentId,
            summary: `${record.role} "${memberName}" killed${record.error ? `: ${record.error}` : ""}.`,
            data: {
              role: record.role,
              previousState,
            },
          });
        }
      }

      if (
        patch.mergedCommitSha !== undefined &&
        patch.mergedCommitSha.trim().length > 0 &&
        patch.mergedCommitSha !== previousMergedSha
      ) {
        const sha = patch.mergedCommitSha.trim();
        await appendLedgerEvent(this.getEventsPath(runId), {
          runId,
          type: "member_merged",
          actor: patch.actor ?? ORCHESTRATOR_NAME,
          memberName,
          agentId: record.agentId,
          summary: `Merged ${record.role} "${memberName}"${record.branch ? ` (${record.branch})` : ""} @${sha.slice(0, 7)}.`,
          data: {
            commitSha: sha,
            ...(record.branch ? { branch: record.branch } : {}),
          },
        });
      }

      return saved;
    });
  }

  // --------------------------------------------------------------------------
  // Named Board Channels
  // --------------------------------------------------------------------------

  async createChannel(
    runId: string,
    input: CreateChannelInput,
  ): Promise<SwarmChannelRecord> {
    const name = validateChannelName(input.name);
    const createdBy =
      typeof input.createdBy === "string" ? input.createdBy.trim() : "";
    if (!createdBy) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        "Channel creator (createdBy) must not be empty.",
        { runId, channel: name },
      );
    }

    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);

      const existing = getOwnRecord(state.channels, name);
      if (existing) {
        if (existing.archived) {
          throw new SwarmProtocolError(
            "CHANNEL_ARCHIVED",
            `Channel "${name}" already exists and is archived in run "${runId}".`,
            { runId, channel: name },
          );
        }
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          `Channel "${name}" already exists in run "${runId}".`,
          { runId, channel: name },
        );
      }

      const subscribers: string[] = [];
      const seen = new Set<string>();
      if (Array.isArray(input.subscribers)) {
        for (const rawSub of input.subscribers) {
          const sub = typeof rawSub === "string" ? rawSub.trim() : "";
          if (!sub || seen.has(sub)) continue;
          const member = getOwnRecord(state.members, sub);
          if (!member) {
            throw new SwarmProtocolError(
              "MEMBER_NOT_FOUND",
              `Cannot subscribe unknown member "${sub}" to channel "${name}".`,
              { runId, channel: name, memberName: sub },
            );
          }
          if (member.state === "killed") {
            throw new SwarmProtocolError(
              "MEMBER_KILLED",
              `Cannot subscribe killed member "${sub}" to channel "${name}".`,
              { runId, channel: name, memberName: sub },
            );
          }
          seen.add(sub);
          subscribers.push(sub);
        }
      }

      const now = new Date().toISOString();
      const topic = input.topic?.trim();
      const channelRecord: SwarmChannelRecord = {
        name,
        ...(topic ? { topic } : {}),
        createdBy,
        createdAt: now,
        archived: false,
        subscribers,
      };

      state.channels[name] = channelRecord;
      for (const sub of subscribers) {
        const member = getOwnRecord(state.members, sub);
        if (member && !member.channels.includes(name)) {
          member.channels.push(name);
          member.updatedAt = now;
        }
      }

      state.revision += 1;
      state.updatedAt = now;
      await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "channel_created",
        actor: createdBy,
        channel: name,
        summary: `Created channel #${name}${topic ? ` — ${topic}` : ""}.`,
        data: {
          ...(topic ? { topic } : {}),
          subscribers: [...subscribers],
        },
      });

      return structuredClone(channelRecord);
    });
  }

  async subscribeChannel(
    runId: string,
    channelName: string,
    memberName: string,
  ): Promise<SwarmChannelRecord> {
    const channel = validateChannelName(channelName);

    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      const record = getOwnRecord(state.channels, channel);
      if (!record) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          `Channel "${channel}" does not exist in run "${runId}".`,
          { runId, channel },
        );
      }
      if (record.archived) {
        throw new SwarmProtocolError(
          "CHANNEL_ARCHIVED",
          `Cannot subscribe to archived channel "${channel}".`,
          { runId, channel },
        );
      }

      const member = getOwnRecord(state.members, memberName);
      if (!member) {
        throw new SwarmProtocolError(
          "MEMBER_NOT_FOUND",
          `Member "${memberName}" not found in run "${runId}".`,
          { runId, memberName },
        );
      }
      if (member.state === "killed") {
        throw new SwarmProtocolError(
          "MEMBER_KILLED",
          `Cannot subscribe killed member "${memberName}" to channel "${channel}".`,
          { runId, channel, memberName },
        );
      }

      const now = new Date().toISOString();
      if (!record.subscribers.includes(memberName)) {
        record.subscribers.push(memberName);
      }
      if (!member.channels.includes(channel)) {
        member.channels.push(channel);
      }
      member.updatedAt = now;
      state.revision += 1;
      state.updatedAt = now;
      await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "channel_updated",
        actor: memberName,
        memberName,
        channel,
        summary: `Subscribed "${memberName}" to #${channel}.`,
        data: {
          action: "subscribe",
          subscribers: [...record.subscribers],
        },
      });

      return structuredClone(record);
    });
  }

  async unsubscribeChannel(
    runId: string,
    channelName: string,
    memberName: string,
  ): Promise<SwarmChannelRecord> {
    const channel = validateChannelName(channelName);
    if (channel === DEFAULT_CHANNEL) {
      throw new SwarmProtocolError(
        "INVALID_CHANNEL",
        `Cannot unsubscribe from default channel "${DEFAULT_CHANNEL}".`,
        { runId, channel },
      );
    }

    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      const record = getOwnRecord(state.channels, channel);
      if (!record) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          `Channel "${channel}" does not exist in run "${runId}".`,
          { runId, channel },
        );
      }

      const member = getOwnRecord(state.members, memberName);
      if (!member) {
        throw new SwarmProtocolError(
          "MEMBER_NOT_FOUND",
          `Member "${memberName}" not found in run "${runId}".`,
          { runId, memberName },
        );
      }

      const now = new Date().toISOString();
      record.subscribers = record.subscribers.filter((s) => s !== memberName);
      member.channels = member.channels.filter((c) => c !== channel);
      if (!member.channels.includes(DEFAULT_CHANNEL)) {
        member.channels.push(DEFAULT_CHANNEL);
      }
      member.updatedAt = now;
      state.revision += 1;
      state.updatedAt = now;
      await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "channel_updated",
        actor: memberName,
        memberName,
        channel,
        summary: `Unsubscribed "${memberName}" from #${channel}.`,
        data: {
          action: "unsubscribe",
          subscribers: [...record.subscribers],
        },
      });

      return structuredClone(record);
    });
  }

  async archiveChannel(
    runId: string,
    channelName: string,
    actor?: string,
  ): Promise<SwarmChannelRecord> {
    const channel = validateChannelName(channelName);
    if (channel === DEFAULT_CHANNEL) {
      throw new SwarmProtocolError(
        "INVALID_CHANNEL",
        `Cannot archive default channel "${DEFAULT_CHANNEL}".`,
        { runId, channel },
      );
    }

    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      const record = getOwnRecord(state.channels, channel);
      if (!record) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          `Channel "${channel}" does not exist in run "${runId}".`,
          { runId, channel },
        );
      }
      if (record.archived) {
        throw new SwarmProtocolError(
          "CHANNEL_ARCHIVED",
          `Channel "${channel}" is already archived.`,
          { runId, channel },
        );
      }

      const now = new Date().toISOString();
      record.archived = true;
      record.archivedAt = now;

      for (const member of Object.values(state.members)) {
        if (member.channels.includes(channel)) {
          member.channels = member.channels.filter((c) => c !== channel);
          if (!member.channels.includes(DEFAULT_CHANNEL)) {
            member.channels.push(DEFAULT_CHANNEL);
          }
          member.updatedAt = now;
        }
      }

      state.revision += 1;
      state.updatedAt = now;
      await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "channel_archived",
        actor: actor ?? ORCHESTRATOR_NAME,
        channel,
        summary: `Archived channel #${channel}.`,
      });

      return structuredClone(record);
    });
  }

  // --------------------------------------------------------------------------
  // Shared Message Board (board.jsonl)
  // --------------------------------------------------------------------------

  async postBoardMessage(
    runId: string,
    input: PostBoardMessageInput,
  ): Promise<BoardMessage> {
    const targetChannel =
      input.channel !== undefined && input.channel.trim().length > 0
        ? validateChannelName(input.channel.trim().toLowerCase())
        : DEFAULT_CHANNEL;

    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      const channelRecord = getOwnRecord(state.channels, targetChannel);
      if (!channelRecord) {
        throw new SwarmProtocolError(
          "INVALID_CHANNEL",
          `Channel "${targetChannel}" does not exist in run "${runId}".`,
          { runId, channel: targetChannel },
        );
      }
      if (channelRecord.archived) {
        throw new SwarmProtocolError(
          "CHANNEL_ARCHIVED",
          `Cannot post to archived channel "${targetChannel}".`,
          { runId, channel: targetChannel },
        );
      }

      const message = await this.board.post(runId, {
        ...input,
        channel: targetChannel,
        minSeq: state.boardHead + 1,
      });

      state.boardHead = Math.max(state.boardHead, message.seq);
      const senderMember = getOwnRecord(state.members, message.from);
      if (senderMember) {
        senderMember.lastPostSeq = message.seq;
        senderMember.lastPostTime = message.timestamp;
        senderMember.updatedAt = message.timestamp;
      }

      state.revision += 1;
      state.updatedAt = message.timestamp;
      await this.persistStateUnlocked(state);

      const snippet = message.text.replace(/\s+/g, " ").trim().slice(0, 140);
      const targets = [
        ...message.mentions.map((m) => `@${m}`),
        ...message.channelMentions.map((c) => `@#${c}`),
      ];
      const mentionSuffix = targets.length > 0 ? ` -> ${targets.join(", ")}` : "";
      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "board_posted",
        actor: message.from,
        ...(senderMember
          ? { memberName: senderMember.name, agentId: senderMember.agentId }
          : {}),
        channel: message.channel,
        summary:
          `#${message.seq} [${message.channel}] ${message.from}${mentionSuffix}: ${snippet}`.trim(),
        data: {
          seq: message.seq,
          channel: message.channel,
          from: message.from,
          fromRole: message.fromRole,
          mentions: message.mentions,
          channelMentions: message.channelMentions,
          kind: message.kind,
        },
      });

      return message;
    });
  }

  async readBoard(
    runId: string,
    options?: ReadBoardOptions,
  ): Promise<ReadBoardResult> {
    return this.board.read(runId, options);
  }

  async getBoardHead(runId: string): Promise<number> {
    return this.board.getHead(runId);
  }

  // --------------------------------------------------------------------------
  // Event Ledger
  // --------------------------------------------------------------------------

  async appendEvent(event: SwarmEventInput): Promise<SwarmEvent> {
    const eventsPath = this.getEventsPath(event.runId);
    await assertNoSymlinksWithin(this.projectRoot, eventsPath);
    return appendLedgerEvent(eventsPath, event);
  }

  async getRecentEvents(runId: string, limit = 50): Promise<SwarmEvent[]> {
    const eventsPath = this.getEventsPath(runId);
    await assertNoSymlinksWithin(this.projectRoot, eventsPath);
    return readRecentLedgerEvents(eventsPath, limit);
  }

  // --------------------------------------------------------------------------
  // Shared Mission Knowledge Library (.pi/swarm/runs/<runId>/library/*.md)
  // --------------------------------------------------------------------------

  private async ensureLibraryInitializedUnlocked(runId: string): Promise<string> {
    const libraryDir = this.getLibraryDir(runId);
    await assertNoSymlinksWithin(this.projectRoot, libraryDir);
    await mkdir(libraryDir, { recursive: true });
    await assertNoSymlinksWithin(this.projectRoot, libraryDir);

    await Promise.all(
      DEFAULT_LIBRARY_TOPICS.map(async (topic) => {
        const filePath = path.join(libraryDir, `${topic}.md`);
        await assertLeafNotSymlink(filePath);
        const starter = DEFAULT_LIBRARY_STARTER_CONTENT[topic];
        try {
          await writeFile(filePath, starter, { encoding: "utf8", flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
            throw err;
          }
        }
      }),
    );
    return libraryDir;
  }

  async readLibraryTopic(runId: string, topic: string): Promise<string | null> {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    const safeTopic = validateLibraryTopic(topic);
    await this.readStateUnlocked(safeRunId);
    const topicPath = this.getLibraryTopicPath(safeRunId, safeTopic);
    await assertNoSymlinksWithin(this.projectRoot, topicPath);
    try {
      return await readFile(topicPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async writeLibraryTopic(
    runId: string,
    topic: string,
    content: string,
    options?: { append?: boolean; actor?: string },
  ): Promise<{ topic: string; path: string; content: string }> {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    const safeTopic = validateLibraryTopic(topic);
    if (typeof content !== "string") {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Library content for topic "${safeTopic}" must be a string.`,
        { runId: safeRunId, topic: safeTopic },
      );
    }
    const incomingBytes = Buffer.byteLength(content, "utf8");
    if (incomingBytes > MAX_LIBRARY_TOPIC_BYTES) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        `Library topic "${safeTopic}" content exceeds maximum size of ${MAX_LIBRARY_TOPIC_BYTES} bytes (got ${incomingBytes} bytes). Keep shared library notes concise instead of dumping raw logs.`,
        {
          runId: safeRunId,
          topic: safeTopic,
          bytes: incomingBytes,
          maxBytes: MAX_LIBRARY_TOPIC_BYTES,
        },
      );
    }

    return this.withRunLock(safeRunId, async () => {
      await this.readStateUnlocked(safeRunId);
      await this.ensureLibraryInitializedUnlocked(safeRunId);
      const topicPath = this.getLibraryTopicPath(safeRunId, safeTopic);
      await assertNoSymlinksWithin(this.projectRoot, topicPath);
      await assertLeafNotSymlink(topicPath);

      let nextContent = content;
      if (options?.append) {
        let existing = "";
        try {
          existing = await readFile(topicPath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            throw err;
          }
        }
        if (existing.length === 0) {
          nextContent = content;
        } else if (
          existing.endsWith("\n") ||
          content.startsWith("\n") ||
          content.length === 0
        ) {
          nextContent = `${existing}${content}`;
        } else {
          nextContent = `${existing}\n${content}`;
        }
      }

      const totalBytes = Buffer.byteLength(nextContent, "utf8");
      if (totalBytes > MAX_LIBRARY_TOPIC_BYTES) {
        throw new SwarmProtocolError(
          "INVALID_INPUT",
          `Library topic "${safeTopic}" exceeds maximum size of ${MAX_LIBRARY_TOPIC_BYTES} bytes after update (got ${totalBytes} bytes). Keep shared library notes concise instead of dumping raw logs.`,
          {
            runId: safeRunId,
            topic: safeTopic,
            bytes: totalBytes,
            maxBytes: MAX_LIBRARY_TOPIC_BYTES,
          },
        );
      }

      await writeTmpAndRename(topicPath, nextContent);
      return {
        topic: safeTopic,
        path: topicPath,
        content: nextContent,
      };
    });
  }

  async listLibraryTopics(
    runId: string,
  ): Promise<Array<{ topic: string; path: string; bytes: number }>> {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    await this.readStateUnlocked(safeRunId);
    const libraryDir = this.getLibraryDir(safeRunId);
    await assertNoSymlinksWithin(this.projectRoot, libraryDir);

    let entries: string[];
    try {
      entries = await readdir(libraryDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const results: Array<{ topic: string; path: string; bytes: number }> = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) {
        continue;
      }
      const rawTopic = entry.slice(0, -3);
      if (!LIBRARY_TOPIC_PATTERN.test(rawTopic) || isPrototypeKey(rawTopic)) {
        continue;
      }
      const normalizedTopic = rawTopic.toLowerCase();
      if (seen.has(normalizedTopic)) {
        continue;
      }
      const fullPath = assertWithinRoot(
        this.projectRoot,
        path.join(libraryDir, entry),
      );
      try {
        const st = await lstat(fullPath);
        if (!st.isSymbolicLink() && st.isFile()) {
          seen.add(normalizedTopic);
          results.push({
            topic: normalizedTopic,
            path: fullPath,
            bytes: st.size,
          });
        }
      } catch {
        // Ignore concurrently removed files.
      }
    }

    results.sort((a, b) => a.topic.localeCompare(b.topic));
    return results;
  }

  // --------------------------------------------------------------------------
  // ROSTER.md Auto-Generation
  // --------------------------------------------------------------------------

  renderRosterMarkdown(state: SwarmRunState): string {
    const lines: string[] = [
      `# ${escapeMarkdownCell(state.title || state.id)}`,
      "",
      `- **Run ID:** \`${state.id}\``,
      `- **Status:** \`${state.status}\``,
      `- **Base Branch:** \`${state.baseBranch}\``,
      `- **Board Head:** #${state.boardHead}`,
      `- **Models:** ${formatRoleModelsSummary(state.roleModels)}`,
      `- **Validator Enabled:** ${state.validatorEnabled ? "yes" : "no"}`,
      `- **Warm Workers:** ${state.keepWorkersWarm ? "yes" : "no"}`,
      `- **Max Concurrency:** ${state.maxConcurrency}`,
      `- **Revision:** ${state.revision}`,
      `- **Updated At:** ${state.updatedAt}`,
      "",
      "## Objective",
      "",
      state.objective.trim() || "(none)",
      "",
      "## Strategy",
      "",
      state.strategy.trim() || "(none)",
      "",
      "## Acceptance Criteria",
      "",
      state.acceptanceCriteria.trim() || "(none)",
      "",
      "## Channels",
      "",
      "| Channel | Status | Topic | Subscribers | Created By |",
      "| --- | --- | --- | --- | --- |",
    ];

    const channelNames = Object.keys(state.channels).sort((a, b) => {
      if (a === DEFAULT_CHANNEL) return -1;
      if (b === DEFAULT_CHANNEL) return 1;
      return a.localeCompare(b);
    });
    for (const chName of channelNames) {
      const ch = getOwnRecord(state.channels, chName);
      if (!ch) continue;
      const status = ch.archived ? "archived" : "active";
      const topic = ch.topic ? escapeMarkdownCell(ch.topic) : "-";
      const subs =
        ch.subscribers.length > 0
          ? escapeMarkdownCell(ch.subscribers.join(", "))
          : "-";
      lines.push(
        `| \`#${escapeMarkdownCell(ch.name)}\` | ${status} | ${topic} | ${subs} | ${escapeMarkdownCell(ch.createdBy)} |`,
      );
    }

    lines.push(
      "",
      "## Members",
      "",
      "| Name | Role | State | Model | Workspace | Parent | Channels | Turns | Last Read/Post | Parked On |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );

    const orderedNames =
      state.memberOrder.length > 0
        ? state.memberOrder
        : Object.keys(state.members);
    for (const name of orderedNames) {
      const m = getOwnRecord(state.members, name);
      if (!m) continue;
      const modelCell = m.model
        ? `\`${escapeMarkdownCell(m.model)}\`${m.thinkingLevel ? ` (${m.thinkingLevel})` : ""}`
        : "default";
      const workspaceCell = m.branch
        ? `${m.workspace} (\`${escapeMarkdownCell(m.branch)}\`)`
        : m.workspace;
      const channelsCell =
        m.channels.length > 0
          ? m.channels.map((c) => `\`#${escapeMarkdownCell(c)}\``).join(", ")
          : `\`#${DEFAULT_CHANNEL}\``;
      const lastRead = `#${m.lastReadSeq}`;
      const lastPost = m.lastPostSeq !== undefined ? `#${m.lastPostSeq}` : "-";
      const parkedOn = m.parkedOn
        ? escapeMarkdownCell(m.parkedOn)
        : m.currentActivity
          ? escapeMarkdownCell(m.currentActivity)
          : "-";
      lines.push(
        `| ${escapeMarkdownCell(m.name)} | ${m.role} | ${m.state} | ${modelCell} | ${workspaceCell} | ${escapeMarkdownCell(m.parentName)} | ${channelsCell} | ${m.turns} | ${lastRead} / ${lastPost} | ${parkedOn} |`,
      );
    }

    if (state.completionSummary && state.completionSummary.trim().length > 0) {
      lines.push("", "## Completion Summary", "", state.completionSummary.trim());
    }

    lines.push("");
    return lines.join("\n");
  }

  // --------------------------------------------------------------------------
  // Droid Mission Artifacts Auto-Materialization
  // --------------------------------------------------------------------------

  renderMissionMarkdown(state: SwarmRunState): string {
    const lines: string[] = [
      `# ${escapeMarkdownCell(state.title || state.id)}`,
      "",
      `- **Run ID:** \`${state.id}\``,
      `- **Status:** \`${state.status}\``,
      `- **Base Branch:** \`${state.baseBranch}\``,
    ];
    if (state.phase) {
      lines.push(`- **Phase:** \`${escapeMarkdownCell(state.phase)}\``);
    }

    lines.push(
      "",
      "## Objective",
      "",
      state.objective.trim() || "(none)",
      "",
      "## Strategy",
      "",
      state.strategy.trim() || "(none)",
      "",
      "## Acceptance Criteria",
      "",
      state.acceptanceCriteria.trim() || "(none)",
      "",
      "## Commands Manifest",
      "",
    );

    if (state.commands && state.commands.length > 0) {
      for (const entry of state.commands) {
        lines.push(
          `- **${escapeMarkdownCell(entry.name)}:** \`${entry.command.replace(/`/g, "\\`")}\``,
        );
      }
    } else {
      lines.push("(none)");
    }

    lines.push("", "## Services & Ports", "");
    if (state.services && state.services.length > 0) {
      for (const svc of state.services) {
        const portPart = svc.port !== undefined ? ` (port ${svc.port})` : "";
        const details: string[] = [
          `start: \`${svc.start.replace(/`/g, "\\`")}\``,
        ];
        if (svc.stop) {
          details.push(`stop: \`${svc.stop.replace(/`/g, "\\`")}\``);
        }
        if (svc.healthcheck) {
          details.push(
            `healthcheck: \`${svc.healthcheck.replace(/`/g, "\\`")}\``,
          );
        }
        if (svc.dependsOn && svc.dependsOn.length > 0) {
          details.push(
            `dependsOn: ${svc.dependsOn.map((d) => `\`${escapeMarkdownCell(d)}\``).join(", ")}`,
          );
        }
        lines.push(
          `- **${escapeMarkdownCell(svc.name)}**${portPart} — ${details.join(" | ")}`,
        );
      }
    } else {
      lines.push("(none)");
    }

    lines.push("", "## Mission Boundaries", "");
    if (state.boundaries && state.boundaries.length > 0) {
      for (const boundary of state.boundaries) {
        lines.push(`- ${boundary}`);
      }
    } else {
      lines.push("(none)");
    }

    lines.push("", "## Milestones", "");
    if (state.milestones && state.milestones.length > 0) {
      for (const ms of state.milestones) {
        const ownerPart = ms.owner ? ` (owner: @${ms.owner})` : "";
        const sealedPart = ms.sealed
          ? ms.sealedAt
            ? ` [SEALED at ${ms.sealedAt}]`
            : " [SEALED]"
          : "";
        lines.push(
          `- [${ms.status}] **${escapeMarkdownCell(ms.label)}**${ownerPart}${sealedPart}`,
        );
      }
    } else {
      lines.push("(none)");
    }

    if (state.lastAudit) {
      lines.push(
        "",
        "## Last Audit",
        "",
        `- **Verdict:** \`${state.lastAudit.verdict}\``,
      );
      if (state.lastAudit.auditor) {
        lines.push(`- **Auditor:** \`${state.lastAudit.auditor}\``);
      }
      lines.push(
        `- **Timestamp:** ${state.lastAudit.timestamp}`,
        `- **Summary:** ${state.lastAudit.summary || "(none)"}`,
      );
    }

    if (state.completionSummary && state.completionSummary.trim().length > 0) {
      lines.push("", "## Completion Summary", "", state.completionSummary.trim());
    }

    lines.push("");
    return lines.join("\n");
  }

  renderValidationContractMarkdown(state: SwarmRunState): string {
    const assertions = state.assertions ?? [];
    let passed = 0;
    let pending = 0;
    let failed = 0;
    let blocked = 0;
    let overriddenCount = 0;
    for (const a of assertions) {
      if (a.status === "passed") passed += 1;
      else if (a.status === "failed") failed += 1;
      else if (a.status === "blocked") blocked += 1;
      else pending += 1;
      if (a.overridden) overriddenCount += 1;
    }

    const overrideSummarySuffix =
      overriddenCount > 0 ? ` (${overriddenCount} [OVERRIDE])` : "";

    const lines: string[] = [
      `# Validation Contract — ${escapeMarkdownCell(state.title || state.id)}`,
      "",
      `- **Run ID:** \`${state.id}\``,
      `- **Summary:** ${passed}/${assertions.length} passed, ${pending} pending, ${failed} failed, ${blocked} blocked${overrideSummarySuffix}`,
      "",
    ];

    if (assertions.length === 0) {
      lines.push("(no assertions defined)", "");
      return lines.join("\n");
    }

    for (const a of assertions) {
      const checkbox =
        a.status === "passed"
          ? "x"
          : a.status === "failed"
            ? "!"
            : a.status === "blocked"
              ? "-"
              : " ";
      const badge = a.status.toUpperCase();
      const overrideBadge = a.overridden ? " `[OVERRIDE]`" : "";
      const headerOverrideSuffix = a.overridden ? " [OVERRIDE]" : "";
      const safeId = a.id.replace(/\r?\n/g, " ").trim();
      const safeTitle = a.title.replace(/\r?\n/g, " ").trim();
      const verifiedByText = a.verifiedBy
        ? a.verifiedByRole
          ? `@${a.verifiedBy} (${a.verifiedByRole})`
          : `@${a.verifiedBy}`
        : "(unverified)";

      lines.push(
        `### ${safeId}: ${safeTitle}${headerOverrideSuffix}`,
        "",
        `- **Status:** [${checkbox}] \`${badge}\`${overrideBadge}`,
        `- **Behavioral Description:** ${a.description || "(none)"}`,
        `- **Required Evidence:** ${a.evidenceRequired || "(not specified)"}`,
        `- **Collected Evidence:** ${a.evidence || "(none)"}`,
        `- **Verified By:** ${verifiedByText}`,
      );
      if (a.overridden || a.overrideJustification !== undefined) {
        lines.push(
          `- **Override Justification:** ${a.overrideJustification || "(none)"}`,
        );
      }
      lines.push(`- **Updated At:** ${a.updatedAt}`, "");
    }

    return lines.join("\n");
  }

  renderValidationStateJson(state: SwarmRunState): string {
    const assertionsMap: Record<
      string,
      {
        status: AssertionStatus;
        evidence?: string;
        verifiedBy?: string;
        verifiedByRole?: CallerRole;
        overridden?: boolean;
        overrideJustification?: string;
        updatedAt: string;
      }
    > = {};
    for (const a of state.assertions ?? []) {
      if (isPrototypeKey(a.id)) {
        continue;
      }
      assertionsMap[a.id] = {
        status: a.status,
        ...(a.evidence !== undefined ? { evidence: a.evidence } : {}),
        ...(a.verifiedBy !== undefined ? { verifiedBy: a.verifiedBy } : {}),
        ...(a.verifiedByRole !== undefined
          ? { verifiedByRole: a.verifiedByRole }
          : {}),
        ...(a.overridden !== undefined ? { overridden: a.overridden } : {}),
        ...(a.overrideJustification !== undefined
          ? { overrideJustification: a.overrideJustification }
          : {}),
        updatedAt: a.updatedAt,
      };
    }
    return `${JSON.stringify({ assertions: assertionsMap }, null, 2)}\n`;
  }

  renderFeaturesJson(state: SwarmRunState): string {
    return `${JSON.stringify({ features: state.features ?? [] }, null, 2)}\n`;
  }

  renderServicesJson(state: SwarmRunState): string {
    return `${JSON.stringify({ services: state.services ?? [] }, null, 2)}\n`;
  }
}

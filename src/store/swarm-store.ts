import { randomUUID } from "node:crypto";
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
  DEFAULT_SWARM_SETTINGS,
  FINAL_AUDIT_MISSION_ID,
  FINAL_VALIDATOR_BOARD_NAME,
  ORCHESTRATOR_BOARD_NAME,
  SWARM_AUDITS_DIR,
  SWARM_BRANCH_PREFIX,
  SWARM_DIR,
  SWARM_EVENTS_FILE,
  SWARM_FINDINGS_DIR,
  SWARM_INBOX_DIR,
  SWARM_LOCKS_DIR,
  SWARM_LOG_TAIL_LIMIT,
  SWARM_MISSIONS_FILE,
  SWARM_REVIEWS_DIR,
  SWARM_RUNS_DIR,
  SWARM_STATE_FILE,
  SWARM_STATE_VERSION,
  SWARM_WORKTREES_DIR,
  SWARM_WORKTREE_PREFIX,
} from "../constants.js";
import {
  SwarmProtocolError,
  isValidReviewSeverityStatus,
  type BoardMessage,
  type CallerRole,
  type CreateRunInput,
  type FinalAuditDecision,
  type FinalAuditStatus,
  type FinalAuditVerdict,
  type ISwarmStore,
  type InboxMessage,
  type MissionKind,
  type MissionPlanInput,
  type MissionRecord,
  type MissionReviewVerdict,
  type MissionStatus,
  type MissionTaskInput,
  type MissionTaskItem,
  type MissionUpdateInput,
  type PlanValidationIssue,
  type PlanValidationOptions,
  type PlanValidationResult,
  type PostBoardMessageInput,
  type ReadBoardOptions,
  type ReadBoardResult,
  type ReadInboxOptions,
  type RecordFindingInput,
  type RegisterRosterInput,
  type RosterAgentRole,
  type RosterAgentStatus,
  type RosterEntry,
  type RosterUpdateInput,
  type RunSummary,
  type RunUpdateInput,
  type SendMessageInput,
  type SwarmEvent,
  type SwarmEventInput,
  type SwarmFindingRecord,
  type SwarmRoleModels,
  type SwarmRunState,
} from "../types.js";
import { SwarmBoard } from "./board.js";
import { appendLedgerEvent, readRecentLedgerEvents } from "./ledger.js";

// ============================================================================
// Constants & State Machine Tables
// ============================================================================

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PRINTABLE_ASCII_RE = /^[ -~]+$/;
const HAS_ASCII_ALNUM_RE = /[A-Za-z0-9]/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

const VALID_MISSION_KINDS: ReadonlySet<MissionKind> = new Set<MissionKind>([
  "build",
  "artifact",
  "survey",
]);

const OPEN_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set<MissionStatus>([
  "planned",
  "active",
  "completed",
  "failed",
  "stopped",
]);

const ALLOWED_TRANSITIONS: Readonly<
  Record<MissionStatus, ReadonlySet<MissionStatus>>
> = {
  planned: new Set<MissionStatus>(["active", "failed", "stopped", "abandoned"]),
  active: new Set<MissionStatus>([
    "completed",
    "failed",
    "stopped",
    "abandoned",
  ]),
  completed: new Set<MissionStatus>([
    "merged",
    "active",
    "failed",
    "stopped",
    "abandoned",
  ]),
  failed: new Set<MissionStatus>(["active", "planned", "stopped", "abandoned"]),
  stopped: new Set<MissionStatus>(["active", "planned", "abandoned"]),
  merged: new Set<MissionStatus>(),
  abandoned: new Set<MissionStatus>(),
};

const ORCHESTRATOR_OR_HUMAN: ReadonlySet<CallerRole> = new Set<CallerRole>([
  "orchestrator",
  "human",
]);

const VALID_MERGE_DECISIONS = new Set(["merge", "fix-then-merge", "hold"]);

const VALID_ROSTER_ROLES: ReadonlySet<RosterAgentRole> =
  new Set<RosterAgentRole>(["worker", "validator", "final-validator"]);

const VALID_ROSTER_STATUSES: ReadonlySet<RosterAgentStatus> =
  new Set<RosterAgentStatus>([
    "working",
    "waiting",
    "stopped",
    "killed",
    "failed",
    "died",
  ]);

const VALID_FINAL_AUDIT_STATUSES: ReadonlySet<FinalAuditStatus> =
  new Set<FinalAuditStatus>([
    "idle",
    "pending",
    "running",
    "approved",
    "disapproved",
    "skipped",
  ]);

const VALID_FINAL_AUDIT_DECISIONS: ReadonlySet<FinalAuditDecision> =
  new Set<FinalAuditDecision>(["approved", "disapproved"]);

const MAX_VALIDATION_ROUNDS_MIN = 1;
const MAX_VALIDATION_ROUNDS_MAX = 10;
const MAX_FINAL_AUDIT_ROUNDS_MIN = 1;
const MAX_FINAL_AUDIT_ROUNDS_MAX = 10;

function clampRounds(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function cloneRoleModels(roleModels: SwarmRoleModels): SwarmRoleModels {
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

function backfillRunState(state: SwarmRunState): SwarmRunState {
  const raw = state as unknown as Record<string, unknown>;
  if (typeof raw.validatorEnabled !== "boolean") {
    state.validatorEnabled = DEFAULT_SWARM_SETTINGS.validatorEnabled;
  }
  state.maxValidationRounds = clampRounds(
    raw.maxValidationRounds,
    MAX_VALIDATION_ROUNDS_MIN,
    MAX_VALIDATION_ROUNDS_MAX,
    DEFAULT_SWARM_SETTINGS.maxValidationRounds,
  );
  if (typeof raw.finalValidatorEnabled !== "boolean") {
    state.finalValidatorEnabled = DEFAULT_SWARM_SETTINGS.finalValidatorEnabled;
  }
  state.maxFinalAuditRounds = clampRounds(
    raw.maxFinalAuditRounds,
    MAX_FINAL_AUDIT_ROUNDS_MIN,
    MAX_FINAL_AUDIT_ROUNDS_MAX,
    DEFAULT_SWARM_SETTINGS.maxFinalAuditRounds,
  );
  if (typeof raw.autoFixOnAuditFail !== "boolean") {
    state.autoFixOnAuditFail = DEFAULT_SWARM_SETTINGS.autoFixOnAuditFail;
  }
  if (typeof raw.keepWorkersWarm !== "boolean") {
    state.keepWorkersWarm = DEFAULT_SWARM_SETTINGS.keepWorkersWarm;
  }
  if (
    typeof raw.finalAuditStatus !== "string" ||
    !VALID_FINAL_AUDIT_STATUSES.has(raw.finalAuditStatus as FinalAuditStatus)
  ) {
    state.finalAuditStatus = "idle";
  }
  if (
    typeof raw.finalAuditRound !== "number" ||
    !Number.isFinite(raw.finalAuditRound) ||
    raw.finalAuditRound < 0
  ) {
    state.finalAuditRound = 0;
  } else {
    state.finalAuditRound = Math.floor(raw.finalAuditRound);
  }
  if (state.roster && typeof state.roster === "object") {
    for (const entry of Object.values(state.roster)) {
      if (
        typeof entry.lastReadBoardSeq !== "number" ||
        !Number.isFinite(entry.lastReadBoardSeq)
      ) {
        entry.lastReadBoardSeq = 0;
      }
      if (typeof entry.turns !== "number" || !Number.isFinite(entry.turns)) {
        entry.turns = 0;
      }
    }
  }
  return state;
}

const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 20;

// ============================================================================
// Pure Protocol Helpers (exported for worktree, runtime & tests)
// ============================================================================

export function isPrintableAsciiTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return PRINTABLE_ASCII_RE.test(trimmed) && HAS_ASCII_ALNUM_RE.test(trimmed);
}

export function slugifyMissionTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function deriveMissionBranch(title: string): string {
  const slug = slugifyMissionTitle(title);
  if (!isPrintableAsciiTitle(title) || slug.length === 0) {
    throw new SwarmProtocolError(
      "INVALID_TITLE",
      `Mission title must contain printable ASCII characters with at least one letter or digit: ${JSON.stringify(title)}`,
      { title },
    );
  }
  return `${SWARM_BRANCH_PREFIX}${slug}`;
}

/**
 * Normalize and validate a POSIX relative scope path.
 * Rejects empty paths, absolute paths, `..`, backslashes, `.git`, and `.pi/swarm`.
 */
export function normalizeScopePath(raw: string): string {
  if (typeof raw !== "string") {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      "Scope path must be a non-empty string",
      { raw },
    );
  }

  let candidate = raw.trim();
  if (candidate.length === 0 || candidate.includes("\0")) {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      `Invalid empty or NUL-containing scope path: ${JSON.stringify(raw)}`,
      { raw },
    );
  }

  if (candidate.includes("\\")) {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      `Scope path must use POSIX forward slashes: ${JSON.stringify(raw)}`,
      { raw },
    );
  }

  if (
    candidate.startsWith("/") ||
    candidate.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(candidate)
  ) {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      `Scope path must be relative to the repository root: ${JSON.stringify(raw)}`,
      { raw },
    );
  }

  while (candidate.endsWith("/")) {
    candidate = candidate.slice(0, -1);
  }

  // Strip trailing directory glob suffixes (`/**` or `/*`) so directory prefixes match cleanly.
  if (candidate.endsWith("/**")) {
    candidate = candidate.slice(0, -3);
  } else if (candidate.endsWith("/*")) {
    candidate = candidate.slice(0, -2);
  }

  while (candidate.startsWith("./")) {
    candidate = candidate.slice(2);
  }
  while (candidate.endsWith("/")) {
    candidate = candidate.slice(0, -1);
  }

  if (candidate.includes("*") || candidate.includes("?")) {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      `Scope path must be a concrete path prefix without glob wildcards ("*" or "?"): ${JSON.stringify(raw)}`,
      { raw },
    );
  }

  const rawSegments = candidate.split("/");
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      throw new SwarmProtocolError(
        "SCOPE_VIOLATION",
        `Scope path must not contain parent traversal (".."): ${JSON.stringify(raw)}`,
        { raw },
      );
    }
    segments.push(seg);
  }

  if (segments.length === 0) {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      `Scope path cannot target repository root: ${JSON.stringify(raw)}`,
      { raw },
    );
  }

  if (segments[0] === ".git") {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      `Scope path cannot target reserved .git directory: ${JSON.stringify(raw)}`,
      { raw },
    );
  }

  if (segments[0] === ".pi" && segments[1] === "swarm") {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      `Scope path cannot target reserved .pi/swarm directory: ${JSON.stringify(raw)}`,
      { raw },
    );
  }

  return segments.join("/");
}

/** Normalize a changed file path reported by git for scope comparisons. */
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

/** Returns true if two normalized POSIX path prefixes overlap (equal or ancestor/descendant). */
export function scopesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Returns true if a single changed repository file matches any declared scope prefix. */
export function isPathInScope(
  filePath: string,
  declaredScope: readonly string[],
): boolean {
  const normalizedFile = normalizeRelativeRepoPath(filePath);
  if (!normalizedFile) {
    return false;
  }
  if (
    normalizedFile === ".git" ||
    normalizedFile.startsWith(".git/") ||
    normalizedFile === ".pi/swarm" ||
    normalizedFile.startsWith(".pi/swarm/")
  ) {
    return false;
  }
  for (const rawPrefix of declaredScope) {
    let prefix: string;
    try {
      prefix = normalizeScopePath(rawPrefix);
    } catch {
      continue;
    }
    if (normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Pure helper enforcing that every touched file matches one of the declared `scope` prefixes.
 * Returns the subset of `changedFiles` that violate `declaredScope`.
 */
export function findScopeViolations(
  changedFiles: readonly string[],
  declaredScope: readonly string[],
): string[] {
  const violations: string[] = [];
  for (const file of changedFiles) {
    if (!isPathInScope(file, declaredScope)) {
      violations.push(file);
    }
  }
  return violations;
}

export function isValidMissionTransition(
  from: MissionStatus,
  to: MissionStatus,
): boolean {
  if (from === to) {
    return from !== "merged" && from !== "abandoned";
  }
  return ALLOWED_TRANSITIONS[from].has(to);
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
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    !pattern.test(trimmed)
  ) {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
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
      "SCOPE_VIOLATION",
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
          "SCOPE_VIOLATION",
          `Refusing to traverse symlink inside project: ${current}`,
          { path: current },
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        // Remaining segments do not exist yet.
        return;
      }
      throw err;
    }
  }
}

async function writeFileAtomic(
  rootDir: string,
  targetPath: string,
  content: string,
): Promise<void> {
  const resolvedTarget = assertWithinRoot(rootDir, targetPath);
  await assertNoSymlinksWithin(rootDir, resolvedTarget);
  const dir = path.dirname(resolvedTarget);
  await mkdir(dir, { recursive: true });
  await assertNoSymlinksWithin(rootDir, dir);

  const tmpPath = `${resolvedTarget}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmpPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, resolvedTarget);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function normalizeTaskInputs(
  tasks: readonly MissionTaskInput[] | undefined,
  now: string,
): MissionTaskItem[] {
  if (!tasks || tasks.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: MissionTaskItem[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const raw = tasks[i];
    if (typeof raw === "string") {
      const title = raw.trim();
      if (!title) continue;
      let id = `T${i + 1}`;
      while (seen.has(id)) {
        id = `${id}_${normalized.length + 1}`;
      }
      seen.add(id);
      normalized.push({ id, title, done: false });
    } else if (raw && typeof raw === "object") {
      const title = raw.title.trim();
      if (!title) continue;
      let id = raw.id?.trim() || `T${i + 1}`;
      while (seen.has(id)) {
        id = `${id}_${normalized.length + 1}`;
      }
      seen.add(id);
      const done = Boolean(raw.done);
      normalized.push({
        id,
        title,
        done,
        ...(done ? { completedAt: now } : {}),
      });
    }
  }
  return normalized;
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

function findRosterSender(
  roster: Record<string, RosterEntry>,
  sender: string,
): RosterEntry | undefined {
  if (roster[sender]) {
    return roster[sender];
  }
  const byName = Object.values(roster).filter((entry) => entry.name === sender);
  if (byName.length === 0) {
    return undefined;
  }
  const live = byName.find(
    (entry) => entry.status === "working" || entry.status === "waiting",
  );
  if (live) {
    return live;
  }
  return byName.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

interface LockFilePayload {
  pid: number;
  token: string;
  hostname: string;
  createdAt: string;
}

export interface SwarmStoreOptions {
  staleLockMs?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

// ============================================================================
// SwarmStore Implementation
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

  getWorktreePath(runId: string, slot: string): string {
    const safeRunId = validateSafeIdentifier(runId, "runId");
    const safeSlot = validateSafeIdentifier(slot, "slot");
    const dirName = safeSlot.startsWith(SWARM_WORKTREE_PREFIX)
      ? safeSlot
      : `${SWARM_WORKTREE_PREFIX}${safeSlot}`;
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.worktreesRoot, safeRunId, dirName),
    );
  }

  private getStatePath(runId: string): string {
    return path.join(this.getRunDir(runId), SWARM_STATE_FILE);
  }

  private getMissionsMarkdownPath(runId: string): string {
    return path.join(this.getRunDir(runId), SWARM_MISSIONS_FILE);
  }

  private getEventsPath(runId: string): string {
    return path.join(this.getRunDir(runId), SWARM_EVENTS_FILE);
  }

  private getInboxPath(runId: string, recipient: string): string {
    const safeRecipient = validateSafeIdentifier(recipient, "recipient");
    return assertWithinRoot(
      this.projectRoot,
      path.join(
        this.getRunDir(runId),
        SWARM_INBOX_DIR,
        `${safeRecipient}.jsonl`,
      ),
    );
  }

  private getReviewPath(runId: string, missionId: string, round: number): string {
    const safeMissionId = validateSafeIdentifier(
      missionId,
      "missionId",
      SAFE_MISSION_ID_RE,
    );
    return assertWithinRoot(
      this.projectRoot,
      path.join(
        this.getRunDir(runId),
        SWARM_REVIEWS_DIR,
        `${safeMissionId}-r${round}.json`,
      ),
    );
  }

  private getAuditsDir(runId: string): string {
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.getRunDir(runId), SWARM_AUDITS_DIR),
    );
  }

  private getAuditPath(runId: string, round: number): string {
    const safeRound = Math.max(1, Math.floor(round));
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.getAuditsDir(runId), `audit-r${safeRound}.json`),
    );
  }

  private getFindingPath(runId: string, findingId: string): string {
    const safeFindingId = validateSafeIdentifier(findingId, "findingId");
    return assertWithinRoot(
      this.projectRoot,
      path.join(
        this.getRunDir(runId),
        SWARM_FINDINGS_DIR,
        `${safeFindingId}.json`,
      ),
    );
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
    while (!acquired) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(payload), "utf8");
        } finally {
          await handle.close();
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
      await this.releaseFileLock(lockPath, token);
    }
  }

  private async tryRecoverStaleLock(lockPath: string): Promise<boolean> {
    try {
      const st = await lstat(lockPath);
      if (st.isSymbolicLink()) {
        throw new SwarmProtocolError(
          "SCOPE_VIOLATION",
          `Refusing to use symlinked lock file: ${lockPath}`,
          { lockPath },
        );
      }
      const ageMs = Date.now() - st.mtimeMs;
      let isStale = ageMs >= this.staleLockMs;

      if (!isStale) {
        try {
          const raw = await readFile(lockPath, "utf8");
          const info = JSON.parse(raw) as Partial<LockFilePayload>;
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
        } catch {
          // Empty or partially written lock file: recover only once aged slightly.
          if (ageMs >= Math.min(this.staleLockMs, 2_000)) {
            isStale = true;
          }
        }
      }

      if (isStale) {
        await unlink(lockPath).catch(() => {});
        return true;
      }
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return true;
      }
      throw err;
    }
  }

  private async releaseFileLock(lockPath: string, token: string): Promise<void> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const info = JSON.parse(raw) as Partial<LockFilePayload>;
      if (info.token === token) {
        await unlink(lockPath).catch(() => {});
      }
    } catch {
      // Lock already removed or unreadable; nothing left to release.
    }
  }

  private async readStateUnlocked(runId: string): Promise<SwarmRunState> {
    const statePath = this.getStatePath(runId);
    await assertNoSymlinksWithin(this.projectRoot, statePath);
    try {
      const raw = await readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as SwarmRunState;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.id !== "string"
      ) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Corrupted run state for "${runId}"`,
          { runId },
        );
      }
      return backfillRunState(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Swarm run "${runId}" not found`,
          { runId },
        );
      }
      throw err;
    }
  }

  private async persistStateUnlocked(
    state: SwarmRunState,
  ): Promise<SwarmRunState> {
    const statePath = this.getStatePath(state.id);
    const missionsMdPath = this.getMissionsMarkdownPath(state.id);
    const json = `${JSON.stringify(state, null, 2)}\n`;
    await writeFileAtomic(this.projectRoot, statePath, json);
    await writeFileAtomic(
      this.projectRoot,
      missionsMdPath,
      this.renderMissionsMarkdown(state),
    );
    return structuredClone(state);
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
  // Plan Validation (Swarm Protocol Invariants)
  // --------------------------------------------------------------------------

  validatePlan(
    missions: MissionPlanInput[],
    options?: PlanValidationOptions,
  ): PlanValidationResult {
    const errors: PlanValidationIssue[] = [];
    const branches: Record<string, string> = {};

    const existingMissions = options?.existingMissions ?? {};
    const reservedBranches = new Map<string, string>();

    if (options?.baseBranch) {
      reservedBranches.set(
        options.baseBranch,
        `base branch "${options.baseBranch}"`,
      );
    }
    for (const branch of options?.existingBranches ?? []) {
      if (branch && !reservedBranches.has(branch)) {
        reservedBranches.set(branch, `existing git branch "${branch}"`);
      }
    }
    for (const existing of Object.values(existingMissions)) {
      if (existing.branch) {
        reservedBranches.set(
          existing.branch,
          `existing mission "${existing.id}" (${existing.status})`,
        );
      }
    }

    if (!Array.isArray(missions) || missions.length === 0) {
      errors.push({
        code: "INVALID_DAG",
        message: "Mission plan must contain at least one mission.",
      });
      return { valid: false, errors, waves: [], branches };
    }

    // Track open build scope reservations from existing open build missions first.
    const openBuildScopes: Array<{ missionId: string; path: string }> = [];
    for (const existing of Object.values(existingMissions)) {
      if (
        existing.kind === "build" &&
        OPEN_MISSION_STATUSES.has(existing.status)
      ) {
        for (const rawScope of existing.scope) {
          try {
            openBuildScopes.push({
              missionId: existing.id,
              path: normalizeScopePath(rawScope),
            });
          } catch {
            // Existing state may contain legacy scope entries; skip malformed.
          }
        }
      }
    }

    const incomingIds = new Set<string>();
    const incomingMap = new Map<string, MissionPlanInput>();

    for (const mission of missions) {
      const id = typeof mission.id === "string" ? mission.id.trim() : "";
      if (
        !id ||
        id.includes("..") ||
        id.includes("/") ||
        id.includes("\\") ||
        !SAFE_MISSION_ID_RE.test(id)
      ) {
        errors.push({
          code: "INVALID_DAG",
          missionId: mission.id,
          message: `Invalid mission ID: ${JSON.stringify(mission.id)}`,
        });
        continue;
      }

      if (incomingIds.has(id) || id in existingMissions) {
        errors.push({
          code: "DUPLICATE_MISSION",
          missionId: id,
          message: `Duplicate mission ID "${id}".`,
        });
      } else {
        incomingIds.add(id);
        incomingMap.set(id, mission);
      }

      if (!VALID_MISSION_KINDS.has(mission.kind)) {
        errors.push({
          code: "INVALID_DAG",
          missionId: id,
          message: `Mission "${id}" has invalid kind "${String(mission.kind)}".`,
        });
      }

      // Printable ASCII title & deterministic unique branch `feat/<slug>`
      if (!isPrintableAsciiTitle(mission.title ?? "")) {
        errors.push({
          code: "INVALID_TITLE",
          missionId: id,
          message: `Mission "${id}" title must use printable ASCII characters with at least one alphanumeric character: ${JSON.stringify(mission.title)}`,
        });
      } else {
        const branch = deriveMissionBranch(mission.title);
        const owner = reservedBranches.get(branch);
        if (owner) {
          errors.push({
            code: "DUPLICATE_BRANCH",
            missionId: id,
            message: `Derived branch "${branch}" for mission "${id}" collides with ${owner}.`,
            details: { branch, collidesWith: owner },
          });
        } else {
          reservedBranches.set(branch, `mission "${id}"`);
          branches[id] = branch;
        }
      }

      // Normalize & validate scope paths
      const rawScopes = Array.isArray(mission.scope) ? mission.scope : [];
      if (mission.kind === "build" && rawScopes.length === 0) {
        errors.push({
          code: "SCOPE_VIOLATION",
          missionId: id,
          message: `Build mission "${id}" must declare at least one scope path.`,
        });
      }

      const normalizedScopes: string[] = [];
      for (const rawScope of rawScopes) {
        try {
          normalizedScopes.push(normalizeScopePath(rawScope));
        } catch (err) {
          errors.push({
            code: "SCOPE_VIOLATION",
            missionId: id,
            message:
              err instanceof Error
                ? `Mission "${id}": ${err.message}`
                : `Mission "${id}": invalid scope path ${JSON.stringify(rawScope)}`,
            details: { rawScope },
          });
        }
      }

      // Enforce pairwise disjoint scope prefixes across open build missions ONLY.
      // Survey scopes are informational (do not reserve paths).
      if (mission.kind === "build") {
        for (const candidatePath of normalizedScopes) {
          for (const reserved of openBuildScopes) {
            if (reserved.missionId === id) {
              continue;
            }
            if (scopesOverlap(candidatePath, reserved.path)) {
              errors.push({
                code: "SCOPE_OVERLAP",
                missionId: id,
                message: `Build mission "${id}" scope "${candidatePath}" overlaps with open build mission "${reserved.missionId}" scope "${reserved.path}".`,
                details: {
                  missionId: id,
                  scope: candidatePath,
                  otherMissionId: reserved.missionId,
                  otherScope: reserved.path,
                },
              });
            }
          }
        }
        for (const candidatePath of normalizedScopes) {
          openBuildScopes.push({ missionId: id, path: candidatePath });
        }
      }
    }

    // Validate dependency existence & self-loops
    const allKnownIds = new Set<string>([
      ...Object.keys(existingMissions),
      ...incomingIds,
    ]);
    for (const [id, mission] of incomingMap) {
      const deps = Array.isArray(mission.deps) ? mission.deps : [];
      for (const dep of deps) {
        if (dep === id) {
          errors.push({
            code: "CYCLE_DETECTED",
            missionId: id,
            message: `Mission "${id}" cannot depend on itself.`,
            details: { cycle: [id, id] },
          });
        } else if (!allKnownIds.has(dep)) {
          errors.push({
            code: "MISSING_DEP",
            missionId: id,
            message: `Mission "${id}" depends on unknown mission "${dep}".`,
            details: { missingDep: dep },
          });
        }
      }
    }

    // Cycle detection & topological wave grouping via Kahn's algorithm
    // Build full graph across existingMissions + incoming missions to guarantee global acyclicity.
    const fullNodes = new Map<string, string[]>();
    for (const existing of Object.values(existingMissions)) {
      fullNodes.set(existing.id, [...existing.deps]);
    }
    for (const [id, mission] of incomingMap) {
      const validDeps = (Array.isArray(mission.deps) ? mission.deps : []).filter(
        (d) => allKnownIds.has(d),
      );
      fullNodes.set(id, validDeps);
    }

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of fullNodes.keys()) {
      inDegree.set(id, 0);
      dependents.set(id, []);
    }
    for (const [id, deps] of fullNodes) {
      const uniqueDeps = new Set(deps);
      for (const dep of uniqueDeps) {
        if (fullNodes.has(dep)) {
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
          dependents.get(dep)!.push(id);
        }
      }
    }

    const fullQueue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) {
        fullQueue.push(id);
      }
    }
    let visitedCount = 0;
    const tempInDegree = new Map(inDegree);
    let idx = 0;
    while (idx < fullQueue.length) {
      const cur = fullQueue[idx++];
      visitedCount += 1;
      for (const next of dependents.get(cur) ?? []) {
        const nextDeg = (tempInDegree.get(next) ?? 0) - 1;
        tempInDegree.set(next, nextDeg);
        if (nextDeg === 0) {
          fullQueue.push(next);
        }
      }
    }

    if (visitedCount < fullNodes.size) {
      const cycleNodes = [...tempInDegree.entries()]
        .filter(([, deg]) => deg > 0)
        .map(([id]) => id);
      const alreadyReportedSelf =
        cycleNodes.length === 1 &&
        errors.some(
          (e) => e.code === "CYCLE_DETECTED" && e.missionId === cycleNodes[0],
        );
      if (!alreadyReportedSelf) {
        errors.push({
          code: "CYCLE_DETECTED",
          message: `Dependency cycle detected involving missions: ${cycleNodes.join(", ")}.`,
          details: { cycleNodes },
        });
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors, waves: [], branches };
    }

    // Build deterministic level-by-level waves for the incoming missions (preserving input order).
    const incomingOrder = missions.map((m) => m.id.trim());
    const incomingInDeg = new Map<string, number>();
    const incomingDependents = new Map<string, string[]>();
    for (const id of incomingOrder) {
      incomingInDeg.set(id, 0);
      incomingDependents.set(id, []);
    }
    for (const id of incomingOrder) {
      const mission = incomingMap.get(id)!;
      const uniqueIncomingDeps = new Set(
        (mission.deps ?? []).filter((d) => incomingMap.has(d)),
      );
      incomingInDeg.set(id, uniqueIncomingDeps.size);
      for (const dep of uniqueIncomingDeps) {
        incomingDependents.get(dep)!.push(id);
      }
    }

    const waves: string[][] = [];
    let currentWave = incomingOrder.filter(
      (id) => incomingInDeg.get(id) === 0,
    );
    while (currentWave.length > 0) {
      waves.push(currentWave);
      const nextWaveSet = new Set<string>();
      for (const id of currentWave) {
        for (const depOf of incomingDependents.get(id) ?? []) {
          const nextDeg = (incomingInDeg.get(depOf) ?? 0) - 1;
          incomingInDeg.set(depOf, nextDeg);
          if (nextDeg === 0) {
            nextWaveSet.add(depOf);
          }
        }
      }
      currentWave = incomingOrder.filter((id) => nextWaveSet.has(id));
    }

    return { valid: true, errors: [], waves, branches };
  }

  private throwIfInvalidPlan(validation: PlanValidationResult): void {
    if (validation.valid) {
      return;
    }
    const primary = validation.errors[0];
    const combinedMessage = validation.errors.map((e) => e.message).join("; ");
    throw new SwarmProtocolError(primary.code, combinedMessage, {
      issues: validation.errors,
    });
  }

  // --------------------------------------------------------------------------
  // Run Lifecycle Operations
  // --------------------------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<SwarmRunState> {
    const runId = input.id
      ? validateSafeIdentifier(input.id, "runId")
      : generateRunId();

    const objective = input.objective?.trim();
    if (!objective) {
      throw new SwarmProtocolError(
        "INVALID_DAG",
        "Run objective must not be empty.",
      );
    }
    const baseBranch = input.baseBranch?.trim();
    if (!baseBranch) {
      throw new SwarmProtocolError(
        "WRONG_BRANCH",
        "Base branch must not be empty.",
      );
    }
    const ownerSessionId = input.ownerSessionId?.trim();
    if (!ownerSessionId) {
      throw new SwarmProtocolError(
        "OWNERSHIP_CONFLICT",
        "ownerSessionId must not be empty.",
      );
    }

    const validation = this.validatePlan(input.missions, {
      existingBranches: input.existingBranches,
      baseBranch,
    });
    this.throwIfInvalidPlan(validation);

    return this.withRunLock(runId, async () => {
      const statePath = this.getStatePath(runId);
      try {
        await stat(statePath);
        throw new SwarmProtocolError(
          "DUPLICATE_MISSION",
          `Run "${runId}" already exists.`,
          { runId },
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
      }

      const now = new Date().toISOString();
      const missions: Record<string, MissionRecord> = {};
      const missionOrder: string[] = [];

      for (const m of input.missions) {
        const id = m.id.trim();
        const normalizedScope = Array.from(
          new Set((m.scope ?? []).map((s) => normalizeScopePath(s))),
        );
        const branch = validation.branches[id];
        missions[id] = {
          id,
          title: m.title.trim(),
          kind: m.kind,
          description: m.description ?? "",
          scope: normalizedScope,
          deps: Array.from(new Set((m.deps ?? []).map((d) => d.trim()))),
          verification: m.verification ?? "",
          tasks: normalizeTaskInputs(m.tasks, now),
          branch,
          worktreePath: this.getWorktreePath(runId, id),
          status: "planned",
          reviewRound: 0,
          retryCount: 0,
          humanStopped: false,
          createdAt: now,
          updatedAt: now,
        };
        missionOrder.push(id);
      }

      const maxConcurrency = Math.max(
        1,
        Math.floor(
          input.maxConcurrency ?? DEFAULT_SWARM_SETTINGS.maxConcurrency,
        ),
      );
      const maxValidationRounds = clampRounds(
        input.maxValidationRounds,
        MAX_VALIDATION_ROUNDS_MIN,
        MAX_VALIDATION_ROUNDS_MAX,
        DEFAULT_SWARM_SETTINGS.maxValidationRounds,
      );
      const maxFinalAuditRounds = clampRounds(
        input.maxFinalAuditRounds,
        MAX_FINAL_AUDIT_ROUNDS_MIN,
        MAX_FINAL_AUDIT_ROUNDS_MAX,
        DEFAULT_SWARM_SETTINGS.maxFinalAuditRounds,
      );

      const state: SwarmRunState = {
        version: SWARM_STATE_VERSION,
        id: runId,
        objective,
        verificationContract: input.verificationContract ?? "",
        baseBranch,
        ownerSessionId,
        ownerPid: input.ownerPid ?? process.pid,
        status: "active",
        maxConcurrency,
        validatorEnabled:
          input.validatorEnabled ?? DEFAULT_SWARM_SETTINGS.validatorEnabled,
        maxValidationRounds,
        finalValidatorEnabled:
          input.finalValidatorEnabled ??
          DEFAULT_SWARM_SETTINGS.finalValidatorEnabled,
        maxFinalAuditRounds,
        autoFixOnAuditFail:
          input.autoFixOnAuditFail ?? DEFAULT_SWARM_SETTINGS.autoFixOnAuditFail,
        keepWorkersWarm:
          input.keepWorkersWarm ?? DEFAULT_SWARM_SETTINGS.keepWorkersWarm,
        finalAuditStatus: "idle",
        finalAuditRound: 0,
        ...(input.roleModels !== undefined
          ? { roleModels: cloneRoleModels(input.roleModels) }
          : {}),
        revision: 1,
        missions,
        missionOrder,
        roster: {},
        findings: [],
        createdAt: now,
        updatedAt: now,
      };

      const saved = await this.persistStateUnlocked(state);
      const auditsDir = this.getAuditsDir(runId);
      await assertNoSymlinksWithin(this.projectRoot, auditsDir);
      await mkdir(auditsDir, { recursive: true });

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "run_created",
        actor: ORCHESTRATOR_BOARD_NAME,
        summary: `Created run "${runId}" on base "${baseBranch}" with ${missionOrder.length} mission(s).`,
        data: {
          baseBranch,
          missions: missionOrder,
          waves: validation.waves,
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

    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      if (!SAFE_ID_RE.test(entry) || entry.includes("..")) {
        continue;
      }
      try {
        const state = await this.readStateUnlocked(entry);
        const allMissions = Object.values(state.missions);
        const mergedCount = allMissions.filter(
          (m) => m.status === "merged",
        ).length;
        const activeCount = allMissions.filter(
          (m) => m.status === "active",
        ).length;
        summaries.push({
          id: state.id,
          objective: state.objective,
          baseBranch: state.baseBranch,
          status: state.status,
          missionCount: allMissions.length,
          mergedCount,
          activeCount,
          ownerSessionId: state.ownerSessionId,
          ownerPid: state.ownerPid,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        });
      } catch {
        // Ignore non-run or unreadable subdirectories.
      }
    }

    summaries.sort((a, b) => {
      const cmp = b.updatedAt.localeCompare(a.updatedAt);
      if (cmp !== 0) return cmp;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return summaries;
  }

  async getActiveRunId(): Promise<string | null> {
    const runs = await this.listRuns();
    const active = runs.find(
      (r) => r.status === "active" || r.status === "verifying",
    );
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

      const previousStatus = state.status;
      if (patch.status !== undefined) state.status = patch.status;
      if (patch.objective !== undefined) state.objective = patch.objective.trim();
      if (patch.verificationContract !== undefined) {
        state.verificationContract = patch.verificationContract;
      }
      if (patch.baseBranch !== undefined) {
        state.baseBranch = patch.baseBranch.trim();
      }
      if (patch.maxConcurrency !== undefined) {
        state.maxConcurrency = Math.max(1, Math.floor(patch.maxConcurrency));
      }
      if (patch.validatorEnabled !== undefined) {
        state.validatorEnabled = patch.validatorEnabled;
      }
      if (patch.maxValidationRounds !== undefined) {
        state.maxValidationRounds = clampRounds(
          patch.maxValidationRounds,
          MAX_VALIDATION_ROUNDS_MIN,
          MAX_VALIDATION_ROUNDS_MAX,
          state.maxValidationRounds,
        );
      }
      if (patch.finalValidatorEnabled !== undefined) {
        state.finalValidatorEnabled = patch.finalValidatorEnabled;
      }
      if (patch.maxFinalAuditRounds !== undefined) {
        state.maxFinalAuditRounds = clampRounds(
          patch.maxFinalAuditRounds,
          MAX_FINAL_AUDIT_ROUNDS_MIN,
          MAX_FINAL_AUDIT_ROUNDS_MAX,
          state.maxFinalAuditRounds,
        );
      }
      if (patch.autoFixOnAuditFail !== undefined) {
        state.autoFixOnAuditFail = patch.autoFixOnAuditFail;
      }
      if (patch.keepWorkersWarm !== undefined) {
        state.keepWorkersWarm = patch.keepWorkersWarm;
      }
      if (patch.roleModels !== undefined) {
        state.roleModels = cloneRoleModels(patch.roleModels);
      }
      if (patch.finalAuditStatus !== undefined) {
        if (!VALID_FINAL_AUDIT_STATUSES.has(patch.finalAuditStatus)) {
          throw new SwarmProtocolError(
            "INVALID_TRANSITION",
            `Invalid finalAuditStatus "${String(patch.finalAuditStatus)}" for run "${runId}".`,
            { runId, finalAuditStatus: patch.finalAuditStatus },
          );
        }
        state.finalAuditStatus = patch.finalAuditStatus;
      }
      if (patch.ownerSessionId !== undefined) {
        state.ownerSessionId = patch.ownerSessionId;
      }
      if (patch.ownerPid !== undefined) {
        state.ownerPid = patch.ownerPid;
      }

      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      const saved = await this.persistStateUnlocked(state);

      if (patch.status && patch.status !== previousStatus) {
        const eventType =
          patch.status === "paused"
            ? "run_paused"
            : (patch.status === "active" || patch.status === "verifying") &&
                previousStatus === "paused"
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
            actor: patch.actor ?? ORCHESTRATOR_BOARD_NAME,
            summary: `Run "${runId}" transitioned ${previousStatus} -> ${patch.status}.`,
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
  // Mission Mutations
  // --------------------------------------------------------------------------

  async addMissions(
    runId: string,
    missions: MissionPlanInput[],
    options?: {
      existingBranches?: readonly string[];
      expectedRevision?: number;
      actor?: string;
    },
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, options?.expectedRevision);

      const validation = this.validatePlan(missions, {
        existingMissions: state.missions,
        existingBranches: options?.existingBranches,
        baseBranch: state.baseBranch,
      });
      this.throwIfInvalidPlan(validation);

      const now = new Date().toISOString();
      const addedIds: string[] = [];

      for (const m of missions) {
        const id = m.id.trim();
        const normalizedScope = Array.from(
          new Set((m.scope ?? []).map((s) => normalizeScopePath(s))),
        );
        state.missions[id] = {
          id,
          title: m.title.trim(),
          kind: m.kind,
          description: m.description ?? "",
          scope: normalizedScope,
          deps: Array.from(new Set((m.deps ?? []).map((d) => d.trim()))),
          verification: m.verification ?? "",
          tasks: normalizeTaskInputs(m.tasks, now),
          branch: validation.branches[id],
          worktreePath: this.getWorktreePath(runId, id),
          status: "planned",
          reviewRound: 0,
          retryCount: 0,
          humanStopped: false,
          createdAt: now,
          updatedAt: now,
        };
        state.missionOrder.push(id);
        addedIds.push(id);
      }

      if (
        state.status === "verifying" ||
        state.finalAuditStatus === "disapproved" ||
        state.finalAuditStatus === "approved"
      ) {
        state.status = "active";
        state.finalAuditStatus = "idle";
      }

      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "mission_planned",
        actor: options?.actor ?? ORCHESTRATOR_BOARD_NAME,
        summary: `Added ${addedIds.length} mission(s): ${addedIds.join(", ")}.`,
        data: { missionIds: addedIds, waves: validation.waves },
      });

      return saved;
    });
  }

  async updateMission(
    runId: string,
    missionId: string,
    patch: MissionUpdateInput,
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, patch.expectedRevision);

      const mission = state.missions[missionId];
      if (!mission) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Mission "${missionId}" not found in run "${runId}".`,
          { runId, missionId },
        );
      }

      const callerRole: CallerRole = patch.callerRole ?? "orchestrator";
      if (callerRole === "validator") {
        throw new SwarmProtocolError(
          "ROLE_FORBIDDEN",
          `Validator role cannot mutate mission "${missionId}" directly; submit a verdict via recordReview or recordFinalAudit.`,
          { runId, missionId, callerRole },
        );
      }

      const previousStatus = mission.status;
      if (patch.status !== undefined) {
        if (
          (patch.status === "abandoned" || patch.status === "merged") &&
          !ORCHESTRATOR_OR_HUMAN.has(callerRole)
        ) {
          throw new SwarmProtocolError(
            "ROLE_FORBIDDEN",
            `Caller role "${callerRole}" is not allowed to set mission "${missionId}" to "${patch.status}".`,
            { runId, missionId, callerRole, targetStatus: patch.status },
          );
        }

        if (!isValidMissionTransition(mission.status, patch.status)) {
          throw new SwarmProtocolError(
            "INVALID_TRANSITION",
            `Invalid mission status transition for "${missionId}": ${mission.status} -> ${patch.status}.`,
            { runId, missionId, from: mission.status, to: patch.status },
          );
        }
        mission.status = patch.status;
      }

      const now = new Date().toISOString();

      if (patch.progressSummary !== undefined) {
        mission.progressSummary = patch.progressSummary;
      }
      if (patch.tasks !== undefined) {
        mission.tasks = patch.tasks.map((t) => ({ ...t }));
      }
      if (patch.taskDoneIds && patch.taskDoneIds.length > 0) {
        const doneSet = new Set(patch.taskDoneIds);
        for (const task of mission.tasks) {
          if (doneSet.has(task.id) && !task.done) {
            task.done = true;
            task.completedAt = now;
          }
        }
      }
      if (patch.worktreePath !== undefined) {
        mission.worktreePath = patch.worktreePath;
      }
      if (patch.reviewRound !== undefined) {
        mission.reviewRound = Math.max(0, Math.floor(patch.reviewRound));
      }
      if (patch.retryCount !== undefined) {
        mission.retryCount = Math.max(0, Math.floor(patch.retryCount));
      }
      if (patch.humanStopped !== undefined) {
        mission.humanStopped = patch.humanStopped;
      }
      if (patch.error === null) {
        delete mission.error;
      } else if (patch.error !== undefined) {
        mission.error = patch.error;
      }

      mission.updatedAt = now;
      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      const actor = patch.actor ?? callerRole;
      if (patch.status && patch.status !== previousStatus) {
        const type =
          patch.status === "active"
            ? "mission_started"
            : patch.status === "completed"
              ? "mission_completed"
              : patch.status === "abandoned"
                ? "mission_abandoned"
                : patch.status === "failed"
                  ? "mission_failed"
                  : "mission_progress";
        await appendLedgerEvent(this.getEventsPath(runId), {
          runId,
          type,
          actor,
          missionId,
          summary: `Mission "${missionId}" transitioned ${previousStatus} -> ${patch.status}.`,
        });
      } else if (
        patch.progressSummary !== undefined ||
        patch.taskDoneIds?.length
      ) {
        await appendLedgerEvent(this.getEventsPath(runId), {
          runId,
          type: "mission_progress",
          actor,
          missionId,
          summary:
            patch.progressSummary ??
            `Completed task(s): ${patch.taskDoneIds?.join(", ") ?? ""}`,
        });
      }

      return saved;
    });
  }

  async patchMissionScope(
    runId: string,
    missionId: string,
    scope: string[],
    options?: {
      expectedRevision?: number;
      callerRole?: CallerRole;
      actor?: string;
    },
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, options?.expectedRevision);

      const mission = state.missions[missionId];
      if (!mission) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Mission "${missionId}" not found in run "${runId}".`,
          { runId, missionId },
        );
      }

      const callerRole: CallerRole = options?.callerRole ?? "orchestrator";
      if (callerRole === "validator") {
        throw new SwarmProtocolError(
          "ROLE_FORBIDDEN",
          `Validator role cannot patch scope for mission "${missionId}".`,
          { runId, missionId, callerRole },
        );
      }

      if (mission.status === "merged" || mission.status === "abandoned") {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Cannot patch scope on terminal mission "${missionId}" (${mission.status}).`,
          { runId, missionId, status: mission.status },
        );
      }

      if (mission.kind === "build" && scope.length === 0) {
        throw new SwarmProtocolError(
          "SCOPE_VIOLATION",
          `Build mission "${missionId}" must declare at least one scope path.`,
          { runId, missionId },
        );
      }

      const normalized = Array.from(
        new Set(scope.map((s) => normalizeScopePath(s))),
      );

      // Re-validate pairwise disjointness against all OTHER open build missions.
      if (
        mission.kind === "build" &&
        OPEN_MISSION_STATUSES.has(mission.status)
      ) {
        for (const other of Object.values(state.missions)) {
          if (
            other.id === missionId ||
            other.kind !== "build" ||
            !OPEN_MISSION_STATUSES.has(other.status)
          ) {
            continue;
          }
          for (const candidatePath of normalized) {
            for (const otherRaw of other.scope) {
              const otherPath = normalizeScopePath(otherRaw);
              if (scopesOverlap(candidatePath, otherPath)) {
                throw new SwarmProtocolError(
                  "SCOPE_OVERLAP",
                  `Patched scope "${candidatePath}" for mission "${missionId}" overlaps with open build mission "${other.id}" scope "${otherPath}".`,
                  {
                    missionId,
                    scope: candidatePath,
                    otherMissionId: other.id,
                    otherScope: otherPath,
                  },
                );
              }
            }
          }
        }
      }

      const now = new Date().toISOString();
      const previousScope = [...mission.scope];
      mission.scope = normalized;
      mission.updatedAt = now;
      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "mission_scope_patched",
        actor: options?.actor ?? callerRole,
        missionId,
        summary: `Patched scope for "${missionId}": [${normalized.join(", ")}]`,
        data: { previousScope, scope: normalized },
      });

      return saved;
    });
  }

  async recordReview(
    runId: string,
    missionId: string,
    verdict: MissionReviewVerdict,
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      const mission = state.missions[missionId];
      if (!mission) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Mission "${missionId}" not found in run "${runId}".`,
          { runId, missionId },
        );
      }

      if (mission.status !== "completed") {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Cannot record review for mission "${missionId}" in status "${mission.status}"; mission must be "completed".`,
          { runId, missionId, status: mission.status },
        );
      }

      if (!verdict.commitSha || verdict.commitSha.trim().length === 0) {
        throw new SwarmProtocolError(
          "REVIEW_REQUIRED",
          `Review verdict for mission "${missionId}" must include a non-empty commitSha.`,
          { runId, missionId },
        );
      }

      if (verdict.missionId && verdict.missionId !== missionId) {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Review verdict missionId "${verdict.missionId}" does not match target mission "${missionId}".`,
          { runId, missionId, verdictMissionId: verdict.missionId },
        );
      }

      if (!isValidReviewSeverityStatus(verdict.status)) {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Invalid review severity status "${String(verdict.status)}".`,
          { runId, missionId, status: verdict.status },
        );
      }

      if (!VALID_MERGE_DECISIONS.has(verdict.merge)) {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Invalid review merge decision "${String(verdict.merge)}".`,
          { runId, missionId, merge: verdict.merge },
        );
      }

      const now = new Date().toISOString();
      const round =
        verdict.round !== undefined && verdict.round > mission.reviewRound
          ? Math.floor(verdict.round)
          : mission.reviewRound + 1;

      const storedVerdict: MissionReviewVerdict = {
        ...verdict,
        missionId,
        branch: verdict.branch || mission.branch,
        commitSha: verdict.commitSha.trim(),
        reviewedAt: verdict.reviewedAt || now,
        round,
      };

      const reviewPath = this.getReviewPath(runId, missionId, round);
      await writeFileAtomic(
        this.projectRoot,
        reviewPath,
        `${JSON.stringify(storedVerdict, null, 2)}\n`,
      );

      mission.latestReview = storedVerdict;
      mission.lastReviewedSha = storedVerdict.commitSha;
      mission.reviewRound = round;

      const isCleanMergeable =
        storedVerdict.status === "clean" && storedVerdict.merge === "merge";
      if (!isCleanMergeable) {
        // Swarm protocol invariant: non-clean validation automatically flips completed -> active.
        mission.status = "active";
      }

      mission.updatedAt = now;
      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "validation_submitted",
        actor: storedVerdict.reviewerAgentId || "validator",
        missionId,
        agentId: storedVerdict.reviewerAgentId,
        summary: isCleanMergeable
          ? `Validation round ${round} clean (merge) @${storedVerdict.commitSha.slice(0, 7)}.`
          : `Validation round ${round} ${storedVerdict.status} (${storedVerdict.merge}) @${storedVerdict.commitSha.slice(0, 7)} — reopened mission completed -> active.`,
        data: {
          round,
          status: storedVerdict.status,
          merge: storedVerdict.merge,
          commitSha: storedVerdict.commitSha,
          findingsCount: storedVerdict.findings.length,
        },
      });

      return saved;
    });
  }

  async recordFinalAudit(
    runId: string,
    verdict: FinalAuditVerdict,
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);

      if (!VALID_FINAL_AUDIT_DECISIONS.has(verdict.verdict)) {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Invalid final audit verdict "${String(verdict.verdict)}"; expected "approved" or "disapproved".`,
          { runId, verdict: verdict.verdict },
        );
      }

      const commitSha =
        typeof verdict.commitSha === "string" ? verdict.commitSha.trim() : "";
      if (commitSha.length === 0) {
        throw new SwarmProtocolError(
          "AUDIT_REQUIRED",
          `Final audit verdict for run "${runId}" must include a non-empty commitSha.`,
          { runId },
        );
      }

      const summary =
        typeof verdict.summary === "string" ? verdict.summary.trim() : "";
      if (summary.length === 0) {
        throw new SwarmProtocolError(
          "AUDIT_REQUIRED",
          `Final audit verdict for run "${runId}" must include a non-empty summary.`,
          { runId },
        );
      }

      const now = new Date().toISOString();
      const round =
        typeof verdict.round === "number" &&
        Number.isFinite(verdict.round) &&
        Math.floor(verdict.round) > state.finalAuditRound
          ? Math.floor(verdict.round)
          : state.finalAuditRound + 1;

      const checks = Array.isArray(verdict.checks)
        ? verdict.checks.map((c) => ({ ...c }))
        : [];
      const findings = Array.isArray(verdict.findings)
        ? verdict.findings.map((f) => ({ ...f }))
        : [];
      const recommendedMissions = Array.isArray(verdict.recommendedMissions)
        ? verdict.recommendedMissions.map((m) => ({
            ...m,
            scope: [...m.scope],
            ...(m.tasks ? { tasks: [...m.tasks] } : {}),
          }))
        : undefined;

      const storedVerdict: FinalAuditVerdict = {
        commitSha,
        baseBranch: verdict.baseBranch?.trim() || state.baseBranch,
        auditedAt: verdict.auditedAt || now,
        verifierAgentId: verdict.verifierAgentId || FINAL_VALIDATOR_BOARD_NAME,
        verdict: verdict.verdict,
        summary,
        checks,
        findings,
        ...(recommendedMissions !== undefined ? { recommendedMissions } : {}),
        round,
      };

      const auditPath = this.getAuditPath(runId, round);
      await writeFileAtomic(
        this.projectRoot,
        auditPath,
        `${JSON.stringify(storedVerdict, null, 2)}\n`,
      );

      state.latestFinalAudit = storedVerdict;
      state.lastAuditedSha = storedVerdict.commitSha;
      state.finalAuditRound = round;
      state.finalAuditStatus = storedVerdict.verdict;
      delete state.finalAuditSkippedBy;
      delete state.finalAuditSkippedAt;
      delete state.finalAuditSkipReason;
      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      const checksTotal = checks.length;
      const checksPassed = checks.filter((c) => c.passed).length;
      const findingsCount = findings.length;

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "final_audit_result",
        actor: storedVerdict.verifierAgentId,
        agentId: storedVerdict.verifierAgentId,
        summary: `Final audit round ${round} ${storedVerdict.verdict} @${storedVerdict.commitSha.slice(0, 7)} — ${storedVerdict.summary}`,
        data: {
          round,
          verdict: storedVerdict.verdict,
          commitSha: storedVerdict.commitSha,
          baseBranch: storedVerdict.baseBranch,
          checksPassed,
          checksTotal,
          findingsCount,
          recommendedMissionsCount: recommendedMissions?.length ?? 0,
        },
      });

      return saved;
    });
  }

  async skipFinalAudit(
    runId: string,
    options?: {
      skippedBy?: string;
      reason?: string;
      expectedRevision?: number;
      callerRole?: CallerRole;
    },
  ): Promise<SwarmRunState> {
    if (options?.callerRole !== "human") {
      throw new SwarmProtocolError(
        "ROLE_FORBIDDEN",
        `Caller role "${String(options?.callerRole ?? "unknown")}" cannot skip final verification for run "${runId}"; only human may skip final verification.`,
        { runId, callerRole: options?.callerRole },
      );
    }

    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, options?.expectedRevision);

      const now = new Date().toISOString();
      const skippedBy = options?.skippedBy?.trim() || "human";
      const reason = options?.reason?.trim();

      state.finalAuditStatus = "skipped";
      state.finalAuditSkippedBy = skippedBy;
      state.finalAuditSkippedAt = now;
      if (reason) {
        state.finalAuditSkipReason = reason;
      } else {
        delete state.finalAuditSkipReason;
      }

      const missions = Object.values(state.missions);
      const allMissionsTerminal =
        missions.length > 0 &&
        missions.every((m) => m.status === "merged" || m.status === "abandoned");

      const previousStatus = state.status;
      let transitionedToCompleted = false;
      if (
        allMissionsTerminal &&
        state.status !== "completed" &&
        state.status !== "abandoned" &&
        state.status !== "failed"
      ) {
        state.status = "completed";
        transitionedToCompleted = true;
      } else if (!allMissionsTerminal && state.status === "verifying") {
        state.status = "active";
      }

      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "final_audit_skipped",
        actor: skippedBy,
        summary: reason
          ? `Final verification skipped by ${skippedBy}: ${reason}`
          : `Final verification skipped by ${skippedBy}.`,
        data: {
          skippedBy,
          ...(reason ? { reason } : {}),
          transitionedToCompleted,
        },
      });

      if (transitionedToCompleted) {
        await appendLedgerEvent(this.getEventsPath(runId), {
          runId,
          type: "run_completed",
          actor: skippedBy,
          summary: `Run "${runId}" transitioned ${previousStatus} -> completed (final verification skipped).`,
        });
      }

      return saved;
    });
  }

  async approveArtifact(
    runId: string,
    missionId: string,
    commitSha: string,
    options?: { approvedBy?: string; expectedRevision?: number },
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, options?.expectedRevision);

      const mission = state.missions[missionId];
      if (!mission) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Mission "${missionId}" not found in run "${runId}".`,
          { runId, missionId },
        );
      }

      if (mission.kind !== "artifact") {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Mission "${missionId}" has kind "${mission.kind}"; only "artifact" missions support human artifact approval.`,
          { runId, missionId, kind: mission.kind },
        );
      }

      if (mission.status === "merged" || mission.status === "abandoned") {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Cannot approve artifact on terminal mission "${missionId}" (${mission.status}).`,
          { runId, missionId, status: mission.status },
        );
      }

      const trimmedSha = commitSha.trim();
      if (!trimmedSha) {
        throw new SwarmProtocolError(
          "ARTIFACT_UNAPPROVED",
          `Approval commitSha for artifact mission "${missionId}" must not be empty.`,
          { runId, missionId },
        );
      }

      const now = new Date().toISOString();
      mission.humanApprovedSha = trimmedSha;
      mission.humanApprovedAt = now;
      mission.updatedAt = now;
      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "artifact_approved",
        actor: options?.approvedBy ?? "human",
        missionId,
        summary: `Artifact mission "${missionId}" approved @${trimmedSha.slice(0, 7)}.`,
        data: {
          commitSha: trimmedSha,
          approvedBy: options?.approvedBy ?? "human",
        },
      });

      return saved;
    });
  }

  async markMerged(
    runId: string,
    missionId: string,
    mergedCommitSha: string | null,
    options?: {
      expectedRevision?: number;
      callerRole?: CallerRole;
      actor?: string;
    },
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      this.checkExpectedRevision(state, options?.expectedRevision);

      const callerRole: CallerRole = options?.callerRole ?? "orchestrator";
      if (!ORCHESTRATOR_OR_HUMAN.has(callerRole)) {
        throw new SwarmProtocolError(
          "ROLE_FORBIDDEN",
          `Caller role "${callerRole}" cannot mark mission "${missionId}" merged.`,
          { runId, missionId, callerRole },
        );
      }

      const mission = state.missions[missionId];
      if (!mission) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Mission "${missionId}" not found in run "${runId}".`,
          { runId, missionId },
        );
      }

      if (mission.status !== "completed") {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Cannot mark mission "${missionId}" merged from status "${mission.status}"; expected "completed".`,
          { runId, missionId, from: mission.status, to: "merged" },
        );
      }

      const now = new Date().toISOString();
      mission.status = "merged";
      mission.mergedAt = now;
      if (mergedCommitSha !== null && mergedCommitSha.trim().length > 0) {
        mission.mergedCommitSha = mergedCommitSha.trim();
      }
      mission.updatedAt = now;
      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "merge_succeeded",
        actor: options?.actor ?? callerRole,
        missionId,
        summary: mergedCommitSha
          ? `Merged mission "${missionId}" (${mission.branch}) -> ${mergedCommitSha.slice(0, 7)}.`
          : `Closed zero-diff mission "${missionId}" (${mission.kind}).`,
        data: { branch: mission.branch, mergedCommitSha },
      });

      return saved;
    });
  }

  // --------------------------------------------------------------------------
  // Roster Management (Warm Persistent Agents)
  // --------------------------------------------------------------------------

  async registerRoster(
    runId: string,
    entry: RegisterRosterInput,
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);

      if (!VALID_ROSTER_ROLES.has(entry.role)) {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Invalid roster role "${String(entry.role)}" for agent "${entry.agentId}".`,
          { runId, agentId: entry.agentId, role: entry.role },
        );
      }

      const initialStatus: RosterAgentStatus = entry.status ?? "working";
      if (!VALID_ROSTER_STATUSES.has(initialStatus)) {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Invalid initial roster status "${String(initialStatus)}" for agent "${entry.agentId}".`,
          { runId, agentId: entry.agentId, status: initialStatus },
        );
      }

      const isFinalValidator =
        entry.role === "final-validator" &&
        entry.missionId === FINAL_AUDIT_MISSION_ID;
      if (!isFinalValidator && !state.missions[entry.missionId]) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Cannot register roster agent for unknown mission "${entry.missionId}".`,
          { runId, missionId: entry.missionId, role: entry.role },
        );
      }

      const existing = state.roster[entry.agentId];
      if (
        existing &&
        (existing.status === "working" || existing.status === "waiting")
      ) {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Roster agent "${entry.agentId}" is already ${existing.status}.`,
          { runId, agentId: entry.agentId, status: existing.status },
        );
      }

      const now = new Date().toISOString();
      const record: RosterEntry = {
        agentId: entry.agentId,
        name: entry.name,
        role: entry.role,
        missionId: entry.missionId,
        worktreePath: entry.worktreePath,
        branch: entry.branch,
        status: initialStatus,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.thinkingLevel !== undefined
          ? { thinkingLevel: entry.thinkingLevel }
          : {}),
        lastReadBoardSeq:
          typeof entry.lastReadBoardSeq === "number" &&
          Number.isFinite(entry.lastReadBoardSeq)
            ? Math.max(0, Math.floor(entry.lastReadBoardSeq))
            : 0,
        turns:
          typeof entry.turns === "number" && Number.isFinite(entry.turns)
            ? Math.max(0, Math.floor(entry.turns))
            : 0,
        startedAt: entry.startedAt ?? now,
        humanStopped: false,
        tokens: 0,
        cost: 0,
        logTail: [],
      };

      state.roster[entry.agentId] = record;
      state.revision += 1;
      state.updatedAt = now;
      const saved = await this.persistStateUnlocked(state);

      if (entry.role === "final-validator") {
        const nextRound = state.finalAuditRound + 1;
        await appendLedgerEvent(this.getEventsPath(runId), {
          runId,
          type: "final_audit_started",
          actor: ORCHESTRATOR_BOARD_NAME,
          missionId: entry.missionId,
          agentId: entry.agentId,
          summary: `Started Final Validator "${entry.name}" (${entry.agentId}) on "${entry.branch}" (round ${nextRound}).`,
          data: {
            round: nextRound,
            branch: entry.branch,
            baseBranch: state.baseBranch,
            agentName: entry.name,
            ...(entry.model ? { model: entry.model } : {}),
          },
        });
      } else if (entry.role === "validator") {
        await appendLedgerEvent(this.getEventsPath(runId), {
          runId,
          type: "validator_spawned",
          actor: ORCHESTRATOR_BOARD_NAME,
          missionId: entry.missionId,
          agentId: entry.agentId,
          summary: `Spawned validator "${entry.name}" (${entry.agentId}) for mission "${entry.missionId}".`,
          data: {
            agentName: entry.name,
            ...(entry.model ? { model: entry.model } : {}),
          },
        });
      } else {
        await appendLedgerEvent(this.getEventsPath(runId), {
          runId,
          type: "worker_spawned",
          actor: ORCHESTRATOR_BOARD_NAME,
          missionId: entry.missionId,
          agentId: entry.agentId,
          summary: `Spawned worker "${entry.name}" (${entry.agentId}) for mission "${entry.missionId}".`,
          data: {
            agentName: entry.name,
            ...(entry.model ? { model: entry.model } : {}),
          },
        });
      }

      return saved;
    });
  }

  async updateRoster(
    runId: string,
    agentId: string,
    patch: RosterUpdateInput,
  ): Promise<SwarmRunState> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      const record = state.roster[agentId];
      if (!record) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Roster agent "${agentId}" not found in run "${runId}".`,
          { runId, agentId },
        );
      }

      if (
        patch.status !== undefined &&
        !VALID_ROSTER_STATUSES.has(patch.status)
      ) {
        throw new SwarmProtocolError(
          "INVALID_TRANSITION",
          `Invalid roster status "${String(patch.status)}" for agent "${agentId}".`,
          { runId, agentId, status: patch.status },
        );
      }

      const previousStatus = record.status;
      if (patch.status !== undefined) record.status = patch.status;
      if (patch.model !== undefined) record.model = patch.model;
      if (patch.thinkingLevel === null) {
        delete record.thinkingLevel;
      } else if (patch.thinkingLevel !== undefined) {
        record.thinkingLevel = patch.thinkingLevel;
      }
      if (
        patch.lastReadBoardSeq !== undefined &&
        Number.isFinite(patch.lastReadBoardSeq)
      ) {
        record.lastReadBoardSeq = Math.max(
          0,
          Math.floor(patch.lastReadBoardSeq),
        );
      }
      if (
        patch.lastPostBoardSeq !== undefined &&
        Number.isFinite(patch.lastPostBoardSeq)
      ) {
        record.lastPostBoardSeq = Math.max(
          0,
          Math.floor(patch.lastPostBoardSeq),
        );
      }
      if (patch.turns !== undefined && Number.isFinite(patch.turns)) {
        record.turns = Math.max(0, Math.floor(patch.turns));
      }
      if (patch.endedAt === null) {
        delete record.endedAt;
      } else if (patch.endedAt !== undefined) {
        record.endedAt = patch.endedAt;
      }
      if (patch.humanStopped !== undefined) {
        record.humanStopped = patch.humanStopped;
      }
      if (patch.currentActivity === null) {
        delete record.currentActivity;
      } else if (patch.currentActivity !== undefined) {
        record.currentActivity = patch.currentActivity;
      }
      if (patch.lastTool !== undefined) {
        record.lastTool = patch.lastTool;
      }
      if (patch.tokens !== undefined) {
        record.tokens = patch.tokens;
      }
      if (patch.tokenBreakdown !== undefined) {
        record.tokenBreakdown = { ...patch.tokenBreakdown };
      }
      if (patch.cost !== undefined) {
        record.cost = patch.cost;
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

      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      const saved = await this.persistStateUnlocked(state);

      // Auto-emit terminal/stop lifecycle events ONLY on state transition.
      // Warm "waiting" and resumed "working" transitions do NOT emit worker_exited.
      if (patch.status && patch.status !== previousStatus) {
        if (patch.status === "killed") {
          await appendLedgerEvent(this.getEventsPath(runId), {
            runId,
            type: "agent_killed",
            actor: record.humanStopped ? "human" : ORCHESTRATOR_BOARD_NAME,
            missionId: record.missionId,
            agentId,
            summary: `${record.role} "${record.name}" killed${record.error ? `: ${record.error}` : ""}.`,
            data: {
              role: record.role,
              agentName: record.name,
              previousStatus,
            },
          });
        } else if (patch.status === "stopped") {
          await appendLedgerEvent(this.getEventsPath(runId), {
            runId,
            type: "worker_stopped",
            actor: record.humanStopped ? "human" : ORCHESTRATOR_BOARD_NAME,
            missionId: record.missionId,
            agentId,
            summary: `${record.role} "${record.name}" stopped${record.humanStopped ? " by human" : ""}.`,
          });
        } else if (patch.status === "failed" || patch.status === "died") {
          await appendLedgerEvent(this.getEventsPath(runId), {
            runId,
            type: "worker_exited",
            actor: agentId,
            missionId: record.missionId,
            agentId,
            summary: `${record.role} "${record.name}" exited with status "${patch.status}"${record.error ? `: ${record.error}` : ""}.`,
          });
        }
      }

      return saved;
    });
  }

  // --------------------------------------------------------------------------
  // Shared Message Board (board.jsonl)
  // --------------------------------------------------------------------------

  async postBoardMessage(
    runId: string,
    input: PostBoardMessageInput,
  ): Promise<BoardMessage> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      const message = await this.board.post(runId, input);

      const senderEntry = findRosterSender(state.roster, message.from);
      if (senderEntry) {
        senderEntry.lastPostBoardSeq = message.seq;
        state.revision += 1;
        state.updatedAt = new Date().toISOString();
        await this.persistStateUnlocked(state);
      }

      const snippet = message.text.replace(/\s+/g, " ").trim().slice(0, 140);
      const mentionSuffix =
        message.mentions.length > 0
          ? ` -> ${message.mentions.map((m) => `@${m}`).join(", ")}`
          : "";
      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "board_posted",
        actor: message.from,
        ...(message.missionId !== undefined
          ? { missionId: message.missionId }
          : {}),
        ...(senderEntry ? { agentId: senderEntry.agentId } : {}),
        summary: `#${message.seq} [${message.from}${mentionSuffix}] ${snippet}`.trim(),
        data: {
          seq: message.seq,
          from: message.from,
          fromRole: message.fromRole,
          mentions: message.mentions,
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
  // Inbox Queues, Findings & Event Ledger
  // --------------------------------------------------------------------------

  async sendMessage(
    runId: string,
    message: SendMessageInput,
  ): Promise<InboxMessage> {
    return this.withRunLock(runId, async () => {
      // Ensure run exists.
      await this.readStateUnlocked(runId);

      const inboxPath = this.getInboxPath(runId, message.to);
      await assertNoSymlinksWithin(this.projectRoot, inboxPath);
      await mkdir(path.dirname(inboxPath), { recursive: true });

      const entry: InboxMessage = {
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        from: message.from,
        to: message.to,
        ...(message.missionId !== undefined
          ? { missionId: message.missionId }
          : {}),
        text: message.text,
        createdAt: new Date().toISOString(),
      };

      const existing = await this.readInboxFileUnlocked(inboxPath);
      existing.push(entry);
      const serialized = existing.map((m) => JSON.stringify(m)).join("\n") + "\n";
      await writeFileAtomic(this.projectRoot, inboxPath, serialized);
      return entry;
    });
  }

  async readInbox(
    runId: string,
    recipient: string,
    options?: ReadInboxOptions,
  ): Promise<InboxMessage[]> {
    return this.withRunLock(runId, async () => {
      await this.readStateUnlocked(runId);
      const inboxPath = this.getInboxPath(runId, recipient);
      const all = await this.readInboxFileUnlocked(inboxPath);

      let selected = options?.unreadOnly
        ? all.filter((m) => !m.readAt)
        : [...all];
      if (options?.limit !== undefined) {
        if (options.limit <= 0) {
          selected = [];
        } else if (selected.length > options.limit) {
          selected = options.unreadOnly
            ? selected.slice(0, options.limit)
            : selected.slice(selected.length - options.limit);
        }
      }

      if (options?.markRead && selected.length > 0) {
        const now = new Date().toISOString();
        const selectedIds = new Set(selected.map((m) => m.id));
        let mutated = false;
        for (const msg of all) {
          if (selectedIds.has(msg.id) && !msg.readAt) {
            msg.readAt = now;
            mutated = true;
          }
        }
        if (mutated) {
          const serialized = all.map((m) => JSON.stringify(m)).join("\n") + "\n";
          await writeFileAtomic(this.projectRoot, inboxPath, serialized);
        }
      }

      return selected.map((m) => ({ ...m }));
    });
  }

  private async readInboxFileUnlocked(
    inboxPath: string,
  ): Promise<InboxMessage[]> {
    await assertNoSymlinksWithin(this.projectRoot, inboxPath);
    let raw: string;
    try {
      raw = await readFile(inboxPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const messages: InboxMessage[] = [];
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as InboxMessage;
        if (
          parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.text === "string"
        ) {
          messages.push(parsed);
        }
      } catch {
        // Ignore malformed trailing line.
      }
    }
    return messages;
  }

  async recordFinding(
    runId: string,
    finding: RecordFindingInput,
  ): Promise<SwarmFindingRecord> {
    return this.withRunLock(runId, async () => {
      const state = await this.readStateUnlocked(runId);
      if (!state.missions[finding.missionId]) {
        throw new SwarmProtocolError(
          "NOT_FOUND",
          `Cannot record finding for unknown mission "${finding.missionId}".`,
          { runId, missionId: finding.missionId },
        );
      }

      const now = new Date().toISOString();
      const record: SwarmFindingRecord = {
        id: `fnd_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        missionId: finding.missionId,
        author: finding.author,
        title: finding.title.trim(),
        summary: finding.summary.trim(),
        details: finding.details,
        ...(finding.files && finding.files.length > 0
          ? { files: [...finding.files] }
          : {}),
        createdAt: now,
      };

      const findingPath = this.getFindingPath(runId, record.id);
      await writeFileAtomic(
        this.projectRoot,
        findingPath,
        `${JSON.stringify(record, null, 2)}\n`,
      );

      state.findings.push(record);
      state.revision += 1;
      state.updatedAt = now;
      await this.persistStateUnlocked(state);

      await appendLedgerEvent(this.getEventsPath(runId), {
        runId,
        type: "finding_recorded",
        actor: finding.author,
        missionId: finding.missionId,
        summary: `Finding "${record.title}": ${record.summary}`,
        data: { findingId: record.id, files: record.files },
      });

      return record;
    });
  }

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
  // MISSIONS.md Auto-Generation
  // --------------------------------------------------------------------------

  renderMissionsMarkdown(state: SwarmRunState): string {
    const validatorEnabled =
      typeof state.validatorEnabled === "boolean"
        ? state.validatorEnabled
        : DEFAULT_SWARM_SETTINGS.validatorEnabled;
    const maxValidationRounds =
      state.maxValidationRounds ?? DEFAULT_SWARM_SETTINGS.maxValidationRounds;
    const keepWorkersWarm =
      typeof state.keepWorkersWarm === "boolean"
        ? state.keepWorkersWarm
        : DEFAULT_SWARM_SETTINGS.keepWorkersWarm;

    const lines: string[] = [
      `# Swarm Missions — ${state.id}`,
      "",
      `- **Objective:** ${escapeMarkdownCell(state.objective)}`,
      `- **Base Branch:** \`${state.baseBranch}\``,
      `- **Status:** \`${state.status}\``,
      `- **Models:** ${formatRoleModelsSummary(state.roleModels)}`,
      `- **Validator Enabled:** ${validatorEnabled ? "yes" : "no"} (max rounds: ${maxValidationRounds})`,
      `- **Warm Workers:** ${keepWorkersWarm ? "yes" : "no"}`,
      `- **Max Concurrency:** ${state.maxConcurrency}`,
      `- **Revision:** ${state.revision}`,
      `- **Updated At:** ${state.updatedAt}`,
      "",
      "| ID | Title | Kind | Deps | Branch | Scope | Status | Review | Retries |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];

    const orderedIds =
      state.missionOrder.length > 0
        ? state.missionOrder
        : Object.keys(state.missions);

    for (const id of orderedIds) {
      const m = state.missions[id];
      if (!m) continue;
      const depsCell = m.deps.length > 0 ? m.deps.join(", ") : "-";
      const scopeCell =
        m.scope.length > 0 ? m.scope.map((s) => `\`${s}\``).join(", ") : "-";
      const reviewCell = formatMissionReviewCell(m);

      lines.push(
        `| ${escapeMarkdownCell(m.id)} | ${escapeMarkdownCell(m.title)} | ${m.kind} | ${escapeMarkdownCell(depsCell)} | \`${escapeMarkdownCell(m.branch)}\` | ${escapeMarkdownCell(scopeCell)} | ${m.status} | ${escapeMarkdownCell(reviewCell)} | ${m.retryCount} |`,
      );
    }

    lines.push("");
    lines.push("## Final Verification");
    lines.push("");
    const finalValidatorEnabled =
      typeof state.finalValidatorEnabled === "boolean"
        ? state.finalValidatorEnabled
        : DEFAULT_SWARM_SETTINGS.finalValidatorEnabled;
    const autoFixOnAuditFail =
      typeof state.autoFixOnAuditFail === "boolean"
        ? state.autoFixOnAuditFail
        : DEFAULT_SWARM_SETTINGS.autoFixOnAuditFail;
    const finalAuditStatus = state.finalAuditStatus ?? "idle";
    const finalAuditRound = state.finalAuditRound ?? 0;
    const maxFinalAuditRounds =
      state.maxFinalAuditRounds ?? DEFAULT_SWARM_SETTINGS.maxFinalAuditRounds;

    lines.push(
      `- **Enabled:** ${finalValidatorEnabled ? "yes" : "no"} (auto-fix: ${autoFixOnAuditFail ? "yes" : "no"})`,
    );
    lines.push(`- **Status:** \`${finalAuditStatus}\``);
    lines.push(`- **Rounds:** ${finalAuditRound}/${maxFinalAuditRounds}`);
    if (state.lastAuditedSha) {
      lines.push(
        `- **Last Audited SHA:** \`${state.lastAuditedSha.slice(0, 7)}\``,
      );
    }
    if (finalAuditStatus === "skipped") {
      const skippedBy = state.finalAuditSkippedBy ?? "human";
      const skippedAt = state.finalAuditSkippedAt
        ? ` at ${state.finalAuditSkippedAt}`
        : "";
      const reason = state.finalAuditSkipReason
        ? ` — ${escapeMarkdownCell(state.finalAuditSkipReason)}`
        : "";
      lines.push(
        `- **Skipped:** by ${escapeMarkdownCell(skippedBy)}${skippedAt}${reason}`,
      );
    } else if (state.latestFinalAudit) {
      const audit = state.latestFinalAudit;
      const checksPassed = audit.checks.filter((c) => c.passed).length;
      const checksTotal = audit.checks.length;
      const findingsCount = audit.findings.length;
      lines.push(
        `- **Latest Verdict:** \`${audit.verdict}\` (round ${audit.round} @\`${audit.commitSha.slice(0, 7)}\`, checks: ${checksPassed}/${checksTotal}, findings: ${findingsCount})`,
      );
      lines.push(`- **Summary:** ${escapeMarkdownCell(audit.summary)}`);
    }
    lines.push("");
    return lines.join("\n");
  }
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

function formatMissionReviewCell(mission: MissionRecord): string {
  if (mission.latestReview) {
    const sha = mission.latestReview.commitSha.slice(0, 7);
    return `${mission.latestReview.status} (${mission.latestReview.merge}) @${sha}`;
  }
  if (mission.kind === "artifact") {
    if (mission.humanApprovedSha) {
      return `approved @${mission.humanApprovedSha.slice(0, 7)}`;
    }
    return "awaiting-approval";
  }
  if (mission.kind === "survey") {
    return "n/a";
  }
  return "-";
}

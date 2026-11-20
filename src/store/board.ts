import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SWARM_BOARD_FILE,
  SWARM_DIR,
  SWARM_RUNS_DIR,
} from "../constants.js";
import {
  SwarmProtocolError,
  type BoardMessage,
  type BoardMessageKind,
  type CallerRole,
  type ISwarmBoard,
  type PostBoardMessageInput,
  type ReadBoardOptions,
  type ReadBoardResult,
} from "../types.js";

const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_SINCE_LIMIT = 50;

/**
 * Matches `@<handle>` preceded by start-of-string or non-email-local-part punctuation/whitespace,
 * ignoring email addresses like `foo@bar.com` and trailing sentence punctuation like `@M1.`.
 */
const MENTION_RE =
  /(?<![A-Za-z0-9._%+-@])@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;

const VALID_BOARD_KINDS: ReadonlySet<BoardMessageKind> =
  new Set<BoardMessageKind>([
    "brief",
    "done",
    "review",
    "fix",
    "handoff",
    "decision",
    "model_switch",
    "stall",
    "chat",
  ]);

const VALID_CALLER_ROLES: ReadonlySet<CallerRole> = new Set<CallerRole>([
  "orchestrator",
  "worker",
  "validator",
  "human",
]);

/** In-process per-file write queues to guarantee ordered, monotonic JSONL appends. */
const boardAppendQueues = new Map<string, Promise<unknown>>();

function enqueueBoardWrite<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath);
  const previous = boardAppendQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const cleanup = next.then(
    () => {
      if (boardAppendQueues.get(key) === cleanup) {
        boardAppendQueues.delete(key);
      }
    },
    () => {
      if (boardAppendQueues.get(key) === cleanup) {
        boardAppendQueues.delete(key);
      }
    },
  );
  boardAppendQueues.set(key, cleanup);
  return next;
}

function validateSafeRunId(runId: string): string {
  const trimmed = typeof runId === "string" ? runId.trim() : "";
  if (
    trimmed.length === 0 ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    !SAFE_RUN_ID_RE.test(trimmed)
  ) {
    throw new SwarmProtocolError(
      "SCOPE_VIOLATION",
      `Invalid runId: ${JSON.stringify(runId)}`,
      { label: "runId", value: runId },
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
      `Board path escapes project boundary: ${targetPath}`,
      { rootDir: resolvedRoot, targetPath: resolvedTarget },
    );
  }
  return resolvedTarget;
}

/**
 * Verify that no existing path component STRICTLY INSIDE `rootDir` is a symlink.
 * (Ancestors of `rootDir` such as macOS `/var -> /private/var` are ignored.)
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
          `Refusing to traverse symlinked board path: ${current}`,
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

function parseBoardLines(raw: string): BoardMessage[] {
  const messages: BoardMessage[] = [];
  // Split strictly on LF (\n) to prevent U+2028/U+2029 corruption.
  const lines = raw.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Partial<BoardMessage>;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.seq === "number" &&
        Number.isFinite(parsed.seq) &&
        parsed.seq > 0 &&
        typeof parsed.runId === "string" &&
        typeof parsed.from === "string" &&
        typeof parsed.text === "string" &&
        Array.isArray(parsed.mentions) &&
        typeof parsed.timestamp === "string"
      ) {
        const kind: BoardMessageKind =
          typeof parsed.kind === "string" &&
          VALID_BOARD_KINDS.has(parsed.kind as BoardMessageKind)
            ? (parsed.kind as BoardMessageKind)
            : "chat";
        const fromRole: CallerRole =
          typeof parsed.fromRole === "string" &&
          VALID_CALLER_ROLES.has(parsed.fromRole as CallerRole)
            ? (parsed.fromRole as CallerRole)
            : "orchestrator";
        messages.push({
          seq: Math.floor(parsed.seq),
          runId: parsed.runId,
          from: parsed.from,
          fromRole,
          text: parsed.text,
          mentions: parsed.mentions.filter(
            (m): m is string => typeof m === "string" && m.trim().length > 0,
          ),
          kind,
          ...(typeof parsed.missionId === "string"
            ? { missionId: parsed.missionId }
            : {}),
          timestamp: parsed.timestamp,
        });
      }
    } catch {
      // Ignore malformed/truncated trailing line rather than crashing readers.
    }
  }
  return messages;
}

function computeHead(messages: readonly BoardMessage[]): number {
  let max = 0;
  for (const msg of messages) {
    if (msg.seq > max) {
      max = msg.seq;
    }
  }
  return max;
}

function mergeMentions(
  text: string,
  explicit?: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const handle of parseMentions(text)) {
    const key = handle.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(handle);
    }
  }

  if (Array.isArray(explicit)) {
    for (const raw of explicit) {
      if (typeof raw !== "string") continue;
      const cleaned = raw.trim().replace(/^@+/, "");
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(cleaned);
      }
    }
  }

  return result;
}

// ============================================================================
// Pure Board Helpers
// ============================================================================

/**
 * Extract unique `@<name>` board handles from freeform text (preserving first-seen casing),
 * ignoring email addresses like `foo@bar.com` and trailing punctuation like `@M1.`.
 */
export function parseMentions(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const mentions: string[] = [];
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const handle = match[1];
    const key = handle.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push(handle);
    }
  }
  return mentions;
}

/**
 * Format a single shared-board message into a concise single-line readable string:
 * `#4 [validator-M1 -> @M1] [review] Fix null check`.
 */
export function formatBoardMessage(msg: BoardMessage): string {
  const route =
    msg.mentions.length > 0
      ? `${msg.from} -> ${msg.mentions
          .map((m) => (m.startsWith("@") ? m : `@${m}`))
          .join(", ")}`
      : msg.from;
  const body = msg.text.replace(/\s+/g, " ").trim();
  const kindBadge =
    msg.kind &&
    msg.kind !== "chat" &&
    !body.toLowerCase().startsWith(`[${msg.kind.toLowerCase()}]`)
      ? ` [${msg.kind}]`
      : "";
  return `#${msg.seq} [${route}]${kindBadge}${body ? ` ${body}` : ""}`;
}

/**
 * Format a sequence of board messages into a multi-line excerpt for prompts or `/swarm board`.
 */
export function formatBoardMessages(
  messages: readonly BoardMessage[],
): string {
  if (messages.length === 0) {
    return "(no board messages yet)";
  }
  return messages.map(formatBoardMessage).join("\n");
}

// ============================================================================
// SwarmBoard Implementation (Append-Only LF JSONL per Run)
// ============================================================================

export class SwarmBoard implements ISwarmBoard {
  readonly projectRoot: string;
  private readonly runsRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.runsRoot = path.join(this.projectRoot, SWARM_DIR, SWARM_RUNS_DIR);
  }

  getBoardPath(runId: string): string {
    const safeRunId = validateSafeRunId(runId);
    return assertWithinRoot(
      this.projectRoot,
      path.join(this.runsRoot, safeRunId, SWARM_BOARD_FILE),
    );
  }

  private async readAllMessages(runId: string): Promise<BoardMessage[]> {
    const boardPath = this.getBoardPath(runId);
    await assertNoSymlinksWithin(this.projectRoot, boardPath);
    try {
      const raw = await readFile(boardPath, "utf8");
      return parseBoardLines(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async post(
    runId: string,
    input: PostBoardMessageInput,
  ): Promise<BoardMessage> {
    const safeRunId = validateSafeRunId(runId);
    const from = typeof input.from === "string" ? input.from.trim() : "";
    if (!from) {
      throw new SwarmProtocolError(
        "INVALID_TRANSITION",
        "Board message sender (from) must not be empty.",
        { runId: safeRunId },
      );
    }

    const boardPath = this.getBoardPath(safeRunId);
    return enqueueBoardWrite(boardPath, async () => {
      await assertNoSymlinksWithin(this.projectRoot, boardPath);
      await mkdir(path.dirname(boardPath), { recursive: true });
      await assertNoSymlinksWithin(this.projectRoot, boardPath);

      let head = 0;
      try {
        const existing = await readFile(boardPath, "utf8");
        head = computeHead(parseBoardLines(existing));
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
      }

      const text = typeof input.text === "string" ? input.text.trim() : "";
      const kind: BoardMessageKind =
        input.kind && VALID_BOARD_KINDS.has(input.kind) ? input.kind : "chat";
      const fromRole: CallerRole = VALID_CALLER_ROLES.has(input.fromRole)
        ? input.fromRole
        : "orchestrator";
      const mentions = mergeMentions(text, input.mentions);

      const message: BoardMessage = {
        seq: head + 1,
        runId: safeRunId,
        from,
        fromRole,
        text,
        mentions,
        kind,
        ...(input.missionId !== undefined
          ? { missionId: input.missionId }
          : {}),
        timestamp: new Date().toISOString(),
      };

      const line = `${JSON.stringify(message)}\n`;
      await appendFile(boardPath, line, { encoding: "utf8", flag: "a" });
      return message;
    });
  }

  async read(
    runId: string,
    options?: ReadBoardOptions,
  ): Promise<ReadBoardResult> {
    const all = await this.readAllMessages(runId);
    const head = computeHead(all);

    if (options?.seqs !== undefined) {
      const seqSet = new Set<number>();
      for (const s of options.seqs) {
        if (typeof s === "number" && Number.isFinite(s) && s > 0) {
          seqSet.add(Math.floor(s));
        }
      }
      const messages = all
        .filter((m) => seqSet.has(m.seq))
        .sort((a, b) => a.seq - b.seq);
      return { messages, head };
    }

    if (options?.since !== undefined) {
      const since = Number.isFinite(options.since)
        ? Math.floor(options.since)
        : 0;
      const limit =
        options.limit !== undefined
          ? Math.floor(options.limit)
          : DEFAULT_SINCE_LIMIT;
      if (limit <= 0) {
        return { messages: [], head };
      }
      const filtered = all.filter((m) => m.seq > since);
      return {
        messages:
          filtered.length > limit ? filtered.slice(0, limit) : filtered,
        head,
      };
    }

    const limit =
      options?.limit !== undefined
        ? Math.floor(options.limit)
        : DEFAULT_RECENT_LIMIT;
    if (limit <= 0) {
      return { messages: [], head };
    }
    const messages =
      all.length > limit ? all.slice(all.length - limit) : all;
    return { messages, head };
  }

  async getHead(runId: string): Promise<number> {
    const all = await this.readAllMessages(runId);
    return computeHead(all);
  }
}

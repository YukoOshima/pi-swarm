import { appendFile, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ALL_MENTION_NAME,
  CHANNEL_NAME_PATTERN,
  DEFAULT_CHANNEL,
  ORCHESTRATOR_NAME,
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
import { isPrototypeKey } from "./swarm-store.js";

const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_SINCE_LIMIT = 50;

/**
 * Matches `@<handle>` preceded by start-of-string or non-email-local-part punctuation/whitespace.
 * Ignores emails like `foo@bar.com`, double-at `@@foo`, channel mentions like `@#backend`,
 * and trailing sentence punctuation like `@parser.`.
 */
const MENTION_RE =
  /(?<![A-Za-z0-9._%+\-@])@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;

/**
 * Matches `@#<channel>` channel mentions (1–32 chars starting with an ASCII letter).
 * Ignores embedded email-like patterns (`foo@#bar`) and trailing punctuation (`@#backend.`).
 */
const CHANNEL_MENTION_RE =
  /(?<![A-Za-z0-9._%+\-@])@#([A-Za-z](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?)/g;

const VALID_BOARD_KINDS: ReadonlySet<BoardMessageKind> =
  new Set<BoardMessageKind>([
    "brief",
    "done",
    "update",
    "review",
    "decision",
    "model_switch",
    "stall",
    "chat",
  ]);

const VALID_CALLER_ROLES: ReadonlySet<CallerRole> = new Set<CallerRole>([
  "orchestrator",
  "worker",
  "validator",
  "monitor",
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
      "INVALID_INPUT",
      `Invalid runId: ${JSON.stringify(runId)}`,
      { label: "runId", value: runId },
    );
  }
  return trimmed;
}

function normalizeChannel(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_CHANNEL;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return DEFAULT_CHANNEL;
  }
  if (!CHANNEL_NAME_PATTERN.test(normalized) || isPrototypeKey(normalized)) {
    throw new SwarmProtocolError(
      "INVALID_CHANNEL",
      `Invalid channel name: ${JSON.stringify(raw)}`,
      { channel: raw },
    );
  }
  return normalized;
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
          "PERMISSION_DENIED",
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
        const channel =
          typeof parsed.channel === "string" && parsed.channel.trim().length > 0
            ? parsed.channel.trim().toLowerCase()
            : DEFAULT_CHANNEL;
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
        const channelMentions = Array.isArray(parsed.channelMentions)
          ? parsed.channelMentions
              .filter(
                (c): c is string => typeof c === "string" && c.trim().length > 0,
              )
              .map((c) => c.trim().toLowerCase())
          : [];
        messages.push({
          seq: Math.floor(parsed.seq),
          runId: parsed.runId,
          channel,
          from: parsed.from,
          fromRole,
          text: parsed.text,
          mentions: parsed.mentions.filter(
            (m): m is string => typeof m === "string" && m.trim().length > 0,
          ),
          channelMentions,
          kind,
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

const ALWAYS_ALLOWED_MENTIONS: ReadonlySet<string> = new Set<string>([
  ALL_MENTION_NAME,
  ORCHESTRATOR_NAME,
]);

function mergeMentions(
  text: string,
  explicit?: readonly string[],
  knownMembers?: Iterable<string>,
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
      if (!cleaned || cleaned.startsWith("#")) continue;
      const key = cleaned.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(cleaned);
      }
    }
  }

  return knownMembers === undefined
    ? result
    : filterMentions(result, knownMembers);
}

function mergeChannelMentions(
  text: string,
  explicit?: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const ch of parseChannelMentions(text)) {
    if (!seen.has(ch)) {
      seen.add(ch);
      result.push(ch);
    }
  }

  if (Array.isArray(explicit)) {
    for (const raw of explicit) {
      if (typeof raw !== "string") continue;
      const cleaned = raw.trim().replace(/^@?#?/, "").toLowerCase();
      if (!cleaned || !CHANNEL_NAME_PATTERN.test(cleaned)) continue;
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
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
 * Filter a list of `@mention` handles against a known roster (`knownMembers`),
 * always preserving `"all"` and `"orchestrator"` (case-insensitive) while
 * dropping arbitrary prose tokens like `@mention`, `@param`, or `@type`.
 *
 * When `knownMembers` is omitted (`undefined`), returns mentions deduplicated
 * case-insensitively without filtering for full backward compatibility.
 */
export function filterMentions(
  mentions: readonly string[],
  knownMembers?: Iterable<string>,
): string[] {
  let allowed: Set<string> | undefined;
  if (knownMembers !== undefined) {
    allowed = new Set<string>(ALWAYS_ALLOWED_MENTIONS);
    for (const raw of knownMembers) {
      if (typeof raw !== "string") continue;
      const cleaned = raw.trim().replace(/^@+/, "").toLowerCase();
      if (cleaned.length > 0 && !cleaned.startsWith("#")) {
        allowed.add(cleaned);
      }
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of mentions) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.trim().replace(/^@+/, "");
    if (!cleaned || cleaned.startsWith("#")) continue;
    const key = cleaned.toLowerCase();
    if (allowed !== undefined && !allowed.has(key)) {
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cleaned);
    }
  }
  return result;
}

/**
 * Extract unique `@<name>` board handles from freeform text (preserving first-seen casing),
 * ignoring email addresses like `foo@bar.com`, channel mentions like `@#backend`,
 * and trailing punctuation like `@M1.`.
 *
 * When `knownMembers` is supplied, filters extracted handles to `"all"`, `"orchestrator"`,
 * and members present in `knownMembers` (case-insensitive).
 */
export function parseMentions(
  text: string,
  knownMembers?: Iterable<string>,
): string[] {
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
  return knownMembers === undefined
    ? mentions
    : filterMentions(mentions, knownMembers);
}

/**
 * Extract unique `@#<channel>` channel mentions from freeform text (normalized lowercase,
 * without the `@#` prefix). Preserves `"main"` if written as `@#main` so store/engine
 * layers can explicitly reject or handle it.
 */
export function parseChannelMentions(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const channels: string[] = [];
  CHANNEL_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHANNEL_MENTION_RE.exec(text)) !== null) {
    const channel = match[1].toLowerCase();
    if (!seen.has(channel)) {
      seen.add(channel);
      channels.push(channel);
    }
  }
  return channels;
}

/**
 * Format a single shared-board message into a concise single-line readable string:
 * `#4 [backend] verifier -> @parser: [review] Fix null check`.
 */
export function formatBoardMessage(msg: BoardMessage): string {
  const channel = msg.channel?.trim() || DEFAULT_CHANNEL;
  const targets: string[] = [
    ...msg.mentions.map((m) => (m.startsWith("@") ? m : `@${m}`)),
    ...(msg.channelMentions ?? []).map((c) =>
      c.startsWith("@#") ? c : `@#${c.replace(/^#/, "")}`,
    ),
  ];
  const route =
    targets.length > 0 ? `${msg.from} -> ${targets.join(", ")}` : msg.from;
  const body = msg.text.replace(/\s+/g, " ").trim();
  const kindPrefix =
    msg.kind &&
    msg.kind !== "chat" &&
    !body.toLowerCase().startsWith(`[${msg.kind.toLowerCase()}]`)
      ? `[${msg.kind}]`
      : "";
  const content = [kindPrefix, body].filter(Boolean).join(" ");
  return `#${msg.seq} [${channel}] ${route}:${content ? ` ${content}` : ""}`;
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

interface BoardCacheEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  head: number;
  endsWithNewline: boolean;
  messages: BoardMessage[];
}

export class SwarmBoard implements ISwarmBoard {
  readonly projectRoot: string;
  private readonly runsRoot: string;
  private readonly boardCache = new Map<string, BoardCacheEntry>();

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

  private async loadCachedByPath(boardPath: string): Promise<{
    messages: BoardMessage[];
    head: number;
    endsWithNewline: boolean;
    size: number;
  }> {
    await assertNoSymlinksWithin(this.projectRoot, boardPath);
    try {
      const st = await lstat(boardPath);
      const existing = this.boardCache.get(boardPath);
      if (
        existing &&
        existing.mtimeMs === st.mtimeMs &&
        existing.size === st.size &&
        existing.ino === st.ino
      ) {
        this.setBoardCacheEntry(boardPath, existing);
        return {
          messages: existing.messages,
          head: existing.head,
          endsWithNewline: existing.endsWithNewline,
          size: existing.size,
        };
      }

      if (
        existing &&
        st.ino === existing.ino &&
        st.size > existing.size &&
        existing.endsWithNewline
      ) {
        const delta = st.size - existing.size;
        const handle = await open(boardPath, "r");
        let tailText = "";
        let bytesRead = 0;
        try {
          const buf = Buffer.allocUnsafe(delta);
          while (bytesRead < delta) {
            const res = await handle.read(
              buf,
              bytesRead,
              delta - bytesRead,
              existing.size + bytesRead,
            );
            if (res.bytesRead === 0) {
              break;
            }
            bytesRead += res.bytesRead;
          }
          tailText = buf.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close().catch(() => {});
        }

        if (bytesRead === delta) {
          const appended = parseBoardLines(tailText);
          const nextMessages =
            appended.length > 0
              ? [...existing.messages, ...appended]
              : existing.messages;
          const head = Math.max(existing.head, computeHead(appended));
          const endsWithNewline =
            tailText.length === 0
              ? existing.endsWithNewline
              : tailText.endsWith("\n");
          this.setBoardCacheEntry(boardPath, {
            mtimeMs: st.mtimeMs,
            size: st.size,
            ino: st.ino,
            head,
            endsWithNewline,
            messages: nextMessages,
          });
          return {
            messages: nextMessages,
            head,
            endsWithNewline,
            size: st.size,
          };
        }
      }

      const raw = await readFile(boardPath, "utf8");
      const endsWithNewline = raw.length === 0 || raw.endsWith("\n");
      const messages = parseBoardLines(raw);
      const head = computeHead(messages);
      this.setBoardCacheEntry(boardPath, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        ino: st.ino,
        head,
        endsWithNewline,
        messages,
      });
      return { messages, head, endsWithNewline, size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.boardCache.delete(boardPath);
        return { messages: [], head: 0, endsWithNewline: true, size: 0 };
      }
      throw err;
    }
  }

  private async readAllMessages(runId: string): Promise<BoardMessage[]> {
    const boardPath = this.getBoardPath(runId);
    const { messages } = await this.loadCachedByPath(boardPath);
    return [...messages];
  }

  async post(
    runId: string,
    input: PostBoardMessageInput,
  ): Promise<BoardMessage> {
    const safeRunId = validateSafeRunId(runId);
    const from = typeof input.from === "string" ? input.from.trim() : "";
    if (!from) {
      throw new SwarmProtocolError(
        "INVALID_INPUT",
        "Board message sender (from) must not be empty.",
        { runId: safeRunId },
      );
    }
    const channel = normalizeChannel(input.channel);

    const boardPath = this.getBoardPath(safeRunId);
    return enqueueBoardWrite(boardPath, async () => {
      await assertNoSymlinksWithin(this.projectRoot, boardPath);
      await mkdir(path.dirname(boardPath), { recursive: true });
      await assertNoSymlinksWithin(this.projectRoot, boardPath);

      const {
        messages: existingMessages,
        head,
        endsWithNewline,
        size: prevSize,
      } = await this.loadCachedByPath(boardPath);

      const text = typeof input.text === "string" ? input.text.trim() : "";
      const kind: BoardMessageKind =
        input.kind && VALID_BOARD_KINDS.has(input.kind) ? input.kind : "chat";
      const fromRole: CallerRole = VALID_CALLER_ROLES.has(input.fromRole)
        ? input.fromRole
        : "orchestrator";
      const mentions = mergeMentions(text, input.mentions, input.knownMembers);
      const channelMentions = mergeChannelMentions(text, input.channelMentions);

      const minSeq =
        typeof input.minSeq === "number" && Number.isFinite(input.minSeq)
          ? Math.floor(input.minSeq)
          : 1;
      const seq = Math.max(head + 1, minSeq);

      const message: BoardMessage = {
        seq,
        runId: safeRunId,
        channel,
        from,
        fromRole,
        text,
        mentions,
        channelMentions,
        kind,
        timestamp: new Date().toISOString(),
      };

      const fullPayload = `${endsWithNewline ? "" : "\n"}${JSON.stringify(message)}\n`;
      await appendFile(boardPath, fullPayload, { encoding: "utf8", flag: "a" });
      try {
        const stAfter = await lstat(boardPath);
        const expectedSize = prevSize + Buffer.byteLength(fullPayload, "utf8");
        if (stAfter.size === expectedSize) {
          const nextMessages = [...existingMessages, message];
          this.setBoardCacheEntry(boardPath, {
            mtimeMs: stAfter.mtimeMs,
            size: stAfter.size,
            ino: stAfter.ino,
            head: message.seq,
            endsWithNewline: true,
            messages: nextMessages,
          });
        } else {
          this.boardCache.delete(boardPath);
        }
      } catch {
        this.boardCache.delete(boardPath);
      }
      return message;
    });
  }

  private setBoardCacheEntry(
    boardPath: string,
    entry: BoardCacheEntry,
  ): void {
    if (this.boardCache.has(boardPath)) {
      this.boardCache.delete(boardPath);
    } else if (this.boardCache.size >= 32) {
      const oldest = this.boardCache.keys().next().value;
      if (oldest !== undefined) {
        this.boardCache.delete(oldest);
      }
    }
    this.boardCache.set(boardPath, entry);
  }

  async read(
    runId: string,
    options?: ReadBoardOptions,
  ): Promise<ReadBoardResult> {
    const boardPath = this.getBoardPath(runId);
    const { messages: cachedMessages, head } = await this.loadCachedByPath(boardPath);
    const all = [...cachedMessages];

    let scoped = all;

    // 1. Channel filtering
    const rawExplicitChannel =
      typeof options?.channel === "string"
        ? options.channel.trim().toLowerCase()
        : "";
    const explicitChannel =
      rawExplicitChannel === "*"
        ? "*"
        : rawExplicitChannel.replace(/^@?#?/, "");
    if (explicitChannel.length > 0) {
      if (explicitChannel !== "*") {
        scoped = scoped.filter((m) => m.channel === explicitChannel);
      }
    } else if (options?.memberChannels !== undefined) {
      const allowed = new Set<string>([DEFAULT_CHANNEL]);
      for (const ch of options.memberChannels) {
        if (typeof ch === "string" && ch.trim().length > 0) {
          allowed.add(ch.trim().toLowerCase().replace(/^@?#?/, ""));
        }
      }
      scoped = scoped.filter(
        (m) => m.channel === DEFAULT_CHANNEL || allowed.has(m.channel),
      );
    }

    // 2. Case-insensitive substring search across text, from, channel, mentions, channelMentions
    const searchNeedle =
      typeof options?.search === "string"
        ? options.search.trim().toLowerCase()
        : "";
    if (searchNeedle.length > 0) {
      scoped = scoped.filter(
        (m) =>
          m.text.toLowerCase().includes(searchNeedle) ||
          m.from.toLowerCase().includes(searchNeedle) ||
          m.channel.toLowerCase().includes(searchNeedle) ||
          `#${m.channel.toLowerCase()}`.includes(searchNeedle) ||
          m.mentions.some((mention) => {
            const lower = mention.toLowerCase();
            return (
              lower.includes(searchNeedle) ||
              `@${lower}`.includes(searchNeedle)
            );
          }) ||
          m.channelMentions.some((ch) => {
            const lower = ch.toLowerCase();
            return (
              lower.includes(searchNeedle) ||
              `@#${lower}`.includes(searchNeedle)
            );
          }),
      );
    }

    // 3. Windowing (seqs / since / recent limit)
    if (options?.seqs !== undefined) {
      const seqSet = new Set<number>();
      for (const s of options.seqs) {
        if (typeof s === "number" && Number.isFinite(s) && s > 0) {
          seqSet.add(Math.floor(s));
        }
      }
      const messages = scoped
        .filter((m) => seqSet.has(m.seq))
        .sort((a, b) => a.seq - b.seq);
      return { messages, head };
    }

    if (options?.since !== undefined) {
      const since = Number.isFinite(options.since)
        ? Math.floor(options.since)
        : 0;
      const limit =
        typeof options.limit === "number" && Number.isFinite(options.limit)
          ? Math.floor(options.limit)
          : DEFAULT_SINCE_LIMIT;
      if (limit <= 0) {
        return { messages: [], head };
      }
      const after = scoped.filter((m) => m.seq > since);
      return {
        messages: after.length > limit ? after.slice(0, limit) : after,
        head,
      };
    }

    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? Math.floor(options.limit)
        : DEFAULT_RECENT_LIMIT;
    if (limit <= 0) {
      return { messages: [], head };
    }
    const messages =
      scoped.length > limit ? scoped.slice(scoped.length - limit) : scoped;
    return { messages, head };
  }

  async getHead(runId: string): Promise<number> {
    const boardPath = this.getBoardPath(runId);
    const { head } = await this.loadCachedByPath(boardPath);
    return head;
  }
}

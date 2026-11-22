import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SwarmProtocolError,
  type SwarmEvent,
  type SwarmEventInput,
} from "../types.js";

/** In-process per-file write queues to guarantee ordered, non-interleaved JSONL appends. */
const appendQueues = new Map<string, Promise<unknown>>();

function enqueuePathWrite<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const cleanup = next.then(
    () => {
      if (appendQueues.get(key) === cleanup) {
        appendQueues.delete(key);
      }
    },
    () => {
      if (appendQueues.get(key) === cleanup) {
        appendQueues.delete(key);
      }
    },
  );
  appendQueues.set(key, cleanup);
  return next;
}

async function assertPathNotSymlink(filePath: string): Promise<void> {
  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink()) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Refusing to access symlinked ledger path: ${filePath}`,
        { path: filePath },
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw err;
  }
}

function parseEventLines(raw: string): SwarmEvent[] {
  const events: SwarmEvent[] = [];
  // Split strictly on LF (\n) to avoid Unicode line-separator corruption (U+2028/U+2029).
  const lines = raw.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Partial<SwarmEvent>;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.id === "string" &&
        typeof parsed.runId === "string" &&
        typeof parsed.type === "string" &&
        typeof parsed.timestamp === "string" &&
        typeof parsed.summary === "string"
      ) {
        events.push(parsed as SwarmEvent);
      }
    } catch {
      // Ignore malformed/truncated trailing line rather than crashing readers.
    }
  }
  return events;
}

/**
 * Append a single event to an append-only JSONL ledger file.
 * Serializes concurrent in-process writes and rejects symlinked target files.
 */
export async function appendLedgerEvent(
  eventsPath: string,
  input: SwarmEventInput,
): Promise<SwarmEvent> {
  return enqueuePathWrite(eventsPath, async () => {
    await mkdir(path.dirname(eventsPath), { recursive: true });
    await assertPathNotSymlink(eventsPath);

    let nextSeq = 1;
    let needsLeadingNewline = false;
    try {
      const existing = await readFile(eventsPath, "utf8");
      needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
      const parsed = parseEventLines(existing);
      if (parsed.length > 0) {
        const last = parsed[parsed.length - 1];
        nextSeq = typeof last.seq === "number" ? last.seq + 1 : parsed.length + 1;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }

    const event: SwarmEvent = {
      id: input.id ?? `evt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      seq: nextSeq,
      runId: input.runId,
      type: input.type,
      timestamp: input.timestamp ?? new Date().toISOString(),
      summary: input.summary,
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      ...(input.memberName !== undefined ? { memberName: input.memberName } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    };

    const line = `${needsLeadingNewline ? "\n" : ""}${JSON.stringify(event)}\n`;
    await appendFile(eventsPath, line, { encoding: "utf8", flag: "a" });
    return event;
  });
}

/** Read all valid events from an append-only JSONL ledger file (oldest first). */
export async function readAllLedgerEvents(
  eventsPath: string,
): Promise<SwarmEvent[]> {
  await assertPathNotSymlink(eventsPath);
  try {
    const raw = await readFile(eventsPath, "utf8");
    return parseEventLines(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/** Read the most recent `limit` events from a JSONL ledger file (chronological order). */
export async function readRecentLedgerEvents(
  eventsPath: string,
  limit = 50,
): Promise<SwarmEvent[]> {
  if (limit <= 0) {
    return [];
  }
  const all = await readAllLedgerEvents(eventsPath);
  if (all.length <= limit) {
    return all;
  }
  return all.slice(all.length - limit);
}

function formatShortTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp.slice(0, 19);
  }
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}Z`;
}

function formatLine(
  time: string,
  eventType: string,
  meta: readonly string[],
  actorPart: string | undefined,
  summary: string,
): string {
  const parts = [time, eventType];
  if (meta.length > 0) {
    parts.push(`[${meta.join(" · ")}]`);
  }
  if (actorPart) {
    parts.push(actorPart);
  }
  if (summary) {
    parts.push(summary);
  }
  return parts.join(" ");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Format a single ledger event into a concise single-line human-readable activity string. */
export function formatLedgerEvent(event: SwarmEvent): string {
  const time = `[${formatShortTime(event.timestamp)}]`;
  const actor = event.actor ?? event.agentId;
  const actorPart = actor ? `(${actor})` : undefined;
  const summary = event.summary.replace(/\s+/g, " ").trim();
  const data = event.data;

  switch (event.type) {
    case "run_created": {
      const meta: string[] = [];
      const baseBranch = nonEmptyString(data?.baseBranch);
      if (baseBranch && !summary.includes(baseBranch)) {
        meta.push(baseBranch);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Created swarm run.",
      );
    }

    case "run_titled": {
      const title = nonEmptyString(data?.title);
      return formatLine(
        time,
        event.type,
        [],
        actorPart,
        summary || (title ? `Renamed swarm to "${title}".` : "Updated swarm title."),
      );
    }

    case "run_paused":
      return formatLine(
        time,
        event.type,
        [],
        actorPart,
        summary || "Paused swarm run.",
      );

    case "run_resumed":
      return formatLine(
        time,
        event.type,
        [],
        actorPart,
        summary || "Resumed swarm run.",
      );

    case "run_completed":
      return formatLine(
        time,
        event.type,
        [],
        actorPart,
        summary || "Completed swarm run.",
      );

    case "run_abandoned":
      return formatLine(
        time,
        event.type,
        [],
        actorPart,
        summary || "Abandoned swarm run.",
      );

    case "member_added": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      const role = nonEmptyString(data?.role);
      if (role && !summary.toLowerCase().includes(role.toLowerCase())) {
        meta.push(role);
      }
      const workspace = nonEmptyString(data?.workspace);
      if (workspace && !summary.includes(workspace)) {
        meta.push(workspace);
      }
      const model = nonEmptyString(data?.model);
      if (model && !summary.includes(model)) {
        meta.push(model);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Added swarm member.",
      );
    }

    case "member_woken": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      if (
        typeof data?.boardSeq === "number" &&
        !summary.includes(`#${data.boardSeq}`)
      ) {
        meta.push(`#${data.boardSeq}`);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Member woken.",
      );
    }

    case "member_waiting": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Member waiting on board.",
      );
    }

    case "member_stopped": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Member stopped.",
      );
    }

    case "member_killed": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Member killed.",
      );
    }

    case "member_model_switched": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      const nextModel = nonEmptyString(data?.model);
      const prevModel = nonEmptyString(data?.previousModel);
      if (nextModel && !summary.includes(nextModel)) {
        meta.push(prevModel ? `${prevModel} -> ${nextModel}` : nextModel);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Switched member model.",
      );
    }

    case "member_merged": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      const commitSha = nonEmptyString(data?.commitSha);
      if (commitSha) {
        const shortSha = commitSha.slice(0, 7);
        if (!summary.includes(shortSha)) {
          meta.push(`@${shortSha}`);
        }
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Merged member branch.",
      );
    }

    case "member_error": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Member encountered an error.",
      );
    }

    case "board_posted": {
      const meta: string[] = [];
      if (typeof data?.seq === "number" && !summary.includes(`#${data.seq}`)) {
        meta.push(`#${data.seq}`);
      }
      const channel = event.channel ?? nonEmptyString(data?.channel);
      if (
        channel &&
        !summary.includes(`[${channel}]`) &&
        !summary.includes(`#${channel}`)
      ) {
        meta.push(`#${channel}`);
      }
      const kind = nonEmptyString(data?.kind);
      if (
        kind &&
        kind !== "chat" &&
        !summary.toLowerCase().includes(`[${kind.toLowerCase()}]`)
      ) {
        meta.push(kind);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Posted to shared board.",
      );
    }

    case "channel_created": {
      const meta: string[] = [];
      const channel = event.channel ?? nonEmptyString(data?.channel);
      if (channel) meta.push(`#${channel}`);
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Created channel.",
      );
    }

    case "channel_updated": {
      const meta: string[] = [];
      const channel = event.channel ?? nonEmptyString(data?.channel);
      if (channel) meta.push(`#${channel}`);
      if (event.memberName && !summary.includes(event.memberName)) {
        meta.push(event.memberName);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Updated channel.",
      );
    }

    case "channel_archived": {
      const meta: string[] = [];
      const channel = event.channel ?? nonEmptyString(data?.channel);
      if (channel) meta.push(`#${channel}`);
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Archived channel.",
      );
    }

    case "stall_detected": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      if (
        typeof data?.boardHead === "number" &&
        !summary.includes(`#${data.boardHead}`)
      ) {
        meta.push(`head #${data.boardHead}`);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Swarm stall detected.",
      );
    }

    case "rate_limit_backoff": {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      if (typeof data?.backoffMs === "number" && Number.isFinite(data.backoffMs)) {
        meta.push(`${Math.round(data.backoffMs)}ms`);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Rate-limit backoff active.",
      );
    }

    case "teardown_completed": {
      const meta: string[] = [];
      if (typeof data?.removed === "number") {
        meta.push(`removed ${data.removed}`);
      }
      if (typeof data?.skipped === "number" && data.skipped > 0) {
        meta.push(`skipped ${data.skipped}`);
      }
      if (typeof data?.errors === "number" && data.errors > 0) {
        meta.push(`errors ${data.errors}`);
      }
      return formatLine(
        time,
        event.type,
        meta,
        actorPart,
        summary || "Teardown completed.",
      );
    }

    default: {
      const meta: string[] = [];
      if (event.memberName) meta.push(event.memberName);
      if (event.channel) meta.push(`#${event.channel}`);
      return formatLine(time, String(event.type), meta, actorPart, summary);
    }
  }
}

/** Format an array of ledger events into a concise multiline activity feed. */
export function formatLedgerActivity(events: readonly SwarmEvent[]): string {
  if (events.length === 0) {
    return "(no activity yet)";
  }
  return events.map(formatLedgerEvent).join("\n");
}

/**
 * Append-only JSONL event ledger scoped to a single events file path.
 */
export class SwarmLedger {
  readonly eventsPath: string;

  constructor(eventsPath: string) {
    this.eventsPath = path.resolve(eventsPath);
  }

  append(input: SwarmEventInput): Promise<SwarmEvent> {
    return appendLedgerEvent(this.eventsPath, input);
  }

  readAll(): Promise<SwarmEvent[]> {
    return readAllLedgerEvents(this.eventsPath);
  }

  readRecent(limit = 50): Promise<SwarmEvent[]> {
    return readRecentLedgerEvents(this.eventsPath, limit);
  }

  format(events: readonly SwarmEvent[]): string {
    return formatLedgerActivity(events);
  }
}

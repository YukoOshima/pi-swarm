import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FINAL_AUDIT_MISSION_ID } from "../constants.js";
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
        "SCOPE_VIOLATION",
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
    try {
      const existing = await readFile(eventsPath, "utf8");
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
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    };

    const line = `${JSON.stringify(event)}\n`;
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

function formatMissionTag(missionId: string): string {
  return missionId === FINAL_AUDIT_MISSION_ID ? "final-audit" : missionId;
}

/** Format a single ledger event into a concise single-line human-readable activity string. */
export function formatLedgerEvent(event: SwarmEvent): string {
  const time = `[${formatShortTime(event.timestamp)}]`;
  const actor = event.actor ?? event.agentId;
  const actorPart = actor ? `(${actor})` : undefined;
  const summary = event.summary.replace(/\s+/g, " ").trim();
  const data = event.data;

  switch (event.type) {
    case "board_posted": {
      const meta: string[] = [];
      if (typeof data?.seq === "number" && !summary.includes(`#${data.seq}`)) {
        meta.push(`#${data.seq}`);
      }
      if (
        typeof data?.kind === "string" &&
        data.kind.trim() &&
        data.kind !== "chat" &&
        !summary.toLowerCase().includes(`[${data.kind.toLowerCase()}]`)
      ) {
        meta.push(data.kind.trim());
      }
      const parts = [time, "board_posted"];
      if (meta.length > 0) parts.push(`[${meta.join(" · ")}]`);
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Posted to shared board.");
      return parts.join(" ");
    }

    case "agent_woken": {
      const meta: string[] = [];
      if (event.missionId) {
        meta.push(formatMissionTag(event.missionId));
      }
      if (
        typeof data?.boardSeq === "number" &&
        !summary.includes(`#${data.boardSeq}`)
      ) {
        meta.push(`#${data.boardSeq}`);
      }
      const parts = [time, "agent_woken"];
      if (meta.length > 0) parts.push(`[${meta.join(" · ")}]`);
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Agent woken.");
      return parts.join(" ");
    }

    case "agent_model_switched": {
      const meta: string[] = [];
      if (event.missionId) {
        meta.push(formatMissionTag(event.missionId));
      }
      const nextModel =
        typeof data?.model === "string" && data.model.trim()
          ? data.model.trim()
          : undefined;
      const prevModel =
        typeof data?.previousModel === "string" && data.previousModel.trim()
          ? data.previousModel.trim()
          : undefined;
      if (nextModel && !summary.includes(nextModel)) {
        meta.push(prevModel ? `${prevModel} -> ${nextModel}` : nextModel);
      }
      const parts = [time, "agent_model_switched"];
      if (meta.length > 0) parts.push(`[${meta.join(" · ")}]`);
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Switched agent model.");
      return parts.join(" ");
    }

    case "agent_killed": {
      const parts = [time, "agent_killed"];
      if (event.missionId) {
        parts.push(`[${formatMissionTag(event.missionId)}]`);
      }
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Agent killed.");
      return parts.join(" ");
    }

    case "validator_spawned": {
      const meta: string[] = [];
      if (event.missionId) {
        meta.push(formatMissionTag(event.missionId));
      }
      if (
        typeof data?.model === "string" &&
        data.model.trim() &&
        !summary.includes(data.model.trim())
      ) {
        meta.push(data.model.trim());
      }
      const parts = [time, "validator_spawned"];
      if (meta.length > 0) parts.push(`[${meta.join(" · ")}]`);
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Validator spawned.");
      return parts.join(" ");
    }

    case "validation_submitted": {
      const meta: string[] = [];
      if (event.missionId) {
        meta.push(formatMissionTag(event.missionId));
      }
      if (
        typeof data?.status === "string" &&
        data.status.trim() &&
        !summary.includes(data.status.trim())
      ) {
        meta.push(data.status.trim());
      }
      if (
        typeof data?.merge === "string" &&
        data.merge.trim() &&
        !summary.includes(data.merge.trim())
      ) {
        meta.push(data.merge.trim());
      }
      const parts = [time, "validation_submitted"];
      if (meta.length > 0) parts.push(`[${meta.join(" · ")}]`);
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Validation submitted.");
      return parts.join(" ");
    }

    case "final_audit_started": {
      const meta: string[] = [];
      if (
        typeof data?.round === "number" &&
        !new RegExp(`\\bround\\s+${data.round}\\b`, "i").test(summary)
      ) {
        meta.push(`r${data.round}`);
      }
      const branch =
        typeof data?.baseBranch === "string" && data.baseBranch.trim()
          ? data.baseBranch.trim()
          : typeof data?.branch === "string" && data.branch.trim()
            ? data.branch.trim()
            : undefined;
      if (branch && !summary.includes(branch)) {
        meta.push(branch);
      }
      if (typeof data?.commitSha === "string" && data.commitSha.trim()) {
        const shortSha = data.commitSha.trim().slice(0, 7);
        if (!summary.includes(shortSha)) {
          meta.push(`@${shortSha}`);
        }
      }
      const parts = [time, "final_audit_started"];
      if (meta.length > 0) parts.push(`[${meta.join(" · ")}]`);
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Final verification started.");
      return parts.join(" ");
    }

    case "final_audit_result": {
      const meta: string[] = [];
      if (typeof data?.verdict === "string" && data.verdict.trim()) {
        meta.push(data.verdict.trim().toUpperCase());
      }
      if (
        typeof data?.round === "number" &&
        !new RegExp(`\\bround\\s+${data.round}\\b`, "i").test(summary)
      ) {
        meta.push(`r${data.round}`);
      }
      if (typeof data?.commitSha === "string" && data.commitSha.trim()) {
        const shortSha = data.commitSha.trim().slice(0, 7);
        if (!summary.includes(shortSha)) {
          meta.push(`@${shortSha}`);
        }
      }
      if (
        typeof data?.checksPassed === "number" &&
        typeof data?.checksTotal === "number"
      ) {
        meta.push(`checks ${data.checksPassed}/${data.checksTotal}`);
      }
      if (typeof data?.findingsCount === "number") {
        meta.push(
          `${data.findingsCount} finding${data.findingsCount === 1 ? "" : "s"}`,
        );
      }
      const parts = [time, "final_audit_result"];
      if (meta.length > 0) parts.push(`[${meta.join(" · ")}]`);
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Final verification completed.");
      return parts.join(" ");
    }

    case "final_audit_skipped": {
      const skippedBy =
        typeof data?.skippedBy === "string" && data.skippedBy.trim()
          ? data.skippedBy.trim()
          : actor ?? "human";
      const reason =
        typeof data?.reason === "string" && data.reason.trim()
          ? data.reason.trim()
          : undefined;
      const parts = [time, "final_audit_skipped", `(${skippedBy})`];
      if (summary) {
        parts.push(summary);
      } else if (reason) {
        parts.push(`Final verification skipped: ${reason}`);
      } else {
        parts.push("Final verification skipped.");
      }
      return parts.join(" ");
    }

    case "final_audit_autofix_planned": {
      const missionIds = Array.isArray(data?.missionIds)
        ? data.missionIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          )
        : [];
      const parts = [time, "final_audit_autofix_planned"];
      if (missionIds.length > 0) {
        parts.push(`[${missionIds.join(", ")}]`);
      }
      if (actorPart) parts.push(actorPart);
      parts.push(summary || "Planned auto-fix missions from final verification.");
      return parts.join(" ");
    }

    default: {
      const parts: string[] = [time, event.type];
      if (event.missionId) {
        parts.push(`[${formatMissionTag(event.missionId)}]`);
      }
      if (actorPart) {
        parts.push(actorPart);
      }
      parts.push(summary);
      return parts.join(" ");
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

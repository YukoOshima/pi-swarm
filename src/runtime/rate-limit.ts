import { DEFAULT_SWARM_SETTINGS } from "../constants.js";
import { parseModelSpec } from "../store/settings.js";

// ============================================================================
// Rate-Limit & Transient Provider Error Detection
// ============================================================================

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate[\s_-]*limit/i,
  /too\s+many\s+requests/i,
  /\bquota\b/i,
  /resource[\s_-]*exhausted/i,
  /\boverloaded\b/i,
  /\bcapacity\b/i,
  /\bthrottl(?:ed|ing)\b/i,
  /\b529\b/,
  /\b503\b/,
  /\b502\b/,
  /\b504\b/,
  /service\s+unavailable/i,
  /temporarily\s+unavailable/i,
  /bad\s+gateway/i,
  /gateway\s+timeout/i,
  /\btry\s+again\b/i,
  /\beconnreset\b/i,
  /\betimedout\b/i,
  /socket\s+hang\s+up/i,
];

function extractErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause ? `${error.message} ${extractErrorText(cause)}` : error.message;
  }
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["errorMessage", "message", "error", "code", "status", "statusCode"]) {
      const val = obj[key];
      if (typeof val === "string" || typeof val === "number") {
        parts.push(String(val));
      } else if (val && typeof val === "object") {
        parts.push(extractErrorText(val));
      }
    }
    return parts.join(" ");
  }
  return "";
}

function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const obj = error as Record<string, unknown>;
  for (const key of ["status", "statusCode", "httpStatus"]) {
    const val = obj[key];
    if (typeof val === "number" && Number.isFinite(val)) {
      return val;
    }
  }
  if (obj.response && typeof obj.response === "object") {
    return extractHttpStatus(obj.response);
  }
  if (obj.cause && typeof obj.cause === "object") {
    return extractHttpStatus(obj.cause);
  }
  return undefined;
}

/**
 * Returns true if the error or assistant errorMessage indicates an HTTP 429,
 * quota/capacity exhaustion, overloaded server, or transient network/gateway failure.
 */
export function isRateLimitOrTransientError(error: unknown): boolean {
  if (error === undefined || error === null) {
    return false;
  }
  const status = extractHttpStatus(error);
  if (
    status !== undefined &&
    (status === 429 || status === 502 || status === 503 || status === 504 || status === 529)
  ) {
    return true;
  }
  const text = extractErrorText(error);
  if (!text) {
    return false;
  }
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Attempts to parse a Retry-After hint (in milliseconds) from an error object or message text.
 */
export function parseRetryAfterMs(error: unknown, nowMs: number = Date.now()): number | undefined {
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.retryAfterMs === "number" && Number.isFinite(obj.retryAfterMs) && obj.retryAfterMs > 0) {
      return Math.round(obj.retryAfterMs);
    }
    if (typeof obj.retryAfter === "number" && Number.isFinite(obj.retryAfter) && obj.retryAfter > 0) {
      // Values <= 600 are treated as seconds; larger values as milliseconds
      return Math.round(obj.retryAfter <= 600 ? obj.retryAfter * 1000 : obj.retryAfter);
    }
    const headers = obj.headers ?? (obj.response as Record<string, unknown> | undefined)?.headers;
    if (headers && typeof headers === "object") {
      const h = headers as Record<string, unknown>;
      const rawMs = h["retry-after-ms"] ?? h["Retry-After-Ms"];
      if (typeof rawMs === "number" && Number.isFinite(rawMs) && rawMs > 0) {
        return Math.round(rawMs);
      }
      if (typeof rawMs === "string" && rawMs.trim()) {
        const parsedMs = Number(rawMs.trim());
        if (Number.isFinite(parsedMs) && parsedMs > 0) {
          return Math.round(parsedMs);
        }
      }
      const raw = h["retry-after"] ?? h["Retry-After"];
      if (typeof raw === "string") {
        const parsed = parseRetryAfterHeaderValue(raw, nowMs);
        if (parsed !== undefined) {
          return parsed;
        }
      } else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return Math.round(raw * 1000);
      }
    }
  }

  const text = extractErrorText(error);
  if (!text) {
    return undefined;
  }

  const msMatch = text.match(/(?:retry[- ]?after|try again in|wait|backoff)[^\d]{0,12}(\d+(?:\.\d+)?)\s*ms\b/i);
  if (msMatch?.[1]) {
    const ms = Number.parseFloat(msMatch[1]);
    if (Number.isFinite(ms) && ms > 0) {
      return Math.round(ms);
    }
  }

  const secMatch = text.match(
    /(?:retry[- ]?after|try again in|wait|backoff)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i,
  );
  if (secMatch?.[1]) {
    const secs = Number.parseFloat(secMatch[1]);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.round(secs * 1000);
    }
  }

  const bareHeaderMatch = text.match(/retry[- ]?after\s*[:=]\s*(\d+(?:\.\d+)?)\b/i);
  if (bareHeaderMatch?.[1]) {
    const secs = Number.parseFloat(bareHeaderMatch[1]);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.round(secs * 1000);
    }
  }

  return undefined;
}

function parseRetryAfterHeaderValue(raw: string, nowMs: number): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.round(numeric * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs) && dateMs > nowMs) {
    return Math.round(dateMs - nowMs);
  }
  return undefined;
}

// ============================================================================
// Quota / 429 Fallback Model Selection
// ============================================================================

function normalizeModelKey(model: string): string {
  const parsed = parseModelSpec(model);
  return (parsed.model || model).trim().toLowerCase();
}

/**
 * Selects the next untried fallback model when an agent hits provider quota / HTTP 429
 * limits and `fallbackModels` is configured. Skips `currentModel` and any models already
 * recorded in `triedModels` (case-insensitive).
 */
export function selectFallbackModel(
  currentModel: string | undefined,
  fallbackModels: readonly string[] | undefined,
  triedModels?: ReadonlySet<string>,
): string | undefined {
  if (!fallbackModels || fallbackModels.length === 0) {
    return undefined;
  }

  const excluded = new Set<string>();
  if (currentModel?.trim()) {
    excluded.add(normalizeModelKey(currentModel));
  }
  if (triedModels) {
    for (const model of triedModels) {
      if (model.trim()) {
        excluded.add(normalizeModelKey(model));
      }
    }
  }

  for (const rawCandidate of fallbackModels) {
    const candidate = rawCandidate.trim();
    if (!candidate) {
      continue;
    }
    const key = normalizeModelKey(candidate);
    if (!excluded.has(key)) {
      return candidate;
    }
  }

  return undefined;
}

// ============================================================================
// Abortable Sleep Utility
// ============================================================================

export function createAbortError(message = "Operation aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ============================================================================
// Shared Fleet Rate-Limit Circuit Breaker
// ============================================================================

export interface RateLimitBreakerOptions {
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Fractional positive jitter applied to exponential delay (default 0.2 = up to +20%). */
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
}

/**
 * Shared fleet-wide circuit breaker that coordinates exponential backoff + jitter
 * whenever any worker or validator hits HTTP 429 / quota / transient provider errors.
 * Prevents respawn-into-429 storms across concurrent missions.
 */
export class RateLimitBreaker {
  private baseBackoffMs: number;
  private maxBackoffMs: number;
  private readonly jitterRatio: number;
  private readonly now: () => number;
  private readonly random: () => number;

  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private lastReason?: string;
  private readonly wakeListeners = new Set<() => void>();

  constructor(options: RateLimitBreakerOptions = {}) {
    this.baseBackoffMs = Math.max(10, options.baseBackoffMs ?? DEFAULT_SWARM_SETTINGS.rateLimitBaseBackoffMs);
    this.maxBackoffMs = Math.max(
      this.baseBackoffMs,
      options.maxBackoffMs ?? DEFAULT_SWARM_SETTINGS.rateLimitMaxBackoffMs,
    );
    this.jitterRatio = Math.max(0, Math.min(1, options.jitterRatio ?? 0.2));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
  }

  configure(options: { baseBackoffMs?: number; maxBackoffMs?: number }): void {
    if (options.baseBackoffMs !== undefined && options.baseBackoffMs > 0) {
      this.baseBackoffMs = Math.max(10, options.baseBackoffMs);
    }
    if (options.maxBackoffMs !== undefined && options.maxBackoffMs > 0) {
      this.maxBackoffMs = Math.max(this.baseBackoffMs, options.maxBackoffMs);
    }
  }

  /**
   * Records a rate-limit or transient provider failure and extends the shared backoff window.
   * Never shortens an already-active longer backoff window.
   * Returns the computed backoff delay in milliseconds.
   */
  recordRateLimit(retryAfterMs?: number, reason?: string): number {
    this.consecutiveFailures += 1;
    const exponent = Math.min(this.consecutiveFailures - 1, 20);
    const expDelay = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
    const jitter = Math.round(expDelay * this.jitterRatio * this.random());
    const computedDelay = Math.min(this.maxBackoffMs, expDelay + jitter);

    const requestedDelay =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(this.maxBackoffMs * 2, Math.round(retryAfterMs))
        : 0;

    const effectiveDelay = Math.max(computedDelay, requestedDelay);
    const nowMs = this.now();
    const candidateUntil = nowMs + effectiveDelay;
    if (candidateUntil > this.backoffUntil) {
      this.backoffUntil = candidateUntil;
    }
    if (reason) {
      this.lastReason = reason;
    }
    return Math.max(0, this.backoffUntil - nowMs);
  }

  /**
   * Records a successful provider completion, resetting consecutive failures and backoff window,
   * and promptly wakes any callers sleeping in `waitIfBackedOff`.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
    this.lastReason = undefined;
    if (this.wakeListeners.size > 0) {
      for (const wake of Array.from(this.wakeListeners)) {
        wake();
      }
    }
  }

  /**
   * Resets all breaker state immediately.
   */
  reset(): void {
    this.recordSuccess();
  }

  /**
   * Returns epoch timestamp (ms) until which launches are paused, or 0 if not backed off.
   */
  getBackoffUntil(): number {
    return this.backoffUntil > this.now() ? this.backoffUntil : 0;
  }

  getRemainingMs(): number {
    return Math.max(0, this.backoffUntil - this.now());
  }

  isBackedOff(): boolean {
    return this.getRemainingMs() > 0;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getLastReason(): string | undefined {
    return this.lastReason;
  }

  /**
   * Waits until the shared backoff window expires (re-checking if extended or cleared during sleep).
   */
  async waitIfBackedOff(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      const remaining = this.getRemainingMs();
      if (remaining <= 0) {
        return;
      }
      await this.sleepWhileBackedOff(remaining, signal);
    }
  }

  private sleepWhileBackedOff(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.wakeListeners.delete(onWake);
        signal?.removeEventListener("abort", onAbort);
      };
      const onWake = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(createAbortError());
      };
      const timer = setTimeout(onWake, ms);
      this.wakeListeners.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ============================================================================
// Shared Per-Run Concurrency Gate (Semaphore + Global Pause/Backoff)
// ============================================================================

interface GateWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Shared per-run semaphore enforcing `maxConcurrency`, global pause state,
 * and shared `RateLimitBreaker` backoff before granting execution slots.
 */
export class ConcurrencyGate {
  private maxConcurrency: number;
  private activeCount = 0;
  private paused = false;
  private readonly breaker?: RateLimitBreaker;
  private readonly waiters: GateWaiter[] = [];

  constructor(maxConcurrency: number, breaker?: RateLimitBreaker) {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
    this.breaker = breaker;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  setMaxConcurrency(limit: number): void {
    this.maxConcurrency = Math.max(1, Math.floor(limit));
    this.drainWaiters();
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  getAvailableSlots(): number {
    if (this.paused || this.breaker?.isBackedOff()) {
      return 0;
    }
    return Math.max(0, this.maxConcurrency - this.activeCount);
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.drainWaiters();
  }

  /**
   * Attempts to acquire a slot immediately without waiting.
   * Returns an idempotent `release()` callback on success, or `null` if unavailable.
   */
  tryAcquire(): (() => void) | null {
    if (this.paused || this.breaker?.isBackedOff() || this.activeCount >= this.maxConcurrency) {
      return null;
    }
    this.activeCount += 1;
    return this.createRelease();
  }

  /**
   * Waits for pause and rate-limit backoff to clear and for a concurrency slot to open.
   * Returns an idempotent `release()` callback.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    try {
      while (true) {
        if (signal?.aborted) {
          throw createAbortError();
        }
        if (this.breaker?.isBackedOff()) {
          await this.breaker.waitIfBackedOff(signal);
          continue;
        }
        if (!this.paused && this.activeCount < this.maxConcurrency) {
          this.activeCount += 1;
          return this.createRelease();
        }
        await this.waitForSignal(signal);
      }
    } catch (err) {
      this.drainWaiters();
      throw err;
    }
  }

  /**
   * Runs `fn` inside an acquired slot, guaranteeing release on completion or error.
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drainWaiters();
    };
  }

  private waitForSignal(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: GateWaiter = { resolve, reject, signal };
      if (signal) {
        const onAbort = (): void => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
          }
          reject(createAbortError());
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private drainWaiters(): void {
    if (this.paused) {
      return;
    }
    const available = Math.max(0, this.maxConcurrency - this.activeCount);
    const wakeCount = Math.min(available, this.waiters.length);
    for (let i = 0; i < wakeCount; i++) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        break;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve();
    }
  }
}

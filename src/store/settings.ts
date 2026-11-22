import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_SWARM_SETTINGS, SWARM_SETTINGS_FILE } from "../constants.js";
import {
  type StallMonitorMode,
  SwarmProtocolError,
  type SwarmSettings,
} from "../types.js";

const VALID_THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const SWARM_SETTINGS_BOUNDS = Object.freeze({
  maxConcurrency: { min: 1, max: 64 },
  stallTimeoutMs: { min: 1_000, max: 3_600_000 },
  maxRetries: { min: 0, max: 20 },
  rateLimitBaseBackoffMs: { min: 250, max: 600_000 },
  rateLimitMaxBackoffMs: { min: 250, max: 3_600_000 },
  gitTimeoutMs: { min: 1_000, max: 600_000 },
});

export interface SettingsPathOptions {
  /** Override global Pi agent directory (defaults to PI_CODING_AGENT_DIR or ~/.pi/agent). */
  globalDir?: string;
  /** Override exact global settings file path. */
  globalPath?: string;
  /** Override exact project settings file path. */
  projectPath?: string;
}

export interface LayeredSettingsResult {
  settings: SwarmSettings;
  globalPath: string;
  projectPath: string;
  globalOverrides: Partial<SwarmSettings>;
  projectOverrides: Partial<SwarmSettings>;
  warnings: string[];
}

export function getDefaultGlobalAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) {
    return path.resolve(envDir);
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function getGlobalSettingsPath(options?: SettingsPathOptions): string {
  if (options?.globalPath) {
    return path.resolve(options.globalPath);
  }
  const dir = options?.globalDir
    ? path.resolve(options.globalDir)
    : getDefaultGlobalAgentDir();
  return path.join(dir, SWARM_SETTINGS_FILE);
}

export function getProjectSettingsPath(
  projectRoot: string,
  options?: SettingsPathOptions,
): string {
  if (options?.projectPath) {
    return path.resolve(options.projectPath);
  }
  return path.join(path.resolve(projectRoot), ".pi", SWARM_SETTINGS_FILE);
}

function clampInt(
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

type RoleModelKey = "orchestratorModel" | "workerModel" | "validatorModel";
type RoleThinkingKey =
  | "orchestratorThinkingLevel"
  | "workerThinkingLevel"
  | "validatorThinkingLevel";

function sanitizeOptionalModel(
  raw: Record<string, unknown>,
  key: RoleModelKey,
  fallback: string | undefined,
): string | undefined {
  if (!(key in raw)) {
    return fallback;
  }
  const value = raw[key];
  if (value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return fallback;
}

function sanitizeOptionalThinking(
  raw: Record<string, unknown>,
  key: RoleThinkingKey,
  fallback: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (!(key in raw)) {
    return fallback;
  }
  const value = raw[key];
  if (value === null || value === "") {
    return undefined;
  }
  if (
    typeof value === "string" &&
    VALID_THINKING_LEVELS.has(value as ThinkingLevel)
  ) {
    return value as ThinkingLevel;
  }
  return fallback;
}

function sanitizeFallbackModels(
  raw: Record<string, unknown>,
  fallback: readonly string[],
): string[] {
  if (!("fallbackModels" in raw)) {
    return [...fallback];
  }
  const value = raw.fallbackModels;
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}

/**
 * Sanitize and clamp raw settings against valid bounds, falling back to `base`
 * (which defaults to `DEFAULT_SWARM_SETTINGS`). Unknown legacy keys are ignored cleanly.
 */
export function sanitizeSwarmSettings(
  raw: Record<string, unknown> | Partial<SwarmSettings> | undefined,
  base: Readonly<SwarmSettings> = DEFAULT_SWARM_SETTINGS,
): SwarmSettings {
  const input: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  let rateLimitBaseBackoffMs = clampInt(
    input.rateLimitBaseBackoffMs,
    SWARM_SETTINGS_BOUNDS.rateLimitBaseBackoffMs.min,
    SWARM_SETTINGS_BOUNDS.rateLimitBaseBackoffMs.max,
    base.rateLimitBaseBackoffMs,
  );

  const rawMaxBackoff = clampInt(
    input.rateLimitMaxBackoffMs,
    SWARM_SETTINGS_BOUNDS.rateLimitMaxBackoffMs.min,
    SWARM_SETTINGS_BOUNDS.rateLimitMaxBackoffMs.max,
    base.rateLimitMaxBackoffMs,
  );

  if (
    "rateLimitMaxBackoffMs" in input &&
    input.rateLimitMaxBackoffMs !== undefined &&
    !(
      "rateLimitBaseBackoffMs" in input &&
      input.rateLimitBaseBackoffMs !== undefined
    )
  ) {
    rateLimitBaseBackoffMs = Math.min(rateLimitBaseBackoffMs, rawMaxBackoff);
  }

  const rateLimitMaxBackoffMs = Math.max(rateLimitBaseBackoffMs, rawMaxBackoff);

  return {
    orchestratorModel: sanitizeOptionalModel(
      input,
      "orchestratorModel",
      base.orchestratorModel,
    ),
    orchestratorThinkingLevel: sanitizeOptionalThinking(
      input,
      "orchestratorThinkingLevel",
      base.orchestratorThinkingLevel,
    ),
    workerModel: sanitizeOptionalModel(input, "workerModel", base.workerModel),
    workerThinkingLevel: sanitizeOptionalThinking(
      input,
      "workerThinkingLevel",
      base.workerThinkingLevel,
    ),
    validatorModel: sanitizeOptionalModel(
      input,
      "validatorModel",
      base.validatorModel,
    ),
    validatorThinkingLevel: sanitizeOptionalThinking(
      input,
      "validatorThinkingLevel",
      base.validatorThinkingLevel,
    ),
    fallbackModels: sanitizeFallbackModels(input, base.fallbackModels),
    maxConcurrency: clampInt(
      input.maxConcurrency,
      SWARM_SETTINGS_BOUNDS.maxConcurrency.min,
      SWARM_SETTINGS_BOUNDS.maxConcurrency.max,
      base.maxConcurrency,
    ),
    validatorEnabled:
      typeof input.validatorEnabled === "boolean"
        ? input.validatorEnabled
        : base.validatorEnabled,
    keepWorkersWarm:
      typeof input.keepWorkersWarm === "boolean"
        ? input.keepWorkersWarm
        : base.keepWorkersWarm,
    stallWatchdogEnabled:
      typeof input.stallWatchdogEnabled === "boolean"
        ? input.stallWatchdogEnabled
        : base.stallWatchdogEnabled,
    stallMonitorMode:
      input.stallMonitorMode === "llm" || input.stallMonitorMode === "deterministic"
        ? (input.stallMonitorMode as StallMonitorMode)
        : base.stallMonitorMode,
    stallTimeoutMs: clampInt(
      input.stallTimeoutMs,
      SWARM_SETTINGS_BOUNDS.stallTimeoutMs.min,
      SWARM_SETTINGS_BOUNDS.stallTimeoutMs.max,
      base.stallTimeoutMs,
    ),
    maxRetries: clampInt(
      input.maxRetries,
      SWARM_SETTINGS_BOUNDS.maxRetries.min,
      SWARM_SETTINGS_BOUNDS.maxRetries.max,
      base.maxRetries,
    ),
    rateLimitBaseBackoffMs,
    rateLimitMaxBackoffMs,
    gitTimeoutMs: clampInt(
      input.gitTimeoutMs,
      SWARM_SETTINGS_BOUNDS.gitTimeoutMs.min,
      SWARM_SETTINGS_BOUNDS.gitTimeoutMs.max,
      base.gitTimeoutMs,
    ),
    autoRebase:
      typeof input.autoRebase === "boolean" ? input.autoRebase : base.autoRebase,
    autoTeardownOnComplete:
      typeof input.autoTeardownOnComplete === "boolean"
        ? input.autoTeardownOnComplete
        : base.autoTeardownOnComplete,
  };
}

/** Extract only recognized and sanitized override fields from a raw layer object. */
export function sanitizeSettingsPatch(
  raw: Record<string, unknown> | Partial<SwarmSettings>,
): Partial<SwarmSettings> {
  const patch: Partial<SwarmSettings> = {};
  const input = raw as Record<string, unknown>;

  if (
    "maxConcurrency" in input &&
    typeof input.maxConcurrency === "number" &&
    Number.isFinite(input.maxConcurrency)
  ) {
    patch.maxConcurrency = clampInt(
      input.maxConcurrency,
      SWARM_SETTINGS_BOUNDS.maxConcurrency.min,
      SWARM_SETTINGS_BOUNDS.maxConcurrency.max,
      DEFAULT_SWARM_SETTINGS.maxConcurrency,
    );
  }
  if ("validatorEnabled" in input && typeof input.validatorEnabled === "boolean") {
    patch.validatorEnabled = input.validatorEnabled;
  }
  if ("keepWorkersWarm" in input && typeof input.keepWorkersWarm === "boolean") {
    patch.keepWorkersWarm = input.keepWorkersWarm;
  }
  if (
    "stallWatchdogEnabled" in input &&
    typeof input.stallWatchdogEnabled === "boolean"
  ) {
    patch.stallWatchdogEnabled = input.stallWatchdogEnabled;
  }
  if (
    "stallMonitorMode" in input &&
    (input.stallMonitorMode === "llm" || input.stallMonitorMode === "deterministic")
  ) {
    patch.stallMonitorMode = input.stallMonitorMode;
  }
  if (
    "stallTimeoutMs" in input &&
    typeof input.stallTimeoutMs === "number" &&
    Number.isFinite(input.stallTimeoutMs)
  ) {
    patch.stallTimeoutMs = clampInt(
      input.stallTimeoutMs,
      SWARM_SETTINGS_BOUNDS.stallTimeoutMs.min,
      SWARM_SETTINGS_BOUNDS.stallTimeoutMs.max,
      DEFAULT_SWARM_SETTINGS.stallTimeoutMs,
    );
  }
  if (
    "maxRetries" in input &&
    typeof input.maxRetries === "number" &&
    Number.isFinite(input.maxRetries)
  ) {
    patch.maxRetries = clampInt(
      input.maxRetries,
      SWARM_SETTINGS_BOUNDS.maxRetries.min,
      SWARM_SETTINGS_BOUNDS.maxRetries.max,
      DEFAULT_SWARM_SETTINGS.maxRetries,
    );
  }
  if (
    "rateLimitBaseBackoffMs" in input &&
    typeof input.rateLimitBaseBackoffMs === "number" &&
    Number.isFinite(input.rateLimitBaseBackoffMs)
  ) {
    patch.rateLimitBaseBackoffMs = clampInt(
      input.rateLimitBaseBackoffMs,
      SWARM_SETTINGS_BOUNDS.rateLimitBaseBackoffMs.min,
      SWARM_SETTINGS_BOUNDS.rateLimitBaseBackoffMs.max,
      DEFAULT_SWARM_SETTINGS.rateLimitBaseBackoffMs,
    );
  }
  if (
    "rateLimitMaxBackoffMs" in input &&
    typeof input.rateLimitMaxBackoffMs === "number" &&
    Number.isFinite(input.rateLimitMaxBackoffMs)
  ) {
    patch.rateLimitMaxBackoffMs = clampInt(
      input.rateLimitMaxBackoffMs,
      SWARM_SETTINGS_BOUNDS.rateLimitMaxBackoffMs.min,
      SWARM_SETTINGS_BOUNDS.rateLimitMaxBackoffMs.max,
      DEFAULT_SWARM_SETTINGS.rateLimitMaxBackoffMs,
    );
  }
  if (
    patch.rateLimitBaseBackoffMs !== undefined &&
    patch.rateLimitMaxBackoffMs !== undefined &&
    patch.rateLimitMaxBackoffMs < patch.rateLimitBaseBackoffMs
  ) {
    patch.rateLimitMaxBackoffMs = patch.rateLimitBaseBackoffMs;
  }
  if (
    "gitTimeoutMs" in input &&
    typeof input.gitTimeoutMs === "number" &&
    Number.isFinite(input.gitTimeoutMs)
  ) {
    patch.gitTimeoutMs = clampInt(
      input.gitTimeoutMs,
      SWARM_SETTINGS_BOUNDS.gitTimeoutMs.min,
      SWARM_SETTINGS_BOUNDS.gitTimeoutMs.max,
      DEFAULT_SWARM_SETTINGS.gitTimeoutMs,
    );
  }
  if ("autoRebase" in input && typeof input.autoRebase === "boolean") {
    patch.autoRebase = input.autoRebase;
  }
  if (
    "autoTeardownOnComplete" in input &&
    typeof input.autoTeardownOnComplete === "boolean"
  ) {
    patch.autoTeardownOnComplete = input.autoTeardownOnComplete;
  }

  for (const key of [
    "orchestratorModel",
    "workerModel",
    "validatorModel",
  ] as const) {
    if (key in input) {
      const model = sanitizeOptionalModel(input, key, undefined);
      const rawVal = input[key];
      if (
        model !== undefined ||
        rawVal === null ||
        rawVal === undefined ||
        (typeof rawVal === "string" && rawVal.trim() === "")
      ) {
        patch[key] = model;
      }
    }
  }

  for (const key of [
    "orchestratorThinkingLevel",
    "workerThinkingLevel",
    "validatorThinkingLevel",
  ] as const) {
    if (key in input) {
      const level = sanitizeOptionalThinking(input, key, undefined);
      const rawVal = input[key];
      if (
        level !== undefined ||
        rawVal === null ||
        rawVal === undefined ||
        rawVal === ""
      ) {
        patch[key] = level;
      }
    }
  }

  if ("fallbackModels" in input) {
    const rawVal = input.fallbackModels;
    if (Array.isArray(rawVal)) {
      patch.fallbackModels = sanitizeFallbackModels(input, []);
    } else if (rawVal === null || rawVal === undefined) {
      patch.fallbackModels = undefined;
    }
  }

  return patch;
}

/** In-process per-path write queue to serialize settings read-modify-write saves. */
const settingsWriteQueues = new Map<string, Promise<unknown>>();

function enqueueSettingsWrite<T>(
  targetPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(targetPath);
  const previous = settingsWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const cleanup = next.then(
    () => {
      if (settingsWriteQueues.get(key) === cleanup) {
        settingsWriteQueues.delete(key);
      }
    },
    () => {
      if (settingsWriteQueues.get(key) === cleanup) {
        settingsWriteQueues.delete(key);
      }
    },
  );
  settingsWriteQueues.set(key, cleanup);
  return next;
}

async function findSymlinkWithinRoot(
  rootDir: string,
  targetPath: string,
): Promise<string | null> {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    return null;
  }
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (!rel || rel === ".") {
    return null;
  }
  const parts = rel.split(path.sep).filter(Boolean);
  let curr = resolvedRoot;
  for (const part of parts) {
    curr = path.join(curr, part);
    try {
      const st = await lstat(curr);
      if (st.isSymbolicLink()) {
        return curr;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }
  return null;
}

async function readSettingsLayer(
  filePath: string,
  warnings: string[],
  projectRoot?: string,
): Promise<Record<string, unknown>> {
  if (projectRoot) {
    const sym = await findSymlinkWithinRoot(projectRoot, filePath);
    if (sym) {
      warnings.push(`Ignored symlinked settings path: ${sym}`);
      return {};
    }
  }

  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink()) {
      warnings.push(`Ignored symlinked settings file: ${filePath}`);
      return {};
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {};
    }
    throw err;
  }

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`Ignored non-object settings file: ${filePath}`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {};
    }
    warnings.push(
      `Failed to parse settings file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

async function writeSettingsFileAtomic(
  filePath: string,
  data: Record<string, unknown>,
  projectRoot?: string,
): Promise<void> {
  if (projectRoot) {
    const sym = await findSymlinkWithinRoot(projectRoot, filePath);
    if (sym) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Refusing to write settings through symlinked path: ${sym}`,
        { path: sym },
      );
    }
  }

  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink()) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Refusing to write symlinked settings file: ${filePath}`,
        { path: filePath },
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }

  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  if (projectRoot) {
    const symAfterMkdir = await findSymlinkWithinRoot(projectRoot, filePath);
    if (symAfterMkdir) {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `Refusing to write settings through symlinked path: ${symAfterMkdir}`,
        { path: symAfterMkdir },
      );
    }
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await writeFile(tmpPath, payload, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Load layered settings with full inspection metadata:
 * `DEFAULT_SWARM_SETTINGS` <- global (`~/.pi/agent/pi-swarm-settings.json`)
 * <- project (`<projectRoot>/.pi/pi-swarm-settings.json`).
 */
export async function loadLayeredSwarmSettings(
  projectRoot: string,
  options?: SettingsPathOptions,
): Promise<LayeredSettingsResult> {
  const warnings: string[] = [];
  const globalPath = getGlobalSettingsPath(options);
  const projectPath = getProjectSettingsPath(projectRoot, options);

  const globalRaw = await readSettingsLayer(globalPath, warnings);
  const projectRaw = await readSettingsLayer(projectPath, warnings, projectRoot);

  const afterGlobal = sanitizeSwarmSettings(globalRaw, DEFAULT_SWARM_SETTINGS);
  const effective = sanitizeSwarmSettings(projectRaw, afterGlobal);

  return {
    settings: effective,
    globalPath,
    projectPath,
    globalOverrides: sanitizeSettingsPatch(globalRaw),
    projectOverrides: sanitizeSettingsPatch(projectRaw),
    warnings,
  };
}

/**
 * Load effective merged Swarm settings for a project.
 */
export async function loadSwarmSettings(
  projectRoot: string,
  options?: SettingsPathOptions,
): Promise<SwarmSettings> {
  const result = await loadLayeredSwarmSettings(projectRoot, options);
  return result.settings;
}

export interface SaveSwarmSettingsOptions extends SettingsPathOptions {
  projectRoot?: string;
  /** Replace the target layer file instead of merging with existing layer keys. */
  replace?: boolean;
}

/**
 * Save settings overrides to either the global or project layer atomically,
 * returning the resulting effective `SwarmSettings`.
 */
export async function saveSwarmSettings(
  scope: "global" | "project",
  patch: Partial<SwarmSettings>,
  options?: SaveSwarmSettingsOptions,
): Promise<SwarmSettings> {
  if (scope === "project" && !options?.projectRoot && !options?.projectPath) {
    throw new SwarmProtocolError(
      "NOT_FOUND",
      "projectRoot (or projectPath) is required to save project settings",
    );
  }

  const targetPath =
    scope === "global"
      ? getGlobalSettingsPath(options)
      : getProjectSettingsPath(options!.projectRoot ?? ".", options);
  const projectRootForGuard =
    scope === "project" ? options?.projectRoot : undefined;

  return enqueueSettingsWrite(targetPath, async () => {
    if (projectRootForGuard) {
      const sym = await findSymlinkWithinRoot(projectRootForGuard, targetPath);
      if (sym) {
        throw new SwarmProtocolError(
          "PERMISSION_DENIED",
          `Refusing to write settings through symlinked path: ${sym}`,
          { path: sym },
        );
      }
    }

    const warnings: string[] = [];
    const existingLayer = options?.replace
      ? {}
      : await readSettingsLayer(targetPath, warnings, projectRootForGuard);
    const sanitizedPatch = sanitizeSettingsPatch(patch);

    const rawPatch = patch as Record<string, unknown>;
    const nextLayer: Record<string, unknown> = { ...existingLayer };
    for (const [key, value] of Object.entries(sanitizedPatch)) {
      if (value === undefined) {
        // In project scope, explicit "" (or whitespace-only) or null clears a global override;
        // explicit undefined removes the project override to inherit global.
        const rawVal = rawPatch[key];
        const isExplicitClear =
          rawVal === null ||
          (typeof rawVal === "string" && rawVal.trim() === "");
        if (scope === "project" && isExplicitClear) {
          nextLayer[key] = null;
        } else {
          delete nextLayer[key];
        }
      } else {
        nextLayer[key] = value;
      }
    }

    await writeSettingsFileAtomic(targetPath, nextLayer, projectRootForGuard);

    if (options?.projectRoot) {
      return loadSwarmSettings(options.projectRoot, options);
    }
    return sanitizeSwarmSettings(nextLayer, DEFAULT_SWARM_SETTINGS);
  });
}

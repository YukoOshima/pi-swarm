import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
  isToolCallEventType,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  POST_MESSAGE_TOOL,
  READ_BOARD_TOOL,
  SWARM_CORE_TOOLS,
  SWARM_DIR,
  SWARM_TOOL,
  SWARM_WAIT_TOOL,
  VALIDATOR_BUILTIN_TOOLS,
  WORKER_BUILTIN_TOOLS,
} from "../constants.js";
import {
  type AgentTelemetryEvent,
  type AgentTurnOutcome,
  type AgentTurnResult,
  type AvailableModelInfo,
  type ISwarmTransport,
  type MemberEngineBridge,
  type ModelSwitchResult,
  type PersistentAgentHandle,
  type SpawnMemberRequest,
  type SwarmMemberState,
  type SwarmModelRole,
  SwarmProtocolError,
  type SwarmSettings,
  type TokenUsage,
} from "../types.js";
import { parseModelSpec } from "../store/settings.js";
import { isRateLimitOrTransientError, parseRetryAfterMs } from "./rate-limit.js";
import { createMemberScopedTools } from "./swarm-tools.js";

// ============================================================================
// 3-Role Model Resolution Helper
// ============================================================================

/**
 * Resolves the effective model and thinking level for one of the 3 Swarm roles
 * (`orchestrator` | `worker` | `validator`), applying explicit per-call overrides first.
 */
export function resolveRoleModel(
  role: SwarmModelRole,
  settings: SwarmSettings,
  override?: string,
  thinkingOverride?: ThinkingLevel,
): { model?: string; thinkingLevel?: ThinkingLevel } {
  let defaultModel: string | undefined;
  let defaultThinking: ThinkingLevel | undefined;

  if (role === "orchestrator") {
    defaultModel = settings.orchestratorModel;
    defaultThinking = settings.orchestratorThinkingLevel;
  } else if (role === "worker") {
    defaultModel = settings.workerModel;
    defaultThinking = settings.workerThinkingLevel;
  } else {
    defaultModel = settings.validatorModel;
    defaultThinking = settings.validatorThinkingLevel;
  }

  const parsedOverride = override?.trim() ? parseModelSpec(override.trim()) : undefined;
  const parsedDefault = defaultModel?.trim() ? parseModelSpec(defaultModel.trim()) : undefined;

  const effectiveModel = parsedOverride?.model || parsedDefault?.model || undefined;
  const effectiveThinking =
    thinkingOverride ??
    parsedOverride?.thinkingLevel ??
    defaultThinking ??
    parsedDefault?.thinkingLevel;
  return {
    model: effectiveModel,
    thinkingLevel: effectiveThinking,
  };
}

function formatModelId(model: { provider?: string; id?: string } | undefined): string | undefined {
  if (!model?.id) {
    return undefined;
  }
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

// ============================================================================
// Scope, Path Normalization & Command Safety Guards
// ============================================================================

const PROTECTED_PREFIXES = [".pi/swarm", ".swarm", ".git"] as const;

/**
 * Normalizes a repo-relative path to POSIX separators without leading `./` or trailing `/`.
 */
export function normalizeRepoPath(filePath: string): string {
  const posix = filePath.replace(/\\/g, "/").trim();
  const normalized = path.posix.normalize(posix);
  if (normalized === "." || normalized === "./") {
    return ".";
  }
  return normalized.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Resolves `targetPath` relative to `worktreePath`.
 * Verifies symlink-safe containment using `realpathSync` on `root` and the deepest existing ancestor.
 * Returns `null` if `targetPath` escapes outside `worktreePath`.
 */
export function resolveWorktreeRelativePath(worktreePath: string, targetPath: string): string | null {
  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, targetPath);
  const rel = path.relative(root, resolved);
  if (rel === "") {
    return ".";
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return normalizeRepoPath(rel);
    }
    return null;
  }

  let hops = 0;
  let probe = resolved;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const realProbe = realpathSync(probe);
      const realResolved =
        missingSegments.length > 0
          ? path.resolve(realProbe, ...missingSegments.reverse())
          : realProbe;
      const realRel = path.relative(realRoot, realResolved);
      if (realRel === "") {
        return ".";
      }
      if (
        realRel === ".." ||
        realRel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRel)
      ) {
        return null;
      }
      return normalizeRepoPath(realRel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return null;
      }
      // Check dangling symlinks so they cannot point outside `realRoot` or into protected paths.
      try {
        const stat = lstatSync(probe);
        if (stat.isSymbolicLink()) {
          if (++hops > 20) {
            return null;
          }
          const linkTarget = readlinkSync(probe);
          const parentReal = realpathSync(path.dirname(probe));
          probe = path.resolve(parentReal, linkTarget);
          continue;
        }
      } catch {
        // Not a symlink entry; continue walking up to parent
      }

      const parent = path.dirname(probe);
      if (parent === probe) {
        return null;
      }
      missingSegments.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Returns true if `relPath` targets `.pi/swarm/`, `.swarm/`, or `.git/` internals.
 */
export function isProtectedSwarmPath(relPath: string): boolean {
  const norm = normalizeRepoPath(relPath);
  if (!norm || norm === ".") {
    return false;
  }
  const candidate =
    process.platform === "darwin" || process.platform === "win32"
      ? norm.toLowerCase()
      : norm;
  return PROTECTED_PREFIXES.some(
    (prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`),
  );
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if ("\\^$+?.()|[]{}".includes(ch)) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

/**
 * Checks whether a normalized repo-relative path falls inside any declared scope entry.
 * Always rejects protected Swarm/Git internal paths and parent traversal (`..`).
 */
export function isPathInScope(relPath: string, scope: readonly string[]): boolean {
  const norm = normalizeRepoPath(relPath);
  if (!norm || norm === ".." || norm.startsWith("../") || path.posix.isAbsolute(norm)) {
    return false;
  }
  if (isProtectedSwarmPath(norm)) {
    return false;
  }
  if (scope.length === 0) {
    return false;
  }

  for (const rawEntry of scope) {
    const entry = normalizeRepoPath(rawEntry);
    if (!entry) {
      continue;
    }
    if (entry === "." || entry === "*" || entry === "**" || entry === "**/*") {
      return true;
    }
    if (entry.includes("*") || entry.includes("?")) {
      if (globToRegExp(entry).test(norm)) {
        return true;
      }
      continue;
    }
    if (norm === entry || norm.startsWith(`${entry}/`)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns every file from `files` that violates `scope` or touches protected Swarm/Git paths.
 */
export function findOutOfScopeFiles(files: readonly string[], scope: readonly string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const norm = normalizeRepoPath(file);
    if (!isPathInScope(norm, scope)) {
      violations.push(norm);
    }
  }
  return violations;
}

export interface CommandGuardResult {
  allowed: boolean;
  reason?: string;
}

const MUTATING_REDIRECTION_RE = /(?<![=\->&])(?:[0-9]?>{1,2}|&>|<>)\s*(?!\/dev\/null\b|&\d\b)\S/;

const WRAPPER_ARG_RE =
  /(?:[A-Za-z_][A-Za-z0-9_]*=\S*|\d+(?:\.\d+)?[smhd]?|-(?:n|P|L|I|d|E|s|k|u|g)\s+[^\s;&|)\r\n]+|-[^\s;&|)\r\n]+)/.source;
const WRAPPER_CHAIN_RE =
  `(?:(?:xargs|env|command|sudo|timeout|time|nice|nohup|(?:sh|bash|zsh|dash|ksh|fish)\\s+-[A-Za-z]*c[A-Za-z]*|eval)(?:\\s+${WRAPPER_ARG_RE})*\\s+)*`;
const CMD_BOUNDARY_RE = /(?:^|(?:[;&|\r\n"'`{(]|\$\()\s*)/.source;
const CMD_PATH_PREFIX_RE = /(?:(?:\/|\.\.?\/)[^\s;&|()"'`]*\/)?/.source;
const CMD_PREFIX_RE = `${CMD_BOUNDARY_RE}(?:[({]\\s*)*${WRAPPER_CHAIN_RE}${CMD_PATH_PREFIX_RE}`;

const SHELL_EVAL_CMD_RE = new RegExp(
  `${CMD_BOUNDARY_RE}(?:[({]\\s*)*${WRAPPER_CHAIN_RE}(?:${CMD_PATH_PREFIX_RE}(?:sh|bash|zsh|dash|ksh|fish)|eval)(?=\\s|$|[;&|)\\r\\n])`,
);

const GIT_GLOBAL_FLAG_RE =
  /(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace|super-prefix|config-env|exec-path))\s+[^\s;&|)\r\n]+|--(?:git-dir|work-tree|namespace|super-prefix|config-env|exec-path)=[^\s;&|)\r\n]+|--(?:no-pager|paginate|bare|no-replace-objects|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs|no-optional-locks|no-lazy-fetch|no-advice|html-path|man-path|info-path)|-[pP])/.source;
const GIT_PREFIX_RE = `\\bgit\\b(?:\\s+${GIT_GLOBAL_FLAG_RE})*`;

const PKG_PRE_FLAG_RE =
  /(?:(?:--(?:prefix|cwd|workspace|filter|dir)|-[Cw])\s+[^\s;&|)\r\n]+|-[^\s;&|)\r\n]+)/.source;

const SIMPLE_TOKEN_RE = /^[A-Za-z0-9_./:-]+$/;

const VALIDATOR_FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: MUTATING_REDIRECTION_RE,
    reason: "Output redirection to files is blocked in read-only validator sessions.",
  },
  {
    pattern: new RegExp(`${CMD_PREFIX_RE}tee\\b`),
    reason: "`tee` is blocked in read-only validator sessions.",
  },
  {
    pattern: /\bsed\b[^\n;|&]*\s-i(?:\b|['".])/,
    reason: "In-place `sed -i` is blocked in read-only validator sessions.",
  },
  {
    pattern: /\bperl\b[^\n;|&]*\s-[a-zA-Z]*i/,
    reason: "In-place `perl -i` is blocked in read-only validator sessions.",
  },
  {
    pattern: /\bfind\b[^\n;|&]*\s-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/,
    reason: "Mutating `find` actions (`-delete`, `-exec`, `-fprint`) are blocked in read-only validator sessions.",
  },
  {
    pattern: new RegExp(
      `${CMD_PREFIX_RE}(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|truncate|dd|install|patch)\\b`,
    ),
    reason: "Filesystem mutation commands are blocked in read-only validator sessions.",
  },
  {
    pattern: new RegExp(
      `${GIT_PREFIX_RE}\\s+(?:add|commit|rm|mv|checkout|switch|reset|rebase|merge|cherry-pick|clean|stash|push|pull|fetch|tag|apply|am|restore|worktree)(?=\\s|$|[;&|)\\r\\n\`"'])`,
    ),
    reason: "Mutating git subcommands are blocked in read-only validator sessions.",
  },
  {
    pattern: new RegExp(
      `${GIT_PREFIX_RE}\\s+branch\\b[^\\n;|&]*\\s(?:-[dDmMcCf]+\\b|--(?:delete|move|copy|force)(?=\\s|$|[;&|)]))`,
    ),
    reason: "Mutating `git branch` flags are blocked in read-only validator sessions.",
  },
  {
    pattern: new RegExp(
      `\\b(?:npm|pnpm|yarn|bun)\\b(?:\\s+${PKG_PRE_FLAG_RE})*\\s+(?:install|i|add|remove|uninstall|rm|update|upgrade|publish|link)\\b`,
    ),
    reason: "Package-mutating commands are blocked in read-only validator sessions.",
  },
];

function unquoteSimpleTokens(command: string): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "\\" && i + 1 < command.length) {
      const next = command[i + 1]!;
      if (/[A-Za-z0-9_./:-]/.test(next)) {
        out += next;
        i += 2;
        continue;
      }
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === "'" || (ch === "$" && command[i + 1] === "'")) {
      const isAnsi = ch === "$";
      const startQuote = i;
      i += isAnsi ? 2 : 1;
      let inner = "";
      while (i < command.length && command[i] !== "'") {
        if (isAnsi && command[i] === "\\" && i + 1 < command.length) {
          inner += command[i + 1]!;
          i += 2;
          continue;
        }
        inner += command[i]!;
        i += 1;
      }
      const closed = i < command.length;
      if (closed) i += 1;
      if (closed && SIMPLE_TOKEN_RE.test(inner)) {
        out += inner;
      } else {
        out += command.slice(startQuote, i);
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function scanMaskedShellSegment(
  command: string,
  startIndex: number,
  endChar?: ")" | "`",
): { masked: string; nextIndex: number } {
  let out = "";
  let i = startIndex;
  let parenDepth = 0;

  while (i < command.length) {
    const ch = command[i]!;
    if (endChar === ")" && ch === "(") {
      parenDepth += 1;
      out += "(";
      i += 1;
      continue;
    }
    if (endChar === ")" && ch === ")") {
      if (parenDepth === 0) {
        return { masked: out, nextIndex: i + 1 };
      }
      parenDepth -= 1;
      out += ")";
      i += 1;
      continue;
    }
    if (endChar === "`" && ch === "`") {
      return { masked: out, nextIndex: i + 1 };
    }

    if (ch === "\\" && i + 1 < command.length) {
      const next = command[i + 1]!;
      if (/[A-Za-z0-9_./:-]/.test(next)) {
        out += next;
      } else {
        out += ch + next;
      }
      i += 2;
      continue;
    }

    if (ch === "'" || (ch === "$" && command[i + 1] === "'")) {
      const isAnsi = ch === "$";
      i += isAnsi ? 2 : 1;
      let inner = "";
      while (i < command.length && command[i] !== "'") {
        if (isAnsi && command[i] === "\\" && i + 1 < command.length) {
          inner += command[i + 1]!;
          i += 2;
          continue;
        }
        inner += command[i]!;
        i += 1;
      }
      const closed = i < command.length;
      if (closed) {
        i += 1;
      }
      if (closed && SIMPLE_TOKEN_RE.test(inner)) {
        out += inner;
      } else {
        out += closed ? "''" : "'";
      }
      continue;
    }

    if (ch === '"') {
      i += 1;
      let literalInner = "";
      let hasCmdSub = false;
      let subOut = '"';
      while (i < command.length && command[i] !== '"') {
        const inner = command[i]!;
        if (inner === "\\" && i + 1 < command.length) {
          hasCmdSub = true; // Force masking unless simple unescaped token
          i += 2;
          continue;
        }
        if (inner === "`") {
          hasCmdSub = true;
          const nested = scanMaskedShellSegment(command, i + 1, "`");
          subOut += `\`${nested.masked}\``;
          i = nested.nextIndex;
          continue;
        }
        if (inner === "$" && command[i + 1] === "(") {
          hasCmdSub = true;
          const nested = scanMaskedShellSegment(command, i + 2, ")");
          subOut += `$(${nested.masked})`;
          i = nested.nextIndex;
          continue;
        }
        literalInner += inner;
        i += 1;
      }
      const closed = i < command.length;
      if (closed) {
        i += 1;
      }
      if (closed && !hasCmdSub && SIMPLE_TOKEN_RE.test(literalInner)) {
        out += literalInner;
      } else {
        out += closed ? `${subOut}"` : subOut;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return { masked: out, nextIndex: i };
}

function maskQuotedShellLiterals(command: string): string {
  const { masked } = scanMaskedShellSegment(command, 0);
  // Preserve shell-eval invocations (`sh -c`, `/bin/bash -c`, `eval`) when invoked at command position.
  if (SHELL_EVAL_CMD_RE.test(masked)) {
    return unquoteSimpleTokens(command);
  }
  return masked;
}

/**
 * Guard for bash commands executed by an independent read-only Validator.
 * Rejects file writes, redirects, mutating git commands, and package mutations
 * while permitting inspection and verification commands (git diff/log/show, tests, typecheck, lint).
 */
export function isReadOnlyValidationCommand(command: string): CommandGuardResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: true };
  }
  const normalized = maskQuotedShellLiterals(trimmed);
  for (const rule of VALIDATOR_FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      return { allowed: false, reason: rule.reason };
    }
  }
  return { allowed: true };
}

/**
 * Guard for bash commands executed by a Worker.
 * Blocks direct mutation of `.pi/swarm/` / `.swarm/` / `.git/` internals and manual
 * `git merge` / `git push` / `git worktree` (and switching to `baseBranch` when isolated).
 */
export function isForbiddenWorkerBashCommand(
  command: string,
  baseBranch = "",
  worktreePath = "",
): CommandGuardResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: true };
  }

  let pathChecked = trimmed;
  if (worktreePath.trim()) {
    const posixWt = path.resolve(worktreePath).replace(/\\/g, "/");
    pathChecked = pathChecked.split(posixWt).join(".");
    if (worktreePath !== posixWt) {
      pathChecked = pathChecked.split(worktreePath).join(".");
    }
  }
  const pathCheckedNoBenignRedir = pathChecked.replace(/(?:\d*>\s*\/dev\/null|\d*>&\d+)/g, "");

  if (
    /(?:^|[\s"'`\/])(?:\.pi\/swarm|\.swarm|\.git)(?:\/|$|\s|["'`])/.test(pathChecked) &&
    /(?:>|>>|\b(?:rm|mv|cp|tee|touch|mkdir|chmod|truncate|sed\s+-i|perl\s+-i|cat\s+<<)\b)/.test(
      pathCheckedNoBenignRedir,
    )
  ) {
    return {
      allowed: false,
      reason: `Workers are forbidden from mutating \`${SWARM_DIR}/\` or \`.git/\` directly. Use Swarm tools instead.`,
    };
  }

  const masked = maskQuotedShellLiterals(trimmed);
  const workerGitRe = new RegExp(
    `${GIT_PREFIX_RE}\\s+(?:merge|push|worktree)(?=\\s|$|[;&|)\\r\\n\`"'])`,
  );
  if (workerGitRe.test(masked)) {
    return {
      allowed: false,
      reason:
        "Workers must not run `git merge`, `git push`, or `git worktree`. Only the Swarm Orchestrator merges.",
    };
  }

  if (baseBranch) {
    const escapedBase = baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const checkoutBaseRe = new RegExp(
      `${GIT_PREFIX_RE}\\s+(?:checkout|switch)(?:\\s+(?:-[fFbBcC]+|--(?:force|create|force-create|discard-changes|guess|no-guess|merge|detach)))*\\s+${escapedBase}(?:\\s|$|[;&|)])`,
    );
    if (checkoutBaseRe.test(masked)) {
      return {
        allowed: false,
        reason: `Workers must stay on their worktree branch and must not switch to base branch \`${baseBranch}\`.`,
      };
    }
  }

  return { allowed: true };
}

// ============================================================================
// TRUE Conversation Forking Helpers
// ============================================================================

function cloneAgentMessage(msg: AgentMessage): AgentMessage | null {
  try {
    return structuredClone(msg);
  } catch {
    try {
      return JSON.parse(JSON.stringify(msg)) as AgentMessage;
    } catch {
      return null;
    }
  }
}

/**
 * Extracts a safe cloned snapshot of `AgentMessage[]` from a Pi `SessionManager` or
 * `ReadonlySessionManager` (`buildSessionContext` or `buildSessionProjection`).
 */
export function extractSessionMessages(sessionManager: unknown): AgentMessage[] {
  if (!sessionManager || typeof sessionManager !== "object") {
    return [];
  }
  const sm = sessionManager as {
    buildSessionContext?: () => { messages?: AgentMessage[] };
    buildSessionProjection?: () => { messages?: AgentMessage[] };
  };

  let raw: AgentMessage[] | undefined;
  try {
    if (typeof sm.buildSessionContext === "function") {
      raw = sm.buildSessionContext()?.messages;
    } else if (typeof sm.buildSessionProjection === "function") {
      raw = sm.buildSessionProjection()?.messages;
    }
  } catch {
    raw = undefined;
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const cloned: AgentMessage[] = [];
  for (const msg of raw) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const copy = cloneAgentMessage(msg);
    if (copy) {
      cloned.push(copy);
    }
  }
  return cloned;
}

/**
 * Deep-clones and sanitizes forked conversation messages before seeding into a new
 * `SessionManager.inMemory`, stripping any dangling unresolved `toolCall` blocks
 * (e.g. when forking `"orchestrator"` mid-`swarm{action:"add"}` tool execution) and
 * orphaned `toolResult` messages so downstream LLM providers never reject the fork.
 */
export function sanitizeForkSeedMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const cloned: AgentMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || !("role" in raw)) {
      continue;
    }
    const copy = cloneAgentMessage(raw);
    if (copy) {
      cloned.push(copy);
    }
  }
  if (cloned.length === 0) {
    return [];
  }

  // Collect all toolCallIds that actually have a matching toolResult message
  const resolvedToolCallIds = new Set<string>();
  for (const msg of cloned) {
    const rec = msg as unknown as Record<string, unknown>;
    if (rec.role === "toolResult" && typeof rec.toolCallId === "string" && rec.toolCallId) {
      resolvedToolCallIds.add(rec.toolCallId);
    }
  }

  // Collect kept toolCallIds emitted by assistant messages
  const keptToolCallIds = new Set<string>();
  const intermediate: AgentMessage[] = [];

  for (const msg of cloned) {
    if (isAssistantMessage(msg) && Array.isArray(msg.content)) {
      let strippedAnyToolCall = false;
      let filteredContent = msg.content.filter((part) => {
        if (part && typeof part === "object" && part.type === "toolCall") {
          const id = typeof part.id === "string" ? part.id : "";
          if (!id || !resolvedToolCallIds.has(id)) {
            strippedAnyToolCall = true;
            return false;
          }
          keptToolCallIds.add(id);
          return true;
        }
        return true;
      });
      if (strippedAnyToolCall) {
        filteredContent = filteredContent.filter(
          (part) => !(part && typeof part === "object" && part.type === "thinking"),
        );
      }
      const hasKeptToolCallOrText = filteredContent.some((part) => {
        if (!part || typeof part !== "object") {
          return false;
        }
        if (part.type === "toolCall") {
          return true;
        }
        if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
          return true;
        }
        return false;
      });
      if (!hasKeptToolCallOrText) {
        continue;
      }
      intermediate.push({
        ...msg,
        content: filteredContent,
        ...(strippedAnyToolCall ? { stopReason: "stop" } : {}),
      });
      continue;
    }
    intermediate.push(msg);
  }

  // Drop orphaned toolResults whose assistant toolCall was stripped or absent
  return intermediate.filter((msg) => {
    const rec = msg as unknown as Record<string, unknown>;
    if (rec.role === "toolResult" && typeof rec.toolCallId === "string") {
      return keptToolCallIds.has(rec.toolCallId);
    }
    return true;
  });
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hasDanglingToolCalls(messages: readonly AgentMessage[]): boolean {
  const sanitized = sanitizeForkSeedMessages(messages);
  if (sanitized.length !== messages.length) {
    return true;
  }
  for (let i = 0; i < messages.length; i++) {
    const a = messages[i];
    const b = sanitized[i];
    if (isAssistantMessage(a) && isAssistantMessage(b)) {
      const aParts = Array.isArray(a.content) ? a.content.length : 0;
      const bParts = Array.isArray(b.content) ? b.content.length : 0;
      if (aParts !== bParts) {
        return true;
      }
    }
  }
  return false;
}

async function openOrCreateMemberSessionManager(
  request: SpawnMemberRequest,
): Promise<SessionManager> {
  if (request.sessionFile && (await fileExists(request.sessionFile))) {
    try {
      const opened = SessionManager.open(
        request.sessionFile,
        request.sessionDir,
        request.cwd,
      );
      const existingMsgs = extractSessionMessages(opened);
      if (!hasDanglingToolCalls(existingMsgs)) {
        return opened;
      }
      // Recovered from a crash mid-tool-call: open fresh persisted session seeded with sanitized history
      if (request.sessionDir) {
        await mkdir(request.sessionDir, { recursive: true });
        const fresh = SessionManager.create(request.cwd, request.sessionDir);
        seedMessagesIntoSessionManager(fresh, existingMsgs);
        return fresh;
      }
      const freshMem = SessionManager.inMemory(request.cwd);
      seedMessagesIntoSessionManager(freshMem, existingMsgs);
      return freshMem;
    } catch {
      // Fall through to creating a new session if corrupt
    }
  }

  if (request.sessionDir && !request.isMonitor) {
    await mkdir(request.sessionDir, { recursive: true });
    const created = SessionManager.create(request.cwd, request.sessionDir);
    if (request.seedMessages && request.seedMessages.length > 0) {
      seedMessagesIntoSessionManager(created, request.seedMessages);
    }
    return created;
  }

  const inMem = SessionManager.inMemory(request.cwd);
  if (request.seedMessages && request.seedMessages.length > 0) {
    seedMessagesIntoSessionManager(inMem, request.seedMessages);
  }
  return inMem;
}

function seedMessagesIntoSessionManager(
  sessionManager: SessionManager,
  seedMessages: readonly AgentMessage[],
): void {
  const sanitized = sanitizeForkSeedMessages(seedMessages);
  for (const msg of sanitized) {
    try {
      const rec = msg as unknown as Record<string, unknown>;
      if (rec.role === "compactionSummary") {
        const summary = typeof rec.summary === "string" ? rec.summary : "";
        const tokensBefore = typeof rec.tokensBefore === "number" ? rec.tokensBefore : 0;
        if (summary) {
          sessionManager.appendCompaction(summary, null, tokensBefore);
        }
        continue;
      }
      if (rec.role === "branchSummary") {
        const summary = typeof rec.summary === "string" ? rec.summary : "";
        if (summary) {
          sessionManager.appendCustomMessageEntry(
            "pi-swarm-fork-branch-summary",
            summary,
            false,
          );
        }
        continue;
      }
      if (
        rec.role === "custom" &&
        typeof (sessionManager as any).appendCustomMessageEntry === "function"
      ) {
        sessionManager.appendCustomMessageEntry(
          String(rec.customType ?? "custom"),
          rec.content as any,
          Boolean(rec.display),
          rec.details,
        );
        continue;
      }
      sessionManager.appendMessage(
        msg as Parameters<SessionManager["appendMessage"]>[0],
      );
    } catch {
      // Skip malformed/incompatible seed entry safely so fork never crashes
    }
  }
}

// ============================================================================
// Guard Extension Factories & Fallback Bridge
// ============================================================================

export function createWorkerGuardExtensionFactory(
  request: SpawnMemberRequest,
  baseBranch?: string,
): ExtensionFactory {
  const isIsolated = request.workspace !== "inherit";
  const branchLabel =
    isIsolated && request.branch ? ` on branch "${request.branch}"` : "";
  const allowedLocationHint = isIsolated
    ? `Allowed worktree: "${request.cwd}"${branchLabel}. Use paths inside "${request.cwd}" (or relative paths).`
    : `Allowed working directory: "${request.cwd}". Use paths inside "${request.cwd}" (or relative paths).`;

  return (pi) => {
    pi.on("tool_call", (event) => {
      if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
        const rawPath = event.input.path;
        const rel = resolveWorktreeRelativePath(request.cwd, rawPath);
        if (rel === null) {
          return {
            block: true,
            reason: `Path "${rawPath}" escapes worktree root "${request.cwd}"${branchLabel}. ${allowedLocationHint}`,
          };
        }
        if (isProtectedSwarmPath(rel)) {
          return {
            block: true,
            reason: `Workers are forbidden from editing protected path "${rel}" (${SWARM_DIR}/, .swarm/, or .git/). ${allowedLocationHint}`,
          };
        }
        return undefined;
      }

      if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
        const enforceBaseBranchGuard =
          request.workspace !== "inherit" ||
          Boolean(request.isIsolatedWorktree) ||
          Boolean(request.branch);
        const check = isForbiddenWorkerBashCommand(
          event.input.command,
          enforceBaseBranchGuard ? (baseBranch ?? "") : "",
          request.cwd,
        );
        if (!check.allowed) {
          const baseReason = check.reason ?? "Command is forbidden in worker sessions.";
          return {
            block: true,
            reason: `${baseReason} ${allowedLocationHint}`,
          };
        }
      }

      return undefined;
    });
  };
}

function createValidatorGuardExtensionFactory(
  memberName: string,
  enforceReadOnlyBash: boolean,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event) ||
        isToolCallEventType("powershell", event)
      ) {
        return {
          block: true,
          reason: `Independent validator @${memberName} is strictly read-only. Tool "${event.toolName}" is blocked.`,
        };
      }

      if (enforceReadOnlyBash && isToolCallEventType("bash", event)) {
        const check = isReadOnlyValidationCommand(event.input.command);
        if (!check.allowed) {
          return {
            block: true,
            reason:
              check.reason ??
              `Mutating bash commands are blocked in read-only validator @${memberName} sessions.`,
          };
        }
      }

      return undefined;
    });
  };
}

function createFallbackBridge(request: SpawnMemberRequest): MemberEngineBridge {
  return {
    async postMessage() {
      throw new SwarmProtocolError(
        "NOT_FOUND",
        `No Swarm engine bridge attached to member "@${request.name}".`,
      );
    },
    async readBoard() {
      return { messages: [], head: 0 };
    },
    async getStatus() {
      return {
        runId: request.runId,
        title: request.runId,
        status: "active",
        baseBranch: request.branch ?? "main",
        boardHead: 0,
        members: [],
        channels: [],
      };
    },
    async listModels() {
      return [];
    },
    async addHelper() {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `No Swarm engine bridge attached to member "@${request.name}".`,
      );
    },
    async killHelper() {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `No Swarm engine bridge attached to member "@${request.name}".`,
      );
    },
    async switchModel() {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `No Swarm engine bridge attached to member "@${request.name}".`,
      );
    },
    async manageChannel() {
      throw new SwarmProtocolError(
        "PERMISSION_DENIED",
        `No Swarm engine bridge attached to member "@${request.name}".`,
      );
    },
  };
}

// ============================================================================
// Telemetry & Assistant Message Extraction Helpers
// ============================================================================

const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const TELEMETRY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const THINKING_THROTTLE_MS = 1500;
const TOOL_UPDATE_THROTTLE_MS = 1500;

function formatToolActivity(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return toolName;
  }
  const record = args as Record<string, unknown>;
  const target =
    (typeof record.path === "string" && record.path) ||
    (typeof record.command === "string" && record.command.slice(0, 60)) ||
    (typeof record.pattern === "string" && record.pattern.slice(0, 40)) ||
    (typeof record.action === "string" && record.action) ||
    (typeof record.name === "string" && record.name) ||
    "";
  return target ? `${toolName}: ${target}` : toolName;
}

function cleanTelemetryLine(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_RE, "")
    .replace(TELEMETRY_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLastNonEmptyLine(raw: string, maxChars = 72): string {
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const cleaned = cleanTelemetryLine(lines[i] ?? "");
    if (cleaned.length > 0) {
      return cleaned.length > maxChars
        ? `${cleaned.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
        : cleaned;
    }
  }
  return "";
}

function extractToolUpdateTail(partialResult: unknown, maxChars = 72): string {
  if (typeof partialResult === "string") {
    return extractLastNonEmptyLine(partialResult, maxChars);
  }
  if (!partialResult || typeof partialResult !== "object") {
    return "";
  }
  const rec = partialResult as Record<string, unknown>;
  if (Array.isArray(rec.content)) {
    for (let i = rec.content.length - 1; i >= 0; i--) {
      const part = rec.content[i];
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const line = extractLastNonEmptyLine((part as { text: string }).text, maxChars);
        if (line) {
          return line;
        }
      }
    }
  }
  for (const key of ["stdout", "output", "text"] as const) {
    if (typeof rec[key] === "string") {
      const line = extractLastNonEmptyLine(rec[key] as string, maxChars);
      if (line) {
        return line;
      }
    }
  }
  return "";
}

function formatThinkingActivity(thinkingTail: string): string {
  const line = extractLastNonEmptyLine(thinkingTail, 56);
  return line ? `thinking… ${line}` : "thinking…";
}

function extractToolCallStartName(
  assistantMessageEvent: Extract<
    Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
    { type: "toolcall_start" }
  >,
): string {
  const partialContent = assistantMessageEvent.partial?.content;
  if (Array.isArray(partialContent)) {
    const block = partialContent[assistantMessageEvent.contentIndex];
    if (
      block &&
      typeof block === "object" &&
      "name" in block &&
      typeof block.name === "string" &&
      block.name.trim().length > 0
    ) {
      return block.name.trim();
    }
  }
  const raw = assistantMessageEvent as unknown as Record<string, unknown>;
  if (typeof raw.toolName === "string" && raw.toolName.trim().length > 0) {
    return raw.toolName.trim();
  }
  if (typeof raw.name === "string" && raw.name.trim().length > 0) {
    return raw.name.trim();
  }
  return "";
}

function extractAssistantText(message: AssistantMessage | undefined): string {
  if (!message) {
    return "";
  }
  const texts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  return texts.join("\n");
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant"
  );
}

// ============================================================================
// InProcessPiTransport (Pi 1.3–1.6 SDK — Warm Persistent Sessions + Forking)
// ============================================================================

export interface InProcessPiTransportOptions {
  /** Override agentDir (defaults to Pi's getAgentDir()). */
  agentDir?: string;
  /** Enforce read-only bash guard inside validator sessions (default true). */
  validatorReadOnlyBash?: boolean;
  /** Optional session factory override (defaults to Pi's `createAgentSession`, for deterministic tests). */
  createSession?: typeof createAgentSession;
}

/**
 * In-process multi-agent transport backed by Pi's `createAgentSession`.
 *
 * Preserves all Pi 1.3–1.6 SDK invariants:
 * - Shared host `ModelRuntime` (with lazy `ModelRuntime.create` fallback + provider copy)
 * - `SettingsManager.create(cwd, agentDir)` + `SessionManager.inMemory(cwd)`
 * - TRUE conversation forking (`seedMessages` appended before `createAgentSession`)
 * - `DefaultResourceLoader({ noExtensions: true, appendSystemPrompt, extensionFactories })` + `reload()` + `bindExtensions({})`
 * - Scoped 4-tool Antigravity Swarm toolset (`swarm`, `post_message`, `read_board`, `swarm_wait`) inside `options.tools`
 * - `WeakSet<AgentSession>` leak-free disposal on early `kill()`
 * - `switchingModel` lock + strict `state === "waiting"` + post-await session checks
 * - Compaction-safe `message_end` tracking + `stopReason === "error"` / 429 detection
 */
export class InProcessPiTransport implements ISwarmTransport {
  private readonly agentDirOverride?: string;
  private readonly validatorReadOnlyBash: boolean;
  private readonly createSessionFn: typeof createAgentSession;
  private fallbackRuntimePromise?: Promise<ModelRuntime>;

  constructor(options: InProcessPiTransportOptions = {}) {
    this.agentDirOverride = options.agentDir;
    this.validatorReadOnlyBash = options.validatorReadOnlyBash ?? true;
    this.createSessionFn = options.createSession ?? createAgentSession;
  }

  async resolveModel(
    modelOverride: string,
    thinkingLevel?: ThinkingLevel,
    hostContext?: ExtensionContext,
  ): Promise<ModelSwitchResult> {
    const trimmed = modelOverride.trim();
    if (!trimmed) {
      throw new SwarmProtocolError("MODEL_NOT_FOUND", "Model identifier must be non-empty.");
    }
    const parsed = parseModelSpec(trimmed);
    const cliThinking = thinkingLevel ?? parsed.thinkingLevel;
    const agentDir = this.agentDirOverride ?? getAgentDir();
    const runtime = await this.resolveModelRuntime(hostContext, agentDir);
    const cliRes = resolveCliModel({
      cliModel: parsed.model || trimmed,
      cliThinking,
      modelRuntime: runtime,
    });
    if (!cliRes.model) {
      throw new SwarmProtocolError(
        "MODEL_NOT_FOUND",
        `Model "${trimmed}" could not be resolved in the active Pi model registry.`,
        { modelOverride: trimmed },
      );
    }
    const resolvedId = formatModelId(cliRes.model) ?? (parsed.model || trimmed);
    const rawThinking = cliThinking ?? cliRes.thinkingLevel;
    const effectiveThinking =
      cliRes.model.reasoning === false
        ? (rawThinking !== undefined ? "off" : undefined)
        : rawThinking;
    return {
      model: resolvedId,
      ...(effectiveThinking ? { thinkingLevel: effectiveThinking } : {}),
    };
  }

  async listAvailableModels(
    hostContext?: ExtensionContext,
  ): Promise<AvailableModelInfo[]> {
    try {
      const agentDir = this.agentDirOverride ?? getAgentDir();
      const runtime = await this.resolveModelRuntime(hostContext, agentDir);
      let rawModels = runtime.getAvailableSnapshot();
      if (rawModels.length === 0) {
        rawModels = runtime.getModels();
      }

      const seen = new Set<string>();
      const result: AvailableModelInfo[] = [];
      for (const m of rawModels) {
        if (!m?.id) {
          continue;
        }
        const provider = m.provider ?? "";
        const fullId = provider ? `${provider}/${m.id}` : m.id;
        const key = fullId.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push({
          id: m.id,
          provider,
          fullId,
          name: m.name,
          reasoning: Boolean(m.reasoning),
          contextWindow: m.contextWindow,
        });
      }
      return result;
    } catch {
      // Fallback to host modelRegistry if ModelRuntime lookup fails
      try {
        const reg = hostContext?.modelRegistry;
        const list = reg?.getAvailable?.() ?? reg?.getAll?.() ?? [];
        return list
          .filter((m) => Boolean(m?.id))
          .map((m) => ({
            id: m.id,
            provider: m.provider ?? "",
            fullId: m.provider ? `${m.provider}/${m.id}` : m.id,
            name: m.name,
            reasoning: Boolean(m.reasoning),
            contextWindow: m.contextWindow,
          }));
      } catch {
        return [];
      }
    }
  }

  async spawnMember(request: SpawnMemberRequest): Promise<PersistentAgentHandle> {
    let session: AgentSession | undefined;
    let modelRuntime: ModelRuntime | undefined;
    let unsubscribe: (() => void) | undefined;
    const disposedSessions = new WeakSet<AgentSession>();

    let state: SwarmMemberState = "working";
    const getCurrentState = (): SwarmMemberState => state;
    let currentModelId: string | undefined =
      request.modelOverride?.trim() || formatModelId(request.hostContext?.model);
    let currentThinkingLevel: ThinkingLevel | undefined = request.thinkingLevel;
    const initialSessionManager = await openOrCreateMemberSessionManager(request);
    let currentSessionFile: string | undefined =
      initialSessionManager.getSessionFile() ?? request.sessionFile;
    const initialMessages = extractSessionMessages(initialSessionManager);
    let cachedMessages: AgentMessage[] =
      initialMessages.length > 0
        ? initialMessages
        : request.seedMessages
          ? sanitizeForkSeedMessages(request.seedMessages)
          : [];

    let promptActive = false;
    let endTurnRequested = false;
    let switchingModel = false;
    let killed = false;
    let sessionBaselineTokens = 0;
    let sessionBaselineBreakdown: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    };
    let sessionBaselineCost = 0;
    const isKilled = (): boolean => killed;
    let abortedByCaller = false;
    const isAbortedByCaller = (): boolean => abortedByCaller;
    let abortReason: string | undefined;
    const assistantRef: { current: AssistantMessage | undefined } = { current: undefined };
    const getLastAssistant = (): AssistantMessage | undefined => assistantRef.current;
    let lastTextEmitAt = 0;
    let lastThinkingEmitAt = 0;
    let thinkingTail = "";
    let lastToolUpdateEmitAt = 0;
    let lastToolUpdateActivity = "";

    const pendingSteers: Array<{ text: string; mode: "steer" | "followUp" }> = [];

    const emitTelemetry = (
      partial: Omit<AgentTelemetryEvent, "agentId" | "name" | "role" | "runId" | "timestamp">,
    ): void => {
      if (!request.onTelemetry) {
        return;
      }
      try {
        request.onTelemetry({
          agentId: request.agentId,
          name: request.name,
          role: request.role,
          runId: request.runId,
          timestamp: new Date().toISOString(),
          model: currentModelId,
          thinkingLevel: currentThinkingLevel,
          ...partial,
        });
      } catch {
        // telemetry errors must never crash agent execution
      }
    };

    const allowedTools: string[] = request.isMonitor
      ? [POST_MESSAGE_TOOL, READ_BOARD_TOOL]
      : request.role === "validator"
        ? Array.from(
            new Set<string>([
              ...VALIDATOR_BUILTIN_TOOLS,
              "bash",
              SWARM_TOOL,
              POST_MESSAGE_TOOL,
              READ_BOARD_TOOL,
              SWARM_WAIT_TOOL,
            ]),
          )
        : Array.from(new Set<string>([...WORKER_BUILTIN_TOOLS, ...SWARM_CORE_TOOLS]));

    const bridge = request.engineApi ?? createFallbackBridge(request);
    const allMemberTools: ToolDefinition[] = createMemberScopedTools(bridge, {
      name: request.name,
      role: request.role,
      runId: request.runId,
      defaultChannel: request.channels?.[0],
      onWaitRecorded: ({ since, mentionsOnly }) => {
        endTurnRequested = true;
        emitTelemetry({
          type: "waiting",
          activity: `waiting (since #${since})`,
          logLine: `swarm_wait since=#${since} mentions_only=${mentionsOnly}`,
        });
      },
      onSelfModelSwitchScheduled: () => {
        endTurnRequested = true;
      },
    });
    const customTools: ToolDefinition[] = request.isMonitor
      ? allMemberTools.filter(
          (t) => t.name === POST_MESSAGE_TOOL || t.name === READ_BOARD_TOOL,
        )
      : allMemberTools;

    const guardFactory: ExtensionFactory =
      request.role === "validator"
        ? createValidatorGuardExtensionFactory(request.name, this.validatorReadOnlyBash)
        : createWorkerGuardExtensionFactory(request, request.baseBranch);

    const readStats = (
      activeSession: AgentSession | undefined,
    ): { tokens: number; breakdown?: TokenUsage; cost: number } => {
      if (!activeSession) {
        return { tokens: 0, cost: 0 };
      }
      try {
        const stats = activeSession.getSessionStats();
        const deltaInput = Math.max(0, (stats.tokens.input ?? 0) - sessionBaselineBreakdown.input);
        const deltaOutput = Math.max(
          0,
          (stats.tokens.output ?? 0) - sessionBaselineBreakdown.output,
        );
        const deltaCacheRead = Math.max(
          0,
          (stats.tokens.cacheRead ?? 0) - sessionBaselineBreakdown.cacheRead,
        );
        const deltaCacheWrite = Math.max(
          0,
          (stats.tokens.cacheWrite ?? 0) - sessionBaselineBreakdown.cacheWrite,
        );
        const deltaTokens = Math.max(0, stats.tokens.total - sessionBaselineTokens);
        const deltaCost = Math.max(0, stats.cost - sessionBaselineCost);
        return {
          tokens: deltaTokens,
          breakdown: {
            input: deltaInput,
            output: deltaOutput,
            cacheRead: deltaCacheRead,
            cacheWrite: deltaCacheWrite,
            total: deltaTokens,
          },
          cost: deltaCost,
        };
      } catch {
        return { tokens: 0, cost: 0 };
      }
    };

    const snapshotSessionMessages = (activeSession: AgentSession | undefined): void => {
      if (!activeSession) {
        return;
      }
      const extracted = extractSessionMessages(activeSession.sessionManager);
      if (extracted.length > 0) {
        cachedMessages = extracted;
      }
    };

    const disposeSessionOnce = async (targetSession?: AgentSession): Promise<void> => {
      const activeSession = targetSession ?? session;
      if (!activeSession) {
        unsubscribe?.();
        unsubscribe = undefined;
        return;
      }
      snapshotSessionMessages(activeSession);
      if (session === activeSession) {
        session = undefined;
      }
      unsubscribe?.();
      unsubscribe = undefined;
      if (disposedSessions.has(activeSession)) {
        return;
      }
      disposedSessions.add(activeSession);
      try {
        if (activeSession.extensionRunner?.hasHandlers("session_shutdown")) {
          await activeSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } catch {
        // ignore shutdown hook errors
      }
      try {
        activeSession.dispose();
      } catch {
        // ignore dispose error
      }
    };

    const makeEarlyAbortResult = (): AgentTurnResult => {
      const outcome: AgentTurnOutcome = killed ? "killed" : "stopped";
      state = outcome;
      const reason = abortReason ?? (killed ? "Killed before session start" : "Stopped before session start");
      if (!killed) {
        emitTelemetry({
          type: "stopped",
          model: currentModelId,
          activity: "stopped",
          logLine: `stopped: ${reason}`,
          error: reason,
        });
      }
      return {
        agentId: request.agentId,
        name: request.name,
        role: request.role,
        outcome,
        summary: reason,
        model: currentModelId,
        thinkingLevel: currentThinkingLevel,
        tokens: 0,
        cost: 0,
        error: reason,
        stopReason: "aborted",
      };
    };

    const runPromptTurn = async (
      promptText: string,
      options: { isInitialTurn: boolean },
    ): Promise<AgentTurnResult> => {
      let caughtError: unknown;
      assistantRef.current = undefined;
      endTurnRequested = false;
      thinkingTail = "";
      lastThinkingEmitAt = 0;
      lastToolUpdateEmitAt = 0;
      lastToolUpdateActivity = "";

      try {
        if (options.isInitialTurn) {
          const agentDir = this.agentDirOverride ?? getAgentDir();
          modelRuntime = await this.resolveModelRuntime(request.hostContext, agentDir);
          const settingsManager = SettingsManager.create(request.cwd, agentDir);
          const sessionManager = initialSessionManager;
          currentSessionFile = sessionManager.getSessionFile() ?? currentSessionFile;

          let resolvedModel = request.hostContext?.model;
          let resolvedThinking = request.thinkingLevel;

          if (request.modelOverride?.trim()) {
            const parsedOverride = parseModelSpec(request.modelOverride.trim());
            const cliThinking = request.thinkingLevel ?? parsedOverride.thinkingLevel;
            const cliRes = resolveCliModel({
              cliModel: parsedOverride.model || request.modelOverride.trim(),
              cliThinking,
              modelRuntime,
            });
            if (cliRes.model) {
              resolvedModel = cliRes.model;
            }
            if (!resolvedThinking && (cliThinking ?? cliRes.thinkingLevel)) {
              resolvedThinking = cliThinking ?? cliRes.thinkingLevel;
            }
          }

          if (killed || abortedByCaller) {
            return makeEarlyAbortResult();
          }

          const resourceLoader = request.isMonitor
            ? new DefaultResourceLoader({
                cwd: request.cwd,
                agentDir,
                settingsManager,
                noExtensions: true,
                noSkills: true,
                noContextFiles: true,
                noThemes: true,
                noPromptTemplates: true,
                ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
                appendSystemPrompt: [],
                extensionFactories: [],
              })
            : new DefaultResourceLoader({
                cwd: request.cwd,
                agentDir,
                settingsManager,
                noExtensions: true,
                noThemes: true,
                noPromptTemplates: true,
                appendSystemPrompt: request.systemPrompt ? [request.systemPrompt] : [],
                extensionFactories: [guardFactory],
              });
          await resourceLoader.reload();

          if (killed || abortedByCaller) {
            return makeEarlyAbortResult();
          }

          const created = await this.createSessionFn({
            cwd: request.cwd,
            agentDir,
            modelRuntime,
            model: resolvedModel,
            thinkingLevel: resolvedThinking,
            tools: allowedTools,
            customTools,
            resourceLoader,
            sessionManager,
            settingsManager,
          });

          if (killed || abortedByCaller) {
            await disposeSessionOnce(created.session);
            return makeEarlyAbortResult();
          }

          session = created.session;
          await session.bindExtensions({});
          if (killed || abortedByCaller || !session) {
            await disposeSessionOnce(created.session);
            return makeEarlyAbortResult();
          }
          currentSessionFile = session.sessionManager?.getSessionFile?.() ?? currentSessionFile;
          try {
            const baseline = session.getSessionStats();
            sessionBaselineTokens = Math.max(0, baseline.tokens.total);
            sessionBaselineBreakdown = {
              input: Math.max(0, baseline.tokens.input ?? 0),
              output: Math.max(0, baseline.tokens.output ?? 0),
              cacheRead: Math.max(0, baseline.tokens.cacheRead ?? 0),
              cacheWrite: Math.max(0, baseline.tokens.cacheWrite ?? 0),
              total: Math.max(0, baseline.tokens.total ?? 0),
            };
            sessionBaselineCost = Math.max(0, baseline.cost);
          } catch {
            sessionBaselineTokens = 0;
            sessionBaselineBreakdown = {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            };
            sessionBaselineCost = 0;
          }

          // Guarantee immediate turn termination when `swarm_wait` (or self `model` switch) runs
          // inside the same parallel tool batch alongside `post_message`!
          const sessionAgent = (session as unknown as {
            agent?: {
              finishTurn?: (turn: unknown, signal?: AbortSignal) => Promise<{ action: "end" | "continue" } | undefined>;
            };
          }).agent;
          if (sessionAgent) {
            const prevFinishTurn = sessionAgent.finishTurn?.bind(sessionAgent);
            sessionAgent.finishTurn = async (turn, sig) => {
              if (endTurnRequested) {
                return { action: "end" };
              }
              return prevFinishTurn ? prevFinishTurn(turn, sig) : undefined;
            };
          }

          if (killed || abortedByCaller) {
            await disposeSessionOnce(created.session);
            return makeEarlyAbortResult();
          }

          currentModelId = formatModelId(session.model ?? resolvedModel) ?? currentModelId;
          currentThinkingLevel =
            resolvedThinking !== undefined
              ? (session.thinkingLevel ?? resolvedThinking)
              : undefined;

          unsubscribe = session.subscribe((event: AgentSessionEvent) => {
            switch (event.type) {
              case "tool_execution_start": {
                lastToolUpdateEmitAt = 0;
                lastToolUpdateActivity = "";
                const activity = formatToolActivity(event.toolName, event.args);
                emitTelemetry({
                  type: "tool_start",
                  toolName: event.toolName,
                  activity,
                  logLine: `> ${activity}`,
                });
                break;
              }
              case "tool_execution_update": {
                const now = Date.now();
                if (now - lastToolUpdateEmitAt >= TOOL_UPDATE_THROTTLE_MS) {
                  const tail = extractToolUpdateTail(event.partialResult);
                  if (tail) {
                    const activity = `${event.toolName}: ${tail}`;
                    if (activity !== lastToolUpdateActivity) {
                      lastToolUpdateEmitAt = now;
                      lastToolUpdateActivity = activity;
                      emitTelemetry({
                        type: "tool_start",
                        toolName: event.toolName,
                        activity,
                      });
                    }
                  }
                }
                break;
              }
              case "tool_execution_end": {
                lastToolUpdateEmitAt = 0;
                lastToolUpdateActivity = "";
                emitTelemetry({
                  type: "tool_end",
                  toolName: event.toolName,
                  activity: event.isError
                    ? `${event.toolName} (error)`
                    : `${event.toolName} (ok)`,
                  logLine: `< ${event.toolName} (${event.isError ? "error" : "ok"})`,
                });
                break;
              }
              case "message_update": {
                const msgEvt = event.assistantMessageEvent;
                if (msgEvt.type === "text_delta") {
                  const now = Date.now();
                  if (now - lastTextEmitAt >= 250) {
                    lastTextEmitAt = now;
                    const snippet = msgEvt.delta.replace(/\s+/g, " ").trim();
                    if (snippet) {
                      emitTelemetry({
                        type: "text_delta",
                        activity: "generating response",
                        logLine: snippet.slice(0, 120),
                      });
                    }
                  }
                } else if (msgEvt.type === "thinking_start") {
                  thinkingTail = "";
                  lastThinkingEmitAt = 0;
                } else if (msgEvt.type === "thinking_delta") {
                  thinkingTail = (thinkingTail + msgEvt.delta).slice(-240);
                  const now = Date.now();
                  if (now - lastThinkingEmitAt >= THINKING_THROTTLE_MS) {
                    lastThinkingEmitAt = now;
                    emitTelemetry({
                      type: "text_delta",
                      activity: formatThinkingActivity(thinkingTail),
                    });
                  }
                } else if (msgEvt.type === "toolcall_start") {
                  const toolName = extractToolCallStartName(msgEvt);
                  emitTelemetry({
                    type: "text_delta",
                    ...(toolName ? { toolName } : {}),
                    activity: toolName ? `preparing ${toolName}…` : "preparing tool call…",
                  });
                }
                break;
              }
              case "compaction_start": {
                emitTelemetry({
                  type: "usage_update",
                  activity: "compacting context…",
                  logLine: `compacting context (${event.reason})`,
                });
                break;
              }
              case "compaction_end": {
                emitTelemetry({
                  type: "usage_update",
                  activity: "",
                  logLine: event.aborted
                    ? "context compaction aborted"
                    : event.errorMessage
                      ? `context compaction error: ${event.errorMessage}`
                      : "context compaction finished",
                });
                break;
              }
              case "message_end": {
                if (isAssistantMessage(event.message)) {
                  assistantRef.current = event.message;
                }
                break;
              }
              case "thinking_level_changed": {
                currentThinkingLevel = event.level;
                break;
              }
              case "turn_end": {
                thinkingTail = "";
                lastThinkingEmitAt = 0;
                const usage = readStats(session);
                emitTelemetry({
                  type: "turn_end",
                  tokens: usage.tokens,
                  tokenBreakdown: usage.breakdown,
                  cost: usage.cost,
                });
                break;
              }
              case "auto_retry_start": {
                emitTelemetry({
                  type: "rate_limit",
                  activity: `retrying (${event.attempt}/${event.maxAttempts})`,
                  logLine: `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
                  error: event.errorMessage,
                });
                break;
              }
              default:
                break;
            }
          });

          emitTelemetry({
            type: "started",
            model: currentModelId,
            activity: request.role === "validator" ? "starting validation" : "starting assignment",
            logLine: `spawned ${request.role} @${request.name} (${request.agentId}) in ${request.cwd}`,
          });
        }

        if (!session) {
          throw new SwarmProtocolError(
            "MEMBER_KILLED",
            `Member "@${request.name}" session is no longer active.`,
          );
        }

        if (killed || abortedByCaller) {
          await session.abort();
        } else {
          promptActive = true;
          const promptPromise = session.prompt(promptText, { expandPromptTemplates: false });

          // Drain any early steer/followUp calls buffered before session.prompt() started
          if (pendingSteers.length > 0) {
            for (const queued of pendingSteers.splice(0, pendingSteers.length)) {
              if (killed || abortedByCaller) {
                break;
              }
              if (queued.mode === "followUp") {
                await session.followUp(queued.text).catch(() => {});
              } else {
                await session.steer(queued.text).catch(() => {});
              }
            }
          }

          await promptPromise;
        }
      } catch (err) {
        caughtError = err;
      } finally {
        promptActive = false;
        pendingSteers.length = 0;
      }

      // Snapshot stats & messages BEFORE potential disposal
      const usage = readStats(session);
      snapshotSessionMessages(session);

      // Classify turn outcome (session.prompt() does NOT throw on provider/quota/429 errors!)
      let outcome: AgentTurnOutcome = request.keepWarm && session ? "waiting" : "stopped";
      let errorText: string | undefined;
      let retryAfterMs: number | undefined;
      const finalAssistant = getLastAssistant();
      const stopReason = finalAssistant?.stopReason;

      if (killed) {
        outcome = "killed";
        errorText = abortReason ?? "Killed";
      } else if (abortedByCaller || stopReason === "aborted") {
        outcome = "stopped";
        errorText = abortReason ?? finalAssistant?.errorMessage ?? "Stopped";
      } else if (caughtError !== undefined) {
        errorText = caughtError instanceof Error ? caughtError.message : String(caughtError);
        if (isRateLimitOrTransientError(caughtError)) {
          outcome = "rate_limited";
          retryAfterMs = parseRetryAfterMs(caughtError);
        } else {
          outcome = "failed";
        }
      } else if (stopReason === "error") {
        errorText = finalAssistant?.errorMessage ?? "Provider returned stopReason=error";
        if (isRateLimitOrTransientError(errorText)) {
          outcome = "rate_limited";
          retryAfterMs = parseRetryAfterMs(errorText);
        } else {
          outcome = "failed";
        }
      }

      const summary = extractAssistantText(finalAssistant) || errorText || "";

      // Transition handle state cleanly (keep warm in `waiting` when keepWarm && session alive!)
      if (killed) {
        state = "killed";
        await disposeSessionOnce();
      } else if (request.keepWarm && session) {
        if (outcome === "waiting") {
          state = "waiting";
          emitTelemetry({
            type: "waiting",
            activity: "waiting (warm)",
            logLine: `@${request.name} parked warm in waiting state`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
          });
        } else if (outcome === "stopped") {
          state = "stopped";
          emitTelemetry({
            type: "stopped",
            activity: "stopped",
            logLine: `stopped: ${errorText ?? "aborted"}`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
            error: errorText,
          });
        } else if (outcome === "rate_limited") {
          // Keep warm in `waiting` so engine/orchestrator can hot-switch fallback model preserving history!
          state = "waiting";
          emitTelemetry({
            type: "rate_limit",
            activity: "rate limited (warm)",
            logLine: `rate_limited: ${errorText ?? "429"}`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
            error: errorText,
          });
        } else {
          // Keep warm in `waiting` with error recorded so Orchestrator can switch model or retry!
          state = "waiting";
          emitTelemetry({
            type: "error",
            activity: "error (warm)",
            logLine: `error: ${errorText ?? "turn failed"}`,
            tokens: usage.tokens,
            tokenBreakdown: usage.breakdown,
            cost: usage.cost,
            error: errorText,
          });
        }
      } else {
        state = "stopped";
        await disposeSessionOnce();
        emitTelemetry({
          type:
            outcome === "rate_limited"
              ? "rate_limit"
              : outcome === "failed"
                ? "error"
                : "stopped",
          activity: outcome,
          logLine: errorText ? `${outcome}: ${errorText}` : `${outcome}: ${summary.slice(0, 120)}`,
          tokens: usage.tokens,
          tokenBreakdown: usage.breakdown,
          cost: usage.cost,
          error: errorText,
        });
      }

      return {
        agentId: request.agentId,
        name: request.name,
        role: request.role,
        outcome,
        summary,
        model: currentModelId,
        thinkingLevel: currentThinkingLevel,
        tokens: usage.tokens,
        tokenBreakdown: usage.breakdown,
        cost: usage.cost,
        error: errorText,
        stopReason,
        retryAfterMs,
      };
    };

    let currentTurnPromise: Promise<AgentTurnResult> = runPromptTurn(request.initialPrompt, {
      isInitialTurn: true,
    });

    return {
      agentId: request.agentId,
      name: request.name,
      role: request.role,

      getState(): SwarmMemberState {
        return state;
      },

      getModel(): string | undefined {
        return currentModelId;
      },

      getThinkingLevel(): ThinkingLevel | undefined {
        return currentThinkingLevel;
      },

      getSessionFile(): string | undefined {
        return session?.sessionManager?.getSessionFile?.() ?? currentSessionFile;
      },

      getConversationMessages(): AgentMessage[] {
        if (session) {
          const liveMessages = extractSessionMessages(session.sessionManager);
          if (liveMessages.length > 0) {
            cachedMessages = liveMessages;
            return liveMessages;
          }
        }
        return sanitizeForkSeedMessages(cachedMessages);
      },

      async wake(prompt: string): Promise<AgentTurnResult> {
        if (killed || state === "killed") {
          throw new SwarmProtocolError(
            "MEMBER_KILLED",
            `Member "@${request.name}" (${request.agentId}) has been killed and cannot be woken.`,
          );
        }
        if (switchingModel) {
          throw new SwarmProtocolError(
            "MEMBER_NOT_WAITING",
            `Member "@${request.name}" (${request.agentId}) is currently switching models; retry wake once model switch completes.`,
          );
        }
        if (state !== "waiting" || promptActive) {
          throw new SwarmProtocolError(
            "MEMBER_NOT_WAITING",
            `Member "@${request.name}" (${request.agentId}) is not waiting (currently "${state}"); cannot wake.`,
          );
        }
        if (!session) {
          throw new SwarmProtocolError(
            "MEMBER_KILLED",
            `Member "@${request.name}" (${request.agentId}) does not have an active persistent session.`,
          );
        }

        // Preserve 100% conversation history on the exact same AgentSession!
        abortedByCaller = false;
        abortReason = undefined;
        state = "working";

        emitTelemetry({
          type: "woken",
          model: currentModelId,
          activity: "woken by board",
          logLine: `woken @${request.name}: ${prompt.replace(/\s+/g, " ").trim().slice(0, 100)}`,
        });

        currentTurnPromise = runPromptTurn(prompt, { isInitialTurn: false });
        return currentTurnPromise;
      },

      async steer(message: string): Promise<void> {
        if (killed || state === "killed" || abortedByCaller) {
          return;
        }
        if (!session || !promptActive) {
          if (state === "working") {
            pendingSteers.push({ text: message, mode: "steer" });
          }
          return;
        }
        await session.steer(message);
      },

      async followUp(message: string): Promise<void> {
        if (killed || state === "killed" || abortedByCaller) {
          return;
        }
        if (!session || !promptActive) {
          if (state === "working") {
            pendingSteers.push({ text: message, mode: "followUp" });
          }
          return;
        }
        await session.followUp(message);
      },

      async switchModel(
        modelOverride: string,
        thinkingLevel?: ThinkingLevel,
      ): Promise<ModelSwitchResult> {
        if (killed || state === "killed") {
          throw new SwarmProtocolError(
            "MEMBER_KILLED",
            `Member "@${request.name}" (${request.agentId}) has been killed and cannot switch models.`,
          );
        }
        if (switchingModel || state !== "waiting" || promptActive) {
          throw new SwarmProtocolError(
            "MEMBER_NOT_WAITING",
            `Member "@${request.name}" (${request.agentId}) is not in waiting state (currently "${switchingModel ? "switchingModel" : state}"). Wait until it parks in waiting state before switching models.`,
          );
        }
        const activeSession = session;
        const activeRuntime = modelRuntime;
        if (!activeSession || !activeRuntime) {
          throw new SwarmProtocolError(
            "MEMBER_KILLED",
            `Member "@${request.name}" (${request.agentId}) has no live session for model switching.`,
          );
        }

        const trimmed = modelOverride.trim();
        if (!trimmed) {
          throw new SwarmProtocolError("MODEL_NOT_FOUND", "Model identifier must be non-empty.");
        }

        const parsed = parseModelSpec(trimmed);
        const requestedThinking = thinkingLevel ?? parsed.thinkingLevel;
        const cliRes = resolveCliModel({
          cliModel: parsed.model || trimmed,
          cliThinking: requestedThinking,
          modelRuntime: activeRuntime,
        });
        if (!cliRes.model) {
          throw new SwarmProtocolError(
            "MODEL_NOT_FOUND",
            `Model "${trimmed}" could not be resolved in the active Pi model registry.`,
            { modelOverride: trimmed },
          );
        }

        const sameModel = Boolean(
          activeSession.model &&
            activeSession.model.provider === cliRes.model.provider &&
            activeSession.model.id === cliRes.model.id,
        );

        switchingModel = true;
        try {
          if (!sameModel) {
            await activeSession.setModel(cliRes.model, { persist: false });
          }

          const postSwitchState = getCurrentState();
          if (isKilled() || postSwitchState === "killed" || !session || session !== activeSession) {
            throw new SwarmProtocolError(
              "MEMBER_KILLED",
              `Member "@${request.name}" (${request.agentId}) was killed while switching models.`,
            );
          }
          if (isAbortedByCaller() || postSwitchState !== "waiting") {
            throw new SwarmProtocolError(
              "MEMBER_NOT_WAITING",
              `Member "@${request.name}" (${request.agentId}) stopped waiting (currently "${postSwitchState}") while switching models.`,
            );
          }

          const effectiveThinking = requestedThinking ?? cliRes.thinkingLevel;
          let appliedThinking: ThinkingLevel | undefined;
          if (effectiveThinking !== undefined) {
            activeSession.setThinkingLevel(effectiveThinking, { persist: false });
            appliedThinking = activeSession.thinkingLevel ?? effectiveThinking;
            currentThinkingLevel = appliedThinking;
          } else {
            const sm = activeSession.settingsManager as
              | {
                  getModelThinkingLevel?: (provider: string, id: string) => ThinkingLevel | undefined;
                  getDefaultThinkingLevel?: () => ThinkingLevel | undefined;
                }
              | undefined;
            const fallbackDefault =
              sm?.getModelThinkingLevel?.(cliRes.model.provider, cliRes.model.id) ??
              sm?.getDefaultThinkingLevel?.() ??
              "medium";
            activeSession.setThinkingLevel(fallbackDefault, { persist: false });
            appliedThinking = undefined;
            currentThinkingLevel = undefined;
          }

          const resolvedId = formatModelId(cliRes.model) ?? (parsed.model || trimmed);
          currentModelId = resolvedId;

          emitTelemetry({
            type: "model_switched",
            model: resolvedId,
            thinkingLevel: appliedThinking,
            activity: `switched model -> ${resolvedId}`,
            logLine: `model switched -> ${resolvedId}${appliedThinking ? ` (${appliedThinking})` : ""}`,
          });

          return {
            model: resolvedId,
            thinkingLevel: appliedThinking,
          };
        } finally {
          switchingModel = false;
        }
      },

      async abort(reason?: string): Promise<void> {
        if (killed || state === "killed") {
          return;
        }
        abortedByCaller = true;
        abortReason = reason ?? "Stopped";
        if (session && promptActive) {
          try {
            await session.abort();
          } catch {
            // ignore abort race
          }
        } else {
          state = "stopped";
        }
      },

      async kill(reason?: string): Promise<void> {
        if (killed || state === "killed") {
          return;
        }
        killed = true;
        abortedByCaller = true;
        abortReason = reason ?? "Killed";
        state = "killed";
        pendingSteers.length = 0;

        if (session && promptActive) {
          try {
            await session.abort();
          } catch {
            // ignore abort race
          }
        }
        await disposeSessionOnce();

        emitTelemetry({
          type: "killed",
          model: currentModelId,
          activity: reason ?? "killed",
          logLine: `killed @${request.name}: ${reason ?? "session disposed"}`,
        });
      },

      get currentTurn(): Promise<AgentTurnResult> {
        return currentTurnPromise;
      },
    };
  }

  private async resolveModelRuntime(
    hostContext: ExtensionContext | undefined,
    agentDir: string,
  ): Promise<ModelRuntime> {
    const hostRegistry = hostContext?.modelRegistry as
      | {
          runtime?: ModelRuntime;
          getRegisteredProviderIds?: () => readonly string[];
          getRegisteredProviderConfig?: (id: string) => unknown;
          getRegisteredNativeProvider?: (id: string) => unknown;
        }
      | undefined;

    if (hostRegistry?.runtime) {
      return hostRegistry.runtime;
    }

    if (!this.fallbackRuntimePromise) {
      this.fallbackRuntimePromise = ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
      });
    }
    const runtime = await this.fallbackRuntimePromise;

    // Best-effort copy of any custom providers registered on host registry
    if (hostRegistry?.getRegisteredProviderIds) {
      for (const providerId of hostRegistry.getRegisteredProviderIds()) {
        if (runtime.getProvider(providerId)) {
          continue;
        }
        const nativeProvider = hostRegistry.getRegisteredNativeProvider?.(providerId);
        if (nativeProvider) {
          try {
            runtime.registerNativeProvider(
              nativeProvider as Parameters<ModelRuntime["registerNativeProvider"]>[0],
            );
            continue;
          } catch {
            // ignore duplicate/incompatible provider registration
          }
        }
        const config = hostRegistry.getRegisteredProviderConfig?.(providerId);
        if (config) {
          try {
            runtime.registerProvider(
              providerId,
              config as Parameters<ModelRuntime["registerProvider"]>[1],
            );
          } catch {
            // ignore duplicate/incompatible provider registration
          }
        }
      }
    }

    return runtime;
  }
}

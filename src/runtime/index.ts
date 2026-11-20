export {
  ConcurrencyGate,
  createAbortError,
  isRateLimitOrTransientError,
  parseRetryAfterMs,
  RateLimitBreaker,
  type RateLimitBreakerOptions,
  selectFallbackModel,
  sleepAbortable,
} from "./rate-limit.js";

export {
  buildMemberInitialPrompt,
  buildMemberSystemPrompt,
  buildOrchestratorContextSummary,
  buildOrchestratorPlaybookSection,
  buildWakeupPrompt,
  formatBoardExcerpt,
  formatBoardExcerptLine,
} from "./role-prompts.js";

export {
  type CommandGuardResult,
  extractSessionMessages,
  findOutOfScopeFiles,
  InProcessPiTransport,
  type InProcessPiTransportOptions,
  isForbiddenWorkerBashCommand,
  isPathInScope,
  isProtectedSwarmPath,
  isReadOnlyValidationCommand,
  normalizeRepoPath,
  resolveRoleModel,
  resolveWorktreeRelativePath,
  sanitizeForkSeedMessages,
} from "./transport.js";

export {
  SwarmEngine,
  type SwarmEngineDeps,
} from "./engine.js";

export {
  createMemberScopedTools,
  createMemberTools,
  createSwarmTools,
  formatSwarmToolError,
  type MemberScopedToolContext,
  registerSwarmTools,
  type SwarmToolDeps,
} from "./swarm-tools.js";

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
  buildOrchestratorLiveStateSection,
  buildOrchestratorPlaybookSection,
  buildOrchestratorStaticSection,
  buildWakeupPrompt,
  formatBoardEntryFull,
  formatBoardExcerpt,
  formatBoardExcerptLine,
  type OrchestratorLiveStateOptions,
} from "./role-prompts.js";

export {
  type CommandGuardResult,
  createValidatorGuardExtensionFactory,
  createWorkerGuardExtensionFactory,
  extractSessionMessages,
  findOutOfScopeFiles,
  getRunValidatorScratchRoot,
  getValidatorScratchDir,
  InProcessPiTransport,
  type InProcessPiTransportOptions,
  isForbiddenWorkerBashCommand,
  isPathInScope,
  isProtectedSwarmPath,
  isReadOnlyValidationCommand,
  normalizeRepoPath,
  resolveRoleModel,
  resolveValidatorScratchPath,
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

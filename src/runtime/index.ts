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
  type BuildWorkerTaskPromptOptions,
  buildFinalValidatorSystemPrompt,
  buildFinalValidatorTaskPrompt,
  buildOrchestratorContextSummary,
  buildValidatorSystemPrompt,
  buildValidatorTaskPrompt,
  buildWorkerSystemPrompt,
  buildWorkerTaskPrompt,
  formatBoardExcerpt,
  formatBoardExcerptLine,
} from "./role-prompts.js";

export {
  type CommandGuardResult,
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
} from "./transport.js";

export {
  SwarmOrchestrator,
  type SwarmOrchestratorDeps,
} from "./orchestrator.js";

export {
  createOrchestratorTools,
  createSwarmVerifyTool,
  type OrchestratorToolDeps,
  registerOrchestratorTools,
} from "./coordinator-tools.js";

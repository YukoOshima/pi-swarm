import {
  FINAL_VALIDATOR_BOARD_NAME,
  ORCHESTRATOR_BOARD_NAME,
  ORCHESTRATOR_TOOLS,
  SWARM_BOARD_POST_TOOL,
  SWARM_BOARD_READ_TOOL,
  SWARM_DIR,
  SWARM_FINAL_VERDICT_TOOL,
  SWARM_FINDING_TOOL,
  SWARM_MISSION_TOOL,
  SWARM_PLAN_ADD_TOOL,
  SWARM_REVIEW_VERDICT_TOOL,
  SWARM_VERIFY_TOOL,
  SWARM_WORKER_DONE_TOOL,
} from "../constants.js";
import type {
  BoardMessage,
  DiffSummary,
  FinalAuditVerdict,
  MissionRecord,
  MissionReviewVerdict,
  MissionTaskItem,
  SwarmFindingRecord,
  SwarmRoleModelConfig,
  SwarmRunState,
  SwarmSnapshot,
} from "../types.js";

// ============================================================================
// Formatting Helpers
// ============================================================================

const MAX_INLINE_DIFF_CHARS = 32_000;

function formatScope(scope: readonly string[]): string {
  if (scope.length === 0) {
    return "(none declared)";
  }
  return scope.map((s) => `\`${s}\``).join(", ");
}

function formatTasks(tasks: readonly MissionTaskItem[]): string {
  if (tasks.length === 0) {
    return "";
  }
  const lines = tasks.map((t) => `- [${t.done ? "x" : " "}] \`${t.id}\`: ${t.title}`);
  return `## Mission Checklist\n${lines.join("\n")}`;
}

function formatUpstreamFindings(findings: readonly SwarmFindingRecord[]): string {
  if (findings.length === 0) {
    return "";
  }
  const blocks = findings.map((f) => {
    const filePart = f.files && f.files.length > 0 ? `\n  Files: ${f.files.join(", ")}` : "";
    const detailPart = f.details.trim() ? `\n  Details: ${f.details.trim()}` : "";
    return `- **[${f.missionId}] ${f.title}** (${f.author}): ${f.summary}${filePart}${detailPart}`;
  });
  return `## Upstream Findings\n${blocks.join("\n")}`;
}

function formatRoleConfig(cfg?: SwarmRoleModelConfig): string {
  const model = cfg?.model?.trim() || "host-default";
  return cfg?.thinkingLevel ? `${model} (${cfg.thinkingLevel})` : model;
}

/**
 * Formats a single board message cleanly for prompts, wakeup deltas, and context summaries.
 */
export function formatBoardExcerptLine(msg: BoardMessage, maxChars = 240): string {
  const mentionsPart =
    msg.mentions.length > 0 ? ` -> ${msg.mentions.map((m) => `@${m}`).join(",")}` : "";
  const compact = msg.text.replace(/\s+/g, " ").trim();
  const clipped = compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
  return `#${msg.seq} [${msg.from}${mentionsPart}] (${msg.kind}) ${clipped}`;
}

/**
 * Formats a slice of board messages for inclusion in prompts or summaries.
 */
export function formatBoardExcerpt(messages: readonly BoardMessage[], maxCharsPerLine = 240): string {
  if (messages.length === 0) {
    return "";
  }
  return messages.map((m) => formatBoardExcerptLine(m, maxCharsPerLine)).join("\n");
}

function formatValidationFeedback(review: MissionReviewVerdict): string {
  const lines: string[] = [
    `## Prior Validation Feedback (Round ${review.round ?? 1}, commit \`${review.commitSha.slice(0, 12)}\`)`,
    `- **Status**: \`${review.status}\` | **Merge**: \`${review.merge}\``,
    `- **Decision**: ${review.decision}`,
  ];

  if (review.findings.length > 0) {
    lines.push("### Findings to Address");
    for (const f of review.findings) {
      const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
      const suggestion = f.suggestion ? ` Suggestion: ${f.suggestion}` : "";
      lines.push(`- **[${f.severity.toUpperCase()}] ${f.title}**${loc}: ${f.detail}${suggestion}`);
    }
  }

  const failedChecks = review.checks.filter((c) => !c.passed);
  if (failedChecks.length > 0) {
    lines.push("### Failed Checks");
    for (const c of failedChecks) {
      lines.push(`- [FAIL] ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    }
  }

  lines.push(
    `Address every P1/P2 finding and failed check, re-run verification, commit your fixes cleanly on your branch, and call \`${SWARM_WORKER_DONE_TOOL}\`.`,
  );

  return lines.join("\n");
}

// ============================================================================
// Worker System & Task Prompts
// ============================================================================

/**
 * Builds a concise, high-signal system prompt appendix tailored to the worker's
 * mission kind (`build` | `artifact` | `survey`), shared message board protocol,
 * warm persistent session lifecycle, scope, upstream findings, and prior validation feedback.
 */
export function buildWorkerSystemPrompt(
  run: SwarmRunState,
  mission: MissionRecord,
  upstreamFindings: readonly SwarmFindingRecord[] = [],
  boardContext: readonly BoardMessage[] = [],
): string {
  const validatorHandle = `validator-${mission.id}`;
  const sections: string[] = [];

  sections.push(
    [
      `# Pi Swarm Worker Assignment — ${mission.id}: ${mission.title}`,
      `- **Board Handle**: \`${mission.id}\` (peers address you as \`@${mission.id}\`)`,
      `- **Run Objective**: ${run.objective}`,
      `- **Mission ID**: ${mission.id} (\`${mission.kind}\`)`,
      `- **Branch**: \`${mission.branch}\` (base: \`${run.baseBranch}\`)`,
      `- **Worktree**: \`${mission.worktreePath}\``,
      `- **Declared Scope**: ${formatScope(mission.scope)}`,
      mission.deps.length > 0 ? `- **Dependencies**: ${mission.deps.join(", ")}` : `- **Dependencies**: none`,
    ].join("\n"),
  );

  sections.push(
    [
      "## Shared Message Board & Warm Session Protocol",
      `1. **Board Tools**: Use \`${SWARM_BOARD_READ_TOOL}\` (\`since?\`, \`seqs?\`, \`limit?\`) to read team context and \`${SWARM_BOARD_POST_TOOL}\` (\`text\`, \`kind?\`) to coordinate with peers.`,
      "2. **Reference by `#seq`**: Always reference earlier board messages by sequence number (e.g., `#4`) instead of copy-pasting long posts.",
      `3. **\`@mention\` Discipline**: \`@name\` is a wakeup doorbell, never a CC! Only \`@mention\` the specific peer(s) who must act next (e.g., \`@${ORCHESTRATOR_BOARD_NAME}\`, \`@${validatorHandle}\`, or a sibling worker like \`@M2\`). Use \`@all\` only for genuine swarm-wide interface changes or rules. Unaddressed posts are still logged and read when peers next wake.`,
      `4. **\`[done]\` & Warm \`waiting\` Persistence**: Calling \`${SWARM_WORKER_DONE_TOOL}\` automatically posts a \`[done]\` handoff on the shared board and parks your session in warm \`waiting\` state (costing zero turns while idle) with your FULL conversation memory intact. If \`@${validatorHandle}\`, a peer worker, or \`@${ORCHESTRATOR_BOARD_NAME}\` later wakes you via \`@${mission.id}\`, answer or apply fixes directly with full context!`,
      "5. **Keep Posts Short**: Every agent pays for every board message in context. No greetings or empty acknowledgements — post concrete questions, interfaces, or results.",
    ].join("\n"),
  );

  if (mission.kind === "build") {
    sections.push(
      [
        "## Build Mission Rules (Enforced by Protocol)",
        `1. **Strict Scope Boundary**: Only create, edit, or delete files inside your declared scope (${formatScope(mission.scope)}). Never touch \`${SWARM_DIR}/\` or \`.git/\`. If another path is genuinely required, post \`@${ORCHESTRATOR_BOARD_NAME}\` via \`${SWARM_BOARD_POST_TOOL}\` to request a scope patch instead of editing out of scope.`,
        `2. **Verification First**: Run your verification criteria (\`${mission.verification || run.verificationContract}\`) and ensure checks pass before committing.`,
        `3. **Clean Git Commits**: Commit all intended changes on branch \`${mission.branch}\` with clear commit message(s). Leave zero uncommitted or untracked files (\`git status --porcelain\` must be empty).`,
        `4. **No Manual Merges**: Never run \`git merge\` into \`${run.baseBranch}\` or switch to \`${run.baseBranch}\`. Only the Swarm Orchestrator merges after independent validation.`,
        `5. **Progress & Completion**: Update checklist progress via \`${SWARM_MISSION_TOOL}\` (\`progress\` / \`task_done\`), coordinate via \`${SWARM_BOARD_POST_TOOL}\` / \`${SWARM_BOARD_READ_TOOL}\` as needed, and finish by calling \`${SWARM_WORKER_DONE_TOOL}\` with a concise summary and verification report.`,
      ].join("\n"),
    );
  } else if (mission.kind === "artifact") {
    sections.push(
      [
        "## Artifact Mission Rules (Enforced by Protocol)",
        `1. **Deliverables Inside Scope**: Produce and verify all requested deliverables strictly within ${formatScope(mission.scope)}. Never touch \`${SWARM_DIR}/\` or \`.git/\`.`,
        `2. **Clean Git Commits**: Commit all deliverables on branch \`${mission.branch}\` and leave \`git status\` completely clean.`,
        `3. **Human Sign-Off Handoff**: Artifact missions require explicit human approval (\`/swarm approve ${mission.id}\`) before merge. Document clearly what was produced, how it was verified, and what the human should inspect.`,
        `4. **Progress & Completion**: Tick off checklist items via \`${SWARM_MISSION_TOOL}\` and finish by calling \`${SWARM_WORKER_DONE_TOOL}\`.`,
      ].join("\n"),
    );
  } else {
    // survey
    sections.push(
      [
        "## Survey Mission Rules (Strictly Read-Only)",
        "1. **Zero File Mutations**: You are on a read-only research/exploration mission. Do NOT edit, create, or delete files, and do NOT make git commits. Closure enforces zero diff.",
        `2. **Record Actionable Findings**: Use \`${SWARM_FINDING_TOOL}\` to persist structured findings (title, summary, details, relevant file paths) so downstream dependent missions receive them automatically.`,
        `3. **Focus Areas**: Start from informational scope ${formatScope(mission.scope)} and gather exact file paths, symbols, constraints, and edge cases.`,
        `4. **Completion**: Finish by calling \`${SWARM_WORKER_DONE_TOOL}\` summarizing the findings you recorded.`,
      ].join("\n"),
    );
  }

  sections.push(
    [
      "## Mission Specification",
      mission.description.trim(),
      "",
      "### Verification Criteria",
      mission.verification.trim() || run.verificationContract.trim() || "Verify changes cleanly.",
      run.verificationContract.trim() &&
      mission.verification.trim() &&
      run.verificationContract.trim() !== mission.verification.trim()
        ? `\n### Global Run Verification Contract\n${run.verificationContract.trim()}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const tasksBlock = formatTasks(mission.tasks);
  if (tasksBlock) {
    sections.push(tasksBlock);
  }

  const findingsBlock = formatUpstreamFindings(upstreamFindings);
  if (findingsBlock) {
    sections.push(findingsBlock);
  }

  if (boardContext.length > 0) {
    sections.push(`## Recent Shared Board Context\n${formatBoardExcerpt(boardContext)}`);
  }

  if (mission.reviewRound > 0 && mission.latestReview) {
    sections.push(formatValidationFeedback(mission.latestReview));
  }

  return sections.join("\n\n");
}

export interface BuildWorkerTaskPromptOptions {
  promptOverride?: string;
  contextMessages?: readonly string[];
  fixInstruction?: string;
  boardContext?: readonly BoardMessage[];
}

/**
 * Builds the initial user turn prompt that launches a worker session.
 */
export function buildWorkerTaskPrompt(
  run: SwarmRunState,
  mission: MissionRecord,
  options: BuildWorkerTaskPromptOptions = {},
): string {
  const parts: string[] = [];

  if (options.promptOverride?.trim()) {
    parts.push(options.promptOverride.trim());
  } else if (options.fixInstruction?.trim()) {
    parts.push(
      `Repair required for mission ${mission.id} ("${mission.title}") on branch \`${mission.branch}\`:\n\n${options.fixInstruction.trim()}\n\nResolve the issue cleanly, ensure verification passes and git status is clean (if applicable), and finish by calling \`${SWARM_WORKER_DONE_TOOL}\`.`,
    );
  } else if (mission.reviewRound > 0 && mission.latestReview) {
    parts.push(
      `Validation round ${mission.reviewRound} returned \`${mission.latestReview.status}\` (\`${mission.latestReview.merge}\`) for mission ${mission.id} ("${mission.title}"). Fix all reported findings on branch \`${mission.branch}\`, re-run verification, make a clean commit, and finish by calling \`${SWARM_WORKER_DONE_TOOL}\`.`,
    );
  } else if (mission.kind === "survey") {
    parts.push(
      `Execute read-only survey mission ${mission.id} ("${mission.title}") for run objective "${run.objective}". Inspect the codebase without modifying files, record structured findings via \`${SWARM_FINDING_TOOL}\`, and finish by calling \`${SWARM_WORKER_DONE_TOOL}\`.`,
    );
  } else if (mission.kind === "artifact") {
    parts.push(
      `Execute artifact mission ${mission.id} ("${mission.title}") on branch \`${mission.branch}\`. Produce and commit the deliverables inside ${formatScope(mission.scope)}, verify them, and call \`${SWARM_WORKER_DONE_TOOL}\` with sign-off notes.`,
    );
  } else {
    parts.push(
      `Execute build mission ${mission.id} ("${mission.title}") on branch \`${mission.branch}\`. Implement the specification strictly inside ${formatScope(mission.scope)}, run verification, commit cleanly, and call \`${SWARM_WORKER_DONE_TOOL}\`.`,
    );
  }

  if (options.boardContext && options.boardContext.length > 0) {
    parts.push(`## Recent Board Messages\n${formatBoardExcerpt(options.boardContext)}`);
  }

  if (options.contextMessages && options.contextMessages.length > 0) {
    parts.push(
      "## Orchestrator / Direct Messages\n" +
        options.contextMessages.map((msg) => `- ${msg}`).join("\n"),
    );
  }

  return parts.join("\n\n");
}

// ============================================================================
// Per-Mission Validator System & Task Prompts
// ============================================================================

/**
 * Builds the independent read-only Per-Mission Validator system prompt for a `build` mission,
 * pinned to the exact branch tip commit SHA. Board handle: `validator-<missionId>`.
 */
export function buildValidatorSystemPrompt(
  run: SwarmRunState,
  mission: MissionRecord,
  diffSummary: DiffSummary,
  changedFiles: readonly string[],
  commitSha: string,
  boardContext: readonly BoardMessage[] = [],
): string {
  const validatorHandle = `validator-${mission.id}`;
  const sections: string[] = [];

  sections.push(
    [
      `# Pi Swarm Independent Validator — ${validatorHandle} (${mission.id}: ${mission.title})`,
      `- **Board Handle**: \`${validatorHandle}\` (worker handle: \`@${mission.id}\`)`,
      `- **Role**: Independent read-only auditor (you did NOT author this branch).`,
      `- **Pinned Commit SHA**: \`${commitSha}\``,
      `- **Branch**: \`${mission.branch}\` vs base \`${run.baseBranch}\` (${diffSummary.commitsAhead} commit(s) ahead)`,
      `- **Declared Scope**: ${formatScope(mission.scope)}`,
      `- **Changed Files (${changedFiles.length})**: ${changedFiles.length > 0 ? changedFiles.map((f) => `\`${f}\``).join(", ") : "(none)"}`,
      `- **Validation Round**: ${mission.reviewRound + 1} / ${run.maxValidationRounds}`,
    ].join("\n"),
  );

  sections.push(
    [
      "## Strict Read-Only Validation & Shared Board Rules",
      "1. **NEVER modify files, stage changes, or create commits.** You may inspect files (`read`, `grep`, `find`, `ls`), read shared board context (`" +
        SWARM_BOARD_READ_TOOL +
        "`), and run read-only inspection/verification commands (e.g., `git diff`, `git show`, typecheck, tests) via `bash`.",
      "2. **Audit Both Intent and Diff**:",
      "   - **Intent Match**: Does the implementation completely satisfy the verbatim mission description and run objective?",
      `   - **Scope Compliance**: Are all changed files strictly inside declared \`scope\` (and zero edits to \`${SWARM_DIR}/\` or \`.git/\`)?`,
      "   - **Correctness & Edge Cases**: Logic bugs, race conditions, null/error handling, protocol invariants.",
      "   - **Security & Data Integrity**: Injection, path traversal, unsafe mutations, leaked resources.",
      "   - **Verification & Tests**: Do verification criteria and relevant tests/typechecks actually pass?",
      "   - **Code Quality**: Clarity, maintainability, no dead debug code or silent regressions.",
      "3. **Structured Verdict Rubric**:",
      "   - `p1`: Blocking defect (broken behavior, failed verification, security bug, scope violation, missing core requirement).",
      "   - `p2`: Non-trivial issue that should be fixed before merge (edge-case bug, missing test coverage for critical path, poor error handling).",
      "   - `note`: Informational suggestion (does NOT block merge).",
      "   - `status`: Must match findings — `\"clean\"` (0 p1 & 0 p2), `\"p1-Nitems\"` (N >= 1 p1 findings), or `\"p2-Nitems\"` (0 p1 and N >= 1 p2 findings).",
      "   - `merge`: `\"merge\"` ONLY when `status === \"clean\"` and required checks pass; `\"fix-then-merge\"` when the worker can fix the findings; `\"hold\"` when blocked on human/design ambiguity.",
      `4. **Automatic Warm Peer Handoff**: Submitting a non-clean \`fix-then-merge\` verdict via \`${SWARM_REVIEW_VERDICT_TOOL}\` automatically posts \`@${mission.id}\` on the shared board and wakes the warm Worker session with its full conversation memory intact so it can fix every finding, re-verify, and re-commit!`,
      `5. **Mandatory Completion Tool**: Finish by calling \`${SWARM_REVIEW_VERDICT_TOOL}\` with \`status\`, \`merge\`, \`findings\`, \`checks\`, and \`decision\`.`,
    ].join("\n"),
  );

  sections.push(
    [
      "## Verbatim Mission Intent",
      `- **Run Objective**: ${run.objective}`,
      `- **Mission Title**: ${mission.title}`,
      `- **Mission Description**:\n${mission.description.trim()}`,
      `- **Mission Verification**: ${mission.verification.trim() || "(see run contract)"}`,
      `- **Run Verification Contract**: ${run.verificationContract.trim() || "(none)"}`,
    ].join("\n"),
  );

  if (boardContext.length > 0) {
    sections.push(`## Shared Board Context\n${formatBoardExcerpt(boardContext)}`);
  }

  if (mission.latestReview) {
    sections.push(
      `## Previous Validation Round Summary\nPrior round (${mission.latestReview.round ?? mission.reviewRound}, \`${mission.latestReview.commitSha.slice(0, 12)}\`) was \`${mission.latestReview.status}\` (\`${mission.latestReview.merge}\`): ${mission.latestReview.decision}. Verify all previous findings are properly resolved.`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Builds the initial user turn prompt for a Per-Mission Validator session, including bounded diff stat and patch.
 */
export function buildValidatorTaskPrompt(
  mission: MissionRecord,
  diffSummary: DiffSummary,
  commitSha: string,
  boardContext: readonly BoardMessage[] = [],
): string {
  let diffText = diffSummary.diff || "";
  let truncatedNote = "";
  if (diffText.length > MAX_INLINE_DIFF_CHARS) {
    diffText = diffText.slice(0, MAX_INLINE_DIFF_CHARS);
    truncatedNote = `\n\n[Diff truncated at ${MAX_INLINE_DIFF_CHARS} chars. Use \`read\` or read-only \`git diff ${diffSummary.baseBranch}...${commitSha}\` to inspect remaining changes.]`;
  }

  const lines: string[] = [
    `Audit mission ${mission.id} ("${mission.title}") at pinned commit \`${commitSha}\` (\`${mission.branch}\` vs \`${diffSummary.baseBranch}\`).`,
  ];

  if (boardContext.length > 0) {
    lines.push("", "### Recent Board Context", formatBoardExcerpt(boardContext));
  }

  lines.push(
    "",
    "### Diff Stat",
    "```",
    diffSummary.stat.trim() || "(empty stat)",
    "```",
    "",
    "### Branch Diff",
    "```diff",
    diffText.trim() || "(empty diff)",
    "```",
    truncatedNote,
    "",
    `Inspect full files, check \`${SWARM_BOARD_READ_TOOL}\` if helpful, and run read-only verification checks as needed, then submit your structured verdict via \`${SWARM_REVIEW_VERDICT_TOOL}\`.`,
  );

  return lines
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
}

// ============================================================================
// Run-Level Final Validator / Goal Auditor Prompts
// ============================================================================

/**
 * Builds the system prompt appendix for the independent, strictly read-only
 * Run-Level Final Validator (`final-validator`) inspecting the integrated base branch
 * at `baseHeadSha` after all missions have merged.
 */
export function buildFinalValidatorSystemPrompt(
  run: SwarmRunState,
  mergedMissions: readonly MissionRecord[],
  baseHeadSha: string,
  round: number,
  boardContext: readonly BoardMessage[] = [],
): string {
  const sections: string[] = [];

  sections.push(
    [
      `# Pi Swarm Final Validator / Goal Auditor — Run ${run.id}`,
      `- **Board Handle**: \`${FINAL_VALIDATOR_BOARD_NAME}\``,
      "- **Role**: Independent, strictly read-only Final Validator / Goal Auditor (you did NOT author any mission branch).",
      `- **Base Branch**: \`${run.baseBranch}\``,
      `- **Pinned Base HEAD SHA**: \`${baseHeadSha}\``,
      `- **Audit Round**: ${round} / ${run.maxFinalAuditRounds}`,
      `- **Auto-Remediation Enabled**: ${run.autoFixOnAuditFail ? "ON" : "OFF"}`,
      `- **Merged Missions (${mergedMissions.length})**: ${mergedMissions.map((m) => `${m.id} (${m.kind}: "${m.title}")`).join(", ") || "(none)"}`,
    ].join("\n"),
  );

  sections.push(
    [
      "## Strict Read-Only Audit Rules",
      `1. **NEVER modify files, stage changes, switch branches, or create commits.** You are auditing the integrated repository directly on \`${run.baseBranch}\` with read-only tools (\`read\`, \`grep\`, \`find\`, \`ls\`, \`${SWARM_BOARD_READ_TOOL}\`) and read-only \`bash\` inspection/verification commands (e.g., tests, typecheck, build, \`git log\`, \`git diff\`, \`git show\`). Mutating commands and file writes are blocked, and leaving the working tree dirty invalidates your audit.`,
      "2. **Treat Individual Mission Summaries as Untrusted Claims**: Worker progress reports and mission completion notes are unverified claims — NEVER approve based on summaries alone. Independently verify every claim directly against the integrated source code, git history/diffs, and live verification command outputs.",
      "3. **Audit Cross-Mission Integration & Overall Goal Satisfaction**:",
      `   - **Objective Fulfillment**: Does the integrated codebase on \`${run.baseBranch}\` completely satisfy the verbatim Run Objective end-to-end?`,
      "   - **Verification Contract Compliance**: Execute and verify EVERY requirement in the Run Verification Contract against the integrated tree.",
      "   - **Cross-Mission Seams & Wiring**: Inspect imports, exports, shared types, registration wiring, CLI/UI integration, and runtime interactions across merged missions for subtle integration regressions, missing glue code, or mismatched assumptions.",
      "   - **Correctness, Completeness & Safety**: Watch for stubs, placeholder TODOs, broken edge cases, failing tests, type errors, or regressions introduced during merges.",
      "4. **Structured Verdict Rubric**:",
      '   - `verdict`: `"approved"` ONLY when the overall objective is genuinely satisfied, every required check in the verification contract passes, and there are ZERO blocking (`p1`) defects; otherwise `"disapproved"`.',
      "   - `summary`: Concise, evidence-backed explanation of your verdict.",
      "   - `checks`: Array of `{ name, passed, detail? }` covering each verification contract item and integration check you ran.",
      '   - `findings`: Array of `{ severity: "p1" | "p2" | "note", title, detail, file?, line?, suggestion? }` (`p1` = blocking failure/missing goal requirement, `p2` = important integration/quality gap, `note` = non-blocking observation).',
      '   - `recommended_missions`: Optional array of concrete follow-up fix missions (`{ title, description, scope, verification, kind?, tasks? }`) when `verdict === "disapproved"`:',
      "     - Each `title` MUST be printable ASCII containing at least one letter/digit (used for unique `feat/<slug>` branches; avoid duplicating existing mission titles).",
      `     - Each \`scope\` MUST be concrete repo-relative POSIX file/directory prefixes (NO globs \`*\`/\`?\`, NO \`..\`, NO absolute paths, NO \`.git\` or \`${SWARM_DIR}\`).`,
      "     - Multiple recommended `build` missions MUST have **pairwise-disjoint** `scope` paths (zero file/directory overlap) so they can safely execute in parallel.",
      '     - `kind` defaults to `"build"` (or `"artifact"` for deliverables requiring human approval).',
      `5. **Mandatory Completion Tool**: Always conclude by calling \`${SWARM_FINAL_VERDICT_TOOL}\` with \`verdict\`, \`summary\`, \`checks\`, \`findings\`, and (when disapproved) optional \`recommended_missions\`.`,
    ].join("\n"),
  );

  sections.push(
    [
      "## Verbatim Run Objective & Verification Contract",
      `### Run Objective\n${run.objective.trim()}`,
      `### Run Verification Contract\n${run.verificationContract.trim() || "(none specified — verify build, typecheck, tests, and end-to-end objective satisfaction)"}`,
    ].join("\n\n"),
  );

  if (boardContext.length > 0) {
    sections.push(`## Recent Shared Board Context\n${formatBoardExcerpt(boardContext)}`);
  }

  return sections.join("\n\n");
}

function formatPriorAuditBlock(audit: FinalAuditVerdict): string {
  const lines: string[] = [
    `### Round ${audit.round} — \`${audit.verdict}\` @ \`${audit.commitSha.slice(0, 12)}\` (${audit.auditedAt})`,
    `- **Summary**: ${audit.summary}`,
  ];

  const failedChecks = audit.checks.filter((c) => !c.passed);
  if (failedChecks.length > 0) {
    lines.push("- **Failed Checks**:");
    for (const c of failedChecks) {
      lines.push(`  - [FAIL] ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    }
  }

  if (audit.findings.length > 0) {
    lines.push("- **Findings**:");
    for (const f of audit.findings) {
      const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
      lines.push(`  - [${f.severity.toUpperCase()}] ${f.title}${loc}: ${f.detail}`);
    }
  }

  return lines.join("\n");
}

/**
 * Builds the initial user turn prompt for a Run-Level Final Validator session,
 * presenting merged mission summaries explicitly as untrusted claims alongside
 * recorded run findings and any prior final audit rounds.
 */
export function buildFinalValidatorTaskPrompt(
  run: SwarmRunState,
  mergedMissions: readonly MissionRecord[],
  findings: readonly SwarmFindingRecord[],
  priorAudits: readonly FinalAuditVerdict[],
  baseHeadSha: string,
  boardContext: readonly BoardMessage[] = [],
): string {
  const parts: string[] = [
    `Perform an independent read-only final validation of integrated branch \`${run.baseBranch}\` at pinned commit \`${baseHeadSha}\` against the Run Objective and Verification Contract.`,
  ];

  if (mergedMissions.length > 0) {
    const missionLines = mergedMissions.map((m) => {
      const mergedSha = m.mergedCommitSha ? ` mergedSha=\`${m.mergedCommitSha.slice(0, 12)}\`` : "";
      const claim = m.progressSummary?.trim()
        ? `\n  - Worker summary *(untrusted claim — verify independently)*: ${m.progressSummary.trim()}`
        : "\n  - Worker summary *(untrusted claim)*: (none provided)";
      return [
        `- **${m.id}** (${m.kind}) "${m.title}" branch=\`${m.branch}\`${mergedSha}`,
        `  - Scope: ${formatScope(m.scope)}`,
        `  - Mission verification: ${m.verification.trim() || "(none)"}`,
        claim.slice(1),
      ].join("\n");
    });
    parts.push(
      `## Merged Missions (Untrusted Claims — Verify Directly Against Code & Tests)\n${missionLines.join("\n")}`,
    );
  }

  const abandonedMissions = run.missionOrder
    .map((id) => run.missions[id])
    .filter((m): m is MissionRecord => Boolean(m && m.status === "abandoned"));
  if (abandonedMissions.length > 0) {
    parts.push(
      "## Abandoned Missions (Not Merged)\n" +
        abandonedMissions
          .map((m) => `- **${m.id}** (${m.kind}) "${m.title}"${m.error ? `: ${m.error}` : ""}`)
          .join("\n"),
    );
  }

  if (findings.length > 0) {
    const findingBlocks = findings.map((f) => {
      const filePart = f.files && f.files.length > 0 ? `\n  Files: ${f.files.join(", ")}` : "";
      const detailPart = f.details.trim() ? `\n  Details: ${f.details.trim()}` : "";
      return `- **[${f.missionId}] ${f.title}** (${f.author}): ${f.summary}${filePart}${detailPart}`;
    });
    parts.push(`## Recorded Run Findings\n${findingBlocks.join("\n")}`);
  }

  if (boardContext.length > 0) {
    parts.push(`## Recent Board Excerpts\n${formatBoardExcerpt(boardContext)}`);
  }

  if (priorAudits.length > 0) {
    parts.push(
      "## Prior Final Audit Rounds (Verify All Prior Issues Are Resolved)\n" +
        priorAudits.map((a) => formatPriorAuditBlock(a)).join("\n\n"),
    );
  }

  parts.push(
    [
      "## Audit Instructions",
      `1. Inspect the integrated code on \`${run.baseBranch}\` (e.g., \`git log --oneline -n 20\`, \`read\`, \`grep\`, \`find\`, \`${SWARM_BOARD_READ_TOOL}\`) and run all read-only verification commands required by the Verification Contract.`,
      "2. Verify cross-mission integration, edge cases, and overall objective completion directly — do not trust worker summaries.",
      `3. Finish by calling \`${SWARM_FINAL_VERDICT_TOOL}\` with \`verdict\`, \`summary\`, \`checks\`, \`findings\`, and (if \`verdict === "disapproved"\`) concrete \`recommended_missions\` with printable ASCII titles and pairwise-disjoint \`scope\` paths.`,
    ].join("\n"),
  );

  return parts.join("\n\n");
}

// ============================================================================
// Orchestrator Context Summary (Tail Custom Message — Prompt-Cache-Friendly)
// ============================================================================

/**
 * Builds a compact, prompt-cache-friendly summary of current Pi Swarm run state
 * injected as a tail custom message so the orchestrator LLM stays aligned with
 * background fleet progress, 3-role models, warm roster, and shared board activity
 * without mutating the leading system prompt.
 */
export function buildOrchestratorContextSummary(snapshot: SwarmSnapshot): string {
  const run = snapshot.run;
  if (!run) {
    return [
      "[Pi Swarm Status]",
      "No active Swarm run. Use `/swarm` to start an interactive mission plan.",
    ].join("\n");
  }

  const missions = run.missionOrder
    .map((id) => run.missions[id])
    .filter((m): m is MissionRecord => Boolean(m));

  const mergedCount = missions.filter((m) => m.status === "merged").length;
  const finalStatus = snapshot.finalAuditStatus ?? run.finalAuditStatus ?? "idle";
  const latestAudit = snapshot.latestFinalAudit ?? run.latestFinalAudit;
  const lines: string[] = [];

  lines.push(
    `[Pi Swarm Run ${run.id} | status=${run.status} | base=${run.baseBranch} | ${mergedCount}/${missions.length} merged | working=${snapshot.workingAgentIds.length}/${snapshot.maxConcurrency} | waiting=${snapshot.waitingAgentIds.length} | board=#${snapshot.boardHead} | validator=${run.validatorEnabled ? "on" : "off"} | final=${run.finalValidatorEnabled ? finalStatus : "off"} | tokens=${snapshot.totalTokens} | cost=$${snapshot.totalCost.toFixed(4)}]`,
  );
  lines.push(`Objective: ${run.objective}`);

  const fallbacks =
    snapshot.roleModels.fallbackModels && snapshot.roleModels.fallbackModels.length > 0
      ? ` | fallbacks=[${snapshot.roleModels.fallbackModels.join(", ")}]`
      : "";
  lines.push(
    `Role Models: orchestrator=${formatRoleConfig(snapshot.roleModels.orchestrator)} | worker=${formatRoleConfig(snapshot.roleModels.worker)} | validator=${formatRoleConfig(snapshot.roleModels.validator)}${fallbacks}`,
  );

  if (snapshot.rateLimitUntil && snapshot.rateLimitUntil > Date.now()) {
    const secs = Math.ceil((snapshot.rateLimitUntil - Date.now()) / 1000);
    lines.push(
      `RATE-LIMIT BACKOFF: pausing new spawns for ~${secs}s${snapshot.rateLimitReason ? ` (${snapshot.rateLimitReason})` : ""}.`,
    );
  }

  lines.push("");
  lines.push("Missions:");
  for (const m of missions) {
    const deps = m.deps.length > 0 ? ` deps=[${m.deps.join(",")}]` : "";
    const review =
      m.kind === "build" && m.latestReview
        ? ` validation=${m.latestReview.status}/${m.latestReview.merge}@${m.latestReview.commitSha.slice(0, 7)}`
        : "";
    const approved =
      m.kind === "artifact" && m.humanApprovedSha
        ? ` approved@${m.humanApprovedSha.slice(0, 7)}`
        : "";
    const stopped = m.humanStopped ? " [HUMAN-STOPPED]" : "";
    const err = m.error ? ` err="${m.error.slice(0, 80)}"` : "";
    lines.push(
      `- ${m.id} (${m.kind}) [${m.status}] "${m.title}" branch=${m.branch} scope=[${m.scope.join(",")}]${deps}${review}${approved}${stopped}${err}`,
    );
  }

  // Final Validation summary
  if (run.finalValidatorEnabled || finalStatus !== "idle" || latestAudit) {
    const shaPart = run.lastAuditedSha ? ` sha=${run.lastAuditedSha.slice(0, 7)}` : "";
    const runningPart = snapshot.finalAuditRunningAgentId
      ? ` agent=${snapshot.finalAuditRunningAgentId}`
      : "";
    const displayStatus = run.status === "verifying" ? "verifying" : finalStatus;
    const displayRound =
      finalStatus === "running" || Boolean(snapshot.finalAuditRunningAgentId)
        ? run.finalAuditRound + 1
        : run.finalAuditRound;
    lines.push("");
    lines.push(
      `Final Validation: ${run.finalValidatorEnabled ? "ON" : "OFF"} | status=${displayStatus} | round=${displayRound}/${run.maxFinalAuditRounds} | autoFix=${run.autoFixOnAuditFail ? "on" : "off"}${shaPart}${runningPart}`,
    );
    if (finalStatus === "skipped") {
      lines.push(
        `- Skipped by ${run.finalAuditSkippedBy ?? "human"}${run.finalAuditSkipReason ? `: ${run.finalAuditSkipReason}` : ""}`,
      );
    }
    if (latestAudit) {
      const passedChecks = latestAudit.checks.filter((c) => c.passed).length;
      const p1Count = latestAudit.findings.filter((f) => f.severity === "p1").length;
      const p2Count = latestAudit.findings.filter((f) => f.severity === "p2").length;
      lines.push(
        `- Latest audit (r${latestAudit.round}@${latestAudit.commitSha.slice(0, 7)}): ${latestAudit.verdict} — ${latestAudit.summary} (checks ${passedChecks}/${latestAudit.checks.length}, findings: ${latestAudit.findings.length} [p1=${p1Count}, p2=${p2Count}])`,
      );
      const importantFindings = latestAudit.findings
        .filter((f) => f.severity === "p1" || f.severity === "p2")
        .slice(0, 5);
      for (const f of importantFindings) {
        const loc = f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ""})` : "";
        lines.push(`  - [${f.severity.toUpperCase()}] ${f.title}${loc}: ${f.detail.slice(0, 140)}`);
      }
      if (latestAudit.recommendedMissions && latestAudit.recommendedMissions.length > 0) {
        lines.push(
          `  - Recommended fix missions (${latestAudit.recommendedMissions.length}): ${latestAudit.recommendedMissions.map((m) => `"${m.title}"`).join(", ")}`,
        );
      }
    }
  }

  // Roster summary (working / waiting / stopped / killed / failed)
  const rosterEntries = Object.values(run.roster);
  if (rosterEntries.length > 0) {
    lines.push("");
    lines.push("Roster:");
    for (const r of rosterEntries) {
      const modelPart = r.model ? ` model=${r.model}` : "";
      const act = r.currentActivity ? ` — ${r.currentActivity}` : "";
      const stopped = r.humanStopped ? " [HUMAN-STOPPED]" : "";
      lines.push(
        `- ${r.name} (${r.role} on ${r.missionId}, id=${r.agentId}): [${r.status}]${modelPart} turns=${r.turns} board=#${r.lastReadBoardSeq}${stopped}${act}`,
      );
    }
  }

  // Recent Shared Board excerpts
  if (snapshot.recentBoard.length > 0) {
    const tail = snapshot.recentBoard.slice(-8);
    lines.push("");
    lines.push(`Shared Board (head #${snapshot.boardHead}, showing last ${tail.length}):`);
    for (const msg of tail) {
      lines.push(`- ${formatBoardExcerptLine(msg, 180)}`);
    }
  }

  // Actionable Alerts
  const alerts: string[] = [];
  if (snapshot.pendingArtifactApprovals.length > 0) {
    alerts.push(
      `Pending human artifact approval: ${snapshot.pendingArtifactApprovals.join(", ")} (user can run /swarm approve <id>)`,
    );
  }
  if (snapshot.pendingReviews.length > 0) {
    alerts.push(`Awaiting validation: ${snapshot.pendingReviews.join(", ")}`);
  }
  if (snapshot.readyToMerge.length > 0) {
    alerts.push(`Ready to merge: ${snapshot.readyToMerge.join(", ")}`);
  }
  if (run.status === "verifying" || snapshot.finalAuditRunningAgentId) {
    alerts.push(
      `Final Validator is auditing ${run.baseBranch} (${snapshot.finalAuditRunningAgentId ?? "verifying"}); check details via ${SWARM_VERIFY_TOOL}.`,
    );
  } else if (finalStatus === "disapproved") {
    alerts.push(
      `Final Validator DISAPPROVED ${run.baseBranch}: inspect via ${SWARM_VERIFY_TOOL} (action="status"), add fix missions with ${SWARM_PLAN_ADD_TOOL}, re-verify via ${SWARM_VERIFY_TOOL} (action="run", force=true), or human may run /swarm verify --skip.`,
    );
  }
  const failedIds = missions.filter((m) => m.status === "failed").map((m) => m.id);
  if (failedIds.length > 0) {
    alerts.push(`Failed/escalated missions needing attention: ${failedIds.join(", ")}`);
  }
  if (snapshot.unreadOrchestratorMessages > 0) {
    alerts.push(
      `Unread @${ORCHESTRATOR_BOARD_NAME} board messages: ${snapshot.unreadOrchestratorMessages} (read via ${SWARM_BOARD_READ_TOOL})`,
    );
  }

  if (alerts.length > 0) {
    lines.push("");
    lines.push("Actionable Alerts:");
    for (const a of alerts) {
      lines.push(`- ${a}`);
    }
  }

  lines.push("");
  lines.push(
    `Orchestrator tools (${ORCHESTRATOR_TOOLS.length}): ${ORCHESTRATOR_TOOLS.join(", ")}. Coordinate via the shared board (${SWARM_BOARD_POST_TOOL}/${SWARM_BOARD_READ_TOOL}), hot-switch waiting agent models via swarm_model, kill completed/stuck agents via swarm_kill, inspect/merge/retry/abandon/verify via tools (${SWARM_VERIFY_TOOL}), never edit ${SWARM_DIR}/ manually, and never restart [HUMAN-STOPPED] agents unless explicitly asked.`,
  );

  return lines.join("\n");
}
